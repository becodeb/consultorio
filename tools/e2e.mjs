#!/usr/bin/env node
/**
 * End-to-end checks for the Consultorio app: starts server.mjs on an ephemeral port with
 * a temp DATA_DIR and INSECURE_COOKIES=1, drives Chromium via Playwright with a fixed
 * clock, and takes the required 390x844 screenshots into shots/.
 *
 *   NODE_PATH=/tmp/pw/node_modules node tools/e2e.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM doesn't honor NODE_PATH for bare specifiers, so resolve playwright-core explicitly
// from it (falling back to a plain bare import in case it's on the regular resolution path).
const PW_BASE = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter)[0] : null;
const { chromium } = PW_BASE
  ? await import(path.join(PW_BASE, 'playwright-core', 'index.mjs'))
  : await import('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(ROOT, 'shots');
const CHROMIUM_PATH = '/usr/bin/chromium';

/* ---------- date helpers (standalone copies; this script has no DOM/app.js access) --- */
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Monday, so the weekly schedule + the "esta semana" reschedule scenario are unambiguous.
// 14:10 falls inside Martina's 14:00-14:45 session window, so the Ahora card is exercised.
const ANCHOR = new Date(2026, 8, 28, 14, 10, 0);
const ANCHOR_ISO = iso(ANCHOR);

let emailCounter = 0;
function nextEmail(prefix) { return `${prefix}-${Date.now()}-${emailCounter++}@example.com`; }

/* ---------- realistic seed data (7 patients, Mon-Fri afternoons + a couple mornings) --- */
function buildSeed() {
  const since = iso(addDays(ANCHOR, -120));
  const patients = [
    { id: 'p1', name: 'Martina López', price: 15000, schedule: [{ day: 1, time: '14:00' }, { day: 4, time: '14:00' }], active: true, color: '#4C8DF6', since },
    { id: 'p2', name: 'Sofía Díaz', price: 18000, schedule: [{ day: 2, time: '16:00' }], active: true, color: '#E8729A', since },
    { id: 'p3', name: 'Joaquín Pérez', price: 20000, schedule: [{ day: 2, time: '17:00' }], active: true, color: '#F59E3B', since },
    { id: 'p4', name: 'Tomás Fernández', price: 17000, schedule: [{ day: 3, time: '15:00' }, { day: 1, time: '09:30' }], active: true, color: '#3DB39E', since },
    { id: 'p5', name: 'Lucía Gómez', price: 19000, schedule: [{ day: 1, time: '09:00' }, { day: 3, time: '09:30' }], active: true, color: '#9B6BDF', since },
    { id: 'p6', name: 'Valentina Ruiz', price: 22000, schedule: [{ day: 5, time: '18:00' }], active: true, color: '#E5534B', since },
    { id: 'p7', name: 'Bautista Ríos', price: 16000, schedule: [{ day: 4, time: '19:00' }], active: true, color: '#2FA7C9', since },
    // Biweekly: Wednesday 17:00 every other week, anchored to this week's Wednesday (an
    // "on" week) — shows up in this week's Hoy/Semana/Mes, absent the week after.
    { id: 'p8', name: 'Camila Torres', price: 18000, schedule: [{ day: 3, time: '17:00', every: 2, anchor: iso(addDays(ANCHOR, 2)) }], active: true, color: '#8FB33A', since },
  ];

  // Joaquín's usual Tuesday 17:00 is moved to today (Monday) 11:00 — shows the "moved" badge.
  const thisTuesday = addDays(ANCHOR, 1);
  const changes = [
    { id: 'c1', patientId: 'p3', kind: 'move', date: iso(thisTuesday), time: '17:00', toDate: ANCHOR_ISO, toTime: '11:00' },
  ];

  const attendance = [
    { id: 'att1', patientId: 'p5', date: ANCHOR_ISO, time: '09:00', status: 'present', price: 19000 },
    { id: 'att2', patientId: 'p4', date: ANCHOR_ISO, time: '09:30', status: 'absent', price: 0 },
  ];

  // A few past weeks of attendance (same month as the anchor) so Cuentas has real totals.
  for (let w = 1; w <= 3; w++) {
    const monday = addDays(ANCHOR, -7 * w);
    const tuesday = addDays(monday, 1);
    const wednesday = addDays(monday, 2);
    const thursday = addDays(monday, 3);
    const friday = addDays(monday, 4);
    if (monday.getMonth() === ANCHOR.getMonth()) {
      attendance.push({ id: `m${w}a`, patientId: 'p1', date: iso(monday), time: '14:00', status: 'present', price: 15000 });
      attendance.push({ id: `m${w}b`, patientId: 'p5', date: iso(monday), time: '09:00', status: 'present', price: 19000 });
    }
    if (tuesday.getMonth() === ANCHOR.getMonth()) {
      attendance.push({ id: `t${w}a`, patientId: 'p2', date: iso(tuesday), time: '16:00', status: 'present', price: 18000 });
      attendance.push({ id: `t${w}b`, patientId: 'p3', date: iso(tuesday), time: '17:00', status: w === 1 ? 'absent' : 'present', price: w === 1 ? 0 : 20000 });
    }
    if (wednesday.getMonth() === ANCHOR.getMonth()) {
      attendance.push({ id: `w${w}a`, patientId: 'p4', date: iso(wednesday), time: '15:00', status: 'present', price: 17000 });
    }
    if (thursday.getMonth() === ANCHOR.getMonth()) {
      attendance.push({ id: `th${w}a`, patientId: 'p1', date: iso(thursday), time: '14:00', status: 'present', price: 15000 });
      attendance.push({ id: `th${w}b`, patientId: 'p7', date: iso(thursday), time: '19:00', status: 'present', price: 16000 });
    }
    if (friday.getMonth() === ANCHOR.getMonth()) {
      attendance.push({ id: `f${w}a`, patientId: 'p6', date: iso(friday), time: '18:00', status: 'present', price: 22000 });
    }
  }

  // Bautista already paid one of his three past sessions — a partial balance, not just 0 or "owes everything".
  const payments = [
    { id: 'pay1', patientId: 'p7', date: iso(addDays(ANCHOR, -3)), amount: 16000 },
  ];

  return { version: 2, patients, changes, attendance, payments, settings: { sessionMinutes: 45 } };
}

/* ---------- infra: free port, spawn server.mjs, wait for it ---------- */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`server did not come up at ${url} within ${timeoutMs}ms`);
}

/* ---------- tiny test runner ---------- */
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`FAIL  ${name}\n      ${e.stack || e.message}`);
  }
}
function assertTrue(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

/* ---------- page + auth helpers ---------- */
async function freshPage(browser, { dark = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: dark ? 'dark' : 'light',
  });
  const page = await context.newPage();
  await page.clock.install({ time: ANCHOR.getTime() });
  return { context, page };
}

async function signup(page, origin, email, password = 'password123') {
  await page.goto(origin);
  await page.waitForSelector('#auth-view:not([hidden])');
  await page.click('#auth-toggle'); // default mode is "login"; switch to "signup"
  await page.fill('#auth-form [name="email"]', email);
  await page.fill('#auth-form [name="password"]', password);
  await page.click('#auth-form button[type="submit"]');
  await page.waitForSelector('nav.tabs:not([hidden])');
}

async function login(page, origin, email, password = 'password123') {
  await page.goto(origin);
  await page.waitForSelector('#auth-view:not([hidden])');
  await page.fill('#auth-form [name="email"]', email);
  await page.fill('#auth-form [name="password"]', password);
  await page.click('#auth-form button[type="submit"]');
  await page.waitForSelector('nav.tabs:not([hidden])');
}

/** Writes `db` straight to the account's server doc (bypassing the UI) and reloads so the
 *  page's in-memory docVersion catches up with the real server version. */
async function seedServer(page, db) {
  const result = await page.evaluate(async data => {
    const cur = await fetch('/api/data').then(r => r.json());
    const res = await fetch('/api/data', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, baseVersion: cur.version }),
    });
    return { status: res.status, body: await res.json() };
  }, db);
  if (result.status !== 200) throw new Error(`seedServer PUT failed: ${result.status} ${JSON.stringify(result.body)}`);
  await page.reload();
  await page.waitForSelector('nav.tabs:not([hidden])');
}

async function readServerData(page) {
  return page.evaluate(() => fetch('/api/data').then(r => r.json()));
}

async function goToView(page, view) {
  await page.click(`nav.tabs button[data-view="${view}"]`);
  await page.waitForTimeout(180);
}

async function assertClass(locator, cls, msg) {
  const c = await locator.getAttribute('class');
  assertTrue(!!c && c.split(/\s+/).includes(cls), `${msg} (class was "${c}")`);
}

/* ---------- scenarios: accounts + sync (phase 2) ---------- */

/** Covers both "v1 localStorage data loads without loss" (phase 1) and "import of
 *  pre-existing local data on first login" (phase 2) — first login IS the migration path
 *  now, so this one scenario exercises both requirements honestly rather than faking two. */
async function scenarioImportOnFirstLogin(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('import');
    const v1 = {
      patients: [{ id: 'legacy1', name: 'Martina López', price: 15000, schedule: [{ day: ANCHOR.getDay(), time: '14:00' }], active: true }],
      sessions: [{ id: 's1', patientId: 'legacy1', date: iso(addDays(ANCHOR, -14)), price: 15000 }],
    };
    await page.goto(origin);
    await page.evaluate(json => localStorage.setItem('consultorio.v1', json), JSON.stringify(v1));
    await signup(page, origin, email);
    await page.waitForTimeout(700); // let the post-signup import-and-push settle

    await goToView(page, 'pacientes');
    assertTrue(await page.locator('.row .name', { hasText: 'Martina López' }).count() > 0,
      'pre-existing v1 data should be visible right after first login');

    const server = await readServerData(page);
    assertEqual(server.data.version, 2, 'imported db must be v2 on the server');
    assertTrue(server.data.patients.some(p => p.name === 'Martina López'), 'imported patient must reach the server, not just a local cache');
    assertTrue(!!server.data.patients[0].color, 'migrated patient should get a palette color');
    assertEqual(server.data.attendance.length, 1, 'migrated attendance count');
    assertEqual(server.data.attendance[0].status, 'present', 'legacy session becomes present attendance');
  } finally {
    await context.close();
  }
}

async function scenarioAuthPersistence(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('persist');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    // A second page in the SAME browser context shares the session cookie.
    const page2 = await context.newPage();
    await page2.goto(origin);
    await page2.waitForTimeout(400);
    assertTrue(await page2.locator('#auth-view').isHidden(), 'a second page sharing the cookie should already be authenticated');
    await page2.click('nav.tabs button[data-view="pacientes"]');
    await page2.waitForTimeout(180);
    const html = await page2.locator('#app').innerHTML();
    assertTrue(html.includes('Martina López'), 'the second page must load the same server-backed data');
    await page2.close();
  } finally {
    await context.close();
  }
}

async function scenarioSyncReachesServer(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('sync');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());
    const before = await readServerData(page);

    await goToView(page, 'hoy');
    const undoBtn = page.locator('[data-act="undo"]').first();
    if (await undoBtn.count()) await undoBtn.click();
    else await page.locator('[data-act="mark"][data-status="present"]').first().click();
    await page.waitForTimeout(900); // 500ms debounce + margin

    const after = await readServerData(page);
    assertTrue(after.version > before.version, 'a local mutation must reach the server as a new doc version');
  } finally {
    await context.close();
  }
}

async function scenario409Conflict(browser, origin) {
  const email = nextEmail('conflict');
  const { context: ctxA, page: pageA } = await freshPage(browser);
  const { context: ctxB, page: pageB } = await freshPage(browser);
  try {
    await signup(pageA, origin, email);
    await seedServer(pageA, buildSeed());

    await login(pageB, origin, email);
    await pageB.waitForTimeout(300);

    // Device B writes behind device A's back.
    const bumpResult = await pageB.evaluate(async () => {
      const cur = await fetch('/api/data').then(r => r.json());
      cur.data.settings.sessionMinutes = 99;
      const res = await fetch('/api/data', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: cur.data, baseVersion: cur.version }) });
      return res.status;
    });
    assertEqual(bumpResult, 200, 'device B\'s own write should succeed');

    // Device A, still holding the old version, makes its own edit.
    await goToView(pageA, 'pacientes');
    await pageA.evaluate(() => {
      const input = document.getElementById('session-minutes');
      input.value = '30';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pageA.waitForFunction(() => (document.getElementById('toast')?.textContent || '').includes('actualizó'), null, { timeout: 5000 });

    const minutesOnA = await pageA.evaluate(() => Number(document.getElementById('session-minutes').value));
    assertEqual(minutesOnA, 99, "device A must adopt device B's server value after a 409, not keep its own stale edit");
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
}

async function scenarioPayments(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('payments');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    await goToView(page, 'cuentas');
    const debtRow = page.locator('button[data-act="patient-accounts"]').filter({ has: page.locator('.balance-chip.debe') }).first();
    assertTrue(await debtRow.count() > 0, 'the seed should include at least one patient who owes money');
    await debtRow.click();
    await page.waitForSelector('#accounts-sheet[open]');

    const prefilled = await page.locator('#payment-form [name="amount"]').inputValue();
    assertTrue(Number(prefilled) > 0, 'the payment amount should be prefilled with the owed balance');

    await page.fill('#payment-form [name="amount"]', '1');
    await page.click('[data-quick]:has-text("Todo lo que debe")');
    const restored = await page.locator('#payment-form [name="amount"]').inputValue();
    assertEqual(restored, prefilled, '"Todo lo que debe" must restore the full owed amount');

    await page.click('#payment-form button[type="submit"]');
    await page.waitForFunction(() => (document.getElementById('accounts-balance')?.textContent || '').includes('Al día'));
    await page.click('#accounts-close');

    // Hoy: the subtle "Pagó" quick action on an already-present row.
    await goToView(page, 'hoy');
    const payBtn = page.locator('[data-act="quick-pay"]').first();
    assertTrue(await payBtn.count() > 0, 'a present row should offer the Pagó quick action');
    await payBtn.click();
    await page.waitForTimeout(180);
    assertTrue(await page.locator('.paid-tag').count() > 0, 'Pagó must turn into a Pagado tag once recorded');

    // Voice: record_payment with amount:null resolves to "everything owed".
    await page.route('**/api/voice', async route => {
      const body = route.request().postDataJSON();
      const target = body.context.patients.find(p => p.balance > 0) || body.context.patients[0];
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          actions: [{ type: 'record_payment', patientId: target.id, amount: null, date: body.context.today }],
          reply: 'Listo, registré el pago.',
        }),
      });
    });
    await page.click('#mic-fab');
    await page.waitForSelector('#voice-sheet[open]');
    await page.fill('#voice-text-input', 'pagó todo');
    await page.click('#voice-text-form button[type="submit"]');
    await page.waitForFunction(() => (document.querySelector('#voice-chat')?.innerHTML || '').includes('chat-done'));
    const chatHtml = await page.locator('#voice-chat').innerHTML();
    assertTrue(chatHtml.includes('pagó'), 'the record_payment result should be described in the done list');
  } finally {
    await context.close();
  }
}

/* ---------- scenarios: carried over from phase 1, now behind auth ---------- */

async function scenarioAttendanceAndUndo(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('attendance');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    const luciaRow = page.locator('li.row.appt', { hasText: 'Lucía Gómez' });
    await assertClass(luciaRow, 'present', 'Lucía should start present (green)');

    const martinaRow = page.locator('li.row.appt', { hasText: 'Martina López' }).first();
    await martinaRow.locator('[data-act="mark"][data-status="absent"]').click();
    await page.waitForTimeout(180);
    await assertClass(martinaRow, 'absent', 'Martina should turn red after No vino');

    const undoBtn = martinaRow.locator('[data-act="undo"]');
    assertTrue(await undoBtn.count() === 1, 'an explicit Deshacer button must appear once marked');
    await undoBtn.click();
    await page.waitForTimeout(180);
    const cls = await martinaRow.getAttribute('class');
    assertTrue(!cls.includes('present') && !cls.includes('absent'), 'Deshacer must explicitly clear the mark (no silent toggle)');

    const nowCard = page.locator('.now-card');
    assertTrue(await nowCard.count() === 1, 'Ahora card should be showing for Martina at 14:10');
    await nowCard.locator('[data-act="mark"][data-status="present"]').click();
    await page.waitForTimeout(180);
    await assertClass(martinaRow, 'present', 'Martina should turn green after Vino from the Ahora card');
  } finally {
    await context.close();
  }
}

async function scenarioReschedule(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('reschedule');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    const thursday = addDays(ANCHOR, 3);

    await page.click('[data-act="day"][data-step="1"]');
    await page.waitForTimeout(180);
    let sofiaRow = page.locator('li.row.appt', { hasText: 'Sofía Díaz' });
    assertTrue(await sofiaRow.count() === 1, 'Sofía should show on Tuesday before reschedule');
    await sofiaRow.locator('[data-act="reprogramar"]').click();
    await page.waitForSelector('#reschedule[open]');
    await page.click('[data-choice="once"]');
    await page.fill('#reschedule-form [name="toDate"]', iso(thursday));
    await page.selectOption('#reschedule-time-picker .time-picker-hour', '18');
    await page.selectOption('#reschedule-time-picker .time-picker-min', '30');
    await page.click('#reschedule-confirm');
    await page.waitForTimeout(220);

    sofiaRow = page.locator('li.row.appt', { hasText: 'Sofía Díaz' });
    assertTrue(await sofiaRow.count() === 0, 'Sofía must disappear from the original Tuesday');

    await page.click('[data-act="day"][data-step="1"]'); // Tue -> Wed
    await page.click('[data-act="day"][data-step="1"]'); // Wed -> Thu
    await page.waitForTimeout(180);
    const movedRow = page.locator('li.row.appt', { hasText: 'Sofía Díaz' });
    assertTrue(await movedRow.count() === 1, 'Sofía must appear on Thursday after reschedule');
    assertTrue((await movedRow.getAttribute('class')).includes('moved'), 'Thursday row should carry the moved marker');
    assertTrue(await movedRow.locator('.moved-badge').count() === 1, 'Thursday row should show the reprogramado badge');

    await goToView(page, 'semana');
    const weekHtml = await page.locator('.week-grid').innerHTML();
    assertTrue(weekHtml.includes('Sofía') || weekHtml.includes('Sof'), 'Semana should render a block for Sofía');
    assertTrue(await page.locator('.week-block.moved').count() >= 1, 'Semana should render the moved block as dashed');

    await goToView(page, 'mes');
    assertTrue(await page.locator(`.month-cell[data-date="${iso(thursday)}"] .dot`).count() >= 1, 'Mes should show at least one dot on the target Thursday');

    const server = await readServerData(page);
    const sofia = server.data.patients.find(p => p.name === 'Sofía Díaz');
    assertEqual(sofia.schedule.length, 1, 'schedule length unchanged');
    assertEqual(sofia.schedule[0].day, 2, 'schedule weekday unchanged');
    assertEqual(sofia.schedule[0].time, '16:00', 'schedule time unchanged');
    const movedOnly = server.data.changes.filter(c => c.patientId === sofia.id);
    assertEqual(movedOnly.length, 1, 'exactly one change recorded for Sofía');
    assertEqual(movedOnly[0].kind, 'move', 'the change must be a move, not a schedule edit');
  } finally {
    await context.close();
  }
}

async function scenarioCuentasFrozenPrice(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('frozen');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    await goToView(page, 'cuentas');
    const totalBefore = await page.locator('.figure-num').first().innerText();

    await goToView(page, 'pacientes');
    await page.locator('button.row', { hasText: 'Martina López' }).click();
    await page.waitForSelector('dialog#editor[open]');
    await page.fill('#editor-form [name="price"]', '99999');
    await page.click('#editor-form button[type="submit"]');
    await page.waitForTimeout(180);

    await goToView(page, 'cuentas');
    const totalAfter = await page.locator('.figure-num').first().innerText();
    assertEqual(totalAfter, totalBefore, 'Cuentas "Atendido" must not change when a price changes after marking (frozen price)');
  } finally {
    await context.close();
  }
}

async function scenarioVoiceTextFallback(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('voice');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    await page.route('**/api/voice', async route => {
      const body = route.request().postDataJSON();
      const target = body.context.patients.find(p => p.name.startsWith('Sofía'));
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          actions: [{ type: 'mark_attendance', patientId: target.id, date: body.context.today, status: 'present' }],
          reply: 'Listo, marqué a Sofía como presente hoy.',
        }),
      });
    });

    await page.click('#mic-fab');
    await page.waitForSelector('#voice-sheet[open]');
    await page.fill('#voice-text-input', 'hoy vino Sofía');
    await page.click('#voice-text-form button[type="submit"]');
    await page.waitForFunction(() => (document.querySelector('#voice-chat')?.innerHTML || '').includes('chat-done'));

    const chatHtml = await page.locator('#voice-chat').innerHTML();
    assertTrue(chatHtml.includes('chat-done'), 'a valid action should be listed as done');
    assertTrue(await page.locator('#voice-undo').count() === 1, 'Deshacer must be offered after applying a voice action');

    await page.waitForTimeout(700); // save()'s own debounce before the PUT reaches the server
    const afterApply = await readServerData(page);
    assertTrue(afterApply.data.attendance.some(a => a.status === 'present' && a.date === ANCHOR_ISO &&
      afterApply.data.patients.find(p => p.id === a.patientId)?.name === 'Sofía Díaz'),
      'the voice action must actually be applied and synced to the server');

    await page.click('#voice-undo');
    await page.waitForFunction(() => (document.getElementById('toast')?.textContent || '').includes('Deshecho'));
    await page.waitForTimeout(700); // undo's own save() debounce, so the server reflects it too
    const afterUndo = await readServerData(page);
    const stillPresentToday = afterUndo.data.attendance.some(a => a.date === ANCHOR_ISO && a.status === 'present' &&
      afterUndo.data.patients.find(p => p.id === a.patientId)?.name === 'Sofía Díaz');
    assertTrue(!stillPresentToday, 'Deshacer must restore the pre-batch snapshot, synced back to the server too');
  } finally {
    await context.close();
  }
}

/* ---------- scenarios: phase 3 (voice memory, biweekly slots, 24h picker) ---------- */

async function scenarioVoiceMemory(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('memory');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    const capturedHistories = [];
    let call = 0;
    await page.route('**/api/voice', async route => {
      call++;
      capturedHistories.push(route.request().postDataJSON().history);
      if (call === 1) {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ actions: [], reply: '¿Cómo se llama y qué horario tiene?' }),
        });
      } else {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            actions: [{ type: 'add_patient', name: 'Nueva Paciente', price: 15000, schedule: [{ day: 1, time: '17:00' }] }],
            reply: 'Listo, la agregué.',
          }),
        });
      }
    });

    await page.click('#mic-fab');
    await page.waitForSelector('#voice-sheet[open]');
    await page.fill('#voice-text-input', 'creame un nuevo paciente');
    await page.click('#voice-text-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length >= 2);
    assertEqual(capturedHistories[0].length, 0, 'the first request must carry no history');

    await page.fill('#voice-text-input', 'Nueva Paciente, quince mil, lunes a las cinco');
    await page.click('#voice-text-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length >= 4);
    assertEqual(capturedHistories[1].length, 2, 'the second request must carry the first exchange as history');
    assertEqual(capturedHistories[1][0].text, 'creame un nuevo paciente', 'history[0] must be the first user turn verbatim');
    assertEqual(capturedHistories[1][1].reply, '¿Cómo se llama y qué horario tiene?', 'history[1] must be the assistant reply verbatim');
    assertEqual(await page.locator('.chat-bubble').count(), 4, '4 chat bubbles should render after 2 exchanges');

    await page.click('#voice-new-chat');
    assertEqual(await page.locator('.chat-bubble').count(), 0, 'Nueva conversación must clear the visible chat log');
    await page.fill('#voice-text-input', 'otra cosa');
    await page.click('#voice-text-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length >= 2);
    assertEqual(capturedHistories[2].length, 0, 'history must be empty again after Nueva conversación');
  } finally {
    await context.close();
  }
}

async function scenarioBiweekly(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('biweekly');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    // Camila (Wed 17:00, every 2, anchored to this week's Wednesday) is on an "on" week now.
    await page.click('[data-act="day"][data-step="1"]'); // Mon -> Tue
    await page.click('[data-act="day"][data-step="1"]'); // Tue -> Wed (on)
    await page.waitForTimeout(180);
    assertEqual(await page.locator('li.row.appt', { hasText: 'Camila Torres' }).count(), 1,
      'biweekly patient must appear on her anchor Wednesday');

    for (let i = 0; i < 7; i++) await page.click('[data-act="day"][data-step="1"]'); // next Wed (off)
    await page.waitForTimeout(180);
    assertEqual(await page.locator('li.row.appt', { hasText: 'Camila Torres' }).count(), 0,
      'biweekly patient must NOT appear on the off week');

    for (let i = 0; i < 7; i++) await page.click('[data-act="day"][data-step="1"]'); // Wed after that (on again)
    await page.waitForTimeout(180);
    assertEqual(await page.locator('li.row.appt', { hasText: 'Camila Torres' }).count(), 1,
      'biweekly patient must appear again 2 weeks after the off week (both sides of the anchor honored)');

    await goToView(page, 'semana');
    assertEqual(await page.locator('.week-block', { hasText: 'Camila' }).count(), 1,
      'Semana should render exactly one block for the biweekly patient on her on-week');

    await goToView(page, 'mes');
    const onIso = iso(addDays(ANCHOR, 2));
    assertTrue(await page.locator(`.month-cell[data-date="${onIso}"] .dot`).count() >= 1,
      'Mes should show a dot on the anchor Wednesday');

    // Editor round-trip: reopen, confirm the frequency/anchor UI reflects the stored slot,
    // save unchanged, and confirm every/anchor survive on the server.
    await goToView(page, 'pacientes');
    await page.locator('button.row', { hasText: 'Camila Torres' }).click();
    await page.waitForSelector('dialog#editor[open]');
    await page.waitForTimeout(100);
    assertTrue(await page.locator('.seg-btn[data-every="2"]').evaluate(el => el.classList.contains('active')),
      'reopened biweekly slot should show "Cada 2 semanas" as the active frequency');
    assertTrue(!(await page.locator('.slot-anchor').first().isHidden()),
      'reopened biweekly slot should show the "Próxima vez" anchor picker');
    await page.click('#editor-form button[type="submit"]');
    await page.waitForTimeout(700); // save()'s own debounce before the PUT reaches the server

    const server = await readServerData(page);
    const camila = server.data.patients.find(p => p.name === 'Camila Torres');
    assertEqual(camila.schedule[0].every, 2, 'every must survive an untouched editor round-trip');
    assertTrue(ISO_DATE_RE.test(camila.schedule[0].anchor || ''), 'anchor must still be a valid date after round-trip');
  } finally {
    await context.close();
  }
}

async function scenarioTimePicker(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const email = nextEmail('timepicker');
    await signup(page, origin, email);
    await seedServer(page, buildSeed());

    await goToView(page, 'pacientes');
    await page.click('[data-act="new"]');
    await page.waitForSelector('dialog#editor[open]');
    assertEqual(await page.locator('dialog#editor input[type="time"]').count(), 0,
      'the patient editor must not contain a native (locale-dependent) time input');
    await page.fill('#editor-form [name="patientName"]', 'Horario Test');
    await page.fill('#editor-form [name="price"]', '15000');
    await page.selectOption('.slot-time .time-picker-hour', '16');
    await page.selectOption('.slot-time .time-picker-min', '00');
    await page.click('#editor-form button[type="submit"]');
    await page.waitForTimeout(700); // save()'s own debounce before the PUT reaches the server
    let server = await readServerData(page);
    let p = server.data.patients.find(x => x.name === 'Horario Test');
    assertTrue(!!p, 'the new patient must have been saved');
    assertEqual(p.schedule[0].time, '16:00', 'the editor picker must save exactly "16:00"');

    await goToView(page, 'hoy');
    const martinaRow = page.locator('li.row.appt', { hasText: 'Martina López' }).first();
    await martinaRow.locator('[data-act="reprogramar"]').click();
    await page.waitForSelector('#reschedule[open]');
    await page.click('[data-choice="once"]');
    await page.waitForTimeout(100);
    assertEqual(await page.locator('dialog#reschedule input[type="time"]').count(), 0,
      'the reschedule sheet must not contain a native time input');
    await page.selectOption('#reschedule-time-picker .time-picker-hour', '16');
    await page.selectOption('#reschedule-time-picker .time-picker-min', '00');
    await page.click('#reschedule-confirm');
    await page.waitForTimeout(700); // save()'s own debounce before the PUT reaches the server

    server = await readServerData(page);
    const move = server.data.changes.find(c => c.kind === 'move' && c.patientId === 'p1');
    assertTrue(!!move, 'a move change must have been recorded');
    assertEqual(move.toTime, '16:00', 'the reschedule picker must save exactly "16:00"');
  } finally {
    await context.close();
  }
}

/* ---------- screenshots ---------- */
async function takeScreenshots(browser, origin) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  {
    const { context, page } = await freshPage(browser);
    try {
      await page.goto(origin);
      await page.waitForSelector('#auth-view:not([hidden])');
      await page.screenshot({ path: path.join(SHOTS_DIR, 'login.png') });
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage(browser);
    try {
      const email = nextEmail('shots');
      await signup(page, origin, email);
      await seedServer(page, buildSeed());
      await page.screenshot({ path: path.join(SHOTS_DIR, 'hoy.png') });

      await goToView(page, 'semana');
      await page.screenshot({ path: path.join(SHOTS_DIR, 'semana.png') });

      await goToView(page, 'mes');
      await page.screenshot({ path: path.join(SHOTS_DIR, 'mes.png') });

      await goToView(page, 'cuentas');
      await page.screenshot({ path: path.join(SHOTS_DIR, 'cuentas.png') });

      const debtRow = page.locator('button[data-act="patient-accounts"]').filter({ has: page.locator('.balance-chip.debe') }).first();
      await (await debtRow.count() ? debtRow : page.locator('button[data-act="patient-accounts"]').first()).click();
      await page.waitForSelector('#accounts-sheet[open]');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'cuentas-paciente.png') });
      await page.click('#accounts-close');

      // voz.png: a real 2-turn conversation (pending question, then its answer) rendered
      // as the compact chat, so the memory feature is visible in the screenshot itself.
      let voiceCall = 0;
      await page.route('**/api/voice', async route => {
        voiceCall++;
        if (voiceCall === 1) {
          await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ actions: [], reply: '¿Cómo se llama la paciente y qué horario tiene?' }),
          });
        } else {
          await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
              actions: [{ type: 'add_patient', name: 'Lucía Torres', price: 15000, schedule: [{ day: 1, time: '17:00' }] }],
              reply: 'Listo, agregué a Lucía Torres.',
            }),
          });
        }
      });
      await page.click('#mic-fab');
      await page.waitForSelector('#voice-sheet[open]');
      await page.fill('#voice-text-input', 'creame un nuevo paciente');
      await page.click('#voice-text-form button[type="submit"]');
      await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length >= 2);
      await page.fill('#voice-text-input', 'Lucía Torres, quince mil, lunes a las cinco');
      await page.click('#voice-text-form button[type="submit"]');
      await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length >= 4);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'voz.png') });
      await page.click('#voice-close');

      // pacientes-editor.png: a biweekly slot with the 24h picker, mid-edit.
      await goToView(page, 'pacientes');
      await page.locator('button.row', { hasText: 'Camila Torres' }).click();
      await page.waitForSelector('dialog#editor[open]');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'pacientes-editor.png') });
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await freshPage(browser, { dark: true });
    try {
      const email = nextEmail('shotsdark');
      await signup(page, origin, email);
      await seedServer(page, buildSeed());
      await page.screenshot({ path: path.join(SHOTS_DIR, 'hoy-dark.png') });
    } finally {
      await context.close();
    }
  }
}

/* ---------- node --check on the plain-JS files ---------- */
function checkSyntax() {
  const files = ['app.js', 'server.mjs', 'tools/e2e.mjs'];
  for (const f of files) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    console.log(`PASS  node --check ${f}`);
  }
}

/* ---------- main ---------- */
async function main() {
  checkSyntax();

  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consultorio-e2e-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, INSECURE_COOKIES: '1', AUTH_RATE_LIMIT: '100' };
  const origin = `http://127.0.0.1:${port}`;

  const serverProc = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', d => console.error('[server]', d.toString().trim()));
  serverProc.on('exit', code => { if (code !== null && code !== 0) console.error(`server.mjs exited with code ${code}`); });

  let browser;
  try {
    await waitForServer(`${origin}/`);
    browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox', '--disable-gpu'] });

    // Accounts + sync (phase 2)
    await check('v1 data imports on first login and migrates to v2 on the server', () => scenarioImportOnFirstLogin(browser, origin));
    await check('session cookie keeps a second page logged in with the same server data', () => scenarioAuthPersistence(browser, origin));
    await check('a local mutation reaches the server as a new doc version', () => scenarioSyncReachesServer(browser, origin));
    await check('a stale write gets 409 and adopts the other device\'s server data', () => scenario409Conflict(browser, origin));
    await check('payments: balance math, "Todo lo que debe", Pagó quick action, voice record_payment', () => scenarioPayments(browser, origin));

    // Carried over from phase 1
    await check('Hoy: explicit Vino/No vino + Deshacer, no silent toggle', () => scenarioAttendanceAndUndo(browser, origin));
    await check('reschedule_once via sheet moves the occurrence, schedule unchanged', () => scenarioReschedule(browser, origin));
    await check('Cuentas sums only present sessions at frozen price', () => scenarioCuentasFrozenPrice(browser, origin));
    await check('voice sheet text fallback applies actions + Deshacer restores (synced)', () => scenarioVoiceTextFallback(browser, origin));

    // Phase 3: voice memory, biweekly slots, 24h time picker
    await check('voice history: 2nd request carries the 1st turn, chat renders both, Nueva conversación clears it', () => scenarioVoiceMemory(browser, origin));
    await check('biweekly slot: on/off weeks in Hoy/Semana/Mes, editor round-trip keeps every/anchor', () => scenarioBiweekly(browser, origin));
    await check('24h time picker: no native input[type=time], selecting 16:00 saves "16:00"', () => scenarioTimePicker(browser, origin));

    console.log('\nTaking screenshots...');
    await takeScreenshots(browser, origin);
    console.log(`Screenshots written to ${SHOTS_DIR}`);
  } finally {
    if (browser) await browser.close();
    serverProc.kill();
    await Promise.race([once(serverProc, 'exit'), new Promise(r => setTimeout(r, 2000))]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('e2e run crashed:', e);
  process.exitCode = 1;
});
