// The Trivy gate of releases (.github/scripts/trivy-check.sh): a fixable vulnerability made public less than
// GRACE_DAYS ago lets the release through as a warning (time-limited exception); older ones, ones without a date and
// secrets stop it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const NOW = Date.parse('2026-11-25T12:00:00Z') / 1000;
const day = (n) => new Date((NOW - n * 86400) * 1000).toISOString().replace('.000Z', 'Z');
const vuln = (id, published) => ({ VulnerabilityID: id, PkgName: 'openssl', InstalledVersion: '3.3.1', FixedVersion: '3.3.2', Severity: 'HIGH', ...(published ? { PublishedDate: published } : {}) });

function check(results, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivy-'));
  const f = path.join(dir, 'report.json');
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(f, JSON.stringify({ Results: results }));
  const r = spawnSync('sh', ['.github/scripts/trivy-check.sh', f], { encoding: 'utf8', env: { ...process.env, TRIVY_NOW: String(NOW), GITHUB_STEP_SUMMARY: summary, ...env } });
  const out = { code: r.status, out: r.stdout + r.stderr, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('nothing found: passes', () => {
  const r = check([{ Target: 'img', Vulnerabilities: [] }]);
  assert.equal(r.code, 0);
  assert.match(r.out, /No fixable/);
});

test('made public 3 days ago: released with a time-limited exception', () => {
  const r = check([{ Target: 'img (alpine)', Vulnerabilities: [vuln('CVE-2026-1111', day(3))] }]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning title=Exception until 2026-12-06::HIGH CVE-2026-1111/);
  assert.match(r.summary, /CVE-2026-1111 \| openssl .* \| 2026-12-06 \|/);
});

test('made public 20 days ago, or without a date: stops the release', () => {
  for (const v of [vuln('CVE-2026-2222', day(20)), vuln('CVE-2026-3333', null), vuln('CVE-2026-4444', 'kein Datum')]) {
    const r = check([{ Target: 'img', Vulnerabilities: [v, vuln('CVE-2026-1111', day(1))] }]);
    assert.equal(r.code, 1, v.VulnerabilityID);
    assert.match(r.out, new RegExp(`::error::HIGH ${v.VulnerabilityID}`));
  }
});

test('dates with fractions and offsets are read; GRACE_DAYS can be set', () => {
  assert.equal(check([{ Target: 'img', Vulnerabilities: [vuln('CVE-1', day(2).replace('Z', '.123Z'))] }]).code, 0);
  assert.equal(check([{ Target: 'img', Vulnerabilities: [vuln('CVE-2', day(2).replace('Z', '+00:00'))] }]).code, 0);
  assert.equal(check([{ Target: 'img', Vulnerabilities: [vuln('CVE-3', day(5))] }], { GRACE_DAYS: '3' }).code, 1);
  assert.equal(check([{ Target: 'img', Vulnerabilities: [vuln('CVE-3', day(5))] }], { GRACE_DAYS: 'x' }).code, 1);
});

test('a secret in the image always stops the release', () => {
  const r = check([{ Target: 'img', Secrets: [{ Severity: 'CRITICAL', RuleID: 'private-key', Title: 'key' }] }]);
  assert.equal(r.code, 1);
});
