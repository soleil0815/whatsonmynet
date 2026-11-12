import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createInventory } from '../src/inventory.js';
import { createScanner, validateTargets, bestWebUrl } from '../src/scan/engine.js';

test('scan targets are checked', () => {
  assert.throws(() => validateTargets([]), /err.noTargets/);
  assert.throws(() => validateTargets([{ cidr: 'abc' }]), /err.cidr/);
  assert.throws(() => validateTargets([{ cidr: '10.0.0.0/16' }]), /err.cidrTooLarge/);
  assert.throws(() => validateTargets([{ cidr: '10.0.0.0/20' }, { cidr: '10.0.16.0/20' }, { cidr: '10.0.32.0/20' }, { cidr: '10.0.48.0/20' }, { cidr: '10.0.64.0/20' }]), /err.tooManyHosts/);
  assert.deepEqual(validateTargets([{ cidr: '192.168.1.7/24' }, { cidr: '192.168.1.0/24' }]), [{ cidr: '192.168.1.0/24', locationId: null }]);
});

test('quick access address', () => {
  assert.equal(bestWebUrl('10.0.0.5', { ports: [22, 8006] }, 'hypervisor'), 'https://10.0.0.5:8006/');
  assert.equal(bestWebUrl('10.0.0.6', { ports: [80, 5000, 5001] }, 'nas'), 'https://10.0.0.6:5001/');
  assert.equal(bestWebUrl('10.0.0.7', { ports: [80] }, 'printer'), 'http://10.0.0.7/');
  assert.equal(bestWebUrl('10.0.0.8', { ports: [22] }, 'server'), '');
});

test('real scan of this machine finds a "Proxmox" and its web interface', { timeout: 60_000 }, async (t) => {
  // A fake Proxmox web interface on 127.0.0.1:8006 and a raw printing port 9100
  const key = path.join(tmp, 'e.key'); const crt = path.join(tmp, 'e.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=pve1'], { stdio: 'ignore' });
  let web; let raw;
  try {
    web = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (_q, s) => s.end('<title>pve1 - Proxmox Virtual Environment</title>'));
    await new Promise((resolve, reject) => { web.once('error', reject); web.listen(8006, '127.0.0.1', resolve); });
  } catch (e) { t.skip(`port 8006 not free: ${e.code}`); return; }
  raw = net.createServer((s) => s.end());
  await new Promise((resolve) => { raw.once('error', resolve); raw.listen(9100, '127.0.0.1', resolve); });

  const db = memoryDb();
  const settings = createSettings(db);
  settings.set('scan.snmp', false);
  settings.set('scan.rate', 200);
  const inventory = createInventory(db);
  const scanner = createScanner({ db, settings, inventory });
  const id = scanner.startNetwork([{ cidr: '127.0.0.1/32' }], 'test');
  assert.throws(() => scanner.startNetwork([{ cidr: '127.0.0.1/32' }], 'test'), /err.scanRunning/);
  while (!scanner.progress(id).finished) await new Promise((r) => setTimeout(r, 200));
  web.close(); raw.close();
  const scan = db.prepare('SELECT * FROM scans WHERE id=?').get(id);
  assert.equal(scan.status, 'done');
  const r = db.prepare('SELECT * FROM scan_results WHERE scan_id=?').get(id);
  assert.equal(r.ip, '127.0.0.1');
  assert.equal(r.status, 'new');
  assert.equal(r.detected_type, 'hypervisor');
  const facts = JSON.parse(r.facts);
  assert.ok(facts.ports.includes(8006) && facts.ports.includes(9100));
  assert.equal(facts.http.find((h) => h.port === 8006).title, 'pve1 - Proxmox Virtual Environment');
  // Adopt it, scan again: now it is "known"
  inventory.adopt([r.id], {}, 'test');
  web = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (_q, s) => s.end('<title>pve1 - Proxmox Virtual Environment</title>'));
  await new Promise((resolve) => web.listen(8006, '127.0.0.1', resolve));
  const id2 = scanner.startNetwork([{ cidr: '127.0.0.1/32' }], 'test');
  while (!scanner.progress(id2).finished) await new Promise((r2) => setTimeout(r2, 200));
  web.close();
  assert.equal(db.prepare('SELECT status FROM scan_results WHERE scan_id=?').get(id2).status, 'known');
  assert.equal(inventory.list()[0].presence, 'online');
});
