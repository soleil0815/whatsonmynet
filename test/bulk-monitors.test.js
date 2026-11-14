// Several monitors and sensors at once: change intervals and alarm settings, pause, resume, delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './helpers.js';

const app = await startApp();
const { call, db } = app;
test.after(() => app.close());

const ADMIN = { username: 'admin', password: 'Sicher-Passwort-1', email: 'a@example.org' };
const at = new Date().toISOString();
const row = (id) => db.prepare('SELECT * FROM monitors WHERE id=?').get(id);
const bulk = (body, who) => call('POST', '/api/monitors/bulk', body, who ? { who } : undefined);

let la; let devA; let devB; let tcp1; let tcp2; let http1; let numSensor; let stateSensor; let foreign;

test('setup: admin, locations, devices, monitors and sensors', async () => {
  assert.equal((await call('POST', '/api/setup', { ...ADMIN, code: 'setup-123' })).status, 200);
  la = (await call('POST', '/api/locations', { name: 'A', subnets: ['10.88.1.0/24'] })).data;
  const lb = (await call('POST', '/api/locations', { name: 'B', subnets: ['10.88.2.0/24'] })).data;
  const ins = db.prepare('INSERT INTO devices(name,type,ip,location_id,created_at,updated_at) VALUES(?,?,?,?,?,?)');
  devA = Number(ins.run('NAS A', 'nas', '10.88.1.5', la.id, at, at).lastInsertRowid);
  devB = Number(ins.run('NAS B', 'nas', '10.88.2.5', lb.id, at, at).lastInsertRowid);
  const mk = async (body) => { const r = await call('POST', '/api/monitors', body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
  tcp1 = await mk({ name: 'SSH A', type: 'tcp', target: '127.0.0.1', port: 1, interval_s: 60, fail_threshold: 3, timeout_s: 10, resend_min: 30, device_id: devA });
  tcp2 = await mk({ name: 'SMTP A', type: 'tcp', target: '127.0.0.1', port: 2, interval_s: 120, fail_threshold: 2, timeout_s: 5, device_id: devA });
  http1 = await mk({ name: 'Web', type: 'http', target: 'http://127.0.0.1:1/', interval_s: 300, http_keyword: 'Login', escalate_min: 30 });
  numSensor = await mk({ name: 'Temperatur A', type: 'sensor', device_id: devA, options: { metric: 'temp', key: '', op: 'ge', threshold: 55, label: 'Temperatur' } });
  stateSensor = await mk({ name: 'Zustand A', type: 'sensor', device_id: devA, options: { metric: 'health', key: '', label: 'Zustand' } });
  foreign = await mk({ name: 'SSH B', type: 'tcp', target: '127.0.0.1', port: 3, interval_s: 60, device_id: devB });
});

test('edit: a new interval for several monitors leaves every other field as it was', async () => {
  const before = [tcp1, tcp2, http1].map(row);
  const r = await bulk({ ids: [tcp1, tcp2, http1], action: 'edit', changes: { interval_s: 600 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { changed: 3, skipped: 0 });
  for (const old of before) {
    const now = row(old.id);
    assert.equal(now.interval_s, 600);
    for (const k of ['name', 'type', 'target', 'port', 'fail_threshold', 'timeout_s', 'resend_min', 'http_keyword', 'http_status', 'channels', 'escalate_min', 'escalate_channels', 'options', 'enabled', 'device_id', 'parent_id']) {
      assert.deepEqual(now[k], old[k], `${old.name}: ${k}`);
    }
  }
  // a monitor that was not selected is not touched
  assert.equal(row(foreign).interval_s, 60);
});

test('edit: only the fields sent change; escalation back to the setting for all monitors', async () => {
  const r = await bulk({ ids: [tcp1, http1], action: 'edit', changes: { fail_threshold: 5, escalate_min: null } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(row(tcp1).fail_threshold, 5);
  assert.equal(row(http1).fail_threshold, 5);
  assert.equal(row(http1).escalate_min, null);
  assert.equal(row(tcp1).resend_min, 30);
  assert.equal(row(tcp1).timeout_s, 10);
  assert.equal(row(http1).http_keyword, 'Login');
  assert.equal(row(tcp2).fail_threshold, 2);
});

test('edit: an invalid value rejects the whole change, nothing is changed', async () => {
  const before = [tcp1, tcp2].map((id) => row(id).interval_s);
  const r = await bulk({ ids: [tcp1, tcp2], action: 'edit', changes: { interval_s: 5, fail_threshold: 4 } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.field, 'interval_s');
  assert.deepEqual([tcp1, tcp2].map((id) => row(id).interval_s), before);
  assert.notEqual(row(tcp2).fail_threshold, 4);
  // a channel that does not exist: the same validation as for a single monitor
  const c = await bulk({ ids: [tcp1, tcp2], action: 'edit', changes: { channels: [9999] } });
  assert.equal(c.status, 400);
  assert.equal(c.data.error.code, 'err.channel');
  // an unknown condition
  assert.equal((await bulk({ ids: [numSensor], action: 'edit', changes: { op: 'between' } })).status, 400);
  // nothing to change, too many or no ids, unknown action
  assert.equal((await bulk({ ids: [tcp1], action: 'edit', changes: {} })).status, 400);
  assert.equal((await bulk({ ids: [], action: 'pause' })).status, 400);
  assert.equal((await bulk({ ids: Array.from({ length: 1001 }, (_, i) => i + 1), action: 'pause' })).status, 400);
  assert.equal((await bulk({ ids: [tcp1], action: 'explode' })).status, 400);
});

test('edit: the limit only goes to sensors with a numeric value, the others are counted as skipped', async () => {
  const oldState = row(stateSensor).options;
  const r = await bulk({ ids: [numSensor, stateSensor, tcp1], action: 'edit', changes: { op: 'gt', threshold: '70' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { changed: 1, skipped: 2 });
  const o = JSON.parse(row(numSensor).options);
  assert.equal(o.op, 'gt');
  assert.equal(o.threshold, '70');
  assert.equal(o.metric, 'temp');
  assert.equal(o.label, 'Temperatur');
  assert.equal(row(stateSensor).options, oldState);
  // limit together with the interval: the interval goes to all, the limit only to the numeric one
  const r2 = await bulk({ ids: [numSensor, stateSensor], action: 'edit', changes: { interval_s: 900, threshold: '75' } });
  assert.deepEqual(r2.data, { changed: 2, skipped: 1 });
  assert.equal(row(stateSensor).interval_s, 900);
  assert.equal(JSON.parse(row(numSensor).options).threshold, '75');
  assert.equal(JSON.parse(row(numSensor).options).op, 'gt');
});

test('pause, resume and delete several at once', async () => {
  let r = await bulk({ ids: [tcp1, tcp2], action: 'pause' });
  assert.deepEqual(r.data, { changed: 2, skipped: 0 });
  assert.equal(row(tcp1).enabled, 0);
  assert.equal(row(tcp2).status, 'paused');
  r = await bulk({ ids: [tcp1, tcp2], action: 'resume' });
  assert.equal(r.data.changed, 2);
  assert.equal(row(tcp1).enabled, 1);
  const extra = (await call('POST', '/api/monitors', { name: 'Weg', type: 'tcp', target: '127.0.0.1', port: 4 })).data.id;
  const extra2 = (await call('POST', '/api/monitors', { name: 'Weg 2', type: 'tcp', target: '127.0.0.1', port: 5 })).data.id;
  r = await bulk({ ids: [extra, extra2], action: 'delete' });
  assert.deepEqual(r.data, { changed: 2, skipped: 0 });
  assert.equal(row(extra), undefined);
  assert.equal(row(extra2), undefined);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action='monitor.bulk'").get());
});

test('a user limited to locations cannot touch monitors of other locations; a viewer cannot change anything', async () => {
  await call('POST', '/api/users', { username: 'seg', password: 'Standort-A-1234', role: 'editor', locations: [la.id] });
  await call('POST', '/api/users', { username: 'leser', password: 'Lesen-Lesen-1', role: 'viewer' });
  assert.equal((await call('POST', '/api/login', { username: 'seg', password: 'Standort-A-1234' }, { who: 'seg' })).status, 200);
  assert.equal((await call('POST', '/api/login', { username: 'leser', password: 'Lesen-Lesen-1' }, { who: 'viewer' })).status, 200);
  const before = [tcp1, foreign].map((id) => row(id).interval_s);
  // own and foreign mixed: refused as a whole
  assert.equal((await bulk({ ids: [tcp1, foreign], action: 'edit', changes: { interval_s: 1200 } }, 'seg')).status, 403);
  assert.equal((await bulk({ ids: [foreign], action: 'pause' }, 'seg')).status, 403);
  assert.equal((await bulk({ ids: [foreign], action: 'delete' }, 'seg')).status, 403);
  // a monitor without a device (web check) belongs to no location
  assert.equal((await bulk({ ids: [http1], action: 'pause' }, 'seg')).status, 403);
  assert.deepEqual([tcp1, foreign].map((id) => row(id).interval_s), before);
  assert.equal(row(foreign).enabled, 1);
  // his own: fine
  const ok = await bulk({ ids: [tcp1, tcp2], action: 'edit', changes: { interval_s: 1200 } }, 'seg');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(row(tcp2).interval_s, 1200);
  // viewer
  assert.equal((await bulk({ ids: [tcp1], action: 'pause' }, 'viewer')).status, 403);
  assert.equal(row(tcp1).enabled, 1);
  // without the CSRF header
  assert.equal((await call('POST', '/api/monitors/bulk', { ids: [tcp1], action: 'pause' }, { csrf: false })).status, 403);
});

test('the texts of the selection and the bulk dialog exist in German and English', async () => {
  const { KEYS_DE, KEYS_EN } = await import('../public/js/i18n.js');
  const de = new Set(KEYS_DE); const en = new Set(KEYS_EN);
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'js', 'views', 'monitoring.js'), 'utf8');
  const keys = [...src.matchAll(/\bt\('(mon\.bulk[a-zA-Z0-9_.]*)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 8, `bulk texts used: ${keys.length}`);
  for (const k of keys) {
    assert.ok(de.has(k), `de ${k}`);
    assert.ok(en.has(k), `en ${k}`);
  }
  const { t } = await import('../src/i18n.js');
  assert.notEqual(t('de', 'err.range'), 'err.range');
  assert.notEqual(t('en', 'err.range'), 'err.range');
});
