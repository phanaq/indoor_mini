const EVENT_TYPES = [
  'signup',
  'cancel',
  'promoted',
  'demoted',
  'paid',
  'unpaid',
  'refund_owed',
  'refunded',
  'refund_voided',
  'threshold_changed',
  'attended',
  'no_show',
  'attendance_cleared',
  'admin_removed',
];

function addEvent(state, { now, type, actor, email = null, name = null, dateId = null, category = null, details = {} }) {
  const date = dateId && state.dates.find((d) => d.id === dateId);
  const last = state.events[state.events.length - 1];
  const event = {
    id: last ? last.id + 1 : 1,
    ts: new Date(now).toISOString(),
    type,
    actor,
    email,
    name: name ?? (email && state.players[email] ? state.players[email].name : email),
    dateId,
    category,
    details: { ...(date ? { dateLabel: date.label } : {}), ...details },
  };
  state.events.push(event);
  return event;
}

module.exports = { EVENT_TYPES, addEvent };
