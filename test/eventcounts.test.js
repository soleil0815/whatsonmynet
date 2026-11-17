// Counts per minute next to the messages: the timeline without a search, the overview by sender and the space page read
// them instead of millions of messages. They are filled in the background like the search index; what is newer than
// them, and the cut minutes at the edges of a range, come from the messages themselves - the numbers are always exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tmp } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { createSettings } from '../src/settings.js';
import { createEvents } from '../src/events.js';

const dirOf = (name) => fs.mkdtempSync(path.join(tmp, `${name}-`));
const insert = (db) => db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,text,event_id) VALUES(?, ?, ?, ?, ?, 'Meldung', ?)");
const counted = (db) => db.prepare("SELECT v FROM events_fts_state WHERE k='counted'").pluck().get();

// a fixed little random: the same messages every run
function fill(db, n, endMs) {
  let x = 7;
  const rnd = (m) => { x = (x * 1103515245 + 12345) % 2147483648; return Math.floor(x / 65536) % m; };
  const ins = insert(db);
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const at = new Date(endMs - (n - i) * 7000 - rnd(5000)).toISOString();
      const ip = `10.0.10.${1 + rnd(4)}`;
      ins.run(at, rnd(3) ? 'syslog' : 'trap', ip, rnd(8), `PC-000${ip.slice(-1)}`, rnd(2) ? [4625, 7036, 59][rnd(3)] : null);
    }
  })();
}

// the same as the plain counting the code did before
function rawHistogram(db, h, f = {}) {
  const w = ['at >= ?', 'at < ?', 'severity <= ?']; const a = [h.from, h.to, f.maxSeverity ?? 7];
  if (f.kind) { w.push('kind = ?'); a.push(f.kind); }
  if (f.source) { w.push('source_ip = ?'); a.push(f.source); }
  const t0 = Math.floor(Date.parse(h.from) / 1000 / h.step) * h.step;
  return db.prepare(`SELECT CAST((CAST(strftime('%s', at) AS INTEGER) - ?) / ? AS INTEGER) b, SUM(severity <= 3) err, SUM(severity = 4) warn, COUNT(*) n
    FROM events_in WHERE ${w.join(' AND ')} GROUP BY b`).all(t0, h.step, ...a);
}
const asBars = (h) => h.buckets.map((b) => [b.err, b.warn, b.other]);
function expectBars(db, h, f) {
  const want = h.buckets.map(() => [0, 0, 0]);
  for (const r of rawHistogram(db, h, f)) if (want[r.b]) want[r.b] = [r.err, r.warn, r.n - r.err - r.warn];
  return want;
}

test('timeline: the same bars before, while and after the counts are filled; cut minutes at the edges', () => {
  const db = openDatabase(path.join(dirOf('cnt1'), 'whatsonmynet.sqlite'));
  const ev = createEvents({ db, settings: createSettings(db) });
  const end = Date.now();
  fill(db, 30000, end); // about two and a half days
  const ranges = [
    {},
    { from: new Date(end - 6 * 3600000 + 17321).toISOString(), to: new Date(end - 3600000 - 4211).toISOString() },
    { from: new Date(end - 40 * 3600000 + 59999).toISOString(), to: new Date(end - 39 * 3600000 + 1).toISOString(), kind: 'trap' },
    { from: new Date(end - 30 * 60000 + 1500).toISOString(), to: new Date(end - 30 * 60000 + 40000).toISOString() }, // within one minute
    { from: new Date(end - 24 * 3600000).toISOString(), maxSeverity: 4, source: '10.0.10.3' },
  ];
  const check = (what) => {
    for (const f of ranges) {
      const h = ev.histogram(f);
      assert.ok(h.buckets.length > 0, `${what}: bars for ${JSON.stringify(f)}`);
      assert.deepEqual(asBars(h), expectBars(db, h, f), `${what}: ${JSON.stringify(f)}`);
      assert.equal(h.total, h.buckets.reduce((s, b) => s + b.err + b.warn + b.other, 0));
    }
  };
  check('nothing counted yet');
  assert.equal(counted(db), 0);
  assert.equal(ev.countBatch(), 10000, 'batches of 20 000');
  check('partly counted');
  while (ev.countBatch() > 0);
  assert.equal(counted(db), 30000);
  check('all counted');
  fill(db, 500, end + 3000); // new ones, not yet counted, in minutes that already have counts
  check('new ones on top of the counts');
  db.close();
});

test('by sender and the space page: the last 24 hours, the share of senders and event ids', () => {
  const db = openDatabase(path.join(dirOf('cnt2'), 'whatsonmynet.sqlite'));
  const ev = createEvents({ db, settings: createSettings(db) });
  const end = Date.now();
  fill(db, 20000, end);
  // what the senders overview needs: each sender has its row
  db.exec("INSERT INTO event_senders(source_ip, host, first_at, last_at, last_id) SELECT source_ip, MAX(host), MIN(at), MAX(at), MAX(id) FROM events_in GROUP BY source_ip");
  const since = new Date(end - 86400000).toISOString();
  const raw = new Map(db.prepare('SELECT source_ip, COUNT(*) n, SUM(severity <= 4) warn, SUM(severity <= 3) err FROM events_in WHERE at >= ? GROUP BY source_ip').all(since).map((r) => [r.source_ip, r]));
  const same = (what) => {
    for (const s of ev.senders({ fresh: true })) {
      const r = raw.get(s.source_ip);
      assert.deepEqual([s.day, s.warn, s.err], [r.n, r.warn, r.err], `${what}: ${s.source_ip}`);
    }
  };
  same('before');
  while (ev.countBatch() > 0);
  same('after');
  const st = ev.storage();
  assert.equal(st.total, 20000);
  const day = db.prepare('SELECT COUNT(*) FROM events_in WHERE at >= ?').pluck().get(since);
  assert.ok(Math.abs(st.perDay - day) <= 2, `${st.perDay} ~ ${day} (the 24 hours move on while counting)`);
  // the same as counting the messages of the day, as before
  const top = (sql) => db.prepare(sql).all(since).map((r) => ({ name: String(r.name), share: Math.round((r.n / day) * 100) })).filter((r) => r.share >= 10);
  assert.deepEqual(st.topSenders, top('SELECT host name, COUNT(*) n FROM events_in WHERE at >= ? GROUP BY host ORDER BY n DESC LIMIT 3'));
  assert.deepEqual(st.topEvents, top('SELECT event_id name, COUNT(*) n FROM events_in WHERE at >= ? AND event_id IS NOT NULL GROUP BY event_id ORDER BY n DESC LIMIT 3'));
  assert.equal(st.topSenders.length, 3);
  assert.deepEqual(st.topEvents.map((r) => r.name).sort(), ['4625', '59', '7036']);
  db.close();
});

test('messages that go take their counts along; nothing left after all are gone', () => {
  const db = openDatabase(path.join(dirOf('cnt3'), 'whatsonmynet.sqlite'));
  const settings = createSettings(db);
  const ev = createEvents({ db, settings });
  const end = Date.now();
  fill(db, 25000, end);
  while (ev.countBatch() > 0);
  const sum = () => db.prepare('SELECT SUM(n) FROM events_minute').pluck().get() || 0;
  const hours = () => db.prepare('SELECT SUM(n) FROM events_hour_id').pluck().get() || 0;
  assert.equal(sum(), 25000);
  // older than a day: in pieces, the counts go down with them
  settings.set('events.keepDays', 1);
  const left = db.prepare('SELECT COUNT(*) FROM events_in WHERE at >= ?').pluck().get(new Date(Date.now() - 86400000).toISOString());
  ev.prune();
  assert.equal(db.prepare('SELECT COUNT(*) FROM events_in').pluck().get(), left);
  assert.equal(sum(), left);
  assert.equal(hours(), db.prepare('SELECT COUNT(*) FROM events_in WHERE event_id IS NOT NULL').pluck().get());
  assert.equal(db.prepare('SELECT COUNT(*) FROM events_minute WHERE n <= 0').pluck().get(), 0, 'empty minutes tidied away');
  const h = ev.histogram({ from: new Date(end - 30 * 3600000).toISOString() });
  assert.deepEqual(asBars(h), expectBars(db, h, {}));
  // a message that changes (not done today - only its device is set later) keeps its counts right all the same
  const one = db.prepare('SELECT id, at FROM events_in ORDER BY id DESC LIMIT 1').get();
  db.prepare("UPDATE events_in SET severity = 2, source_ip = '10.0.10.77', event_id = 4740, at = ? WHERE id = ?").run(new Date(Date.parse(one.at) - 7200000).toISOString(), one.id);
  db.prepare('UPDATE events_in SET device_id = NULL WHERE id = ?').run(one.id);
  const h2 = ev.histogram({ from: new Date(end - 30 * 3600000).toISOString() });
  assert.deepEqual(asBars(h2), expectBars(db, h2, {}));
  assert.equal(hours(), db.prepare('SELECT COUNT(*) FROM events_in WHERE event_id IS NOT NULL').pluck().get());
  assert.equal(ev.histogram({ from: h2.from, source: '10.0.10.77' }).total, 1);
  // all gone: the pointer follows, new messages are counted from the start again
  db.prepare('DELETE FROM events_in').run();
  assert.equal(sum(), 0);
  assert.equal(counted(db), 0);
  fill(db, 100, end);
  while (ev.countBatch() > 0);
  assert.equal(sum(), 100);
  ev.stop();
  db.close();
});

test('a big day to remove goes in pieces, the rest a little later', () => {
  const db = openDatabase(path.join(dirOf('cnt4'), 'whatsonmynet.sqlite'));
  const settings = createSettings(db);
  const ev = createEvents({ db, settings });
  const ins = insert(db);
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  db.transaction(() => { for (let i = 0; i < 120000; i++) ins.run(old, 'syslog', '10.0.10.9', 6, 'PC-0009', null); })();
  settings.set('events.keepDays', 1);
  const removed = ev.prune();
  assert.equal(removed, 100000, 'at most ten pieces of 10 000 at a time');
  assert.equal(db.prepare('SELECT COUNT(*) FROM events_in').pluck().get(), 20000);
  assert.equal(ev.prune(), 20000);
  ev.stop();
  db.close();
});

test('a file from before the update gets its counts in the background', () => {
  const dir = dirOf('cnt5');
  openDatabase(path.join(dir, 'whatsonmynet.sqlite')).close();
  const f = new Database(path.join(dir, 'events.sqlite'));
  f.exec('DROP TRIGGER events_counts_gone; DROP TRIGGER events_counts_changed; DROP TABLE events_minute; DROP TABLE events_hour; DROP TABLE events_hour_id; DROP TABLE events_day_src; ALTER TABLE event_senders DROP COLUMN transport; ALTER TABLE event_senders DROP COLUMN udp_at; PRAGMA user_version = 4;');
  f.prepare("DELETE FROM events_fts_state WHERE k = 'counted'").run();
  const ins = f.prepare("INSERT INTO events_in(at,kind,source_ip,severity,text) VALUES(?, 'syslog', '10.0.10.5', 3, 'alt')");
  f.transaction(() => { for (let i = 0; i < 3000; i++) ins.run(new Date(Date.now() - i * 60000).toISOString()); })();
  f.close();
  const db = openDatabase(path.join(dir, 'whatsonmynet.sqlite'));
  assert.equal(db.pragma('ev.user_version', { simple: true }), 7);
  assert.equal(counted(db), 0, 'everything still to count');
  const ev = createEvents({ db, settings: createSettings(db) });
  const h = ev.histogram({ from: new Date(Date.now() - 86400000).toISOString() });
  assert.equal(h.total, 1440, 'right before the counts are there');
  ev.countBatch();
  assert.equal(ev.histogram({ from: h.from, to: h.to }).total, 1440, 'and after');
  db.close();
});
