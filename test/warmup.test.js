// Warm-up after the start: reads what the first pages need, changes nothing, holds nothing up, and a step that fails
// leaves the others alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { warmUp } from '../src/warmup.js';

test('warm-up reads the first pages ahead - and changes nothing', async () => {
  const s = await startApp();
  try {
    const { ctx, db } = s;
    await ctx.monitoring.create({ name: 'Intranet', type: 'tcp', target: '10.0.10.5', port: 443 });
    db.prepare("INSERT INTO checks(monitor_id,at,ok,ms,message) SELECT id, ?, 1, 5, '' FROM monitors").run(new Date().toISOString());
    const before = db.prepare('SELECT total_changes() n').get().n;
    // it gives the server back between its steps: something else gets its turn before it is done
    let other = false;
    setImmediate(() => { other = true; });
    const running = warmUp(ctx);
    assert.equal(other, false);
    const r = await running;
    assert.equal(other, true);
    assert.deepEqual(r.done, ['checks', 'monitors', 'overview', 'inventory', 'sensors', 'messages']);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before, 'only read');
  } finally { await s.close(); }
});

test('a step that fails is left out, the others still run', async () => {
  const s = await startApp();
  try {
    const ctx = { ...s.ctx, monitoring: { ...s.ctx.monitoring, list: () => { throw new Error('kaputt'); } } };
    const r = await warmUp(ctx);
    assert.deepEqual(r.done, ['checks', 'overview', 'inventory', 'sensors', 'messages'], 'only the monitor list is left out');
  } finally { await s.close(); }
});
