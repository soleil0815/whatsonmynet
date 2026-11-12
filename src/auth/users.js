// User accounts: local ones (password stored as scrypt hash) and ones from Active Directory (no password here).
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

const PUBLIC = 'id, username, display_name, email, role, language, theme, active, created_at, last_login, source';

export function createUsers(db) {
  const byName = db.prepare('SELECT * FROM users WHERE username=?');
  const adminsLeft = (exceptId) => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?").get(exceptId).n;

  const locsOf = db.prepare('SELECT location_id FROM user_locations WHERE user_id=? ORDER BY location_id');
  function withLocations(u) { return u ? { ...u, locations: locsOf.all(u.id).map((r) => r.location_id) } : u; }

  /** Limits a user to locations (empty list = all). Admins are never limited. */
  function setLocations(id, list) {
    const idsIn = [...new Set((Array.isArray(list) ? list : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 200);
    for (const l of idsIn) if (!db.prepare('SELECT 1 FROM locations WHERE id=?').get(l)) throw new HttpError(400, 'err.location');
    db.transaction(() => {
      db.prepare('DELETE FROM user_locations WHERE user_id=?').run(id);
      const ins = db.prepare('INSERT INTO user_locations(user_id,location_id) VALUES(?,?)');
      for (const l of idsIn) ins.run(id, l);
    })();
  }

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
    list: () => db.prepare(`SELECT ${PUBLIC} FROM users ORDER BY username`).all().map(withLocations),
    get: (id) => withLocations(db.prepare(`SELECT ${PUBLIC} FROM users WHERE id=?`).get(id)),
    /** Local accounts only – an account from the directory never signs in with a password stored here */
    authenticate(username, password) {
      const u = byName.get(String(username || '').trim());
      const ok = verifyPassword(String(password || ''), u?.source === 'local' ? u.password_hash : '');
      return ok && u.active && u.source === 'local' ? u : null;
    },
    /** 'local' | 'ldap' | null – which kind of account has this name */
    sourceOf(username) { return byName.get(String(username || '').trim())?.source || null; },
    /**
     * After a successful directory sign-in: create the account or update name, e-mail and role from AD.
     * Returns the full row, or null if an admin has switched the account off here.
     */
    upsertDirectory(info) {
      const now = new Date().toISOString();
      const cur = byName.get(info.username);
      if (cur && cur.source !== 'ldap') throw new HttpError(409, 'err.userExists');
      if (!cur) {
        db.prepare("INSERT INTO users(username,display_name,email,password_hash,role,source,ext_dn,created_at) VALUES(?,?,?,'',?,'ldap',?,?)")
          .run(info.username, info.display_name || '', info.email || '', info.role, info.dn, now);
      } else {
        db.prepare('UPDATE users SET display_name=?, email=?, role=?, ext_dn=? WHERE id=?').run(info.display_name || cur.display_name, info.email || cur.email, info.role, info.dn, cur.id);
      }
      const u = byName.get(info.username);
      return u.active ? u : null;
    },
    create(input) {
      const v = clean(input);
      const pw = checkPassword(input.password, v.username);
      if (byName.get(v.username)) throw new HttpError(409, 'err.userExists');
      const now = new Date().toISOString();
      const r = db.prepare('INSERT INTO users(username,display_name,email,password_hash,role,language,theme,created_at,password_changed_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(v.username, v.display_name, v.email, hashPassword(pw), v.role, v.language, v.theme || 'system', now, now);
      if (v.role !== 'admin' && 'locations' in input) setLocations(Number(r.lastInsertRowid), input.locations);
      return this.get(r.lastInsertRowid);
    },
    update(id, input, { self = false } = {}) {
      const cur = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!cur) throw new HttpError(404, 'err.notFound');
      // On the own account only personal settings can be changed (never role or active)
      let allowed = self ? ['display_name', 'email', 'language', 'theme'] : ['display_name', 'email', 'language', 'theme', 'role', 'active'];
      // Directory accounts: name, e-mail and role come from AD at every sign-in
      if (cur.source === 'ldap') allowed = allowed.filter((k) => !['display_name', 'email', 'role'].includes(k));
      const subset = Object.fromEntries(Object.entries(input || {}).filter(([k]) => allowed.includes(k)));
      const v = clean(subset, { partial: true });
      const losesAdmin = cur.role === 'admin' && cur.active && ((v.role && v.role !== 'admin') || v.active === 0);
      if (losesAdmin && adminsLeft(id) === 0) throw new HttpError(400, 'err.lastAdmin');
      const keys = Object.keys(v);
      if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => v[k]), id);
      if (!self && input && 'locations' in input) setLocations(id, input.locations);
      return this.get(id);
    },
    setPassword(id, password) {
      const u = db.prepare('SELECT username, source FROM users WHERE id=?').get(id);
      if (!u) throw new HttpError(404, 'err.notFound');
      if (u.source !== 'local') throw new HttpError(400, 'err.adPassword');
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
