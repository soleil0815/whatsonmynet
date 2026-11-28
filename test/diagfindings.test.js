// From the first real diagnostic package (Synology RS815+, Proxmox cluster): false alarms at night and two loose ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { carryOver, KEEP_POLLS } from '../src/snmpdevices.js';
import { alarmOf, proxmoxCheck } from '../src/monitor/sensors.js';
import { memoryDb } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createDiagnostics } from '../src/diagnostics.js';
import { unzip } from '../src/lib/zip.js';

const disks = (...names) => names.map((name) => ({ name, status: 'normal', temp: 35 }));

test('a NAS that answers half a table for once: its disks are not "gone" (no "not found" alarm)', () => {
  const prev = { volumes: [{ name: '/volume1', pct: 57 }], disks: disks('Disk 1', 'Disk 2', 'Disk 3', 'Disk 4'), raids: [{ name: 'Volume 1' }] };
  // the walk of the disk table timed out: only two rows came
  let next = carryOver(prev, { volumes: [{ name: '/volume1', pct: 57 }], disks: disks('Disk 1', 'Disk 2'), raids: [{ name: 'Volume 1' }], incomplete: ['disks'] });
  assert.deepEqual(next.disks.map((d) => [d.name, !!d.kept]), [['Disk 1', false], ['Disk 2', false], ['Disk 3', true], ['Disk 4', true]]);
  assert.deepEqual(next.kept, { disks: 1 });
  // an empty volume table all of a sudden (the walk "completed" but brought nothing)
  next = carryOver(next, { volumes: [], disks: disks('Disk 1', 'Disk 2', 'Disk 3', 'Disk 4'), raids: [{ name: 'Volume 1' }] });
  assert.deepEqual(next.volumes.map((v) => v.name), ['/volume1']);
  assert.equal(next.kept.disks, undefined);
  // gone for longer than KEEP_POLLS polls: really gone
  let n = next;
  for (let i = 0; i < KEEP_POLLS; i++) n = carryOver(n, { volumes: [], disks: n.disks.filter((d) => !d.kept), raids: n.raids });
  assert.deepEqual(n.volumes, []);
  // a disk taken out while the table came in whole: gone at once (no false "all fine")
  const out = carryOver(prev, { volumes: prev.volumes, disks: disks('Disk 1', 'Disk 2', 'Disk 3'), raids: prev.raids });
  assert.deepEqual(out.disks.map((d) => d.name), ['Disk 1', 'Disk 2', 'Disk 3']);
});

test('the NAS reader asks one table after the other and says which ones did not come whole', () => {
  const src = fs.readFileSync(new URL('../src/scan/nas.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export async function readNas'), src.indexOf('export function nasProblems')), /Promise\.all/);
  assert.match(src, /out\.incomplete = /);
  const w = fs.readFileSync(new URL('../src/scan/snmpwalk.js', import.meta.url), 'utf8');
  assert.match(w, /out\.complete = complete/);
});

test('hysteresis: an NVMe around its limit does not alarm and clear every 5 minutes', () => {
  // 86 °C limit: 86.9 sets it off; 85.9 does not clear it (needs < 84), 83.9 does
  assert.equal(alarmOf('ge', 86.9, 86, '°C', false), true);
  assert.equal(alarmOf('ge', 85.9, 86, '°C', true), true);
  assert.equal(alarmOf('ge', 83.9, 86, '°C', true), false);
  // not yet in alarm: the limit itself counts
  assert.equal(alarmOf('ge', 85.9, 86, '°C', false), false);
  // "below": a charge of 50 % sets it off, it clears above 52 %
  assert.equal(alarmOf('le', 51, 50, '%', true), true);
  assert.equal(alarmOf('le', 53, 50, '%', true), false);
  // values without a unit keep the plain limit
  assert.equal(alarmOf('gt', 9, 10, '', true), false);
});

test('Proxmox: a value missing for once is not blamed on missing rights', () => {
  const db = memoryDb();
  const id = db.prepare("INSERT INTO proxmox_hosts(name,kind,url,token_id,created_at,last_at,last_ok,data) VALUES('pve','pve','https://x:8006','a@pve!b','x',?,1,?)")
    .run(new Date().toISOString(), JSON.stringify({ kind: 'pve', missing: [], nodes: [{ name: 'pve1', status: 'online', cpu: null, mem: null, maxmem: 0 }] })).lastInsertRowid;
  const m = { status: 'up', options: JSON.stringify({ host: id, metric: 'nodeCpu', key: 'pve1', op: 'ge', threshold: 90, label: 'CPU pve1' }) };
  const r = proxmoxCheck(db, m);
  assert.equal(r.ok, false);
  assert.match(r.message, /^CPU pve1: no value at the moment \(not delivered by the host\)$/);
  db.prepare('UPDATE proxmox_hosts SET data=? WHERE id=?').run(JSON.stringify({ kind: 'pve', missing: ['Sys.Audit'], nodes: [{ name: 'pve1', status: 'online', cpu: null, mem: null, maxmem: 0 }] }), id);
  const r2 = proxmoxCheck(db, m);
  assert.match(r2.message, /lacks read rights/);
});

test('diagnostic package: the SMTP account name is a placeholder too', async () => {
  const db = memoryDb();
  const settings = createSettings(db);
  settings.set('smtp.user', 'm024c94f');
  settings.set('smtp.from', 'it@firma.example');
  const diag = createDiagnostics({ db, settings });
  const z = unzip((await diag.build({ days: 1 })).buffer);
  const set = JSON.parse(z['einstellungen.json']);
  assert.match(set['smtp.user'], /^USER-\d+$/);
  assert.match(set['smtp.from'], /^MAIL-\d+$/);
  assert.equal(JSON.stringify(Object.values(z).map(String)).includes('m024c94f'), false);
});
