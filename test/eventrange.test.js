// A time range for the messages (as in Splunk or Wazuh): filter for an event, then narrow it to the hours that matter.
// The list and the bars above it follow the same filters; the bars count errors, warnings and the rest per step of time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => { ctx.events.stop(); return app.close(); });

const H = 3600000;
const base = Date.parse('2026-11-10T08:00:00.000Z');
const ins = db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,text,event_id) VALUES(?, 'syslog', ?, ?, ?, ?, ?)");
const at = (h) => new Date(base + h * H).toISOString();

test('setup with messages over a day', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'viewer' });
  assert.equal((await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'viewer' })).status, 200);
  ins.run(at(0), '10.0.10.5', 6, 'PC-0001', 'Anmeldung erfolgreich', 4624);
  ins.run(at(2), '10.0.10.5', 4, 'PC-0001', 'Fehler beim Anmelden eines Kontos', 4625);
  ins.run(at(2.6), '10.0.10.5', 4, 'PC-0001', 'Fehler beim Anmelden eines Kontos', 4625);
  ins.run(at(3), '10.0.10.6', 3, 'PC-0002', 'Dienst beendet', 7031);
  ins.run(at(10), '10.0.10.5', 4, 'PC-0001', 'Fehler beim Anmelden eines Kontos', 4625);
});

test('list: from is inclusive, to is not; with search and sender', async () => {
  const texts = (r) => r.data.list.map((x) => x.at);
  let r = await call('GET', `/api/events?from=${encodeURIComponent(at(2))}&to=${encodeURIComponent(at(3))}`);
  assert.equal(r.status, 200);
  assert.deepEqual(texts(r), [at(2.6), at(2)]);
  r = await call('GET', `/api/events?q=4625&from=${encodeURIComponent(at(2.6))}`);
  assert.deepEqual(texts(r), [at(10), at(2.6)]);
  r = await call('GET', `/api/events?q=4625&to=${encodeURIComponent(at(2.6))}&source=10.0.10.5`);
  assert.deepEqual(texts(r), [at(2)]);
  // more of the list: the range stays
  const first = (await call('GET', `/api/events?from=${encodeURIComponent(at(0))}&limit=2`)).data.list;
  r = await call('GET', `/api/events?from=${encodeURIComponent(at(2))}&before=${first[1].id}`);
  assert.deepEqual(texts(r), [at(2.6), at(2)]);
});

test('bad ranges are refused; viewers see nothing', async () => {
  assert.equal((await call('GET', '/api/events?from=gestern')).status, 400);
  assert.equal((await call('GET', '/api/events/histogram?to=2026-13-45')).status, 400);
  const r = await call('GET', `/api/events?from=${encodeURIComponent(at(3))}&to=${encodeURIComponent(at(2))}`);
  assert.equal(r.status, 400);
  assert.equal(r.data.error.message, 'Der Beginn des Zeitraums muss vor seinem Ende liegen.');
  assert.equal((await call('GET', '/api/events/histogram', undefined, { who: 'viewer' })).status, 403);
});

test('histogram: step follows the span, counts split by severity, same filters as the list', async () => {
  let r = await call('GET', `/api/events/histogram?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(12))}`);
  assert.equal(r.status, 200);
  // 12 hours → bars of 15 minutes (48 of them)
  assert.equal(r.data.step, 900);
  assert.equal(r.data.buckets.length, 48);
  assert.equal(r.data.total, 5);
  const sum = (k) => r.data.buckets.reduce((s, b) => s + b[k], 0);
  assert.deepEqual([sum('err'), sum('warn'), sum('other')], [1, 3, 1]);
  assert.deepEqual(r.data.buckets[8], { at: at(2), err: 0, warn: 1, other: 0 });
  // a search narrows the bars too
  r = await call('GET', `/api/events/histogram?q=4625&from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(12))}`);
  assert.equal(r.data.total, 3);
  // one hour → bars of one minute
  r = await call('GET', `/api/events/histogram?from=${encodeURIComponent(at(2))}&to=${encodeURIComponent(at(3))}`);
  assert.deepEqual([r.data.step, r.data.buckets.length, r.data.total], [60, 60, 2]);
  // without a start: from the oldest message that matches
  r = await call('GET', `/api/events/histogram?q=7031&to=${encodeURIComponent(at(4))}`);
  assert.deepEqual([r.data.from, r.data.total], [at(3), 1]);
  // nothing that matches: no bars, no error
  r = await call('GET', '/api/events/histogram?q=nothing-like-this');
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 0);
  // never more than about 60 bars, even over a year
  r = await call('GET', `/api/events/histogram?from=2025-11-01T00:00:00Z&to=${encodeURIComponent(at(12))}`);
  assert.ok(r.data.buckets.length <= 61, `${r.data.buckets.length} bars`);
  assert.equal(r.data.total, 5);
});
