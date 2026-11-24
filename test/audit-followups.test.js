// Follow-ups of the code audit 2026-11 (decided by the owner): SNMP access data per scan agent, restore keeps today's
// roles and limits, monitor targets checked again when a check runs (DNS rebinding), event rule patterns with a time limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const V3 = { user: 'womn-nord', level: 'authPriv', authProtocol: 'sha256', authKey: 'Auth-Schluessel-1', privProtocol: 'aes', privKey: 'Priv-Schluessel-1' };

test('scan agents get only the SNMP access data chosen for them', async () => {
  const app = await startApp({ setupToken: 'fu-setup' });
  const { call, ctx } = app;
  try {
    await call('POST', '/api/setup', { code: 'fu-setup', username: 'testadmin', password: 'Admin-Passwort-1', email: 'a@firma.local' });
    await call('PUT', '/api/settings/scan', { snmpCommunities: 'zentrale-geheim', snmpV3: [{ ...V3, user: 'womn-zentrale' }] });
    const loc = (await call('POST', '/api/locations', { name: 'Außenstelle', subnets: ['10.0.10.0/24'] })).data;
    const poll = async (token) => (await (await fetch(`${app.url}/api/agent/poll`, { headers: { Authorization: `Bearer ${token}` } })).json()).scan;

    // a new agent starts without stored access data: only "public"
    const a = (await call('POST', '/api/agents', { name: 'Nord', location_id: loc.id })).data;
    assert.equal(a.snmp_mode, 'none');
    let s = await poll(a.token);
    assert.equal(s.snmpCommunities, '');
    assert.equal(s.snmpV3, '');

    // its own: only these, encrypted in the database, the keys never on the admin page
    let r = await call('PUT', `/api/agents/${a.id}`, { name: 'Nord', location_id: loc.id, snmp_mode: 'own', snmp_communities: 'nord-community', snmp_v3: [V3] });
    assert.equal(r.status, 200);
    assert.equal(r.data.snmp_communities_set, true);
    assert.deepEqual(r.data.snmp_v3.map((u) => u.user), ['womn-nord']);
    const listed = JSON.stringify((await call('GET', '/api/agents')).data);
    for (const secret of ['nord-community', V3.authKey, V3.privKey]) assert.ok(!listed.includes(secret), `${secret} not on the admin page`);
    const row = ctx.db.prepare('SELECT snmp_communities, snmp_v3 FROM agents WHERE id=?').get(a.id);
    assert.ok(row.snmp_communities.startsWith('v1:') && !row.snmp_communities.includes('nord'), 'stored encrypted');
    s = await poll(a.token);
    assert.equal(s.snmpCommunities, 'nord-community');
    assert.deepEqual(JSON.parse(s.snmpV3).map((u) => [u.user, u.authKey]), [['womn-nord', V3.authKey]]);
    assert.ok(!JSON.stringify(s).includes('zentrale'), 'nothing of the server or other locations');

    // saving again without keys keeps them (the page never has them)
    await call('PUT', `/api/agents/${a.id}`, { name: 'Nord', location_id: loc.id, snmp_mode: 'own', snmp_v3: [{ ...V3, authKey: '', privKey: '' }] });
    s = await poll(a.token);
    assert.equal(s.snmpCommunities, 'nord-community');
    assert.equal(JSON.parse(s.snmpV3)[0].privKey, V3.privKey);

    // "all" is a choice of the admin; leaving "own" forgets the agent's own data
    await call('PUT', `/api/agents/${a.id}`, { name: 'Nord', location_id: loc.id, snmp_mode: 'all' });
    s = await poll(a.token);
    assert.equal(s.snmpCommunities, 'zentrale-geheim');
    assert.equal(ctx.db.prepare('SELECT snmp_communities FROM agents WHERE id=?').get(a.id).snmp_communities, '');
    // an edit without the field keeps the mode
    await call('PUT', `/api/agents/${a.id}`, { name: 'Nord 2', location_id: loc.id });
    assert.equal(ctx.agents.get(a.id).snmp_mode, 'all');
    assert.equal((await call('PUT', `/api/agents/${a.id}`, { name: 'Nord', location_id: loc.id, snmp_mode: 'own', snmp_v3: [{ ...V3, authKey: 'kurz' }] })).status, 400);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------- restore
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { tmp } from './helpers.js';
import { openDatabase, verifyKey, backupDatabase } from '../src/db.js';
import { createBackups, applyPendingRestore } from '../src/backup.js';

const iso = () => new Date().toISOString();
function restoreSetup() {
  const dir = fs.mkdtempSync(path.join(tmp, 'b-followup-'));
  const dbFile = path.join(dir, 'whatsonmynet.sqlite');
  const backupsDir = path.join(dir, 'backups');
  const db = openDatabase(dbFile);
  verifyKey(db);
  return { dbFile, backupsDir, db };
}

test('restore: today\'s roles, location limits and agent SNMP choices stay', async () => {
  const { dbFile, backupsDir, db: first } = restoreSetup();
  let db = first;
  const user = db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)');
  user.run('testadmin', 'h', 'admin', iso());
  const ex = user.run('max', 'h', 'admin', iso()).lastInsertRowid;
  const ed = user.run('erika', 'h', 'editor', iso()).lastInsertRowid;
  const lim = user.run('lena', 'h', 'editor', iso()).lastInsertRowid;
  const loc = db.prepare('INSERT INTO locations(name,created_at) VALUES(?,?)');
  loc.run('Zentrale', iso());
  const l2 = loc.run('Filiale', iso()).lastInsertRowid;
  const agent = db.prepare("INSERT INTO agents(name,location_id,token_hash,created_at,snmp_mode) VALUES(?,?,?,?,'all')").run('Nord', l2, 'hash-nord', iso()).lastInsertRowid;
  const name = path.basename(await backupDatabase(db, 10, backupsDir));
  // after the backup: an admin demoted, an editor limited to one location, the agent narrowed to its own data
  db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(ex);
  db.prepare('INSERT INTO user_locations(user_id,location_id) VALUES(?,?)').run(ed, l2);
  // a location created after the backup: a limit only to it has nothing in the backup → the user is switched off
  const l3 = loc.run('Neu', iso()).lastInsertRowid;
  db.prepare('INSERT INTO user_locations(user_id,location_id) VALUES(?,?)').run(lim, l3);
  db.prepare("UPDATE agents SET snmp_mode='own', snmp_communities='v1:x' WHERE id=?").run(agent);
  await createBackups({ db, settings: { get: () => 10 }, dbFile, backupsDir, restart: () => {} }).restore({ name });
  db.close();
  applyPendingRestore(dbFile, backupsDir);
  db = openDatabase(dbFile);
  try {
    assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(ex).role, 'viewer', 'demoted admin gets admin back');
    assert.deepEqual(db.prepare('SELECT location_id FROM user_locations WHERE user_id=?').all(ed).map((r) => r.location_id), [l2], 'limit dropped');
    assert.equal(db.prepare('SELECT active FROM users WHERE id=?').get(lim).active, 0, 'limit to a location missing in the backup would mean "everything"');
    assert.deepEqual({ ...db.prepare('SELECT snmp_mode, snmp_communities FROM agents WHERE id=?').get(agent) }, { snmp_mode: 'own', snmp_communities: 'v1:x' });
  } finally { db.close(); }
});

test('restore: no admin left by today\'s roles is refused', async () => {
  const { dbFile, backupsDir, db } = restoreSetup();
  const ex = db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('max','h','admin',?)").run(iso()).lastInsertRowid;
  const name = path.basename(await backupDatabase(db, 10, backupsDir));
  db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(ex);
  db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('testadmin','h','admin',?)").run(iso());
  await assert.rejects(createBackups({ db, settings: { get: () => 10 }, dbFile, backupsDir, restart: () => {} }).restore({ name }), { code: 'err.backupNoAdminLive' });
  db.close();
});

test('restore: a backup from before the agent SNMP choice does not give agents "all" again', async () => {
  const { dbFile, backupsDir, db: first } = restoreSetup();
  let db = first;
  db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('testadmin','h','admin',?)").run(iso());
  const l = db.prepare("INSERT INTO locations(name,created_at) VALUES('Filiale',?)").run(iso()).lastInsertRowid;
  const a = db.prepare("INSERT INTO agents(name,location_id,token_hash,created_at,snmp_mode) VALUES('Nord',?,'hash-nord',?,'none')").run(l, iso()).lastInsertRowid;
  const file = await backupDatabase(db, 10, backupsDir);
  // make the backup look like one of 0.56 (schema 43, agents without the new columns)
  const raw = path.join(path.dirname(file), 'raw.sqlite');
  fs.writeFileSync(raw, zlib.gunzipSync(fs.readFileSync(file)));
  const old = new Database(raw);
  old.pragma('foreign_keys = OFF');
  old.exec(`CREATE TABLE agents_old AS SELECT id, name, location_id, token_hash, enabled, created_at, last_seen, last_ip, version FROM agents;
    DROP TABLE agents; CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT NOT NULL, location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_seen TEXT, last_ip TEXT, version TEXT NOT NULL DEFAULT '');
    INSERT INTO agents SELECT * FROM agents_old; DROP TABLE agents_old; PRAGMA user_version = 43;`);
  old.close();
  fs.writeFileSync(file, zlib.gzipSync(fs.readFileSync(raw)));
  fs.rmSync(raw);
  await createBackups({ db, settings: { get: () => 10 }, dbFile, backupsDir, restart: () => {} }).restore({ name: path.basename(file) });
  db.close();
  applyPendingRestore(dbFile, backupsDir);
  db = openDatabase(dbFile);
  try {
    assert.equal(db.prepare('SELECT snmp_mode FROM agents WHERE id=?').get(a).snmp_mode, 'none');
  } finally { db.close(); }
});

test('schema update: agents that exist keep "all", new ones start with "none"', () => {
  const { db } = restoreSetup();
  const cols = db.prepare("SELECT name, dflt_value FROM pragma_table_info('agents') WHERE name='snmp_mode'").get();
  assert.equal(cols.dflt_value, "'all'");
  db.close();
});

// ---------------------------------------------------------------------------------------------------- DNS rebinding
import http from 'node:http';
import { setLookupForTests } from '../src/lib/targetguard.js';
import { runCheck, httpCheck, pinnedLookup } from '../src/monitor/checks.js';

test('monitor of a non-admin: the address is checked again when the check runs and exactly that one is contacted', async () => {
  const app = await startApp({ setupToken: 'fu-dns' });
  const { call, ctx } = app;
  const srv = http.createServer((_q, r) => r.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  let answer = '10.0.10.5';
  setLookupForTests(async () => [{ address: answer, family: 4 }]);
  try {
    await call('POST', '/api/setup', { code: 'fu-dns', username: 'testadmin', password: 'Admin-Passwort-1', email: 'a@firma.local' });
    await call('POST', '/api/users', { username: 'max', password: 'Max-Passwort-123', role: 'editor', email: 'max@firma.local' });
    await call('POST', '/api/login', { username: 'max', password: 'Max-Passwort-123' }, { who: 'ed' });
    const ed = { who: 'ed' };
    const m = await call('POST', '/api/monitors', { name: 'Intranet', type: 'http', target: `http://intranet.firma.local:${port}/`, interval_s: 3600 }, ed);
    assert.equal(m.status, 201);
    const row = ctx.db.prepare('SELECT * FROM monitors WHERE id=?').get(m.data.id);
    assert.ok(row.target_rule, 'the rule of the editor is kept');
    assert.ok(!('target_rule' in m.data), 'not shown to the browser');
    // later the name points at the server itself: refused when the check runs
    answer = '127.0.0.1';
    const r = await runCheck(row, {});
    assert.equal(r.ok, false);
    assert.match(r.message, /not allowed/);
    // an admin saves a new address: no rule any more, the check runs as typed
    await call('PUT', `/api/monitors/${m.data.id}`, { name: 'Intranet', type: 'http', target: `http://intranet2.firma.local:${port}/`, interval_s: 3600 });
    assert.equal(ctx.db.prepare('SELECT target_rule FROM monitors WHERE id=?').get(m.data.id).target_rule, null);
    // an admin's monitor has no rule at all
    const am = await call('POST', '/api/monitors', { name: 'Lokal', type: 'tcp', target: '127.0.0.1', port, interval_s: 3600 });
    assert.equal(ctx.db.prepare('SELECT target_rule FROM monitors WHERE id=?').get(am.data.id).target_rule, null);
  } finally { setLookupForTests(null); srv.close(); await app.close(); }
});

test('a pinned check contacts the checked address, not a second DNS answer', async () => {
  const srv = http.createServer((q, r) => r.end(q.headers.host));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    // the name does not exist: only the pinned address can make this check succeed - and the Host header stays the name
    const r = await httpCheck(`http://gibt-es-nicht.invalid:${port}/`, { timeoutS: 3, keyword: `gibt-es-nicht.invalid:${port}`, lookup: pinnedLookup('127.0.0.1', 4) });
    assert.equal(r.ok, true, r.message);
  } finally { srv.close(); }
});

// ---------------------------------------------------------------------------------------------------- regex time limit
import { regexRun, HARD_MS } from '../src/lib/saferegex.js';
import { memoryDb } from './helpers.js';
import { createEventRules } from '../src/eventrules.js';

test('an expression that never ends is stopped after its time limit - the server goes on, the next one works', () => {
  const t0 = Date.now();
  assert.throws(() => regexRun('(a+)+$', `${'a'.repeat(40)}!`), (e) => e.code === 'REGEX_TIMEOUT');
  const took = Date.now() - t0;
  assert.ok(took < HARD_MS + 2000, `stopped after ${took} ms`);
  const r = regexRun('Port (\\d+) link down', 'Port 12 LINK down', { group: true });
  assert.deepEqual([r.match, r.key], [true, '12']);
  assert.equal(regexRun('ä', 'Ä').match, true, 'case-insensitive like before');
  assert.equal(regexRun('xyz', 'abc').match, false);
});

test('an event rule whose expression slipped through the checks is switched off instead of holding the server', () => {
  const db = memoryDb();
  const ts = new Date().toISOString();
  // written into the database directly: the checks when saving would refuse it
  const id = db.prepare("INSERT INTO event_rules(name,enabled,match,channels,mode,created_at,updated_at) VALUES('Böse',1,?, '[]','single',?,?)")
    .run(JSON.stringify({ regex: '(a+)+$', maxSeverity: 7 }), ts, ts).lastInsertRowid;
  const rules = createEventRules({ db, channels: { notifyIds: async () => [] } });
  rules.start?.();
  const evId = db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,text) VALUES(?,'syslog','10.0.10.21',3,?)").run(ts, `${'a'.repeat(40)}!`).lastInsertRowid;
  const t0 = Date.now();
  rules.onEvent({ id: evId, at: ts, kind: 'syslog', source_ip: '10.0.10.21', severity: 3, text: `${'a'.repeat(40)}!`, app: '', channel: '', event_id: null, device_id: null });
  assert.ok(Date.now() - t0 < HARD_MS + 2000);
  const r = db.prepare('SELECT enabled, options FROM event_rules WHERE id=?').get(id);
  assert.equal(r.enabled, 0);
  assert.match(r.options, /regex slow/);
  rules.stop?.();
});

// ---------------------------------------------------------------------------------------------------- CI
test('release workflows: the Trivy gate runs in its own job before publish; publish takes its digest', () => {
  for (const f of ['ci.yml', 'security-update.yml']) {
    const wf = fs.readFileSync(path.join('.github', 'workflows', f), 'utf8');
    assert.ok(wf.includes('\n  candidate-scan:'), f);
    const scan = wf.slice(wf.indexOf('\n  candidate-scan:'), wf.indexOf('\n  publish:'));
    const publish = wf.slice(wf.indexOf('\n  publish:'), wf.indexOf('\n  cleanup-candidates:'));
    assert.match(scan, /trivy-scan\.sh[^\n]*amd64/, f);
    assert.match(scan, /trivy-scan\.sh[^\n]*arm64/, f);
    assert.doesNotMatch(publish, /trivy-(scan|check)\.sh/, `${f}: no scan inside publish any more`);
    assert.match(publish, /needs: \[[^\]]*candidate-scan\]/, f);
    assert.match(publish, /needs\.candidate-scan\.outputs\.digest/, f);
    assert.match(wf.slice(wf.indexOf('\n  cleanup-candidates:')), /needs: \[[^\]]*candidate-scan[^\]]*\]/, f);
  }
});

test('Windows checks: Fluent Bit in a fixed version, Node 24', () => {
  assert.match(fs.readFileSync('tools/wincheck/fluentbit.ps1', 'utf8'), /choco install fluent-bit --version \$FluentBitVersion/);
  const wf = fs.readFileSync('.github/workflows/windows.yml', 'utf8');
  assert.doesNotMatch(wf, /node-version: 22/);
});

// ---------------------------------------------------------------------------------------------------- review findings
test('review: an admin with left-over location rows is not switched off by a restore', async () => {
  const { dbFile, backupsDir, db: first } = restoreSetup();
  let db = first;
  const adm = db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('testadmin','h','admin',?)").run(iso()).lastInsertRowid;
  const name = path.basename(await backupDatabase(db, 10, backupsDir));
  const l = db.prepare("INSERT INTO locations(name,created_at) VALUES('Neu',?)").run(iso()).lastInsertRowid;
  db.prepare('INSERT INTO user_locations(user_id,location_id) VALUES(?,?)').run(adm, l);
  await createBackups({ db, settings: { get: () => 10 }, dbFile, backupsDir, restart: () => {} }).restore({ name });
  db.close();
  applyPendingRestore(dbFile, backupsDir);
  db = openDatabase(dbFile);
  try { assert.equal(db.prepare('SELECT active FROM users WHERE id=?').get(adm).active, 1); } finally { db.close(); }
});

test('review: an admin changing only the port keeps the rule of the host a non-admin typed', async () => {
  const app = await startApp({ setupToken: 'fu-port' });
  const { call, ctx } = app;
  setLookupForTests(async () => [{ address: '10.0.10.9', family: 4 }]);
  try {
    await call('POST', '/api/setup', { code: 'fu-port', username: 'testadmin', password: 'Admin-Passwort-1', email: 'a@firma.local' });
    await call('POST', '/api/users', { username: 'max', password: 'Max-Passwort-123', role: 'editor', email: 'max@firma.local' });
    await call('POST', '/api/login', { username: 'max', password: 'Max-Passwort-123' }, { who: 'ed' });
    const m = await call('POST', '/api/monitors', { name: 'Dienst', type: 'tcp', target: 'dienst.firma.local', port: 80, interval_s: 3600 }, { who: 'ed' });
    assert.equal(m.status, 201);
    await call('PUT', `/api/monitors/${m.data.id}`, { name: 'Dienst', type: 'tcp', target: 'dienst.firma.local', port: 8080, interval_s: 3600 });
    assert.ok(ctx.db.prepare('SELECT target_rule FROM monitors WHERE id=?').get(m.data.id).target_rule);
  } finally { setLookupForTests(null); await app.close(); }
});

test('review: a non-admin cannot reach the host itself through the web address of a device', async () => {
  const app = await startApp({ setupToken: 'fu-web' });
  const { call } = app;
  try {
    await call('POST', '/api/setup', { code: 'fu-web', username: 'testadmin', password: 'Admin-Passwort-1', email: 'a@firma.local' });
    await call('POST', '/api/users', { username: 'max', password: 'Max-Passwort-123', role: 'editor', email: 'max@firma.local' });
    await call('POST', '/api/login', { username: 'max', password: 'Max-Passwort-123' }, { who: 'ed' });
    const r = await call('POST', '/api/devices', { name: 'PC-0001', ip: '10.0.10.21', type: 'pc', web_url: 'http://127.0.0.1:9/admin' }, { who: 'ed' });
    assert.equal(r.status, 403);
    assert.equal((await call('POST', '/api/devices', { name: 'PC-0002', ip: '10.0.10.22', type: 'pc', web_url: 'http://10.0.10.22/' }, { who: 'ed' })).status, 201);
  } finally { await app.close(); }
});

test('review: monitors made by automatic watching never contact the host itself', async () => {
  const r = await runCheck({ type: 'tcp', target: '127.0.0.1', port: 9, timeout_s: 1, target_rule: JSON.stringify({ scoped: false, subnets: [] }) }, {});
  assert.match(r.message, /not allowed/);
});
