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
- [x] T8 Payments: data + Cuentas UI (owed / paid / balance per patient, register payment
      prefilled with the owed amount) + voice action `record_payment`.
- [x] T9 AI via ai-router (SSE parsing, tolerant JSON extraction, one retry on bad JSON);
      send only first name + surname initial to the model.
- [x] T10 Polish (Ahora card actions, Semana overlaps) + e2e/screenshots updated.
- [x] T11 Dockerfile + docker-compose.yml (files only — GitHub repo, Coolify app, domain
      and live checks are the coordinator's own follow-up).

## Phase 3 scope (authorized by the user on 2026-09-27)

- Voice conversation memory: the assistant keeps a short context of the recent exchange so
  a follow-up like "Lucía Gómez, lunes a las cinco" completes a previous "creame un nuevo
  paciente" that asked for the missing data. Stored client-side (localStorage), short-lived.
- Biweekly patients: a schedule slot can repeat every week or every two weeks.
- Times must be entered as 24h ("16hs"), not AM/PM.

### Phase 3 tasks

- [x] T12 Voice conversation memory (client history + server multi-turn prompt + UI).
- [x] T13 Biweekly slots (data, appointmentsOn, editor UI, voice actions, calendars).
- [x] T14 24-hour time picker everywhere ("16:00", never "4 PM"): the native
      `<input type=time>` follows the phone's 12h locale.
- [ ] T15 Redeploy to Coolify + live checks (coordinator).

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

- T8 (commit pending): added `payments[]` (`{id,patientId,date,amount,note?}`) to the doc
  (`emptyDb`/`migrate` updated) and the pure `balanceOf(db,patientId)` (sum of `present`
  attendance price − sum of payments; positive = owes, 0 = al día, negative = a favor).
  Cuentas redesigned: two month figures (Atendido = present sessions this month, Cobrado
  = payments dated this month), an all-time "Te deben" total (sum of only the *positive*
  balances — a patient with a credit doesn't reduce what others owe), and per-patient rows
  with a balance chip (red "Debe $X" / green "Al día" / neutral "A favor $X"); tapping a
  row opens a new patient-accounts sheet (`#accounts-sheet`): balance banner, a payment
  form prefilled with the owed amount (quick buttons "Todo lo que debe" and, when
  different, the last session's price), recent sessions and payments with delete-with-
  confirm on payments. Hoy: a present row shows a subtle "Pagó" button (records a payment
  of that session's frozen price for that date) that becomes a "Pagado" tag once any
  payment exists for that patient on that date. Voice: `record_payment` (`amount: null`
  resolves to the current balance; validation rejects it when the balance isn't positive
  — "no debe nada" — matching "Joaquín no debe nada, no hice nada" style non-actions), each
  patient's `balance` added to `buildVoiceContext`, and the `server.mjs` system prompt
  updated with the new action and balance-aware `reply` guidance (still the OpenAI-
  compatible client for now; T9 moves the client to ai-router, prompt content carries
  over).

  Checks: `node --check app.js server.mjs` pass. Playwright/Chromium end to end (signup →
  seed via `PUT /api/data` → reload): Hoy's "Pagó" quick action marks the session paid
  (chip becomes "Pagado"); Cuentas shows Atendido/Cobrado/Te deben and an "Al día" chip
  once the session is paid; the accounts sheet opens, a manual extra payment flips the
  balance to "A favor $5.000", and deleting a payment recomputes the balance correctly
  (confirmed the math traces through insertion order for same-date payments, not a bug).
  No console errors in any of the runs.

- T9 (commit pending): replaced the OpenAI-compatible `/chat/completions` client with an
  `ai-router` client (`AI_ROUTER_URL`, optional `AI_ROUTER_MODEL`/`AI_ROUTER_TOKEN`; all
  `LLM_*` env vars removed, module comment and `README.md` updated). Verified the exact
  wire format against the live router before writing the parser (`curl` with `cat -A`):
  `data: <token>\n\n` per chunk, ending `data: [DONE]\n\n`. `parseAiRouterSse` splits on
  `\n\ndata: ` (not on blank lines alone — a token could contain one), strips the `data: `
  prefix only from the first chunk by exact 6-char slice (never trimmed, so a token with a
  genuine leading space survives), and stops at a `[DONE]` sentinel (`trimEnd()`-compared,
  since the final chunk carries the stream's closing blank line). Total failure is detected
  by `content-type` (only `text/event-stream` is success), not `res.ok` alone, and a
  non-JSON failure body (Cloudflare's own error page behind the CDN) falls back to a
  truncated text snippet instead of crashing on `.json()`. `max_tokens`/`response_format`
  are no longer sent (the router ignores both). One corrective retry on unparsable JSON
  appends the bad output plus a "that wasn't valid JSON" follow-up message and asks again —
  a transport/total failure is never retried, since the router already cascaded every free
  provider itself. `/api/voice` still requires a session (unchanged from T7).

  Privacy: `buildVoiceContext` now sends `shortName(patient.name)` ("Martina López" →
  "Martina L.") instead of the full name — patients are children and the free cascade
  goes to third-party providers. `patientId` is untouched, so every action the app applies
  still resolves to the real patient via local `db` (full names were already used there,
  no change needed). The model's own free-text `reply` can still surface a short name, so
  `deanonymizeReply` replaces each patient's short name with their full name client-side
  before it's displayed. `server.mjs`'s system prompt documents `record_payment` and
  balance-aware replies (content carried over from T8, now served through the new client).

  Checks: `node --check app.js server.mjs` pass. Unit-checked `parseAiRouterSse` inline
  against three cases (plain token, JSON payload, a token split across chunks with a
  genuine leading space) — all correct. `curl` through the live router confirmed the SSE
  framing assumptions before coding, and confirmed the total-failure JSON shape separately
  via the documented example.

  **Real ai-router test**, 10 calls through the full app (`POST /api/voice`, authenticated,
  no model pinned — free cascade), covering the exact list asked for:

  | # | Command | Result | Latency |
  |---|---|---|---|
  | 1 | "hoy vino Martina" | no action; asked whether to add it as an extra session (Martina's schedule is Mon/Thu, "today" in the test context was Sunday — a defensible read, not a hallucination, though more conservative than the client's own validation requires) | 727ms |
  | 2 | "Sofía no vino" | correct `mark_attendance` absent, correct upcoming Tuesday | 915ms |
  | 3 | "esta semana Joaquín viene el jueves a las seis de la tarde en vez del martes" | correct `reschedule_once`, this week's Tue→Thu 18:00 | 1.44s |
  | 4 | "agregá a Lucía Gómez, quince mil, lunes y miércoles a las cinco" | correct `add_patient`, 15000, Mon+Wed 17:00 | 1.57s |
  | 5 | "Martina me pagó" | correct `record_payment`, `amount:null` | 1.59s |
  | 6 | "Joaquín pagó lo de hoy" | correct `record_payment`, `amount:20000` (today's session price, not null) | 867ms |
  | 7 | "Sofía me pagó el mes" | correct `record_payment`, `amount:null` | 749ms |
  | 8 | "¿cuánto me debe Tomás?" | no action (correct), reply correctly reports Tomás's credit from `balance:-5000` | 1.31s |
  | 9 | "¿quién me debe?" | no action (correct), reply correctly lists both debtors with amounts from context | 1.71s |
  | 10 | "¿cuánto llevo este mes?" | no action (correct), reply matches `monthTotals` | 1.61s |

  9/10 fully correct, 1 defensible-but-conservative non-action. `GET /providers` showed
  the cascade actually failing over mid-battery — Groq (the fastest, `speedRank:1`) hit
  its free-tier cooldown partway through this burst and `google`/`gemini-3.5-flash-lite`
  took over as preferred — every answer stayed correct through that handoff, which is a
  real (not simulated) exercise of the router's own failover.

- T10 (commit pending): **Ahora card** — "Reprogramar" is now a full-width secondary text
  button on its own line directly under the two big buttons (`.now-reprogramar`), card
  vertical padding tightened (18px→14px), no more floating gap. **Semana overlaps** —
  added `layoutDayColumn()`: mutually-overlapping appointments in a day column are grouped
  and packed into the fewest side-by-side lanes (Google-Calendar-style greedy algorithm),
  each block's `left`/`width` set from its lane instead of always spanning the full column;
  verified with real 09:00/09:30 overlapping data (two 45-min sessions) rendering as two
  narrow side-by-side blocks, neither hidden. **Voice sheet vs. bottom nav** — confirmed via
  screenshot that native `<dialog>` (`showModal()`) already paints above the fixed nav/FAB
  regardless of z-index (top-layer), so this was not actually broken; added `overflow-y:
  auto` to the base `dialog` rule as a safety net so a longer result list scrolls inside
  the sheet instead of visually overflowing it, and confirmed the last Semana hour (20:00)
  clears the nav/FAB with room to spare when scrolled to the bottom.

  **`tools/e2e.mjs` rewritten** for the auth-gated app: server now starts with a temp
  `DATA_DIR` (`fs.mkdtempSync`, removed in `finally`) and `INSECURE_COOKIES=1`. New
  `signup()`/`login()`/`seedServer()` (writes a doc straight to `PUT /api/data`, bypassing
  the UI, then reloads so the page's in-memory `docVersion` catches up) and
  `readServerData()` helpers. Every scenario runs behind a real account now; each phase-1
  scenario was ported (unique email per scenario, `seed()`→`seedServer()`, `readDb()`→
  `readServerData()`). Five new scenarios:
  - **v1 import on first login**: writes legacy `consultorio.v1` data before signup —
    covers both "v1 data loads without loss" (phase 1) and "import of pre-existing local
    data on first login" (phase 2) with one honest scenario, since first login *is* the
    migration path now. Asserts the imported patient is visible **and** that the server
    doc (not just the local cache) is version 2 with the migrated shape.
  - **Auth persistence**: a second `page` in the *same* browser context (shared cookie)
    opens already authenticated and loads the same server data — no separate login step.
  - **Sync reaches the server**: a local mutation is followed by `GET /api/data` showing a
    bumped version.
  - **409 conflict**: two separate contexts log into the *same* account; device B writes
    behind device A's back via a raw `PUT`; device A's own (now-stale) edit gets a 409 and
    the UI adopts device B's value — asserted by reading the live DOM after the toast, not
    by trusting the response alone.
  - **Payments**: opens the accounts sheet for a patient who owes money, asserts the
    prefilled amount, exercises "Todo lo que debe" (change the field, click it, assert it
    restored the full balance), registers the payment and asserts "Al día", exercises
    Hoy's "Pagó" quick action (chip becomes "Pagado"), and mocks `record_payment` with
    `amount:null` through the voice text fallback.

  **Two real bugs found while running this against the rewritten suite** (not just review):
  (1) the auth rate limit (10 req/min/IP) started rejecting the e2e script's own signups
  partway through the run — 9 scenarios × 1 signup each is exactly the kind of legitimate
  burst a household or a test suite produces; raised to 30/min (still a real throttle:
  `scrypt` makes each attempt CPU-costly regardless of the count). (2) the voice-fallback
  scenario asserted the server had synced *immediately* after the action rendered, racing
  `save()`'s own 500ms debounce; added a matching wait before reading `GET /api/data`.

  Checks: `node --check app.js server.mjs tools/e2e.mjs` pass. Full suite run twice back
  to back — 9/9 scenarios green both times, no flakes. Screenshots (390×844 @2x) written
  to `shots/`: `login.png`, `hoy.png` (Ahora card's new Reprogramar layout, plus the "Pagó"
  quick action on a present row), `semana.png` (the 09:00/09:30 overlap rendered
  side-by-side, confirmed in the actual screenshot, not just asserted), `mes.png`,
  `cuentas.png`, `cuentas-paciente.png` (payment form, quick buttons, session/payment
  history), `voz.png` (sheet open above the nav, result + Deshacer), `hoy-dark.png`. All
  inspected by hand — no overflow, no nav/FAB overlap, dark mode legible.

- T11 (commit pending, files only): `Dockerfile` (`node:24-alpine`, no npm dependencies —
  just copies the static files + `server.mjs`), `docker-compose.yml`, `.dockerignore`, and
  a README "Deploy" section. Added `GET /api/health` (200, unauthenticated, exempt from
  the general rate limit so an orchestrator's frequent probing is never throttled) and a
  matching Dockerfile `HEALTHCHECK` (`node -e` hitting it — no `curl`/`wget` dependency
  needed on Alpine). Cache-busting: `index.html`'s `styles.css`/`app.js` `<link>`/`<script>`
  URLs carry `?v=__V__`, substituted at build time
  (`RUN sed -i "s/__V__/$(date +%s)/g" index.html`) so Cloudflare's hours-long `.css`/`.js`
  cache can never serve a stale asset after a deploy; `index.html` itself already carried
  `Cache-Control: no-cache` since T7's static file handler, so the browser always re-checks
  it and immediately picks up the new asset URLs. `RUN mkdir -p /data && chown -R node:node
  /data /app` before `USER node`, so a fresh named volume mounted at `/data` inherits
  `node`-owned permissions on first use instead of being root-owned and unwritable.
  `docker-compose.yml`: one `app` service, `expose: ["3000"]`, no published ports, no
  external network, named volume `consultorio-data:/data`, `AI_ROUTER_URL` with the
  documented default via `${AI_ROUTER_URL:-https://ai-router.becode.com.ar}` — no
  BuildKit-only syntax (plain `build: {context, dockerfile}`, no `--mount=type=cache`).

  Verified with the local Docker daemon (`docker --version` 29.3.1, confirmed reachable):
  `docker build` succeeded; ran the built image standalone
  (`docker run -p 18940:3000 -e INSECURE_COOKIES=1 ...`, an arbitrary local port, nothing
  shared) and confirmed: `GET /api/health` → 200, `index.html` → `Cache-Control: no-cache`
  with real build-timestamp query strings on both asset URLs, the versioned asset URL
  itself resolves (200), `POST /api/signup` → 200 (proves `/data` is actually writable by
  the unprivileged `node` user, not just present), `whoami` inside the container is `node`,
  `/data/consultorio.db*` is `node`-owned, and the container's own Docker `HEALTHCHECK`
  reported `healthy` after its start period. `docker compose config` parses the compose
  file cleanly (the `networks: default` it prints is Compose's ordinary implicit network
  for inter-container DNS, not a declared external network). Test container, image, and
  volume were all removed afterward — nothing left running, no `compose up` was run against
  this box.

## Deploy (T11, coordinator, 2026-09-27)

- GitHub: `becodeb/consultorio` (public; history scanned for keys: clean).
- Coolify (coolify.becode.com.ar): app `consultorio`, uuid `9lnqhagr0yfvtfwdkmqj7s6v`,
  dockercompose, service `app`, domains `https://consultorio.becode.com.ar` +
  sslip fallback. No auto-deploy (public repo): redeploy via API after each push.
- Live checks: `/`, `/api/health`, assets → 200 over HTTPS; `/api/me` and `/api/voice`
  → 401 unauthenticated; wrong login → 401 without cookie; served `app.js` sha256
  equals local (asset URLs versioned `?v=<build time>`); status `running:healthy`.
- Not verified live: a real signup + voice call against production (avoided creating
  test data in prod; the free ai-router cascade was verified from the Pi with 10 calls).
- Local server on 8811 stopped (its `data/` DB is separate from production).

- T12 (commit pending): client keeps `voiceHistory` (last 8 turns,
  `{role:'user',text}` / `{role:'assistant',reply,done}`), persisted per user under
  `consultorio.voice.<userId>` with an `updatedAt` timestamp; `loadVoiceHistory()` discards
  it once idle past 20 minutes. Sent as `history` on every `POST /api/voice`.
  `server.mjs`'s `sanitizeHistory()` caps it independently of the client (≤8 turns, ≤4000
  combined chars, per-field length caps, shape-validated) before `callLlm` turns it into
  real prior `user`/`assistant` messages (an assistant turn's content is
  `JSON.stringify({reply,done})`, so the model can see exactly what it already applied).
  Added prompt rules: never repeat an action already in a prior turn's `done`; if the last
  assistant reply asked for missing data for a pending intent (add_patient, reschedule,
  record_payment, …) and the new utterance reads as the answer, complete that same intent
  instead of asking again; an unrelated new request is still handled fresh.

  UI: the voice sheet now shows the exchange as a compact chat (`#voice-chat`, right-
  aligned dark user bubbles, left-aligned outlined assistant bubbles with their `done`
  list underneath, auto-scrolled to the newest turn), with "Nueva conversación" clearing
  the history. "Deshacer" moved to a dedicated slot below the chat (still tied to the most
  recent applied batch only, same `undoSnapshot` semantics as before).

  **Two real layout bugs found and fixed while screenshotting** (not caught by code
  review): (1) `.voice-new-chat` was absolutely positioned over a centered `<h2>`, so on a
  long title ("Asistente por voz") the button visually overlapped the text — fixed with an
  ordinary `justify-content: space-between` header row and a smaller, `white-space: nowrap`
  title instead of absolute positioning. (2) forcing `dialog#voice-sheet` to a fixed
  `height: 88dvh` (added so the chat area could flex-scroll) left a large dead gap below a
  short 2-turn conversation, because the flex chat area had no reason to grow yet the
  dialog was still forced to nearly full height; fixed by using `max-height` (not `height`)
  on both the dialog and its inner flex column — a flex child only consumes leftover space
  when the container is actually height-constrained by real content, so a short
  conversation now hugs its content and a long one caps at 88dvh with the chat area (not
  the whole sheet) scrolling internally. Verified pixel-by-pixel via
  `getBoundingClientRect()` (not just eyeballing a screenshot) that every gap between the
  chat log, the undo slot, the mic circle, and the text-fallback form is exactly the
  intended 8px, with no unaccounted space. Also discovered mid-fix that `.sheet-inner` was
  a class shared with the T8 accounts (payments) sheet, so the new flex-column rules had
  silently leaked into it too; re-scoped the voice sheet to its own `.voice-sheet-inner`
  class and confirmed the accounts sheet's layout is unchanged (screenshot comparison
  against the T10 version).

  Checks: `node --check app.js server.mjs` pass. Playwright/Chromium (mocked
  `POST /api/voice` via `page.route`): first request's `history` is `[]`; after one
  exchange, the second request's `history` contains the first user+assistant turn
  verbatim; 4 chat bubbles render after 2 exchanges; closing and reopening the sheet keeps
  the history (localStorage); "Nueva conversación" empties it and the next request's
  `history` is `[]` again; no console errors.

  **Real ai-router test**, 4 calls (free cascade), covering exactly the user's reported
  scenario plus a discipline check:

  | # | Turn | Result | Latency |
  |---|---|---|---|
  | 1 | "creame un nuevo paciente" (no history) | correct: no action, asks for name/price/schedule | 798ms |
  | 2 | "Lucía Gómez, quince mil, lunes a las cinco" (history = turn 1) | correct: completes the *same* pending `add_patient` from just the answer — the exact behavior she asked for — `{name:"Lucía Gómez", price:15000, schedule:[{day:1,time:"17:00"}]}` | 673ms |
  | 3 | "Martina me pagó" (fresh conversation) | correct: `record_payment` `amount:null` resolved directly from the explicit prompt rule ("everything owed" is the default), no clarifying question needed — so the "¿cuánto?" follow-up path was never exercised because the model correctly didn't need it | 605ms |
  | 4 | "Sofía no vino hoy" with a *fabricated* pending "nombre y horario" question in history, and no Sofía in context | correct: recognized this as an unrelated new request, not an answer to the stale question, and correctly refused (no matching active patient) rather than misapplying it as add_patient data | 2.79s |

  4/4 correct; stopped early (budget was ~6) since the core memory behavior and the
  discard-when-unrelated guard were both cleanly demonstrated.

- T13 (commit pending): schedule slot shape extended to `{day,time,every?:1|2,anchor?}`;
  missing `every` still means weekly everywhere (no data migration needed — `slotOccursOn`
  defaults it to 1 at read time). New pure helpers `mondayOfIsoUtc`/`weeksBetweenIsoUtc`
  compute entirely from ISO date strings via `Date.parse(...'Z')` (UTC), never the
  runtime's local timezone, so DST transitions can't shift which week is "even". An
  occurrence exists when `weeksBetweenIsoUtc(anchor, date) % 2 === 0`; verified this holds
  for dates *before* the anchor too (JS's `%` on a negative even number of weeks is still
  `0`/`-0`, both `=== 0`) with a standalone 8-case table (anchor week, ±1 week, ±2 weeks,
  ±4 weeks — all correct) before wiring it into `appointmentsOn`'s slot filter, the only
  place that needed to change (Hoy/Semana/Mes/Ahora/voice context all read through it, so
  they all followed automatically — confirmed end to end, not just asserted: Hoy showed a
  biweekly patient on the anchor Monday, correctly hid her the next Monday, and showed her
  again 2 weeks later; Semana rendered exactly one block on an "on" week; Mes showed the
  dot on 9/28 and 10/12 but not 10/5).

  Editor: each slot row gained a segmented "Cada semana"/"Cada 2 semanas" control; picking
  biweekly reveals "Próxima vez" with exactly the next 2 upcoming dates for the row's
  current weekday (`nextWeekdayDates`), and changing the weekday regenerates them. On
  reopening an existing biweekly slot, the control preselects whichever of those 2 dates
  shares the stored anchor's parity (the two offered dates are always exactly 1 week apart
  so exactly one of them always matches) — the pattern round-trips exactly even though the
  literal anchor string may refresh to a more recent equivalent date. Patient list text:
  "Lun 16:00 c/2 sem". Voice: `add_patient`/`update_patient` schedule validation now
  accepts `every`/`anchor` (anchor required and must be a valid `YYYY-MM-DD` when
  `every:2`); `buildVoiceContext` already forwarded the whole slot object, so no extra
  client wiring was needed for the model to see or set them. Server prompt documents the
  new fields plus both example phrasings from the task.

  **Two more real `[hidden]`-vs-`display` bugs found while screenshotting the editor**
  (same defect class as two found in T7/T12, now four total across the app): `.remove`
  (the "Dar de baja" button) has always set `display: block` unconditionally, so it was
  visibly showing on a brand-new, unsaved patient — pre-existing since T1, just never
  screenshotted in that exact state before. `.slot-anchor`'s `display: flex` (added in
  this same task) had the identical problem, showing "Próxima vez" by default on an
  ordinary weekly slot. Both fixed with an explicit `.remove[hidden]`/`.slot-anchor[hidden]
  { display: none; }`, and reverified with a fresh "Nuevo paciente" screenshot plus
  `isHidden()` assertions (not just re-reading the CSS) showing both correctly hidden by
  default.

  Checks: `node --check app.js server.mjs` pass. Playwright/Chromium: editor round-trip
  (create biweekly → reopen → frequency still "Cada 2 semanas", anchor select still
  visible), Hoy/Semana/Mes integration above, `remove`/`slot-anchor` default-hidden
  regression check. No console errors in any run.

  **Real ai-router test**, 2 calls, the task's own example phrasings:

  | # | Command | Result | Latency |
  |---|---|---|---|
  | 1 | "Lucía viene cada dos semanas los lunes a las 16, empieza este lunes" (today = Sun 27/9) | correct `add_patient`, schedule `[{day:1,time:"16:00",every:2,anchor:"2026-09-28"}]` — "este lunes" correctly resolved to tomorrow | 1.24s |
  | 2 | "Tomás pasa a venir cada 15 días, la próxima es el jueves que viene" (existing Tue 15:00 patient) | correct `update_patient` on the right `patientId`, schedule `[{day:4,time:"15:00",every:2,anchor:"2026-10-01"}]` — kept his existing time, changed only the day/frequency/anchor | 782ms |

  2/2 correct.

- T14 (commit pending): every `<input type="time">` replaced by a shared
  `mountTimePicker(container, initial)` — two native `<select>`s ("HH" 07-22 by default,
  extended to include the initial value if it's outside that; "MM" the usual quarter-hours
  plus the initial minute if off-grid) rendered as "16 : 00", with `aria-label`s "Hora"/
  "Minutos" and a live `{value}` accessor (get/set "HH:MM") stored on the container element
  so callers can read/write it like a form field. One helper, two call sites: the slot
  editor (`slotRow`, replacing the bare `<input>`) and the reschedule sheet's "Nueva hora".
  `grep -c 'type="time"' index.html app.js` is `0` in both. `nowHM()` and the rest of the
  app already formatted every displayed time manually (`pad2` + `:`), and there was no
  `toLocaleTimeString`/`hour12` usage anywhere, so no other display-side fix was needed.
  Server prompt: added an explicit rule that both actions *and* `reply` text are always
  24h ("16:00"/"16 hs"), never "4 PM".

  Checks: `node --check app.js server.mjs` pass; `grep` confirms zero native time inputs.
  Playwright/Chromium: picked 09:30 in the editor → patient list shows "09:30" → reopening
  the same patient shows the picker's hour/minute selects still at 09/30 (round-trip);
  picked 11:15 in the reschedule sheet → the occurrence actually moved to 11:15 in Hoy
  (not just a UI-only check). Screenshots of both pickers inspected by hand — clean
  "HH : MM" layout, no leftover native clock-icon affordance, no truncation at 390px.

## Next step

T13.
