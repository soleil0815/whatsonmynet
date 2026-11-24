// Audit 2026-11 (b), group "scan": monitor targets and device addresses of non-admins never reach the WhatsOnMyNet host
// or internal networks outside their reach (SNMP monitors: only private ranges and location subnets), the SNMP walk
// stops asking once it is over, and one silent v3 user does not hide the others. (The rule in detail and the SNMP
// access data of admin devices: audit-2026-11b-review.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import snmp from 'net-snmp';
import { startApp } from './helpers.js';
import { walk, openSnmp } from '../src/scan/snmpwalk.js';
import { snmpSystem } from '../src/scan/probes.js';
import { forgetAccess } from '../src/snmpcreds.js';

const app = await startApp();
const { call, ctx } = app;
test.after(() => app.close());

const SECRET = 'firma-community-42';
let locA;

test('setup: admin, editor, location-limited editor, a stored community', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  assert.equal((await call('PUT', '/api/settings/scan', { snmpCommunities: SECRET })).status, 200);
  locA = (await call('POST', '/api/locations', { name: 'A', subnets: ['10.77.1.0/24'] })).data;
  assert.equal((await call('POST', '/api/users', { username: 'ed', password: 'Editor-Passwort-1', role: 'editor' })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'ed', password: 'Editor-Passwort-1' }, { who: 'ed' })).status, 200);
  assert.equal((await call('POST', '/api/users', { username: 'seg', password: 'Standort-A-1234', role: 'editor', locations: [locA.id] })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'seg', password: 'Standort-A-1234' }, { who: 'seg' })).status, 200);
});

function udpListener() {
  const sock = dgram.createSocket('udp4');
  const got = [];
  sock.on('message', (b) => got.push(b.toString('latin1')));
  return new Promise((r) => sock.bind(0, '127.0.0.1', () => r({ sock, got, port: sock.address().port })));
}

test('an editor cannot point an SNMP monitor at the WhatsOnMyNet host (no community leaves)', async () => {
  const l = await udpListener();
  try {
    const m = await call('POST', '/api/monitors', { name: 'x', type: 'snmp', target: '127.0.0.1', port: l.port, options: { oid: '1.3.6.1.2.1.1.1.0', op: 'contains', threshold: 'x' }, timeout_s: 2, interval_s: 3600 }, { who: 'ed' });
    assert.equal(m.status, 403, JSON.stringify(m.data));
    assert.equal(m.data.error.code, 'err.monitorTarget');
  } finally { l.sock.close(); }
  assert.ok(!l.got.some((p) => p.includes(SECRET)));
});

test('editor monitor targets: loopback, link-local, names resolving to loopback refused; private and public allowed', async () => {
  const appPort = Number(new URL(app.url).port);
  const bad = [
    { name: 't1', type: 'tcp', target: '127.0.0.1', port: appPort },
    { name: 't3', type: 'tcp', target: '169.254.1.1', port: 22 },
    { name: 't4', type: 'tcp', target: 'localhost', port: appPort },
    { name: 'h1', type: 'http', target: `http://127.0.0.1:${appPort}/` },
    { name: 'h3', type: 'http', target: `http://localhost:${appPort}/` },
    { name: 'm1', type: 'mail', target: '127.0.0.1', options: { proto: 'smtp', tls: 'none' } },
    { name: 'd1', type: 'dns', target: 'firma.local', options: { server: '127.0.0.1' } },
    { name: 'p1', type: 'mysql', target: '0.0.0.0' },
  ];
  for (const b of bad) {
    const r = await call('POST', '/api/monitors', { ...b, interval_s: 3600 }, { who: 'ed' });
    assert.equal(r.status, 403, `${b.name}: ${JSON.stringify(r.data)}`);
  }
  const ok = await call('POST', '/api/monitors', { name: 'ok1', type: 'tcp', target: '10.0.10.5', port: 22, interval_s: 3600 }, { who: 'ed' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const okHttp = await call('POST', '/api/monitors', { name: 'ok2', type: 'http', target: 'http://10.0.10.6/', interval_s: 3600 }, { who: 'ed' });
  assert.equal(okHttp.status, 201, JSON.stringify(okHttp.data));
  const okPub = await call('POST', '/api/monitors', { name: 'ok4', type: 'http', target: 'https://203.0.113.5/', interval_s: 3600 }, { who: 'ed' });
  assert.equal(okPub.status, 201, JSON.stringify(okPub.data));
  // a DNS check through the system resolver only asks a name - allowed
  const okDns = await call('POST', '/api/monitors', { name: 'ok3', type: 'dns', target: 'firma.local', interval_s: 3600 }, { who: 'ed' });
  assert.equal(okDns.status, 201, JSON.stringify(okDns.data));
});

test('a location-limited editor: only addresses inside the subnets of his locations', async () => {
  const da = (await call('POST', '/api/devices', { name: 'PC-0001', ip: '10.77.1.5', location_id: locA.id })).data;
  const appPort = Number(new URL(app.url).port);
  for (const target of ['127.0.0.1', '10.0.10.5']) {
    const m = await call('POST', '/api/monitors', { name: `probe ${target}`, type: 'tcp', target, port: appPort, device_id: da.id, interval_s: 3600 }, { who: 'seg' });
    assert.equal(m.status, 403, `${target}: ${JSON.stringify(m.data)}`);
  }
  const ok = await call('POST', '/api/monitors', { name: 'own', type: 'tcp', target: '10.77.1.5', port: 22, device_id: da.id, interval_s: 3600 }, { who: 'seg' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  // and moving it out of his network on an edit is refused as well
  const moved = await call('PUT', `/api/monitors/${ok.data.id}`, { target: '10.0.10.5' }, { who: 'seg' });
  assert.equal(moved.status, 403);
});

test('edits by an editor are checked again; admins stay unrestricted', async () => {
  const pub = await call('POST', '/api/monitors', { name: 'extern', type: 'tcp', target: '203.0.113.10', port: 443, interval_s: 3600 });
  assert.equal(pub.status, 201, 'admin may watch a public address');
  // renaming the admin's monitor or another port of a public address is fine, pointing it at the host itself is not
  assert.equal((await call('PUT', `/api/monitors/${pub.data.id}`, { name: 'extern 2' }, { who: 'ed' })).status, 200);
  assert.equal((await call('PUT', `/api/monitors/${pub.data.id}`, { port: 22 }, { who: 'ed' })).status, 200);
  assert.equal((await call('PUT', `/api/monitors/${pub.data.id}`, { target: '169.254.1.1' }, { who: 'ed' })).status, 403);
  const own = (await call('GET', '/api/monitors', undefined, { who: 'ed' })).data.find((m) => m.name === 'ok1');
  assert.equal((await call('PUT', `/api/monitors/${own.id}`, { target: '127.0.0.1' }, { who: 'ed' })).status, 403);
  assert.equal((await call('PUT', `/api/monitors/${own.id}`, { target: 'http://127.0.0.1/', type: 'http' }, { who: 'ed' })).status, 403);
});

test('device address set by a non-admin follows the monitor target rule', async () => {
  assert.equal((await call('POST', '/api/devices', { name: 'PC-0002', ip: '169.254.7.7' }, { who: 'ed' })).status, 403);
  const d = await call('POST', '/api/devices', { name: 'PC-0003', ip: '10.0.10.7' }, { who: 'ed' });
  assert.equal(d.status, 201);
  assert.equal((await call('PATCH', `/api/devices/${d.data.id}`, { ip: '127.0.0.1' }, { who: 'ed' })).status, 403);
  assert.equal((await call('PATCH', `/api/devices/${d.data.id}`, { notes: 'unchanged ip' }, { who: 'ed' })).status, 200);
  // admins may
  assert.equal((await call('PATCH', `/api/devices/${d.data.id}`, { ip: '127.0.0.1' })).status, 200);
  // an editor editing other fields of that device is not stopped by the admin's address
  assert.equal((await call('PATCH', `/api/devices/${d.data.id}`, { notes: 'still fine', ip: '127.0.0.1' }, { who: 'ed' })).status, 200);
});

test('walk() stops asking once it has ended (timeout) and on any repeated OID', async () => {
  let calls = 0;
  let stopped = false;
  const session = {
    subtree(base, _n, feed, done) {
      const step = () => {
        if (stopped) return;
        calls++;
        // OIDs going back and forth: never the same twice in a row
        const r = feed([{ oid: `${base}.1`, type: 4, value: Buffer.from('a') }, { oid: `${base}.2`, type: 4, value: Buffer.from('b') }]);
        if (r) return done(null);
        setTimeout(step, 1);
      };
      step();
    },
  };
  const out = await walk({ session }, '1.3.6.1.2.1.4.22.1.2', { max: 2000, timeout: 200 });
  const atResolve = calls;
  await new Promise((r) => setTimeout(r, 150));
  stopped = true;
  assert.ok(calls <= atResolve + 1, `still asking after the walk ended: ${atResolve} -> ${calls}`);
  assert.equal(out.size, 2);
  assert.ok(atResolve <= 2, `a repeated OID ends the walk at once (asked ${atResolve} times)`);
});

// A v3 device that answers engine discovery but silently drops requests of users it does not know (a UDP relay in
// front of a net-snmp agent drops every packet that carries the unknown user's name)
test('a v3 user dropped silently by the device does not hide the next, valid v3 user', async () => {
  const PORT = 17161 + Math.floor(Math.random() * 1000);
  const agent = snmp.createAgent({ port: PORT, address: '127.0.0.1', accessControlModelType: snmp.AccessControlModelType.None }, () => {});
  agent.getAuthorizer().addUser({ name: 'womn-read', level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha256, authKey: 'Firma-Auth-1',
    privProtocol: snmp.PrivProtocols.aes, privKey: 'Firma-Priv-1' });
  const mib = agent.getMib();
  mib.registerProvider({ name: 'sysDescr', type: snmp.MibProviderType.Scalar, oid: '1.3.6.1.2.1.1.1', scalarType: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess['read-only'] });
  mib.setScalarValue('sysDescr', 'PC-0001 switch');
  const relay = dgram.createSocket('udp4');
  const back = new Map();
  relay.on('message', (b, rinfo) => {
    if (rinfo.port === PORT) { const to = back.get('c'); if (to) relay.send(b, to.port, '127.0.0.1'); return; }
    if (b.includes(Buffer.from('fremder-user'))) return; // unknown user: dropped without a report
    back.set('c', rinfo);
    relay.send(b, PORT, '127.0.0.1');
  });
  await new Promise((r) => relay.bind(0, '127.0.0.1', r));
  const relayPort = relay.address().port;
  const good = { v3: true, user: 'womn-read', level: 'authPriv', authProtocol: 'sha256', authKey: 'Firma-Auth-1', privProtocol: 'aes', privKey: 'Firma-Priv-1' };
  const unknown = { ...good, user: 'fremder-user' };
  try {
    forgetAccess();
    const s = await openSnmp('127.0.0.1', [unknown, good], { port: relayPort, timeout: 400 });
    assert.ok(s, 'the second v3 user was tried and works');
    assert.equal(s.access, 'v3 · womn-read · authPriv');
    s.close();
  } finally { relay.close(); agent.close(); }
  // a host silent to v3 altogether is still asked only once (gentle scan)
  forgetAccess();
  const t0 = Date.now();
  assert.equal(await snmpSystem('127.0.0.1', [unknown, good, { ...good, user: 'u3' }], 300), null);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});
