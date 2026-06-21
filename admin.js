import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync }                              from 'node:fs';
import { fileURLToPath }                             from 'node:url';
import { dirname, resolve, extname }                 from 'node:path';
import {
  getUserCount, createUser, checkPassword, findUser,
  createToken, listTokens, deleteToken,
} from './db.js';

// ── Paths ─────────────────────────────────────────────────────────
const __dirname  = dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR  = resolve(__dirname, 'views');
const PUBLIC_DIR = resolve(__dirname, 'public');

// ── Template engine ───────────────────────────────────────────────
const tplCache = new Map();

function loadTemplate(name) {
  if (process.env.NODE_ENV === 'production' && tplCache.has(name)) return tplCache.get(name);
  const content = readFileSync(resolve(VIEWS_DIR, name), 'utf8');
  if (process.env.NODE_ENV === 'production') tplCache.set(name, content);
  return content;
}

function render(template, vars = {}) {
  let html = loadTemplate(template);
  for (const [k, v] of Object.entries(vars)) {
    html = html.replaceAll(`{{${k}}}`, v ?? '');
  }
  return html;
}

// ── Sessions ──────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const sessions       = new Map();
const SESSION_TTL    = 8 * 60 * 60 * 1000;

export function signSession(id) {
  return `${id}.${createHmac('sha256', SESSION_SECRET).update(id).digest('hex')}`;
}

export function parseSession(cookieValue) {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return null;
  const id  = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = createHmac('sha256', SESSION_SECRET).update(id).digest('hex');
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch { return null; }
  return id;
}

function getSession(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/);
  if (!match) return null;
  const id = parseSession(decodeURIComponent(match[1]));
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || Date.now() > session.expiresAt) { sessions.delete(id); return null; }
  return session;
}

export function isAdminSession(req) { return getSession(req) !== null; }

function createSession(userId, username) {
  const id = randomBytes(16).toString('hex');
  sessions.set(id, { userId, username, expiresAt: Date.now() + SESSION_TTL });
  return id;
}

function sessionCookie(id) {
  return `sid=${encodeURIComponent(signSession(id))}; HttpOnly; Path=/; SameSite=Strict`;
}

// ── HTML helpers ──────────────────────────────────────────────────
export function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export function parseForm(body) { return Object.fromEntries(new URLSearchParams(body)); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1_048_576) { req.socket.destroy(); reject(new Error('Body too large')); return; }
      data += chunk.toString();
    });
    req.on('end',   () => resolve(data));
    req.on('error', reject);
  });
}

function redirect(res, location, code = 303, extra = {}) {
  res.writeHead(code, { Location: location, ...extra });
  res.end();
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

// ── renderLayout (kept for backward-compat / tests) ──────────────
export function renderLayout(title, body) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${escHtml(title)}</title></head><body>${body}</body></html>`;
}

// ── Token cards HTML (server-rendered) ───────────────────────────
function renderTokenRows(tokens) {
  if (!tokens.length) {
    return `<div class="tokens-empty">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
  </svg>
  <div>No tokens yet — create one below.</div>
</div>`;
  }

  const cards = tokens.map(t => `
<div class="token-card">
  <div class="tc-top">
    <div class="tc-name">${escHtml(t.label)}</div>
  </div>
  <div class="tc-preview" data-token="${escHtml(t.token)}">${escHtml(t.preview)}</div>
  <div class="tc-footer">
    <div class="tc-last">Last used: <span>${t.last_used ? new Date(t.last_used * 1000).toLocaleString() : 'never'}</span></div>
    <div class="tc-actions">
      <button class="btn-copy" onclick="copyToken(this)" data-token="${escHtml(t.token)}">Copy</button>
      <form method="post" action="/api/tokens/delete" style="margin:0">
        <input type="hidden" name="id" value="${t.id}"/>
        <button type="submit" class="btn-revoke">Revoke</button>
      </form>
    </div>
  </div>
</div>`).join('');

  return `<div class="token-grid">${cards}</div>`;
}

function renderBanner(token) {
  if (!token) return '';
  return `<div class="token-banner">
  <p><strong>Token created.</strong> Copy it now — it won't be shown again.</p>
  <code>${escHtml(token)}</code>
</div>`;
}

function renderError(msg) {
  if (!msg) return '';
  return `<div class="err-pill">${escHtml(msg)}</div>`;
}

// ── Static file serving ───────────────────────────────────────────
const MIME = { '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath.replace(/^\/public\//, '');
  const abs = resolve(PUBLIC_DIR, rel);
  // Path traversal guard
  if (!abs.startsWith(PUBLIC_DIR + '/') && abs !== PUBLIC_DIR) {
    send(res, 403, '<p>Forbidden</p>'); return;
  }
  try {
    const content = readFileSync(abs, 'utf8');
    const mime    = MIME[extname(abs)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(content);
  } catch { send(res, 404, ''); }
}

// ── Main HTTP handler ─────────────────────────────────────────────
export async function adminHandler(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  try {
    // Static assets
    if (method === 'GET' && url.startsWith('/public/')) {
      serveStatic(req, res, url); return;
    }

    // Dashboard (root)
    if (method === 'GET' && url === '/') {
      const session = getSession(req);
      if (session) {
        return send(res, 200, render('dashboard.html', {
          username:       escHtml(session.username),
          banner:         '',
          tokens_section: renderTokenRows(listTokens()),
        }));
      }
      if (getUserCount() === 0) return send(res, 200, render('setup.html', { error: '' }));
      return send(res, 200, render('login.html', { error: '' }));
    }

    // Login
    if (method === 'POST' && url === '/login') {
      const { username = '', password = '' } = parseForm(await readBody(req));
      if (checkPassword(username, password)) {
        const user = findUser(username);
        const id   = createSession(user.id, user.username);
        return redirect(res, '/', 303, { 'Set-Cookie': sessionCookie(id) });
      }
      return send(res, 401, render('login.html', {
        error: renderError('Incorrect username or password.'),
      }));
    }

    // Initial setup
    if (method === 'POST' && url === '/setup') {
      if (getUserCount() > 0) return send(res, 403, render('login.html', { error: '' }));
      const { username = '', password = '' } = parseForm(await readBody(req));
      if (!username.trim() || !password.trim()) {
        return send(res, 400, render('setup.html', {
          error: renderError('Username and password are required.'),
        }));
      }
      try {
        createUser(username.trim(), password);
        const user = findUser(username.trim());
        const id   = createSession(user.id, user.username);
        return redirect(res, '/', 303, { 'Set-Cookie': sessionCookie(id) });
      } catch {
        return send(res, 400, render('setup.html', {
          error: renderError('That username is already taken.'),
        }));
      }
    }

    // Logout
    if (method === 'POST' && url === '/logout') {
      const match = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/);
      if (match) { const id = parseSession(decodeURIComponent(match[1])); if (id) sessions.delete(id); }
      return redirect(res, '/', 303, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0' });
    }

    // Create token
    if (method === 'POST' && url === '/api/tokens') {
      const session = getSession(req);
      if (!session) return redirect(res, '/');
      const { label = '' } = parseForm(await readBody(req));
      const trimmed = label.trim().slice(0, 100);
      if (!trimmed) return send(res, 400, render('dashboard.html', {
        username: escHtml(session.username), banner: '', tokens_section: renderTokenRows(listTokens()),
      }));
      const newToken = createToken(trimmed, session.userId);
      return send(res, 200, render('dashboard.html', {
        username:       escHtml(session.username),
        banner:         renderBanner(newToken),
        tokens_section: renderTokenRows(listTokens()),
      }));
    }

    // Delete token
    if (method === 'POST' && url === '/api/tokens/delete') {
      const session = getSession(req);
      if (!session) return redirect(res, '/');
      const { id = '' } = parseForm(await readBody(req));
      const tid = parseInt(id, 10);
      if (!isNaN(tid)) deleteToken(tid);
      return redirect(res, '/');
    }

    send(res, 404, '<p>Not found.</p>');
  } catch (err) {
    console.error('Admin error:', err);
    send(res, 500, '<p>Internal server error.</p>');
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────
export function bootstrap() {
  if (getUserCount() === 0) {
    const u = process.env.ADMIN_USERNAME;
    const p = process.env.ADMIN_PASSWORD;
    if (u && p) {
      createUser(u, p);
      console.log(`Admin user "${u}" auto-created from env vars`);
    } else {
      console.log('No admin users — open / to create one');
    }
  }
}
