const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const logic = require('../lib/logic');
const v = require('../lib/validate');
const { gameStartMs, hoursBeforeGame } = require('../lib/gametime');

const DATE = '2026-11-18';
let clock;
const tick = () => (clock += 1000);

function setup(thresholds = {}) {
  clock = Date.UTC(2026, 10, 1);
  const state = store.defaultState();
  Object.assign(state.dates.find((d) => d.id === DATE), thresholds);
  return state;
}

function addPlayer(state, name, category = 'MMP') {
  const email = `${name.toLowerCase()}@example.com`;
  state.players[email] = { email, name, category };
  return email;
}

const signUp = (state, email) => logic.register(state, { email, dateId: DATE, now: tick() });
const drop = (state, email, actor) => logic.cancel(state, { email, dateId: DATE, now: tick(), actor });
const types = (state) => state.events.map((e) => [e.type, e.email]);

test('signup emits an event with the full shape', () => {
  const state = setup({ mmp: 1 });
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  signUp(state, a);
  signUp(state, b);
  signUp(state, b);
  assert.equal(state.events.length, 2);
  const [first, second] = state.events;
  assert.deepEqual(Object.keys(first), ['id', 'ts', 'type', 'actor', 'email', 'name', 'dateId', 'category', 'details']);
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(first.type, 'signup');
  assert.equal(first.actor, 'player');
  assert.equal(first.name, 'A');
  assert.equal(first.dateId, DATE);
  assert.equal(first.category, 'MMP');
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(first.details.status, 'confirmed');
  assert.deepEqual([second.details.status, second.details.position], ['waitlist', 1]);
});

test('cancel records timing and promotes the next waitlisted player, not the canceller', () => {
  const state = setup({ mmp: 1 });
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  signUp(state, a);
  signUp(state, b);
  state.events.length = 0;
  drop(state, a);
  assert.deepEqual(types(state), [['cancel', a], ['promoted', b]]);
  const [cancel, promoted] = state.events;
  assert.equal(typeof cancel.details.hoursBeforeGame, 'number');
  assert.equal(cancel.details.late, false);
  assert.equal(promoted.actor, 'player');
  assert.deepEqual([promoted.details.from, promoted.details.to], ['waitlist', 'confirmed']);
});

test('threshold changes emit threshold_changed plus promoted and demoted for others', () => {
  const state = setup({ mmp: 3 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => addPlayer(state, n));
  [a, b, c].forEach((e) => signUp(state, e));
  state.events.length = 0;
  logic.updateDate(state, DATE, { mmp: 1 }, tick());
  assert.deepEqual(types(state), [['threshold_changed', null], ['demoted', b], ['demoted', c]]);
  assert.deepEqual(state.events[0].details, { dateLabel: state.dates[0].label, from: 3, to: 1 });
  assert.equal(state.events[0].category, 'MMP');
  assert.equal(state.events[1].actor, 'admin');
  state.events.length = 0;
  logic.updateDate(state, DATE, { mmp: 2, fee: 12 }, tick());
  assert.deepEqual(types(state), [['threshold_changed', null], ['promoted', b]]);
});

test('admin removal is logged as admin_removed with promotion, paid flow and refunds', () => {
  const state = setup({ mmp: 1 });
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  signUp(state, a);
  signUp(state, b);
  logic.setPaid(state, { email: a, dateId: DATE, paid: true, now: tick() });
  logic.setPaid(state, { email: a, dateId: DATE, paid: true, now: tick() });
  logic.setPaid(state, { email: a, dateId: DATE, paid: false, now: tick() });
  logic.setPaid(state, { email: a, dateId: DATE, paid: true, now: tick() });
  state.events.length = 0;
  const { refund } = drop(state, a, 'admin');
  assert.deepEqual(types(state), [['admin_removed', a], ['refund_owed', a], ['promoted', b]]);
  assert.equal(state.events[0].actor, 'admin');
  assert.equal(state.events.some((e) => e.type === 'cancel'), false);
  state.events.length = 0;
  logic.markRefunded(state, refund.id, tick());
  assert.deepEqual(types(state), [['refunded', a]]);
  assert.equal(state.events[0].details.amount, 10);
});

test('paid and unpaid events fire only on a change; re-registering voids an owed refund', () => {
  const state = setup();
  const a = addPlayer(state, 'A');
  signUp(state, a);
  logic.setPaid(state, { email: a, dateId: DATE, paid: true, now: tick() });
  logic.setPaid(state, { email: a, dateId: DATE, paid: true, now: tick() });
  logic.setPaid(state, { email: a, dateId: DATE, paid: false, now: tick() });
  assert.deepEqual(types(state).map((t) => t[0]), ['signup', 'paid', 'unpaid']);
  logic.setPaid(state, { email: a, dateId: DATE, paid: true, now: tick() });
  drop(state, a);
  state.events.length = 0;
  signUp(state, a);
  assert.deepEqual(types(state).map((t) => t[0]), ['signup', 'refund_voided']);
  assert.equal(state.events[0].details.creditApplied, true);
});

test('removing a date logs admin_removed per registration without promotion noise', () => {
  const state = setup({ mmp: 1 });
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  signUp(state, a);
  signUp(state, b);
  state.events.length = 0;
  logic.removeDate(state, DATE, tick());
  assert.deepEqual(types(state), [['admin_removed', a], ['admin_removed', b]]);
  assert.equal(state.events[0].details.cause, 'date_removed');
});

test('game start is resolved in the configured zone across DST changes', () => {
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(iso(gameStartMs('2026-10-28', '21:30', 'America/Chicago')), '2026-10-29T02:30:00.000Z');
  assert.equal(iso(gameStartMs('2026-11-04', '21:30', 'America/Chicago')), '2026-11-05T03:30:00.000Z');
  assert.equal(iso(gameStartMs('2026-11-01', '21:30', 'America/Chicago')), '2026-11-02T03:30:00.000Z');
  assert.equal(iso(gameStartMs('2026-03-08', '21:30', 'America/Chicago')), '2026-03-09T02:30:00.000Z');
  assert.equal(iso(gameStartMs('2026-03-07', '21:30', 'America/Chicago')), '2026-03-08T03:30:00.000Z');
  assert.equal(iso(gameStartMs('2026-11-18', '21:30', 'Asia/Kolkata')), '2026-11-18T16:00:00.000Z');
});

test('hoursBeforeGame spans the fall-back DST change by real elapsed time and flags late cancels', () => {
  const settings = { gameStartTime: '21:30', timezone: 'America/Chicago', lateCancelHours: 24 };
  const at = (s) => Date.parse(s);
  assert.deepEqual(hoursBeforeGame(settings, '2026-11-04', at('2026-10-31T03:30:00Z')), { hoursBeforeGame: 120, late: false });
  assert.deepEqual(hoursBeforeGame(settings, '2026-11-04', at('2026-11-04T03:30:00Z')), { hoursBeforeGame: 24, late: false });
  assert.deepEqual(hoursBeforeGame(settings, '2026-11-04', at('2026-11-04T03:31:00Z')), { hoursBeforeGame: 23.98, late: true });
  assert.deepEqual(hoursBeforeGame(settings, '2026-11-04', at('2026-11-05T04:30:00Z')), { hoursBeforeGame: -1, late: true });
  assert.equal(hoursBeforeGame({ ...settings, lateCancelHours: 4 }, '2026-11-04', at('2026-11-04T23:30:00Z')).late, false);
});

test('cancel events use the configured start time, zone and late threshold', () => {
  const state = setup();
  Object.assign(state.settings, { timezone: 'Asia/Kolkata', gameStartTime: '20:00', lateCancelHours: 48 });
  const a = addPlayer(state, 'A');
  signUp(state, a);
  logic.cancel(state, { email: a, dateId: DATE, now: Date.parse('2026-11-16T14:30:00Z') });
  const cancel = state.events.find((e) => e.type === 'cancel');
  assert.equal(cancel.details.hoursBeforeGame, 48);
  assert.equal(cancel.details.late, false);
});

test('game time settings are validated', () => {
  assert.deepEqual(v.parseSettings({ gameStartTime: '07:05', timezone: 'Europe/London', lateCancelHours: 12.5 }),
    { gameStartTime: '07:05', timezone: 'Europe/London', lateCancelHours: 12.5 });
  for (const bad of ['24:00', '9:30', '21:60', '', 2130]) assert.throws(() => v.parseSettings({ gameStartTime: bad }), /HH:MM/);
  for (const bad of ['Mars/Base', '', 'x'.repeat(80), 5]) assert.throws(() => v.parseSettings({ timezone: bad }), /Time zone/);
  for (const bad of [-1, 721, '24', NaN, null]) assert.throws(() => v.parseSettings({ lateCancelHours: bad }), /Late cancel/);
});

test('attendance can only be set for confirmed registrations and emits events', () => {
  const state = setup({ mmp: 1 });
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  signUp(state, a);
  signUp(state, b);
  const mark = (email, attendance) => logic.setAttendance(state, { email, dateId: DATE, attendance, now: tick() });
  assert.throws(() => mark(b, 'attended'), /confirmed/);
  assert.throws(() => mark('nobody@example.com', 'attended'), /not found/);
  assert.throws(() => mark(a, 'late'), /attendance must be/);
  assert.equal(state.registrations.find((r) => r.email === a).attendance, null);
  state.events.length = 0;
  mark(a, 'no_show');
  mark(a, 'no_show');
  mark(a, 'attended');
  mark(a, null);
  assert.deepEqual(types(state).map((t) => t[0]), ['no_show', 'attended', 'attendance_cleared']);
  assert.equal(state.registrations.find((r) => r.email === a).attendance, null);
});

test('player summaries count signups, cancels, late cancels and the current attendance mark', () => {
  const state = setup({ mmp: 5 });
  state.settings.lateCancelHours = 1000;
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  signUp(state, a);
  signUp(state, b);
  logic.setAttendance(state, { email: a, dateId: DATE, attendance: 'no_show', now: tick() });
  logic.setAttendance(state, { email: a, dateId: DATE, attendance: 'attended', now: tick() });
  logic.setAttendance(state, { email: b, dateId: DATE, attendance: 'no_show', now: tick() });
  drop(state, b);
  const by = Object.fromEntries(logic.playerSummaries(state).map((p) => [p.email, p]));
  assert.deepEqual([by[a].signups, by[a].attended, by[a].noShows, by[a].cancels], [1, 1, 0, 0]);
  assert.deepEqual([by[b].signups, by[b].cancels, by[b].lateCancels, by[b].noShows], [1, 1, 1, 0]);
});

test('an old data.json without events or game settings loads with defaults and no backfill', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comed-old-'));
  const file = path.join(dir, 'data.json');
  const old = store.defaultState();
  delete old.events;
  for (const k of ['gameStartTime', 'timezone', 'lateCancelHours']) delete old.settings[k];
  old.players['a@x.co'] = { email: 'a@x.co', name: 'A', category: 'MMP' };
  old.registrations.push({ email: 'a@x.co', date: DATE, category: 'MMP', signedUpAt: '2026-10-01T00:00:00.000Z', paid: false });
  fs.writeFileSync(file, JSON.stringify(old));
  const state = store.load(file);
  assert.deepEqual(state.events, []);
  assert.deepEqual([state.settings.gameStartTime, state.settings.timezone, state.settings.lateCancelHours], ['21:30', 'America/Chicago', 24]);
  const rows = logic.adminRows(state, state.dates.find((d) => d.id === DATE)).MMP.rows;
  assert.equal(rows[0].attendance, null);
  logic.setAttendance(state, { email: 'a@x.co', dateId: DATE, attendance: 'attended', now: 1 });
  assert.equal(state.events.length, 1);
  fs.rmSync(dir, { recursive: true });
});
