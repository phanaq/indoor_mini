function offsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// Wall-clock time in a zone to a UTC instant. The second pass re-reads the offset at the
// first estimate so dates near a DST change resolve to the right side of it.
function gameStartMs(isoDate, time, timeZone) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const first = local - offsetMs(local, timeZone);
  return local - offsetMs(first, timeZone);
}

function hoursBeforeGame(settings, isoDate, nowMs) {
  try {
    const hours = (gameStartMs(isoDate, settings.gameStartTime, settings.timezone) - nowMs) / 3600000;
    const rounded = Math.round(hours * 100) / 100;
    return { hoursBeforeGame: rounded, late: rounded < settings.lateCancelHours };
  } catch {
    return { hoursBeforeGame: null, late: false };
  }
}

module.exports = { gameStartMs, hoursBeforeGame };
