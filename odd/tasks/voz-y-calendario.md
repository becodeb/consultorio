# Feature: voice assistant, rescheduling and calendars

Locator: `odd/tasks/voz-y-calendario.md` (Engram mirror: `odd/voz-y-calendario/tasks` — PENDING: engram returns ambiguous_project and does not list `consultorio` yet)

## Objective

A psicopedagoga sees several patients per day (some twice a week). She must be able to run
the whole day from the phone: see who is coming, mark who came / didn't come, reschedule a
single occurrence, check the week and the month, and do all of it by voice too.

## Problem

v1 (commit 2d9f507) only has a daily list with a yellow toggle that silently un-marks on a
second tap (not intuitive), no absences, no one-off schedule changes, no calendar, no voice.

## Scope (authorized by the user on 2026-09-26)

- Voice: microphone button; she speaks ("hoy vino Martina", "esta semana Joaquín viene el
  jueves a las 18", "agregá a Lucía, 15 mil, lunes y miércoles a las 17") and an AI turns it
  into actions that are applied, with undo. Everything must be doable by voice.
- One-off changes: move one occurrence to another day/time, cancel one occurrence, add an
  extra session. Permanent schedule changes stay in the patient editor.
- Today view: the day's list is pre-filled from schedules; each row has explicit
  "Vino" (turns green) and "No vino" (turns red) actions plus "Reprogramar".
- "Now" card: during a session's time window, the current patient appears on top to mark.
- Week calendar view and month calendar view.
- Visual redesign ("más lindo").
- Playwright screenshots of the result.

## Constraints

- No build step. Static front (index.html + css + js) plus a zero-dependency Node server
  (`server.mjs`) that serves the files and proxies `/api/voice` to an OpenAI-compatible LLM.
- API keys only via environment variables, never committed.
- Data stays in the browser (localStorage) with JSON backup; v1 data must migrate.
- Microphone (Web Speech API) needs a secure context: works on localhost/HTTPS, not on
  `http://192.168.x.x`. Text input fallback in the voice sheet.
- UI copy in Spanish (neutral), code in English.
- TDD: off (source: no project config, no test runner). Checks: Playwright e2e script with
  system Chromium (`/usr/bin/chromium`, `NODE_PATH=/tmp/pw/node_modules`).
- RDD: off (global, decided by the user 2026-09-23).
- Delivery: local repo only, no remote; no PR.

## Tasks

- [x] T1 Data model v2 + migration: appointments computed from weekly schedule + one-off
      changes (move / cancel / extra); attendance with `present` | `absent` and frozen price.
- [x] T2 Today view redesign: pre-filled list, Vino (green) / No vino (red) / Reprogramar,
      undo, "now" card, reschedule sheet.
- [x] T3 Week calendar + month calendar views.
- [x] T4 Voice: mic sheet (Web Speech API es-AR + text fallback), `server.mjs` LLM proxy,
      action validation + apply + undo.
- [x] T5 Visual polish across all views, bottom navigation.
- [x] T6 Playwright e2e + screenshots (390×844).

Route: delegated direct — one writer (writer trigger: 2+ non-trivial files).

## Phase 2 scope (authorized by the user on 2026-09-26, mid-session)

- Account with email + password; the phone stays logged in (enter it once). Data moves to
  the server per account (source of truth), local cache for offline.
- Payments: record whether a patient paid, how much (the full owed amount or another
  amount), by UI and by voice. Balance per patient = present sessions − payments.
- AI goes through `https://ai-router.becode.com.ar` (docs: GitHub `ezemastro/ai-router`,
  local clone `~/projects/ai_router/README.md`) instead of a direct provider.
- Deploy to `coolify.becode.com.ar` with docker compose on a `*.becode.com.ar` domain of
  our choice → `consultorio.becode.com.ar`.
- Polish from review of phase 1 screenshots: "Reprogramar" floats loose in the Ahora card;
  overlapping blocks in Semana (09:00 and 09:30) cover each other.

### Phase 2 tasks

- [x] T7 Server storage + auth: node:sqlite users/sessions/docs, scrypt, long-lived
      `__Host-` session cookie, login/signup screen, sync with version check, import of
      existing local data on first login.
- [ ] T8 Payments: data + Cuentas UI (owed / paid / balance per patient, register payment
      prefilled with the owed amount) + voice action `record_payment`.
- [ ] T9 AI via ai-router (SSE parsing, tolerant JSON extraction, one retry on bad JSON);
      send only first name + surname initial to the model.
- [ ] T10 Polish (Ahora card actions, Semana overlaps) + e2e/screenshots updated.
- [ ] T11 Dockerfile + docker-compose.yml, GitHub repo, Coolify app, domain, live checks.

## Acceptance criteria

- Marking "Vino" shows the row green; "No vino" red; both are reversible explicitly.
- A moved occurrence disappears from its original day and appears on the new one, in Today,
  Week and Month; the patient's fixed schedule is unchanged.
- Accounts count only `present` sessions at the price frozen when marked.
- Voice/text command "hoy vino X" marks X present today; a reschedule command moves only
  that week's occurrence.
- v1 localStorage data loads without loss.

## Progress / evidence

- T1 (commit `99c7d06`): split `index.html`/`styles.css`/`app.js`; added `migrate()`
  (v1 `{patients,sessions}` → v2 `{patients,changes,attendance,settings}`, assigning a
  palette color and a `since` date per patient), and the pure `appointmentsOn(db,isoDate)`
  function (weekly schedule + move/cancel/extra changes + attached attendance status,
  including legacy attendance with no matching appointment). Hoy/Cuentas adapted to read
  from `attendance`/`appointmentsOn` instead of the old `sessions` array; UI/UX unchanged
  for now (redesign is T2/T5). `node --check app.js` passes. Correctness of the new
  functions is exercised end-to-end by the Playwright suite in T6 (migration, attendance,
  reschedule, frozen price).

- T2 (commit pending): each Hoy row now shows an explicit "Vino"/"No vino" pair when
  unmarked, and a colored chip + explicit "Deshacer" button when marked (no silent
  toggle). Rows tint green/red via `.row.present`/`.row.absent`. Added the "Ahora" card
  (`currentOrNextAppointment`, ongoing window + 15 min grace, falls back to a "Próximo: …"
  line), refreshed every 30s via a dedicated `#now-card-slot` (does not re-render the rest
  of the page, so no UI state is lost). Added the reschedule sheet (`<dialog id="reschedule">`)
  with "Solo esta vez" (date+time picker → `rescheduleOccurrence`), "Cancelar esta sesión"
  (→ `cancelOccurrence`, native confirm) and "Cambiar horario fijo" (opens the existing
  patient editor; the weekly `schedule` is never touched by these). Session length is
  editable in Pacientes' footer (`db.settings.sessionMinutes`). "Otro paciente…" now records
  an `extra` change plus immediate `present` attendance, so it also appears correctly in
  Semana/Mes (T3). Manually smoke-tested with Playwright/Chromium (ad hoc script, not yet
  the T6 harness): v1 migration + mark present → green chip, reschedule sheet open →
  confirm "Solo esta vez" with no console errors; "Ahora" card renders for an in-window
  appointment and a "Próximo" line for a later one. `node --check app.js` passes.

- T3 (commit pending): added "Semana" and "Mes" tabs. `renderSemana` builds a Mon–Sat
  time grid (Sunday column only added when it has appointments) from `appointmentsOn`
  per day, hour range auto-expanded to cover the day's earliest/latest appointment (base
  08:00–20:00), blocks positioned by CSS `top`/`height` in a `position:relative` column
  per day, tinted by `patient.color`, dashed when moved, first name truncated. `renderMes`
  builds a Mon-first grid (`mondayOf`/`addDays`, always complete weeks) with up to 4
  colored dots + "+n" per day, today outlined, days where every appointment is marked
  tinted, tapping any day/block jumps to Hoy on that date (`openday` action). Smoke-tested
  with Playwright/Chromium at 390×844: 3 week blocks / 35 month cells / 15 month dots
  rendered correctly for a 6-patient seed, no console errors, tap-to-Hoy verified; visual
  screenshots at 390px show both grids fit without horizontal overflow (name truncation
  is intentionally tight — refined further in T5). `node --check app.js` passes.

- T4 (commit pending): mic FAB opens a bottom `<dialog>` sheet that auto-starts
  `SpeechRecognition` (`lang:'es-AR'`, `interimResults:true`) when available in a secure
  context, showing a live transcript and auto-submitting on `onend`; a text input +
  "Enviar" is always present as fallback (and the only path when speech is unsupported).
  `buildVoiceContext(db)` sends today/weekday/now, next 14 + previous 7 days, active+
  inactive patients, computed appointments for the current+next week, and this month's
  totals. `server.mjs` (Node built-ins only) serves the static files (traversal blocked —
  verified the WHATWG URL parser already collapses `..` before our path-containment check
  even runs; `.git`/`odd/`/`.env*` explicitly blocked with 403) and proxies
  `POST /api/voice` to an OpenAI-compatible `/chat/completions` endpoint (30s timeout,
  200KB body cap, 30 req/min per-IP rate limit, `response_format:json_object` + defensive
  fenced-code/first-object JSON extraction, 503 when unconfigured, API key never logged).
  Client validates every action type from the schema (patient exists, `YYYY-MM-DD`/
  `HH:MM` shapes, occurrence exists for reschedule/cancel) before applying any of them,
  applies valid ones in one batch, snapshots `db` first for an explicit "Deshacer", and
  lists invalid ones as "No hecho: <reason>". Added `README.md` and `.gitignore`
  (`.env*`, `node_modules/`, `shots/`).

  Checks: `node --check app.js server.mjs` pass. `curl`: static 200, traversal → 404 (URL
  parser normalizes `..` before it reaches our code — no vulnerability), `.git`/`odd/` →
  403, `/api/voice` without LLM env → 503, missing `text` → 400. Playwright/Chromium
  (mocked `/api/voice` via `page.route`): sheet opens, text fallback submits, valid action
  applied → row turns green in Hoy, "Deshacer" restores prior state (verified 0 present
  rows after undo), invalid action → listed as "No hecho: paciente inexistente", no
  console errors.

  **Real LLM test** (OpenCode Go, `https://opencode.ai/zen/go/v1`, model
  `deepseek-v4.1-flash`, session/user-agent headers via `LLM_EXTRA_HEADERS` per
  `kodu-medicion/experimentos/razonamiento/proxy-go.mjs`), 9 calls against a realistic
  4-patient context:

  | # | Command | Result | Latency |
  |---|---|---|---|
  | 1 | "hoy vino Martina" | correct `mark_attendance` present, today | 4.05s |
  | 2 | "Sofía no vino" | correct `mark_attendance` absent, correct patient | 4.62s |
  | 3 | "vinieron Joaquín y Tomás" | correct, one `mark_attendance` present per patient | 3.74s |
  | 4 | "esta semana Joaquín viene el jueves a las seis de la tarde en vez del martes" | **502** — upstream aborted at the 30s timeout | 30.0s |
  | 4b | same command, retried | correct `reschedule_once`, fromDate = this week's Tue, toDate = this week's Thu, toTime 18:00 | 2.95s |
  | 5 | "el lunes que viene Tomás no viene" | correct `cancel_once`, next Monday's date | 13.9s |
  | 6 | "agregá a Lucía Gómez, quince mil, lunes y miércoles a las cinco" | correct `add_patient`, price 15000, Mon+Wed 17:00 | 2.39s |
  | 7 | "a Martina subile a dieciocho mil" | correct `update_patient`, price 18000 | 1.82s |
  | 8 | "¿cuánto llevo este mes?" | no action (correct), `reply` states the real month total/count | 1.75s |

  8/9 calls correct on the first try (one transient timeout on the hardest case,
  correct on immediate retry — treated as a provider hiccup, not a prompt defect).
  Every produced action shape matched the schema and passed client-side validation.

- T5 (commit pending): adopted the exact spec tokens (`--paper #F5F7FA`, `--line #DCE3EA`,
  vino/novino/moved values, 8-color patient palette — the palette and status colors had
  already been picked to match in T1–T2), swapped the faint line grid for a dot grid
  (`radial-gradient` dots every 22px at `color-mix(ink 6%)`), row radius 14→16px, and
  turned the top tab bar into a fixed bottom nav (5 tabs, inline SVG icon + short label,
  `env(safe-area-inset-bottom)`, selected tab gets an ink label + a pencil-tinted icon
  pill) with the mic FAB fixed above it. Reworded the three "·" middle-dot strings found
  (moved badge, Cuentas absences line, reschedule sheet subtitle) to plain
  words/parentheses/commas per the "no middle-dot meta strings" rule. Made the Ahora card
  the visually heaviest element (pencil-tinted background + left edge, larger name/time
  type, an "Ahora"/"Todavía sin marcar" eyebrow).

  **Bug found and fixed during this pass**: the Hoy row layout broke at 390px — cramming
  the dot, time, name, price, the two "Vino"/"No vino" buttons and the kebab menu into one
  flex row left `.who` (`flex:1; min-width:0`) almost no space, so the patient name wrapped
  one letter per line (confirmed with a Playwright screenshot, not just code review).
  Fixed by splitting each appointment row into a `.row-main` info line (dot, time, name,
  price, kebab) and a `.row-actions` line below it (the two full-width action buttons, or
  the chip + Deshacer) — `.row.appt { flex-direction: column }`. Re-screenshotted after the
  fix: name renders on one line, both buttons fit comfortably, no console errors, and the
  earlier `mark`/`undo`/`reprogramar` Playwright checks (T2/T4 smoke scripts) still pass
  since the `data-act` delegation is unaffected by the DOM nesting change.

  Also discovered while screenshotting: Playwright's `fullPage: true` duplicates
  `position: fixed` elements (nav/FAB) at odd scroll offsets in the stitched image — that
  is a screenshot-capture artifact, not a layout bug; confirmed by re-shooting the same
  views as plain viewport screenshots (no `fullPage`), which is also what T6's required
  390×844 screenshots use. Verified the bottom-nav content clearance by scrolling
  Pacientes (the longest view, with the session-length field last) all the way down: the
  input clears the fixed nav/FAB with room to spare.

  Checks: `node --check app.js server.mjs` pass. Playwright/Chromium screenshots at
  390×844 (light: Hoy with Ahora card + green/red/moved rows, Semana, Mes, Pacientes,
  Cuentas, voice sheet; dark: Hoy) inspected by hand — no overflow, no truncated-beyond-
  legibility text, bottom nav/FAB never obscure unreachable content, dark mode legible
  (tightened the Ahora-card eyebrow color afterwards for low contrast in dark mode).

- T6 (commit pending): `tools/e2e.mjs` starts `server.mjs` on a Node-assigned free port
  (LLM env vars explicitly deleted for this run), drives system Chromium
  (`executablePath:'/usr/bin/chromium'`, `--no-sandbox --disable-gpu`) via
  `playwright-core` (resolved from `NODE_PATH` explicitly, since ESM does not honor
  `NODE_PATH` for bare specifiers), and fixes the clock (`page.clock.install`) to Monday
  2026-09-28 14:10 — inside Martina's 14:00 session window, so the Ahora card is always
  exercised. Seed: 7 Argentine-named patients, Mon–Fri 09:00–19:00 (mostly afternoons,
  two mornings), prices 15000–22000, ~3 past weeks of attendance for real Cuentas totals,
  and one this-week move (Joaquín's Tuesday → today) for the "reprogramado" badge.

  Five scenarios, all green:
  - **v1 → v2 migration**: writes the v1 `{patients,sessions}` shape, reloads, asserts
    `version:2`, a palette color + `since` were assigned, the legacy session became
    `present` attendance, and the patient renders correctly in Pacientes.
  - **Explicit Vino/No vino + Deshacer**: asserts a pre-marked row is green
    (`.row.present`), marking "No vino" turns it red, "Deshacer" clears both classes
    (proving the mark is undone explicitly, not silently toggled), then marking "Vino"
    from the Ahora card turns it green.
  - **reschedule_once via the sheet**: moves Sofía's Tuesday 16:00 to Thursday 18:30
    ("Solo esta vez"); asserts she disappears from Tuesday's Hoy, appears on Thursday's
    Hoy with the moved badge and dashed row, Semana renders a dashed block, Mes's
    Thursday cell gains a dot, and — reading `db` directly — her `schedule` and the
    change count/kind are exactly what a one-off move should produce (fixed schedule
    untouched).
  - **Cuentas frozen price**: reads the month total, changes a patient's price after she
    was already marked present, re-reads the total — unchanged.
  - **Voice text fallback**: mocks `POST /api/voice` via `page.route`, submits through
    the always-available text input, asserts the action list/reply render and the db was
    actually mutated, then asserts "Deshacer" restores the pre-batch snapshot.

  `node --check app.js server.mjs tools/e2e.mjs` all pass (run from inside the script
  too). Ran the full suite twice back to back — stable, no flakes — after fixing two real
  issues it caught: (1) a v1→v2 migration was only ever applied in memory, never
  persisted back to `localStorage`, so a reload before any mutation would silently
  re-read the original v1 shape (fixed: `app.js` now calls `save()` once right after
  `load()`); (2) one assertion raced the DOM update after clicking "Deshacer" — replaced
  the fixed `waitForTimeout` with `page.waitForFunction` on the rendered "Deshecho" text,
  and widened the other timeouts, since this Pi is shared and another session's Chromium
  was independently running concurrently during this work (confirmed via `ps`, left
  untouched).

  Screenshots (390×844, deviceScaleFactor 2) written to `shots/` and inspected by hand:
  `hoy.png` (Ahora card + one green + one red + one moved, all visible together after
  reordering the seed's row times), `semana.png`, `mes.png`, `pacientes.png`,
  `cuentas.png`, `voz.png` (sheet open, submitted text, reply, one done action, Deshacer),
  `hoy-dark.png`. No overflow, truncation, or nav/FAB overlap in any of them; the Ahora
  eyebrow's dark-mode contrast was tightened after review.

  **Deployment**: stopped the `python3 -m http.server 8811` placeholder (killed by PID,
  not by pattern), started `node server.mjs` detached (`setsid nohup … &`, disowned) on
  `0.0.0.0:8811` with the OpenCode Go env wired in, logging to
  `/tmp/consultorio-server.log`. Verified `curl http://127.0.0.1:8811/` → 200 and a live
  `POST /api/voice` call answers correctly.

- T7 (commit pending): `server.mjs` gained `node:sqlite` storage (`users`, `sessions`,
  `docs` tables, WAL mode, `DATA_DIR` env, gitignored) and full auth: `scrypt` password
  hashing (`scrypt$N$r$p$salt$hash`, `timingSafeEqual` compare), a random 32-byte session
  token whose sha256 is the only thing stored server-side, `__Host-consultorio`
  (Secure/HttpOnly/SameSite=Lax/Path=/, 400-day Max-Age), and a relaxed non-Secure
  `consultorio` cookie only when `INSECURE_COOKIES=1` AND the request isn't HTTPS (via
  `x-forwarded-proto`, since Coolify/Traefik terminates TLS) — for local dev/e2e, documented
  in the module comment and `README.md`. Endpoints: `POST /api/signup|login|logout`,
  `GET /api/me`, `GET /api/data`, `PUT /api/data` (optimistic concurrency via
  `baseVersion`, 409 returns the current server `{data,version}`). All mutating endpoints
  reject non-JSON `Content-Type` and a mismatched `Origin` header; login/signup are
  rate-limited separately (10/min/IP) from the general per-IP API limit (120/min) and the
  existing voice limit (30/min); `/api/voice` now requires a session.

  Client: `boot()` calls `GET /api/me` before anything else; 401 shows a full-screen auth
  view (email/password, Entrar/Crear cuenta toggle, mapped error strings). On success,
  `afterLogin()` loads `GET /api/data`; an empty server doc imports any existing
  `consultorio.v1` (v1 or v2) through the same `migrate()` used since T1, then pushes it
  so the server has a real doc to build on — existing browser data is never lost. Every
  mutation still calls the same `save()` used throughout the app (unchanged call sites);
  it now writes an instant per-user `consultorio.cache.<userId>` localStorage cache and
  debounces (500ms) a `PUT /api/data`. A failed/offline push keeps a `dirty` flag, shows
  a small "Sin conexión, guardando al volver" indicator, and retries on the `online` event
  and every 15s. A `409` adopts the server's `{data,version}`, re-renders, and toasts "Se
  actualizó desde otro dispositivo" — no client-side merge, server wins. Logout
  (`POST /api/logout` + reload) sits at the bottom of Pacientes next to the account email.

  **Two real bugs found and fixed while smoke-testing (not just code review):**
  (1) `process.removeAllListeners('warning')` never suppressed the `node:sqlite`
  experimental warning because a static `import` is hoisted above it regardless of source
  order — the warning fires during import evaluation, before any of the importing
  module's own code runs. Fixed by using a dynamic `await import('node:sqlite')` instead,
  which is not hoisted. (2) The auth overlay, bottom nav and mic FAB each combine a
  `hidden` attribute (toggled from JS) with a class that sets an explicit `display`
  value; since `[hidden]` and a class selector have equal CSS specificity, the later
  author rule always won over the browser's built-in `[hidden]{display:none}`, so setting
  `hidden` did nothing and the auth overlay kept intercepting clicks even when "hidden".
  Fixed with an explicit `.auth-view[hidden]`/`nav.tabs[hidden]`/`.fab[hidden] { display:
  none; }` override for each. Caught by a Playwright smoke test that tried to click
  through the (visually invisible in a screenshot, but still there) overlay and timed out
  — a static review of the CSS would very plausibly have missed this.

  Checks (ad hoc Playwright/Chromium scripts, not yet folded into `tools/e2e.mjs` — that's
  T10): `node --check app.js server.mjs` pass. `curl`: signup → 200 + cookie, `/api/me`
  with/without cookie → 200/401, `GET /api/data` on a fresh account → `{data:null,
  version:0}`, `PUT` with `baseVersion:0` → `{version:1}`, repeating the same stale
  `baseVersion:0` → `409` with the real current doc, duplicate signup → 409, wrong
  password → 401, logout → 204, `/api/voice` without a session → 401. Playwright: signup
  with pre-existing local v1 data → patient visible in Pacientes + email shown in footer;
  reload with the session cookie → still logged in, same data loaded from the server (not
  re-imported); marking attendance → the debounced `PUT` lands (`GET /api/data` shows the
  new version and the attendance row) within ~900ms; a simulated second-device write
  (direct `PUT` bumping the version) followed by a local edit → 409 → toast shown, and the
  *other device's* value (not the local edit) is what's kept, confirming server-wins
  conflict resolution.

## Next step

T8.
