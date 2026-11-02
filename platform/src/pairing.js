
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

function normalizePhoneNumber(input) {
  const raw = String(input || '').trim();

  if (!raw) return null;

  let normalized;

  if (raw.startsWith('+')) {
    normalized = raw;
  } else {
    const digits = raw.replace(/\D/g, '');

    if (digits.startsWith('254')) {
      normalized = `+${digits}`;
    } else if (digits.startsWith('0')) {
      normalized = `+254${digits.slice(1)}`;
    } else {
      normalized = `+254${digits}`;
    }
  }

  const parsed = parsePhoneNumberFromString(normalized);

  return parsed && parsed.isValid() ? parsed : null;
}

function safeError(err) {
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
}

async function startPairing(pool, userId, phoneInput) {
  const parsed = normalizePhoneNumber(phoneInput);

  if (!parsed) {
    const error = new Error(
      'Enter a valid phone number, for example 254712345678 or +254712345678.'
    );

    error.status = 400;
    error.code = 'INVALID_PHONE';
    throw error;
  }

  const phone = parsed.number;
  const phoneNumber = phone.replace(/\D/g, '');

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

  const ttlMinutes = Number(
    process.env.PAIRING_TTL_MINUTES || 10
  );

  const expiresAt = new Date(
    Date.now() + ttlMinutes * 60000
  );

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

  let dir;

  try {
    dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'javiel-pair-')
    );

    await fs.chmod(dir, 0o700);
  } catch (error) {
    await pool.query(
      `
      UPDATE sessions
      SET status='failed',
          error_code='PAIRING_STORAGE_ERROR',
          error_message='Could not initialize temporary session storage.',
          updated_at=NOW()
      WHERE id=$1
      `,
      [id]
    ).catch(() => {});

    throw error;
  }

  const entry = {
    dir,
    socket: null,
    timer: null,
    requestTimer: null,
    reconnectTimer: null,
    snapshotTimer: null,
    requestStarted: false,
    codeGenerated: false,
    reconnecting: false,
    restartCount: 0,
    saved: false,
    closed: false
  };

  active.set(id, entry);

  let state;
  let saveCreds;
  let version;

  // Keep credential writes in order so a restart does not
  // happen before updated credentials have been saved.
  let credsSaveQueue = Promise.resolve();

  function cleanup(removeFiles = true) {
    if (entry.closed) return;

    entry.closed = true;

    if (entry.timer) clearTimeout(entry.timer);
    if (entry.requestTimer) clearTimeout(entry.requestTimer);
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);

    if (entry.snapshotTimer) {
      clearInterval(entry.snapshotTimer);
    }

    try {
      entry.socket?.end(undefined);
    } catch (error) {
      console.error('[PAIRING_CLEANUP]', id, error.message);
    }

    if (active.get(id) === entry) {
      active.delete(id);
    }

    if (removeFiles) {
      fs.rm(dir, {
        recursive: true,
        force: true
      }).catch(error => {
        console.error(
          '[PAIRING_FILE_CLEANUP]',
          id,
          error.message
        );
      });
    }
  }

  async function failSession(error, label = 'PAIRING_ERROR') {
    if (entry.closed || entry.saved) return;

    console.error(
      `[${label}]`,
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
      WHERE id=$3
      AND status!='saved'
      `,
      [errorCode, message, id]
    ).catch(dbError => {
      console.error(
        '[PAIRING_DATABASE_ERROR]',
        id,
        dbError.message
      );
    });

    cleanup(true);
  }

  async function requestPairingCode(sock) {
    if (
      entry.closed ||
      entry.requestStarted ||
      entry.codeGenerated
    ) {
      return;
    }

    entry.requestStarted = true;

    try {
      console.log(
        '[PAIRING]',
        id,
        'Requesting WhatsApp pairing code'
      );

      const code = await sock.requestPairingCode(phoneNumber);

      if (entry.closed) return;

      if (!code) {
        throw new Error('WhatsApp returned an empty pairing code.');
      }

      await pool.query(
        `
        UPDATE sessions
        SET pairing_code=$1,
            status='waiting_verification',
            error_code=NULL,
            error_message=NULL,
            updated_at=NOW()
        WHERE id=$2
        AND status!='saved'
        `,
        [code, id]
      );

      if (entry.closed) return;

      entry.codeGenerated = true;

      console.log(
        '[PAIRING]',
        id,
        'Pairing code generated successfully'
      );

      entry.snapshotTimer = setInterval(() => {
        if (entry.closed) return;

        saveSessionSnapshot(pool, id, dir).catch(error => {
          console.error(
            '[PAIRING_SNAPSHOT]',
            id,
            error.message
          );
        });
      }, 2000);

    } catch (error) {
      await failSession(error, 'PAIRING_CODE_ERROR');
    }
  }

  async function saveConnectedSession(sock) {
    if (entry.closed || entry.saved) return;

    try {
      console.log(
        '[PAIRING]',
        id,
        'WhatsApp connection opened'
      );

      await credsSaveQueue;

      if (entry.closed || entry.saved) return;

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

      entry.saved = true;

      console.log(
        '[PAIRING]',
        id,
        'Session saved successfully'
      );

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
          id,
          error.message
        );
      });

      cleanup(true);

    } catch (error) {
      await failSession(error, 'PAIRING_SAVE_ERROR');
    }
  }

  async function reconnectSocket() {
    if (entry.closed || entry.saved || entry.reconnecting) {
      return;
    }

    entry.reconnecting = true;

    try {
      // Wait until the latest credentials have been written.
      await credsSaveQueue;

      if (entry.closed || entry.saved) return;

      console.log(
        '[PAIRING]',
        id,
        'Restarting WhatsApp socket with existing credentials'
      );

      await createSocket();
    } catch (error) {
      await failSession(error, 'PAIRING_RECONNECT_ERROR');
    } finally {
      entry.reconnecting = false;
    }
  }

  async function createSocket() {
    if (entry.closed || entry.saved) return;

    const sock = makeWASocket({
      auth: state,
      version,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.macOS('Firefox'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    entry.socket = sock;

    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', error => {
        console.error(
          '[PAIRING_WEBSOCKET_ERROR]',
          id,
          error.message
        );
      });
    }

    sock.ev.on('creds.update', () => {
      if (entry.closed) return;

      credsSaveQueue = credsSaveQueue
        .then(async () => {
          if (entry.closed) return;

          await saveCreds();

          if (!entry.closed) {
            await saveSessionSnapshot(pool, id, dir);
          }
        })
        .catch(error => {
          console.error(
            '[PAIRING_CREDS]',
            id,
            error.message
          );
        });
    });

    sock.ev.on('connection.update', async update => {
      if (entry.closed || entry.socket !== sock) return;

      const {
        connection,
        lastDisconnect
      } = update;

      if (connection === 'connecting') {
        console.log(
          '[PAIRING]',
          id,
          'Connecting to WhatsApp'
        );
      }

      if (connection === 'open') {
        await saveConnectedSession(sock);
      }

      if (connection === 'close') {
        const disconnectError = lastDisconnect?.error;

        const statusCode =
          disconnectError?.output?.statusCode ??
          disconnectError?.data?.statusCode;

        console.error(
          '[PAIRING_DISCONNECTED]',
          id,
          'Status:',
          statusCode || 'unknown',
          'Message:',
          disconnectError?.message || 'No message',
          'Code generated:',
          entry.codeGenerated
        );

        if (entry.saved || entry.closed) return;

        if (statusCode === DisconnectReason.loggedOut) {
          await pool.query(
            `
            UPDATE sessions
            SET status='failed',
                pairing_code=NULL,
                error_code='WHATSAPP_LOGGED_OUT',
                error_message='WhatsApp logged out before the session was saved.',
                updated_at=NOW()
            WHERE id=$1
            AND status!='saved'
            `,
            [id]
          ).catch(() => {});

          cleanup(true);
          return;
        }

        // 515 means WhatsApp requires a socket restart.
        // Keep the same authentication directory and reconnect.
        if (
          statusCode === DisconnectReason.restartRequired &&
          entry.codeGenerated
        ) {
          if (entry.restartCount >= 4) {
            await failSession(
              new Error('WhatsApp requested too many socket restarts.'),
              'PAIRING_RESTART_LIMIT'
            );
            return;
          }

          entry.restartCount += 1;

          console.log(
            '[PAIRING]',
            id,
            'WhatsApp requested restart. Attempt:',
            entry.restartCount
          );

          if (entry.reconnectTimer) {
            clearTimeout(entry.reconnectTimer);
          }

          entry.reconnectTimer = setTimeout(() => {
            entry.reconnectTimer = null;

            reconnectSocket().catch(error => {
              console.error(
                '[PAIRING_RECONNECT]',
                id,
                error.message
              );
            });
          }, 1500);

          return;
        }

        // Other disconnects are not treated as successful pairing.
        await failSession(
          disconnectError || new Error(
            'WhatsApp disconnected before pairing was completed.'
          ),
          'PAIRING_DISCONNECTED_ERROR'
        );
      }
    });
  }

  (async () => {
    try {
      console.log(
        '[PAIRING]',
        id,
        'Initializing WhatsApp connection'
      );

      const auth = await useMultiFileAuthState(dir);

      state = auth.state;
      saveCreds = auth.saveCreds;

      if (entry.closed) return;

      const latest = await fetchLatestBaileysVersion();

      version = latest.version;

      console.log(
        '[PAIRING]',
        id,
        'Using WhatsApp Web version',
        version
      );

      await createSocket();

      await pool.query(
        `
        UPDATE sessions
        SET status='requesting_code',
            updated_at=NOW()
        WHERE id=$1
        `,
        [id]
      );

      entry.requestTimer = setTimeout(() => {
        entry.requestTimer = null;

        if (entry.closed || entry.codeGenerated) return;

        requestPairingCode(entry.socket).catch(error => {
          console.error(
            '[PAIRING_REQUEST_HANDLER]',
            id,
            error.message
          );
        });
      }, 3000);

      entry.timer = setTimeout(async () => {
        if (entry.closed || entry.saved) return;

        console.log(
          '[PAIRING]',
          id,
          'Pairing expired'
        );

        await pool.query(
          `
          UPDATE sessions
          SET status='failed',
              pairing_code=NULL,
              error_code='PAIRING_EXPIRED',
              error_message='Pairing code expired. Start a new request.',
              updated_at=NOW()
          WHERE id=$1
          AND status!='saved'
          `,
          [id]
        ).catch(() => {});

        cleanup(true);
      }, Math.max(0, expiresAt.getTime() - Date.now()));

    } catch (error) {
      await failSession(error);
    }
  })().catch(error => {
    console.error(
      '[PAIRING_UNHANDLED]',
      id,
      error?.stack || error
    );
  });

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
  if (entry.requestTimer) clearTimeout(entry.requestTimer);
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);

  if (entry.snapshotTimer) {
    clearInterval(entry.snapshotTimer);
  }

  try {
    entry.socket?.end(undefined);
  } catch (error) {
    console.error(
      '[PAIRING_CLEANUP]',
      id,
      error.message
    );
  }

  active.delete(id);

  if (removeFiles) {
    fs.rm(entry.dir, {
      recursive: true,
      force: true
    }).catch(error => {
      console.error(
        '[PAIRING_FILE_CLEANUP]',
        id,
        error.message
      );
    });
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
