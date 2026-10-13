const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./lib/store');
const logic = require('./lib/logic');
const v = require('./lib/validate');
const { createLimiter } = require('./lib/ratelimit');
const { createSessions } = require('./lib/sessions');

const MAX_BODY = 16 * 1024;
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const ADMIN_TTL = 12 * 3600 * 1000;
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function createApp({ dataFile, adminPassword, secureCookies = false, now = Date.now }) {
  if (!adminPassword) throw new Error('ADMIN_PASSWORD is required');
  const logFile = path.join(path.dirname(dataFile), 'refunds.log');
  const adminHash = sha256(adminPassword);
  const players = createSessions(SESSION_TTL);
  const admins = createSessions(ADMIN_TTL);
  const limiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  let state = store.load(dataFile);

  // Mutate a clone and persist before swapping, so a validation error or failed write leaves state untouched.
  function mutate(fn) {
    const draft = structuredClone(state);
    const result = fn(draft);
    store.save(dataFile, draft);
    state = draft;
    return result;
  }

  function logRefund(refund) {
    try {
      fs.appendFileSync(logFile, `${JSON.stringify({ event: 'refund_owed', ...refund })}\n`);
    } catch (err) {
      console.error('could not write refunds.log:', err.message);
    }
  }

  const bodyOf = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function cookie(name, value, maxAgeSec) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookies ? '; Secure' : ''}`;
  }

  function send(res, status, body, headers = {}) {
    const isString = typeof body === 'string';
    res.writeHead(status, {
      'Content-Type': isString ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(isString ? body : JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          if (size - chunk.length <= MAX_BODY) reject(new v.ValidationError('Request body too large', 413));
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new v.ValidationError('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function playerSession(req) {
    const token = parseCookies(req).sid;
    const sess = players.get(token);
    return sess && state.players[sess.email] ? { token, player: state.players[sess.email] } : null;
  }

  function requirePlayer(req) {
    const s = playerSession(req);
    if (!s) throw new v.ValidationError('Please log in', 401);
    return s.player;
  }

  function requireAdmin(req) {
    if (!admins.get(parseCookies(req).asid)) throw new v.ValidationError('Admin login required', 401);
  }

  function rateLimit(req, bucket) {
    const r = limiter.check(`${bucket}:${req.socket.remoteAddress}`, now());
    if (!r.ok) {
      const err = new v.ValidationError('Too many attempts, try again later', 429);
      err.retryAfter = r.retryAfter;
      throw err;
    }
  }

  function playerState(player) {
    const settings = state.settings;
    const dates = state.dates.map((date) => {
      const roster = logic.computeRoster(state, date);
      const counts = {};
      const names = {};
      for (const cat of v.CATEGORIES) {
        const r = roster[cat];
        counts[cat] = { confirmed: r.confirmed.length, threshold: r.threshold, waitlisted: r.waitlist.length };
        const nameOf = (reg) => state.players[reg.email].name;
        names[cat] = { confirmed: r.confirmed.map(nameOf), waitlist: r.waitlist.map(nameOf) };
      }
      const status = player ? logic.statusOf(state, date.id, player.email) : null;
      let mine = null;
      if (status) {
        const reg = state.registrations.find((x) => x.email === player.email && x.date === date.id);
        mine = { ...status, paid: reg.paid };
      }
      return { id: date.id, date: date.date, label: date.label, gameType: date.gameType || 'mixed', counts, names, mine };
    });
    return {
      me: player ? { email: player.email, name: player.name, category: player.category } : null,
      settings: { intro: settings.intro },
      dates,
    };
  }

  function adminState() {
    return {
      settings: state.settings,
      dates: state.dates.map((date) => ({ ...date, rosters: logic.adminRows(state, date) })),
      refunds: state.refunds,
      owedRefunds: logic.owedRefundCount(state),
    };
  }

  function csvCell(value) {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  }

  const eventsNewestFirst = () => [...state.events].sort((a, b) => (a.ts === b.ts ? b.id - a.id : a.ts < b.ts ? 1 : -1));

  function eventsCsv() {
    const lines = [['id', 'ts', 'type', 'actor', 'email', 'name', 'date_id', 'date_label', 'category', 'hours_before_game', 'late', 'details']];
    for (const e of eventsNewestFirst()) {
      const { dateLabel, hoursBeforeGame, late, ...rest } = e.details || {};
      lines.push([e.id, e.ts, e.type, e.actor, e.email, e.name, e.dateId, dateLabel, e.category, hoursBeforeGame, late ?? '', Object.keys(rest).length ? JSON.stringify(rest) : '']);
    }
    return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function exportCsv() {
    const lines = [['date', 'label', 'category', 'email', 'name', 'status', 'position', 'signed_up_at', 'paid']];
    for (const date of state.dates) {
      const rosters = logic.adminRows(state, date);
      for (const cat of v.CATEGORIES) {
        for (const row of rosters[cat].rows) {
          lines.push([date.date, date.label, cat, row.email, row.name, row.status, row.position ?? '', row.signedUpAt, row.paid ? 'yes' : 'no']);
        }
      }
    }
    return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  const routes = {
    'GET /api/state': (req, res) => {
      const s = playerSession(req);
      send(res, 200, playerState(s ? s.player : null));
    },

    'POST /api/login': (req, res, body) => {
      rateLimit(req, 'login');
      const email = v.normalizeEmail(body.email);
      let player = state.players[email];
      if (!player) {
        if (body.name === undefined || body.name === '') return send(res, 200, { needsName: true });
        const name = v.normalizeName(body.name);
        const category = v.normalizeCategory(body.category);
        player = mutate((draft) => (draft.players[email] = { email, name, category, createdAt: new Date(now()).toISOString() }));
      }
      const token = players.create({ email }, now());
      send(res, 200, playerState(state.players[email]), { 'Set-Cookie': cookie('sid', token, SESSION_TTL / 1000) });
    },

    'POST /api/logout': (req, res) => {
      players.destroy(parseCookies(req).sid);
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie('sid', '', 0) });
    },

    'PUT /api/me': (req, res, body) => {
      const player = requirePlayer(req);
      mutate((draft) => {
        if ('category' in body) draft.players[player.email].category = v.normalizeCategory(body.category);
        if ('name' in body) draft.players[player.email].name = v.normalizeName(body.name);
      });
      send(res, 200, playerState(state.players[player.email]));
    },

    'POST /api/register': (req, res, body) => {
      const player = requirePlayer(req);
      if (typeof body.dateId !== 'string') throw new v.ValidationError('dateId is required');
      mutate((draft) => logic.register(draft, { email: player.email, dateId: body.dateId, now: now() }));
      send(res, 200, playerState(player));
    },

    'POST /api/unregister': (req, res, body) => {
      const player = requirePlayer(req);
      if (typeof body.dateId !== 'string') throw new v.ValidationError('dateId is required');
      logic.findDate(state, body.dateId);
      const { refund } = mutate((draft) => logic.cancel(draft, { email: player.email, dateId: body.dateId, now: now() }));
      if (refund) logRefund(refund);
      send(res, 200, playerState(player));
    },

    'POST /api/admin/login': (req, res, body) => {
      rateLimit(req, 'admin');
      const given = typeof body.password === 'string' ? body.password : '';
      if (!crypto.timingSafeEqual(sha256(given), adminHash)) throw new v.ValidationError('Wrong password', 401);
      const token = admins.create({ admin: true }, now());
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie('asid', token, ADMIN_TTL / 1000) });
    },

    'POST /api/admin/logout': (req, res) => {
      admins.destroy(parseCookies(req).asid);
      send(res, 200, { ok: true }, { 'Set-Cookie': cookie('asid', '', 0) });
    },

    'GET /api/admin/state': (req, res) => {
      requireAdmin(req);
      send(res, 200, adminState());
    },

    'PUT /api/admin/settings': (req, res, body) => {
      requireAdmin(req);
      const patch = v.parseSettings(body);
      mutate((draft) => Object.assign(draft.settings, patch));
      send(res, 200, adminState());
    },

    'POST /api/admin/dates': (req, res, body) => {
      requireAdmin(req);
      mutate((draft) => logic.addDate(draft, body));
      send(res, 200, adminState());
    },

    'PUT /api/admin/dates': (req, res, body) => {
      requireAdmin(req);
      if (typeof body.id !== 'string') throw new v.ValidationError('id is required');
      const { id, ...patch } = body;
      mutate((draft) => logic.updateDate(draft, id, patch, now()));
      send(res, 200, adminState());
    },

    'POST /api/admin/dates/remove': (req, res, body) => {
      requireAdmin(req);
      if (typeof body.id !== 'string') throw new v.ValidationError('id is required');
      const refunds = mutate((draft) => logic.removeDate(draft, body.id, now()));
      refunds.forEach(logRefund);
      send(res, 200, adminState());
    },

    'POST /api/admin/paid': (req, res, body) => {
      requireAdmin(req);
      if (typeof body.dateId !== 'string' || typeof body.paid !== 'boolean') throw new v.ValidationError('dateId and paid are required');
      const email = v.normalizeEmail(body.email);
      mutate((draft) => logic.setPaid(draft, { email, dateId: body.dateId, paid: body.paid, now: now() }));
      send(res, 200, adminState());
    },

    'POST /api/admin/remove-registration': (req, res, body) => {
      requireAdmin(req);
      if (typeof body.dateId !== 'string') throw new v.ValidationError('dateId is required');
      const email = v.normalizeEmail(body.email);
      logic.findDate(state, body.dateId);
      const { registration, refund } = mutate((draft) => logic.cancel(draft, { email, dateId: body.dateId, now: now(), actor: 'admin' }));
      if (!registration) throw new v.ValidationError('Registration not found', 404);
      if (refund) logRefund(refund);
      send(res, 200, adminState());
    },

    'POST /api/admin/refunds/refunded': (req, res, body) => {
      requireAdmin(req);
      if (!Number.isInteger(body.id)) throw new v.ValidationError('id is required');
      mutate((draft) => logic.markRefunded(draft, body.id, now()));
      send(res, 200, adminState());
    },

    'POST /api/admin/attendance': (req, res, body) => {
      requireAdmin(req);
      if (typeof body.dateId !== 'string') throw new v.ValidationError('dateId is required');
      const email = v.normalizeEmail(body.email);
      mutate((draft) => logic.setAttendance(draft, { email, dateId: body.dateId, attendance: body.attendance ?? null, now: now() }));
      send(res, 200, adminState());
    },

    'GET /api/admin/events': (req, res) => {
      requireAdmin(req);
      send(res, 200, { events: eventsNewestFirst() });
    },

    'GET /api/admin/players': (req, res) => {
      requireAdmin(req);
      send(res, 200, { players: logic.playerSummaries(state) });
    },

    'GET /api/admin/events.csv': (req, res) => {
      requireAdmin(req);
      send(res, 200, eventsCsv(), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="events.csv"',
      });
    },

    'GET /api/admin/export.csv': (req, res) => {
      requireAdmin(req);
      send(res, 200, exportCsv(), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="registrations.csv"',
      });
    },
  };

  async function handle(req, res) {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(INDEX_HTML, 'utf8'), {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
        });
      }
      const route = routes[`${req.method} ${pathname}`];
      if (!route) return send(res, 404, { error: 'Not found' });

      let body = {};
      if (req.method !== 'GET') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
          throw new v.ValidationError('Content-Type must be application/json', 415);
        }
        const origin = req.headers.origin;
        let originHost = null;
        try {
          originHost = origin ? new URL(origin).host : null;
        } catch {}
        if (origin && originHost !== req.headers.host) throw new v.ValidationError('Cross-origin request blocked', 403);
        body = bodyOf(await readBody(req));
      }
      route(req, res, body);
    } catch (err) {
      if (err instanceof v.ValidationError) {
        const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
        if (err.status === 413) headers.Connection = 'close';
        return send(res, err.status, { error: err.message }, headers);
      }
      console.error(err);
      send(res, 500, { error: 'Internal error' });
    }
  }

  return { server: http.createServer(handle) };
}

if (require.main === module) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.error('ADMIN_PASSWORD is not set; refusing to start.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const dataFile = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
  const { server } = createApp({ dataFile, adminPassword, secureCookies: process.env.COOKIE_SECURE === '1' });
  server.listen(port, host, () => console.log(`ComEd signup listening on http://${host}:${port}`));
}

module.exports = { createApp };
