// Code audit 2026-11: one test per confirmed finding (each failed on the state before the fix).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { memoryDb, tmp } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { httpProbe, extractTitle, netbios } from '../src/scan/probes.js';
import { classify } from '../src/scan/classify.js';
import { parseStorage } from '../src/scan/nas.js';
import { validateTargets } from '../src/scan/engine.js';
import { fillDevice } from '../src/devicefill.js';
import { httpCheck } from '../src/monitor/checks.js';
import { redisCheck } from '../src/monitor/services.js';
import { request as providerRequest } from '../src/monitor/providers.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';
import { createChannels } from '../src/monitor/notify.js';
import { tlsOptions } from '../src/proxmox.js';
import { mergePush } from '../src/virt.js';
import { cleanScanFacts } from '../src/scanfacts.js';
import { hostScript } from '../src/hostscripts.js';
import { serverBase } from '../src/hosts.js';
import { mdToHtml } from '../public/js/md.js';
import { keyPin } from '../src/tls.js';
import { inspect, applyPendingRestore, pendingPath } from '../src/backup.js';
import { createInventory } from '../src/inventory.js';
import { createLocations } from '../src/locations.js';
import { agentConfig, makeHttpsAgent } from '../src/agent.js';

const listen = (srv, host = '127.0.0.1') => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));
const quick = async (fn, ms) => { const t0 = Date.now(); const r = await fn(); assert.ok(Date.now() - t0 < ms, `took ${Date.now() - t0} ms`); return r; };
const ts = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------- scanner

test('scanner: a NetBIOS answer of one byte does not end the program', async (t) => {
  const srv = dgram.createSocket('udp4');
  try { await new Promise((res, rej) => { srv.once('error', rej); srv.bind(137, '127.0.0.5', res); }); } catch { t.skip('port 137 needs root'); return; }
  srv.on('message', (_m, r) => srv.send(Buffer.from([1]), r.port, r.address));
  assert.equal(await netbios('127.0.0.5', 800), null);
  srv.close();
});

test('scanner: a web page trickling in byte by byte does not hold the scan', async () => {
  const srv = http.createServer((_q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.write('<title>x'); const i = setInterval(() => s.write('a'), 300); s.on('close', () => clearInterval(i)); });
  const port = await listen(srv);
  const r = await quick(() => httpProbe('127.0.0.1', port, 'http', 1000), 5000);
  assert.equal(r.status, 200);
  srv.closeAllConnections(); srv.close();
});

test('scanner: crafted page and SNMP text are no ReDoS', () => {
  const t0 = Date.now();
  extractTitle('<title'.repeat(20000));
  classify({ ports: [], snmp: { descr: 'omada '.repeat(10000) }, http: [{ title: 'epson '.repeat(10000) }] });
  assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
});

test('scanner: "eHealth" in a page title alone makes no card terminal', () => {
  assert.notEqual(classify({ ports: [22, 80, 443, 3306], http: [{ title: 'eHealth Portal - Login' }] }).type, 'ti_terminal');
  assert.equal(classify({ ports: [4742], http: [{ title: 'ORGA 6141' }] }).type, 'ti_terminal');
  assert.equal(classify({ ports: [80], vendor: 'Ingenico', http: [{ title: 'ORGA 6141 online' }] }).type, 'ti_terminal');
});

test('scanner: two NAS volumes of the same size both stay', () => {
  const G = 1024 ** 3; const D = '1.3.6.1.2.1.25.2.1.4';
  const m = new Map([['2.1', D], ['3.1', Buffer.from('/volume1')], ['4.1', 4096], ['5.1', (4000 * G) / 4096], ['6.1', (400 * G) / 4096],
    ['2.2', D], ['3.2', Buffer.from('/volume2')], ['4.2', 4096], ['5.2', (4000 * G) / 4096], ['6.2', (3960 * G) / 4096]]);
  assert.deepEqual(parseStorage(m).map((v) => [v.name, v.pct]), [['/volume1', 10], ['/volume2', 99]]);
});

test('scanner: all subnets together may be larger for the nightly light scan', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ cidr: `10.${i}.0.0/20` }));
  assert.throws(() => validateTargets(many), { code: 'err.tooManyHosts' });
  assert.equal(validateTargets(many, 16384 * 4).length, 6);
});

test('device facts: a serial number typed differently is no exchange of the hardware', () => {
  const db = memoryDb();
  const id = db.prepare("INSERT INTO devices(name,type,mac,serial,model,vendor,created_at,updated_at) VALUES('sw','switch','aa:bb:cc:00:00:01','SG2-ABC123','Mein Modell','Ich',?,?)").run(ts(), ts()).lastInsertRowid;
  const r = fillDevice(db, id, { serial: 'SG2ABC123', model: 'TL-SG2210P', vendor: 'TP-Link' });
  assert.equal(r.replaced, false);
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  assert.deepEqual([d.model, d.vendor, d.mac], ['Mein Modell', 'Ich', 'aa:bb:cc:00:00:01']);
});

test('scan agent facts are brought into shape', () => {
  const f = cleanScanFacts({ ports: 'x', classification: { model: 5, reasons: 'r' }, http: [{ proto: 'javascript:alert(1)//', port: 80 }, { proto: 'https', port: 443, title: 'A\u0000B' }], evil: 1 });
  assert.deepEqual(f.ports, []);
  assert.equal(f.classification.model, '5');
  assert.deepEqual(f.classification.reasons, []);
  assert.deepEqual(f.http.map((h) => [h.proto, h.port, h.title]), [['https', 443, 'A B']]);
  assert.equal('evil' in f, false);
});

// ---------------------------------------------------------------------------------------------- monitoring

test('web check: a stream without end does not hold the check', async () => {
  const srv = http.createServer((_q, s) => { s.writeHead(200); const i = setInterval(() => s.write('x'), 200); s.on('close', () => clearInterval(i)); });
  const port = await listen(srv);
  assert.equal((await quick(() => httpCheck(`http://127.0.0.1:${port}/`, { timeoutS: 1 }), 3000)).ok, true);
  const k = await quick(() => httpCheck(`http://127.0.0.1:${port}/`, { timeoutS: 1, keyword: 'nie' }), 3000);
  assert.equal(k.ok, false);
  srv.closeAllConnections(); srv.close();
});

test('webhook/provider request: a trickling answer is cut off in time', async () => {
  const srv = http.createServer((_q, s) => { s.writeHead(200); const i = setInterval(() => s.write('x'), 200); s.on('close', () => clearInterval(i)); });
  const port = await listen(srv);
  await quick(() => providerRequest('GET', `http://127.0.0.1:${port}/`, { timeoutMs: 1000 }).catch((e) => e), 5000);
  srv.closeAllConnections(); srv.close();
});

test('redis check: endless answer without line end ends quickly, small memory', async () => {
  const srv = net.createServer((s) => { const chunk = Buffer.alloc(64 * 1024, 'a'); const i = setInterval(() => s.write(chunk), 5); s.on('close', () => clearInterval(i)); s.on('error', () => {}); });
  const port = await listen(srv);
  const r = await quick(() => redisCheck({ host: '127.0.0.1', port }, 3), 2000);
  assert.equal(r.ok, false);
  srv.close();
});

function monSetup() {
  const db = memoryDb();
  const sent = [];
  const channels = { notify: async (_m, ev) => { sent.push(`${ev.kind}:${ev.monitor.name}`); return ['T']; }, notifyIds: async (ids, ev) => { sent.push(`ids${ids}:${ev.kind}`); return ['C']; } };
  const maintenance = createMaintenance(db);
  const clock = { t: new Date('2026-11-12T10:00:00Z') };
  const store = { 'escalate.min': 10, 'escalate.channels': [7] };
  const mon = createMonitoring({ db, channels, maintenance, settings: { get: (k) => store[k] }, now: () => clock.t });
  return { db, sent, mon, maintenance, clock };
}
const tick = (clock, s = 60) => { clock.t = new Date(clock.t.getTime() + s * 1000); };

test('monitoring: a switch in maintenance holds back the alarms behind it', async () => {
  const { sent, mon, maintenance } = monSetup();
  const sw = await mon.create({ name: 'Switch', type: 'tcp', target: '10.0.0.2', port: 22, fail_threshold: 1 });
  const nas = await mon.create({ name: 'NAS', type: 'tcp', target: '10.0.0.20', port: 445, fail_threshold: 1, parent_id: sw.id });
  maintenance.create({ name: 'Firmware', kind: 'once', starts_at: '2026-11-12T09:00:00Z', ends_at: '2026-11-12T11:00:00Z', monitor_ids: [sw.id] });
  await mon.record(sw, { ok: false, message: 'x' });
  assert.equal(mon.get(sw.id).status, 'maintenance');
  await mon.record(nas, { ok: false, message: 'timeout' });
  assert.equal(mon.get(nas.id).status, 'unreachable');
  assert.deepEqual(sent, []);
});

test('monitoring: paused while the check runs - no alarm', async () => {
  const { sent, mon } = monSetup();
  const m = await mon.create({ name: 'Web', type: 'tcp', target: '10.0.0.3', port: 80, fail_threshold: 1 });
  mon.pause(m.id);
  await mon.record(m, { ok: false, message: 'refused' });
  assert.notEqual(mon.get(m.id).status, 'down');
  assert.deepEqual(sent, []);
});

test('monitoring: certificate warning during maintenance comes afterwards', async () => {
  const { sent, mon, maintenance, clock } = monSetup();
  const m = await mon.create({ name: 'Portal', type: 'tcp', target: '10.0.0.4', port: 443, fail_threshold: 1, cert_days: '30,14,7' });
  maintenance.create({ name: 'W', kind: 'once', starts_at: '2026-11-12T09:00:00Z', ends_at: '2026-11-12T10:30:00Z', monitor_ids: [m.id] });
  const validTo = new Date(clock.t.getTime() + 20 * 86400000).toISOString();
  await mon.record(m, { ok: true, ms: 1, message: 'ok', cert: { validTo } });
  assert.deepEqual(sent, []);
  tick(clock, 3600);
  await mon.record(m, { ok: true, ms: 1, message: 'ok', cert: { validTo } });
  assert.deepEqual(sent, ['cert:Portal']);
});

test('monitoring: an escalated outage that ran into maintenance still gets its all clear', async () => {
  const { db, sent, mon, maintenance, clock } = monSetup();
  db.prepare("INSERT INTO channels(id,name,type,config,is_default,enabled,language,created_at) VALUES(7,'Chef','email','{}',0,1,'de','x')").run();
  const m = await mon.create({ name: 'FW', type: 'tcp', target: '10.0.0.1', port: 443, fail_threshold: 1 });
  await mon.record(m, { ok: false, message: 'x' });
  tick(clock, 11 * 60);
  await mon.record(m, { ok: false, message: 'x' });
  assert.deepEqual(sent, ['down:FW', 'ids7:escalate']);
  maintenance.create({ name: 'W', kind: 'once', starts_at: clock.t.toISOString(), ends_at: new Date(clock.t.getTime() + 600000).toISOString(), monitor_ids: [m.id] });
  tick(clock, 60);
  await mon.record(m, { ok: false, message: 'x' });
  tick(clock, 3600);
  await mon.record(m, { ok: true, ms: 1, message: 'ok' });
  assert.ok(sent.includes('ids7:up'), sent.join(' '));
});

test('monitoring: a moved monitor needs its password again', async () => {
  const { mon } = monSetup();
  const m = await mon.create({ name: 'Cache', type: 'redis', target: 'redis.firma.local', port: 6379, password: 'Geheim-123' });
  assert.equal((await mon.update(m.id, { name: 'Cache 2' })).has_password, true);
  await assert.rejects(mon.update(m.id, { target: '10.66.0.9' }), { code: 'err.passwordAgain' });
  await assert.rejects(mon.update(m.id, { port: 6380 }), { code: 'err.passwordAgain' });
  assert.equal((await mon.update(m.id, { target: '10.66.0.9', password: 'Neu-456' })).has_password, true);
});

test('deleted channel, monitor, device: their ids leave the lists', async () => {
  const { db, mon, maintenance } = monSetup();
  const store = { 'escalate.channels': [5, 6] };
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const ch = createChannels(db, null, settings);
  const a = ch.create({ name: 'A', type: 'webhook', config: { url: 'https://hooks.example.org/a' } });
  const m = await mon.create({ name: 'M', type: 'tcp', target: '10.0.0.5', port: 22, channels: [a.id] });
  store['escalate.channels'] = [a.id, 99];
  ch.remove(a.id);
  assert.deepEqual(mon.get(m.id).channels, []);
  assert.deepEqual(store['escalate.channels'], [99]);
  // a maintenance window for this monitor only: switched off, never "for all"
  const w = maintenance.create({ name: 'W', kind: 'once', starts_at: '2026-11-12T09:00:00Z', ends_at: '2026-11-12T11:00:00Z', monitor_ids: [m.id] });
  mon.remove(m.id);
  const row = db.prepare('SELECT enabled, monitor_ids FROM maintenance WHERE id=?').get(w.id);
  assert.deepEqual([row.enabled, row.monitor_ids], [0, '[]']);
});

// ---------------------------------------------------------------------------------------------- TLS

test('pinned company CA: the name of the server still has to fit', async (t) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ca-'));
  const o = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  try {
    o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Firmen-CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
    for (const n of ['pve.firma.local', 'drucker17.firma.local']) {
      o(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.csr`, '-subj', `/CN=${n}`]);
      fs.writeFileSync(path.join(dir, `${n}.ext`), `subjectAltName=DNS:${n}\n`);
      o(['x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${n}.pem`, '-days', '2', '-extfile', `${n}.ext`]);
    }
  } catch { t.skip('openssl missing'); return; }
  const ca = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8');
  const opts = tlsOptions({ ca });
  const leaf = (n) => new crypto.X509Certificate(fs.readFileSync(path.join(dir, `${n}.pem`)));
  // checkServerIdentity gets the peer certificate with its chain
  const peer = (n) => { const c = leaf(n); const caX = new crypto.X509Certificate(ca); const issuer = { fingerprint256: caX.fingerprint256, issuerCertificate: null };
    issuer.issuerCertificate = issuer; return { fingerprint256: c.fingerprint256, subject: { CN: n }, subjectaltname: `DNS:${n}`, issuerCertificate: issuer }; };
  assert.equal(opts.checkServerIdentity('pve.firma.local', peer('pve.firma.local')), undefined);
  assert.ok(opts.checkServerIdentity('pve.firma.local', peer('drucker17.firma.local')) instanceof Error);
});

test('Windows key pin: as X509Certificate.GetPublicKey() hashes it', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
  assert.equal(keyPin(publicKey), crypto.createHash('sha256').update(raw).digest('hex').toUpperCase());
  const s = hostScript('windows', { url: 'https://w/api/hosts/push', token: 't', pin: { sha1: 'AB', key: keyPin(publicKey) } });
  assert.ok(s.text.includes(`$KeyPin = '${keyPin(publicKey)}'`));
});

test('scan agent: a company root CA is checked with the name, not as pinned server certificate', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'aca-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'k', '-out', 'c', '-days', '2', '-subj', '/CN=Root',
      '-addext', 'basicConstraints=critical,CA:TRUE'], { cwd: dir, stdio: 'pipe' });
  } catch { return; }
  const cfg = agentConfig({ WOMN_AGENT_SERVER: 'https://womn.firma.local', WOMN_AGENT_TOKEN: 'a'.repeat(30), WOMN_AGENT_CA: fs.readFileSync(path.join(dir, 'c'), 'utf8') });
  assert.equal(cfg.isCa, true);
  assert.equal(makeHttpsAgent(cfg).options.checkServerIdentity, undefined);
});

// ---------------------------------------------------------------------------------------------- host scripts

test('host scripts: server address strict, no quote tricks in PowerShell', () => {
  assert.equal(serverBase('https://womn.firma.local:8743/'), 'https://womn.firma.local:8743');
  for (const bad of ['https://a$`', "https://a’;Write-Output PWNED;’", 'ftp://x', 'https://u:p@x', 'https://x/path']) assert.throws(() => serverBase(bad), { code: 'err.badRequest' });
  const s = hostScript('windows', { url: 'https://w/api/hosts/push', token: "a’b", pin: {} });
  assert.ok(s.text.includes("$Token = 'a’’b'"));
});

test('Linux script: mount points with spaces and control characters give valid JSON', { skip: !fs.existsSync('/bin/sh') }, () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'lnx-')); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const w = (n, b) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${b}\n`, { mode: 0o755 });
  w('id', 'echo 1000'); w('hostname', 'echo web01'); w('crontab', 'cat >/dev/null'); w('curl', `cat > "${dir}/body"`);
  w('df', "printf 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 ext4 102400 51200 51200 50%% /\\n//nas/Team Daten cifs 2048000 1024 2046976 1%% /mnt/team\\n/dev/sdb1 xfs 409600 100 409500 1%% /srv/my data\\n'");
  w('systemctl', "printf 'x.service loaded active running Desc with\\rCR\\n'");
  const s = hostScript('linux', { url: 'https://w/api/hosts/push', token: 'tok-1234567890', pin: {} });
  const file = path.join(dir, s.file); fs.writeFileSync(file, s.text);
  spawnSync('sh', [file], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir }, timeout: 20000 });
  const body = JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8'));
  assert.deepEqual(body.disks.map((d) => d.name), ['/', '/srv/my data']);
});

test('Hyper-V/KVM push: the data cannot grow without end', () => {
  let data = {};
  const at = '2026-11-12T10:00:00Z';
  for (let i = 0; i < 20; i++) {
    data = mergePush('hyperv', data, { nodes: [{ name: 'hv1' }], storages: [], guests: Array.from({ length: 100 }, (_, k) => ({ name: `vm${i}-${k}`, node: `ghost${i}` })) }, at);
  }
  assert.equal(data.guests.length, 100, 'guests of the sending node are replaced, never added up');
  assert.ok(data.guests.every((g) => g.node === 'hv1'));
});

// ---------------------------------------------------------------------------------------------- data

test('manual: tables are rendered as tables (escaped)', () => {
  const html = mdToHtml('| A | B |\n|---|---|\n| **x** | <b>y</b> |\n');
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td><strong>x<\/strong><\/td><td>&lt;b&gt;y&lt;\/b&gt;<\/td>/);
});

test('location: the only location of a limited user cannot be deleted; a report for it is switched off', () => {
  const db = memoryDb();
  const locs = createLocations(db);
  const a = locs.create({ name: 'A', subnets: ['10.1.0.0/24'] });
  const b = locs.create({ name: 'B', subnets: ['10.2.0.0/24'] });
  const u = db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('seg','x','editor',?)").run(ts()).lastInsertRowid;
  db.prepare('INSERT INTO user_locations(user_id,location_id) VALUES(?,?)').run(u, a.id);
  assert.throws(() => locs.remove(a.id), { code: 'err.locationLastScope' });
  const r = db.prepare("INSERT INTO reports(name,sections,recipients,schedule,location_ids,created_at) VALUES('R','[]','a@b.de','{}',?,?)").run(JSON.stringify([b.id]), ts()).lastInsertRowid;
  locs.remove(b.id);
  assert.equal(db.prepare('SELECT enabled FROM reports WHERE id=?').get(r).enabled, 0);
});

test('inventory: suggestions only from the own locations; a form cannot set scan facts', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const l1 = db.prepare("INSERT INTO locations(name,created_at) VALUES('A',?)").run(ts()).lastInsertRowid;
  const l2 = db.prepare("INSERT INTO locations(name,created_at) VALUES('B',?)").run(ts()).lastInsertRowid;
  inv.create({ name: 'a', owner: 'Team A', location_id: l1 });
  inv.create({ name: 'b', owner: 'Chefin Geheim', location_id: l2 });
  assert.deepEqual(inv.suggestions(new Set([l1])).owner, ['Team A']);
  const d = inv.create({ name: 'c', facts: { ports: ['<b>'] }, last_seen: '2099-01-01T00:00:00Z' });
  assert.deepEqual([d.facts, d.last_seen], [{}, null]);
});

test('scan agent results never change a device of another location', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const hq = db.prepare("INSERT INTO locations(name,created_at) VALUES('HQ',?)").run(ts()).lastInsertRowid;
  const br = db.prepare("INSERT INTO locations(name,created_at) VALUES('Filiale',?)").run(ts()).lastInsertRowid;
  const fw = inv.create({ name: 'Firewall', ip: '10.0.0.1', mac: 'aa:bb:cc:00:00:01', location_id: hq });
  const scan = db.prepare("INSERT INTO scans(kind,status,targets,started_at,user,stats) VALUES('network','done','[]',?,'agent:x','{}')").run(ts()).lastInsertRowid;
  const rid = db.prepare("INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status,location_id) VALUES(?,'10.88.1.66','aa:bb:cc:00:00:01','evil','','unknown',0,'{}','pending',?)").run(scan, br).lastInsertRowid;
  inv.applyResult(rid, { onlyLocation: br });
  const after = db.prepare('SELECT ip, hostname FROM devices WHERE id=?').get(fw.id);
  assert.deepEqual(after, { ip: '10.0.0.1', hostname: '' });
});

test('restore: schema 0, no admin and a failing schema update are refused; the copy before keeps the latest changes', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'rs-'));
  const mk = (name, fn) => { const f = path.join(dir, name); const d = openDatabase(f); fn?.(d); d.pragma('wal_checkpoint(TRUNCATE)'); d.close(); return f; };
  const admin = (d) => d.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('a','x','admin',?)").run(ts());
  assert.throws(() => inspect(mk('noadmin.sqlite')), { code: 'err.backupNoAdmin' });
  const v0 = mk('v0.sqlite', admin);
  const w = new Database(v0); w.pragma('user_version = 0'); w.close();
  assert.throws(() => inspect(v0), { code: 'err.backupFile' });
  const old = mk('old.sqlite', admin);
  const o = new Database(old); o.pragma('user_version = 18'); o.exec('ALTER TABLE monitors DROP COLUMN escalate_min'); o.exec('ALTER TABLE monitors DROP COLUMN escalate_channels'); o.exec('ALTER TABLE monitors DROP COLUMN escalated_at'); o.exec('ALTER TABLE monitor_hourly DROP COLUMN v_n'); o.close();
  assert.throws(() => inspect(old), { code: 'err.backupBroken' }, 'migration 19 cannot run on this file (column exists)');

  // the database in use with changes only in the -wal file, the program ended without closing it
  const live = path.join(dir, 'whatsonmynet.sqlite');
  const script = `import Database from 'better-sqlite3'; const d = new Database(${JSON.stringify(live)}); d.pragma('journal_mode = WAL'); d.pragma('wal_autocheckpoint = 0');
    d.exec('CREATE TABLE t(x)'); for (let i = 0; i < 50; i++) d.prepare('INSERT INTO t VALUES(?)').run(i); process.exit(0);`;
  spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve('.') });
  fs.copyFileSync(mk('new.sqlite', admin), pendingPath(live));
  applyPendingRestore(live, path.join(dir, 'backups'));
  const kept = fs.readdirSync(path.join(dir, 'backups')).find((f) => f.includes('before-restore'));
  const k = new Database(path.join(dir, 'backups', kept), { readonly: true });
  assert.equal(k.prepare('SELECT COUNT(*) n FROM t').get().n, 50);
  k.close();
});

test('health check: an invalid port means the default, like the server', () => {
  const r = spawnSync(process.execPath, ['docker/healthcheck.mjs'], { env: { ...process.env, WOMN_HTTPS_PORT: '99999' }, encoding: 'utf8', timeout: 10000 });
  assert.ok(!/ERR_SOCKET_BAD_PORT/.test(r.stderr), r.stderr);
});
