// No monitor or sensor twice. Two entries are the same when they watch the same thing:
//   sensor   the same value (metric + key) of the same device
//   proxmox  the same value of the same hypervisor
//   http     the same address (scheme, host, port, path) and the same keyword
//   tcp/ping/snmp/smb/databases  the same host (and port, OID, share, database)
//   docker   the same container on the same Docker host
// A host typed as its name or as its IP counts as the same host when an inventory device has that name and address.
// Several services on one server (web interface, SSH, a database …) are different things and all stay possible.
//
// Creating or changing a monitor into one that exists already is refused (err.monitorExists, with the name of the
// one there is). Duplicates from before are merged once: the one that runs (else the oldest) stays and takes over
// dependencies, maintenance windows and reports; the others are deleted.
import { log } from '../lib/log.js';

const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };
const DONE = 'monitors.deduped';
const DEFAULT_HTTP_PORT = { 'http:': '80', 'https:': '443' };

/** Host names and addresses of the inventory → the device they belong to */
export function hostIndex(db) {
  const map = new Map();
  for (const d of db.prepare('SELECT id, ip, hostname FROM devices').all()) {
    const add = (x) => { const k = String(x ?? '').trim().toLowerCase().replace(/\.$/, ''); if (k && !map.has(k)) map.set(k, d.id); };
    add(d.ip);
    add(d.hostname);
    if (d.hostname && d.hostname.includes('.')) add(d.hostname.split('.')[0]);
  }
  return map;
}

function hostKey(index, host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const dev = index.get(h) ?? (h.includes('.') && !/^\d+(\.\d+){3}$/.test(h) ? index.get(h.split('.')[0]) : undefined);
  return dev !== undefined ? `dev:${dev}` : h;
}

/** What a monitor watches, as one string - equal strings = the same thing */
export function fingerprint(m, index) {
  const o = typeof m.options === 'string' ? parse(m.options) : (m.options || {});
  const key = (x) => String(x ?? '');
  switch (m.type) {
    case 'sensor': return `sensor|${m.device_id}|${o.metric}|${key(o.key)}`;
    case 'proxmox': return `proxmox|${o.host}|${o.metric}|${key(o.key)}`;
    case 'http': {
      let u;
      try { u = new URL(m.target); } catch { return `http|${String(m.target).toLowerCase()}|${m.http_keyword || ''}`; }
      const port = u.port || DEFAULT_HTTP_PORT[u.protocol] || '';
      const pathQ = `${u.pathname.replace(/\/+$/, '') || ''}${u.search}`;
      return `http|${u.protocol}|${hostKey(index, u.hostname)}|${port}|${pathQ}|${m.http_keyword || ''}`;
    }
    case 'tcp': return `tcp|${hostKey(index, m.target)}|${m.port}`;
    case 'ping': return `ping|${hostKey(index, m.target)}`;
    case 'snmp': return `snmp|${hostKey(index, m.target)}|${m.port}|${o.oid}`;
    case 'smb': return `smb|${hostKey(index, m.target)}|${String(o.share || '').toLowerCase()}|${String(o.path || '').toLowerCase()}`;
    case 'docker': return `docker|${m.docker_host_id}|${m.target}`;
    default: return `${m.type}|${hostKey(index, m.target)}|${m.port}|${String(o.database || '').toLowerCase()}`;
  }
}

/** The monitor that watches the same thing as `m` already (null: none). exceptId = the one being changed. */
export function findSame(db, m, exceptId = null) {
  const index = hostIndex(db);
  const fp = fingerprint(m, index);
  for (const x of db.prepare('SELECT id, name, type, target, port, device_id, options, http_keyword, docker_host_id FROM monitors WHERE type=?').all(m.type)) {
    if (x.id !== exceptId && fingerprint(x, index) === fp) return x;
  }
  return null;
}

/** id `from` → `to` in a JSON list column of every row (no id twice afterwards) */
function replaceId(db, table, column, from, to) {
  for (const row of db.prepare(`SELECT id, ${column} v FROM ${table} WHERE ${column} <> '[]'`).all()) {
    const list = parse(row.v, []);
    if (!Array.isArray(list) || !list.some((x) => Number(x) === from)) continue;
    const next = [...new Set(list.map((x) => (Number(x) === from ? to : Number(x))))];
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(JSON.stringify(next), row.id);
  }
}

/** Merges duplicates: returns [{ kept, removed: [ids], name }] */
export function mergeDuplicates(db) {
  const index = hostIndex(db);
  const groups = new Map();
  const all = db.prepare(`SELECT m.id, m.name, m.type, m.target, m.port, m.device_id, m.options, m.http_keyword, m.docker_host_id, m.enabled,
    (SELECT COUNT(*) FROM checks c WHERE c.monitor_id=m.id) checks FROM monitors m ORDER BY m.id`).all();
  for (const m of all) {
    const fp = fingerprint(m, index);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(m);
  }
  const out = [];
  db.transaction(() => {
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      // the one that runs, then the one with the longer history, then the oldest
      const keep = [...list].sort((a, b) => b.enabled - a.enabled || b.checks - a.checks || a.id - b.id)[0];
      const drop = list.filter((m) => m.id !== keep.id);
      for (const m of drop) {
        db.prepare('UPDATE monitors SET parent_id=? WHERE parent_id=? AND id<>?').run(keep.id, m.id, keep.id);
        replaceId(db, 'maintenance', 'monitor_ids', m.id, keep.id);
        replaceId(db, 'reports', 'monitor_ids', m.id, keep.id);
        db.prepare('DELETE FROM monitors WHERE id=?').run(m.id);
      }
      // a monitor must not end up behind itself
      db.prepare('UPDATE monitors SET parent_id=NULL WHERE id=? AND parent_id=?').run(keep.id, keep.id);
      out.push({ kept: keep.id, removed: drop.map((m) => m.id), name: keep.name });
    }
  })();
  return out;
}

/** Once per database (after the update that brought it) */
export function mergeDuplicatesOnce(db, settings) {
  if (settings.get(DONE)) return [];
  const out = mergeDuplicates(db);
  settings.set(DONE, true);
  if (out.length) {
    const n = out.reduce((s, g) => s + g.removed.length, 0);
    log.info(`Duplicate monitors/sensors merged: ${n} removed (${out.map((g) => g.name).join(', ').slice(0, 300)})`);
    try {
      db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), 'system', 'monitor.dedupe',
        `${n} duplicate(s) removed: ${out.map((g) => `${g.name} (kept #${g.kept}, removed #${g.removed.join(', #')})`).join('; ')}`.slice(0, 500));
    } catch { /* never stops */ }
  }
  return out;
}
