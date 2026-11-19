// A device in a maintenance window shows it - "maintenance until 10:00" - so a backup system switched off at night by
// plan does not look like an outage: in the monitor list, on the device, in the inventory and on the overview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { windowEnd } from '../src/monitor/maintenance.js';

const app = await startApp();
const { call, db, ctx } = app;
test.after(() => app.close());

test('until when a window holds: once, weekly, across midnight', () => {
  const at = (s) => new Date(s); // local time of the test process
  const night = { kind: 'weekly', weekdays: '[0,1,2,3,4,5,6]', time_from: '18:00', time_to: '10:00' };
  assert.equal(windowEnd(night, at('2026-11-19T19:30:00')).getTime(), at('2026-11-20T10:00:00').getTime(), 'started this evening: ends tomorrow');
  assert.equal(windowEnd(night, at('2026-11-20T06:15:00')).getTime(), at('2026-11-20T10:00:00').getTime(), 'after midnight: ends today');
  assert.equal(windowEnd({ kind: 'weekly', time_from: '08:00', time_to: '12:00' }, at('2026-11-19T09:00:00')).getTime(), at('2026-11-19T12:00:00').getTime());
  assert.equal(windowEnd({ kind: 'once', ends_at: '2026-11-21T08:00:00.000Z' }).toISOString(), '2026-11-21T08:00:00.000Z');
});

let dev; let mon; let other;
test('setup: a backup NAS with a monitor, a window around the clock (so it holds now)', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  const at = new Date().toISOString();
  dev = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('BACKUP-NAS','nas','10.0.10.40',?,?)").run(at, at).lastInsertRowid;
  const two = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('PC-0001','computer','10.0.10.41',?,?)").run(at, at).lastInsertRowid;
  const r1 = await call('POST', '/api/monitors', { name: 'Backup-NAS Ping', type: 'tcp', target: '10.0.10.40', port: 445, device_id: dev });
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  mon = r1.data.id;
  other = (await call('POST', '/api/monitors', { name: 'PC Ping', type: 'tcp', target: '10.0.10.41', port: 3389, device_id: two })).data.id;
  db.prepare("UPDATE monitors SET status='down' WHERE id IN (?,?)").run(mon, other);
  const end = new Date(Date.now() + 2 * 3600000);
  const w = await call('POST', '/api/maintenance', { name: 'Backup-Nacht', kind: 'once', starts_at: new Date(Date.now() - 3600000).toISOString(), ends_at: end.toISOString(), monitor_ids: [mon] });
  assert.equal(w.status, 201);
});

test('the monitor says which window and until when; the other one is down as before', async () => {
  const list = (await call('GET', '/api/monitors')).data;
  const m = list.find((x) => x.id === mon);
  assert.equal(m.status, 'maintenance');
  assert.equal(m.maint.name, 'Backup-Nacht');
  assert.ok(Date.parse(m.maint.until) > Date.now());
  const o = list.find((x) => x.id === other);
  assert.equal(o.status, 'down');
  assert.equal(o.maint, null);
  assert.equal((await call('GET', `/api/monitors/${mon}`)).data.maint.name, 'Backup-Nacht');
});

test('inventory, device page and overview: the device is in maintenance, not missing or down', async () => {
  const devs = (await call('GET', '/api/devices')).data;
  assert.equal(devs.find((d) => d.id === dev).maint.name, 'Backup-Nacht');
  assert.equal(devs.find((d) => d.name === 'PC-0001').maint, null);
  const d = (await call('GET', `/api/devices/${dev}`)).data;
  assert.equal(d.monitors[0].maint.name, 'Backup-Nacht');
  // never seen in the newest scan: "missing" - but not while its window holds
  db.prepare("INSERT INTO scans(kind,status,targets,started_at) VALUES('network','done',?,?)").run(JSON.stringify([{ cidr: '10.0.10.0/24' }]), new Date(Date.now() + 1000).toISOString());
  assert.equal((await call('GET', '/api/devices')).data.find((x) => x.id === dev).presence, 'missing');
  const dash = (await call('GET', '/api/dashboard')).data;
  assert.equal(dash.missing, 1, 'only PC-0001 counts as missing');
  assert.equal(dash.monitoring.maintenance, 1);
  assert.deepEqual(dash.monitoring.inMaintenance.map((x) => [x.name, x.window, !!x.until]), [['Backup-NAS Ping', 'Backup-Nacht', true]]);
  // the list of windows says which one runs now
  const ws = (await call('GET', '/api/maintenance')).data;
  assert.ok(ws[0].active_until);
});

test('when the window is switched off, everything is as before at once', async () => {
  const w = (await call('GET', '/api/maintenance')).data[0];
  assert.equal((await call('PUT', `/api/maintenance/${w.id}`, { ...w, enabled: false })).status, 200);
  const m = (await call('GET', '/api/monitors')).data.find((x) => x.id === mon);
  assert.notEqual(m.status, 'maintenance');
  assert.equal(m.maint, null);
  assert.equal((await call('GET', '/api/devices')).data.find((d) => d.id === dev).maint, null);
  assert.equal((await call('GET', '/api/dashboard')).data.missing, 2);
});
