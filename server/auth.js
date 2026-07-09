// Multi-user auth: scrypt password hashes + cookie sessions.
import crypto from 'node:crypto';
import { db, uid } from './store.js';

const COOKIE = 'deem_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function register({ name, email, password }) {
  const state = db.get();
  email = String(email || '').trim().toLowerCase();
  if (!email || !password || !name) throw new Error('name, email and password are required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid email address');
  if (String(password).length < 8) throw new Error('password must be at least 8 characters');
  if (state.users.find((u) => u.email === email)) throw new Error('an account with this email already exists');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: uid('user'), name, email, salt, passHash: hash(password, salt), createdAt: Date.now() };
  state.users.push(user);
  db.save();
  return user;
}

// Brute-force protection: 5 failures locks the account for 15 minutes.
const attempts = new Map(); // email -> { count, lockedUntil }
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

export function verify({ email, password }) {
  const state = db.get();
  email = String(email || '').trim().toLowerCase();

  const a = attempts.get(email);
  if (a?.lockedUntil > Date.now()) {
    const mins = Math.ceil((a.lockedUntil - Date.now()) / 60000);
    throw new Error(`too many failed attempts — locked for ${mins} more minute(s)`);
  }

  const user = state.users.find((u) => u.email === email);
  const candidate = hash(password || '', user?.salt || 'x');
  const ok =
    Boolean(user) &&
    candidate.length === user.passHash.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(user.passHash));

  if (!ok) {
    const next = { count: (a?.count || 0) + 1, lockedUntil: 0 };
    if (next.count >= MAX_FAILURES) {
      next.lockedUntil = Date.now() + LOCK_MS;
      next.count = 0;
    }
    attempts.set(email, next);
    return null;
  }
  attempts.delete(email);
  return user;
}

export function createSession(userId) {
  const state = db.get();
  const token = crypto.randomBytes(24).toString('hex');
  state.sessions.push({ token, userId, createdAt: Date.now() });
  db.save();
  return token;
}

export function destroySession(token) {
  const state = db.get();
  state.sessions = state.sessions.filter((s) => s.token !== token);
  db.save();
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function currentUser(req) {
  const token = parseCookies(req.headers.cookie).deem_session;
  if (!token) return null;
  const state = db.get();
  const session = state.sessions.find((s) => s.token === token);
  if (!session || Date.now() - session.createdAt > SESSION_TTL) return null;
  const user = state.users.find((u) => u.id === session.userId);
  return user ? { ...user, token } : null;
}

// Mounted at /api, so req.path here is relative to that prefix.
const PUBLIC = new Set(['/register', '/login', '/health']);

export function authMiddleware(req, res, next) {
  if (PUBLIC.has(req.path)) return next();
  const user = currentUser(req);
  if (!user) {
    if (req.path === '/profile') return res.json(null); // login screen probe
    return res.status(401).json({ error: 'not signed in' });
  }
  req.user = user;
  next();
}
