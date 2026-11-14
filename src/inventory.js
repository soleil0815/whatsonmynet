// Inventory: devices the admin has chosen to keep, their history, and how scan results are matched to them.
//
// A device is recognised by its MAC address (stays the same when the IP changes). Devices without MAC (only in
// routed subnets without SNMP/NetBIOS) are recognised by their IP address.
// After every scan: known devices get their new IP, host name (unless typed in by hand) and last-seen time automatically
// (with an entry in the history); new devices only appear in the scan result until the admin adopts or ignores them.
import { HttpError, line, str, isoDate, oneOf } from './lib/http.js';
import { normalizeMac, isIPv4, ipSortKey, cidrContains } from './lib/net.js';
import { TYPES, isTelematik, suggestName } from './scan/classify.js';
import { bestWebUrl } from './scan/engine.js';
import { forgetDevices } from './lib/idlists.js';
import { onDeviceChanged, followUrl } from './devicechange.js';

const EDITABLE = ['name', 'type', 'vendor', 'model', 'ip', 'mac', 'hostname', 'os', 'location_id', 'owner', 'notes', 'tags',
  'web_url', 'serial', 'supplier', 'purchase_date', 'warranty_until', 'maintenance_until'];

const now = () => new Date().toISOString();
const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };

// Re-exported: callers and tests import it from here
export { followUrl };

const parseAuto = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };

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
    // Host name (DNS/NetBIOS): the scan owns it only while it is empty or still holds what a scan (or the device)
    // set last time (auto_fields.hostname). Typed in by hand (auto_fields.hostname = null) it is left alone.
    // Devices from before this rule have no entry: the scan keeps them up to date as it always did.
    const auto = parseAuto(device.auto_fields);
    if (r.hostname && device.hostname !== r.hostname) {
      const scanOwned = !device.hostname || auto.hostname === undefined || (auto.hostname !== null && auto.hostname === device.hostname);
      if (scanOwned) {
        if (device.hostname) changes.push({ field: 'hostname', from: device.hostname, to: r.hostname });
        set.hostname = r.hostname;
        set.auto_fields = JSON.stringify({ ...auto, hostname: r.hostname });
      }
    } else if (r.hostname && auto.hostname === undefined) set.auto_fields = JSON.stringify({ ...auto, hostname: r.hostname });
    if (!device.vendor && r.vendor) set.vendor = r.vendor;
    if (!device.os && facts.classification?.os && !facts.light) set.os = facts.classification.os;
    if (!device.web_url) { const u = bestWebUrl(r.ip, facts, device.type); if (u) set.web_url = u; }
    const keys = Object.keys(set);
    db.transaction(() => {
      db.prepare(`UPDATE devices SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => set[k]), device.id);
      for (const c of changes) if (c.field !== 'ip') history(device.id, 'change', c, 'scan');
      // New address: history, monitors and web link follow (same rules for every path that changes a device)
      onDeviceChanged(db, device, { ...device, ...set }, 'scan', { user: 'scan', ts });
      if (deep) history(device.id, 'deep', { ports: facts.ports?.length || 0 }, 'scan');
      db.prepare('UPDATE scan_results SET status=?, device_id=? WHERE id=?').run(changes.some((c) => c.field === 'ip' || c.field === 'mac') ? 'changed' : 'known', device.id, resultId);
    })();
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
      // A host name typed in belongs to the user from now on (scans leave it alone); cleared, the scan fills it again
      if (changed.includes('hostname')) {
        const auto = parseAuto(cur.auto_fields);
        if (v.hostname) auto.hostname = null; else delete auto.hostname;
        db.prepare('UPDATE devices SET auto_fields=? WHERE id=?').run(JSON.stringify(auto), id);
      }
      // Monitors follow a new name and address, the web link a new address (unless changed in the same edit), SNMP
      // data of the old type goes - the same rules as for a scan or a device report
      renamed = onDeviceChanged(db, cur, { ...cur, ...v }, 'manual', { user, ts, ipHistory: false, webUrlEdited: changed.includes('web_url') }).renamed;
    })();
    return renamed ? { ...get(id), renamedMonitors: renamed } : get(id);
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

  /**
   * Is a newer finished scan covering the address of this result there? Then the result is outdated: it can still be
   * looked at, but not adopted or ignored (its address, name or the device itself may be gone by now). Covering means
   * a target subnet containing the address at the same location (overlapping subnets of two sites with scan agents);
   * a scan without location counts for any. A full network scan outdates everything older; a light
   * scan (ping/ARP only) outdates older light scan results only - a nightly light scan must not make the last full scan
   * unusable.
   */
  const scanOf = db.prepare('SELECT id, kind FROM scans WHERE id=?');
  function newerScans(scanId) {
    const own = scanOf.get(scanId);
    if (!own) return [];
    const kinds = own.kind === 'light' ? ['network', 'light'] : ['network'];
    return db.prepare(`SELECT targets FROM scans WHERE id>? AND status='done' AND kind IN (${kinds.map(() => '?').join(',')})`).all(own.id, ...kinds);
  }
  function isOutdated(r, newer = newerScans(r.scan_id)) {
    return newer.some((s) => parse(s.targets, []).some((t) => t && t.cidr && cidrContains(t.cidr, r.ip) && (t.locationId == null || r.location_id == null || t.locationId === r.location_id)));
  }

  /** Ids of the results of a scan that are outdated by a newer scan (for the scan view) */
  function outdatedResults(scanId) {
    const newer = newerScans(scanId);
    if (!newer.length) return new Set();
    return new Set(db.prepare('SELECT id, scan_id, ip, location_id FROM scan_results WHERE scan_id=?').all(scanId).filter((r) => isOutdated(r, newer)).map((r) => r.id));
  }

  /** Adopting or ignoring only from the newest scan of a subnet - an old result is refused as a whole */
  function refuseOutdated(resultIds) {
    for (const rid of resultIds) {
      const r = getResult.get(rid);
      if (r && !r.device_id && isOutdated(r)) throw new HttpError(409, 'err.scanOutdated');
    }
  }

  /** Adopts scan results into the inventory (optional type/name per result chosen in the UI). */
  function adopt(resultIds, overrides = {}, user = '', skipped = []) {
    const created = [];
    refuseOutdated(resultIds);
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
        // Probably in the inventory already (same address or host name): only when asked for ("add as new anyway")
        const maybe = o.force ? null : likelyExisting(r);
        if (maybe) { skipped.push({ id: rid, device: maybe }); continue; }
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
        // The host name came from the scan too: the scan keeps it up to date until someone types in another one
        const guessed = Object.fromEntries(['vendor', 'model', 'os', 'type', 'hostname'].filter((k) => d[k]).map((k) => [k, d[k]]));
        if (Object.keys(guessed).length) db.prepare('UPDATE devices SET auto_fields=? WHERE id=?').run(JSON.stringify(guessed), d.id);
        // Remove the device from the ignore list if it was there (devices without MAC are on it by IP)
        unlistIgnored(mac, r.ip);
        created.push(d.id);
      }
    })();
    return created;
  }

  // Names too general to say "the same device" (many devices answer with them)
  const GENERIC_HOST = /^(localhost|unknown|android|iphone|ipad|espressif|esp[-_]?\w*|wlan\w*|dhcp\w*|.{0,2})$/i;
  const sameHost = db.prepare(`SELECT id, name, mac, ip FROM devices WHERE lower(hostname)=? OR substr(lower(hostname),1,length(?)+1)=?||'.'
    OR (hostname='' AND lower(name)=?) ORDER BY id LIMIT 1`);
  const sameIp = db.prepare('SELECT id, name, mac, ip FROM devices WHERE ip=? ORDER BY id LIMIT 1');

  /**
   * A new scan result that is probably a device of the inventory already (shown as a tip, not adopted by itself):
   *   'ip'        the same address, another MAC (a VM with a new MAC, a device exchanged, a changing WLAN MAC)
   *   'hostname'  the same host name, another address and MAC (a second network card, e.g. a NAS with two ports)
   * Returns { id, name, why } or null. Several services of one server are not concerned (they are no devices).
   */
  function likelyExisting(r) {
    if (!r || r.device_id) return null;
    const mac = normalizeMac(r.mac);
    const ip = sameIp.get(r.ip);
    if (ip && ip.mac && ip.mac !== mac) return { id: ip.id, name: ip.name, why: 'ip' };
    const facts = parse(r.facts);
    for (const raw of [r.hostname, facts.netbios?.name]) {
      const short = String(raw || '').trim().toLowerCase().split('.')[0];
      if (!short || GENERIC_HOST.test(short)) continue;
      const d = sameHost.get(short, short, short, short);
      if (d && (!mac || d.mac !== mac)) return { id: d.id, name: d.name, why: 'hostname' };
    }
    return null;
  }

  /**
   * "Belongs to that device": the result is marked as the device. The same address with a new MAC: the device takes
   * the new MAC (the next scan finds it by it). A second network card (same host name): its MAC/address is put on the
   * ignore list with a note, so it does not come back as new.
   */
  function linkResults(resultIds, user = '') {
    let n = 0;
    refuseOutdated(resultIds);
    db.transaction(() => {
      for (const rid of resultIds) {
        const r = getResult.get(rid);
        const m = likelyExisting(r);
        if (!m || r.handled) continue;
        const mac = normalizeMac(r.mac);
        const d = getDevice.get(m.id);
        if (m.why === 'ip' && mac && !byMac.get(mac)) {
          db.prepare('UPDATE devices SET mac=?, last_seen=?, updated_at=? WHERE id=?').run(mac, now(), now(), d.id);
          history(d.id, 'change', { field: 'mac', from: d.mac, to: mac, linked: true }, user);
        } else {
          const label = `→ ${d.name}${r.hostname ? ` (${r.hostname})` : ''}`.slice(0, 200);
          if (mac) db.prepare('INSERT INTO ignored(mac,ip,label,created_at,created_by) VALUES(?,?,?,?,?) ON CONFLICT(mac) DO UPDATE SET ip=excluded.ip, label=excluded.label').run(mac, r.ip, label, now(), user);
          else if (!isIgnored.get(null, r.ip)) db.prepare('INSERT INTO ignored(mac,ip,label,created_at,created_by) VALUES(NULL,?,?,?,?)').run(r.ip, label, now(), user);
          history(d.id, 'linked', { ip: r.ip, mac: mac || null }, user);
        }
        db.prepare("UPDATE scan_results SET device_id=?, handled='linked', status='known' WHERE id=?").run(d.id, rid);
        n++;
      }
    })();
    return n;
  }

  /** Devices of the inventory that are probably one and the same (same host name): shown as a tip */
  function duplicates() {
    const out = [];
    const seen = new Map();
    for (const d of db.prepare("SELECT id, name, ip, mac, hostname FROM devices WHERE hostname <> '' ORDER BY id").all()) {
      const short = d.hostname.toLowerCase().split('.')[0];
      if (!short || GENERIC_HOST.test(short)) continue;
      if (seen.has(short)) out.push({ keep: seen.get(short), drop: { id: d.id, name: d.name, ip: d.ip, mac: d.mac }, why: 'hostname' });
      else seen.set(short, { id: d.id, name: d.name, ip: d.ip, mac: d.mac });
    }
    return out;
  }

  /**
   * Two entries of one device become one: `dropId` goes into `keepId` - its monitors and sensors (watched twice then:
   * merged), history, script key and reports, values the kept one lacks (SNMP, printer, script), empty fields. Its
   * MAC/address goes on the ignore list with a note, so the scan does not bring it back as new.
   */
  function merge(keepId, dropId, user = '') {
    if (keepId === dropId) throw new HttpError(400, 'err.badRequest');
    const keep = getDevice.get(keepId);
    const drop = getDevice.get(dropId);
    if (!keep || !drop) throw new HttpError(404, 'err.notFound');
    db.transaction(() => {
      db.prepare('UPDATE monitors SET device_id=? WHERE device_id=?').run(keepId, dropId);
      db.prepare('UPDATE device_history SET device_id=? WHERE device_id=?').run(keepId, dropId);
      db.prepare('UPDATE host_tokens SET device_id=? WHERE device_id=?').run(keepId, dropId);
      db.prepare('UPDATE scan_results SET device_id=? WHERE device_id=?').run(keepId, dropId);
      for (const tbl of ['snmp_status', 'printer_status', 'host_reports']) {
        if (!db.prepare(`SELECT 1 FROM ${tbl} WHERE device_id=?`).get(keepId)) db.prepare(`UPDATE ${tbl} SET device_id=? WHERE device_id=?`).run(keepId, dropId);
      }
      db.prepare('INSERT OR IGNORE INTO printer_pages(device_id, day, count) SELECT ?, day, count FROM printer_pages WHERE device_id=?').run(keepId, dropId);
      db.prepare('INSERT OR IGNORE INTO switch_macs(switch_id, mac, if_index, port, vlan, seen_at) SELECT ?, mac, if_index, port, vlan, seen_at FROM switch_macs WHERE switch_id=?').run(keepId, dropId);
      for (const row of db.prepare("SELECT id, device_ids v FROM reports WHERE device_ids <> '[]'").all()) {
        const list = parse(row.v, []);
        if (!Array.isArray(list) || !list.some((x) => Number(x) === dropId)) continue;
        db.prepare('UPDATE reports SET device_ids=? WHERE id=?').run(JSON.stringify([...new Set(list.map((x) => (Number(x) === dropId ? keepId : Number(x))))]), row.id);
      }
      // what the kept one does not know yet
      const fill = {};
      for (const k of ['hostname', 'vendor', 'model', 'os', 'owner', 'tags', 'web_url', 'serial', 'supplier', 'purchase_date', 'warranty_until', 'maintenance_until']) {
        if (!keep[k] && drop[k]) fill[k] = drop[k];
      }
      if (!keep.location_id && drop.location_id) fill.location_id = drop.location_id;
      if (drop.notes && !String(keep.notes || '').includes(drop.notes)) fill.notes = [keep.notes, drop.notes].filter(Boolean).join('\n').slice(0, 4000);
      db.prepare('DELETE FROM devices WHERE id=?').run(dropId);
      if (!keep.mac && drop.mac) fill.mac = drop.mac;
      if (!keep.ip && drop.ip) fill.ip = drop.ip;
      const keys = Object.keys(fill);
      if (keys.length) db.prepare(`UPDATE devices SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...keys.map((k) => fill[k]), now(), keepId);
      // the other card/address of the device: not offered as new again
      const label = `→ ${keep.name}`.slice(0, 200);
      if (drop.mac && drop.mac !== (fill.mac ?? keep.mac)) db.prepare('INSERT INTO ignored(mac,ip,label,created_at,created_by) VALUES(?,?,?,?,?) ON CONFLICT(mac) DO UPDATE SET ip=excluded.ip, label=excluded.label').run(drop.mac, drop.ip, label, now(), user);
      else if (!drop.mac && drop.ip && drop.ip !== (fill.ip ?? keep.ip) && !isIgnored.get(null, drop.ip)) db.prepare('INSERT INTO ignored(mac,ip,label,created_at,created_by) VALUES(NULL,?,?,?,?)').run(drop.ip, label, now(), user);
      history(keepId, 'merged', { name: drop.name, ip: drop.ip, mac: drop.mac }, user);
    })();
    return getDevice.get(keepId);
  }

  function ignore(resultIds, user = '') {
    let n = 0;
    refuseOutdated(resultIds);
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
  // A host name typed into the form belongs to the user (scans do not overwrite it)
  const createFromForm = (input, user) => {
    const d = create(Object.fromEntries(EDITABLE.filter((k) => input && typeof input === 'object' && k in input).map((k) => [k, input[k]])), user);
    if (!d.hostname) return d;
    db.prepare('UPDATE devices SET auto_fields=? WHERE id=?').run(JSON.stringify({ ...parseAuto(d.auto_fields), hostname: null }), d.id);
    return get(d.id);
  };
  return { likelyExisting, linkResults, duplicates, merge, applyResult, finishScan, create: createFromForm, update, remove, get, list, historyOf, adopt, ignore, unignore, outdatedResults, stats, history, suggestions, bulkUpdate, bulkRemove };
}

/** CSV export (semicolon, UTF-8 with BOM - opens correctly in Excel) */
export function toCsv(devices) {
  const cols = ['name', 'type', 'ip', 'mac', 'hostname', 'vendor', 'model', 'os', 'location_name', 'owner', 'tags', 'serial',
    'supplier', 'purchase_date', 'warranty_until', 'maintenance_until', 'web_url', 'last_seen', 'notes'];
  const esc = (v) => {
    let s = String(v ?? '');
    // Formula injection: a cell starting with = + - @ (also after leading spaces, tabs or line breaks), starting with a
    // tab or CR, or holding a comma followed by one of them (Excel with comma as list separator splits the cell there)
    // is shown as text in spreadsheets. Every column is text (dates are ISO strings), so "-5" becomes text as well.
    if (/^[\t\r]|^\s*[=+\-@]|,\s*[=+\-@]/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(';'), ...devices.map((d) => cols.map((c) => esc(d[c])).join(';'))].join('\r\n') + '\r\n';
}
