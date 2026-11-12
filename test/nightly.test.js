import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { isDue, validTime, createNightly } from '../src/scan/nightly.js';
import { createSettings } from '../src/settings.js';

const at = (h, m) => { const d = new Date(2026, 10, 12, h, m); return d; };

test('nightly window', () => {
  assert.ok(validTime('02:30') && !validTime('2:30') && !validTime('24:00'));
  assert.equal(isDue(at(2, 29), '02:30', ''), false);
  assert.equal(isDue(at(2, 30), '02:30', ''), true);
  assert.equal(isDue(at(6, 29), '02:30', ''), true);
  assert.equal(isDue(at(6, 30), '02:30', ''), false);
  assert.equal(isDue(at(3, 0), '02:30', '2026-11-12'), false, 'already ran today');
});

function setup() {
  const db = memoryDb();
  const settings = createSettings(db);
  const sent = [];
  const started = [];
  const hooks = [];
  const scanner = { isRunning: () => false, startLight: (t, u) => { started.push({ t, u }); return 99; }, onFinished: (fn) => hooks.push(fn) };
  const nightly = createNightly({ db, settings, scanner, channels: { notifyIds: async (ids, ev) => { sent.push(ev); return ['Mail']; } } });
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO locations(name,created_at) VALUES('HQ',?)").run(ts);
  db.prepare("INSERT INTO subnets(location_id,cidr,created_at) VALUES(1,'10.0.0.0/24',?)").run(ts);
  const scan = (kind) => db.prepare("INSERT INTO scans(kind,status,started_at) VALUES(?,'done',?)").run(kind, ts).lastInsertRowid;
  const result = (scanId, ip, mac, status = 'new') => db.prepare("INSERT INTO scan_results(scan_id,ip,mac,vendor,status) VALUES(?,?,?,'HP',?)").run(scanId, ip, mac, status);
  return { db, settings, sent, started, hooks, nightly, scan, result };
}

test('starts once in the window, with all subnets', () => {
  const s = setup();
  s.nightly.tick(at(2, 31));
  s.nightly.tick(at(2, 32));
  assert.equal(s.started.length, 1);
  assert.deepEqual(s.started[0].t, [{ cidr: '10.0.0.0/24', locationId: 1 }]);
  s.settings.set('lightscan.enabled', false);
  s.settings.set('lightscan.lastRun', '');
  s.nightly.tick(at(2, 33));
  assert.equal(s.started.length, 1);
});

test('unknown devices: first scan learns, later ones report only first sightings', async () => {
  const s = setup();
  assert.equal(s.hooks.length, 1);
  const a = s.scan('light');
  s.result(a, '10.0.0.5', 'aa:aa:aa:aa:aa:01');
  await s.hooks[0]({ id: a, kind: 'light', status: 'done' });
  assert.equal(s.sent.length, 0, 'baseline: nothing reported');

  const b = s.scan('light');
  s.result(b, '10.0.0.5', 'aa:aa:aa:aa:aa:01');
  s.result(b, '10.0.0.6', 'aa:aa:aa:aa:aa:02');
  s.result(b, '10.0.0.7', 'aa:aa:aa:aa:aa:03', 'ignored');
  await s.hooks[0]({ id: b, kind: 'light', status: 'done' });
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0].devices.map((d) => d.ip), ['10.0.0.6']);

  const c = s.scan('light');
  s.result(c, '10.0.0.6', 'aa:aa:aa:aa:aa:02');
  await s.hooks[0]({ id: c, kind: 'light', status: 'done' });
  assert.equal(s.sent.length, 1, 'already reported');

  // A manual scan remembers but does not report
  const d = s.scan('network');
  s.result(d, '10.0.0.8', 'aa:aa:aa:aa:aa:04');
  await s.hooks[0]({ id: d, kind: 'network', status: 'done' });
  assert.equal(s.sent.length, 1);
  assert.ok(s.db.prepare("SELECT 1 FROM sightings WHERE key='aa:aa:aa:aa:aa:04'").get());
});
