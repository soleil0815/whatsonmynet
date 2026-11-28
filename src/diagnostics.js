// Diagnostic package (Settings → Diagnostics): a ZIP for troubleshooting - only downloaded, never sent by itself.
//
// Contents: version and environment, settings (without passwords and keys), the program's own log of the period
// (it is kept 30 days in server_log), warnings and errors, monitors and sensors with their checks in the period,
// events, devices with the values their sensors can see, hypervisors, scans, notification channels (without their
// configuration), failover state, user actions, and what changed since the oldest version in the period.
//
// Anonymised (the default): device, host, node and guest names, users, mail addresses, IP and MAC addresses, host
// names, locations, directory paths (CN=/OU=/DC=) and channel names are replaced by placeholders (GERAET-001,
// HOST-003, 10.99.0.7 …). They stay the same in every package (table diag_alias), so "GERAET-004" is the same NAS
// next month. Only the administrators of this installation can look them up. Passwords, keys, tokens and
// communities are never in a package - anonymised or not.
import { eventsFile } from './db.js';
import fs from 'node:fs';
import os from 'node:os';
import { config, paths } from './config.js';
import { setLogSink } from './lib/log.js';
import { zip } from './lib/zip.js';
import { csvCell } from './lib/csv.js';
import { DEFAULTS } from './settings.js';
import { metricsFor, sourceOf } from './monitor/sensors.js';
import { proxmoxMetrics } from './proxmox.js';
import { nodeTempsInto, reportGone } from './hosts.js';
import { CHANGELOG } from '../public/js/changelog.js';

export const KEEP_DAYS = 30;
const KEEP_ROWS = 200000;
const MAX_LOG_ROWS = 100000;
const MAX_MESSAGE = 4000;
const DAY = 24 * 3600 * 1000;
const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };
const iso = (ms) => new Date(ms).toISOString();

// Never in a package, whatever their value: setting keys and option fields with secrets
const SECRET_NAME = /(pass|secret|token|community|credential|cookie|apikey|api_key|private|totp|recovery|bindpassword)/i;
const NEVER_SETTING = /(^_keycheck$|password|secret|token|community|\.ca$)/i;
// "password=…", "token: …", "access_token=…", "X-Api-Key: …" in free text (log lines, error messages)
const SECRET_IN_TEXT = /([\w-]*(?:password|passwort|kennwort|passwd|secret|token|community|api[-_]?key))(["'\s]*[:=]\s*["']?)([^\s"',;&]+)/gi;
// "Authorization: Bearer …" / "authorization=Basic …": scheme and value; a bare "Bearer …" as well
const AUTH_IN_TEXT = /\b((?:proxy-)?authorization)(["'\s]*[:=]\s*["']?)(?:(?:bearer|basic|digest|token|negotiate|apikey)\s+)?[^\s"',;&]+/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// every value of a query string (?access_token=…&sig=…): its names stay, the values may be keys
const QUERY_VALUE = /([?&][^\s?&#=/"'<>]{1,64}=)[^\s&#"'<>]+/g;
const USERINFO = /(\/\/)[^\s/@:]+:[^\s/@]*@/g;

/** Passwords in free text, query values and user:password@ in addresses - always, also without anonymising */
export function maskSecrets(text) {
  return String(text ?? '').replace(USERINFO, '$1***:***@').replace(QUERY_VALUE, '$1***').replace(AUTH_IN_TEXT, '$1$2***')
    .replace(BEARER, '$1 ***').replace(SECRET_IN_TEXT, (_, k, sep) => `${k}${sep}***`);
}

// --- Placeholders ------------------------------------------------------------------------------------------
const PREFIX = { device: 'GERAET', host: 'HOST', hv: 'HV', node: 'KNOTEN', guest: 'GAST', user: 'USER', mail: 'MAIL', location: 'STANDORT',
  channel: 'KANAL', mac: 'MAC', dn: 'DN', ip: 'IP', pool: 'POOL' };
// Words too general to be a name worth hiding (a device called "NAS" stays "NAS")
const COMMON = new Set(['nas', 'switch', 'router', 'firewall', 'server', 'drucker', 'printer', 'proxmox', 'pve', 'pbs', 'local', 'admin', 'administrator',
  'test', 'user', 'users', 'system', 'default', 'gast', 'guest', 'online', 'offline', 'windows', 'linux', 'docker', 'backup', 'storage', 'usv', 'ups',
  'telegram', 'webhook', 'mail', 'email', 'monitor', 'sensor', 'ping', 'http', 'https', 'lan', 'wlan', 'wifi', 'none', 'unknown', 'auto', 'node', 'host']);
const TABLE_COUNT_MAX = 100000;
const FILE_EXT = /\.(js|mjs|cjs|json|sh|ps1|txt|csv|md|html?|css|sqlite|db|pem|key|crt|cer|pfx|log|zip|gz|tmp|conf|yml|yaml|xml|svg|png|jpg|exe|msi|dll)$/i;
const IPV4 = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/;
const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/i;
const MAILRX = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/;
const FQDN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}\b/i;
// a value with spaces runs up to the next comma (CN=Max Muster,OU=…); the last one ends at a space (DC=local as …)
const DNRX = /\b(CN|OU|DC|O|L)=([^,;"\n=]{1,64}?(?=,)|[^,;"\s=]+)/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Addresses that tell nothing about a network: kept as they are */
const keepIp = (ip) => /^(0\.|127\.|255\.|22[4-9]\.|23\d\.)/.test(ip) || /^10\.99\./.test(ip);

export function createAnonymizer(db, enabled = true) {
  const known = new Map(); // `${kind}\0${real lower}` → alias
  const used = new Set();
  const counters = {};
  const fresh = [];
  for (const r of db.prepare('SELECT kind, real, alias FROM diag_alias').all()) {
    known.set(`${r.kind}\0${r.real.toLowerCase()}`, r.alias);
    used.add(r.alias);
  }
  function alias(kind, real) {
    const k = `${kind}\0${String(real).toLowerCase()}`;
    if (known.has(k)) return known.get(k);
    let a;
    do {
      counters[kind] = (counters[kind] || db.prepare('SELECT COUNT(*) n FROM diag_alias WHERE kind=?').get(kind).n) + 1;
      const n = counters[kind];
      a = kind === 'ip' ? `10.99.${(n >> 8) & 255}.${n & 255}` : kind === 'mac' ? `02:00:00:00:${((n >> 8) & 255).toString(16).padStart(2, '0')}:${(n & 255).toString(16).padStart(2, '0')}`
        : `${PREFIX[kind] || kind.toUpperCase()}-${String(n).padStart(kind === 'user' || kind === 'location' || kind === 'channel' || kind === 'hv' ? 2 : 3, '0')}`;
    } while (used.has(a));
    used.add(a);
    known.set(k, a);
    fresh.push([kind, String(real), a]);
    return a;
  }

  // Lower case that keeps the length (a few letters grow in lower case, e.g. the Turkish İ: they stay as they are) -
  // the names and the texts the same way, so a match in the lower-case text is the same place in the original
  // (the Greek final ς as σ: lower case writes Σ as one or the other depending on the letters around it)
  const lower = (t) => {
    const l = t.toLowerCase();
    return (l.length === t.length ? l : Array.from(t, (c) => { const x = c.toLowerCase(); return x.length === c.length ? x : c; }).join('')).replace(/ς/g, 'σ');
  };
  // Names from the database: the longest first, so "pve2.firma.local" is one placeholder, not "KNOTEN-001.firma.local"
  const vocab = new Map(); // lower → [kind, real]
  const add = (kind, v) => {
    const s = String(v ?? '').trim();
    if (s.length < 3 || COMMON.has(s.toLowerCase()) || /^\d+$/.test(s) || IPV4.test(s) && s.match(IPV4)[0] === s) return;
    if (!vocab.has(lower(s))) vocab.set(lower(s), [kind, s]);
  };
  if (enabled) {
    for (const d of db.prepare('SELECT name, hostname FROM devices').all()) {
      add('device', d.name);
      if (d.hostname) { add('host', d.hostname); add('host', d.hostname.split('.')[0]); }
    }
    for (const h of db.prepare('SELECT name, data FROM proxmox_hosts').all()) {
      add('hv', h.name);
      const data = parse(h.data);
      for (const n of data.nodes || []) add('node', n.name || n.node);
      for (const g of data.guests || []) add('guest', g.name);
      // cloud accounts: the account itself and what is in it
      if (data.cloud) {
        add('hv', data.account);
        for (const x of [...(data.databases || []), ...(data.balancers || []), ...(data.resources || []), ...(data.alarms || [])]) add('guest', x.name);
      }
    }
    for (const r of db.prepare('SELECT hostname FROM host_unmatched').all()) { add('host', r.hostname); add('host', String(r.hostname).split('.')[0]); }
    for (const u of db.prepare('SELECT username, display_name FROM users').all()) { add('user', u.username); add('user', u.display_name); }
    for (const l of db.prepare('SELECT name FROM locations').all()) add('location', l.name);
    for (const c of db.prepare('SELECT name FROM channels').all()) add('channel', c.name);
    // computers that send messages without being in the inventory (Windows through NXLog: "PC-0011", "DC01"): the names
    // the senders gave last, and those of the newest 100 000 messages - not the whole file (millions of messages: a DISTINCT over
    // all of them read gigabytes and held the server up)
    try {
      const hosts = db.prepare(`SELECT host FROM event_senders WHERE host <> '' UNION
        SELECT host FROM (SELECT host FROM events_in ORDER BY id DESC LIMIT 100000) WHERE host <> '' LIMIT 5000`).all();
      for (const r of hosts) { add('host', r.host); add('host', String(r.host).split('.')[0]); }
    } catch { /* no messages file */ }
  }
  const names = [...vocab.keys()].sort((a, b) => b.length - a.length).map(esc);
  const parts = (dn) => [
    `(?<mail>${MAILRX.source})`,
    `(?<dn>${dn})`,
    ...(names.length ? [`(?<![\\p{L}\\p{N}_-])(?<name>${names.join('|')})(?![\\p{L}\\p{N}_-])`] : []),
    `(?<mac>${MAC.source})`,
    `(?<ip>${IPV4.source})`,
    `(?<fqdn>${FQDN.source})`,
  ].join('|');
  // Searched in the text in lower case and without the "i" flag: case-insensitive, thousands of names in one pattern took
  // the engine some 200 times as long (a package with many devices and message senders: minutes, the server stood still).
  // All parts match lower case the same way (the names are kept in lower case; the DN keys are written so here).
  const all = new RegExp(parts(DNRX.source.replace('(CN|OU|DC|O|L)', '(cn|ou|dc|o|l)')), 'gu');

  function anon(text) {
    const s = maskSecrets(text);
    if (!enabled || !s) return s;
    // (exec on the one pattern, not matchAll: matchAll copies the pattern on every call - with thousands of names that is
    // compiling it anew for every short value, 0.1 ms each, a minute for the values of a thousand devices)
    const low = lower(s);
    let out = ''; let last = 0; let mm;
    all.lastIndex = 0;
    while ((mm = all.exec(low)) !== null) {
      if (mm[0] === '') { all.lastIndex++; continue; }
      const m = s.slice(mm.index, mm.index + mm[0].length);
      out += s.slice(last, mm.index) + replace(m, mm.groups, mm[0]);
      last = mm.index + mm[0].length;
    }
    return out + s.slice(last);
  }
  function replace(m, g, low) {
    {
      if (g.mail) return alias('mail', m);
      if (g.dn) {
        const [, k, v] = m.match(new RegExp(DNRX.source, 'i'));
        return COMMON.has(v.trim().toLowerCase()) || /^(com|net|org|de|local|lan)$/i.test(v.trim()) ? m : `${k}=${alias('dn', v.trim())}`;
      }
      // (looked up as it was found - in the lower-case text; a name not found stays a placeholder of its kind anyway)
      if (g.name) { const [kind, real] = vocab.get(low) || ['host', m]; return alias(kind, real); }
      if (g.mac) return alias('mac', m.toLowerCase().replace(/-/g, ':'));
      if (g.ip) return keepIp(m) ? m : alias('ip', m);
      if (g.fqdn) return FILE_EXT.test(m) || /^\d/.test(m) || /^(node|www)\./i.test(m) ? m : alias('host', m);
      return m;
    }
  }
  /** An object/array with every string anonymised; keys that hold secrets are left out */
  function deep(v, depth = 0) {
    if (typeof v === 'string') return anon(v);
    if (v === null || typeof v !== 'object' || depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => deep(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET_NAME.test(k)) out[k] = deep(x, depth + 1);
    return out;
  }
  return {
    enabled,
    anon,
    deep,
    alias: (kind, real) => (enabled && real ? alias(kind, real) : real),
    /** New placeholders are kept for good: the same in the next package, and they can be looked up */
    flush() {
      if (!fresh.length) return;
      const ins = db.prepare('INSERT OR IGNORE INTO diag_alias(kind, real, alias, created_at) VALUES(?,?,?,?)');
      const at = new Date().toISOString();
      db.transaction(() => { for (const [k, r, a] of fresh.splice(0)) ins.run(k, r, a, at); })();
    },
  };
}

// --- Package ----------------------------------------------------------------------------------------------
function csv(rows, cols) {
  // (the same cells as the inventory export: names and messages from the network never run as a formula)
  return `﻿${[cols.join(';'), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(';'))].join('\r\n')}\r\n`;
}
const json = (v) => `${JSON.stringify(v, null, 1)}\n`;
const normMsg = (m) => String(m).replace(/\d+(\.\d+)?/g, '#').slice(0, 200);

/** Which version ran at a moment ("vor 0.22.0" for lines older than the first known start) */
function versionAt(hist) {
  return (ts) => {
    if (!hist.length) return config.version;
    let v = null;
    for (const h of hist) { if (h.started_at <= ts) v = h.version; else break; }
    return v || `vor ${hist[0].version}`;
  };
}

/** Changelog from the oldest version in the period up to this one (German) */
function changesSince(oldest) {
  const out = ['# Änderungen seit der ältesten Version im Zeitraum', ''];
  for (const c of CHANGELOG) {
    out.push(c.version === 'next' ? `## ${config.version} (diese Version)` : `## ${c.version} - ${c.date}`, '', ...c.de.map((x) => `- ${x}`), '');
    if (c.version === oldest) break;
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function sizeOf(file) { try { return fs.statSync(file).size; } catch { return null; } }
function dirSize(dir) {
  try { return fs.readdirSync(dir).reduce((n, f) => n + (sizeOf(`${dir}/${f}`) || 0), 0); } catch { return null; }
}

/** The backups at a glance: how many, compressed or not, the newest (names only carry dates) */
function backupFiles(dir) {
  try {
    const names = fs.readdirSync(dir).filter((f) => /^whatsonmynet-.*\.sqlite(\.gz)?$/.test(f)).sort();
    const daily = names.filter((f) => /^whatsonmynet-\d{4}-/.test(f));
    return { count: names.length, compressed: names.filter((f) => f.endsWith('.gz')).length, uncompressed: names.filter((f) => !f.endsWith('.gz')).length,
      daily: daily.length, newestDaily: daily.at(-1) ?? null };
  } catch { return null; }
}

export function createDiagnostics({ db, settings, failover = null, dbFile = paths.db, backupsDir = paths.backups }) {
  const insert = db.prepare('INSERT INTO server_log(at, level, message) VALUES(?,?,?)');
  // made after the diagnostics (app.js): the receivers of the messages, the event rules, the keys for /metrics
  const src = { events: null, eventRules: null, apiTokens: null };
  let building = false;
  let inserted = 0;

  function prune() {
    db.prepare('DELETE FROM server_log WHERE at < ?').run(iso(Date.now() - KEEP_DAYS * DAY));
    const over = db.prepare('SELECT COUNT(*) n FROM server_log').get().n - KEEP_ROWS;
    if (over > 0) db.prepare('DELETE FROM server_log WHERE id IN (SELECT id FROM server_log ORDER BY id LIMIT ?)').run(over);
  }

  function recordStart() {
    const cur = db.prepare('SELECT version FROM version_history ORDER BY started_at DESC LIMIT 1').get();
    if (!cur || cur.version !== config.version) db.prepare('INSERT OR REPLACE INTO version_history(started_at, version) VALUES(?,?)').run(new Date().toISOString(), config.version);
  }

  function settingsOut(an) {
    const keys = new Set([...Object.keys(DEFAULTS), ...db.prepare('SELECT key FROM settings').all().map((r) => r.key)]);
    const out = {};
    for (const k of [...keys].sort()) {
      if (NEVER_SETTING.test(k) || settings.isSecret(k)) { if (settings.isSecret(k) || /\.ca$/.test(k)) out[k] = settings.get(k) ? '(gesetzt)' : '(leer)'; continue; }
      // account names (SMTP user, sender) are names too, even when they do not look like one ("m024c94f")
      const v = settings.get(k);
      if (/\.(user|username|from|to)$/i.test(k) && typeof v === 'string' && v && an.enabled) { out[k] = /@/.test(v) ? an.anon(v) : an.alias('user', v); continue; }
      out[k] = an.deep(v);
    }
    return out;
  }

  function environment(an) {
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      // counted up to 100 000 (more: "more than 100 000") - a full COUNT(*) of tables with millions of rows held the
      // server up for seconds, and the package must take as long with 20 million messages as with 20 000
      try {
        const n = db.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM "${name}" LIMIT ${TABLE_COUNT_MAX + 1})`).get().n;
        tables[name] = n > TABLE_COUNT_MAX ? `> ${TABLE_COUNT_MAX}` : n;
      } catch { tables[name] = null; }
    }
    const mem = process.memoryUsage();
    let fo = null;
    try { fo = failover ? an.deep(failover.status()) : null; } catch (e) { fo = { error: an.anon(e.message) }; }
    if (fo) delete fo.envKey;
    return {
      version: config.version, node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length,
      memory: { total: os.totalmem(), free: os.freemem(), rss: mem.rss, heapUsed: mem.heapUsed },
      uptime_s: Math.round(process.uptime()), system_uptime_s: Math.round(os.uptime()), timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      config: { httpsPort: config.httpsPort, httpPort: config.httpPort, baseUrl: an.anon(config.baseUrl), hsts: config.hsts, trustProxy: an.anon(config.trustProxy),
        logLevel: config.logLevel, sessionHours: config.sessionHours, composeVersion: config.composeVersion },
      database: { schema: db.pragma('user_version', { simple: true }), size: sizeOf(dbFile), wal: sizeOf(`${dbFile}-wal`), backups: dirSize(backupsDir), backupFiles: backupFiles(backupsDir), backupKeep: settings.get('backup.keep'), tables,
        // (the number from the counts per hour and the messages not counted yet - COUNT(*) read the whole file)
        events: { size: sizeOf(eventsFile(dbFile)), wal: sizeOf(`${eventsFile(dbFile)}-wal`), rows: messageRows() } },
      failover: fo,
    };
  }

  /** Messages kept: the counts per hour and those not counted yet (not COUNT(*) over a file of millions of messages) */
  function messageRows() {
    try {
      if (src.events) return src.events.storage().total;
    } catch { /* below */ }
    return db.prepare('SELECT COUNT(*) n FROM events_in').get().n;
  }

  function monitorsOut(since, an) {
    // checks in the period from the hours (not every check: hundreds of thousands, read whole each time)
    // (from the monitors: each one's hours along its key - the hours are kept 400 days)
    const stats = new Map(db.prepare(`SELECT m.id monitor_id, SUM(h.total) n, SUM(h.total - h.ok) failed, ROUND(SUM(h.ms_sum) * 1.0 / NULLIF(SUM(h.ok), 0)) ms
      FROM monitors m CROSS JOIN monitor_hourly h ON h.monitor_id = m.id AND h.hour >= ? GROUP BY m.id`).all(String(since).slice(0, 13)).map((r) => [r.monitor_id, r]));
    const events = new Map(db.prepare('SELECT monitor_id, COUNT(*) n FROM (SELECT monitor_id, at FROM monitor_events ORDER BY id DESC LIMIT 100000) WHERE at >= ? GROUP BY monitor_id').all(since).map((r) => [r.monitor_id, r.n]));
    // groups by number (their names are the user's own words): GROUP-1, GROUP-2 … - the same in the group monitors
    const rows = db.prepare('SELECT * FROM monitors ORDER BY id').all();
    const groupNames = [...new Set(rows.flatMap((m) => [m.group_name, m.type === 'group' ? parse(m.options)?.group : ''])
      .map((g) => String(g || '').trim().toLowerCase()).filter(Boolean))].sort();
    const grp = (g) => { const i = groupNames.indexOf(String(g || '').trim().toLowerCase()); return i < 0 ? '' : `GROUP-${i + 1}`; };
    return rows.map((m) => {
      const s = stats.get(m.id) || {};
      const opts = parse(m.options);
      if (m.type === 'group' && opts) opts.group = grp(opts.group);
      return { id: m.id, type: m.type, name: an.anon(m.name), target: an.anon(m.target), port: m.port, device_id: m.device_id, parent_id: m.parent_id,
        enabled: !!m.enabled, interval_s: m.interval_s, timeout_s: m.timeout_s, fail_threshold: m.fail_threshold, status: m.status, status_since: m.status_since,
        last_check: m.last_check, last_ms: m.last_ms, last_message: an.anon(m.last_message), fail_count: m.fail_count,
        group: grp(m.group_name), options: an.deep(opts), data: an.deep(parse(m.data)),
        period: { checks: s.n || 0, failed: s.failed || 0, avg_ms: s.ms ?? null, events: events.get(m.id) || 0 } };
    });
  }

  /** The shape of stored data: keys with counts, no contents (serial numbers, addresses …) */
  const shape = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, Array.isArray(v) ? `${v.length} Einträge` : v && typeof v === 'object' ? 'Objekt' : typeof v]));
  const values = (list, an) => list.map((x) => ({ metric: x.metric, key: an.anon(x.key ?? ''), name: an.anon(x.name ?? ''), value: typeof x.value === 'string' ? an.anon(x.value) : x.value, unit: x.unit || '' }));

  // (async: a break after every few devices - each one's values are worked out, a thousand of them took seconds)
  async function devicesOut(an) {
    const lim = { printerThreshold: Number(settings.get('printer.threshold')) || 15, nasThreshold: Number(settings.get('nas.threshold')) || 90 };
    const snmp = new Map(db.prepare('SELECT * FROM snmp_status').all().map((r) => [r.device_id, r]));
    const printers = new Map(db.prepare('SELECT * FROM printer_status').all().map((r) => [r.device_id, r]));
    const reports = new Map(db.prepare('SELECT device_id, at, data FROM host_reports').all().map((r) => [r.device_id, r]));
    const mons = new Map(db.prepare('SELECT device_id, COUNT(*) n FROM monitors WHERE device_id IS NOT NULL GROUP BY device_id').all().map((r) => [r.device_id, r.n]));
    const out = [];
    for (const d of db.prepare('SELECT id, name, type, vendor, model, os, ip, mac, hostname, location_id, auto_watch, auto_fields, first_seen, last_seen, created_at FROM devices ORDER BY id').all()) {
      if (out.length % 25 === 24) await new Promise((res) => setImmediate(res));
      const s = snmp.get(d.id); const p = printers.get(d.id); const r = reports.get(d.id);
      const rd = r ? parse(r.data) : null;
      let vals = [];
      try { vals = values(metricsFor(db, d.id, lim), an); } catch (e) { vals = [{ error: an.anon(e.message) }]; }
      out.push({ id: d.id, name: an.alias('device', d.name), type: d.type, vendor: d.vendor, model: d.model, os: d.os, ip: an.anon(d.ip || ''), mac: an.anon(d.mac || ''),
        hostname: an.anon(d.hostname), location_id: d.location_id, first_seen: d.first_seen, last_seen: d.last_seen, created_at: d.created_at,
        auto_watch: parse(d.auto_watch, null), auto_fields: Object.keys(parse(d.auto_fields)), monitors: mons.get(d.id) || 0, source: sourceOf(db, d.id),
        snmp: s ? { kind: s.kind, at: s.at, ok: !!s.ok, error: an.anon(s.error), data: shape(parse(s.data)), alerts: Object.keys(parse(s.alerts)).length } : null,
        printer: p ? { at: p.at, ok: !!p.ok, error: an.anon(p.error), data: shape(parse(p.data)) } : null,
        script: r ? { at: r.at, gone: reportGone(r.at), version: rd.script || null, pools: poolsOut(rd.pools, an), data: shape(rd) } : null,
        values: vals });
    }
    return out;
  }

  /** Storage pools without their names in the clear (pools and nodes as placeholders) */
  const poolsOut = (list, an) => (Array.isArray(list) && list.length ? list.map((p) => ({ kind: p.kind, name: an.alias('pool', p.name), node: p.node ? an.alias('node', p.node) : '',
    state: p.state, good: p.good, pct: p.pct, down: p.down, scrubAt: p.scrubAt, scrubErrors: p.scrubErrors, text: an.anon(p.text || '') })) : undefined);
  const countBy = (list, key) => list.reduce((a, x) => { const k = String(key(x)); a[k] = (a[k] || 0) + 1; return a; }, {});

  function hostsOut(an) {
    return db.prepare('SELECT * FROM proxmox_hosts ORDER BY id').all().map((h) => {
      const data = parse(h.data);
      let vals = [];
      try { vals = values(proxmoxMetrics(nodeTempsInto(db, data)), an); } catch (e) { vals = [{ error: an.anon(e.message) }]; }
      return { id: h.id, name: an.alias('hv', h.name), kind: h.kind, url: an.anon(h.url), verify: !!h.verify, own_ca: !!h.ca, last_at: h.last_at, last_ok: !!h.last_ok,
        last_error: an.anon(h.last_error), auto_watch: parse(h.auto_watch, null), data: shape(data),
        // cloud: regions and whether costs are read - never tenant, subscription, project or key
        cloud: data.cloud ? { regions: parse(h.options)?.regions || [], costs: !!parse(h.options)?.costs } : undefined, missing_rights: an.deep(data.missing || []),
        // ZFS, Ceph (Proxmox, TrueNAS, Ceph dashboard): state and why; TrueNAS: its alerts and replications by state
        pools: poolsOut(data.pools, an), version: data.version || undefined,
        alerts: data.kind === 'truenas' ? countBy(data.alerts || [], (a) => a.level) : undefined,
        replications: data.kind === 'truenas' ? countBy(data.replications || [], (r) => (r.enabled ? r.state : 'disabled')) : undefined, values: vals };
    });
  }

  /**
   * Messages of the devices: receivers (port, error, connections), the space of the messages file, what came in the
   * period (by kind, severity, format - Windows through NXLog with or without log and source), the event rules with
   * what they sent and what did not get through, and how many keys /metrics has. Never message texts or rule words in
   * the clear: senders, names and words go through the anonymiser.
   */
  /** The filter of a rule: ids, kinds and severity as they are; senders as placeholders, words only counted (anonymised) */
  const ruleMatchOut = (m, an) => ({ kind: m.kind, maxSeverity: m.maxSeverity, deviceId: m.deviceId, eventIds: m.eventIds, source: m.source, channel: m.channel,
    from: (m.from || []).map((f) => (an.enabled ? (IPV4.test(f) ? an.anon(f) : an.alias('host', f)) : f)),
    words: an.enabled ? `${(m.words || []).length} Wörter` : m.words, notWords: an.enabled ? `${(m.notWords || []).length} Wörter` : m.notWords, regex: an.anon(m.regex || '') });

  function messagesOut(since, an) {
    const out = {};
    if (src.events) {
      const s = src.events.status();
      const st = s.storage || {};
      out.receivers = Object.fromEntries(['traps', 'syslog', 'syslogTcp', 'syslogTls'].map((k) => [k, s[k] ? { on: !!s[k].on, port: s[k].port, error: an.anon(s[k].error || ''), connections: s[k].connections ?? null } : null]));
      out.skipped_too_long = s.skipped || 0;
      out.filtered = s.filtered || 0;
      // flood protection since the start: dropped (UDP, traps) / held back a moment (TCP, TLS); the limit in all
      out.flooded = s.flooded || 0;
      out.held_back = s.heldBack || 0;
      out.per_second = s.perSecond ?? null;
      out.keep_for_all = Number(settings.get('events.minSeverity') ?? 7);
      // Windows event ids left out / only taken (numbers only - they say nothing about the network)
      out.win_deny = String(settings.get('events.winDeny') || '');
      out.win_allow = String(settings.get('events.winAllow') || '');
      // how the senders send (the way of the newest message) and how many still sent over UDP in the last 24 hours
      try {
        out.senders_by_transport = Object.fromEntries(db.prepare("SELECT CASE WHEN transport = '' THEN 'unknown' ELSE transport END t, COUNT(*) n FROM event_senders GROUP BY 1").all().map((r) => [r.t, r.n]));
        out.senders_udp_24h = db.prepare('SELECT COUNT(*) FROM event_senders WHERE udp_at > ?').pluck().get(new Date(Date.now() - 86400000).toISOString());
      } catch { /* older file */ }
      out.sender_filters = db.prepare('SELECT source_ip, min_severity FROM event_source_filters').all().map((f) => ({ sender: an.anon(f.source_ip), min_severity: f.min_severity }));
      out.storage = { used: st.used, limit: st.limit, cap: st.cap, disk_short: !!st.diskShort, total: st.total, per_day: st.perDay, oldest: st.oldest, keep_days: st.keepDays,
        days_fit: st.daysFit, short: !!st.short, top_senders: (st.topSenders || []).map((x) => ({ name: an.anon(x.name), share: x.share })), top_events: st.topEvents || [] };
      // the full-text index: how far it is (its size is part of "used")
      const si = s.searchIndex || {};
      out.search_index = { building: !!si.building, share: si.share ?? null, behind: si.behind ?? null };
      // the counts per minute (timeline, by sender, space): messages not counted yet
      out.counts_behind = s.counts?.behind ?? null;
      try { out.saved_searches = db.prepare('SELECT COUNT(*) n, SUM(shared) shared FROM event_searches').get(); } catch { /* older database */ }
    }
    // The period from the counts per hour (sender, kind, severity; event ids) - what only the messages themselves say
    // (format, device, texts, sources) from the newest of the period: a full pass over millions of messages and their
    // texts took the server minutes, during which it answered nobody
    const hour = Math.floor(Date.parse(since) / 3600000);
    // the counts and, on top, the messages not counted yet (the newest few; after an update until the counts caught up)
    // (at most the newest 100 000 of them: right after an update the counts may be behind by millions; NOT INDEXED: along
    // the numbers - SQLite would otherwise take the index of the senders, all messages)
    const counted = Math.max(db.prepare("SELECT v FROM events_fts_state WHERE k = 'counted'").pluck().get() ?? 0,
      (db.prepare('SELECT MAX(id) FROM events_in').pluck().get() ?? 0) - 100000);
    const h = (counts, raw) => db.prepare(`SELECT k, SUM(n) n FROM (${counts} UNION ALL ${raw}) GROUP BY k HAVING SUM(n) > 0`).all(hour, counted, since);
    const SAMPLE = 50000;
    // the newest by number, then those of the period - read once, only the columns needed ("WHERE at >= ? ORDER BY id"
    // let SQLite fetch and sort the whole period first: with 20 million messages that would take long again)
    const sample = db.prepare(`SELECT event_id, channel, app, device_id IS NOT NULL dev, instr(text, char(65533)) > 0 bad
      FROM (SELECT event_id, channel, app, device_id, text, at FROM events_in ORDER BY id DESC LIMIT ${SAMPLE}) WHERE at >= ?`).all(since);
    const q = (sql) => db.prepare(sql).all(since);
    const tally = (f) => { const m = new Map(); for (const r of sample) { const k = f(r); if (k !== null) m.set(k, (m.get(k) || 0) + 1); } return m; };
    const bySender = h('SELECT source_ip k, SUM(n) n FROM events_hour WHERE hour >= ? GROUP BY 1', 'SELECT source_ip k, COUNT(*) n FROM events_in NOT INDEXED WHERE id > ? AND at >= ? GROUP BY 1');
    out.period = {
      by_kind: Object.fromEntries(h('SELECT kind k, SUM(n) n FROM events_hour WHERE hour >= ? GROUP BY 1', 'SELECT kind k, COUNT(*) n FROM events_in NOT INDEXED WHERE id > ? AND at >= ? GROUP BY 1').map((r) => [r.k, r.n])),
      by_severity: Object.fromEntries(h('SELECT severity k, SUM(n) n FROM events_hour WHERE hour >= ? GROUP BY 1', 'SELECT severity k, COUNT(*) n FROM events_in NOT INDEXED WHERE id > ? AND at >= ? GROUP BY 1').map((r) => [r.k, r.n])),
      senders: bySender.length,
      senders_known: db.prepare('SELECT COUNT(*) n FROM event_senders').get().n,
      top_event_ids: h('SELECT event_id k, SUM(n) n FROM events_hour_id WHERE hour >= ? GROUP BY 1', 'SELECT event_id k, COUNT(*) n FROM events_in NOT INDEXED WHERE id > ? AND at >= ? AND event_id IS NOT NULL GROUP BY 1')
        .sort((a, b) => b.n - a.n || a.k - b.k).slice(0, 15).map((r) => ({ event_id: r.k, n: r.n })),
      // of the newest messages of the period (at most this many - the figures below are shares of them)
      sample: sample.length,
      // the shape NXLog sends: with log and source ([id] [log] or JSON), only the id (its own line format), or no Windows event
      by_format: Object.fromEntries(tally((r) => (r.event_id === null ? 'syslog' : (r.channel || r.app) ? 'windows_full' : 'windows_id_only'))),
      matched_to_device: { yes: sample.filter((r) => r.dev).length, no: sample.filter((r) => !r.dev).length },
      // texts that were not UTF-8 (read as Windows-1252, e.g. NXLog on a German Windows)
      text_with_replacement_char: sample.filter((r) => r.bad).length,
      top_sources: [...tally((r) => (r.app ? r.app : null))].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15).map(([app, n]) => ({ app, n })),
    };
    out.event_monitors = db.prepare("SELECT COUNT(*) n, SUM(enabled) enabled FROM monitors WHERE type='event'").get();
    if (src.eventRules) {
      out.rules = src.eventRules.list().map((r) => ({ id: r.id, name: an.anon(r.name), enabled: r.enabled, mode: r.mode, digest_min: r.digest_min, max_per_hour: r.max_per_hour,
        channels: r.channels, match: ruleMatchOut(r.match, an), blocked_ids: r.blocked || [], count: r.count,
        state: r.state ? { open: !!r.state.open, closeWords: an.enabled ? `${(r.state.closeWords || []).length} Wörter` : r.state.closeWords, closeIds: r.state.closeIds, closeRegex: an.anon(r.state.closeRegex || ''),
          expireHours: r.state.expireHours, notifyClose: !!r.state.notifyClose } : null, disabled_reason: r.disabled_reason || '', counting: r.counting, open_events: r.openEvents, hits24h: r.hits24h, open: r.open, failed24h: r.failed24h, last_hit: r.lastHit }));
    }
    out.open_events = { by_state: Object.fromEntries(db.prepare('SELECT state k, COUNT(*) n FROM event_open GROUP BY state').all().map((r) => [r.k, r.n])),
      closed_how_period: Object.fromEntries(q("SELECT closed_how k, COUNT(*) n FROM event_open WHERE closed_at >= ? GROUP BY closed_how").map((r) => [r.k, r.n])) };
    // (of the newest 100 000 hits: they grow with the messages a rule matches)
    out.rule_hits_period = q('SELECT COUNT(*) n, SUM(sent_at IS NOT NULL AND failed = 0) sent, SUM(failed) failed, SUM(sent_at IS NULL) open, MAX(tries) max_tries FROM (SELECT * FROM event_rule_hits ORDER BY id DESC LIMIT 100000) WHERE at >= ?')[0];
    if (src.apiTokens) out.metrics_keys = src.apiTokens.list().map((k) => ({ created_at: k.created_at, last_used: k.last_used }));
    return out;
  }

  function stats(since, logs, monitors) {
    const count = (list, f) => list.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});
    const top = Object.entries(count(logs.filter((l) => l.level !== 'info' && l.level !== 'debug'), (l) => normMsg(l.message)))
      .sort((a, b) => b[1] - a[1]).slice(0, 30).map(([message, n]) => ({ n, message }));
    return {
      since,
      log: count(logs, (l) => l.level),
      monitors: { by_type: count(monitors, (m) => m.type), by_status: count(monitors, (m) => m.status), paused: monitors.filter((m) => !m.enabled).length,
        // groups of their own (Uptime-Kuma-like) and how many monitors are in one
        groups: new Set(monitors.map((m) => m.group).filter(Boolean)).size, in_group: monitors.filter((m) => m.group).length },
      // status pages without login: how many, how reached - never their addresses (a secret link is a key)
      status_pages: db.prepare(`SELECT COUNT(*) n, SUM(enabled) enabled, SUM(access='link') secret_link, SUM(access='open') own_address,
        SUM(networks <> '[]') limited_to_networks, SUM(json_array_length(items)) items FROM status_pages`).get(),
      // plugins of the host script: how many, for which system, how far rolled out - never their code
      // devices whose network ports are watched (off by default), by type
      watch_ports: Object.fromEntries(db.prepare('SELECT type, COUNT(*) n FROM devices WHERE watch_ports=1 GROUP BY type').all().map((r) => [r.type, r.n])),
      plugins: db.prepare(`SELECT os, COUNT(*) n, SUM(enabled) enabled, MAX(version) newest_version, SUM(targets LIKE '%"all":true%') for_all, SUM(interval_min > 5) less_often FROM plugins GROUP BY os`).all(),
      plugin_states: Object.fromEntries(db.prepare(`SELECT json_extract(p.value,'$.state') state, COUNT(*) n FROM host_reports h, json_each(h.data,'$.plugins') p GROUP BY 1`).all().map((r) => [r.state, r.n])),
      // machine scripts by version and how their last self-update went (failed ones with the message - never a key)
      host_script_versions: Object.fromEntries(db.prepare(`SELECT coalesce(json_extract(data,'$.script'),'(none)') v, COUNT(*) n FROM host_reports GROUP BY 1`).all().map((r) => [r.v, r.n])),
      host_self_update: {
        ...db.prepare(`SELECT coalesce(SUM(json_extract(data,'$.selfUpdate.ok')=1),0) ok, coalesce(SUM(json_extract(data,'$.selfUpdate.ok')=0),0) failed FROM host_reports`).get(),
        // without names, addresses and paths a message may carry (Windows quotes the host it could not reach)
        messages: [...new Set(db.prepare(`SELECT json_extract(data,'$.selfUpdate.message') m FROM host_reports WHERE json_extract(data,'$.selfUpdate.ok')=0`).all()
          .map((r) => String(r.m || '').replace(/https?:\/\/\S+|'[^']*'|"[^"]*"|\/\S+|[A-Za-z]:\\\S+|\[?[0-9a-f]*:[0-9a-f:]{2,}\]?(:\d+)?|\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b|\b[\w-]+(\.[\w-]+)+\b/gi, '…').slice(0, 160)).filter(Boolean))].slice(0, 10),
      },
      // scan agents by the SNMP access data they get (none / own / all) - never the data themselves
      agents_snmp: Object.fromEntries(db.prepare('SELECT snmp_mode, COUNT(*) n FROM agents GROUP BY snmp_mode').all().map((r) => [r.snmp_mode, r.n])),
      // monitors whose address is checked again on every run (set by a non-admin) - and how many of those failed for it
      target_checked: db.prepare("SELECT COUNT(*) n, SUM(last_message LIKE 'target address not allowed%') refused FROM monitors WHERE target_rule IS NOT NULL").get(),
      checks: db.prepare('SELECT m.type, SUM(h.total) n, SUM(h.total - h.ok) failed FROM monitors m CROSS JOIN monitor_hourly h ON h.monitor_id = m.id AND h.hour >= ? GROUP BY m.type').all(String(since).slice(0, 13)),
      events: Object.fromEntries(db.prepare('SELECT kind, COUNT(*) n FROM (SELECT kind, at FROM monitor_events ORDER BY id DESC LIMIT 100000) WHERE at >= ? GROUP BY kind').all(since).map((r) => [r.kind, r.n])),
      scans: db.prepare('SELECT kind, status, COUNT(*) n FROM scans WHERE started_at >= ? GROUP BY kind, status').all(since),
      frequent_warnings: top,
    };
  }

  function readme(label, since, anonymised) {
    return `WhatsOnMyNet - Diagnosepaket / diagnostic package
Version ${config.version}, erstellt ${new Date().toISOString()}, Zeitraum: ${label} (ab ${since})
Anonymisiert: ${anonymised ? 'ja' : 'NEIN - enthält echte Namen und Adressen'}

Dateien
  versionen.json         Versionsgeschichte (ab wann welche Version lief), Versionen im Zeitraum
  aenderungen.md         Änderungen von der ältesten Version im Zeitraum bis heute
  umgebung.json          Version, System, Speicher, Datenbank (Tabellen und Größen), Ausfallsicherung
  einstellungen.json     Einstellungen (Kennwörter, Communities und Schlüssel nur als „gesetzt“/„leer“)
  statistik.json         Protokoll nach Stufe, Monitore nach Art und Zustand, Prüfungen, Ereignisse, Scans, häufigste Warnungen
  protokoll.csv          Protokoll des Programms im Zeitraum (höchstens ${MAX_LOG_ROWS} Zeilen, neueste zuerst; aufbewahrt ${KEEP_DAYS} Tage)
  fehler.txt             Warnungen und Fehler mit Version
  monitore.json          Alle Monitore und Sensoren: Einstellungen, Zustand, Prüfungen und Ausfälle im Zeitraum
  ereignisse.csv         Ausfälle, Erholungen, Alarme im Zeitraum
  geraete.json           Geräte: Art, Quelle (SNMP, Skript, Drucker), letzte Abfrage mit Fehler, Aufbau der Daten, die Werte für Sensoren
  hypervisoren.json      Hypervisoren, Controller, Cloud, Veeam, Microsoft 365: letzte Abfrage, Fehler, fehlende Rechte, Werte für Sensoren
  meldungen.json         Syslog/Traps: Empfänger (Ports, Fehler, Verbindungen), Platz der Meldungsdatei, Meldungen im Zeitraum
                         (Art, Schwere, Absender, Ereignis-IDs aus den Stundenzählern; Format von NXLog, Quellen und Geräte-
                         zuordnung aus den neuesten 50 000 - „sample“), Ereignisregeln mit Versand und Fehlversuchen,
                         Schlüssel für /metrics
  scans.csv              Scans im Zeitraum
  benachrichtigungen.json Kanäle (Art, an/aus, Sprache - ohne Zugangsdaten)
  aktionen.csv           Was Benutzer im Zeitraum getan haben (Anlegen, Ändern, Löschen …)

${anonymised ? `Anonymisierung: Namen von Geräten, Hosts, Knoten und Gästen, Benutzer, Mail-, IP- und MAC-Adressen, Rechnernamen,
Standorte, Verzeichnispfade und Kanäle sind durch Platzhalter ersetzt (GERAET-001, HOST-003, 10.99.0.7 …). Sie bleiben in
jedem Paket gleich. Die Zuordnung liegt nur auf Ihrem Server (Einstellungen → Diagnose).
` : ''}Kennwörter, Schlüssel, Tokens und Communities sind nie enthalten. Nichts davon wird automatisch verschickt.

English: the same files with German names. Anonymised packages replace names and addresses with placeholders that
stay the same in every package; the mapping stays on your server (Settings → Diagnostics). Passwords, keys, tokens
and communities are never included. Nothing is sent anywhere by itself.
`;
  }

  /** days 1-30, or 0 = since the last update. Returns { buffer, filename } */
  /**
   * The package, file by file with a break after each: the web pages and the receivers get their turn in between
   * (built in one go, a large installation held the server up for minutes - the pages said "not reachable").
   */
  async function build({ days = 7, anonymize = true } = {}) {
    if (building) throw Object.assign(new Error('busy'), { busy: true });
    building = true;
    const pause = () => new Promise((r) => setImmediate(r));
    try {
      const hist = db.prepare('SELECT started_at, version FROM version_history ORDER BY started_at').all();
      const vat = versionAt(hist);
      const d = Number(days);
      let since; let label; let tag;
      if (!d || d <= 0) {
        since = [hist.at(-1)?.started_at || iso(Date.now() - KEEP_DAYS * DAY), iso(Date.now() - KEEP_DAYS * DAY)].sort().at(-1);
        label = 'seit dem letzten Update'; tag = 'seit-update';
      } else {
        const n = Math.min(KEEP_DAYS, Math.max(1, Math.round(d)));
        since = iso(Date.now() - n * DAY); label = `letzte ${n} Tage`; tag = `${n}T`;
      }
      const an = createAnonymizer(db, !!anonymize);
      await pause();
      // (anonymised with a break every 2 000 lines)
      const logs = [];
      for (const l of db.prepare('SELECT at, level, message FROM server_log WHERE at >= ? ORDER BY id DESC LIMIT ?').all(since, MAX_LOG_ROWS)) {
        if (logs.length % 2000 === 1999) await pause();
        logs.push({ at: l.at, version: vat(l.at), level: l.level, message: an.anon(String(l.message).slice(0, MAX_MESSAGE)) });
      }
      const errors = logs.filter((l) => l.level === 'warn' || l.level === 'error').map((l) => `${l.at} [${l.version}] ${l.level.toUpperCase()} ${l.message}`);
      await pause();
      const monitors = monitorsOut(since, an);
      await pause();
      const events = db.prepare('SELECT e.at, e.monitor_id, m.type, e.kind, e.message, e.notified FROM monitor_events e LEFT JOIN monitors m ON m.id=e.monitor_id WHERE e.at >= ? ORDER BY e.id DESC LIMIT 20000').all(since)
        .map((e) => ({ ...e, version: vat(e.at), message: an.anon(e.message) }));
      const scans = db.prepare('SELECT id, kind, status, targets, started_at, finished_at, user, stats, error FROM scans WHERE started_at >= ? ORDER BY id DESC').all(since)
        .map((s) => ({ ...s, version: vat(s.started_at), targets: an.anon(s.targets), user: an.alias('user', s.user), stats: an.anon(s.stats), error: an.anon(s.error || '') }));
      const actions = db.prepare('SELECT at, user, action, detail FROM audit WHERE at >= ? ORDER BY id DESC LIMIT 20000').all(since)
        .map((a) => ({ ...a, user: a.user === 'system' ? a.user : an.alias('user', a.user), detail: an.anon(a.detail) }));
      const channels = db.prepare('SELECT id, name, type, language, is_default, enabled, created_at FROM channels ORDER BY id').all()
        .map((c) => ({ ...c, name: an.alias('channel', c.name), is_default: !!c.is_default, enabled: !!c.enabled }));
      const inPeriod = [...new Set([...logs.map((l) => l.version), config.version])];
      const oldest = hist.map((h) => h.version).find((v) => inPeriod.includes(v)) || config.version;
      const files = [];
      const add = async (name, fn) => {
        await pause();
        try { files.push({ name, data: await fn() }); } catch (e) { files.push({ name, data: json({ error: an.anon(e.message).slice(0, 500) }) }); }
      };
      await add('LIESMICH.txt', () => readme(label, since, an.enabled));
      // placeholders made so far are kept now - so the table counts in umgebung.json are right too
      an.flush();
      await add('versionen.json', () => json({ current: config.version, since: hist.at(-1)?.started_at || null, in_period: inPeriod, history: hist,
        note: 'Zeilen vor der ersten bekannten Version: „vor X“ (die Versionsgeschichte wird seit dem Diagnosepaket geführt).' }));
      await add('aenderungen.md', () => changesSince(oldest));
      await add('umgebung.json', () => json(environment(an)));
      await add('einstellungen.json', () => json(settingsOut(an)));
      await add('statistik.json', () => json(stats(since, logs, monitors)));
      await add('protokoll.csv', () => csv(logs, ['at', 'version', 'level', 'message']));
      await add('fehler.txt', () => `${errors.join('\n') || 'Keine Warnungen oder Fehler im Zeitraum.'}\n`);
      await add('monitore.json', () => json(monitors));
      await add('ereignisse.csv', () => csv(events, ['at', 'version', 'monitor_id', 'type', 'kind', 'message', 'notified']));
      await add('geraete.json', async () => json(await devicesOut(an)));
      await add('hypervisoren.json', () => json(hostsOut(an)));
      await add('meldungen.json', () => json(messagesOut(since, an)));
      await add('scans.csv', () => csv(scans, ['id', 'version', 'kind', 'status', 'started_at', 'finished_at', 'user', 'targets', 'stats', 'error']));
      await add('benachrichtigungen.json', () => json(channels));
      await add('aktionen.csv', () => csv(actions, ['at', 'user', 'action', 'detail']));
      an.flush();
      const filename = `whatsonmynet-diagnose-${config.version}-${new Date().toISOString().slice(0, 10)}-${tag}${an.enabled ? '-anonym' : ''}.zip`;
      return { buffer: zip(files), filename, label };
    } finally { building = false; }
  }

  return {
    /** From now on the log lines also go to server_log; the running version is noted */
    start() {
      try { recordStart(); } catch { /* never stops the start */ }
      setLogSink((e) => {
        insert.run(e.at, e.level, String(e.message).slice(0, MAX_MESSAGE));
        if (++inserted % 5000 === 0) prune();
      });
    },
    stop() { setLogSink(null); },
    prune,
    recordStart,
    build,
    /** Placeholder → real name (only for administrators in the interface) */
    lookup(q) {
      const a = String(q ?? '').trim();
      if (!a) return [];
      return db.prepare('SELECT kind, alias, real FROM diag_alias WHERE lower(alias)=lower(?) OR lower(real)=lower(?) ORDER BY kind LIMIT 20').all(a, a);
    },
    mappingCsv() {
      return csv(db.prepare('SELECT kind, alias, real, created_at FROM diag_alias ORDER BY kind, alias').all(), ['kind', 'alias', 'real', 'created_at']);
    },
    aliasCount: () => db.prepare('SELECT COUNT(*) n FROM diag_alias').get().n,
    /** The parts made after the diagnostics (app.js) */
    useSources(s) { Object.assign(src, s); },
  };
}
