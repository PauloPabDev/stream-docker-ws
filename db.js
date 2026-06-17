import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'crypto';

const DB_PATH = process.env.DB_PATH ?? './data/app.db';

if (DB_PATH !== ':memory:') {
  mkdirSync(DB_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER DEFAULT (unixepoch()),
    last_used INTEGER
  );
`);

// --- Prepared statements ---
const stmtGetUserCount = db.prepare('SELECT COUNT(*) as count FROM users');
const stmtFindUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtInsertUser = db.prepare(
  'INSERT INTO users (username, password_hash) VALUES (?, ?)'
);
const stmtInsertToken = db.prepare(
  'INSERT INTO tokens (label, token, created_by) VALUES (?, ?, ?)'
);
const stmtListTokens = db.prepare(
  'SELECT id, label, token, created_at, last_used FROM tokens ORDER BY created_at DESC'
);
const stmtDeleteToken = db.prepare('DELETE FROM tokens WHERE id = ?');
const stmtFindToken = db.prepare('SELECT id FROM tokens WHERE token = ?');
const stmtTouchToken = db.prepare(
  'UPDATE tokens SET last_used = unixepoch() WHERE id = ?'
);

// --- Helpers internos ---
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expected, 'hex');
  return timingSafeEqual(actual, expectedBuf);
}

// --- API pública ---
export function initDb() {
  // La DB se inicializa al importar el módulo, esta función es para compatibilidad
  // con server.js que la llama explícitamente.
}

export function getUserCount() {
  return stmtGetUserCount.get().count;
}

export function createUser(username, password) {
  const hash = hashPassword(password);
  stmtInsertUser.run(username, hash);
}

export function checkPassword(username, password) {
  const user = stmtFindUser.get(username);
  if (!user) return false;
  return verifyPassword(password, user.password_hash);
}

export function findUser(username) {
  return stmtFindUser.get(username);
}

export function createToken(label, userId) {
  const token = randomBytes(32).toString('hex');
  stmtInsertToken.run(label, token, userId);
  return token;
}

export function listTokens() {
  return stmtListTokens.all().map((row) => ({
    ...row,
    preview: `${row.token.slice(0, 8)}...`,
  }));
}

export function deleteToken(id) {
  return stmtDeleteToken.run(id).changes;
}

export function validateToken(tokenStr) {
  const row = stmtFindToken.get(tokenStr);
  if (!row) return false;
  stmtTouchToken.run(row.id);
  return true;
}

// Exportar helpers de sesión para tests
export { createHmac };
