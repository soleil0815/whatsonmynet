// Settings that are changed in the web interface (key/value, JSON). Secrets are stored encrypted.
import { encrypt, decrypt } from './lib/crypto.js';
import { v3Public } from './snmpcreds.js';

// Windows events that come by the thousand and say nothing worth keeping: not taken on a new installation (Messages →
// Receiving settings → never take). Logon/logoff and special logon, process start/end, object access, token and group
// enumeration, firewall (WFP) connections, credential manager reads, service state, DCOM 10016, software protection,
// user profile service, uptime, WMI 5858. Not in it: 8004 - also AppLocker "blocked" (ready-made rule); 4625, 4740 & co.
// Windows events that are usually worth keeping (security, crashes, restarts) - the overview "What takes the space?"
// says so before one of them is left out
export const WIN_KEEP = '41, 104, 1074, 1076, 1102, 1116, 1117, 4104, 4625, 4648, 4697, 4698, 4719, 4720, 4722, 4723, 4724, 4725, 4726, 4728, 4732, 4735, 4738, 4740, 4756, 4767, 4771, 4776, 6005, 6006, 6008, 7034, 7045';
export const WIN_NOISE = '1531, 1532, 4624, 4634, 4647, 4656, 4658, 4663, 4672, 4688, 4689, 4690, 4703, 4798, 4799, 5156, 5158, 5379, 5858, 6013, 7036, 10016, 16384, 16394';

export const DEFAULTS = {
  'general.title': 'WhatsOnMyNet',
  // Scan
  'scan.ping': true,              // ICMP echo (if the host allows unprivileged ping)
  'scan.snmp': true,              // ask devices via SNMP (read-only, sysDescr etc.)
  'scan.snmpCommunities': '',     // encrypted; empty = "public"
  'scan.snmpV3': '',              // encrypted JSON: SNMPv3 users (name, level, procedures, keys) - the keys never leave the server
  'scan.rate': 40,                // new connection attempts per second (gentle)
  'scan.httpTitles': true,        // read the title of web interfaces
  'scan.keepScans': 20,           // how many scans are kept
  'scan.routerArp': true,         // routed subnets: MAC addresses from the ARP table of routers/firewalls (SNMP)
  // Nightly light scan: only finds devices (ARP/ping/NetBIOS), takes over new IPs, reports unknown devices
  // off on a new installation: WhatsOnMyNet scans nothing on its own - an administrator switches it on (installations
  // from before 0.42 keep what they had, see migration 38)
  'lightscan.enabled': false,
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
  // New devices and hosts get a first monitor and a few sensors by themselves
  'autowatch.enabled': true,
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
  'backup.keep': 10,
  // Messages devices send by themselves (SNMP traps, syslog) - off until switched on
  'events.traps': false,
  'events.syslog': false,
  'events.syslogTcp': false,      // syslog over TCP (RFC 6587)
  'events.syslogTls': false,      // syslog over TLS (RFC 5425), with the certificate of this server
  'events.communities': '',       // encrypted; empty = the SNMP communities of the scan (else "public")
  'events.onlyKnown': false,      // only from devices in the inventory
  'events.keepDays': 30,
  'events.minSeverity': 7,        // messages kept from this severity on (7 = all, 6 = no debug, 4 = warning and worse)
  'events.winAllow': '',          // Windows event ids taken ("1116, 4740, 865-868"); empty = all
  'events.winDeny': WIN_NOISE,    // Windows event ids never taken; existing installations keep theirs (migration 35)
  'events.maxGb': 2,              // the messages file (data/events.sqlite) at most - less when the disk gets short
  // "First steps" on the overview (administrators): hidden for good once someone clicks "Hide"
  'ui.startHidden': false,
  // Update check (Settings → About): off - WhatsOnMyNet asks GitHub only when an administrator wants it
  'hosts.selfUpdate': true,      // machine scripts (Windows, Linux) fetch a newer version of themselves from WhatsOnMyNet
  'update.auto': false,           // once a day: is there a newer version?
  'update.notify': false,         // report a new version once to the channels
  'update.channels': [],          // empty = default channels
  'update.last': {},              // { checkedAt, latest, url, published, notes, error, notified } - the last answer
  // Prometheus keys: [{ id, name, hash, prefix, created_at, created_by }] - only the SHA-256 of a key is kept
  'api.tokens': [],
};

const SECRET = new Set(['smtp.password', 'scan.snmpCommunities', 'scan.snmpV3', 'ad.bindPassword', 'events.communities']);

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
        // v3 users: names, levels and procedures for the form - never the keys
        if (k === 'scan.snmpV3') { out[name] = v3Public(get(k)); continue; }
        out[name] = SECRET.has(k) ? { set: !!get(k) } : get(k);
      }
      return out;
    },
  };
}
