const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { saveSessionSnapshot } = require('./auth-snapshot');
const { newId, newSessionId } = require('./security');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const P = require('pino');

const active = new Map();
const safeError = (err) => {
  const text = String(err?.message || 'Connection failed');
  if (/timeout/i.test(text)) return ['PAIRING_TIMEOUT', 'WhatsApp did not respond in time. Please try again.'];
  if (/logged.?out|401/i.test(text)) return ['WHATSAPP_REJECTED', 'WhatsApp rejected the connection. Start a new pairing request.'];
  return ['PAIRING_FAILED', 'Could not complete WhatsApp pairing. Please try again later.'];
};

async function startPairing(pool, userId, phoneInput) {
  const parsed = parsePhoneNumberFromString(phoneInput);
  if (!parsed || !parsed.isValid()) {
    const e = new Error('Enter a valid international phone number including country code, for example +254712345678.');
    e.status = 400; e.code = 'INVALID_PHONE'; throw e;
  }
  const phone = parsed.number;
  await pool.query(`UPDATE sessions SET status='failed',pairing_code=NULL,error_code='PAIRING_EXPIRED',error_message='Pairing request expired.',updated_at=NOW() WHERE status IN ('initializing','requesting_code','waiting_verification') AND expires_at<=NOW()`);
  const existing = await pool.query(
    `SELECT id FROM sessions WHERE phone_e164=$1 AND status IN ('initializing','requesting_code','waiting_verification','connected','saved') AND (status='saved' OR expires_at>NOW())`,
    [phone]
  );
  if (existing.rowCount) { const e = new Error('This WhatsApp number already has a saved or active session. Revoke it before pairing again.'); e.status = 409; e.code = 'PAIRING_ALREADY_ACTIVE'; throw e; }

  const id = newId();
  const expiresAt = new Date(Date.now() + Number(process.env.PAIRING_TTL_MINUTES || 10) * 60000);
  try {
    await pool.query(
      `INSERT INTO sessions(id,user_id,phone_e164,status,expires_at) VALUES($1,$2,$3,'initializing',$4)`,
      [id, userId, phone, expiresAt]
    );
  } catch (err) {
    if (err.code === '23505') { const conflict = new Error('This WhatsApp number already has a saved or active session. Revoke it before pairing again.'); conflict.status = 409; conflict.code = 'PAIRING_ALREADY_ACTIVE'; throw conflict; }
    throw err;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'javiel-pair-'));
  await fs.chmod(dir, 0o700);
  const entry = { dir, socket: null, timer: null, snapshotTimer: null };
  active.set(id, entry);

  (async () => {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(dir);
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({ auth: state, version, logger: P({ level: 'silent' }), printQRInTerminal: false, browser: Browsers.macOS('Firefox') });
      entry.socket = sock;
      sock.ev.on('creds.update', async () => {
        await saveCreds();
        await saveSessionSnapshot(pool, id, dir).catch(() => {});
      });
      entry.snapshotTimer = setInterval(() => saveSessionSnapshot(pool, id, dir).catch(() => {}), 2000);
      await pool.query(`UPDATE sessions SET status='requesting_code',updated_at=NOW() WHERE id=$1`, [id]);
      const code = await sock.requestPairingCode(parsed.number.replace('+', ''));
      await pool.query(`UPDATE sessions SET pairing_code=$1,status='waiting_verification',updated_at=NOW() WHERE id=$2`, [code, id]);
      sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          try {
            await saveCreds();
            await saveSessionSnapshot(pool, id, dir);
            const publicId = newSessionId();
            await pool.query(`UPDATE sessions SET public_id=$1,status='saved',pairing_code=NULL,updated_at=NOW() WHERE id=$2`, [publicId, id]);
            // Delivery is best-effort. The dashboard remains the authoritative retrieval path.
            await sock.sendMessage(sock.user.id, { text: `亗 JAVIEL MD 亗\nYour session reference is:\n${publicId}\nKeep it private. It is not your WhatsApp credentials.` }).catch(() => {});
            await pool.query(`UPDATE sessions SET status='saved',updated_at=NOW() WHERE id=$1`, [id]);
            cleanup(id, true);
          } catch (err) {
            const [code, message] = safeError(err);
            await pool.query(`UPDATE sessions SET status='failed',pairing_code=NULL,error_code=$1,error_message=$2,updated_at=NOW() WHERE id=$3`, [code, message, id]);
            cleanup(id, true);
          }
        }
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            await pool.query(`UPDATE sessions SET status='failed',pairing_code=NULL,error_code='WHATSAPP_LOGGED_OUT',error_message='WhatsApp logged out before the session was saved.',updated_at=NOW() WHERE id=$1 AND status!='saved'`, [id]).catch(() => {});
            cleanup(id, true);
          }
        }
      });
      entry.timer = setTimeout(async () => {
        await pool.query(`UPDATE sessions SET status='failed',error_code='PAIRING_EXPIRED',error_message='Pairing code expired. Start a new request.',updated_at=NOW() WHERE id=$1 AND status!='saved'`, [id]).catch(() => {});
        cleanup(id, true);
      }, expiresAt.getTime() - Date.now());
    } catch (err) {
      const [code, message] = safeError(err);
      await pool.query(`UPDATE sessions SET status='failed',pairing_code=NULL,error_code=$1,error_message=$2,updated_at=NOW() WHERE id=$3`, [code, message, id]).catch(() => {});
      cleanup(id, true);
    }
  })();
  return { id, phone, expiresAt };
}
function cleanup(id, removeFiles) {
  const entry = active.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.snapshotTimer) clearInterval(entry.snapshotTimer);
  try { entry.socket?.end(undefined); } catch {}
  active.delete(id);
  if (removeFiles) fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
}
async function cancelPairing(id) { cleanup(id, true); }
module.exports = { startPairing, active, cancelPairing };
