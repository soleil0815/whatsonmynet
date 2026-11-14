// Logic improvements 2026-11: one central place for device changes, adopt/ignore only from the newest scan of a
// subnet, fixed hypervisor poll interval, maintenance status shown from the window, host name ownership, monitors with
// a stored password paused after an IP change, CSV formula hardening.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDb } from './helpers.js';
import { createInventory, toCsv } from '../src/inventory.js';
import { fillDevice } from '../src/devicefill.js';
import { createSettings } from '../src/settings.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';

const iso = () => new Date().toISOString();
const channels = { notify: async () => [], notifyIds: async () => [] };

function scanWith(db, rows, { status = 'running', cidr = '192.168.1.0/24', kind = 'network', locationId } = {}) {
  const target = locationId === undefined ? { cidr } : { cidr, locationId };
  const scanId = db.prepare('INSERT INTO scans(kind,status,targets,started_at,finished_at) VALUES(?,?,?,?,?)')
    .run(kind, status, JSON.stringify([target]), iso(), status === 'done' ? iso() : null).lastInsertRowid;
  const ids = rows.map((r) => db.prepare(`INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status,location_id)
    VALUES(?,?,?,?,?,?,?,?,'pending',?)`).run(scanId, r.ip, r.mac ?? null, r.hostname || '', r.vendor || '', r.type || 'server', 0.8,
    JSON.stringify({ ports: [22], classification: { type: r.type || 'server', os: 'Linux' } }), locationId ?? null).lastInsertRowid);
  return { scanId, ids };
}

// ---------------------------------------------------------------------------------------------------- 4
test('central device change: onDeviceChanged moves monitors, follows the web link, renames monitors and clears SNMP data', async () => {
  const mod = await import('../src/devicechange.js').catch(() => null);
  assert.ok(mod && typeof mod.onDeviceChanged === 'function', 'src/devicechange.js exports onDeviceChanged');
  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'NAS', type: 'nas', ip: '10.0.0.5', mac: 'aa:bb:cc:00:04:01', web_url: 'https://10.0.0.5:5001/' });
  const ts = iso();
  const mon = db.prepare(`INSERT INTO monitors(name,type,target,device_id,created_at,updated_at,status,status_since) VALUES('NAS - Ping','ping','10.0.0.5',?,?,?,'up',?)`)
    .run(d.id, ts, ts, ts).lastInsertRowid;
  db.prepare("INSERT INTO snmp_status(device_id,kind,ok,data,at) VALUES(?, 'nas', 1, '{}', ?)").run(d.id, ts);
  const before = db.prepare('SELECT * FROM devices WHERE id=?').get(d.id);
  db.prepare("UPDATE devices SET ip='10.0.0.6', name='Storage', type='server' WHERE id=?").run(d.id);
  const after = db.prepare('SELECT * FROM devices WHERE id=?').get(d.id);
  const r = mod.onDeviceChanged(db, before, after, 'manual', { user: 'admin' });
  assert.equal(r.moved, 1);
  assert.equal(r.renamed, 1);
  const m = db.prepare('SELECT name, target FROM monitors WHERE id=?').get(mon);
  assert.deepEqual([m.name, m.target], ['Storage - Ping', '10.0.0.6']);
  assert.equal(inv.get(d.id).web_url, 'https://10.0.0.6:5001/');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM snmp_status WHERE device_id=?').get(d.id).n, 0);
  assert.equal(inv.historyOf(d.id)[0].kind, 'ip');
});

test('central device change: a type reported by the device itself clears SNMP data of the old type like a manual edit', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'Box', type: 'unknown', ip: '10.0.0.9', mac: 'aa:bb:cc:00:04:02' });
  const ts = iso();
  db.prepare("INSERT INTO snmp_status(device_id,kind,ok,data,at) VALUES(?, 'nas', 1, '{}', ?)").run(d.id, ts);
  db.prepare("INSERT INTO switch_macs(switch_id,if_index,port,mac,seen_at) VALUES(?, 1, 'Port 1', 'aa:bb:cc:00:00:99', ?)").run(d.id, ts);
  assert.deepEqual(fillDevice(db, d.id, { type: 'vm' }, 'script').fields, ['type']);
  assert.equal(inv.get(d.id).type, 'vm');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM snmp_status WHERE device_id=?').get(d.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM switch_macs WHERE switch_id=?').get(d.id).n, 0);
});

// ---------------------------------------------------------------------------------------------------- 5
test('adopt and ignore refuse results that are not from the newest finished scan of their subnet', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const old = scanWith(db, [{ ip: '192.168.1.50', mac: 'aa:bb:cc:00:05:01' }, { ip: '192.168.1.51', mac: 'aa:bb:cc:00:05:02' }], { status: 'done' });
  const otherNet = scanWith(db, [{ ip: '10.9.0.5', mac: 'aa:bb:cc:00:05:03' }], { status: 'done', cidr: '10.9.0.0/24' });
  const fresh = scanWith(db, [{ ip: '192.168.1.50', mac: 'aa:bb:cc:00:05:01' }], { status: 'done' });
  for (const id of [...old.ids, ...otherNet.ids, ...fresh.ids]) inv.applyResult(id);
  assert.throws(() => inv.adopt([old.ids[0]]), { code: 'err.scanOutdated', status: 409 });
  assert.throws(() => inv.ignore([old.ids[1]]), { code: 'err.scanOutdated' });
  assert.equal(inv.list().length, 0, 'nothing adopted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ignored').get().n, 0, 'nothing ignored');
  // the old scan can still be looked at: its results are marked, not removed
  assert.deepEqual([...inv.outdatedResults(old.scanId)].sort(), [...old.ids].sort());
  assert.equal(inv.outdatedResults(fresh.scanId).size, 0);
  // another subnet is not covered by the newer scan; the newest scan works
  assert.equal(inv.adopt(otherNet.ids).length, 1);
  assert.equal(inv.adopt(fresh.ids).length, 1);
});

test('newest scan rule: a light scan does not outdate a full scan, a running scan outdates nothing, scan agents only their own site', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const ts = iso();
  const loc = (n) => db.prepare('INSERT INTO locations(name,created_at) VALUES(?,?)').run(n, ts).lastInsertRowid;
  const a = loc('Head office'); const b = loc('Branch');
  const full = scanWith(db, [{ ip: '192.168.1.60', mac: 'aa:bb:cc:00:05:11' }], { status: 'done', locationId: a });
  scanWith(db, [{ ip: '192.168.1.60', mac: 'aa:bb:cc:00:05:11' }], { status: 'done', kind: 'light', locationId: a });
  scanWith(db, [], { status: 'running', locationId: a });
  // same subnet at another site (scan agent): not the same network
  scanWith(db, [], { status: 'done', locationId: b });
  for (const id of full.ids) inv.applyResult(id);
  assert.equal(inv.outdatedResults(full.scanId).size, 0);
  assert.equal(inv.adopt(full.ids).length, 1);
});

// ---------------------------------------------------------------------------------------------------- 6a
test('hypervisor poll interval is a fixed 5 minutes, not a setting that can never be set', () => {
  const db = memoryDb();
  assert.equal(createSettings(db).get('proxmox.interval'), undefined);
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'proxmox.js'), 'utf8');
  assert.ok(!src.includes("'proxmox.interval'"), 'no setting read');
  assert.match(src, /5 \* 60 \* 1000/);
});

// ---------------------------------------------------------------------------------------------------- 6b
test('monitor status shows the maintenance window from its start and no longer after its end, without a check', async () => {
  const db = memoryDb();
  const clock = { t: new Date('2026-11-12T10:00:00Z') };
  const maintenance = createMaintenance(db);
  const mon = createMonitoring({ db, channels, maintenance, now: () => clock.t });
  const inv = createInventory(db);
  const d = inv.create({ name: 'Server', ip: '10.0.0.20', mac: 'aa:bb:cc:00:06:01' });
  const m = await mon.create({ name: 'Server RDP', type: 'tcp', target: '10.0.0.20', port: 3389, device_id: d.id });
  await mon.record(m, { ok: true, ms: 1, message: 'open' });
  assert.equal(mon.get(m.id).status, 'up');
  maintenance.create({ name: 'Patch', kind: 'once', starts_at: '2026-11-12T10:05:00Z', ends_at: '2026-11-12T10:35:00Z', monitor_ids: [m.id] });
  clock.t = new Date('2026-11-12T10:06:00Z');
  assert.equal(mon.get(m.id).status, 'maintenance', 'detail/get');
  assert.equal(mon.list().find((x) => x.id === m.id).status, 'maintenance', 'list');
  assert.equal(mon.summary().maintenance, 1, 'dashboard summary');
  assert.equal(mon.summary().up, 0);
  assert.equal(mon.deviceStatus()[d.id], 'maintenance', 'device status');
  assert.equal(db.prepare('SELECT status FROM monitors WHERE id=?').get(m.id).status, 'up', 'stored status untouched');
  // the check inside the window stores "maintenance"; after the window the display no longer claims it
  await mon.record(m, { ok: true, ms: 1, message: 'open' });
  clock.t = new Date('2026-11-12T10:40:00Z');
  assert.notEqual(mon.get(m.id).status, 'maintenance');
  assert.equal(mon.summary().maintenance, 0);
  // paused stays paused
  mon.pause(m.id);
  clock.t = new Date('2026-11-12T10:10:00Z');
  assert.equal(mon.get(m.id).status, 'paused');
});

// ---------------------------------------------------------------------------------------------------- 7
test('host name: the scan keeps a scan-set name up to date but never overwrites a typed one; clearing gives it back', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const s1 = scanWith(db, [{ ip: '192.168.1.70', mac: 'aa:bb:cc:00:07:01', hostname: 'nas-old.lan' }]);
  inv.applyResult(s1.ids[0]);
  const [id] = inv.adopt(s1.ids);
  // scan-set value follows the network
  const s2 = scanWith(db, [{ ip: '192.168.1.70', mac: 'aa:bb:cc:00:07:01', hostname: 'nas.lan' }]);
  inv.applyResult(s2.ids[0]);
  assert.equal(inv.get(id).hostname, 'nas.lan');
  // typed by hand: the scan leaves it alone
  inv.update(id, { hostname: 'storage.firma.local' }, 'admin');
  const s3 = scanWith(db, [{ ip: '192.168.1.70', mac: 'aa:bb:cc:00:07:01', hostname: 'nas.lan' }]);
  inv.applyResult(s3.ids[0]);
  assert.equal(inv.get(id).hostname, 'storage.firma.local');
  // cleared: the scan fills it again and keeps it up to date
  inv.update(id, { hostname: '' }, 'admin');
  const s4 = scanWith(db, [{ ip: '192.168.1.70', mac: 'aa:bb:cc:00:07:01', hostname: 'nas2.lan' }]);
  inv.applyResult(s4.ids[0]);
  assert.equal(inv.get(id).hostname, 'nas2.lan');
  const s5 = scanWith(db, [{ ip: '192.168.1.70', mac: 'aa:bb:cc:00:07:01', hostname: 'nas3.lan' }]);
  inv.applyResult(s5.ids[0]);
  assert.equal(inv.get(id).hostname, 'nas3.lan');
  // a host name typed into the form of a new device is the user's too
  const own = inv.create({ name: 'Printer', ip: '192.168.1.71', mac: 'aa:bb:cc:00:07:02', hostname: 'printer-2og' });
  const s6 = scanWith(db, [{ ip: '192.168.1.71', mac: 'aa:bb:cc:00:07:02', hostname: 'npi1234.lan' }]);
  inv.applyResult(s6.ids[0]);
  assert.equal(inv.get(own.id).hostname, 'printer-2og');
});

test('host name: devices from before the ownership rule are still kept up to date by the scan', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const ts = iso();
  const id = db.prepare("INSERT INTO devices(name,type,ip,mac,hostname,created_at,updated_at) VALUES('Old','server','192.168.1.72','aa:bb:cc:00:07:03','old.lan',?,?)").run(ts, ts).lastInsertRowid;
  const s = scanWith(db, [{ ip: '192.168.1.72', mac: 'aa:bb:cc:00:07:03', hostname: 'new.lan' }]);
  inv.applyResult(s.ids[0]);
  assert.equal(inv.get(id).hostname, 'new.lan');
});

// ---------------------------------------------------------------------------------------------------- 8
test('monitor with a stored password: paused with a note after an IP change, new IP offered, a new password resumes it', async () => {
  const db = memoryDb();
  const mon = createMonitoring({ db, channels, maintenance: createMaintenance(db) });
  const inv = createInventory(db);
  const d = inv.create({ name: 'DB', type: 'server', ip: '10.0.0.30', mac: 'aa:bb:cc:00:08:01' });
  const m = await mon.create({ name: 'DB MySQL', type: 'mysql', target: '10.0.0.30', port: 3306, password: 'secret-1', options: { user: 'monitor' }, device_id: d.id });
  // the scan sees the device at another address
  const s = scanWith(db, [{ ip: '10.0.0.31', mac: 'aa:bb:cc:00:08:01' }], { cidr: '10.0.0.0/24' });
  inv.applyResult(s.ids[0]);
  const paused = mon.get(m.id);
  assert.equal(paused.enabled, false);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.target, '10.0.0.30', 'the password stays bound to the old address');
  assert.match(paused.last_message, /new IP \(10\.0\.0\.30 → 10\.0\.0\.31\)/);
  assert.deepEqual([paused.data.ipMoved.from, paused.data.ipMoved.to, paused.data.ipMoved.target], ['10.0.0.30', '10.0.0.31', '10.0.0.31']);
  assert.equal(mon.detail(m.id).events[0].kind, 'ipMoved');
  assert.ok(inv.historyOf(d.id).some((h) => h.kind === 'monitorsPaused'), 'device history entry');
  // moving it to the new address without typing the password again is refused
  await assert.rejects(mon.update(m.id, { target: '10.0.0.31' }), { code: 'err.passwordAgain' });
  // with the password it runs again at the new address
  const back = await mon.update(m.id, { target: '10.0.0.31', password: 'secret-1' });
  assert.equal(back.enabled, true);
  assert.equal(back.target, '10.0.0.31');
  assert.equal(back.status, 'pending');
  assert.equal(back.data.ipMoved, undefined);
  assert.equal(back.last_message, '');
});

test('monitor with a stored password is paused the same way after a manual address change', async () => {
  const db = memoryDb();
  const mon = createMonitoring({ db, channels, maintenance: createMaintenance(db) });
  const inv = createInventory(db);
  const d = inv.create({ name: 'Files', type: 'nas', ip: '10.0.0.40', mac: 'aa:bb:cc:00:08:02' });
  const m = await mon.create({ name: 'Files share', type: 'smb', target: '10.0.0.40', password: 'pw', options: { share: 'data', user: 'reader' }, device_id: d.id });
  inv.update(d.id, { ip: '10.0.0.41' }, 'admin');
  const x = mon.get(m.id);
  assert.equal(x.enabled, false);
  assert.equal(x.target, '10.0.0.40');
  assert.equal(x.data.ipMoved.to, '10.0.0.41');
  // resumed by hand (at the old address): the note is done with
  const r = mon.resume(m.id);
  assert.equal(r.enabled, true);
  assert.equal(r.data.ipMoved, undefined);
});

// ---------------------------------------------------------------------------------------------------- 12
test('CSV export neutralises formulas after leading whitespace and after a comma (comma list separator)', () => {
  // the data row (everything after the header line; a cell may hold a line break of its own)
  const row = (over) => { const csv = toCsv([{ name: 'x', ...over }]); return csv.slice(csv.indexOf('\r\n') + 2, -2); };
  assert.ok(row({ notes: ' =1+1' }).includes("' =1+1"), 'leading space');
  assert.ok(row({ notes: '\t=cmd' }).includes("'\t=cmd"), 'leading tab');
  assert.ok(row({ notes: '\r\n@SUM(A1)' }).includes("'\r\n@SUM(A1)"), 'leading line break');
  assert.ok(row({ tags: 'a,=HYPERLINK("http://x")' }).includes('\'a,=HYPERLINK'), 'comma then =');
  assert.ok(row({ owner: 'IT, +49 30 1234' }).includes("'IT, +49 30 1234"), 'comma, space then +');
  assert.ok(toCsv([{ name: '-5' }]).includes("\r\n'-5;"), 'every column is text, so -5 is text too');
  assert.ok(toCsv([{ name: 'NAS 1' }]).includes('\r\nNAS 1;'), 'harmless values untouched');
  assert.ok(row({ notes: 'plain, text' }).endsWith('plain, text'));
});
