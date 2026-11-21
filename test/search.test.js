// Search over everything: devices (name, address, MAC also without separators), monitors and sensors, locations,
// hypervisors and users - each only what the user may see; LIKE wildcards are plain text. "First steps" on the
// overview: ticked by the data, only for administrators, hidden for good.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { searchAll } from '../src/search.js';

const app = await startApp();
const { call, db } = app;
test.after(() => app.close());

const ids = {};
test('setup: an empty installation shows the first steps to the administrator', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  const d = (await call('GET', '/api/dashboard')).data;
  assert.deepEqual(d.start, { location: false, scan: false, devices: false, channel: false, monitor: false, totp: false });
  const at = new Date().toISOString();
  ids.locA = db.prepare("INSERT INTO locations(name,created_at) VALUES('Hauptgebäude',?)").run(at).lastInsertRowid;
  ids.locB = db.prepare("INSERT INTO locations(name,created_at) VALUES('Außenstelle',?)").run(at).lastInsertRowid;
  db.prepare("INSERT INTO subnets(location_id,cidr,created_at) VALUES(?,'10.0.10.0/24',?)").run(ids.locA, at);
  const dev = (name, ip, mac, loc) => db.prepare("INSERT INTO devices(name,type,ip,mac,hostname,location_id,created_at,updated_at) VALUES(?,'server',?,?,?,?,?,?)")
    .run(name, ip, mac, `${name.toLowerCase()}.firma.local`, loc, at, at).lastInsertRowid;
  ids.dc = dev('DC01', '10.0.10.5', 'AA:BB:CC:00:11:22', ids.locA);
  ids.fs = dev('FS01', '10.0.10.6', 'AA:BB:CC:00:11:33', ids.locA);
  ids.pc = dev('PC-0042', '10.0.20.42', null, ids.locB);
  ids.odd = dev('Test_50%', '10.0.10.9', null, ids.locA);
  const mon = (name, type, target, dev) => db.prepare('INSERT INTO monitors(name,type,target,device_id,interval_s,created_at,updated_at) VALUES(?,?,?,?,60,?,?)').run(name, type, target, dev, at, at).lastInsertRowid;
  ids.ping = mon('DC01 Ping', 'ping', '10.0.10.5', ids.dc);
  ids.cpu = mon('DC01 CPU', 'sensor', '', ids.dc);
  ids.web = mon('Intranet', 'http', 'https://intranet.firma.local/', null);
  db.prepare("INSERT INTO proxmox_hosts(name,kind,url,token_id,created_at) VALUES('pve01','pve','https://10.0.10.11:8006','x@pve!y',?)").run(at);
});

test('devices by name, address, host name and MAC (with or without separators); exact hits first', async () => {
  const r = (await call('GET', '/api/search?q=dc01')).data;
  assert.equal(r.devices[0].id, ids.dc);
  assert.equal(r.devices[0].location, 'Hauptgebäude');
  assert.deepEqual(r.monitors.map((m) => m.id), [ids.ping]);
  assert.deepEqual(r.sensors.map((m) => m.id), [ids.cpu]);
  assert.deepEqual((await call('GET', '/api/search?q=10.0.10.6')).data.devices.map((d) => d.id), [ids.fs]);
  assert.deepEqual((await call('GET', '/api/search?q=aabbcc001133')).data.devices.map((d) => d.id), [ids.fs]);
  assert.deepEqual((await call('GET', '/api/search?q=aa-bb-cc-00-11-22')).data.devices.map((d) => d.id), [ids.dc]);
  assert.deepEqual((await call('GET', '/api/search?q=fs01.firma')).data.devices.map((d) => d.id), [ids.fs]);
  assert.deepEqual((await call('GET', '/api/search?q=intranet.firma')).data.monitors.map((m) => m.id), [ids.web], 'monitor by target');
  assert.deepEqual((await call('GET', '/api/search?q=pve0')).data.hosts.map((x) => x.name), ['pve01']);
  assert.deepEqual((await call('GET', '/api/search?q=außen')).data.locations.map((l) => l.id), [ids.locB]);
  assert.deepEqual((await call('GET', '/api/search?q=testad')).data.users.map((u) => u.username), ['testadmin']);
});

test('% and _ are plain text; one letter finds nothing on the server', async () => {
  assert.deepEqual((await call('GET', '/api/search?q=50%25')).data.devices.map((d) => d.id), [ids.odd]);
  assert.deepEqual((await call('GET', '/api/search?q=e_t')).data.devices, [], '_ is no wildcard (would find Test)');
  assert.deepEqual((await call('GET', '/api/search?q=d')).data.devices, []);
  assert.equal((await call('GET', `/api/search?q=${'x'.repeat(300)}`)).status, 200);
});

test('a limited user finds only what is his: devices of his location, their monitors; no hosts, users, global monitors', async () => {
  assert.equal((await call('POST', '/api/users', { username: 'max', password: 'Sicher-Passwort-2', role: 'editor', locations: [ids.locB] })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'max', password: 'Sicher-Passwort-2' }, { who: 'max' })).status, 200);
  const all = (q) => call('GET', `/api/search?q=${encodeURIComponent(q)}`, undefined, { who: 'max' }).then((r) => r.data);
  assert.deepEqual((await all('10.0')).devices.map((d) => d.id), [ids.pc]);
  assert.deepEqual((await all('dc01')).devices, []);
  assert.deepEqual((await all('dc01')).monitors, []);
  assert.deepEqual((await all('intranet')).monitors, [], 'a monitor without device belongs to no location');
  assert.deepEqual((await all('haupt')).locations, []);
  assert.deepEqual((await all('testadmin')).users, []);
  assert.equal((await call('GET', '/api/dashboard', undefined, { who: 'max' })).data.start, null, 'first steps only for administrators');
});

test('a viewer sees no hypervisors; quick with many devices', async () => {
  const viewer = { role: 'viewer' };
  assert.deepEqual(searchAll(db, 'pve', { user: viewer }).hosts, []);
  const at = new Date().toISOString();
  const ins = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES(?,'computer',?,?,?)");
  db.transaction(() => { for (let i = 0; i < 20000; i++) ins.run(`PC-${String(i).padStart(5, '0')}`, `10.1.${i >> 8}.${i & 255}`, at, at); })();
  const t0 = performance.now();
  const r = searchAll(db, 'pc-1', { user: { role: 'admin' } });
  const ms = performance.now() - t0;
  assert.equal(r.devices.length, 8);
  assert.ok(ms < 500, `${Math.round(ms)} ms`);
});

test('first steps: ticked by the data, hidden for good', async () => {
  const at = new Date().toISOString();
  db.prepare("INSERT INTO scans(started_at,status,targets,stats) VALUES(?,'done','[]','{}')").run(at);
  db.prepare("INSERT INTO channels(name,type,config,created_at) VALUES('Mail','email','{}',?)").run(at);
  const s = (await call('GET', '/api/dashboard')).data.start;
  assert.deepEqual(s, { location: true, scan: true, devices: true, channel: true, monitor: true, totp: false });
  assert.equal((await call('PUT', '/api/settings/start', { hidden: true }, { who: 'max' })).status, 403);
  assert.equal((await call('PUT', '/api/settings/start', { hidden: true })).status, 200);
  assert.equal((await call('GET', '/api/dashboard')).data.start, null);
});
