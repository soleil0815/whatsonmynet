// The chart on a monitor page: outages from checks (short ranges) and from events (long ranges), lengths in words.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { documentElement: {} };
const { duration, outagesFromChecks, outagesFromEvents } = await import('../public/js/views/monchart.js');

const T0 = Date.parse('2026-11-14T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

test('outages from checks: from the first failed check to the next good one, an open one lasts on', () => {
  const checks = [
    { at: at(0), ok: true, ms: 50 }, { at: at(2), ok: false, ms: null, message: 'Intranet: timeout' }, { at: at(4), ok: false, ms: null, message: 'x' },
    { at: at(6), ok: true, ms: 60 }, { at: at(8), ok: true, ms: 70 }, { at: at(10), ok: false, ms: 81, message: 'T: 81 °C' }, { at: at(12), ok: false, ms: 84 },
  ];
  const o = outagesFromChecks(checks);
  assert.equal(o.length, 2);
  assert.deepEqual([o[0].from, o[0].to, o[0].n, o[0].message], [T0 + 2 * 60000, T0 + 6 * 60000, 2, 'Intranet: timeout']);
  assert.deepEqual([o[1].to, o[1].n, o[1].lo, o[1].hi], [null, 2, 81, 84]);
  assert.deepEqual(outagesFromChecks([{ at: at(0), ok: true }]), []);
});

test('outages from events: down until up, in time order, only those in the range, an open one only while still down', () => {
  const ev = [
    { id: 5, at: at(100), kind: 'down', message: 'b' }, { id: 4, at: at(60), kind: 'up' }, { id: 3, at: at(50), kind: 'cert' },
    { id: 2, at: at(40), kind: 'down', message: 'a' }, { id: 1, at: at(-500), kind: 'up' },
  ];
  const o = outagesFromEvents(ev, T0, T0 + 200 * 60000, true);
  assert.deepEqual(o.map((x) => [x.message, x.to === null ? null : (x.to - x.from) / 60000]), [['a', 20], ['b', null]]);
  assert.equal(outagesFromEvents(ev, T0, T0 + 200 * 60000, false).length, 1);
  // before the range: left out
  assert.equal(outagesFromEvents(ev, T0 + 70 * 60000, T0 + 90 * 60000, false).length, 0);
});

test('lengths in words', () => {
  assert.equal(duration(20000), 'unter 1 Min.');
  assert.equal(duration(15 * 60000), '15 Min.');
  assert.equal(duration(125 * 60000), '2 Std. 5 Min.');
  assert.equal(duration(3 * 3600000), '3 Std.');
  assert.equal(duration((3 * 24 + 4) * 3600000), '3 Tg. 4 Std.');
});
