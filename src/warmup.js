// Warm-up after the start: what the first pages need is read once in the background, so the first click after an update
// or a restart is as quick as any other. Right after a start nothing of the database is in memory yet - neither in the
// operating system's file cache nor in SQLite's - and the first visit of the overview, monitoring or sensors read it
// from the disk piece by piece (the last checks of hundreds of monitors lie scattered over the file). Measured with
// 400 monitors: the first call of the monitor list three times as long as the second, on a slow disk far more.
//
// Only reading, nothing is changed or sent. In small steps with a break after each (one monitor at a time): the warm-up
// itself must not hold up the receivers or a page that is asked for meanwhile.
import { log } from './lib/log.js';

const DELAY_MS = 5000; // after the start: the jobs of the start first (monitors, receivers, hypervisors)
const pause = () => new Promise((r) => setImmediate(r));

/**
 * Reads ahead what the first pages ask for. Returns what it did (for the log and the tests); a step that fails is left
 * out - the page then reads it itself, as before.
 */
export async function warmUp(ctx, { now = () => new Date() } = {}) {
  const t0 = Date.now();
  const done = [];
  const step = async (name, fn) => {
    try { await fn(); done.push(name); } catch (e) { log.debug(`Warm-up: ${name}: ${e.message}`); }
    await pause();
  };
  const { db } = ctx;

  // Monitoring and sensors: the last checks of the day and the uptime of each monitor - one monitor at a time
  await step('checks', async () => {
    const since = new Date(now().getTime() - 86400000).toISOString();
    const hour = new Date(now().getTime() - 24 * 3600000).toISOString().slice(0, 13);
    const beats = db.prepare('SELECT ok, ms, at, message FROM checks WHERE monitor_id=? AND at>=? ORDER BY at DESC, id DESC LIMIT 40');
    const up = db.prepare('SELECT SUM(ok) ok, SUM(total) total FROM monitor_hourly WHERE monitor_id=? AND hour>=?');
    for (const { id } of db.prepare('SELECT id FROM monitors').all()) {
      beats.all(id, since);
      up.get(id, hour);
      await pause();
    }
  });
  // the pages themselves, now from memory (once each: also the program code is then ready)
  await step('monitors', () => ctx.monitoring.list());
  await step('overview', () => {
    ctx.inventory.stats();
    ctx.monitoring.summary();
    ctx.hosts.scripts();
  });
  await step('inventory', () => ctx.inventory.list({}));
  await step('sensors', () => ctx.sensorChoices.deviceIds());
  await step('messages', () => {
    ctx.events.status();
    ctx.events.list({ limit: 100 });
  });
  const ms = Date.now() - t0;
  log.info(`Warm-up after the start: ${done.join(', ') || 'nothing'} read ahead in ${ms} ms`);
  return { done, ms };
}

/** Started once by the server, a few seconds after it listens */
export function scheduleWarmUp(ctx, delay = DELAY_MS) {
  setTimeout(() => { warmUp(ctx).catch((e) => log.debug(`Warm-up: ${e.message}`)); }, delay).unref();
}
