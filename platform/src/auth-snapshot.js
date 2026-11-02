const fs = require('node:fs/promises');
const path = require('node:path');
const { encrypt, decrypt } = require('./security');

async function readSnapshot(dir) {
  const files = {};
  async function walk(current, prefix = '') {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      const rel = path.posix.join(prefix, item.name);
      if (item.isDirectory()) await walk(full, rel);
      else if (item.isFile()) files[rel] = (await fs.readFile(full)).toString('base64');
    }
  }
  await walk(dir);
  return Buffer.from(JSON.stringify({ version: 1, files }));
}
async function writeSnapshot(dir, payload) {
  const parsed = JSON.parse(payload.toString('utf8'));
  if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== 'object') throw new Error('Invalid authentication snapshot');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [rel, data] of Object.entries(parsed.files)) {
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('Unsafe auth snapshot path');
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, Buffer.from(data, 'base64'), { mode: 0o600 });
  }
}
async function saveSessionSnapshot(pool, sessionId, dir) {
  const plain = await readSnapshot(dir);
  const sealed = encrypt(plain);
  await pool.query(
    `UPDATE sessions SET encrypted_auth=$1, auth_iv=$2, auth_tag=$3, updated_at=NOW() WHERE id=$4`,
    [sealed.ciphertext, sealed.iv, sealed.tag, sessionId]
  );
}
async function restoreSessionSnapshot(pool, sessionId, dir) {
  const result = await pool.query('SELECT encrypted_auth, auth_iv, auth_tag FROM sessions WHERE id=$1', [sessionId]);
  if (!result.rowCount || !result.rows[0].encrypted_auth) throw new Error('SESSION_AUTH_MISSING');
  const row = result.rows[0];
  await writeSnapshot(dir, decrypt(row.encrypted_auth, row.auth_iv, row.auth_tag));
}
module.exports = { saveSessionSnapshot, restoreSessionSnapshot };
