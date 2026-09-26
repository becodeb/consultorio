#!/usr/bin/env node
/**
 * Static file server + auth + per-account storage + /api/voice proxy for the
 * Consultorio app. Node built-ins only, no npm dependencies.
 *
 *   DATA_DIR=./data node server.mjs
 *
 * Env vars: PORT (default 8811), HOST (default 0.0.0.0), DATA_DIR (default ./data),
 * INSECURE_COOKIES (set to "1" to allow a non-Secure session cookie over plain HTTP,
 * for local dev / e2e only — see the cookie section below), LLM_BASE_URL, LLM_API_KEY,
 * LLM_MODEL, optional LLM_EXTRA_HEADERS (JSON object merged into the LLM request headers).
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// node:sqlite is experimental in Node 24; the app deliberately relies on it (no npm
// dependency), so the warning is expected noise rather than something to fix. A static
// `import` is hoisted above this line regardless of source order, so it would already have
// fired the warning before we get a chance to suppress it — a dynamic import() does not
// hoist, so it runs after removeAllListeners has taken effect. (`--no-warnings` on the
// start command, used in the Docker image, is an alternative belt-and-suspenders fix.)
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;

const PORT = Number(process.env.PORT) || 8811;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || './data';
const INSECURE_COOKIES = process.env.INSECURE_COOKIES === '1';
const LLM_BASE_URL = process.env.LLM_BASE_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || '';
let LLM_EXTRA_HEADERS = {};
try {
  if (process.env.LLM_EXTRA_HEADERS) LLM_EXTRA_HEADERS = JSON.parse(process.env.LLM_EXTRA_HEADERS);
} catch {
  console.error('LLM_EXTRA_HEADERS is not valid JSON, ignoring it');
}

/* ============================================================
   Storage: node:sqlite, one file under DATA_DIR
   ============================================================ */
fsSync.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'consultorio.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS docs (
    user_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const stmt = {
  insertUser: db.prepare('INSERT INTO users (id, email, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)'),
  sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
  touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  docByUser: db.prepare('SELECT * FROM docs WHERE user_id = ?'),
  upsertDoc: db.prepare(`
    INSERT INTO docs (user_id, data, version, updated_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = version + 1, updated_at = excluded.updated_at
  `),
};

function nowIso() { return new Date().toISOString(); }
function uid() { return crypto.randomUUID(); }

/* ============================================================
   Passwords: scrypt, random salt, constant-time compare
   ============================================================ */
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(nStr), r: Number(rStr), p: Number(pStr),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ============================================================
   Sessions: random token, sha256 stored server-side, cookie helpers
   ============================================================ */
const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60; // 400 days
const SECURE_COOKIE = '__Host-consultorio';
const INSECURE_COOKIE = 'consultorio';

function newSessionToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https'; }

/** Whether this request may use the relaxed, non-Secure cookie (local dev / e2e only). */
function useInsecureCookie(req) { return INSECURE_COOKIES && !isHttps(req); }

function setSessionCookie(req, res, token) {
  const name = useInsecureCookie(req) ? INSECURE_COOKIE : SECURE_COOKIE;
  const attrs = [`${name}=${token}`, 'Path=/', `Max-Age=${SESSION_MAX_AGE_S}`, 'SameSite=Lax', 'HttpOnly'];
  if (!useInsecureCookie(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const name = useInsecureCookie(req) ? INSECURE_COOKIE : SECURE_COOKIE;
  const attrs = [`${name}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax', 'HttpOnly'];
  if (!useInsecureCookie(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SECURE_COOKIE] || (INSECURE_COOKIES ? cookies[INSECURE_COOKIE] : undefined);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = stmt.sessionByHash.get(tokenHash);
  if (!row) return null;
  stmt.touchSession.run(nowIso(), tokenHash);
  const user = stmt.userById.get(row.user_id);
  if (!user) return null;
  return { userId: user.id, email: user.email, tokenHash };
}

/* ============================================================
   Rate limiting (in-memory, per IP)
   ============================================================ */
function makeLimiter(limit, windowMs) {
  const hits = new Map(); // ip -> timestamps[]
  return ip => {
    const now = Date.now();
    const windowStart = now - windowMs;
    const arr = (hits.get(ip) || []).filter(t => t > windowStart);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length <= limit;
  };
}
const voiceLimiter = makeLimiter(30, 60_000);
const authLimiter = makeLimiter(10, 60_000);
const generalLimiter = makeLimiter(120, 60_000);

function clientIp(req) { return req.socket.remoteAddress || 'unknown'; }

/* ============================================================
   Request helpers
   ============================================================ */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function isJsonContentType(req) {
  const ct = req.headers['content-type'] || '';
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

/** Origin, when present, must match this server's own host — a lightweight CSRF guard.
 *  Requests without an Origin header (curl, same-origin edge cases) are not blocked here;
 *  the session cookie is SameSite=Lax + HttpOnly, which already stops cross-site use. */
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const proto = isHttps(req) ? 'https' : 'http';
  const host = req.headers.host || '';
  return origin === `${proto}://${host}`;
}

async function readJsonBody(req, res, limit) {
  if (!isJsonContentType(req)) { sendJson(res, 415, { error: 'Content-Type debe ser application/json.' }); return undefined; }
  let body;
  try {
    body = await readBody(req, limit);
  } catch {
    sendJson(res, 413, { error: 'Solicitud demasiado grande.' });
    return undefined;
  }
  try {
    return JSON.parse(body.toString('utf-8'));
  } catch {
    sendJson(res, 400, { error: 'JSON inválido.' });
    return undefined;
  }
}

/* ============================================================
   Static files
   ============================================================ */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const BLOCKED_SEGMENTS = new Set(['.git', 'odd', 'node_modules', 'shots', 'tools', 'data']);
function isBlockedPath(relFromRoot) {
  return relFromRoot.split(path.sep).some(seg => BLOCKED_SEGMENTS.has(seg) || seg.startsWith('.env'));
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  rel = rel.replace(/^\/+/, '');
  const resolved = path.normalize(path.join(ROOT, rel));
  const inRoot = resolved === ROOT || resolved.startsWith(ROOT_WITH_SEP);
  if (!inRoot || isBlockedPath(path.relative(ROOT, resolved))) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) throw new Error('is a directory');
    const ext = path.extname(resolved);
    const body = await fs.readFile(resolved);
    const headers = { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream', 'content-length': body.length };
    if (ext === '.html') headers['cache-control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/* ============================================================
   Auth endpoints
   ============================================================ */
async function handleSignup(req, res) {
  if (!authLimiter(clientIp(req))) return sendJson(res, 429, { error: 'Demasiados intentos, esperá un minuto.' });
  if (!originOk(req)) return sendJson(res, 403, { error: 'Origen inválido.' });
  const payload = await readJsonBody(req, res, 16 * 1024);
  if (payload === undefined) return;

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';
  if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'Mail inválido.' });
  if (password.length < 8) return sendJson(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });

  const id = uid();
  try {
    stmt.insertUser.run(id, email, hashPassword(password), nowIso());
  } catch (e) {
    if (e.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(e.message)) {
      return sendJson(res, 409, { error: 'Ya existe una cuenta con ese mail.' });
    }
    throw e;
  }

  const token = newSessionToken();
  stmt.insertSession.run(hashToken(token), id, nowIso(), nowIso());
  setSessionCookie(req, res, token);
  sendJson(res, 200, { id, email });
}

async function handleLogin(req, res) {
  if (!authLimiter(clientIp(req))) return sendJson(res, 429, { error: 'Demasiados intentos, esperá un minuto.' });
  if (!originOk(req)) return sendJson(res, 403, { error: 'Origen inválido.' });
  const payload = await readJsonBody(req, res, 16 * 1024);
  if (payload === undefined) return;

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';
  const user = email ? stmt.userByEmail.get(email) : null;
  if (!user || !verifyPassword(password, user.pass_hash)) {
    return sendJson(res, 401, { error: 'Mail o contraseña incorrectos.' });
  }

  const token = newSessionToken();
  stmt.insertSession.run(hashToken(token), user.id, nowIso(), nowIso());
  setSessionCookie(req, res, token);
  sendJson(res, 200, { id: user.id, email: user.email });
}

async function handleLogout(req, res) {
  if (!originOk(req)) return sendJson(res, 403, { error: 'Origen inválido.' });
  const session = getSession(req);
  if (session) stmt.deleteSession.run(session.tokenHash);
  clearSessionCookie(req, res);
  res.writeHead(204);
  res.end();
}

function handleMe(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'No autenticado.' });
  sendJson(res, 200, { id: session.userId, email: session.email });
}

/* ============================================================
   Data sync endpoints
   ============================================================ */
function handleGetData(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'No autenticado.' });
  const row = stmt.docByUser.get(session.userId);
  if (!row) return sendJson(res, 200, { data: null, version: 0 });
  let data;
  try { data = JSON.parse(row.data); } catch { data = null; }
  sendJson(res, 200, { data, version: row.version });
}

async function handlePutData(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'No autenticado.' });
  if (!originOk(req)) return sendJson(res, 403, { error: 'Origen inválido.' });
  const payload = await readJsonBody(req, res, 2 * 1024 * 1024);
  if (payload === undefined) return;

  if (typeof payload.baseVersion !== 'number' || !payload.data || typeof payload.data !== 'object') {
    return sendJson(res, 400, { error: 'Falta data o baseVersion.' });
  }

  const row = stmt.docByUser.get(session.userId);
  const currentVersion = row ? row.version : 0;
  if (payload.baseVersion !== currentVersion) {
    let data = null;
    try { data = row ? JSON.parse(row.data) : null; } catch { /* leave null */ }
    return sendJson(res, 409, { data, version: currentVersion });
  }

  stmt.upsertDoc.run(session.userId, JSON.stringify(payload.data), nowIso());
  const updated = stmt.docByUser.get(session.userId);
  sendJson(res, 200, { version: updated.version });
}

/* ============================================================
   Voice assistant (LLM proxy) — auth required
   ============================================================ */
const MAX_VOICE_BODY = 200 * 1024; // 200 KB

/** Strips code fences and pulls out the first balanced {...} object from free-form text. */
function extractJsonObject(text) {
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function systemPrompt() {
  return `You are a scheduling assistant for an Argentine "psicopedagoga" (learning-support therapist). She controls her daily agenda by speaking or typing short Spanish (es-AR) instructions. You receive her instruction as "text" plus a JSON "context": today's date and weekday, the current time, the next 14 days and previous 7 days as "YYYY-MM-DD Weekday" strings, her active and inactive patients (id, name, price, weekly schedule), the computed appointments for the current and next week (patientId, date, time, status, moved, extra), and this month's totals.

Resolve relative dates ("hoy", "mañana", "el jueves", "esta semana", "la semana que viene") strictly against the provided day lists — never invent a date outside them unless she states one explicitly (YYYY-MM-DD or an unambiguous day/month). "Esta semana X viene el jueves en vez del martes" means a reschedule_once whose fromDate is THIS WEEK's Tuesday (look it up in the appointments list for that patient) and toDate is this week's Thursday.

Match patient names fuzzily by first name (accents/diminutives allowed) against the patients list. If the instruction could match more than one active patient, or is otherwise ambiguous, do not guess: return no action for that part and ask for clarification in "reply" (in Spanish).

Numbers spoken in words are Argentine Spanish ("quince mil" = 15000). A bare hour spoken in a scheduling context ("a las cinco", "a las seis") means afternoon/evening (17:00, 18:00) unless she says "de la mañana" or the number is already 13 or higher.

Reply with ONLY one JSON object, no prose, no markdown fences: {"actions": [...], "reply": "..."}. "reply" is always a short, plain Spanish sentence: it answers direct questions (e.g. "¿cuánto llevo este mes?" using monthTotals), asks for clarification when needed, or briefly confirms what you understood. "actions" is a possibly-empty array; every entry is exactly one of:
- {"type":"mark_attendance","patientId":"...","date":"YYYY-MM-DD","status":"present"|"absent"}
- {"type":"reschedule_once","patientId":"...","fromDate":"YYYY-MM-DD","toDate":"YYYY-MM-DD","toTime":"HH:MM"}
- {"type":"cancel_once","patientId":"...","date":"YYYY-MM-DD"}
- {"type":"add_once","patientId":"...","date":"YYYY-MM-DD","time":"HH:MM"}
- {"type":"add_patient","name":"...","price":0,"schedule":[{"day":0,"time":"HH:MM"}]}  (day: 0=Sunday..6=Saturday)
- {"type":"update_patient","patientId":"...","name"?:"...","price"?:0,"schedule"?:[...]}
- {"type":"deactivate_patient","patientId":"..."}
Use exact "id" values from context.patients for patientId; never invent one. add_patient is the only action type without a patientId. If she names several patients at once ("vinieron Joaquín y Tomás"), return one mark_attendance action per patient.`;
}

async function callLlm(text, context) {
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    throw Object.assign(new Error('LLM not configured'), { code: 'NOT_CONFIGURED' });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/json', authorization: `Bearer ${LLM_API_KEY}` },
        LLM_EXTRA_HEADERS,
      ),
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: JSON.stringify({ text, context }) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw Object.assign(new Error(`LLM upstream error ${res.status}`), { code: 'UPSTREAM', status: res.status });
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw Object.assign(new Error('Empty LLM response'), { code: 'EMPTY' });
    const parsed = extractJsonObject(content);
    if (!parsed) throw Object.assign(new Error('Could not parse LLM JSON'), { code: 'PARSE' });
    return {
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      reply: typeof parsed.reply === 'string' ? parsed.reply : '',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleVoice(req, res) {
  const session = getSession(req);
  if (!session) return sendJson(res, 401, { error: 'No autenticado.' });
  if (!voiceLimiter(clientIp(req))) return sendJson(res, 429, { error: 'Demasiadas solicitudes, esperá un minuto.' });
  if (!originOk(req)) return sendJson(res, 403, { error: 'Origen inválido.' });

  const payload = await readJsonBody(req, res, MAX_VOICE_BODY);
  if (payload === undefined) return;

  const text = typeof payload.text === 'string' ? payload.text.slice(0, 2000) : '';
  if (!text.trim()) return sendJson(res, 400, { error: 'Falta el texto.' });

  try {
    const result = await callLlm(text, payload.context && typeof payload.context === 'object' ? payload.context : {});
    sendJson(res, 200, result);
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') {
      return sendJson(res, 503, { error: 'El asistente de voz no está configurado en este servidor.' });
    }
    // Never log the API key or the raw request/response bodies.
    console.error('voice: LLM call failed:', e.code || e.name, e.message);
    sendJson(res, 502, { error: 'El asistente no pudo responder. Probá de nuevo.' });
  }
}

/* ============================================================
   Router
   ============================================================ */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      if (!generalLimiter(clientIp(req))) return sendJson(res, 429, { error: 'Demasiadas solicitudes.' });

      if (req.method === 'POST' && url.pathname === '/api/signup') return void await handleSignup(req, res);
      if (req.method === 'POST' && url.pathname === '/api/login') return void await handleLogin(req, res);
      if (req.method === 'POST' && url.pathname === '/api/logout') return void await handleLogout(req, res);
      if (req.method === 'GET' && url.pathname === '/api/me') return void handleMe(req, res);
      if (req.method === 'GET' && url.pathname === '/api/data') return void handleGetData(req, res);
      if (req.method === 'PUT' && url.pathname === '/api/data') return void await handlePutData(req, res);
      if (req.method === 'POST' && url.pathname === '/api/voice') return void await handleVoice(req, res);

      return sendJson(res, 404, { error: 'No encontrado.' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
      return;
    }
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD, POST, PUT' });
    res.end('Method not allowed');
  } catch (e) {
    console.error('server error:', e.message);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Internal error'); }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`consultorio server listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    console.log('voice assistant: LLM not configured (set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL) — /api/voice will return 503');
  }
  if (INSECURE_COOKIES) {
    console.log('INSECURE_COOKIES=1: session cookie will be sent without Secure over plain HTTP — dev/e2e only');
  }
});
