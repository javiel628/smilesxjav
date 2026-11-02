require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env') });
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pool, migrate } = require('./db');
const { auth, makeToken, hashPassword, verifyPassword, newId } = require('./security');
const { startPairing, cancelPairing } = require('./pairing');

for (const key of ['DATABASE_URL','JWT_SECRET','SESSION_ENCRYPTION_KEY']) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
const app = express();
const port = Number(process.env.PORT || 10000);
const botRoot = path.resolve(__dirname, '..', process.env.BOT_ROOT || '../bot');
const workerScript = path.resolve(__dirname, '../workers/deployment-worker.js');
const workers = new Map();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] } } }));
app.use(express.json({ limit: '32kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, '../public')));

const registerSchema = z.object({ email: z.string().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(10).max(128) });
const phoneSchema = z.object({ phone: z.string().min(8).max(20) });
const deploySchema = z.object({ sessionId: z.string().regex(/^JAVIEL-[A-Z0-9_-]{24,80}$/) });
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const setAuthCookie = (res, token) => res.setHeader('Set-Cookie', `javiel_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
const clearAuthCookie = (res) => res.setHeader('Set-Cookie', `javiel_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
const ownSession = async (userId, publicId) => pool.query('SELECT * FROM sessions WHERE user_id=$1 AND public_id=$2 AND status IN (\'saved\',\'connected\')', [userId, publicId]);
const ownDeployment = async (userId, id) => pool.query('SELECT * FROM deployments WHERE user_id=$1 AND id=$2', [userId,id]);

app.post('/api/auth/register', rateLimit({ windowMs: 3600000, limit: 5 }), asyncRoute(async (req,res) => {
  const input = registerSchema.parse(req.body);
  const id = newId();
  try {
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [id,input.email,await hashPassword(input.password)]);
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error:'EMAIL_EXISTS', message:'An account with this email already exists.' }); throw e; }
  setAuthCookie(res, makeToken({ id,email:input.email }));
  res.status(201).json({ user:{ id,email:input.email } });
}));
app.post('/api/auth/login', rateLimit({ windowMs: 900000, limit: 10 }), asyncRoute(async (req,res) => {
  const input = registerSchema.parse(req.body);
  const result = await pool.query('SELECT id,email,password_hash FROM users WHERE email=$1', [input.email]);
  if (!result.rowCount || !(await verifyPassword(input.password,result.rows[0].password_hash))) return res.status(401).json({ error:'INVALID_LOGIN', message:'Email or password is incorrect.' });
  const user = result.rows[0]; setAuthCookie(res, makeToken(user)); res.json({ user:{id:user.id,email:user.email} });
}));

app.post('/api/auth/logout', (req,res)=>{clearAuthCookie(res);res.json({ok:true});});
app.get('/api/auth/me', auth, asyncRoute(async(req,res)=>{const u=await pool.query('SELECT id,email FROM users WHERE id=$1',[req.user.sub]);if(!u.rowCount)return res.status(401).json({error:'AUTH_REQUIRED'});res.json({user:u.rows[0]});}));

app.post('/api/pairings', rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }), auth, asyncRoute(async (req,res) => {
  const { phone } = phoneSchema.parse(req.body);
  const result = await startPairing(pool, req.user.sub, phone);
  res.status(202).json({ pairingId:result.id, status:'initializing', phone:result.phone, expiresAt:result.expiresAt });
}));
app.get('/api/pairings/:id', auth, asyncRoute(async (req,res) => {
  const result = await pool.query(`SELECT id,phone_e164,status,pairing_code,public_id,error_code,error_message,expires_at,updated_at FROM sessions WHERE id=$1 AND user_id=$2`, [req.params.id,req.user.sub]);
  if (!result.rowCount) return res.status(404).json({ error:'NOT_FOUND',message:'Pairing request not found.' });
  const s=result.rows[0];
  res.json({ pairingId:s.id,phone:s.phone_e164,status:s.status,pairingCode:s.pairing_code,sessionId:s.public_id,error:s.error_message ? {code:s.error_code,message:s.error_message}:null,expiresAt:s.expires_at,updatedAt:s.updated_at });
}));
app.get('/api/sessions', auth, asyncRoute(async (req,res) => {
  const result = await pool.query(`SELECT id,public_id,phone_e164,status,created_at,updated_at FROM sessions WHERE user_id=$1 AND status!='revoked' ORDER BY created_at DESC LIMIT 50`, [req.user.sub]);
  res.json({ sessions:result.rows.map(s=>({id:s.id,sessionId:s.public_id,phone:s.phone_e164,status:s.status,createdAt:s.created_at,updatedAt:s.updated_at})) });
}));
app.post('/api/sessions/:id/revoke', auth, asyncRoute(async (req,res) => {
  const result = await pool.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2', [req.params.id,req.user.sub]);
  if (!result.rowCount) return res.status(404).json({error:'NOT_FOUND',message:'Session not found.'});
  await cancelPairing(req.params.id);
  const deployments = await pool.query(`SELECT id FROM deployments WHERE session_id=$1 AND user_id=$2 AND desired_state='running'`,[req.params.id,req.user.sub]);
  for (const d of deployments.rows) await stopWorker(d.id);
  await pool.query(`UPDATE sessions SET status='revoked',public_id=NULL,pairing_code=NULL,encrypted_auth=NULL,auth_iv=NULL,auth_tag=NULL,updated_at=NOW() WHERE id=$1`,[req.params.id]);
  res.json({ok:true,status:'revoked'});
}));

async function spawnWorker(deploymentId, sessionId) {
  const existing=workers.get(deploymentId);
  if (existing && existing.exitCode===null) return existing;
  const child=spawn(process.execPath,[workerScript],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DEPLOYMENT_ID:deploymentId,SESSION_REF:sessionId,BOT_ROOT:botRoot},stdio:['ignore','pipe','pipe']});
  workers.set(deploymentId,child);
  child.on('exit',()=>{if(workers.get(deploymentId)===child) workers.delete(deploymentId);});
  return child;
}
async function stopWorker(deploymentId) {
  const child=workers.get(deploymentId);
  await pool.query(`UPDATE deployments SET desired_state='stopped',updated_at=NOW() WHERE id=$1`,[deploymentId]);
  if (child && child.exitCode===null) {
    child.kill('SIGTERM');
    await new Promise(resolve=>{const t=setTimeout(resolve,9000);child.once('exit',()=>{clearTimeout(t);resolve();});});
  } else {
    await pool.query(`UPDATE deployments SET status='stopped',worker_pid=NULL,stopped_at=NOW(),updated_at=NOW() WHERE id=$1`,[deploymentId]);
  }
}
app.post('/api/deployments', auth, asyncRoute(async(req,res)=>{
  const {sessionId}=deploySchema.parse(req.body);
  const found=await ownSession(req.user.sub,sessionId);
  if(!found.rowCount || !found.rows[0].encrypted_auth) return res.status(404).json({error:'INVALID_SESSION',message:'Session ID is invalid, revoked, or has no saved authentication.'});
  const session=found.rows[0];
  const activeCount=await pool.query(`SELECT COUNT(*)::int AS count FROM deployments WHERE user_id=$1 AND desired_state='running'`,[req.user.sub]);
  if(activeCount.rows[0].count>=Number(process.env.MAX_ACTIVE_DEPLOYMENTS_PER_USER||3)) return res.status(429).json({error:'DEPLOYMENT_LIMIT',message:'You have reached your active deployment limit.'});
  const existing=await pool.query('SELECT id,status,desired_state FROM deployments WHERE session_id=$1',[session.id]);
  if(existing.rowCount && existing.rows[0].desired_state==='running') return res.status(409).json({error:'ALREADY_DEPLOYED',message:'This session already has an active deployment.'});
  const id=existing.rowCount?existing.rows[0].id:newId();
  if(existing.rowCount) await pool.query(`UPDATE deployments SET desired_state='running',status='preparing',last_error=NULL,updated_at=NOW() WHERE id=$1`,[id]);
  else await pool.query(`INSERT INTO deployments(id,user_id,session_id,status,desired_state) VALUES($1,$2,$3,'preparing','running')`,[id,req.user.sub,session.id]);
  await spawnWorker(id,session.id);
  res.status(202).json({deploymentId:id,status:'preparing'});
}));
app.get('/api/deployments', auth, asyncRoute(async(req,res)=>{
  const result=await pool.query(`SELECT d.id,d.status,d.desired_state,d.created_at,d.updated_at,d.started_at,d.stopped_at,s.phone_e164 FROM deployments d JOIN sessions s ON s.id=d.session_id WHERE d.user_id=$1 ORDER BY d.created_at DESC`,[req.user.sub]);
  res.json({deployments:result.rows});
}));
app.get('/api/deployments/:id', auth, asyncRoute(async(req,res)=>{
  const result=await ownDeployment(req.user.sub,req.params.id);
  if(!result.rowCount) return res.status(404).json({error:'NOT_FOUND',message:'Deployment not found.'});
  res.json({deployment:result.rows[0]});
}));
app.get('/api/deployments/:id/logs', auth, asyncRoute(async(req,res)=>{
  const owner=await ownDeployment(req.user.sub,req.params.id);
  if(!owner.rowCount) return res.status(404).json({error:'NOT_FOUND',message:'Deployment not found.'});
  const result=await pool.query('SELECT level,message,created_at FROM deployment_logs WHERE deployment_id=$1 ORDER BY id DESC LIMIT 150',[req.params.id]);
  res.json({logs:result.rows.reverse()});
}));
app.post('/api/deployments/:id/restart', auth, asyncRoute(async(req,res)=>{
  const result=await ownDeployment(req.user.sub,req.params.id);
  if(!result.rowCount) return res.status(404).json({error:'NOT_FOUND',message:'Deployment not found.'});
  const d=result.rows[0];
  const activeSession=await pool.query(`SELECT status,encrypted_auth FROM sessions WHERE id=$1 AND user_id=$2`,[d.session_id,req.user.sub]);
  if(!activeSession.rowCount || activeSession.rows[0].status==='revoked' || !activeSession.rows[0].encrypted_auth) return res.status(409).json({error:'SESSION_REVOKED',message:'This session is no longer available. Generate a new session before restarting.'});
  await stopWorker(d.id);
  await pool.query(`UPDATE deployments SET desired_state='running',status='preparing',last_error=NULL,updated_at=NOW() WHERE id=$1`,[d.id]);
  await spawnWorker(d.id,d.session_id);
  res.status(202).json({ok:true,status:'preparing'});
}));
app.post('/api/deployments/:id/stop', auth, asyncRoute(async(req,res)=>{
  const result=await ownDeployment(req.user.sub,req.params.id);
  if(!result.rowCount) return res.status(404).json({error:'NOT_FOUND',message:'Deployment not found.'});
  await stopWorker(req.params.id); res.json({ok:true,status:'stopped'});
}));
app.delete('/api/deployments/:id', auth, asyncRoute(async(req,res)=>{
  const result=await ownDeployment(req.user.sub,req.params.id);
  if(!result.rowCount) return res.status(404).json({error:'NOT_FOUND',message:'Deployment not found.'});
  await stopWorker(req.params.id);
  await pool.query('DELETE FROM deployments WHERE id=$1',[req.params.id]);
  res.json({ok:true,deleted:true});
}));

app.get('/api/health', asyncRoute(async(req,res)=>{await pool.query('SELECT 1');res.json({ok:true,service:'javiel-md-platform'});}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));
app.use((err,req,res,next)=>{
  if(err instanceof z.ZodError) return res.status(400).json({error:'VALIDATION_ERROR',message:err.issues[0]?.message||'Invalid request.'});
  const status=err.status||500;
  const publicMessage=status<500?err.message:'An unexpected server error occurred.';
  console.error(`[API_ERROR] ${err.code||'UNEXPECTED'} ${req.method} ${req.path}`);
  res.status(status).json({error:err.code||'SERVER_ERROR',message:publicMessage});
});

(async()=>{
  await migrate();
  await pool.query(`UPDATE sessions SET status='failed',pairing_code=NULL,error_code='PAIRING_INTERRUPTED',error_message='Pairing was interrupted by a platform restart. Please try again.',updated_at=NOW() WHERE status IN ('initializing','requesting_code','waiting_verification')`).catch(()=>{});
  const server=app.listen(port,()=>console.log(`JAVIEL MD platform listening on ${port}`));
  // Reconcile desired deployments after an API service restart.
  const desired=await pool.query(`SELECT id,session_id FROM deployments WHERE desired_state='running'`);
  for(const d of desired.rows) await spawnWorker(d.id,d.session_id);
  const shutdown=async()=>{server.close();for(const id of workers.keys()) await stopWorker(id);await pool.end();process.exit(0);};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
})().catch(err=>{console.error('Platform startup failed:',err.message);process.exit(1);});
