class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const CATEGORIES = ['MMP', 'WMP'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new ValidationError('Email is required');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email) || CONTROL_RE.test(email)) {
    throw new ValidationError('Enter a valid email address');
  }
  return email;
}

function normalizeName(value) {
  if (typeof value !== 'string') throw new ValidationError('Name is required');
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 60 || CONTROL_RE.test(name)) {
    throw new ValidationError('Name must be 1-60 characters');
  }
  return name;
}

function normalizeCategory(value) {
  if (!CATEGORIES.includes(value)) throw new ValidationError('Category must be MMP or WMP');
  return value;
}

function parseThreshold(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 500) {
    throw new ValidationError(`${field} threshold must be a whole number from 0 to 500`);
  }
  return value;
}

function parseFee(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) {
    throw new ValidationError('Fee must be a number from 0 to 1000');
  }
  return Math.round(value * 100) / 100;
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('Date must be YYYY-MM-DD');
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ValidationError('Date is not a real calendar date');
  }
  return value;
}

function parseLabel(value) {
  if (typeof value !== 'string') throw new ValidationError('Label must be text');
  const label = value.replace(/\s+/g, ' ').trim();
  if (label.length > 60 || CONTROL_RE.test(label)) throw new ValidationError('Label must be at most 60 characters');
  return label;
}

function parseSettings(input) {
  const out = {};
  if ('intro' in input) {
    if (typeof input.intro !== 'string' || input.intro.length > 4000) {
      throw new ValidationError('Intro must be text up to 4000 characters');
    }
    out.intro = input.intro;
  }
  if ('gameStartTime' in input) {
    if (typeof input.gameStartTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.gameStartTime)) {
      throw new ValidationError('Game start time must be HH:MM (24-hour)');
    }
    out.gameStartTime = input.gameStartTime;
  }
  if ('timezone' in input) {
    out.timezone = parseTimeZone(input.timezone);
  }
  if ('lateCancelHours' in input) {
    const hours = input.lateCancelHours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > 720) {
      throw new ValidationError('Late cancel hours must be a number from 0 to 720');
    }
    out.lateCancelHours = hours;
  }
  return out;
}

function parseTimeZone(value) {
  const zone = typeof value === 'string' ? value.trim() : '';
  try {
    if (!zone || zone.length > 64) throw new RangeError('bad zone');
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new ValidationError('Time zone must be a valid IANA name, e.g. America/Chicago');
  }
  return zone;
}

module.exports = {
  ValidationError,
  CATEGORIES,
  normalizeEmail,
  normalizeName,
  normalizeCategory,
  parseThreshold,
  parseFee,
  parseIsoDate,
  parseLabel,
  parseSettings,
};
