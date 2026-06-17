import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import {
  getUserCount,
  createUser,
  checkPassword,
  findUser,
  createToken,
  listTokens,
  deleteToken,
} from './db.js';

const SESSION_SECRET =
  process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const sessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 horas

// --- Helpers de sesión ---
export function signSession(id) {
  const hmac = createHmac('sha256', SESSION_SECRET).update(id).digest('hex');
  return `${id}.${hmac}`;
}

export function parseSession(cookieValue) {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return null;
  const id = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const expected = createHmac('sha256', SESSION_SECRET).update(id).digest('hex');
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')))
      return null;
  } catch {
    return null;
  }
  return id;
}

function getSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!match) return null;
  const id = parseSession(decodeURIComponent(match[1]));
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function isAdminSession(req) {
  return getSession(req) !== null;
}

function createSession(userId, username) {
  const id = randomBytes(16).toString('hex');
  sessions.set(id, { userId, username, expiresAt: Date.now() + SESSION_TTL });
  return id;
}

function sessionCookie(id) {
  return `sid=${encodeURIComponent(signSession(id))}; HttpOnly; Path=/; SameSite=Strict`;
}

// --- Helpers HTTP ---
export function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        req.socket.destroy();
        reject(new Error('Body too large'));
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function redirect(res, location, code = 303, extraHeaders = {}) {
  res.writeHead(code, { Location: location, ...extraHeaders });
  res.end();
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

// --- HTML ---
const STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:2rem;width:100%;max-width:680px}
  h1{color:#f0f6fc;font-size:1.2rem;margin-bottom:1.5rem}
  h2{color:#f0f6fc;font-size:1rem;margin:1.5rem 0 0.75rem}
  input,button{width:100%;padding:0.6rem 0.8rem;border-radius:6px;border:1px solid #30363d;font-size:0.9rem;margin-top:0.5rem}
  input{background:#0d1117;color:#c9d1d9}
  input:focus{outline:none;border-color:#58a6ff}
  button{background:#238636;color:#fff;border:none;cursor:pointer;font-weight:600}
  button:hover{background:#2ea043}
  button.danger{background:#b91c1c}
  button.danger:hover{background:#991b1b}
  .btn-sm{width:auto;padding:0.3rem 0.7rem;margin:0;font-size:0.8rem}
  .error{color:#f85149;font-size:0.85rem;margin-top:0.5rem}
  .banner{background:#1a3a1a;border:1px solid #238636;border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.85rem;word-break:break-all}
  .banner code{color:#79c0ff;font-family:monospace}
  table{width:100%;border-collapse:collapse;font-size:0.85rem;margin-top:0.5rem}
  th,td{padding:0.4rem 0.6rem;text-align:left;border-bottom:1px solid #21262d}
  th{color:#8b949e;font-weight:600}
  .row-form{display:flex;gap:0.5rem;margin-top:0.75rem;align-items:flex-end}
  .row-form input{margin:0;flex:1}
  .row-form button{width:auto;padding:0.6rem 1rem}
  .logout{float:right;background:none;border:none;color:#8b949e;cursor:pointer;font-size:0.8rem;width:auto;margin:0;padding:0}
  .logout:hover{color:#c9d1d9}
  .btn-copy{background:#1f6feb;margin-top:0}
  .btn-copy:hover{background:#388bfd}
  .btn-copy.copied{background:#238636}
`;

export function renderLayout(title, body) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>${STYLE}</style></head><body><div class="card">${body}</div></body></html>`;
}

function renderLogin(error = '') {
  return renderLayout('Admin — Login', `
    <h1>Docker Stats — Admin</h1>
    <form method="post" action="/login">
      <input name="username" placeholder="Usuario" required autofocus>
      <input name="password" type="password" placeholder="Contraseña" required style="margin-top:0.75rem">
      <button style="margin-top:1rem">Entrar</button>
      ${error ? `<p class="error">${escHtml(error)}</p>` : ''}
    </form>
  `);
}

function renderSetup(error = '') {
  return renderLayout('Admin — Setup inicial', `
    <h1>Crear primer usuario admin</h1>
    <form method="post" action="/setup">
      <input name="username" placeholder="Nombre de usuario" required autofocus>
      <input name="password" type="password" placeholder="Contraseña" required style="margin-top:0.75rem">
      <button style="margin-top:1rem">Crear admin</button>
      ${error ? `<p class="error">${escHtml(error)}</p>` : ''}
    </form>
  `);
}

function renderDashboard(session, tokens, newToken = null) {
  const rows = tokens.map((t) => `
    <tr>
      <td>${escHtml(t.label)}</td>
      <td>
        <span class="token-preview" data-token="${escHtml(t.token)}">
          <code style="font-family:monospace;color:#79c0ff">${escHtml(t.preview)}</code>
          <button class="btn-sm btn-copy" onclick="copyToken(this)" style="margin-left:0.4rem">Copiar</button>
        </span>
      </td>
      <td>${t.last_used ? new Date(t.last_used * 1000).toLocaleString() : '—'}</td>
      <td>
        <form method="post" action="/api/tokens/delete" style="display:inline">
          <input type="hidden" name="id" value="${t.id}">
          <button class="danger btn-sm" type="submit">Revocar</button>
        </form>
      </td>
    </tr>`).join('');

  const banner = newToken
    ? `<div class="banner">Token creado. <strong>Cópialo ahora</strong>, no se mostrará de nuevo:<br><br><code>${escHtml(newToken)}</code></div>`
    : '';

  return renderLayout('Admin — Docker Stats', `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <h1 style="margin:0">Docker Stats — Admin</h1>
      <form method="post" action="/logout">
        <button class="logout" type="submit">Cerrar sesión (${escHtml(session.username)})</button>
      </form>
    </div>

    ${banner}

    <h2>Contenedores en tiempo real</h2>
    <p id="ws-status" style="font-size:0.8rem;color:#8b949e;margin:0.4rem 0 0.6rem">Conectando...</p>
    <div style="overflow-x:auto">
      <table id="stats-table">
        <thead>
          <tr>
            <th>Nombre</th><th>CPU</th><th>Memoria</th><th>Uso Memoria</th><th>Red</th><th>Disco</th><th>PIDs</th>
          </tr>
        </thead>
        <tbody id="stats-body">
          <tr><td colspan="7" style="color:#8b949e;text-align:center">Esperando datos...</td></tr>
        </tbody>
      </table>
    </div>

    <h2 style="margin-top:1.5rem">Tokens de API</h2>
    ${tokens.length
      ? `<table><thead><tr><th>Nombre</th><th>Preview</th><th>Último uso</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p style="color:#8b949e;font-size:0.85rem;margin-top:0.5rem">No hay tokens. Crea uno abajo.</p>'
    }
    <h2>Crear token</h2>
    <form method="post" action="/api/tokens">
      <div class="row-form">
        <input name="label" placeholder="Nombre del token (ej: cli-casa)" required maxlength="100">
        <button type="submit">Crear</button>
      </div>
    </form>

    <script>
      (function () {
        const statusEl = document.getElementById('ws-status');
        const tbody = document.getElementById('stats-body');
        let ws, retryMs = 1000;

        function connect() {
          ws = new WebSocket('ws://' + location.host);
          ws.onopen = () => {
            retryMs = 1000;
            statusEl.textContent = 'Conectado';
            statusEl.style.color = '#3fb950';
          };
          ws.onclose = () => {
            statusEl.textContent = 'Desconectado — reconectando en ' + (retryMs / 1000) + 's...';
            statusEl.style.color = '#f85149';
            setTimeout(connect, retryMs);
            retryMs = Math.min(retryMs * 2, 10000);
          };
          ws.onmessage = (e) => {
            let data;
            try { data = JSON.parse(e.data); } catch { return; }
            if (!Array.isArray(data) || !data.length) {
              tbody.innerHTML = '<tr><td colspan="7" style="color:#8b949e;text-align:center">Sin contenedores activos</td></tr>';
              return;
            }
            tbody.innerHTML = data.map(c => \`<tr>
              <td>\${c.Name}</td>
              <td>\${c.CPUPerc}</td>
              <td>\${c.MemPerc}</td>
              <td>\${c.MemUsage}</td>
              <td>\${c.NetIO}</td>
              <td>\${c.BlockIO}</td>
              <td>\${c.PIDs}</td>
            </tr>\`).join('');
          };
        }

        connect();
      })();

      function copyToken(btn) {
        const token = btn.closest('.token-preview').dataset.token;
        navigator.clipboard.writeText(token).then(() => {
          btn.textContent = 'Copiado!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 2000);
        });
      }
    </script>
  `);
}

// --- Handler HTTP exportado ---
export async function adminHandler(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  try {
    if (method === 'GET' && url === '/') {
      const session = getSession(req);
      if (session) return send(res, 200, renderDashboard(session, listTokens()));
      if (getUserCount() === 0) return send(res, 200, renderSetup());
      return send(res, 200, renderLogin());
    }

    if (method === 'POST' && url === '/login') {
      const body = parseForm(await readBody(req));
      const { username = '', password = '' } = body;
      if (checkPassword(username, password)) {
        const user = findUser(username);
        const id = createSession(user.id, user.username);
        return redirect(res, '/', 303, { 'Set-Cookie': sessionCookie(id) });
      }
      return send(res, 401, renderLogin('Usuario o contraseña incorrectos'));
    }

    if (method === 'POST' && url === '/setup') {
      if (getUserCount() > 0) return send(res, 403, renderLayout('Error', '<p>Ya existe un usuario administrador.</p>'));
      const body = parseForm(await readBody(req));
      const { username = '', password = '' } = body;
      if (!username.trim() || !password.trim())
        return send(res, 400, renderSetup('Usuario y contraseña son requeridos'));
      try {
        createUser(username.trim(), password);
        const user = findUser(username.trim());
        const id = createSession(user.id, user.username);
        return redirect(res, '/', 303, { 'Set-Cookie': sessionCookie(id) });
      } catch {
        return send(res, 400, renderSetup('Ese nombre de usuario ya existe'));
      }
    }

    if (method === 'POST' && url === '/logout') {
      const cookieHeader = req.headers.cookie || '';
      const match = cookieHeader.match(/(?:^|;\s*)sid=([^;]+)/);
      if (match) {
        const id = parseSession(decodeURIComponent(match[1]));
        if (id) sessions.delete(id);
      }
      const clearCookie = 'sid=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0';
      return redirect(res, '/', 303, { 'Set-Cookie': clearCookie });
    }

    if (method === 'POST' && url === '/api/tokens') {
      const session = getSession(req);
      if (!session) return redirect(res, '/');
      const body = parseForm(await readBody(req));
      const label = (body.label || '').trim().slice(0, 100);
      if (!label) return send(res, 400, renderDashboard(session, listTokens()));
      const token = createToken(label, session.userId);
      return send(res, 200, renderDashboard(session, listTokens(), token));
    }

    if (method === 'POST' && url === '/api/tokens/delete') {
      const session = getSession(req);
      if (!session) return redirect(res, '/');
      const body = parseForm(await readBody(req));
      const id = parseInt(body.id, 10);
      if (!isNaN(id)) deleteToken(id);
      return redirect(res, '/');
    }

    send(res, 404, renderLayout('404', '<p>Página no encontrada.</p>'));
  } catch (err) {
    console.error('Admin error:', err);
    send(res, 500, renderLayout('Error', '<p>Error interno del servidor.</p>'));
  }
}

// Bootstrap: crear primer admin desde env vars si la DB está vacía
export function bootstrap() {
  if (getUserCount() === 0) {
    const u = process.env.ADMIN_USERNAME;
    const p = process.env.ADMIN_PASSWORD;
    if (u && p) {
      createUser(u, p);
      console.log(`Admin user "${u}" auto-created from env vars`);
    } else {
      console.log('No admin users — open /admin to create one');
    }
  }
}

