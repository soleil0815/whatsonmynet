import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { buildTopology } from '../src/topology.js';
import { parseArp } from '../src/scan/routerarp.js';

test('router ARP table (ipNetToMedia and ipNetToPhysical)', () => {
  const media = new Map([['3.10.1.2.5', Buffer.from('001122334455', 'hex')], ['3.10.1.2.6', Buffer.from('00', 'hex')]]);
  const phys = new Map([['3.1.4.10.1.2.7', Buffer.from('aabbccddeeff', 'hex')], ['3.2.16.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1', Buffer.from('aabbccddee01', 'hex')]]);
  assert.deepEqual([...parseArp(media, phys)], [['10.1.2.5', '00:11:22:33:44:55'], ['10.1.2.7', 'aa:bb:cc:dd:ee:ff']]);
});

test('topology: devices at edge ports, switches linked by MAC and LLDP, root at the router', () => {
  const db = memoryDb();
  const ts = new Date().toISOString();
  const add = (name, type, mac, hostname = '') => db.prepare('INSERT INTO devices(name,type,mac,hostname,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(name, type, mac, hostname, ts, ts).lastInsertRowid;
  const core = add('core', 'switch', '02:00:00:00:00:01');
  const floor = add('floor', 'switch', '02:00:00:00:00:02');
  const lab = add('lab-sw', 'switch', '02:00:00:00:00:03', 'lab-sw.firma.local');
  const router = add('Router', 'router', '02:00:00:00:00:10');
  const pc = add('PC', 'computer', '02:00:00:00:00:20');
  const printer = add('Drucker', 'printer', '02:00:00:00:00:21');
  add('Laptop WLAN', 'computer', '02:00:00:00:00:99');
  const mac = (sw, m, ifIndex, port) => db.prepare('INSERT INTO switch_macs(switch_id,mac,if_index,port,vlan,seen_at) VALUES(?,?,?,?,1,?)').run(sw, m, ifIndex, port, ts);
  // core: router on 1, uplink to floor on 24 (sees floor + everything behind it)
  mac(core, '02:00:00:00:00:10', 1, 'Port 1');
  for (const m of ['02:00:00:00:00:02', '02:00:00:00:00:20', '02:00:00:00:00:21']) mac(core, m, 24, 'Port 24');
  // floor: PC and printer on own ports, uplink to core on 1
  mac(floor, '02:00:00:00:00:20', 5, 'Port 5');
  mac(floor, '02:00:00:00:00:21', 6, 'Port 6');
  for (const m of ['02:00:00:00:00:10', '02:00:00:00:00:01']) mac(floor, m, 1, 'Port 1');
  // lab switch only known through LLDP of core
  db.prepare("INSERT INTO snmp_status(device_id,kind,at,ok,data) VALUES(?,'switch',?,1,?)").run(core, ts, JSON.stringify({ ports: [{ status: 'up' }], neighbours: [{ localNum: 3, localPort: 'Port 3', name: 'LAB-SW', port: 'gi0/1' }] }));
  const t = buildTopology(db);
  assert.equal(t.roots.length, 1);
  const root = t.roots[0];
  assert.equal(root.name, 'core');
  assert.deepEqual(root.ports.map((p) => [p.port, p.devices.map((d) => d.name)]), [['Port 1', ['Router']]]);
  const kids = Object.fromEntries(root.children.map((c) => [c.name, c]));
  assert.equal(kids['lab-sw'].via.kind, 'lldp');
  assert.equal(kids.floor.via.port, 'Port 24');
  assert.deepEqual(kids.floor.ports.map((p) => [p.port, p.devices.map((d) => d.name)]), [['Port 5', ['PC']], ['Port 6', ['Drucker']]]);
  assert.deepEqual(t.unplaced.map((d) => d.name), ['Laptop WLAN']);
  assert.ok(pc && printer && lab && router);
  // Location limit: a user without the locations sees nothing
  assert.equal(buildTopology(db, { allowed: new Set([999]) }).roots.length, 0);
});
