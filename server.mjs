#!/usr/bin/env node
/**
 * Static file server + /api/voice proxy for the Consultorio app. Node built-ins only,
 * no npm dependencies.
 *
 *   LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=... LLM_MODEL=deepseek-chat \
 *     node server.mjs
 *
 * Env vars: PORT (default 8811), HOST (default 0.0.0.0), LLM_BASE_URL, LLM_API_KEY,
 * LLM_MODEL, optional LLM_EXTRA_HEADERS (JSON object merged into the LLM request headers).
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;

const PORT = Number(process.env.PORT) || 8811;
const HOST = process.env.HOST || '0.0.0.0';
const LLM_BASE_URL = process.env.LLM_BASE_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || '';
let LLM_EXTRA_HEADERS = {};
try {
  if (process.env.LLM_EXTRA_HEADERS) LLM_EXTRA_HEADERS = JSON.parse(process.env.LLM_EXTRA_HEADERS);
} catch {
  console.error('LLM_EXTRA_HEADERS is not valid JSON, ignoring it');
}

const MAX_BODY = 200 * 1024; // 200 KB
const RATE_LIMIT_PER_MIN = 30;
const rateMap = new Map(); // ip -> timestamps[]

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

const BLOCKED_SEGMENTS = new Set(['.git', 'odd', 'node_modules', 'shots']);
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
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (rateMap.get(ip) || []).filter(t => t > windowStart);
  arr.push(now);
  rateMap.set(ip, arr);
  return arr.length <= RATE_LIMIT_PER_MIN;
}

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
  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Demasiadas solicitudes, esperá un minuto.' }));
    return;
  }

  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch {
    res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Solicitud demasiado grande.' }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf-8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'JSON inválido.' }));
    return;
  }

  const text = typeof payload.text === 'string' ? payload.text.slice(0, 2000) : '';
  if (!text.trim()) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Falta el texto.' }));
    return;
  }

  try {
    const result = await callLlm(text, payload.context && typeof payload.context === 'object' ? payload.context : {});
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'El asistente de voz no está configurado en este servidor.' }));
      return;
    }
    // Never log the API key or the raw request/response bodies.
    console.error('voice: LLM call failed:', e.code || e.name, e.message);
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'El asistente no pudo responder. Probá de nuevo.' }));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST' && url.pathname === '/api/voice') {
      await handleVoice(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
      return;
    }
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD, POST' });
    res.end('Method not allowed');
  } catch (e) {
    console.error('server error:', e.message);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Internal error'); }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`consultorio server listening on http://${HOST}:${PORT}`);
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    console.log('voice assistant: LLM not configured (set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL) — /api/voice will return 503');
  }
});
