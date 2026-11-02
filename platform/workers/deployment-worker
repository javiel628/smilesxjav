require('dotenv').config({ path: process.env.ENV_FILE || undefined });
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pool } = require('../src/db');
const { restoreSessionSnapshot, saveSessionSnapshot } = require('../src/auth-snapshot');

const deploymentId = process.env.DEPLOYMENT_ID;
const sessionId = process.env.SESSION_REF;
const botRoot = path.resolve(process.env.BOT_ROOT || '../../bot');
let child;
let stopping = false;
let snapshotTimer;
let authDir;
let workspaceDir;

async function log(level, message) {
  const clean = String(message).replace(/\b(JAVIEL-[A-Z0-9_-]{12,}|[A-Za-z0-9_-]{30,})\b/g, '[REDACTED]').slice(0, 1800);
  await pool.query('INSERT INTO deployment_logs(deployment_id,level,message) VALUES($1,$2,$3)', [deploymentId, level, clean]).catch(() => {});
}
async function setStatus(status, extra = {}) {
  await pool.query('UPDATE deployments SET status=$1,updated_at=NOW(),last_error=$2 WHERE id=$3', [status, extra.error || null, deploymentId]);
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(snapshotTimer);
  if (child && child.exitCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 8000;
  while (child && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  if (child && child.exitCode === null) child.kill('SIGKILL');
  if (authDir) {
    await saveSessionSnapshot(pool, sessionId, authDir).catch(() => {});
    await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
  }
  if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  await pool.query(`UPDATE deployments SET status='stopped',desired_state='stopped',worker_pid=NULL,stopped_at=NOW(),updated_at=NOW() WHERE id=$1`, [deploymentId]).catch(() => {});
  await log('info', 'Bot worker stopped.');
  await pool.end();
  process.exit(0);
}

(async () => {
  try {
    await setStatus('preparing');
    await log('info', 'Preparing isolated bot worker.');
    authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'javiel-bot-'));
    await fs.chmod(authDir, 0o700);
    await setStatus('restoring_session');
    await log('info', 'Restoring encrypted WhatsApp authentication.');
    await restoreSessionSnapshot(pool, sessionId, authDir);
    const sessionRow = await pool.query('SELECT phone_e164 FROM sessions WHERE id=$1', [sessionId]);
    if (!sessionRow.rowCount) throw new Error('Linked session record not found.');
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'javiel-workspace-'));
    await fs.cp(botRoot, path.join(workspaceDir, 'bot'), { recursive: true, filter: source => !source.includes(`${path.sep}sessions${path.sep}`) });
    const workspaceBot = path.join(workspaceDir, 'bot');
    const projectNodeModules = path.resolve(__dirname, '../..', 'node_modules');
    await fs.symlink(projectNodeModules, path.join(workspaceBot, 'node_modules'), 'dir');
    await setStatus('starting');
    await log('info', 'Starting isolated copy of the original JAVIEL MD bot engine and preserved plugins.');
    child = spawn(process.execPath, [path.join(workspaceBot, 'index.js')], {
      cwd: workspaceBot,
      env: { ...process.env, AUTH_DIR: authDir, SESSION_ID: '', OWNER_NUMBER: sessionRow.rows[0].phone_e164.replace('+',''), BOT_NAME: '亗 JAVIEL MD 亗', DEPLOYMENT_ID: deploymentId, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await pool.query('UPDATE deployments SET worker_pid=$1,started_at=NOW(),updated_at=NOW() WHERE id=$2', [child.pid, deploymentId]);
    const consume = (stream, level) => {
      let pending = '';
      stream.on('data', chunk => {
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.includes('JAVIEL_STATUS:ONLINE')) { setStatus('online').catch(() => {}); log('info', 'WhatsApp connected; bot is online.').catch(() => {}); }
          else if (line.includes('Connecting JAVIEL MD to WhatsApp')) { setStatus('connecting').catch(() => {}); log(level, 'Connecting to WhatsApp…').catch(() => {}); }
          else if (line.includes('JAVIEL_STATUS:OFFLINE')) { setStatus('offline').catch(() => {}); }
          else log(level, line).catch(() => {});
        }
      });
    };
    consume(child.stdout, 'info'); consume(child.stderr, 'error');
    snapshotTimer = setInterval(() => saveSessionSnapshot(pool, sessionId, authDir).catch(err => log('warn', `Auth snapshot update failed: ${err.message}`)), 5000);
    child.on('error', async err => { await setStatus('failed', { error: 'Worker process could not start.' }); await log('error', 'Bot process failed to start.'); });
    child.on('exit', async (code, signal) => {
      clearInterval(snapshotTimer);
      await saveSessionSnapshot(pool, sessionId, authDir).catch(() => {});
      if (stopping) return;
      await setStatus(code === 0 ? 'offline' : 'failed', { error: code === 0 ? null : 'Bot process exited unexpectedly.' });
      await log(code === 0 ? 'info' : 'error', `Bot process exited (code ${code ?? 'null'}, signal ${signal || 'none'}).`);
      await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
      if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
      await pool.end();
      process.exit(code || 0);
    });
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  } catch (err) {
    await setStatus('failed', { error: err.message === 'SESSION_AUTH_MISSING' ? 'Session authentication data is missing.' : 'Worker startup failed.' }).catch(() => {});
    await log('error', err.message === 'SESSION_AUTH_MISSING' ? 'Session authentication data is missing.' : `Worker startup failed: ${err.message}`).catch(() => {});
    if (authDir) await fs.rm(authDir, { recursive: true, force: true }).catch(() => {});
    if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    await pool.end(); process.exit(1);
  }
})();
