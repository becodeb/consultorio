/* Consultorio — data model v2 + views. Plain script, no build step. */

const KEY = 'consultorio.v1';
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const money = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const PALETTE = ['#4C8DF6', '#E8729A', '#F59E3B', '#3DB39E', '#9B6BDF', '#E5534B', '#2FA7C9', '#8FB33A'];
const DEFAULT_SESSION_MINUTES = 45;

const PREV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const NEXT = PREV.replace('M15 5l-7 7 7 7', 'M9 5l7 7-7 7');
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';
const XICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const KEBAB = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

/* ============================================================
   Pure data-model helpers (T1). No DOM access below this block.
   ============================================================ */

function moneyFmt(n) { return '$' + money.format(Math.round(n || 0)); }

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function mondayOf(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  return addDays(startOfDay(d), day === 0 ? -6 : 1 - day);
}
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateFromIso(s) { return new Date(s + 'T00:00:00'); }
function weekdayOf(isoDate) { return dateFromIso(isoDate).getDay(); }
function pad2(n) { return String(n).padStart(2, '0'); }
function nowHM(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function byName(a, b) { return a.name.localeCompare(b.name, 'es'); }
function slotOrder(a, b) {
  const da = (a.day + 6) % 7, dbb = (b.day + 6) % 7; // Monday first
  return da - dbb || a.time.localeCompare(b.time);
}
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function emptyDb() {
  return { version: 2, patients: [], changes: [], attendance: [], settings: { sessionMinutes: DEFAULT_SESSION_MINUTES } };
}

/** Migrate a v1 payload ({patients,sessions}) to v2 in place. Returns v2 shape unchanged if already v2. */
function migrate(raw) {
  if (raw && raw.version === 2) {
    if (!raw.changes) raw.changes = [];
    if (!raw.attendance) raw.attendance = [];
    if (!raw.settings) raw.settings = { sessionMinutes: DEFAULT_SESSION_MINUTES };
    if (!raw.settings.sessionMinutes) raw.settings.sessionMinutes = DEFAULT_SESSION_MINUTES;
    return raw;
  }
  const legacy = (raw && Array.isArray(raw.patients) && Array.isArray(raw.sessions)) ? raw : { patients: [], sessions: [] };
  const today = iso(new Date());
  const patients = legacy.patients.map((p, i) => {
    const own = legacy.sessions.filter(s => s.patientId === p.id).map(s => s.date).sort();
    return {
      id: p.id,
      name: p.name,
      price: p.price,
      schedule: p.schedule || [],
      active: p.active !== false,
      color: PALETTE[i % PALETTE.length],
      since: own[0] || today,
    };
  });
  const attendance = legacy.sessions.map(s => {
    const p = patients.find(x => x.id === s.patientId);
    const wd = weekdayOf(s.date);
    const slot = p ? p.schedule.find(sl => sl.day === wd) : null;
    return { id: s.id, patientId: s.patientId, date: s.date, time: slot ? slot.time : '', status: 'present', price: s.price };
  });
  return { version: 2, patients, changes: [], attendance, settings: { sessionMinutes: DEFAULT_SESSION_MINUTES } };
}

function findPatient(db, id) { return db.patients.find(p => p.id === id); }

/**
 * Computes the sorted list of appointments that fall on `isoDate`, combining the
 * patient's weekly schedule with one-off changes (move / cancel / extra), and
 * attaches attendance status. This is the single source of truth for Hoy, Semana
 * and Mes — they must never scan `schedule`/`attendance` directly.
 * Returns: { patientId, date, time, moved: {fromDate,fromTime}|null, extra, status }[]
 */
function appointmentsOn(db, isoDate) {
  const weekday = weekdayOf(isoDate);
  const out = [];

  for (const p of db.patients) {
    if (p.since && isoDate < p.since) continue;
    const slots = p.schedule.filter(sl => sl.day === weekday);
    for (const slot of slots) {
      const removed = db.changes.some(c =>
        (c.kind === 'move' || c.kind === 'cancel') &&
        c.patientId === p.id && c.date === isoDate && c.time === slot.time);
      if (removed) continue;
      out.push({ patientId: p.id, date: isoDate, time: slot.time, moved: null, extra: false });
    }
    for (const c of db.changes) {
      if (c.kind === 'move' && c.patientId === p.id && c.toDate === isoDate) {
        out.push({ patientId: p.id, date: isoDate, time: c.toTime, moved: { fromDate: c.date, fromTime: c.time }, extra: false });
      } else if (c.kind === 'extra' && c.patientId === p.id && c.date === isoDate) {
        out.push({ patientId: p.id, date: isoDate, time: c.time, moved: null, extra: true });
      }
    }
  }

  const withStatus = out.map(a => {
    const att = db.attendance.find(x => x.patientId === a.patientId && x.date === a.date && x.time === a.time);
    return Object.assign({}, a, { status: att ? att.status : null });
  });

  // Legacy / unmatched attendance records still must show up on their day.
  for (const att of db.attendance.filter(x => x.date === isoDate)) {
    const already = withStatus.some(a => a.patientId === att.patientId && a.time === att.time);
    if (!already) {
      withStatus.push({ patientId: att.patientId, date: isoDate, time: att.time || '', moved: null, extra: false, status: att.status, legacy: true });
    }
  }

  withStatus.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  return withStatus;
}

/** Appointments for a list of ISO dates, flattened and still date-sorted. */
function appointmentsInRange(db, isoDates) {
  return isoDates.flatMap(d => appointmentsOn(db, d));
}

function findOccurrence(db, patientId, isoDate) {
  return appointmentsOn(db, isoDate).find(a => a.patientId === patientId) || null;
}

/** Builds the JSON context sent to /api/voice alongside the spoken/typed text. */
function buildVoiceContext(db) {
  const today = new Date();
  const todayIso = iso(today);
  const next14Days = [];
  for (let i = 0; i < 14; i++) { const d = addDays(today, i); next14Days.push(`${iso(d)} ${DAYS[d.getDay()]}`); }
  const prev7Days = [];
  for (let i = 1; i <= 7; i++) { const d = addDays(today, -i); prev7Days.push(`${iso(d)} ${DAYS[d.getDay()]}`); }

  const patients = db.patients.map(p => ({
    id: p.id, name: p.name, price: p.price, schedule: p.schedule, active: p.active,
  }));

  const weekStart = mondayOf(today);
  const rangeDates = [];
  for (let i = 0; i < 14; i++) rangeDates.push(iso(addDays(weekStart, i)));
  const appointments = rangeDates.flatMap(d =>
    appointmentsOn(db, d).filter(a => findPatient(db, a.patientId)).map(a => ({
      patientId: a.patientId, date: a.date, time: a.time, status: a.status,
      moved: !!a.moved, extra: !!a.extra,
    })));

  const prefix = todayIso.slice(0, 7);
  const present = db.attendance.filter(a => a.date.startsWith(prefix) && a.status === 'present');
  const monthTotals = { month: prefix, total: present.reduce((t, s) => t + s.price, 0), sessions: present.length };

  return {
    today: todayIso, todayWeekday: DAYS[today.getDay()], now: nowHM(today),
    next14Days, prev7Days, patients, appointments, monthTotals,
  };
}

function describeDate(isoStr) {
  const d = dateFromIso(isoStr);
  return `${DAY_SHORT[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
}

/** Returns an error string if the action is invalid, or null if it may be applied. */
function validateVoiceAction(db, a) {
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return 'acción inválida';
  const scheduleOk = s => Array.isArray(s) && s.every(sl => sl && Number.isInteger(sl.day) && sl.day >= 0 && sl.day <= 6 && HHMM_RE.test(sl.time));
  switch (a.type) {
    case 'mark_attendance':
      if (!findPatient(db, a.patientId)) return 'paciente inexistente';
      if (!ISO_DATE_RE.test(a.date)) return 'fecha inválida';
      if (a.status !== 'present' && a.status !== 'absent') return 'estado inválido';
      return null;
    case 'reschedule_once':
      if (!findPatient(db, a.patientId)) return 'paciente inexistente';
      if (!ISO_DATE_RE.test(a.fromDate) || !ISO_DATE_RE.test(a.toDate)) return 'fecha inválida';
      if (!HHMM_RE.test(a.toTime)) return 'hora inválida';
      if (!findOccurrence(db, a.patientId, a.fromDate)) return 'no hay sesión en esa fecha';
      return null;
    case 'cancel_once':
      if (!findPatient(db, a.patientId)) return 'paciente inexistente';
      if (!ISO_DATE_RE.test(a.date)) return 'fecha inválida';
      if (!findOccurrence(db, a.patientId, a.date)) return 'no hay sesión en esa fecha';
      return null;
    case 'add_once':
      if (!findPatient(db, a.patientId)) return 'paciente inexistente';
      if (!ISO_DATE_RE.test(a.date)) return 'fecha inválida';
      if (!HHMM_RE.test(a.time)) return 'hora inválida';
      return null;
    case 'add_patient':
      if (typeof a.name !== 'string' || !a.name.trim()) return 'falta el nombre';
      if (!(Number(a.price) >= 0)) return 'precio inválido';
      if (a.schedule !== undefined && !scheduleOk(a.schedule)) return 'horario inválido';
      return null;
    case 'update_patient':
      if (!findPatient(db, a.patientId)) return 'paciente inexistente';
      if (a.price !== undefined && !(Number(a.price) >= 0)) return 'precio inválido';
      if (a.schedule !== undefined && !scheduleOk(a.schedule)) return 'horario inválido';
      if (a.name !== undefined && (typeof a.name !== 'string' || !a.name.trim())) return 'nombre inválido';
      return null;
    case 'deactivate_patient':
      if (!findPatient(db, a.patientId)) return 'paciente inexistente';
      return null;
    default:
      return 'tipo de acción desconocido';
  }
}

function describeVoiceAction(db, a) {
  const p = findPatient(db, a.patientId);
  const name = p ? p.name : '';
  switch (a.type) {
    case 'mark_attendance':
      return `${name}: ${a.status === 'present' ? 'vino' : 'no vino'} el ${describeDate(a.date)}`;
    case 'reschedule_once':
      return `${name}: pasa del ${describeDate(a.fromDate)} al ${describeDate(a.toDate)} ${a.toTime} (solo esta vez)`;
    case 'cancel_once':
      return `${name}: sesión del ${describeDate(a.date)} cancelada`;
    case 'add_once':
      return `${name}: sesión extra el ${describeDate(a.date)} a las ${a.time}`;
    case 'add_patient':
      return `Paciente agregado: ${a.name}`;
    case 'update_patient':
      return `${name}: datos actualizados`;
    case 'deactivate_patient':
      return `${name}: dado de baja`;
    default:
      return '';
  }
}

/** Applies one already-validated voice action to `db` in place. */
function applyVoiceAction(db, a) {
  switch (a.type) {
    case 'mark_attendance': {
      const appt = findOccurrence(db, a.patientId, a.date);
      markAttendance(db, a.patientId, a.date, appt ? appt.time : '', a.status);
      return;
    }
    case 'reschedule_once':
      rescheduleOccurrence(db, a.patientId, a.fromDate, a.toDate, a.toTime);
      return;
    case 'cancel_once':
      cancelOccurrence(db, a.patientId, a.date);
      return;
    case 'add_once':
      addExtraOccurrence(db, a.patientId, a.date, a.time);
      return;
    case 'add_patient':
      db.patients.push({
        id: uid(), name: a.name.trim(), price: Math.round(Number(a.price)),
        schedule: a.schedule || [], active: true, color: nextColor(db), since: iso(new Date()),
      });
      return;
    case 'update_patient': {
      const p = findPatient(db, a.patientId);
      if (a.name !== undefined) p.name = a.name.trim();
      if (a.price !== undefined) p.price = Math.round(Number(a.price));
      if (a.schedule !== undefined) p.schedule = a.schedule;
      return;
    }
    case 'deactivate_patient':
      findPatient(db, a.patientId).active = false;
      return;
  }
}

/** Moves one occurrence to another date/time. Fixed weekly schedule is never touched. */
function rescheduleOccurrence(db, patientId, fromDate, toDate, toTime) {
  const appt = findOccurrence(db, patientId, fromDate);
  if (!appt) return false;
  if (appt.extra) {
    const c = db.changes.find(c => c.kind === 'extra' && c.patientId === patientId && c.date === fromDate && c.time === appt.time);
    if (c) { c.date = toDate; c.time = toTime; return true; }
  }
  if (appt.moved) {
    const c = db.changes.find(c => c.kind === 'move' && c.patientId === patientId && c.toDate === fromDate && c.toTime === appt.time);
    if (c) { c.toDate = toDate; c.toTime = toTime; return true; }
  }
  db.changes.push({ id: uid(), patientId, kind: 'move', date: fromDate, time: appt.time, toDate, toTime });
  return true;
}

/** Cancels one occurrence (does not touch the fixed weekly schedule). */
function cancelOccurrence(db, patientId, date) {
  const appt = findOccurrence(db, patientId, date);
  if (!appt) return false;
  if (appt.extra) {
    db.changes = db.changes.filter(c => !(c.kind === 'extra' && c.patientId === patientId && c.date === date && c.time === appt.time));
    return true;
  }
  if (appt.moved) {
    db.changes = db.changes.filter(c => !(c.kind === 'move' && c.patientId === patientId && c.toDate === date && c.toTime === appt.time));
    return true;
  }
  db.changes.push({ id: uid(), patientId, kind: 'cancel', date, time: appt.time });
  return true;
}

/** Adds an extra (one-off) session for a patient on a date/time outside their usual schedule. */
function addExtraOccurrence(db, patientId, date, time) {
  db.changes.push({ id: uid(), patientId, kind: 'extra', date, time });
}

/** Marks/updates attendance for one occurrence. Price is frozen at the patient's current price. */
function markAttendance(db, patientId, date, time, status) {
  db.attendance = db.attendance.filter(a => !(a.patientId === patientId && a.date === date && a.time === time));
  const p = findPatient(db, patientId);
  const price = status === 'present' ? (p ? p.price : 0) : 0;
  db.attendance.push({ id: uid(), patientId, date, time: time || '', status, price });
}

function unmarkAttendance(db, patientId, date, time) {
  db.attendance = db.attendance.filter(a => !(a.patientId === patientId && a.date === date && a.time === time));
}

function nextColor(db) { return PALETTE[db.patients.length % PALETTE.length]; }

/* ============================================================
   App state, storage, rendering
   ============================================================ */

const app = document.getElementById('app');
const state = {
  view: 'hoy',
  day: startOfDay(new Date()),
  week: mondayOf(new Date()),
  month: firstOfMonth(new Date()),
  editing: null,
};
let db = load();
save(); // persist a v1->v2 migration immediately, so it never has to be redone/re-read as v1

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch {}
  return emptyDb();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { toast('No se pudo guardar en este navegador'); }
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function scheduleText(p) {
  if (!p.schedule.length) return 'Sin horario';
  return [...p.schedule].sort(slotOrder).map(s => `${DAY_SHORT[s.day]} ${s.time}`).join(', ');
}

/* ---------- views ---------- */
function render() {
  document.querySelectorAll('nav.tabs button').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
  ({ hoy: renderHoy, semana: renderSemana, mes: renderMes, pacientes: renderPacientes, cuentas: renderCuentas })[state.view]();
}

/** Ongoing session (within [start, start+sessionMinutes)), or one still unmarked up to
 *  15 minutes after it ended, or otherwise the next appointment still to come today. */
function currentOrNextAppointment(db, isoDate, now) {
  const appts = appointmentsOn(db, isoDate).filter(a => findPatient(db, a.patientId) && a.time);
  const mins = (db.settings && db.settings.sessionMinutes) || DEFAULT_SESSION_MINUTES;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const a of appts) {
    const start = timeToMinutes(a.time);
    const end = start + mins;
    if (nowMin >= start && nowMin < end) return Object.assign({}, a, { phase: 'ongoing' });
    if (nowMin >= end && nowMin < end + 15 && !a.status) return Object.assign({}, a, { phase: 'grace' });
  }
  const upcoming = appts
    .filter(a => timeToMinutes(a.time) > nowMin)
    .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  return upcoming.length ? Object.assign({}, upcoming[0], { phase: 'next' }) : null;
}

function nowCardHtml() {
  if (iso(state.day) !== iso(new Date())) return '';
  const info = currentOrNextAppointment(db, iso(state.day), new Date());
  if (!info) return '';
  const p = findPatient(db, info.patientId);
  if (!p) return '';
  if (info.phase === 'next') {
    return `<div class="next-line">Próximo: ${esc(p.name)} ${info.time}</div>`;
  }
  return `<div class="now-card">
    <div class="now-eyebrow">${info.phase === 'grace' ? 'Todavía sin marcar' : 'Ahora'}</div>
    <div class="now-head">
      <span class="dot" style="background:${p.color}"></span>
      <span class="now-name">${esc(p.name)}</span>
      <span class="now-time">${info.time}</span>
    </div>
    <div class="now-actions">
      <button class="btn-mark big vino" data-act="mark" data-status="present" data-id="${p.id}" data-time="${info.time}">${CHECK}Vino</button>
      <button class="btn-mark big novino" data-act="mark" data-status="absent" data-id="${p.id}" data-time="${info.time}">${XICON}No vino</button>
    </div>
    <button class="btn ghost" data-act="reprogramar" data-id="${p.id}" data-time="${info.time}">Reprogramar</button>
  </div>`;
}

function apptRowHtml(a) {
  const p = findPatient(db, a.patientId);
  if (!p) return '';
  const status = a.status;
  const rowClass = status === 'present' ? 'present' : status === 'absent' ? 'absent' : '';
  const movedBadge = a.moved
    ? `<div class="moved-badge"><span class="moved-pill">Reprogramado</span> antes ${DAY_SHORT[weekdayOf(a.moved.fromDate)]} ${a.moved.fromTime}</div>`
    : '';
  const actionsHtml = !status
    ? `<button class="btn-mark vino" data-act="mark" data-status="present" data-id="${p.id}" data-time="${a.time}">${CHECK}Vino</button>
       <button class="btn-mark novino" data-act="mark" data-status="absent" data-id="${p.id}" data-time="${a.time}">${XICON}No vino</button>`
    : `<span class="chip ${status}">${status === 'present' ? 'Vino' : 'No vino'}</span>
       <button class="btn ghost small" data-act="undo" data-id="${p.id}" data-time="${a.time}">Deshacer</button>`;
  return `<li class="row appt ${rowClass} ${a.moved ? 'moved' : ''}">
    <div class="row-main">
      <span class="dot" style="background:${p.color}"></span>
      <span class="time">${a.time || '—'}</span>
      <span class="who"><span class="name">${esc(p.name)}</span>
        <div class="sub">${moneyFmt(p.price)}</div>${movedBadge}</span>
      <button class="icon-btn" data-act="reprogramar" data-id="${p.id}" data-time="${a.time}" aria-label="Reprogramar a ${esc(p.name)}">${KEBAB}</button>
    </div>
    <div class="row-actions">${actionsHtml}</div>
  </li>`;
}

function renderHoy() {
  const d = state.day, date = iso(d), wd = d.getDay();
  const isToday = date === iso(new Date());
  const active = db.patients.filter(p => p.active);

  const appts = appointmentsOn(db, date).filter(a => findPatient(db, a.patientId));
  const seen = new Set(appts.map(a => a.patientId));
  const daySessions = db.attendance.filter(a => a.date === date && a.status === 'present');
  const dayTotal = daySessions.reduce((t, s) => t + s.price, 0);
  const others = active.filter(p => !seen.has(p.id)).sort(byName);

  let html = `
    <div class="period">
      <button class="arrow" data-act="day" data-step="-1" aria-label="Día anterior">${PREV}</button>
      <h1>${DAYS[wd]} ${d.getDate()}<small>${MONTHS[d.getMonth()]} ${d.getFullYear()}</small></h1>
      <button class="arrow" data-act="day" data-step="1" aria-label="Día siguiente">${NEXT}</button>
    </div>
    ${isToday ? '' : '<button class="today-link" data-act="today">Volver a hoy</button>'}
    ${isToday ? `<div id="now-card-slot">${nowCardHtml()}</div>` : ''}`;

  if (!db.patients.length) {
    html += `<div class="empty">Todavía no hay pacientes.<br>
      <button class="btn primary" data-act="new">Agregar paciente</button></div>`;
  } else {
    if (appts.length) {
      html += '<ul class="list">' + appts.map(apptRowHtml).join('') + '</ul>';
    } else {
      html += '<div class="empty">Nadie tiene turno este día.</div>';
    }

    html += `<div class="day-total"><span>Atendidos ${daySessions.length} de ${appts.length}</span>
      <strong>${moneyFmt(dayTotal)}</strong></div>`;

    if (others.length) {
      html += `<div class="extra">
        <select id="extra-patient" aria-label="Paciente fuera de horario">
          <option value="">Otro paciente…</option>
          ${others.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
        </select>
        <button class="btn" data-act="extra">Sumar</button>
      </div>`;
    }
  }
  app.innerHTML = html;
}

setInterval(() => {
  if (state.view !== 'hoy') return;
  const slot = document.getElementById('now-card-slot');
  if (slot) slot.innerHTML = nowCardHtml();
}, 30000);

function renderSemana() {
  const monday = state.week;
  const days = [0, 1, 2, 3, 4, 5].map(i => addDays(monday, i));
  const sunday = addDays(monday, 6);
  const sundayHasAppts = appointmentsOn(db, iso(sunday)).some(a => findPatient(db, a.patientId));
  if (sundayHasAppts) days.push(sunday);

  const todayIso = iso(new Date());
  const perDay = days.map(d => appointmentsOn(db, iso(d)).filter(a => findPatient(db, a.patientId)));
  const sessionMin = (db.settings && db.settings.sessionMinutes) || DEFAULT_SESSION_MINUTES;

  let minMin = 8 * 60, maxMin = 20 * 60;
  perDay.flat().forEach(a => {
    const start = timeToMinutes(a.time);
    minMin = Math.min(minMin, start);
    maxMin = Math.max(maxMin, start + sessionMin);
  });
  minMin = Math.floor(minMin / 60) * 60;
  maxMin = Math.ceil(maxMin / 60) * 60;
  const totalMin = maxMin - minMin;
  const hours = [];
  for (let m = minMin; m <= maxMin; m += 60) hours.push(m);

  const isCurrentWeek = iso(monday) === iso(mondayOf(new Date()));

  let html = `
    <div class="period">
      <button class="arrow" data-act="week" data-step="-1" aria-label="Semana anterior">${PREV}</button>
      <h1>Semana<small>${monday.getDate()} ${MONTHS[monday.getMonth()]} – ${days[days.length - 1].getDate()} ${MONTHS[days[days.length - 1].getMonth()]}</small></h1>
      <button class="arrow" data-act="week" data-step="1" aria-label="Semana siguiente">${NEXT}</button>
    </div>
    ${isCurrentWeek ? '' : '<button class="today-link" data-act="thisweek">Esta semana</button>'}`;

  html += `<div class="week-grid" style="grid-template-columns:34px repeat(${days.length},1fr)">
    <div class="week-corner"></div>
    ${days.map(d => `<div class="week-daylabel ${iso(d) === todayIso ? 'is-today' : ''}">${DAY_SHORT[d.getDay()]}<br>${d.getDate()}</div>`).join('')}
    <div class="week-axis" style="height:${totalMin}px">
      ${hours.map(m => `<div class="hour-label" style="top:${m - minMin}px">${String(Math.floor(m / 60)).padStart(2, '0')}</div>`).join('')}
    </div>
    ${days.map((d, i) => `<div class="week-col" style="height:${totalMin}px">
      ${hours.map(m => `<div class="hour-line" style="top:${m - minMin}px"></div>`).join('')}
      ${perDay[i].map(a => {
        const p = findPatient(db, a.patientId);
        const top = timeToMinutes(a.time) - minMin;
        const cls = a.status === 'present' ? 'present' : a.status === 'absent' ? 'absent' : '';
        return `<button class="week-block ${cls} ${a.moved ? 'moved' : ''}" data-act="openday" data-date="${iso(d)}"
          style="top:${top}px;height:${sessionMin - 2}px;background:color-mix(in srgb, ${p.color} 22%, var(--surface));border-color:${p.color}"
          aria-label="${esc(p.name)} ${a.time}">${esc(p.name.split(' ')[0])}</button>`;
      }).join('')}
    </div>`).join('')}
  </div>`;

  app.innerHTML = html;
}

function renderMes() {
  const m = state.month;
  const first = firstOfMonth(m);
  const lastOfMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0);
  const startGrid = mondayOf(first);
  const endGrid = addDays(mondayOf(lastOfMonth), 6);
  const days = [];
  for (let c = startGrid; c <= endGrid; c = addDays(c, 1)) days.push(c);

  const todayIso = iso(new Date());
  const isCurrentMonth = m.getFullYear() === new Date().getFullYear() && m.getMonth() === new Date().getMonth();

  let html = `
    <div class="period">
      <button class="arrow" data-act="month" data-step="-1" aria-label="Mes anterior">${PREV}</button>
      <h1 style="text-transform:capitalize">${MONTHS[m.getMonth()]}<small>${m.getFullYear()}</small></h1>
      <button class="arrow" data-act="month" data-step="1" aria-label="Mes siguiente">${NEXT}</button>
    </div>
    ${isCurrentMonth ? '' : '<button class="today-link" data-act="thismonth">Este mes</button>'}
    <div class="month-weekdays">${DAY_SHORT.slice(1).concat(DAY_SHORT[0]).map(l => `<div>${l[0]}</div>`).join('')}</div>
    <div class="month-grid">`;

  html += days.map(d => {
    const dISO = iso(d);
    const appts = appointmentsOn(db, dISO).filter(a => findPatient(db, a.patientId));
    const dots = appts.slice(0, 4);
    const extra = appts.length > 4 ? appts.length - 4 : 0;
    const allDone = appts.length > 0 && appts.every(a => a.status);
    const cls = [
      d.getMonth() !== m.getMonth() ? 'dim' : '',
      dISO === todayIso ? 'is-today' : '',
      allDone ? 'all-done' : '',
    ].filter(Boolean).join(' ');
    return `<button class="month-cell ${cls}" data-act="openday" data-date="${dISO}">
      <span class="month-daynum">${d.getDate()}</span>
      ${appts.length ? `<span class="month-dots">${dots.map(a => `<span class="dot" style="background:${findPatient(db, a.patientId).color}"></span>`).join('')}${extra ? `<span class="month-more">+${extra}</span>` : ''}</span>` : ''}
    </button>`;
  }).join('');

  html += '</div>';
  app.innerHTML = html;
}

function renderPacientes() {
  const active = db.patients.filter(p => p.active).sort(byName);
  const archived = db.patients.filter(p => !p.active).sort(byName);

  let html = `<div class="period" style="justify-content:center"><h1>Pacientes</h1></div>
    <button class="btn primary wide" data-act="new">Agregar paciente</button>
    <div style="height:16px"></div>`;

  if (active.length) {
    html += '<ul class="list">' + active.map(p => `<li>
      <button class="row" data-act="edit" data-id="${p.id}">
        <span class="who"><span class="name">${esc(p.name)}</span>
          <div class="sub">${scheduleText(p)}</div></span>
        <span class="amount">${moneyFmt(p.price)}</span>
      </button></li>`).join('') + '</ul>';
  } else {
    html += '<div class="empty">Todavía no hay pacientes.</div>';
  }

  if (archived.length) {
    html += `<details class="archived"><summary>Dados de baja (${archived.length})</summary>
      <ul class="list">${archived.map(p => `<li class="row">
        <span class="who"><span class="name">${esc(p.name)}</span></span>
        <button class="btn" data-act="restore" data-id="${p.id}">Reactivar</button>
      </li>`).join('')}</ul></details>`;
  }

  html += `<div class="backup">
    <button class="btn ghost" data-act="export">Descargar copia</button>
    <button class="btn ghost" data-act="import">Cargar copia</button>
  </div>
  <div class="settings-line">
    <label class="inline">Duración de sesión (minutos)
      <input type="number" id="session-minutes" min="5" step="5" value="${db.settings.sessionMinutes}">
    </label>
  </div>`;
  app.innerHTML = html;
}

function renderCuentas() {
  const m = state.month;
  const prefix = iso(m).slice(0, 7);
  const present = db.attendance.filter(a => a.date.startsWith(prefix) && a.status === 'present');
  const absentCount = db.attendance.filter(a => a.date.startsWith(prefix) && a.status === 'absent').length;
  const total = present.reduce((t, s) => t + s.price, 0);

  const perPatient = new Map();
  for (const s of present) {
    const e = perPatient.get(s.patientId) || { days: [], total: 0 };
    e.days.push(Number(s.date.slice(8)));
    e.total += s.price;
    perPatient.set(s.patientId, e);
  }
  const rows = [...perPatient.entries()]
    .map(([id, e]) => ({ p: findPatient(db, id) || { name: 'Paciente eliminado' }, ...e }))
    .sort((a, b) => byName(a.p, b.p));

  let html = `
    <div class="period">
      <button class="arrow" data-act="month" data-step="-1" aria-label="Mes anterior">${PREV}</button>
      <h1 style="text-transform:capitalize">${MONTHS[m.getMonth()]}<small>${m.getFullYear()}</small></h1>
      <button class="arrow" data-act="month" data-step="1" aria-label="Mes siguiente">${NEXT}</button>
    </div>
    <div class="big"><span class="num">${moneyFmt(total)}</span>
      <div class="sub">${present.length} ${present.length === 1 ? 'sesión' : 'sesiones'}${absentCount ? `, ${absentCount} ${absentCount === 1 ? 'ausencia' : 'ausencias'}` : ''}</div></div>`;

  if (rows.length) {
    html += '<ul class="list">' + rows.map(r => `<li class="row">
      <span class="who"><span class="name">${esc(r.p.name)}</span>
        <div class="sub">${r.days.length} ${r.days.length === 1 ? 'sesión' : 'sesiones'}: ${r.days.sort((a, b) => a - b).join(', ')}</div></span>
      <span class="amount">${moneyFmt(r.total)}</span>
    </li>`).join('') + '</ul>';
  } else {
    html += '<div class="empty">No hay sesiones este mes.</div>';
  }
  app.innerHTML = html;
}

/* ---------- editor ---------- */
const editor = document.getElementById('editor');
const form = document.getElementById('editor-form');
const slotsEl = document.getElementById('slots');

function slotRow(slot = { day: 1, time: '16:00' }) {
  const div = document.createElement('div');
  div.className = 'slot';
  div.innerHTML = `
    <select aria-label="Día">${[1, 2, 3, 4, 5, 6, 0].map(d =>
      `<option value="${d}" ${d === slot.day ? 'selected' : ''}>${DAYS[d]}</option>`).join('')}</select>
    <input type="time" value="${slot.time}" required aria-label="Hora">
    <button type="button" class="x" aria-label="Quitar horario">×</button>`;
  div.querySelector('.x').onclick = () => div.remove();
  slotsEl.append(div);
}

function openEditor(p) {
  state.editing = p ? p.id : null;
  document.getElementById('editor-title').textContent = p ? 'Editar paciente' : 'Nuevo paciente';
  form.elements.patientName.value = p ? p.name : '';
  form.elements.price.value = p ? p.price : '';
  slotsEl.innerHTML = '';
  (p ? p.schedule : [undefined]).forEach(s => slotRow(s));
  document.getElementById('remove').hidden = !p;
  editor.showModal();
  if (!p) form.elements.patientName.focus();
}

document.getElementById('add-slot').onclick = () => slotRow();
document.getElementById('cancel').onclick = () => editor.close();
document.getElementById('remove').onclick = () => {
  const p = findPatient(db, state.editing);
  if (!p) return;
  if (!confirm(`¿Dar de baja a ${p.name}? Sus sesiones quedan en las cuentas.`)) return;
  p.active = false; save(); editor.close(); render(); toast('Dado de baja');
};

form.addEventListener('submit', e => {
  e.preventDefault();
  const name = form.elements.patientName.value.trim();
  const price = Math.round(Number(form.elements.price.value));
  if (!name || !(price >= 0)) return;
  const schedule = [...slotsEl.querySelectorAll('.slot')]
    .map(r => ({ day: Number(r.querySelector('select').value), time: r.querySelector('input').value }))
    .filter(s => s.time);

  const existing = findPatient(db, state.editing);
  if (existing) Object.assign(existing, { name, price, schedule });
  else db.patients.push({ id: uid(), name, price, schedule, active: true, color: nextColor(db), since: iso(new Date()) });
  save(); editor.close(); render();
  toast(existing ? 'Cambios guardados' : 'Paciente agregado');
});

/* ---------- actions ---------- */
app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  const date = iso(state.day);

  if (act === 'mark') {
    markAttendance(db, id, date, el.dataset.time || '', el.dataset.status);
    save(); render();
  } else if (act === 'undo') {
    unmarkAttendance(db, id, date, el.dataset.time || '');
    save(); render();
  } else if (act === 'reprogramar') {
    openReschedule(id, date, el.dataset.time || '');
  } else if (act === 'extra') {
    const pid = document.getElementById('extra-patient').value;
    if (!pid) return;
    const time = nowHM(new Date());
    addExtraOccurrence(db, pid, date, time);
    markAttendance(db, pid, date, time, 'present');
    save(); render();
  } else if (act === 'day') {
    state.day = addDays(state.day, Number(el.dataset.step));
    render();
  } else if (act === 'today') {
    state.day = startOfDay(new Date()); render();
  } else if (act === 'week') {
    state.week = addDays(state.week, 7 * Number(el.dataset.step));
    render();
  } else if (act === 'thisweek') {
    state.week = mondayOf(new Date()); render();
  } else if (act === 'month') {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + Number(el.dataset.step), 1);
    render();
  } else if (act === 'thismonth') {
    state.month = firstOfMonth(new Date()); render();
  } else if (act === 'openday') {
    state.day = dateFromIso(el.dataset.date);
    state.view = 'hoy';
    render();
  } else if (act === 'new') {
    openEditor(null);
  } else if (act === 'edit') {
    openEditor(findPatient(db, id));
  } else if (act === 'restore') {
    findPatient(db, id).active = true; save(); render(); toast('Paciente reactivado');
  } else if (act === 'export') {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `consultorio-${iso(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else if (act === 'import') {
    document.getElementById('import-file').click();
  }
});

document.getElementById('import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const migrated = migrate(data);
    if (!Array.isArray(migrated.patients)) throw new Error();
    if (!confirm('Esto reemplaza todos los datos actuales por los de la copia. ¿Seguir?')) return;
    db = migrated; save(); render(); toast('Copia cargada');
  } catch {
    toast('Ese archivo no es una copia válida');
  }
});

document.querySelector('nav.tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  state.view = b.dataset.view; render();
});

app.addEventListener('change', e => {
  if (e.target.id === 'session-minutes') {
    const v = Math.max(5, Math.round(Number(e.target.value)) || DEFAULT_SESSION_MINUTES);
    db.settings.sessionMinutes = v;
    save();
  }
});

/* ---------- reschedule sheet ---------- */
const reschedule = document.getElementById('reschedule');
const rescheduleForm = document.getElementById('reschedule-form');
let rescheduleCtx = null; // { patientId, date, time }

function openReschedule(patientId, date, time) {
  rescheduleCtx = { patientId, date, time };
  const p = findPatient(db, patientId);
  document.getElementById('reschedule-who').textContent =
    `${p ? p.name : ''} (${DAY_SHORT[weekdayOf(date)]} ${time || ''})`;
  document.getElementById('reschedule-once-fields').hidden = true;
  document.getElementById('reschedule-confirm').hidden = true;
  rescheduleForm.elements.toDate.value = date;
  rescheduleForm.elements.toTime.value = time || '';
  reschedule.showModal();
}

reschedule.addEventListener('click', e => {
  const choice = e.target.closest('[data-choice]');
  if (!choice || !rescheduleCtx) return;
  if (choice.dataset.choice === 'once') {
    document.getElementById('reschedule-once-fields').hidden = false;
    document.getElementById('reschedule-confirm').hidden = false;
  } else if (choice.dataset.choice === 'cancel') {
    if (!confirm('¿Cancelar esta sesión?')) return;
    cancelOccurrence(db, rescheduleCtx.patientId, rescheduleCtx.date);
    save(); reschedule.close(); render(); toast('Sesión cancelada');
  } else if (choice.dataset.choice === 'fixed') {
    const p = findPatient(db, rescheduleCtx.patientId);
    reschedule.close();
    openEditor(p);
  }
});
document.getElementById('reschedule-cancel').onclick = () => reschedule.close();
rescheduleForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!rescheduleCtx) return;
  const toDate = rescheduleForm.elements.toDate.value;
  const toTime = rescheduleForm.elements.toTime.value;
  if (!ISO_DATE_RE.test(toDate) || !HHMM_RE.test(toTime)) { toast('Fecha u hora inválida'); return; }
  rescheduleOccurrence(db, rescheduleCtx.patientId, rescheduleCtx.date, toDate, toTime);
  save(); reschedule.close(); render(); toast('Sesión reprogramada');
});

/* ---------- voice sheet ---------- */
const voiceSheet = document.getElementById('voice-sheet');
const voiceMicBtn = document.getElementById('voice-mic-btn');
const voiceStatusEl = document.getElementById('voice-status');
const voiceTranscriptEl = document.getElementById('voice-transcript');
const voiceTextForm = document.getElementById('voice-text-form');
const voiceTextInput = document.getElementById('voice-text-input');
const voiceResultEl = document.getElementById('voice-result');

let recognition = null;
let recognizing = false;
let undoSnapshot = null;

function speechSupported() {
  return !!(window.isSecureContext && (window.SpeechRecognition || window.webkitSpeechRecognition));
}

function stopListening() {
  if (recognition && recognizing) { try { recognition.stop(); } catch {} }
}

function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'es-AR';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognizing = true;
  voiceMicBtn.classList.add('listening');
  voiceStatusEl.textContent = 'Escuchando…';
  recognition.onresult = e => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    voiceTranscriptEl.textContent = text;
  };
  recognition.onerror = () => {
    voiceStatusEl.textContent = 'No se entendió. Probá de nuevo o escribí abajo.';
  };
  recognition.onend = () => {
    recognizing = false;
    voiceMicBtn.classList.remove('listening');
    voiceStatusEl.textContent = '';
    const text = voiceTranscriptEl.textContent.trim();
    if (text) submitVoiceText(text);
  };
  try { recognition.start(); }
  catch { recognizing = false; voiceMicBtn.classList.remove('listening'); voiceStatusEl.textContent = 'No se pudo iniciar el micrófono.'; }
}

function openVoiceSheet() {
  voiceResultEl.innerHTML = '';
  voiceTranscriptEl.textContent = '';
  voiceTextInput.value = '';
  voiceStatusEl.textContent = '';
  voiceSheet.showModal();
  if (speechSupported()) startListening();
  else voiceStatusEl.textContent = 'Sin reconocimiento de voz en este navegador: escribí abajo.';
}

async function submitVoiceText(text) {
  stopListening();
  voiceResultEl.innerHTML = '<p class="muted">Pensando…</p>';
  const context = buildVoiceContext(db);
  let data;
  try {
    const res = await fetch('/api/voice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, context }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      voiceResultEl.innerHTML = `<p class="voice-error">${esc(body.error || 'No se pudo conectar con el asistente.')}</p>`;
      return;
    }
    data = body;
  } catch {
    voiceResultEl.innerHTML = '<p class="voice-error">No se pudo conectar con el asistente.</p>';
    return;
  }
  applyVoiceResult(data);
}

function applyVoiceResult(data) {
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const reply = typeof data.reply === 'string' ? data.reply : '';
  const done = [];
  const failed = [];
  const snapshot = JSON.parse(JSON.stringify(db));
  for (const a of actions) {
    const err = validateVoiceAction(db, a);
    if (err) { failed.push(err); continue; }
    done.push(describeVoiceAction(db, a));
    applyVoiceAction(db, a);
  }
  if (done.length) { undoSnapshot = snapshot; save(); render(); }

  let html = '';
  if (reply) html += `<p class="voice-reply">${esc(reply)}</p>`;
  if (done.length) {
    html += '<ul class="voice-done">' + done.map(d => `<li>${esc(d)}</li>`).join('') + '</ul>';
    html += '<button type="button" class="btn" id="voice-undo">Deshacer</button>';
  }
  if (failed.length) {
    html += '<ul class="voice-invalid">' + failed.map(e => `<li>No hecho: ${esc(e)}</li>`).join('') + '</ul>';
  }
  if (!done.length && !failed.length && !reply) html = '<p class="muted">No entendí ninguna acción.</p>';
  voiceResultEl.innerHTML = html;
  const undoBtn = document.getElementById('voice-undo');
  if (undoBtn) undoBtn.onclick = () => {
    db = undoSnapshot; undoSnapshot = null; save(); render();
    voiceResultEl.innerHTML = '<p class="muted">Deshecho.</p>';
  };
}

document.getElementById('mic-fab').addEventListener('click', openVoiceSheet);
document.getElementById('voice-close').addEventListener('click', () => { stopListening(); voiceSheet.close(); });
voiceSheet.addEventListener('close', stopListening);
voiceMicBtn.addEventListener('click', () => {
  if (recognizing) stopListening();
  else if (speechSupported()) startListening();
});
voiceTextForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = voiceTextInput.value.trim();
  if (!text) return;
  voiceTextInput.value = '';
  voiceTranscriptEl.textContent = text;
  submitVoiceText(text);
});

render();
