// Settings that are changed in the web interface (key/value, JSON). Secrets are stored encrypted.
import { encrypt, decrypt } from './lib/crypto.js';

export const DEFAULTS = {
  'general.title': 'WhatsOnMyNet',
  // Scan
  'scan.ping': true,              // ICMP echo (if the host allows unprivileged ping)
  'scan.snmp': true,              // ask devices via SNMP (read-only, sysDescr etc.)
  'scan.snmpCommunities': '',     // encrypted; empty = "public"
  'scan.rate': 40,                // new connection attempts per second (gentle)
  'scan.httpTitles': true,        // read the title of web interfaces
  'scan.keepScans': 20,           // how many scans are kept
  // Mail (SMTP)
  'smtp.host': '',
  'smtp.port': 587,
  'smtp.security': 'starttls',    // starttls | tls | none
  'smtp.user': '',
  'smtp.password': '',            // encrypted
  'smtp.from': '',
  'smtp.allowSelfSigned': false,
  // Backups
  'backup.keep': 7,
};

const SECRET = new Set(['smtp.password', 'scan.snmpCommunities']);

export function createSettings(db) {
  const getRow = db.prepare('SELECT value FROM settings WHERE key=?');
  const upsert = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const cache = new Map();

  function get(key) {
    if (cache.has(key)) return cache.get(key);
    const row = getRow.get(key);
    let v = row ? JSON.parse(row.value) : DEFAULTS[key];
    if (SECRET.has(key) && v) {
      try { v = decrypt(v); } catch { v = ''; }
    }
    cache.set(key, v);
    return v;
  }

  function set(key, value) {
    const stored = SECRET.has(key) && value ? encrypt(value) : value;
    upsert.run(key, JSON.stringify(stored ?? null));
    cache.set(key, value);
  }

  return {
    get,
    set,
    isSecret: (key) => SECRET.has(key),
    /** All keys of a group (without secrets in clear text: they are reported as set/not set) */
    publicGroup(prefix) {
      const out = {};
      for (const k of Object.keys(DEFAULTS).filter((x) => x.startsWith(`${prefix}.`))) {
        const name = k.slice(prefix.length + 1);
        out[name] = SECRET.has(k) ? { set: !!get(k) } : get(k);
      }
      return out;
    },
  };
}
