import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { createInventory, toCsv } from '../src/inventory.js';

function scanWith(db, rows) {
  const scanId = db.prepare("INSERT INTO scans(kind,status,targets,started_at) VALUES('network','running','[{\"cidr\":\"192.168.1.0/24\"}]',?)").run(new Date().toISOString()).lastInsertRowid;
  const ids = rows.map((r) => db.prepare(`INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status)
    VALUES(?,?,?,?,?,?,?,?,'pending')`).run(scanId, r.ip, r.mac ?? null, r.hostname || '', r.vendor || '', r.type || 'server', 0.8,
    JSON.stringify({ ports: r.ports || [22], classification: { type: r.type || 'server', os: 'Linux' } })).lastInsertRowid);
  return { scanId, ids };
}

test('new devices stay out of the inventory until adopted', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const { scanId, ids } = scanWith(db, [{ ip: '192.168.1.10', mac: 'bc:24:11:00:00:01', hostname: 'pve1', ports: [22, 8006], type: 'hypervisor' }]);
  ids.forEach((id) => inv.applyResult(id));
  inv.finishScan(scanId);
  assert.equal(db.prepare('SELECT status FROM scan_results WHERE id=?').get(ids[0]).status, 'new');
  assert.equal(inv.list().length, 0);
  const created = inv.adopt(ids, {}, 'michael');
  assert.equal(created.length, 1);
  const d = inv.get(created[0]);
  assert.equal(d.name, 'pve1');
  assert.equal(d.type, 'hypervisor');
  assert.equal(d.web_url, 'https://192.168.1.10:8006/');
  assert.equal(inv.historyOf(d.id)[0].kind, 'created');
  // adopting twice does nothing
  assert.equal(inv.adopt(ids, {}, 'michael').length, 0);
});

test('known device: new IP is taken over automatically (MAC stays the same)', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'NAS', type: 'nas', ip: '192.168.1.20', mac: '00:11:32:aa:bb:cc', web_url: 'https://192.168.1.20:5001/' }, 'michael');
  const { ids } = scanWith(db, [{ ip: '192.168.1.44', mac: '00-11-32-AA-BB-CC', type: 'nas', ports: [5000, 5001] }]);
  inv.applyResult(ids[0]);
  const after = inv.get(d.id);
  assert.equal(after.ip, '192.168.1.44');
  assert.equal(after.web_url, 'https://192.168.1.44:5001/');
  assert.equal(after.name, 'NAS');
  const r = db.prepare('SELECT status, device_id FROM scan_results WHERE id=?').get(ids[0]);
  assert.equal(r.status, 'changed');
  assert.equal(r.device_id, d.id);
  const h = inv.historyOf(d.id).find((x) => x.kind === 'ip');
  assert.deepEqual([h.detail.from, h.detail.to, h.user], ['192.168.1.20', '192.168.1.44', 'scan']);
  assert.equal(inv.list()[0].presence, 'unknown'); // the scan is not finished/"done" yet
});

test('known device with unchanged address is only "known"; user fields are never overwritten', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'Mein Drucker', type: 'printer', ip: '192.168.1.30', mac: '3c:2a:f4:00:00:01', vendor: 'Brother' });
  const { ids } = scanWith(db, [{ ip: '192.168.1.30', mac: '3c:2a:f4:00:00:01', type: 'unknown', hostname: 'brn001' }]);
  inv.applyResult(ids[0]);
  const after = inv.get(d.id);
  assert.equal(after.type, 'printer');
  assert.equal(after.name, 'Mein Drucker');
  assert.equal(after.hostname, 'brn001');
  assert.equal(db.prepare('SELECT status FROM scan_results WHERE id=?').get(ids[0]).status, 'known');
});

test('ignored devices', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const a = scanWith(db, [{ ip: '192.168.1.50', mac: 'da:a1:19:00:00:01' }, { ip: '10.9.9.9', mac: null }]);
  a.ids.forEach((id) => inv.applyResult(id));
  assert.equal(inv.ignore(a.ids, 'michael'), 2);
  const b = scanWith(db, [{ ip: '192.168.1.51', mac: 'da:a1:19:00:00:01' }, { ip: '10.9.9.9', mac: null }]);
  b.ids.forEach((id) => inv.applyResult(id));
  assert.deepEqual(b.ids.map((id) => db.prepare('SELECT status FROM scan_results WHERE id=?').get(id).status), ['ignored', 'ignored']);
});

test('devices without MAC are matched by IP', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'Remote', ip: '10.1.1.1' });
  const { ids } = scanWith(db, [{ ip: '10.1.1.1', mac: '00:11:22:33:44:55' }]);
  inv.applyResult(ids[0]);
  assert.equal(inv.get(d.id).mac, '00:11:22:33:44:55');
});

test('validation of manual input', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  assert.throws(() => inv.create({ name: '' }), /err.nameRequired/);
  assert.throws(() => inv.create({ name: 'x', ip: '1.2.3' }), /err.ip/);
  assert.throws(() => inv.create({ name: 'x', mac: 'zz' }), /err.mac/);
  assert.throws(() => inv.create({ name: 'x', web_url: 'javascript:alert(1)' }), /err.url/);
  assert.throws(() => inv.create({ name: 'x', location_id: 99 }), /err.location/);
  inv.create({ name: 'a', mac: 'aa:aa:aa:00:00:01' });
  assert.throws(() => inv.create({ name: 'b', mac: 'AA-AA-AA-00-00-01' }), /err.macExists/);
  assert.throws(() => inv.create({ name: 'c', warranty_until: '2027-02-30' }), /err.date/);
  const d = inv.create({ name: 'c', type: 'nonsense', tags: 'a, b,,c', warranty_until: '' });
  assert.equal(d.type, 'unknown');
  assert.equal(d.tags, 'a, b, c');
  assert.equal(d.warranty_until, null);
});

test('CSV export is safe for spreadsheets', () => {
  const csv = toCsv([{ name: '=HYPERLINK("x")', notes: 'a;b', ip: '1.2.3.4' }]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"a;b"'));
});

test('suggestions come from the inventory, most used first; a known model knows its manufacturer and type', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  inv.create({ name: 'a', vendor: 'Brother', model: 'HL-L2350DW', type: 'printer', tags: 'EG, Büro' });
  inv.create({ name: 'b', vendor: 'Brother', model: 'HL-L2350DW', type: 'printer', tags: 'büro' });
  inv.create({ name: 'c', vendor: 'Synology', model: 'DS920+', type: 'nas', supplier: 'Systemhaus Nord', owner: 'IT' });
  const s = inv.suggestions();
  assert.deepEqual(s.vendor, ['Brother', 'Synology']);
  assert.deepEqual(s.tags, ['Büro', 'EG']);
  assert.deepEqual(s.models['hl-l2350dw'], { vendor: 'Brother', type: 'printer' });
  assert.deepEqual(s.supplier, ['Systemhaus Nord']);
});

test('bulk edit: only chosen fields change, tags are added/removed, history per device', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const a = inv.create({ name: 'a', vendor: 'HP', tags: 'Keller, alt' });
  const b = inv.create({ name: 'b', vendor: 'Dell', owner: 'Anna' });
  const loc = db.prepare("INSERT INTO locations(name,created_at) VALUES('Hauptgebäude',?)").run(new Date().toISOString()).lastInsertRowid;
  const n = inv.bulkUpdate([a.id, b.id, 9999], { set: { location_id: loc, warranty_until: '2028-01-31', name: 'ignored' }, tagsAdd: ['Server'], tagsRemove: ['ALT'] }, 'michael');
  assert.equal(n, 2);
  const a2 = inv.get(a.id); const b2 = inv.get(b.id);
  assert.equal(a2.location_id, loc);
  assert.equal(a2.vendor, 'HP');
  assert.equal(a2.name, 'a');
  assert.equal(a2.tags, 'Keller, Server');
  assert.equal(b2.owner, 'Anna');
  assert.equal(b2.tags, 'Server');
  assert.equal(b2.warranty_until, '2028-01-31');
  assert.equal(inv.historyOf(b.id)[0].kind, 'edit');
  assert.throws(() => inv.bulkUpdate([a.id], { set: { warranty_until: '2028-02-30' } }), /err.date/);
  assert.equal(inv.get(a.id).warranty_until, '2028-01-31');
  assert.equal(inv.bulkRemove([a.id, b.id]), 2);
  assert.equal(inv.list().length, 0);
});

test('renaming a device renames its monitors and sensors that carry the old name', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'Drucker EG', ip: '192.168.1.40', type: 'printer' }, 'michael');
  const ts = new Date().toISOString();
  const mk = (name, deviceId) => db.prepare("INSERT INTO monitors(name,type,target,device_id,created_at,updated_at) VALUES(?,'ping','192.168.1.40',?,?,?)").run(name, deviceId, ts, ts).lastInsertRowid;
  const a = mk('Drucker EG', d.id);
  const b = mk('Drucker EG - Sensor: Toner Schwarz', d.id);
  const c = mk('Mein eigener Name', d.id);
  const other = mk('Drucker EG', null);
  const r = inv.update(d.id, { name: 'Drucker Empfang' }, 'michael');
  assert.equal(r.renamedMonitors, 2);
  const name = (id) => db.prepare('SELECT name FROM monitors WHERE id=?').get(id).name;
  assert.deepEqual([name(a), name(b), name(c), name(other)], ['Drucker Empfang', 'Drucker Empfang - Sensor: Toner Schwarz', 'Mein eigener Name', 'Drucker EG']);
  assert.equal(inv.update(d.id, { notes: 'x' }).renamedMonitors, undefined, 'no rename without a new name');
});
