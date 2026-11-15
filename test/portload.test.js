// Load of switch ports from the 64-bit byte counters: bit/s and percent between two polls, no value instead of a wrong
// one (switch restarted, counter went back, poll too short or too old), the sensor and its German text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { portRates } from '../src/snmpdevices.js';
import { sensorCheck, metricsFor, bitRate } from '../src/monitor/sensors.js';
import { checkText } from '../public/js/checktext.js';

const GB = 1e9 / 8;
const port = (ifIndex, inOctets, outOctets, extra = {}) => ({ ifIndex, name: `Gi1/0/${ifIndex}`, status: 'up', speed: 1000, inOctets, outOctets, inErrors: 0, ...extra });

test('rates between two polls 15 minutes apart', () => {
  const prev = { uptime: 1000, ports: [port(1, 0, 0), port(2, 5e9, 1e9), port(3, 100, 100), port(4, null, null)] };
  // port 1: 0.8 Gbit/s in for 900 s = 90 GB, port 2: little, port 3: counter went back, port 4: no counters
  const next = { uptime: 91000, ports: [port(1, 0.8 * GB * 900, 0.1 * GB * 900), port(2, 5e9 + 1125000, 1e9), port(3, 50, 200), port(4, null, null), port(5, 1, 1)] };
  portRates(prev, '2026-11-15T10:00:00.000Z', next, '2026-11-15T10:15:00.000Z');
  const [p1, p2, p3, p4, p5] = next.ports;
  assert.deepEqual([p1.inBps, p1.outBps, p1.inPct, p1.outPct, p1.loadPct], [8e8, 1e8, 80, 10, 80]);
  assert.deepEqual([p2.inBps, p2.inPct, p2.loadPct], [10000, 0, 0]);
  assert.equal(p3.loadPct, undefined, 'a counter that went back gives no value');
  assert.equal(p4.loadPct, undefined);
  assert.equal(p5.loadPct, undefined, 'a new port has no previous value');
  assert.equal(next.rateSeconds, 900);
});

test('no rates after a restart of the switch, nor from a poll too short or too old', () => {
  const prev = { uptime: 500000, ports: [port(1, 0, 0)] };
  const restarted = { uptime: 300, ports: [port(1, 1e6, 1e6)] };
  portRates(prev, '2026-11-15T10:00:00.000Z', restarted, '2026-11-15T10:15:00.000Z');
  assert.equal(restarted.ports[0].inBps, undefined);
  for (const at of ['2026-11-15T10:00:10.000Z', '2026-11-15T20:00:00.000Z']) {
    const n = { uptime: 600000, ports: [port(1, 1e6, 1e6)] };
    portRates(prev, '2026-11-15T10:00:00.000Z', n, at);
    assert.equal(n.ports[0].inBps, undefined, at);
  }
});

test('sensor: offered once the load is known, alarms above the limit, quiet for a port that is down', () => {
  const db = memoryDb();
  const id = db.prepare("INSERT INTO devices(name, ip, type, created_at, updated_at) VALUES('sw-core','10.0.0.2','switch',?,?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  const data = { ports: [port(1, 0, 0, { inBps: 8.5e8, outBps: 2e7, inPct: 85, outPct: 2, loadPct: 85 }), port(2, 0, 0, { status: 'down' }), port(3, 0, 0)] };
  db.prepare("INSERT INTO snmp_status(device_id, kind, at, ok, data) VALUES(?, 'switch', ?, 1, ?)").run(id, new Date().toISOString(), JSON.stringify(data));
  const offered = metricsFor(db, id).filter((x) => x.metric === 'portLoad');
  assert.deepEqual(offered.map((x) => [x.key, x.value, x.threshold]), [['1', 85, 80]]);
  const chk = (key, status = 'up') => sensorCheck(db, { device_id: id, status, options: JSON.stringify({ metric: 'portLoad', key, op: 'ge', threshold: 80, label: `Port ${key}` }) });
  const busy = chk('1');
  assert.equal(busy.ok, false);
  assert.equal(busy.message, 'Port 1: 85 % (in 850 Mbit/s, out 20 Mbit/s) (≥ 80)');
  assert.equal(checkText('Port 1: 85.5 % (in 850.3 Mbit/s, out 20 Mbit/s)'), 'Port 1: 85,5 % (ein 850,3 Mbit/s, aus 20 Mbit/s)');
  const down = chk('2');
  assert.deepEqual([down.ok, down.message], [true, 'Port 2: no traffic (port down)']);
  assert.equal(checkText(down.message), 'Port 2: kein Verkehr (Port getrennt)');
  const later = chk('3');
  assert.deepEqual([later.ok, later.message], [true, 'Port 3: measuring - value after the next query']);
  assert.equal(chk('9').message, 'Port 9: not found');
  assert.equal(bitRate(1500), '1.5 kbit/s');
  assert.equal(bitRate(2.5e9), '2.5 Gbit/s');
});
