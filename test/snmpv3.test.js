// SNMPv3: users with authentication and encryption next to the communities. Stored encrypted, the keys never go to the
// browser; an empty key in the form keeps the stored one. A device that only speaks v3 is read with its user; the
// access that worked is tried first next time; a device silent to v3 is not asked with every user.
import test from 'node:test';
import assert from 'node:assert/strict';
import snmp from 'net-snmp';
import { startApp } from './helpers.js';
import { openSnmp, getValues } from '../src/scan/snmpwalk.js';
import { parseV3, snmpCredentials, orderFor, forgetAccess } from '../src/snmpcreds.js';

const PORT = 16161 + Math.floor(Math.random() * 1000);
const agent = snmp.createAgent({ port: PORT, address: '127.0.0.1', accessControlModelType: snmp.AccessControlModelType.None }, () => {});
agent.getAuthorizer().addUser({ name: 'womn-read', level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha256, authKey: 'Geheim-Auth-1',
  privProtocol: snmp.PrivProtocols.aes, privKey: 'Geheim-Priv-1' });
const mib = agent.getMib();
mib.registerProvider({ name: 'sysDescr', type: snmp.MibProviderType.Scalar, oid: '1.3.6.1.2.1.1.1', scalarType: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess['read-only'] });
mib.setScalarValue('sysDescr', 'Switch nur mit v3');

const app = await startApp();
const { call, db } = app;
test.after(() => { agent.close(); app.close(); });

const good = { v3: true, user: 'womn-read', level: 'authPriv', authProtocol: 'sha256', authKey: 'Geheim-Auth-1', privProtocol: 'aes', privKey: 'Geheim-Priv-1' };

test('a device that only speaks v3: the community fails, the v3 user reads it; next time that user first', async () => {
  forgetAccess();
  const s = await openSnmp('127.0.0.1', ['public', good], { port: PORT, timeout: 700 });
  assert.ok(s, 'opened');
  assert.equal(s.version, '3');
  assert.equal(s.access, 'v3 · womn-read · authPriv');
  assert.match(String((await getValues(s, ['1.3.6.1.2.1.1.1.0']))['1.3.6.1.2.1.1.1.0']), /nur mit v3/);
  s.close();
  assert.equal(orderFor('127.0.0.1', ['public', good])[0], good, 'remembered');
  const t0 = Date.now();
  const again = await openSnmp('127.0.0.1', ['public', good], { port: PORT, timeout: 700 });
  assert.ok(Date.now() - t0 < 700, 'no wait for the community any more');
  again.close();
});

test('wrong password or wrong procedure: nothing opened', async () => {
  forgetAccess();
  assert.equal(await openSnmp('127.0.0.1', [{ ...good, authKey: 'Falsches-Passwort' }], { port: PORT, timeout: 700 }), null);
  assert.equal(await openSnmp('127.0.0.1', [{ ...good, privKey: 'Falsches-Passwort' }], { port: PORT, timeout: 700 }), null);
});

test('a host silent to v3 is asked once, not with every user', async () => {
  forgetAccess();
  const users = [1, 2, 3, 4, 5].map((i) => ({ ...good, user: `u${i}` }));
  const t0 = Date.now();
  assert.equal(await openSnmp('127.0.0.1', users, { port: PORT + 1, timeout: 300 }), null);
  assert.ok(Date.now() - t0 < 2500, `${Date.now() - t0} ms`);
});

test('parseV3 drops what cannot work (short key, unknown procedure, no name)', () => {
  const v = parseV3(JSON.stringify([good, { ...good, user: 'kurz', authKey: '1234567' }, { ...good, user: 'x', privProtocol: 'rot13' }, { ...good, user: '' },
    { user: 'offen', level: 'noAuthNoPriv' }]));
  assert.deepEqual(v.map((u) => u.user), ['womn-read', 'offen']);
  assert.equal(v[1].authKey, null);
});

test('settings: saved encrypted, keys never to the browser, empty key keeps the stored one', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  const r = await call('PUT', '/api/settings/scan', { snmpV3: [{ user: 'womn-read', level: 'authPriv', authProtocol: 'sha256', authKey: 'Geheim-Auth-1', privProtocol: 'aes', privKey: 'Geheim-Priv-1' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.snmpV3, [{ user: 'womn-read', level: 'authPriv', authProtocol: 'sha256', privProtocol: 'aes', context: '' }]);
  const raw = db.prepare("SELECT value FROM settings WHERE key='scan.snmpV3'").get().value;
  assert.ok(!raw.includes('Geheim'), 'encrypted at rest');
  const all = JSON.stringify((await call('GET', '/api/settings')).data);
  assert.ok(!all.includes('Geheim'), 'not in the settings for the browser');
  // change the level of the procedure only: the keys stay
  await call('PUT', '/api/settings/scan', { snmpV3: [{ user: 'womn-read', level: 'authPriv', authProtocol: 'sha256', authKey: '', privProtocol: 'aes', privKey: '' }] });
  const creds = snmpCredentials({ get: (k) => app.ctx.settings.get(k) });
  assert.equal(creds.at(-1).authKey, 'Geheim-Auth-1');
  assert.equal(creds[0], 'public', 'communities first');
  // a new user needs its passwords; bad lengths and twins refused
  for (const [body, code] of [[{ user: 'neu', level: 'authNoPriv', authProtocol: 'sha', authKey: '' }, 'err.snmpV3AuthKey'],
    [{ user: 'neu', level: 'authNoPriv', authProtocol: 'sha', authKey: 'kurz' }, 'err.snmpV3KeyLength'],
    [{ user: 'neu', level: 'authNoPriv', authProtocol: 'crc32', authKey: 'lang-genug-1' }, 'err.snmpV3Proto'],
    [{ user: '', level: 'noAuthNoPriv' }, 'err.snmpV3User']]) {
    assert.equal((await call('PUT', '/api/settings/scan', { snmpV3: [body] })).data.error.code, code);
  }
  assert.equal((await call('PUT', '/api/settings/scan', { snmpV3: [{ user: 'a', level: 'noAuthNoPriv' }, { user: 'a', level: 'noAuthNoPriv' }] })).data.error.code, 'err.snmpV3Twice');
  // removing all users
  assert.deepEqual((await call('PUT', '/api/settings/scan', { snmpV3: [] })).data.snmpV3, []);
});

test('the test button: needs an address, answers without secrets; only administrators', async () => {
  assert.equal((await call('POST', '/api/settings/scan/snmp-test', { ip: 'kein-host' })).status, 400);
  const r = await call('POST', '/api/settings/scan/snmp-test', { ip: '127.0.0.1' });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.data).includes('Geheim'));
  assert.equal((await call('POST', '/api/users', { username: 'max', password: 'Sicher-Passwort-2', role: 'editor' })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'max', password: 'Sicher-Passwort-2' }, { who: 'editor' })).status, 200);
  assert.equal((await call('POST', '/api/settings/scan/snmp-test', { ip: '127.0.0.1' }, { who: 'editor' })).status, 403);
});
