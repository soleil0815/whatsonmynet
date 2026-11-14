// One sensor list, whichever way it is opened: a Proxmox node that is also a device shows the values of Proxmox and of
// the Linux script on it together - from the device in the inventory and from the host under Virtualization alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { cleanReport } from '../src/hosts.js';
import { createSensorChoices } from '../src/monitor/choices.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());

let pve2; let other; let host;
test('setup: cluster with pve1 and pve2, pve2 runs the Linux script', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  const at = new Date().toISOString();
  const add = (name, hostname, ip) => db.prepare("INSERT INTO devices(name,type,hostname,ip,created_at,updated_at) VALUES(?,'server',?,?,?,?)").run(name, hostname, ip, at, at).lastInsertRowid;
  pve2 = add('pve2', 'pve2.firma.local', '10.0.10.12');
  other = add('fileserver', 'fs01.firma.local', '10.0.10.30');
  const temps = [{ chip: 'coretemp', dev: 'coretemp.0', name: 'Package id 0', mC: 52000, maxMC: 80000, critMC: 100000 },
    { chip: 'nvme', dev: 'nvme0', name: 'Sensor 2', mC: 61000 }];
  db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?)').run(pve2, at, JSON.stringify(cleanReport({ hostname: 'pve2', cpu: 5, mem: 40, temps })));
  host = db.prepare("INSERT INTO proxmox_hosts(name,kind,url,token_id,secret,verify,created_at,last_at,last_ok,data) VALUES('Cluster','pve','https://10.0.10.11:8006','a@pve!b','x',1,?,?,1,?)")
    .run(at, at, JSON.stringify({ kind: 'pve',
      nodes: [{ name: 'pve1', online: true, cpu: 3, mem: 20 }, { name: 'pve2', online: true, cpu: 6, mem: 41 }],
      storages: [{ node: 'pve2', name: 'local-zfs', pct: 30 }, { node: 'pve1', name: 'local', pct: 10 }],
      guests: [{ vmid: 101, name: 'dc01', status: 'running', node: 'pve2' }], backups: [] })).lastInsertRowid;
});

const sig = (x) => `${x.src}:${x.device ?? x.host}:${x.metric}:${x.key}`;

test('from the device: script values and the node values of Proxmox - CPU, RAM and the hottest only once', () => {
  const c = createSensorChoices({ db, settings: ctx.settings });
  const l = c.forDevice(pve2);
  const m = l.map((x) => `${x.src}:${x.metric}:${x.key}`);
  assert.ok(m.includes('device:hostTemp:nvme/nvme0/Sensor 2'));
  assert.ok(m.includes('device:hostTempMax:'));
  assert.ok(m.includes('host:nodeOnline:pve2'));
  assert.ok(m.includes('host:storage:pve2/local-zfs'));
  for (const twin of ['nodeCpu', 'nodeMem', 'nodeTemp']) assert.ok(!m.some((x) => x.startsWith(`host:${twin}:`)), twin);
  // nothing of the other node, no VMs (they move between nodes)
  assert.ok(!m.some((x) => x.includes('pve1')));
  assert.ok(!m.some((x) => x.includes('guestRunning')));
  // a device that is no node gets no hypervisor values; a limited user gets none either
  assert.ok(!c.forDevice(other).some((x) => x.src === 'host'));
  assert.ok(!c.forDevice(pve2, { withHosts: false }).some((x) => x.src === 'host'));
});

test('from the host: one group per node - for pve2 exactly the same values as at the device', () => {
  const c = createSensorChoices({ db, settings: ctx.settings });
  const l = c.forHost(host);
  const node2 = l.filter((x) => x.group === 'node:pve2').map(sig).sort();
  assert.deepEqual(node2, c.forDevice(pve2).map(sig).sort());
  // pve1 has no script: CPU and RAM from Proxmox
  assert.deepEqual(l.filter((x) => x.group === 'node:pve1').map((x) => x.metric), ['nodeOnline', 'nodeCpu', 'nodeMem', 'storage']);
  assert.ok(l.some((x) => x.metric === 'guestRunning' && !x.group));
  // the device list offers the node, even without printer/NAS type
  assert.ok(c.deviceIds().has(pve2));
  assert.ok(!c.deviceIds().has(other));
});

test('API: sources and choices; a sensor at the hypervisor can be moved to a single sensor of the node', async () => {
  const src = (await call('GET', '/api/sensors/sources')).data;
  assert.deepEqual(src.devices.map((d) => d.name), ['pve2']);
  assert.deepEqual(src.hosts.map((x) => x.name), ['Cluster']);
  assert.ok((await call('GET', `/api/devices/${pve2}`)).data.hasSensors);
  assert.equal((await call('GET', `/api/devices/${other}`)).data.hasSensors, false);
  // the old way: "Temperatur pve2" at the host
  const mon = (await call('POST', '/api/monitors', { name: 'Temperatur pve2', type: 'proxmox', interval_s: 300, options: { host, metric: 'nodeTemp', key: 'pve2', op: 'ge', threshold: 80, label: 'Temperatur pve2' } })).data;
  assert.equal(mon.device_id, null);
  // moved to the NVMe sensor of the device
  const r = await call('PUT', `/api/monitors/${mon.id}`, { name: 'pve2: NVMe', type: 'sensor', device_id: pve2, options: { metric: 'hostTemp', key: 'nvme/nvme0/Sensor 2', op: 'ge', threshold: 70, label: 'Temperatur: NVMe nvme0 Sensor 2' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.type, 'sensor');
  assert.equal(r.data.device_id, pve2);
  assert.equal(r.data.options.key, 'nvme/nvme0/Sensor 2');
  // and back to a hypervisor value: no longer tied to the device
  const b = await call('PUT', `/api/monitors/${mon.id}`, { name: 'pve2 online', type: 'proxmox', options: { host, metric: 'nodeOnline', key: 'pve2', label: 'Knoten pve2 online' } });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.device_id, null);
});

test('a user limited to locations: only devices of his locations, no hypervisors, cannot move a sensor elsewhere', async () => {
  const la = (await call('POST', '/api/locations', { name: 'A', subnets: ['10.77.1.0/24'] })).data;
  const at = new Date().toISOString();
  const mine = db.prepare("INSERT INTO devices(name,type,ip,location_id,created_at,updated_at) VALUES('Drucker A','printer','10.77.1.9',?,?,?)").run(la.id, at, at).lastInsertRowid;
  await call('POST', '/api/users', { username: 'seg', password: 'Standort-A-1234', role: 'editor', locations: [la.id] });
  assert.equal((await call('POST', '/api/login', { username: 'seg', password: 'Standort-A-1234' }, { who: 'seg' })).status, 200);
  const src = (await call('GET', '/api/sensors/sources', undefined, { who: 'seg' })).data;
  assert.deepEqual(src.devices.map((d) => d.id), [mine]);
  assert.deepEqual(src.hosts, []);
  assert.equal((await call('GET', `/api/sensors/choices?host=${host}`, undefined, { who: 'seg' })).status, 403);
  assert.equal((await call('GET', `/api/sensors/choices?device=${pve2}`, undefined, { who: 'seg' })).status, 404);
  const mon = (await call('POST', '/api/monitors', { name: 'Fehler', type: 'sensor', device_id: mine, options: { metric: 'printerErrors', key: '' } }, { who: 'seg' })).data;
  assert.ok(mon.id, JSON.stringify(mon));
  const r = await call('PUT', `/api/monitors/${mon.id}`, { type: 'sensor', device_id: pve2, options: { metric: 'hostTempMax', key: '' } }, { who: 'seg' });
  assert.equal(r.status, 403);
});

test('after the update: sensors are named after their value once (the old "Temperatur pve2" says what it watches)', async () => {
  const { nameSensorsByValue, nameSensorsOnce } = await import('../src/monitor/sensornames.js');
  const at = new Date().toISOString();
  const ins = db.prepare('INSERT INTO monitors(name,type,target,device_id,interval_s,timeout_s,fail_threshold,options,status,created_at,updated_at) VALUES(?,?,?,?,300,10,1,?,?,?,?)');
  // value changed earlier, name kept: device sensor on the NVMe, still called after the hottest of the node
  const a = ins.run('Temperatur pve2', 'sensor', 'Temperatur', pve2, JSON.stringify({ metric: 'hostTemp', key: 'nvme/nvme0/Sensor 2', op: 'ge', threshold: 70, label: 'Temperatur' }), 'up', at, at).lastInsertRowid;
  const b = ins.run('Knoten', 'proxmox', 'x', null, JSON.stringify({ host, metric: 'nodeCpu', key: 'pve1', op: 'ge', threshold: 90, label: 'CPU pve1' }), 'down', at, at).lastInsertRowid;
  // a value that is gone and has no label: stays as it is
  const c = ins.run('Mein Name', 'sensor', '', pve2, JSON.stringify({ metric: 'hostTemp', key: 'weg', op: 'ge', threshold: 70 }), 'up', at, at).lastInsertRowid;
  const s = ctx.settings;
  s.set('sensors.namedByValue', false);
  const before = nameSensorsOnce(db, s);
  assert.ok(before >= 2);
  const row = (id) => db.prepare('SELECT name, target, status, options FROM monitors WHERE id=?').get(id);
  assert.equal(row(a).name, 'pve2: Temperatur: NVMe nvme0 Sensor 2');
  assert.equal(JSON.parse(row(a).options).label, 'Temperatur: NVMe nvme0 Sensor 2');
  assert.equal(row(a).status, 'up');
  assert.equal(row(b).name, 'CPU pve1');
  assert.equal(row(b).status, 'down');
  assert.equal(row(c).name, 'Mein Name');
  // once only: a name typed afterwards stays
  db.prepare("UPDATE monitors SET name='Eigener Name' WHERE id=?").run(a);
  assert.equal(nameSensorsOnce(db, s), 0);
  assert.equal(row(a).name, 'Eigener Name');
  assert.equal(nameSensorsByValue(db) >= 1, true);
});

test('values a sensor already watches are marked as taken - also the script twin of a node value', async () => {
  for (const m of db.prepare("SELECT id FROM monitors WHERE type IN ('sensor','proxmox')").all()) await call('DELETE', `/api/monitors/${m.id}`);
  const nvme = (await call('POST', '/api/monitors', { name: 'pve2: NVMe', type: 'sensor', device_id: pve2, interval_s: 300, options: { metric: 'hostTemp', key: 'nvme/nvme0/Sensor 2', op: 'ge', threshold: 70, label: 'Temperatur: NVMe nvme0 Sensor 2' } })).data;
  // the old way: the hottest temperature of pve2 at the hypervisor - the script delivers the same value
  const hot = (await call('POST', '/api/monitors', { name: 'Temperatur pve2', type: 'proxmox', interval_s: 300, options: { host, metric: 'nodeTemp', key: 'pve2', op: 'ge', threshold: 80, label: 'Temperatur pve2' } })).data;
  const online = (await call('POST', '/api/monitors', { name: 'pve2 online', type: 'proxmox', interval_s: 300, options: { host, metric: 'nodeOnline', key: 'pve2', label: 'Knoten pve2 online' } })).data;
  const l = (await call('GET', `/api/sensors/choices?device=${pve2}`)).data;
  const taken = (metric, key = '') => l.find((x) => x.metric === metric && String(x.key) === key)?.taken;
  assert.equal(taken('hostTemp', 'nvme/nvme0/Sensor 2'), nvme.id);
  assert.equal(taken('hostTempMax'), hot.id);
  assert.equal(taken('nodeOnline', 'pve2'), online.id);
  assert.equal(taken('hostCpu'), undefined);
  // from the host the same
  const lh = (await call('GET', `/api/sensors/choices?host=${host}`)).data;
  assert.equal(lh.find((x) => x.metric === 'nodeOnline' && x.key === 'pve2').taken, online.id);
  assert.equal(lh.find((x) => x.metric === 'nodeOnline' && x.key === 'pve1').taken, undefined);
  // the dialog leaves taken values out, except the one of the sensor being edited
  const src = (await import('node:fs')).readFileSync(new URL('../public/js/views/monitoring.js', import.meta.url), 'utf8');
  assert.match(src, /choices\.filter\(\(x\) => !x\.taken \|\| \(m && x\.taken === m\.id\)/);
});
