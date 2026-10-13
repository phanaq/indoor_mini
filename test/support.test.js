const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const v = require('../lib/validate');
const { createLimiter } = require('../lib/ratelimit');
const { createSessions } = require('../lib/sessions');

test('store saves atomically and round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comed-'));
  const file = path.join(dir, 'data.json');
  const state = store.load(file);
  assert.equal(state.dates.length, 5);
  state.players['a@b.co'] = { email: 'a@b.co', name: 'A', category: 'MMP' };
  store.save(file, state);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(store.load(file).players['a@b.co'].name, 'A');
  fs.rmSync(dir, { recursive: true });
});

test('store refuses to overwrite a corrupt data file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comed-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => store.load(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  fs.rmSync(dir, { recursive: true });
});

test('email and name validation', () => {
  assert.equal(v.normalizeEmail('  Foo@Example.COM '), 'foo@example.com');
  assert.throws(() => v.normalizeEmail('nope'));
  assert.throws(() => v.normalizeEmail(5));
  assert.equal(v.normalizeName('  Jo   Smith '), 'Jo Smith');
  assert.throws(() => v.normalizeName(''));
  assert.throws(() => v.normalizeName('a\u0000b'));
  assert.throws(() => v.normalizeCategory('XYZ'));
});

test('rate limiter blocks after max and resets after the window', () => {
  const l = createLimiter({ max: 2, windowMs: 1000 });
  assert.equal(l.check('ip', 0).ok, true);
  assert.equal(l.check('ip', 1).ok, true);
  assert.equal(l.check('ip', 2).ok, false);
  assert.equal(l.check('other', 2).ok, true);
  assert.equal(l.check('ip', 1001).ok, true);
});

test('sessions expire and can be destroyed', () => {
  const s = createSessions(1000);
  const t = s.create({ email: 'a' }, 0);
  assert.deepEqual(s.get(t, 500), { email: 'a' });
  assert.equal(s.get(t, 1500), null);
  const t2 = s.create({ email: 'b' }, 0);
  s.destroy(t2);
  assert.equal(s.get(t2, 1), null);
});
