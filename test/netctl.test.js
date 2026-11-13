// Network controllers: UniFi (UniFi OS and self-hosted), TP-Link Omada, MikroTik RouterOS against simulated APIs;
// devices go into the inventory by MAC; sensors per device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, proxmoxMetrics } from '../src/proxmox.js';
import { proxmoxCheck } from '../src/monitor/sensors.js';
import { rosUptime } from '../src/netctl.js';

function fake(dir, { unifiOs = true } = {}) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=ctl',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const seen = [];
  const json = (res, code, o, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const p = req.url.split('?')[0];
      seen.push({ m: req.method, p, cookie: req.headers.cookie || '', csrf: req.headers['x-csrf-token'] || req.headers['csrf-token'] || '', auth: req.headers.authorization || '' });
      const b = body ? JSON.parse(body) : {};
      // UniFi
      if (p === '/api/auth/login') {
        if (!unifiOs) return json(res, 404, {});
        return b.username === 'viewer' && b.password === 'pw' ? json(res, 200, {}, { 'Set-Cookie': 'TOKEN=abc; Path=/; HttpOnly', 'X-CSRF-Token': 'csrf1' }) : json(res, 401, {});
      }
      if (p === '/api/login') return b.username === 'viewer' && b.password === 'pw' ? json(res, 200, { meta: { rc: 'ok' } }, { 'Set-Cookie': 'unifises=xyz; Path=/' }) : json(res, 400, { meta: { rc: 'error' } });
      const pre = unifiOs ? '/proxy/network' : '';
      const unifiAuthed = unifiOs ? req.headers.cookie === 'TOKEN=abc' : req.headers.cookie === 'unifises=xyz';
      if (p === `${pre}/api/self/sites`) return unifiAuthed ? json(res, 200, { data: [{ name: 'default', desc: 'Default' }] }) : json(res, 401, {});
      if (p === `${pre}/api/s/default/stat/device`) {
        return json(res, 200, { data: [
          { mac: 'F4:92:BF:00:00:01', name: 'AP Flur', model: 'U6PRO', model_name: 'U6 Pro', type: 'uap', ip: '10.0.0.21', version: '6.6.77', serial: 'F492BF000001', state: 1, num_sta: 17, uptime: 86400, 'system-stats': { cpu: '7.1', mem: '41.0' }, upgradable: true, upgrade_to_firmware: '6.7.10' },
          { mac: 'f4:92:bf:00:00:02', name: 'Switch Keller', model: 'USL8LP', model_name: 'USW Lite 8 PoE', type: 'usw', ip: '10.0.0.22', version: '7.1.26', serial: 'F492BF000002', state: 0, uptime: 0 },
        ] });
      }
      if (p === `${pre}/api/s/default/stat/health`) return json(res, 200, { data: [{ subsystem: 'wlan', num_user: 17 }, { subsystem: 'lan', num_user: 9 }] });
      if (p === '/api/auth/logout' || p === '/api/logout') return json(res, 200, {});
      // Omada
      if (p === '/api/info') return json(res, 200, { errorCode: 0, result: { omadacId: 'abc123', controllerVer: '5.14.26' } });
      if (p === '/abc123/api/v2/login') return b.username === 'viewer' && b.password === 'pw' ? json(res, 200, { errorCode: 0, result: { token: 'tok9' } }, { 'Set-Cookie': 'TPOMADA_SESSIONID=s1; Path=/' }) : json(res, 200, { errorCode: -30109, msg: 'Invalid username or password.' });
      const omAuthed = req.headers['csrf-token'] === 'tok9' && req.headers.cookie === 'TPOMADA_SESSIONID=s1';
      if (p === '/abc123/api/v2/sites') return omAuthed ? json(res, 200, { errorCode: 0, result: { data: [{ id: 's1', name: 'Büro' }] } }) : json(res, 200, { errorCode: -1200, msg: 'login' });
      if (p === '/abc123/api/v2/sites/s1/devices') {
        return json(res, 200, { errorCode: 0, result: [
          { mac: '50-91-E3-00-00-01', name: 'EAP Empfang', model: 'EAP245(EU) v3.0', showModel: 'EAP245(EU) v3.0', type: 'ap', ip: '10.0.1.5', firmwareVersion: '5.1.0', sn: 'Y2250', statusCategory: 1, clientNum: 4, uptimeLong: 3600, cpuUtil: 3, memUtil: 50, needUpgrade: false },
          { mac: '50-91-E3-00-00-02', name: 'ER605', model: 'ER605 v2.0', type: 'gateway', statusCategory: 0, clientNum: 0 },
        ] });
      }
      if (p === '/abc123/api/v2/logout') return json(res, 200, { errorCode: 0 });
      // MikroTik
      if (p.startsWith('/rest/')) {
        if (req.headers.authorization !== `Basic ${Buffer.from('readonly:pw').toString('base64')}`) return json(res, 401, { error: 401, message: 'Unauthorized' });
        const R = {
          '/rest/system/resource': { uptime: '1w2d3h4m5s', 'cpu-load': '12', 'free-memory': '536870912', 'total-memory': '1073741824', version: '7.16.2 (stable)', 'board-name': 'CRS326-24G-2S+' },
          '/rest/system/routerboard': { model: 'CRS326-24G-2S+', 'serial-number': 'HD60812ABC', 'current-firmware': '7.16.2' },
          '/rest/system/identity': { name: 'core-sw' },
          '/rest/interface': [{ name: 'ether1', type: 'ether', 'mac-address': '48:A9:8A:00:00:01', running: 'true', disabled: 'false' }, { name: 'ether2', type: 'ether', 'mac-address': '48:A9:8A:00:00:02', running: 'false', disabled: 'false' }],
        };
        return R[p] ? json(res, 200, R[p]) : json(res, 404, {});
      }
      json(res, 404, {});
    });
  });
  return { srv, seen, ca: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') };
}

async function withFake(opts, fn) {
  const dir = fs.mkdtempSync(path.join(tmp, 'ctl-'));
  const f = fake(dir, opts);
  await new Promise((r) => f.srv.listen(0, '127.0.0.1', r));
  try { await fn({ ...f, url: `https://127.0.0.1:${f.srv.address().port}` }); } finally { f.srv.close(); }
}

test('UniFi OS console: devices, clients, firmware update; devices go into the inventory', () => withFake({}, async ({ url, ca, seen }) => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  const ts = new Date().toISOString();
  // in the inventory from a scan: type and model only guessed
  const ap = db.prepare("INSERT INTO devices(name,type,ip,mac,model,auto_fields,created_at,updated_at) VALUES('ap','switch','10.0.0.21','f4:92:bf:00:00:01','U6','{\"type\":\"switch\",\"model\":\"U6\"}',?,?)").run(ts, ts).lastInsertRowid;
  const wrong = await px.poll(px.create({ name: 'x', kind: 'unifi', url, token_id: 'viewer', secret: 'nope', ca }).id);
  assert.match(wrong.last_error, /sign-in refused/);
  const h = await px.poll(px.create({ name: 'UDM', kind: 'unifi', url, token_id: 'viewer', secret: 'pw', ca }).id);
  assert.equal(h.last_ok, true, h.last_error);
  assert.deepEqual(h.data.netdevices.map((d) => [d.name, d.type, d.online, d.clients, d.cpu, d.update, d.deviceId]),
    [['AP Flur', 'accesspoint', true, 17, 7, '6.7.10', ap], ['Switch Keller', 'switch', false, null, null, '', null]]);
  assert.equal(h.data.clients, 26);
  assert.ok(seen.some((x) => x.p === '/proxy/network/api/s/default/stat/device' && x.csrf === 'csrf1'), 'CSRF token of UniFi OS sent');
  assert.ok(seen.some((x) => x.p === '/api/auth/logout'), 'signs out');
  assert.deepEqual(db.prepare('SELECT type, model, serial, os, vendor FROM devices WHERE id=?').get(ap), { type: 'accesspoint', model: 'U6 Pro', serial: 'F492BF000001', os: '6.6.77', vendor: 'Ubiquiti' },
    'guessed type and model corrected by the controller');
  // sensors: device online, clients, firmware updates
  const m = proxmoxMetrics(h.data);
  assert.deepEqual([...new Set(m.map((x) => x.metric))], ['netOnline', 'netClients', 'netCpu', 'netMem', 'clientsTotal', 'netUpdates']);
  const chk = (metric, key = '', op = 'eq', threshold = '') => proxmoxCheck(db, { options: JSON.stringify({ host: h.id, metric, key, op, threshold, label: metric }) });
  assert.equal(chk('netOnline', 'f4:92:bf:00:00:02').ok, false);
  assert.equal(chk('netOnline', 'f4:92:bf:00:00:01').data.state, 'online');
  assert.equal(chk('netUpdates', '', 'gt', '0').ok, false);
  assert.equal(chk('netClients', 'f4:92:bf:00:00:01', 'ge', '60').data.v, 17);
}));

test('UniFi Network application (self-hosted, port 8443)', () => withFake({ unifiOs: false }, async ({ url, ca }) => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  const h = await px.poll(px.create({ name: 'Controller', kind: 'unifi', url, token_id: 'viewer', secret: 'pw', ca }).id);
  assert.equal(h.last_ok, true, h.last_error);
  assert.equal(h.data.netdevices.length, 2);
}));

test('Omada controller: sign-in with token, sites, devices', () => withFake({}, async ({ url, ca }) => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  assert.match((await px.poll(px.create({ name: 'x', kind: 'omada', url, token_id: 'viewer', secret: 'bad', ca }).id)).last_error, /sign-in refused/);
  const h = await px.poll(px.create({ name: 'OC200', kind: 'omada', url, token_id: 'viewer', secret: 'pw', ca }).id);
  assert.equal(h.last_ok, true, h.last_error);
  assert.deepEqual(h.data.netdevices.map((d) => [d.name, d.type, d.online, d.clients, d.mac]),
    [['EAP Empfang', 'accesspoint', true, 4, '50:91:e3:00:00:01'], ['ER605', 'router', false, 0, '50:91:e3:00:00:02']]);
  assert.equal(h.data.controller.version, '5.14.26');
}));

test('MikroTik RouterOS 7: REST API, read-only user', () => withFake({}, async ({ url, ca }) => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  const h = await px.poll(px.create({ name: 'core-sw', kind: 'mikrotik', url, token_id: 'readonly', secret: 'pw', ca }).id);
  assert.equal(h.last_ok, true, h.last_error);
  assert.deepEqual(h.data.netdevices.map((d) => [d.name, d.type, d.serial, d.firmware, d.cpu, d.mem, d.uptime, d.mac]),
    [['core-sw', 'switch', 'HD60812ABC', 'RouterOS 7.16.2 (stable)', 12, 50, 788645, '48:a9:8a:00:00:01']]);
  assert.deepEqual(h.data.ports.map((p) => [p.name, p.up]), [['ether1', true], ['ether2', false]]);
  assert.equal(rosUptime('3d4h'), 273600);
  assert.ok(!JSON.stringify(px.list()).includes('"pw"'), 'password never listed');
}));
