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
  if (state.users.find((u) => u.email === email)) throw new Error('an account with this email already exists');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: uid('user'), name, email, salt, passHash: hash(password, salt), createdAt: Date.now() };
  state.users.push(user);
  db.save();
  return user;
}

export function verify({ email, password }) {
  const state = db.get();
  email = String(email || '').trim().toLowerCase();
  const user = state.users.find((u) => u.email === email);
  if (!user) return null;
  const candidate = hash(password || '', user.salt);
  const ok =
    candidate.length === user.passHash.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(user.passHash));
  return ok ? user : null;
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
const PUBLIC = new Set(['/register', '/login']);

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
