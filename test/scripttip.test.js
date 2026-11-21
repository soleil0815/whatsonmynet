// The tip to monitor a machine with the script: hidden per device / hypervisor on request (editors / admins),
// Proxmox nodes know whether their script reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp } from './helpers.js';
import { nodeScriptsInto as joinScripts, forgetReporting } from '../src/hosts.js';

const nodeScriptsInto = (db, data) => { forgetReporting(db); return joinScripts(db, data); };

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());

test('"do not show again" per device: editors only, kept on the device', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'viewer' });
  await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'viewer' });
  const d = ctx.inventory.create({ name: 'pve1', type: 'hypervisor', ip: '10.0.0.11', os: 'Proxmox VE 9' }, 'testadmin');
  assert.equal((await call('GET', `/api/devices/${d.id}`)).data.script_tip_hidden, 0);
  assert.equal((await call('PUT', `/api/devices/${d.id}/script-tip`, { hidden: true }, { who: 'viewer' })).status, 403);
  assert.equal((await call('PUT', `/api/devices/${d.id}/script-tip`, { hidden: true })).status, 200);
  assert.equal((await call('GET', `/api/devices/${d.id}`)).data.script_tip_hidden, 1);
  assert.equal((await call('PUT', '/api/devices/9999/script-tip', { hidden: true })).status, 404);
});

test('Proxmox nodes: which ones run the script; the tip of a host can be hidden', async () => {
  const dev = ctx.inventory.create({ name: 'pve2', type: 'hypervisor', ip: '10.0.0.12', hostname: 'pve2.firma.local' }, 'testadmin');
  db.prepare('INSERT INTO host_reports(device_id, at, data) VALUES(?,?,?)').run(dev.id, new Date().toISOString(), JSON.stringify({ hostname: 'pve2' }));
  const data = nodeScriptsInto(db, { nodes: [{ name: 'pve1' }, { name: 'pve2' }] });
  assert.deepEqual(data.nodes.map((n) => n.script), [false, true]);
  // an old report does not count
  db.prepare('UPDATE host_reports SET at=? WHERE device_id=?').run('2020-01-01T00:00:00Z', dev.id);
  assert.deepEqual(nodeScriptsInto(db, { nodes: [{ name: 'pve2' }] }).nodes.map((n) => n.script), [false]);
  const h = db.prepare("INSERT INTO proxmox_hosts(name,kind,url,token_id,created_at) VALUES('Cluster','pve','https://10.0.0.11:8006','x@pve!y','x')").run().lastInsertRowid;
  assert.equal((await call('PUT', `/api/proxmox/${h}/script-tip`, { hidden: true })).status, 200);
  assert.equal((await call('GET', '/api/proxmox')).data.find((x) => x.id === Number(h)).script_tip_hidden, true);
});

test('the tip shows for Linux machines and hypervisors too, not for NAS or ESXi; the help link finds its section', () => {
  const src = fs.readFileSync(new URL('../public/js/views/device.js', import.meta.url), 'utf8');
  assert.match(src, /\['server', 'computer', 'vm', 'hypervisor'\]/);
  assert.match(src, /d\.host \|\| d\.hardware \|\| d\.script_tip_hidden/);
  const hs = fs.readFileSync(new URL('../public/js/views/hostscripts.js', import.meta.url), 'utf8');
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '');
  for (const lang of ['de', 'en']) {
    const id = hs.match(new RegExp(`${lang}: '([^']+)'`))[1];
    const md = fs.readFileSync(new URL(`../public/help/manual.${lang}.md`, import.meta.url), 'utf8');
    assert.ok(md.split('\n').some((l) => l.startsWith('## ') && slug(l.slice(3)) === id), `${lang}: section ${id}`);
  }
});

test('nodes and guests with the script: what it says at a glance, and where they are in the inventory', async () => {
  const { cleanReport } = await import('../src/hosts.js');
  const at = new Date().toISOString();
  const GB = 1024 ** 3;
  const node = ctx.inventory.create({ name: 'pve3', type: 'hypervisor', ip: '10.0.0.13' }, 'testadmin');
  const vm = ctx.inventory.create({ name: 'fileserver', type: 'vm', ip: '10.0.10.21' }, 'testadmin');
  const put = (id, b) => db.prepare('INSERT INTO host_reports(device_id, at, data) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET at=excluded.at, data=excluded.data').run(id, at, JSON.stringify(cleanReport(b)));
  put(node.id, { hostname: 'pve3', os: 'Proxmox VE 9', updates: { pending: 4, security: 1, reboot: true }, services: [{ name: 'ssh', state: 'running' }] });
  put(vm.id, { hostname: 'fileserver.firma.local', disks: [{ name: '/srv', total: 100 * GB, used: 96 * GB }],
    services: [{ name: 'smbd.service', display: 'Samba', state: 'failed' }, { name: 'ssh', state: 'running' }],
    checks: [{ name: 'backup', status: 2, text: 'x' }, { name: 'ok', status: 0 }] });
  const d = nodeScriptsInto(db, { nodes: [{ name: 'pve3' }, { name: 'pve9' }], guests: [{ vmid: 101, name: 'FileServer' }, { vmid: 102, name: 'dc01' }] });
  const [n3, n9] = d.nodes;
  assert.equal(n3.script, true);
  assert.equal(n3.report.deviceId, node.id);
  assert.deepEqual(n3.report.glance.updates, { pending: 4, security: 1 });
  assert.equal(n3.report.glance.reboot, true);
  assert.equal(n3.report.glance.failedCount, 0);
  assert.equal(n9.report, undefined);
  const [g1, g2] = d.guests;
  assert.equal(g1.report.deviceId, vm.id, 'a guest matches by its short name, any case');
  assert.deepEqual(g1.report.glance.failed, ['Samba']);
  assert.deepEqual(g1.report.glance.disks, [{ name: '/srv', pct: 96 }]);
  assert.equal(g1.report.glance.checks, 1);
  assert.equal(g2.report, undefined);
  // a silent script (an hour) is still shown as silent; after a day it is gone
  db.prepare('UPDATE host_reports SET at=? WHERE device_id=?').run(new Date(Date.now() - 3600e3).toISOString(), vm.id);
  const silent = nodeScriptsInto(db, { guests: [{ name: 'fileserver' }] }).guests[0];
  assert.equal(silent.report.stale, true);
  assert.equal(silent.script, false);
  db.prepare('UPDATE host_reports SET at=? WHERE device_id=?').run(new Date(Date.now() - 25 * 3600e3).toISOString(), vm.id);
  assert.equal(nodeScriptsInto(db, { guests: [{ name: 'fileserver' }] }).guests[0].report, undefined);
  // the page of the hypervisor (admins) carries it
  db.prepare("INSERT INTO proxmox_hosts(name,kind,url,token_id,created_at,last_at,last_ok,data) VALUES('pve3','pve','https://10.0.0.13:8006','x@pve!y',?,?,1,?)")
    .run(at, at, JSON.stringify({ kind: 'pve', nodes: [{ name: 'pve3', online: true }], guests: [] }));
  const list = (await call('GET', '/api/proxmox')).data;
  assert.equal(list.find((x) => x.name === 'pve3').data.nodes[0].report.deviceId, node.id);
});

test('many machines: one query, quick', () => {
  const at = new Date().toISOString();
  const ins = db.prepare("INSERT INTO devices(name,type,created_at,updated_at) VALUES(?,'vm',?,?)");
  const rep = db.prepare('INSERT INTO host_reports(device_id, at, data) VALUES(?,?,?)');
  const body = JSON.stringify({ hostname: 'x', services: Array.from({ length: 200 }, (_, i) => ({ name: `s${i}`, state: 'running', failed: false })) });
  db.transaction(() => { for (let i = 0; i < 2000; i++) rep.run(ins.run(`vm-${i}`, at, at).lastInsertRowid, at, body.replace('"x"', `"vm-${i}"`)); })();
  const guests = Array.from({ length: 500 }, (_, i) => ({ name: `vm-${i}` }));
  const t0 = performance.now();
  const d = nodeScriptsInto(db, { nodes: [{ name: 'pve3' }], guests });
  const ms = performance.now() - t0;
  // the next hypervisor of the same page: the reports are not read again
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) joinScripts(db, { nodes: [{ name: 'pve3' }], guests });
  assert.ok(performance.now() - t1 < ms + 200, 'read once for the whole page');
  assert.equal(d.guests.filter((g) => g.report).length, 500);
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});
