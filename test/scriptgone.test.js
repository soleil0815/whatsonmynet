// A machine whose script has been silent for a day (removed, most likely): not offered for new sensors any more, its
// page asks what happened, and "Remove script data" brings back the tip "Monitor by script". Sensors that already
// watch its values keep them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { cleanReport, reportGone, GONE_HOURS } from '../src/hosts.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());

let pc; let srv;
const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const report = (id, at) => db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET at=excluded.at, data=excluded.data')
  .run(id, at, JSON.stringify(cleanReport({ hostname: `pc-${id}`, os: 'Windows 11', cpu: 5, memTotal: 100, memUsed: 40 })));

test('setup: two machines with the script, one silent for two days', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  const at = new Date().toISOString();
  const add = (name, ip) => db.prepare("INSERT INTO devices(name,type,ip,os,created_at,updated_at) VALUES(?,'computer',?,'Windows 11',?,?)").run(name, ip, at, at).lastInsertRowid;
  pc = add('PC-0001', '10.0.10.21');
  srv = add('PC-0002', '10.0.10.22');
  report(pc, ago(0.1));
  report(srv, ago(48));
  db.prepare("INSERT INTO host_tokens(name,os,device_id,token_hash,created_at) VALUES('PC-0002','windows',?,'x',?)").run(srv, at);
});

test('reportGone: after a day, a missing time counts as gone', () => {
  assert.equal(reportGone(ago(GONE_HOURS - 1)), false);
  assert.equal(reportGone(ago(GONE_HOURS + 1)), true);
  assert.equal(reportGone(undefined), true);
});

test('the silent machine is not offered for new sensors', async () => {
  const s = await call('GET', '/api/sensors/sources');
  const ids = s.data.devices.map((d) => d.id);
  assert.ok(ids.includes(pc));
  assert.ok(!ids.includes(srv));
  assert.deepEqual(ctx.hosts.deviceIds(), [pc]);
  assert.equal((await call('GET', `/api/sensors/choices?device=${srv}`)).data.length, 0);
  assert.ok((await call('GET', `/api/sensors/choices?device=${pc}`)).data.length > 0);
  const d = (await call('GET', `/api/devices/${srv}`)).data;
  assert.equal(d.host.gone, true);
  assert.equal(d.hasSensors, false);
  const fresh = (await call('GET', `/api/devices/${pc}`)).data;
  assert.equal(fresh.host.gone, false);
  assert.equal(fresh.hasSensors, true);
});

test('a sensor that already watches a value keeps it (offered to that sensor only)', async () => {
  const at = new Date().toISOString();
  const id = db.prepare("INSERT INTO monitors(name,type,target,device_id,options,interval_s,created_at,updated_at) VALUES('CPU','sensor','',?,?,300,?,?)")
    .run(srv, JSON.stringify({ metric: 'hostCpu', key: '' }), at, at).lastInsertRowid;
  const l = (await call('GET', `/api/sensors/choices?device=${srv}`)).data;
  assert.deepEqual(l.map((x) => [x.metric, x.taken]), [['hostCpu', Number(id)]]);
  db.prepare('DELETE FROM monitors WHERE id=?').run(id);
});

test('"Remove script data": report and own key go, the page offers the script again', async () => {
  assert.equal((await call('DELETE', `/api/devices/${srv}/host-report`)).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM host_reports WHERE device_id=?').get(srv), undefined);
  assert.equal(db.prepare('SELECT 1 FROM host_tokens WHERE device_id=?').get(srv), undefined);
  const d = (await call('GET', `/api/devices/${srv}`)).data;
  assert.equal(d.host, null);
  assert.equal(d.hostScript, null);
  assert.equal((await call('DELETE', '/api/devices/99999/host-report')).status, 404);
});

test('deleting the script of a single machine drops its last report too; a shared key leaves reports alone', async () => {
  const at = new Date().toISOString();
  const own = db.prepare("INSERT INTO host_tokens(name,os,device_id,token_hash,created_at) VALUES('PC-0001','windows',?,'y',?)").run(pc, at).lastInsertRowid;
  assert.equal((await call('DELETE', `/api/hosts/${own}`)).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM host_reports WHERE device_id=?').get(pc), undefined);
  report(pc, at);
  const shared = db.prepare("INSERT INTO host_tokens(name,os,device_id,token_hash,created_at) VALUES('Alle','windows',NULL,'z',?)").run(at).lastInsertRowid;
  assert.equal((await call('DELETE', `/api/hosts/${shared}`)).status, 200);
  assert.ok(db.prepare('SELECT 1 FROM host_reports WHERE device_id=?').get(pc));
  assert.equal((await call('DELETE', '/api/hosts/99999')).status, 404);
});

test('a sensor on removed script data says so (not "device missing")', async () => {
  const { sensorCheck } = await import('../src/monitor/sensors.js');
  const r = sensorCheck(db, { device_id: srv, options: JSON.stringify({ metric: 'hostCpu', key: '' }) });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'script data removed');
  assert.equal(sensorCheck(db, { device_id: 99999, options: JSON.stringify({ metric: 'hostCpu', key: '' }) }).message, 'device missing');
});
