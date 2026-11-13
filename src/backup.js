// Backup and restore in the web interface.
//
// Download: a consistent copy of the database (SQLite online backup). Stored passwords inside it are encrypted with
// the key (data/secret.key or WOMN_SECRET) - a restore only works with the same key.
// Restore: the file is checked (SQLite, schema not newer, same key), stored as data/restore-pending.sqlite and the
// program restarts; at the next start the current database is moved to the backups and the new one takes its place.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { HttpError } from './lib/http.js';
import { decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';
import { backupDatabase, MIGRATIONS } from './db.js';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const NAME = /^whatsonmynet-[\w.-]+\.sqlite$/;

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
    return {
      schema: version,
      devices: db.prepare('SELECT COUNT(*) n FROM devices').get().n,
      users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    };
  } finally { db.close(); }
}

/** At startup, before the database is opened: put a waiting restore in place */
export function applyPendingRestore(dbFile, backupsDir) {
  const pending = pendingPath(dbFile);
  if (!fs.existsSync(pending)) return false;
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  if (fs.existsSync(dbFile)) {
    const keep = path.join(backupsDir, `whatsonmynet-before-restore-${stamp}.sqlite`);
    fs.copyFileSync(dbFile, keep);
    fs.chmodSync(keep, 0o600);
    log.info(`Restore: the previous database was kept as ${keep}`);
  }
  for (const f of [`${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(pending, dbFile);
  fs.chmodSync(dbFile, 0o600);
  log.info('Restore: the restored database is now in use');
  return true;
}

export function createBackups({ db, settings, dbFile, backupsDir, restart = () => setTimeout(() => process.exit(0), 500).unref() }) {
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
    /** Fresh copy for downloading (deleted after sending) */
    async snapshot() {
      const f = path.join(os.tmpdir(), `womn-download-${process.pid}-${Date.now()}.sqlite`);
      await db.backup(f);
      return f;
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
