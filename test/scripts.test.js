import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const script = path.join(import.meta.dirname, '..', '.github', 'scripts', 'patchday.sh');
const isPatchday = (day) => {
  const r = spawnSync('sh', [script, day]);
  if (r.status === 2) throw new Error(String(r.stderr));
  return r.status === 0;
};

test('patch day is the second Tuesday of the month', () => {
  assert.equal(isPatchday('2026-11-10'), true);
  assert.equal(isPatchday('2026-11-03'), false); // first Tuesday (ZAP scan night)
  assert.equal(isPatchday('2026-11-17'), false);
  assert.equal(isPatchday('2026-11-11'), false);
  assert.equal(isPatchday('2026-12-08'), true);
  assert.equal(isPatchday('2027-01-12'), true);
  assert.equal(isPatchday('2027-02-09'), true);
  assert.throws(() => isPatchday('2026-13-01'));
  assert.throws(() => isPatchday('yesterday'));
});
