// Review follow-ups 2026-11: repeated IP moves of a paused password monitor, alarm when such a monitor is paused,
// host name ownership migration, outdated scans still allow "stop ignoring", subnet errors name the typed input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tmp, memoryDb } from './helpers.js';
import { createInventory } from '../src/inventory.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';
import { eventText } from '../src/monitor/notify.js';
import { openDatabase, migrate } from '../src/db.js';
import { createLocations } from '../src/locations.js';

const iso = () => new Date().toISOString();
const settle = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setTimeout(r, 20)));

function recordingChannels() {
  const sent = [];
  return {
    sent,
    notify: async (monitor, ev) => { sent.push({ monitor, ev }); return ['Ops mail']; },
    notifyIds: async () => [],
  };
}

// ---------------------------------------------------------------------------------------------------- 1
test('paused password monitor follows repeated IP moves and runs again when the device returns to the password address', async () => {
  const db = memoryDb();
  const mon = createMonitoring({ db, channels: recordingChannels(), maintenance: createMaintenance(db) });
  const inv = createInventory(db);
  const d = inv.create({ name: 'DB', type: 'server', ip: '10.0.0.50', mac: 'aa:bb:cc:00:11:01' });
  const m = await mon.create({ name: 'DB MySQL', type: 'mysql', target: '10.0.0.50', port: 3306, password: 'pw-1', options: { user: 'monitor' }, device_id: d.id });

  inv.update(d.id, { ip: '10.0.0.51' }, 'admin');
  inv.update(d.id, { ip: '10.0.0.52' }, 'admin');
  const twice = mon.get(m.id);
  assert.equal(twice.enabled, false);
  assert.equal(twice.target, '10.0.0.50', 'the password stays bound to the address it was typed for');
  assert.deepEqual([twice.data.ipMoved.from, twice.data.ipMoved.to, twice.data.ipMoved.target], ['10.0.0.50', '10.0.0.52', '10.0.0.52']);
  assert.match(twice.last_message, /10\.0\.0\.50 → 10\.0\.0\.52/);

  inv.update(d.id, { ip: '10.0.0.50' }, 'admin');
  const back = mon.get(m.id);
  assert.equal(back.enabled, true);
  assert.equal(back.status, 'pending');
  assert.equal(back.target, '10.0.0.50');
  assert.equal(back.data.ipMoved, undefined);
  assert.equal(back.last_message, '');
});

test('repeated IP moves: a monitor without a password follows each time, the paused password monitor keeps its note up to date', async () => {
  const db = memoryDb();
  const mon = createMonitoring({ db, channels: recordingChannels(), maintenance: createMaintenance(db) });
  const inv = createInventory(db);
  const d = inv.create({ name: 'Share', type: 'nas', ip: '10.0.0.60', mac: 'aa:bb:cc:00:11:02' });
  const smb = await mon.create({ name: 'Share SMB', type: 'smb', target: '10.0.0.60', password: 'pw', options: { share: 'data', user: 'reader' }, device_id: d.id });
  const ping = await mon.create({ name: 'Share Port', type: 'tcp', target: '10.0.0.60', port: 445, device_id: d.id });
  inv.update(d.id, { ip: '10.0.0.61' }, 'admin');
  inv.update(d.id, { ip: '10.0.0.62' }, 'admin');
  assert.equal(mon.get(ping.id).target, '10.0.0.62');
  assert.equal(mon.get(smb.id).data.ipMoved.to, '10.0.0.62');
  assert.equal(mon.get(smb.id).data.ipMoved.from, '10.0.0.60');
});

// ---------------------------------------------------------------------------------------------------- 2
test('paused password monitor: its channels are told about the IP change, in German and English', async () => {
  const db = memoryDb();
  const channels = recordingChannels();
  const mon = createMonitoring({ db, channels, maintenance: createMaintenance(db) });
  const inv = createInventory(db);
  const d = inv.create({ name: 'Files', type: 'nas', ip: '10.0.0.70', mac: 'aa:bb:cc:00:11:03' });
  const m = await mon.create({ name: 'Files share', type: 'smb', target: '10.0.0.70', password: 'pw', options: { share: 'data', user: 'reader' }, device_id: d.id });
  inv.update(d.id, { ip: '10.0.0.71' }, 'admin');
  await settle();
  assert.equal(channels.sent.length, 1, 'one notification');
  const { monitor, ev } = channels.sent[0];
  assert.equal(monitor.id, m.id);
  assert.equal(ev.kind, 'ipMoved');
  assert.deepEqual([ev.from, ev.to], ['10.0.0.70', '10.0.0.71']);
  assert.equal(eventText(ev, 'de'), '🟠 Files share pausiert: Das Gerät hat eine neue IP (10.0.0.70 → 10.0.0.71) - bitte das Passwort neu eingeben.');
  assert.equal(eventText(ev, 'en'), '🟠 Files share paused: the device has a new IP (10.0.0.70 → 10.0.0.71) - please enter the password again.');
  const stored = mon.detail(m.id).events.find((e) => e.kind === 'ipMoved');
  assert.equal(stored.notified, 'Ops mail', 'the event records who was told');
});

test('paused password monitor: nothing is sent when the change was rolled back', async () => {
  const db = memoryDb();
  const channels = recordingChannels();
  const mon = createMonitoring({ db, channels, maintenance: createMaintenance(db) });
  const inv = createInventory(db);
  const d = inv.create({ name: 'Cache', type: 'server', ip: '10.0.0.80', mac: 'aa:bb:cc:00:11:04' });
  await mon.create({ name: 'Cache Redis', type: 'redis', target: '10.0.0.80', port: 6379, password: 'pw', device_id: d.id });
  const { moveMonitors } = await import('../src/devicechange.js');
  assert.throws(() => db.transaction(() => { moveMonitors(db, d.id, '10.0.0.80', '10.0.0.81'); throw new Error('abort'); })(), /abort/);
  await settle();
  assert.equal(channels.sent.length, 0);
});

// ---------------------------------------------------------------------------------------------------- 3
function oldDb() {
  const db = memoryDb();
  db.pragma('user_version = 21');
  return db;
}
function device(db, { hostname, auto = '{}', mac }) {
  const ts = iso();
  return Number(db.prepare("INSERT INTO devices(name,type,ip,mac,hostname,auto_fields,created_at,updated_at) VALUES('Dev','server','192.168.1.90',?,?,?,?,?)")
    .run(mac, hostname, auto, ts, ts).lastInsertRowid);
}
function hist(db, id, kind, detail) {
  db.prepare('INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,?,?,?)').run(id, iso(), kind === 'edit' ? 'admin' : 'scan', kind, JSON.stringify(detail));
}
const autoOf = (db, id) => JSON.parse(db.prepare('SELECT auto_fields FROM devices WHERE id=?').get(id).auto_fields);

test('migration: a host name typed by hand before the ownership rule becomes the user\'s, scan and device names stay scan-owned', () => {
  const db = oldDb();
  const typed = device(db, { hostname: 'typed.lan', auto: '{"serial":"S1"}', mac: 'aa:bb:cc:00:12:01' });
  hist(db, typed, 'change', { field: 'hostname', from: 'a.lan', to: 'b.lan' });
  hist(db, typed, 'edit', { fields: [{ field: 'owner', from: '', to: 'IT' }, { field: 'hostname', from: 'b.lan', to: 'typed.lan' }] });
  hist(db, typed, 'edit', { fields: [{ field: 'notes' }] });
  const scanLater = device(db, { hostname: 'scan.lan', mac: 'aa:bb:cc:00:12:02' });
  hist(db, scanLater, 'edit', { fields: [{ field: 'hostname', from: '', to: 'typed.lan' }] });
  hist(db, scanLater, 'change', { field: 'hostname', from: 'typed.lan', to: 'scan.lan' });
  const reported = device(db, { hostname: 'host-1', mac: 'aa:bb:cc:00:12:03' });
  hist(db, reported, 'edit', { fields: [{ field: 'hostname', from: '', to: 'x.lan' }] });
  hist(db, reported, 'snmp', { source: 'script', fields: [{ field: 'hostname', from: 'x.lan', to: 'host-1' }] });
  const cleared = device(db, { hostname: 'filled.lan', mac: 'aa:bb:cc:00:12:04' });
  hist(db, cleared, 'edit', { fields: [{ field: 'hostname', from: 'old.lan', to: '' }] });
  const decided = device(db, { hostname: 'own.lan', auto: '{"hostname":"own.lan"}', mac: 'aa:bb:cc:00:12:05' });
  hist(db, decided, 'edit', { fields: [{ field: 'hostname', from: '', to: 'own.lan' }] });
  const broken = device(db, { hostname: 'b.lan', auto: 'not json', mac: 'aa:bb:cc:00:12:06' });
  hist(db, broken, 'edit', { fields: [{ field: 'hostname', from: '', to: 'b.lan' }] });
  db.prepare("INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,'x','edit','broken')").run(scanLater, iso());
  const names = db.prepare('SELECT id, hostname FROM devices ORDER BY id').all();

  migrate(db, { quiet: true });

  assert.equal(db.pragma('user_version', { simple: true }) >= 22, true);
  assert.deepEqual(autoOf(db, typed), { serial: 'S1', hostname: null });
  assert.deepEqual(autoOf(db, scanLater), {});
  assert.deepEqual(autoOf(db, reported), {});
  assert.deepEqual(autoOf(db, cleared), {});
  assert.deepEqual(autoOf(db, decided), { hostname: 'own.lan' });
  assert.deepEqual(autoOf(db, broken), { hostname: null });
  assert.deepEqual(db.prepare('SELECT id, hostname FROM devices ORDER BY id').all(), names, 'host names are never changed');

  // the scan now leaves the typed name alone
  const inv = createInventory(db);
  const scanId = db.prepare("INSERT INTO scans(kind,status,targets,started_at) VALUES('network','running','[]',?)").run(iso()).lastInsertRowid;
  const rid = db.prepare(`INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status)
    VALUES(?,'192.168.1.90','aa:bb:cc:00:12:01','dns.lan','','server',0.8,'{}','pending')`).run(scanId).lastInsertRowid;
  inv.applyResult(rid);
  assert.equal(inv.get(typed).hostname, 'typed.lan');
});

test('migration: the host name ownership update makes the usual copy of the database before the schema changes', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'mig-'));
  const file = path.join(dir, 'db.sqlite');
  openDatabase(file).close();
  const raw = new Database(file);
  raw.pragma('user_version = 21');
  raw.close();
  const db = openDatabase(file);
  assert.ok(db.pragma('user_version', { simple: true }) >= 22);
  db.close();
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('whatsonmynet-before-schema-22-')));
});

// ---------------------------------------------------------------------------------------------------- 5
test('scan results: an outdated scan still allows "stop ignoring", only adopt and ignore are restricted', async () => {
  const pick = await import('../public/js/scanpick.js').catch(() => null);
  assert.ok(pick, 'public/js/scanpick.js exists');
  const old = { id: 1, outdated: true };
  const fresh = { id: 2, outdated: false };
  assert.equal(pick.selectableRow(old, 'ignored'), true);
  assert.equal(pick.selectableRow(old, 'new'), false);
  assert.equal(pick.selectableRow(fresh, 'new'), true);
  assert.equal(pick.canAdopt([fresh]), true);
  assert.equal(pick.canAdopt([fresh, old]), false);
  assert.equal(pick.canAdopt([]), false);
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'js', 'views', 'scan.js'), 'utf8');
  assert.match(src, /disabled: !selectableRow\(r, mode\)/, 'check boxes follow the rule');
  assert.match(src, /disabled: !canAdopt\(/, 'adopt is refused for outdated rows');
  assert.doesNotMatch(src, /disabled: !!r\.outdated/);
});

// ---------------------------------------------------------------------------------------------------- 6
test('locations: subnet errors name the subnet as typed, so the form marks the right row', () => {
  const db = memoryDb();
  const loc = createLocations(db);
  assert.throws(() => loc.create({ name: 'Site', subnets: ['192.168.1.0/24', ' 10.0.7.9/16 '] }),
    (e) => e.code === 'err.cidrTooLarge' && e.detail === '10.0.7.9/16' && e.field === 'cidr');
  assert.throws(() => loc.create({ name: 'Site', subnets: ['192.168.1.0/24', '192.168.1.7/24'] }),
    (e) => e.code === 'err.cidrDuplicate' && e.detail === '192.168.1.7/24');
  loc.create({ name: 'Main', subnets: ['192.168.2.0/24'] });
  assert.throws(() => loc.create({ name: 'Other', subnets: ['192.168.2.9/24'] }),
    (e) => e.code === 'err.cidrTaken' && e.detail === '192.168.2.9/24 → Main');
});
