const crypto = require('node:crypto');

function createSessions(ttlMs) {
  const map = new Map();
  return {
    create(data, now = Date.now()) {
      const token = crypto.randomBytes(32).toString('base64url');
      map.set(token, { data, expiresAt: now + ttlMs });
      return token;
    },
    get(token, now = Date.now()) {
      if (!token) return null;
      const s = map.get(token);
      if (!s) return null;
      if (s.expiresAt <= now) {
        map.delete(token);
        return null;
      }
      return s.data;
    },
    destroy(token) {
      map.delete(token);
    },
  };
}

module.exports = { createSessions };
