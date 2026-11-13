// Server hardware through Redfish (iDRAC, iLO, XClarity …) against a simulated management chip: older firmware with
// Thermal/Power, newer one with ThermalSubsystem/PowerSubsystem/Sensors; the server goes into the inventory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, proxmoxMetrics } from '../src/proxmox.js';
import { proxmoxCheck } from '../src/monitor/sensors.js';
import { healthOf } from '../src/redfish.js';

const ok = { State: 'Enabled', Health: 'OK' };
const col = (...ids) => ({ Members: ids.map((id) => ({ '@odata.id': id })) });

/** The Redfish tree of a Dell server (older layout) */
function dell(state) {
  return {
    '/redfish/v1': { Systems: { '@odata.id': '/redfish/v1/Systems' }, Managers: { '@odata.id': '/redfish/v1/Managers' }, Chassis: { '@odata.id': '/redfish/v1/Chassis' } },
    '/redfish/v1/Systems': col('/redfish/v1/Systems/System.Embedded.1'),
    '/redfish/v1/Systems/System.Embedded.1': {
      Manufacturer: 'Dell Inc.', Model: 'PowerEdge R650', SerialNumber: 'CNFCP0012300AB', SKU: '7XK2Q93', BiosVersion: '1.13.2', PowerState: 'On',
      Status: { State: 'Enabled', Health: state.psuBroken ? 'Critical' : 'OK' }, ProcessorSummary: { Count: 2, Model: 'Intel(R) Xeon(R) Silver 4310 CPU @ 2.10GHz' }, MemorySummary: { TotalSystemMemoryGiB: 128 },
      Links: { Chassis: [{ '@odata.id': '/redfish/v1/Chassis/System.Embedded.1' }] },
      Storage: { '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage' }, EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/System.Embedded.1/EthernetInterfaces' },
    },
    '/redfish/v1/Systems/System.Embedded.1/EthernetInterfaces': col('/redfish/v1/Systems/System.Embedded.1/EthernetInterfaces/NIC.1'),
    '/redfish/v1/Systems/System.Embedded.1/EthernetInterfaces/NIC.1': { MACAddress: 'B0:7B:25:AA:BB:01', PermanentMACAddress: 'B0:7B:25:AA:BB:01' },
    '/redfish/v1/Managers': col('/redfish/v1/Managers/iDRAC.Embedded.1'),
    '/redfish/v1/Managers/iDRAC.Embedded.1': { Model: '15G Monolithic', FirmwareVersion: '7.00.00.171' },
    '/redfish/v1/Chassis/System.Embedded.1': { Thermal: { '@odata.id': '/redfish/v1/Chassis/System.Embedded.1/Thermal' }, Power: { '@odata.id': '/redfish/v1/Chassis/System.Embedded.1/Power' } },
    '/redfish/v1/Chassis/System.Embedded.1/Thermal': {
      Fans: [{ Name: 'System Board Fan1A', Reading: 6840, ReadingUnits: 'RPM', Status: ok }, { Name: 'System Board Fan2A', Reading: 0, ReadingUnits: 'RPM', Status: { State: 'Absent' } }],
      Temperatures: [{ Name: 'CPU1 Temp', ReadingCelsius: 48, UpperThresholdNonCritical: 93, UpperThresholdCritical: 98, Status: ok }, { Name: 'System Board Inlet Temp', ReadingCelsius: 23, UpperThresholdNonCritical: 42, Status: ok }],
    },
    '/redfish/v1/Chassis/System.Embedded.1/Power': {
      PowerSupplies: [{ Name: 'PS1 Status', Model: 'PWR SPLY,800W', PowerCapacityWatts: 800, LastPowerOutputWatts: 141, Status: ok },
        { Name: 'PS2 Status', Model: 'PWR SPLY,800W', PowerCapacityWatts: 800, Status: state.psuBroken ? { State: 'Enabled', Health: 'Critical' } : ok }],
      PowerControl: [{ PowerConsumedWatts: 262 }],
    },
    '/redfish/v1/Systems/System.Embedded.1/Storage': col('/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1'),
    '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1': {
      Name: 'PERC H755 Front', StorageControllers: [{ Name: 'PERC H755 Front', Model: 'PERC H755 Front', FirmwareVersion: '52.21.0-4606', Status: ok }],
      Drives: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1/Drives/Disk.0' }, { '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1/Drives/Disk.1' }],
      Volumes: { '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1/Volumes' },
    },
    '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1/Drives/Disk.0': { Name: 'Solid State Disk 0:1:0', Model: 'MZ7L3480HCHQAD3', SerialNumber: 'S6M0NE0T1', CapacityBytes: 479559942144, MediaType: 'SSD', Protocol: 'SATA', PredictedMediaLifeLeftPercent: 98, Status: ok },
    '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1/Drives/Disk.1': { Name: 'Solid State Disk 0:1:1', Model: 'MZ7L3480HCHQAD3', SerialNumber: 'S6M0NE0T2', CapacityBytes: 479559942144, MediaType: 'SSD', Protocol: 'SATA', PredictedMediaLifeLeftPercent: 7, FailurePredicted: true, Status: ok },
    '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1/Volumes': col('/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1/Volumes/Disk.Virtual.0'),
    '/redfish/v1/Systems/System.Embedded.1/Storage/RAID.SL.3-1/Volumes/Disk.Virtual.0': { Name: 'OS', RAIDType: 'RAID1', CapacityBytes: 479559942144, Status: ok },
  };
}

/** HPE iLO 6 style: ThermalSubsystem, PowerSubsystem, temperatures as Sensors */
const hpe = {
  '/redfish/v1': { Systems: { '@odata.id': '/redfish/v1/Systems' }, Chassis: { '@odata.id': '/redfish/v1/Chassis' } },
  '/redfish/v1/Systems': col('/redfish/v1/Systems/1'),
  '/redfish/v1/Systems/1': { Manufacturer: 'HPE', Model: 'ProLiant DL360 Gen11', SerialNumber: 'CZ2D1234', SKU: 'P52499-B21', PowerState: 'Off', Status: { State: 'Disabled', Health: 'OK' } },
  '/redfish/v1/Chassis': col('/redfish/v1/Chassis/1'),
  '/redfish/v1/Chassis/1': { ThermalSubsystem: { '@odata.id': '/redfish/v1/Chassis/1/ThermalSubsystem' }, PowerSubsystem: { '@odata.id': '/redfish/v1/Chassis/1/PowerSubsystem' }, Sensors: { '@odata.id': '/redfish/v1/Chassis/1/Sensors' } },
  '/redfish/v1/Chassis/1/ThermalSubsystem': { Fans: { '@odata.id': '/redfish/v1/Chassis/1/ThermalSubsystem/Fans' } },
  '/redfish/v1/Chassis/1/ThermalSubsystem/Fans': col('/redfish/v1/Chassis/1/ThermalSubsystem/Fans/1'),
  '/redfish/v1/Chassis/1/ThermalSubsystem/Fans/1': { Name: 'Fan 1', SpeedPercent: { Reading: 23 }, Status: { State: 'Enabled', Health: 'Warning' } },
  '/redfish/v1/Chassis/1/PowerSubsystem': { PowerSupplies: { '@odata.id': '/redfish/v1/Chassis/1/PowerSubsystem/PowerSupplies' } },
  '/redfish/v1/Chassis/1/PowerSubsystem/PowerSupplies': col('/redfish/v1/Chassis/1/PowerSubsystem/PowerSupplies/1'),
  '/redfish/v1/Chassis/1/PowerSubsystem/PowerSupplies/1': { Name: 'Power Supply 1', PowerCapacityWatts: 1000, Status: ok },
  '/redfish/v1/Chassis/1/Sensors': col('/redfish/v1/Chassis/1/Sensors/01-Inlet', '/redfish/v1/Chassis/1/Sensors/fan'),
  '/redfish/v1/Chassis/1/Sensors/01-Inlet': { Name: '01-Inlet Ambient', ReadingType: 'Temperature', Reading: 21, Thresholds: { UpperCaution: { Reading: 42 } }, Status: ok },
  '/redfish/v1/Chassis/1/Sensors/fan': { Name: 'Fan speed', ReadingType: 'Percent', Reading: 23, Status: ok },
};

async function withFake(tree, fn) {
  const dir = fs.mkdtempSync(path.join(tmp, 'rf-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=idrac',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const seen = [];
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    const p = req.url.split('?')[0].replace(/\/+$/, '');
    seen.push({ m: req.method, p });
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Basic ${Buffer.from('womn:pw').toString('base64')}`) return send(401, { error: 'auth' });
    const x = typeof tree === 'function' ? tree()[p] : tree[p];
    return x ? send(200, x) : send(404, { error: 'not found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn({ url: `https://127.0.0.1:${srv.address().port}`, ca: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8'), seen }); } finally { srv.close(); }
}

test('Redfish (older layout, Dell): fans, temperatures, power supplies, RAID; server into the inventory; sensors', async () => {
  const state = { psuBroken: false };
  await withFake(() => dell(state), async ({ url, ca, seen }) => {
    const db = memoryDb();
    const px = createProxmox({ db, settings: createSettings(db) });
    const ts = new Date().toISOString();
    const dev = db.prepare("INSERT INTO devices(name,type,ip,mac,created_at,updated_at) VALUES('srv-db01','unknown','10.0.0.30','b0:7b:25:aa:bb:01',?,?)").run(ts, ts).lastInsertRowid;
    const wrong = await px.poll(px.create({ name: 'x', kind: 'redfish', url, token_id: 'womn', secret: 'nope', ca }).id);
    assert.match(wrong.last_error, /sign-in refused/);
    const h = await px.poll(px.create({ name: 'iDRAC srv-db01', kind: 'redfish', url, token_id: 'womn', secret: 'pw', ca }).id);
    assert.equal(h.last_ok, true, h.last_error);
    const d = h.data;
    assert.deepEqual([d.vendor, d.model, d.sku, d.bios, d.power, d.health, d.cpus, d.memGiB, d.watts, d.bmc.firmware, d.deviceId],
      ['Dell Inc.', 'PowerEdge R650', '7XK2Q93', '1.13.2', 'on', 'ok', 2, 128, 262, '7.00.00.171', dev]);
    assert.deepEqual(d.fans, [{ name: 'System Board Fan1A', rpm: 6840, pct: null, health: 'ok' }], 'absent fan left out');
    assert.deepEqual(d.temps.map((x) => [x.name, x.c, x.warn]), [['CPU1 Temp', 48, 93], ['System Board Inlet Temp', 23, 42]]);
    assert.deepEqual(d.psus.map((x) => [x.name, x.capacity, x.output, x.health]), [['PS1 Status', 800, 141, 'ok'], ['PS2 Status', 800, null, 'ok']]);
    assert.deepEqual(d.drives.map((x) => [x.serial, x.life, x.failurePredicted]), [['S6M0NE0T1', 98, false], ['S6M0NE0T2', 7, true]]);
    assert.deepEqual(d.volumes, [{ name: 'OS', raid: 'RAID1', size: 479559942144, health: 'ok' }]);
    assert.deepEqual(d.controllers.map((x) => x.model), ['PERC H755 Front']);
    assert.ok(seen.every((x) => x.m === 'GET'), 'only reads');
    // Service tag on the label (SKU at Dell) into the inventory, the server is a server
    assert.deepEqual(db.prepare('SELECT vendor, model, serial, type FROM devices WHERE id=?').get(dev), { vendor: 'Dell Inc.', model: 'PowerEdge R650', serial: '7XK2Q93', type: 'server' });
    assert.equal(px.hardwareOf(dev).name, 'iDRAC srv-db01');

    const m = proxmoxMetrics(d);
    assert.deepEqual([...new Set(m.map((x) => x.metric))], ['rfHealth', 'rfPower', 'rfFan', 'rfTemp', 'rfPsu', 'rfDrive', 'rfDriveLife', 'rfVolume', 'rfWatts']);
    const chk = (metric, key = '', op = '', threshold = '') => proxmoxCheck(db, { options: JSON.stringify({ host: h.id, metric, key, op, threshold, label: metric }) });
    assert.equal(chk('rfHealth').ok, true);
    assert.match(chk('rfFan', 'System Board Fan1A').message, /ok · 6840 RPM/);
    assert.equal(chk('rfDrive', 'S6M0NE0T2').ok, false, 'failure predicted = warning');
    assert.equal(chk('rfDriveLife', 'S6M0NE0T2', 'le', '10').ok, false);
    assert.equal(chk('rfTemp', 'CPU1 Temp', 'ge', '93').ok, true);
    // A power supply fails
    state.psuBroken = true;
    await px.poll(h.id);
    assert.equal(chk('rfPsu', 'PS2 Status').ok, false);
    assert.equal(chk('rfHealth').data.state, 'critical');
  });
});

test('Redfish (newer layout, HPE iLO 6): ThermalSubsystem, PowerSubsystem, temperatures as sensors, server off', () => withFake(hpe, async ({ url, ca }) => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  const h = await px.poll(px.create({ name: 'iLO', kind: 'redfish', url, token_id: 'womn', secret: 'pw', ca }).id);
  assert.equal(h.last_ok, true, h.last_error);
  const d = h.data;
  assert.deepEqual([d.vendor, d.model, d.serial, d.power, d.health, d.bmc, d.deviceId], ['HPE', 'ProLiant DL360 Gen11', 'CZ2D1234', 'off', 'ok', null, null]);
  assert.deepEqual(d.fans, [{ name: 'Fan 1', rpm: null, pct: 23, health: 'warning' }]);
  assert.deepEqual(d.temps, [{ name: '01-Inlet Ambient', c: 21, warn: 42, crit: null, health: 'ok' }], 'only temperature sensors');
  assert.deepEqual(d.psus.map((x) => [x.name, x.capacity]), [['Power Supply 1', 1000]]);
  const chk = (metric, key = '') => proxmoxCheck(db, { options: JSON.stringify({ host: h.id, metric, key, label: metric }) });
  assert.equal(chk('rfPower').ok, false, 'switched off');
  assert.equal(chk('rfFan', 'Fan 1').ok, false);
}));

test('Redfish: not a Redfish service, absent parts, foreign links are not followed', async () => {
  await withFake({ '/redfish/v1': { Name: 'x' } }, async ({ url, ca }) => {
    const db = memoryDb();
    const px = createProxmox({ db, settings: createSettings(db) });
    const h = await px.poll(px.create({ name: 'x', kind: 'redfish', url, token_id: 'womn', secret: 'pw', ca }).id);
    assert.match(h.last_error, /no Redfish service/);
  });
  await withFake({ '/redfish/v1': { Systems: { '@odata.id': 'https://evil.example/redfish/v1/Systems' } } }, async ({ url, ca, seen }) => {
    const db = memoryDb();
    const px = createProxmox({ db, settings: createSettings(db) });
    const h = await px.poll(px.create({ name: 'x', kind: 'redfish', url, token_id: 'womn', secret: 'pw', ca }).id);
    assert.equal(h.last_ok, false);
    assert.deepEqual(seen.map((x) => x.p), ['/redfish/v1']);
  });
  assert.equal(healthOf({ State: 'Absent', Health: 'OK' }), null);
  assert.equal(healthOf({ Health: 'Critical' }), 'critical');
  assert.equal(healthOf(undefined), 'unknown');
});
