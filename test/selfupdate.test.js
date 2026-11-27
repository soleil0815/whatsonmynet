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
import { createHosts } from '../src/hosts.js';
import { hostScript, scriptTemplate, SCRIPT_VERSIONS } from '../src/hostscripts.js';

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
  assert.match(text, new RegExp(`^\\$ScriptVersion = '${SCRIPT_VERSIONS.windows.replace(/\./g, '\\.')}'$`, 'm'));
  const off = setup({ 'hosts.selfUpdate': false });
  assert.throws(() => off.hosts.template(off.shared.token), { code: 'err.selfUpdateOff' });
});

// ------------------------------------------------------------------------------------------------- Linux, for real
function linuxMachine(answer) {
  const dir = fs.mkdtempSync(path.join(tmp, 'su-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const w = (n, b) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${b}\n`, { mode: 0o755 });
  w('id', 'echo 1000'); w('hostname', 'echo app01'); w('crontab', 'cat >/dev/null');
  const tplFile = path.join(dir, 'template.sh');
  fs.writeFileSync(tplFile, scriptTemplate('linux').bytes);
  // stand-in curl: the report gets the answer, the download gets the template (to the file after -o)
  w('curl', `out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; done
case "$*" in *"/api/hosts/script"*) cp "${tplFile}" "$out" ;; *) cat > "${dir}/body"; printf '%s' '${JSON.stringify(answer)}' ;; esac`);
  // the copy cron runs: an older version of the script, with its own address, key and pin
  const s = hostScript('linux', { url: 'https://w.firma.local/api/hosts/push', token: "tok-1234567890'x", pin: { spki: 'AbC+/9=' } });
  const old = s.text.replace(/^SCRIPT_VERSION=.*$/m, 'SCRIPT_VERSION=0.58.0');
  const dest = path.join(dir, '.local', 'bin', s.file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, old, { mode: 0o700 });
  const go = () => spawnSync('sh', [dest, '--run'], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, WOMN_CHECKS: path.join(dir, 'none'), WOMN_PLUGINS: path.join(dir, 'none'), WOMN_HWMON: path.join(dir, 'none'), WOMN_THERMAL: path.join(dir, 'none') }, timeout: 60000 });
  return { dir, dest, s, go, state: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.cache', 'whatsonmynet', 'update.json'), 'utf8')); } catch { return null; } } };
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

// ----------------------------------------------------------------------------------------------- Windows, for real
const pwsh = ['pwsh', process.env.PWSH].filter(Boolean).find((p) => { try { execFileSync(p, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; } });
test('Windows script: replaces itself with the newer version over the same address and key', { skip: !pwsh && 'pwsh missing' }, async () => {
  const tpl = scriptTemplate('windows');
  let auth = '';
  const srv = http.createServer((q, r) => { auth = q.headers.authorization; if (q.url === '/api/hosts/script') r.end(tpl.bytes); else { r.statusCode = 404; r.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const dir = fs.mkdtempSync(path.join(tmp, 'suw-'));
    const home = path.join(dir, 'WhatsOnMyNet'); fs.mkdirSync(home);
    const url = `http://127.0.0.1:${srv.address().port}/api/hosts/push`;
    const s = hostScript('windows', { url, token: 'tok-windows-1234567890' });
    const file = path.join(home, s.file);
    fs.writeFileSync(file, s.text.replace(/^\$ScriptVersion = .*$/m, "$ScriptVersion = '0.58.0'"));
    const answer = JSON.stringify({ ok: true, device: 1, plugins: '', nics: false, update: `${tpl.version}:${tpl.sha256}` });
    await run(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.resolve('test/fixtures/winmock.ps1'), '-Script', file],
      { env: { ...process.env, ProgramData: dir, WOMN_BODY: path.join(dir, 'body.json'), WOMN_ANSWER: answer, COMPUTERNAME: 'PC-0001' }, timeout: 60000 });
    assert.equal(auth, 'Bearer tok-windows-1234567890');
    const now = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    assert.equal(now, s.text, 'exactly the script WhatsOnMyNet would hand out to this machine');
    const st = JSON.parse(fs.readFileSync(path.join(home, 'womn-host-update.json'), 'utf8').replace(/^﻿/, ''));
    assert.deepEqual([st.ok, st.version], [true, tpl.version]);
  } finally { srv.close(); }
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
  db.prepare("UPDATE host_reports SET data=json_set(data,'$.script','0.59.0','$.selfUpdate',json('{\"ok\":false,\"message\":\"answer 409\"}'))").run();
  o = hosts.scripts();
  assert.equal(o.outdated, SCRIPT_VERSIONS.windows === '0.59.0' ? 0 : 1);
});

test('new hardware under the old name: suggested, taken over only by hand', () => {
  const { db, id, hosts, shared } = setup();
  db.prepare("UPDATE devices SET mac='00:15:5d:00:00:01', serial='ALT-123' WHERE id=?").run(id);
  assert.throws(() => hosts.push(shared.token, report({ macs: ['00:15:5d:00:00:99'], hw: { vendor: 'Dell Inc.', model: 'OptiPlex 7010', serial: 'NEU-456' } })), { code: 'err.hostUnknown' });
  const u = hosts.unmatched();
  assert.deepEqual(u[0].suggest, { id, name: 'PC-0001' });
  hosts.assignUnmatched('pc-0001', id, 'testadmin');
  assert.equal(hosts.unmatched().length, 0);
  assert.equal(hosts.push(shared.token, report({ macs: ['00:15:5d:00:00:99'], hw: { vendor: 'Dell Inc.', model: 'OptiPlex 7010', serial: 'NEU-456' } })).device, id);
  const d = db.prepare('SELECT mac, serial FROM devices WHERE id=?').get(id);
  assert.equal(d.serial, 'NEU-456');
  assert.ok(db.prepare("SELECT 1 FROM device_history WHERE device_id=? AND kind='hardwareSwapped'").get(id));
});
