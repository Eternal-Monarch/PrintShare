'use strict';
/**
 * PrintShare - self-hosted PDF print sharing server.
 * - Listens ONLY on 127.0.0.1 (your own laptop). Cloudflare Tunnel is the only way in from the internet.
 * - Admin dashboard + admin API are reachable ONLY from this laptop (never through the tunnel).
 * - PDFs are stored in ./uploads under random names. Nothing is sent to any cloud service.
 */
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { PDFDocument } = require('pdf-lib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---------------------------------------------------------------- settings
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 100;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
const DOCS_FILE = path.join(DATA_DIR, 'documents.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TUNNEL_LOG = path.join(DATA_DIR, 'tunnel.log');
const RANGES_FILE = path.join(DATA_DIR, 'blocked-ranges.txt');
const PDFJS_DIR = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build');
const ID_RE = /^[A-Za-z0-9_-]{24}$/;

for (const d of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- storage helpers
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const docPath = id => path.join(UPLOAD_DIR, id + '.pdf');
const newId = () => crypto.randomBytes(18).toString('base64url'); // 24 chars, 144 bits

let config = readJson(CONFIG_FILE, {});
if (!config.secret) { config.secret = crypto.randomBytes(32).toString('hex'); writeJson(CONFIG_FILE, config); }
const saveConfig = () => writeJson(CONFIG_FILE, config);

let docs = readJson(DOCS_FILE, []).filter(d => d && ID_RE.test(d.id) && fs.existsSync(docPath(d.id)));
const saveDocs = () => writeJson(DOCS_FILE, docs);
const getDoc = id => (ID_RE.test(id || '') ? docs.find(d => d.id === id) : undefined);
const publicView = d => ({ id: d.id, name: d.name, size: d.size, pages: d.pages, createdAt: d.createdAt, protected: !!d.pw, strict: !!d.strict, locked: !!d.lock, lockedAt: d.lock ? d.lock.at : null, lockIp: d.lock ? d.lock.ip : null });

// ---------------------------------------------------------------- crypto helpers
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(pw, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function unlockToken(doc, exp) {
  const mac = crypto.createHmac('sha256', config.secret).update(`${doc.id}.${exp}.${doc.pw.hash.slice(0, 16)}`).digest('base64url');
  return `${exp}.${mac}`;
}
function hasUnlocked(req, doc) {
  if (!doc.pw) return true;
  const tok = parseCookies(req)['ps_' + doc.id];
  if (!tok) return false;
  const [exp] = tok.split('.');
  if (!(Number(exp) > Date.now())) return false;
  const good = Buffer.from(unlockToken(doc, exp));
  const got = Buffer.from(tok);
  return good.length === got.length && crypto.timingSafeEqual(good, got);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
const isSecure = req => req.headers['x-forwarded-proto'] === 'https' || /https/.test(req.headers['cf-visitor'] || '');


// ---------------------------------------------------------------- strict access (one device + no VPN/proxy)
const clientIp = req => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
function ipv4ToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { const v = Number(x); if (!/^\d{1,3}$/.test(x) || v > 255) return null; n = n * 256 + v; }
  return n;
}
let blockedRanges = [];
function loadRanges() { // optional file data\blocked-ranges.txt: one IPv4 range per line, e.g. 203.0.113.0/24
  try {
    blockedRanges = fs.readFileSync(RANGES_FILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => {
      const [a, b = '32'] = l.split('/'), base = ipv4ToInt(a), bits = Number(b);
      if (base === null || !(bits >= 0 && bits <= 32)) return null;
      const size = 2 ** (32 - bits), start = Math.floor(base / size) * size;
      return [start, start + size - 1];
    }).filter(Boolean);
  } catch { blockedRanges = []; }
}
loadRanges();
function proxyReason(req) {
  if (req.headers['cf-ipcountry'] === 'T1') return 'tor';
  if (req.headers['x-proxy-id'] || req.headers['proxy-connection']) return 'proxy';
  if (String(req.headers['x-forwarded-for'] || '').split(',').filter(x => x.trim()).length > 1) return 'proxy';
  const n = ipv4ToInt(clientIp(req));
  if (n !== null && blockedRanges.some(([a, b]) => n >= a && n <= b)) return 'vpn';
  return null;
}
/** Returns an error message if access must be refused, otherwise null. claim=true locks the link to this visitor. */
function strictCheck(req, res, doc, claim) {
  if (!doc.strict) return null;
  if (proxyReason(req)) return 'Access through a VPN, proxy or Tor is not allowed. Please turn it off and reload this page.';
  const ip = clientIp(req), tok = parseCookies(req)['pl_' + doc.id];
  if (doc.lock) {
    const ok = doc.lock.ip === ip && tok && sha(tok) === doc.lock.tok;
    return ok ? null : 'This link has already been opened on another device or network, so it cannot be opened again. Ask the sender for a new link.';
  }
  if (claim) {
    const t = crypto.randomBytes(24).toString('base64url');
    doc.lock = { ip, tok: sha(t), at: new Date().toISOString() };
    saveDocs();
    res.append('Set-Cookie', `pl_${doc.id}=${t}; Path=/api/public/${doc.id}; HttpOnly; SameSite=Lax; Max-Age=31536000${isSecure(req) ? '; Secure' : ''}`);
  }
  return null;
}

// ---------------------------------------------------------------- admin sessions + "local only" guard
const sessions = new Map();
const SESSION_MS = 12 * 3600 * 1000;
function startSession(res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_MS);
  res.append('Set-Cookie', `ps_admin=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
}
function isAuthed(req) {
  const t = parseCookies(req).ps_admin;
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
const requireAuth = (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Please log in.' }));

const LOCAL_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocalRequest(req) {
  if (!LOCAL_ADDR.has(req.socket.remoteAddress)) return false;
  // Anything that came through Cloudflare carries these headers. Admin is refused for them.
  for (const h of ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-forwarded-host', 'forwarded']) {
    if (req.headers[h]) return false;
  }
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}
const localOnly = (req, res, next) => (isLocalRequest(req) ? next() : res.status(404).type('text').send('Not found'));
function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const o = req.headers.origin;
  if (o) {
    try { if (new URL(o).host !== req.headers.host) throw 0; } catch { return res.status(403).json({ error: 'Bad origin' }); }
  }
  next();
}

// ---------------------------------------------------------------- rate limiting
const ipKey = req => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown');
const limiter = (windowMs, limit, extra = {}) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: ipKey,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' }, ...extra
});
const publicLimiter = limiter(60 * 1000, 120);
const unlockLimiter = limiter(10 * 60 * 1000, 10, { skipSuccessfulRequests: true, keyGenerator: req => ipKey(req) + ':' + req.params.id });
const loginLimiter = limiter(10 * 60 * 1000, 10, { skipSuccessfulRequests: true });

// ---------------------------------------------------------------- tunnel status
let procCache = { t: 0, v: false };
function cloudflaredRunning() {
  return new Promise(resolve => {
    if (Date.now() - procCache.t < 4000) return resolve(procCache.v);
    const done = v => { procCache = { t: Date.now(), v }; resolve(v); };
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/NH'], { windowsHide: true, timeout: 5000 },
        (e, out) => done(!e && /cloudflared\.exe/i.test(out || '')));
    } else {
      execFile('pgrep', ['-x', 'cloudflared'], e => done(!e));
    }
  });
}
function quickTunnelUrl() {
  try {
    const m = [...fs.readFileSync(TUNNEL_LOG, 'utf8').matchAll(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/g)];
    return m.length ? m[m.length - 1][0] : '';
  } catch { return ''; }
}
let probeCache = { url: '', t: 0, ok: false };
async function probe(url) {
  if (probeCache.url === url && Date.now() - probeCache.t < 10000) return probeCache.ok;
  let ok = false;
  try {
    const r = await fetch(url + '/healthz', { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    ok = r.ok;
  } catch { ok = false; }
  probeCache = { url, t: Date.now(), ok };
  return ok;
}
async function tunnelStatus() {
  const running = await cloudflaredRunning();
  let url = config.publicUrl || '';
  let mode = url ? 'stable' : 'none';
  if (!url && running) { url = quickTunnelUrl(); if (url) mode = 'quick'; }
  const reachable = running && url ? await probe(url) : false;
  return { running, mode, url, reachable };
}

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' blob: data:; worker-src 'self' blob:; frame-src blob:; object-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  });
  next();
});

const sendPage = name => (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(PUBLIC_DIR, name)); };
const sendAsset = name => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name), { maxAge: '1h' });

// ---- public routes (available through the tunnel)
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));
app.get('/favicon.svg', sendAsset('favicon.svg'));
app.get('/print.css', sendAsset('print.css'));
app.get('/print.js', sendAsset('print.js'));
app.use('/vendor/pdfjs', express.static(PDFJS_DIR, { index: false, dotfiles: 'ignore', maxAge: '7d' }));
app.get('/print/:id', publicLimiter, sendPage('print.html'));

app.get('/api/public/:id/info', publicLimiter, (req, res) => {
  const doc = getDoc(req.params.id);
  res.set('Cache-Control', 'no-store');
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const deny = strictCheck(req, res, doc, false);
  if (deny) return res.status(403).json({ error: deny });
  if (!hasUnlocked(req, doc)) return res.json({ locked: true });
  res.json({ locked: false, name: doc.name, size: doc.size, pages: doc.pages });
});

app.post('/api/public/:id/unlock', publicLimiter, unlockLimiter, express.json({ limit: '2kb' }), (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!doc.pw) return res.json({ ok: true });
  const pw = String((req.body && req.body.password) || '');
  if (!checkPw(pw, doc.pw.salt, doc.pw.hash)) return res.status(401).json({ error: 'Incorrect password.' });
  const exp = Date.now() + 8 * 3600 * 1000;
  res.append('Set-Cookie', `ps_${doc.id}=${unlockToken(doc, exp)}; Path=/api/public/${doc.id}; HttpOnly; SameSite=Lax; Max-Age=28800${isSecure(req) ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/public/:id/file', publicLimiter, (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!hasUnlocked(req, doc)) return res.status(401).json({ error: 'Password required' });
  const deny = strictCheck(req, res, doc, true);
  if (deny) return res.status(403).json({ error: deny });
  res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Robots-Tag': 'noindex' });
  res.sendFile(docPath(doc.id), { etag: false, lastModified: false, dotfiles: 'deny' });
});

// ---- admin routes (this laptop only)
app.get('/', localOnly, sendPage('index.html'));
app.get('/style.css', localOnly, sendAsset('style.css'));
app.get('/app.js', localOnly, sendAsset('app.js'));

const admin = express.Router();
admin.use(express.json({ limit: '10kb' }));
admin.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

admin.get('/session', (req, res) => res.json({ authed: isAuthed(req), setupRequired: !config.adminHash }));

admin.post('/setup', (req, res) => {
  if (config.adminHash) return res.status(400).json({ error: 'Password already set.' });
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Use at least 8 characters.' });
  const { salt, hash } = hashPw(pw);
  config.adminSalt = salt; config.adminHash = hash; saveConfig();
  startSession(res);
  res.json({ ok: true });
});

admin.post('/login', loginLimiter, (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  if (!config.adminHash || !checkPw(pw, config.adminSalt, config.adminHash)) return res.status(401).json({ error: 'Incorrect password.' });
  startSession(res);
  res.json({ ok: true });
});

admin.post('/logout', (req, res) => {
  sessions.delete(parseCookies(req).ps_admin);
  res.append('Set-Cookie', 'ps_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

admin.use(requireAuth);

admin.get('/status', async (req, res) => {
  const tunnel = await tunnelStatus();
  const storage = docs.reduce((n, d) => n + d.size, 0);
  const baseUrl = config.publicUrl || (tunnel.running ? tunnel.url : '');
  res.json({ server: 'online', uptime: Math.round(process.uptime()), tunnel, baseUrl, count: docs.length, storage, maxFileMB: MAX_FILE_MB });
});

admin.get('/settings', (req, res) => res.json({ publicUrl: config.publicUrl || '' }));
admin.post('/settings', (req, res) => {
  let u = String((req.body && req.body.publicUrl) || '').trim().replace(/\/+$/, '');
  if (u) {
    try {
      const p = new URL(u);
      if (p.protocol !== 'https:' || p.pathname !== '/' ) throw 0;
      u = p.origin;
    } catch { return res.status(400).json({ error: 'Enter a full address that starts with https:// (no extra path).' }); }
  }
  config.publicUrl = u; saveConfig(); probeCache.t = 0;
  res.json({ publicUrl: u });
});

admin.get('/docs', (req, res) => res.json({ documents: docs.slice().reverse().map(publicView) }));

const uploader = multer({
  storage: multer.diskStorage({
    destination: (r, f, cb) => cb(null, UPLOAD_DIR),
    filename: (r, f, cb) => cb(null, newId() + '.pdf')
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ok = /\.pdf$/i.test(file.originalname) && file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Only PDF files are allowed.'), ok);
  }
}).array('files', 20);

const cleanName = raw => {
  let n = raw;
  try { n = Buffer.from(raw, 'latin1').toString('utf8'); } catch {}
  n = n.replace(/[\\/\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return n || 'document.pdf';
};

admin.post('/upload', (req, res) => {
  uploader(req, res, async err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_FILE_MB} MB.` : (err.message || 'Upload failed.');
      return res.status(400).json({ error: msg });
    }
    const created = [], rejected = [];
    for (const f of req.files || []) {
      const id = path.basename(f.filename, '.pdf');
      try {
        const fd = fs.openSync(f.path, 'r');
        const head = Buffer.alloc(1024);
        fs.readSync(fd, head, 0, 1024, 0); fs.closeSync(fd);
        if (!head.toString('latin1').includes('%PDF-')) throw new Error('This file is not a real PDF.');
        let pages = null;
        try {
          const pdf = await PDFDocument.load(fs.readFileSync(f.path), { ignoreEncryption: true, updateMetadata: false });
          pages = pdf.getPageCount();
        } catch { /* admin page will count pages in the browser instead */ }
        const doc = { id, name: cleanName(f.originalname), size: f.size, pages, createdAt: new Date().toISOString(), pw: null, strict: true, lock: null };
        docs.push(doc); created.push(publicView(doc));
      } catch (e) {
        fs.unlink(f.path, () => {});
        rejected.push({ name: cleanName(f.originalname), error: e.message });
      }
    }
    saveDocs();
    if (!created.length) return res.status(400).json({ error: (rejected[0] && rejected[0].error) || 'No file received.' });
    res.json({ documents: created, rejected });
  });
});

admin.get('/docs/:id/file', (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
  res.sendFile(docPath(doc.id), { etag: false, lastModified: false, dotfiles: 'deny' });
});

admin.post('/docs/:id/pages', (req, res) => {
  const doc = getDoc(req.params.id);
  const n = Number(req.body && req.body.pages);
  if (!doc || !Number.isInteger(n) || n < 1 || n > 100000) return res.status(400).json({ error: 'Invalid request' });
  doc.pages = n; saveDocs();
  res.json({ document: publicView(doc) });
});

admin.post('/docs/:id/password', (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const pw = req.body && req.body.password;
  if (pw === null || pw === '') doc.pw = null;
  else if (typeof pw === 'string' && pw.length >= 4 && pw.length <= 100) doc.pw = hashPw(pw);
  else return res.status(400).json({ error: 'Use 4 to 100 characters.' });
  saveDocs();
  res.json({ document: publicView(doc) });
});

admin.post('/docs/:id/access', (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (req.body && typeof req.body.strict === 'boolean') { doc.strict = req.body.strict; if (!doc.strict) doc.lock = null; }
  if (req.body && req.body.release === true) doc.lock = null;
  saveDocs();
  res.json({ document: publicView(doc) });
});

admin.delete('/docs/:id', (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  docs = docs.filter(d => d.id !== doc.id);
  saveDocs();
  fs.unlink(docPath(doc.id), () => {});
  res.json({ ok: true });
});

app.use('/api/admin', localOnly, sameOrigin, admin);

app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

process.on('uncaughtException', e => console.error('Unexpected error:', e));
process.on('unhandledRejection', e => console.error('Unexpected error:', e));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  PrintShare is running.');
  console.log(`  Admin dashboard (this laptop only): http://localhost:${PORT}`);
  console.log('  Keep this window open while you want to share documents.');
  console.log('');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Is PrintShare already running? Run STOP.bat first.\n`);
  else console.error(e);
  process.exit(1);
});
