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
import fs from 'node:fs';
import os from 'node:os';
import { config, paths } from './config.js';
import { setLogSink } from './lib/log.js';
import { zip } from './lib/zip.js';
import { DEFAULTS } from './settings.js';
import { metricsFor, sourceOf } from './monitor/sensors.js';
import { proxmoxMetrics } from './proxmox.js';
import { nodeTempsInto } from './hosts.js';
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
// "password=…", "token: …" in free text (log lines, error messages)
const SECRET_IN_TEXT = /\b(password|passwort|kennwort|secret|token|community|apikey|api_key|authorization)(["'\s]*[:=]\s*["']?)([^\s"',;&]+)/gi;
const USERINFO = /(\/\/)[^\s/@:]+:[^\s/@]*@/g;

/** Passwords in free text and user:password@ in addresses - always, also without anonymising */
export function maskSecrets(text) {
  return String(text ?? '').replace(USERINFO, '$1***:***@').replace(SECRET_IN_TEXT, (_, k, sep) => `${k}${sep}***`);
}

// --- Placeholders ------------------------------------------------------------------------------------------
const PREFIX = { device: 'GERAET', host: 'HOST', hv: 'HV', node: 'KNOTEN', guest: 'GAST', user: 'USER', mail: 'MAIL', location: 'STANDORT',
  channel: 'KANAL', mac: 'MAC', dn: 'DN', ip: 'IP' };
// Words too general to be a name worth hiding (a device called "NAS" stays "NAS")
const COMMON = new Set(['nas', 'switch', 'router', 'firewall', 'server', 'drucker', 'printer', 'proxmox', 'pve', 'pbs', 'local', 'admin', 'administrator',
  'test', 'user', 'users', 'system', 'default', 'gast', 'guest', 'online', 'offline', 'windows', 'linux', 'docker', 'backup', 'storage', 'usv', 'ups',
  'telegram', 'webhook', 'mail', 'email', 'monitor', 'sensor', 'ping', 'http', 'https', 'lan', 'wlan', 'wifi', 'none', 'unknown', 'auto', 'node', 'host']);
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

  // Names from the database: the longest first, so "pve2.firma.local" is one placeholder, not "KNOTEN-001.firma.local"
  const vocab = new Map(); // lower → [kind, real]
  const add = (kind, v) => {
    const s = String(v ?? '').trim();
    if (s.length < 3 || COMMON.has(s.toLowerCase()) || /^\d+$/.test(s) || IPV4.test(s) && s.match(IPV4)[0] === s) return;
    if (!vocab.has(s.toLowerCase())) vocab.set(s.toLowerCase(), [kind, s]);
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
    }
    for (const r of db.prepare('SELECT hostname FROM host_unmatched').all()) { add('host', r.hostname); add('host', String(r.hostname).split('.')[0]); }
    for (const u of db.prepare('SELECT username, display_name FROM users').all()) { add('user', u.username); add('user', u.display_name); }
    for (const l of db.prepare('SELECT name FROM locations').all()) add('location', l.name);
    for (const c of db.prepare('SELECT name FROM channels').all()) add('channel', c.name);
  }
  const names = [...vocab.keys()].sort((a, b) => b.length - a.length).map(esc);
  const parts = [
    `(?<mail>${MAILRX.source})`,
    `(?<dn>${DNRX.source})`,
    ...(names.length ? [`(?<![\\p{L}\\p{N}_-])(?<name>${names.join('|')})(?![\\p{L}\\p{N}_-])`] : []),
    `(?<mac>${MAC.source})`,
    `(?<ip>${IPV4.source})`,
    `(?<fqdn>${FQDN.source})`,
  ];
  const all = new RegExp(parts.join('|'), 'giu');

  function anon(text) {
    let s = maskSecrets(text);
    if (!enabled || !s) return s;
    return s.replace(all, (m, ...args) => {
      const g = args[args.length - 1];
      if (g.mail) return alias('mail', m);
      if (g.dn) {
        const [, k, v] = m.match(new RegExp(DNRX.source, 'i'));
        return COMMON.has(v.trim().toLowerCase()) || /^(com|net|org|de|local|lan)$/i.test(v.trim()) ? m : `${k}=${alias('dn', v.trim())}`;
      }
      if (g.name) { const [kind, real] = vocab.get(m.toLowerCase()); return alias(kind, real); }
      if (g.mac) return alias('mac', m.toLowerCase().replace(/-/g, ':'));
      if (g.ip) return keepIp(m) ? m : alias('ip', m);
      if (g.fqdn) return FILE_EXT.test(m) || /^\d/.test(m) || /^(node|www)\./i.test(m) ? m : alias('host', m);
      return m;
    });
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
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n')}\r\n`;
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

export function createDiagnostics({ db, settings, failover = null, dbFile = paths.db, backupsDir = paths.backups }) {
  const insert = db.prepare('INSERT INTO server_log(at, level, message) VALUES(?,?,?)');
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
      out[k] = an.deep(settings.get(k));
    }
    return out;
  }

  function environment(an) {
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      try { tables[name] = db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n; } catch { tables[name] = null; }
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
      database: { schema: db.pragma('user_version', { simple: true }), size: sizeOf(dbFile), wal: sizeOf(`${dbFile}-wal`), backups: dirSize(backupsDir), tables },
      failover: fo,
    };
  }

  function monitorsOut(since, an) {
    const stats = new Map(db.prepare(`SELECT monitor_id, COUNT(*) n, SUM(ok=0) failed, ROUND(AVG(ms)) ms FROM checks WHERE at >= ? GROUP BY monitor_id`).all(since).map((r) => [r.monitor_id, r]));
    const events = new Map(db.prepare('SELECT monitor_id, COUNT(*) n FROM monitor_events WHERE at >= ? GROUP BY monitor_id').all(since).map((r) => [r.monitor_id, r.n]));
    return db.prepare('SELECT * FROM monitors ORDER BY id').all().map((m) => {
      const s = stats.get(m.id) || {};
      return { id: m.id, type: m.type, name: an.anon(m.name), target: an.anon(m.target), port: m.port, device_id: m.device_id, parent_id: m.parent_id,
        enabled: !!m.enabled, interval_s: m.interval_s, timeout_s: m.timeout_s, fail_threshold: m.fail_threshold, status: m.status, status_since: m.status_since,
        last_check: m.last_check, last_ms: m.last_ms, last_message: an.anon(m.last_message), fail_count: m.fail_count,
        options: an.deep(parse(m.options)), data: an.deep(parse(m.data)),
        period: { checks: s.n || 0, failed: s.failed || 0, avg_ms: s.ms ?? null, events: events.get(m.id) || 0 } };
    });
  }

  /** The shape of stored data: keys with counts, no contents (serial numbers, addresses …) */
  const shape = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, Array.isArray(v) ? `${v.length} Einträge` : v && typeof v === 'object' ? 'Objekt' : typeof v]));
  const values = (list, an) => list.map((x) => ({ metric: x.metric, key: an.anon(x.key ?? ''), name: an.anon(x.name ?? ''), value: typeof x.value === 'string' ? an.anon(x.value) : x.value, unit: x.unit || '' }));

  function devicesOut(an) {
    const lim = { printerThreshold: Number(settings.get('printer.threshold')) || 15, nasThreshold: Number(settings.get('nas.threshold')) || 90 };
    const snmp = new Map(db.prepare('SELECT * FROM snmp_status').all().map((r) => [r.device_id, r]));
    const printers = new Map(db.prepare('SELECT * FROM printer_status').all().map((r) => [r.device_id, r]));
    const reports = new Map(db.prepare('SELECT device_id, at, data FROM host_reports').all().map((r) => [r.device_id, r]));
    const mons = new Map(db.prepare('SELECT device_id, COUNT(*) n FROM monitors WHERE device_id IS NOT NULL GROUP BY device_id').all().map((r) => [r.device_id, r.n]));
    return db.prepare('SELECT id, name, type, vendor, model, os, ip, mac, hostname, location_id, auto_watch, auto_fields, first_seen, last_seen, created_at FROM devices ORDER BY id').all().map((d) => {
      const s = snmp.get(d.id); const p = printers.get(d.id); const r = reports.get(d.id);
      let vals = [];
      try { vals = values(metricsFor(db, d.id, lim), an); } catch (e) { vals = [{ error: an.anon(e.message) }]; }
      return { id: d.id, name: an.alias('device', d.name), type: d.type, vendor: d.vendor, model: d.model, os: d.os, ip: an.anon(d.ip || ''), mac: an.anon(d.mac || ''),
        hostname: an.anon(d.hostname), location_id: d.location_id, first_seen: d.first_seen, last_seen: d.last_seen, created_at: d.created_at,
        auto_watch: parse(d.auto_watch, null), auto_fields: Object.keys(parse(d.auto_fields)), monitors: mons.get(d.id) || 0, source: sourceOf(db, d.id),
        snmp: s ? { kind: s.kind, at: s.at, ok: !!s.ok, error: an.anon(s.error), data: shape(parse(s.data)), alerts: Object.keys(parse(s.alerts)).length } : null,
        printer: p ? { at: p.at, ok: !!p.ok, error: an.anon(p.error), data: shape(parse(p.data)) } : null,
        script: r ? { at: r.at, data: shape(parse(r.data)) } : null,
        values: vals };
    });
  }

  function hostsOut(an) {
    return db.prepare('SELECT * FROM proxmox_hosts ORDER BY id').all().map((h) => {
      const data = parse(h.data);
      let vals = [];
      try { vals = values(proxmoxMetrics(nodeTempsInto(db, data)), an); } catch (e) { vals = [{ error: an.anon(e.message) }]; }
      return { id: h.id, name: an.alias('hv', h.name), kind: h.kind, url: an.anon(h.url), verify: !!h.verify, own_ca: !!h.ca, last_at: h.last_at, last_ok: !!h.last_ok,
        last_error: an.anon(h.last_error), auto_watch: parse(h.auto_watch, null), data: shape(data), missing_rights: an.deep(data.missing || []), values: vals };
    });
  }

  function stats(since, logs, monitors) {
    const count = (list, f) => list.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});
    const top = Object.entries(count(logs.filter((l) => l.level !== 'info' && l.level !== 'debug'), (l) => normMsg(l.message)))
      .sort((a, b) => b[1] - a[1]).slice(0, 30).map(([message, n]) => ({ n, message }));
    return {
      since,
      log: count(logs, (l) => l.level),
      monitors: { by_type: count(monitors, (m) => m.type), by_status: count(monitors, (m) => m.status), paused: monitors.filter((m) => !m.enabled).length },
      checks: db.prepare('SELECT m.type, COUNT(*) n, SUM(c.ok=0) failed FROM checks c JOIN monitors m ON m.id=c.monitor_id WHERE c.at >= ? GROUP BY m.type').all(since),
      events: Object.fromEntries(db.prepare('SELECT kind, COUNT(*) n FROM monitor_events WHERE at >= ? GROUP BY kind').all(since).map((r) => [r.kind, r.n])),
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
  hypervisoren.json      Hypervisoren und Controller: letzte Abfrage, Fehler, fehlende Rechte, Werte für Sensoren
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
  function build({ days = 7, anonymize = true } = {}) {
    if (building) throw Object.assign(new Error('busy'), { busy: true });
    building = true;
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
      const logs = db.prepare('SELECT at, level, message FROM server_log WHERE at >= ? ORDER BY id DESC LIMIT ?').all(since, MAX_LOG_ROWS)
        .map((l) => ({ at: l.at, version: vat(l.at), level: l.level, message: an.anon(String(l.message).slice(0, MAX_MESSAGE)) }));
      const errors = logs.filter((l) => l.level === 'warn' || l.level === 'error').map((l) => `${l.at} [${l.version}] ${l.level.toUpperCase()} ${l.message}`);
      const monitors = monitorsOut(since, an);
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
      const add = (name, fn) => {
        try { files.push({ name, data: fn() }); } catch (e) { files.push({ name, data: json({ error: an.anon(e.message).slice(0, 500) }) }); }
      };
      add('LIESMICH.txt', () => readme(label, since, an.enabled));
      add('versionen.json', () => json({ current: config.version, since: hist.at(-1)?.started_at || null, in_period: inPeriod, history: hist,
        note: 'Zeilen vor der ersten bekannten Version: „vor X“ (die Versionsgeschichte wird seit dem Diagnosepaket geführt).' }));
      add('aenderungen.md', () => changesSince(oldest));
      add('umgebung.json', () => json(environment(an)));
      add('einstellungen.json', () => json(settingsOut(an)));
      add('statistik.json', () => json(stats(since, logs, monitors)));
      add('protokoll.csv', () => csv(logs, ['at', 'version', 'level', 'message']));
      add('fehler.txt', () => `${errors.join('\n') || 'Keine Warnungen oder Fehler im Zeitraum.'}\n`);
      add('monitore.json', () => json(monitors));
      add('ereignisse.csv', () => csv(events, ['at', 'version', 'monitor_id', 'type', 'kind', 'message', 'notified']));
      add('geraete.json', () => json(devicesOut(an)));
      add('hypervisoren.json', () => json(hostsOut(an)));
      add('scans.csv', () => csv(scans, ['id', 'version', 'kind', 'status', 'started_at', 'finished_at', 'user', 'targets', 'stats', 'error']));
      add('benachrichtigungen.json', () => json(channels));
      add('aktionen.csv', () => csv(actions, ['at', 'user', 'action', 'detail']));
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
  };
}
