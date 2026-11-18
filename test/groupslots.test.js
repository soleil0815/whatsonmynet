// The bar of a group in the list "by group": red where a member failed, green where all checks were fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSlots } from '../public/js/groupslots.js';

test('slots as long as the slowest interval; red with the names of who failed, green, empty', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const at = (min) => new Date(now - min * 60000).toISOString();
  const members = [
    { name: 'mariadb', interval_s: 60, beats: [{ ok: true, at: at(9.5) }, { ok: false, at: at(4.5) }, { ok: false, at: at(4.2) }, { ok: true, at: at(0.5) }] },
    { name: 'redis', interval_s: 300, beats: [{ ok: true, at: at(9) }, { ok: false, at: at(4) }, { ok: true, at: at(60 * 24) }] },
  ];
  const s = groupSlots(members, 4, now);
  assert.equal(s.length, 4);
  assert.equal(s[0].at, at(20));
  assert.deepEqual(s.map((x) => [x.ok, x.bad]), [[0, []], [0, []], [2, []], [1, ['mariadb', 'redis']]]);
  assert.equal(groupSlots([{ name: 'x', interval_s: 99999, beats: [] }], 2, now)[0].at, at(120), 'at most an hour per slot');
  assert.equal(groupSlots([], 3, now).length, 3);
});
