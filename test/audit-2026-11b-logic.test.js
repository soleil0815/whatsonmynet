// Audit 2026-11 (logic and plausibility): status pages and deleted/merged monitors, renamed plugins, the same ZFS pool
// watched twice, host name ownership (migration, merge), the status page summary and "watch new devices" rounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, memoryDb } from './helpers.js';
import { cleanReport } from '../src/hosts.js';
import { createPlugins } from '../src/plugins.js';
import { mergeDuplicates } from '../src/monitor/dedupe.js';
import { createInventory } from '../src/inventory.js';
import { migrate } from '../src/db.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());
const at = () => new Date().toISOString();
const mon = (name, target, status = 'up', created = at()) => Number(db.prepare(`INSERT INTO monitors(name,type,target,status,interval_s,created_at,updated_at)
  VALUES(?,'ping',?,?,60,?,?)`).run(name, target, status, created, created).lastInsertRowid);
const itemsOf = (id) => JSON.parse(db.prepare('SELECT items FROM status_pages WHERE id=?').get(id).items);
const lineNames = (v) => v.sections.flatMap((s) => s.lines.map((l) => l.name));

test('setup', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
});

// ---------------------------------------------------------------------------------------------------- status pages
test('status page: a deleted monitor leaves the page, so a new monitor with the reused id does not show up there', async () => {
  const a = mon('Mailserver', '10.0.10.21');
  const vpn = mon('VPN', '10.0.10.22');
  const p = await call('POST', '/api/status-pages', { name: 'Public', items: [{ type: 'monitor', id: a }, { type: 'monitor', id: vpn }] });
  assert.equal(p.status, 201);
  assert.equal((await call('DELETE', `/api/monitors/${vpn}`)).status, 200);
  assert.deepEqual(itemsOf(p.data.id).map((x) => x.id), [a]);
  const secret = mon('Payroll-DB intern', '10.0.10.99');
  assert.equal(secret, vpn, 'SQLite gives the id again');
  const v = await call('GET', `/api/status-pages/${p.data.id}/preview`);
  assert.deepEqual(lineNames(v.data), ['Mailserver']);
});

test('status page: still saved after one of its monitors is gone; a newly chosen unknown monitor is still refused', async () => {
  const x = mon('Drucker EG', '10.0.10.31');
  const y = mon('Drucker OG', '10.0.10.32');
  const p = await call('POST', '/api/status-pages', { name: 'Drucker', items: [{ type: 'monitor', id: x }, { type: 'monitor', id: y }] });
  // gone without the clean-up (e.g. a page from before this fix)
  db.prepare('DELETE FROM monitors WHERE id=?').run(x);
  // the editor (opened before) sends the stored list back
  const r2 = await call('PUT', `/api/status-pages/${p.data.id}`, { items: [{ type: 'monitor', id: x }, { type: 'monitor', id: y }] });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  assert.deepEqual(r2.data.items.map((i) => i.id), [y]);
  db.prepare('UPDATE status_pages SET items=? WHERE id=?').run(JSON.stringify([{ type: 'monitor', id: x }, { type: 'monitor', id: y }]), p.data.id);
  const r = await call('PUT', `/api/status-pages/${p.data.id}`, { notice: 'Wartung morgen' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.items.map((i) => i.id), [y]);
  assert.equal((await call('PUT', `/api/status-pages/${p.data.id}`, { items: [{ type: 'monitor', id: 999999 }] })).status, 400);
});

test('status page: merging duplicate monitors points the line at the kept one and keeps its label', async () => {
  const keep = mon('NAS ping', '10.0.10.45');
  const dup = mon('NAS ping (2)', '10.0.10.45');
  const p = await call('POST', '/api/status-pages', { name: 'NAS', items: [{ type: 'group', group: 'Keller', label: '' }, { type: 'monitor', id: dup, label: 'Dateiablage' }] });
  const out = mergeDuplicates(db);
  assert.ok(out.some((g) => g.kept === keep));
  const items = itemsOf(p.data.id);
  assert.deepEqual(items.find((i) => i.type === 'monitor'), { type: 'monitor', id: keep, label: 'Dateiablage' });
  assert.equal(items.length, 2);
  const v = await call('GET', `/api/status-pages/${p.data.id}/preview`);
  assert.ok(lineNames(v.data).includes('Dateiablage'));
});

test('status page summary counts only lines with a state of their own (not paused or still checked ones)', async () => {
  const up = mon('Web', '10.0.10.51', 'up');
  const down = mon('Mail', '10.0.10.52', 'down');
  const off = mon('Alt', '10.0.10.53', 'up');
  db.prepare('UPDATE monitors SET enabled=0 WHERE id=?').run(off);
  const p = await call('POST', '/api/status-pages', { name: 'Summe', items: [up, down, off].map((id) => ({ type: 'monitor', id })) });
  const v = (await call('GET', `/api/status-pages/${p.data.id}/preview`)).data;
  assert.equal(v.overall, 'partial');
  assert.equal(v.bad, 1);
  assert.equal(v.counted, 2, 'the paused line is no "of 3"');
  db.prepare('UPDATE monitors SET enabled=0 WHERE id=?').run(up);
  const v2 = (await call('GET', `/api/status-pages/${p.data.id}/preview`)).data;
  assert.equal(v2.overall, 'down', 'the only monitored line is down');
});

test('migration 43 removes monitor lines of status pages whose monitor is gone or younger than the page', () => {
  const mdb = memoryDb();
  const old = '2026-01-01T00:00:00.000Z';
  const m1 = mdb.prepare("INSERT INTO monitors(name,type,target,interval_s,created_at,updated_at) VALUES('A','ping','10.0.10.1',60,?,?)").run(old, old).lastInsertRowid;
  const m2 = mdb.prepare("INSERT INTO monitors(name,type,target,interval_s,created_at,updated_at) VALUES('B','ping','10.0.10.2',60,?,?)").run(at(), at()).lastInsertRowid;
  const items = [{ type: 'monitor', id: Number(m1), label: 'Eins' }, { type: 'group', group: 'EG', label: '', members: false }, { type: 'monitor', id: Number(m2), label: '' }, { type: 'monitor', id: 4242, label: '' }];
  const ins = mdb.prepare("INSERT INTO status_pages(name,slug,access,items,created_at,updated_at) VALUES(?,?,'link',?,?,?)");
  const p = ins.run('P', 'abcdefghijklmnopqrstuvwx', JSON.stringify(items), '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z').lastInsertRowid;
  const q = ins.run('Q', 'bcdefghijklmnopqrstuvwxy', 'not json', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z').lastInsertRowid;
  mdb.pragma('user_version = 42');
  migrate(mdb, { quiet: true });
  assert.deepEqual(JSON.parse(mdb.prepare('SELECT items FROM status_pages WHERE id=?').get(p).items), items.slice(0, 2));
  assert.equal(mdb.prepare('SELECT items FROM status_pages WHERE id=?').get(q).items, 'not json');
  mdb.close();
});

// ---------------------------------------------------------------------------------------------------- plugins
test('plugin renamed: the copy with the current version counts, the old file is shown as one to delete', () => {
  const plugins = createPlugins({ db });
  const d = Number(db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('PC-0001','server','10.0.10.61',?,?)").run(at(), at()).lastInsertRowid);
  const p = plugins.create({ name: 'Backup age', os: 'linux', code: 'echo "age: 3 h"', targets: { all: true } });
  const oldFile = p.file;
  const u = plugins.update(p.id, { name: 'Backup status' });
  assert.notEqual(u.file, oldFile);
  const rep = [{ file: oldFile, id: p.id, version: 1, state: 'outdated', text: 'version 1 - WhatsOnMyNet has version 2' },
    { file: u.file, id: p.id, version: 2, state: 'ok', text: '1 value(s)' }].sort((a, b) => a.file.localeCompare(b.file));
  db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?)').run(d, at(), JSON.stringify({ ...cleanReport({ hostname: 'pc-0001', os: 'Debian 12' }), plugins: rep }));
  const ov = plugins.overview(d, 'linux', rep);
  const mine = ov.items.filter((x) => x.id === p.id);
  assert.equal(mine[0].state, 'ok');
  assert.equal(mine[0].file, u.file);
  assert.deepEqual(mine.slice(1).map((x) => [x.state, x.file]), [['oldFile', oldFile]]);
  const roll = plugins.list().find((x) => x.id === p.id).rollout;
  assert.equal(roll.ok, 1, JSON.stringify(roll));
  assert.equal(roll.expected, 1);
  // a machine silent for more than a day does not count (as everywhere else)
  db.prepare('UPDATE host_reports SET at=? WHERE device_id=?').run(new Date(Date.now() - 30 * 3600e3).toISOString(), d);
  assert.equal(plugins.list().find((x) => x.id === p.id).rollout.expected, 0);
  assert.ok(!plugins.choices().devices.some((x) => x.id === d));
  db.prepare('DELETE FROM host_reports WHERE device_id=?').run(d);
  plugins.remove(p.id);
});

// ---------------------------------------------------------------------------------------------------- watch new devices
const zfsReport = (hostname) => JSON.stringify(cleanReport({ hostname, os: 'Debian GNU/Linux 12',
  zfs: { list: 'rpool\tONLINE\t1000000\t400000\n', status: { rpool: '  pool: rpool\n state: ONLINE\nconfig:\n\n\tNAME STATE\n\trpool ONLINE\n\nerrors: No known data errors\n' } } }));
const pveData = (node) => JSON.stringify({ kind: 'pve', nodes: [{ name: node, online: true, cpu: 3, mem: 20 }], storages: [], guests: [], backups: [],
  pools: [{ kind: 'zfs', name: 'rpool', node, state: 'ONLINE', good: true, used: 400000, total: 1000000 }] });
const poolSensors = (node, dev) => db.prepare(`SELECT type, json_extract(options,'$.metric') metric, json_extract(options,'$.key') key FROM monitors
  WHERE (json_extract(options,'$.metric')='pool' AND json_extract(options,'$.key')=?) OR (json_extract(options,'$.metric')='hostPool' AND device_id=?)`).all(`zfs:${node}/rpool`, dev);

test('watch new devices: a Proxmox node with the Linux script gets one sensor for its ZFS pool (script first)', async () => {
  await call('PUT', '/api/settings/autowatch', { enabled: true });
  const r = await call('POST', '/api/devices', { name: 'pve1', type: 'server', ip: '10.0.10.71' });
  assert.equal(r.status, 201);
  db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?)').run(r.data.id, at(), zfsReport('pve1'));
  db.prepare(`INSERT INTO proxmox_hosts(name,kind,url,token_id,secret,verify,created_at,last_at,last_ok,data,auto_watch)
    VALUES('PVE','pve','https://10.0.10.71:8006','a@pve!b','x',1,?,?,1,?,'{"lang":"en"}')`).run(at(), at(), pveData('pve1'));
  await ctx.autoWatch.tick();
  await ctx.autoWatch.tick();
  const rows = poolSensors('pve1', r.data.id);
  assert.equal(rows.length, 1, JSON.stringify(rows));
});

test('watch new devices: the same the other way round (hypervisor first, the script later)', async () => {
  const r = await call('POST', '/api/devices', { name: 'pve2.firma.local', type: 'server', ip: '10.0.10.72' });
  assert.equal(r.status, 201);
  db.prepare(`INSERT INTO proxmox_hosts(name,kind,url,token_id,secret,verify,created_at,last_at,last_ok,data,auto_watch)
    VALUES('PVE2','pve','https://10.0.10.72:8006','a@pve!b','x',1,?,?,1,?,'{"lang":"en"}')`).run(at(), at(), pveData('pve2'));
  await ctx.autoWatch.tick();
  assert.equal(poolSensors('pve2', r.data.id).length, 1);
  db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?)').run(r.data.id, at(), zfsReport('pve2'));
  await ctx.autoWatch.tick();
  const rows = poolSensors('pve2', r.data.id);
  assert.deepEqual(rows.map((x) => x.metric), ['pool'], JSON.stringify(rows));
  // the other values of the script still come
  assert.ok(db.prepare("SELECT 1 FROM monitors WHERE device_id=? AND json_extract(options,'$.metric')='hostOnline'").get(r.data.id));
});

test('watch new devices: a device marked while a round runs is handled right after it, not a minute later', async () => {
  const ins = (name) => Number(db.prepare("INSERT INTO devices(name,type,created_at,updated_at,auto_watch) VALUES(?,'server',?,?,'{\"lang\":\"en\"}')").run(name, at(), at()).lastInsertRowid);
  const a = ins('PC-0002');
  const first = ctx.autoWatch.tick();
  const b = ins('PC-0003');
  // as markDevices asks (the minute timer does not ask for another round - audit-2026-11b-review.test.js)
  assert.equal(await ctx.autoWatch.tick({ rerun: true }), 0, 'a round runs already');
  await first;
  const w = (id) => JSON.parse(db.prepare('SELECT auto_watch FROM devices WHERE id=?').get(id).auto_watch);
  assert.equal(w(a).conn, true);
  assert.equal(w(b).conn, true, 'second device waited for the next round');
});

// ---------------------------------------------------------------------------------------------------- host name ownership
function scan(mdb, row) {
  const scanId = mdb.prepare("INSERT INTO scans(kind,status,targets,started_at) VALUES('network','running','[]',?)").run(at()).lastInsertRowid;
  return mdb.prepare(`INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status) VALUES(?,?,?,?,?,?,?,?,'pending')`)
    .run(scanId, row.ip, row.mac, row.hostname, '', 'server', 0.8, JSON.stringify({ ports: [22] })).lastInsertRowid;
}

test('merge: a typed host name taken from the dropped device stays the user\'s', () => {
  const mdb = memoryDb();
  const inv = createInventory(mdb);
  const keep = inv.create({ name: 'NAS', ip: '10.0.10.81', mac: '00:11:32:00:00:01' }, 'admin');
  mdb.prepare('UPDATE devices SET auto_fields=\'{"vendor":"x"}\' WHERE id=?').run(keep.id);
  const drop = inv.create({ name: 'NAS 2', ip: '10.0.10.82', mac: '00:11:32:00:00:02', hostname: 'nas-archiv' }, 'admin');
  inv.merge(keep.id, drop.id, 'admin');
  assert.equal(inv.get(keep.id).hostname, 'nas-archiv');
  inv.applyResult(scan(mdb, { ip: '10.0.10.81', mac: '00:11:32:00:00:01', hostname: 'ds920.firma.local' }));
  assert.equal(inv.get(keep.id).hostname, 'nas-archiv');
  assert.deepEqual(JSON.parse(mdb.prepare('SELECT auto_fields FROM devices WHERE id=?').get(keep.id).auto_fields), { vendor: 'x', hostname: null });
  mdb.close();
});

test('migration 43: a host name typed into the create form before the rule becomes the user\'s; scan-owned ones stay', () => {
  const mdb = memoryDb();
  const dev = (hostname, mac, auto = '{}') => Number(mdb.prepare("INSERT INTO devices(name,type,ip,mac,hostname,auto_fields,created_at,updated_at) VALUES('PC','server','10.0.10.90',?,?,?,?,?)")
    .run(mac, hostname, auto, at(), at()).lastInsertRowid);
  const hist = (id, kind, detail) => mdb.prepare("INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,'admin',?,?)").run(id, at(), kind, JSON.stringify(detail));
  const typed = dev('drucker-buero', '00:11:22:33:44:01', '{"serial":"S1"}'); hist(typed, 'created', { source: 'manual' }); hist(typed, 'edit', { fields: [{ field: 'owner', from: '', to: 'IT' }] });
  const adopted = dev('pc-0001.firma.local', '00:11:22:33:44:02'); hist(adopted, 'created', { source: 'scan' });
  const changed = dev('scan.firma.local', '00:11:22:33:44:03'); hist(changed, 'created', { source: 'manual' }); hist(changed, 'change', { field: 'hostname', from: 'a', to: 'scan.firma.local' });
  const reported = dev('host-1', '00:11:22:33:44:04'); hist(reported, 'created', { source: 'manual' }); hist(reported, 'snmp', { source: 'script', fields: [{ field: 'hostname', from: '', to: 'host-1' }] });
  const owned = dev('own', '00:11:22:33:44:05', '{"hostname":"own"}'); hist(owned, 'created', { source: 'manual' });
  const empty = dev('', '00:11:22:33:44:06'); hist(empty, 'created', { source: 'manual' });
  const merged = dev('m.firma.local', '00:11:22:33:44:07'); hist(merged, 'created', { source: 'manual' }); hist(merged, 'merged', { name: 'x' });
  const noHistory = dev('nohist', '00:11:22:33:44:08');
  const names = mdb.prepare('SELECT id, hostname FROM devices ORDER BY id').all();
  mdb.pragma('user_version = 42');
  migrate(mdb, { quiet: true });
  const autoOf = (id) => JSON.parse(mdb.prepare('SELECT auto_fields FROM devices WHERE id=?').get(id).auto_fields);
  assert.deepEqual(autoOf(typed), { serial: 'S1', hostname: null });
  for (const id of [adopted, changed, reported, empty, merged, noHistory]) assert.deepEqual(autoOf(id), {}, `device ${id}`);
  assert.deepEqual(autoOf(owned), { hostname: 'own' });
  assert.deepEqual(mdb.prepare('SELECT id, hostname FROM devices ORDER BY id').all(), names, 'host names are never changed');
  const inv = createInventory(mdb);
  inv.applyResult(scan(mdb, { ip: '10.0.10.90', mac: '00:11:22:33:44:01', hostname: 'npi0815.firma.local' }));
  assert.equal(inv.get(typed).hostname, 'drucker-buero');
  mdb.close();
});
