// TrueNAS (SCALE / Community Edition 25.04 or newer) through its JSON-RPC API over WebSocket (/api/current - the REST
// API is gone from version 26). An API key of a user with the role "Read-Only Administrator": it can only read.
// Pools with their state, vdevs, space and last scrub; the open alerts of TrueNAS itself; replication tasks.
//   { kind: 'truenas', name, version, pools: [pool shape of pools.js], alerts: [{ level, text, klass, at }],
//     replications: [{ id, name, enabled, state, at, error }], missing: [what the key may not read] }
import { tlsOptions } from './proxmox.js';
import { wsRpc } from './lib/wsrpc.js';
import { pool, poolMetrics } from './pools.js';

const clip = (s, n = 200) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** Dates of the API: { $date: ms } (JSON-RPC) or an ISO text */
const when = (v) => { const ms = v && typeof v === 'object' && '$date' in v ? Number(v.$date) : Date.parse(v); return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; };
// TrueNAS levels from INFO up; from WARNING on they are worth a look
const LEVELS = ['INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'];

/** Members of a pool topology that are not ONLINE: "sdd FAULTED" */
function badMembers(topology) {
  const out = [];
  const walk = (list) => {
    for (const c of list || []) {
      const st = String(c.status || '').toUpperCase();
      if (!(c.children && c.children.length) && st && !['ONLINE', 'AVAIL', 'INUSE'].includes(st)) out.push(`${clip(c.disk || c.name || c.path, 60)} ${st}`);
      walk(c.children);
    }
  };
  for (const part of Object.values(topology || {})) walk(Array.isArray(part) ? part : []);
  return out;
}

/** A pool as pool.query returns it → the common shape */
export function truenasPool(p) {
  const state = String(p.status || 'unknown').toUpperCase();
  const scan = p.scan || {};
  const scrubbed = String(scan.function || '').toUpperCase() === 'SCRUB' && String(scan.state || '').toUpperCase() === 'FINISHED';
  const errs = num(scan.errors);
  const bad = badMembers(p.topology);
  return pool({ kind: 'zfs', name: p.name, state, good: p.healthy !== false && state === 'ONLINE' && !bad.length && !(scrubbed && errs > 0),
    used: num(p.allocated), total: num(p.size),
    text: [state === 'ONLINE' ? '' : state, bad.join(', '), p.status_detail ? clip(p.status_detail, 160) : '', scrubbed && errs > 0 ? `last scrub found ${errs} errors` : ''].filter(Boolean).join(' · '),
    scrubAt: scrubbed ? when(scan.end_time) : null, scrubErrors: scrubbed ? errs : null, down: bad.length });
}

export async function readTrueNas(host) {
  const ws = await wsRpc(new URL('/api/current', host.url).href, tlsOptions(host)).catch((e) => {
    throw new Error(/404/.test(e.message) ? 'no TrueNAS API at this address - TrueNAS 25.04 or newer?' : e.message);
  });
  try {
    const login = await ws.call('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username: host.token_id, api_key: host.secretPlain, login_options: { user_info: false } }]);
    const rt = login?.response_type;
    if (rt === 'OTP_REQUIRED') throw new Error('the user needs a second factor (OTP) - use a user without it for the API key');
    if (rt === 'EXPIRED') throw new Error('the API key has expired - create a new one');
    if (rt === 'DENIED') throw new Error('the user may not use the API - give it the role "Read-Only Administrator"');
    if (rt !== 'SUCCESS') throw new Error('sign-in refused - user or API key wrong');
    const missing = [];
    const ask = async (method, params = []) => {
      try { return await ws.call(method, params); } catch (e) { if (/EACCES|not authorized|denied|permission/i.test(e.message)) missing.push(method); else throw e; return null; }
    };
    const info = (await ask('system.info')) || {};
    const pools = (await ask('pool.query')) || [];
    const alerts = (await ask('alert.list')) || [];
    const repl = (await ask('replication.query')) || [];
    return {
      kind: 'truenas', name: clip(info.hostname, 120), version: clip(info.version, 60), missing,
      pools: (Array.isArray(pools) ? pools : []).slice(0, 64).map(truenasPool),
      alerts: (Array.isArray(alerts) ? alerts : []).filter((a) => !a.dismissed && LEVELS.indexOf(String(a.level).toUpperCase()) >= 2).slice(0, 50)
        .map((a) => ({ level: String(a.level).toUpperCase(), text: clip(a.formatted || a.text, 400), klass: clip(a.klass, 80), at: when(a.datetime) })),
      replications: (Array.isArray(repl) ? repl : []).slice(0, 100).map((r) => ({ id: num(r.id), name: clip(r.name, 120), enabled: r.enabled !== false,
        state: clip(r.state?.state || 'PENDING', 20).toUpperCase(), at: when(r.state?.datetime), error: clip(r.state?.error, 300) })),
    };
  } finally { ws.close(); }
}

const REPL_BAD = new Set(['ERROR', 'FAILED']);
/** What a sensor can watch on TrueNAS: the pools (as everywhere), its own alerts, the replications */
export function truenasMetrics(d) {
  const out = [...poolMetrics(d.pools)];
  const crit = (d.alerts || []).filter((a) => LEVELS.indexOf(a.level) >= 4);
  out.push({ metric: 'nasAlerts', key: '', name: '', value: (d.alerts || []).length, unit: '', kind: 'number', op: 'gt', threshold: 0, text: (d.alerts || []).slice(0, 3).map((a) => a.text).join(' · ') });
  out.push({ metric: 'nasAlertsCrit', key: '', name: '', value: crit.length, unit: '', kind: 'number', op: 'gt', threshold: 0 });
  for (const r of d.replications || []) {
    if (!r.enabled) continue;
    out.push({ metric: 'replication', key: String(r.id ?? r.name), name: r.name, value: r.state, kind: 'state', good: !REPL_BAD.has(r.state),
      text: REPL_BAD.has(r.state) ? `${r.state}${r.error ? ` - ${r.error}` : ''}` : r.state });
  }
  return out;
}
