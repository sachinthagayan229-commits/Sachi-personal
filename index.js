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

// ---------- settings ----------
const SETTINGS_FILE = './settings.json';
let settings = { antidelete: true, antiedit: true, autoViewOnce: true };
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch {}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

// ---------- message store ----------
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

// Send any message content (text or media) to jid. Returns false if unsupported.
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

// ---------- YouTube helpers ----------
function getVideoId(url) {
  const m = String(url).match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Download audio/video as Buffer.
// 1) btch-downloader (third-party API, works from GitHub servers)
// 2) ytdl-core fallback (often blocked on GitHub servers)
async function getYtMedia(video, isSong) {
  try {
    const b = require('btch-downloader');
    const r = isSong ? await b.ytmp3(video.url) : await b.ytmp4(video.url);
    const link =
      r?.mp3 || r?.mp4 || r?.url || r?.download || r?.result?.mp3 || r?.result?.mp4 || r?.result?.download || r?.result?.url;
    if (link) {
      const res = await fetch(link);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      console.log('btch download http', res.status);
    } else {
      console.log('btch gave no link:', JSON.stringify(r).slice(0, 200));
    }
  } catch (e) {
    console.log('btch yt failed:', e.message);
  }
  return streamToBuffer(ytdl(video.url, { quality: isSong ? '140' : '18' }));
}

// ---------- menu ----------
function menuText() {
  const p = config.prefix;
  const up = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60), s = up % 60;
  return `╭━━━━〔 *${config.botName.toUpperCase()}* 〕━━━━╮
┃ 👤 *Owner*  : ${config.owner}
┃ 🔹 *Prefix* : ${p}
┃ ⏱️ *Uptime* : ${h}h ${m}m ${s}s
╰━━━━━━━━━━━━━━━━━━━━╯

╭─「 ⚙️ *MAIN* 」
│ ◦ ${p}menu
│ ◦ ${p}alive
│ ◦ ${p}ping
│ ◦ ${p}update
╰───────────────

╭─「 📥 *DOWNLOAD* 」
│ ◦ ${p}song <name / link>
│ ◦ ${p}yt <name / link>
│ ◦ ${p}fb <link>
╰───────────────

╭─「 👑 *OWNER TOOLS* 」
│ ◦ ${p}vv  _(reply view-once)_
│ ◦ ${p}sv  _(reply status)_
│ ◦ ${p}send  _(reply media)_
│ ◦ ${p}antidelete on/off
│ ◦ ${p}antiedit on/off
╰───────────────

╭─「 🛡️ *STATUS* 」
│ ◦ AntiDelete : ${settings.antidelete ? '✅ ON' : '❌ OFF'}
│ ◦ AntiEdit   : ${settings.antiedit ? '✅ ON' : '❌ OFF'}
╰───────────────

_© ${config.owner}_`;
}

// ---------- SESSION_ID ----------
// Supports: base64 | gzip-base64 | PREFIX~xxx | Mega ID (xxx#yyy)
async function loadSessionFromEnv() {
  const id = process.env.SESSION_ID;
  // Skip when QR login or pair number is used
  if (!id || process.env.QR_LOGIN === 'true' || (process.env.PAIR_NUMBER || '').trim()) return;
  try {
    let raw = id.trim().replace(/^[A-Za-z0-9_-]{2,30}[~=]/, '');
    let text;

    if (raw.includes('#')) {
      console.log('Downloading session from Mega...');
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

    // Keep cached session if it is the same account (it has newer keys)
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync('./session/creds.json', 'utf8')); } catch {}
    const same = cached?.me?.id && incoming?.me?.id && num(cached.me.id) === num(incoming.me.id);
    if (same) {
      console.log('Using session from cache');
      return;
    }

    fs.rmSync('./session', { recursive: true, force: true });
    fs.mkdirSync('./session', { recursive: true });
    fs.writeFileSync('./session/creds.json', text);
    console.log('SESSION_ID loaded (' + (incoming?.me?.id ? num(incoming.me.id) : 'unknown') + ')');
  } catch (e) {
    console.log('SESSION_ID invalid or failed to load:', e.message);
  }
}

// ---------- Pairing code (custom: SACHAK12) -> logs + ntfy ----------
async function sendPairingCode(sock, pairNumber) {
  try {
    const custom = (process.env.PAIR_CODE || 'SACHAK12').toUpperCase();
    const code = await sock.requestPairingCode(pairNumber, custom);
    console.log('\n==============================');
    console.log('PAIRING CODE : ' + code);
    console.log('==============================\n');

    if (process.env.NTFY_TOPIC) {
      fetch('https://ntfy.sh/' + process.env.NTFY_TOPIC, {
        method: 'POST',
        body: code,
        headers: { Title: 'WhatsApp Pairing Code', Priority: 'urgent' },
      }).catch(() => {});
    }
  } catch (e) {
    console.log('Pairing code error:', e.message);
  }
}

// ---------- QR printed with plain block characters (works in GitHub logs) ----------
// Filled block = light module, empty = dark module (made for GitHub DARK theme)
function printQr(qr) {
  try {
    const QRCode = require('qrcode');
    const modules = QRCode.create(qr, { errorCorrectionLevel: 'L' }).modules;
    const size = modules.size;
    const margin = 2;
    const total = size + margin * 2;
    const isDark = (x, y) =>
      x >= margin && y >= margin && x < size + margin && y < size + margin && !!modules.get(x - margin, y - margin);

    const lines = [];
    for (let y = 0; y < total; y += 2) {
      let line = '';
      for (let x = 0; x < total; x++) {
        const top = !isDark(x, y);
        const bottom = y + 1 < total ? !isDark(x, y + 1) : true;
        if (top && bottom) line += '\u2588';
        else if (top) line += '\u2580';
        else if (bottom) line += '\u2584';
        else line += ' ';
      }
      lines.push(line);
    }
    console.log('\n' + lines.join('\n') + '\n');
  } catch (e) {
    console.log('qrcode package missing, using fallback:', e.message);
    qrcode.generate(qr, { small: true });
  }
}

// ---------- bot ----------
async function start() {
  await loadSessionFromEnv();
  const { state, saveCreds } = await useMultiFileAuthState('session');
  const { version } = await fetchLatestBaileysVersion();
  const pairNumber = (process.env.PAIR_NUMBER || '').replace(/\D/g, '');
  let pairRequested = false;

  if (process.env.GITHUB_ACTIONS && !state.creds.me && !pairNumber && process.env.QR_LOGIN !== 'true') {
    console.log('No session found! Set the SESSION_ID secret, or give pair_number / tick use_qr when running the workflow.');
    process.exit(1);
  }
  console.log('Connecting...', state.creds.me ? '(session: ' + num(state.creds.me.id) + ')' : '(new login)');

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || 'warn' }),
    browser: [config.botName, 'Chrome', '1.0.0'],
    defaultQueryTimeoutMs: undefined,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async (key) => store.get(key.id)?.message || undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    // Pairing code mode (only when a pair number is given)
    if (qr && pairNumber && !sock.authState.creds.registered && !pairRequested) {
      pairRequested = true;
      sendPairingCode(sock, pairNumber);
    }
    // QR mode: print the QR in the logs
    if (qr && !pairNumber) {
      console.log('\n===== NEW QR (scan within 20 seconds) =====');
      printQr(qr);
    }
    if (connection === 'open') {
      console.log(`${config.botName} connected`);
      sock.sendMessage(ownerJid, { text: `*${config.botName}* online! ✅\nSend ${config.prefix}menu to see commands` }).catch(() => {});
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed. code =', code, '|', lastDisconnect?.error?.message || '');
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged o
