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

/* ============================================================
   Pure data-model helpers (T1). No DOM access below this block.
   ============================================================ */

function moneyFmt(n) { return '$' + money.format(Math.round(n || 0)); }

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
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
const state = { view: 'hoy', day: startOfDay(new Date()), month: firstOfMonth(new Date()), editing: null };
let db = load();

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
  ({ hoy: renderHoy, pacientes: renderPacientes, cuentas: renderCuentas })[state.view]();
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
    ${isToday ? '' : '<button class="today-link" data-act="today">Volver a hoy</button>'}`;

  if (!db.patients.length) {
    html += `<div class="empty">Todavía no hay pacientes.<br>
      <button class="btn primary" data-act="new">Agregar paciente</button></div>`;
  } else {
    if (appts.length) {
      html += '<ul class="list">' + appts.map(a => {
        const p = findPatient(db, a.patientId);
        const present = a.status === 'present';
        return `<li class="row ${present ? 'present' : ''}">
          <span class="time">${a.time || '—'}</span>
          <span class="who"><span class="name">${esc(p.name)}</span>
            <div class="sub">${moneyFmt(p.price)}</div></span>
          <button class="check" data-act="toggle" data-id="${p.id}" data-time="${a.time}"
            aria-pressed="${present}" aria-label="${present ? 'Quitar presente de' : 'Marcar presente a'} ${esc(p.name)}">${CHECK}</button>
        </li>`;
      }).join('') + '</ul>';
    } else {
      html += '<div class="empty">Nadie tiene turno este día.</div>';
    }

    if (daySessions.length) {
      html += `<div class="day-total"><span>${daySessions.length} ${daySessions.length === 1 ? 'sesión' : 'sesiones'}</span>
        <strong>${moneyFmt(dayTotal)}</strong></div>`;
    }

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
      <div class="sub">${present.length} ${present.length === 1 ? 'sesión' : 'sesiones'}${absentCount ? ` · ${absentCount} ${absentCount === 1 ? 'ausencia' : 'ausencias'}` : ''}</div></div>`;

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

  if (act === 'toggle') {
    const time = el.dataset.time || '';
    const already = appointmentsOn(db, date).find(a => a.patientId === id && a.time === time && a.status === 'present');
    if (already) unmarkAttendance(db, id, date, time);
    else markAttendance(db, id, date, time, 'present');
    save(); render();
  } else if (act === 'extra') {
    const pid = document.getElementById('extra-patient').value;
    if (!pid) return;
    markAttendance(db, pid, date, '', 'present');
    save(); render();
  } else if (act === 'day') {
    state.day = addDays(state.day, Number(el.dataset.step));
    render();
  } else if (act === 'today') {
    state.day = startOfDay(new Date()); render();
  } else if (act === 'month') {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + Number(el.dataset.step), 1);
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

render();
