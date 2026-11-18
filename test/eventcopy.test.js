// A standby takes the master's messages: twins (the sender sends to both) are skipped - quickly, also when a busy
// network has many messages per second (one pass per time slice, not one query per message: that kept the CPU busy).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { createSettings } from '../src/settings.js';
import { createEvents } from '../src/events.js';

test('copies: twins skipped (here and within the page), the rest written - fast with many messages per second', () => {
  const db = openDatabase(path.join(fs.mkdtempSync(path.join(tmp, 'evcopy-')), 'whatsonmynet.sqlite'));
  const ev = createEvents({ db, settings: createSettings(db) });
  const t0 = Date.parse('2026-11-18T08:00:00Z');
  // here already: 60 000 messages within a minute (1000 per second) from 50 senders
  const add = db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,text) VALUES(?, 'syslog', ?, 5, ?)");
  db.transaction(() => { for (let i = 0; i < 60000; i++) add.run(new Date(t0 + i).toISOString(), `10.0.10.${i % 50}`, `Meldung ${i}`); })();
  // the master's page: 2000 of those (a little later - its own clock), 1000 new ones, one new one twice
  const row = (at, ip, text, id = 0) => [id, new Date(at).toISOString(), 'syslog', ip, 5, null, '', '', '', text, null, '', ''];
  const page = [];
  for (let i = 0; i < 2000; i++) page.push(row(t0 + i * 30 + 700, `10.0.10.${(i * 30) % 50}`, `Meldung ${i * 30}`));
  for (let i = 0; i < 1000; i++) page.push(row(t0 + i * 50, '10.0.10.200', `Neu ${i}`));
  page.push(row(t0 + 5, '10.0.10.201', 'doppelt'), row(t0 + 900, '10.0.10.201', 'doppelt'));
  // the same text much later is another message
  page.push(row(t0 + 20 * 60000, '10.0.10.0', 'Meldung 0'));
  const started = process.hrtime.bigint();
  const n = ev.importCopies(page);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(n, 1000 + 1 + 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events_in WHERE text='doppelt'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events_in WHERE text='Meldung 0'").get().n, 2);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
  // nothing more the second time
  assert.equal(ev.importCopies(page), 0);
  // rubbish is left out
  assert.equal(ev.importCopies([null, [0, 'kein Datum', 'syslog', '10.0.10.1', 5], [0, new Date(t0).toISOString(), 'SYS LOG', '10.0.10.1', 5], 'x']), 0);
  db.close();
});
