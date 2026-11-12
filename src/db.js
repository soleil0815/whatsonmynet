// SQLite database: schema, migrations (PRAGMA user_version) and backups.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { paths } from './config.js';
import { encrypt, decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';

export class DatabaseTooNewError extends Error {}
export class WrongKeyError extends Error {}

// Each entry raises user_version by one. Never change an entry once released – only append.
export const MIGRATIONS = [
  // 1: first version
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
    language TEXT NOT NULL DEFAULT 'de',
    theme TEXT NOT NULL DEFAULT 'system',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login TEXT,
    password_changed_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE locations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE subnets (
    id INTEGER PRIMARY KEY,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    cidr TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'unknown',
    vendor TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    ip TEXT,
    mac TEXT UNIQUE,
    hostname TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    owner TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    web_url TEXT NOT NULL DEFAULT '',
    serial TEXT NOT NULL DEFAULT '',
    supplier TEXT NOT NULL DEFAULT '',
    purchase_date TEXT,
    warranty_until TEXT,
    maintenance_until TEXT,
    facts TEXT NOT NULL DEFAULT '{}',
    first_seen TEXT,
    last_seen TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX devices_ip ON devices(ip);
  CREATE INDEX devices_location ON devices(location_id);
  CREATE TABLE device_history (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    user TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX history_device ON device_history(device_id, id);
  CREATE TABLE scans (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'network',
    status TEXT NOT NULL DEFAULT 'running',
    targets TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    user TEXT NOT NULL DEFAULT '',
    stats TEXT NOT NULL DEFAULT '{}',
    error TEXT
  );
  CREATE TABLE scan_results (
    id INTEGER PRIMARY KEY,
    scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    mac TEXT,
    hostname TEXT NOT NULL DEFAULT '',
    vendor TEXT NOT NULL DEFAULT '',
    detected_type TEXT NOT NULL DEFAULT 'unknown',
    confidence REAL NOT NULL DEFAULT 0,
    facts TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    handled TEXT
  );
  CREATE INDEX scan_results_scan ON scan_results(scan_id);
  CREATE TABLE ignored (
    id INTEGER PRIMARY KEY,
    mac TEXT UNIQUE,
    ip TEXT,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    user TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  `,
  // 2: monitoring (checks, notifications, maintenance windows)
  `
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('ping','tcp','http')),
    target TEXT NOT NULL,
    port INTEGER,
    device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    interval_s INTEGER NOT NULL DEFAULT 60,
    timeout_s INTEGER NOT NULL DEFAULT 10,
    fail_threshold INTEGER NOT NULL DEFAULT 3,
    resend_min INTEGER NOT NULL DEFAULT 0,
    http_status TEXT NOT NULL DEFAULT '200-399',
    http_keyword TEXT NOT NULL DEFAULT '',
    tls_verify INTEGER NOT NULL DEFAULT 0,
    cert_check INTEGER NOT NULL DEFAULT 1,
    cert_days TEXT NOT NULL DEFAULT '30,14,7',
    channels TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_since TEXT,
    last_check TEXT,
    last_ms INTEGER,
    last_message TEXT NOT NULL DEFAULT '',
    fail_count INTEGER NOT NULL DEFAULT 0,
    notified_down INTEGER NOT NULL DEFAULT 0,
    last_alert_at TEXT,
    cert_valid_to TEXT,
    cert_alert_days INTEGER
  );
  CREATE INDEX monitors_device ON monitors(device_id);
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    ms INTEGER,
    message TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX checks_monitor ON checks(monitor_id, at);
  CREATE TABLE monitor_hourly (
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    hour TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    ms_sum INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (monitor_id, hour)
  );
  CREATE TABLE monitor_events (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    notified TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX monitor_events_monitor ON monitor_events(monitor_id, id);
  CREATE TABLE channels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('email','telegram','webhook')),
    config TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'de',
    is_default INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE maintenance (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('once','weekly')),
    starts_at TEXT,
    ends_at TEXT,
    weekdays TEXT NOT NULL DEFAULT '[]',
    time_from TEXT,
    time_to TEXT,
    monitor_ids TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  `,
  // 3: devices seen by scans (unknown-device notice), printer status (SNMP)
  `
  CREATE TABLE sightings (
    key TEXT PRIMARY KEY,
    ip TEXT,
    mac TEXT,
    vendor TEXT NOT NULL DEFAULT '',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    notified_at TEXT
  );
  CREATE TABLE printer_status (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    alerts TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE printer_pages (
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (device_id, day)
  );
  `,
  // 4: Docker hosts; monitors get the types docker/mysql/postgres/redis (table rebuilt – SQLite cannot change a CHECK)
  { foreignKeysOff: true, sql: `
  CREATE TABLE docker_hosts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE monitors_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('ping','tcp','http','docker','mysql','postgres','redis')),
    target TEXT NOT NULL,
    port INTEGER,
    device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    interval_s INTEGER NOT NULL DEFAULT 60,
    timeout_s INTEGER NOT NULL DEFAULT 10,
    fail_threshold INTEGER NOT NULL DEFAULT 3,
    resend_min INTEGER NOT NULL DEFAULT 0,
    http_status TEXT NOT NULL DEFAULT '200-399',
    http_keyword TEXT NOT NULL DEFAULT '',
    tls_verify INTEGER NOT NULL DEFAULT 0,
    cert_check INTEGER NOT NULL DEFAULT 1,
    cert_days TEXT NOT NULL DEFAULT '30,14,7',
    channels TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_since TEXT,
    last_check TEXT,
    last_ms INTEGER,
    last_message TEXT NOT NULL DEFAULT '',
    fail_count INTEGER NOT NULL DEFAULT 0,
    notified_down INTEGER NOT NULL DEFAULT 0,
    last_alert_at TEXT,
    cert_valid_to TEXT,
    cert_alert_days INTEGER,
    docker_host_id INTEGER REFERENCES docker_hosts(id) ON DELETE RESTRICT,
    options TEXT NOT NULL DEFAULT '{}',
    secret TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO monitors_new(id,name,type,target,port,device_id,interval_s,timeout_s,fail_threshold,resend_min,http_status,http_keyword,
    tls_verify,cert_check,cert_days,channels,enabled,created_at,updated_at,status,status_since,last_check,last_ms,last_message,fail_count,
    notified_down,last_alert_at,cert_valid_to,cert_alert_days)
  SELECT id,name,type,target,port,device_id,interval_s,timeout_s,fail_threshold,resend_min,http_status,http_keyword,
    tls_verify,cert_check,cert_days,channels,enabled,created_at,updated_at,status,status_since,last_check,last_ms,last_message,fail_count,
    notified_down,last_alert_at,cert_valid_to,cert_alert_days FROM monitors;
  DROP TABLE monitors;
  ALTER TABLE monitors_new RENAME TO monitors;
  CREATE INDEX monitors_device ON monitors(device_id);
  ` },
  // 5: switches and NAS via SNMP – latest status, MAC table of the switches (where is a device plugged in?)
  `
  CREATE TABLE snmp_status (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    alerts TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE switch_macs (
    switch_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    mac TEXT NOT NULL,
    if_index INTEGER NOT NULL,
    port TEXT NOT NULL DEFAULT '',
    vlan INTEGER NOT NULL DEFAULT 0,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (switch_id, mac, vlan)
  );
  CREATE INDEX switch_macs_mac ON switch_macs(mac);
  `,
  // 6: accounts from Active Directory / LDAP (no local password; role from the AD groups)
  `
  ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE users ADD COLUMN ext_dn TEXT NOT NULL DEFAULT '';
  `,
  // 7: editors and viewers can be limited to locations (no rows = all locations)
  `
  CREATE TABLE user_locations (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, location_id)
  );
  `,
  // 8: scan agents for branch offices (scan locally, report to this server)
  `
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_seen TEXT,
    last_ip TEXT,
    version TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE agent_jobs (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('network','light')),
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    taken_at TEXT,
    done_at TEXT,
    scan_id INTEGER REFERENCES scans(id) ON DELETE SET NULL
  );
  CREATE INDEX agent_jobs_agent ON agent_jobs(agent_id, done_at);
  `,
  // 9: planned reports by e-mail (e.g. weekly printer supplies for the office) – neutral, without a link to here
  `
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sections TEXT NOT NULL DEFAULT '["printers"]',
    recipients TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '{}',
    location_ids TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '',
    intro TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'de',
    only_attention INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_run TEXT,
    last_day TEXT,
    last_status TEXT NOT NULL DEFAULT ''
  );
  `,
  // 10: sensors on values the devices deliver, free SNMP values, Proxmox (monitor table rebuilt for the new types)
  { foreignKeysOff: true, sql: `
  CREATE TABLE monitors_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('ping','tcp','http','docker','mysql','postgres','redis','sensor','snmp','proxmox')),
    target TEXT NOT NULL,
    port INTEGER,
    device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    interval_s INTEGER NOT NULL DEFAULT 60,
    timeout_s INTEGER NOT NULL DEFAULT 10,
    fail_threshold INTEGER NOT NULL DEFAULT 3,
    resend_min INTEGER NOT NULL DEFAULT 0,
    http_status TEXT NOT NULL DEFAULT '200-399',
    http_keyword TEXT NOT NULL DEFAULT '',
    tls_verify INTEGER NOT NULL DEFAULT 0,
    cert_check INTEGER NOT NULL DEFAULT 1,
    cert_days TEXT NOT NULL DEFAULT '30,14,7',
    channels TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_since TEXT,
    last_check TEXT,
    last_ms INTEGER,
    last_message TEXT NOT NULL DEFAULT '',
    fail_count INTEGER NOT NULL DEFAULT 0,
    notified_down INTEGER NOT NULL DEFAULT 0,
    last_alert_at TEXT,
    cert_valid_to TEXT,
    cert_alert_days INTEGER,
    docker_host_id INTEGER REFERENCES docker_hosts(id) ON DELETE RESTRICT,
    options TEXT NOT NULL DEFAULT '{}',
    secret TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO monitors_new(id,name,type,target,port,device_id,interval_s,timeout_s,fail_threshold,resend_min,http_status,http_keyword,tls_verify,cert_check,cert_days,channels,enabled,created_at,updated_at,status,status_since,last_check,last_ms,last_message,fail_count,notified_down,last_alert_at,cert_valid_to,cert_alert_days,docker_host_id,options,secret)
  SELECT id,name,type,target,port,device_id,interval_s,timeout_s,fail_threshold,resend_min,http_status,http_keyword,tls_verify,cert_check,cert_days,channels,enabled,created_at,updated_at,status,status_since,last_check,last_ms,last_message,fail_count,notified_down,last_alert_at,cert_valid_to,cert_alert_days,docker_host_id,options,secret FROM monitors;
  DROP TABLE monitors;
  ALTER TABLE monitors_new RENAME TO monitors;
  CREATE INDEX monitors_device ON monitors(device_id);
  ` },
  // 11: Proxmox VE and Proxmox Backup Server via their API (read-only token)
  `
  CREATE TABLE proxmox_hosts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pve','pbs')),
    url TEXT NOT NULL,
    token_id TEXT NOT NULL,
    secret TEXT NOT NULL DEFAULT '',
    verify INTEGER NOT NULL DEFAULT 1,
    ca TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_at TEXT,
    last_ok INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}'
  );
  `,
  // 12: two-factor sign-in (TOTP) for local accounts
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '[]';
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file = paths.db) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Before an update changes the schema: copy of the database next to the daily backups
  const version = db.pragma('user_version', { simple: true });
  if (file !== ':memory:' && version > 0 && version < MIGRATIONS.length) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `whatsonmynet-before-schema-${version + 1}-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.sqlite`);
    fs.copyFileSync(file, target);
    fs.chmodSync(target, 0o600);
    log.info(`Backup before the schema update: ${target}`);
  }
  migrate(db, { quiet: file === ':memory:' });
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.chmodSync(f, 0o600); } catch { /* not there */ } }
  }
  return db;
}

export function migrate(db, { quiet = false } = {}) {
  const version = db.pragma('user_version', { simple: true });
  if (version > MIGRATIONS.length) {
    throw new DatabaseTooNewError(`The database belongs to a newer version of WhatsOnMyNet (schema ${version}, this version knows ${MIGRATIONS.length}). Please install the newer version again or restore a backup.`);
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v];
    const sql = typeof m === 'string' ? m : m.sql;
    // Rebuilding a table: foreign keys off (otherwise DROP TABLE would delete dependent rows), checked afterwards
    if (m.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        if (m.foreignKeysOff) {
          const bad = db.pragma('foreign_key_check');
          if (bad.length) throw new Error(`Schema update ${v + 1}: ${bad.length} broken reference(s)`);
        }
        db.pragma(`user_version = ${v + 1}`);
      })();
    } finally {
      if (m.foreignKeysOff) db.pragma('foreign_keys = ON');
    }
    if (!quiet) log.info(`Database schema updated to version ${v + 1}`);
  }
}

/**
 * Checks that the key (secret.key / WOMN_SECRET) still matches the database: a check value is stored on first start.
 * A different key would make stored passwords (SMTP, SNMP) unreadable.
 */
export function verifyKey(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='_keycheck'").get();
  if (!row) {
    db.prepare("INSERT INTO settings(key,value) VALUES('_keycheck',?)").run(JSON.stringify(encrypt('whatsonmynet')));
    return;
  }
  try {
    if (decrypt(JSON.parse(row.value)) === 'whatsonmynet') return;
  } catch { /* falls through */ }
  throw new WrongKeyError('The key (data/secret.key or WOMN_SECRET) does not match this database. Restore the original key file or the old WOMN_SECRET value.');
}

/** Consistent copy of the database into the backups folder (keeps the newest `keep`). */
export async function backupDatabase(db, keep = 7, dir = paths.backups) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = path.join(dir, `whatsonmynet-${stamp}.sqlite`);
  await db.backup(target);
  fs.chmodSync(target, 0o600);
  const files = fs.readdirSync(dir).filter((f) => /^whatsonmynet-\d{4}-.*\.sqlite$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - Math.max(1, keep)))) fs.rmSync(path.join(dir, f), { force: true });
  return target;
}
