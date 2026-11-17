// Storage that is more than a disk: ZFS pools, Ceph clusters, Linux software RAID (mdadm), Windows Storage Spaces,
// TrueNAS. Wherever they come from (Proxmox API, TrueNAS API, Ceph dashboard, the host scripts), they end up in one
// shape, so the sensors, the alarms and the pages treat them alike:
//   { kind: 'zfs'|'ceph'|'md'|'spaces', name, node, state, good, text, used, total, pct, scrubAt, scrubErrors, down }
// state: as the system says it (ONLINE, DEGRADED, HEALTH_WARN, clean, degraded …); good: fine or not; text: why not;
// down: members that are missing or failed (disks, OSDs); scrubAt: end of the last scrub (ZFS).
// Everything is read only - nothing here changes a pool.

const clip = (s, n = 200) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f]/g, ' ').trim().slice(0, n);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pctOf = (used, total) => (total > 0 && used !== null ? Math.min(100, Math.round((used / total) * 100)) : null);
const MAX = 64;

/** One pool in the common shape (fields clipped, numbers checked) */
export function pool(p) {
  const used = num(p.used); const total = num(p.total);
  return {
    kind: ['zfs', 'ceph', 'md', 'spaces'].includes(p.kind) ? p.kind : 'zfs',
    name: clip(p.name, 120), node: clip(p.node, 80), state: clip(p.state, 40) || 'unknown', good: !!p.good, text: clip(p.text, 400),
    used, total, pct: num(p.pct) ?? pctOf(used, total),
    scrubAt: p.scrubAt && Number.isFinite(Date.parse(p.scrubAt)) ? new Date(p.scrubAt).toISOString() : null,
    scrubErrors: num(p.scrubErrors), down: num(p.down),
  };
}
export const pools = (list) => (Array.isArray(list) ? list : []).slice(0, MAX).map(pool).filter((p) => p.name);

// ------------------------------------------------------------------------------------------------------------- ZFS
const ZFS_GOOD = new Set(['ONLINE']);
/**
 * The "scan" line of zpool status / the Proxmox API: "scrub repaired 0B in 00:01:23 with 0 errors on Sun Nov  9
 * 00:25:24 2025" → { at, errors }; "scrub in progress since …" → running; none → nulls
 */
export function zfsScan(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = /scrub repaired .*? with (\d+) errors? on (?:\w{3} )?(\w{3}) (\d{1,2}) (\d{1,2}:\d{2}:\d{2}) (\d{4})/i.exec(s);
  if (m) {
    const at = Date.parse(`${m[2]} ${m[3]}, ${m[5]} ${m[4]}`);
    return { at: Number.isFinite(at) ? new Date(at).toISOString() : null, errors: Number(m[1]), running: false };
  }
  return { at: null, errors: null, running: /scrub in progress/i.test(s) };
}

/** Members of a pool that are not ONLINE (from the vdev tree of zpool status / the API): count and names */
function zfsBadMembers(children = [], out = []) {
  for (const c of children || []) {
    const st = String(c.state || c.status || '').toUpperCase();
    if (!(c.children && c.children.length) && st && !['ONLINE', 'AVAIL', 'INUSE'].includes(st)) out.push(`${clip(c.name, 60)} ${st}`);
    zfsBadMembers(c.children, out);
  }
  return out;
}

/** A ZFS pool from what Proxmox says: list entry (name, health, size, alloc) and, if asked, its details */
export function zfsFromPve(item, detail, node) {
  const state = String(detail?.state || item.health || 'unknown').toUpperCase();
  const scan = zfsScan(detail?.scan);
  const errors = clip(detail?.errors, 200);
  const bad = zfsBadMembers(detail?.children);
  const dataErrors = errors && !/^No known data errors$/i.test(errors);
  const good = ZFS_GOOD.has(state) && !bad.length && !dataErrors && !(scan.errors > 0);
  return pool({ kind: 'zfs', name: item.name, node, state, good, used: item.alloc, total: item.size,
    text: [ZFS_GOOD.has(state) ? '' : state, bad.join(', '), dataErrors ? errors : '', scan.errors > 0 ? `last scrub found ${scan.errors} errors` : ''].filter(Boolean).join(' · '),
    scrubAt: scan.at, scrubErrors: scan.errors, down: bad.length });
}

/**
 * ZFS pools from the Linux script: `zpool list -Hp -o name,health,size,alloc` (tab separated) and the text of
 * `zpool status -p <pool>` for each - read here, so the script stays a few plain lines of sh
 */
export function zfsFromScript(list, statusByName = {}) {
  const out = [];
  for (const l of String(list || '').split('\n').slice(0, MAX)) {
    const [name, health, size, alloc] = l.split('\t');
    if (!name || !health) continue;
    const st = String(statusByName[name] || '');
    const scanLine = (/^\s*scan:\s*(.+(?:\n\s{4,}\S.*)*)/m.exec(st) || [])[1] || '';
    const scan = zfsScan(scanLine);
    const errors = ((/^\s*errors:\s*(.+)$/m.exec(st) || [])[1] || '').trim();
    // members: the lines of the config block that are neither the pool itself nor a header
    const bad = [];
    const cfg = (/config:\s*\n([\s\S]*?)\n\s*errors:/.exec(st) || [])[1] || '';
    for (const row of cfg.split('\n')) {
      const m = /^\s+(\S+)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED)\b/.exec(row);
      if (m && m[1] !== name && !/^(mirror|raidz\d?|draid\d?|spare|log|cache|special|dedup)(-\d+)?/.test(m[1]) && m[2] !== 'ONLINE') bad.push(`${m[1]} ${m[2]}`);
    }
    const dataErrors = errors && !/^No known data errors$/i.test(errors);
    const state = health.toUpperCase();
    out.push(pool({ kind: 'zfs', name, state, used: num(alloc), total: num(size),
      good: state === 'ONLINE' && !bad.length && !dataErrors && !(scan.errors > 0),
      text: [state === 'ONLINE' ? '' : state, bad.join(', '), dataErrors ? errors : '', scan.errors > 0 ? `last scrub found ${scan.errors} errors` : ''].filter(Boolean).join(' · '),
      scrubAt: scan.at, scrubErrors: scan.errors, down: bad.length }));
  }
  return out;
}

// -------------------------------------------------------------------------------------------- Linux software RAID
/**
 * /proc/mdstat → one pool per array. "[2/1] [U_]" = one of two members missing; "(F)" = a failed member;
 * resync/recovery/check are named with their progress.
 */
export function mdFromMdstat(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length && out.length < MAX; i++) {
    const m = /^(md\w+)\s*:\s*(\w+)\s+(?:\((?:auto-)?read-only\)\s+)?(raid\d+|linear|multipath)?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, name, active, level = '', members] = m;
    const failed = (members.match(/\(F\)/g) || []).length;
    const rest = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() && !/^md\w+\s*:/.test(lines[j]); j++) rest.push(lines[j]);
    const block = rest.join('\n');
    const counts = /\[(\d+)\/(\d+)\]/.exec(block);
    const blocks = num((/(\d+) blocks/.exec(block) || [])[1]);
    const missing = counts ? Math.max(0, Number(counts[1]) - Number(counts[2])) : 0;
    const op = /(resync|recovery|reshape|check)\s*=\s*([\d.]+%)/.exec(block);
    const down = missing + failed;
    const state = active !== 'active' ? active : down ? 'degraded' : op ? op[1] : 'clean';
    out.push(pool({ kind: 'md', name, state, good: active === 'active' && !down, total: blocks === null ? null : blocks * 1024,
      text: [level, active !== 'active' ? active : '', down ? `${down} member(s) missing or failed` : '', op ? `${op[1]} ${op[2]}` : ''].filter(Boolean).join(' · '), down }));
  }
  return out;
}

// ------------------------------------------------------------------------------------------ Windows Storage Spaces
const SPACE_HEALTH = { 0: 'healthy', 1: 'warning', 2: 'unhealthy', 5: 'unknown' };
/** Storage Spaces from the Windows script: pools and their virtual disks (MSFT_StoragePool / MSFT_VirtualDisk) */
export function spacesFromScript(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX).map((p) => {
    const health = SPACE_HEALTH[num(p.health)] || 'unknown';
    const vd = (Array.isArray(p.vdisks) ? p.vdisks : []).slice(0, 32);
    const badVd = vd.filter((v) => num(v.health) !== 0).map((v) => `${clip(v.name, 60)} ${SPACE_HEALTH[num(v.health)] || 'unknown'}`);
    const badPd = num(p.badDisks) || 0;
    return pool({ kind: 'spaces', name: p.name, state: health, good: health === 'healthy' && !badVd.length && !badPd, used: num(p.alloc), total: num(p.size),
      text: [health === 'healthy' ? '' : health, badVd.join(', '), badPd ? `${badPd} disk(s) not healthy` : ''].filter(Boolean).join(' · '), down: badPd });
  });
}

// ---------------------------------------------------------------------------------------------------------- Ceph
const CEPH_STATES = ['HEALTH_OK', 'HEALTH_WARN', 'HEALTH_ERR'];
/** The health checks of Ceph as a short text: "OSD_DOWN: 1 osds down · PG_DEGRADED: Degraded data redundancy …" */
function cephChecks(checks) {
  const list = Array.isArray(checks) ? checks.map((c) => [c.type, c]) : Object.entries(checks || {});
  return list.slice(0, 6).map(([k, c]) => `${clip(k, 40)}: ${clip(c?.summary?.message ?? c?.summary ?? '', 120)}`).join(' · ');
}
/** PGs that are not active+clean (a few during a rebalance are normal; the count shows when it stays) */
function pgsNotClean(states) {
  let bad = 0;
  for (const [name, n] of states) if (!/^active\+clean$/.test(name)) bad += Number(n) || 0;
  return bad;
}
/**
 * The cluster from `ceph status` as Proxmox passes it on (/cluster/ceph/status) or from the Ceph dashboard
 * (/api/health/minimal) - one "pool" for the whole cluster
 */
export function cephPool(s, name = 'Ceph') {
  if (!s || typeof s !== 'object') return null;
  const health = String(s.health?.status || s.health?.overall_status || '').toUpperCase();
  if (!CEPH_STATES.includes(health)) return null;
  // OSDs: ceph status (osdmap.num_osds / older osdmap.osdmap) or the dashboard (osd_map.osds[])
  const om = s.osdmap?.osdmap || s.osdmap || {};
  let osds = num(om.num_osds); let up = num(om.num_up_osds);
  if (Array.isArray(s.osd_map?.osds)) { osds = s.osd_map.osds.length; up = s.osd_map.osds.filter((o) => o.up).length; }
  const down = osds !== null && up !== null ? Math.max(0, osds - up) : null;
  // space and placement groups
  const pg = s.pgmap || {};
  const total = num(pg.bytes_total ?? s.df?.stats?.total_bytes); const used = num(pg.bytes_used ?? s.df?.stats?.total_used_raw_bytes);
  const states = Array.isArray(pg.pgs_by_state) ? pg.pgs_by_state.map((x) => [x.state_name, x.count]) : Object.entries(s.pg_info?.statuses || {});
  const unclean = pgsNotClean(states);
  const checks = cephChecks(s.health?.checks);
  return pool({ kind: 'ceph', name, state: health, good: health === 'HEALTH_OK', used, total,
    text: [checks, down ? `${down} of ${osds} OSDs down` : '', unclean ? `${unclean} PGs not active+clean` : ''].filter(Boolean).join(' · '), down });
}

/**
 * Prometheus text of the Ceph manager (mgr module "prometheus"): health, OSDs up, space - for a Ceph without
 * dashboard. Not used for alarms of its own; the dashboard answer is preferred.
 */
export function cephFromPrometheus(text, name = 'Ceph') {
  const val = (metric) => { const m = new RegExp(`^${metric}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)`, 'm').exec(text); return m ? Number(m[1]) : null; };
  const all = (metric) => [...String(text).matchAll(new RegExp(`^${metric}\\{[^}]*\\}\\s+([\\d.eE+-]+)`, 'gm'))].map((m) => Number(m[1]));
  const h = val('ceph_health_status');
  if (h === null) return null;
  const up = all('ceph_osd_up');
  const checks = [...String(text).matchAll(/^ceph_health_detail\{[^}]*name="([^"]+)"[^}]*\}\s+1/gm)].map((m) => m[1]);
  return pool({ kind: 'ceph', name, state: CEPH_STATES[h] || 'unknown', good: h === 0, total: val('ceph_cluster_total_bytes'), used: val('ceph_cluster_total_used_bytes'),
    text: [checks.join(', '), up.length && up.some((x) => x === 0) ? `${up.filter((x) => x === 0).length} of ${up.length} OSDs down` : ''].filter(Boolean).join(' · '),
    down: up.length ? up.filter((x) => x === 0).length : null });
}

// ------------------------------------------------------------------------------------------------------ sensors
const KIND_NAME = { zfs: 'ZFS', ceph: 'Ceph', md: 'RAID', spaces: 'Storage Spaces' };
export const poolKey = (p) => `${p.kind}:${p.node ? `${p.node}/` : ''}${p.name}`;
export const poolName = (p) => `${KIND_NAME[p.kind]} ${p.name}${p.node ? ` (${p.node})` : ''}`;
/** Days since the last scrub (ZFS), null when it never ran or is not known */
export const scrubDays = (p) => (p.scrubAt ? Math.floor((Date.now() - Date.parse(p.scrubAt)) / 86400000) : null);

/**
 * What a sensor can watch on pools. prefix '' for hosts asked through an API (Proxmox, TrueNAS, Ceph), 'host' for
 * machines with a script: pool / hostPool (state), poolUsed (%), poolScrub (days since the last scrub), poolDown
 * (members missing: disks, OSDs).
 */
export function poolMetrics(list, prefix = '') {
  const m = (name) => (prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name);
  const out = [];
  for (const p of list || []) {
    const key = poolKey(p); const name = poolName(p);
    out.push({ metric: m('pool'), key, name, value: p.state, kind: 'state', good: p.good, text: p.good ? p.state : `${p.state}${p.text ? ` - ${p.text}` : ''}` });
    // ZFS gets slow above 80 %, Ceph refuses to write at 95 % (nearfull at 85)
    if (p.pct !== null) out.push({ metric: m('poolUsed'), key, name, value: p.pct, unit: '%', kind: 'number', op: 'ge', threshold: p.kind === 'ceph' ? 75 : 80, used: p.used, total: p.total });
    if (p.kind === 'zfs') out.push({ metric: m('poolScrub'), key, name, value: scrubDays(p), unit: 'd', kind: 'number', op: 'gt', threshold: 35 });
    if (p.down !== null) out.push({ metric: m('poolDown'), key, name, value: p.down, unit: '', kind: 'number', op: 'gt', threshold: 0 });
  }
  return out;
}
