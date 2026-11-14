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
  'scan.routerArp': true,         // routed subnets: MAC addresses from the ARP table of routers/firewalls (SNMP)
  // Nightly light scan: only finds devices (ARP/ping/NetBIOS), takes over new IPs, reports unknown devices
  'lightscan.enabled': true,
  'lightscan.time': '02:30',      // local time (TZ), runs within 4 hours after it
  'lightscan.notify': true,       // report devices seen for the first time
  'lightscan.channels': [],       // empty = default channels
  'lightscan.lastRun': '',        // YYYY-MM-DD of the last automatic run
  'lightscan.baseline': false,    // true after the first scan has learned the devices that were already there
  // Printers (SNMP): supplies, page counter, errors
  'printer.enabled': true,
  'printer.interval': 60,         // minutes between two queries of a printer
  'printer.threshold': 15,        // % - report a supply at or below this
  'printer.notify': true,
  'printer.channels': [],
  // Switches and NAS (SNMP): ports, MAC table, volumes, disks
  'snmpdev.enabled': true,
  'snmpdev.interval': 15,         // minutes
  'nas.threshold': 90,            // % - report a volume at or above this
  'nas.notify': true,
  'nas.channels': [],
  // Escalation: an outage not solved after this many minutes goes to these channels too (0 = off)
  'escalate.min': 0,
  'escalate.channels': [],
  // Active Directory / LDAP sign-in
  'ad.enabled': false,
  'ad.url': '',                   // ldaps://dc01.firma.local or ldap://… with StartTLS
  'ad.startTls': false,
  'ad.verify': true,              // check the server certificate
  'ad.ca': '',                    // own CA (PEM), empty = system CAs
  'ad.bindDn': '',                // service account (DN or user@domain)
  'ad.bindPassword': '',          // encrypted
  'ad.baseDn': '',
  'ad.userFilter': '',            // empty = default filter (sAMAccountName / userPrincipalName)
  'ad.groupAdmin': '',
  'ad.groupEditor': '',
  'ad.groupViewer': '',
  'ad.nested': true,              // nested groups (AD)
  'ad.trust': '',                 // pinned (certificate fetched from the DC) | system | '' = derived
  'ad.verifyHostname': true,      // name in the certificate must fit the server address
  // Security
  'security.require2faAdmins': false, // local administrators must use two-factor sign-in
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

const SECRET = new Set(['smtp.password', 'scan.snmpCommunities', 'ad.bindPassword']);

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
    /** After the database was replaced underneath (failover standby): read everything anew */
    clearCache: () => cache.clear(),
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
