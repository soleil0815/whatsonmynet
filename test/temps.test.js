// Temperatures from the Linux script (hwmon): script output, cleaning, sensors, and the nodes on the virtualisation page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { hostScript } from '../src/hostscripts.js';
import { cleanTemps } from '../src/hostfacts.js';
import { cleanReport } from '../src/hosts.js';
import { metricsFor, sensorCheck } from '../src/monitor/sensors.js';
import { createProxmox } from '../src/proxmox.js';
import { createSettings } from '../src/settings.js';

/** A fake /sys/class/hwmon: CPU (coretemp with limits), an NVMe drive, an AMD CPU without limits */
function fakeHwmon(dir) {
  const chip = (n, name, device, temps) => {
    const d = path.join(dir, 'hwmon', `hwmon${n}`);
    const dev = path.join(dir, 'devices', device);
    fs.mkdirSync(d, { recursive: true }); fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(d, 'name'), `${name}\n`);
    fs.symlinkSync(dev, path.join(d, 'device'));
    for (const [i, tp] of temps.entries()) {
      const b = path.join(d, `temp${i + 1}`);
      fs.writeFileSync(`${b}_input`, `${tp.mC}\n`);
      if (tp.label) fs.writeFileSync(`${b}_label`, `${tp.label}\n`);
      if (tp.max !== undefined) fs.writeFileSync(`${b}_max`, `${tp.max}\n`);
      if (tp.crit !== undefined) fs.writeFileSync(`${b}_crit`, `${tp.crit}\n`);
    }
  };
  chip(0, 'coretemp', 'coretemp.0', [{ mC: 54000, label: 'Package id 0', max: 80000, crit: 100000 }, { mC: 51000, label: 'Core 0', max: 80000, crit: 100000 }]);
  chip(1, 'nvme', 'nvme0', [{ mC: 41850, label: 'Composite', max: 84850, crit: 89850 }]);
  chip(2, 'k10temp', '0000:00:18.3', [{ mC: 61250, label: 'Tctl' }]);
  return path.join(dir, 'hwmon');
}

test('Linux script: reads hwmon without lm-sensors, the server makes names and limits of it', { skip: !fs.existsSync('/bin/sh') }, () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'hw-')); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const w = (n, b) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${b}\n`, { mode: 0o755 });
  w('id', 'echo 1000'); w('hostname', 'echo pve1'); w('crontab', 'cat >/dev/null'); w('curl', `cat > "${dir}/body"`);
  const hwmon = fakeHwmon(dir);
  const s = hostScript('linux', { url: 'https://w/api/hosts/push', token: 'tok-1234567890', pin: {} });
  const file = path.join(dir, s.file); fs.writeFileSync(file, s.text);
  spawnSync('sh', [file], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, WOMN_HWMON: hwmon, WOMN_THERMAL: path.join(dir, 'none') }, timeout: 20000 });
  const body = JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8'));
  assert.equal(body.temps.length, 4);
  const r = cleanReport(body);
  assert.deepEqual(r.temps.map((x) => [x.key, x.name, x.c, x.warn]), [
    ['coretemp/coretemp.0/Package id 0', 'CPU Package id 0', 54, 80],
    ['coretemp/coretemp.0/Core 0', 'CPU Core 0', 51, 80],
    ['nvme/nvme0/Composite', 'NVMe nvme0 Composite', 41.9, 84.9],
    ['k10temp/0000:00:18.3/Tctl', 'CPU Tctl', 61.3, 80],
  ]);
});

test('temperatures: no readings and nonsense limits are dropped, thermal zones as fallback', () => {
  const t = cleanTemps([{ chip: 'acpitz', dev: 'x', name: 'temp1', mC: 27800, maxMC: 0, critMC: 255000 }, { chip: 'x', dev: 'y', name: 'z', mC: -273000 },
    { chip: 'thermal', dev: 'thermal_zone0', name: 'cpu-thermal', mC: 48312 }, 'junk', { chip: 'acpitz', dev: 'x', name: 'temp1', mC: 1 }]);
  assert.deepEqual(t.map((x) => [x.name, x.c, x.warn]), [['ACPI temp1', 27.8, 80], ['Zone cpu-thermal', 48.3, 80]]);
});

function hostWithTemps(db, temps) {
  const at = new Date().toISOString();
  const id = db.prepare("INSERT INTO devices(name,type,hostname,created_at,updated_at) VALUES('pve1','server','pve1.firma.local',?,?)").run(at, at).lastInsertRowid;
  const data = cleanReport({ hostname: 'pve1', cpu: 5, temps });
  db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?)').run(id, at, JSON.stringify(data));
  return id;
}

test('sensors: the hottest of all, and each temperature with the chip limit', () => {
  const db = memoryDb();
  const id = hostWithTemps(db, [{ chip: 'coretemp', dev: 'coretemp.0', name: 'Package id 0', mC: 86000, maxMC: 80000, critMC: 100000 }, { chip: 'nvme', dev: 'nvme0', name: 'Composite', mC: 40000 }]);
  const m = metricsFor(db, id);
  const max = m.find((x) => x.metric === 'hostTempMax');
  assert.deepEqual([max.value, max.threshold, max.name], [86, 85, 'CPU Package id 0']);
  assert.equal(m.find((x) => x.metric === 'hostTemp' && x.key === 'coretemp/coretemp.0/Package id 0').threshold, 80);
  const mon = (o) => ({ device_id: id, options: JSON.stringify(o) });
  const r = sensorCheck(db, mon({ metric: 'hostTempMax', op: 'ge', threshold: 85, label: 'pve1' }));
  assert.equal(r.ok, false);
  assert.match(r.message, /86 °C \(CPU Package id 0\)/);
  assert.equal(sensorCheck(db, mon({ metric: 'hostTemp', key: 'nvme/nvme0/Composite', op: 'ge', threshold: 70, label: 'NVMe' })).ok, true);
});

test('virtualisation: a Proxmox node that runs the script shows its temperature', () => {
  const db = memoryDb();
  hostWithTemps(db, [{ chip: 'k10temp', dev: 'pci', name: 'Tctl', mC: 63000 }]);
  db.prepare("INSERT INTO proxmox_hosts(name,kind,url,token_id,secret,verify,created_at,last_at,last_ok,data) VALUES('Cluster','pve','https://pve1:8006','a@pve!b','x',1,?,?,1,?)")
    .run(new Date().toISOString(), new Date().toISOString(), JSON.stringify({ kind: 'pve', nodes: [{ name: 'pve1', online: true }, { name: 'pve2', online: true }], guests: [], storages: [] }));
  const px = createProxmox({ db, settings: createSettings(db) });
  const nodes = px.list()[0].data.nodes;
  assert.equal(nodes[0].temp.c, 63);
  assert.equal(nodes[1].temp, undefined);
});
