// The tip to monitor a machine with the script: hidden per device / hypervisor on request (editors / admins),
// Proxmox nodes know whether their script reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp } from './helpers.js';
import { nodeScriptsInto } from '../src/hosts.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());

test('"do not show again" per device: editors only, kept on the device', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'michael', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'viewer' });
  await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'viewer' });
  const d = ctx.inventory.create({ name: 'pve1', type: 'hypervisor', ip: '10.0.0.11', os: 'Proxmox VE 9' }, 'michael');
  assert.equal((await call('GET', `/api/devices/${d.id}`)).data.script_tip_hidden, 0);
  assert.equal((await call('PUT', `/api/devices/${d.id}/script-tip`, { hidden: true }, { who: 'viewer' })).status, 403);
  assert.equal((await call('PUT', `/api/devices/${d.id}/script-tip`, { hidden: true })).status, 200);
  assert.equal((await call('GET', `/api/devices/${d.id}`)).data.script_tip_hidden, 1);
  assert.equal((await call('PUT', '/api/devices/9999/script-tip', { hidden: true })).status, 404);
});

test('Proxmox nodes: which ones run the script; the tip of a host can be hidden', async () => {
  const dev = ctx.inventory.create({ name: 'pve2', type: 'hypervisor', ip: '10.0.0.12', hostname: 'pve2.firma.local' }, 'michael');
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
