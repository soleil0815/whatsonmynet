import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { compare, metricsFor, sensorCheck, snmpCheck, validOid } from '../src/monitor/sensors.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';
import { createSettings } from '../src/settings.js';
import { startAgent } from './fixtures/switch-agent.js';

test('conditions and OIDs', () => {
  assert.ok(compare('lt', 9, '10') && !compare('lt', 10, '10') && compare('le', 10, '10'));
  assert.ok(compare('gt', '55', 50) && compare('eq', 'up', 'up') && compare('contains', 'On Battery', 'battery'));
  assert.ok(!compare('gt', 'abc', 5), 'text is not a number');
  assert.ok(validOid('1.3.6.1.2.1.1.3.0') && validOid('.1.3.6.1.4.1.6574.1.2.0') && !validOid('1.3') && !validOid('abc'));
});

function setup() {
  const db = memoryDb();
  const ts = new Date().toISOString();
  const add = (name, type) => db.prepare('INSERT INTO devices(name,type,created_at,updated_at) VALUES(?,?,?,?)').run(name, type, ts, ts).lastInsertRowid;
  const prn = add('Drucker', 'printer');
  const nas = add('nas01', 'nas');
  const sw = add('core', 'switch');
  db.prepare('INSERT INTO printer_status(device_id,at,ok,data) VALUES(?,?,1,?)').run(prn, ts, JSON.stringify({ pages: 500, errors: [], supplies: [{ key: '1.1', description: 'Toner Cyan', type: 'toner', color: 'cyan', pct: 9, state: 'ok' }] }));
  db.prepare("INSERT INTO snmp_status(device_id,kind,at,ok,data) VALUES(?,'nas',?,1,?)").run(nas, ts, JSON.stringify({ temp: 48, volumes: [{ name: '/volume1', pct: 86 }], disks: [{ name: 'Drive 1', status: 'normal', bad: false, temp: 36 }, { name: 'Drive 2', status: 'crashed', bad: true }], raids: [], system: 'normal', fan: 'normal', power: 'normal' }));
  db.prepare("INSERT INTO snmp_status(device_id,kind,at,ok,data) VALUES(?,'switch',?,1,?)").run(sw, ts, JSON.stringify({ ports: [{ ifIndex: 10, name: '10', alias: 'Uplink', status: 'down', inErrors: 0 }, { ifIndex: 1, name: '1', status: 'up', speed: 1000, inErrors: 0 }] }));
  return { db, prn, nas, sw };
}

test('metrics of a device and sensor checks on stored values', () => {
  const { db, prn, nas, sw } = setup();
  const pm = metricsFor(db, prn);
  assert.deepEqual(pm.map((x) => x.metric), ['supply', 'printerErrors', 'pages']);
  const mon = (deviceId, options) => ({ device_id: deviceId, options: JSON.stringify(options) });
  assert.deepEqual(sensorCheck(db, mon(prn, { metric: 'supply', key: '1.1', op: 'le', threshold: '10', label: 'Cyan' })), { ok: false, ms: 9, message: 'Cyan: 9 % (≤ 10)' });
  assert.equal(sensorCheck(db, mon(prn, { metric: 'supply', key: '1.1', op: 'le', threshold: '5' })).ok, true);
  assert.equal(sensorCheck(db, mon(prn, { metric: 'printerErrors' })).ok, true);
  assert.equal(sensorCheck(db, mon(nas, { metric: 'volume', key: '/volume1', op: 'ge', threshold: '85' })).ok, false);
  assert.equal(sensorCheck(db, mon(nas, { metric: 'temp', op: 'gt', threshold: '50' })).ms, 48);
  assert.equal(sensorCheck(db, mon(nas, { metric: 'disk', key: 'Drive 2' })).ok, false);
  assert.equal(sensorCheck(db, mon(nas, { metric: 'health' })).ok, true);
  assert.equal(sensorCheck(db, mon(sw, { metric: 'port', key: '10', label: 'Uplink' })).ok, false);
  assert.equal(sensorCheck(db, mon(sw, { metric: 'port', key: '1' })).ms, 1000);
  // old data counts as failure
  db.prepare('UPDATE printer_status SET at=?').run(new Date(Date.now() - 6 * 3600 * 1000).toISOString());
  assert.equal(sensorCheck(db, mon(prn, { metric: 'pages', op: 'ge', threshold: '1000' })).message, 'no current data');
});

test('sensor and SNMP monitors are created, checked and graphed', async () => {
  const { db, prn } = setup();
  const settings = createSettings(db);
  const monitoring = createMonitoring({ db, channels: { notify: async () => [] }, maintenance: createMaintenance(db), settings });
  await assert.rejects(monitoring.create({ name: 'x', type: 'sensor', options: { metric: 'supply', op: 'le', threshold: 10 } }), { code: 'err.sensorDevice' });
  await assert.rejects(monitoring.create({ name: 'x', type: 'sensor', device_id: prn, options: { metric: 'nope' } }), { code: 'err.sensorMetric' });
  const s = await monitoring.create({ name: 'Cyan', type: 'sensor', device_id: prn, options: { metric: 'supply', key: '1.1', op: 'le', threshold: '10', label: 'Toner Cyan' } });
  assert.equal(s.target, 'Toner Cyan');
  const r = await monitoring.checkNow(s.id);
  assert.equal(r.last_ms, 9);
  assert.match(r.last_message, /Toner Cyan: 9 %/);
  await assert.rejects(monitoring.create({ name: 'x', type: 'snmp', target: '127.0.0.1', options: { oid: 'abc', op: 'gt', threshold: 1 } }), { code: 'err.oid' });
  const agent = startAgent(16164);
  try {
    const n = await monitoring.create({ name: 'Descr', type: 'snmp', target: '127.0.0.1', port: 16164, options: { oid: '1.3.6.1.2.1.1.1.0', op: 'notcontains', threshold: 'Fake' } });
    const c = await monitoring.checkNow(n.id);
    assert.match(c.last_message, /Fake device/);
    const direct = await snmpCheck('127.0.0.1', 16164, ['public'], { oid: '1.3.6.1.2.1.1.1.0', op: 'contains', threshold: 'fake' });
    assert.equal(direct.ok, false, 'alarm when the text is contained');
  } finally { agent.close(); }
});
