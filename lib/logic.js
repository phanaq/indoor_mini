const crypto = require('node:crypto');
const { formatDateLabel } = require('./store');
const { addEvent } = require('./events');
const { hoursBeforeGame } = require('./gametime');
const {
  ValidationError,
  CATEGORIES,
  parseThreshold,
  parseFee,
  parseIsoDate,
  parseLabel,
} = require('./validate');

const iso = (now) => new Date(now).toISOString();

function findDate(state, dateId) {
  const date = state.dates.find((d) => d.id === dateId);
  if (!date) throw new ValidationError('Unknown date', 404);
  return date;
}

function orderedRegistrations(state, dateId, category) {
  return state.registrations
    .map((reg, index) => ({ reg, index }))
    .filter((x) => x.reg.date === dateId && x.reg.category === category)
    .sort((a, b) => {
      if (a.reg.signedUpAt !== b.reg.signedUpAt) return a.reg.signedUpAt < b.reg.signedUpAt ? -1 : 1;
      return a.index - b.index;
    })
    .map((x) => x.reg);
}

// Status is derived from FIFO order and the current threshold; it is never stored.
function computeRoster(state, date) {
  const out = {};
  for (const category of CATEGORIES) {
    const threshold = date[category.toLowerCase()];
    const ordered = orderedRegistrations(state, date.id, category);
    out[category] = {
      threshold,
      confirmed: ordered.slice(0, threshold),
      waitlist: ordered.slice(threshold),
    };
  }
  return out;
}

function statusOf(state, dateId, email) {
  const date = findDate(state, dateId);
  const roster = computeRoster(state, date);
  for (const category of CATEGORIES) {
    const { confirmed, waitlist } = roster[category];
    if (confirmed.some((r) => r.email === email)) return { status: 'confirmed', category };
    const idx = waitlist.findIndex((r) => r.email === email);
    if (idx !== -1) return { status: 'waitlist', position: idx + 1, category };
  }
  return null;
}

function snapshotStatuses(state, dateIds) {
  const out = new Map();
  for (const dateId of dateIds) {
    const date = state.dates.find((d) => d.id === dateId);
    if (!date) continue;
    const roster = computeRoster(state, date);
    for (const category of CATEGORIES) {
      const { confirmed, waitlist } = roster[category];
      confirmed.forEach((r) => out.set(`${dateId}\n${r.email}`, { dateId, email: r.email, category, status: 'confirmed' }));
      waitlist.forEach((r) => out.set(`${dateId}\n${r.email}`, { dateId, email: r.email, category, status: 'waitlist' }));
    }
  }
  return out;
}

// Only people present before and after count, so the actor's own signup/removal never shows up as a promotion.
function emitStatusChanges(state, before, after, { now, actor, cause }) {
  for (const [key, a] of after) {
    const b = before.get(key);
    if (!b || b.status === a.status) continue;
    addEvent(state, {
      now,
      type: a.status === 'confirmed' ? 'promoted' : 'demoted',
      actor,
      email: a.email,
      dateId: a.dateId,
      category: a.category,
      details: { from: b.status, to: a.status, cause },
    });
  }
}

function register(state, { email, dateId, now }) {
  const date = findDate(state, dateId);
  const player = state.players[email];
  if (!player) throw new ValidationError('Unknown player', 404);

  const existing = state.registrations.find((r) => r.email === email && r.date === date.id);
  if (existing) return { registration: existing, created: false, creditApplied: null };

  const registration = {
    email,
    date: date.id,
    category: player.category,
    signedUpAt: iso(now),
    paid: false,
    attendance: null,
  };

  // A still-owed refund for this date is cancelled out by the new signup instead of paid out.
  const refund = state.refunds.find((r) => r.email === email && r.date === date.id && r.status === 'owed');
  if (refund) {
    refund.status = 'voided';
    refund.voidedAt = iso(now);
    registration.paid = true;
    registration.paidAmount = refund.amount;
  }

  const before = snapshotStatuses(state, [date.id]);
  state.registrations.push(registration);
  const placed = statusOf(state, date.id, email);
  addEvent(state, {
    now,
    type: 'signup',
    actor: 'player',
    email,
    dateId: date.id,
    category: registration.category,
    details: { status: placed.status, ...(placed.position ? { position: placed.position } : {}), creditApplied: !!refund },
  });
  if (refund) {
    addEvent(state, {
      now,
      type: 'refund_voided',
      actor: 'player',
      email,
      dateId: date.id,
      category: registration.category,
      details: { refundId: refund.id, amount: refund.amount },
    });
  }
  emitStatusChanges(state, before, snapshotStatuses(state, [date.id]), { now, actor: 'player', cause: 'signup' });
  return { registration, created: true, creditApplied: refund || null };
}

function cancelRegistration(state, { email, dateId, now, actor, cause }, trackStatus) {
  const idx = state.registrations.findIndex((r) => r.email === email && r.date === dateId);
  if (idx === -1) return { registration: null, refund: null };
  const before = trackStatus ? snapshotStatuses(state, [dateId]) : null;
  const [registration] = state.registrations.splice(idx, 1);
  const date = state.dates.find((d) => d.id === dateId);
  const timing = date ? hoursBeforeGame(state.settings, date.date, now) : { hoursBeforeGame: null, late: false };
  const base = { now, actor, email, dateId, category: registration.category };
  if (actor === 'admin') {
    addEvent(state, { ...base, type: 'admin_removed', details: { hoursBeforeGame: timing.hoursBeforeGame, wasPaid: registration.paid, cause } });
  } else {
    addEvent(state, { ...base, type: 'cancel', details: { ...timing, wasPaid: registration.paid } });
  }
  let refund = null;
  if (registration.paid) {
    refund = {
      id: state.nextRefundId++,
      email,
      name: state.players[email] ? state.players[email].name : email,
      date: dateId,
      dateLabel: date ? date.label : dateId,
      amount: registration.paidAmount ?? (date ? date.fee : 0),
      status: 'owed',
      createdAt: iso(now),
    };
    state.refunds.push(refund);
    addEvent(state, { ...base, type: 'refund_owed', details: { refundId: refund.id, amount: refund.amount } });
  }
  if (trackStatus) emitStatusChanges(state, before, snapshotStatuses(state, [dateId]), { now, actor, cause });
  return { registration, refund };
}

function cancel(state, { email, dateId, now, actor = 'player' }) {
  return cancelRegistration(state, { email, dateId, now, actor, cause: actor === 'admin' ? 'admin_removed' : 'cancel' }, true);
}

function setPaid(state, { email, dateId, paid, now = Date.now() }) {
  const date = findDate(state, dateId);
  const reg = state.registrations.find((r) => r.email === email && r.date === dateId);
  if (!reg) throw new ValidationError('Registration not found', 404);
  const changed = reg.paid !== !!paid;
  reg.paid = !!paid;
  if (reg.paid) reg.paidAmount = date.fee;
  else delete reg.paidAmount;
  if (changed) {
    addEvent(state, {
      now,
      type: reg.paid ? 'paid' : 'unpaid',
      actor: 'admin',
      email,
      dateId,
      category: reg.category,
      details: reg.paid ? { amount: date.fee } : {},
    });
  }
  return reg;
}

const ATTENDANCE = [null, 'attended', 'no_show'];

// Clearing is allowed on any registration so a mark can't get stuck after a demotion; setting needs a confirmed spot.
function setAttendance(state, { email, dateId, attendance, now = Date.now() }) {
  if (!ATTENDANCE.includes(attendance)) throw new ValidationError("attendance must be 'attended', 'no_show' or null");
  findDate(state, dateId);
  const reg = state.registrations.find((r) => r.email === email && r.date === dateId);
  if (!reg) throw new ValidationError('Registration not found', 404);
  if (attendance !== null && statusOf(state, dateId, email).status !== 'confirmed') {
    throw new ValidationError('Attendance can only be set for confirmed registrations', 409);
  }
  const previous = reg.attendance ?? null;
  if (previous === attendance) return reg;
  reg.attendance = attendance;
  addEvent(state, {
    now,
    type: attendance ?? 'attendance_cleared',
    actor: 'admin',
    email,
    dateId,
    category: reg.category,
    details: attendance ? {} : { previous },
  });
  return reg;
}

function markRefunded(state, id, now) {
  const refund = state.refunds.find((r) => r.id === id);
  if (!refund) throw new ValidationError('Refund not found', 404);
  if (refund.status !== 'owed') throw new ValidationError('Refund is not owed', 409);
  refund.status = 'refunded';
  refund.refundedAt = iso(now);
  addEvent(state, {
    now,
    type: 'refunded',
    actor: 'admin',
    email: refund.email,
    name: refund.name,
    dateId: refund.date,
    details: { refundId: refund.id, amount: refund.amount, dateLabel: refund.dateLabel },
  });
  return refund;
}

function owedRefundCount(state) {
  return state.refunds.filter((r) => r.status === 'owed').length;
}

function parseGameType(value) {
  if (value !== 'mixed' && value !== 'wmp_only') throw new ValidationError('Game type must be mixed or wmp_only');
  return value;
}

function addDate(state, input) {
  const date = parseIsoDate(input.date);
  if (state.dates.some((d) => d.date === date)) throw new ValidationError('That date already exists', 409);
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    date,
    label: input.label ? parseLabel(input.label) || formatDateLabel(date) : formatDateLabel(date),
    mmp: parseThreshold(input.mmp ?? 10, 'MMP'),
    wmp: parseThreshold(input.wmp ?? 10, 'WMP'),
    fee: parseFee(input.fee ?? 10),
    gameType: parseGameType(input.gameType ?? 'mixed'),
  };
  state.dates.push(entry);
  state.dates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return entry;
}

function updateDate(state, dateId, patch, now = Date.now()) {
  const entry = findDate(state, dateId);
  const before = snapshotStatuses(state, [entry.id]);
  const thresholds = { MMP: entry.mmp, WMP: entry.wmp };
  if ('date' in patch) {
    const date = parseIsoDate(patch.date);
    if (state.dates.some((d) => d.id !== entry.id && d.date === date)) {
      throw new ValidationError('That date already exists', 409);
    }
    entry.date = date;
  }
  if ('label' in patch) entry.label = parseLabel(patch.label) || formatDateLabel(entry.date);
  if ('mmp' in patch) entry.mmp = parseThreshold(patch.mmp, 'MMP');
  if ('wmp' in patch) entry.wmp = parseThreshold(patch.wmp, 'WMP');
  if ('fee' in patch) entry.fee = parseFee(patch.fee);
  if ('gameType' in patch) entry.gameType = parseGameType(patch.gameType);
  state.dates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const category of CATEGORIES) {
    const to = entry[category.toLowerCase()];
    if (to === thresholds[category]) continue;
    addEvent(state, { now, type: 'threshold_changed', actor: 'admin', dateId: entry.id, category, details: { from: thresholds[category], to } });
  }
  emitStatusChanges(state, before, snapshotStatuses(state, [entry.id]), { now, actor: 'admin', cause: 'threshold_changed' });
  return entry;
}

// Removing a date cancels its registrations, so paid ones generate owed refunds.
function removeDate(state, dateId, now) {
  findDate(state, dateId);
  const refunds = [];
  for (const reg of state.registrations.filter((r) => r.date === dateId)) {
    const { refund } = cancelRegistration(state, { email: reg.email, dateId, now, actor: 'admin', cause: 'date_removed' }, false);
    if (refund) refunds.push(refund);
  }
  state.dates = state.dates.filter((d) => d.id !== dateId);
  return refunds;
}

function adminRows(state, date) {
  const roster = computeRoster(state, date);
  const out = {};
  for (const category of CATEGORIES) {
    const { threshold, confirmed, waitlist } = roster[category];
    const row = (reg, status, position) => ({
      email: reg.email,
      name: state.players[reg.email] ? state.players[reg.email].name : reg.email,
      category,
      status,
      position,
      paid: reg.paid,
      attendance: reg.attendance ?? null,
      signedUpAt: reg.signedUpAt,
      warning: status === 'waitlist' && reg.paid,
    });
    out[category] = {
      threshold,
      rows: [
        ...confirmed.map((r) => row(r, 'confirmed')),
        ...waitlist.map((r, i) => row(r, 'waitlist', i + 1)),
      ],
    };
  }
  return out;
}

// Attendance is the latest mark per player and date; a signup, cancel or removal resets it with the registration.
function playerSummaries(state) {
  const rows = new Map();
  const blank = (email, name, category) => ({ email, name, category, signups: 0, cancels: 0, lateCancels: 0, noShows: 0, attended: 0 });
  for (const p of Object.values(state.players)) rows.set(p.email, blank(p.email, p.name, p.category));
  const marks = new Map();
  for (const e of state.events) {
    if (!e.email) continue;
    if (!rows.has(e.email)) rows.set(e.email, blank(e.email, e.name, e.category));
    const row = rows.get(e.email);
    if (e.type === 'signup') {
      row.signups += 1;
      marks.delete(`${e.dateId}\n${e.email}`);
    } else if (e.type === 'cancel' || e.type === 'admin_removed') {
      marks.delete(`${e.dateId}\n${e.email}`);
      if (e.type === 'cancel') row.cancels += 1;
      if (e.details && e.details.late) row.lateCancels += 1;
    } else if (e.type === 'attended' || e.type === 'no_show' || e.type === 'attendance_cleared') {
      marks.set(`${e.dateId}\n${e.email}`, { email: e.email, type: e.type });
    }
  }
  for (const { email, type } of marks.values()) {
    if (type === 'attended') rows.get(email).attended += 1;
    else if (type === 'no_show') rows.get(email).noShows += 1;
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

module.exports = {
  findDate,
  computeRoster,
  statusOf,
  register,
  cancel,
  setPaid,
  setAttendance,
  playerSummaries,
  markRefunded,
  owedRefundCount,
  addDate,
  updateDate,
  removeDate,
  adminRows,
};
