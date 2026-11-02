
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const { saveSessionSnapshot } = require('./auth-snapshot');
const { newId, newSessionId } = require('./security');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const P = require('pino');

const active = new Map();

const safeError = (err) => {
  const message = String(err?.message || 'Connection failed');

  if (/timeout/i.test(message)) {
    return [
      'PAIRING_TIMEOUT',
      'WhatsApp did not respond in time. Please try again.'
    ];
  }

  if (/logged.?out|401/i.test(message)) {
    return [
      'WHATSAPP_REJECTED',
      'WhatsApp rejected the connection. Start a new pairing request.'
    ];
  }

  return [
    'PAIRING_FAILED',
    'Could not complete WhatsApp pairing. Please try again later.'
  ];
};

async function startPairing(pool, userId, phoneInput) {
  const parsed = parsePhoneNumberFromString(phoneInput);

  if (!parsed || !parsed.isValid()) {
    const error = new Error(
      'Enter a valid international phone number including country code, for example +254712345678.'
    );

    error.status = 400;
    error.code = 'INVALID_PHONE';

    throw error;
  }

  const phone = parsed.number;

  await pool.query(`
    UPDATE sessions
    SET status='failed',
        pairing_code=NULL,
        error_code='PAIRING_EXPIRED',
        error_message='Pairing request expired.',
        updated_at=NOW()
    WHERE status IN (
      'initializing',
      'requesting_code',
      'waiting_verification'
    )
    AND expires_at <= NOW()
  `);

  const existing = await pool.query(
    `
    SELECT id
    FROM sessions
    WHERE phone_e164=$1
    AND status IN (
      'initializing',
      'requesting_code',
      'waiting_verification',
      'connected',
      'saved'
    )
    AND (status='saved' OR expires_at > NOW())
    `,
    [phone]
  );

  if (existing.rowCount) {
    const error = new Error(
      'This WhatsApp number already has a saved or active session. Revoke it before pairing again.'
    );

    error.status = 409;
    error.code = 'PAIRING_ALREADY_ACTIVE';

    throw error;
  }

  const id = newId();

  const expiresAt = new Date(
    Date.now() +
    Number(process.env.PAIRING_TTL_MINUTES || 10) * 60000
  );

  try {
    await pool.query(
      `
      INSERT INTO sessions(
        id,
        user_id,
        phone_e164,
        status,
        expires_at
      )
      VALUES($1,$2,$3,'initializing',$4)
      `,
      [id, userId, phone, expiresAt]
    );
  } catch (err) {
    if (err.code === '23505') {
      const error = new Error(
        'This WhatsApp number already has a saved or active session.'
      );

      error.status = 409;
      error.code = 'PAIRING_ALREADY_ACTIVE';

      throw error;
    }

    throw err;
  }

  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'javiel-pair-')
  );

  await fs.chmod(dir, 0o700);

  const entry = {
    dir,
    socket: null,
    timer: null,
    snapshotTimer: null,
    closed: false
  };

  active.set(id, entry);

  function cleanup(removeFiles = true) {
    if (entry.closed) return;

    entry.closed = true;

    if (entry.timer) clearTimeout(entry.timer);

    if (entry.snapshotTimer) {
      clearInterval(entry.snapshotTimer);
    }

    try {
      entry.socket?.end(undefined);
    } catch (error) {
      console.error('[PAIRING_CLEANUP]', error.message);
    }

    if (active.get(id) === entry) {
      active.delete(id);
    }

    if (removeFiles) {
      fs.rm(dir, {
        recursive: true,
        force: true
      }).catch(error => {
        console.error('[PAIRING_FILE_CLEANUP]', error.message);
      });
    }
  }

  (async () => {
    try {
      console.log('[PAIRING]', id, 'Initializing WhatsApp connection');

      const { state, saveCreds } =
        await useMultiFileAuthState(dir);

      const { version } =
        await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        auth: state,
        version,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Firefox'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 15000
      });

      entry.socket = sock;

      sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          await saveSessionSnapshot(pool, id, dir);
        } catch (error) {
          console.error('[PAIRING_CREDS]', error.message);
        }
      });

      // Register connection listener BEFORE requesting pairing code.
      sock.ev.on('connection.update', async ({
        connection,
        lastDisconnect
      }) => {
        if (entry.closed) return;

        if (connection === 'connecting') {
          console.log('[PAIRING]', id, 'Connecting to WhatsApp');
        }

        if (connection === 'open') {
          try {
            console.log('[PAIRING]', id, 'WhatsApp connected');

            await saveCreds();
            await saveSessionSnapshot(pool, id, dir);

            const publicId = newSessionId();

            await pool.query(
              `
              UPDATE sessions
              SET public_id=$1,
                  status='saved',
                  pairing_code=NULL,
                  error_code=NULL,
                  error_message=NULL,
                  updated_at=NOW()
              WHERE id=$2
              `,
              [publicId, id]
            );

            // Best-effort delivery of the session reference.
            await sock.sendMessage(
              sock.user.id,
              {
                text:
                  `亗 JAVIEL MD 亗\n` +
                  `Your session reference is:\n${publicId}\n` +
                  `Keep it private.`
              }
            ).catch(error => {
              console.error(
                '[PAIRING_MESSAGE]',
                error.message
              );
            });

            cleanup(true);

          } catch (error) {
            console.error(
              '[PAIRING_SAVE_ERROR]',
              error
            );

            const [errorCode, message] = safeError(error);

            await pool.query(
              `
              UPDATE sessions
              SET status='failed',
                  pairing_code=NULL,
                  error_code=$1,
                  error_message=$2,
                  updated_at=NOW()
              WHERE id=$3
              `,
              [errorCode, message, id]
            ).catch(() => {});

            cleanup(true);
          }
        }

        if (connection === 'close') {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          console.error(
            '[PAIRING_DISCONNECTED]',
            id,
            'Status:',
            statusCode || 'unknown',
            lastDisconnect?.error?.message || ''
          );

          if (statusCode === DisconnectReason.loggedOut) {
            await pool.query(
              `
              UPDATE sessions
              SET status='failed',
                  pairing_code=NULL,
                  error_code='WHATSAPP_LOGGED_OUT',
                  error_message='WhatsApp logged out before the session was saved.',
                  updated_at=NOW()
              WHERE id=$1 AND status!='saved'
              `,
              [id]
            ).catch(() => {});

            cleanup(true);
          }
        }
      });

      await pool.query(
        `
        UPDATE sessions
        SET status='requesting_code',
            updated_at=NOW()
        WHERE id=$1
        `,
        [id]
      );

      console.log('[PAIRING]', id, 'Requesting pairing code');

      const code = await sock.requestPairingCode(
        parsed.number.replace('+', '')
      );

      if (entry.closed) return;

      await pool.query(
        `
        UPDATE sessions
        SET pairing_code=$1,
            status='waiting_verification',
            updated_at=NOW()
        WHERE id=$2
        `,
        [code, id]
      );

      console.log('[PAIRING]', id, 'Pairing code generated');

      entry.snapshotTimer = setInterval(() => {
        saveSessionSnapshot(pool, id, dir).catch(error => {
          console.error(
            '[PAIRING_SNAPSHOT]',
            error.message
          );
        });
      }, 2000);

      entry.timer = setTimeout(async () => {
        console.log('[PAIRING]', id, 'Pairing expired');

        await pool.query(
          `
          UPDATE sessions
          SET status='failed',
              pairing_code=NULL,
              error_code='PAIRING_EXPIRED',
              error_message='Pairing code expired. Start a new request.',
              updated_at=NOW()
          WHERE id=$1 AND status!='saved'
          `,
          [id]
        ).catch(() => {});

        cleanup(true);

      }, Math.max(0, expiresAt.getTime() - Date.now()));

    } catch (error) {
      console.error(
        '[PAIRING_ERROR]',
        id,
        error?.stack || error?.message || error
      );

      const [errorCode, message] = safeError(error);

      await pool.query(
        `
        UPDATE sessions
        SET status='failed',
            pairing_code=NULL,
            error_code=$1,
            error_message=$2,
            updated_at=NOW()
        WHERE id=$3 AND status!='saved'
        `,
        [errorCode, message, id]
      ).catch(dbError => {
        console.error(
          '[PAIRING_DATABASE_ERROR]',
          dbError.message
        );
      });

      cleanup(true);
    }
  })();

  return {
    id,
    phone,
    expiresAt
  };
}

function cleanup(id, removeFiles = true) {
  const entry = active.get(id);

  if (!entry || entry.closed) return;

  entry.closed = true;

  if (entry.timer) clearTimeout(entry.timer);

  if (entry.snapshotTimer) {
    clearInterval(entry.snapshotTimer);
  }

  try {
    entry.socket?.end(undefined);
  } catch (error) {
    console.error('[PAIRING_CLEANUP]', error.message);
  }

  active.delete(id);

  if (removeFiles) {
    fs.rm(entry.dir, {
      recursive: true,
      force: true
    }).catch(() => {});
  }
}

async function cancelPairing(id) {
  cleanup(id, true);
}

module.exports = {
  startPairing,
  active,
  cancelPairing
};
