const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

function encryptionKey() {
  const raw = process.env.SESSION_ENCRYPTION_KEY || '';
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be base64 for exactly 32 random bytes');
  return key;
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}
function decrypt(ciphertext, iv, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function makeToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '12h', issuer: 'javiel-md' });
}
function auth(req, res, next) {
  const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('javiel_token='));
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (cookie ? decodeURIComponent(cookie.slice('javiel_token='.length)) : '');
  try {
    if (!token) throw new Error('missing');
    req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'javiel-md' });
    next();
  } catch {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Please sign in again.' });
  }
}
async function hashPassword(password) { return bcrypt.hash(password, 12); }
async function verifyPassword(password, hash) { return bcrypt.compare(password, hash); }
function newId() { return crypto.randomUUID(); }
function newSessionId() { return `JAVIEL-${crypto.randomBytes(24).toString('base64url').toUpperCase()}`; }
module.exports = { encrypt, decrypt, makeToken, auth, hashPassword, verifyPassword, newId, newSessionId };
