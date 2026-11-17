// Search over many gigabytes: a full-text index of words next to the messages (SQLite FTS5). New messages are written
// without waiting for it and go in in batches; a file from before the update is indexed in the background. The search
// finds words and beginnings of words; parts of words only on request (every message is read then). Messages that go
// take their words with it - the index never gets out of step with the messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tmp, startApp } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { createSettings } from '../src/settings.js';
import { createEvents } from '../src/events.js';

const dirOf = (name) => fs.mkdtempSync(path.join(tmp, `${name}-`));
const ins = (db, at, text, extra = {}) => db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,text,event_id,account) VALUES(?, 'syslog', ?, ?, ?, ?, ?, ?)")
  .run(at, extra.ip || '10.0.10.5', extra.sev ?? 6, extra.host || 'PC-0001', text, extra.eventId ?? null, extra.account || '').lastInsertRowid;
const ids = (rows) => rows.map((r) => r.id);
const intact = (db) => db.exec("INSERT INTO events_fts(events_fts) VALUES('integrity-check')");
const done = (db) => db.prepare("SELECT v FROM events_fts_state WHERE k='done'").pluck().get();

test('words, beginnings of words, the order of words; parts of words only on request', () => {
  const db = openDatabase(path.join(dirOf('fts1'), 'whatsonmynet.sqlite'));
  const ev = createEvents({ db, settings: createSettings(db) });
  const t = (h) => new Date(Date.parse('2026-11-10T08:00:00Z') + h * 3600000).toISOString();
  const a = ins(db, t(0), 'Fehler beim Anmelden eines Kontos. Kontoname: m.muster Status: 0xC000006A', { sev: 4, eventId: 4625, account: 'FIRMA\\m.muster' });
  const b = ins(db, t(1), 'Der Dienst "Druckwarteschlange" wurde beendet.', { eventId: 7036 });
  const c = ins(db, t(2), 'Ein Konto wurde erfolgreich angemeldet. Kontoname: max.muster', { eventId: 4624 });
  const d = ins(db, t(3), 'PORT: Port 7 link down', { ip: '10.0.10.99', host: 'sw-core' });
  assert.equal(ev.indexBatch(), 0, 'everything in one batch');
  assert.equal(done(db), d);
  assert.deepEqual(ids(ev.list({ q: 'm.muster' })), [a], 'the name as written - not max.muster');
  assert.deepEqual(ids(ev.list({ q: 'muster' })), [c, a], 'a word on its own');
  assert.deepEqual(ids(ev.list({ q: 'Druck' })), [b], 'the beginning of a word');
  assert.deepEqual(ids(ev.list({ q: 'druckwarteschlange' })), [b], 'upper and lower case alike');
  assert.deepEqual(ids(ev.list({ q: 'link down' })), [d], 'several words');
  assert.deepEqual(ids(ev.list({ q: 'down link' })), [d], 'in any order');
  assert.deepEqual(ids(ev.list({ q: '"link down"' })), [d], 'in quotes: one after the other');
  assert.deepEqual(ids(ev.list({ q: '"down link"' })), []);
  // all of them, in any field: sender, event id, words of the text, account
  assert.deepEqual(ids(ev.list({ q: 'PC-0001 4625 m.muster' })), [a]);
  assert.deepEqual(ids(ev.list({ q: 'PC-0001 4625 max.muster' })), [], 'every word must be there');
  assert.deepEqual(ids(ev.list({ q: 'Konto PC-0001' })), [c, a]);
  // -word leaves out
  assert.deepEqual(ids(ev.list({ q: 'muster -max' })), [a]);
  assert.deepEqual(ids(ev.list({ q: 'Kontoname -4625' })), [c]);
  assert.deepEqual(ids(ev.list({ q: '-PC-0001' })), [d], 'only leaving out');
  // parts of words with several terms too
  assert.deepEqual(ids(ev.list({ q: 'C000006A PC-0001', part: true })), [a]);
  assert.deepEqual(ids(ev.list({ q: 'arteschlan -beendet', part: true })), []);
  assert.deepEqual(ids(ev.list({ q: '10.0.10.99' })), [d], 'an address');
  assert.deepEqual(ids(ev.list({ q: 'sw-core' })), [d], 'the sender name');
  assert.deepEqual(ids(ev.list({ q: '4625' })), [a], 'the Windows event id');
  assert.deepEqual(ids(ev.list({ q: 'anmeldeten' })), [], 'not a word in there');
  // part of a word: only when asked for - then as before the index
  assert.deepEqual(ids(ev.list({ q: 'C000006A' })), []);
  assert.deepEqual(ids(ev.list({ q: 'C000006A', part: true })), [a]);
  assert.deepEqual(ids(ev.list({ q: 'arteschlan', part: true })), [b]);
  // characters that mean something to the index are words or nothing - never a syntax error
  for (const q of ['"', 'NOT', 'a OR b', '*', 'm.muster"*', '(x', '::', 'NEAR(a b)']) assert.ok(Array.isArray(ev.list({ q })), q);
  // the time range and the timeline go with the words
  assert.deepEqual(ids(ev.list({ q: 'muster', from: t(1), to: t(3) })), [c]);
  assert.deepEqual(ids(ev.list({ q: 'muster', from: t(5) })), []);
  const h = ev.histogram({ q: 'muster', from: t(0), to: t(4) });
  assert.equal(h.total, 2);
  assert.equal(ev.histogram({ q: 'muster' }).from, t(0), 'without a start: the oldest hit');
  // other filters still apply
  assert.deepEqual(ids(ev.list({ q: 'muster', maxSeverity: 4 })), [a]);
  intact(db);
  db.close();
});

test('new messages are found before their batch, many hits come newest first, more of the list', () => {
  const db = openDatabase(path.join(dirOf('fts2'), 'whatsonmynet.sqlite'));
  const ev = createEvents({ db, settings: createSettings(db) });
  const now = Date.now();
  db.transaction(() => { for (let i = 0; i < 25000; i++) ins(db, new Date(now - (25000 - i) * 1000).toISOString(), `Ein Konto wurde angemeldet. Kontoname: user${i % 50}`); })();
  while (ev.indexBatch() > 0);
  // not in the index yet: still found (read the slow way until the next batch)
  const fresh = ev.receive('syslog', '10.0.10.7', { severity: 3, text: 'Neue Meldung: Lüfter 2 ausgefallen' });
  assert.ok(done(db) < fresh.id);
  assert.deepEqual(ids(ev.list({ q: 'Lüfter' })), [fresh.id]);
  assert.deepEqual(ids(ev.list({ q: 'Lufter' })), [], 'not in the index yet: as written');
  ev.indexBatch();
  assert.deepEqual(ids(ev.list({ q: 'Lufter' })), [fresh.id], 'in the index: umlauts or not');
  // a word in 25 000 messages: the newest 200, then the next 200
  const page1 = ev.list({ q: 'angemeldet' });
  assert.equal(page1.length, 200);
  assert.equal(page1[0].id, fresh.id - 1);
  const page2 = ev.list({ q: 'angemeldet', before: page1[199].id });
  assert.equal(page2[0].id, page1[199].id - 1);
  assert.equal(ev.histogram({ q: 'angemeldet' }).total, 25000);
  intact(db);
  db.close();
});

test('messages that go take their words; numbers given again are indexed again', () => {
  const db = openDatabase(path.join(dirOf('fts3'), 'whatsonmynet.sqlite'));
  const settings = createSettings(db);
  const ev = createEvents({ db, settings });
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  for (let i = 0; i < 50; i++) ins(db, old, `alt Meldung ${i}`);
  ev.indexBatch();
  for (let i = 0; i < 5; i++) ins(db, new Date().toISOString(), `neu Meldung ${i}`); // not in the index yet
  // older than 30 days: gone, with their words
  ev.prune();
  assert.equal(db.prepare('SELECT COUNT(*) FROM events_in').pluck().get(), 5);
  intact(db);
  assert.deepEqual(ids(ev.list({ q: 'alt' })), []);
  assert.equal(ev.list({ q: 'neu' }).length, 5);
  // everything goes (nothing came for longer than kept): the next message gets an id that was used before
  db.prepare('DELETE FROM events_in').run();
  assert.equal(done(db), 0, 'the index follows');
  const again = ev.receive('syslog', '10.0.10.8', { severity: 6, text: 'wieder da' });
  assert.ok(again.id <= 50, `id ${again.id} used before`);
  ev.indexBatch();
  assert.deepEqual(ids(ev.list({ q: 'wieder' })), [again.id]);
  db.prepare('DELETE FROM events_in').run();
  intact(db);
  db.close();
});

test('a file from before the update: indexed in the background, found all the time', () => {
  const dir = dirOf('fts4');
  // the messages file as version 0.38 left it (schema 3, no index)
  const db0 = openDatabase(path.join(dir, 'whatsonmynet.sqlite'));
  db0.close();
  const f = new Database(path.join(dir, 'events.sqlite'));
  f.exec('DROP TRIGGER events_counts_gone; DROP TRIGGER events_counts_changed; DROP TABLE events_minute; DROP TABLE events_hour; DROP TABLE events_hour_id; DROP TRIGGER events_fts_gone; DROP TRIGGER events_fts_changed; DROP TABLE events_fts; DROP TABLE events_fts_state; DROP INDEX events_in_event; DROP TABLE events_day_src; ALTER TABLE event_senders DROP COLUMN transport; ALTER TABLE event_senders DROP COLUMN udp_at; PRAGMA user_version = 3;');
  const ins0 = f.prepare("INSERT INTO events_in(at,kind,source_ip,severity,text) VALUES(?, 'syslog', '10.0.10.5', 6, ?)");
  f.transaction(() => { for (let i = 0; i < 12000; i++) ins0.run(new Date(Date.now() - (12000 - i) * 60000).toISOString(), i === 10 ? 'Kennwort abgelaufen m.muster' : `Meldung ${i}`); })();
  f.close();
  const db = openDatabase(path.join(dir, 'whatsonmynet.sqlite'));
  assert.equal(db.pragma('ev.user_version', { simple: true }), 7);
  const ev = createEvents({ db, settings: createSettings(db) });
  assert.equal(done(db), 0, 'nothing indexed yet');
  assert.equal(ev.indexStatus().building, false, '12 000 are not a build worth a note');
  assert.deepEqual(ev.list({ q: 'm.muster' }).map((r) => r.text), ['Kennwort abgelaufen m.muster'], 'found before the index');
  assert.equal(ev.indexBatch(), 7000, 'batches of 5000');
  assert.deepEqual(ev.list({ q: 'm.muster' }).map((r) => r.text), ['Kennwort abgelaufen m.muster'], 'and while it is built');
  while (ev.indexBatch() > 0);
  assert.equal(ev.indexStatus().share, 1);
  assert.deepEqual(ev.list({ q: 'm.muster' }).map((r) => r.text), ['Kennwort abgelaufen m.muster']);
  intact(db);
  db.close();
});

test('route: part of a word on request, the state of the index in the status', async () => {
  const app = await startApp();
  try {
    const { call, ctx, db } = app;
    assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
    ins(db, new Date().toISOString(), 'Status: 0xC000006A');
    ctx.events.indexBatch();
    assert.equal((await call('GET', '/api/events?q=C000006A')).data.list.length, 0);
    assert.equal((await call('GET', '/api/events?q=C000006A&part=1')).data.list.length, 1);
    assert.equal((await call('GET', '/api/events/histogram?q=C000006A&part=1')).data.total, 1);
    const r = await call('GET', '/api/events');
    assert.deepEqual(r.data.status.searchIndex, { building: false, share: 1, behind: 0 });
    ctx.events.stop();
  } finally { await app.close(); }
});
