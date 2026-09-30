#!/usr/bin/env node
/**
 * Static file server + auth + per-account storage + /api/voice proxy for the
 * Consultorio app. Node built-ins only, no npm dependencies.
 *
 *   DATA_DIR=./data node server.mjs
 *
 * Env vars: PORT (default 8811), HOST (default 0.0.0.0), DATA_DIR (default ./data),
 * INSECURE_COOKIES (set to "1" to allow a non-Secure session cookie over plain HTTP,
 * for local dev / e2e only — see the cookie section below), AI_ROUTER_URL (default
 * https://ai-router.becode.com.ar), optional AI_ROUTER_MODEL (pin a model instead of the
 * free-provider cascade) and AI_ROUTER_TOKEN (only sent, as a bearer token, when set —
 * required for a paid pinned model such as deepseek-chat).
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
const AI_ROUTER_URL = process.env.AI_ROUTER_URL || 'https://ai-router.becode.com.ar';
const AI_ROUTER_MODEL = process.env.AI_ROUTER_MODEL || '';
const AI_ROUTER_TOKEN = process.env.AI_ROUTER_TOKEN || '';

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
// Kept strict in production; the e2e suite raises it via env for its own signups.
const authLimiter = makeLimiter(Number(process.env.AUTH_RATE_LIMIT) || 10, 60_000);
const generalLimiter = makeLimiter(300, 60_000);

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
  return `You are a scheduling and billing assistant for an Argentine "psicopedagoga" (learning-support therapist). She controls her daily agenda by speaking or typing short Spanish (es-AR) instructions. You receive her instruction as "text" plus a JSON "context": today's date and weekday, the current time, the next 14 days and previous 7 days as "YYYY-MM-DD Weekday" strings, her active and inactive patients (id, name, current price, priceHistory — every {"from","amount"} entry ever set, oldest first, current weekly schedule, scheduledSchedule — any future {"from","slots"} entries already scheduled, balance — positive means the patient owes that amount, negative means they have a credit), the computed appointments for the current and next week (patientId, date, time, status, moved, extra), and this month's totals.

Resolve relative dates ("hoy", "mañana", "el jueves", "esta semana", "la semana que viene") strictly against the provided day lists — never invent a date outside them unless she states one explicitly (YYYY-MM-DD or an unambiguous day/month). "Esta semana X viene el jueves en vez del martes" means a reschedule_once whose fromDate is THIS WEEK's Tuesday (look it up in the appointments list for that patient) and toDate is this week's Thursday.

Match patient names fuzzily by first name (accents/diminutives allowed) against the patients list. If the instruction could match more than one active patient, or is otherwise ambiguous, do not guess: return no action for that part and ask for clarification in "reply" (in Spanish).

Numbers spoken in words are Argentine Spanish ("quince mil" = 15000). A bare hour spoken in a scheduling context ("a las cinco", "a las seis") means afternoon/evening (17:00, 18:00) unless she says "de la mañana" or the number is already 13 or higher. All times, everywhere (actions and "reply" alike), are 24-hour: "16:00" or "16 hs" — never "4 PM"/"4:00 PM"/"4 de la tarde" in a reply.

Reply with ONLY one JSON object, no prose, no markdown fences: {"actions": [...], "reply": "..."}. "reply" is always a short, plain Spanish sentence: it answers direct questions (e.g. "¿cuánto llevo este mes?" using monthTotals, "¿cuánto me debe X?"/"¿quién me debe?" using each patient's balance), asks for clarification when needed, or briefly confirms what you understood. "actions" is a possibly-empty array; every entry is exactly one of:
- {"type":"mark_attendance","patientId":"...","date":"YYYY-MM-DD","status":"present"|"absent"}
- {"type":"reschedule_once","patientId":"...","fromDate":"YYYY-MM-DD","toDate":"YYYY-MM-DD","toTime":"HH:MM"}
- {"type":"cancel_once","patientId":"...","date":"YYYY-MM-DD"}
- {"type":"add_once","patientId":"...","date":"YYYY-MM-DD","time":"HH:MM"}
- {"type":"add_patient","name":"...","price":0,"schedule":[{"day":0,"time":"HH:MM","every"?:1|2,"anchor"?:"YYYY-MM-DD"}]}  (day: 0=Sunday..6=Saturday)
- {"type":"update_patient","patientId":"...","name"?:"...","price"?:0,"schedule"?:[...]}  (price/schedule here always mean "starting today, right now" — use schedule_change/price_change instead for anything starting on a specific future date)
- {"type":"schedule_change","patientId":"...","from":"YYYY-MM-DD","schedule":[{"day":0,"time":"HH:MM","every"?:1|2,"anchor"?:"YYYY-MM-DD"}]}  (the patient's full new weekly schedule, effective from "from" onward; everything before "from" keeps showing the old schedule)
- {"type":"price_change","patientId":"...","from":"YYYY-MM-DD","amount":0}  (the new price, effective from "from" onward; a session marked before "from" still freezes the old price)
- {"type":"deactivate_patient","patientId":"..."}
- {"type":"record_payment","patientId":"...","amount":number|null,"date":"YYYY-MM-DD"}  (amount null means "everything owed"; use null when she does not name a number and does not clearly mean a single session's price, e.g. "Martina me pagó" or "Sofía me pagó el mes" both mean null — the client resolves it to the current balance. "Joaquín pagó lo de hoy" means the price of today's session, a specific number, not null. Only propose record_payment when the balance context or her words make it unambiguous that a payment happened; a question like "¿cuánto me debe X?" is answered in "reply", never as a record_payment action.)
Use exact "id" values from context.patients for patientId; never invent one. add_patient is the only action type without a patientId. If she names several patients at once ("vinieron Joaquín y Tomás"), return one mark_attendance action per patient.

A schedule or price change always takes a "from" date resolved the same way as any other date ("a partir del 1 de noviembre", "desde el mes que viene", "desde el lunes"). "Martina L.: desde el 1/11 viene Jue 17:00" and "Martina L.: $20.000 desde el 1/11" are the kind of plain confirmation to give back in "reply" once you have both the date and the new value. If she asks for a bulk change across everyone ("desde noviembre todos los precios suben un 10%", "a todos les subo 2000 desde el lunes"), return one price_change per active patient, each computed from THAT patient's own current price (not a single shared number), rounded to the nearest $500, and say in "reply" that amounts were rounded to the nearest $500. A plain price/schedule question about the past or the history itself ("¿cuánto le cobraba a Martina en agosto?", "¿cuándo le aumenté a Tomás?", "¿qué horario tenía antes Joaquín?") is answered from priceHistory/scheduledSchedule in "reply" — never as an action.

A schedule slot is weekly by default; "every":2 makes it biweekly (every two weeks), and then "anchor" is REQUIRED: a concrete "YYYY-MM-DD" date (resolved against the day lists, same rules as any other date) of one week where she DOES come — "empieza este lunes" / "la próxima es el jueves que viene" both give you that anchor date directly. Omit "every"/"anchor" entirely for an ordinary weekly slot. Examples: "Lucía viene cada dos semanas los lunes a las 16, empieza este lunes" → schedule [{"day":1,"time":"16:00","every":2,"anchor":"<this Monday's date>"}]. "Tomás pasa a venir cada 15 días, la próxima es el jueves que viene" → update_patient with schedule [{"day":4,"time":"<his existing Thursday time>","every":2,"anchor":"<next Thursday's date>"}].

You may also receive prior turns of this same conversation as extra messages before the current one: a real "user" message for what she said, and an "assistant" message whose content is JSON {"reply":"...","done":[...]} — "done" is a plain-language list of what was already applied (or "No hecho: <reason>" for something that was not). Never propose an action that duplicates one already listed in a prior "done". If the most recent assistant turn's "reply" asked her for missing information to complete an action (e.g. add_patient needs a name/price/schedule, reschedule_once needs a day/time, record_payment needs an amount, schedule_change/price_change needs a "from" date and/or the new value), and her current message reads like an answer to exactly that question (e.g. just a name, price and schedule; just a day and time; just a number; just a date), complete that same pending action now using the new information — do not ask again or start over. If her current message clearly starts something unrelated instead, treat it as a fresh request and ignore the pending question.`;
}

/**
 * Validates and caps client-sent conversation history before it reaches the model: at
 * most 8 turns, each field length-capped, and a combined character budget so one request
 * can't smuggle an oversized prompt through many small fields.
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const CHAR_BUDGET = 4000;
  const out = [];
  let total = 0;
  for (const turn of history.slice(-8)) {
    if (!turn || typeof turn !== 'object') continue;
    if (turn.role === 'user' && typeof turn.text === 'string') {
      const text = turn.text.slice(0, 1000);
      if (total + text.length > CHAR_BUDGET) break;
      total += text.length;
      out.push({ role: 'user', text });
    } else if (turn.role === 'assistant' && typeof turn.reply === 'string') {
      const reply = turn.reply.slice(0, 1000);
      const done = Array.isArray(turn.done)
        ? turn.done.filter(d => typeof d === 'string').slice(0, 10).map(d => d.slice(0, 200))
        : [];
      const size = reply.length + done.reduce((n, d) => n + d.length, 0);
      if (total + size > CHAR_BUDGET) break;
      total += size;
      out.push({ role: 'assistant', reply, done });
    }
  }
  return out;
}

/**
 * Extracts the raw token text from an ai-router SSE body. Events look like
 * "data: token1\n\ndata: token2\n\ndata: [DONE]\n\n" — split on the blank-line-plus-prefix
 * (not on blank lines alone, since a token can itself contain one), strip the "data: "
 * prefix only where the split left it (the very first chunk), and never trim a token:
 * a token that starts with a space arrives as "data: " (with the space already part of
 * the prefix) followed by the token's own leading space, so byte-position stripping
 * (exactly 6 chars) is required, not a trim.
 */
function parseAiRouterSse(rawText) {
  const parts = String(rawText).split('\n\ndata: ');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (i === 0 && part.startsWith('data: ')) part = part.slice(6);
    if (part.trimEnd() === '[DONE]') break;
    out += part;
  }
  return out;
}

/** One POST /chat call. Throws on total failure (the router already cascaded every free
 *  provider, so this is not retried) — never on a merely unparsable JSON reply. */
async function fetchAiRouterOnce(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const body = { messages };
    if (AI_ROUTER_MODEL) body.model = AI_ROUTER_MODEL;
    const headers = { 'content-type': 'application/json' };
    if (AI_ROUTER_TOKEN) headers.authorization = `Bearer ${AI_ROUTER_TOKEN}`;
    const res = await fetch(`${AI_ROUTER_URL.replace(/\/+$/, '')}/chat`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      // Total failure: the router answers 502 JSON, but behind Cloudflare a 502 body is
      // replaced by Cloudflare's own plain-text error page (content-type: text/plain).
      let message = `ai-router upstream error ${res.status}`;
      if (contentType.includes('application/json')) {
        try { const errBody = await res.json(); if (errBody && errBody.error) message = errBody.error; } catch { /* fall through */ }
      } else {
        try { message = (await res.text()).slice(0, 300) || message; } catch { /* fall through */ }
      }
      throw Object.assign(new Error(message), { code: 'UPSTREAM', status: res.status });
    }
    return parseAiRouterSse(await res.text());
  } finally {
    clearTimeout(timeout);
  }
}

async function callLlm(text, context, history = []) {
  if (!AI_ROUTER_URL) throw Object.assign(new Error('ai-router not configured'), { code: 'NOT_CONFIGURED' });

  const messages = [{ role: 'system', content: systemPrompt() }];
  for (const turn of history) {
    if (turn.role === 'user') messages.push({ role: 'user', content: turn.text });
    else messages.push({ role: 'assistant', content: JSON.stringify({ reply: turn.reply, done: turn.done }) });
  }
  messages.push({ role: 'user', content: JSON.stringify({ text, context }) });

  // max_tokens / response_format are ignored by the router, so neither is sent. The model
  // sometimes wraps its JSON in prose or ```json fences; extractJsonObject is tolerant of
  // that, and one corrective retry (not a transport retry — the router already cascaded
  // every free provider for us) covers the rest.
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await fetchAiRouterOnce(attempt === 0 ? messages : [
      ...messages,
      { role: 'assistant', content: lastRaw },
      { role: 'user', content: 'Eso no era JSON válido. Respondé ÚNICAMENTE con el objeto JSON {"actions":[...],"reply":"..."}, sin texto ni cercas de código.' },
    ]);
    lastRaw = raw;
    const parsed = extractJsonObject(raw);
    if (parsed) {
      return {
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        reply: typeof parsed.reply === 'string' ? parsed.reply : '',
      };
    }
  }
  throw Object.assign(new Error('Could not parse ai-router JSON after retry'), { code: 'PARSE' });
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
    const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
    const history = sanitizeHistory(payload.history);
    const result = await callLlm(text, context, history);
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
      // Unrated and unauthenticated: an orchestrator's healthcheck should never be
      // throttled or blocked by the same limits that protect the real endpoints.
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { status: 'ok' });

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
  console.log(`voice assistant: ai-router at ${AI_ROUTER_URL}${AI_ROUTER_MODEL ? ` (pinned model: ${AI_ROUTER_MODEL})` : ' (free-provider cascade)'}`);
  if (INSECURE_COOKIES) {
    console.log('INSECURE_COOKIES=1: session cookie will be sent without Secure over plain HTTP — dev/e2e only');
  }
});
