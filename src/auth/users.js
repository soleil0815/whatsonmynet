// Local user accounts (Active Directory follows in a later version).
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { HttpError, line, oneOf } from '../lib/http.js';
import { ROLES } from './session.js';

export const MIN_PASSWORD = 10;
export const LANGS = ['de', 'en'];
export const THEMES = ['system', 'light', 'dark'];
const USERNAME = /^[a-z0-9][a-z0-9._@-]{1,63}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;

export function checkPassword(pw, username = '') {
  const p = typeof pw === 'string' ? pw : '';
  if (p.length < MIN_PASSWORD || p.length > 1024) throw new HttpError(400, 'err.passwordShort', String(MIN_PASSWORD));
  if (username && p.toLowerCase() === String(username).toLowerCase()) throw new HttpError(400, 'err.passwordIsName');
  return p;
}

const PUBLIC = 'id, username, display_name, email, role, language, theme, active, created_at, last_login';

export function createUsers(db) {
  const byName = db.prepare('SELECT * FROM users WHERE username=?');
  const adminsLeft = (exceptId) => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?").get(exceptId).n;

  function clean(input, { partial = false } = {}) {
    const out = {};
    if (!partial || 'username' in input) {
      const u = line(input.username, 64);
      if (!USERNAME.test(u)) throw new HttpError(400, 'err.username');
      out.username = u;
    }
    if (!partial || 'display_name' in input) out.display_name = line(input.display_name, 120);
    if (!partial || 'email' in input) {
      const e = line(input.email, 254);
      if (e && !EMAIL.test(e)) throw new HttpError(400, 'err.email');
      out.email = e;
    }
    if (!partial || 'role' in input) out.role = oneOf(input.role, ROLES, partial ? undefined : 'viewer');
    if (!partial || 'language' in input) out.language = oneOf(input.language, LANGS, 'de');
    if ('theme' in input) out.theme = oneOf(input.theme, THEMES, 'system');
    if ('active' in input) out.active = input.active ? 1 : 0;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  return {
    count: () => db.prepare('SELECT COUNT(*) n FROM users').get().n,
    list: () => db.prepare(`SELECT ${PUBLIC} FROM users ORDER BY username`).all(),
    get: (id) => db.prepare(`SELECT ${PUBLIC} FROM users WHERE id=?`).get(id),
    authenticate(username, password) {
      const u = byName.get(String(username || '').trim());
      const ok = verifyPassword(String(password || ''), u?.password_hash);
      return ok && u.active ? u : null;
    },
    create(input) {
      const v = clean(input);
      const pw = checkPassword(input.password, v.username);
      if (byName.get(v.username)) throw new HttpError(409, 'err.userExists');
      const now = new Date().toISOString();
      const r = db.prepare('INSERT INTO users(username,display_name,email,password_hash,role,language,theme,created_at,password_changed_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(v.username, v.display_name, v.email, hashPassword(pw), v.role, v.language, v.theme || 'system', now, now);
      return this.get(r.lastInsertRowid);
    },
    update(id, input, { self = false } = {}) {
      const cur = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!cur) throw new HttpError(404, 'err.notFound');
      // On the own account only personal settings can be changed (never role or active)
      const allowed = self ? ['display_name', 'email', 'language', 'theme'] : ['display_name', 'email', 'language', 'theme', 'role', 'active'];
      const subset = Object.fromEntries(Object.entries(input || {}).filter(([k]) => allowed.includes(k)));
      const v = clean(subset, { partial: true });
      const losesAdmin = cur.role === 'admin' && cur.active && ((v.role && v.role !== 'admin') || v.active === 0);
      if (losesAdmin && adminsLeft(id) === 0) throw new HttpError(400, 'err.lastAdmin');
      const keys = Object.keys(v);
      if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => v[k]), id);
      return this.get(id);
    },
    setPassword(id, password) {
      const u = db.prepare('SELECT username FROM users WHERE id=?').get(id);
      if (!u) throw new HttpError(404, 'err.notFound');
      const pw = checkPassword(password, u.username);
      db.prepare('UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?').run(hashPassword(pw), new Date().toISOString(), id);
    },
    remove(id) {
      const cur = db.prepare('SELECT role, active FROM users WHERE id=?').get(id);
      if (!cur) throw new HttpError(404, 'err.notFound');
      if (cur.role === 'admin' && cur.active && adminsLeft(id) === 0) throw new HttpError(400, 'err.lastAdmin');
      db.prepare('DELETE FROM users WHERE id=?').run(id);
    },
  };
}
