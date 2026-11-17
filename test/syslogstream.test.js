// Syslog over TCP (RFC 6587) and TLS (RFC 5425) over real connections: both framings, several messages per
// connection and split across packets, limits that end a connection, the certificate of the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
process.env.WOMN_SYSLOG_TCP_PORT = String(await freePort());
process.env.WOMN_SYSLOG_TLS_PORT = String(await freePort());
const { memoryDb, tmp } = await import('./helpers.js');
const { createSettings } = await import('../src/settings.js');
const { createEvents, syslogFramer, FLOOD } = await import('../src/events.js');

const key = path.join(tmp, 'sl.key'); const crt = path.join(tmp, 'sl.crt');
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=womn.firma.local',
  '-addext', 'subjectAltName=DNS:womn.firma.local,IP:127.0.0.1'], { stdio: 'ignore' });
const pem = { cert: fs.readFileSync(crt, 'utf8'), key: fs.readFileSync(key, 'utf8') };
const db = memoryDb();
const settings = createSettings(db);
const ev = createEvents({ db, settings, tls: { current: () => pem } });
test.after(() => ev.stop());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = () => db.prepare('SELECT text, app, severity FROM events_in ORDER BY id').all();
const until = async (n) => { for (let i = 0; i < 60 && rows().length < n; i++) await wait(50); return rows(); };

test('framing: length first, line by line, mixed, split over packets; nonsense ends it', () => {
  const got = [];
  const feed = syslogFramer((b) => got.push(b.toString()));
  assert.equal(feed(Buffer.from('16 <13>one message\n<13>line two\n<1')), true);
  assert.equal(feed(Buffer.from('3>three\r\n10 <13>fo')), true);
  assert.equal(feed(Buffer.from('ur!!\n')), true);
  assert.deepEqual(got, ['<13>one message\n', '<13>line two', '<13>three\r', '<13>four!!']);
  assert.equal(syslogFramer(() => {})(Buffer.from('99999999 <13>x')), false, 'a length above the limit');
  // NXLog without Exec (im_msvistalog -> om_tcp) and devices without <PRI>: lines that start with a digit
  const nx = []; const feedNx = syslogFramer((b) => nx.push(b.toString()));
  assert.equal(feedNx(Buffer.from('2026-11-15 10:00:00 PC-01 INFO 1116 Malware found\r\n2026-11-15 10:00:01 PC-01 WARNING 865 Access to C:\\x.exe restricted\n12')), true);
  assert.equal(feedNx(Buffer.from(' <13>tw')), true);
  assert.equal(feedNx(Buffer.from('elve!!\n404 not a length\n')), true);
  assert.deepEqual(nx, ['2026-11-15 10:00:00 PC-01 INFO 1116 Malware found\r', '2026-11-15 10:00:01 PC-01 WARNING 865 Access to C:\\x.exe restricted', '<13>twelve!!', '404 not a length']);
  // a message that is too long is skipped - that one only, the connection and the next messages stay
  const long = []; let skips = 0; const feedLong = syslogFramer((b) => long.push(b.toString()), () => { skips++; });
  assert.equal(feedLong(Buffer.from(`<13>${'x'.repeat(9000)}`)), true, 'a line without end above the limit');
  assert.equal(feedLong(Buffer.from(`${'y'.repeat(100)}\n<13>next\n9000 <13>${'z'.repeat(8996)}<13>after\n`)), true);
  assert.deepEqual([long, skips], [['<13>next', '<13>after'], 2]);
});

test('TCP: several messages on one connection, both framings', async () => {
  settings.set('events.syslogTcp', true);
  ev.apply();
  await wait(150);
  assert.equal(ev.status().syslogTcp.on, true);
  const s = net.connect(Number(process.env.WOMN_SYSLOG_TCP_PORT), '127.0.0.1');
  await new Promise((r) => s.once('connect', r));
  s.write('<11>Nov 15 10:00:00 sw01 stp: topology change\n');
  const m5424 = '<12>1 2026-11-15T10:00:00Z fw01 filterlog - - - WAN down';
  s.write(`${Buffer.byteLength(m5424)} ${m5424}`);
  s.write('\n<14>fs01 smartd[1]: ok\n');
  const r = await until(3);
  s.end();
  assert.deepEqual(r.map((x) => [x.app, x.text, x.severity]), [['stp', 'topology change', 3], ['filterlog', 'WAN down', 4], ['smartd', 'ok', 6]]);
  assert.equal(r.length, 3);
});

test('TCP: a sender sending nonsense is cut off, the next connection works', async () => {
  db.prepare('DELETE FROM events_in').run();
  const bad = net.connect(Number(process.env.WOMN_SYSLOG_TCP_PORT), '127.0.0.1');
  await new Promise((r) => bad.once('connect', r));
  const closed = new Promise((r) => bad.once('close', r));
  bad.write('9999999 <13>too long');
  await closed;
  const good = net.connect(Number(process.env.WOMN_SYSLOG_TCP_PORT), '127.0.0.1', () => good.end('<13>still here\n'));
  assert.deepEqual((await until(1)).map((x) => x.text), ['still here']);
});

test('TLS: with the certificate of the server, checked by the sender; plain TCP on the TLS port gets nothing in', async () => {
  db.prepare('DELETE FROM events_in').run();
  settings.set('events.syslogTls', true);
  ev.apply();
  await wait(150);
  assert.equal(ev.status().syslogTls.on, true);
  const s = tls.connect({ port: Number(process.env.WOMN_SYSLOG_TLS_PORT), host: '127.0.0.1', ca: pem.cert, servername: 'womn.firma.local' });
  await new Promise((r, j) => { s.once('secureConnect', r); s.once('error', j); });
  assert.equal(s.authorized, true, 'the sender can check the certificate');
  const m = '<10>1 - nas01 kernel - - - disk';
  s.write(`${Buffer.byteLength(m)} ${m}`);
  s.end();
  assert.deepEqual((await until(1)).map((x) => [x.app, x.text, x.severity]), [['kernel', 'disk', 2]]);
  const plain = net.connect(Number(process.env.WOMN_SYSLOG_TLS_PORT), '127.0.0.1', () => plain.write('<13>not encrypted\n'));
  await new Promise((r) => plain.once('close', r));
  await wait(100);
  assert.equal(rows().length, 1, 'nothing unencrypted is taken on the TLS port');
});

test('switched off: ports closed, connections ended', async () => {
  settings.set('events.syslogTcp', false); settings.set('events.syslogTls', false);
  ev.apply();
  await wait(100);
  assert.deepEqual([ev.status().syslogTcp.on, ev.status().syslogTls.on], [false, false]);
  await assert.rejects(new Promise((r, j) => { const s = net.connect(Number(process.env.WOMN_SYSLOG_TCP_PORT), '127.0.0.1', r); s.once('error', j); }));
});

test('TCP: above the limit a sender is held back, not dropped - all come, in order, a little later', async () => {
  const d2 = memoryDb(); const s2 = createSettings(d2);
  s2.set('events.syslogTcp', true);
  const seen = [];
  const e2 = createEvents({ db: d2, settings: s2, limits: { perSenderStream: 30 }, ports: { syslogTcp: 0 }, bind: '127.0.0.1', onEvent: (r) => seen.push(r.id) });
  e2.apply();
  for (let i = 0; i < 40 && !e2.status().syslogTcp.on; i++) await wait(25);
  const c = net.connect(e2.status().syslogTcp.port, '127.0.0.1');
  await new Promise((r) => c.once('connect', r));
  const t0 = Date.now();
  c.write(Array.from({ length: 100 }, (_, i) => `<14>pc01 app: message ${i}\n`).join(''));
  const got = () => d2.prepare('SELECT text FROM events_in ORDER BY id').pluck().all();
  for (let i = 0; i < 120 && got().length < 100; i++) await wait(50);
  c.end(); e2.stop();
  assert.deepEqual(got(), Array.from({ length: 100 }, (_, i) => `message ${i}`), 'all of them, in order');
  assert.ok(Date.now() - t0 >= 2000, 'spread over the seconds (30 a second)');
  assert.ok(e2.status().heldBack > 0);
  assert.equal(e2.status().flooded, 0, 'none dropped');
  // the rules and monitors saw each message once, after it was written (with its id)
  assert.equal(seen.length, 100); assert.ok(seen.every((id) => id > 0));
  assert.equal(new Set(seen).size, 100);
  assert.equal(FLOOD.perSenderStream, 500);
});

test('messages of one turn are written together: one row per sender, the newest message and the first time', () => {
  const d3 = memoryDb(); const s3 = createSettings(d3);
  const e3 = createEvents({ db: d3, settings: s3 });
  const t = d3.prepare('SELECT total_changes()').pluck();
  e3.queue('syslog', '10.0.10.5', { severity: 6, host: 'PC-0005', app: 'a', text: 'one' });
  e3.queue('syslog', '10.0.10.5', { severity: 4, host: '', app: 'a', text: 'two' });
  e3.queue('syslog', '10.0.10.6', { severity: 6, host: 'PC-0006', app: 'b', text: 'three' });
  assert.equal(d3.prepare('SELECT COUNT(*) FROM events_in').pluck().get(), 0, 'not yet - at the end of the turn');
  const before = t.get();
  e3.flush();
  assert.equal(d3.prepare('SELECT COUNT(*) FROM events_in').pluck().get(), 3);
  assert.ok(t.get() - before <= 6, 'three messages and two senders');
  const s = d3.prepare('SELECT source_ip, host, last_id, first_at FROM event_senders ORDER BY source_ip').all();
  const ids = d3.prepare('SELECT id, text FROM events_in ORDER BY id').all();
  assert.deepEqual(s.map((r) => [r.source_ip, r.host, r.last_id]), [['10.0.10.5', 'PC-0005', ids[1].id], ['10.0.10.6', 'PC-0006', ids[2].id]]);
  assert.ok(s[0].first_at);
  // receive() still writes at once (and what is waiting before it)
  e3.queue('syslog', '10.0.10.7', { severity: 6, text: 'waiting' });
  e3.receive('syslog', '10.0.10.7', { severity: 6, text: 'now' });
  assert.deepEqual(d3.prepare('SELECT text FROM events_in WHERE source_ip = ? ORDER BY id').pluck().all('10.0.10.7'), ['waiting', 'now']);
  e3.stop();
});
