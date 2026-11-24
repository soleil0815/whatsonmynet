// Audit 2026-11 (b), group "auth": location limits, two-factor sign-in, failover admin routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, memoryDb } from './helpers.js';
import { totpAt } from '../src/auth/totp.js';
import { createInventory } from '../src/inventory.js';

const app = await startApp();
const { call, db } = app;
test.after(() => app.close());
const code = (secret) => totpAt(secret, Math.floor(Date.now() / 30000));
const at = () => new Date().toISOString();
const ADMIN_PW = 'Sicher-Passwort-1';
let lA; let lB; let dA; let dB; let monA; let monB;

test('setup: admin, two locations, a location-limited editor', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'admin1', password: ADMIN_PW, code: 'setup-123' })).status, 200);
  lA = Number(db.prepare("INSERT INTO locations(name,created_at) VALUES('Site A',?)").run(at()).lastInsertRowid);
  lB = Number(db.prepare("INSERT INTO locations(name,created_at) VALUES('Site B',?)").run(at()).lastInsertRowid);
  dA = Number(db.prepare("INSERT INTO devices(name,type,ip,mac,location_id,created_at,updated_at) VALUES('PC-0001','computer','10.0.10.11','aa:aa:aa:00:00:01',?,?,?)").run(lA, at(), at()).lastInsertRowid);
  dB = Number(db.prepare("INSERT INTO devices(name,type,ip,mac,location_id,created_at,updated_at) VALUES('PC-0002','computer','10.0.10.12','aa:aa:aa:00:00:02',?,?,?)").run(lB, at(), at()).lastInsertRowid);
  assert.equal((await call('POST', '/api/users', { username: 'segeditor', password: 'Sicher-Passwort-3', role: 'editor', locations: [lA] })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'segeditor', password: 'Sicher-Passwort-3' }, { who: 'se' })).status, 200);
  monA = (await call('POST', '/api/monitors', { name: 'PC-0001 RDP', type: 'tcp', target: '10.0.10.11', port: 3389, device_id: dA })).data.id;
  monB = (await call('POST', '/api/monitors', { name: 'PC-0002 RDP', type: 'tcp', target: '10.0.10.12', port: 3389, device_id: dB })).data.id;
  assert.ok(monA && monB);
});

test('F1 scan link: a limited editor neither sees nor rewrites a device of another location', async () => {
  const scan = db.prepare("INSERT INTO scans(kind,status,targets,started_at,finished_at) VALUES('network','done',?,?,?)")
    .run(JSON.stringify([{ cidr: '10.0.10.0/24', locationId: lA }]), at(), at()).lastInsertRowid;
  const rid = db.prepare("INSERT INTO scan_results(scan_id,ip,mac,status,location_id) VALUES(?,?,?,'new',?)").run(scan, '10.0.10.12', 'bb:bb:bb:00:00:99', lA).lastInsertRowid;
  const g = await call('GET', `/api/scans/${scan}`, undefined, { who: 'se' });
  assert.equal(g.status, 200);
  assert.equal(g.data.results[0].maybe, null, `device of another location offered: ${JSON.stringify(g.data.results[0].maybe)}`);
  // the unlimited admin still gets the tip
  assert.equal((await call('GET', `/api/scans/${scan}`)).data.results[0].maybe?.id, dB);
  const l = await call('POST', `/api/scans/${scan}/link`, { ids: [rid] }, { who: 'se' });
  assert.equal(l.data.linked, 0);
  assert.equal(db.prepare('SELECT mac FROM devices WHERE id=?').get(dB).mac, 'aa:aa:aa:00:00:02');
});

test('F2 monitors: a limited editor cannot make a monitor location-less (device_id null, group, event)', async () => {
  const m = await call('POST', '/api/monitors', { name: 'PC-0001 events', type: 'event', device_id: dA, options: { source: 'any', maxSeverity: 7 } }, { who: 'se' });
  assert.equal(m.status, 201);
  const u = await call('PUT', `/api/monitors/${m.data.id}`, { type: 'event', device_id: null, options: { source: 'any', maxSeverity: 7 } }, { who: 'se' });
  assert.equal(u.status, 403);
  assert.equal(db.prepare('SELECT device_id FROM monitors WHERE id=?').get(m.data.id).device_id, dA);
  const gr = await call('POST', '/api/monitors', { name: 'grp', type: 'group', device_id: dA, options: { group: 'Site B', mode: 'any' } }, { who: 'se' });
  assert.equal(gr.status, 403);
  const toGroup = await call('PUT', `/api/monitors/${monA}`, { type: 'group', options: { group: 'Site B', mode: 'any' } }, { who: 'se' });
  assert.equal(toGroup.status, 403);
  assert.equal(db.prepare('SELECT device_id FROM monitors WHERE id=?').get(monA).device_id, dA);
  // still allowed: own device
  assert.equal((await call('PUT', `/api/monitors/${m.data.id}`, { name: 'PC-0001 messages' }, { who: 'se' })).status, 200);
});

test('F5 limited users: maintenance windows, switch port, parent/dependents and script hosts of other locations stay hidden', async () => {
  const w = await call('POST', '/api/maintenance', { name: 'Night B', kind: 'once', starts_at: new Date(Date.now() - 3600e3).toISOString(),
    ends_at: new Date(Date.now() + 3600e3).toISOString(), monitor_ids: [monB] });
  assert.equal(w.status, 201);
  const wAll = await call('POST', '/api/maintenance', { name: 'Both', kind: 'once', starts_at: new Date(Date.now() + 86400e3).toISOString(),
    ends_at: new Date(Date.now() + 90000e3).toISOString(), monitor_ids: [monA, monB] });
  const list = (await call('GET', '/api/maintenance', undefined, { who: 'se' })).data;
  assert.ok(!list.some((x) => x.id === w.data.id), 'window of another location listed');
  const both = list.find((x) => x.id === wAll.data.id);
  assert.deepEqual(both?.monitor_ids, [monA]);

  const sw = db.prepare("INSERT INTO devices(name,type,ip,location_id,created_at,updated_at) VALUES('SW-B','switch','10.0.10.2',?,?,?)").run(lB, at(), at()).lastInsertRowid;
  db.prepare("INSERT INTO switch_macs(switch_id,mac,if_index,port,seen_at) VALUES(?,'aa:aa:aa:00:00:01',3,'Gi0/3',?)").run(sw, at());
  assert.equal((await call('GET', `/api/devices/${dA}`)).data.plugged?.switchId, Number(sw));
  assert.equal((await call('GET', `/api/devices/${dA}`, undefined, { who: 'se' })).data.plugged, null);

  db.prepare('UPDATE monitors SET parent_id=? WHERE id=?').run(monB, monA);
  const d1 = (await call('GET', `/api/monitors/${monA}`, undefined, { who: 'se' })).data;
  assert.equal(d1.parent, null);
  db.prepare('UPDATE monitors SET parent_id=NULL WHERE id=?').run(monA);
  db.prepare('UPDATE monitors SET parent_id=? WHERE id=?').run(monA, monB);
  const d2 = (await call('GET', `/api/monitors/${monA}`, undefined, { who: 'se' })).data;
  assert.deepEqual(d2.dependents, []);
  assert.equal((await call('GET', `/api/monitors/${monA}`)).data.dependents.length, 1);
  db.prepare('UPDATE monitors SET parent_id=NULL WHERE id=?').run(monB);

  db.prepare("INSERT INTO host_reports(device_id,at,data) VALUES(?,?,'{}')").run(dB, at());
  db.prepare("INSERT INTO host_reports(device_id,at,data) VALUES(?,?,'{}')").run(dA, at());
  assert.deepEqual((await call('GET', '/api/hosts/devices', undefined, { who: 'se' })).data, [dA]);
  assert.equal((await call('GET', '/api/hosts/devices')).data.length, 2);
});

test('F6 dashboard: the last scan of another location is not shown to a limited user', async () => {
  const mdb = memoryDb();
  const inv = createInventory(mdb);
  const l1 = mdb.prepare("INSERT INTO locations(name,created_at) VALUES('Site A',?)").run(at()).lastInsertRowid;
  const l2 = mdb.prepare("INSERT INTO locations(name,created_at) VALUES('Site B',?)").run(at()).lastInsertRowid;
  mdb.prepare("INSERT INTO scans(kind,status,targets,started_at,user,stats) VALUES('network','done',?,?,'admin2','{}')").run(JSON.stringify([{ cidr: '10.0.10.0/24', locationId: l1 }]), at());
  mdb.prepare("INSERT INTO scans(kind,status,targets,started_at,user,stats) VALUES('network','done',?,?,'admin2','{}')").run(JSON.stringify([{ cidr: '192.0.2.0/24', locationId: l2 }]), at());
  const s = inv.stats({ allowed: new Set([Number(l1)]) });
  assert.equal(s.lastScan?.targets?.[0]?.cidr, '10.0.10.0/24', `other location's scan visible: ${JSON.stringify(s.lastScan?.targets)}`);
  assert.equal(s.locations, 1);
  assert.equal(inv.stats({ allowed: new Set([Number(l2) + 10]) }).lastScan, null);
  assert.equal(inv.stats().lastScan.targets[0].cidr, '192.0.2.0/24');
  assert.equal(inv.stats().locations, 2);
  // through the API
  db.prepare("INSERT INTO scans(kind,status,targets,started_at,user,stats) VALUES('network','done',?,?,'admin1','{}')").run(JSON.stringify([{ cidr: '203.0.113.0/24', locationId: lB }]), at());
  const dash = (await call('GET', '/api/dashboard', undefined, { who: 'se' })).data;
  assert.notEqual(dash.lastScan?.targets?.[0]?.cidr, '203.0.113.0/24');
  assert.equal(dash.locations, 1);
});

test('F7 search: the limit does not hide in-scope hits; monitor status says maintenance', async () => {
  const ins = db.prepare("INSERT INTO devices(name,type,ip,location_id,created_at,updated_at) VALUES(?,'computer',?,?,?,?)");
  db.transaction(() => { for (let i = 0; i < 420; i++) ins.run(`FINDME-${String(i).padStart(4, '0')}`, `10.0.11.${i % 250}`, lB, at(), at()); })();
  ins.run('FINDME-ZZZZ', '10.0.10.99', lA, at(), at());
  const s = (await call('GET', '/api/search?q=FINDME', undefined, { who: 'se' })).data;
  assert.deepEqual(s.devices.map((d) => d.name), ['FINDME-ZZZZ']);
  // monitor in a maintenance window, stored status down
  db.prepare("UPDATE monitors SET status='down' WHERE id=?").run(monB);
  const m = (await call('GET', '/api/search?q=PC-0002 RDP')).data.monitors.find((x) => x.id === monB);
  assert.equal((await call('GET', `/api/monitors/${monB}`)).data.status, 'maintenance');
  assert.equal(m?.status, 'maintenance');
});

test('F8 user flags: serverPages only for editors without a location limit; client guards use it', async () => {
  assert.equal((await call('GET', '/api/me', undefined, { who: 'se' })).data.serverPages, false);
  assert.equal((await call('GET', '/api/me', undefined, { who: 'se' })).data.canEdit, true);
  assert.equal((await call('GET', '/api/me')).data.serverPages, true);
  assert.equal((await call('GET', '/api/bootstrap', undefined, { who: 'se' })).data.user.serverPages, false);
  assert.equal((await call('GET', '/api/search?q=PC', undefined, { who: 'se' })).status, 200);
  for (const f of ['public/js/app.js', 'public/js/search.js', 'public/js/views/events.js', 'public/js/views/eventrules.js', 'public/js/views/settings.js', 'public/js/views/device.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/canEditServer \?\? (state\.user\.|u\.|user\.)?canEdit/.test(src), `${f} still guards server pages with canEditServer ?? canEdit`);
  }
});

test('F4 two-factor enrolment needs the password and signs out the other sessions', async () => {
  assert.equal((await call('POST', '/api/login', { username: 'admin1', password: ADMIN_PW }, { who: 'other' })).status, 200);
  const s = (await call('POST', '/api/me/2fa/setup')).data;
  const noPw = await call('POST', '/api/me/2fa/enable', { code: code(s.secret) });
  assert.equal(noPw.status, 400);
  assert.equal(noPw.data.error.code, 'err.passwordWrong');
  assert.equal(db.prepare('SELECT totp_enabled FROM users WHERE username=?').get('admin1').totp_enabled, 0);
  const ok = await call('POST', '/api/me/2fa/enable', { code: code(s.secret), password: ADMIN_PW });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.recoveryCodes.length, 10);
  assert.equal((await call('GET', '/api/me')).status, 200, 'own session kept');
  assert.equal((await call('GET', '/api/me', undefined, { who: 'other' })).status, 401, 'other session still valid');
});

test('F3 require2faAdmins also guards the failover admin routes (peer endpoints unaffected)', async () => {
  assert.equal((await call('PUT', '/api/settings/security', { require2faAdmins: true })).status, 200);
  assert.equal((await call('POST', '/api/users', { username: 'admin2', password: 'Sicher-Passwort-2', role: 'admin' })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'admin2', password: 'Sicher-Passwort-2' }, { who: 'a2' })).status, 200);
  assert.equal((await call('GET', '/api/users', undefined, { who: 'a2' })).status, 403);
  const fo = await call('GET', '/api/failover', undefined, { who: 'a2' });
  assert.equal(fo.status, 403);
  assert.equal(fo.data.error.code, 'err.totpRequiredByAdmin');
  const mk = await call('POST', '/api/failover/master', {}, { who: 'a2' });
  assert.equal(mk.status, 403);
  assert.equal((await call('GET', '/api/failover/banner', undefined, { who: 'a2' })).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, { who: 'a2' })).status, 200);
  // admin with 2FA: works
  assert.equal((await call('GET', '/api/failover')).status, 200);
  // peer endpoint without a session: not the 2FA answer
  const hello = await call('GET', '/api/failover/hello', undefined, { who: 'nobody' });
  assert.notEqual(hello.data?.error?.code, 'err.totpRequiredByAdmin');
});
