// Sessions (cookie + table), role checks, protection against password guessing.
import crypto from 'node:crypto';
import { randomToken } from '../lib/crypto.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

export const COOKIE = 'womn_sid';
// Maximum lifetime from sign-in - after that sign in again, even with constant use
export const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

/** The table only holds the SHA-256 of the cookie value: a database copy never lets anyone sign in. */
export function sessionKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createSessions(db, { idleMs = config.sessionHours * 3600 * 1000 } = {}) {
  const insert = db.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen,expires_at,ip) VALUES(?,?,?,?,?,?)');
  const find = db.prepare('SELECT s.id sid, s.created_at s_created, s.last_seen s_seen, s.expires_at, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?');
  const del = db.prepare('DELETE FROM sessions WHERE id=?');
  const touch = db.prepare('UPDATE sessions SET last_seen=?, expires_at=? WHERE id=?');

  // Cookies only over HTTPS - WhatsOnMyNet always speaks HTTPS (directly or through the proxy)
  const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'strict', secure: req.secure || !!req.socket?.encrypted, path: '/' });

  return {
    create(req, res, userId) {
      const token = randomToken(32);
      const now = Date.now();
      insert.run(sessionKey(token), userId, now, now, now + idleMs, req.ip || null);
      db.prepare('UPDATE users SET last_login=? WHERE id=?').run(new Date().toISOString(), userId);
      res.cookie(COOKIE, token, { ...cookieOpts(req), maxAge: idleMs });
    },
    destroy(req, res) {
      const token = req.cookies?.[COOKIE];
      if (token) del.run(sessionKey(token));
      res.clearCookie(COOKIE, { path: '/' });
    },
    middleware(req, res, next) {
      const token = req.cookies?.[COOKIE];
      if (!token) return next();
      const id = sessionKey(token);
      const row = find.get(id);
      const now = Date.now();
      if (!row) return next();
      const valid = row.active && row.expires_at > now && now - row.s_created < SESSION_MAX_AGE_MS;
      if (!valid) { del.run(id); return next(); }
      const { sid, s_created: _c, s_seen: seen, expires_at: _e, password_hash: _p, ...user } = row;
      req.user = user;
      req.sessionId = sid;
      if (now - seen > TOUCH_EVERY_MS) {
        const until = Math.min(now + idleMs, row.s_created + SESSION_MAX_AGE_MS);
        touch.run(now, until, id);
        res.cookie(COOKIE, token, { ...cookieOpts(req), maxAge: until - now });
      }
      next();
    },
    purgeExpired() { db.prepare('DELETE FROM sessions WHERE expires_at < ? OR created_at < ?').run(Date.now(), Date.now() - SESSION_MAX_AGE_MS); },
    destroyAllForUser(userId, exceptId = null) {
      db.prepare('DELETE FROM sessions WHERE user_id=? AND id IS NOT ?').run(userId, exceptId);
    },
  };
}

/** Minimal cookie parser (saves a dependency). */
export function parseCookies(req, _res, next) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  req.cookies = out;
  next();
}

export const ROLES = ['viewer', 'editor', 'admin'];
const RANK = { viewer: 1, editor: 2, admin: 3 };

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'err.unauthorized'));
  next();
}

export function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'err.unauthorized'));
    if ((RANK[req.user.role] || 0) < RANK[role]) return next(new HttpError(403, 'err.forbidden'));
    next();
  };
}

export const can = (user, role) => (RANK[user?.role] || 0) >= RANK[role];

/** At most 8 failed attempts per user name and 40 per IP address in 15 minutes. */
export function createLoginLimiter({ max = 8, ipMax = 40, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  const over = (k, limit) => { const e = hits.get(k); return e && e.until > Date.now() && e.count >= limit; };
  const bump = (k) => {
    const e = hits.get(k);
    if (!e || e.until < Date.now()) hits.set(k, { count: 1, until: Date.now() + windowMs });
    else e.count++;
  };
  const nameKey = (u) => `u|${String(u || '').trim().toLowerCase()}`;
  return {
    check(ip, user) {
      if (over(nameKey(user), max) || over(`i|${ip}`, ipMax)) throw new HttpError(429, 'err.tooManyAttempts');
    },
    fail(ip, user) {
      bump(nameKey(user)); bump(`i|${ip}`);
      if (hits.size > 10000) for (const [k, v] of hits) if (v.until < Date.now()) hits.delete(k);
    },
    success(_ip, user) { hits.delete(nameKey(user)); },
  };
}
