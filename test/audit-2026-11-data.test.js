// Code audit 2026-11 (data): inventory matching, host reports, monitors following a device, scan agents, directory
// roles, ignore list scope, restore and maintenance windows during an outage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDb, tmp, startApp } from './helpers.js';
import { createInventory } from '../src/inventory.js';
import { createHosts } from '../src/hosts.js';
import { fillDevice } from '../src/devicefill.js';
import { createSnmpDevices } from '../src/snmpdevices.js';
import { createAgents } from '../src/agents.js';
import { createScanner } from '../src/scan/engine.js';
import { createSettings } from '../src/settings.js';
import { createUsers } from '../src/auth/users.js';
import { recheckDirectoryUsers } from '../src/auth/adrecheck.js';
import { openDatabase, verifyKey } from '../src/db.js';
import { applyPendingRestore, pendingPath } from '../src/backup.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';

const iso = () => new Date().toISOString();

function scanWith(db, rows, { startedAt = iso(), status = 'running', cidr = '192.168.1.0/24' } = {}) {
  const scanId = db.prepare("INSERT INTO scans(kind,status,targets,started_at,finished_at) VALUES('network',?,?,?,?)")
    .run(status, JSON.stringify([{ cidr }]), startedAt, status === 'done' ? startedAt : null).lastInsertRowid;
  const ids = rows.map((r) => db.prepare(`INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status)
    VALUES(?,?,?,?,?,?,?,?,'pending')`).run(scanId, r.ip, r.mac ?? null, r.hostname || '', r.vendor || '', r.type || 'server', 0.8,
    JSON.stringify({ ports: r.ports || [22], classification: { type: r.type || 'server', os: 'Linux' } })).lastInsertRowid);
  return { scanId, ids };
}

function addMonitor(db, deviceId, { name = 'm', type, target, port = null, secret = '' }) {
  const ts = iso();
  return db.prepare(`INSERT INTO monitors(name,type,target,port,device_id,secret,created_at,updated_at,status,status_since)
    VALUES(?,?,?,?,?,?,?,?,'up',?)`).run(name, type, target, port, deviceId, secret, ts, ts, ts).lastInsertRowid;
}
const monTarget = (db, id) => db.prepare('SELECT target FROM monitors WHERE id=?').get(id).target;

// ---------------------------------------------------------------------------------------------------- 1
test('shared host key: a report whose MACs match no device never lands on a device with another MAC by IP, and a name match changes no hardware', () => {
  const db = memoryDb();
  const hosts = createHosts({ db });
  const ts = iso();
  const add = (name, ip, mac, serial) => db.prepare(`INSERT INTO devices(name,type,ip,mac,hostname,serial,model,vendor,auto_fields,created_at,updated_at)
    VALUES(?,'computer',?,?,'',?,'OptiPlex 7090','Dell',?,?,?)`).run(name, ip, mac, serial, JSON.stringify({ serial, model: 'OptiPlex 7090', vendor: 'Dell' }), ts, ts).lastInsertRowid;
  const a = add('PC-0001', '10.0.10.11', 'aa:bb:cc:00:00:01', 'SN-A');
  const b = add('PC-0002', '10.0.10.12', 'aa:bb:cc:00:00:02', 'SN-B');
  const noMac = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('PC-0003','computer','10.0.10.13',?,?)").run(ts, ts).lastInsertRowid;
  const t = hosts.create({ name: 'All PCs', os: 'windows' }, { server: 'https://womn.firma.local' });
  const rep = (over) => ({ hostname: 'PC-0001', os: 'Windows 11', macs: ['aa:bb:cc:00:00:99'], ips: [], hw: { vendor: 'HP', model: 'EliteDesk', serial: 'SN-OTHER' }, ...over });
  // same name, other MAC (docked laptop reports only its cable MAC): PC-0001, but MAC, serial and model stay
  assert.equal(hosts.push(t.token, rep()).device, a);
  // reported IP of a device with another MAC: not that one either
  assert.throws(() => hosts.push(t.token, rep({ hostname: 'X1', ips: ['10.0.10.12'] })), { code: 'err.hostUnknown' });
  // the remote address only reaches devices without MAC
  assert.throws(() => hosts.push(t.token, rep({ hostname: 'X2', macs: [] }), '10.0.10.12'), { code: 'err.hostUnknown' });
  assert.equal(hosts.push(t.token, rep({ hostname: 'X3', macs: [], hw: {} }), '10.0.10.13').device, noMac);
  for (const id of [a, b]) {
    const d = db.prepare('SELECT mac, serial, model, vendor FROM devices WHERE id=?').get(id);
    assert.ok(d.mac, 'MAC kept');
    assert.notEqual(d.serial, 'SN-OTHER', 'serial kept');
    assert.deepEqual([d.model, d.vendor], ['OptiPlex 7090', 'Dell']);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_history WHERE kind='replaced'").get().n, 0);
});

test('shared host key: a match by name with another serial does not mark the device as replaced', () => {
  const db = memoryDb();
  const hosts = createHosts({ db });
  const ts = iso();
  const id = db.prepare(`INSERT INTO devices(name,type,ip,mac,serial,model,auto_fields,created_at,updated_at)
    VALUES('PC-0004','computer','10.0.10.14','aa:bb:cc:00:00:04','SN-D','OptiPlex',?,?,?)`).run(JSON.stringify({ serial: 'SN-D', model: 'OptiPlex' }), ts, ts).lastInsertRowid;
  const t = hosts.create({ name: 'All PCs', os: 'windows' }, { server: 'https://womn.firma.local' });
  // script without MAC list (older version): matched by name, but the serial differs
  assert.equal(hosts.push(t.token, { hostname: 'PC-0004', macs: [], hw: { serial: 'SN-OTHER', model: 'EliteDesk' } }).device, id);
  const d = db.prepare('SELECT mac, serial, model FROM devices WHERE id=?').get(id);
  assert.deepEqual([d.mac, d.serial, d.model], ['aa:bb:cc:00:00:04', 'SN-D', 'OptiPlex']);
});

// ---------------------------------------------------------------------------------------------------- 2
test('IP change: the web address only follows when its host is exactly the old IP', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const a = inv.create({ name: 'Router', ip: '192.168.1.1', mac: 'aa:bb:cc:00:01:01', web_url: 'https://192.168.1.10:8443/ui' });
  const b = inv.create({ name: 'AP', ip: '192.168.1.2', mac: 'aa:bb:cc:00:01:02', web_url: 'https://192.168.1.2:8443/ui' });
  const { ids } = scanWith(db, [{ ip: '192.168.1.77', mac: 'aa:bb:cc:00:01:01' }, { ip: '192.168.1.78', mac: 'aa:bb:cc:00:01:02' }]);
  ids.forEach((id) => inv.applyResult(id));
  assert.equal(inv.get(a.id).web_url, 'https://192.168.1.10:8443/ui');
  assert.equal(inv.get(b.id).web_url, 'https://192.168.1.78:8443/ui');
});

// ---------------------------------------------------------------------------------------------------- 3
test('monitors of every address type follow the device to a new IP (scan and manual edit); stored passwords stay bound', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'NAS', type: 'nas', ip: '10.0.10.20', mac: 'aa:bb:cc:00:02:01' });
  const snmp = addMonitor(db, d.id, { type: 'snmp', target: '10.0.10.20', port: 161 });
  const smb = addMonitor(db, d.id, { type: 'smb', target: '10.0.10.20', port: 445 });
  const redis = addMonitor(db, d.id, { type: 'redis', target: '10.0.10.20', port: 6379 });
  const ping = addMonitor(db, d.id, { type: 'ping', target: '10.0.10.20' });
  const http = addMonitor(db, d.id, { type: 'http', target: 'https://10.0.10.20:5001/' });
  const other = addMonitor(db, d.id, { type: 'ping', target: '10.0.10.200' });
  const otherHttp = addMonitor(db, d.id, { type: 'http', target: 'https://10.0.10.200/' });
  const withPw = addMonitor(db, d.id, { type: 'mysql', target: '10.0.10.20', port: 3306, secret: '{"x":1}' });
  const { ids } = scanWith(db, [{ ip: '10.0.10.21', mac: 'aa:bb:cc:00:02:01' }], { cidr: '10.0.10.0/24' });
  inv.applyResult(ids[0]);
  for (const id of [snmp, smb, redis, ping]) assert.equal(monTarget(db, id), '10.0.10.21', `monitor ${id}`);
  assert.equal(monTarget(db, http), 'https://10.0.10.21:5001/');
  assert.equal(monTarget(db, other), '10.0.10.200');
  assert.equal(monTarget(db, otherHttp), 'https://10.0.10.200/');
  // a stored password is never sent to another address without being typed in again
  assert.equal(monTarget(db, withPw), '10.0.10.20');
  // manual edit of the address
  inv.update(d.id, { ip: '10.0.10.22' }, 'admin');
  for (const id of [snmp, smb, redis, ping]) assert.equal(monTarget(db, id), '10.0.10.22', `monitor ${id} after edit`);
  assert.equal(monTarget(db, http), 'https://10.0.10.22:5001/');
  assert.equal(monTarget(db, withPw), '10.0.10.20');
});

// ---------------------------------------------------------------------------------------------------- 4
test('adopting MAC-less results twice (two scans, or twice in one call) creates one device', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const s1 = scanWith(db, [{ ip: '192.168.1.50' }]);
  const s2 = scanWith(db, [{ ip: '192.168.1.50' }]);
  const s3 = scanWith(db, [{ ip: '192.168.1.50' }]);
  for (const id of [...s1.ids, ...s2.ids, ...s3.ids]) inv.applyResult(id);
  assert.equal(inv.adopt([s1.ids[0], s2.ids[0]]).length, 1);
  assert.equal(inv.adopt([s3.ids[0]]).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM devices WHERE ip='192.168.1.50'").get().n, 1);
});

// ---------------------------------------------------------------------------------------------------- 5
test('adopting from an older scan does not mark the device as online', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  const s1 = scanWith(db, [{ ip: '192.168.1.60', mac: 'aa:bb:cc:00:03:01' }], { startedAt: old, status: 'done' });
  inv.applyResult(s1.ids[0]); inv.finishScan(s1.scanId);
  // newer finished scan of the same subnet without that device: the old result can no longer be adopted at all
  // (adopt only from the newest scan of a subnet, suggestions 2026-11)
  const s2 = scanWith(db, [], { startedAt: new Date(Date.now() - 3600000).toISOString(), status: 'done' });
  assert.throws(() => inv.adopt(s1.ids), { code: 'err.scanOutdated' });
  // still running, the newer scan does not count yet: adopted, the device carries the time of its own scan, not "now"
  db.prepare("UPDATE scans SET status='running', finished_at=NULL WHERE id=?").run(s2.scanId);
  const [id] = inv.adopt(s1.ids);
  const d = inv.get(id);
  assert.equal(d.last_seen, old);
  assert.equal(d.first_seen, old);
});

// ---------------------------------------------------------------------------------------------------- 6
test('ignoring a stale result never puts an inventory device on the ignore list', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const s = scanWith(db, [{ ip: '192.168.1.70', mac: 'aa:bb:cc:00:04:01' }, { ip: '192.168.1.71' }]);
  s.ids.forEach((id) => inv.applyResult(id)); inv.finishScan(s.scanId);
  inv.create({ name: 'Printer', ip: '192.168.1.72', mac: 'aa:bb:cc:00:04:01' });
  inv.create({ name: 'Camera', ip: '192.168.1.71' });
  assert.equal(inv.ignore(s.ids), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ignored').get().n, 0);
});

// ---------------------------------------------------------------------------------------------------- 7
test('renaming a device only replaces its name at the start of monitor names', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'NAS', ip: '10.0.10.30' });
  const names = ['NAS', 'NAS: Web', 'NAS - Sensor', 'NAS Web', 'SNAS Web', 'NASA', 'Web NAS'];
  const ids = names.map((name) => addMonitor(db, d.id, { name, type: 'ping', target: '10.0.10.30' }));
  inv.update(d.id, { name: 'Synology' });
  assert.deepEqual(ids.map((id) => db.prepare('SELECT name FROM monitors WHERE id=?').get(id).name),
    ['Synology', 'Synology: Web', 'Synology - Sensor', 'Synology Web', 'SNAS Web', 'NASA', 'Web NAS']);
});

// ---------------------------------------------------------------------------------------------------- 8
test('changing the type away from NAS/switch removes its stale SNMP problems and MAC table', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const settings = createSettings(db);
  const snmp = createSnmpDevices({ db, settings, channels: { notifyIds: async () => [] } });
  const d = inv.create({ name: 'NAS', type: 'nas', ip: '10.0.10.40' });
  const ts = iso();
  db.prepare("INSERT INTO snmp_status(device_id,kind,at,ok,data,alerts) VALUES(?,'nas',?,1,'{}',?)").run(d.id, ts, JSON.stringify({ 'vol:1': { key: 'vol:1', kind: 'volume' } }));
  db.prepare("INSERT INTO switch_macs(switch_id,mac,if_index,port,vlan,seen_at) VALUES(?,'aa:bb:cc:00:05:01',1,'1',0,?)").run(d.id, ts);
  assert.equal(snmp.problems().length, 1);
  inv.update(d.id, { type: 'server' });
  assert.equal(snmp.problems().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM switch_macs WHERE switch_id=?').get(d.id).n, 0);
});

// ---------------------------------------------------------------------------------------------------- 9 + 10
function agentSetup() {
  const db = memoryDb();
  const settings = createSettings(db);
  const inventory = createInventory(db);
  const scanner = createScanner({ db, settings, inventory });
  const agents = createAgents({ db, settings, inventory, scanner });
  const loc = db.prepare("INSERT INTO locations(name,created_at) VALUES('Branch',?)").run(iso()).lastInsertRowid;
  db.prepare("INSERT INTO subnets(location_id,cidr,created_at) VALUES(?,'10.0.10.0/24',?)").run(loc, iso());
  const agent = db.prepare("INSERT INTO agents(name,location_id,token_hash,created_at) VALUES('North',?,'x',?) RETURNING *").get(loc, iso());
  return { db, settings, agents, agent };
}

test('scans reported by an agent are pruned like local ones', () => {
  const { db, settings, agents, agent } = agentSetup();
  settings.set('scan.keepScans', 3);
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO scans(kind,status,targets,started_at) VALUES('network','done','[]',?)").run(iso());
  agents.report(agent, { kind: 'network', results: [] });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scans WHERE kind='network'").get().n, 3);
});

test('an agent cannot date its scan into the future', () => {
  const { db, agents, agent } = agentSetup();
  const before = Date.now();
  const r = agents.report(agent, { kind: 'network', startedAt: '2099-01-01T00:00:00Z', results: [] });
  const s = db.prepare('SELECT started_at, finished_at FROM scans WHERE id=?').get(r.scanId);
  assert.ok(Date.parse(s.started_at) <= Date.now() && Date.parse(s.started_at) >= before - 1000, s.started_at);
  assert.ok(s.started_at <= s.finished_at);
});

// ---------------------------------------------------------------------------------------------------- 11
test('Redfish does not turn a hypervisor (or another specific type) into a plain server', () => {
  const db = memoryDb();
  const ts = iso();
  const add = (type) => db.prepare('INSERT INTO devices(name,type,auto_fields,created_at,updated_at) VALUES(?,?,?,?,?)').run(`d-${type}`, type, JSON.stringify({ type }), ts, ts).lastInsertRowid;
  const hv = add('hypervisor');
  const unk = add('unknown');
  fillDevice(db, hv, { type: 'server', serial: 'SRV-1' }, 'redfish');
  fillDevice(db, unk, { type: 'server', serial: 'SRV-2' }, 'redfish');
  assert.equal(db.prepare('SELECT type FROM devices WHERE id=?').get(hv).type, 'hypervisor');
  assert.equal(db.prepare('SELECT type FROM devices WHERE id=?').get(unk).type, 'server');
});

// ---------------------------------------------------------------------------------------------------- 12
test('a directory sign-in or recheck never demotes the last active admin', async () => {
  const db = memoryDb();
  const users = createUsers(db);
  const ts = iso();
  const id = db.prepare("INSERT INTO users(username,password_hash,role,source,created_at) VALUES('ad-admin','','admin','ldap',?)").run(ts).lastInsertRowid;
  db.prepare("INSERT INTO users(username,password_hash,role,active,created_at) VALUES('old-admin','x','admin',0,?)").run(ts);
  users.upsertDirectory({ username: 'ad-admin', role: 'viewer', dn: 'CN=ad-admin' });
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(id).role, 'admin');
  db.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)').run('s-ad', id, Date.now(), Date.now(), Date.now() + 3600000);
  await recheckDirectoryUsers({ db, users, directory: { enabled: () => true, verify: async (n) => ({ username: n, role: 'viewer', dn: 'CN=ad-admin' }) } });
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(id).role, 'admin');
  // with a second active admin the role from AD applies
  db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('local-admin','x','admin',?)").run(ts);
  users.upsertDirectory({ username: 'ad-admin', role: 'viewer', dn: 'CN=ad-admin' });
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(id).role, 'viewer');
});

// ---------------------------------------------------------------------------------------------------- 13
test('GET /api/ignored respects the location limit of the user', async () => {
  const app = await startApp({ setupToken: 'ign-setup' });
  const { call, db } = app;
  try {
    await call('POST', '/api/setup', { code: 'ign-setup', username: 'admin', password: 'Admin-Passwort-1' });
    const la = (await call('POST', '/api/locations', { name: 'A', subnets: ['10.0.10.0/24'] })).data;
    await call('POST', '/api/locations', { name: 'B', subnets: ['192.0.2.0/24'] });
    db.prepare("INSERT INTO ignored(mac,ip,label,created_at) VALUES('aa:bb:cc:00:06:01','10.0.10.9','a',?)").run(iso());
    db.prepare("INSERT INTO ignored(mac,ip,label,created_at) VALUES('aa:bb:cc:00:06:02','192.0.2.9','b',?)").run(iso());
    await call('POST', '/api/users', { username: 'seg', password: 'Standort-A-1234', role: 'editor', locations: [la.id] });
    assert.equal((await call('POST', '/api/login', { username: 'seg', password: 'Standort-A-1234' }, { who: 'seg' })).status, 200);
    const r = await call('GET', '/api/ignored', undefined, { who: 'seg' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.map((x) => x.ip), ['10.0.10.9']);
    assert.equal((await call('GET', '/api/ignored')).data.length, 2);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------- 14
test('a restored backup brings back no sessions', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'restore-sessions-'));
  const file = path.join(dir, 'whatsonmynet.sqlite');
  const cur = openDatabase(file); verifyKey(cur); cur.close();
  const old = openDatabase(pendingPath(file));
  verifyKey(old);
  const uid = old.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('admin','x','admin',?)").run(iso()).lastInsertRowid;
  old.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)').run('revoked', uid, Date.now(), Date.now(), Date.now() + 86400000);
  old.close();
  assert.equal(applyPendingRestore(file, path.join(dir, 'backups')), true);
  const db = openDatabase(file);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------------- 15
test('an outage that runs through a maintenance window: no second alarm, all clear with the full downtime', async () => {
  const db = memoryDb();
  const sent = [];
  const channels = { notify: async (_m, ev) => { sent.push(ev); return ['Mail']; }, notifyIds: async () => [] };
  const maintenance = createMaintenance(db);
  const clock = { t: new Date('2026-11-12T10:00:00Z') };
  const tick = (s) => { clock.t = new Date(clock.t.getTime() + s * 1000); };
  const mon = createMonitoring({ db, channels, maintenance, now: () => clock.t });
  const m = await mon.create({ name: 'PC-0001', type: 'tcp', target: '10.0.10.50', port: 3389, fail_threshold: 2 });
  await mon.record(m, { ok: true, ms: 2, message: 'open' });
  tick(60); await mon.record(m, { ok: false, message: 'timeout' });
  tick(60); await mon.record(m, { ok: false, message: 'timeout' }); // 10:02 down
  assert.equal(mon.get(m.id).status, 'down');
  assert.equal(sent.length, 1);
  maintenance.create({ name: 'Patch', kind: 'once', starts_at: '2026-11-12T10:05:00Z', ends_at: '2026-11-12T10:35:00Z', monitor_ids: [m.id] });
  tick(240); await mon.record(m, { ok: false, message: 'timeout' }); // 10:06
  assert.equal(mon.get(m.id).status, 'maintenance');
  tick(1800); await mon.record(m, { ok: false, message: 'timeout' }); // 10:36, after the window
  assert.equal(mon.get(m.id).status, 'down');
  tick(60); await mon.record(m, { ok: false, message: 'timeout' });
  assert.equal(sent.filter((e) => e.kind === 'down').length, 1, 'no second alarm for the same outage');
  tick(60); await mon.record(m, { ok: true, ms: 2, message: 'open' }); // 10:38
  const up = sent.find((e) => e.kind === 'up');
  assert.ok(up, 'all clear sent');
  assert.equal(up.downtimeMin, 36);
});

test('a device that recovered during the maintenance window and fails again afterwards raises a new alarm', async () => {
  const db = memoryDb();
  const sent = [];
  const channels = { notify: async (_m, ev) => { sent.push(ev); return ['Mail']; }, notifyIds: async () => [] };
  const maintenance = createMaintenance(db);
  const clock = { t: new Date('2026-11-12T10:00:00Z') };
  const tick = (s) => { clock.t = new Date(clock.t.getTime() + s * 1000); };
  const mon = createMonitoring({ db, channels, maintenance, now: () => clock.t });
  const m = await mon.create({ name: 'PC-0001', type: 'tcp', target: '10.0.10.50', port: 3389, fail_threshold: 2 });
  await mon.record(m, { ok: true, ms: 2, message: 'open' });
  tick(60); await mon.record(m, { ok: false, message: 'timeout' });
  tick(60); await mon.record(m, { ok: false, message: 'timeout' }); // 10:02 down, alarm
  maintenance.create({ name: 'Patch', kind: 'once', starts_at: '2026-11-12T10:05:00Z', ends_at: '2026-11-12T10:35:00Z', monitor_ids: [m.id] });
  tick(240); await mon.record(m, { ok: false, message: 'timeout' }); // 10:06
  tick(600); await mon.record(m, { ok: true, ms: 2, message: 'open' }); // 10:16 recovered inside the window
  tick(1200); await mon.record(m, { ok: false, message: 'timeout' }); // 10:36 a new outage
  assert.notEqual(mon.get(m.id).status, 'down', 'a single failure after a recovery waits for the threshold');
  tick(60); await mon.record(m, { ok: false, message: 'timeout' });
  assert.equal(mon.get(m.id).status, 'down');
  assert.equal(sent.filter((e) => e.kind === 'down').length, 2, 'the new outage is alarmed');
});
