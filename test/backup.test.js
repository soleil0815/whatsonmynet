import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmp, startApp } from './helpers.js';
import { openDatabase, verifyKey } from '../src/db.js';
import { createSettings } from '../src/settings.js';
import { createBackups, inspect, applyPendingRestore, pendingPath } from '../src/backup.js';
import { setMasterKeyForTests, encrypt } from '../src/lib/crypto.js';

function makeDb(dir, devices = 1) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'whatsonmynet.sqlite');
  const db = openDatabase(file);
  verifyKey(db);
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('admin','x','admin',?)").run(ts);
  for (let i = 0; i < devices; i++) db.prepare('INSERT INTO devices(name,created_at,updated_at) VALUES(?,?,?)').run(`Gerät ${i}`, ts, ts);
  return { db, file };
}

test('backup files are checked before a restore', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'bk-'));
  const { db, file } = makeDb(path.join(dir, 'a'), 3);
  const copy = path.join(dir, 'copy.sqlite');
  await db.backup(copy);
  assert.deepEqual(inspect(copy), { schema: db.pragma('user_version', { simple: true }), devices: 3, users: 1 });
  fs.writeFileSync(path.join(dir, 'x.sqlite'), 'kein sqlite '.repeat(200));
  assert.throws(() => inspect(path.join(dir, 'x.sqlite')), { code: 'err.backupFile' });
  // newer schema
  const newer = path.join(dir, 'newer.sqlite');
  fs.copyFileSync(copy, newer);
  const n = openDatabase(':memory:'); n.close();
  const raw = (await import('better-sqlite3')).default;
  const w = new raw(newer); w.pragma('user_version = 999'); w.close();
  assert.throws(() => inspect(newer), { code: 'err.backupNewer' });
  // other key
  const other = path.join(dir, 'other.sqlite');
  fs.copyFileSync(copy, other);
  const o = new raw(other);
  const realKey = crypto.randomBytes(32);
  setMasterKeyForTests(crypto.randomBytes(32));
  o.prepare("UPDATE settings SET value=? WHERE key='_keycheck'").run(JSON.stringify(encrypt('whatsonmynet')));
  o.close();
  setMasterKeyForTests(realKey);
  // the key of this process changed: the copy made with the old key no longer fits either
  assert.throws(() => inspect(other), { code: 'err.backupKey' });
  db.close();
  assert.ok(file);
});

test('restore: waits as pending, keeps the old database, takes over at the next start', async () => {
  setMasterKeyForTests(crypto.randomBytes(32));
  const dir = fs.mkdtempSync(path.join(tmp, 'bk2-'));
  const backupsDir = path.join(dir, 'backups');
  const { db, file } = makeDb(dir, 2);
  const settings = createSettings(db);
  let restarted = 0;
  const b = createBackups({ db, settings, dbFile: file, backupsDir, restart: () => { restarted++; } });
  const name = await b.create();
  assert.match(name, /^whatsonmynet-\d{4}-/);
  assert.equal(b.list().length, 1);
  assert.throws(() => b.file('../whatsonmynet.sqlite'), { code: 'err.notFound' });
  // more devices after the backup
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO devices(name,created_at,updated_at) VALUES(?,?,?)').run('neu', ts, ts);
  const info = await b.restore({ name });
  assert.equal(info.devices, 2);
  assert.equal(restarted, 1);
  assert.ok(fs.existsSync(pendingPath(file)));
  db.close();
  // next start
  assert.equal(applyPendingRestore(file, backupsDir), true);
  assert.ok(!fs.existsSync(pendingPath(file)));
  const again = openDatabase(file);
  assert.equal(again.prepare('SELECT COUNT(*) n FROM devices').get().n, 2);
  again.close();
  assert.ok(fs.readdirSync(backupsDir).some((f) => f.startsWith('whatsonmynet-before-restore-')), 'old state kept');
  // a broken upload changes nothing
  await assert.rejects(b.restore({ buffer: Buffer.alloc(4096, 1) }), { code: 'err.backupFile' });
  assert.ok(!fs.existsSync(pendingPath(file)));
});

test('backup API: admin only, download, restore needs confirmation', async () => {
  const app = await startApp({ setupToken: 'bk-setup' });
  try {
    await app.call('POST', '/api/setup', { code: 'bk-setup', username: 'admin', password: 'Admin-Passwort-1', email: 'a@x.de' });
    const res = await app.call('GET', '/api/backups/download', undefined, { raw: true });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal((await app.call('POST', '/api/backups/restore', undefined)).status, 400);
    assert.equal((await app.call('GET', '/api/backups/file/..%2Fsecret.key', undefined, { raw: true })).status, 404);
  } finally { await app.close(); }
});
