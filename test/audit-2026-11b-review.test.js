// Review of the audit 2026-11 fixes: the stored SNMP access data work again for every device of the inventory and every
// admin monitor, the target rule of non-admins guards what is inside (not the internet), "from" in event rules matches
// names as before, safe counted groups in expressions are accepted again, and the auto-watch timer does not keep
// running rounds back to back.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { startApp } from './helpers.js';
import * as guard from '../src/lib/targetguard.js';
import { ruleMatches } from '../src/eventrules.js';
import { checkRegexStatic } from '../src/lib/saferegex.js';
import { createAutoWatch } from '../src/monitor/autowatch.js';

const app = await startApp();
const { call, ctx } = app;
test.after(() => { guard.setLookupForTests?.(null); return app.close(); });

const SECRET = 'firma-community-77';
const NAMES = {
  'www.example.com': ['203.0.113.80'],
  'dual.firma.local': ['10.0.10.30', '2001:db8::30'],
  'dual-lo.firma.local': ['10.0.10.31', '::1'],
  'v6.firma.local': ['2001:db8::31'],
  'ula.firma.local': ['fd00::31'],
  'lo6.firma.local': ['::1'],
};
let locA; let locB;

const snmpOpts = { oid: '1.3.6.1.2.1.1.1.0', op: 'contains', threshold: 'x' };
const mon = (who, body) => call('POST', '/api/monitors', { interval_s: 3600, timeout_s: 1, ...body }, { who });

test('setup: admin, editor, editor limited to a location with subnets and one without', async () => {
  guard.setLookupForTests?.(async (host) => {
    const list = NAMES[host];
    if (!list) throw new Error('ENOTFOUND');
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
  assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  assert.equal((await call('PUT', '/api/settings/scan', { snmpCommunities: SECRET })).status, 200);
  locA = (await call('POST', '/api/locations', { name: 'A', subnets: ['10.77.1.0/24'] })).data;
  locB = (await call('POST', '/api/locations', { name: 'B' })).data;
  for (const [u, pw, extra] of [['ed', 'Editor-Passwort-1', {}], ['seg', 'Standort-A-1234', { locations: [locA.id] }], ['segb', 'Standort-B-1234', { locations: [locB.id] }]]) {
    assert.equal((await call('POST', '/api/users', { username: u, password: pw, role: 'editor', ...extra })).status, 201);
    assert.equal((await call('POST', '/api/login', { username: u, password: pw }, { who: u })).status, 200);
  }
});

function udpListener() {
  const sock = dgram.createSocket('udp4');
  const got = [];
  sock.on('message', (b) => got.push(b.toString('latin1')));
  return new Promise((r) => sock.bind(0, '127.0.0.1', () => r({ sock, got, port: sock.address().port })));
}

// ------------------------------------------------------------------------------------------- 1. SNMP access data
test('admin SNMP monitor on 127.0.0.1 and polls of public device addresses use the stored community', async () => {
  const l = await udpListener();
  try {
    const m = await mon('default', { name: 'own snmpd', type: 'snmp', target: '127.0.0.1', port: l.port, options: snmpOpts });
    assert.equal(m.status, 201, JSON.stringify(m.data));
    await call('POST', `/api/monitors/${m.data.id}/check`, {});
  } finally { l.sock.close(); }
  assert.ok(l.got.some((p) => p.includes(SECRET)), 'the admin monitor asks with the stored community');

  const seen = [];
  ctx.printers.setReaderForTests(async (ip, creds) => { seen.push([ip, creds]); throw new Error('snmp'); });
  ctx.snmpDevices.setReaderForTests('switch', async (ip, creds) => { seen.push([ip, creds]); throw new Error('snmp'); });
  const prn = (await call('POST', '/api/devices', { name: 'PRN-1', type: 'printer', ip: '203.0.113.20' })).data;
  const sw = (await call('POST', '/api/devices', { name: 'SW-1', type: 'switch', ip: '192.0.2.21' })).data;
  await call('POST', `/api/devices/${prn.id}/printer`, {});
  await call('POST', `/api/devices/${sw.id}/snmp`, {});
  const credsOf = (ip) => JSON.stringify(seen.find((x) => x[0] === ip)?.[1]);
  assert.ok(credsOf('203.0.113.20').includes(SECRET), credsOf('203.0.113.20'));
  assert.ok(credsOf('192.0.2.21').includes(SECRET), credsOf('192.0.2.21'));
});

// ------------------------------------------------------------------------------------------- 2. target rule
test('editor: public URLs and addresses are fine, the host itself never', async () => {
  for (const b of [{ name: 'web', type: 'http', target: 'https://www.example.com/' }, { name: 'web-ip', type: 'http', target: 'https://203.0.113.80/' },
    { name: 'tcp-pub', type: 'tcp', target: '203.0.113.81', port: 443 }]) {
    const r = await mon('ed', b);
    assert.equal(r.status, 201, `${b.name}: ${JSON.stringify(r.data)}`);
  }
  for (const target of ['127.0.0.1', '::1', 'fe80::1', '169.254.1.1', '0.0.0.0', 'lo6.firma.local']) {
    const r = await mon('ed', { name: `no ${target}`, type: 'tcp', target, port: 22 });
    // IPv6 literals may already be refused by the form (400)
    assert.ok(r.status === 403 || (target.includes(':') && r.status === 400), `${target}: ${JSON.stringify(r.data)}`);
  }
  // IPv4-mapped forms (the monitor form refuses them already; the device address and the rule itself)
  const rule = { scoped: false, subnets: [] };
  for (const a of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:101', '::', '[::1]']) assert.equal(guard.addressAllowed(a, rule), false, a);
  assert.equal(guard.addressAllowed('::ffff:203.0.113.80', rule), true);
  assert.equal((await call('POST', '/api/devices', { name: 'PC-0009', ip: '::ffff:7f00:1' }, { who: 'ed' })).status === 201, false);
});

test('editor: SNMP monitors only to private ranges and location subnets', async () => {
  assert.equal((await mon('ed', { name: 's-pub', type: 'snmp', target: '203.0.113.9', options: snmpOpts })).status, 403);
  assert.equal((await mon('ed', { name: 's-lan', type: 'snmp', target: '10.0.10.9', options: snmpOpts })).status, 201);
  assert.equal((await mon('ed', { name: 's-loc', type: 'snmp', target: '10.77.1.9', options: snmpOpts })).status, 201);
  // turning a public tcp monitor into an SNMP one is checked again
  const t = (await call('GET', '/api/monitors', undefined, { who: 'ed' })).data.find((m) => m.name === 'tcp-pub');
  assert.equal((await call('PUT', `/api/monitors/${t.id}`, { type: 'snmp', options: snmpOpts }, { who: 'ed' })).status, 403);
});

test('dual-stack names: the IPv4 answers decide, IPv6 answers only must not be the host itself', async () => {
  assert.equal((await mon('ed', { name: 'dual', type: 'snmp', target: 'dual.firma.local', options: snmpOpts })).status, 201);
  assert.equal((await mon('ed', { name: 'dual-lo', type: 'tcp', target: 'dual-lo.firma.local', port: 22 })).status, 403);
  // only AAAA answers: each must pass - a global IPv6 address is fine for tcp, not for SNMP; unique local counts as private
  assert.equal((await mon('ed', { name: 'v6', type: 'tcp', target: 'v6.firma.local', port: 22 })).status, 201);
  assert.equal((await mon('ed', { name: 'v6-snmp', type: 'snmp', target: 'v6.firma.local', options: snmpOpts })).status, 403);
  assert.equal((await mon('ed', { name: 'ula-snmp', type: 'snmp', target: 'ula.firma.local', options: snmpOpts })).status, 201);
});

test('user limited to a location with subnets: public addresses, private ones only in his subnets', async () => {
  const d = (await call('POST', '/api/devices', { name: 'PC-0001', ip: '10.77.1.5', location_id: locA.id })).data;
  const r = (b) => mon('seg', { device_id: d.id, ...b });
  assert.equal((await r({ name: 'a-pub', type: 'tcp', target: '203.0.113.50', port: 443 })).status, 201);
  assert.equal((await r({ name: 'a-web', type: 'http', target: 'https://www.example.com:8443/' })).status, 201);
  assert.equal((await r({ name: 'a-own', type: 'tcp', target: '10.77.1.5', port: 22 })).status, 201);
  assert.equal((await r({ name: 'a-other', type: 'tcp', target: '10.0.10.5', port: 22 })).status, 403);
  assert.equal((await r({ name: 'a-dual', type: 'tcp', target: 'dual.firma.local', port: 22 })).status, 403, 'its IPv4 answer is outside his subnets');
  assert.equal((await r({ name: 'a-snmp-pub', type: 'snmp', target: '203.0.113.50', options: snmpOpts })).status, 403);
  assert.equal((await r({ name: 'a-snmp-lan', type: 'snmp', target: '10.0.10.5', options: snmpOpts })).status, 403);
  assert.equal((await r({ name: 'a-snmp-own', type: 'snmp', target: '10.77.1.5', options: snmpOpts })).status, 201);
});

test('user limited to a location without subnets: the private ranges count', async () => {
  const d = (await call('POST', '/api/devices', { name: 'PC-0002', ip: '10.0.10.40', location_id: locB.id })).data;
  const r = (b) => mon('segb', { device_id: d.id, ...b });
  assert.equal((await r({ name: 'b-lan', type: 'tcp', target: '10.0.10.40', port: 22 })).status, 201);
  assert.equal((await r({ name: 'b-pub', type: 'tcp', target: '203.0.113.41', port: 443 })).status, 201);
  assert.equal((await r({ name: 'b-lo', type: 'tcp', target: '127.0.0.1', port: 22 })).status, 403);
  assert.equal((await r({ name: 'b-mc', type: 'tcp', target: '224.0.0.1', port: 22 })).status, 403);
  assert.equal((await r({ name: 'b-snmp-lan', type: 'snmp', target: '10.0.10.42', options: snmpOpts })).status, 201);
  assert.equal((await r({ name: 'b-snmp-pub', type: 'snmp', target: '203.0.113.43', options: snmpOpts })).status, 403);
});

test('device address set by an editor: the tcp/ping rule', async () => {
  assert.equal((await call('POST', '/api/devices', { name: 'PC-0003', ip: '203.0.113.7' }, { who: 'ed' })).status, 201);
  assert.equal((await call('POST', '/api/devices', { name: 'PC-0004', ip: '169.254.3.4' }, { who: 'ed' })).status, 403);
});

// ------------------------------------------------------------------------------------------- 3. event rule senders
test('event rules: "from" names match as substrings again, addresses exactly - also the reported host', () => {
  const base = { kind: 'syslog', severity: 3, device_id: null, device_name: '', app: 'x', text: 'y', event_id: null, channel: '', host: '', source_ip: '' };
  const m = (from, row) => ruleMatches({ from }, { ...base, ...row });
  for (const f of ['switch', 'core-switch', 'Core', 'switch-*', 'core-*-01', 'SWITCH-01']) {
    assert.equal(m([f], { source_ip: '10.0.10.2', host: 'core-switch-01' }), true, `${f} (host)`);
    assert.equal(m([f], { source_ip: '10.0.10.2', device_name: 'core-switch-01' }), true, `${f} (device)`);
  }
  assert.equal(m(['access-switch'], { source_ip: '10.0.10.2', host: 'core-switch-01' }), false);
  assert.equal(m(['10.0.0.1'], { source_ip: '10.0.0.10' }), false);
  assert.equal(m(['10.0.0.1'], { source_ip: '10.0.0.1' }), true);
  assert.equal(m(['10.0.0.1'], { source_ip: '10.0.10.250', host: '10.0.0.1' }), true, 'an rsyslog relay: the reported host counts');
  assert.equal(m(['10.0.0.1'], { source_ip: '10.0.10.250', host: '10.0.0.10' }), false);
  assert.equal(m(['10.0.0.0/24'], { source_ip: '10.0.10.250', host: '10.0.0.7' }), true);
  assert.equal(m(['10.0.10'], { source_ip: '10.0.10.5' }), true, 'a partial address is its start');
  assert.equal(m(['10.0.10'], { source_ip: '110.0.10.5' }), false);
  assert.equal(m(['10.0.10.*'], { source_ip: '10.0.11.5', host: '10.0.10.9' }), true);
});

// ------------------------------------------------------------------------------------------- 4. counted groups
test('regex: counted groups whose repeated atom ends at a required separator are accepted', () => {
  for (const src of ['(\\d+\\.){3}\\d+', '(\\S+ ){2}failed', '(\\w+\\s){2}', '(?:\\w+\\s){2}', '([a-z]+-){2,4}x', '(\\d+:){2}\\d+']) {
    assert.doesNotThrow(() => checkRegexStatic(src), src);
  }
  for (const src of ['(?:\\*+ ?){8}ALERT', '(a+a){3}', '(\\w+\\d){3}', '(\\d+|x){3}', '(a+){2,5}', '(\\d+\\.\\d+){3}', '((\\d+)\\.){3}', '(\\w+ ?){4}']) {
    assert.throws(() => checkRegexStatic(src), (e) => e.code === 'err.regexUnsafe', src);
  }
});

// ------------------------------------------------------------------------------------------- 5. auto-watch rounds
test('auto-watch: the minute timer does not ask for another round, a newly added device does', async () => {
  const { db } = ctx;
  let rounds = 0;
  const wrapped = { prepare: (sql) => { if (/FROM devices WHERE auto_watch IS NOT NULL/.test(sql)) rounds++; return db.prepare(sql); } };
  let release;
  let gate = new Promise((r) => { release = r; });
  const monitoring = { suggestionFor: async () => { await gate; const e = new Error('dup'); e.status = 409; throw e; }, create: async () => ({}) };
  const aw = createAutoWatch({ db: wrapped, settings: { get: () => undefined }, monitoring });
  const id = db.prepare("INSERT INTO devices(name, ip, type, created_at, updated_at) VALUES('PC-0005', '10.0.10.55', 'pc', datetime(), datetime())").run().lastInsertRowid;
  db.prepare("UPDATE devices SET auto_watch='{\"lang\":\"en\"}' WHERE id=?").run(id);
  db.prepare("UPDATE devices SET auto_watch=NULL WHERE id<>?").run(id);
  const p = aw.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(await aw.tick(), 0, 'the timer while a round runs');
  release();
  await p;
  assert.equal(rounds, 1, 'no second round for the timer');

  // a device added while a round runs: one more round right after
  rounds = 0;
  gate = new Promise((r) => { release = r; });
  const id2 = db.prepare("INSERT INTO devices(name, ip, type, created_at, updated_at) VALUES('PC-0006', '10.0.10.56', 'pc', datetime(), datetime())").run().lastInsertRowid;
  db.prepare("UPDATE devices SET auto_watch='{\"lang\":\"en\"}' WHERE id=?").run(id);
  aw.start();
  try {
    const p2 = aw.tick();
    await new Promise((r) => setImmediate(r));
    aw.markDevices([id2], 'en');
    await new Promise((r) => setImmediate(r));
    release();
    await p2;
    assert.equal(rounds, 2, 'one more round for the new device');
  } finally { aw.stop(); }
});
