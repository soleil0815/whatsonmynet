import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, proxmoxMetrics } from '../src/proxmox.js';
import { proxmoxCheck } from '../src/monitor/sensors.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';

const now = Math.floor(Date.now() / 1000);
function fakeProxmox(dir, name) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${name}`,
    '-keyout', path.join(dir, `${name}-k.pem`), '-out', path.join(dir, `${name}-c.pem`)], { stdio: 'ignore' });
  const seen = [];
  const routes = {
    '/api2/json/cluster/resources': [
      { type: 'node', node: 'pve1', status: 'online', cpu: 0.12, mem: 30, maxmem: 100, disk: 10, maxdisk: 100 },
      { type: 'node', node: 'pve2', status: 'offline' },
      { type: 'storage', storage: 'local-zfs', node: 'pve1', status: 'available', disk: 870, maxdisk: 1000 },
      { type: 'qemu', vmid: 101, name: 'dc01', node: 'pve1', status: 'running', cpu: 0.05, mem: 2, maxmem: 4 },
      { type: 'lxc', vmid: 200, name: 'pihole', node: 'pve1', status: 'stopped' },
      { type: 'qemu', vmid: 9000, name: 'tmpl', node: 'pve1', status: 'stopped', template: 1 },
    ],
    '/api2/json/access/permissions': { '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'Datastore.Audit': 1 } },
    '/api2/json/status/datastore-usage': [{ store: 'backup', used: 600, total: 1000 }],
    '/api2/json/admin/datastore/backup/groups': [{ 'backup-type': 'vm', 'backup-id': 101, 'last-backup': now - 3600, 'backup-count': 12 }, { 'backup-type': 'ct', 'backup-id': 200, 'last-backup': now - 5 * 86400, 'backup-count': 3 }],
  };
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, `${name}-k.pem`)), cert: fs.readFileSync(path.join(dir, `${name}-c.pem`)) }, (req, res) => {
    seen.push(req.headers.authorization);
    const p = req.url.split('?')[0];
    res.setHeader('Content-Type', 'application/json');
    if (!/^PVEAPIToken=monitor@pve!womn=secret-1$|^PBSAPIToken=monitor@pbs!womn:secret-1$/.test(req.headers.authorization || '')) { res.statusCode = 401; return res.end('{}'); }
    if (/\/nodes\/pve1\/tasks/.test(p)) return res.end(JSON.stringify({ data: [{ id: '101', starttime: now - 7200, endtime: now - 7000, status: 'OK' }, { id: '200', starttime: now - 3600, endtime: now - 3500, status: 'job errors' }] }));
    if (/\/nodes\/localhost\/tasks/.test(p)) return res.end(JSON.stringify({ data: [{ worker_type: 'verify', worker_id: 'backup', starttime: now - 600, status: 'verification failed' }, { worker_type: 'gc', starttime: now - 60, status: 'OK' }] }));
    if (routes[p]) return res.end(JSON.stringify({ data: routes[p] }));
    res.statusCode = 404; res.end('{}');
  });
  return { srv, seen, routes, ca: fs.readFileSync(path.join(dir, `${name}-c.pem`), 'utf8') };
}

test('Proxmox VE and Backup Server: read, metrics, sensors, pinned certificate', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'px-'));
  const fake = fakeProxmox(dir, 'pve');
  await new Promise((r) => fake.srv.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${fake.srv.address().port}`;
  const db = memoryDb();
  const settings = createSettings(db);
  const px = createProxmox({ db, settings });
  try {
    assert.throws(() => px.create({ name: 'x', url: 'http://pve', token_id: 'a@pve!b', secret: 's' }), { code: 'err.proxmoxUrl' });
    assert.throws(() => px.create({ name: 'x', url, token_id: 'kein-token', secret: 's' }), { code: 'err.proxmoxToken' });
    // self-signed without the certificate → refused, token never sent
    const strict = px.create({ name: 'pve', kind: 'pve', url, token_id: 'monitor@pve!womn', secret: 'secret-1' });
    let r = await px.poll(strict.id);
    assert.equal(r.last_ok, false);
    assert.match(r.last_error, /self-signed/);
    assert.equal(fake.seen.length, 0);
    assert.ok(!JSON.stringify(px.list()).includes('secret-1'), 'secret never listed');
    // with the pasted certificate
    r = await px.poll(px.update(strict.id, { name: 'pve', kind: 'pve', url, token_id: 'monitor@pve!womn', ca: fake.ca }).id);
    assert.equal(r.last_ok, true, r.last_error);
    assert.deepEqual(r.data.nodes.map((n) => [n.name, n.online]), [['pve1', true], ['pve2', false]]);
    assert.equal(r.data.storages[0].pct, 87);
    assert.deepEqual(r.data.guests.map((g) => g.vmid), [101, 200], 'templates left out');
    assert.deepEqual(r.data.missing, [], 'all read rights there');
    // Token without rights: Proxmox answers, but shows almost nothing - the missing rights are named
    const full = fake.routes['/api2/json/cluster/resources'];
    fake.routes['/api2/json/access/permissions'] = { '/': {}, '/vms': { 'VM.Audit': 0 } };
    fake.routes['/api2/json/cluster/resources'] = [{ type: 'node', node: 'pve1', status: 'online' }];
    const bare = await px.poll(strict.id);
    assert.deepEqual(bare.data.missing, ['Sys.Audit', 'VM.Audit', 'Datastore.Audit']);
    assert.deepEqual([bare.data.nodes[0].cpu, bare.data.nodes[0].mem], [null, null], 'no made-up values');
    fake.routes['/api2/json/cluster/resources'] = full;
    fake.routes['/api2/json/access/permissions'] = { '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'Datastore.Audit': 1 } };
    r = await px.poll(strict.id);
    const metrics = proxmoxMetrics(r.data);
    assert.equal(metrics.find((x) => x.metric === 'backupAge' && x.key === '101').value, 2);
    assert.equal(metrics.find((x) => x.metric === 'backupAge' && x.key === '200').value, null, 'failed backup does not count');
    assert.equal(metrics.find((x) => x.metric === 'backupFailed').value, 1);

    const monitoring = createMonitoring({ db, channels: { notify: async () => [] }, maintenance: createMaintenance(db), settings });
    const mk = (metric, key, op, threshold) => monitoring.create({ name: metric, type: 'proxmox', options: { host: strict.id, metric, key, op, threshold, label: metric } });
    assert.equal((await monitoring.checkNow((await mk('nodeOnline', 'pve2')).id)).status === 'up', false);
    const st = await mk('storage', 'pve1/local-zfs', 'ge', '85');
    assert.match((await monitoring.checkNow(st.id)).last_message, /87 % \(≥ 85\)/);
    const vm = await mk('guestRunning', '101');
    assert.equal((await monitoring.checkNow(vm.id)).last_message, 'guestRunning: running');
    assert.throws(() => px.remove(strict.id), { code: 'err.proxmoxInUse' });

    // Backup Server
    const pbs = px.create({ name: 'pbs', kind: 'pbs', url, token_id: 'monitor@pbs!womn', secret: 'secret-1', ca: fake.ca });
    const b = await px.poll(pbs.id);
    assert.equal(b.last_ok, true, b.last_error);
    assert.equal(b.data.datastores[0].pct, 60);
    assert.deepEqual(b.data.groups.map((g) => `${g.type}/${g.id}`), ['ct/200', 'vm/101']);
    assert.equal(b.data.failed.length, 1);
    const m2 = proxmoxMetrics(b.data);
    assert.equal(m2.find((x) => x.metric === 'groupAge' && x.key === 'backup/ct/200').value, 120);
    const age = proxmoxCheck(db, { options: JSON.stringify({ host: pbs.id, metric: 'groupAge', key: 'backup/ct/200', op: 'gt', threshold: '26', label: 'CT 200' }) });
    assert.equal(age.ok, false);
  } finally { fake.srv.close(); }
});
