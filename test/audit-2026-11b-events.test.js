// Audit 2026-11 (3b): receiving messages - regular expressions, memory, event monitors, rule senders, standby search,
// syslog over TLS and UDP over IPv6.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import v8 from 'node:v8';
import vm from 'node:vm';
import { memoryDb, tmp } from './helpers.js';

const { openDatabase } = await import('../src/db.js');
const { createSettings } = await import('../src/settings.js');
const events = await import('../src/events.js');
const { createEvents, eventMatches, eventCheck } = events;
const { ruleMatches } = await import('../src/eventrules.js');
const { checkRegexStatic, checkRegexTime } = await import('../src/lib/saferegex.js');

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('regex: a counted group around an unbounded quantifier is refused when saved', () => {
  for (const src of ['(?:\\*+ ?){8}ALERT', '(a+){2,5}', '(?:\\w+\\s?){2}', '(x*y){3,}']) {
    assert.throws(() => checkRegexStatic(src), (e) => e.code === 'err.regexUnsafe', src);
  }
  // still fine: counted groups without an unbounded inner quantifier or whose repeated atom stops at a required
  // separator, and the presets of the rule form
  for (const src of ['(\\d{1,3}\\.){3}\\d{1,3}', '(?:\\w+\\s){2}', '(ab){8}', '([a-z]+){1}', 'Failed password|Invalid user', 'port\\s*(\\d+)\\D*down', 'port\\s*(\\d+)\\D*up']) {
    assert.doesNotThrow(() => checkRegexStatic(src), src);
  }
});

test('regex: the timed check also tries runs of the expression\'s own characters', async () => {
  // polynomial backtracking on a run of '*' - no group, so only the timed check can see it
  await assert.rejects(checkRegexTime('\\*+\\*+\\*+\\*+ALERT', ['UPS ALERT on battery']));
  // the presets still pass
  assert.ok(await checkRegexTime('port\\s*(\\d+)\\D*down', ['Port 12 link down']) >= 0);
  assert.ok(await checkRegexTime('Failed password|Invalid user', ['sshd: Failed password for root']) >= 0);
});

test('memory: senders whose messages are filtered out are remembered only up to a limit', async () => {
  const db = memoryDb(); const settings = createSettings(db);
  settings.set('events.minSeverity', 4);
  const ev = createEvents({ db, settings, limits: { perSecond: 1e9 } });
  const flood = (from) => { for (let i = from; i < from + 200000; i++) ev.receive('syslog', `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, { severity: 6, text: 'x' }); };
  // the flood counters of the current second are emptied by the first message of the next one
  const heap = async () => { await wait(1100); ev.receive('syslog', '192.0.2.1', { severity: 6, text: 'x' }); gc(); gc(); return process.memoryUsage().heapUsed; };
  flood(0); // the first round fills the remembered senders up to the limit (and warms up everything else)
  const before = await heap();
  flood(200000);
  const grown = (await heap() - before) / 1048576;
  assert.equal(ev.status().filtered, 400002);
  assert.ok(grown < 3, `heap grew ${grown.toFixed(1)} MB for 200 000 more filtered messages from different addresses`);
});

test('event monitor: the check is case-insensitive beyond ASCII, like the trigger', () => {
  const db = memoryDb();
  db.prepare("INSERT INTO events_in(at, kind, source_ip, severity, app, text) VALUES(?, 'syslog', '10.0.10.5', 3, 'ups', 'LÜFTER AUSGEFALLEN')").run(new Date().toISOString());
  const row = db.prepare('SELECT * FROM events_in').get();
  const o = { source: 'any', maxSeverity: 4, holdMin: 15, match: 'Lüfter ausgefallen' };
  assert.equal(eventMatches(row, o, null), true);
  assert.equal(eventCheck(db, { options: JSON.stringify(o), device_id: null }).ok, false);
  // a text that is not there stays ok; LIKE signs in the text are plain characters
  assert.equal(eventCheck(db, { options: JSON.stringify({ ...o, match: 'lüfter_aus' }), device_id: null }).ok, true);
});

test('event rules: "from" matches addresses exactly or by network, names as parts of the name', () => {
  const base = { kind: 'syslog', severity: 3, device_id: null, device_name: '', app: 'x', text: 'y', event_id: null, channel: '', host: '' };
  const m = (from, row) => ruleMatches({ from }, { ...base, ...row });
  assert.equal(m(['10.0.10.1'], { source_ip: '10.0.10.15' }), false);
  assert.equal(m(['10.0.10.1'], { source_ip: '10.0.10.100' }), false);
  assert.equal(m(['10.0.10.1'], { source_ip: '10.0.10.1' }), true);
  assert.equal(m(['10.0.0.1'], { source_ip: '10.0.0.10' }), false);
  assert.equal(m(['10.0.10.1'], { source_ip: '192.0.2.9', host: '10.0.10.1' }), true, 'a relay: the address the message gives counts as well');
  assert.equal(m(['10.0.10.1'], { source_ip: '192.0.2.9', host: '10.0.10.15' }), false);
  assert.equal(m(['10.0.10.0/24'], { source_ip: '10.0.10.77' }), true);
  assert.equal(m(['10.0.10.0/24'], { source_ip: '10.0.11.7' }), false);
  assert.equal(m(['10.0.10.'], { source_ip: '10.0.10.200' }), true, 'the start of an address still works');
  assert.equal(m(['10.0.10.'], { source_ip: '110.0.10.200' }), false);
  assert.equal(m(['dc01'], { source_ip: '192.0.2.10', host: 'DC01.firma.local' }), true);
  assert.equal(m(['dc01'], { source_ip: '192.0.2.10', host: 'srv02' }), false);
  assert.equal(m(['switch'], { source_ip: '10.0.10.2', host: 'core-switch-01' }), true, 'a part of the name, as rules always did');
  assert.equal(m(['pc-00'], { source_ip: '10.0.10.21', device_id: 8, device_name: 'PC-00010' }), true);
  assert.equal(m(['pc-*10'], { source_ip: '10.0.10.21', device_id: 8, device_name: 'PC-00010' }), true, '* for any characters');
  assert.equal(m(['pc-*11'], { source_ip: '10.0.10.21', device_id: 8, device_name: 'PC-00010' }), false);
});

test('standby: a time range finds own messages and copies whose ids are not in time order', () => {
  const db = openDatabase(path.join(fs.mkdtempSync(path.join(tmp, 'ev3b-')), 'whatsonmynet.sqlite'));
  const ev = createEvents({ db, settings: createSettings(db) });
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  for (let i = 0; i < 3; i++) ev.receive('syslog', '10.0.10.7', { severity: 3, text: `diskfull volume ${i}` }, new Date(t0 + i * 1000));
  ev.importCopies([[1, new Date(t0 - 30000).toISOString(), 'syslog', '10.0.10.8', 5, null, '', '', '', 'diskfull other', null, '', '']]);
  while (ev.indexBatch() > 0);
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(ev.list({ q: 'diskfull' }).length, 4);
  assert.equal(ev.list({ q: 'diskfull', from: iso(t0 - 60000) }).length, 4);
  assert.equal(ev.list({ q: 'diskfull', from: iso(t0 - 60000), to: iso(t0 - 10000) }).length, 1, 'the copy before "to" has a higher id');
  assert.equal(ev.list({ q: 'diskfull', from: iso(t0 + 1000) }).length, 2);
  assert.equal(ev.list({ q: 'diskfull', to: iso(t0 - 60000) }).length, 0);
  assert.equal(ev.list({ q: 'diskfull', from: iso(t0 + 60000) }).length, 0);
});

test('syslog TLS: connections are counted per address before the handshake', async () => {
  const key = path.join(tmp, 'a3b.key'); const crt = path.join(tmp, 'a3b.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=test.example',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const pem = { cert: fs.readFileSync(crt, 'utf8'), key: fs.readFileSync(key, 'utf8') };
  const db = memoryDb(); const settings = createSettings(db);
  settings.set('events.syslogTls', true);
  const seen = [];
  const ev = createEvents({ db, settings, tls: { current: () => pem }, ports: { syslogTls: 0 }, bind: '127.0.0.1', onEvent: (r) => seen.push(r.text) });
  ev.apply();
  await wait(200);
  const port = ev.status().syslogTls.port;
  // one host (127.0.0.2) opens many connections and never says hello
  const idle = [];
  for (let i = 0; i < 200; i++) {
    idle.push(await new Promise((r) => { const s = net.connect({ port, host: '127.0.0.1', localAddress: '127.0.0.2' }); s.on('error', () => {}); s.once('connect', () => r(s)); s.once('close', () => r(s)); }));
  }
  await wait(200);
  assert.ok(ev.status().syslogTls.connections <= 10, `${ev.status().syslogTls.connections} un-handshaken connections of one address held`);
  const ok = await new Promise((resolve) => {
    const c = tls.connect({ port, host: '127.0.0.1', ca: pem.cert }, () => { c.write('<11>legit: disk failure\n'); setTimeout(() => { c.destroy(); resolve(true); }, 300); });
    c.on('error', () => resolve(false)); c.on('close', () => resolve(false));
  });
  for (const s of idle) s.destroy();
  ev.stop();
  assert.ok(ok && seen.includes('disk failure'), 'a legitimate TLS sender gets through');
});

test('UDP receivers use an IPv6 socket for an IPv6 bind address', () => {
  assert.equal(typeof events.udpType, 'function');
  assert.equal(events.udpType('::1'), 'udp6');
  assert.equal(events.udpType('::'), 'udp6');
  assert.equal(events.udpType('fd00::10'), 'udp6');
  assert.equal(events.udpType('10.0.10.1'), 'udp4');
  assert.equal(events.udpType(undefined), 'udp4');
});

const ipv6 = await new Promise((r) => { const s = dgram.createSocket('udp6'); s.on('error', () => { s.close(); r(false); }); s.bind(0, '::1', () => { s.close(); r(true); }); });
test('UDP syslog and traps listen on an IPv6 bind address', { skip: ipv6 ? false : 'no IPv6 on this host' }, async () => {
  const db = memoryDb(); const settings = createSettings(db);
  settings.set('events.syslog', true); settings.set('events.traps', true);
  const seen = [];
  // traps refuse port 0 (below 1024 needs root): take a free high port for them
  const probe = dgram.createSocket('udp6');
  const trapPort = await new Promise((r) => probe.bind(0, '::1', () => { const p = probe.address().port; probe.close(() => r(p)); }));
  const ev = createEvents({ db, settings, ports: { syslog: 0, traps: trapPort }, bind: '::1', onEvent: (r) => seen.push(r.text) });
  ev.apply();
  await wait(200);
  const st = ev.status();
  try {
    assert.equal(st.syslog.error, ''); assert.equal(st.syslog.on, true);
    assert.equal(st.traps.error, ''); assert.equal(st.traps.on, true);
    const c = dgram.createSocket('udp6');
    await new Promise((r) => c.send('<11>app: over ipv6', st.syslog.port, '::1', r));
    c.close();
    await wait(200);
    assert.ok(seen.includes('over ipv6'));
  } finally { ev.stop(); }
});
