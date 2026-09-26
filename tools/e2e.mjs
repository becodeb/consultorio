#!/usr/bin/env node
/**
 * End-to-end checks for the Consultorio app: starts server.mjs on an ephemeral port
 * (with the LLM env unset), drives Chromium via Playwright with a fixed clock, and
 * takes the required 390x844 screenshots into shots/.
 *
 *   NODE_PATH=/tmp/pw/node_modules node tools/e2e.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
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

// Monday, so the weekly schedule + the "esta semana" reschedule scenario are unambiguous.
// 14:10 falls inside Martina's 14:00-14:45 session window, so the Ahora card is exercised.
const ANCHOR = new Date(2026, 8, 28, 14, 10, 0);
const ANCHOR_ISO = iso(ANCHOR);

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

  return { version: 2, patients, changes, attendance, settings: { sessionMinutes: 45 } };
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

/* ---------- page helpers ---------- */
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

async function seed(page, origin, db) {
  await page.goto(origin);
  await page.evaluate(json => localStorage.setItem('consultorio.v1', json), JSON.stringify(db));
  await page.reload();
  await page.waitForSelector('nav.tabs');
}

async function readDb(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('consultorio.v1')));
}

async function goToView(page, view) {
  await page.click(`nav.tabs button[data-view="${view}"]`);
  await page.waitForTimeout(180);
}

/* ---------- scenarios ---------- */
async function scenarioMigration(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const v1 = {
      patients: [
        { id: 'legacy1', name: 'Martina López', price: 15000, schedule: [{ day: ANCHOR.getDay(), time: '14:00' }], active: true },
      ],
      sessions: [
        { id: 's1', patientId: 'legacy1', date: iso(addDays(ANCHOR, -14)), price: 15000 },
      ],
    };
    await page.goto(origin);
    await page.evaluate(json => localStorage.setItem('consultorio.v1', json), JSON.stringify(v1));
    await page.reload();
    await page.waitForSelector('nav.tabs');

    const migrated = await readDb(page);
    assertEqual(migrated.version, 2, 'migrated db should be version 2');
    assertEqual(migrated.patients.length, 1, 'migrated patient count');
    assertTrue(!!migrated.patients[0].color, 'migrated patient should get a palette color');
    assertTrue(!!migrated.patients[0].since, 'migrated patient should get a since date');
    assertEqual(migrated.attendance.length, 1, 'migrated attendance count');
    assertEqual(migrated.attendance[0].status, 'present', 'legacy session becomes present attendance');

    await goToView(page, 'pacientes');
    const nameVisible = await page.locator('.row .name', { hasText: 'Martina López' }).count();
    assertTrue(nameVisible > 0, 'migrated patient should be visible in Pacientes');
  } finally {
    await context.close();
  }
}

async function scenarioAttendanceAndUndo(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    await seed(page, origin, buildSeed());

    // Lucía (09:00) is already present -> should render green.
    const luciaRow = page.locator('li.row.appt', { hasText: 'Lucía Gómez' });
    await assertClass(luciaRow, 'present', 'Lucía should start present (green)');

    // Mark Martina (14:00, the Ahora card) as "No vino" from her row, then undo explicitly.
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

    // Now mark her present via the big Ahora-card buttons.
    const nowCard = page.locator('.now-card');
    assertTrue(await nowCard.count() === 1, 'Ahora card should be showing for Martina at 14:10');
    await nowCard.locator('[data-act="mark"][data-status="present"]').click();
    await page.waitForTimeout(180);
    await assertClass(martinaRow, 'present', 'Martina should turn green after Vino from the Ahora card');
  } finally {
    await context.close();
  }
}

async function assertClass(locator, cls, msg) {
  const c = await locator.getAttribute('class');
  assertTrue(!!c && c.split(/\s+/).includes(cls), `${msg} (class was "${c}")`);
}

async function scenarioReschedule(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    await seed(page, origin, buildSeed());

    const tuesday = addDays(ANCHOR, 1);
    const thursday = addDays(ANCHOR, 3);
    const nextTuesday = addDays(ANCHOR, 8);

    // Go to Tuesday (Sofía's normal 16:00) and reschedule her to Thursday 18:30, once.
    await page.click('[data-act="day"][data-step="1"]');
    await page.waitForTimeout(180);
    let sofiaRow = page.locator('li.row.appt', { hasText: 'Sofía Díaz' });
    assertTrue(await sofiaRow.count() === 1, 'Sofía should show on Tuesday before reschedule');
    await sofiaRow.locator('[data-act="reprogramar"]').click();
    await page.waitForSelector('#reschedule[open]');
    await page.click('[data-choice="once"]');
    await page.fill('#reschedule-form [name="toDate"]', iso(thursday));
    await page.fill('#reschedule-form [name="toTime"]', '18:30');
    await page.click('#reschedule-confirm');
    await page.waitForTimeout(220);

    // Gone from Tuesday.
    sofiaRow = page.locator('li.row.appt', { hasText: 'Sofía Díaz' });
    assertTrue(await sofiaRow.count() === 0, 'Sofía must disappear from the original Tuesday');

    // Present on Thursday with the moved badge, in Hoy.
    await page.click('[data-act="day"][data-step="1"]'); // Tue -> Wed
    await page.click('[data-act="day"][data-step="1"]'); // Wed -> Thu
    await page.waitForTimeout(180);
    const movedRow = page.locator('li.row.appt', { hasText: 'Sofía Díaz' });
    assertTrue(await movedRow.count() === 1, 'Sofía must appear on Thursday after reschedule');
    assertTrue((await movedRow.getAttribute('class')).includes('moved'), 'Thursday row should carry the moved marker');
    assertTrue(await movedRow.locator('.moved-badge').count() === 1, 'Thursday row should show the reprogramado badge');

    // Present in Semana too (Thursday column, not Tuesday).
    await goToView(page, 'semana');
    const weekHtml = await page.locator('.week-grid').innerHTML();
    assertTrue(weekHtml.includes('Sofía') || weekHtml.includes('Sof'), 'Semana should render a block for Sofía');
    const movedBlocks = await page.locator('.week-block.moved').count();
    assertTrue(movedBlocks >= 1, 'Semana should render the moved block as dashed');

    // Present in Mes: Thursday's cell should have a dot, and this week's Tuesday should not
    // have lost its other appointments (only Sofía's occurrence moved away from it).
    await goToView(page, 'mes');
    const thuCell = page.locator(`.month-cell[data-date="${iso(thursday)}"] .dot`);
    assertTrue(await thuCell.count() >= 1, 'Mes should show at least one dot on the target Thursday');

    // Fixed weekly schedule must be untouched: next Tuesday she is back to her normal 16:00.
    const db = await readDb(page);
    const sofia = db.patients.find(p => p.name === 'Sofía Díaz');
    assertEqual(sofia.schedule.length, 1, 'schedule length unchanged');
    assertEqual(sofia.schedule[0].day, 2, 'schedule weekday unchanged');
    assertEqual(sofia.schedule[0].time, '16:00', 'schedule time unchanged');
    const movedOnly = db.changes.filter(c => c.patientId === sofia.id);
    assertEqual(movedOnly.length, 1, 'exactly one change recorded for Sofía');
    assertEqual(movedOnly[0].kind, 'move', 'the change must be a move, not a schedule edit');
    void nextTuesday; // (schedule-based, no attendance needed for this check)
  } finally {
    await context.close();
  }
}

async function scenarioCuentasFrozenPrice(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    const db = buildSeed();
    await seed(page, origin, db);

    await goToView(page, 'cuentas');
    const totalBefore = await page.locator('.big .num').innerText();

    // Change Martina's price after she was already marked present this month.
    await goToView(page, 'pacientes');
    await page.locator('button.row', { hasText: 'Martina López' }).click();
    await page.waitForSelector('dialog#editor[open]');
    await page.fill('#editor-form [name="price"]', '99999');
    await page.click('#editor-form button[type="submit"]');
    await page.waitForTimeout(180);

    await goToView(page, 'cuentas');
    const totalAfter = await page.locator('.big .num').innerText();
    assertEqual(totalAfter, totalBefore, 'Cuentas total must not change when a price changes after marking (frozen price)');
  } finally {
    await context.close();
  }
}

async function scenarioVoiceTextFallback(browser, origin) {
  const { context, page } = await freshPage(browser);
  try {
    await seed(page, origin, buildSeed());

    await page.route('**/api/voice', async route => {
      const body = route.request().postDataJSON();
      const target = body.context.patients.find(p => p.name === 'Sofía Díaz');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
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
    await page.waitForTimeout(400);

    const resultHtml = await page.locator('#voice-result').innerHTML();
    assertTrue(resultHtml.includes('voice-done'), 'a valid action should be listed as done');
    assertTrue(await page.locator('#voice-undo').count() === 1, 'Deshacer must be offered after applying a voice action');

    const dbAfter = await readDb(page);
    assertTrue(dbAfter.attendance.some(a => a.status === 'present' && a.date === ANCHOR_ISO && dbAfter.patients.find(p => p.id === a.patientId)?.name === 'Sofía Díaz'),
      'the voice action must actually be applied to the db');

    await page.click('#voice-undo');
    await page.waitForFunction(() => (document.querySelector('#voice-result')?.textContent || '').includes('Deshecho'));
    const dbUndone = await readDb(page);
    const stillPresentToday = dbUndone.attendance.some(a => a.date === ANCHOR_ISO && a.status === 'present' &&
      dbUndone.patients.find(p => p.id === a.patientId)?.name === 'Sofía Díaz');
    assertTrue(!stillPresentToday, 'Deshacer must restore the pre-batch snapshot');
  } finally {
    await context.close();
  }
}

/* ---------- screenshots ---------- */
async function takeScreenshots(browser, origin) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const { context, page } = await freshPage(browser);
  try {
    await seed(page, origin, buildSeed());
    await page.screenshot({ path: path.join(SHOTS_DIR, 'hoy.png') });

    await goToView(page, 'semana');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'semana.png') });

    await goToView(page, 'mes');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mes.png') });

    await goToView(page, 'pacientes');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'pacientes.png') });

    await goToView(page, 'cuentas');
    await page.screenshot({ path: path.join(SHOTS_DIR, 'cuentas.png') });

    await page.route('**/api/voice', async route => {
      const body = route.request().postDataJSON();
      const target = body.context.patients[1];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          actions: [{ type: 'mark_attendance', patientId: target.id, date: body.context.today, status: 'present' }],
          reply: `Listo, marqué a ${target.name.split(' ')[0]} como presente hoy.`,
        }),
      });
    });
    await page.click('#mic-fab');
    await page.waitForSelector('#voice-sheet[open]');
    await page.fill('#voice-text-input', 'hoy vino Sofía');
    await page.click('#voice-text-form button[type="submit"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'voz.png') });
  } finally {
    await context.close();
  }

  const { context: darkContext, page: darkPage } = await freshPage(browser, { dark: true });
  try {
    await seed(darkPage, origin, buildSeed());
    await darkPage.screenshot({ path: path.join(SHOTS_DIR, 'hoy-dark.png') });
  } finally {
    await darkContext.close();
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
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
  delete env.LLM_BASE_URL;
  delete env.LLM_API_KEY;
  delete env.LLM_MODEL;
  delete env.LLM_EXTRA_HEADERS;
  const origin = `http://127.0.0.1:${port}`;

  const serverProc = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', d => console.error('[server]', d.toString().trim()));
  serverProc.on('exit', code => { if (code !== null && code !== 0) console.error(`server.mjs exited with code ${code}`); });

  let browser;
  try {
    await waitForServer(`${origin}/`);
    browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox', '--disable-gpu'] });

    await check('v1 data migrates to v2 and shows correctly', () => scenarioMigration(browser, origin));
    await check('Hoy: explicit Vino/No vino + Deshacer, no silent toggle', () => scenarioAttendanceAndUndo(browser, origin));
    await check('reschedule_once via sheet moves the occurrence, schedule unchanged', () => scenarioReschedule(browser, origin));
    await check('Cuentas sums only present sessions at frozen price', () => scenarioCuentasFrozenPrice(browser, origin));
    await check('voice sheet text fallback applies actions + Deshacer restores', () => scenarioVoiceTextFallback(browser, origin));

    console.log('\nTaking screenshots...');
    await takeScreenshots(browser, origin);
    console.log(`Screenshots written to ${SHOTS_DIR}`);
  } finally {
    if (browser) await browser.close();
    serverProc.kill();
    await Promise.race([once(serverProc, 'exit'), new Promise(r => setTimeout(r, 2000))]);
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
