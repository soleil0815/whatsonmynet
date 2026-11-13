import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { startAgent, addSwitch, addNas } from './fixtures/switch-agent.js';
import { readSwitch, macFromOid, parseFdb, parseLldp } from '../src/scan/switch.js';
import { readNas, parseStorage, nasProblems } from '../src/scan/nas.js';
import { createSnmpDevices } from '../src/snmpdevices.js';
import { createSettings } from '../src/settings.js';
import { eventText } from '../src/monitor/notify.js';
import { createInventory } from '../src/inventory.js';
import { syncStoredFacts } from '../src/devicefill.js';

test('MAC from an OID suffix', () => {
  assert.equal(macFromOid('10.0.17.226.5.1.255'), '00:11:e2:05:01:ff');
  assert.equal(macFromOid('1.2.3'), null);
});

test('FDB: Q-BRIDGE first, BRIDGE as fallback, own entries skipped', () => {
  const bridgeIf = new Map([['5', 10005]]);
  assert.deepEqual(parseFdb({ qfdb: new Map([['10.0.17.226.5.1.255', 5]]), bridgeIf }), [{ mac: '00:11:e2:05:01:ff', ifIndex: 10005, vlan: 10 }]);
  const fdb = new Map([['0.17.226.5.1.1', 5], ['0.17.226.5.1.2', 5]]);
  const st = new Map([['0.17.226.5.1.1', 3], ['0.17.226.5.1.2', 4]]);
  assert.deepEqual(parseFdb({ fdb, fdbStatus: st, bridgeIf }).map((x) => x.mac), ['00:11:e2:05:01:01']);
});

test('LLDP neighbours', () => {
  const rem = new Map([['9.0.3.1', Buffer.from('core-sw')], ['8.0.3.1', Buffer.from('Port 24')], ['7.0.3.1', Buffer.from('24')]]);
  assert.deepEqual(parseLldp(rem, new Map([['3', Buffer.from('Port 3')]])), [{ localNum: 3, localPort: 'Port 3', name: 'core-sw', port: 'Port 24' }]);
});

test('storage: volumes only, deduplicated', () => {
  const G = 1024 ** 3;
  const m = new Map([
    ['2.1', '1.3.6.1.2.1.25.2.1.2'], ['3.1', Buffer.from('Physical memory')], ['4.1', 1024], ['5.1', 8 * 1024 ** 2], ['6.1', 1],
    ['2.2', '1.3.6.1.2.1.25.2.1.4'], ['3.2', Buffer.from('/volume1')], ['4.2', 4096], ['5.2', (4000 * G) / 4096], ['6.2', (3700 * G) / 4096],
    ['2.3', '1.3.6.1.2.1.25.2.1.4'], ['3.3', Buffer.from('/volume1/@docker')], ['4.3', 4096], ['5.3', (4000 * G) / 4096], ['6.3', (3700 * G) / 4096],
    ['2.4', '1.3.6.1.2.1.25.2.1.4'], ['3.4', Buffer.from('/dev/shm')], ['4.4', 4096], ['5.4', (2 * G) / 4096], ['6.4', 0],
  ]);
  const v = parseStorage(m);
  assert.deepEqual(v.map((x) => [x.name, x.pct]), [['/volume1', 93]]);
  assert.deepEqual(nasProblems({ volumes: v }, 90).map((p) => p.key), ['vol:/volume1']);
});

test('reads a switch and a NAS via SNMP (fake agents)', async () => {
  const sw = startAgent(16162);
  addSwitch(sw.mib, {
    ports: [{ idx: 1, name: 'Port 1', up: true, alias: 'Drucker' }, { idx: 2, name: 'Port 2', up: false }, { idx: 3, name: 'Port 3', up: true, speed: 10000 }],
    fdb: [{ vlan: 1, mac: 'aa:bb:cc:00:00:01', port: 1 }, { vlan: 1, mac: 'aa:bb:cc:00:00:02', port: 3 }, { vlan: 20, mac: 'aa:bb:cc:00:00:03', port: 3 }],
  });
  const nas = startAgent(16163);
  addNas(nas.mib, {
    volumes: [{ name: '/volume1', sizeBlocks: 1000000, usedBlocks: 950000 }],
    disks: [{ name: 'Drive 1', model: 'WD40EFRX', status: 1, temp: 35 }, { name: 'Drive 2', model: 'WD40EFRX', status: 5, temp: 37 }],
    raids: [{ name: 'Storage Pool 1', status: 11 }],
  });
  try {
    const s = await readSwitch('127.0.0.1', ['public'], { port: 16162 });
    assert.deepEqual(s.ports.map((p) => [p.name, p.status, p.speed]), [['Port 1', 'up', 1000], ['Port 2', 'down', 1000], ['Port 3', 'up', 10000]]);
    assert.equal(s.ports[0].alias, 'Drucker');
    assert.equal(s.macs.length, 3);
    assert.deepEqual(s.macs.find((m) => m.mac === 'aa:bb:cc:00:00:03'), { mac: 'aa:bb:cc:00:00:03', ifIndex: 3, vlan: 20 });

    const n = await readNas('127.0.0.1', ['public'], { port: 16163 });
    assert.equal(n.vendor, 'synology');
    assert.equal(n.model, 'DS920+');
    assert.equal(n.temp, 41);
    assert.equal(n.volumes[0].pct, 95);
    assert.deepEqual(n.disks.map((d) => [d.name, d.bad]), [['Drive 1', false], ['Drive 2', true]]);
    assert.equal(n.raids[0].status, 'degrade');
    assert.deepEqual(nasProblems(n, 90).map((p) => p.key), ['raid:Storage Pool 1', 'disk:Drive 2', 'vol:/volume1']);
  } finally { sw.close(); nas.close(); }
});

test('poller: MAC table → "plugged in at", NAS problems reported once and when solved', async () => {
  const db = memoryDb();
  const settings = createSettings(db);
  const sent = [];
  const svc = createSnmpDevices({ db, settings, channels: { notifyIds: async (ids, ev) => { sent.push(ev); return ['Mail']; } } });
  const ts = new Date().toISOString();
  const add = (name, type, ip, mac = null) => db.prepare('INSERT INTO devices(name,type,ip,mac,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(name, type, ip, mac, ts, ts).lastInsertRowid;
  const swId = add('Core', 'switch', '10.0.0.2');
  const prn = add('Drucker', 'printer', '10.0.0.9', 'aa:bb:cc:00:00:01');
  const nasId = add('nas01', 'nas', '10.0.0.5');
  svc.setReaderForTests('switch', async () => ({ ports: [{ ifIndex: 1, name: 'Port 1', status: 'up' }, { ifIndex: 24, name: 'Port 24', status: 'up' }],
    macs: [{ mac: 'aa:bb:cc:00:00:01', ifIndex: 1, vlan: 1 }, ...Array.from({ length: 5 }, (_, i) => ({ mac: `aa:bb:cc:00:01:0${i}`, ifIndex: 24, vlan: 1 })),
      { mac: 'aa:bb:cc:00:00:01', ifIndex: 999, vlan: 1 }] }));
  const s = await svc.poll(swId);
  assert.equal(s.ports[0].macs[0].device.name, 'Drucker');
  assert.deepEqual(svc.locate('AA-BB-CC-00-00-01'), { switchId: swId, switchName: 'Core', port: 'Port 1', ifIndex: 1, vlan: 1, seenAt: s.at, macsOnPort: 1 });
  assert.ok(prn);

  let state = { volumes: [{ name: '/volume1', size: 100, used: 95, pct: 95 }], disks: [], raids: [], system: 'normal' };
  svc.setReaderForTests('nas', async () => state);
  await svc.poll(nasId);
  await svc.poll(nasId);
  assert.equal(sent.length, 1);
  assert.match(eventText(sent[0], 'de'), /nas01: Volume \/volume1 zu 95 % voll/);
  assert.equal(svc.problems().length, 1);
  state = { ...state, volumes: [{ name: '/volume1', size: 100, used: 50, pct: 50 }] };
  await svc.poll(nasId);
  assert.equal(sent.length, 2);
  assert.match(eventText(sent[1], 'en'), /nas01: fine again/);
  assert.equal(svc.problems().length, 0);
  await assert.rejects(svc.poll(prn), { code: 'err.snmpType' });
});

test('serial number, model and firmware from SNMP go into empty device fields only', async () => {
  const db = memoryDb();
  const svc = createSnmpDevices({ db, settings: createSettings(db), channels: { notifyIds: async () => [] } });
  const ts = new Date().toISOString();
  const nas = db.prepare("INSERT INTO devices(name,type,ip,model,created_at,updated_at) VALUES('nas01','nas','10.0.0.5','Mein Modell',?,?)").run(ts, ts).lastInsertRowid;
  const sw = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('core','switch','10.0.0.2',?,?)").run(ts, ts).lastInsertRowid;
  svc.setReaderForTests('nas', async () => ({ vendor: 'synology', model: 'DS920+', serial: '2080PDN123456', version: 'DSM 7.2.2-72806', volumes: [], disks: [], raids: [], system: 'normal' }));
  svc.setReaderForTests('switch', async () => ({ ports: [], macs: [], serial: 'N/A', model: 'GS-2310P', firmware: '10.42.0457' }));
  await svc.poll(nas);
  await svc.poll(sw);
  const get = (id) => db.prepare('SELECT serial, model, vendor, os FROM devices WHERE id=?').get(id);
  assert.deepEqual(get(nas), { serial: '2080PDN123456', model: 'Mein Modell', vendor: 'Synology', os: 'DSM 7.2.2-72806' }, 'typed-in model stays');
  assert.deepEqual(get(sw), { serial: '', model: 'GS-2310P', vendor: '', os: '10.42.0457' }, '"N/A" is no serial number');
  const h = db.prepare("SELECT user, detail FROM device_history WHERE device_id=? AND kind='snmp'").all(nas);
  assert.equal(h.length, 1);
  assert.equal(h[0].user, 'SNMP');
  // later polls change nothing (fields are filled now), the history stays quiet
  await svc.poll(nas);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_history WHERE device_id=? AND kind='snmp'").get(nas).n, 1);
});

test('device details follow the device: firmware updates, exchanged hardware, values from earlier polls', async () => {
  const db = memoryDb();
  const svc = createSnmpDevices({ db, settings: createSettings(db), channels: { notifyIds: async () => [] } });
  const now = new Date().toISOString();
  const sw = db.prepare("INSERT INTO devices(name,type,ip,mac,created_at,updated_at) VALUES('core','switch','10.0.0.2','aa:aa:aa:00:00:01',?,?)").run(now, now).lastInsertRowid;
  let state = { ports: [], macs: [], serial: 'SN-OLD-1', model: 'GS-2310P', firmware: '10.42.0457' };
  svc.setReaderForTests('switch', async () => state);
  await svc.poll(sw);
  const get = () => db.prepare('SELECT serial, model, os, mac FROM devices WHERE id=?').get(sw);
  assert.deepEqual(get(), { serial: 'SN-OLD-1', model: 'GS-2310P', os: '10.42.0457', mac: 'aa:aa:aa:00:00:01' });

  // Firmware update: the field still holds what the device reported → kept up to date
  state = { ...state, firmware: '10.50.0100' };
  await svc.poll(sw);
  assert.equal(get().os, '10.50.0100');
  // Typed in by hand: stays
  db.prepare("UPDATE devices SET model='Core-Switch Keller' WHERE id=?").run(sw);
  state = { ...state, model: 'GS-2310P v2' };
  await svc.poll(sw);
  assert.equal(get().model, 'Core-Switch Keller');

  // Exchanged at the same IP: another serial number → hardware fields from the new device, old MAC dropped
  state = { ports: [], macs: [], serial: 'SN-NEW-2', model: 'GS-4530X', firmware: '10.80.0001' };
  await svc.poll(sw);
  assert.deepEqual(get(), { serial: 'SN-NEW-2', model: 'GS-4530X', os: '10.80.0001', mac: null });
  const h = db.prepare("SELECT kind, detail FROM device_history WHERE device_id=? AND kind='replaced'").get(sw);
  assert.deepEqual(JSON.parse(h.detail), { source: 'SNMP', from: 'SN-OLD-1', to: 'SN-NEW-2', mac: 'aa:aa:aa:00:00:01' });
  // … so the next scan takes the new MAC at that address instead of reporting a new device
  const inv = createInventory(db);
  const scan = db.prepare("INSERT INTO scans(kind,status,targets,started_at) VALUES('network','running','[]',?)").run(now).lastInsertRowid;
  const rid = db.prepare("INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status) VALUES(?,'10.0.0.2','bb:bb:bb:00:00:02','','','switch',0.8,'{}','pending')").run(scan).lastInsertRowid;
  inv.applyResult(rid);
  assert.equal(get().mac, 'bb:bb:bb:00:00:02');
  assert.equal(db.prepare('SELECT status FROM scan_results WHERE id=?').get(rid).status, 'changed');
});

test('values polled before the update are taken over at start', () => {
  const db = memoryDb();
  const now = new Date().toISOString();
  const prn = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('Drucker','printer','10.0.0.9',?,?)").run(now, now).lastInsertRowid;
  db.prepare("INSERT INTO printer_status(device_id,at,ok,error,data,alerts) VALUES(?,?,1,'',?,'{}')").run(prn, now, JSON.stringify({ serial: 'E78123', model: 'Brother HL-L2350DW series', supplies: [] }));
  assert.equal(syncStoredFacts(db), 1);
  assert.deepEqual(db.prepare('SELECT serial, model FROM devices WHERE id=?').get(prn), { serial: 'E78123', model: 'Brother HL-L2350DW series' });
  assert.equal(syncStoredFacts(db), 0, 'nothing twice');
});
