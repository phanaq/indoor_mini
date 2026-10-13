const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultState } = require('../lib/store');
const logic = require('../lib/logic');

const DATE = '2026-11-18';
let clock;
const tick = () => (clock += 1000);

function setup(thresholds = {}) {
  clock = Date.UTC(2026, 10, 1);
  const state = defaultState();
  Object.assign(state.dates.find((d) => d.id === DATE), thresholds);
  return state;
}

function addPlayer(state, name, category = 'MMP') {
  const email = `${name.toLowerCase()}@example.com`;
  state.players[email] = { email, name, category };
  return email;
}

const signUp = (state, email) => logic.register(state, { email, dateId: DATE, now: tick() });
const drop = (state, email) => logic.cancel(state, { email, dateId: DATE, now: tick() });
const status = (state, email) => logic.statusOf(state, DATE, email);
const date = (state) => state.dates.find((d) => d.id === DATE);

test('fills confirmed spots up to the threshold, then waitlists in order', () => {
  const state = setup({ mmp: 2 });
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => addPlayer(state, n));
  [a, b, c, d].forEach((e) => signUp(state, e));
  assert.deepEqual(status(state, a), { status: 'confirmed', category: 'MMP' });
  assert.deepEqual(status(state, b), { status: 'confirmed', category: 'MMP' });
  assert.deepEqual(status(state, c), { status: 'waitlist', position: 1, category: 'MMP' });
  assert.deepEqual(status(state, d), { status: 'waitlist', position: 2, category: 'MMP' });
});

test('MMP and WMP are counted separately', () => {
  const state = setup({ mmp: 1, wmp: 1 });
  const m = addPlayer(state, 'M', 'MMP');
  const m2 = addPlayer(state, 'M2', 'MMP');
  const w = addPlayer(state, 'W', 'WMP');
  [m, m2, w].forEach((e) => signUp(state, e));
  assert.equal(status(state, w).status, 'confirmed');
  assert.equal(status(state, m2).status, 'waitlist');
  const roster = logic.computeRoster(state, date(state));
  assert.equal(roster.MMP.waitlist.length, 1);
  assert.equal(roster.WMP.confirmed.length, 1);
});

test('registering twice is idempotent and does not change signup time', () => {
  const state = setup();
  const a = addPlayer(state, 'A');
  const first = signUp(state, a);
  const second = signUp(state, a);
  assert.equal(second.created, false);
  assert.equal(state.registrations.length, 1);
  assert.equal(second.registration.signedUpAt, first.registration.signedUpAt);
});

test('unknown dates and players are rejected', () => {
  const state = setup();
  const a = addPlayer(state, 'A');
  assert.throws(() => logic.register(state, { email: a, dateId: 'nope', now: tick() }), /Unknown date/);
  assert.throws(() => logic.register(state, { email: 'x@y.com', dateId: DATE, now: tick() }), /Unknown player/);
});

test('unchecking promotes the next waitlisted person', () => {
  const state = setup({ mmp: 1 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => addPlayer(state, n));
  [a, b, c].forEach((e) => signUp(state, e));
  drop(state, a);
  assert.equal(status(state, a), null);
  assert.equal(status(state, b).status, 'confirmed');
  assert.deepEqual(status(state, c), { status: 'waitlist', position: 1, category: 'MMP' });
});

test('rechecking goes to the back of a full waitlist', () => {
  const state = setup({ mmp: 1 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => addPlayer(state, n));
  [a, b, c].forEach((e) => signUp(state, e));
  drop(state, b);
  signUp(state, b);
  assert.equal(status(state, a).status, 'confirmed');
  assert.deepEqual(status(state, c), { status: 'waitlist', position: 1, category: 'MMP' });
  assert.deepEqual(status(state, b), { status: 'waitlist', position: 2, category: 'MMP' });
});

test('rechecking takes a free spot straight away', () => {
  const state = setup({ mmp: 2 });
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  [a, b].forEach((e) => signUp(state, e));
  drop(state, a);
  signUp(state, a);
  assert.equal(status(state, a).status, 'confirmed');
});

test('raising a threshold promotes waitlisted people in order', () => {
  const state = setup({ mmp: 1 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => addPlayer(state, n));
  [a, b, c].forEach((e) => signUp(state, e));
  logic.updateDate(state, DATE, { mmp: 2 });
  assert.equal(status(state, b).status, 'confirmed');
  assert.equal(status(state, c).position, 1);
});

test('lowering a threshold demotes the latest signups', () => {
  const state = setup({ mmp: 3 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => addPlayer(state, n));
  [a, b, c].forEach((e) => signUp(state, e));
  logic.updateDate(state, DATE, { mmp: 1 });
  assert.equal(status(state, a).status, 'confirmed');
  assert.deepEqual(status(state, b), { status: 'waitlist', position: 1, category: 'MMP' });
  assert.deepEqual(status(state, c), { status: 'waitlist', position: 2, category: 'MMP' });
});

test('a paid registration demoted by a lowered threshold is flagged in the admin view', () => {
  const state = setup({ mmp: 2 });
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  [a, b].forEach((e) => signUp(state, e));
  logic.setPaid(state, { email: b, dateId: DATE, paid: true });
  assert.equal(logic.adminRows(state, date(state)).MMP.rows.some((r) => r.warning), false);
  logic.updateDate(state, DATE, { mmp: 1 });
  const rows = logic.adminRows(state, date(state)).MMP.rows;
  assert.deepEqual(rows.map((r) => [r.email, r.warning]), [[a, false], [b, true]]);
});

test('cancelling an unpaid registration creates no refund', () => {
  const state = setup();
  const a = addPlayer(state, 'A');
  signUp(state, a);
  const { refund } = drop(state, a);
  assert.equal(refund, null);
  assert.equal(state.refunds.length, 0);
});

test('cancelling a paid registration records an owed refund for the amount paid', () => {
  const state = setup();
  const a = addPlayer(state, 'Ann');
  signUp(state, a);
  logic.setPaid(state, { email: a, dateId: DATE, paid: true });
  logic.updateDate(state, DATE, { fee: 12 });
  const { refund } = drop(state, a);
  assert.equal(refund.status, 'owed');
  assert.equal(refund.email, a);
  assert.equal(refund.name, 'Ann');
  assert.equal(refund.date, DATE);
  assert.equal(refund.amount, 10);
  assert.equal(logic.owedRefundCount(state), 1);
});

test('re-registering while a refund is owed voids it and applies credit', () => {
  const state = setup();
  const a = addPlayer(state, 'A');
  signUp(state, a);
  logic.setPaid(state, { email: a, dateId: DATE, paid: true });
  drop(state, a);
  const res = signUp(state, a);
  assert.equal(res.creditApplied.status, 'voided');
  assert.equal(res.registration.paid, true);
  assert.equal(logic.owedRefundCount(state), 0);
  const second = drop(state, a);
  assert.equal(second.refund.status, 'owed');
  assert.equal(second.refund.amount, 10);
});

test('an already refunded payment is not credited on re-register', () => {
  const state = setup();
  const a = addPlayer(state, 'A');
  signUp(state, a);
  logic.setPaid(state, { email: a, dateId: DATE, paid: true });
  const { refund } = drop(state, a);
  logic.markRefunded(state, refund.id, tick());
  const res = signUp(state, a);
  assert.equal(res.registration.paid, false);
  assert.equal(res.creditApplied, null);
  assert.throws(() => logic.markRefunded(state, refund.id, tick()), /not owed/);
});

test('removing a date cancels registrations and owes refunds for paid ones', () => {
  const state = setup();
  const [a, b] = ['A', 'B'].map((n) => addPlayer(state, n));
  [a, b].forEach((e) => signUp(state, e));
  logic.setPaid(state, { email: a, dateId: DATE, paid: true });
  const refunds = logic.removeDate(state, DATE, tick());
  assert.equal(refunds.length, 1);
  assert.equal(state.registrations.length, 0);
  assert.equal(state.dates.some((d) => d.id === DATE), false);
});

test('date admin validation', () => {
  const state = setup();
  assert.throws(() => logic.addDate(state, { date: '2026-11-18' }), /already exists/);
  assert.throws(() => logic.addDate(state, { date: '2026-02-30' }), /real calendar date/);
  assert.throws(() => logic.updateDate(state, DATE, { mmp: -1 }), /threshold/);
  assert.throws(() => logic.updateDate(state, DATE, { fee: 'x' }), /Fee/);
  const added = logic.addDate(state, { date: '2027-01-06', mmp: 8 });
  assert.equal(added.mmp, 8);
  assert.equal(state.dates[state.dates.length - 1].id, added.id);
});
