// Plugins of the host script: written in WhatsOnMyNet, downloaded as a file, run by the machines they are meant for.
// A machine runs a plugin only when WhatsOnMyNet named exactly that file for it in the answer to its last report (id,
// version, SHA-256) - a changed file, an old version or a plugin for other machines does not run. Their values become
// checks and sensors; the device page and the plugin list show where a plugin runs, is missing or outdated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { startApp, tmp } from './helpers.js';
import { hostScript, SCRIPT_VERSIONS } from '../src/hostscripts.js';
import { pluginFile, targetsMatch, cleanTargets, cleanPluginReport } from '../src/plugins.js';
import { cleanReport } from '../src/hosts.js';
import { metricsFor, sensorCheck } from '../src/monitor/sensors.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());

test('the file: header with id and version, Windows with BOM and CRLF, Linux keeps its #! line; fingerprint over the bytes', () => {
  const w = pluginFile({ id: 4, version: 2, os: 'windows', name: 'Größe "D:"', code: 'Write-Output "x: 1"\n' });
  assert.deepEqual([...w.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(w.text, /^# womn-plugin id=4 version=2\r\n/);
  assert.ok(!/[^\r]\n/.test(w.text), 'CRLF only');
  assert.equal(w.file, 'womn-plugin-4-grosse-d.ps1');
  assert.equal(w.sha, crypto.createHash('sha256').update(w.bytes).digest('hex'));
  const l = pluginFile({ id: 5, version: 1, os: 'linux', name: 'x', code: '#!/bin/bash\necho "a: 1"' });
  assert.match(l.text, /^#!\/bin\/bash\n# womn-plugin id=5 version=1\n/);
  assert.notEqual(pluginFile({ id: 5, version: 2, os: 'linux', name: 'x', code: '#!/bin/bash\necho "a: 1"' }).sha, l.sha, 'a new version is a new file');
});

test('targets: all, tags (also added later), locations, devices; nothing chosen is refused', () => {
  assert.equal(targetsMatch({ all: true }, { id: 1 }), true);
  const t = cleanTargets({ tags: 'Dateiserver, SQL', locations: [2, '2', -1], devices: ['9'] });
  assert.deepEqual(t, { tags: ['dateiserver', 'sql'], locations: [2], devices: [9] });
  assert.equal(targetsMatch(t, { id: 1, location_id: 3, tags: 'web,dateiserver' }), true);
  assert.equal(targetsMatch(t, { id: 1, location_id: 2, tags: '' }), true);
  assert.equal(targetsMatch(t, { id: 9, location_id: null, tags: '' }), true);
  assert.equal(targetsMatch(t, { id: 1, location_id: 3, tags: 'web' }), false);
  assert.throws(() => cleanTargets({ tags: [] }), { code: 'err.pluginTargets' });
  assert.deepEqual(cleanPluginReport([{ file: 'a.ps1', id: '3', version: 1, state: 'ok' }, { state: 'evil' }, 'x']), [{ file: 'a.ps1', id: 3, version: 1, state: 'ok', text: '' }]);
});

const ids = {};
test('server: only administrators; a new version only when the file changes; download is exactly the file', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  const at = new Date().toISOString();
  const dev = (name, tags) => db.prepare("INSERT INTO devices(name,type,tags,created_at,updated_at) VALUES(?,'server',?,?,?)").run(name, tags, at, at).lastInsertRowid;
  ids.fs = dev('FS01', 'dateiserver'); ids.web = dev('WEB01', ''); ids.lx = dev('LX01', 'dateiserver');
  const rep = (id, os, plugins) => db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET at=excluded.at, data=excluded.data')
    .run(id, at, JSON.stringify(cleanReport({ hostname: `h${id}`, os, plugins })));
  rep(ids.fs, 'Microsoft Windows Server 2022', []); rep(ids.web, 'Microsoft Windows Server 2019', undefined); rep(ids.lx, 'Debian 13', []);

  assert.equal((await call('POST', '/api/plugins', { name: 'x', os: 'windows', code: 'x' })).status, 201);
  ids.first = (await call('GET', '/api/plugins')).data[0].id;
  const p = (await call('POST', '/api/plugins', { name: 'Backup-Alter', os: 'windows', code: '"Backup-Alter: 26 h"', targets: { tags: ['dateiserver'] }, timeout: 20 })).data;
  ids.p = p.id;
  assert.equal(p.version, 1);
  assert.equal((await call('PUT', `/api/plugins/${p.id}`, { description: 'nur Text', targets: { all: true } })).data.version, 1, 'no new file');
  // how often it runs: only the steps offered, no new file (the machines learn it with the next answer)
  assert.equal(p.interval, 5);
  assert.equal((await call('PUT', `/api/plugins/${p.id}`, { interval: 7 })).status, 400);
  const iv = (await call('PUT', `/api/plugins/${p.id}`, { interval: 60 })).data;
  assert.deepEqual([iv.interval, iv.version], [60, 1]);
  await call('PUT', `/api/plugins/${p.id}`, { interval: 5 });
  const v2 = (await call('PUT', `/api/plugins/${p.id}`, { code: '"Backup-Alter: 27 h"', targets: { tags: ['dateiserver'] } })).data;
  assert.equal(v2.version, 2);
  assert.equal(v2.newVersion, true);
  const dl = await call('GET', `/api/plugins/${p.id}/download`, undefined, { raw: true });
  assert.equal(dl.status, 200);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), v2.sha);
  assert.match(dl.headers.get('content-disposition'), /womn-plugin-\d+-backup-alter\.ps1/);
  for (const [b, code] of [[{ name: 'y', os: 'mac', code: 'x' }, 'err.badRequest'], [{ name: 'y', os: 'linux', code: ' ' }, 'err.pluginCode'],
    [{ name: 'y', os: 'linux', code: 'x'.repeat(70000) }, 'err.pluginTooLarge'], [{ name: 'y', os: 'linux', code: 'x', targets: {} }, 'err.pluginTargets']]) {
    assert.equal((await call('POST', '/api/plugins', b)).data.error.code, code);
  }
  assert.equal((await call('POST', '/api/users', { username: 'max', password: 'Sicher-Passwort-2', role: 'editor' })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'max', password: 'Sicher-Passwort-2' }, { who: 'editor' })).status, 200);
  assert.equal((await call('GET', '/api/plugins', undefined, { who: 'editor' })).status, 403);
  assert.equal((await call('GET', `/api/plugins/${p.id}/download`, undefined, { who: 'editor' })).status, 403);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit WHERE action LIKE 'plugin.%'").get().n >= 4);
});

test('what a machine may run: its system, its targets, switched on - in the answer to its report', async () => {
  const p = ctx.plugins.get(ids.p);
  assert.deepEqual(ctx.plugins.allowedFor(ids.fs, 'windows').map((x) => x.id).sort(), [ids.first, ids.p].sort());
  assert.deepEqual(ctx.plugins.allowedFor(ids.web, 'windows').map((x) => x.id), [ids.first], 'no tag');
  assert.deepEqual(ctx.plugins.allowedFor(ids.lx, 'linux'), [], 'a Windows plugin is not for Linux');
  const s = ctx.plugins.allowString(ctx.plugins.allowedFor(ids.fs, 'windows'));
  assert.match(s, new RegExp(`(^| )${ids.p}:2:${p.sha}:20:5( |$)`));
  // a device key: its report gets the list back
  const tok = await call('POST', '/api/hosts', { device_id: ids.fs, os: 'windows', server: 'https://womn.firma.local' });
  const j = (await call('POST', '/api/hosts/push', { hostname: 'FS01', os: 'Microsoft Windows Server 2022', plugins: [{ file: p.file, id: ids.p, version: 1, state: 'outdated' }] },
    { who: 'script', headers: { Authorization: `Bearer ${tok.data.token}` } })).data;
  assert.equal(j.plugins, s);
  // switched off: no machine runs it any more
  await call('PUT', `/api/plugins/${ids.p}`, { enabled: false });
  assert.deepEqual(ctx.plugins.allowedFor(ids.fs, 'windows').map((x) => x.id), [ids.first]);
  await call('PUT', `/api/plugins/${ids.p}`, { enabled: true });
});

test('device page and list: running, missing, outdated, not for here; a script too old to know plugins', async () => {
  const d = (await call('GET', `/api/devices/${ids.fs}`)).data.host.plugins;
  const st = Object.fromEntries(d.items.map((x) => [x.id, x.state]));
  assert.equal(st[ids.p], 'outdated');
  assert.equal(st[ids.first], 'missing');
  const w = (await call('GET', `/api/devices/${ids.web}`)).data.host.plugins;
  assert.equal(w.scriptKnows, false);
  const list = (await call('GET', '/api/plugins')).data;
  const r = list.find((x) => x.id === ids.p).rollout;
  assert.deepEqual([r.expected, r.ok, r.problems[0].state], [1, 0, 'outdated']);
  const all = list.find((x) => x.id === ids.first).rollout;
  assert.deepEqual([all.expected, all.problems.map((x) => x.state).sort()], [2, ['missing', 'scriptOld']]);
  const ch = (await call('GET', '/api/plugins/choices')).data;
  assert.ok(ch.tags.includes('dateiserver'));
  assert.deepEqual(ch.devices.map((x) => x.os).sort(), ['linux', 'windows', 'windows']);
});

test('values of plugins: checks with unit, sensors with a limit of your own', () => {
  const r = cleanReport({ hostname: 'FS01', checks: [{ name: 'Backup-Alter', status: 0, text: '26 h', value: 26, plugin: 3, unit: 'h', file: 'p.ps1' }, { name: 'Größe', status: 0, value: 1.5, unit: 'GB' }] });
  assert.deepEqual(r.checks.map((c) => [c.name, c.plugin ?? null, c.unit]), [['Backup-Alter', 3, 'h'], ['Größe', null, 'GB']]);
  db.prepare('UPDATE host_reports SET data=? WHERE device_id=?').run(JSON.stringify(r), ids.fs);
  const m = metricsFor(db, ids.fs).filter((x) => x.metric === 'localValue');
  assert.deepEqual(m.map((x) => [x.key, x.value, x.unit]), [['Backup-Alter', 26, 'h'], ['Größe', 1.5, 'GB']]);
  const chk = (threshold) => sensorCheck(db, { device_id: ids.fs, status: 'up', options: JSON.stringify({ metric: 'localValue', key: 'Backup-Alter', op: 'ge', threshold, label: 'Backup-Alter' }) });
  assert.deepEqual([chk('24').ok, chk('30').ok], [false, true]);
  assert.match(chk('24').message, /26 h/);
});

// --- the scripts themselves --------------------------------------------------------------------------------------
const linuxRun = (setup, allow) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'plg-')); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const w = (n, b) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${b}\n`, { mode: 0o755 });
  const uid = process.getuid() === 0 ? 1000 : process.getuid();
  w('id', `echo ${uid}`); w('hostname', 'echo app01'); w('crontab', 'cat >/dev/null');
  w('curl', `cat > "${dir}/body"; printf '{"ok":true,"device":3,"plugins":"7:1:${'b'.repeat(64)}:30:5"}'`);
  const plg = path.join(dir, 'plugins'); fs.mkdirSync(plg, { mode: 0o755 });
  const cache = path.join(dir, '.cache', 'whatsonmynet'); fs.mkdirSync(cache, { recursive: true });
  const made = setup(plg);
  const s = hostScript('linux', { url: 'https://w/api/hosts/push', token: 'tok-1234567890', pin: {} });
  const file = path.join(dir, s.file); fs.writeFileSync(file, s.text);
  // the answer of the stand-in curl replaces the list - a second run writes its own list again first
  let last = allow(made);
  const run = (newAllow) => {
    if (newAllow) last = newAllow;
    fs.writeFileSync(path.join(cache, 'plugins.txt'), last);
    try { fs.rmSync(path.join(dir, 'body')); } catch { /* first run */ }
    const r = spawnSync('sh', [file], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, WOMN_PLUGINS: plg, WOMN_CHECKS: path.join(dir, 'none'), WOMN_HWMON: path.join(dir, 'none'), WOMN_THERMAL: path.join(dir, 'none') }, timeout: 60000 });
    assert.equal(r.status, 0, String(r.stderr));
    if (!fs.existsSync(path.join(dir, 'body'))) return { body: null };
    return { body: JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8')), allowAfter: fs.readFileSync(path.join(cache, 'plugins.txt'), 'utf8') };
  };
  return { ...run(), again: run, dir, plg, cache };
};
const put = (dir, p, mode = 0o644, extra = '') => { const f = pluginFile(p); const file = path.join(dir, f.file); fs.writeFileSync(file, Buffer.concat([f.bytes, Buffer.from(extra)])); fs.chmodSync(file, mode); return f; };

test('Linux script: runs only the file WhatsOnMyNet named; values with unit; the answer is kept for the next run', { skip: !fs.existsSync('/bin/sh') }, () => {
  const { body, allowAfter } = linuxRun((dir) => ({
    ok: put(dir, { id: 1, version: 2, os: 'linux', name: 'Backup', code: 'echo "Backup-Alter: 26 h"\necho "Größe: 1,5 GB"\necho "0 Queue count=3 three waiting"\necho "noise"' }),
    old: put(dir, { id: 2, version: 1, os: 'linux', name: 'Alt', code: 'echo "Alt: 1"' }),
    changed: put(dir, { id: 3, version: 1, os: 'linux', name: 'Veraendert', code: 'echo "Evil: 1"' }, 0o644, 'echo "Evil2: 1"\n'),
    foreign: put(dir, { id: 4, version: 1, os: 'linux', name: 'Fremd', code: 'echo "Fremd: 1"' }),
    unsafe: put(dir, { id: 5, version: 1, os: 'linux', name: 'Offen', code: 'echo "Offen: 1"' }, 0o666),
    slow: put(dir, { id: 6, version: 1, os: 'linux', name: 'Langsam', code: 'sleep 9; echo "Langsam: 1"' }),
    none: fs.writeFileSync(path.join(dir, 'eigenes.sh'), 'echo "X: 1"\n', { mode: 0o644 }),
  }), (f) => `1:2:${f.ok.sha}:20:5 2:2:${'c'.repeat(64)}:20:5 3:1:${pluginFile({ id: 3, version: 1, os: 'linux', name: 'Veraendert', code: 'echo "Evil: 1"' }).sha}:20:5 5:1:${f.unsafe.sha}:20:5 6:1:${f.slow.sha}:1:5`);
  const st = Object.fromEntries(body.plugins.map((x) => [x.file.replace(/^womn-plugin-\d+-|\.sh$/g, ''), x.state]));
  assert.deepEqual(st, { backup: 'ok', alt: 'outdated', veraendert: 'changed', fremd: 'notAssigned', offen: 'unsafe', langsam: 'timeout', eigenes: 'noHeader' });
  assert.deepEqual(body.checks.map((c) => [c.name, c.status, c.value, c.unit, c.plugin]),
    [['Backup-Alter', 0, 26, 'h', 1], ['Größe', 0, 1.5, 'GB', 1], ['Queue', 0, 3, '', 1]]);
  assert.ok(!JSON.stringify(body).includes('Evil'), 'a changed file does not run');
  assert.equal(allowAfter, `7:1:${'b'.repeat(64)}:30:5`, 'the list of the answer is kept');
});

test('Linux script: a plugin with a longer interval runs once and gives its last output in between; one run at a time', { skip: !fs.existsSync('/bin/sh') }, () => {
  let f;
  const allow = (x, every) => `1:1:${x.sha}:20:${every}`;
  const r = linuxRun((dir) => { f = put(dir, { id: 1, version: 1, os: 'linux', name: 'Zaehler', code: 'n=$(cat "$HOME/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$HOME/n"; echo "Laeufe: $n"' }); return f; }, (x) => allow(x, 60));
  assert.deepEqual([r.body.plugins[0].state, r.body.checks[0].value], ['ok', 1]);
  const r2 = r.again();
  assert.deepEqual([r2.body.plugins[0].state, r2.body.checks[0].value], ['ok', 1], 'not run again within the hour - the last output');
  assert.match(r2.body.plugins[0].text, /runs every 60 min - last run 0 min ago/);
  // every 5 minutes (the default): runs every time, nothing kept
  const r3 = r.again(allow(f, 5));
  assert.equal(r3.body.checks[0].value, 2);
  // a changed file is never answered from the cache
  r.again(allow(f, 60));
  fs.appendFileSync(path.join(r.plg, f.file), 'echo "Evil: 1"\n');
  const r4 = r.again();
  assert.equal(r4.body.plugins[0].state, 'changed');
  // a run still going: the next one does nothing; a lock left over (older than 30 minutes) does not stop it
  const lock = path.join(r.cache, 'run.lock'); fs.mkdirSync(lock);
  assert.equal(r.again().body, null);
  const old = new Date(Date.now() - 40 * 60000); fs.utimesSync(lock, old, old);
  assert.ok(r.again().body);
  assert.ok(!fs.existsSync(lock), 'the lock goes with the run');
});

test('Linux script: the version goes with the report - an older one is shown as outdated', () => {
  const r = linuxRun(() => ({}), () => '');
  assert.equal(r.body.script, SCRIPT_VERSIONS.linux);
  assert.match(SCRIPT_VERSIONS.linux, /^\d+\.\d+\.\d+$/);
});

const pwsh = ['pwsh', process.env.PWSH].filter(Boolean).find((p) => { try { execFileSync(p, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; } });
test('Windows script: the same rules; umlauts survive (UTF-8 with BOM)', { skip: !pwsh && 'pwsh missing' }, () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'plgw-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin); fs.symlinkSync(pwsh.includes('/') ? pwsh : execFileSync('sh', ['-c', `command -v ${pwsh}`]).toString().trim(), path.join(bin, 'powershell.exe'));
  const s = hostScript('windows', { url: 'https://womn:8443/api/hosts/push', token: 'tok' });
  const home = path.join(dir, 'WhatsOnMyNet'); fs.mkdirSync(home);
  const file = path.join(home, s.file); fs.writeFileSync(file, s.text);
  const plg = path.join(home, 'plugins'); fs.mkdirSync(plg);
  const ok = put(plg, { id: 1, version: 2, os: 'windows', name: 'Backup', code: 'Write-Output "Backup-Alter: 26 h"\n"Größe: 1,5 GB"\n"2 Lizenz - lic01 down"' });
  put(plg, { id: 2, version: 1, os: 'windows', name: 'Fremd', code: '"Fremd: 1"' });
  const ch = pluginFile({ id: 3, version: 1, os: 'windows', name: 'Geaendert', code: '"Y: 1"' }); fs.writeFileSync(path.join(plg, ch.file), Buffer.concat([ch.bytes, Buffer.from('"Evil: 1"')]));
  const un = put(plg, { id: 4, version: 1, os: 'windows', name: 'unsafe', code: '"Unsafe: 1"' });
  fs.writeFileSync(path.join(home, 'womn-plugins.txt'), `1:2:${ok.sha}:20:5 3:1:${ch.sha}:20:5 4:1:${un.sha}:20:5`);
  const body = path.join(dir, 'body.json');
  execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.resolve('test/fixtures/winmock.ps1'), '-Script', file],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ProgramData: dir, WOMN_BODY: body, COMPUTERNAME: 'SRV-FS01', WOMN_ACL_SAFE: '1' }, timeout: 120000 });
  const b = JSON.parse(fs.readFileSync(body, 'utf8'));
  const st = Object.fromEntries(b.plugins.map((x) => [x.id, x.state]));
  assert.deepEqual(st, { 1: 'ok', 2: 'notAssigned', 3: 'changed', 4: 'unsafe' });
  assert.deepEqual(b.checks.map((c) => [c.name, c.status, c.value, c.unit]), [['Backup-Alter', 0, 26, 'h'], ['Größe', 0, 1.5, 'GB'], ['Lizenz', 2, null, '']]);
  assert.ok(!JSON.stringify(b).includes('Evil') && !JSON.stringify(b).includes('Unsafe:'));
  // every 60 minutes: the next run gives the last output again without running the file
  const cnt = put(plg, { id: 5, version: 1, os: 'windows', name: 'Zaehler', code: '$f = Join-Path $env:ProgramData "n.txt"; $n = 1 + [int](Get-Content $f -ErrorAction SilentlyContinue); Set-Content $f $n; "Laeufe: $n"' });
  fs.writeFileSync(path.join(home, 'womn-plugins.txt'), `5:1:${cnt.sha}:20:60`);
  const again = () => {
    execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.resolve('test/fixtures/winmock.ps1'), '-Script', file],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ProgramData: dir, WOMN_BODY: body, COMPUTERNAME: 'SRV-FS01', WOMN_ACL_SAFE: '1' }, timeout: 120000 });
    const x = JSON.parse(fs.readFileSync(body, 'utf8'));
    return [x.plugins.find((p) => p.id === 5), x.checks.find((c) => c.name === 'Laeufe')?.value];
  };
  assert.deepEqual(again()[1], 1);
  const [p2, v2] = again();
  assert.deepEqual([p2.state, v2], ['ok', 1]);
  assert.match(p2.text, /runs every 60 min/);
});
