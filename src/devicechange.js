// One place for what follows when a device changes its address, name or type - no matter who changed it (scan,
// manual edit, host script, SNMP/controller/Redfish facts). Every path calls onDeviceChanged() after it wrote the new
// values, inside its own transaction, so all of them behave the same.
//
// - new IP:   monitors whose target is the old address follow it; a monitor with a stored password is paused instead
//             (the password was entered for the old address and is never sent elsewhere without being typed again)
//             and its channels are told; back at that address it runs again;
//             the device link (web_url) follows unless it was changed in the same edit; history entry
// - new name: monitors named after the device ("NAS", "NAS - Sensor") carry the new name
// - new type: what SNMP read for the old type (NAS problems, MAC table of a switch) is dropped
import { log } from './lib/log.js';

// Monitors whose target is the address of the device itself
const ADDRESS_MONITORS = ['ping', 'tcp', 'snmp', 'smb', 'mysql', 'postgres', 'redis'];

const now = () => new Date().toISOString();

/**
 * A device link (web interface, ssh://, rdp:// ...) after an IP change: only when its host is exactly the old address
 * (192.168.1.1 → .77 must leave https://192.168.1.10/ alone). Returns the new link or null.
 */
export function followUrl(url, from, to) {
  if (!url || !from || !to) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (host !== from) return null;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = String(url).replace(new RegExp(`^([a-z][a-z0-9+.-]*://(?:[^@/?#]*@)?)${esc}(?=[:/?#]|$)`, 'i'), `$1${to}`);
  return out === url ? null : out;
}

/** Text stored as last message of a monitor paused after an IP change (English like all check results; see checktext.js) */
export const ipMovedMessage = (from, to) => `device has a new IP (${from} → ${to}) - please enter the password again`;

/**
 * Who hears about a monitor paused after an IP change: monitoring registers a sender per database (see
 * monitor/index.js), which sends the stored ipMoved event through the monitor's channels like any other alarm. Called
 * on the next turn of the event loop, i.e. after the caller's transaction was committed (or rolled back - then the
 * event row is gone and nothing is sent).
 */
const ipMovedSenders = new WeakMap();
export function onIpMovedPaused(db, fn) { if (fn) ipMovedSenders.set(db, fn); else ipMovedSenders.delete(db); }

/** The host of a monitor target (address, or URL for web checks) replaced: from → to; null when it is not that host */
function retarget(type, target, from, to) {
  if (ADDRESS_MONITORS.includes(type)) return String(target).toLowerCase() === from ? to : null;
  if (type === 'http') {
    try {
      const u = new URL(target);
      if (u.hostname === from) { u.hostname = to; return u.toString(); }
    } catch { /* not a URL */ }
  }
  return null;
}

/**
 * Monitors of a device follow it to its new address: every monitor whose target is the old address and web checks
 * whose URL points at it. A monitor with a stored password does not move: it is paused with a note (last_message and
 * data.ipMoved) and an event (also sent to its channels), so that the user enters the password again for the new
 * address. A monitor paused that way follows the device on (data.ipMoved.to is where the device is now), and when
 * the device comes back to the address the password was entered for, the note goes and the monitor runs again.
 * Returns { moved, paused, resumed }.
 */
export function moveMonitors(db, deviceId, from, to, ts = now()) {
  let moved = 0;
  const paused = [];
  const resumed = [];
  const events = [];
  for (const mon of db.prepare('SELECT id, name, type, target, secret, enabled, data FROM monitors WHERE device_id=?').all(deviceId)) {
    let data = {};
    try { data = JSON.parse(mon.data) || {}; } catch { /* broken JSON: start over */ }
    const prev = mon.secret && !mon.enabled && data.ipMoved && typeof data.ipMoved === 'object' ? data.ipMoved : null;
    if (prev) {
      // Already paused after an earlier change: the target still names the address of the password (prev.from); the
      // device is now at prev.to - only a change away from there concerns this monitor
      if (String(prev.to || '').toLowerCase() !== from) continue;
      const origin = prev.from;
      if (origin && String(origin).toLowerCase() === String(to).toLowerCase()) {
        // Back at the address the password belongs to: nothing to type again
        const { ipMoved, ...rest } = data;
        db.prepare("UPDATE monitors SET enabled=1, status='pending', status_since=?, fail_count=0, last_message='', data=?, updated_at=? WHERE id=?")
          .run(ts, JSON.stringify(rest), ts, mon.id);
        resumed.push({ id: mon.id, name: mon.name });
        continue;
      }
      const target = retarget(mon.type, prev.target || mon.target, from, to) || retarget(mon.type, mon.target, String(origin || '').toLowerCase(), to) || to;
      db.prepare('UPDATE monitors SET last_message=?, data=?, updated_at=? WHERE id=?')
        .run(ipMovedMessage(origin, to), JSON.stringify({ ...data, ipMoved: { from: origin, to, target, at: ts } }), ts, mon.id);
      const ev = db.prepare('INSERT INTO monitor_events(monitor_id,at,kind,message,notified) VALUES(?,?,?,?,?)').run(mon.id, ts, 'ipMoved', `${origin} → ${to}`, '');
      events.push({ monitorId: mon.id, eventId: Number(ev.lastInsertRowid), from: origin, to });
      paused.push({ id: mon.id, name: mon.name });
      continue;
    }
    const target = retarget(mon.type, mon.target, from, to);
    if (!target) continue;
    if (mon.secret) {
      db.prepare("UPDATE monitors SET enabled=0, status='paused', status_since=?, fail_count=0, last_message=?, data=?, updated_at=? WHERE id=?")
        .run(ts, ipMovedMessage(from, to), JSON.stringify({ ...data, ipMoved: { from, to, target, at: ts } }), ts, mon.id);
      const ev = db.prepare('INSERT INTO monitor_events(monitor_id,at,kind,message,notified) VALUES(?,?,?,?,?)').run(mon.id, ts, 'ipMoved', `${from} → ${to}`, '');
      events.push({ monitorId: mon.id, eventId: Number(ev.lastInsertRowid), from, to });
      paused.push({ id: mon.id, name: mon.name });
      continue;
    }
    moved += db.prepare('UPDATE monitors SET target=?, updated_at=? WHERE id=?').run(target, ts, mon.id).changes;
  }
  if (paused.length) log.info(`Device ${deviceId} moved from ${from} to ${to}: ${paused.length} monitor(s) with a stored password paused until the password is entered again`);
  if (resumed.length) log.info(`Device ${deviceId} is back at ${to}: ${resumed.length} paused monitor(s) with a stored password run again`);
  const send = ipMovedSenders.get(db);
  if (send && events.length) setImmediate(() => { Promise.resolve().then(() => send(events)).catch((e) => log.warn(`Notification about paused monitors failed: ${e.message}`)); });
  return { moved, paused, resumed };
}

/**
 * Monitors and sensors of the device carry its name ("NAS", "NAS - Sensor") - they follow a new name, so an alarm
 * names the device as it is called now. A monitor named by hand without the old name stays as it is.
 */
export function renameMonitors(db, deviceId, from, to, ts = now()) {
  let n = 0;
  for (const m of db.prepare('SELECT id, name FROM monitors WHERE device_id=?').all(deviceId)) {
    // Only the device name at the start, as a whole word ("NAS", "NAS: Web", "NAS - Sensor") - never inside
    // another word ("SNAS Web", "NASA")
    if (!m.name.startsWith(from) || !(m.name.length === from.length || /^[\s:-]/.test(m.name.slice(from.length)))) continue;
    const name = (to + m.name.slice(from.length)).slice(0, 120);
    if (name === m.name) continue;
    n += db.prepare('UPDATE monitors SET name=?, updated_at=? WHERE id=?').run(name, ts, m.id).changes;
  }
  return n;
}

/**
 * Called after a device row was written. before/after: { id, ip, name, type, web_url } (after = the stored values).
 * source: 'scan' | 'manual' | 'SNMP' | 'script' | 'controller' | 'redfish' (also the user in history entries of
 * non-manual sources). Options: user (for history), ts, ipHistory (false when the caller already recorded the new
 * address, e.g. in the history entry of a manual edit), webUrlEdited (the link was changed in the same edit - then it
 * does not follow). Returns { moved, paused, resumed, renamed, webUrl }.
 */
export function onDeviceChanged(db, before, after, source, { user = '', ts = now(), ipHistory = true, webUrlEdited = false } = {}) {
  const out = { moved: 0, paused: [], resumed: [], renamed: 0, webUrl: null };
  if (!before || !after) return out;
  const id = after.id ?? before.id;
  const hist = db.prepare('INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,?,?,?)');
  const who = user || (source === 'manual' ? '' : source);

  if (before.ip !== after.ip && after.ip) {
    if (ipHistory) hist.run(id, ts, who, 'ip', JSON.stringify({ field: 'ip', from: before.ip ?? null, to: after.ip }));
    if (before.ip) {
      const r = moveMonitors(db, id, before.ip, after.ip, ts);
      out.moved = r.moved;
      out.paused = r.paused;
      out.resumed = r.resumed;
      if (r.paused.length) hist.run(id, ts, who, 'monitorsPaused', JSON.stringify({ from: before.ip, to: after.ip, monitors: r.paused.map((m) => m.name) }));
      const u = !webUrlEdited ? followUrl(after.web_url, before.ip, after.ip) : null;
      if (u) { db.prepare('UPDATE devices SET web_url=? WHERE id=?').run(u, id); out.webUrl = u; }
    }
  }
  if (before.name && after.name && before.name !== after.name) out.renamed = renameMonitors(db, id, before.name, after.name, ts);
  if (before.type !== after.type && before.type !== undefined && after.type !== undefined) {
    db.prepare('DELETE FROM snmp_status WHERE device_id=?').run(id);
    db.prepare('DELETE FROM switch_macs WHERE switch_id=?').run(id);
  }
  return out;
}
