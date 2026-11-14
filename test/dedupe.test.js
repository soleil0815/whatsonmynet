// Nothing twice: a monitor or sensor for what is watched already is refused (several services of one server stay
// possible), old duplicates are merged once; the scan shows devices that are probably in the inventory already as a
// tip (and skips them when adopting), duplicates in the inventory can be merged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { createInventory } from '../src/inventory.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';
import { createSettings } from '../src/settings.js';
import { mergeDuplicates, mergeDuplicatesOnce, fingerprint, hostIndex } from '../src/monitor/dedupe.js';

const setup = () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const mon = createMonitoring({ db, channels: { notify: async () => [] }, maintenance: createMaintenance(db) });
  return { db, inv, mon };
};
const refused = async (p) => { try { await p; } catch (e) { return e.code; } return 'accepted'; };

function scanWith(db, rows) {
  const scanId = db.prepare("INSERT INTO scans(kind,status,targets,started_at) VALUES('network','running','[{\"cidr\":\"192.168.0.0/24\"}]',?)").run(new Date().toISOString()).lastInsertRowid;
  const ids = rows.map((r) => db.prepare(`INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status)
    VALUES(?,?,?,?,?,?,?,?,'pending')`).run(scanId, r.ip, r.mac ?? null, r.hostname || '', '', r.type || 'nas', 0.8, JSON.stringify({ ports: [5001] })).lastInsertRowid);
  return { scanId, ids };
}

test('the same thing is watched once - several services of one server are fine', async () => {
  const { inv, mon } = setup();
  const nas = inv.create({ name: 'Synology', type: 'nas', ip: '192.168.0.253', mac: '00:11:32:aa:bb:cc', hostname: 'ihomeddserver.fritz.box' }, 'michael');
  const web = await mon.create({ name: 'DSM', type: 'http', target: 'https://192.168.0.253:5001/', device_id: nas.id });
  // the same address written differently, or by host name instead of IP: the same thing
  assert.equal(await refused(mon.create({ name: 'DSM 2', type: 'http', target: 'https://192.168.0.253:5001' })), 'err.monitorExists');
  assert.equal(await refused(mon.create({ name: 'DSM 3', type: 'http', target: 'https://ihomeddserver.fritz.box:5001/' })), 'err.monitorExists');
  // other services of the same server: fine
  assert.notEqual(await refused(mon.create({ name: 'Nextcloud', type: 'http', target: 'https://192.168.0.253:5001/nextcloud/' })), 'err.monitorExists');
  assert.notEqual(await refused(mon.create({ name: 'SSH', type: 'tcp', target: '192.168.0.253', port: 22 })), 'err.monitorExists');
  assert.notEqual(await refused(mon.create({ name: 'DSM keyword', type: 'http', target: 'https://192.168.0.253:5001/', http_keyword: 'Synology' })), 'err.monitorExists');
  assert.equal(await refused(mon.create({ name: 'SSH by name', type: 'tcp', target: 'ihomeddserver', port: 22 })), 'err.monitorExists');
  // sensors: the same value of the same device once
  const s = await mon.create({ name: 'Temp', type: 'sensor', device_id: nas.id, options: { metric: 'temp', op: 'ge', threshold: 55 } });
  assert.equal(await refused(mon.create({ name: 'Temp again', type: 'sensor', device_id: nas.id, options: { metric: 'temp', op: 'ge', threshold: 60 } })), 'err.monitorExists');
  assert.notEqual(await refused(mon.create({ name: 'Vol1', type: 'sensor', device_id: nas.id, options: { metric: 'volume', key: '/volume1', op: 'ge', threshold: 90 } })), 'err.monitorExists');
  // changing one into another that exists: refused too; changing itself: fine
  const vol = await mon.create({ name: 'Vol2', type: 'sensor', device_id: nas.id, options: { metric: 'volume', key: '/volume2', op: 'ge', threshold: 90 } });
  assert.equal(await refused(mon.update(vol.id, { options: { metric: 'volume', key: '/volume1' } })), 'err.monitorExists');
  assert.equal((await mon.update(s.id, { options: { metric: 'temp', op: 'ge', threshold: 58 } })).id, s.id);
  assert.equal((await mon.update(web.id, { name: 'DSM web' })).name, 'DSM web');
});

test('duplicates from before are merged once: the one that runs stays and takes over dependencies and windows', async () => {
  const { db, mon } = setup();
  const sw = await mon.create({ name: 'Switch', type: 'tcp', target: '10.0.0.2', port: 22 });
  const insert = (name, enabled) => Number(db.prepare(`INSERT INTO monitors(name,type,target,port,enabled,created_at,updated_at,status) VALUES(?,?,?,?,?,'x','x','pending')`)
    .run(name, 'tcp', '10.0.0.5', 443, enabled ? 1 : 0).lastInsertRowid);
  const old = insert('Web old (paused)', false);
  const live = insert('Web', true);
  const third = insert('Web copy', true);
  db.prepare('UPDATE monitors SET parent_id=? WHERE id=?').run(third, sw.id);
  db.prepare("INSERT INTO maintenance(name,kind,monitor_ids,created_at) VALUES('Nacht','weekly',?, 'x')").run(JSON.stringify([old, third]));
  const settings = createSettings(db);
  const out = mergeDuplicatesOnce(db, settings);
  assert.equal(out.length, 1);
  assert.equal(out[0].kept, live);
  assert.deepEqual(out[0].removed.sort(), [old, third].sort());
  assert.equal(db.prepare('SELECT parent_id FROM monitors WHERE id=?').get(sw.id).parent_id, live);
  assert.deepEqual(JSON.parse(db.prepare('SELECT monitor_ids FROM maintenance').get().monitor_ids), [live]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE action='monitor.dedupe'").get().n, 1);
  // once: a later duplicate (only possible by hand in the database) is left to the user
  insert('Web again', true);
  assert.deepEqual(mergeDuplicatesOnce(db, settings), []);
  assert.equal(mergeDuplicates(db).length, 1);
});

test('fingerprints: host name and IP of one inventory device are the same host', () => {
  const { db, inv } = setup();
  inv.create({ name: 'pve2', ip: '10.0.0.12', hostname: 'pve2.firma.local' }, 'x');
  const idx = hostIndex(db);
  const fp = (target) => fingerprint({ type: 'ping', target }, idx);
  assert.equal(fp('10.0.0.12'), fp('PVE2.firma.local'));
  assert.equal(fp('10.0.0.12'), fp('pve2'));
  assert.notEqual(fp('10.0.0.12'), fp('10.0.0.13'));
});

test('scan: a device probably in the inventory is a tip, skipped when adopting unless asked for', () => {
  const { db, inv } = setup();
  const nas = inv.create({ name: 'Synology', type: 'nas', ip: '192.168.0.253', mac: '00:11:32:aa:bb:cc', hostname: 'ihomeddserver.fritz.box' }, 'michael');
  const vm = inv.create({ name: 'Docker-VM', type: 'vm', ip: '192.168.0.30', mac: 'bc:24:11:00:00:30' }, 'michael');
  const { scanId, ids } = scanWith(db, [
    { ip: '192.168.0.254', mac: '00:11:32:aa:bb:cd', hostname: 'ihomeddserver.fritz.box' }, // second card of the NAS
    { ip: '192.168.0.30', mac: 'bc:24:11:00:00:99', type: 'vm' }, // the VM with a new MAC
    { ip: '192.168.0.40', mac: 'aa:aa:aa:00:00:40', hostname: 'drucker-neu' }, // really new
    { ip: '192.168.0.41', mac: 'aa:aa:aa:00:00:41', hostname: 'localhost' }, // a name that says nothing
  ]);
  ids.forEach((id) => inv.applyResult(id));
  inv.finishScan(scanId);
  const row = (id) => db.prepare('SELECT * FROM scan_results WHERE id=?').get(id);
  assert.deepEqual(inv.likelyExisting(row(ids[0])), { id: nas.id, name: 'Synology', why: 'hostname' });
  assert.deepEqual(inv.likelyExisting(row(ids[1])), { id: vm.id, name: 'Docker-VM', why: 'ip' });
  assert.equal(inv.likelyExisting(row(ids[2])), null);
  assert.equal(inv.likelyExisting(row(ids[3])), null);
  const skipped = [];
  const created = inv.adopt(ids, {}, 'michael', skipped);
  assert.equal(created.length, 2);
  assert.deepEqual(skipped.map((x) => x.device.why), ['hostname', 'ip']);
  // "add as new anyway"
  assert.equal(inv.adopt([ids[0]], { [ids[0]]: { force: true } }, 'michael').length, 1);
});

test('scan: "assign to this device" - a new MAC is taken over, a second card goes on the ignore list', () => {
  const { db, inv } = setup();
  const nas = inv.create({ name: 'Synology', type: 'nas', ip: '192.168.0.253', mac: '00:11:32:aa:bb:cc', hostname: 'ihomeddserver' }, 'michael');
  const vm = inv.create({ name: 'Docker-VM', type: 'vm', ip: '192.168.0.30', mac: 'bc:24:11:00:00:30' }, 'michael');
  const { scanId, ids } = scanWith(db, [
    { ip: '192.168.0.254', mac: '00:11:32:aa:bb:cd', hostname: 'ihomeddserver' },
    { ip: '192.168.0.30', mac: 'bc:24:11:00:00:99', type: 'vm' },
  ]);
  ids.forEach((id) => inv.applyResult(id));
  inv.finishScan(scanId);
  assert.equal(inv.linkResults(ids, 'michael'), 2);
  assert.equal(inv.get(vm.id).mac, 'bc:24:11:00:00:99');
  assert.equal(inv.get(nas.id).mac, '00:11:32:aa:bb:cc', 'the NAS keeps its own MAC');
  assert.match(db.prepare("SELECT label FROM ignored WHERE mac='00:11:32:aa:bb:cd'").get().label, /→ Synology/);
  assert.deepEqual(db.prepare('SELECT handled, status, device_id FROM scan_results WHERE id=?').get(ids[0]), { handled: 'linked', status: 'known', device_id: nas.id });
  // the next scan: the second card is ignored, the VM is known
  const next = scanWith(db, [{ ip: '192.168.0.254', mac: '00:11:32:aa:bb:cd', hostname: 'ihomeddserver' }, { ip: '192.168.0.30', mac: 'bc:24:11:00:00:99', type: 'vm' }]);
  next.ids.forEach((id) => inv.applyResult(id));
  inv.finishScan(next.scanId);
  assert.deepEqual(next.ids.map((id) => row(db, id).status), ['ignored', 'known']);
});
const row = (db, id) => db.prepare('SELECT * FROM scan_results WHERE id=?').get(id);

test('inventory: one device twice is a tip, merging makes one of it (monitors, sensors, history, ignore list)', async () => {
  const { db, inv, mon } = setup();
  const a = inv.create({ name: 'NAS LAN1', type: 'nas', ip: '192.168.0.253', mac: '00:11:32:aa:bb:cc', hostname: 'ihomeddserver' }, 'michael');
  const b = inv.create({ name: 'NAS LAN2', type: 'nas', ip: '192.168.0.254', mac: '00:11:32:aa:bb:cd', hostname: 'ihomeddserver.fritz.box', serial: 'XYZ123' }, 'michael');
  inv.create({ name: 'Other', ip: '192.168.0.9', hostname: 'other' }, 'michael');
  assert.deepEqual(inv.duplicates().map((p) => [p.keep.id, p.drop.id]), [[a.id, b.id]]);
  await mon.create({ name: 'Temp A', type: 'sensor', device_id: a.id, options: { metric: 'temp', op: 'ge', threshold: 55 } });
  await mon.create({ name: 'Temp B', type: 'sensor', device_id: b.id, options: { metric: 'temp', op: 'ge', threshold: 55 } });
  await mon.create({ name: 'Ping B', type: 'tcp', target: '192.168.0.254', port: 5001, device_id: b.id });
  inv.merge(a.id, b.id, 'michael');
  assert.equal(inv.get(b.id), null);
  assert.equal(inv.get(a.id).serial, 'XYZ123', 'empty fields are filled');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM monitors WHERE device_id=?').get(a.id).n, 3);
  const merged = mergeDuplicates(db);
  assert.equal(merged.length, 1, 'the two temperature sensors are one now');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM monitors WHERE device_id=?').get(a.id).n, 2);
  assert.match(db.prepare("SELECT label FROM ignored WHERE mac='00:11:32:aa:bb:cd'").get().label, /→ NAS LAN1/);
  assert.equal(inv.historyOf(a.id)[0].kind, 'merged');
  assert.deepEqual(inv.duplicates(), []);
});

test('API: tip in the scan result, skipped when adopting, assign, merge - editors only', async () => {
  const { startApp } = await import('./helpers.js');
  const app = await startApp();
  try {
    const { call, ctx, db } = app;
    assert.equal((await call('POST', '/api/setup', { username: 'michael', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
    ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'viewer' });
    await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'viewer' });
    const nas = ctx.inventory.create({ name: 'Synology', type: 'nas', ip: '192.168.0.253', mac: '00:11:32:aa:bb:cc', hostname: 'ihomeddserver' }, 'michael');
    const { scanId, ids } = scanWith(db, [{ ip: '192.168.0.254', mac: '00:11:32:aa:bb:cd', hostname: 'ihomeddserver' }]);
    ids.forEach((id) => ctx.inventory.applyResult(id));
    ctx.inventory.finishScan(scanId);
    db.prepare("UPDATE scans SET status='done' WHERE id=?").run(scanId);
    const res = (await call('GET', `/api/scans/${scanId}`)).data.results[0];
    assert.deepEqual(res.maybe, { id: nas.id, name: 'Synology', why: 'hostname' });
    const ad = (await call('POST', `/api/scans/${scanId}/adopt`, { ids })).data;
    assert.deepEqual([ad.created.length, ad.skipped.length], [0, 1]);
    assert.equal((await call('POST', `/api/scans/${scanId}/link`, { ids }, { who: 'viewer' })).status, 403);
    assert.equal((await call('POST', `/api/scans/${scanId}/link`, { ids })).data.linked, 1);
    // two entries of one device in the inventory
    const b = ctx.inventory.create({ name: 'NAS 2', type: 'nas', ip: '192.168.0.252', mac: '00:11:32:aa:bb:ce', hostname: 'ihomeddserver.fritz.box' }, 'michael');
    assert.equal((await call('GET', '/api/devices/duplicates')).data.list.length, 1);
    assert.equal((await call('POST', `/api/devices/${nas.id}/merge`, { from: b.id }, { who: 'viewer' })).status, 403);
    const m = await call('POST', `/api/devices/${nas.id}/merge`, { from: b.id });
    assert.equal(m.status, 200);
    assert.equal((await call('GET', '/api/devices/duplicates')).data.list.length, 0);
    assert.equal((await call('POST', `/api/devices/${nas.id}/merge`, { from: nas.id })).status, 400);
  } finally { await app.close(); }
});
