// Backup and restore in the web interface.
//
// Download: a consistent copy of the database (SQLite online backup). Stored passwords inside it are encrypted with
// the key (data/secret.key or WOMN_SECRET) - a restore only works with the same key.
// Restore: the file is checked (SQLite, schema not newer, same key), stored as data/restore-pending.sqlite and the
// program restarts; at the next start the current database is moved to the backups and the new one takes its place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { HttpError } from './lib/http.js';
import { decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';
import { backupDatabase, MIGRATIONS, migrate } from './db.js';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const NAME = /^whatsonmynet-[\w.-]+\.sqlite$/;
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

/** At startup, before the database is opened: put a waiting restore in place */
export function applyPendingRestore(dbFile, backupsDir) {
  const pending = pendingPath(dbFile);
  if (!fs.existsSync(pending)) return false;
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  if (fs.existsSync(dbFile)) {
    const keep = path.join(backupsDir, `whatsonmynet-before-restore-${stamp}.sqlite`);
    // The latest changes may still be in the -wal file only: write them into the database first, then copy
    try { const old = new Database(dbFile); try { old.pragma('wal_checkpoint(TRUNCATE)'); } finally { old.close(); } } catch (e) { log.warn(`Restore: checkpoint of the previous database failed: ${e.message}`); }
    fs.copyFileSync(dbFile, keep);
    fs.chmodSync(keep, 0o600);
    log.info(`Restore: the previous database was kept as ${keep}`);
  }
  // Sessions in the backup were open when it was made: signed out or revoked since, they must not come back to life
  try {
    const r = new Database(pending);
    try {
      r.prepare('DELETE FROM sessions').run();
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
        if (buffer) {
          if (buffer.length < 1024) throw new HttpError(400, 'err.backupFile');
          fs.writeFileSync(tmp, buffer, { mode: 0o600 });
        } else {
          fs.copyFileSync(this.file(name), tmp);
          fs.chmodSync(tmp, 0o600);
        }
        const info = inspect(tmp);
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
