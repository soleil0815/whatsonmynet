import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { MIGRATIONS } from '../src/db.js';
import { httpCheck, tcpCheck, statusMatcher, validStatusSpec } from '../src/monitor/checks.js';
import { createMonitoring, certStep, parseCertDays } from '../src/monitor/index.js';
import { createMaintenance, windowActive } from '../src/monitor/maintenance.js';
import { createChannels, renderTemplate, eventText, setTelegramApiForTests } from '../src/monitor/notify.js';
import { createInventory } from '../src/inventory.js';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('status codes', () => {
  const m = statusMatcher('200,301-302');
  assert.ok(m(200) && m(302) && !m(404) && !m(303));
  assert.ok(statusMatcher('')(204));
  assert.ok(validStatusSpec('200-399') && !validStatusSpec('2xx'));
});

test('web check: status, keyword, timeout', async () => {
  const srv = http.createServer((q, s) => { if (q.url === '/slow') return; s.statusCode = q.url === '/missing' ? 404 : 200; s.end('<h1>Alles OK</h1>'); });
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await httpCheck(`${base}/`)).ok, true);
  assert.equal((await httpCheck(`${base}/`, { keyword: 'Alles OK' })).ok, true);
  const k = await httpCheck(`${base}/`, { keyword: 'Fehler' });
  assert.equal(k.ok, false);
  assert.match(k.message, /keyword/);
  const s = await httpCheck(`${base}/missing`);
  assert.deepEqual([s.ok, s.message], [false, 'status 404']);
  assert.equal((await httpCheck(`${base}/missing`, { status: '200-499' })).ok, true);
  const slow = await httpCheck(`${base}/slow`, { timeoutS: 1 });
  assert.match(slow.message, /timeout/);
  assert.equal((await httpCheck('ftp://x/')).ok, false);
  srv.closeAllConnections(); srv.close();
});

test('web check over HTTPS reads the certificate; verification is optional', async () => {
  const key = path.join(tmp, 'm.key'); const crt = path.join(tmp, 'm.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '20', '-subj', '/CN=nas01'], { stdio: 'ignore' });
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (_q, s) => s.end('ok'));
  const port = await listen(srv);
  const r = await httpCheck(`https://127.0.0.1:${port}/`);
  assert.equal(r.ok, true);
  assert.equal(r.cert.subject, 'nas01');
  const days = (Date.parse(r.cert.validTo) - Date.now()) / 86400000;
  assert.ok(days > 18 && days <= 20);
  const v = await httpCheck(`https://127.0.0.1:${port}/`, { verify: true });
  assert.equal(v.ok, false);
  assert.equal(v.message, 'self-signed certificate');
  srv.close();
});

test('TCP check', async () => {
  const srv = net.createServer((s) => s.end());
  const port = await listen(srv);
  assert.equal((await tcpCheck('127.0.0.1', port)).ok, true);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  const c = await tcpCheck('127.0.0.1', port);
  assert.deepEqual([c.ok, c.message], [false, 'connection refused']);
});

test('certificate warning steps', () => {
  assert.deepEqual(parseCertDays('7, 30,14'), [30, 14, 7]);
  assert.throws(() => parseCertDays('0'), /err.certDays/);
  assert.equal(certStep(40, [30, 14, 7]), null);
  assert.equal(certStep(30, [30, 14, 7]), 30);
  assert.equal(certStep(10, [30, 14, 7]), 14);
  assert.equal(certStep(3, [30, 14, 7]), 7);
  assert.equal(certStep(-1, [30, 14, 7]), -1);
});

function setup({ at = new Date('2026-11-12T10:00:00Z') } = {}) {
  const db = memoryDb();
  const sent = [];
  const channels = { notify: async (m, ev) => { sent.push(ev); return ['Telegram']; } };
  const maintenance = createMaintenance(db);
  const clock = { t: at };
  const mon = createMonitoring({ db, channels, maintenance, now: () => clock.t });
  return { db, sent, mon, maintenance, clock };
}
const tick = (clock, s = 60) => { clock.t = new Date(clock.t.getTime() + s * 1000); };

test('alarm only after several failed checks, then all clear with downtime', async () => {
  const { db, sent, mon, clock } = setup();
  const m = await mon.create({ name: 'NAS', type: 'tcp', target: '10.0.10.20', port: 5001, fail_threshold: 2 });
  await mon.record(m, { ok: true, ms: 3, message: 'port 5001 open' });
  assert.equal(mon.get(m.id).status, 'up');
  tick(clock); await mon.record(m, { ok: false, ms: null, message: 'timeout (10 s)' });
  assert.equal(mon.get(m.id).status, 'pending');
  assert.equal(sent.length, 0);
  tick(clock); await mon.record(m, { ok: false, ms: null, message: 'timeout (10 s)' });
  assert.equal(mon.get(m.id).status, 'down');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'down');
  tick(clock); await mon.record(m, { ok: false, ms: null, message: 'timeout (10 s)' });
  assert.equal(sent.length, 1, 'no repeated alarm without resend');
  tick(clock, 600); await mon.record(m, { ok: true, ms: 4, message: 'port 5001 open' });
  assert.equal(mon.get(m.id).status, 'up');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].kind, 'up');
  assert.equal(sent[1].downtimeMin, 11);
  const ev = db.prepare('SELECT kind, notified FROM monitor_events WHERE monitor_id=? ORDER BY id').all(m.id);
  assert.deepEqual(ev.map((e) => e.kind), ['down', 'up']);
  assert.equal(ev[0].notified, 'Telegram');
  const d = mon.detail(m.id);
  assert.equal(d.uptime.h24.checks, 5);
  assert.equal(d.uptime.h24.pct, 40);
});

test('repeat the alarm while down when set', async () => {
  const { sent, mon, clock } = setup();
  const m = await mon.create({ name: 'Web', type: 'http', target: 'https://intranet.firma.local/', fail_threshold: 1, resend_min: 30 });
  await mon.record(m, { ok: false, message: 'status 502' });
  tick(clock, 600); await mon.record(m, { ok: false, message: 'status 502' });
  assert.equal(sent.length, 1);
  tick(clock, 1260); await mon.record(m, { ok: false, message: 'status 502' });
  assert.equal(sent.length, 2);
});

test('no alarms during a maintenance window', async () => {
  const { sent, mon, maintenance, clock } = setup();
  const m = await mon.create({ name: 'pve1', type: 'tcp', target: '10.0.10.5', port: 8006, fail_threshold: 1 });
  maintenance.create({ name: 'Update', kind: 'once', starts_at: '2026-11-12T09:30:00Z', ends_at: '2026-11-12T10:30:00Z', monitor_ids: [m.id] });
  await mon.record(m, { ok: false, message: 'connection refused' });
  assert.equal(mon.get(m.id).status, 'maintenance');
  assert.equal(sent.length, 0);
  tick(clock, 3600); await mon.record(m, { ok: false, message: 'connection refused' });
  assert.equal(mon.get(m.id).status, 'down');
  assert.equal(sent.length, 1);
});

test('certificate expiry warnings: once per step, again after renewal', async () => {
  const { sent, mon, clock } = setup();
  const m = await mon.create({ name: 'Shop', type: 'http', target: 'https://shop.firma.local/', cert_days: '30,14,7' });
  const certIn = (days) => ({ validTo: new Date(clock.t.getTime() + days * 86400000 + 3600000).toISOString() });
  await mon.record(m, { ok: true, ms: 50, message: 'status 200', cert: certIn(40) });
  assert.equal(sent.length, 0);
  await mon.record(m, { ok: true, ms: 50, message: 'status 200', cert: certIn(29) });
  await mon.record(m, { ok: true, ms: 50, message: 'status 200', cert: certIn(28) });
  assert.deepEqual(sent.map((e) => [e.kind, e.certDays]), [['cert', 29]]);
  await mon.record(m, { ok: true, ms: 50, message: 'status 200', cert: certIn(13) });
  assert.equal(sent.length, 2);
  await mon.record(m, { ok: true, ms: 50, message: 'status 200', cert: certIn(200) });
  await mon.record(m, { ok: true, ms: 50, message: 'status 200', cert: certIn(25) });
  assert.equal(sent.length, 3);
  assert.equal(mon.get(m.id).cert_days_left, 25);
});

test('input is checked', async () => {
  const { mon } = setup();
  await assert.rejects(mon.create({ name: 'x', type: 'tcp', target: '10.0.0.1' }), /err.port/);
  await assert.rejects(mon.create({ name: 'x', type: 'http', target: 'file:///etc/passwd' }), /err.url/);
  await assert.rejects(mon.create({ name: 'x', type: 'http', target: 'https://user:pw@host/' }), /err.url/);
  await assert.rejects(mon.create({ name: 'x', type: 'tcp', target: 'bad host', port: 1 }), /err.host/);
  await assert.rejects(mon.create({ name: 'x', type: 'http', target: 'https://a.example/', http_status: '2xx' }), /err.httpStatus/);
  await assert.rejects(mon.create({ name: 'x', type: 'http', target: 'https://a.example/', channels: [99] }), /err.channel/);
  const m = await mon.create({ name: 'x', type: 'http', target: 'https://a.example/', interval_s: 5, timeout_s: 90 });
  assert.equal(m.interval_s, 20);
  assert.equal(m.timeout_s, 19);
});

test('device monitors follow a new IP address from the scan', async () => {
  const { db, mon } = setup();
  const inv = createInventory(db);
  const d = inv.create({ name: 'pve1', ip: '10.0.10.5', mac: 'bc:24:11:00:00:05' });
  const a = await mon.create({ name: 'pve1', type: 'http', target: 'https://10.0.10.5:8006/', device_id: d.id });
  const b = await mon.create({ name: 'pve1 ssh', type: 'tcp', target: '10.0.10.5', port: 22, device_id: d.id });
  const c = await mon.create({ name: 'other', type: 'http', target: 'https://10.0.10.55/', device_id: d.id });
  const scan = db.prepare("INSERT INTO scans(kind,status,targets,started_at) VALUES('network','running','[]',?)").run(new Date().toISOString()).lastInsertRowid;
  const rid = db.prepare("INSERT INTO scan_results(scan_id,ip,mac,facts,status) VALUES(?,?,?,'{}','pending')").run(scan, '10.0.10.9', 'bc:24:11:00:00:05').lastInsertRowid;
  inv.applyResult(rid);
  assert.equal(mon.get(a.id).target, 'https://10.0.10.9:8006/');
  assert.equal(mon.get(b.id).target, '10.0.10.9');
  assert.equal(mon.get(c.id).target, 'https://10.0.10.55/');
  assert.equal(mon.deviceStatus()[d.id], 'pending');
});

test('maintenance windows', () => {
  const w = { enabled: 1, kind: 'weekly', weekdays: '[0]', time_from: '22:00', time_to: '02:00', monitor_ids: '[]' };
  const at = (s) => new Date(s); // local time of the test process
  assert.equal(windowActive(w, 1, at('2026-11-15T23:00:00')), true);  // Sunday 23:00
  assert.equal(windowActive(w, 1, at('2026-11-16T01:30:00')), true);  // Monday 01:30, started Sunday
  assert.equal(windowActive(w, 1, at('2026-11-16T03:00:00')), false);
  assert.equal(windowActive(w, 1, at('2026-11-15T21:59:00')), false);
  assert.equal(windowActive({ ...w, monitor_ids: '[2]' }, 1, at('2026-11-15T23:00:00')), false);
  const db = memoryDb();
  const mt = createMaintenance(db);
  assert.throws(() => mt.create({ name: 'x', kind: 'weekly', weekdays: [], time_from: '01:00', time_to: '02:00' }), /err.maintenanceTime/);
  assert.throws(() => mt.create({ name: 'x', kind: 'once', starts_at: '2026-11-12T10:00', ends_at: '2026-11-12T09:00' }), /err.maintenanceTime/);
});

test('notification texts and webhook template', () => {
  assert.equal(eventText({ kind: 'down', monitor: { name: 'pve1' }, message: 'timeout (10 s)' }, 'de'), '🔴 pve1 ist nicht erreichbar - timeout (10 s)');
  assert.equal(eventText({ kind: 'up', monitor: { name: 'pve1' }, downtimeMin: 5 }, 'en'), '🟢 pve1 is up again (down for 5 min)');
  const body = renderTemplate('{"chat":"x","text":"{{text}}","n":"{{name}}"}', { text: 'a "quoted"\nline', name: 'NAS' });
  assert.deepEqual(JSON.parse(body), { chat: 'x', text: 'a "quoted"\nline', n: 'NAS' });
});

test('channels: webhook and Telegram are sent, secrets never shown or logged', async () => {
  const got = [];
  const srv = http.createServer((q, s) => {
    let b = ''; q.on('data', (d) => { b += d; });
    q.on('end', () => {
      got.push({ url: q.url, auth: q.headers['x-api-key'], body: JSON.parse(b) });
      if (q.url.includes('/botBAD')) { s.statusCode = 401; s.end('{"ok":false,"description":"Unauthorized"}'); return; }
      s.end('{"ok":true}');
    });
  });
  const port = await listen(srv);
  setTelegramApiForTests(`http://127.0.0.1:${port}`);
  const db = memoryDb();
  const ch = createChannels(db, { send: async () => {} });
  const hook = ch.create({ name: 'Hook', type: 'webhook', config: { url: `http://127.0.0.1:${port}/hook`, template: '{"msg":"{{text}}"}', headerName: 'X-Api-Key', headerValue: 'geheim-123' } });
  assert.deepEqual(hook.config.headerValue, { set: true });
  assert.ok(!JSON.stringify(ch.list()).includes('geheim-123'));
  const tg = ch.create({ name: 'Telegram', type: 'telegram', config: { token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', chatId: '-1001234567890' } });
  assert.deepEqual(tg.config.token, { set: true });
  assert.throws(() => ch.create({ name: 'x', type: 'telegram', config: { token: 'nope', chatId: '1' } }), /err.telegramToken/);
  assert.throws(() => ch.create({ name: 'x', type: 'webhook', config: { url: 'http://a.example/', template: '{"a":' } }), /err.webhookTemplate/);
  const reached = await ch.notify({ channels: '[]' }, { kind: 'down', monitor: { id: 1, name: 'pve1', target: '10.0.10.5' }, message: 'timeout' });
  assert.deepEqual(reached.sort(), ['Hook', 'Telegram']);
  const h = got.find((g) => g.url === '/hook');
  assert.equal(h.auth, 'geheim-123');
  assert.match(h.body.msg, /pve1 ist nicht erreichbar/);
  const t = got.find((g) => g.url.startsWith('/bot123456789'));
  assert.equal(t.body.chat_id, '-1001234567890');
  // only selected channels
  got.length = 0;
  await ch.notify({ channels: JSON.stringify([hook.id]) }, { kind: 'up', monitor: { id: 1, name: 'pve1', target: 'x' } });
  assert.deepEqual(got.map((g) => g.url), ['/hook']);
  // token never in error messages; editing keeps the token
  ch.update(tg.id, { name: 'Telegram', config: { chatId: '-100999' } });
  const bad = ch.create({ name: 'Bad', type: 'telegram', config: { token: 'BAD456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.replace('BAD', '999'), chatId: '1' } });
  db.prepare('UPDATE channels SET config=? WHERE id=?').run((await import('../src/lib/crypto.js')).encrypt(JSON.stringify({ token: 'BAD', chatId: '1' })), bad.id);
  await assert.rejects(ch.test(bad.id), (e) => e.code === 'err.channelFailed' && !String(e.detail).includes('BAD') && /Unauthorized/.test(e.detail));
  srv.close();
});

test('dependencies: behind a failed switch no alarm flood, own problem reported once the switch is back', async () => {
  const { db, sent, mon, clock } = setup();
  const sw = await mon.create({ name: 'Switch Keller', type: 'tcp', target: '10.0.0.2', port: 22, fail_threshold: 2 });
  const nas = await mon.create({ name: 'NAS', type: 'tcp', target: '10.0.0.20', port: 445, fail_threshold: 1, parent_id: sw.id });
  const cam = await mon.create({ name: 'Kamera', type: 'tcp', target: '10.0.0.30', port: 22, fail_threshold: 1, parent_id: sw.id });
  for (const m of [sw, nas, cam]) await mon.record(m, { ok: true, ms: 1, message: 'ok' });
  // Everything fails at once; the NAS reaches its threshold before the switch: it waits for the switch
  tick(clock);
  await mon.record(sw, { ok: false, message: 'no answer' });
  await mon.record(nas, { ok: false, message: 'timeout' });
  assert.equal(mon.get(nas.id).status, 'pending');
  assert.equal(sent.length, 0);
  tick(clock);
  await mon.record(sw, { ok: false, message: 'no answer' });
  assert.equal(mon.get(sw.id).status, 'down');
  await mon.record(nas, { ok: false, message: 'timeout' });
  await mon.record(cam, { ok: false, message: 'no answer' });
  assert.equal(mon.get(nas.id).status, 'unreachable');
  assert.equal(mon.get(cam.id).status, 'unreachable');
  assert.deepEqual(sent.map((e) => e.kind), ['down'], 'only the switch is reported');
  const ev = db.prepare("SELECT message FROM monitor_events WHERE monitor_id=? AND kind='unreachable'").get(nas.id);
  assert.equal(ev.message, 'Switch Keller');
  assert.equal(mon.summary().unreachable, 2);
  assert.equal(mon.summary().down.length, 1);
  // Switch back: the camera is fine again (no "up" message - there was no alarm), the NAS still fails → its own alarm
  tick(clock, 600);
  await mon.record(sw, { ok: true, ms: 1, message: 'ok' });
  await mon.record(cam, { ok: true, ms: 1, message: 'ok' });
  await mon.record(nas, { ok: false, message: 'timeout' });
  assert.equal(mon.get(cam.id).status, 'up');
  assert.equal(mon.get(nas.id).status, 'down');
  assert.deepEqual(sent.map((e) => `${e.kind}:${e.monitor.name}`), ['down:Switch Keller', 'up:Switch Keller', 'down:NAS']);
  const d = mon.detail(sw.id);
  assert.deepEqual(d.dependents.map((x) => x.name), ['Kamera', 'NAS']);
  assert.equal(mon.detail(nas.id).parent.name, 'Switch Keller');
});

test('dependencies: no circles, unknown parent refused, deleting the parent frees the others', async () => {
  const { db, mon } = setup();
  const a = await mon.create({ name: 'Router', type: 'tcp', target: '10.0.0.1', port: 22 });
  const b = await mon.create({ name: 'Switch', type: 'tcp', target: '10.0.0.2', port: 22, parent_id: a.id });
  const c = await mon.create({ name: 'Server', type: 'tcp', target: '10.0.0.3', port: 22, parent_id: b.id });
  await assert.rejects(mon.update(a.id, { parent_id: c.id }), /err.parentCycle/);
  await assert.rejects(mon.update(a.id, { parent_id: a.id }), /err.parentCycle/);
  await assert.rejects(mon.create({ name: 'X', type: 'tcp', target: '10.0.0.9', port: 22, parent_id: 999 }), /err.parentMonitor/);
  // An edit without parent_id keeps it; empty removes it
  await mon.update(c.id, { name: 'Server 1' });
  assert.equal(mon.get(c.id).parent_id, b.id);
  await mon.update(c.id, { parent_id: '' });
  assert.equal(mon.get(c.id).parent_id, null);
  mon.remove(a.id);
  assert.equal(db.prepare('SELECT parent_id FROM monitors WHERE id=?').get(b.id).parent_id, null);
});

test('dependencies: the switch a device is plugged in at is suggested and can take all devices behind it', async () => {
  const { db, mon } = setup();
  const now = '2026-11-12T10:00:00Z';
  const dev = (name, ip, mac, type = 'server') => Number(db.prepare(`INSERT INTO devices(name,ip,mac,type,created_at,updated_at,first_seen,last_seen)
    VALUES(?,?,?,?,?,?,?,?)`).run(name, ip, mac, type, now, now, now, now).lastInsertRowid);
  const sw = dev('Switch Keller', '10.0.0.2', 'aa:00:00:00:00:02', 'switch');
  const nas = dev('NAS', '10.0.0.20', 'aa:00:00:00:00:20', 'nas');
  const cam = dev('Kamera', '10.0.0.30', 'aa:00:00:00:00:30', 'camera');
  const mac = db.prepare('INSERT INTO switch_macs(switch_id,mac,if_index,port,vlan,seen_at) VALUES(?,?,?,?,?,?)');
  mac.run(sw, 'aa:00:00:00:00:20', 3, 'Port 3', 1, now);
  mac.run(sw, 'aa:00:00:00:00:30', 4, 'Port 4', 1, now);
  const swMon = await mon.create({ name: 'Switch Keller', type: 'tcp', target: '10.0.0.2', port: 22, device_id: sw });
  const s = await mon.suggestionFor(nas);
  assert.equal(s.parent_id, swMon.id);
  await mon.create({ name: 'NAS', type: 'tcp', target: '10.0.0.20', port: 22, device_id: nas });
  await mon.create({ name: 'Kamera', type: 'tcp', target: '10.0.0.30', port: 22, device_id: cam });
  assert.equal(mon.detail(swMon.id).candidates, 2);
  assert.equal(mon.adoptChildren(swMon.id), 2);
  assert.equal(mon.detail(swMon.id).candidates, 0);
  assert.deepEqual(mon.detail(swMon.id).dependents.map((x) => x.name), ['Kamera', 'NAS']);
});

test('long history: hourly values with lowest/highest, grouped per day for a year, raw checks only up to 7 days', async () => {
  const { db, mon, clock } = setup({ at: new Date('2026-01-01T00:30:00Z') });
  const m = await mon.create({ name: 'Disk C', type: 'tcp', target: '10.0.0.5', port: 22 });
  // Three days, four checks a day: values 10/20/30 and one failed check without value on day 2
  for (let d = 0; d < 3; d++) {
    for (const [ok, ms] of [[true, 10], [true, 20], [true, 30], [d !== 1, d === 1 ? null : 15]]) {
      await mon.record(m, { ok, ms, message: ok ? 'ok' : 'timeout' });
      tick(clock, 6 * 3600);
    }
  }
  const h = db.prepare('SELECT * FROM monitor_hourly WHERE monitor_id=? ORDER BY hour LIMIT 1').get(m.id);
  assert.deepEqual([h.v_n, h.v_sum, h.v_min, h.v_max], [1, 10, 10, 10]);
  const year = mon.detail(m.id, 8784);
  assert.equal(year.checks.length, 0);
  assert.equal(year.bucketHours, 24);
  assert.equal(year.history.length, 3);
  assert.deepEqual(year.history.map((b) => [b.ok, b.total, b.min, b.max, b.avg]), [[4, 4, 10, 30, 18.75], [3, 4, 10, 30, 20], [4, 4, 10, 30, 18.75]]);
  assert.equal(year.uptime.span.pct, 91.67);
  const month = mon.detail(m.id, 720);
  assert.equal(month.bucketHours, 6);
  assert.equal(month.history.length, 12);
  // Up to 7 days the single checks as before
  const week = mon.detail(m.id, 168);
  assert.equal(week.history, undefined);
  assert.equal(week.checks.length, 12);
  // More than a year is cut to a year
  assert.equal(mon.detail(m.id, 99999).history.length, 3);
});

test('migration 20 fills the long history from the stored checks', () => {
  const db = memoryDb();
  db.prepare("INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES(1,'x','tcp','h',?,?)").run('2026-01-01', '2026-01-01');
  const add = db.prepare('INSERT INTO checks(monitor_id,at,ok,ms) VALUES(1,?,?,?)');
  add.run('2026-11-12T10:05:00.000Z', 1, 4); add.run('2026-11-12T10:35:00.000Z', 1, 8); add.run('2026-11-12T10:59:59.000Z', 0, null);
  add.run('2026-11-12T11:00:00.000Z', 1, 100);
  db.prepare("INSERT INTO monitor_hourly(monitor_id,hour,ok,total,ms_sum) VALUES(1,'2026-11-12T10:00',2,3,12),(1,'2026-11-01T08:00',2,2,50)").run();
  db.prepare('UPDATE monitor_hourly SET v_n=0, v_sum=0, v_min=NULL, v_max=NULL').run();
  // Run the backfill part of the migration again on these rows
  const sql = MIGRATIONS[MIGRATIONS.length - 1].split('\n').filter((l) => !/ALTER TABLE/.test(l)).join('\n');
  db.exec(sql);
  const rows = db.prepare('SELECT hour, v_n, v_sum, v_min, v_max FROM monitor_hourly ORDER BY hour').all();
  assert.deepEqual(rows.map((r) => [r.hour, r.v_n, r.v_sum, r.v_min, r.v_max]), [['2026-11-01T08:00', 2, 50, null, null], ['2026-11-12T10:00', 2, 12, 4, 8]]);
});
