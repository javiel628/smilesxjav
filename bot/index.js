const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  proto,
  generateWAMessageContent,
  generateWAMessage,
  AnyMessageContent,
  prepareWAMessageMedia,
  areJidsSameUser,
  downloadContentFromMessage,
  MessageRetryMap,
  generateForwardMessageContent,
  generateWAMessageFromContent,
  generateMessageID,
  makeInMemoryStore,
  jidDecode,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const l = console.log;
const {
  getBuffer, getGroupAdmins, getRandom, h2k,
  isUrl, Json, runtime, sleep, fetchJson
} = require('./lib/functions');
const fs = require('fs');
const P = require('pino');
const config = require('./config');
const { sms, downloadMediaMessage } = require('./lib/msg');
const FileType = require('file-type');
const axios = require('axios');
const os = require('os');
const Crypto = require('crypto');
const path = require('path');
const prefix = config.PREFIX;

const loadedPlugins = new Set();
const ownerNumber = String(config.OWNER_NUMBER || '')
  .split(',')
  .map(v => v.replace(/\D/g, ''))
  .filter(Boolean);

const tempDir = path.join(
  os.tmpdir(),
  `javiel-cache-${process.env.DEPLOYMENT_ID || process.pid}`
);

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const clearTempDir = () => {
  fs.readdir(tempDir, (readErr, files) => {
    if (readErr) {
      if (readErr.code !== 'ENOENT') {
        console.error('[TEMP]', readErr.message);
      }
      return;
    }

    for (const file of files) {
      const filePath = path.join(tempDir, file);

      fs.stat(filePath, (statErr, stats) => {
        if (statErr || Date.now() - stats.mtimeMs < 30 * 60 * 1000) return;

        fs.unlink(filePath, err => {
          if (err && err.code !== 'ENOENT') {
            console.error('[TEMP]', err.message);
          }
        });
      });
    }
  });
};

setInterval(clearTempDir, 5 * 60 * 1000);

const authDir = process.env.AUTH_DIR;

if (!authDir) {
  throw new Error(
    'AUTH_DIR is required. Start this bot through the JAVIEL MD deployment worker.'
  );
}

fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

async function connectToWA() {
  console.log('Connecting JAVIEL MD to WhatsApp…');

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Firefox'),
    syncFullHistory: false,
    auth: state,
    version
  });

  conn.ev.on('connection.update', update => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      console.log('JAVIEL_STATUS:OFFLINE');

      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          connectToWA().catch(err =>
            console.error('Reconnect failed:', err)
          );
        }, 5000);
      } else {
        console.log('WhatsApp session logged out.');
        setTimeout(() => process.exit(1), 1000);
      }
    }

    if (connection === 'open') {
      console.log('🧬 Installing JAVIEL MD Plugins');

      const pluginDir = path.join(__dirname, 'plugins');

      fs.readdirSync(pluginDir)
        .filter(file => path.extname(file).toLowerCase() === '.js')
        .sort()
        .forEach(file => {
          try {
            if (!loadedPlugins.has(file)) {
              require(path.join(pluginDir, file));
              loadedPlugins.add(file);
            }
          } catch (error) {
            console.error(`[PLUGIN LOAD ERROR] ${file}:`, error);
          }
        });

      console.log('Plugins installed successful ✅');
      console.log('Bot connected to WhatsApp ✅');
      console.log('JAVIEL_STATUS:ONLINE');

      const up = `*亗 JAVIEL MD 亗 is connected!* 👋

> Your personal WhatsApp assistant is online.

- *PREFIX:* ${prefix}
- *DEVELOPER:* JAVIEL × SMILE MODZ

> © 2026`;

      conn.sendMessage(conn.user.id, { text: up })
        .catch(err => console.error('[ONLINE MESSAGE]', err.message));
    }
  });

  conn.ev.on('creds.update', saveCreds);

  conn.ev.on('messages.upsert', async update => {
    for (const incomingMessage of (update.messages || [])) {
      try {
        await handleIncomingMessage(incomingMessage);
      } catch (error) {
        console.error('[MESSAGE HANDLER ERROR]', error);
      }
    }
  });

  async function handleIncomingMessage(mek) {
    if (!mek || !mek.message ||
        (mek.key?.remoteJid === 'status@broadcast' && mek.key.fromMe)) {
      return;
    }

    mek.message = getContentType(mek.message) === 'ephemeralMessage'
      ? mek.message.ephemeralMessage.message
      : mek.message;

    const viewOncePayload =
      mek.message.viewOnceMessageV2 ||
      mek.message.viewOnceMessage ||
      null;

    if (config.READ_MESSAGE === 'true') {
      await conn.readMessages([mek.key]);
    }

    if (mek.message.viewOnceMessage) {
      mek.message = mek.message.viewOnceMessage.message;
    }

    if (mek.message.viewOnceMessageV2) {
      mek.message = mek.message.viewOnceMessageV2.message;
    }

    if (mek.key?.remoteJid === 'status@broadcast' &&
        config.AUTO_STATUS_SEEN === 'true') {
      await conn.readMessages([mek.key]);
    }

    if (mek.key?.remoteJid === 'status@broadcast' &&
        config.AUTO_STATUS_REPLY === 'true') {
      const user = mek.key.participant;
      const text = `${config.AUTO_STATUS__MSG}`;

      await conn.sendMessage(user, {
        text,
        react: { text: '🩷', key: mek.key }
      }, { quoted: mek });
    }

    const jawadik = viewOncePayload;

    if (jawadik && config.ANTI_VV === 'true') {
      const ownerJid = ownerNumber[0]
        ? `${ownerNumber[0]}@s.whatsapp.net`
        : null;

      if (ownerJid && jawadik.message?.imageMessage) {
        const media = jawadik.message.imageMessage;
        const file = await conn.downloadAndSaveMediaMessage(media);

        return conn.sendMessage(ownerJid, {
          image: { url: file },
          caption: media.caption || ''
        }, { quoted: mek });
      }

      if (ownerJid && jawadik.message?.videoMessage) {
        const media = jawadik.message.videoMessage;
        const file = await conn.downloadAndSaveMediaMessage(media);

        return conn.sendMessage(ownerJid, {
          video: { url: file },
          caption: media.caption || ''
        }, { quoted: mek });
      }

      if (ownerJid && jawadik.message?.audioMessage) {
        const file = await conn.downloadAndSaveMediaMessage(
          jawadik.message.audioMessage
        );

        return conn.sendMessage(ownerJid, {
          audio: { url: file },
          mimetype: 'audio/mpeg'
        }, { quoted: mek });
      }
    }

    const m = sms(conn, mek);
    const type = getContentType(mek.message);
    const from = mek.key.remoteJid;

    const quoted = type === 'extendedTextMessage' &&
      mek.message.extendedTextMessage.contextInfo
      ? mek.message.extendedTextMessage.contextInfo.quotedMessage || []
      : [];

    const body = type === 'conversation'
      ? mek.message.conversation
      : type === 'extendedTextMessage'
        ? mek.message.extendedTextMessage.text
        : type === 'imageMessage'
          ? mek.message.imageMessage.caption || ''
          : type === 'videoMessage'
            ? mek.message.videoMessage.caption || ''
            : '';

    const isCmd = body.startsWith(prefix);
    const command = isCmd
      ? body.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase()
      : '';

    const args = body.trim().split(/ +/).slice(1);
    const q = args.join(' ');
    const isGroup = from.endsWith('@g.us');

    const sender = mek.key.fromMe
      ? conn.user.id.split(':')[0] + '@s.whatsapp.net'
      : mek.key.participant || mek.key.remoteJid;

    const senderNumber = sender.split('@')[0];
    const botNumber = conn.user.id.split(':')[0];
    const pushname = mek.pushName || 'Sin Nombre';
    const isMe = botNumber === senderNumber;
    const isOwner = ownerNumber.includes(senderNumber) || isMe;

    const botNumber2 = await jidNormalizedUser(conn.user.id);

    const groupMetadata = isGroup
      ? await conn.groupMetadata(from).catch(() => null)
      : null;

    const groupName = groupMetadata?.subject || '';
    const participants = groupMetadata?.participants || [];
    const groupAdmins = isGroup ? await getGroupAdmins(participants) : [];

    const isBotAdmins = isGroup && groupAdmins.includes(botNumber2);
    const isAdmins = isGroup &&
      (groupAdmins.includes(sender) ||
       groupAdmins.includes(conn.decodeJid(sender)));

    const isReact = Boolean(m.message.reactionMessage);
    const reply = teks =>
      conn.sendMessage(from, { text: teks }, { quoted: mek });

    conn.decodeJid = jid => {
      if (!jid) return jid;

      if (/:\d+@/gi.test(jid)) {
        const decoded = jidDecode(jid) || {};

        return decoded.user && decoded.server
          ? decoded.user + '@' + decoded.server
          : jid;
      }

      return jid;
    };
  conn.copyNForward = async (jid, message, forceForward = false, options = {}) => {
    let vtype;

    if (options.readViewOnce) {
      message.message = message.message?.ephemeralMessage?.message ||
        message.message;

      vtype = Object.keys(message.message.viewOnceMessage.message)[0];

      delete message.message.viewOnceMessage.message[vtype].viewOnce;

      message.message = {
        ...message.message.viewOnceMessage.message
      };
    }

    const mtype = Object.keys(message.message)[0];
    const content = await generateForwardMessageContent(message, forceForward);
    const ctype = Object.keys(content)[0];

    let context = {};

    if (mtype !== 'conversation') {
      context = message.message[mtype].contextInfo || {};
    }

    content[ctype].contextInfo = {
      ...context,
      ...content[ctype].contextInfo
    };

    const waMessage = await generateWAMessageFromContent(jid, content, {
      ...content[ctype],
      ...options
    });

    await conn.relayMessage(jid, waMessage.message, {
      messageId: waMessage.key.id
    });

    return waMessage;
  };

  conn.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
    const quoted = message.msg || message;
    const mime = quoted.mimetype || '';
    const messageType = message.mtype
      ? message.mtype.replace(/Message/gi, '')
      : mime.split('/')[0];

    const stream = await downloadContentFromMessage(quoted, messageType);

    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }

    const type = await FileType.fromBuffer(buffer);
    const safeName = filename ||
      path.join(tempDir, Crypto.randomBytes(8).toString('hex'));

    const trueFileName = attachExtension
      ? `${safeName}.${type?.ext || 'bin'}`
      : safeName;

    await fs.promises.writeFile(trueFileName, buffer);

    return trueFileName;
  };

  conn.downloadMediaMessage = async message => {
    const mime = (message.msg || message).mimetype || '';
    const messageType = message.mtype
      ? message.mtype.replace(/Message/gi, '')
      : mime.split('/')[0];

    const stream = await downloadContentFromMessage(message, messageType);

    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }

    return buffer;
  };

  conn.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const buffer = Buffer.from(response.data);
    const mime = response.headers['content-type'] || 'application/octet-stream';

    if (mime.includes('gif')) {
      return conn.sendMessage(jid, {
        video: buffer,
        caption,
        gifPlayback: true,
        ...options
      }, { quoted });
    }

    if (mime === 'application/pdf') {
      return conn.sendMessage(jid, {
        document: buffer,
        mimetype: mime,
        caption,
        ...options
      }, { quoted });
    }

    if (mime.startsWith('image/')) {
      return conn.sendMessage(jid, {
        image: buffer,
        caption,
        ...options
      }, { quoted });
    }

    if (mime.startsWith('video/')) {
      return conn.sendMessage(jid, {
        video: buffer,
        caption,
        mimetype: mime,
        ...options
      }, { quoted });
    }

    if (mime.startsWith('audio/')) {
      return conn.sendMessage(jid, {
        audio: buffer,
        mimetype: mime,
        ...options
      }, { quoted });
    }

    return conn.sendMessage(jid, {
      document: buffer,
      mimetype: mime,
      fileName: 'file',
      caption,
      ...options
    }, { quoted });
  };

  conn.cMod = (jid, copy, text = '', sender = conn.user.id, options = {}) => {
    const mtype = Object.keys(copy.message)[0];
    const isEphemeral = mtype === 'ephemeralMessage';

    const msg = isEphemeral
      ? copy.message.ephemeralMessage.message
      : copy.message;

    const contentType = Object.keys(msg)[0];
    const content = msg[contentType];

    if (typeof content === 'string') {
      msg[contentType] = text || content;
    } else if (content.caption) {
      content.caption = text || content.caption;
    } else if (content.text) {
      content.text = text || content.text;
    }

    if (typeof content !== 'string') {
      msg[contentType] = { ...content, ...options };
    }

    if (copy.key.participant) {
      copy.key.participant = sender || copy.key.participant;
    }

    copy.key.remoteJid = jid;
    copy.key.fromMe = sender === conn.user.id;

    return proto.WebMessageInfo.fromObject(copy);
  };

  conn.getFile = async (input, save = false) => {
    let res;
    let data;

    if (Buffer.isBuffer(input)) {
      data = input;
    } else if (
      typeof input === 'string' &&
      /^data:.*?\/.*?;base64,/i.test(input)
    ) {
      data = Buffer.from(input.split(',')[1], 'base64');
    } else if (
      typeof input === 'string' &&
      /^https?:\/\//i.test(input)
    ) {
      res = await axios.get(input, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024
      });

      data = Buffer.from(res.data);
    } else if (typeof input === 'string' && fs.existsSync(input)) {
      data = fs.readFileSync(input);
    } else if (typeof input === 'string') {
      data = Buffer.from(input);
    } else {
      data = Buffer.alloc(0);
    }

    const type = await FileType.fromBuffer(data) || {
      mime: 'application/octet-stream',
      ext: 'bin'
    };

    const filename = path.join(
      tempDir,
      `${Date.now()}-${Crypto.randomBytes(5).toString('hex')}.${type.ext || 'bin'}`
    );

    if (save) {
      await fs.promises.writeFile(filename, data);
    }

    return {
      res,
      filename,
      size: data.length,
      ...type,
      data
    };
  };

  conn.sendFile = async (jid, input, fileName, quoted = null, options = {}) => {
    const file = await conn.getFile(input, true);

    const messageType = options.asDocument ? 'document' :
      file.mime.startsWith('image/') ? 'image' :
      file.mime.startsWith('video/') ? 'video' :
      file.mime.startsWith('audio/') ? 'audio' : 'document';

    const payload = {
      [messageType]: file.data,
      mimetype: file.mime,
      fileName: fileName || `file.${file.ext}`,
      ...options
    };

    delete payload.asDocument;
    delete payload.asSticker;

    try {
      return await conn.sendMessage(jid, payload, {
        quoted: quoted || undefined
      });
    } finally {
      await fs.promises.unlink(file.filename).catch(() => {});
    }
  };

  conn.parseMention = async text => {
    return [...text.matchAll(/@([0-9]{5,16}|0)/g)]
      .map(v => v[1] + '@s.whatsapp.net');
  };

  conn.sendMedia = async (
    jid,
    input,
    fileName = '',
    caption = '',
    quoted = null,
    options = {}
  ) => {
    const file = await conn.getFile(input, true);

    const messageType = options.asDocument ? 'document' :
      file.mime.startsWith('image/') ? 'image' :
      file.mime.startsWith('video/') ? 'video' :
      file.mime.startsWith('audio/') ? 'audio' : 'document';

    const payload = {
      [messageType]: file.data,
      caption,
      mimetype: file.mime,
      fileName: fileName || `file.${file.ext}`,
      ...options
    };

    delete payload.asDocument;
    delete payload.asSticker;

    try {
      return await conn.sendMessage(jid, payload, {
        quoted: quoted || undefined
      });
    } finally {
      await fs.promises.unlink(file.filename).catch(() => {});
    }
  };

  const makeStickerBuffer = async (input, options = {}) => {
    const { Sticker, StickerTypes } = require('wa-sticker-formatter');

    const sticker = new Sticker(input, {
      pack: options.packname || config.BOT_NAME || 'JAVIEL MD',
      author: options.author || config.OWNER_NAME || 'JAVIEL MD',
      type: StickerTypes.FULL,
      categories: options.categories || [],
      quality: 80
    });

    return sticker.toBuffer();
  };

  conn.sendVideoAsSticker = async (jid, input, options = {}) => {
    const { videoToWebp } = require('./lib/video-utils');

    const source = Buffer.isBuffer(input)
      ? input
      : fs.readFileSync(input);

    const webp = await videoToWebp(source);
    const stickerBuffer = await makeStickerBuffer(webp, options);

    return conn.sendMessage(jid, {
      sticker: stickerBuffer
    }, {
      quoted: options.quoted || undefined
    });
  };

  conn.sendImageAsSticker = async (jid, input, options = {}) => {
    const source = Buffer.isBuffer(input)
      ? input
      : typeof input === 'string' && /^https?:\/\//i.test(input)
        ? Buffer.from(await getBuffer(input))
        : typeof input === 'string' && fs.existsSync(input)
          ? fs.readFileSync(input)
          : Buffer.from(input);

    const stickerBuffer = await makeStickerBuffer(source, options);

    return conn.sendMessage(jid, {
      sticker: stickerBuffer
    }, {
      quoted: options.quoted || undefined
    });
  };

  conn.sendTextWithMentions = async (
    jid,
    text,
    quoted,
    options = {}
  ) => {
    return conn.sendMessage(jid, {
      text,
      contextInfo: {
        mentionedJid: [...text.matchAll(/@(\d{5,16})/g)]
          .map(v => v[1] + '@s.whatsapp.net')
      },
      ...options
    }, { quoted });
  };

  conn.sendImage = async (
    jid,
    input,
    caption = '',
    quoted = '',
    options = {}
  ) => {
    const buffer = Buffer.isBuffer(input)
      ? input
      : /^data:.*?\/.*?;base64,/i.test(input)
        ? Buffer.from(input.split(',')[1], 'base64')
        : /^https?:\/\//.test(input)
          ? Buffer.from(await getBuffer(input))
          : fs.existsSync(input)
            ? fs.readFileSync(input)
            : Buffer.alloc(0);

    return conn.sendMessage(jid, {
      image: buffer,
      caption,
      ...options
    }, { quoted });
  };

  conn.sendText = (jid, text, quoted = '', options = {}) => {
    return conn.sendMessage(jid, {
      text,
      ...options
    }, { quoted });
  };

  conn.sendButtonText = (
    jid,
    buttons = [],
    text,
    footer,
    quoted = '',
    options = {}
  ) => {
    return conn.sendMessage(jid, {
      text,
      footer,
      buttons,
      headerType: 2,
      ...options
    }, { quoted });
  };

  conn.send5ButImg = async (
    jid,
    text = '',
    footer = '',
    img,
    but = [],
    thumb,
    options = {}
  ) => {
    const message = await prepareWAMessageMedia({
      image: img,
      jpegThumbnail: thumb
    }, {
      upload: conn.waUploadToServer
    });

    const template = await generateWAMessageFromContent(
      jid,
      proto.Message.fromObject({
        templateMessage: {
          hydratedTemplate: {
            imageMessage: message.imageMessage,
            hydratedContentText: text,
            hydratedFooterText: footer,
            hydratedButtons: but
          }
        }
      }),
      options
    );

    await conn.relayMessage(jid, template.message, {
      messageId: template.key.id
    });
  };
    //================ OWNER REACTION ==============
  if (
    ownerNumber.includes(senderNumber) &&
    !isReact &&
    config.OWNER_REACT === 'true'
  ) {
    m.react('🩷').catch(err =>
      console.error('[REACTION]', err.message)
    );
  }

  //================ AUTO REACTION ==============
  if (!isReact && senderNumber !== botNumber) {
    if (config.AUTO_REACT === 'true') {
      const reactions = [
        '😊', '👍', '😂', '💯', '🔥',
        '🙏', '🎉', '👏', '😎', '🤖',
        '❤️', '🥰', '😍', '🤣', '🌹',
        '💖', '✨', '🐼', '🌸', '💪'
      ];

      const randomReaction =
        reactions[Math.floor(Math.random() * reactions.length)];

      m.react(randomReaction).catch(err =>
        console.error('[AUTO REACT]', err.message)
      );
    }
  }

  //================ CUSTOM REACTION ==============
  if (!isReact && senderNumber !== botNumber) {
    if (config.CUSTOM_REACT === 'true') {
      const reactions = (
        config.CUSTOM_REACT_EMOJIS || '🥲,😂,👍🏻,🙂,😔'
      ).split(',').map(item => item.trim()).filter(Boolean);

      if (reactions.length) {
        const randomReaction =
          reactions[Math.floor(Math.random() * reactions.length)];

        m.react(randomReaction).catch(err =>
          console.error('[CUSTOM REACT]', err.message)
        );
      }
    }
  }

  if (!isReact && senderNumber === botNumber) {
    if (config.CUSTOM_REACT === 'true') {
      const reactions = (
        config.CUSTOM_REACT_EMOJIS || '🥲,😂,👍🏻,🙂,😔'
      ).split(',').map(item => item.trim()).filter(Boolean);

      if (reactions.length) {
        const randomReaction =
          reactions[Math.floor(Math.random() * reactions.length)];

        m.react(randomReaction).catch(err =>
          console.error('[CUSTOM REACT]', err.message)
        );
      }
    }
  }

  //================ WORK MODE ==============
  if (!isOwner && config.MODE === 'private') return;
  if (!isOwner && isGroup && config.MODE === 'inbox') return;
  if (!isOwner && !isGroup && config.MODE === 'groups') return;

  //================ COMMAND HANDLER ==============
  const events = require('./command');

  const cmdName = isCmd
    ? body.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase()
    : '';

  const context = {
    from,
    l,
    quoted,
    body,
    isCmd,
    command,
    args,
    q,
    isGroup,
    sender,
    senderNumber,
    botNumber2,
    botNumber,
    pushname,
    isMe,
    isOwner,
    groupMetadata,
    groupName,
    participants,
    groupAdmins,
    isBotAdmins,
    isAdmins,
    reply
  };

  if (isCmd) {
    const cmd = events.commands.find(item =>
      item.pattern === cmdName
    ) || events.commands.find(item =>
      item.alias && item.alias.includes(cmdName)
    );

    if (cmd) {
      if (cmd.react) {
        await conn.sendMessage(from, {
          react: {
            text: cmd.react,
            key: mek.key
          }
        }).catch(() => {});
      }

      try {
        await Promise.resolve(
          cmd.function(conn, mek, m, context)
        );
      } catch (error) {
        console.error('[COMMAND ERROR]', cmdName, error);
      }
    }
  }

  //================ EVENT HANDLER ==============
  for (const eventCommand of events.commands) {
    try {
      if (body && eventCommand.on === 'body') {
        await Promise.resolve(
          eventCommand.function(conn, mek, m, context)
        );
      } else if (body && eventCommand.on === 'text') {
        await Promise.resolve(
          eventCommand.function(conn, mek, m, context)
        );
      } else if (
        (eventCommand.on === 'image' ||
          eventCommand.on === 'photo') &&
        type === 'imageMessage'
      ) {
        await Promise.resolve(
          eventCommand.function(conn, mek, m, context)
        );
      } else if (
        eventCommand.on === 'sticker' &&
        type === 'stickerMessage'
      ) {
        await Promise.resolve(
          eventCommand.function(conn, mek, m, context)
        );
      }
    } catch (eventError) {
      console.error(
        '[EVENT COMMAND ERROR]',
        eventCommand.pattern || eventCommand.on,
        eventError
      );
    }
  }
}

// Close the message handler and WhatsApp connection function.

  } // End event handler loop
} // End handleIncomingMessage
} // End connectToWA

setTimeout(() => {
  connectToWA().catch(err => {
    console.error('JAVIEL startup failed:', err.message);
    process.exitCode = 1;
  });
}, 1500);
