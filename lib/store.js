const fs = require('node:fs');
const path = require('node:path');

const SEED_INTRO = [
  'Please do not mark attending for a date unless you are committed to that date.',
  '',
  'Field: 1/4 field reservation, first week capped at 20 players.',
  'Ratio: mixed 2:2, may convert 1-2 games to WMP only.',
  'Cost: field is $150/night, est. $8-10 per person per night.',
].join('\n');

function defaultState() {
  const dates = ['2026-11-18', '2026-11-25', '2026-12-02', '2026-12-09', '2026-12-16'].map((d) => ({
    id: d,
    date: d,
    label: formatDateLabel(d),
    mmp: 10,
    wmp: 10,
    fee: 10,
    gameType: 'mixed',
  }));
  return {
    settings: {
      intro: SEED_INTRO,
      gameStartTime: '21:30',
      timezone: 'America/Chicago',
      lateCancelHours: 24,
    },
    dates,
    players: {},
    registrations: [],
    refunds: [],
    nextRefundId: 1,
    events: [],
  };
}

function formatDateLabel(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function load(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const state = defaultState();
    save(file, state);
    return state;
  }
  const parsed = JSON.parse(raw);
  const base = defaultState();
  return {
    ...base,
    ...parsed,
    settings: { ...base.settings, ...parsed.settings },
    events: Array.isArray(parsed.events) ? parsed.events : [],
  };
}

// Write to a temp file then rename so a crash never leaves a half-written data.json.
function save(file, state) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

module.exports = { defaultState, formatDateLabel, load, save };
