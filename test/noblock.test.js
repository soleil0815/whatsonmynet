// Nothing may hold the server up: the diagnostic package, the cleanup of the messages and the search index work in
// small steps and hand the server back in between (with millions of messages the package once took nine minutes in one
// go, the pages said "not reachable"). And the anonymiser gives the same result as before - just much faster.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, memoryDb, startApp } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { createSettings } from '../src/settings.js';
import { createEvents } from '../src/events.js';
import { createAnonymizer } from '../src/diagnostics.js';

const dirOf = (name) => fs.mkdtempSync(path.join(tmp, `${name}-`));

test('anonymiser: names in any case, also next to letters that grow in lower case (Turkish İ)', () => {
  const db = memoryDb();
  const ts = new Date().toISOString();
  for (const [name, host] of [['PC-0011', 'pc-0011.firma.local'], ['Drucker Flur', 'drucker-flur'], ['İzmir-PC', 'izmir-pc']]) {
    db.prepare('INSERT INTO devices(name,type,hostname,created_at,updated_at) VALUES(?,?,?,?,?)').run(name, 'computer', host, ts, ts);
  }
  const an = createAnonymizer(db, true);
  const out = an.anon('pc-0011 meldet: PC-0011.FIRMA.LOCAL, DRUCKER FLUR leer, İzmir-PC aus, İstanbul bleibt, CN=Max Mustermann,OU=IT');
  assert.ok(!/pc-0011|drucker flur|İzmir-PC|Max Mustermann/i.test(out), out);
  assert.ok(out.includes('İstanbul bleibt'), 'an unknown word stays as it is');
  assert.match(out, /GERAET-\d+ meldet/);
  // the same name gets the same placeholder in any case
  assert.equal(an.anon('pc-0011'), an.anon('PC-0011'));
  // many short values (the values of every device) cost next to nothing
  const t = performance.now();
  for (let i = 0; i < 20000; i++) an.anon('Laufwerk C: belegt');
  assert.ok(performance.now() - t < 2000, `${Math.round(performance.now() - t)} ms`);
});

test('diagnostic package: built in steps - other work gets its turn while it is made', async () => {
  const s = await startApp();
  try {
    let turns = 0; let building = true;
    const tick = () => { if (!building) return; turns++; setImmediate(tick); };
    setImmediate(tick);
    const p = await s.ctx.diagnostics.build({ days: 7, anonymize: true });
    building = false;
    assert.ok(p.buffer.length > 1000);
    assert.ok(turns >= 10, `only ${turns} turns in between`);
  } finally { await s.close(); }
});

test('message cleanup: a round stops after its time and the rest follows by itself; the counts are tidied at the end', async () => {
  const db = openDatabase(path.join(dirOf('nb1'), 'whatsonmynet.sqlite'));
  const settings = createSettings(db);
  const ev = createEvents({ db, settings, pruneBudgetMs: 0 });
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const ins = db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,text,event_id) VALUES(?, 'syslog', '10.0.10.9', 6, 'PC-0009', 'Meldung', 4624)");
  db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run(old); })();
  // counted, as the index pump does
  for (let i = 0; i < 10 && ev.countBatch() > 0; i++);
  ev.countBatch();
  settings.set('events.keepDays', 1);
  assert.equal(ev.prune(), 500);
  for (let i = 0; i < 200 && db.prepare('SELECT COUNT(*) FROM events_in').pluck().get(); i++) await new Promise((r) => setTimeout(r, 30));
  assert.equal(db.prepare('SELECT COUNT(*) FROM events_in').pluck().get(), 0);
  // the series is over: the counts of the removed messages and the sender are gone too
  for (let i = 0; i < 50 && db.prepare('SELECT COUNT(*) FROM event_senders').pluck().get(); i++) await new Promise((r) => setTimeout(r, 30));
  assert.equal(db.prepare('SELECT COUNT(*) FROM events_hour WHERE n > 0').pluck().get(), 0);
  ev.stop();
  db.close();
});

test('search index: merged in small steps of its own, the automatic merge (inside an insert, as large as it gets) is off', async () => {
  const db = openDatabase(path.join(dirOf('nb2'), 'whatsonmynet.sqlite'));
  const settings = createSettings(db);
  const ev = createEvents({ db, settings });
  assert.equal(db.prepare("SELECT v FROM events_fts_config WHERE k = 'automerge'").pluck().get(), 0);
  const ins = db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,text,event_id) VALUES(?, 'syslog', '10.0.10.9', 6, 'PC-0009', ?, 4624)");
  const at = new Date().toISOString();
  // many small batches: many pieces in the index
  for (let b = 0; b < 40; b++) { db.transaction(() => { for (let i = 0; i < 50; i++) ins.run(at, `Anmeldung Konto max${b}x${i}`); })(); ev.indexBatch(); }
  const pieces = () => db.prepare('SELECT COUNT(*) FROM events_fts_data').pluck().get();
  const before = pieces();
  // the pump merges them in its steps (and hands the server back between them)
  ev.indexPump();
  for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
  assert.ok(pieces() < before, `${pieces()} pieces, before ${before}`);
  assert.equal(ev.list({ q: 'max39x49', limit: 5 }).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM events_fts WHERE events_fts MATCH 'Anmeldung'").pluck().get(), 2000);
  ev.stop();
  db.close();
});

// The rule behind it: nothing in the diagnostic package may read a table that grows with time (messages, checks, log)
// in full - each statement on them goes along an index or stops after a fixed number of rows. Checked from the plan
// SQLite makes for each statement the package sends, so a new "read everything" is noticed here, not on a full server.
test('diagnostic package and message pages: no statement reads the messages, checks or log in full', async () => {
  const s = await startApp();
  try {
    const { db, ctx } = s;
    const seen = new Set();
    const prep = db.prepare.bind(db);
    db.prepare = (sql) => { seen.add(sql); return prep(sql); };
    try {
      await ctx.diagnostics.build({ days: 7, anonymize: true });
      // and what the pages of the messages ask for again and again
      ctx.events.status(); ctx.events.storage(); ctx.events.noise({ days: 7 }); ctx.events.noise({ days: 30 });
      ctx.events.histogram({ hours: 24 }); ctx.events.histogram({ hours: 720 }); ctx.events.senders(); ctx.events.list({ limit: 200 });
    } finally { db.prepare = prep; }
    const GROWING = /\b(events_in|checks|server_log|monitor_events|audit)\b/;
    const bad = [];
    for (const sql of seen) {
      if (!GROWING.test(sql) || !/^\s*SELECT/i.test(sql)) continue;
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) || []).length).fill('2026-01-01T00:00:00.000Z')).map((r) => r.detail);
      const full = plan.filter((d) => /^SCAN (events_in|checks|server_log|monitor_events|audit)\b/.test(d));
      if (full.length && !/\bLIMIT\b/i.test(sql)) bad.push(`${sql.replace(/\s+/g, ' ').slice(0, 140)}  →  ${full.join('; ')}`);
    }
    assert.deepEqual(bad, []);
  } finally { await s.close(); }
});
