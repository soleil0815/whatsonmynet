// Backups on the server are compressed (.sqlite.gz, 0600), ten daily ones by default; older uncompressed copies are
// compressed once; the copies before a schema update or a restore stop piling up; a restore takes .gz and .sqlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { tmp, memoryDb } from './helpers.js';
import { openDatabase, verifyKey, backupDatabase, migrate } from '../src/db.js';
import { createSettings, DEFAULTS } from '../src/settings.js';
import { createBackups, pendingPath } from '../src/backup.js';

function makeDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'whatsonmynet.sqlite');
  const db = openDatabase(file);
  verifyKey(db);
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('admin','x','admin',?)").run(ts);
  for (let i = 0; i < 200; i++) db.prepare('INSERT INTO devices(name,created_at,updated_at) VALUES(?,?,?)').run(`Gerät ${i} ${'x'.repeat(200)}`, ts, ts);
  return { db, file };
}

test('daily backup: compressed, private, a real database inside, ten by default', async () => {
  assert.equal(DEFAULTS['backup.keep'], 10);
  const dir = fs.mkdtempSync(path.join(tmp, 'gz-'));
  const { db, file } = makeDb(dir);
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  // what was there before: 12 old uncompressed daily copies, and 12 copies before schema updates
  const raw = fs.readFileSync(file);
  for (let i = 1; i <= 12; i++) {
    const d = `2026-10-${String(i).padStart(2, '0')}`;
    fs.writeFileSync(path.join(bdir, `whatsonmynet-${d}-03-00-00.sqlite`), raw, { mode: 0o600 });
    fs.utimesSync(path.join(bdir, `whatsonmynet-${d}-03-00-00.sqlite`), new Date(`${d}T03:00:00Z`), new Date(`${d}T03:00:00Z`));
    fs.writeFileSync(path.join(bdir, `whatsonmynet-before-schema-${i}-${d}-03-00-00.sqlite`), raw, { mode: 0o600 });
  }
  const f = await backupDatabase(db, createSettings(db).get('backup.keep'), bdir);
  assert.match(path.basename(f), /^whatsonmynet-\d{4}-.*\.sqlite\.gz$/);
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
  assert.ok(fs.statSync(f).size < raw.length / 2, `compressed: ${fs.statSync(f).size} of ${raw.length}`);
  const out = path.join(dir, 'check.sqlite');
  fs.writeFileSync(out, zlib.gunzipSync(fs.readFileSync(f)));
  const c = new Database(out, { readonly: true });
  assert.equal(c.prepare('SELECT COUNT(*) n FROM devices').get().n, 200);
  c.close();
  const files = fs.readdirSync(bdir);
  assert.equal(files.filter((x) => x.endsWith('.sqlite')).length, 0, 'old copies compressed too');
  assert.equal(files.filter((x) => /^whatsonmynet-\d{4}-/.test(x)).length, 10, 'ten daily ones');
  assert.ok(files.includes(path.basename(f)), 'the newest stays');
  assert.equal(files.filter((x) => x.includes('before-schema')).length, 10, 'copies before updates no longer pile up');
  const kept = fs.statSync(path.join(bdir, 'whatsonmynet-2026-10-12-03-00-00.sqlite.gz'));
  assert.equal(kept.mtime.toISOString(), '2026-10-12T03:00:00.000Z', 'a compressed old copy keeps its date');
  db.close();
});

test('restore takes a compressed backup from the list and a compressed upload; garbage is refused', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'gzr-'));
  const { db, file } = makeDb(dir);
  const bdir = path.join(dir, 'backups');
  const f = await backupDatabase(db, 10, bdir);
  let restarts = 0;
  const backups = createBackups({ db, settings: createSettings(db), dbFile: file, backupsDir: bdir, restart: () => { restarts++; } });
  assert.ok(backups.list().some((x) => x.name === path.basename(f) && x.kind === 'daily'));
  const info = await backups.restore({ name: path.basename(f) });
  assert.equal(info.devices, 200);
  assert.equal(fs.readFileSync(pendingPath(file)).subarray(0, 15).toString(), 'SQLite format 3');
  fs.rmSync(pendingPath(file));
  const up = await backups.restore({ buffer: fs.readFileSync(f) });
  assert.equal(up.devices, 200);
  assert.equal(restarts, 2);
  fs.rmSync(pendingPath(file));
  await assert.rejects(backups.restore({ buffer: Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(4000, 7)]) }), { code: 'err.backupFile' });
  await assert.rejects(backups.restore({ buffer: zlib.gzipSync(Buffer.alloc(5000, 1)) }), { code: 'err.backupFile' });
  assert.equal(fs.existsSync(pendingPath(file)), false);
  db.close();
});

test('migration 34: the old default 7 becomes 10, an own choice stays', () => {
  for (const [stored, expected] of [['7', 10], ['5', 5], ['30', 30]]) {
    const db = memoryDb();
    db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('backup.keep', ?)").run(stored);
    db.pragma('user_version = 33');
    migrate(db, { quiet: true });
    assert.equal(createSettings(db).get('backup.keep'), expected);
  }
});
