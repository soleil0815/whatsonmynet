// What a device tells about itself over SNMP (serial number, model, firmware, manufacturer) goes into its inventory
// entry - but only into empty fields: what someone typed in is never overwritten. Each fill is in the device history.
import { line } from './lib/http.js';

const FIELDS = ['serial', 'model', 'vendor', 'os'];
// Placeholders some devices answer instead of a value
const JUNK = /^(|0+|n\/?a|none|null|unknown|not available|default string|to be filled by o\.e\.m\.|123456789|serial ?number|x+)$/i;

/** facts: { serial, model, vendor, os }; returns the fields that were filled */
export function fillDevice(db, deviceId, facts) {
  const d = db.prepare(`SELECT ${FIELDS.join(',')} FROM devices WHERE id=?`).get(deviceId);
  if (!d) return [];
  const set = {};
  for (const k of FIELDS) {
    const v = line(facts?.[k], k === 'os' ? 120 : 100).trim();
    if (!v || JUNK.test(v) || String(d[k] ?? '').trim()) continue;
    set[k] = v;
  }
  const keys = Object.keys(set);
  if (!keys.length) return [];
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE devices SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...keys.map((k) => set[k]), at, deviceId);
    db.prepare('INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,?,?,?)')
      .run(deviceId, at, 'SNMP', 'snmp', JSON.stringify({ fields: keys.map((k) => ({ field: k, to: set[k] })) }));
  })();
  return keys;
}
