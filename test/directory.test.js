import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'ldapts';
import { memoryDb } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createDirectory, escapeFilter, plainName, roleFromGroups } from '../src/auth/directory.js';
import { createUsers } from '../src/auth/users.js';

test('filter escaping and names', () => {
  assert.equal(escapeFilter('a*b(c)\\d'), 'a\\2ab\\28c\\29\\5cd');
  assert.equal(plainName('FIRMA\\michael'), 'michael');
  assert.equal(plainName('michael@firma.local'), 'michael@firma.local');
});

test('role from groups: highest wins, DN compared loosely', () => {
  const cfg = { groupAdmin: 'CN=Admins,DC=x', groupEditor: 'CN=Edit, DC=x', groupViewer: 'CN=Read,DC=x' };
  assert.equal(roleFromGroups(['cn=edit,dc=x', 'CN=Read,DC=x'], cfg), 'editor');
  assert.equal(roleFromGroups(['cn=admins,dc=x'], cfg), 'admin');
  assert.equal(roleFromGroups(['CN=Other,DC=x'], cfg), null);
});

function fakeClient({ users, groups, extraGroups = [] }) {
  return () => {
    let bound = null;
    return {
      async startTLS() {},
      async bind(dn, pw) {
        if (dn === 'svc' && pw === 'svc-pw') { bound = dn; return; }
        const u = users.find((x) => x.dn === dn);
        if (!u || u.password !== pw) throw Object.assign(new Error('Invalid Credentials'), { code: 49 });
        bound = dn;
      },
      async search(base, { filter, scope }) {
        // RootDSE can be read without signing in (like AD)
        if (base === '' && scope === 'base') return { searchEntries: [{ defaultNamingContext: 'DC=firma,DC=local' }] };
        if (!bound) throw new Error('not bound');
        if (scope === 'base') return { searchEntries: groups.concat(extraGroups).some((g) => g.dn === base) ? [{ dn: base }] : [] };
        const cn = /\(cn=([^)]*)\)/.exec(filter);
        if (filter.includes('objectClass=group') && cn) {
          return { searchEntries: groups.concat(extraGroups).filter((g) => g.dn.toLowerCase().startsWith(`cn=${cn[1].toLowerCase()},`)).map((g) => ({ dn: g.dn })) };
        }
        if (filter.includes('1.2.840.113556.1.4.1941')) {
          const dn = /:=(.*)\)$/.exec(filter)[1].replace(/\\5c/g, '\\');
          return { searchEntries: groups.filter((g) => g.nested.includes(dn)).map((g) => ({ dn: g.dn })) };
        }
        if (filter.startsWith('(|(member=')) return { searchEntries: [] };
        const name = /sAMAccountName=([^)]*)\)/.exec(filter)?.[1];
        return { searchEntries: users.filter((u) => u.sam === name).map((u) => ({ dn: u.dn, sAMAccountName: u.sam, displayName: u.name, mail: u.mail, memberOf: u.memberOf, userAccountControl: u.uac || '512' })) };
      },
      async unbind() {},
    };
  };
}

function setup() {
  const db = memoryDb();
  const settings = createSettings(db);
  const users = [
    { dn: 'CN=Anna,OU=IT,DC=firma,DC=local', sam: 'anna', password: 'Anna-Passwort-1', name: 'Anna Admin', mail: 'anna@firma.local', memberOf: ['CN=IT,DC=firma,DC=local'] },
    { dn: 'CN=Bob,OU=IT,DC=firma,DC=local', sam: 'bob', password: 'Bob-Passwort-1', name: 'Bob', memberOf: ['CN=WOMN-Lesen,DC=firma,DC=local'] },
    { dn: 'CN=Carl,OU=IT,DC=firma,DC=local', sam: 'carl', password: 'Carl-Passwort-1', name: 'Carl', memberOf: [] },
    { dn: 'CN=Dora,OU=IT,DC=firma,DC=local', sam: 'dora', password: 'Dora-Passwort-1', name: 'Dora', memberOf: ['CN=WOMN-Admins,DC=firma,DC=local'], uac: '514' },
  ];
  // Anna is in WOMN-Admins only through the nested group IT
  const groups = [{ dn: 'CN=WOMN-Admins,DC=firma,DC=local', nested: ['CN=Anna,OU=IT,DC=firma,DC=local'] }];
  const extraGroups = [{ dn: 'CN=WOMN-Lesen,DC=firma,DC=local', nested: [] }];
  const dir = createDirectory(settings, { clientFactory: fakeClient({ users, groups, extraGroups }) });
  dir.save({ enabled: true, url: 'ldaps://dc01.firma.local', baseDn: 'DC=firma,DC=local', bindDn: 'svc', bindPassword: 'svc-pw',
    groupAdmin: 'CN=WOMN-Admins,DC=firma,DC=local', groupViewer: 'CN=WOMN-Lesen,DC=firma,DC=local' });
  return { db, settings, dir };
}

test('directory: nested group, direct group, no group, wrong password, disabled account', async () => {
  const { dir } = setup();
  const a = await dir.verify('FIRMA\\anna', 'Anna-Passwort-1');
  assert.equal(a.role, 'admin');
  assert.equal(a.email, 'anna@firma.local');
  assert.equal((await dir.verify('bob', 'Bob-Passwort-1')).role, 'viewer');
  assert.equal((await dir.verify('carl', 'Carl-Passwort-1')).role, null);
  await assert.rejects(dir.verify('anna', 'falsch'), { status: 401 });
  await assert.rejects(dir.verify('nobody', 'x'), { status: 401 });
  await assert.rejects(dir.verify('dora', 'Dora-Passwort-1'), { status: 401 });
  await assert.rejects(dir.verify('anna*', 'x'), { status: 401 }, 'wildcards are escaped');
});

test('directory settings: no plain LDAP, filter and CA checked, password kept', () => {
  const { dir, settings } = setup();
  assert.throws(() => dir.save({ enabled: true, url: 'ldap://dc01', baseDn: 'DC=x' }), { code: 'err.adPlain' });
  dir.save({ enabled: true, url: 'ldap://dc01:389', startTls: true, baseDn: 'DC=x' });
  assert.equal(settings.get('ad.bindPassword'), 'svc-pw', 'kept when not sent');
  assert.throws(() => dir.save({ enabled: true, url: 'ldaps://dc01', baseDn: 'DC=x', userFilter: '(uid=x)' }), { code: 'err.adFilter' });
  assert.throws(() => dir.save({ enabled: true, url: 'ldaps://dc01', baseDn: 'DC=x', ca: 'nope' }), { code: 'err.adCa' });
  assert.throws(() => dir.save({ enabled: true, url: 'http://dc01', baseDn: 'DC=x' }), { code: 'err.adUrl' });
});

test('directory accounts: created at sign-in, no local password, role follows AD', () => {
  const db = memoryDb();
  const users = createUsers(db);
  const u = users.upsertDirectory({ username: 'anna', display_name: 'Anna', email: 'a@x.de', role: 'admin', dn: 'CN=Anna' });
  assert.equal(u.source, 'ldap');
  assert.equal(users.authenticate('anna', ''), null);
  assert.throws(() => users.setPassword(u.id, 'Irgendwas-1234'), { code: 'err.adPassword' });
  users.update(u.id, { role: 'viewer', active: true });
  assert.equal(users.get(u.id).role, 'admin', 'role of an AD account is not changed here');
  assert.equal(users.upsertDirectory({ username: 'anna', role: 'editor', dn: 'CN=Anna' }).role, 'editor');
  users.update(u.id, { active: false });
  assert.equal(users.upsertDirectory({ username: 'anna', role: 'editor', dn: 'CN=Anna' }), null, 'locked here stays locked');
  users.create({ username: 'admin', password: 'Lokal-Passwort-1', role: 'admin' });
  assert.throws(() => users.upsertDirectory({ username: 'admin', role: 'viewer', dn: 'CN=Admin' }), { code: 'err.userExists' });
});

// Real LDAP server - only where the CI provides one (osixia/openldap, LDAPS with self-signed certificate)
const LDAP = process.env.WOMN_TEST_LDAP; // host:ldapsPort:adminPassword
test('real LDAPS server', { skip: !LDAP }, async () => {
  const [host, port, adminPw] = LDAP.split(':');
  const url = `ldaps://${host}:${port}`;
  const admin = new Client({ url, tlsOptions: { rejectUnauthorized: false } });
  await admin.bind('cn=admin,dc=example,dc=org', adminPw);
  const add = async (dn, attrs) => { try { await admin.add(dn, attrs); } catch (e) { if (e.code !== 68) throw e; } };
  await add('ou=people,dc=example,dc=org', { objectClass: ['organizationalUnit'], ou: 'people' });
  await add('uid=anna,ou=people,dc=example,dc=org', { objectClass: ['inetOrgPerson'], uid: 'anna', cn: 'Anna Admin', sn: 'Admin', mail: 'anna@example.org', userPassword: 'Anna-Passwort-1' });
  await add('cn=womn-admins,dc=example,dc=org', { objectClass: ['groupOfNames'], cn: 'womn-admins', member: ['uid=anna,ou=people,dc=example,dc=org'] });
  await admin.unbind();

  const db = memoryDb();
  const settings = createSettings(db);
  const dir = createDirectory(settings);
  dir.save({ enabled: true, url, verify: false, baseDn: 'dc=example,dc=org', bindDn: 'cn=admin,dc=example,dc=org', bindPassword: adminPw,
    userFilter: '(&(objectClass=inetOrgPerson)(uid={username}))', groupAdmin: 'cn=womn-admins,dc=example,dc=org', nested: false });
  const a = await dir.verify('anna', 'Anna-Passwort-1');
  assert.equal(a.role, 'admin');
  assert.equal(a.email, 'anna@example.org');
  await assert.rejects(dir.verify('anna', 'falsch'), { status: 401 });
  // With certificate check on, the self-signed certificate is refused
  dir.save({ ...dir.config(), trust: 'system', bindPassword: undefined });
  await assert.rejects(dir.verify('anna', 'Anna-Passwort-1'), { status: 502 });
  // The certificate can be fetched from the server (not trusted until confirmed)
  const fc = await dir.fetchCert({});
  assert.ok(fc.certs.length >= 1);
  assert.match(fc.certs[0].fingerprint256, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  assert.ok(fc.pem.includes('BEGIN CERTIFICATE'));
});

test('AD like Helfi.Space: server fields, group names, base DN from AD, test steps', async () => {
  const { dir, settings } = setup();
  // server fields → address; an ldaps:// address pasted into the field works too; plain LDAP is refused
  dir.save({ ...dir.config(), bindPassword: undefined, host: 'dc01.firma.local', security: 'starttls', port: '' });
  assert.equal(settings.get('ad.url'), 'ldap://dc01.firma.local:389');
  assert.equal(settings.get('ad.startTls'), true);
  dir.save({ ...dir.config(), bindPassword: undefined, host: 'ldaps://dc02.firma.local:3269', security: 'starttls' });
  assert.equal(settings.get('ad.url'), 'ldaps://dc02.firma.local:3269');
  assert.deepEqual([dir.config().host, dir.config().port, dir.config().security], ['dc02.firma.local', 3269, 'ldaps']);
  assert.throws(() => dir.save({ ...dir.config(), host: 'dc 01', security: 'ldaps' }), { code: 'err.adUrl' });
  assert.throws(() => dir.save({ enabled: true, url: 'ldap://dc01', baseDn: '' }), { code: 'err.adPlain' });

  // group names instead of DNs, base DN left empty → found in AD
  dir.save({ ...dir.config(), bindPassword: undefined, host: 'dc01.firma.local', security: 'ldaps', baseDn: '', groupAdmin: 'WOMN-Admins', groupViewer: 'womn-lesen', groupEditor: '' });
  assert.equal((await dir.verify('anna', 'Anna-Passwort-1')).role, 'admin', 'nested group found by its name');
  assert.equal((await dir.verify('bob', 'Bob-Passwort-1')).role, 'viewer', 'name compared without case');

  // test with unsaved values: every step
  const r = await dir.test({ host: 'dc01.firma.local', security: 'ldaps', baseDn: '', groupAdmin: 'WOMN-Admins', groupEditor: 'Gibt-es-nicht', groupViewer: '' }, 'anna', 'Anna-Passwort-1');
  const by = (k) => r.steps.filter((x) => x.key === k);
  assert.equal(by('connect')[0].ok, true);
  assert.equal(by('bind')[0].ok, true);
  assert.deepEqual([by('baseDn')[0].value, by('baseDn')[0].auto], ['DC=firma,DC=local', true]);
  assert.equal(r.baseDn, 'DC=firma,DC=local');
  assert.deepEqual(by('group').map((x) => [x.role, x.ok, x.dn]), [['admin', true, 'CN=WOMN-Admins,DC=firma,DC=local'], ['editor', false, null]]);
  assert.equal(by('role')[0].role, 'admin');
  assert.equal(by('password')[0].ok, true);
  assert.equal(r.ok, false, 'a missing group is not "all fine"');
  // wrong password and unknown user are named
  const w = await dir.test({ groupAdmin: 'WOMN-Admins' }, 'anna', 'falsch');
  assert.deepEqual(w.steps.filter((x) => x.key === 'password').map((x) => [x.ok, x.error]), [[false, 'credentials']]);
  const nobody = await dir.test({ groupAdmin: 'WOMN-Admins' }, 'nobody');
  assert.equal(nobody.steps.find((x) => x.key === 'user').error, 'userNotFound');
  // wrong service account password
  const bad = await dir.test({ bindPassword: 'falsch' });
  assert.deepEqual([bad.steps[1].key, bad.steps[1].ok, bad.steps[1].error], ['bind', false, 'credentials']);
});

test('trust setting: pinned, system, insecure', () => {
  const { dir, settings } = setup();
  dir.save({ ...dir.config(), bindPassword: undefined, trust: 'insecure' });
  assert.deepEqual([dir.config().trust, settings.get('ad.verify')], ['insecure', false]);
  dir.save({ ...dir.config(), bindPassword: undefined, trust: 'system' });
  assert.deepEqual([dir.config().trust, settings.get('ad.verify')], ['system', true]);
});
