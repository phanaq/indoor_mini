const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function boot(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comed-api-'));
  const { server } = createApp({ dataFile: path.join(dir, 'data.json'), adminPassword: 'pw-for-tests', ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (cookieName) => {
    let jar = '';
    return async (method, url, body, extra = {}) => {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar ? { cookie: jar } : {}), ...extra },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) jar = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text, headers: res.headers };
    };
  };
  return { client, dir, dataFile: path.join(dir, 'data.json') };
}

test('login flow asks for a name only the first time and sets a hardened cookie', async (t) => {
  const { client } = await boot(t);
  const c = client();
  assert.equal((await c('POST', '/api/login', { email: 'New@Example.com' })).json.needsName, true);
  const res = await c('POST', '/api/login', { email: 'New@Example.com', name: 'New P', category: 'WMP' });
  assert.equal(res.status, 200);
  assert.equal(res.json.me.category, 'WMP');
  assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const again = client();
  assert.equal((await again('POST', '/api/login', { email: 'new@example.com' })).json.me.name, 'New P');
});

test('waitlist, promotion, paid refund and credit over HTTP', async (t) => {
  const { client } = await boot(t);
  const admin = client();
  assert.equal((await admin('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  assert.equal((await admin('POST', '/api/admin/login', { password: 'pw-for-tests' })).status, 200);
  await admin('PUT', '/api/admin/dates', { id: '2026-11-18', mmp: 1 });

  const mk = async (n) => {
    const c = client();
    await c('POST', '/api/login', { email: `${n}@x.co`, name: n, category: 'MMP' });
    return c;
  };
  const [a, b] = [await mk('a'), await mk('b')];
  const mine = (r) => r.json.dates.find((d) => d.id === '2026-11-18').mine;
  const ra = await a('POST', '/api/register', { dateId: '2026-11-18' });
  const rb = await b('POST', '/api/register', { dateId: '2026-11-18' });
  assert.equal(mine(ra).status, 'confirmed');
  assert.equal(mine(rb).status, 'waitlist');

  await admin('POST', '/api/admin/paid', { dateId: '2026-11-18', email: 'a@x.co', paid: true });
  await a('POST', '/api/unregister', { dateId: '2026-11-18' });
  const promoted = await b('GET', '/api/state');
  assert.equal(mine(promoted).status, 'confirmed');

  const st = await admin('GET', '/api/admin/state');
  assert.equal(st.json.owedRefunds, 1);
  const back = await a('POST', '/api/register', { dateId: '2026-11-18' });
  assert.equal(mine(back).paid, true);
  assert.equal((await admin('GET', '/api/admin/state')).json.owedRefunds, 0);
});

test('admin endpoints and bad input are rejected', async (t) => {
  const { client } = await boot(t);
  const anon = client();
  assert.equal((await anon('GET', '/api/admin/state')).status, 401);
  assert.equal((await anon('GET', '/api/admin/export.csv')).status, 401);
  assert.equal((await anon('POST', '/api/register', { dateId: '2026-11-18' })).status, 401);
  await anon('POST', '/api/login', { email: 'z@x.co', name: 'Z', category: 'MMP' });
  assert.equal((await anon('POST', '/api/register', { dateId: 'bogus' })).status, 404);
  assert.equal((await anon('POST', '/api/login', { email: 'bad' })).status, 400);
});

test('non-JSON posts, cross-origin posts and oversized bodies are rejected', async (t) => {
  const { client } = await boot(t);
  const c = client();
  assert.equal((await c('POST', '/api/login', { email: 'a@x.co' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await c('POST', '/api/login', { email: 'a@x.co' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await c('POST', '/api/login', { email: 'a@x.co', pad: 'x'.repeat(20000) })).status, 413);
});

test('login endpoints are rate limited per IP', async (t) => {
  const { client } = await boot(t);
  const c = client();
  let last;
  for (let i = 0; i < 11; i++) last = await c('POST', '/api/admin/login', { password: 'nope' });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('CSV export neutralises formula cells', async (t) => {
  const { client } = await boot(t);
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'pw-for-tests' });
  const p = client();
  await p('POST', '/api/login', { email: 'q@x.co', name: '=HYPERLINK("x")', category: 'MMP' });
  await p('POST', '/api/register', { dateId: '2026-11-18' });
  const csv = await admin('GET', '/api/admin/export.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /"'=HYPERLINK/);
});

test('events and attendance never appear in public or player responses', async (t) => {
  const { client } = await boot(t);
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'pw-for-tests' });
  const p = client();
  const login = await p('POST', '/api/login', { email: 'leak@x.co', name: 'Leak', category: 'MMP' });
  const reg = await p('POST', '/api/register', { dateId: '2026-11-18' });
  await admin('POST', '/api/admin/attendance', { dateId: '2026-11-18', email: 'leak@x.co', attendance: 'no_show' });
  const cancelled = await p('POST', '/api/unregister', { dateId: '2026-11-18' });
  const anon = client();
  const responses = [login, reg, cancelled, await p('GET', '/api/state'), await anon('GET', '/api/state'), await p('PUT', '/api/me', { name: 'Leak 2' })];
  for (const r of responses) {
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /events|attendance|no_show|hoursBeforeGame|gameStartTime|lateCancelHours/);
  }
});

test('new admin endpoints require the admin cookie', async (t) => {
  const { client } = await boot(t);
  const anon = client();
  for (const url of ['/api/admin/events', '/api/admin/players', '/api/admin/events.csv']) {
    assert.equal((await anon('GET', url)).status, 401);
  }
  assert.equal((await anon('POST', '/api/admin/attendance', { dateId: '2026-11-18', email: 'a@x.co', attendance: 'attended' })).status, 401);
  const p = client();
  await p('POST', '/api/login', { email: 'a@x.co', name: 'A', category: 'MMP' });
  assert.equal((await p('GET', '/api/admin/events')).status, 401);
});

test('signup then cancel shows up in admin events, with late flag and attendance rules over HTTP', async (t) => {
  const gameStart = Date.parse('2026-11-19T03:30:00Z');
  const { client } = await boot(t, { now: () => gameStart - 5 * 3600000 });
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'pw-for-tests' });
  await admin('PUT', '/api/admin/dates', { id: '2026-11-18', mmp: 1 });
  const mk = async (n) => {
    const c = client();
    await c('POST', '/api/login', { email: `${n}@x.co`, name: n, category: 'MMP' });
    return c;
  };
  const [a, b] = [await mk('a'), await mk('b')];
  await a('POST', '/api/register', { dateId: '2026-11-18' });
  await b('POST', '/api/register', { dateId: '2026-11-18' });

  const waitlisted = await admin('POST', '/api/admin/attendance', { dateId: '2026-11-18', email: 'b@x.co', attendance: 'attended' });
  assert.equal(waitlisted.status, 409);
  assert.equal((await admin('POST', '/api/admin/attendance', { dateId: '2026-11-18', email: 'a@x.co', attendance: 'bogus' })).status, 400);
  const marked = await admin('POST', '/api/admin/attendance', { dateId: '2026-11-18', email: 'a@x.co', attendance: 'no_show' });
  assert.equal(marked.json.dates.find((d) => d.id === '2026-11-18').rosters.MMP.rows[0].attendance, 'no_show');

  await a('POST', '/api/unregister', { dateId: '2026-11-18' });
  const { events } = (await admin('GET', '/api/admin/events')).json;
  assert.deepEqual(events.map((e) => e.type), ['promoted', 'cancel', 'no_show', 'signup', 'signup', 'threshold_changed']);
  const cancel = events.find((e) => e.type === 'cancel');
  assert.equal(cancel.details.hoursBeforeGame, 5);
  assert.equal(cancel.details.late, true);
  assert.equal(events[0].type, 'promoted');
  assert.equal(events[0].email, 'b@x.co');

  const players = (await admin('GET', '/api/admin/players')).json.players;
  const pa = players.find((p) => p.email === 'a@x.co');
  assert.deepEqual([pa.signups, pa.cancels, pa.lateCancels, pa.noShows], [1, 1, 1, 0]);

  const settings = await admin('PUT', '/api/admin/settings', { timezone: 'Nope/Zone' });
  assert.equal(settings.status, 400);
  const ok = await admin('PUT', '/api/admin/settings', { timezone: 'America/New_York', gameStartTime: '20:00', lateCancelHours: 2 });
  assert.equal(ok.json.settings.timezone, 'America/New_York');
});

test('events CSV neutralises formula cells and persists with the state change', async (t) => {
  const { client, dataFile } = await boot(t);
  const admin = client();
  await admin('POST', '/api/admin/login', { password: 'pw-for-tests' });
  const p = client();
  await p('POST', '/api/login', { email: 'q@x.co', name: '=HYPERLINK("x")', category: 'MMP' });
  await p('POST', '/api/register', { dateId: '2026-11-18' });
  const csv = await admin('GET', '/api/admin/events.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /"'=HYPERLINK/);
  assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).events.length, 1);
});
