const crypto = require('node:crypto');

const SESSION_DAYS = 14;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split(':');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 32);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now.toISOString(), exp.toISOString());
  return token;
}

function userForToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
  if (!row || !row.active) return null;
  return { ...row };
}

module.exports = { hashPassword, verifyPassword, createSession, userForToken };
