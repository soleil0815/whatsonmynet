// What a device tells about itself - over SNMP (serial number, model, firmware, manufacturer) or by its host script
// (operating system, host name) - goes into its inventory entry, so nobody has to type it in.
//
// Rules, per field:
// - empty field → filled in
// - field still holds what the device reported last time (auto_fields) → kept up to date (e.g. after a firmware update)
// - field typed in by hand with another value → left alone
// - the device reports another serial number than the inventory holds → it was exchanged (same IP, new hardware):
//   serial, model, manufacturer and firmware are replaced, the old MAC address is dropped so that the next scan takes
//   the new one instead of reporting a "new device", and the history says so (purchase date/warranty may be old).
// Every change is in the device history.
import { line } from './lib/http.js';
import { TYPES } from './scan/classify.js';

const FIELDS = ['serial', 'model', 'vendor', 'os', 'hostname', 'type'];
const HARDWARE = ['serial', 'model', 'vendor', 'os', 'type'];
// Host names also come from the scan (DNS) - they are only filled in, never kept "up to date" against it
const FILL_ONLY = ['hostname'];
// Placeholders some devices answer instead of a value
const JUNK = /^(|0+|n\/?a|none|null|unknown|not available|not specified|default string|to be filled by o\.e\.m\.|o\.e\.m\.?|oem|123456789|serial ?number|x+|system (serial number|product name|manufacturer|version)|chassis serial number|base board serial number|invalid)$/i;
const parse = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const same = (a, b) => String(a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * facts: { serial, model, vendor, os, hostname }; source: 'SNMP' or 'script'.
 * Returns { fields: [changed field names], replaced: boolean }.
 */
export function fillDevice(db, deviceId, facts, source = 'SNMP') {
  const d = db.prepare(`SELECT ${FIELDS.join(',')}, mac, auto_fields FROM devices WHERE id=?`).get(deviceId);
  if (!d) return { fields: [], replaced: false };
  const auto = parse(d.auto_fields);
  const got = {};
  for (const k of FIELDS) {
    const v = line(facts?.[k], k === 'os' ? 120 : 100).trim();
    if (k === 'type' && !TYPES.includes(v)) continue;
    if (v && !JUNK.test(v)) got[k] = v;
  }
  // Another serial number than the one in the inventory: other hardware at this address
  // Only when the serial number in the inventory came from the device itself (a typed one may be written differently:
  // SG2-ABC123 / SG2ABC123), and compared without dashes, spaces and case
  const serialKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const replaced = !!(got.serial && serialKey(d.serial) && auto.serial !== undefined && same(auto.serial, d.serial) && serialKey(d.serial) !== serialKey(got.serial));
  const set = {};
  const changes = [];
  const nextAuto = { ...auto };
  for (const k of FIELDS) {
    const v = got[k];
    if (!v) continue;
    // "unknown" is no real type - like an empty field
    const cur = k === 'type' && d[k] === 'unknown' ? '' : String(d[k] ?? '').trim();
    if (same(cur, v)) { nextAuto[k] = cur; continue; }
    const followsDevice = !cur || (!FILL_ONLY.includes(k) && auto[k] !== undefined && same(auto[k], cur)) || (replaced && HARDWARE.includes(k));
    if (!followsDevice) continue;
    set[k] = v;
    nextAuto[k] = v;
    changes.push({ field: k, from: cur || undefined, to: v });
  }
  if (replaced && d.mac) set.mac = null;
  const autoChanged = JSON.stringify(nextAuto) !== JSON.stringify(auto);
  if (!changes.length && !autoChanged && !set.mac) return { fields: [], replaced: false };
  const at = new Date().toISOString();
  const who = { script: 'Skript', controller: 'Controller', redfish: 'Redfish' }[source] || 'SNMP';
  db.transaction(() => {
    const cols = { ...set, auto_fields: JSON.stringify(nextAuto) };
    if (changes.length || replaced) cols.updated_at = at;
    const keys = Object.keys(cols);
    db.prepare(`UPDATE devices SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => cols[k]), deviceId);
    const hist = db.prepare('INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,?,?,?)');
    if (replaced) hist.run(deviceId, at, who, 'replaced', JSON.stringify({ source, from: d.serial, to: got.serial, mac: d.mac || null }));
    if (changes.length) hist.run(deviceId, at, who, 'snmp', JSON.stringify({ source, fields: changes }));
  })();
  return { fields: changes.map((c) => c.field), replaced };
}

/** What the inventory already knows from earlier polls (after an update, before the next poll): the same rules */
export function syncStoredFacts(db) {
  let n = 0;
  for (const r of db.prepare('SELECT p.device_id, p.data FROM printer_status p WHERE p.ok=1').all()) {
    const x = parse(r.data);
    if (fillDevice(db, r.device_id, { serial: x.serial, model: x.model }).fields.length) n++;
  }
  for (const r of db.prepare('SELECT s.device_id, s.kind, s.data FROM snmp_status s WHERE s.ok=1').all()) {
    if (fillDevice(db, r.device_id, snmpFacts(r.kind, parse(r.data))).fields.length) n++;
  }
  return n;
}

/** Facts of a switch / NAS poll in inventory terms */
export function snmpFacts(kind, data) {
  if (kind === 'ups') return { serial: data.serial, model: data.model, vendor: data.vendor, os: data.firmware };
  return kind === 'nas'
    ? { serial: data.serial, model: data.model, vendor: { synology: 'Synology', qnap: 'QNAP' }[data.vendor], os: data.version && data.vendor === 'qnap' && !/^Q/i.test(data.version) ? `QTS ${data.version}` : data.version }
    : { serial: data.serial, model: data.model, os: data.firmware };
}
