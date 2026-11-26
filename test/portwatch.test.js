// Watching network ports beyond switches: NAS, router, firewall by SNMP (IF-MIB) and the network cards of machines with
// the host script - only for devices where someone switched it on (devices.watch_ports). Warnings come from sensors:
// connected, speed dropped, new errors since the last query, load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { portRates } from '../src/portrates.js';
import { createSnmpDevices } from '../src/snmpdevices.js';
import { metricsFor, sensorCheck } from '../src/monitor/sensors.js';
import { cleanNics } from '../src/hostfacts.js';
import { createHosts } from '../src/hosts.js';
import { onDeviceChanged } from '../src/devicechange.js';

const iso = (ms) => new Date(ms).toISOString();
const settings = (over = {}) => { const m = { 'snmpdev.enabled': true, 'snmpdev.interval': 15, 'scan.snmpCommunities': 'public', ...over }; return { get: (k) => m[k] }; };
const port = (o) => ({ ifIndex: 1, name: 'LAN-1', alias: '', status: 'up', admin: 'up', speed: 1000, lag: false, inErrors: 0, outErrors: 0, inOctets: 0, outOctets: 0, ...o });
const sensor = (metric, key, extra = {}) => ({ type: 'sensor', options: JSON.stringify({ metric, key: String(key), label: metric, ...extra }) });

test('port rates: new errors since the last query, also without byte counters; a counter that went back gives none', () => {
  const prev = { ports: [port({ inErrors: 10, outErrors: 2, inOctets: null, outOctets: null }), port({ ifIndex: 2, inErrors: 50 })] };
  const now = { ports: [port({ inErrors: 15, outErrors: 3, inOctets: null, outOctets: null }), port({ ifIndex: 2, inErrors: 4 })] };
  portRates(prev, iso(0), now, iso(300000));
  assert.equal(now.ports[0].newErrors, 6);
  assert.equal(now.ports[1].newErrors, undefined, 'reset of the port: no value rather than a wrong one');
});

test('a router is only queried when its ports are watched - then port state, speed and new errors become sensors', async () => {
  const db = memoryDb();
  const ts = new Date().toISOString();
  const id = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('LANCOM-01','router','10.0.10.1',?,?)").run(ts, ts).lastInsertRowid;
  const snmp = createSnmpDevices({ db, settings: settings(), channels: { notifyIds: async () => [] } });
  let answer = { ports: [port({ inErrors: 3, inOctets: 1e9, outOctets: 2e9 }), port({ ifIndex: 2, name: 'WAN', status: 'down', speed: 0 })], uptime: 1000 };
  let calls = 0;
  snmp.setReaderForTests('ports', async () => { calls++; return structuredClone(answer); });
  assert.equal(await snmp.pollDue(), 0, 'off by default: nothing is asked');
  assert.equal(calls, 0);
  await assert.rejects(snmp.poll(id), { code: 'err.snmpType' });

  db.prepare('UPDATE devices SET watch_ports=1 WHERE id=?').run(id);
  assert.equal(await snmp.pollDue(), 1);
  assert.equal(calls, 1);
  const m = metricsFor(db, id);
  assert.deepEqual(m.filter((x) => x.metric === 'port').map((x) => [x.key, x.value]), [['1', 'up'], ['2', 'down']]);
  assert.deepEqual(m.filter((x) => x.metric === 'portSpeed').map((x) => [x.key, x.value, x.op, x.threshold]), [['1', 1000, 'lt', 1000]]);
  assert.ok(m.some((x) => x.metric === 'portErrorsNew' && x.key === '1'));

  // ten minutes later: 40 new errors, the port down to 100 Mbit/s
  db.prepare('UPDATE snmp_status SET at=? WHERE device_id=?').run(iso(Date.now() - 600000), id);
  answer = { ports: [port({ inErrors: 43, speed: 100, inOctets: 1.1e9, outOctets: 2.1e9 }), port({ ifIndex: 2, name: 'WAN', status: 'down', speed: 0 })], uptime: 1600 };
  await snmp.poll(id);
  const ck = (metric, extra) => sensorCheck(db, { ...sensor(metric, 1, extra), device_id: id });
  const e = ck('portErrorsNew', { op: 'gt', threshold: 0 });
  assert.equal(e.ok, false, JSON.stringify(e));
  const sp = ck('portSpeed', { op: 'lt', threshold: 1000 });
  assert.equal(sp.ok, false, JSON.stringify(sp));
  assert.match(ck('portLoad', { op: 'ge', threshold: 80 }).message, /%/);
});

test('a NAS whose ports are watched gets its ports read along; without it nothing changes', async () => {
  const db = memoryDb();
  const ts = new Date().toISOString();
  const id = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('NAS-01','nas','10.0.10.5',?,?)").run(ts, ts).lastInsertRowid;
  const snmp = createSnmpDevices({ db, settings: settings(), channels: { notifyIds: async () => [] } });
  snmp.setReaderForTests('nas', async () => ({ volumes: [{ name: 'Volume 1', pct: 40 }] }));
  let asked = 0;
  snmp.setReaderForTests('ports', async () => { asked++; return { ports: [port({ name: 'LAN 1' })], uptime: 5 }; });
  await snmp.poll(id);
  assert.equal(asked, 0);
  assert.ok(!metricsFor(db, id).some((x) => x.metric === 'port'));
  db.prepare('UPDATE devices SET watch_ports=1 WHERE id=?').run(id);
  await snmp.poll(id);
  assert.equal(asked, 1);
  const m = metricsFor(db, id);
  assert.ok(m.some((x) => x.metric === 'volume') && m.some((x) => x.metric === 'port'));
  // switched off: the ports read go
  const before = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  db.prepare('UPDATE devices SET watch_ports=0 WHERE id=?').run(id);
  onDeviceChanged(db, before, { ...before, watch_ports: 0 }, 'manual', { ts });
  assert.ok(!metricsFor(db, id).some((x) => x.metric === 'port'));
});

test('network cards from the host script: checked and cut to size', () => {
  const n = cleanNics([{ name: 'Ethernet', up: true, speed: 1000, rxBytes: 5, txBytes: 6, rxErrors: 1, txErrors: -3 }, { name: 'ethernet' }, { name: '' }, 'x',
    ...Array.from({ length: 40 }, (_, i) => ({ name: `eth${i}`, up: 1, speed: 'viel' }))]);
  assert.deepEqual(n[0], { ifIndex: 'Ethernet', name: 'Ethernet', alias: '', status: 'up', speed: 1000, inErrors: 1, outErrors: 0, inOctets: 5, outOctets: 6 });
  assert.ok(n.length <= 32);
  assert.equal(n.find((x) => x.name === 'eth0').speed, 0);
});

test('host script: network cards are kept only for watched machines, then with load and new errors', () => {
  const db = memoryDb();
  const ts = new Date().toISOString();
  const id = db.prepare("INSERT INTO devices(name,type,hostname,created_at,updated_at) VALUES('PC-0001','server','pc-0001',?,?)").run(ts, ts).lastInsertRowid;
  const hosts = createHosts({ db });
  const { token } = hosts.create({ name: 'PC-0001', os: 'linux', device_id: id }, { server: 'https://womn.firma.local' });
  const report = (o) => ({ hostname: 'pc-0001', os: 'Debian GNU/Linux 12', uptime: 1000, nics: [{ name: 'eth0', up: 1, speed: 1000, rxBytes: 1e6, txBytes: 2e6, rxErrors: 0, txErrors: 0, ...o }] });
  hosts.push(token, report());
  assert.equal(JSON.parse(db.prepare('SELECT data FROM host_reports WHERE device_id=?').get(id).data).nics, undefined, 'not watched: not kept');
  db.prepare('UPDATE devices SET watch_ports=1 WHERE id=?').run(id);
  hosts.push(token, report());
  db.prepare('UPDATE host_reports SET at=? WHERE device_id=?').run(iso(Date.now() - 300000), id);
  hosts.push(token, report({ rxBytes: 1e6 + 37.5e6, rxErrors: 12, uptime: 1300 }));
  const m = metricsFor(db, id);
  const nm = (metric) => m.find((x) => x.metric === metric && x.key === 'eth0');
  assert.equal(nm('portErrorsNew').value, 12);
  assert.ok(nm('portLoad').value > 0);
  assert.equal(nm('portSpeed').value, 1000);
});
