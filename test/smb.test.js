import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDb, tmp } from './helpers.js';
import { smbPath, parseSpace, smbError, smbCommand, smbCheck, SHARE } from '../src/monitor/smb.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';
import { createSettings } from '../src/settings.js';
import { createReports } from '../src/reports.js';

// Fake smbclient (POSIX sh): answers like the real one, depending on share, path and password
const fake = path.join(tmp, 'fake-smbclient');
fs.writeFileSync(fake, `#!/bin/sh
[ "$1" = "--version" ] && { echo "Version 4.20.0"; exit 0; }
all="$*"
case "$all" in
  *//slow/*) sleep 30 ;;
  *//x/Nope*) echo "tree connect failed: NT_STATUS_BAD_NETWORK_NAME" >&2; exit 1 ;;
  *Fehlt*) echo "NT_STATUS_NO_SUCH_FILE listing \\\\Fehlt"; exit 1 ;;
esac
[ "\${PASSWD-}" = "falsch" ] && { echo "session setup failed: NT_STATUS_LOGON_FAILURE" >&2; exit 1; }
printf '  Projekte    D    0  Thu Nov 12 22:50:38 2026\\n\\n\\t\\t1000000 blocks of size 1024. 50000 blocks available\\n'
`, { mode: 0o755 });
process.env.WOMN_SMBCLIENT = fake;

test('share, path and space are parsed strictly', () => {
  assert.equal(smbPath('/Projekte//2026/'), 'Projekte\\2026');
  assert.equal(smbPath('\\Projekte\\Bericht 2026.txt'), 'Projekte\\Bericht 2026.txt');
  assert.equal(smbPath(''), '');
  for (const bad of ['a;!id', '../etc', 'a"b', 'x*', 'a\nb', 'a|b', '$(id)']) assert.equal(smbPath(bad), null, bad);
  assert.ok(SHARE.test('D$'));
  assert.ok(!SHARE.test('a;b') && !SHARE.test('a/b'));
  assert.deepEqual(parseSpace('\t\t264212084 blocks of size 1024. 31007172 blocks available'), { total: 270553174016, free: 31751344128, pct: 11.7 });
  assert.equal(smbError('session setup failed: NT_STATUS_LOGON_FAILURE'), 'sign-in failed (user or password wrong)');
  assert.equal(smbError('all fine'), null);
});

test('the password never goes on the command line; only ls or du run', () => {
  const c = smbCommand('fs01.firma.local', 445, { share: 'Abteilung', path: 'Projekte/2026', user: 'monitor', domain: 'FIRMA' }, 'Geh"eim; !rm', 10);
  assert.ok(!c.args.join(' ').includes('Geh'), 'password not in argv');
  assert.equal(c.env.PASSWD, 'Geh"eim; !rm');
  assert.deepEqual(c.args.slice(c.args.indexOf('-U'), c.args.indexOf('-U') + 2), ['-U', 'FIRMA\\monitor']);
  assert.deepEqual(c.args.slice(-2), ['-c', 'ls "Projekte\\2026"']);
  assert.ok(!('SECRET' in c.env) && Object.keys(c.env).sort().join() === 'HOME,LANG,PASSWD,PATH', 'only a minimal environment');
  const guest = smbCommand('10.0.0.5', 445, { share: 'Offen' }, '', 5);
  assert.ok(guest.args.includes('-N') && !('PASSWD' in guest.env));
  assert.deepEqual(guest.args.slice(-2), ['-c', 'du']);
  assert.throws(() => smbCommand('-oops', 445, { share: 'x' }, ''), /invalid/);
  assert.throws(() => smbCommand('fs01', 445, { share: 'x', path: 'a;!sh' }, ''), /invalid/);
  assert.throws(() => smbCommand('fs01', 445, { share: 'x', user: 'a%b' }, ''), /invalid user/);
});

test('check: free space, warning limits, errors, timeout', async () => {
  const ok = await smbCheck('fs01', 445, { share: 'Abteilung', user: 'monitor' }, 'Geheim', 5);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.pct, 5);
  assert.match(ok.message, /51\.2 MB free of 1\.02 GB|free of/);
  const low = await smbCheck('fs01', 445, { share: 'Abteilung', minFreePct: 10 }, '', 5);
  assert.equal(low.ok, false);
  assert.equal(low.data.low, true);
  assert.match(low.message, /^only /);
  assert.equal((await smbCheck('fs01', 445, { share: 'Abteilung', minFreeGb: 1 }, '', 5)).ok, false);
  assert.equal((await smbCheck('fs01', 445, { share: 'A', user: 'monitor' }, 'falsch', 5)).message, 'sign-in failed (user or password wrong)');
  assert.equal((await smbCheck('x', 445, { share: 'Nope' }, '', 5)).message, 'share not found');
  assert.equal((await smbCheck('fs01', 445, { share: 'A', path: 'Fehlt' }, '', 5)).message, 'folder or file not found');
  const slow = await smbCheck('slow', 445, { share: 'A' }, '', 1);
  assert.equal(slow.ok, false);
  assert.match(slow.message, /timeout/);
});

function setup() {
  const db = memoryDb();
  const maintenance = createMaintenance(db);
  const mon = createMonitoring({ db, channels: { notify: async () => [] }, maintenance });
  return { db, mon };
}

test('SMB monitor: validation, password kept, free space stored and reported', async () => {
  const { db, mon } = setup();
  const base = { name: 'Abteilung', type: 'smb', target: 'FS01.firma.local', options: { share: 'Abteilung', user: 'monitor', domain: 'FIRMA', minFreePct: 10 }, password: 'Geheim-1' };
  await assert.rejects(mon.create({ ...base, options: { ...base.options, share: '' } }), { code: 'err.smbShare' });
  await assert.rejects(mon.create({ ...base, options: { ...base.options, path: 'a;!id' } }), { code: 'err.smbPath' });
  await assert.rejects(mon.create({ ...base, options: { ...base.options, user: 'FIRMA\\monitor' } }), { code: 'err.smbUser' });
  await assert.rejects(mon.create({ ...base, options: { ...base.options, minFreePct: 120 } }), { code: 'err.smbFree' });
  const m = await mon.create(base);
  assert.equal(m.target, 'fs01.firma.local');
  assert.equal(m.port, 445);
  assert.equal(m.has_password, true);
  assert.ok(!('secret' in m));
  const row = db.prepare('SELECT secret FROM monitors WHERE id=?').get(m.id);
  assert.ok(row.secret && !row.secret.includes('Geheim'), 'stored encrypted');
  // edit without a new password keeps it
  const m2 = await mon.update(m.id, { name: 'Abteilung (fs01)', options: { share: 'Abteilung', path: 'Projekte', user: 'monitor', domain: 'FIRMA' } });
  assert.equal(m2.has_password, true);
  assert.equal(m2.options.path, 'Projekte');
  // the check result keeps the measured values
  await mon.record(m2, { ok: false, ms: null, message: 'only 51.2 MB free', data: { total: 1024000000, free: 51200000, pct: 5, low: true } });
  assert.equal(mon.get(m.id).data.pct, 5);

  const settings = createSettings(db);
  const reports = createReports({ db, settings, mailer: { send: async () => {} } });
  const r = reports.create({ name: 'Laufwerke', sections: ['shares'], recipients: 'it@firma.de', schedule: { freq: 'weekly', weekday: 1, time: '08:00' } });
  const mail = reports.render(r);
  assert.equal(mail.count, 1);
  assert.equal(mail.attention, 1);
  assert.match(mail.text, /\\\\fs01\.firma\.local\\Abteilung\\Projekte/);
  assert.match(mail.text, /fast voll/);
  assert.ok(!/whatsonmynet/i.test(mail.html));
});

// Real Samba server (CI): WOMN_TEST_SMB=host:port:share:user:password
const real = process.env.WOMN_TEST_SMB;
test('real Samba server', { skip: !real && 'WOMN_TEST_SMB not set' }, async () => {
  const [host, port, share, user, password] = real.split(':');
  const saved = process.env.WOMN_SMBCLIENT;
  delete process.env.WOMN_SMBCLIENT;
  try {
    const r = await smbCheck(host, Number(port), { share, user }, password, 10);
    assert.equal(r.ok, true, r.message);
    assert.ok(r.data.total > 0);
    assert.equal((await smbCheck(host, Number(port), { share, user }, 'falsch', 10)).message, 'sign-in failed (user or password wrong)');
    assert.equal((await smbCheck(host, Number(port), { share, user, path: 'gibt-es-nicht' }, password, 10)).message, 'folder or file not found');
    assert.equal((await smbCheck(host, Number(port), { share: 'nope', user }, password, 10)).message, 'share not found');
  } finally { process.env.WOMN_SMBCLIENT = saved; }
});
