// Self-update of the machine scripts: WhatsOnMyNet names a newer version in its answer to a report, the script fetches
// the template with its own key, checks fingerprint and version, puts its own address, key and pin in and replaces
// itself. Also: the overview of outdated scripts and "new hardware, same machine" for unknown machines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { memoryDb, tmp } from './helpers.js';
import { createHosts, scriptState } from '../src/hosts.js';
import { hostScript, scriptTemplate, uninstallScript, SCRIPT_VERSIONS } from '../src/hostscripts.js';

const run = promisify(execFile);
const settings = (over = {}) => { const m = { 'hosts.selfUpdate': true, ...over }; return { get: (k) => m[k] }; };
const SERVER = 'https://womn.firma.local';

function setup(over) {
  const db = memoryDb();
  const ts = new Date().toISOString();
  const id = db.prepare("INSERT INTO devices(name,type,hostname,created_at,updated_at) VALUES('PC-0001','computer','pc-0001',?,?)").run(ts, ts).lastInsertRowid;
  const hosts = createHosts({ db, settings: settings(over) });
  const shared = hosts.create({ name: 'Alle Windows-Rechner', os: 'windows' }, { server: SERVER });
  return { db, id, hosts, shared };
}
const report = (o = {}) => ({ hostname: 'pc-0001', os: 'Microsoft Windows 11 Pro 10.0.26100', script: '0.58.0', ...o });

test('the answer names a newer script only when self-update is on and the machine runs an older one', () => {
  const { hosts, shared } = setup();
  const tpl = scriptTemplate('windows');
  assert.equal(hosts.push(shared.token, report()).update, `${SCRIPT_VERSIONS.windows}:${tpl.sha256}`);
  assert.equal(hosts.push(shared.token, report({ script: SCRIPT_VERSIONS.windows })).update, undefined, 'up to date');
  const off = setup({ 'hosts.selfUpdate': false });
  assert.equal(off.hosts.push(off.shared.token, report()).update, undefined, 'switched off');
});

test('the template: only with a valid key, without key, address or pin of anyone, fingerprint as named', () => {
  const { hosts, shared } = setup();
  assert.throws(() => hosts.template('x'.repeat(30)), { code: 'err.unauthorized' });
  const t = hosts.template(shared.token);
  assert.equal(t.sha256, scriptTemplate('windows').sha256);
  const text = t.bytes.toString('utf8');
  assert.ok(!text.includes(shared.token));
  for (const mark of ['@@WOMN_URL@@', '@@WOMN_TOKEN@@', '@@WOMN_THUMB@@', '@@WOMN_PUBKEY@@']) assert.ok(text.includes(mark), mark);
  assert.ok(text.split('\n').includes(`$ScriptVersion = '${SCRIPT_VERSIONS.windows}'`), 'the version line of the template');
  const off = setup({ 'hosts.selfUpdate': false });
  assert.throws(() => off.hosts.template(off.shared.token), { code: 'err.selfUpdateOff' });
});

// ------------------------------------------------------------------------------------------------- Linux, for real
function linuxMachine(answer, { url = 'https://w.firma.local/api/hosts/push', bins = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'su-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const w = (n, b) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${b}\n`, { mode: 0o755 });
  w('id', 'echo 1000'); w('hostname', 'echo app01'); w('crontab', 'cat >/dev/null');
  for (const [n, b] of Object.entries(bins)) w(n, b);
  const tplFile = path.join(dir, 'template.sh');
  fs.writeFileSync(tplFile, scriptTemplate('linux').bytes);
  // stand-in curl: the report gets the answer, the download gets the template (to the file after -o)
  w('curl', `out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; done
case "$*" in *"/api/hosts/script"*) cp "${tplFile}" "$out" ;; *) cat > "${dir}/body"; printf '%s' '${JSON.stringify(answer)}' ;; esac`);
  // the copy cron runs: an older version of the script, with its own address, key and pin
  const s = hostScript('linux', { url, token: "tok-1234567890'x", pin: { spki: 'AbC+/9=' } });
  const old = s.text.replace(/^SCRIPT_VERSION=.*$/m, 'SCRIPT_VERSION=0.58.0');
  const dest = path.join(dir, '.local', 'bin', s.file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, old, { mode: 0o700 });
  const go = (file = dest) => spawnSync('sh', [file, '--run'], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, WOMN_CHECKS: path.join(dir, 'none'), WOMN_PLUGINS: path.join(dir, 'none'), WOMN_HWMON: path.join(dir, 'none'), WOMN_THERMAL: path.join(dir, 'none') }, timeout: 60000 });
  return { dir, dest, s, go, old, state: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.cache', 'whatsonmynet', 'update.json'), 'utf8')); } catch { return null; } } };
}

test('Linux script: replaces itself with the newer version and keeps its own address, key and pin', { skip: !fs.existsSync('/bin/sh') }, () => {
  const tpl = scriptTemplate('linux');
  const m = linuxMachine({ ok: true, device: 1, plugins: '', nics: false, update: `${tpl.version}:${tpl.sha256}` });
  const r = m.go();
  assert.equal(r.status, 0, String(r.stderr));
  const now = fs.readFileSync(m.dest, 'utf8');
  assert.equal(now, m.s.text, 'exactly the script WhatsOnMyNet would hand out to this machine');
  assert.equal((fs.statSync(m.dest).mode & 0o777).toString(8), '700');
  assert.deepEqual([m.state().ok, m.state().version, m.state().message], [true, tpl.version, '']);
  // the next report says how it went
  m.go();
  const body = JSON.parse(fs.readFileSync(path.join(m.dir, 'body'), 'utf8'));
  assert.equal(body.script, tpl.version);
  assert.equal(body.selfUpdate.ok, true);
});

test('Linux script: a wrong fingerprint changes nothing and is reported', { skip: !fs.existsSync('/bin/sh') }, () => {
  const tpl = scriptTemplate('linux');
  const m = linuxMachine({ ok: true, device: 1, plugins: '', nics: false, update: `${tpl.version}:${'0'.repeat(64)}` });
  const before = fs.readFileSync(m.dest, 'utf8');
  m.go();
  assert.equal(fs.readFileSync(m.dest, 'utf8'), before);
  assert.deepEqual([m.state().ok, m.state().message], [false, 'fingerprint does not match']);
});

test('Linux script: a full disk (cut-off copy) changes nothing - sh -n alone would let half a script through', { skip: !fs.existsSync('/bin/sh') }, () => {
  const tpl = scriptTemplate('linux');
  // the filling in writes only the first 4 KB, as on a disk that ran full
  const awk = execFileSync('sh', ['-c', 'command -v awk']).toString().trim();
  const m = linuxMachine({ ok: true, device: 1, plugins: '', nics: false, update: `${tpl.version}:${tpl.sha256}` },
    { bins: { awk: `if [ -n "\${U_MARKS:-}" ]; then ${awk} "$@" | head -c 4096; else exec ${awk} "$@"; fi` } });
  m.go();
  assert.equal(fs.readFileSync(m.dest, 'utf8'), m.old);
  assert.deepEqual([m.state().ok, m.state().message], [false, 'the new version was not written completely']);
  assert.ok(!fs.existsSync(`${m.dest}.new`));
  // and should a run be cut off in the middle: the uninstall script takes the half-written copy (it holds the key) too
  assert.ok(uninstallScript('linux').text.includes('"$HOME/.local/bin/$f.new"'));
});

test('Linux script: only the copy cron runs is replaced, and only over HTTPS', { skip: !fs.existsSync('/bin/sh') }, () => {
  const tpl = scriptTemplate('linux');
  const answer = { ok: true, device: 1, plugins: '', nics: false, update: `${tpl.version}:${tpl.sha256}` };
  const m = linuxMachine(answer);
  const other = path.join(m.dir, 'other.sh');
  fs.writeFileSync(other, m.old, { mode: 0o700 });
  m.go(other);
  assert.equal(fs.readFileSync(m.dest, 'utf8'), m.old, 'the set-up copy is not touched by another one');
  assert.match(m.state().message, /^runs as .*other\.sh, not as /);
  const h = linuxMachine(answer, { url: 'http://w.firma.local/api/hosts/push' });
  h.go();
  assert.equal(fs.readFileSync(h.dest, 'utf8'), h.old);
  assert.deepEqual([h.state().ok, h.state().message], [false, 'self-update only over https']);
});

test('Linux script: a cut-off status file is not sent (it would make every report invalid)', { skip: !fs.existsSync('/bin/sh') }, () => {
  const m = linuxMachine({ ok: true, device: 1, plugins: '', nics: false });
  fs.mkdirSync(path.join(m.dir, '.cache', 'whatsonmynet'), { recursive: true });
  fs.writeFileSync(path.join(m.dir, '.cache', 'whatsonmynet', 'update.json'), '{"at":"2026-11-27T00:00:00Z","ok":fal');
  m.go();
  const body = JSON.parse(fs.readFileSync(path.join(m.dir, 'body'), 'utf8'));
  assert.equal(body.selfUpdate, null);
});

// ----------------------------------------------------------------------------------------------- Windows, for real
const pwsh = ['pwsh', process.env.PWSH].filter(Boolean).find((p) => { try { execFileSync(p, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; } });
// a WhatsOnMyNet stand-in that hands out the template
async function winServer() {
  const tpl = scriptTemplate('windows');
  const seen = { auth: '', hits: 0 };
  const srv = http.createServer((q, r) => { seen.auth = q.headers.authorization; seen.hits++; if (q.url === '/api/hosts/script') r.end(tpl.bytes); else { r.statusCode = 404; r.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { tpl, seen, pin: {}, url: `http://127.0.0.1:${srv.address().port}/api/hosts/push`, close: () => srv.close() };
}
async function winRun(server, env = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'suw-'));
  const home = path.join(dir, 'WhatsOnMyNet'); fs.mkdirSync(home);
  const s = hostScript('windows', { url: server.url, token: 'tok-windows-1234567890', pin: server.pin });
  const file = path.join(home, s.file);
  let old = s.text.replace(/^\$ScriptVersion = .*$/m, "$ScriptVersion = '0.58.0'");
  // PowerShell 7 on Linux cannot run the certificate check of the script (a script block) on the thread of a web
  // request ("no Runspace"), Windows PowerShell 5.1 can: to try the update itself, the old copy here has no HTTPS guard
  // and talks plain HTTP (the guard itself: the next test; the certificate check: hosts.test.js)
  if (env.noGuard) { const g = "    if ($Url -notlike 'https://*') { throw 'self-update only over https' }\n"; assert.ok(old.includes(g)); old = old.replace(g, ''); }
  fs.writeFileSync(file, old);
  const answer = JSON.stringify({ ok: true, device: 1, plugins: '', nics: false, update: `${server.tpl.version}:${server.tpl.sha256}` });
  await run(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.resolve('test/fixtures/winmock.ps1'), '-Script', file],
    { env: { ...process.env, ProgramData: dir, WOMN_BODY: path.join(dir, 'body.json'), WOMN_ANSWER: answer, COMPUTERNAME: 'PC-0001' }, timeout: 60000 });
  const st = JSON.parse(fs.readFileSync(path.join(home, 'womn-host-update.json'), 'utf8').replace(/^\uFEFF/, ''));
  return { s, old, now: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), st, left: fs.readdirSync(home).filter((f) => /\.(new|old|download)$/.test(f)) };
}

test('Windows script: replaces itself with the newer version over the same address and key', { skip: !pwsh && 'pwsh missing' }, async () => {
  const server = await winServer(false);
  try {
    const m = await winRun(server, { noGuard: true });
    assert.equal(server.seen.auth, 'Bearer tok-windows-1234567890');
    assert.equal(m.now, m.s.text, 'exactly the script WhatsOnMyNet would hand out to this machine');
    assert.deepEqual([m.st.ok, m.st.version], [true, server.tpl.version], m.st.message);
    assert.deepEqual(m.left, [], 'no download, new or backup file left');
  } finally { server.close(); }
});

test('Windows script: never over plain HTTP (anyone on the way could name a fingerprint of their own)', { skip: !pwsh && 'pwsh missing' }, async () => {
  const server = await winServer(false);
  try {
    const m = await winRun(server);
    assert.equal(server.seen.hits, 0, 'nothing fetched');
    assert.equal(m.now, m.old);
    assert.deepEqual([m.st.ok, m.st.message], [false, 'self-update only over https']);
  } finally { server.close(); }
});

// ------------------------------------------------------------------------------------- overview, unknown machines
test('overview: machines with an older script; those before 0.59 need to be handed out once more', () => {
  const { db, id, hosts, shared } = setup();
  hosts.push(shared.token, report({ script: '0.58.0' }));
  let o = hosts.scripts();
  assert.equal(o.outdated, 1);
  assert.deepEqual([o.stuck[0].deviceId, o.stuck[0].manual], [id, true]);
  hosts.push(shared.token, report({ script: SCRIPT_VERSIONS.windows }));
  assert.equal(hosts.scripts().outdated, 0);
  // why a machine stays behind (version numbers made up: from 0.59 on, older than the current one)
  const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  assert.deepEqual(scriptState({ script: '0.58.0' }, '0.60.0', true), { manual: true, error: null, late: false, action: true });
  assert.deepEqual(scriptState({ script: '0.59.0', updateOffered: { version: '0.60.0', at: ago(0.2) } }, '0.60.0', true), { manual: false, error: null, late: false, action: false }, 'catches up shortly');
  assert.deepEqual(scriptState({ script: '0.59.0', updateOffered: { version: '0.60.0', at: ago(2) } }, '0.60.0', true), { manual: false, error: null, late: true, action: true }, 'an hour later still old');
  assert.deepEqual(scriptState({ script: '0.59.0', selfUpdate: { ok: false, version: '0.60.0', message: 'answer 409' } }, '0.60.0', true).error, 'answer 409');
  assert.equal(scriptState({ script: '0.59.0', selfUpdate: { ok: false, version: '0.59.5', message: 'old try' } }, '0.60.0', true).error, null, 'a failed try for another version does not count');
  assert.equal(scriptState({ script: '0.59.0' }, '0.60.0', false).action, true, 'self-update off');
  assert.equal(scriptState({ script: '0.59.0', updateOffered: { version: '0.60.0', at: ago(5) } }, '0.60.0', true, Date.parse(ago(4.9))).late, false, 'switched off right after the offer: not late');
});

test('the answer keeps the time a version was first offered; the template follows the operating system of the key', () => {
  const { db, id, hosts, shared } = setup();
  hosts.push(shared.token, report());
  const first = JSON.parse(db.prepare('SELECT data FROM host_reports WHERE device_id=?').get(id).data).updateOffered;
  assert.equal(first.version, SCRIPT_VERSIONS.windows);
  db.prepare("UPDATE host_reports SET data=json_set(data,'$.updateOffered.at','2026-01-01T00:00:00.000Z')").run();
  hosts.push(shared.token, report());
  assert.equal(JSON.parse(db.prepare('SELECT data FROM host_reports WHERE device_id=?').get(id).data).updateOffered.at, '2026-01-01T00:00:00.000Z');
  // a Windows key, whatever the machine says it runs: the fingerprint of the Windows template
  assert.equal(hosts.push(shared.token, report({ os: 'Ubuntu 24.04 LTS' })).update.split(':')[1], scriptTemplate('windows').sha256);
});

test('new hardware under the old name: suggested, taken over only by hand', () => {
  const { db, id, hosts, shared } = setup();
  db.prepare("UPDATE devices SET mac='00:15:5d:00:00:01', serial='ALT-123' WHERE id=?").run(id);
  assert.throws(() => hosts.push(shared.token, report({ macs: ['00:15:5d:aa:bb:cc', 'd8:bb:c1:00:00:99'], hw: { vendor: 'Dell Inc.', model: 'OptiPlex 7010', serial: 'NEU-456' } })), { code: 'err.hostUnknown' });
  const u = hosts.unmatched();
  assert.deepEqual(u[0].suggest, { id, name: 'PC-0001' });
  assert.deepEqual([u[0].macs, u[0].serial, u[0].model], [['00:15:5d:aa:bb:cc', 'd8:bb:c1:00:00:99'], 'NEU-456', 'Dell Inc. OptiPlex 7010'], 'shown before the click');
  hosts.assignUnmatched('pc-0001', id, 'testadmin');
  assert.equal(hosts.unmatched().length, 0);
  // the device now carries the reported MAC of the real network card (not the Hyper-V one): another machine with the shared key and the same name no longer reaches it
  assert.deepEqual(db.prepare('SELECT mac, serial FROM devices WHERE id=?').get(id), { mac: 'd8:bb:c1:00:00:99', serial: 'NEU-456' });
  assert.throws(() => hosts.push(shared.token, report({ macs: ['d8:bb:c1:00:00:42'] })), { code: 'err.hostUnknown' });
  assert.equal(hosts.push(shared.token, report({ macs: ['d8:bb:c1:00:00:99'], hw: { vendor: 'Dell Inc.', model: 'OptiPlex 7010', serial: 'NEU-456' } })).device, id);
  const d = db.prepare('SELECT mac, serial FROM devices WHERE id=?').get(id);
  assert.equal(d.serial, 'NEU-456');
  assert.ok(db.prepare("SELECT 1 FROM device_history WHERE device_id=? AND kind='hardwareSwapped'").get(id));
});

test('no suggestion while the device still reports (the old machine runs: a clone or a second one of that name)', () => {
  const { db, id, hosts, shared } = setup();
  db.prepare("UPDATE devices SET mac='00:15:5d:00:00:01' WHERE id=?").run(id);
  hosts.push(shared.token, report({ macs: ['00:15:5d:00:00:01'] }));
  assert.throws(() => hosts.push(shared.token, report({ macs: ['00:15:5d:00:00:77'] })), { code: 'err.hostUnknown' });
  assert.equal(hosts.unmatched()[0].suggest, null);
});
