const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { exec } = require('child_process');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const config = require('./config');

const ownerJid = config.ownerNumber + '@s.whatsapp.net';
const startTime = Date.now();

// ---------- settings (antidelete / antiedit on-off) ----------
const SETTINGS_FILE = './settings.json';
let settings = { antidelete: true, antiedit: true, autoViewOnce: true };
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch {}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

// ---------- message store (for antidelete / antiedit) ----------
const store = new Map();
const STORE_LIMIT = 1500;
function keep(msg) {
  if (!msg.key?.id) return;
  store.set(msg.key.id, msg);
  if (store.size > STORE_LIMIT) store.delete(store.keys().next().value);
}

// ---------- helpers ----------
function unwrap(m) {
  if (!m) return m;
  if (m.ephemeralMessage) return unwrap(m.ephemeralMessage.message);
  if (m.viewOnceMessage) return unwrap(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2) return unwrap(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension) return unwrap(m.viewOnceMessageV2Extension.message);
  if (m.documentWithCaptionMessage) return unwrap(m.documentWithCaptionMessage.message);
  if (m.editedMessage) return unwrap(m.editedMessage.message);
  return m;
}

function isViewOnce(m) {
  if (!m) return false;
  if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) return true;
  const inner = unwrap(m);
  return !!(inner?.imageMessage?.viewOnce || inner?.videoMessage?.viewOnce || inner?.audioMessage?.viewOnce);
}

function getText(m) {
  m = unwrap(m);
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

function getContext(m) {
  m = unwrap(m);
  if (!m) return null;
  const type = Object.keys(m)[0];
  return m[type]?.contextInfo || null;
}

const num = (jid = '') => jid.split('@')[0].split(':')[0];

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

async function downloadMedia(node, kind) {
  const stream = await downloadContentFromMessage(node, kind);
  return streamToBuffer(stream);
}

const KIND = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
  documentMessage: 'document',
};

// Any message content -> send to jid (text or media). Returns false if unsupported.
async function sendContent(sock, jid, content, caption = '') {
  content = unwrap(content);
  if (!content) return false;
  const type = Object.keys(content)[0];

  if (type === 'conversation' || type === 'extendedTextMessage') {
    await sock.sendMessage(jid, { text: (caption ? caption + '\n\n' : '') + getText(content) });
    return true;
  }
  const kind = KIND[type];
  if (!kind) return false;

  const node = content[type];
  const buf = await downloadMedia(node, kind);
  const cap = [caption, node.caption].filter(Boolean).join('\n\n');
  let payload;
  if (kind === 'image') payload = { image: buf, caption: cap };
  else if (kind === 'video') payload = { video: buf, caption: cap };
  else if (kind === 'audio') payload = { audio: buf, mimetype: 'audio/mp4', ptt: !!node.ptt };
  else if (kind === 'sticker') payload = { sticker: buf };
  else payload = { document: buf, mimetype: node.mimetype, fileName: node.fileName || 'file' };

  await sock.sendMessage(jid, payload);
  if (cap && (kind === 'audio' || kind === 'sticker' || kind === 'document')) {
    await sock.sendMessage(jid, { text: cap });
  }
  return true;
}

// ---------- menu ----------
function menuText() {
  const p = config.prefix;
  const up = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60), s = up % 60;
  return `╭━━━━━━━━━━━━━━━━━━━━╮
┃  🤖 *${config.botName.toUpperCase()}*
╰━━━━━━━━━━━━━━━━━━━━╯

👑 *Owner* : ${config.owner}
⚡ *Prefix* : ${p}
⏱️ *Uptime* : ${h}h ${m}m ${s}s

╭─❖ 🧭 *MAIN* ❖─
│ ✦ ${p}menu
│ ✦ ${p}alive
│ ✦ ${p}ping
│ ✦ ${p}update
╰──────────────

╭─❖ 📥 *DOWNLOAD* ❖─
│ ✦ ${p}song <name / link>
│ ✦ ${p}yt <name / link>
│ ✦ ${p}fb <link>
╰──────────────

╭─❖ 🕵️ *OWNER TOOLS* ❖─
│ ✦ ${p}vv  _(reply view-once)_
│ ✦ ${p}sv  _(reply status)_
│ ✦ ${p}send  _(reply media)_
│ ✦ ${p}antidelete on/off
│ ✦ ${p}antiedit on/off
╰──────────────

🛡️ AntiDelete : ${settings.antidelete ? '✅ ON' : '❌ OFF'}
✏️ AntiEdit   : ${settings.antiedit ? '✅ ON' : '❌ OFF'}

_© ${config.owner}_`;
}

// ---------- SESSION_ID (pair site එකෙන් ගත්ත session) ----------
// Support: base64 | gzip-base64 | PREFIX~xxx | Mega ID (xxx#yyy)
async function loadSessionFromEnv() {
  const id = process.env.SESSION_ID;
  if (!id || process.env.QR_LOGIN === 'true') return; // QR login නම් SESSION_ID පාවිච්චි කරන්නේ නෑ
  try {
    let raw = id.trim().replace(/^[A-Za-z0-9_-]{2,30}[~=]/, ''); // prefix අයින් කරනවා
    let text;

    if (raw.includes('#')) {
      console.log('📥 Mega එකෙන් session download කරනවා...');
      const { File } = require('megajs');
      const buf = await File.fromURL('https://mega.nz/file/' + raw).downloadBuffer();
      text = buf.toString('utf8');
    } else {
      let buf = Buffer.from(raw, 'base64');
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = require('zlib').gunzipSync(buf);
      text = buf.toString('utf8');
    }

    let incoming;
    try {
      incoming = JSON.parse(text);
    } catch {
      incoming = JSON.parse(Buffer.from(text.trim(), 'base64').toString('utf8'));
      text = JSON.stringify(incoming);
    }

    // cache එකේ ඒ ගිණුමේම session එකක් තියෙනවා නම් (අලුත් keys තියෙන නිසා) ඒක තියාගන්නවා
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync('./session/creds.json', 'utf8')); } catch {}
    const same = cached?.me?.id && incoming?.me?.id && num(cached.me.id) === num(incoming.me.id);
    if (same) {
      console.log('♻️ Cache එකේ session එක පාවිච්චි කරනවා');
      return;
    }

    fs.rmSync('./session', { recursive: true, force: true });
    fs.mkdirSync('./session', { recursive: true });
    fs.writeFileSync('./session/creds.json', text);
    console.log('✅ SESSION_ID load උනා (' + (incoming?.me?.id ? num(incoming.me.id) : 'unknown') + ')');
  } catch (e) {
    console.log('❌ SESSION_ID වැරදියි / load කරන්න බැරි වුණා:', e.message);
  }
}

// ---------- bot ----------
async function start() {
  await loadSessionFromEnv();
  const { state, saveCreds } = await useMultiFileAuthState('session');
  const { version } = await fetchLatestBaileysVersion();
  const pairNumber = (process.env.PAIR_NUMBER || '').replace(/\D/g, '');

  // GitHub Actions වල session නැත්නම් පැහැදිලිව error එකක් දෙනවා
  if (process.env.GITHUB_ACTIONS && !state.creds.me && !pairNumber && process.env.QR_LOGIN !== 'true') {
    console.log('❌ Session එකක් නෑ! SESSION_ID secret එක හරියට දාන්න, නැත්නම් Run workflow එකේ pair_number දෙන්න / use_qr ටික් කරන්න.');
    process.exit(1);
  }
  console.log('⏳ Connecting...', state.creds.me ? '(session: ' + num(state.creds.me.id) + ')' : '(new login)');

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || 'warn' }),
    browser: [config.botName, 'Chrome', '1.0.0'],
    defaultQueryTimeoutMs: undefined, // init query "Timed Out" errors අඩු කරන්න
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => store.get(key.id)?.message || undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  // පළවෙනි වතාවට: QR වෙනුවට Pairing Code එකක් logs වල print වෙනවා
  if (!sock.authState.creds.registered && pairNumber) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairNumber);
        console.log('\n==============================');
        console.log('🔑 PAIRING CODE : ' + code);
        console.log('==============================\n');
      } catch (e) {
        console.log('Pairing code error:', e.message);
      }
    }, 4000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !pairNumber) {
      console.log('\n📲 මේ QR එක වෙන device එකකින් WhatsApp > Linked Devices > Link a device වලින් scan කරන්න (තත්පර 20කට සැරයක් අලුත් වෙනවා):\n');
      qrcode.generate(qr, { small: false });
    }
    if (connection === 'open') {
      console.log(`✅ ${config.botName} connected`);
      sock.sendMessage(ownerJid, { text: `✅ *${config.botName}* online!\nMenu එක බලන්න ${config.prefix}menu` }).catch(() => {});
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('❗ Connection closed. code =', code, '|', lastDisconnect?.error?.message || '');
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out. "session" folder එක delete කරලා ආයෙ run කරන්න.');
      } else {
        console.log('Reconnecting...');
        setTimeout(start, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        console.log('📩', type, '| fromMe:', !!msg.key.fromMe, '|', msg.message ? Object.keys(msg.message)[0] : 'NO CONTENT (decrypt fail?) stub=' + (msg.messageStubType || '-'));
        if (!msg.message) continue;
        const proto = msg.message.protocolMessage;

        // ----- AntiDelete / AntiEdit -----
        if (proto) {
          // 0 = REVOKE (delete), 14 = MESSAGE_EDIT
          if (proto.type === 0 && settings.antidelete) {
            const orig = store.get(proto.key?.id);
            if (orig && !orig.key.fromMe) {
              const who = orig.key.participant || orig.key.remoteJid;
              const note =
                `🛡️ *ANTI DELETE*\n👤 From: @${num(who)}\n💬 Chat: ${orig.key.remoteJid.endsWith('@g.us') ? 'Group' : 'Inbox'}`;
              const ok = await sendContent(sock, ownerJid, orig.message, note).catch(() => false);
              if (!ok) await sock.sendMessage(ownerJid, { text: note + '\n\n_(content save කරගන්න බැරි වුණා)_', mentions: [who] });
            }
          }
          if (proto.type === 14 && settings.antiedit) {
            const orig = store.get(proto.key?.id);
            const newText = getText(proto.editedMessage);
            if (orig && !orig.key.fromMe) {
              const who = orig.key.participant || orig.key.remoteJid;
              await sock.sendMessage(ownerJid, {
                text: `✏️ *ANTI EDIT*\n👤 From: @${num(who)}\n\n❌ *Old:* ${getText(orig.message) || '_(media)_'}\n✅ *New:* ${newText}`,
                mentions: [who],
              });
              // update stored copy
              orig.message = proto.editedMessage || orig.message;
            }
          }
          continue;
        }

        keep(msg);
        if (msg.key.remoteJid === 'status@broadcast') continue;

        // ----- Auto View-Once -> owner inbox -----
        if (settings.autoViewOnce && !msg.key.fromMe && isViewOnce(msg.message)) {
          const who = msg.key.participant || msg.key.remoteJid;
          await sendContent(sock, ownerJid, msg.message, `👁️ *VIEW ONCE SAVED*\n👤 From: @${num(who)}`).catch(() => {});
        }

        // ----- Commands -----
        const body = getText(msg.message).trim();
        if (!body.startsWith(config.prefix)) continue;
        await handleCommand(sock, msg, body);
      } catch (e) {
        console.error('msg error:', e.message);
      }
    }
  });
}

async function handleCommand(sock, msg, body) {
  const from = msg.key.remoteJid;
  const sender = msg.key.participant || from;
  const isOwner = msg.key.fromMe || num(sender) === config.ownerNumber;
  const [cmd, ...args] = body.slice(config.prefix.length).trim().split(/\s+/);
  const command = cmd.toLowerCase();
  const text = args.join(' ');
  const reply = (t) => sock.sendMessage(from, { text: t }, { quoted: msg });
  const ownerOnly = () => (isOwner ? false : (reply('🚫 මේක Owner ට විතරයි.'), true));
  const quoted = getContext(msg.message)?.quotedMessage;

  console.log('⚙️ command:', command);

  switch (command) {
    case 'menu':
    case 'help':
      return sock.sendMessage(from, { text: menuText() }, { quoted: msg });

    case 'alive':
      return reply(`✅ *${config.botName}* alive!\n👑 Owner: ${config.owner}\n⚡ Prefix: ${config.prefix}`);

    case 'ping': {
      const t = Date.now();
      await reply('🏓 Pinging...');
      return reply(`🏓 Pong! *${Date.now() - t} ms*`);
    }

    case 'update': {
      if (ownerOnly()) return;
      await reply('🔄 Update කරනවා...');
      return exec('git pull', async (err, out) => {
        if (err) return reply('❌ Update fail: ' + err.message);
        await reply('✅ ' + out.trim() + '\n♻️ Restart වෙනවා...');
        setTimeout(() => process.exit(0), 1500); // pm2 / hosting platform එක auto restart කරයි
      });
    }

    case 'song':
    case 'yt': {
      if (!text) return reply(`උදා: ${config.prefix}${command} shape of you`);
      const isSong = command === 'song';
      await reply('🔎 Searching...');
      let video;
      if (ytdl.validateURL(text)) {
        const info = await ytdl.getBasicInfo(text);
        video = { url: text, title: info.videoDetails.title, seconds: +info.videoDetails.lengthSeconds, thumbnail: info.videoDetails.thumbnails.pop()?.url };
      } else {
        video = (await yts(text)).videos[0];
      }
      if (!video) return reply('❌ Result නෑ.');
      if (video.seconds > 1200) return reply('❌ විනාඩි 20 ට වඩා දිග වීඩියෝ බෑ.');

      await sock.sendMessage(from, {
        image: { url: video.thumbnail },
        caption: `🎵 *${video.title}*\n⏱️ ${video.timestamp || video.seconds + 's'}\n\n⏬ Downloading...`,
      }, { quoted: msg });

      const buf = await streamToBuffer(ytdl(video.url, { quality: isSong ? '140' : '18' }));
      if (isSong) {
        return sock.sendMessage(from, { audio: buf, mimetype: 'audio/mp4', fileName: video.title + '.m4a' }, { quoted: msg });
      }
      return sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: video.title }, { quoted: msg });
    }

    case 'fb': {
      if (!text) return reply(`උදා: ${config.prefix}fb https://facebook.com/...`);
      await reply('⏬ Downloading...');
      const { fbdown } = require('btch-downloader');
      const r = await fbdown(text);
      const link = r?.HD || r?.Normal_video;
      if (!link) return reply('❌ Video එක ගන්න බැරි වුණා.');
      return sock.sendMessage(from, { video: { url: link }, caption: '✅ Facebook Video' }, { quoted: msg });
    }

    // reply to a view-once -> owner inbox
    case 'vv': {
      if (ownerOnly()) return;
      if (!quoted) return reply('View once message එකකට reply කරන්න.');
      const ok = await sendContent(sock, ownerJid, quoted, '👁️ *VIEW ONCE (.vv)*').catch(() => false);
      return reply(ok ? '✅ Owner inbox එකට යැව්වා.' : '❌ Save කරගන්න බැරි වුණා.');
    }

    // reply to a status -> owner inbox
    case 'sv': {
      if (ownerOnly()) return;
      if (!quoted) return reply('Status එකකට reply කරන්න.');
      const ok = await sendContent(sock, ownerJid, quoted, '💾 *STATUS SAVED*').catch(() => false);
      return reply(ok ? '✅ Status එක Owner inbox එකට යැව්වා.' : '❌ Save කරගන්න බැරි වුණා.');
    }

    // reply to media/text -> resend in this chat
    case 'send': {
      if (ownerOnly()) return;
      if (!quoted) return reply('Message / media එකකට reply කරන්න.');
      const ok = await sendContent(sock, from, quoted).catch(() => false);
      return ok ? null : reply('❌ යවන්න බැරි වුණා.');
    }

    case 'antidelete':
    case 'antiedit': {
      if (ownerOnly()) return;
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return reply(`උදා: ${config.prefix}${command} on`);
      settings[command] = v === 'on';
      saveSettings();
      return reply(`✅ ${command} → *${v.toUpperCase()}*`);
    }
  }
}

start();
