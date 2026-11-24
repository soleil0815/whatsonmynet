// Code audit 2026-11 b (data): standby sessions after a password reset on the master, credentials after a restore,
// secrets in the diagnostic package, the shared host key, alarm kinds handed back by the standby.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { tmp, memoryDb, startApp } from './helpers.js';
import { openDatabase, verifyKey, backupDatabase } from '../src/db.js';
import { createBackups, applyPendingRestore } from '../src/backup.js';
import { maskSecrets, createAnonymizer } from '../src/diagnostics.js';
import { createHosts } from '../src/hosts.js';
import { createPlugins } from '../src/plugins.js';
import { createTls } from '../src/tls.js';
import { parseCode } from '../src/failover.js';
import { csvCell } from '../src/lib/csv.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------- 1 + 5
test('failover: standby sessions end after a password or 2FA reset on the master; handed back "ipMoved" alarms are taken', async () => {
  const dirA = fs.mkdtempSync(path.join(tmp, 'b-fo-a-'));
  const dirB = fs.mkdtempSync(path.join(tmp, 'b-fo-b-'));
  const tlsA = createTls(path.join(dirA, 'tls')); await tlsA.ensure();
  const tlsB = createTls(path.join(dirB, 'tls')); await tlsB.ensure();
  const A = await startApp({ tls: tlsA, dataDir: dirA });
  const B = await startApp({ tls: tlsB, dataDir: dirB });
  const c = tlsA.current();
  const srv = https.createServer({ cert: c.cert, key: c.key }, A.app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const sync = async () => { B.ctx.failover._state().standby.needSync = true; await B.ctx.failover.tick(); };
  try {
    for (const X of [A, B]) assert.equal((await X.call('POST', '/api/setup', { username: 'chef', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
    const u = await A.call('POST', '/api/users', { username: 'leser', password: 'Leser-Passwort-12', role: 'viewer' });
    const v = await A.call('POST', '/api/users', { username: 'kollege', password: 'Kollege-Passwort-12', role: 'viewer' });
    assert.equal(u.status, 201);
    // "kollege" has begun to set up 2FA (secret stored, not confirmed yet): signs in with the password alone
    A.db.prepare("UPDATE users SET totp_secret='enc-secret' WHERE id=?").run(v.data.id);
    const code = (await A.call('POST', '/api/failover/master')).data.code;
    assert.equal((await B.call('POST', '/api/failover/pair', { address: `https://127.0.0.1:${srv.address().port}`, code })).status, 200);
    for (const [who, pw] of [['leser', 'Leser-Passwort-12'], ['kollege', 'Kollege-Passwort-12']]) {
      assert.equal((await B.call('POST', '/api/login', { username: who, password: pw }, { who })).status, 200);
    }
    // a sync without changes keeps both signed in
    await sync();
    assert.equal((await B.call('GET', '/api/devices', undefined, { who: 'leser' })).status, 200);
    // the admin resets the password of "leser" on the master: its standby session ends with the next copy
    assert.equal((await A.call('POST', `/api/users/${u.data.id}/password`, { password: 'Ganz-Neues-Passwort-9' })).status, 200);
    await sync();
    assert.equal((await B.call('GET', '/api/devices', undefined, { who: 'leser' })).status, 401, 'old session still reads the standby');
    assert.equal((await B.call('GET', '/api/devices', undefined, { who: 'kollege' })).status, 200, 'other users stay signed in');
    // a 2FA reset by the admin on the master ends the standby session as well
    assert.equal((await A.call('DELETE', `/api/users/${v.data.id}/2fa`)).status, 200);
    await sync();
    assert.equal((await B.call('GET', '/api/devices', undefined, { who: 'kollege' })).status, 401, 'session survived a 2FA reset');

    // 5: the standby hands back an "IP moved" alarm (kind ipMoved, written by devicechange.js)
    const mid = A.db.prepare("INSERT INTO monitors(name,type,target,created_at,updated_at) VALUES('PC-0001','ping','10.0.10.50',?,?)").run(iso(), iso()).lastInsertRowid;
    const { secret } = parseCode(code);
    const from = new Date(Date.now() - 3600000).toISOString(); const to = iso();
    const at = new Date(Date.now() - 1800000).toISOString();
    const req = { get: (h) => (h.toLowerCase() === 'authorization' ? `Bearer ${secret}` : ''), ip: '127.0.0.1', query: {},
      body: { pack: 'b'.repeat(16), part: 0, of: 1, from, to, monitors: { [mid]: { name: 'PC-0001', type: 'ping' } },
        events: [[mid, at, 'ipMoved', 'PC-0001: 10.0.10.50 → 10.0.10.51', '']] } };
    const out = A.ctx.failover.receiveHandback(req);
    assert.equal(out.events, 1, 'ipMoved alarm dropped');
    assert.equal(A.db.prepare("SELECT COUNT(*) n FROM monitor_events WHERE monitor_id=? AND kind='ipMoved'").get(mid).n, 1);
  } finally {
    A.ctx.failover.stop(); B.ctx.failover.stop(); srv.close(); await A.close(); await B.close();
  }
});

// ---------------------------------------------------------------------------------------------------- 2
function restoreSetup() {
  const dir = fs.mkdtempSync(path.join(tmp, 'b-restore-'));
  const dbFile = path.join(dir, 'whatsonmynet.sqlite');
  const backupsDir = path.join(dir, 'backups');
  const db = openDatabase(dbFile);
  verifyKey(db);
  return { dir, dbFile, backupsDir, db };
}

test('restore: revoked agent and host keys, deleted /metrics keys, changed passwords and deleted users do not come back', async () => {
  const { dbFile, backupsDir } = restoreSetup();
  let db = openDatabase(dbFile);
  const user = db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)');
  const chef = user.run('chef', 'hash-chef', 'admin', iso()).lastInsertRowid;
  const leser = user.run('leser', 'hash-leser-old', 'viewer', iso()).lastInsertRowid;
  const alt = user.run('ehemalig', 'hash-alt', 'editor', iso()).lastInsertRowid;
  const loc = db.prepare("INSERT INTO locations(name,created_at) VALUES('Filiale',?)").run(iso()).lastInsertRowid;
  const agent = db.prepare('INSERT INTO agents(name,location_id,token_hash,created_at) VALUES(?,?,?,?)');
  const a1 = agent.run('Agent 1', loc, sha('old-agent-1'), iso()).lastInsertRowid;
  const a2 = agent.run('Agent 2', loc, sha('old-agent-2'), iso()).lastInsertRowid;
  const host = db.prepare("INSERT INTO host_tokens(name,os,token_hash,created_at) VALUES(?,'windows',?,?)");
  const h1 = host.run('Alle PCs', sha('old-host-1'), iso()).lastInsertRowid;
  const h2 = host.run('Server', sha('old-host-2'), iso()).lastInsertRowid;
  db.prepare("INSERT INTO settings(key,value) VALUES('api.tokens',?)").run(JSON.stringify([{ id: 'k1', name: 'grafana', hash: sha('womn_oldkey'), prefix: 'womn_old', created_at: '' }]));
  const name = path.basename(await backupDatabase(db, 10, backupsDir));
  // after the backup: keys renewed or deleted, a password changed, 2FA switched on, a user deleted
  db.prepare('UPDATE agents SET token_hash=? WHERE id=?').run(sha('new-agent-1'), a1);
  db.prepare('DELETE FROM agents WHERE id=?').run(a2);
  db.prepare('UPDATE host_tokens SET token_hash=? WHERE id=?').run(sha('new-host-1'), h1);
  db.prepare('DELETE FROM host_tokens WHERE id=?').run(h2);
  db.prepare("DELETE FROM settings WHERE key='api.tokens'").run();
  db.prepare("UPDATE users SET password_hash='hash-leser-new', totp_enabled=1, totp_secret='enc', recovery_codes='[\"r\"]' WHERE id=?").run(leser);
  db.prepare('DELETE FROM users WHERE id=?').run(alt);
  await createBackups({ db, settings: { get: () => 10 }, dbFile, backupsDir, restart: () => {} }).restore({ name });
  db.close();
  applyPendingRestore(dbFile, backupsDir);
  db = openDatabase(dbFile);
  try {
    const ag = (id) => db.prepare('SELECT token_hash, enabled FROM agents WHERE id=?').get(id);
    assert.equal(ag(a1).token_hash, sha('new-agent-1'), 'agent key of today');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM agents WHERE token_hash IN (?,?)').get(sha('old-agent-1'), sha('old-agent-2')).n, 0, 'revoked agent key works again');
    assert.equal(ag(a2).enabled, 0, 'deleted agent comes back disabled');
    assert.equal(db.prepare('SELECT token_hash FROM host_tokens WHERE id=?').get(h1).token_hash, sha('new-host-1'));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM host_tokens WHERE token_hash=?').get(sha('old-host-2')).n, 0, 'deleted host key works again');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM settings WHERE key='api.tokens' AND value LIKE ?").get(`%${sha('womn_oldkey')}%`).n, 0, 'deleted metrics key works again');
    const l = db.prepare('SELECT password_hash, totp_enabled, totp_secret FROM users WHERE id=?').get(leser);
    assert.deepEqual([l.password_hash, l.totp_enabled, l.totp_secret], ['hash-leser-new', 1, 'enc'], 'old password works again');
    assert.equal(db.prepare('SELECT active FROM users WHERE id=?').get(alt).active, 0, 'deleted user comes back active');
    assert.equal(db.prepare('SELECT active FROM users WHERE id=?').get(chef).active, 1);
  } finally { db.close(); }
});

test('restore: refused when no administrator of the backup could still sign in; a backup of another installation is taken as it is', async () => {
  const { dbFile, backupsDir, db } = restoreSetup();
  db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('chef','x','admin',?)").run(iso());
  const name = path.basename(await backupDatabase(db, 10, backupsDir));
  db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('neu','y','admin',?)").run(iso());
  db.prepare("UPDATE users SET active=0 WHERE username='chef'").run();
  const backups = createBackups({ db, settings: { get: () => 10 }, dbFile, backupsDir, restart: () => {} });
  await assert.rejects(backups.restore({ name }), { code: 'err.backupNoAdminLive' });
  // another installation (moving to a new server with the same key): nothing to carry over
  const other = restoreSetup();
  other.db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('anderer','z','admin',?)").run(iso());
  const agentLoc = db.prepare("INSERT INTO locations(name,created_at) VALUES('Filiale',?)").run(iso()).lastInsertRowid;
  db.prepare('INSERT INTO agents(name,location_id,token_hash,created_at) VALUES(?,?,?,?)').run('Agent', agentLoc, sha('moved-agent'), iso());
  db.prepare("UPDATE users SET active=1 WHERE username='chef'").run();
  const moved = path.basename(await backupDatabase(db, 10, other.backupsDir));
  await createBackups({ db: other.db, settings: { get: () => 10 }, dbFile: other.dbFile, backupsDir: other.backupsDir, restart: () => {} }).restore({ name: moved });
  other.db.close(); db.close();
  applyPendingRestore(other.dbFile, other.backupsDir);
  const r = openDatabase(other.dbFile);
  try {
    assert.equal(r.prepare('SELECT enabled FROM agents WHERE token_hash=?').get(sha('moved-agent'))?.enabled, 1, 'agents of a moved installation keep working');
    assert.equal(r.prepare("SELECT active FROM users WHERE username='chef'").get().active, 1);
  } finally { r.close(); }
});

// ---------------------------------------------------------------------------------------------------- 3
test('diagnostics: query values, API key headers and Authorization schemes are masked; CSV cells are formula-safe', () => {
  const db = memoryDb();
  const an = createAnonymizer(db, true);
  const cases = ['https://hc.example/ping?access_token=SECRETVALUE1', 'https://api.example/h?key=SECRETVALUE2&x=1', 'Authorization: Bearer SECRETVALUE3',
    'https://h.example/a?auth_token=SECRETVALUE4', 'X-Api-Key: SECRETVALUE5', 'GET /hook?sig=SECRETVALUE6 failed', 'authorization=Basic SECRETVALUE7',
    'api-key=SECRETVALUE8', '{"apiKey":"SECRETVALUE9"}'];
  for (const s of cases) {
    assert.ok(!maskSecrets(s).includes('SECRETVALUE'), `maskSecrets leaks: ${maskSecrets(s)}`);
    assert.ok(!an.anon(s).includes('SECRETVALUE'), `anon leaks: ${an.anon(s)}`);
  }
  assert.equal(maskSecrets('Authorization: Bearer abc'), 'Authorization: ***');
  assert.equal(maskSecrets('https://hc.example/ping?access_token=abc&x=1#top'), 'https://hc.example/ping?access_token=***&x=***#top');
  assert.equal(maskSecrets('token=abc123 password: "x y" https://u:p@h/'), 'token=*** password: "*** y" https://***:***@h/');
  assert.equal(maskSecrets('5 tokens in use, key rotation done'), '5 tokens in use, key rotation done');
  assert.equal(csvCell('=HYPERLINK("http://192.0.2.1")'), '"\'=HYPERLINK(""http://192.0.2.1"")"');
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

// ---------------------------------------------------------------------------------------------------- 4
const GiB = 1024 ** 3;
const rep = (over) => ({ os: 'Microsoft Windows Server 2022 Standard', cpu: 5, memTotal: 8 * GiB, memUsed: 2 * GiB, uptime: 100,
  disks: [{ name: 'C:', used: 1, total: 10 }], services: [{ name: 'NTDS', state: 'running' }], macs: [], ips: [], ...over });

test('shared host key: no match by name or IP to a device with another MAC; a MAC match never replaces hardware', () => {
  const db = memoryDb();
  const ts = iso();
  const plugins = createPlugins({ db });
  const hosts = createHosts({ db, plugins });
  const dc = db.prepare("INSERT INTO devices(name,type,ip,mac,hostname,tags,created_at,updated_at) VALUES('DC01','server','10.0.10.10','00:15:5d:00:00:10','srv-dc01.firma.local','dc',?,?)").run(ts, ts).lastInsertRowid;
  plugins.create({ name: 'AD check', os: 'windows', code: 'Write-Output "0 ad - ok"', targets: { tags: ['dc'] } }, 'admin');
  const shared = hosts.create({ name: 'Alle Rechner', os: 'windows' }, { server: 'https://womn.firma.local' });
  // the real DC01 (its MAC): matched, plugin list handed out, hardware taken
  const real = hosts.push(shared.token, rep({ hostname: 'SRV-DC01', macs: ['00:15:5d:00:00:10'], services: [{ name: 'DNS', state: 'failed' }], hw: { vendor: 'Dell Inc.', model: 'PowerEdge R650', serial: 'REAL123' } }));
  assert.equal(real.device, dc);
  assert.ok(real.plugins);
  // another machine claims the name and leaves out its MACs - or names its own: unknown machine, DC01 untouched
  for (const macs of [[], ['00:15:5d:00:00:50']]) {
    assert.throws(() => hosts.push(shared.token, rep({ hostname: 'SRV-DC01', macs, services: [{ name: 'DNS', state: 'running' }] }), '10.0.10.50'), { code: 'err.hostUnknown' });
    assert.throws(() => hosts.push(shared.token, rep({ hostname: 'x', macs, ips: ['10.0.10.10'] })), { code: 'err.hostUnknown' });
  }
  assert.equal(hosts.report(dc).services[0].state, 'failed', 'the failed service of DC01 stays visible');
  // with DC01's MAC and made-up hardware: lands on DC01, but serial, model and MAC stay
  hosts.push(shared.token, rep({ hostname: 'whatever', macs: ['00:15:5d:00:00:10'], hw: { vendor: 'Fake', model: 'Fake', serial: 'FAKE999' } }));
  const d = db.prepare('SELECT serial, model, mac FROM devices WHERE id=?').get(dc);
  assert.deepEqual([d.serial, d.model, d.mac], ['REAL123', 'PowerEdge R650', '00:15:5d:00:00:10']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_history WHERE kind='replaced'").get().n, 0);
  // a device without MAC is still found by name; a per-device key keeps replacing hardware
  const noMac = db.prepare("INSERT INTO devices(name,type,ip,hostname,created_at,updated_at) VALUES('PC-0001','computer','10.0.10.51','pc-0001',?,?)").run(ts, ts).lastInsertRowid;
  assert.equal(hosts.push(shared.token, rep({ hostname: 'PC-0001', macs: ['00:15:5d:00:00:51'] })).device, noMac);
  const own = hosts.create({ os: 'windows', device_id: dc }, { server: 'https://womn.firma.local' });
  hosts.push(own.token, rep({ hostname: 'SRV-DC01', macs: [], hw: { vendor: 'Dell Inc.', model: 'PowerEdge R660', serial: 'NEW456' } }));
  assert.equal(db.prepare('SELECT serial FROM devices WHERE id=?').get(dc).serial, 'NEW456');
});
