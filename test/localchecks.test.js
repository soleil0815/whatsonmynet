// Own checks ("local checks"): the Linux script really runs the scripts of its checks folder - only those nobody
// else may change - and reports them; the server cleans them and turns them into sensors. The Windows script carries
// the same rules (owner, write rights, time limit) - checked as text here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { hostScript } from '../src/hostscripts.js';
import { cleanChecks } from '../src/hostfacts.js';
import { cleanReport } from '../src/hosts.js';
import { metricsFor, sensorCheck } from '../src/monitor/sensors.js';
import { hostPicks, DEVICE_PICKS } from '../src/monitor/autowatch.js';
import { checkText } from '../public/js/checktext.js';

function runLinux(setup) {
  const dir = fs.mkdtempSync(path.join(tmp, 'lc-')); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const w = (n, b) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${b}\n`, { mode: 0o755 });
  // never "root" in the test (the setup would write to /etc/cron.d) - but the real owner of the files otherwise
  const uid = process.getuid() === 0 ? 1000 : process.getuid();
  w('id', `echo ${uid}`); w('hostname', 'echo app01'); w('crontab', 'cat >/dev/null'); w('curl', `cat > "${dir}/body"`);
  const checks = path.join(dir, 'checks');
  fs.mkdirSync(checks, { mode: 0o755 });
  setup(checks);
  const s = hostScript('linux', { url: 'https://w/api/hosts/push', token: 'tok-1234567890', pin: {} });
  const file = path.join(dir, s.file); fs.writeFileSync(file, s.text);
  const r = spawnSync('sh', [file], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, WOMN_CHECKS: checks, WOMN_CHECK_TIMEOUT: '2', WOMN_HWMON: path.join(dir, 'none'), WOMN_THERMAL: path.join(dir, 'none') }, timeout: 40000 });
  assert.equal(r.status, 0, String(r.stderr));
  return JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8'));
}
const script = (dir, name, body, mode = 0o755) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, mode); };

test('Linux script: runs the checks, only safe ones, each with a time limit', { skip: !fs.existsSync('/bin/sh') }, () => {
  const body = runLinux((dir) => {
    script(dir, '10-backup.sh', 'echo "0 Backup_NAS count=12;20;30 last backup 2 h ago"\necho "2 Lizenzserver - \\"lic01\\" not reachable"\necho "this line is no check"');
    script(dir, '20-stdin.sh', 'cat; echo "1 Queue - reads no stdin"');
    script(dir, '30-slow.sh', 'sleep 5; echo "0 Slow - never seen"');
    script(dir, '40-noformat.sh', 'echo hello; exit 3');
    script(dir, '50-writable.sh', 'echo "0 Evil - must not run"', 0o777);
    script(dir, '60-notexec.sh', 'echo "0 NotExec - must not run"', 0o644);
  });
  const c = body.checks;
  assert.deepEqual(c.map((x) => [x.name, x.status]), [['Backup_NAS', 0], ['Lizenzserver', 2], ['Queue', 1], ['30-slow.sh', 3], ['40-noformat.sh', 3]]);
  assert.deepEqual([c[0].value, c[0].text, c[0].file], [12, 'last backup 2 h ago', '10-backup.sh']);
  assert.equal(c[1].text, '"lic01" not reachable');
  assert.equal(c[3].text, 'timeout (2 s)');
  assert.equal(c[4].text, 'no line in the check format (exit code 3)');
  assert.equal(JSON.stringify(c).includes('Evil'), false, 'a file others may change does not run');
  assert.equal(JSON.stringify(c).includes('NotExec'), false);
});

test('Linux script: a checks folder others may change is not used at all', { skip: !fs.existsSync('/bin/sh') }, () => {
  const body = runLinux((dir) => {
    script(dir, 'ok.sh', 'echo "0 Fine - ok"');
    fs.chmodSync(dir, 0o777);
  });
  assert.deepEqual(body.checks.map((x) => [x.name, x.status]), [['_checks', 3]]);
  assert.match(body.checks[0].text, /may be changed by others - checks not run$/);
});

test('server: cleaned, unique names, sensors with OK / WARN / CRIT / UNKNOWN', () => {
  assert.deepEqual(cleanChecks([{ name: 'a b', status: 0 }, { name: 'A_B', status: 1 }, { name: 'x', status: 7 }, { name: 'y', status: '2', value: 'NaN' }, 'junk']),
    [{ name: 'a_b', status: 0, text: '', value: null, file: '' }, { name: 'y', status: 2, text: '', value: null, file: '' }]);
  const r = cleanReport({ hostname: 'app01', checks: [{ name: 'Backup_NAS', status: 0, text: 'ok', value: 12 }, { name: 'Lizenzserver', status: 2, text: 'not reachable' }, { name: 'Queue', status: 1, text: '120 waiting' }] });
  const db = memoryDb();
  const id = db.prepare("INSERT INTO devices(name, ip, type, created_at, updated_at) VALUES('app01','10.0.0.9','server',?,?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
  db.prepare('INSERT INTO host_reports(device_id, at, data) VALUES(?,?,?)').run(id, new Date().toISOString(), JSON.stringify(r));
  const offered = metricsFor(db, id).filter((x) => x.metric === 'localCheck');
  assert.deepEqual(offered.map((x) => [x.key, x.value]), [['Backup_NAS', 'ok'], ['Lizenzserver', 'crit'], ['Queue', 'warn']]);
  const chk = (key) => sensorCheck(db, { device_id: id, options: JSON.stringify({ metric: 'localCheck', key, op: 'eq', threshold: '', label: key }) });
  assert.deepEqual([chk('Backup_NAS').ok, chk('Backup_NAS').ms, chk('Backup_NAS').message], [true, 12, 'Backup_NAS: OK - ok']);
  assert.deepEqual([chk('Lizenzserver').ok, chk('Lizenzserver').message], [false, 'Lizenzserver: CRIT - not reachable']);
  assert.equal(chk('Queue').ok, false, 'WARN alarms too');
  const gone = chk('Weg');
  assert.deepEqual([gone.ok, gone.message], [false, 'Weg: not found - the check script no longer reports it']);
  assert.equal(checkText(gone.message), 'Weg: nicht gefunden - das Prüfskript meldet sie nicht mehr');
  assert.equal(checkText('Lizenzserver: CRIT - not reachable'), 'Lizenzserver: KRITISCH - not reachable');
  assert.ok(DEVICE_PICKS.host.some(([m]) => m === 'localCheck'), 'new machines watch their checks from the start');
  assert.ok(hostPicks);
});

test('Windows script: same rules - folder of SYSTEM/administrators only, owner checked, time limit, format', () => {
  const s = hostScript('windows', { url: 'https://w/api/hosts/push', token: 'tok-1234567890', pin: {} }).text;
  assert.match(s, /checks = \$checks/);
  assert.match(s, /S-1-5-18/);
  assert.match(s, /S-1-5-32-544/);
  assert.match(s, /WaitForExit\(30000\)/);
  assert.match(s, /ReparsePoint/);
  assert.match(s, /\^\(\[0-3\]\)\\s\+\(\\S\+\)\\s\+\(\\S\+\)/);
});
