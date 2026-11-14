// Watch new devices by themselves: a first monitor when a device is added, a few sensors once it delivers values
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { cleanReport } from '../src/hosts.js';
import { pick, DEVICE_PICKS, hostPicks } from '../src/monitor/autowatch.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());
const monsOf = (id) => db.prepare('SELECT type, name, options FROM monitors WHERE device_id=? ORDER BY id').all(id).map((m) => ({ ...m, o: JSON.parse(m.options || '{}') }));

test('the choice: a few values that matter, the system drive, nothing twice', () => {
  const m = [{ metric: 'hostOnline', key: '' }, { metric: 'hostCpu', key: '' }, { metric: 'hostMem', key: '' }, { metric: 'hostDisk', key: 'D:' }, { metric: 'hostDisk', key: 'C:' },
    { metric: 'servicesFailed', key: '' }, { metric: 'service', key: 'spooler' }, { metric: 'hostTempMax', key: '' }, { metric: 'hostTemp', key: 'cpu' }, { metric: 'hostUpdates', key: '' }];
  assert.deepEqual(pick(m, DEVICE_PICKS.host).map((x) => `${x.metric}|${x.key}`),
    ['hostOnline|', 'hostCpu|', 'hostMem|', 'hostDisk|C:', 'hostTempMax|', 'servicesFailed|']);
  // a Linux machine: "/" is the system drive; without it the first one
  assert.equal(pick([{ metric: 'hostDisk', key: '/srv' }, { metric: 'hostDisk', key: '/' }], DEVICE_PICKS.host)[0].key, '/');
  assert.equal(pick([{ metric: 'hostDisk', key: '/srv' }], DEVICE_PICKS.host)[0].key, '/srv');
  assert.deepEqual(pick(m, DEVICE_PICKS.host, new Set(['hostCpu|'])).map((x) => x.metric).includes('hostCpu'), false);
  // printer: the cartridges, not the waste box
  assert.deepEqual(pick([{ metric: 'supply', key: '1' }, { metric: 'supply', key: '9', receptacle: true }, { metric: 'printerErrors', key: '' }, { metric: 'pages', key: '' }], DEVICE_PICKS.printer)
    .map((x) => x.key), ['1', '']);
  assert.deepEqual(hostPicks('pbs').map((x) => x[0]), ['datastore', 'tasksFailed']);
});

let dev;
test('a device added by hand: a first monitor right away, sensors once its script reports - each once', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  // what is there already stays as it is
  const at = new Date().toISOString();
  const old = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('alt','server','10.0.10.9',?,?)").run(at, at).lastInsertRowid;
  const r = await call('POST', '/api/devices', { name: 'srv01', type: 'server', ip: '10.0.10.21' });
  assert.equal(r.status, 201);
  dev = r.data.id;
  await ctx.autoWatch.tick();
  const first = monsOf(dev);
  assert.equal(first.length, 1);
  assert.ok(['ping', 'tcp', 'http'].includes(first[0].type));
  assert.equal(first[0].name, 'srv01');
  assert.equal(monsOf(old).length, 0);
  // the Windows script reports for the first time
  db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?)').run(dev, at, JSON.stringify(cleanReport({ hostname: 'srv01', os: 'Windows Server 2022', cpu: 12, mem: 48,
    disks: [{ name: 'D:', total: 500e9, used: 100e9 }, { name: 'C:', total: 100e9, used: 40e9 }], services: [{ name: 'Spooler', state: 'running' }],
    temps: [{ chip: 'acpitz', dev: 'x', name: 'CPU', mC: 51000 }] })));
  await ctx.autoWatch.tick();
  const s = monsOf(dev).filter((m) => m.type === 'sensor');
  assert.deepEqual(s.map((m) => `${m.o.metric}|${m.o.key}`), ['hostOnline|', 'hostCpu|', 'hostMem|', 'hostDisk|C:', 'hostTempMax|', 'servicesFailed|']);
  assert.equal(s[1].name, `srv01: ${s[1].o.label}`);
  assert.match(s[1].name, /^srv01: /);
  assert.equal(s[1].o.op, 'ge');
  // once: no second set, and a deleted sensor does not come back
  await call('DELETE', `/api/monitors/${db.prepare("SELECT id FROM monitors WHERE device_id=? AND json_extract(options,'$.metric')='hostCpu'").get(dev).id}`);
  await ctx.autoWatch.tick();
  assert.equal(monsOf(dev).filter((m) => m.type === 'sensor').length, 5);
});

test('adopted from a scan: watched; the setting off: nothing is created', async () => {
  const at = new Date().toISOString();
  const scan = db.prepare("INSERT INTO scans(started_at,status,kind,targets) VALUES(?,'done','network','[]')").run(at).lastInsertRowid;
  const res = db.prepare("INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status) VALUES(?,?,?,?,?,?,?,?,'new')");
  const r1 = res.run(scan, '10.0.10.40', 'aa:bb:cc:00:00:40', 'drucker-eg', 'Brother', 'printer', 90, '{}').lastInsertRowid;
  const r2 = res.run(scan, '10.0.10.41', 'aa:bb:cc:00:00:41', 'drucker-og', 'Brother', 'printer', 90, '{}').lastInsertRowid;
  const a = await call('POST', `/api/scans/${scan}/adopt`, { ids: [r1] });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.watched, true);
  const pr = a.data.created[0];
  await ctx.autoWatch.tick();
  assert.equal(monsOf(pr).length, 1);
  // its first poll: toner and errors
  db.prepare('INSERT INTO printer_status(device_id,at,ok,error,data,alerts) VALUES(?,?,1,\'\',?,\'[]\')').run(pr, at, JSON.stringify({ supplies: [
    { key: '1.1', description: 'Black Toner', pct: 60 }, { key: '1.2', description: 'Waste', pct: 10, receptacle: true }], errors: [], pages: 1000 }));
  await ctx.autoWatch.tick();
  assert.deepEqual(monsOf(pr).filter((m) => m.type === 'sensor').map((m) => `${m.o.metric}|${m.o.key}|${m.o.op}|${m.o.threshold}`), ['supply|1.1|le|15', 'printerErrors||eq|']);
  // off
  assert.equal((await call('PUT', '/api/settings/autowatch', { enabled: false })).status, 200);
  const b = await call('POST', `/api/scans/${scan}/adopt`, { ids: [r2] });
  assert.equal(b.data.watched, false);
  await ctx.autoWatch.tick();
  assert.equal(monsOf(b.data.created[0]).length, 0);
  await call('PUT', '/api/settings/autowatch', { enabled: true });
});

test('a host under Virtualization: its nodes, storage and backups once it answers', async () => {
  const at = new Date().toISOString();
  const h = db.prepare("INSERT INTO proxmox_hosts(name,kind,url,token_id,secret,verify,created_at,last_at,last_ok,data,auto_watch) VALUES('Cluster','pve','https://pve1:8006','a@pve!b','x',1,?,?,0,'{}','{\"lang\":\"en\"}')").run(at, at).lastInsertRowid;
  await ctx.autoWatch.tick();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM monitors WHERE type='proxmox'").get().n, 0);
  db.prepare('UPDATE proxmox_hosts SET last_ok=1, data=? WHERE id=?').run(JSON.stringify({ kind: 'pve', nodes: [{ name: 'pve1', online: true, cpu: 3, mem: 20 }, { name: 'pve2', online: true, cpu: 5, mem: 30 }],
    storages: [{ node: 'pve1', name: 'local', pct: 30 }], guests: [{ vmid: 101, name: 'dc01', status: 'running', node: 'pve1' }], backups: [] }), h);
  await ctx.autoWatch.tick();
  const m = db.prepare("SELECT name, options FROM monitors WHERE type='proxmox' ORDER BY id").all().map((x) => [x.name, JSON.parse(x.options).metric]);
  assert.deepEqual(m.map((x) => x[1]), ['nodeOnline', 'nodeOnline', 'storage', 'backupFailed']);
  assert.match(m[0][0], /pve1/);
  await ctx.autoWatch.tick();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM monitors WHERE type='proxmox'").get().n, 4);
});
