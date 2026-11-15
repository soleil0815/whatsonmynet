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
  assert.equal(ev.storage().total, 0);
  ev.receive('syslog', '10.0.9.1', { severity: 6, text: 'first' });
  assert.equal(ev.storage().total, 1, 'the first message shows at once, not after the cache minute');
  db.prepare("DELETE FROM events_in WHERE text='first'").run();
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
  // the page never says "0 stored" next to new messages
  assert.equal(ev.storage().total, 3000);
  ev.receive('syslog', '10.0.10.99', { severity: 6, text: 'one more' });
  db.prepare('DELETE FROM events_in WHERE text=?').run('one more');
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

test('umlauts in the code page of Windows (NXLog) are read right; UTF-8 stays UTF-8', async () => {
  const { parseSyslog, decodeText } = await import('../src/events.js');
  const cp = Buffer.concat([Buffer.from('2026-11-15 10:00:00 PC-0011 INFO 4624 Konto: NT-AUTORIT'), Buffer.from([0xc4]), Buffer.from('T\\SYSTEM')]);
  assert.equal(parseSyslog(cp).text, 'Konto: NT-AUTORITÄT\\SYSTEM');
  assert.equal(decodeText(Buffer.from('Grüße – €', 'utf8')), 'Grüße – €');
  assert.equal(decodeText(Buffer.from([0x80, 0x20, 0xfc])), '€ ü', 'Windows-1252, not only Latin-1');
});

test('by sender: one row per address with its newest message and the last 24 hours; one sender\'s messages', () => {
  const dir = dirOf('evs');
  const file = path.join(dir, 'whatsonmynet.sqlite');
  // a messages file of the first shape with messages: the senders are filled in from them
  let db = openDatabase(file);
  db.pragma('ev.user_version = 1');
  db.exec('DROP TABLE ev.event_senders; DROP INDEX ev.events_in_source');
  const ins = db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,text,event_id) VALUES(?, 'syslog', ?, ?, ?, ?, ?)");
  ins.run(new Date(Date.now() - 3600000).toISOString(), '10.0.10.21', 3, 'PC-0021', 'old error', 7000);
  ins.run(new Date().toISOString(), '10.0.10.21', 6, '', 'newest', 7036);
  ins.run(new Date(Date.now() - 3 * 86400000).toISOString(), '10.0.10.8', 6, 'DC01', 'days ago', 4624);
  db.close();
  db = openDatabase(file);
  const ev = createEvents({ db, settings: createSettings(db) });
  let s = ev.senders();
  assert.deepEqual(s.map((x) => [x.source_ip, x.host, x.last_text, x.day, x.err, x.warn]), [['10.0.10.21', '', 'newest', 2, 1, 1], ['10.0.10.8', 'DC01', 'days ago', 0, 0, 0]]);
  // new messages: a host name fills in, an empty one does not empty it
  ev.receive('syslog', '10.0.10.8', { severity: 4, host: 'DC01', text: 'locked', eventId: 4740 });
  ev.receive('syslog', '10.0.10.8', { severity: 6, host: '', text: 'no name' });
  s = ev.senders({ fresh: true });
  assert.deepEqual([s[0].source_ip, s[0].host, s[0].last_text, s[0].day, s[0].warn], ['10.0.10.8', 'DC01', 'no name', 2, 1]);
  assert.deepEqual(ev.senders({ q: 'dc0' }).map((x) => x.source_ip), ['10.0.10.8']);
  assert.deepEqual(ev.list({ source: '10.0.10.21' }).map((r) => r.text), ['newest', 'old error']);
  // a sender whose messages are all gone leaves the overview
  createSettings(db).set('events.keepDays', 1);
  ev.prune();
  assert.deepEqual(db.prepare('SELECT source_ip FROM event_senders ORDER BY source_ip').all().map((r) => r.source_ip), ['10.0.10.21', '10.0.10.8']);
  db.prepare("UPDATE events_in SET at='2000-01-01T00:00:00.000Z' WHERE source_ip='10.0.10.21'").run();
  ev.prune();
  assert.deepEqual(db.prepare('SELECT source_ip FROM event_senders').all().map((r) => r.source_ip), ['10.0.10.8']);
  db.close();
});

test('UTF-8 and the code page of Windows mixed in one line: each part read right', async () => {
  const { decodeText } = await import('../src/events.js');
  const line = Buffer.concat([Buffer.from('NT-AUTORIT'), Buffer.from([0xc4]), Buffer.from('T\\SYSTEM Die manuelle Verarbeitung der Richtlinie für Computer FIRMA\\PC-0012$ wurde in 3 Sekunden abgeschlossen.')]);
  assert.equal(decodeText(line), 'NT-AUTORITÄT\\SYSTEM Die manuelle Verarbeitung der Richtlinie für Computer FIRMA\\PC-0012$ wurde in 3 Sekunden abgeschlossen.');
  assert.equal(decodeText(Buffer.from([0xe2, 0x82, 0xac, 0x20, 0x80, 0x20, 0xc3])), '€ € Ã', 'a cut UTF-8 sequence at the end is one Windows byte');
  assert.equal(decodeText(Buffer.from([0xed, 0xa0, 0x80])), 'í €', 'no surrogates out of UTF-8');
});

test('Windows events by id: only these / never these; other messages untouched; rules for dropped ids refused', async () => {
  const { createEventRules } = await import('../src/eventrules.js');
  const db = openDatabase(path.join(dirOf('evid'), 'whatsonmynet.sqlite'));
  const settings = createSettings(db);
  const ev = createEvents({ db, settings });
  const win = (id) => ev.receive('syslog', `10.0.20.${id % 200}`, { severity: 6, host: 'PC-0012', text: `event ${id}`, eventId: id });
  settings.set('events.winDeny', '8004, 4624, 4634');
  ev.apply(); ev.stop();
  assert.equal(win(8004), null);
  assert.ok(win(1116));
  assert.ok(ev.receive('syslog', '10.0.30.1', { severity: 3, text: 'switch port down' }), 'not a Windows event: taken');
  settings.set('events.winAllow', '1116, 1117, 4740, 865-868');
  ev.apply(); ev.stop();
  assert.equal(win(7036), null);
  assert.ok(win(866));
  assert.ok(ev.receive('syslog', '10.0.30.1', { severity: 3, text: 'NAS volume degraded' }));
  assert.equal(ev.status().filtered, 2);
  const chan = Number(db.prepare("INSERT INTO channels(name,type,config,language,is_default,enabled,created_at) VALUES('T','email','x','de',0,1,'x')").run().lastInsertRowid);
  const rules = createEventRules({ db, channels: { notifyIds: async () => [] }, settings });
  assert.throws(() => rules.create({ name: 'GPO', match: { eventIds: '8004' }, channels: [chan] }), (e) => e.code === 'err.ruleIdsFiltered' && e.detail === '8004');
  assert.throws(() => rules.create({ name: 'SRP', match: { eventIds: '860-868' }, channels: [chan] }), (e) => e.detail === '860-868', 'part of the range is not taken');
  const ok = rules.create({ name: 'Virus', match: { eventIds: '1116-1117' }, channels: [chan] });
  settings.set('events.winAllow', '4740');
  assert.deepEqual(rules.list().find((r) => r.id === ok.id).blocked, ['1116-1117'], 'the list says when a rule can no longer fire');
  db.close();
});

test('what is kept: from a severity on for all, per sender stricter or looser, muted senders stay in the list', () => {
  const db = openDatabase(path.join(dirOf('evf2'), 'whatsonmynet.sqlite'));
  const settings = createSettings(db);
  const ev = createEvents({ db, settings });
  const msg = (ip, severity) => ev.receive('syslog', ip, { severity, text: `s${severity}` });
  settings.set('events.minSeverity', 4);
  assert.equal(msg('10.0.1.1', 6), null, 'info is not kept when "warning and worse" is set');
  assert.ok(msg('10.0.1.1', 4));
  ev.setSenderFilter('10.0.1.2', 7);               // this server: everything
  assert.ok(msg('10.0.1.2', 7));
  ev.setSenderFilter('10.0.1.3', -1);              // a chatty switch: nothing
  assert.equal(msg('10.0.1.3', 0), null);
  assert.equal(msg('10.0.1.3', 3), null);
  const s = ev.senders({ fresh: true });
  const of = (ip) => s.find((x) => x.source_ip === ip);
  assert.deepEqual([of('10.0.1.3').filter, of('10.0.1.3').dropped, of('10.0.1.3').last_at], [-1, 2, null], 'muted and nothing stored - still listed');
  assert.deepEqual([of('10.0.1.2').filter, of('10.0.1.1').filter, of('10.0.1.1').dropped], [7, null, 1]);
  ev.setSenderFilter('10.0.1.3', null);
  assert.ok(msg('10.0.1.3', 3), 'back to "as for all"');
  assert.equal(ev.status().filtered, 3);
  db.close();
});
