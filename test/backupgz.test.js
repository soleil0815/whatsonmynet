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

test('Windows noise: a new installation leaves it out, one already in use (migration 35) keeps taking everything', async () => {
  const { WIN_NOISE } = await import('../src/settings.js');
  const fresh = memoryDb();
  assert.equal(createSettings(fresh).get('events.winDeny'), WIN_NOISE);
  for (const id of ['4624', '4634', '5858', '7036', '10016']) assert.ok(WIN_NOISE.split(', ').includes(id), id);
  // the ready-made rules must keep working: none of their ids in the noise
  // the ready-made rules must keep working: none of their ids in the noise (read from the rules page itself)
  const presets = fs.readFileSync(new URL('../public/js/views/eventrules.js', import.meta.url), 'utf8');
  const ids = [...presets.matchAll(/eventIds: '([^']+)'/g)].flatMap((m) => m[1].split(/,\s*/)).flatMap((x) => {
    const [a, b] = x.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => String(a + i)) : [String(a)];
  });
  for (const id of ['4625', '4740', '1116', '1117', '5001', '8004', '8007', '1102', '104', '7045', '4698', '4720', '4728', '4732', '4756', '865', '4100', '4104']) assert.ok(ids.includes(id), `preset ${id}`);
  for (const id of ids) assert.equal(WIN_NOISE.split(', ').includes(id), false, id);
  const used = memoryDb();
  used.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('admin','x','admin','x')").run();
  used.prepare("DELETE FROM settings WHERE key='events.winDeny'").run();
  used.pragma('user_version = 34');
  migrate(used, { quiet: true });
  assert.equal(createSettings(used).get('events.winDeny'), '');
  const own = memoryDb();
  own.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('admin','x','admin','x')").run();
  own.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('events.winDeny', '\"8004\"')").run();
  own.pragma('user_version = 34');
  migrate(own, { quiet: true });
  assert.equal(createSettings(own).get('events.winDeny'), '8004');
});

test('backups: the number set applies at once to daily copies and to each kind of special copy; one can be deleted by hand', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'gzk-'));
  const { db, file } = makeDb(dir);
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  const put = (name, day) => { const f = path.join(bdir, name); fs.writeFileSync(f, zlib.gzipSync('x'), { mode: 0o600 }); fs.utimesSync(f, new Date(`2026-10-${day}T03:00:00Z`), new Date(`2026-10-${day}T03:00:00Z`)); };
  for (let i = 10; i <= 17; i++) {
    put(`whatsonmynet-2026-10-${i}-03-00-00.sqlite.gz`, i);
    put(`whatsonmynet-before-schema-${i}-2026-10-${i}-03-00-00.sqlite.gz`, i);
    put(`whatsonmynet-before-restore-2026-10-${i}-03-00-00.sqlite.gz`, i);
  }
  const settings = createSettings(db);
  const backups = createBackups({ db, settings, dbFile: file, backupsDir: bdir, restart: () => {} });
  settings.set('backup.keep', 3);
  await backups.tidy();
  const kinds = (k) => backups.list().filter((x) => x.kind === k).map((x) => x.name).sort();
  assert.deepEqual(kinds('daily'), ['whatsonmynet-2026-10-15-03-00-00.sqlite.gz', 'whatsonmynet-2026-10-16-03-00-00.sqlite.gz', 'whatsonmynet-2026-10-17-03-00-00.sqlite.gz'], 'the newest three');
  assert.equal(kinds('schema').length, 3);
  assert.equal(kinds('restore').length, 3);
  // copies before an update: the oldest go by their time - by name "before-schema-36" would sort before "-4"
  for (const [n, day] of [[4, '01'], [9, '02'], [31, '20'], [36, '21']]) put(`whatsonmynet-before-schema-${n}-2026-10-${day}-03-00-00.sqlite.gz`, day);
  await backups.tidy();
  assert.deepEqual(kinds('schema'), ['whatsonmynet-before-schema-17-2026-10-17-03-00-00.sqlite.gz', 'whatsonmynet-before-schema-31-2026-10-20-03-00-00.sqlite.gz', 'whatsonmynet-before-schema-36-2026-10-21-03-00-00.sqlite.gz'], 'the newest by time');
  backups.remove('whatsonmynet-2026-10-15-03-00-00.sqlite.gz');
  assert.equal(kinds('daily').length, 2);
  // only names from the list: no other file of the data folder, no way out of the folder
  for (const bad of ['../whatsonmynet.sqlite', 'whatsonmynet.sqlite', '..%2Fwhatsonmynet.sqlite', 'whatsonmynet-2026-10-15-03-00-00.sqlite.gz']) {
    assert.throws(() => backups.remove(bad), { code: 'err.notFound' }, bad);
  }
  assert.ok(fs.existsSync(file), 'the database itself is untouched');
  db.close();
});

test('API: delete a backup only with the confirmation, setting the number tidies at once - administrators only', async () => {
  const { startApp } = await import('./helpers.js');
  const app = await startApp();
  const { call, ctx } = app;
  try {
    assert.equal((await call('POST', '/api/setup', { username: 'michael', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
    ctx.users.create({ username: 'olaf', password: 'Sicher-Passwort-2', role: 'editor' });
    await call('POST', '/api/login', { username: 'olaf', password: 'Sicher-Passwort-2' }, { who: 'editor' });
    for (let i = 0; i < 3; i++) await call('POST', '/api/backups');
    let { list } = (await call('GET', '/api/backups')).data;
    assert.ok(list.length >= 1);
    const name = list[0].name;
    assert.equal((await call('DELETE', `/api/backups/file/${encodeURIComponent(name)}`, undefined, { who: 'editor', headers: { 'X-WOMN-Confirm': 'delete' } })).status, 403);
    assert.equal((await call('DELETE', `/api/backups/file/${encodeURIComponent(name)}`)).status, 400, 'without confirmation');
    assert.equal((await call('DELETE', `/api/backups/file/${encodeURIComponent(name)}`, undefined, { headers: { 'X-WOMN-Confirm': 'delete' } })).status, 200);
    assert.ok(!(await call('GET', '/api/backups')).data.list.some((x) => x.name === name));
    assert.equal((await call('DELETE', `/api/backups/file/${encodeURIComponent('../whatsonmynet.sqlite')}`, undefined, { headers: { 'X-WOMN-Confirm': 'delete' } })).status, 404);
    assert.equal((await call('PUT', '/api/settings/backup', { keep: 1 })).data.keep, 1);
    list = (await call('GET', '/api/backups')).data.list;
    assert.ok(list.filter((x) => x.kind === 'daily').length <= 1, 'tidied when saved');
  } finally { await app.close(); }
});
