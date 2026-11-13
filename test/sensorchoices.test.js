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
