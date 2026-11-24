// Backup and restore in the web interface.
//
// Download: a consistent copy of the database (SQLite online backup). Stored passwords inside it are encrypted with
// the key (data/secret.key or WOMN_SECRET) - a restore only works with the same key.
// Restore: the file is checked (SQLite, schema not newer, same key), stored as data/restore-pending.sqlite and the
// program restarts; at the next start the current database is moved to the backups and the new one takes its place.
// Backups on the server are compressed (.sqlite.gz); a restore takes compressed and uncompressed files alike.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { HttpError } from './lib/http.js';
import { decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';
import { backupDatabase, MIGRATIONS, migrate, tidyBackups } from './db.js';
import { gzipFileSync, gunzipFile, isGzip, freeName } from './lib/gz.js';
import zlib from 'node:zlib';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const NAME = /^whatsonmynet-[\w.-]+\.sqlite(\.gz)?$/;
const MAX_UNPACKED = 4 * 1024 ** 3;
const DOWNLOAD = /^download-\d+-\d+-[0-9a-f]{8}\.sqlite\.tmp$/;

export const pendingPath = (dbFile) => path.join(path.dirname(dbFile), 'restore-pending.sqlite');

/** Checks a database file: SQLite, belongs to WhatsOnMyNet, not newer than this version, same key. Returns info. */
export function inspect(file) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (!head.equals(SQLITE_MAGIC)) throw new HttpError(400, 'err.backupFile');
  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); } catch { throw new HttpError(400, 'err.backupFile'); }
  try {
    const ok = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('devices','users','settings')").all().length === 3;
    if (!ok) throw new HttpError(400, 'err.backupFile');
    const version = db.pragma('user_version', { simple: true });
    if (version > MIGRATIONS.length) throw new HttpError(400, 'err.backupNewer');
    const check = db.prepare("SELECT value FROM settings WHERE key='_keycheck'").get();
    if (check) {
      let same = false;
      try { same = decrypt(JSON.parse(check.value)) === 'whatsonmynet'; } catch { same = false; }
      if (!same) throw new HttpError(400, 'err.backupKey');
    }
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new HttpError(400, 'err.backupBroken');
    // Schema 0 is no backup of ours; and without an active admin nobody could sign in afterwards
    if (version < 1) throw new HttpError(400, 'err.backupFile');
    if (!db.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1").get()) throw new HttpError(400, 'err.backupNoAdmin');
    trialMigration(file);
    return {
      schema: version,
      devices: db.prepare('SELECT COUNT(*) n FROM devices').get().n,
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    };
  } finally { db.close(); }
}

/** The schema updates must run on the file - tried on a copy, so that a restore can never leave a server that does not start */
function trialMigration(file) {
  const copy = `${file}.trial`;
  try {
    fs.copyFileSync(file, copy);
    const t = new Database(copy);
    try { t.pragma('foreign_keys = ON'); migrate(t, { quiet: true }); } finally { t.close(); }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    log.warn(`Restore refused: the schema update fails on this file (${e.message})`);
    throw new HttpError(400, 'err.backupBroken');
  } finally {
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) fs.rmSync(f, { force: true });
  }
}

// --- Sign-in data stay as they are today ----------------------------------------------------------------------
// A backup holds the keys and passwords of its day. A key renewed or deleted since (it leaked), a changed password or
// a removed account must not work again after a restore: for the same installation (same check value of the key) the
// sign-in data are taken from the current database. Accounts, scan agents and host keys are the same ones only with
// the same id AND the same creation time (ids may be given again after a delete). What a person may do counts as
// sign-in data too: today's role and location limits (a user demoted or limited since must not get the old rights
// back), and the SNMP access data a scan agent gets (narrowed since → not widened again by a restore).
const USER_CRED = ['password_hash', 'password_changed_at', 'active', 'role', 'totp_secret', 'totp_enabled', 'totp_last_step', 'recovery_codes'];
const AGENT_CRED = ['token_hash', 'enabled', 'snmp_mode', 'snmp_communities', 'snmp_v3'];
const hasTable = (d, t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const colsOf = (d, t) => (hasTable(d, t) ? d.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name) : []);
const keycheckOf = (d) => { try { return d.prepare("SELECT value FROM settings WHERE key='_keycheck'").get()?.value || ''; } catch { return ''; } };

/** Same installation: both carry the same check value (written once at the first start, kept by every restore) */
function sameInstallation(a, b) {
  const k = keycheckOf(a);
  return !!k && k === keycheckOf(b);
}

/** Today's sign-in data (read from the current database, small: accounts and keys only) */
function readCredentials(live) {
  const rows = (t, cols) => {
    const have = colsOf(live, t);
    const want = ['id', 'created_at', ...cols].filter((c) => have.includes(c));
    return have.length ? new Map(live.prepare(`SELECT ${want.join(',')} FROM ${t}`).all().map((r) => [r.id, r])) : null;
  };
  return {
    users: rows('users', USER_CRED),
    userCols: USER_CRED.filter((c) => colsOf(live, 'users').includes(c)),
    agents: rows('agents', AGENT_CRED),
    agentCols: AGENT_CRED.filter((c) => colsOf(live, 'agents').includes(c)),
    // location limits: user → [{ id, created_at }] of today's locations (a location is the same only with its creation time)
    scopes: hasTable(live, 'user_locations') ? live.prepare('SELECT ul.user_id, l.id, l.created_at FROM user_locations ul JOIN locations l ON l.id=ul.location_id').all()
      .reduce((m, r) => m.set(r.user_id, [...(m.get(r.user_id) || []), { id: r.id, created_at: r.created_at }]), new Map()) : null,
    hostTokens: rows('host_tokens', ['token_hash']),
    apiTokens: live.prepare("SELECT value FROM settings WHERE key='api.tokens'").get()?.value ?? null,
  };
}

/** Into the restored database (r): today's sign-in data; what is gone today comes back switched off */
function carryCredentials(r, cred) {
  const same = (mine, row) => mine && mine.created_at === row.created_at;
  r.transaction(() => {
    if (cred.users && hasTable(r, 'users')) {
      const cols = cred.userCols.filter((c) => colsOf(r, 'users').includes(c));
      const set = r.prepare(`UPDATE users SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`);
      const scoped = cred.scopes && hasTable(r, 'user_locations') && hasTable(r, 'locations');
      for (const u of r.prepare('SELECT id, created_at FROM users').all()) {
        const now = cred.users.get(u.id);
        if (!same(now, u)) { r.prepare('UPDATE users SET active=0 WHERE id=?').run(u.id); continue; }
        set.run(...cols.map((c) => now[c]), u.id);
        if (!scoped) continue;
        // today's location limits: only locations that are the same ones in the backup
        const want = cred.scopes.get(u.id) || [];
        r.prepare('DELETE FROM user_locations WHERE user_id=?').run(u.id);
        let kept = 0;
        for (const l of want) {
          if (r.prepare('SELECT created_at FROM locations WHERE id=?').get(l.id)?.created_at !== l.created_at) continue;
          r.prepare('INSERT INTO user_locations(user_id, location_id) VALUES(?,?)').run(u.id, l.id);
          kept++;
        }
        // limited today, but none of the locations is in the backup: no limit would mean "everything" - switched off
        if (want.length && !kept) {
          r.prepare('UPDATE users SET active=0 WHERE id=?').run(u.id);
          log.warn(`Restore: user ${u.id} is limited to locations the backup does not have - switched off`);
        }
      }
    }
    if (cred.agents && hasTable(r, 'agents')) {
      const list = r.prepare('SELECT id, created_at FROM agents').all();
      // first every key unusable (token_hash is unique), then today's ones back
      for (const a of list) r.prepare('UPDATE agents SET token_hash=?, enabled=0 WHERE id=?').run(`revoked-${a.id}-${crypto.randomBytes(16).toString('hex')}`, a.id);
      // A backup from before the SNMP choice of agents: add the columns now (the schema update later sees them and skips),
      // otherwise the update would give every agent "all" again although today it has less
      if (cred.agentCols.includes('snmp_mode') && !colsOf(r, 'agents').includes('snmp_mode')) {
        r.exec(MIGRATIONS.find((m) => String(m?.unless || '').includes("'agents') WHERE name = 'snmp_mode'")).sql);
      }
      const cols = cred.agentCols.filter((c) => colsOf(r, 'agents').includes(c));
      const set = r.prepare(`UPDATE agents SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`);
      for (const a of list) {
        const now = cred.agents.get(a.id);
        if (same(now, a)) set.run(...cols.map((c) => (c === 'enabled' ? now.enabled ?? 1 : now[c])), a.id);
      }
    }
    if (cred.hostTokens && hasTable(r, 'host_tokens')) {
      for (const h of r.prepare('SELECT id, created_at FROM host_tokens').all()) {
        const now = cred.hostTokens.get(h.id);
        if (same(now, h)) r.prepare('UPDATE host_tokens SET token_hash=? WHERE id=?').run(now.token_hash, h.id);
        else r.prepare('DELETE FROM host_tokens WHERE id=?').run(h.id);
      }
    }
    r.prepare("DELETE FROM settings WHERE key='api.tokens'").run();
    if (cred.apiTokens !== null) r.prepare("INSERT INTO settings(key,value) VALUES('api.tokens',?)").run(cred.apiTokens);
  })();
}

/**
 * Before a restore is accepted: with today's accounts, is there still an administrator of the backup who may sign in?
 * (Otherwise nobody could sign in afterwards.) Backups of another installation are taken as they are.
 */
function checkAdminLeft(file, live) {
  const b = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (!sameInstallation(b, live)) return;
    // roles and the active flag are today's after the restore: an admin of today who is in the backup
    const today = live.prepare("SELECT created_at FROM users WHERE id=? AND active=1 AND role='admin'");
    const ok = b.prepare('SELECT id, created_at FROM users').all().some((u) => today.get(u.id)?.created_at === u.created_at);
    if (!ok) throw new HttpError(400, 'err.backupNoAdminLive');
  } finally { b.close(); }
}

/** At startup, before the database is opened: put a waiting restore in place */
export function applyPendingRestore(dbFile, backupsDir) {
  const pending = pendingPath(dbFile);
  if (!fs.existsSync(pending)) return false;
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  let cred = null;
  if (fs.existsSync(dbFile)) {
    const keep = freeName(path.join(backupsDir, `whatsonmynet-before-restore-${stamp}.sqlite.gz`));
    // The latest changes may still be in the -wal file only: write them into the database first, then copy
    try { const old = new Database(dbFile); try { old.pragma('wal_checkpoint(TRUNCATE)'); } finally { old.close(); } } catch (e) { log.warn(`Restore: checkpoint of the previous database failed: ${e.message}`); }
    gzipFileSync(dbFile, keep);
    log.info(`Restore: the previous database was kept as ${keep}`);
    // today's keys and passwords (a damaged current database - often the reason for the restore - has none to give)
    try {
      const live = new Database(dbFile, { readonly: true, fileMustExist: true });
      const r = new Database(pending, { readonly: true, fileMustExist: true });
      try { if (sameInstallation(r, live)) cred = readCredentials(live); } finally { r.close(); live.close(); }
    } catch (e) { log.warn(`Restore: could not read the sign-in data of the previous database: ${e.message}`); }
  }
  // Sessions in the backup were open when it was made: signed out or revoked since, they must not come back to life
  try {
    const r = new Database(pending);
    try {
      r.prepare('DELETE FROM sessions').run();
      if (cred) {
        try {
          carryCredentials(r, cred);
          log.info('Restore: keys, passwords and accounts are as they were before the restore');
          if (!r.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1").get()) log.error('Restore: no active administrator left - create one with "womn-admin reset <user>"');
        } catch (e) { log.warn(`Restore: could not take over today's keys and passwords: ${e.message}`); }
      }
      r.pragma('wal_checkpoint(TRUNCATE)');
    } finally { r.close(); }
  } catch (e) { log.warn(`Restore: could not remove the sessions of the restored database: ${e.message}`); }
  for (const f of [`${dbFile}-wal`, `${dbFile}-shm`, `${pending}-wal`, `${pending}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(pending, dbFile);
  fs.chmodSync(dbFile, 0o600);
  log.info('Restore: the restored database is now in use');
  return true;
}

export function createBackups({ db, settings, dbFile, backupsDir, restart = () => setTimeout(() => { try { db.close(); } catch { /* closed already */ } process.exit(0); }, 500).unref() }) {
  return {
    list() {
      if (!fs.existsSync(backupsDir)) return [];
      return fs.readdirSync(backupsDir).filter((f) => NAME.test(f)).map((f) => {
        const st = fs.statSync(path.join(backupsDir, f));
        return { name: f, size: st.size, at: st.mtime.toISOString(), kind: f.includes('before-schema') ? 'schema' : f.includes('before-restore') ? 'restore' : 'daily' };
      }).sort((a, b) => b.at.localeCompare(a.at));
    },
    async create() {
      const file = await backupDatabase(db, settings.get('backup.keep'), backupsDir);
      return path.basename(file);
    },
    /** Keep only as many as set (daily ones, and the same number of copies before an update or a restore) - right when
     * the number is changed, not only at the next nightly backup */
    async tidy() {
      if (fs.existsSync(backupsDir)) await tidyBackups(backupsDir, Number(settings.get('backup.keep')) || 10);
    },
    /** Delete one stored backup by hand (a name from the list only) */
    remove(name) {
      fs.rmSync(this.file(name), { force: true });
    },
    /** Path of a stored backup (only names from the list - never a path from outside) */
    file(name) {
      if (!NAME.test(String(name)) || String(name).includes('/')) throw new HttpError(404, 'err.notFound');
      const f = path.join(backupsDir, name);
      if (!fs.existsSync(f)) throw new HttpError(404, 'err.notFound');
      return f;
    },
    /**
     * Fresh copy for downloading: in the backups folder of the data directory (not the shared temp folder), readable
     * only by this program (0600), under a name the list never shows. The caller removes it with discard() after
     * sending - also when sending fails or the browser aborts. Leftovers of a crash are removed by the next download.
     */
    async snapshot() {
      fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
      for (const old of fs.readdirSync(backupsDir).filter((x) => DOWNLOAD.test(x))) {
        const p = path.join(backupsDir, old);
        try { if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.rmSync(p, { force: true }); } catch { /* removed meanwhile */ }
      }
      const f = path.join(backupsDir, `download-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite.tmp`);
      // Created empty with 0600 first: the copy never exists with wider rights, whatever the umask
      fs.closeSync(fs.openSync(f, 'wx', 0o600));
      try {
        await db.backup(f);
        fs.chmodSync(f, 0o600);
      } catch (e) {
        this.discard(f);
        throw e;
      }
      return f;
    },
    /** Removes a download copy made by snapshot() (only those - never another file) */
    discard(f) {
      if (!f || path.resolve(path.dirname(f)) !== path.resolve(backupsDir) || !DOWNLOAD.test(path.basename(f))) return;
      for (const x of [f, `${f}-journal`, `${f}-wal`, `${f}-shm`]) fs.rmSync(x, { force: true });
    },
    /** buffer (upload) or name (stored backup) → checked, waits as restore-pending, program restarts */
    async restore({ buffer = null, name = null }) {
      const pending = pendingPath(dbFile);
      const tmp = `${pending}.upload`;
      try {
        fs.rmSync(tmp, { force: true });
        if (buffer) {
          // a compressed backup (.sqlite.gz) is unpacked first - with a limit, a "zip bomb" stops early
          let data = buffer;
          if (isGzip(buffer)) {
            try { data = zlib.gunzipSync(buffer, { maxOutputLength: MAX_UNPACKED }); } catch { throw new HttpError(400, 'err.backupFile'); }
          }
          if (data.length < 1024) throw new HttpError(400, 'err.backupFile');
          fs.writeFileSync(tmp, data, { mode: 0o600 });
        } else {
          const src = this.file(name);
          if (src.endsWith('.gz')) {
            try { await gunzipFile(src, tmp, MAX_UNPACKED); } catch { throw new HttpError(400, 'err.backupFile'); }
          } else {
            fs.copyFileSync(src, tmp);
            fs.chmodSync(tmp, 0o600);
          }
        }
        const info = inspect(tmp);
        checkAdminLeft(tmp, db);
        fs.renameSync(tmp, pending);
        log.warn(`Restore requested (${info.devices} devices, ${info.users} users, schema ${info.schema}) - restarting`);
        restart();
        return info;
      } finally {
        // the read-only check may leave -wal/-shm files of the upload behind
        for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
      }
    },
  };
}
