// Many machines, monitors and messages: the pages must not read everything whole on every visit, and nothing that
// runs in the background may hold the server up (every click waits as long). What the measurements with a thousand
// machine reports, 400 monitors and 1.5 million messages found - each kept as a test, so it does not come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { createHosts, cleanReport, hostTempsByName, nodeScriptsInto, forgetReporting } from '../src/hosts.js';
import { createInventory } from '../src/inventory.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';
import { createSensorChoices } from '../src/monitor/choices.js';

const at = (ms = 0) => new Date(Date.now() - ms).toISOString();
const facts = (db, id) => db.prepare('SELECT hostname, os, script, temps, self_update, offered FROM host_report_facts WHERE device_id=?').get(id);
function device(db, name, extra = {}) {
  const ts = at();
  return db.prepare('INSERT INTO devices(name,type,hostname,ip,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(name, extra.type || 'computer', extra.hostname || name.toLowerCase(), extra.ip || null, ts, ts).lastInsertRowid;
}

test('what the pages need of a report is kept in a small table of its own - by every way a report is written', () => {
  const db = memoryDb();
  const id = device(db, 'PVE1');
  const settings = { get: (k) => (k === 'hosts.selfUpdate' ? true : undefined) };
  const hosts = createHosts({ db, settings });
  const shared = hosts.create({ name: 'Alle Linux-Rechner', os: 'linux' }, { server: 'https://womn.firma.local' });
  const rep = (o) => ({ hostname: 'pve1', os: 'Debian GNU/Linux 12', script: '0.58.0', temps: [{ chip: 'coretemp', dev: 'isa', name: 'Package id 0', mC: 51000 }], ...o });
  hosts.push(shared.token, rep());
  let f = facts(db, id);
  assert.deepEqual([f.hostname, f.os, f.script, JSON.parse(f.temps)[0].c], ['pve1', 'Debian GNU/Linux 12', '0.58.0', 51]);
  assert.equal(JSON.parse(f.offered).version.length > 0, true, 'the time an update was offered');
  // the second report of the same machine (written with an upsert): it used to fail with "UNIQUE constraint failed"
  // when the trigger said INSERT OR REPLACE - SQLite applies the conflict rule of the outer statement to the trigger
  hosts.push(shared.token, rep({ script: '0.59.0', temps: [{ chip: 'coretemp', dev: 'isa', name: 'Package id 0', mC: 77000 }] }));
  hosts.push(shared.token, rep({ script: '0.59.0', temps: [] }));
  f = facts(db, id);
  assert.deepEqual([f.script, f.temps], ['0.59.0', null], 'no temperatures: none kept');
  // written directly (other parts of the program and the tests do), a broken report, a removed one
  db.prepare("UPDATE host_reports SET data=json_set(data,'$.os','Debian GNU/Linux 13') WHERE device_id=?").run(id);
  assert.equal(facts(db, id).os, 'Debian GNU/Linux 13');
  db.prepare("UPDATE host_reports SET data='{broken' WHERE device_id=?").run(id);
  assert.deepEqual(facts(db, id), { hostname: null, os: null, script: null, temps: null, self_update: null, offered: null });
  db.prepare('DELETE FROM host_reports WHERE device_id=?').run(id);
  assert.equal(facts(db, id), undefined);
  // a device that goes takes its row along
  db.prepare("INSERT INTO host_reports(device_id,at,data) VALUES(?,?,'{\"hostname\":\"pve1\"}')").run(id, at());
  db.prepare('DELETE FROM devices WHERE id=?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM host_report_facts').get().n, 0);
});

test('temperatures, script overview and node join read the small table - the report only for the machines shown', () => {
  const db = memoryDb();
  const ids = [];
  for (let i = 1; i <= 30; i++) {
    const id = device(db, `PC-${String(i).padStart(4, '0')}`);
    ids.push(id);
    const r = cleanReport({ hostname: `pc-${String(i).padStart(4, '0')}`, os: 'Microsoft Windows 11 Pro', script: '0.58.0', services: [{ name: 'Spooler', state: i === 3 ? 'failed' : 'running' }] });
    db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?)').run(id, at(), JSON.stringify(i === 2 ? { ...r, temps: [{ name: 'CPU', c: 66 }] } : r));
  }
  // a report the page would have to read whole is replaced by one that cannot be read: the lists still work
  const temps = hostTempsByName(db);
  assert.deepEqual([...temps.keys()], ['pc-0002']);
  assert.equal(temps.get('pc-0002').c, 66);
  const hosts = createHosts({ db, settings: { get: () => true } });
  assert.equal(hosts.scripts().outdated, 30);
  // the join on the hypervisor page: only the shown node's report is read, the others are never parsed
  db.prepare("UPDATE host_reports SET data=? WHERE device_id NOT IN (?,?)").run('{not json', ids[1], ids[2]);
  forgetReporting(db);
  const d = nodeScriptsInto(db, { nodes: [{ name: 'pc-0003' }, { name: 'pc-0099' }] });
  assert.equal(d.nodes[0].report.deviceId, ids[2]);
  assert.deepEqual(d.nodes[0].report.glance.failed, ['Spooler']);
  assert.equal(d.nodes[1].script, false);
  // the name a broken report would give is unknown, the inventory names still find the machine
  assert.equal(nodeScriptsInto(db, { nodes: [{ name: 'pc-0010' }] }).nodes[0].report.deviceId, ids[9]);
  // sensors: the index of names comes from the small table too
  const choices = createSensorChoices({ db, settings: { get: () => undefined } });
  assert.ok(choices.deviceIds().has(ids[0]));
});

test('monitor list: the last 40 checks of the day per monitor, oldest first - without numbering every check of the day', async () => {
  const db = memoryDb();
  const mon = createMonitoring({ db, channels: { notify: async () => [], notifyIds: async () => [] }, maintenance: createMaintenance(db) });
  const a = await mon.create({ name: 'A', type: 'tcp', target: '10.0.10.1', port: 22 });
  const b = await mon.create({ name: 'B', type: 'tcp', target: '10.0.10.2', port: 22 });
  const ins = db.prepare('INSERT INTO checks(monitor_id,at,ok,ms,message) VALUES(?,?,?,?,?)');
  for (let i = 0; i < 100; i++) ins.run(a.id, at((100 - i) * 60000), i % 10 ? 1 : 0, i, `#${i}`);
  ins.run(b.id, at(2 * 86400000), 1, 5, 'yesterday and before');
  const list = mon.list();
  const la = list.find((m) => m.id === a.id); const lb = list.find((m) => m.id === b.id);
  assert.equal(la.beats.length, 40);
  assert.deepEqual([la.beats[0].message, la.beats[39].message], ['#60', '#99'], 'the newest 40, oldest first');
  assert.equal(la.beats[0].ok, false, '#60 failed (every tenth)');
  assert.equal(la.beats[1].ok, true);
  assert.equal(la.beats.find((x) => x.message === '#70').ok, false);
  assert.deepEqual(lb.beats, [], 'older than a day: none');
});

test('cleanup of old checks: monitor by monitor with breaks, the newer rows stay', async () => {
  const db = memoryDb();
  const mon = createMonitoring({ db, channels: { notify: async () => [], notifyIds: async () => [] }, maintenance: createMaintenance(db) });
  const ms = [];
  for (let i = 0; i < 5; i++) ms.push(await mon.create({ name: `M${i}`, type: 'tcp', target: `10.0.10.${i + 1}`, port: 22 }));
  const ins = db.prepare('INSERT INTO checks(monitor_id,at,ok,ms,message) VALUES(?,?,1,1,?)');
  for (const m of ms) { ins.run(m.id, at(8 * 86400000), 'old'); ins.run(m.id, at(3600000), 'new'); }
  db.prepare('INSERT INTO monitor_hourly(monitor_id,hour,ok,total) VALUES(?,?,1,1)').run(ms[0].id, at(401 * 86400000).slice(0, 13));
  db.prepare('INSERT INTO monitor_events(monitor_id,at,kind) VALUES(?,?,?)').run(ms[0].id, at(401 * 86400000), 'down');
  // it gives the server back between monitors: something else gets its turn before it is done
  let other = false;
  setImmediate(() => { other = true; });
  const running = mon.cleanup();
  assert.equal(other, false);
  const n = await running;
  assert.equal(other, true);
  assert.equal(n, 7);
  assert.deepEqual(db.prepare('SELECT DISTINCT message FROM checks').all().map((r) => r.message), ['new']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM monitor_hourly').get().n, 0);
});

test('device page: its presence alone, the same as in the list (not the whole inventory for one device)', () => {
  const db = memoryDb();
  const inv = createInventory(db);
  const t = (ms) => at(ms);
  db.prepare("INSERT INTO scans(kind,status,targets,started_at,finished_at) VALUES('network','done',?,?,?)").run(JSON.stringify([{ cidr: '10.0.10.0/24' }, { cidr: 'kaputt' }]), t(3600000), t(3000000));
  const seen = device(db, 'PC-0001', { ip: '10.0.10.11' });
  const gone = device(db, 'PC-0002', { ip: '10.0.10.12' });
  const other = device(db, 'PC-0003', { ip: '10.0.20.13' });
  db.prepare('UPDATE devices SET created_at=?, last_seen=? WHERE id=?').run(t(86400000), t(60000), seen);
  db.prepare('UPDATE devices SET created_at=?, last_seen=? WHERE id=?').run(t(86400000), t(86400000), gone);
  const list = new Map(inv.list().map((d) => [d.id, d.presence]));
  for (const id of [seen, gone, other]) assert.equal(inv.presenceOf(id), list.get(id));
  assert.deepEqual([inv.presenceOf(seen), inv.presenceOf(gone), inv.presenceOf(other), inv.presenceOf(9999)], ['online', 'missing', 'unknown', 'unknown']);
});
