// Search over everything (Ctrl+K): devices, monitors and sensors, locations, hypervisors, users - each only what the
// user may see (locations of a limited user; servers, users only with the right role). A few hits per group, newest
// state; one query per group with LIKE (also with many thousand devices quick, no row-by-row work).
import { inScope } from './auth/scope.js';

const PER_GROUP = 8;
const SENSOR_TYPES = ['sensor', 'snmp', 'proxmox'];

/** "50%_x" → a LIKE pattern that finds exactly this text anywhere */
const likeOf = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Exact or leading matches first, then by name */
function rank(rows, q, keys) {
  const n = q.toLowerCase();
  const score = (r) => {
    const vals = keys.map((k) => String(r[k] ?? '').toLowerCase());
    if (vals.some((v) => v === n)) return 0;
    if (vals.some((v) => v.startsWith(n))) return 1;
    return 2;
  };
  return rows.map((r) => [score(r), r]).sort((a, b) => a[0] - b[0] || String(a[1].name).localeCompare(String(b[1].name))).map(([, r]) => r);
}

/**
 * @param user  the signed-in user (role, flags from userOut)
 * @param scope Set of location ids of a limited user, null = all
 */
export function searchAll(db, q, { user, scope = null } = {}) {
  const text = String(q ?? '').trim().slice(0, 100);
  if (text.length < 2) return { q: text, devices: [], monitors: [], sensors: [], locations: [], hosts: [], users: [] };
  const like = likeOf(text);
  const esc = "ESCAPE '\\'";

  // devices: name, address, MAC (also without separators), host name, serial, owner, tags
  const macLike = /^[0-9a-f:.-]{4,}$/i.test(text) ? likeOf(text.replace(/[:.-]/g, '').toLowerCase()) : null;
  const devRows = db.prepare(`SELECT d.id, d.name, d.ip, d.mac, d.hostname, d.type, d.serial, d.owner, d.location_id, l.name location
    FROM devices d LEFT JOIN locations l ON l.id=d.location_id
    WHERE d.name LIKE @like ${esc} OR d.ip LIKE @like ${esc} OR d.mac LIKE @like ${esc} OR d.hostname LIKE @like ${esc} OR d.serial LIKE @like ${esc}
      OR d.owner LIKE @like ${esc} OR d.tags LIKE @like ${esc}${macLike ? ` OR lower(replace(replace(replace(d.mac,':',''),'-',''),'.','')) LIKE @mac ${esc}` : ''}
    LIMIT 400`).all({ like, mac: macLike });
  const devices = rank(devRows.filter((d) => inScope(scope, d.location_id)), text, ['name', 'ip', 'hostname', 'mac'])
    .slice(0, PER_GROUP).map((d) => ({ id: d.id, name: d.name, ip: d.ip || '', type: d.type, location: d.location || '' }));

  // monitors and sensors: name, target, group; a limited user sees those of his devices only
  const monRows = db.prepare(`SELECT m.id, m.name, m.type, m.target, m.status, m.enabled, m.group_name, d.location_id, d.name device
    FROM monitors m LEFT JOIN devices d ON d.id=m.device_id
    WHERE m.name LIKE @like ${esc} OR m.target LIKE @like ${esc} OR m.group_name LIKE @like ${esc} OR d.name LIKE @like ${esc}
    LIMIT 400`).all({ like });
  const visible = monRows.filter((m) => !scope || (m.location_id !== null && inScope(scope, m.location_id)));
  const shape = (m) => ({ id: m.id, name: m.name, type: m.type, status: m.enabled ? m.status : 'paused', device: m.device || '', group: m.group_name || '' });
  const ranked = rank(visible, text, ['name', 'target']);
  const monitors = ranked.filter((m) => !SENSOR_TYPES.includes(m.type)).slice(0, PER_GROUP).map(shape);
  const sensors = ranked.filter((m) => SENSOR_TYPES.includes(m.type)).slice(0, PER_GROUP).map(shape);

  const locations = rank(db.prepare(`SELECT id, name FROM locations WHERE name LIKE @like ${esc} LIMIT 100`).all({ like })
    .filter((l) => inScope(scope, l.id)), text, ['name']).slice(0, PER_GROUP);

  // hypervisors, backup servers, controllers, hardware, cloud: only for who may see these pages
  const hosts = user && user.role !== 'viewer'
    ? rank(db.prepare(`SELECT id, name, kind FROM proxmox_hosts WHERE name LIKE @like ${esc} OR url LIKE @like ${esc} LIMIT 100`).all({ like }), text, ['name'])
      .slice(0, PER_GROUP)
    : [];

  const users = user?.role === 'admin'
    ? rank(db.prepare(`SELECT id, username, display_name FROM users WHERE username LIKE @like ${esc} OR display_name LIKE @like ${esc} LIMIT 50`).all({ like })
      .map((u) => ({ id: u.id, name: u.display_name || u.username, username: u.username })), text, ['name', 'username']).slice(0, PER_GROUP)
    : [];

  return { q: text, devices, monitors, sensors, locations, hosts, users };
}
