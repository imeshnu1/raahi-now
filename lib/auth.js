// Auth for Raahi NOW — own implementation, Node crypto only.
//
// Passwords: crypto.scrypt with a per-user random salt, stored as
// "scrypt$<saltHex>$<hashHex>". Verification uses timingSafeEqual.
// Plaintext passwords are never stored or logged.
//
// Sessions: a random 32-byte token goes to the browser in an HttpOnly
// cookie (rn_session). Only the SHA-256 hash of the token is stored in
// the sessions table, so a database leak does not leak live sessions.
// Session lifetime: 30 days.

const crypto = require('crypto');
const { promisify } = require('util');
const { backend } = require('./store');

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = 'rn_session';
const SESSION_DAYS = 30;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseCookies(req) {
  const header = (req.headers && (req.headers.cookie || req.headers.Cookie)) || '';
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  const proto = req.headers && (req.headers['x-forwarded-proto'] || '');
  return proto === 'https' || !!process.env.VERCEL || process.env.NODE_ENV === 'production';
}

function sessionCookie(req, token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  await backend.createSession(userId, hashToken(token), expiresAt);
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_DAYS * 24 * 3600));
  return token;
}

async function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  return backend.getUserBySession(hashToken(token));
}

async function endSession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) await backend.deleteSession(hashToken(token));
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
}

function publicUser(user) {
  if (!user) return null;
  const s = user.socials || {};
  const pick = (v) => (typeof v === 'string' && v ? v : null);
  return {
    id: user.id, name: user.name, email: user.email,
    walletAddress: user.walletAddress || null,
    // Connection readiness: future external identity (e.g. Firebase
    // UID) mapped in users.external_id. Null until accounts connect.
    externalId: user.externalId || null,
    // Saved social handles (no '@'), used to tag this person when
    // their posts go out on Raahi's channels. Nulls until they save
    // them (POST /api/me-socials).
    socials: {
      instagram: pick(s.instagram),
      tiktok: pick(s.tiktok),
      youtube: pick(s.youtube),
      x: pick(s.x),
      threads: pick(s.threads),
    },
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  startSession,
  currentUser,
  endSession,
  publicUser,
  COOKIE_NAME,
};
