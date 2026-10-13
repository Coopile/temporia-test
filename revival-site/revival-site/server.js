// Zero-dependency server: needs only Node 22.13+ (uses built-in node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const config = require('./config');

const db = new DatabaseSync(path.join(__dirname, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT 'classic',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discord_verifications (
    code TEXT PRIMARY KEY,
    discord_id TEXT,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS launch_tickets (
    ticket TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// ---------- helpers ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(expected, actual);
}

const hits = new Map(); // ip -> [timestamps]
function rateLimited(req, max = 20, windowMs = 15 * 60 * 1000) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20_000) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) return resolve(JSON.parse(raw || '{}'));
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid);
  if (!s || s.expires_at < Date.now()) return null;
  return db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(s.user_id) || null;
}

function startSession(res, userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  const ttl = 14 * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (sid, user_id, expires_at) VALUES (?, ?, ?)').run(sid, userId, Date.now() + ttl);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl / 1000}`);
}

function navFor(user) {
  return user
    ? `<a href="/profile">${esc(user.username)}</a><form method="post" action="/logout" class="inline"><button class="linklike">Log out</button></form>`
    : `<a href="/login">Log in</a><a class="btn small" href="/signup">Sign up</a>`;
}

const layoutHtml = () => fs.readFileSync(path.join(__dirname, 'views', 'layout.html'), 'utf8');
function render(res, view, locals = {}, status = 200) {
  const body = fs.readFileSync(path.join(__dirname, 'views', view + '.html'), 'utf8');
  const vars = { site: esc(config.siteName), theme: config.theme, ...locals };
  const fill = (str) => str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
  const html = fill(layoutHtml()).replace('<!--BODY-->', fill(body));
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };
const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(__dirname, 'public', rel));
  if (!file.startsWith(path.join(__dirname, 'public') + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  return true;
}

// Basic CSRF defence for form posts: Origin (when sent) must match Host.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const signupView = (res, error = '', status = 200) =>
  render(res, 'signup', {
    nav: navFor(null),
    error: error ? `<p class="error">${esc(error)}</p>` : '',
    discordInvite: esc(config.discordInvite),
    requireDiscord: config.requireDiscordVerification ? '' : 'hidden',
  }, status);

// ---------- routes ----------
async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  const method = req.method;
  const user = currentUser(req);

  if (method === 'GET' && serveStatic(req, res)) return;

  if (method === 'GET' && pathname === '/') return render(res, 'home', { nav: navFor(user) });
  if (method === 'GET' && pathname === '/download')
    return render(res, 'download', { nav: navFor(user), launcherUrl: esc(config.launcherUrl) });
  if (method === 'GET' && pathname === '/help')
    return render(res, 'help', { nav: navFor(user), discordInvite: esc(config.discordInvite) });

  if (method === 'GET' && pathname === '/signup') return signupView(res);
  if (method === 'POST' && pathname === '/signup') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad_origin' });
    if (rateLimited(req)) return signupView(res, 'Too many attempts. Try again later.', 429);
    const b = await readBody(req);
    const username = String(b.username || '');
    const password = String(b.password || '');
    const avatar = String(b.avatar || 'classic');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return signupView(res, 'Username must be 3-20 letters, numbers or underscores.', 400);
    if (password.length < 8) return signupView(res, 'Password must be at least 8 characters.', 400);
    if (password !== String(b.confirm || '')) return signupView(res, 'Passwords do not match.', 400);
    if (!['classic', 'blue', 'pink'].includes(avatar)) return signupView(res, 'Pick an avatar.', 400);

    if (config.requireDiscordVerification) {
      const row = db.prepare('SELECT * FROM discord_verifications WHERE code = ? AND used = 0').get(String(b.code || '').trim().toUpperCase());
      if (!row) return signupView(res, 'Invalid or already used verification code. Get one from our Discord server.', 400);
      db.prepare('UPDATE discord_verifications SET used = 1 WHERE code = ?').run(row.code);
    }
    try {
      const info = db.prepare('INSERT INTO users (username, password_hash, avatar) VALUES (?, ?, ?)').run(username, hashPassword(password), avatar);
      startSession(res, Number(info.lastInsertRowid));
      return redirect(res, '/profile');
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return signupView(res, 'That username is taken.', 409);
      console.error(e);
      return signupView(res, 'Something went wrong. Try again.', 500);
    }
  }

  if (method === 'GET' && pathname === '/login') return render(res, 'login', { nav: navFor(user), error: '' });
  if (method === 'POST' && pathname === '/login') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad_origin' });
    if (rateLimited(req)) return render(res, 'login', { nav: navFor(null), error: '<p class="error">Too many attempts. Try again later.</p>' }, 429);
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || ''));
    if (!row || !verifyPassword(String(b.password || ''), row.password_hash))
      return render(res, 'login', { nav: navFor(null), error: '<p class="error">Wrong username or password.</p>' }, 401);
    startSession(res, row.id);
    return redirect(res, '/profile');
  }

  if (method === 'POST' && pathname === '/logout') {
    const sid = parseCookies(req).sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return redirect(res, '/');
  }

  if (method === 'GET' && pathname === '/profile') {
    if (!user) return redirect(res, '/login');
    return render(res, 'profile', { nav: navFor(user), username: esc(user.username), avatar: esc(user.avatar) });
  }

  // ----- API for the launcher / game servers / Discord bot -----
  if (method === 'POST' && pathname === '/api/launcher/login') {
    if (rateLimited(req)) return json(res, 429, { error: 'rate_limited' });
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || ''));
    if (!row || !verifyPassword(String(b.password || ''), row.password_hash)) return json(res, 401, { error: 'invalid_credentials' });
    const ticket = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO launch_tickets (ticket, user_id, expires_at) VALUES (?, ?, ?)').run(ticket, row.id, Date.now() + 5 * 60 * 1000);
    return json(res, 200, { ticket, username: row.username, avatar: row.avatar });
  }
  if (method === 'POST' && pathname === '/api/launcher/redeem') {
    if (req.headers['x-api-key'] !== config.serverApiKey) return json(res, 403, { error: 'forbidden' });
    const b = await readBody(req);
    const row = db.prepare('SELECT * FROM launch_tickets WHERE ticket = ?').get(String(b.ticket || ''));
    if (!row || row.expires_at < Date.now()) return json(res, 404, { error: 'invalid_ticket' });
    db.prepare('DELETE FROM launch_tickets WHERE ticket = ?').run(row.ticket);
    return json(res, 200, db.prepare('SELECT id, username, avatar FROM users WHERE id = ?').get(row.user_id));
  }
  if (method === 'POST' && pathname === '/api/discord/code') {
    if (req.headers['x-api-key'] !== config.serverApiKey) return json(res, 403, { error: 'forbidden' });
    const b = await readBody(req);
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare('INSERT INTO discord_verifications (code, discord_id) VALUES (?, ?)').run(code, b.discordId ? String(b.discordId) : null);
    return json(res, 200, { code });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
    });
  })
  .listen(config.port, () => console.log(`${config.siteName} running on http://localhost:${config.port}`));
