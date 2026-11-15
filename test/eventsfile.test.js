// The messages live in a file of their own (events.sqlite next to the database): the database and its daily backups stay
// small, an update moves what was there once, a restored older backup does not bring it back twice. The file keeps to its
// limit in GB and leaves the disk room; the page says how far the space reaches and who fills it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tmp } from './helpers.js';
import { openDatabase, backupDatabase, MIGRATIONS } from '../src/db.js';
import { createSettings } from '../src/settings.js';
import { createEvents } from '../src/events.js';

const dirOf = (name) => fs.mkdtempSync(path.join(tmp, `${name}-`));
// stored the way receive() stores them (receive itself would cut a flood of 3000 in one second)
const msg = (db, i) => db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,text,event_id) VALUES(?, 'syslog', ?, 6, ?, ?, ?)")
  .run(new Date().toISOString(), `10.0.10.${(i % 20) + 1}`, `PC-${i % 20}`, `${'x'.repeat(700)} ${i}`, i % 3 ? 4624 : 7036);

test('a file of its own: not in the database, not in the backups, kept across a restart', async () => {
  const dir = dirOf('evf');
  const file = path.join(dir, 'whatsonmynet.sqlite');
  let db = openDatabase(file);
  const ev = createEvents({ db, settings: createSettings(db) });
  for (let i = 0; i < 40; i++) assert.ok(ev.receive('syslog', `10.0.10.${i}`, { severity: 6, text: `m ${i}` }));
  for (let i = 0; i < 10; i++) msg(db, i);
  assert.ok(fs.existsSync(path.join(dir, 'events.sqlite')));
  assert.equal(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name IN ('events_in','event_rule_hits')").get(), undefined);
  assert.equal((fs.statSync(path.join(dir, 'events.sqlite')).mode & 0o777).toString(8), '600');
  const backup = await backupDatabase(db, 7, path.join(dir, 'backups'));
  const b = new Database(backup, { readonly: true });
  assert.equal(b.prepare("SELECT 1 FROM sqlite_master WHERE name='events_in'").get(), undefined, 'the backup has no messages');
  b.close();
  db.close();
  db = openDatabase(file);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events_in').get().n, 50);
  db.close();
});

test('update: the messages move once; a restored older backup only drops its copy', () => {
  const dir = dirOf('evm');
  const file = path.join(dir, 'whatsonmynet.sqlite');
  // as before: schema 29, messages and what the rules sent in the database
  const old = new Database(file);
  for (let v = 0; v < 29; v++) { const m = MIGRATIONS[v]; old.exec(typeof m === 'string' ? m : m.sql); }
  old.pragma('user_version = 29');
  const ins = old.prepare("INSERT INTO events_in(at,kind,source_ip,severity,text,event_id) VALUES(?, 'syslog', '10.0.10.21', 4, ?, ?)");
  for (let i = 0; i < 3; i++) ins.run(`2026-11-15T10:0${i}:00.000Z`, `old ${i}`, 1116);
  old.close();
  fs.copyFileSync(file, path.join(dir, 'restore-me.sqlite'));
  let db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
  assert.deepEqual(db.prepare('SELECT text, event_id FROM events_in ORDER BY id').all().map((r) => [r.text, r.event_id]), [['old 0', 1116], ['old 1', 1116], ['old 2', 1116]]);
  assert.equal(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='events_in'").get(), undefined);
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.includes('before-schema-30')), 'the usual copy before the update');
  db.close();
  // an older backup put back: its messages are not taken a second time
  fs.copyFileSync(path.join(dir, 'restore-me.sqlite'), file);
  db = openDatabase(file);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events_in').get().n, 3);
  assert.equal(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='events_in'").get(), undefined);
  db.close();
});

test('limit: the oldest go when the file is full, the disk keeps room, the page says how far it reaches', () => {
  const dir = dirOf('evl');
  const db = openDatabase(path.join(dir, 'whatsonmynet.sqlite'));
  const settings = createSettings(db);
  const ev = createEvents({ db, settings });
  db.transaction(() => { for (let i = 0; i < 3000; i++) msg(db, i); })();
  const before = ev.storage();
  assert.equal(before.total, 3000);
  assert.ok(before.used > 2 * 1024 * 1024, `${before.used}`);
  assert.equal(before.limit, 2 * 1024 ** 3, 'default 2 GB');
  assert.equal(before.short, false);
  // 1 MB: the oldest go, the newest stay
  settings.set('events.maxGb', 0.001);
  assert.ok(ev.prune() > 0);
  const after = db.prepare('SELECT COUNT(*) n, MIN(id) lo, MAX(id) hi FROM events_in').get();
  assert.ok(after.n < 3000 && after.n > 500, `${after.n}`);
  assert.equal(after.hi, 3000, 'the newest message is kept');
  const s = ev.storage();
  assert.ok(s.used <= 1024 ** 3 / 1000, `${s.used}`);
  assert.equal(s.short, true, 'a day of messages does not fit into 1 MB for 30 days');
  assert.ok(s.daysFit !== null && s.daysFit < 30);
  assert.deepEqual(s.topEvents.map((e) => e.name), ['4624', '7036']);
  assert.equal(s.topEvents[0].share, 67);
  // days: what is older than set goes in any case
  settings.set('events.maxGb', 2);
  db.prepare("UPDATE events_in SET at='2000-01-01T00:00:00.000Z' WHERE id < (SELECT MAX(id) - 10 FROM events_in)").run();
  ev.prune();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events_in').get().n, 11);
  // the disk gets short: at least 10 % (and 1 GB) stay free - the limit drops below the setting
  const real = fs.statfsSync;
  fs.statfsSync = () => ({ bsize: 4096, blocks: (100 * 1024 ** 3) / 4096, bavail: (10.5 * 1024 ** 3) / 4096 });
  try {
    const t = createEvents({ db, settings }).storage();
    assert.equal(t.diskShort, true);
    assert.ok(t.cap < 1024 ** 3 && t.cap > 400 * 1024 ** 2, `${t.cap}`);
  } finally { fs.statfsSync = real; }
  db.close();
});
