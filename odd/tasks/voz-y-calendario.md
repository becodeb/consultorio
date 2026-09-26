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
- [ ] T4 Voice: mic sheet (Web Speech API es-AR + text fallback), `server.mjs` LLM proxy,
      action validation + apply + undo.
- [ ] T5 Visual polish across all views, bottom navigation.
- [ ] T6 Playwright e2e + screenshots (390×844).

Route: delegated direct — one writer (writer trigger: 2+ non-trivial files).

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

## Next step

T4.
