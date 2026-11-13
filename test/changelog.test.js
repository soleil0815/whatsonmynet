// "What's new" in the program: every version in German and English, newest first, no gaps in the released ones
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { CHANGELOG } from '../public/js/changelog.js';

test('changelog: both languages, newest first, released versions with date', () => {
  const nums = (v) => v.split('.').map(Number);
  let prev = null;
  for (const c of CHANGELOG) {
    assert.ok(Array.isArray(c.de) && c.de.length && Array.isArray(c.en), `${c.version}: texts`);
    assert.equal(c.de.length, c.en.length, `${c.version}: as many English as German lines`);
    if (c.version === 'next') { assert.equal(CHANGELOG[0], c, "'next' comes first"); continue; }
    assert.match(c.version, /^\d+\.\d+\.\d+$/);
    assert.match(c.date, /^\d{4}-\d{2}-\d{2}$/);
    if (prev) assert.ok(nums(prev)[0] * 1e6 + nums(prev)[1] * 1e3 + nums(prev)[2] > nums(c.version)[0] * 1e6 + nums(c.version)[1] * 1e3 + nums(c.version)[2], `${prev} before ${c.version}`);
    prev = c.version;
  }
});

test('changelog: every released minor version (git tags) is listed', (t) => {
  let tags = [];
  try { tags = execFileSync('git', ['tag', '--list', 'v*.*.0'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* no git */ }
  if (!tags.length) { t.skip('no git tags here'); return; }
  const listed = new Set(CHANGELOG.map((c) => c.version));
  for (const tag of tags) assert.ok(listed.has(tag.slice(1)), `${tag} missing in public/js/changelog.js`);
});
