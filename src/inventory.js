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

const EDITABLE = ['name', 'type', 'vendor', 'model', 'ip', 'mac', 'hostname', 'os', 'location_id', 'owner', 'notes', 'tags',
  'web_url', 'serial', 'supplier', 'purchase_date', 'warranty_until', 'maintenance_until'];

const now = () => new Date().toISOString();
const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };

export function createInventory(db) {
  const getDevice = db.prepare('SELECT * FROM devices WHERE id=?');
  const byMac = db.prepare('SELECT * FROM devices WHERE mac=?');
  const byIpNoMac = db.prepare('SELECT * FROM devices WHERE ip=? AND mac IS NULL');
  const getResult = db.prepare('SELECT * FROM scan_results WHERE id=?');
  const isIgnored = db.prepare('SELECT id FROM ignored WHERE (mac IS NOT NULL AND mac=?) OR (mac IS NULL AND ip=?)');
  const addHistory = db.prepare('INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,?,?,?)');

  function history(deviceId, kind, detail, user = '') {
    addHistory.run(deviceId, now(), user, kind, JSON.stringify(detail || {}));
  }

  function shape(d) {
    if (!d) return null;
    const facts = parse(d.facts);
    return { ...d, facts, telematik: isTelematik(d.type) };
  }

  /** Matches one scan result against the inventory and updates the device if it is known. */
  function applyResult(resultId, { deep = false } = {}) {
    const r = getResult.get(resultId);
    if (!r) return;
    const mac = normalizeMac(r.mac);
    let device = mac ? byMac.get(mac) : null;
    if (!device) device = byIpNoMac.get(r.ip) || null;
    if (!device) {
      const ign = isIgnored.get(mac, r.ip);
      db.prepare('UPDATE scan_results SET status=? WHERE id=?').run(ign ? 'ignored' : 'new', resultId);
      return;
    }
    const facts = parse(r.facts);
    const changes = [];
    const ts = now();
    const set = { last_seen: ts, facts: JSON.stringify({ ...parse(device.facts), ...facts }), updated_at: ts };
    if (device.ip !== r.ip) { changes.push({ field: 'ip', from: device.ip, to: r.ip }); set.ip = r.ip; }
    if (!device.mac && mac) { changes.push({ field: 'mac', from: null, to: mac }); set.mac = mac; }
    if (r.hostname && device.hostname !== r.hostname) {
      if (device.hostname) changes.push({ field: 'hostname', from: device.hostname, to: r.hostname });
      set.hostname = r.hostname;
    }
    if (!device.vendor && r.vendor) set.vendor = r.vendor;
    if (!device.os && facts.classification?.os) set.os = facts.classification.os;
    if (!device.web_url) { const u = bestWebUrl(r.ip, facts, device.type); if (u) set.web_url = u; }
    else if (set.ip && device.web_url.includes(`//${device.ip}`)) set.web_url = device.web_url.replace(`//${device.ip}`, `//${r.ip}`);
    const keys = Object.keys(set);
    db.transaction(() => {
      db.prepare(`UPDATE devices SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => set[k]), device.id);
      for (const c of changes) history(device.id, c.field === 'ip' ? 'ip' : 'change', c, 'scan');
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
          if (ip && !isIPv4(ip)) throw new HttpError(400, 'err.ip');
          out.ip = ip || null; break;
        }
        case 'mac': {
          const raw = line(v, 40);
          const mac = raw ? normalizeMac(raw) : null;
          if (raw && !mac) throw new HttpError(400, 'err.mac');
          out.mac = mac; break;
        }
        case 'location_id': {
          const id = v === null || v === '' || v === undefined ? null : Number(v);
          if (id !== null && !db.prepare('SELECT 1 FROM locations WHERE id=?').get(id)) throw new HttpError(400, 'err.location');
          out.location_id = id; break;
        }
        case 'purchase_date': case 'warranty_until': case 'maintenance_until': out[k] = isoDate(v); break;
        case 'notes': out.notes = str(v, 5000); break;
        case 'web_url': {
          const u = line(v, 500);
          if (u && !/^(https?|ssh|rdp|vnc):\/\/[^\s"'<>]+$/i.test(u)) throw new HttpError(400, 'err.url');
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
    db.transaction(() => {
      db.prepare(`UPDATE devices SET ${changed.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...changed.map((k) => v[k]), now(), id);
      history(id, 'edit', { fields: changed.map((k) => ({ field: k, from: k === 'notes' ? undefined : cur[k], to: k === 'notes' ? undefined : v[k] })) }, user);
    })();
    return get(id);
  }

  function remove(id) {
    if (!db.prepare('DELETE FROM devices WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
  }

  /** Last finished network scans with their subnets – to tell whether a device was seen in the latest scan */
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

  function list({ q = '', type = '', location = '', tag = '' } = {}) {
    const rows = db.prepare('SELECT d.*, l.name location_name FROM devices d LEFT JOIN locations l ON l.id=d.location_id').all();
    const scans = coverage();
    const needle = String(q).trim().toLowerCase();
    return rows.filter((d) => {
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
        const o = overrides[rid] || {};
        const type = TYPES.includes(o.type) ? o.type : r.detected_type;
        const ts = now();
        const d = create({
          name: line(o.name, 120) || suggestName({ ...r, facts, model: facts.classification?.model }),
          type, vendor: r.vendor, model: facts.classification?.model || '', ip: r.ip, mac, hostname: r.hostname,
          os: facts.classification?.os || '', location_id: r.location_id, web_url: bestWebUrl(r.ip, facts, type),
          facts, first_seen: ts, last_seen: ts, source: 'scan',
        }, user);
        db.prepare("UPDATE scan_results SET device_id=?, handled='adopted', status='known' WHERE id=?").run(d.id, rid);
        // Remove the device from the ignore list if it was there
        if (mac) db.prepare('DELETE FROM ignored WHERE mac=?').run(mac);
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
        const label = [r.hostname, r.vendor].filter(Boolean).join(' – ').slice(0, 200);
        if (mac) db.prepare('INSERT INTO ignored(mac,ip,label,created_at,created_by) VALUES(?,?,?,?,?) ON CONFLICT(mac) DO UPDATE SET ip=excluded.ip').run(mac, r.ip, label, now(), user);
        else if (!isIgnored.get(null, r.ip)) db.prepare('INSERT INTO ignored(mac,ip,label,created_at,created_by) VALUES(NULL,?,?,?,?)').run(r.ip, label, now(), user);
        db.prepare("UPDATE scan_results SET handled='ignored', status='ignored' WHERE id=?").run(rid);
        n++;
      }
    })();
    return n;
  }

  function stats() {
    const devices = list();
    const byType = {};
    for (const d of devices) byType[d.type] = (byType[d.type] || 0) + 1;
    const lastScan = db.prepare("SELECT * FROM scans WHERE kind='network' AND status IN ('done','cancelled','failed') ORDER BY id DESC LIMIT 1").get();
    const waiting = lastScan ? db.prepare("SELECT COUNT(*) n FROM scan_results WHERE scan_id=? AND status='new' AND handled IS NULL").get(lastScan.id).n : 0;
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
        ORDER BY h.id DESC LIMIT 12`).all().map((h) => ({ ...h, detail: parse(h.detail) })),
      warranty: devices.filter((d) => d.warranty_until && d.warranty_until <= new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10))
        .map((d) => ({ id: d.id, name: d.name, warranty_until: d.warranty_until })).slice(0, 10),
    };
  }

  return { applyResult, finishScan, create, update, remove, get, list, historyOf, adopt, ignore, stats, history };
}

/** CSV export (semicolon, UTF-8 with BOM – opens correctly in Excel) */
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
