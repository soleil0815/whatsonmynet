// "How it is checked" and the reasons of failed Proxmox/PBS tasks: every message can be traced to its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aptSources, taskReason, CRITICAL_TASKS } from '../src/proxmox.js';
import { explain } from '../src/monitor/explain.js';
import { memoryDb } from './helpers.js';
import { createSettings } from '../src/settings.js';

test('apt update: a failing Proxmox/Debian source alarms, a third-party source (Webmin) does not', () => {
  assert.deepEqual(aptSources(['Err:5 https://download.webmin.com/download/newkey/repository stable InRelease', 'W: Failed to fetch https://download.webmin.com/x']),
    { repo: 'foreign', hosts: ['download.webmin.com'] });
  assert.equal(aptSources(['Err:3 https://enterprise.proxmox.com/debian/pbs trixie InRelease', '  401  Unauthorized [IP: 1.2.3.4 443]']).repo, 'official');
  assert.equal(aptSources(['Err:1 http://deb.debian.org/debian trixie InRelease', 'Err:9 https://download.webmin.com/x']).repo, 'official');
  assert.equal(aptSources(['E: Could not get lock /var/lib/apt/lists/lock']).repo, null);
  // a name that only looks like one is no official source
  assert.equal(aptSources(['Err:2 https://proxmox.com.evil.example/repo x']).repo, 'foreign');
});

test('the reason of a failed task: its error lines, not "unknown"', () => {
  assert.equal(taskReason([{ t: 'starting' }, { t: 'upload chunk 1' }, { t: 'Error: connection refused' }, { t: 'TASK ERROR: backup failed' }]),
    'Error: connection refused\nTASK ERROR: backup failed');
  assert.equal(taskReason([{ t: 'a' }, { t: 'b' }]), 'a\nb');
  assert.equal(taskReason([]), '');
  assert.ok(CRITICAL_TASKS.has('verificationjob') && !CRITICAL_TASKS.has('aptupdate'));
});

test('how a sensor is checked: its source, how fresh, when it alarms (with the margin)', () => {
  const db = memoryDb();
  const settings = createSettings(db);
  settings.set('snmpdev.interval', 15);
  const dev = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at,first_seen,last_seen) VALUES('nas','nas','10.0.0.5','x','x','x','x')").run().lastInsertRowid;
  db.prepare("INSERT INTO snmp_status(device_id,kind,at,ok,error,data,alerts) VALUES(?,?,?,?,?,?,?)").run(dev, 'nas', '2026-11-15T07:00:00Z', 1, '', JSON.stringify({ disks: [], kept: { disks: 1 } }), '{}');
  const w = explain(db, settings, { type: 'sensor', device_id: dev, interval_s: 300, timeout_s: 10, fail_threshold: 1, last_check: 'x', last_message: 'Zustand Disk 1: normal',
    options: JSON.stringify({ metric: 'diskTemp', key: 'Disk 1', op: 'ge', threshold: 55, label: 'Temperatur Disk 1' }) });
  assert.deepEqual([w.source.kind, w.source.everyMin, w.source.staleMin, w.source.kept], ['nas', 15, 180, ['disks']]);
  assert.deepEqual([w.state, w.op, w.threshold, w.hysteresisFor['°C']], [false, 'ge', 55, 2]);
  const s = explain(db, settings, { type: 'sensor', device_id: dev, options: JSON.stringify({ metric: 'disk', key: 'Disk 1', label: 'Zustand Disk 1' }) });
  assert.equal(s.state, true);
  const http = explain(db, settings, { type: 'http', http_status: '200', http_keyword: 'Login', tls_verify: 1, options: '{}' });
  assert.deepEqual([http.status, http.keyword, http.verify], ['200', 'Login', true]);
});
