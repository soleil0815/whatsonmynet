// Windows/Linux machines with the host script: keys per device or shared, matching to the inventory, sensors,
// the Linux script really run (stand-ins for df, systemctl, curl …) incl. setup and uninstall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp, startApp } from './helpers.js';
import { createHosts, cleanReport } from '../src/hosts.js';
import { hostScript, uninstallScript } from '../src/hostscripts.js';
import { metricsFor, sensorCheck } from '../src/monitor/sensors.js';
import { cleanPdisks, cleanHw } from '../src/hostfacts.js';
import { createInventory } from '../src/inventory.js';

const GiB = 1024 ** 3;
const ts = new Date().toISOString();
const report = (over = {}) => ({ hostname: 'SRV-DC01', os: 'Microsoft Windows Server 2022 Standard 10.0.20348', cpu: 12, memTotal: 16 * GiB, memUsed: 6 * GiB, uptime: 3600,
  disks: [{ name: 'C:', label: 'System', used: 90 * GiB, total: 100 * GiB }, { name: 'D:', used: 1, total: 4 }],
  services: [{ name: 'NTDS', display: 'Active Directory Domain Services', state: 'running' }, { name: 'DNS', display: 'DNS Server', state: 'stopped', failed: true },
    { name: 'gupdate', display: 'Google Update', state: 'stopped', failed: false }],
  macs: ['00-15-5D-01-02-03'], ips: ['10.0.0.10'], ...over });

test('device key: report stored for that device, OS filled in, sensors on CPU, disk, services', () => {
  const db = memoryDb();
  const hosts = createHosts({ db });
  const dev = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('dc01','server','10.0.0.10',?,?)").run(ts, ts).lastInsertRowid;
  assert.throws(() => hosts.create({ os: 'windows', device_id: dev }, { server: 'javascript:x' }), { code: 'err.badRequest' });
  const t = hosts.create({ os: 'windows', device_id: dev }, { server: 'https://womn.firma.local:8443', pin: { sha1: 'AB:CD' } });
  assert.equal(t.name, 'dc01');
  assert.equal(t.script.file, 'womn-host.ps1');
  assert.ok(t.script.text.includes(`$Token = '${t.token}'`) && t.script.text.includes("$Url = 'https://womn.firma.local:8443/api/hosts/push'"));
  assert.ok(t.script.text.includes("$Task = 'WhatsOnMyNet-Host'") && !t.script.text.includes('@SETUP@'), 'sets itself up');
  assert.equal(t.uninstall.file, 'womn-host-uninstall.ps1');
  assert.ok(!JSON.stringify(hosts.list()).includes(t.token), 'only the hash is stored');

  assert.throws(() => hosts.push('x'.repeat(43), report()), { code: 'err.unauthorized' });
  // The device key wins over name/MAC: even another host name lands on this device
  assert.deepEqual(hosts.push(t.token, report({ hostname: 'renamed' })), { ok: true, device: dev });
  const r = hosts.report(dev);
  assert.deepEqual([r.cpu, r.mem, r.stale, r.disks[0].pct, r.macs[0]], [12, 38, false, 90, '00:15:5d:01:02:03']);
  assert.equal(db.prepare('SELECT os FROM devices WHERE id=?').get(dev).os, 'Microsoft Windows Server 2022 Standard 10.0.20348');

  const m = metricsFor(db, dev);
  assert.deepEqual([...new Set(m.map((x) => x.metric))], ['hostOnline', 'hostCpu', 'hostMem', 'hostDisk', 'servicesFailed', 'service']);
  const check = (metric, key = '', op = 'ge', threshold = '85') => sensorCheck(db, { device_id: dev, options: JSON.stringify({ metric, key, op, threshold, label: metric }) });
  assert.deepEqual([check('hostDisk', 'C:').ok, check('hostDisk', 'C:').data.v], [false, 90]);
  assert.equal(check('hostCpu').ok, true);
  assert.equal(check('service', 'NTDS').ok, true);
  assert.equal(check('service', 'DNS').ok, false);
  assert.equal(check('servicesFailed', '', 'gt', '0').message, 'servicesFailed: DNS Server', 'a stopped trigger service is no failure');
  assert.equal(check('hostOnline').data.state, 'online');
  // 20 minutes without a report: offline
  db.prepare('UPDATE host_reports SET at=? WHERE device_id=?').run(new Date(Date.now() - 20 * 60000).toISOString(), dev);
  assert.deepEqual([check('hostOnline').ok, check('hostOnline').message], [false, 'no report for 20 min']);
  assert.equal(hosts.report(dev).stale, true);
  // A new script for the same device replaces the key
  const t2 = hosts.create({ os: 'linux', device_id: dev }, { server: 'https://w' });
  assert.throws(() => hosts.push(t.token, report()), { code: 'err.unauthorized' });
  assert.equal(hosts.list().length, 1);
  assert.equal(t2.script.file, 'womn-host.sh');
});

test('shared key: matched by MAC, host name or IP; unknown machines are listed, not created', () => {
  const db = memoryDb();
  const hosts = createHosts({ db });
  const add = (name, ip, mac = null, hostname = '') => db.prepare('INSERT INTO devices(name,type,ip,mac,hostname,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(name, 'server', ip, mac, hostname, ts, ts).lastInsertRowid;
  const byMac = add('a', '10.0.0.1', '00:15:5d:01:02:03');
  const byName = add('Fileserver', '10.0.0.2', null, 'fs01.firma.local');
  const byIp = add('c', '10.0.0.3');
  const t = hosts.create({ name: 'Alle Server', os: 'windows' }, { server: 'https://w' });
  assert.equal(hosts.push(t.token, report()).device, byMac);
  assert.equal(hosts.push(t.token, report({ hostname: 'FS01', macs: [] })).device, byName);
  assert.equal(hosts.push(t.token, report({ hostname: 'x', macs: [], ips: ['10.0.0.3'] })).device, byIp);
  assert.throws(() => hosts.push(t.token, report({ hostname: 'NEU-PC', macs: [], ips: ['10.9.9.9'] })), { code: 'err.hostUnknown' });
  assert.deepEqual(hosts.unmatched().map((u) => [u.hostname, u.ip]), [['NEU-PC', '10.9.9.9']]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM devices').get().n, 3, 'nothing created');
  assert.equal(hosts.list()[0].reports, 4);
});

test('reports are checked like a form', () => {
  const r = cleanReport({ hostname: 'h'.repeat(300), cpu: 900, memTotalKb: 1024, memAvailKb: 256, disks: [{ name: '/', usedKb: 5, totalKb: 10 }, { name: '/x', totalKb: 0 }],
    services: [{ name: 'evil', state: 'rm -rf' }, { name: 'nginx', state: 'failed' }], macs: ['zz', 'AA:BB:CC:DD:EE:FF'], ips: ['1.2.3.4', 'x; drop'] });
  assert.equal(r.hostname.length, 80);
  assert.deepEqual([r.cpu, r.memTotal, r.memUsed, r.mem], [100, 1048576, 786432, 75]);
  assert.deepEqual(r.disks.map((d) => [d.name, d.used, d.total]), [['/', 5120, 10240]]);
  assert.deepEqual(r.services.map((s) => [s.name, s.state, s.failed]), [['evil', 'stopped', false], ['nginx', 'failed', true]]);
  assert.deepEqual([r.macs, r.ips], [['aa:bb:cc:dd:ee:ff'], ['1.2.3.4']]);
  assert.throws(() => cleanReport({}), { code: 'err.badRequest' });
});

test('push route over HTTP: no session, only with a key', async () => {
  const app = await startApp();
  try {
    const dev = app.db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('pc','computer','10.0.0.5',?,?)").run(ts, ts).lastInsertRowid;
    const { token } = app.ctx.hosts.create({ os: 'linux', device_id: dev }, { server: app.url });
    const send = (tok) => fetch(`${app.url}/api/hosts/push`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'X-WOMN-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(report()) });
    assert.equal((await send('y'.repeat(43))).status, 401);
    assert.equal((await send(token)).status, 200);
    assert.equal(app.ctx.hosts.report(dev).hostname, 'SRV-DC01');
  } finally { await app.close(); }
});

test('Linux script: POSIX sh, sets itself up in cron, reports what the server accepts, uninstall removes it', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'lnx-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const w = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  w('id', 'echo 1000');
  w('hostname', 'echo web01');
  w('crontab', `if [ "$1" = -l ]; then cat "${dir}/crontab" 2>/dev/null; else cat > "${dir}/crontab"; fi`);
  w('curl', `printf '%s\\n' "$*" > "${dir}/args"; cat > "${dir}/body"`);
  w('df', `printf 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 ext4 102400 51200 51200 50%% /\\ntmpfs tmpfs 1000 0 1000 0%% /run\\n/dev/sdb1 xfs 2048000 2000000 48000 98%% /var/lib/data\\n'`);
  w('systemctl', `printf 'nginx.service loaded active running A high performance web server\\ncron.service loaded active running Regular background program processing daemon\\npostgresql.service loaded failed failed PostgreSQL "database" server\\nfoo.service not-found inactive dead foo.service\\n'`);
  w('ip', `printf '2: eth0    inet 10.0.0.20/24 brd 10.0.0.255 scope global eth0\\n'`);
  w('apt-get', `printf 'Inst openssl [3.0.2] (3.0.13 Ubuntu:22.04/jammy-security [amd64])\\nInst vim [2:8.2] (2:8.2.3995 Ubuntu:22.04/jammy-updates [amd64])\\nConf openssl\\n'`);
  const s = hostScript('linux', { url: 'https://womn:8443/api/hosts/push', token: 'tok-123', pin: { spki: 'PIN=' } });
  const file = path.join(dir, s.file);
  fs.writeFileSync(file, s.text);
  execFileSync('sh', ['-n', file]);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir };
  execFileSync('sh', [file], { env, timeout: 15000 });
  const dest = path.join(dir, '.local/bin/womn-host.sh');
  assert.equal(fs.readFileSync(path.join(dir, 'crontab'), 'utf8'), `*/5 * * * * ${dest} --run >/dev/null 2>&1\n`);
  assert.equal(fs.statSync(dest).mode & 0o777, 0o700, 'key readable only for its owner');
  assert.match(fs.readFileSync(path.join(dir, 'args'), 'utf8'), /-k --pinnedpubkey sha256\/\/PIN= -H Authorization: Bearer tok-123/);
  const r = cleanReport(JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8')));
  assert.equal(r.hostname, 'web01');
  assert.ok(r.memTotal > 0 && r.cpu >= 0 && r.uptime > 0);
  assert.deepEqual(r.disks.map((d) => [d.name, d.pct]), [['/', 50], ['/var/lib/data', 98]], 'no tmpfs');
  assert.deepEqual(r.services.map((x) => [x.name, x.state, x.failed]), [['cron', 'running', false], ['nginx', 'running', false], ['postgresql', 'failed', true]]);
  assert.equal(r.services.find((x) => x.name === 'postgresql').display, 'PostgreSQL "database" server');
  assert.deepEqual(r.ips, ['10.0.0.20']);
  assert.equal(r.ups, null, 'no UPS software - no UPS values');
  assert.equal(r.updates.pending, null, 'the setup does not search for updates');
  // cron calls the copy with --run: it only reports, the crontab stays as it is
  execFileSync('sh', [dest, '--run'], { env, timeout: 15000 });
  assert.equal(fs.readFileSync(path.join(dir, 'crontab'), 'utf8').split('\n').filter(Boolean).length, 1);
  // A local NUT: its values come along
  w('upsc', `if [ "$1" = -l ]; then echo eaton; else printf 'battery.charge: 87\\nbattery.runtime: 1260\\ndevice.mfr: EATON\\nups.load: 23\\nups.model: Ellipse PRO "650"\\nups.status: OB DISCHRG\\n'; fi`);
  execFileSync('sh', [dest, '--run'], { env, timeout: 15000 });
  assert.deepEqual(cleanReport(JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8'))).ups,
    { source: 'script', vendor: 'EATON', model: 'Ellipse PRO "650"', serial: '', firmware: '', status: 'battery', low: false, replace: false, charge: 87, runtime: 1260, load: 23 });
  // apcupsd instead
  fs.rmSync(path.join(bin, 'upsc'));
  w('apcaccess', `printf 'APC      : 001,036,0866\\nSTATUS   : ONLINE\\nMODEL    : Back-UPS XS 700U\\nLOADPCT  : 12.0 Percent\\nBCHARGE  : 100.0 Percent\\nTIMELEFT : 45.5 Minutes\\n'`);
  execFileSync('sh', [dest, '--run'], { env, timeout: 15000 });
  const a = cleanReport(JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8'))).ups;
  assert.deepEqual([a.status, a.charge, a.runtime, a.load, a.model, a.vendor], ['online', 100, 2730, 12, 'Back-UPS XS 700U', 'APC']);
  // Disks, journal, updates, firewall (as a normal user: no smartctl, no dmidecode)
  w('lsblk', `case "$*" in *NAME,TYPE*) printf 'sda disk\\nnvme0n1 disk\\nloop0 loop\\nzram0 disk\\n' ;;
    */dev/sda) printf 'MODEL="ST4000NM0035-1V4107" SERIAL="ZC1ABCDE" SIZE="4000787030016" ROTA="1" TRAN="sata"\\n' ;;
    */dev/nvme0n1) printf 'MODEL="Samsung SSD 980 PRO 1TB" SERIAL="S5GXNF0R123" SIZE="1000204886016" ROTA="0" TRAN="nvme"\\n' ;; esac`);
  w('journalctl', `case "$*" in *"-o json"*) printf '%s\\n' '{"PRIORITY":"2","SYSLOG_IDENTIFIER":"kernel","MESSAGE":"EXT4-fs error (device sdb1): bad block","__REALTIME_TIMESTAMP":"1763038800000000"}' '{"PRIORITY":"3","SYSLOG_IDENTIFIER":"sshd","MESSAGE":[1,2]}' ;;
    *"0..2"*) echo one ;; *"3..3"*) printf 'a\\nb\\nc\\n' ;; esac`);
  w('firewall-cmd', 'echo running');
  execFileSync('sh', [dest, '--run'], { env, timeout: 15000 });
  let x = cleanReport(JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8')));
  assert.deepEqual(x.pdisks.map((d) => [d.name, d.model, d.serial, d.media, d.size, d.health]), [
    ['sda', 'ST4000NM0035-1V4107', 'ZC1ABCDE', 'HDD', 4000787030016, 'unknown'], ['nvme0n1', 'Samsung SSD 980 PRO 1TB', 'S5GXNF0R123', 'NVMe', 1000204886016, 'unknown']]);
  assert.deepEqual([x.events.critical, x.events.errors, x.events.items.length, x.events.items[0].source, x.events.items[0].level, x.events.items[0].at], [1, 3, 2, 'kernel', 'critical', '2025-11-13T13:00:00.000Z']);
  assert.equal(x.events.items[1].message, '', 'binary journal message left out');
  assert.deepEqual(x.firewall, { name: 'firewalld', state: 'on', profiles: null });
  assert.ok(x.hw && x.hw.threads > 0 && x.hw.cores > 0, 'CPU from /proc/cpuinfo');
  // The search ran after the first report of cron; later reports have it
  assert.deepEqual([x.updates.pending, x.updates.security, x.updates.reboot], [2, 1, false]);
  assert.ok(fs.existsSync(path.join(dir, '.cache/whatsonmynet/updates.json')));
  const un = path.join(dir, s.uninstall.file);
  fs.writeFileSync(un, s.uninstall.text);
  execFileSync('sh', ['-n', un]);
  execFileSync('sh', [un], { env });
  assert.ok(!fs.existsSync(dest));
  assert.equal(fs.readFileSync(path.join(dir, 'crontab'), 'utf8'), '');
  assert.ok(!fs.existsSync(path.join(dir, '.cache/whatsonmynet')), 'update status removed too');
});

// The Windows script under PowerShell with a pretended Windows server (test/fixtures/winmock.ps1); GitHub's runners
// have pwsh - where it is missing the test is skipped
const pwsh = ['pwsh', process.env.PWSH].filter(Boolean).find((p) => { try { execFileSync(p, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; } });
test('Windows script: reports hardware, disks, updates, protection, events and certificates', { skip: !pwsh && 'pwsh missing' }, () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'win-'));
  // Without certificate pinning: its Add-Type needs Windows PowerShell 5.1 (the scheduled task uses powershell.exe);
  // PowerShell 7.5 refuses the old ServicePointManager at compile time
  const s = hostScript('windows', { url: 'https://womn:8443/api/hosts/push', token: 'tok' });
  const home = path.join(dir, 'WhatsOnMyNet');
  fs.mkdirSync(home);
  const file = path.join(home, s.file);
  fs.writeFileSync(file, s.text);
  const body = path.join(dir, 'body.json');
  const run = () => {
    execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.resolve('test/fixtures/winmock.ps1'), '-Script', file], { env: { ...process.env, ProgramData: dir, WOMN_BODY: body, COMPUTERNAME: 'SRV-DC01' }, timeout: 60000 });
    return cleanReport(JSON.parse(fs.readFileSync(body, 'utf8')));
  };
  let r = run();
  assert.equal(r.hostname, 'SRV-DC01');
  assert.deepEqual([r.hw.vendor, r.hw.model, r.hw.serial, r.hw.bios, r.hw.biosDate, r.hw.sockets, r.hw.cores, r.hw.threads, r.hw.virtual, r.hw.ramTotal],
    ['Dell Inc.', 'PowerEdge R650', '7XK2Q93', '1.13.2', '2024-03-05', 2, 20, 40, false, 34359738368]);
  assert.deepEqual(r.hw.nics.map((n) => [n.name, n.mac, n.speed, n.up]), [['Ethernet 1', '00:15:5d:01:02:03', 1000, true], ['Ethernet 2', '00:15:5d:01:02:04', null, false]]);
  assert.deepEqual(r.pdisks.map((d) => [d.model, d.serial, d.media, d.health, d.temp, d.wear, d.hours]),
    [['SAMSUNG MZ7LH480', 'S45PNA0M123456', 'SSD', 'ok', 34, 7, 21000], ['ST4000NM0035', 'ZC1ABCDE', 'HDD', 'warning', null, null, null]]);
  assert.deepEqual(r.updates, { pending: null, security: null, checkedAt: null, lastInstalled: null, reboot: true });
  assert.deepEqual(r.antivirus, { name: 'Microsoft Defender', enabled: true, realtime: true, upToDate: true, sigAge: 1, state: 'ok' });
  assert.deepEqual(r.firewall, { name: 'Windows', state: 'partial', profiles: { domain: true, private: true, public: false } });
  assert.deepEqual([r.events.critical, r.events.errors, r.events.items[0].source, r.events.items[0].id, r.events.items[0].message],
    [1, 1, 'Microsoft-Windows-Kernel-Power', 41, 'The system has rebooted without cleanly shutting down first.']);
  assert.deepEqual(r.certs.map((c) => [c.subject, c.thumb]), [['CN=rdg.firma.de', 'A1B2C3']], 'long expired ones are left out');
  // The update search ran after the report (not during setup): the next report has its result
  assert.ok(fs.existsSync(path.join(home, 'womn-updates.json')));
  r = run();
  assert.deepEqual([r.updates.pending, r.updates.security, r.updates.lastInstalled], [3, 2, '2026-11-01T03:00:00.000Z']);
  assert.ok(uninstallScript('windows').text.includes("@('womn-host.ps1', 'womn-updates.json')"), 'uninstall removes the update status too');
});

test('Windows scripts: set up / remove the scheduled task, also the one of version 0.6.0 (Hyper-V)', () => {
  const h = hostScript('hyperv', { url: 'https://w/api/proxmox/1/push', token: 't' });
  assert.ok(h.text.includes("$Task = 'WhatsOnMyNet-HyperV'") && h.text.includes("foreach ($old in @('WhatsOnMyNet'))"));
  const u = uninstallScript('hyperv').text;
  assert.ok(u.includes("foreach ($task in @('WhatsOnMyNet-HyperV', 'WhatsOnMyNet'))") && u.includes("@('womn-hyperv.ps1')"));
  assert.ok(uninstallScript('libvirt').text.includes("for c in 'whatsonmynet-kvm' 'whatsonmynet'; do"));
  assert.ok(!/@[A-Z]+@/.test(hostScript('windows', { url: 'u', token: 't' }).text), 'no placeholder left');
  assert.throws(() => hostScript('beos', {}), /unknown/);
});

test('disk health from smartctl, sensors on disks, updates, protection, events and certificates', () => {
  const pd = cleanPdisks([
    { name: 'sda', model: '', serial: '', size: 1, rota: 0, tran: 'sata', smart: { model_name: 'Samsung SSD 870 EVO 1TB', serial_number: 'S6P', smart_status: { passed: true },
      temperature: { current: 38 }, power_on_time: { hours: 9000 }, ata_smart_attributes: { table: [{ id: 5, value: 100, raw: { value: 8 } }, { id: 177, value: 92, raw: { value: 81 } }] } } },
    { name: 'nvme0n1', size: 2, rota: 0, tran: 'nvme', smart: { model_name: 'WD Red SN700', serial_number: 'W1', smart_status: { passed: false },
      temperature: { current: 0 }, nvme_smart_health_information_log: { percentage_used: 104, media_errors: 3 } } },
  ]);
  assert.deepEqual(pd.map((d) => [d.model, d.serial, d.media, d.health, d.temp, d.wear, d.hours, d.realloc, d.readErrors]), [
    ['Samsung SSD 870 EVO 1TB', 'S6P', 'SSD', 'warning', 38, 8, 9000, 8, null], ['WD Red SN700', 'W1', 'NVMe', 'failed', null, 100, null, null, 3]]);
  assert.equal(cleanHw({ biosDate: '03/05/2024', model: 'X' }).biosDate, '2024-03-05');

  const db = memoryDb();
  const inv = createInventory(db);
  const d = inv.create({ name: 'srv', ip: '10.0.0.9', type: 'server' });
  const soon = new Date(Date.now() + 10.5 * 86400000).toISOString();
  const data = cleanReport({ hostname: 'srv', pdisks: [{ name: 'S1', serial: 'ZC1', health: 'Warning', temp: 61, wear: 3 }],
    updates: { pending: 4, security: 1, reboot: true }, av: { name: 'Microsoft Defender', enabled: true, realtime: true, upToDate: false, sigAge: 9 },
    firewall: { domain: true, private: true, public: true }, events: { hours: 24, critical: 2, errors: 5, items: [{ level: 'critical', source: 'Kernel-Power', id: 41, message: 'rebooted' }] },
    certs: [{ subject: 'CN=web.firma.de', notAfter: soon, thumb: 'ab12' }] });
  db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?)').run(d.id, new Date().toISOString(), JSON.stringify(data));
  const m = metricsFor(db, d.id);
  const val = (metric) => m.find((x) => x.metric === metric)?.value;
  assert.deepEqual(['hostPdHealth', 'hostPdTemp', 'hostUpdates', 'hostUpdatesSec', 'hostReboot', 'hostAv', 'hostFirewall', 'hostEvCritical', 'hostCert'].map(val),
    ['warning', 61, 4, 1, 'required', 'outdated', 'on', 2, 10]);
  assert.equal(m.find((x) => x.metric === 'hostCert').name, 'web.firma.de');
  const check = (metric, key = '', extra = {}) => sensorCheck(db, { device_id: d.id, options: JSON.stringify({ metric, key, label: metric, ...extra }) });
  assert.equal(check('hostPdHealth', 'ZC1').ok, false);
  assert.match(check('hostPdHealth', 'ZC1').message, /warning \(61 °C, 3 % worn\)/);
  assert.equal(check('hostPdTemp', 'ZC1', { op: 'ge', threshold: 55 }).ok, false);
  assert.equal(check('hostReboot').ok, false);
  assert.match(check('hostAv').message, /signatures 9 days old/);
  assert.equal(check('hostFirewall').ok, true);
  assert.match(check('hostEvCritical', '', { op: 'gt', threshold: 0 }).message, /2 in 24 h - newest: Kernel-Power 41: rebooted/);
  assert.equal(check('hostCert', 'AB12', { op: 'le', threshold: 21 }).ok, false);
  assert.equal(check('hostCert', 'AB12', { op: 'le', threshold: 7 }).ok, true);
  assert.equal(check('hostUpdatesSec', '', { op: 'gt', threshold: 0 }).ok, false);
});
