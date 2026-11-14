// Suggestions 2026-11 (operations): allowed scan targets, telematics-safe deep check, cleanup of candidate images,
// private download copy of the backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp, startApp, memoryDb } from './helpers.js';
import { isPrivateCidr, scanTargetAllowed, cidrCovers } from '../src/lib/net.js';
import { deepPlan, SICCT_PORT, createScanner } from '../src/scan/engine.js';
import { GENTLE_PORTS, DEEP_PORTS } from '../src/scan/ports.js';
import { createSettings } from '../src/settings.js';
import { createInventory } from '../src/inventory.js';
import { openDatabase, verifyKey } from '../src/db.js';
import { createBackups } from '../src/backup.js';
import { t } from '../src/i18n.js';

const root = path.join(import.meta.dirname, '..');

// --- 9. Allowed scan targets ----------------------------------------------------------------------------------

test('scan targets: private ranges (RFC 1918, CGNAT) are private, public ones and ranges reaching outside are not', () => {
  for (const c of ['10.0.0.0/8', '10.1.2.0/24', '172.16.0.0/12', '172.31.255.0/24', '192.168.0.0/16', '192.168.10.7', '100.64.0.0/10', '100.127.1.0/24']) {
    assert.equal(isPrivateCidr(c), true, c);
  }
  for (const c of ['8.8.8.8', '203.0.113.0/24', '172.32.0.0/24', '172.15.255.0/24', '100.128.0.0/24', '10.0.0.0/7', '192.168.0.0/15', '0.0.0.0/0', '169.254.1.0/24']) {
    assert.equal(isPrivateCidr(c), false, c);
  }
  assert.equal(cidrCovers('10.0.0.0/8', '10.2.3.4'), true);
  assert.equal(cidrCovers('10.2.3.0/24', '10.2.0.0/16'), false);
});

test('scan targets: a public subnet is allowed for editors only when it lies inside a location subnet', () => {
  const subnets = ['198.51.100.0/24'];
  assert.equal(scanTargetAllowed('198.51.100.0/24', subnets), true);
  assert.equal(scanTargetAllowed('198.51.100.64/26', subnets), true);
  assert.equal(scanTargetAllowed('198.51.100.9', subnets), true);
  assert.equal(scanTargetAllowed('198.51.100.0/23', subnets), false);
  assert.equal(scanTargetAllowed('203.0.113.0/24', subnets), false);
  assert.equal(scanTargetAllowed('192.168.5.0/24', []), true);
  assert.equal(scanTargetAllowed('kein netz', subnets), false);
});

test('scan targets: the error text exists in German and English', () => {
  assert.match(t('de', 'err.publicScan'), /Öffentliche Netze dürfen nur Administratoren scannen/);
  assert.match(t('en', 'err.publicScan'), /Only administrators may scan public networks/);
});

test('scan targets: editors may not scan public networks or deep-check public devices, administrators may', async () => {
  const app = await startApp({ setupToken: 'ops-setup' });
  const { call, ctx } = app;
  const started = [];
  const real = { net: ctx.scanner.startNetwork, deep: ctx.scanner.startDeep };
  ctx.scanner.startNetwork = (targets) => { started.push(targets.map((x) => x.cidr)); return 9001; };
  ctx.scanner.startDeep = (d) => { started.push([`${d.ip}/32`]); return 9002; };
  try {
    assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'Sicher-Passwort-1', code: 'ops-setup' })).status, 200);
    const loc = (await call('POST', '/api/locations', { name: 'Außenstelle', subnets: ['198.51.100.0/24'] })).data;
    const pub = (await call('POST', '/api/devices', { name: 'Öffentlich', ip: '203.0.113.10' })).data;
    const atLoc = (await call('POST', '/api/devices', { name: 'Am Standort', ip: '198.51.100.20', location_id: loc.id })).data;
    const lan = (await call('POST', '/api/devices', { name: 'Intern', ip: '192.168.50.20' })).data;
    assert.equal((await call('POST', '/api/users', { username: 'redakteur', password: 'Redakteur-Pass-1', role: 'editor' })).status, 201);
    assert.equal((await call('POST', '/api/login', { username: 'redakteur', password: 'Redakteur-Pass-1' }, { who: 'ed' })).status, 200);
    const ed = { who: 'ed' };

    const denied = await call('POST', '/api/scans', { cidrs: ['192.168.50.0/24', '203.0.113.0/24'] }, ed);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.code, 'err.publicScan');
    assert.match(denied.data.error.message, /203\.0\.113\.0\/24/);
    assert.equal((await call('POST', '/api/scans', { cidrs: ['10.0.0.0/7'] }, ed)).status, 403);
    assert.equal((await call('POST', `/api/devices/${pub.id}/deep`, undefined, ed)).status, 403);
    assert.equal(started.length, 0);

    assert.equal((await call('POST', '/api/scans', { cidrs: ['192.168.50.0/24', '100.64.1.0/24'] }, ed)).status, 202);
    assert.equal((await call('POST', '/api/scans', { cidrs: ['198.51.100.128/25'] }, ed)).status, 202);
    assert.equal((await call('POST', '/api/scans', { locationIds: [loc.id] }, ed)).status, 202);
    assert.equal((await call('POST', `/api/devices/${atLoc.id}/deep`, undefined, ed)).status, 202);
    assert.equal((await call('POST', `/api/devices/${lan.id}/deep`, undefined, ed)).status, 202);
    // administrators: public networks too
    assert.equal((await call('POST', '/api/scans', { cidrs: ['203.0.113.0/24'] })).status, 202);
    assert.equal((await call('POST', `/api/devices/${pub.id}/deep`, undefined)).status, 202);
    assert.deepEqual(started.at(-2), ['203.0.113.0/24']);
  } finally {
    ctx.scanner.startNetwork = real.net; ctx.scanner.startDeep = real.deep;
    await app.close();
  }
});

// --- 10. Telematics-safe deep check -------------------------------------------------------------------------

test('deep check: an unclassified device answering on the SICCT port gets the gentle list', async () => {
  const asked = [];
  const open4742 = async (ip, port) => { asked.push(`${ip}:${port}`); return port === SICCT_PORT ? 'open' : 'closed'; };
  const plan = await deepPlan({ ip: '192.168.7.20', type: 'unknown', facts: '{}' }, { probe: open4742 });
  assert.deepEqual(asked, [`192.168.7.20:${SICCT_PORT}`]);
  assert.equal(plan.telematik, true);
  assert.equal(plan.reason, 'sicct');
  assert.deepEqual(plan.ports, GENTLE_PORTS);

  const silent = await deepPlan({ ip: '192.168.7.21', type: 'unknown', facts: '{}' }, { probe: async () => 'filtered' });
  assert.equal(silent.telematik, false);
  assert.deepEqual(silent.ports, DEEP_PORTS);
  // a failing probe counts as no answer
  assert.equal((await deepPlan({ ip: '192.168.7.22', facts: '{}' }, { probe: async () => { throw new Error('x'); } })).telematik, false);
});

test('deep check: known Telematik devices and connector manufacturers are never probed first', async () => {
  const never = async () => { throw new Error('must not probe'); };
  assert.equal((await deepPlan({ ip: '192.168.7.30', type: 'ti_connector', facts: '{}' }, { probe: never })).reason, 'type');
  assert.equal((await deepPlan({ ip: '192.168.7.31', type: 'unknown', facts: JSON.stringify({ classification: { type: 'ti_terminal' } }) }, { probe: never })).reason, 'type');
  const byVendor = await deepPlan({ ip: '192.168.7.32', type: 'unknown', facts: '{}' }, { probe: never, vendor: 'secunet' });
  assert.equal(byVendor.reason, 'vendor');
  assert.deepEqual(byVendor.ports, GENTLE_PORTS);
});

test('deep check: the scanner uses the gentle profile when the mocked SICCT probe answers', { timeout: 60_000 }, async () => {
  const db = memoryDb();
  const settings = createSettings(db);
  settings.set('scan.snmp', false);
  settings.set('scan.httpTitles', false);
  settings.set('scan.ping', false);
  const inventory = createInventory(db);
  const asked = [];
  const scanner = createScanner({ db, settings, inventory, probe: async (ip, port) => { asked.push(port); return 'open'; } });
  const ts = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO devices(name,ip,type,created_at,updated_at) VALUES('Unklar','127.0.0.1','unknown',?,?)").run(ts, ts).lastInsertRowid);
  const scanId = scanner.startDeep(db.prepare('SELECT * FROM devices WHERE id=?').get(id), 'test');
  while (!scanner.progress(scanId).finished) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(asked, [SICCT_PORT]);
  const facts = JSON.parse(db.prepare('SELECT facts FROM scan_results WHERE scan_id=?').get(scanId).facts);
  assert.equal(facts.deep.gentle, true);
  assert.equal(facts.deep.gentleReason, 'sicct');
  assert.equal(JSON.parse(db.prepare('SELECT stats FROM scans WHERE id=?').get(scanId).stats).telematikGentle, true);
});

// --- 11. Candidate image cleanup ------------------------------------------------------------------------------

const hasTools = spawnSync('sh', ['-c', 'command -v jq']).status === 0;

function runCleanup(runId, { failInspect = false, ghFail = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'cand-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
case "$GH_FAIL:$*" in
  list403:*--paginate*) echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1 ;;
  list500:*--paginate*) echo 'gh: Server Error (HTTP 500)' >&2; exit 1 ;;
  'delete403:api -X DELETE '*) echo 'gh: Must have admin rights to Repository. (HTTP 403)' >&2; exit 1 ;;
  'delete500:api -X DELETE '*) echo 'gh: Server Error (HTTP 500)' >&2; exit 1 ;;
esac
case " $* " in *" -X DELETE "*) exit 0 ;; esac
expr=''
while [ $# -gt 0 ]; do [ "$1" = --jq ] && expr="$2"; shift; done
exec jq -r "$expr" "$FIXTURE_VERSIONS"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
[ -z "$FAIL_INSPECT" ] || { echo 'denied' >&2; exit 1; }
for last; do :; done
d="\${last#*@}"
out="$(jq -c --arg d "$d" '.[$d] // empty' "$FIXTURE_MANIFESTS")"
[ -n "$out" ] || { echo 'manifest unknown' >&2; exit 1; }
printf '%s\\n' "$out"
`, { mode: 0o755 });
  const r = spawnSync('sh', [path.join(root, '.github', 'scripts', 'delete-candidates.sh'), 'ghcr.io/example/netapp', String(runId)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, GH_TOKEN: 'x', FAIL_INSPECT: failInspect ? '1' : '', GH_FAIL: ghFail,
      FIXTURE_VERSIONS: path.join(root, 'test', 'fixtures', 'ghcr-versions.json'), FIXTURE_MANIFESTS: path.join(root, 'test', 'fixtures', 'ghcr-manifests.json') },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  const deleted = calls.filter((c) => c.includes('-X DELETE')).map((c) => Number(c.split('/').pop()));
  return { ...r, calls, deleted };
}

test('candidate cleanup: refuses versions with a real tag, latest or another run, and platform images of the published image', { skip: !hasTools && 'jq missing' }, () => {
  const r = runCleanup(777);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // 1: candidate = published 1.2.0/latest, 2+3: platform images of 1.2.0, 5: also tagged 1.1.9, 4/7: other runs, 6: untagged
  assert.deepEqual(r.deleted, [8]);
  assert.match(r.stdout, /Kept 1 .*also tagged/);
  assert.match(r.stdout, /Kept 5 .*also tagged 1\.1\.9/);
  assert.match(r.stdout, /Kept 2 .*platform image of a published image/);
  assert.ok(r.calls.every((c) => !/\/versions\/(1|2|3|4|5|6|7)$/.test(c)), r.calls.join('\n'));
  assert.ok(r.calls.some((c) => c.startsWith('gh api --paginate /users/example/packages/container/netapp/versions?per_page=100')));
});

test('candidate cleanup: a run that published nothing removes all its candidates, the index first', { skip: !hasTools && 'jq missing' }, () => {
  const r = runCleanup(888);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.deleted, [10, 11, 12]);
});

test('candidate cleanup: nothing is deleted when the published images cannot be read', { skip: !hasTools && 'jq missing' }, () => {
  const r = runCleanup(888, { failInspect: true });
  assert.equal(r.status, 1);
  assert.deepEqual(r.deleted, []);
  const bad = runCleanup('12; rm');
  assert.equal(bad.status, 2);
  assert.deepEqual(bad.calls, []);
});

test('candidate cleanup: a token without access to the package only warns, real errors still fail', { skip: !hasTools && 'jq missing' }, () => {
  const list = runCleanup(888, { ghFail: 'list403' });
  assert.equal(list.status, 0, list.stderr + list.stdout);
  assert.match(list.stdout, /::warning::No access to the package versions/);
  assert.deepEqual(list.deleted, []);
  const del = runCleanup(888, { ghFail: 'delete403' });
  assert.equal(del.status, 0, del.stderr + del.stdout);
  assert.match(del.stdout, /::warning::No permission to delete 10 /);
  const listErr = runCleanup(888, { ghFail: 'list500' });
  assert.equal(listErr.status, 1);
  assert.match(listErr.stderr, /::error::Cannot list the package versions/);
  const delErr = runCleanup(888, { ghFail: 'delete500' });
  assert.equal(delErr.status, 1);
  assert.match(delErr.stdout, /::warning::Could not delete 10 /);
});

test('candidate cleanup: a failed publish keeps the candidates for "Re-run failed jobs"', () => {
  for (const f of ['ci.yml', 'security-update.yml']) {
    const wf = fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8');
    const job = wf.slice(wf.indexOf('\n  cleanup-candidates:'));
    assert.match(job, /\n {4}if: always\(\) && needs\.publish\.result != 'failure' && /, f);
    assert.match(wf.slice(0, wf.indexOf('\n  cleanup-candidates:')).split('\n').slice(-6).join('\n'), /Re-run failed jobs/, `${f}: the reason is noted`);
  }
});

test('candidate cleanup: both release workflows clean up in an always() job with packages: write only', () => {
  for (const f of ['ci.yml', 'security-update.yml']) {
    const wf = fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8');
    const job = wf.slice(wf.indexOf('\n  cleanup-candidates:'));
    assert.ok(job.length > 30, f);
    assert.match(job, /if: always\(\) && /, f);
    assert.match(job, /needs: \[[^\]]*publish\]/, f);
    assert.match(job, /permissions:\n {6}contents: read\n {6}packages: write\n {4}steps:/, f);
    assert.match(job, /sh \.github\/scripts\/delete-candidates\.sh "\$IMAGE" "\$GITHUB_RUN_ID"/, f);
    for (const u of job.match(/uses: \S+/g)) assert.match(u, /@[0-9a-f]{40}$/, `${f}: ${u}`);
  }
});

// --- 13. Private download copy of the backup ------------------------------------------------------------------

test('backup download: the copy lies in the backups folder with mode 0600 and is removed by discard()', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'dl-'));
  const file = path.join(dir, 'whatsonmynet.sqlite');
  const db = openDatabase(file);
  verifyKey(db);
  const backupsDir = path.join(dir, 'backups');
  const backups = createBackups({ db, settings: createSettings(db), dbFile: file, backupsDir, restart: () => {} });
  const old = process.umask(0o022);
  try {
    const f = await backups.snapshot();
    assert.equal(path.dirname(f), backupsDir);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(f).subarray(0, 15).toString(), 'SQLite format 3');
    assert.deepEqual(backups.list(), []); // never listed as a backup
    backups.discard(f);
    assert.equal(fs.existsSync(f), false);
    // discard() never removes other files
    const other = path.join(dir, 'keep.sqlite');
    fs.writeFileSync(other, 'x');
    backups.discard(other);
    assert.equal(fs.existsSync(other), true);
  } finally { process.umask(old); db.close(); }
});

test('backup download: the copy is gone after sending and after an aborted download', async () => {
  const app = await startApp({ setupToken: 'dl-setup' });
  try {
    await app.call('POST', '/api/setup', { code: 'dl-setup', username: 'admin', password: 'Admin-Passwort-1' });
    const dir = path.join(tmp, 'backups');
    const leftovers = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith('download-')) : []);
    const res = await app.call('GET', '/api/backups/download', undefined, { raw: true });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(leftovers(), []);
    // abort: read only the headers, then cancel
    const ac = new AbortController();
    const r2 = await fetch(`${app.url}/api/backups/download`, { headers: { Cookie: (await cookieOf(app)) }, signal: ac.signal }).catch(() => null);
    if (r2) ac.abort();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(leftovers(), []);
  } finally { await app.close(); }
});

// The session cookie of the default user of startApp (a raw request needs it)
async function cookieOf(app) {
  const res = await fetch(`${app.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WOMN-Request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'Admin-Passwort-1' }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
