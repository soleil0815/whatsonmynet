// Diagnostic package: the program's own log, the package (anonymised by default, never with secrets), placeholders
// that stay the same, looking them up - for administrators only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, tmp } from './helpers.js';
import { log } from '../src/lib/log.js';
import { zip, unzip } from '../src/lib/zip.js';
import { maskSecrets, createAnonymizer } from '../src/diagnostics.js';
import { parseSyslog } from '../src/events.js';
import { LOCAL_TABLES } from '../src/failover.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => { ctx.diagnostics.stop(); ctx.eventRules.stop(); return app.close(); });

const pkg = async (q = '', who = 'default') => {
  const res = await call('GET', `/api/diagnostics/package${q}`, undefined, { who, raw: true });
  if (res.status !== 200) return { status: res.status };
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  const text = Object.values(files).map((b) => b.toString('utf8')).join('\n');
  return { status: 200, files, text, name: res.headers.get('content-disposition') };
};

test('setup: an admin, a NAS, a viewer, a secret or two, some log lines', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'viewer' });
  assert.equal((await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'viewer' })).status, 200);
  ctx.inventory.create({ name: 'ihomeddserver', ip: '192.168.0.253', mac: '00:11:32:aa:bb:cc', hostname: 'ihomeddserver.fritz.box', type: 'nas' }, 'testadmin');
  ctx.settings.set('smtp.password', 'Mail-Geheim-77');
  ctx.settings.set('scan.snmpCommunities', 'SnmpGeheim42');
  ctx.settings.set('smtp.host', 'smtp.example-firma.de');
  // messages: a Windows computer that is not in the inventory (NXLog), the NAS; an event rule with sender and words
  ctx.eventRules.start();
  const mail = ctx.channels.create({ name: 'Helpdesk-Eingang', type: 'email', config: { to: 'ticket@example-firma.de' } });
  ctx.eventRules.create({ name: 'Virenfund', match: { eventIds: '1116', source: 'Defender', from: 'PC-0815, 192.168.0.77', words: 'm.weber' }, channels: [mail.id] });
  ctx.events.receive('syslog', '192.168.0.77', parseSyslog('<12>Nov 15 10:00:00 PC-0815 Microsoft-Windows-Windows Defender: [1116] [Microsoft-Windows-Windows Defender/Operational] Virus bei m.weber gefunden'));
  ctx.events.receive('syslog', '192.168.0.253', parseSyslog('<12>Nov 15 10:00:01 ihomeddserver storage: Volume 1 degraded'));
  // lines from before the log is attached wait for it (start, migrations)
  log.info('Early line before the database log (ihomeddserver)');
  ctx.diagnostics.start();
  log.warn('Synology ihomeddserver (192.168.0.253, 00:11:32:AA:BB:CC): SNMP timeout, community=SnmpGeheim42');
  log.info('Mail to max.muster@example-firma.de via https://admin:Mail-Geheim-77@smtp.example-firma.de:465/ ok');
  const rows = db.prepare('SELECT level, message FROM server_log').all();
  assert.ok(rows.some((r) => r.message.startsWith('Early line')), 'buffered start lines are kept');
  // the tests print errors only (WOMN_LOG_LEVEL=error) - the program's log keeps info and warnings all the same
  assert.ok(rows.some((r) => r.level === 'warn' && r.message.includes('SNMP timeout')));
});

test('anonymised by default: no real name, address or secret anywhere in the package', async () => {
  // a status page: counted, its secret link (a key) never in the package
  const sp = ctx.statusPages.create({ name: 'Status', networks: '10.0.10.0/24' });
  const p = await pkg('?days=7');
  assert.equal(p.text.includes(sp.slug), false, 'secret link of a status page');
  assert.deepEqual(JSON.parse(p.files['statistik.json']).status_pages, { n: 1, enabled: 1, secret_link: 1, own_address: 0, limited_to_networks: 1, items: 0 });
  ctx.statusPages.remove(sp.id);
  assert.equal(p.status, 200);
  assert.match(p.name, /whatsonmynet-diagnose-.*-7T-anonym\.zip/);
  for (const f of ['LIESMICH.txt', 'versionen.json', 'aenderungen.md', 'umgebung.json', 'einstellungen.json', 'statistik.json', 'protokoll.csv', 'fehler.txt',
    'monitore.json', 'ereignisse.csv', 'geraete.json', 'hypervisoren.json', 'meldungen.json', 'scans.csv', 'benachrichtigungen.json', 'aktionen.csv']) assert.ok(p.files[f], f);
  for (const real of ['ihomeddserver', '192.168.0.253', '00:11:32', 'fritz.box', 'max.muster', 'example-firma', 'testadmin', 'lisa', 'SnmpGeheim42', 'Mail-Geheim-77', 'PC-0815', '192.168.0.77', 'm.weber', 'Helpdesk-Eingang']) {
    assert.equal(p.text.toLowerCase().includes(real.toLowerCase()), false, `${real} must not be in the package`);
  }
  assert.match(p.files['fehler.txt'].toString(), /WARN Synology GERAET-001 \(10\.99\.0\.\d+, 02:00:00:00:00:\w\w\): SNMP timeout, community=\*\*\*/);
  const set = JSON.parse(p.files['einstellungen.json']);
  assert.equal(set['smtp.password'], '(gesetzt)');
  assert.equal(set['scan.snmpCommunities'], '(gesetzt)');
  assert.equal(set['smtp.host'].startsWith('HOST-'), true);
  const dev = JSON.parse(p.files['geraete.json'])[0];
  assert.equal(dev.name, 'GERAET-001');
  // messages: receivers, space, what came in by format, the rules - senders as placeholders, words only counted
  const env = JSON.parse(p.files['umgebung.json']);
  assert.equal(env.database.backupKeep, 10);
  assert.ok(env.database.backupFiles === null || typeof env.database.backupFiles.compressed === 'number');
  const m = JSON.parse(p.files['meldungen.json']);
  assert.deepEqual(Object.keys(m.receivers), ['traps', 'syslog', 'syslogTcp', 'syslogTls']);
  assert.equal(m.storage.total, 2);
  assert.deepEqual(m.period.by_format, { syslog: 1, windows_full: 1 });
  assert.deepEqual(m.period.top_event_ids, [{ event_id: 1116, n: 1 }]);
  assert.deepEqual(m.period.matched_to_device, { yes: 1, no: 1 });
  assert.equal(m.rules[0].match.eventIds, '1116');
  assert.match(m.rules[0].match.from[0], /^HOST-\d+$/);
  assert.match(m.rules[0].match.from[1], /^10\.99\./);
  assert.equal(m.rules[0].match.words, '1 Wörter');
  assert.equal(m.rules[0].hits24h, 1, 'the rule matched the Defender message');
  assert.deepEqual(m.metrics_keys, []);
});

test('the same placeholders in the next package; administrators can look them up', async () => {
  const a = JSON.parse((await pkg('?days=1')).files['geraete.json'])[0];
  const b = JSON.parse((await pkg('?days=0')).files['geraete.json'])[0];
  assert.deepEqual([a.name, a.ip, a.mac, a.hostname], [b.name, b.ip, b.mac, b.hostname]);
  const found = (await call('GET', `/api/diagnostics/lookup?q=${encodeURIComponent(a.ip)}`)).data.list;
  assert.deepEqual(found.map((x) => [x.kind, x.real]), [['ip', '192.168.0.253']]);
  assert.equal((await call('GET', '/api/diagnostics/lookup?q=GERAET-001')).data.list[0].real, 'ihomeddserver');
  const csvRes = await call('GET', '/api/diagnostics/aliases.csv', undefined, { raw: true });
  assert.match(await csvRes.text(), /device;GERAET-001;ihomeddserver/);
});

test('only for administrators', async () => {
  assert.equal((await pkg('', 'viewer')).status, 403);
  assert.equal((await call('GET', '/api/diagnostics/lookup?q=GERAET-001', undefined, { who: 'viewer' })).status, 403);
  assert.equal((await call('GET', '/api/diagnostics/aliases.csv', undefined, { who: 'viewer' })).status, 403);
  assert.equal((await call('GET', '/api/diagnostics/package', undefined, { who: 'nobody' })).status, 401);
});

test('not anonymised when asked for - secrets stay out all the same; the download is in the actions log', async () => {
  const p = await pkg('?days=7&anon=0');
  assert.match(p.name, /-7T\.zip"/);
  assert.ok(p.text.includes('ihomeddserver') && p.text.includes('192.168.0.253'));
  for (const secret of ['SnmpGeheim42', 'Mail-Geheim-77']) assert.equal(p.text.includes(secret), false, secret);
  assert.match(p.files['LIESMICH.txt'].toString(), /NEIN - enthält echte Namen/);
  const audit = db.prepare("SELECT detail FROM audit WHERE action='diagnostics.download' ORDER BY id").all().map((r) => r.detail);
  assert.ok(audit.some((d) => d.includes('NOT anonymised')));
});

test('masking secrets and directory paths, keeping what tells nothing', () => {
  assert.equal(maskSecrets('token=abc123 password: "x y" https://u:p@h/'), 'token=*** password: "*** y" https://***:***@h/');
  const an = createAnonymizer(db, true);
  assert.equal(an.anon('bind CN=svc-womn,OU=Dienste,DC=firma,DC=local as 127.0.0.1 mask 255.255.255.0'),
    `bind CN=${an.alias('dn', 'svc-womn')},OU=${an.alias('dn', 'Dienste')},DC=${an.alias('dn', 'firma')},DC=local as 127.0.0.1 mask 255.255.255.0`);
  // file names are no host names
  assert.equal(an.anon('wrote data/failover.json and womn-host.ps1'), 'wrote data/failover.json and womn-host.ps1');
});

test('the log is kept 30 days', () => {
  db.prepare('INSERT INTO server_log(at, level, message) VALUES(?,?,?)').run('2020-01-01T00:00:00.000Z', 'info', 'very old');
  ctx.diagnostics.prune();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM server_log WHERE message='very old'").get().n, 0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM server_log').get().n > 0);
});

test('log, versions and placeholders stay with each installation (failover does not copy them)', () => {
  for (const t of ['sessions', 'server_log', 'version_history', 'diag_alias']) assert.ok(LOCAL_TABLES.has(t), t);
});

test('the ZIP opens with the usual tools', () => {
  const buf = zip([{ name: 'a.txt', data: 'Grüße\n' }, { name: 'ordner/b.json', data: '{"x":1}' }]);
  assert.deepEqual(Object.fromEntries(Object.entries(unzip(buf)).map(([k, v]) => [k, v.toString()])), { 'a.txt': 'Grüße\n', 'ordner/b.json': '{"x":1}' });
  const f = path.join(tmp, 'diag-test.zip');
  fs.writeFileSync(f, buf);
  let tested = null;
  try { tested = execFileSync('unzip', ['-t', f], { encoding: 'utf8' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (tested !== null) assert.match(tested, /No errors detected/);
});

// The first log line of a start ("WhatsOnMyNet 0.59.3 starting") is written before the version is noted: it was listed
// with the version before (found in a package from a real server)
test('version history: a version counts from the start of the process, its first log line belongs to it', () => {
  const before = new Date(Date.now() - process.uptime() * 1000 + 1).toISOString();
  db.prepare('DELETE FROM version_history').run();
  ctx.diagnostics.recordStart();
  const row = db.prepare('SELECT started_at FROM version_history').get();
  assert.ok(row.started_at < before, `${row.started_at} is not before the first moment of the process (${before})`);
});
