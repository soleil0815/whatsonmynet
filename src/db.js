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
const MIGRATIONS = [
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
  migrate(db);
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.chmodSync(f, 0o600); } catch { /* not there */ } }
  }
  return db;
}

export function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version > MIGRATIONS.length) {
    throw new DatabaseTooNewError(`The database belongs to a newer version of WhatsOnMyNet (schema ${version}, this version knows ${MIGRATIONS.length}). Please install the newer version again or restore a backup.`);
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
    log.info(`Database schema updated to version ${v + 1}`);
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
