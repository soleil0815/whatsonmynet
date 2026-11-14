// Inventory: devices the admin has chosen to keep, their history, and how scan results are matched to them.
//
// A device is recognised by its MAC address (stays the same when the IP changes). Devices without MAC (only in
// routed subnets without SNMP/NetBIOS) are recognised by their IP address.
// After every scan: known devices get their new IP, host name and last-seen time automatically (with an entry in
// the history); new devices only appear in the scan result until the admin adopts or ignores them.
import { HttpError, line, str, isoDate, oneOf } from './lib/http.js';
import { normalizeMac, isIPv4, ipSortKey, cidrContains } from './lib/net.js';
import { TYPES, isTelematik, suggestName } from './scan/classify.js';
import { bestWebUrl } from './scan/engine.js';
import { forgetDevices } from './lib/idlists.js';
import { log } from './lib/log.js';

const EDITABLE = ['name', 'type', 'vendor', 'model', 'ip', 'mac', 'hostname', 'os', 'location_id', 'owner', 'notes', 'tags',
  'web_url', 'serial', 'supplier', 'purchase_date', 'warranty_until', 'maintenance_until'];

const now = () => new Date().toISOString();
const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };

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

// Monitors whose target is the address of the device itself
const ADDRESS_MONITORS = ['ping', 'tcp', 'snmp', 'smb', 'mysql', 'postgres', 'redis'];

export function createInventory(db) {
  const getDevice = db.prepare('SELECT * FROM devices WHERE id=?');
  const byMac = db.prepare('SELECT * FROM devices WHERE mac=?');
  const byIpNoMac = db.prepare('SELECT * FROM devices WHERE ip=? AND mac IS NULL');
  const getResult = db.prepare('SELECT * FROM scan_results WHERE id=?');
  const isIgnored = db.prepare('SELECT id FROM ignored WHERE (mac IS NOT NULL AND mac=?) OR (mac IS NULL AND ip=?)');
  const addHistory = db.prepare('INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,?,?,?)');

  /** Takes a device off the ignore list: by MAC, or by IP for devices without MAC. */
  function unlistIgnored(mac, ip) {
    if (mac) db.prepare('DELETE FROM ignored WHERE mac=?').run(mac);
    else db.prepare('DELETE FROM ignored WHERE mac IS NULL AND ip=?').run(ip);
  }

  function history(deviceId, kind, detail, user = '') {
    addHistory.run(deviceId, now(), user, kind, JSON.stringify(detail || {}));
  }

  function shape(d) {
    if (!d) return null;
    const facts = parse(d.facts);
    return { ...d, facts, telematik: isTelematik(d.type) };
  }

  /** Matches one scan result against the inventory and updates the device if it is known. */
  function applyResult(resultId, { deep = false, onlyLocation = null } = {}) {
    const r = getResult.get(resultId);
    if (!r) return;
    const mac = normalizeMac(r.mac);
    let device = mac ? byMac.get(mac) : null;
    if (!device) device = byIpNoMac.get(r.ip) || null;
    // Results of a scan agent only ever change devices of its own location (a branch office must not be able to move
    // the firewall of the head office to an address of its own by reporting that MAC)
    if (device && onlyLocation !== null && device.location_id !== onlyLocation) device = null;
    if (!device) {
      const ign = isIgnored.get(mac, r.ip);
      db.prepare('UPDATE scan_results SET status=? WHERE id=?').run(ign ? 'ignored' : 'new', resultId);
      return;
    }
    const facts = parse(r.facts);
    const changes = [];
    const ts = now();
    // A light scan knows little: it must not replace what a full scan found (ports, SNMP, classification ...)
    const merged = facts.light ? { ...parse(device.facts), ...(facts.netbios ? { netbios: facts.netbios } : {}), lightSeen: ts } : { ...parse(device.facts), ...facts };
    const set = { last_seen: ts, facts: JSON.stringify(merged), updated_at: ts };
    if (device.ip !== r.ip) { changes.push({ field: 'ip', from: device.ip, to: r.ip }); set.ip = r.ip; }
    if (!device.mac && mac) { changes.push({ field: 'mac', from: null, to: mac }); set.mac = mac; }
    if (r.hostname && device.hostname !== r.hostname) {
      if (device.hostname) changes.push({ field: 'hostname', from: device.hostname, to: r.hostname });
      set.hostname = r.hostname;
    }
    if (!device.vendor && r.vendor) set.vendor = r.vendor;
    if (!device.os && facts.classification?.os && !facts.light) set.os = facts.classification.os;
    if (!device.web_url) { const u = bestWebUrl(r.ip, facts, device.type); if (u) set.web_url = u; }
    else if (set.ip) { const u = followUrl(device.web_url, device.ip, r.ip); if (u) set.web_url = u; }
    const keys = Object.keys(set);
    db.transaction(() => {
      db.prepare(`UPDATE devices SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => set[k]), device.id);
      for (const c of changes) history(device.id, c.field === 'ip' ? 'ip' : 'change', c, 'scan');
      // Monitors of this device follow the new address
      if (set.ip && device.ip) moveMonitors(device.id, device.ip, set.ip, ts);
      if (deep) history(device.id, 'deep', { ports: facts.ports?.length || 0 }, 'scan');
      db.prepare('UPDATE scan_results SET status=?, device_id=? WHERE id=?').run(changes.some((c) => c.field === 'ip' || c.field === 'mac') ? 'changed' : 'known', device.id, resultId);
    })();
  }

  /**
   * Monitors of a device follow it to its new address: every monitor whose target is the old address and web checks
   * whose URL points at it. A monitor with a stored password stays where it is - the password was entered for that
   * address and is never sent to another one without being typed in again (a spoofed MAC or an edited address must
   * not lure it elsewhere). Returns { moved, kept }.
   */
  function moveMonitors(deviceId, from, to, ts = now()) {
    let moved = 0;
    const kept = [];
    for (const mon of db.prepare('SELECT id, name, type, target, secret FROM monitors WHERE device_id=?').all(deviceId)) {
      let target = null;
      if (ADDRESS_MONITORS.includes(mon.type) && String(mon.target).toLowerCase() === from) target = to;
      else if (mon.type === 'http') {
        try {
          const u = new URL(mon.target);
          if (u.hostname === from) { u.hostname = to; target = u.toString(); }
        } catch { /* not a URL */ }
      }
      if (!target) continue;
      if (mon.secret) { kept.push(mon.name); continue; }
      moved += db.prepare('UPDATE monitors SET target=?, updated_at=? WHERE id=?').run(target, ts, mon.id).changes;
    }
    if (kept.length) log.info(`Device ${deviceId} moved from ${from} to ${to}: ${kept.length} monitor(s) with a stored password stay at the old address`);
    return { moved, kept: kept.length };
  }

  function finishScan(scanId) {
    db.prepare("UPDATE scan_results SET status='new' WHERE scan_id=? AND status='pending'").run(scanId);
  }

  function create(input, user = '') {
    const v = cleanDevice(input);
    if (!v.name) throw new HttpError(400, 'err.nameRequired');
    if (v.mac && byMac.get(v.mac)) throw new HttpError(409, 'err.macExists');
    const ts = now();
    const facts = input.facts && typeof input.facts === 'object' ? input.facts : {};
    const cols = { ...v, facts: JSON.stringify(facts), created_at: ts, updated_at: ts, first_seen: input.first_seen || null, last_seen: input.last_seen || null };
    const keys = Object.keys(cols);
    const id = db.prepare(`INSERT INTO devices(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k])).lastInsertRowid;
    history(id, 'created', { source: input.source || 'manual' }, user);
    return get(id);
  }

  function cleanDevice(input, { partial = false } = {}) {
    const out = {};
    for (const k of EDITABLE) {
      if (partial && !(k in input)) continue;
      const v = input[k];
      switch (k) {
        case 'type': out.type = oneOf(v, TYPES, 'unknown'); break;
        case 'ip': {
          const ip = line(v, 15);
          if (ip && !isIPv4(ip)) throw new HttpError(400, 'err.ip', undefined, 'ip');
          out.ip = ip || null; break;
        }
        case 'mac': {
          const raw = line(v, 40);
          const mac = raw ? normalizeMac(raw) : null;
          if (raw && !mac) throw new HttpError(400, 'err.mac', undefined, 'mac');
          out.mac = mac; break;
        }
        case 'location_id': {
          const id = v === null || v === '' || v === undefined ? null : Number(v);
          if (id !== null && !db.prepare('SELECT 1 FROM locations WHERE id=?').get(id)) throw new HttpError(400, 'err.location', undefined, 'location_id');
          out.location_id = id; break;
        }
        case 'purchase_date': case 'warranty_until': case 'maintenance_until': {
          const d = isoDate(v);
          if (!d && v !== null && v !== undefined && String(v).trim() !== '') throw new HttpError(400, 'err.date', undefined, k);
          out[k] = d; break;
        }
        case 'notes': out.notes = str(v, 5000); break;
        case 'web_url': {
          const u = line(v, 500);
          if (u && !/^(https?|ssh|rdp|vnc):\/\/[^\s"'<>]+$/i.test(u)) throw new HttpError(400, 'err.url', undefined, 'web_url');
          out.web_url = u; break;
        }
        case 'tags': out.tags = line(v, 300).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20).join(', '); break;
        case 'name': out.name = line(v, 120); break;
        default: out[k] = line(v, 200);
      }
    }
    return out;
  }

  function get(id) {
    return shape(getDevice.get(id));
  }

  function update(id, input, user = '') {
    const cur = getDevice.get(id);
    if (!cur) throw new HttpError(404, 'err.notFound');
    const v = cleanDevice(input || {}, { partial: true });
    if ('name' in v && !v.name) throw new HttpError(400, 'err.nameRequired');
    if (v.mac && v.mac !== cur.mac && byMac.get(v.mac)) throw new HttpError(409, 'err.macExists');
    const changed = Object.keys(v).filter((k) => (v[k] ?? null) !== (cur[k] ?? null));
    if (!changed.length) return get(id);
    let renamed = 0;
    db.transaction(() => {
      const ts = now();
      db.prepare(`UPDATE devices SET ${changed.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...changed.map((k) => v[k]), ts, id);
      history(id, 'edit', { fields: changed.map((k) => ({ field: k, from: k === 'notes' ? undefined : cur[k], to: k === 'notes' ? undefined : v[k] })) }, user);
      // Monitors and sensors of the device carry its name ("NAS", "NAS - Sensor") - they follow a new name, so an alarm
      // names the device as it is called now. A monitor named by hand without the old name stays as it is.
      if (changed.includes('name') && cur.name) renamed = renameMonitors(id, cur.name, v.name);
      // A new address typed in: monitors and the web link (unless changed in the same edit) follow, as after a scan
      if (changed.includes('ip') && cur.ip && v.ip) {
        moveMonitors(id, cur.ip, v.ip, ts);
        const u = !changed.includes('web_url') ? followUrl(cur.web_url, cur.ip, v.ip) : null;
        if (u) db.prepare('UPDATE devices SET web_url=? WHERE id=?').run(u, id);
      }
      // Another type: what SNMP read for the old type (NAS problems, MAC table of a switch) no longer applies - it
      // would stay on the dashboard for good. The next poll reads it again if the device is of such a type.
      if (changed.includes('type')) {
        db.prepare('DELETE FROM snmp_status WHERE device_id=?').run(id);
        db.prepare('DELETE FROM switch_macs WHERE switch_id=?').run(id);
      }
    })();
    return renamed ? { ...get(id), renamedMonitors: renamed } : get(id);
  }

  function renameMonitors(deviceId, from, to) {
    let n = 0;
    for (const m of db.prepare('SELECT id, name FROM monitors WHERE device_id=?').all(deviceId)) {
      // Only the device name at the start, as a whole word ("NAS", "NAS: Web", "NAS - Sensor") - never inside
      // another word ("SNAS Web", "NASA")
      if (!m.name.startsWith(from) || !(m.name.length === from.length || /^[\s:-]/.test(m.name.slice(from.length)))) continue;
      const name = (to + m.name.slice(from.length)).slice(0, 120);
      if (name === m.name) continue;
      n += db.prepare('UPDATE monitors SET name=?, updated_at=? WHERE id=?').run(name, now(), m.id).changes;
    }
    return n;
  }

  function remove(id) {
    db.transaction(() => {
      const mons = db.prepare('SELECT id FROM monitors WHERE device_id=?').all(id).map((m) => m.id);
      if (!db.prepare('DELETE FROM devices WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
      forgetDevices(db, [id], mons);
    })();
  }

  /** Last finished network scans with their subnets - to tell whether a device was seen in the latest scan */
  function coverage() {
    return db.prepare("SELECT id, started_at, targets FROM scans WHERE kind='network' AND status='done' ORDER BY id DESC LIMIT 50").all()
      .map((s) => ({ ...s, targets: parse(s.targets, []) }));
  }

  /** 'online' (seen in the newest scan of its subnet), 'missing' (not seen), 'unknown' (not scanned since) */
  function presence(d, scans) {
    if (!d.ip) return 'unknown';
    const s = scans.find((x) => x.targets.some((t) => cidrContains(t.cidr, d.ip)));
    if (!s || (d.created_at > s.started_at && !d.last_seen)) return 'unknown';
    return d.last_seen && d.last_seen >= s.started_at ? 'online' : (d.created_at > s.started_at ? 'unknown' : 'missing');
  }

  /** allowed: Set of location ids the user may see (null = all) */
  function list({ q = '', type = '', location = '', tag = '', allowed = null } = {}) {
    const rows = db.prepare('SELECT d.*, l.name location_name FROM devices d LEFT JOIN locations l ON l.id=d.location_id').all();
    const scans = coverage();
    const needle = String(q).trim().toLowerCase();
    return rows.filter((d) => {
      if (allowed && !allowed.has(d.location_id)) return false;
      if (type === 'telematik' ? !isTelematik(d.type) : type && d.type !== type) return false;
      if (location === 'none' ? d.location_id : location && String(d.location_id) !== String(location)) return false;
      if (tag && !d.tags.toLowerCase().split(/,\s*/).includes(String(tag).toLowerCase())) return false;
      if (!needle) return true;
      return [d.name, d.ip, d.mac, d.hostname, d.vendor, d.model, d.os, d.owner, d.tags, d.notes, d.serial, d.location_name]
        .some((x) => String(x || '').toLowerCase().includes(needle));
    }).map((d) => {
      const { facts, ...rest } = d;
      const f = parse(facts);
      return { ...rest, ports: f.ports || [], telematik: isTelematik(d.type), presence: presence(d, scans) };
    }).sort((a, b) => ipSortKey(a.ip) - ipSortKey(b.ip) || a.name.localeCompare(b.name));
  }

  function historyOf(id) {
    return db.prepare('SELECT * FROM device_history WHERE device_id=? ORDER BY id DESC LIMIT 200').all(id).map((h) => ({ ...h, detail: parse(h.detail) }));
  }

  /**
   * When was this device seen by the scans? Not "now": adopted from an older scan it would count as online although
   * the newest scan did not see it. First and last scan that found it (by MAC, without MAC by address).
   */
  function seenTimes(r, mac) {
    const own = db.prepare('SELECT started_at FROM scans WHERE id=?').get(r.scan_id)?.started_at || now();
    const row = mac
      ? db.prepare('SELECT MIN(s.started_at) first, MAX(s.started_at) last FROM scan_results x JOIN scans s ON s.id=x.scan_id WHERE x.mac IN (?,?)').get(mac, r.mac || mac)
      : db.prepare('SELECT MIN(s.started_at) first, MAX(s.started_at) last FROM scan_results x JOIN scans s ON s.id=x.scan_id WHERE x.mac IS NULL AND x.ip=?').get(r.ip);
    return { first: row?.first && row.first < own ? row.first : own, last: row?.last && row.last > own ? row.last : own };
  }

  /** Adopts scan results into the inventory (optional type/name per result chosen in the UI). */
  function adopt(resultIds, overrides = {}, user = '') {
    const created = [];
    db.transaction(() => {
      for (const rid of resultIds) {
        const r = getResult.get(rid);
        if (!r || r.device_id || r.status === 'known' || r.status === 'changed') continue;
        const facts = parse(r.facts);
        const mac = normalizeMac(r.mac);
        if (mac && byMac.get(mac)) continue;
        // Without MAC the address is the identity: the same device from another scan (or twice in this call) is no
        // second device
        if (!mac && byIpNoMac.get(r.ip)) continue;
        const o = overrides[rid] || {};
        const type = TYPES.includes(o.type) ? o.type : r.detected_type;
        const seen = seenTimes(r, mac);
        const d = create({
          name: line(o.name, 120) || suggestName({ ...r, facts, model: facts.classification?.model }),
          type, vendor: r.vendor, model: facts.classification?.model || '', ip: r.ip, mac, hostname: r.hostname,
          os: facts.classification?.os || '', location_id: r.location_id, web_url: bestWebUrl(r.ip, facts, type),
          facts, first_seen: seen.first, last_seen: seen.last, source: 'scan',
        }, user);
        db.prepare("UPDATE scan_results SET device_id=?, handled='adopted', status='known' WHERE id=?").run(d.id, rid);
        // What the scan guessed (model, OS, manufacturer from the MAC) may be replaced by what the device itself reports
        const guessed = Object.fromEntries(['vendor', 'model', 'os', 'type'].filter((k) => d[k]).map((k) => [k, d[k]]));
        if (Object.keys(guessed).length) db.prepare('UPDATE devices SET auto_fields=? WHERE id=?').run(JSON.stringify(guessed), d.id);
        // Remove the device from the ignore list if it was there (devices without MAC are on it by IP)
        unlistIgnored(mac, r.ip);
        created.push(d.id);
      }
    })();
    return created;
  }

  function ignore(resultIds, user = '') {
    let n = 0;
    db.transaction(() => {
      for (const rid of resultIds) {
        const r = getResult.get(rid);
        if (!r || r.device_id) continue;
        const mac = normalizeMac(r.mac);
        // A stale result of a device that is in the inventory by now: ignoring it must not put that device on the list
        if (mac ? byMac.get(mac) : byIpNoMac.get(r.ip)) continue;
        const label = [r.hostname, r.vendor].filter(Boolean).join(' - ').slice(0, 200);
        if (mac) db.prepare('INSERT INTO ignored(mac,ip,label,created_at,created_by) VALUES(?,?,?,?,?) ON CONFLICT(mac) DO UPDATE SET ip=excluded.ip').run(mac, r.ip, label, now(), user);
        else if (!isIgnored.get(null, r.ip)) db.prepare('INSERT INTO ignored(mac,ip,label,created_at,created_by) VALUES(NULL,?,?,?,?)').run(r.ip, label, now(), user);
        db.prepare("UPDATE scan_results SET handled='ignored', status='ignored' WHERE id=?").run(rid);
        n++;
      }
    })();
    return n;
  }

  /** Takes ignored scan results off the ignore list; in this scan they count as new again (to adopt or ignore). */
  function unignore(resultIds) {
    let n = 0;
    db.transaction(() => {
      for (const rid of resultIds) {
        const r = getResult.get(rid);
        if (!r || r.device_id || r.status !== 'ignored') continue;
        unlistIgnored(normalizeMac(r.mac), r.ip);
        db.prepare("UPDATE scan_results SET handled=NULL, status='new' WHERE id=?").run(rid);
        n++;
      }
    })();
    return n;
  }

  function stats({ allowed = null } = {}) {
    const devices = list({ allowed });
    const byType = {};
    for (const d of devices) byType[d.type] = (byType[d.type] || 0) + 1;
    const lastScan = db.prepare("SELECT * FROM scans WHERE kind IN ('network','light') AND status IN ('done','cancelled','failed') ORDER BY id DESC LIMIT 1").get();
    const waiting = lastScan ? db.prepare("SELECT location_id FROM scan_results WHERE scan_id=? AND status='new' AND handled IS NULL").all(lastScan.id)
      .filter((r) => !allowed || allowed.has(r.location_id)).length : 0;
    const seeDevice = new Set(devices.map((d) => d.id));
    return {
      devices: devices.length,
      online: devices.filter((d) => d.presence === 'online').length,
      missing: devices.filter((d) => d.presence === 'missing').length,
      telematik: devices.filter((d) => d.telematik).length,
      byType,
      waiting,
      lastScan: lastScan ? { ...lastScan, stats: parse(lastScan.stats), targets: parse(lastScan.targets, []) } : null,
      locations: db.prepare('SELECT COUNT(*) n FROM locations').get().n,
      recent: db.prepare(`SELECT h.*, d.name device_name FROM device_history h JOIN devices d ON d.id=h.device_id
        ORDER BY h.id DESC LIMIT 200`).all().filter((h) => seeDevice.has(h.device_id)).slice(0, 12).map((h) => ({ ...h, detail: parse(h.detail) })),
      warranty: devices.filter((d) => d.warranty_until && d.warranty_until <= new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10))
        .map((d) => ({ id: d.id, name: d.name, warranty_until: d.warranty_until })).slice(0, 10),
    };
  }

  /** Values already used in the inventory - for suggestions while typing (most used first) */
  function suggestions(allowed = null) {
    // A user limited to locations only gets values of the devices he may see
    const where = allowed ? ` AND location_id IN (${[...allowed].map(Number).filter(Number.isInteger).join(',') || 'NULL'})` : '';
    const top = (col) => db.prepare(`SELECT ${col} v, COUNT(*) n FROM devices WHERE ${col} <> ''${where} GROUP BY ${col} COLLATE NOCASE ORDER BY n DESC, v LIMIT 300`).all().map((r) => r.v);
    const tags = new Map();
    for (const r of db.prepare(`SELECT tags FROM devices WHERE tags <> ''${where}`).all()) {
      for (const tg of r.tags.split(',').map((x) => x.trim()).filter(Boolean)) {
        const k = tg.toLowerCase();
        const e = tags.get(k) || { v: tg, n: 0 };
        e.n++;
        tags.set(k, e);
      }
    }
    // Model → most common manufacturer and type (to fill them in when a known model is chosen)
    const models = db.prepare(`SELECT model, vendor, type, COUNT(*) n FROM devices WHERE model <> ''${where} GROUP BY model COLLATE NOCASE, vendor, type ORDER BY n DESC`).all();
    const byModel = {};
    for (const m of models) if (!byModel[m.model.toLowerCase()]) byModel[m.model.toLowerCase()] = { vendor: m.vendor, type: m.type };
    return {
      vendor: top('vendor'), model: top('model'), supplier: top('supplier'), owner: top('owner'), os: top('os'),
      tags: [...tags.values()].sort((a, b) => b.n - a.n || a.v.localeCompare(b.v)).slice(0, 300).map((e) => e.v),
      models: byModel,
    };
  }

  const BULK_FIELDS = ['type', 'location_id', 'vendor', 'model', 'os', 'owner', 'supplier', 'purchase_date', 'warranty_until', 'maintenance_until'];

  /**
   * Changes several devices at once. Only the fields in `set` change (others stay); tags can be added or removed.
   * Each device gets its own history entry.
   */
  function bulkUpdate(deviceIds, { set = {}, tagsAdd = [], tagsRemove = [] } = {}, user = '') {
    const fields = Object.fromEntries(Object.entries(set || {}).filter(([k]) => BULK_FIELDS.includes(k)));
    const add = (Array.isArray(tagsAdd) ? tagsAdd : []).map((x) => line(x, 60)).filter(Boolean).slice(0, 20);
    const rem = new Set((Array.isArray(tagsRemove) ? tagsRemove : []).map((x) => line(x, 60).toLowerCase()).filter(Boolean));
    let n = 0;
    db.transaction(() => {
      for (const id of deviceIds) {
        const cur = getDevice.get(id);
        if (!cur) continue;
        const change = { ...fields };
        if (add.length || rem.size) {
          const list = cur.tags.split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !rem.has(x.toLowerCase()));
          for (const a of add) if (!list.some((x) => x.toLowerCase() === a.toLowerCase())) list.push(a);
          change.tags = list.join(', ');
        }
        if (!Object.keys(change).length) continue;
        update(id, change, user);
        n++;
      }
    })();
    return n;
  }

  function bulkRemove(deviceIds) {
    let n = 0;
    db.transaction(() => {
      for (const id of deviceIds) {
        const mons = db.prepare('SELECT id FROM monitors WHERE device_id=?').all(id).map((m) => m.id);
        if (db.prepare('DELETE FROM devices WHERE id=?').run(id).changes) { n++; forgetDevices(db, [id], mons); }
      }
    })();
    return n;
  }

  // From a form only the fields a person may set: facts, first/last seen and the source come from scans alone
  const createFromForm = (input, user) => create(Object.fromEntries(EDITABLE.filter((k) => input && typeof input === 'object' && k in input).map((k) => [k, input[k]])), user);
  return { applyResult, finishScan, create: createFromForm, update, remove, get, list, historyOf, adopt, ignore, unignore, stats, history, suggestions, bulkUpdate, bulkRemove };
}

/** CSV export (semicolon, UTF-8 with BOM - opens correctly in Excel) */
export function toCsv(devices) {
  const cols = ['name', 'type', 'ip', 'mac', 'hostname', 'vendor', 'model', 'os', 'location_name', 'owner', 'tags', 'serial',
    'supplier', 'purchase_date', 'warranty_until', 'maintenance_until', 'web_url', 'last_seen', 'notes'];
  const esc = (v) => {
    let s = String(v ?? '');
    // Formula injection: cells starting with = + - @ are shown as text in spreadsheets
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(';'), ...devices.map((d) => cols.map((c) => esc(d[c])).join(';'))].join('\r\n') + '\r\n';
}
