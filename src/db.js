// SQLite database: schema, migrations (PRAGMA user_version) and backups.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { paths } from './config.js';
import { encrypt, decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';
import { gzipFile, gzipFileSync, freeName } from './lib/gz.js';

export class DatabaseTooNewError extends Error {}
export class WrongKeyError extends Error {}

// Each entry raises user_version by one. Never change an entry once released - only append.
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
  // 4: Docker hosts; monitors get the types docker/mysql/postgres/redis (table rebuilt - SQLite cannot change a CHECK)
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
  // 5: switches and NAS via SNMP - latest status, MAC table of the switches (where is a device plugged in?)
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
  // 9: planned reports by e-mail (e.g. weekly printer supplies for the office) - neutral, without a link to here
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
  // 13: network drives (SMB). The list of monitor kinds is checked by the program, so new kinds need no table rebuild;
  // data keeps the last measured values of a check (e.g. free space of a share)
  { foreignKeysOff: true, sql: `
  CREATE TABLE monitors_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
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
    secret TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}'
  );
  INSERT INTO monitors_new(id,name,type,target,port,device_id,interval_s,timeout_s,fail_threshold,resend_min,http_status,http_keyword,tls_verify,cert_check,cert_days,channels,enabled,created_at,updated_at,status,status_since,last_check,last_ms,last_message,fail_count,notified_down,last_alert_at,cert_valid_to,cert_alert_days,docker_host_id,options,secret)
  SELECT id,name,type,target,port,device_id,interval_s,timeout_s,fail_threshold,resend_min,http_status,http_keyword,tls_verify,cert_check,cert_days,channels,enabled,created_at,updated_at,status,status_since,last_check,last_ms,last_message,fail_count,notified_down,last_alert_at,cert_valid_to,cert_alert_days,docker_host_id,options,secret FROM monitors;
  DROP TABLE monitors;
  ALTER TABLE monitors_new RENAME TO monitors;
  CREATE INDEX monitors_device ON monitors(device_id);
  ` },
  // 14: reports for chosen devices only (empty = all devices of the chosen kinds)
  `ALTER TABLE reports ADD COLUMN device_ids TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE reports ADD COLUMN monitor_ids TEXT NOT NULL DEFAULT '[]';`,
  // 15: more notification services (Discord, Slack, Teams, ntfy …). The kind is checked by the program, so new services
  // need no table rebuild
  { foreignKeysOff: true, sql: `
  CREATE TABLE channels_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'de',
    is_default INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  INSERT INTO channels_new(id,name,type,config,language,is_default,enabled,created_at) SELECT id,name,type,config,language,is_default,enabled,created_at FROM channels;
  DROP TABLE channels;
  ALTER TABLE channels_new RENAME TO channels;
  ` },
  // 16: more hypervisors beside Proxmox (VMware, XCP-ng, Hyper-V, Nutanix, oVirt, KVM/libvirt) in the same table; the kind
  // is checked by the program
  { foreignKeysOff: true, sql: `
  CREATE TABLE proxmox_hosts_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
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
  INSERT INTO proxmox_hosts_new(id,name,kind,url,token_id,secret,verify,ca,created_at,last_at,last_ok,last_error,data) SELECT id,name,kind,url,token_id,secret,verify,ca,created_at,last_at,last_ok,last_error,data FROM proxmox_hosts;
  DROP TABLE proxmox_hosts;
  ALTER TABLE proxmox_hosts_new RENAME TO proxmox_hosts;
  ` },
  // 17: Windows/Linux machines that report by a small script (no agent): keys (hash only, per device or shared),
  // the last report per device, and machines that reported but are not in the inventory
  `
  CREATE TABLE host_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    os TEXT NOT NULL CHECK (os IN ('windows','linux')),
    device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_used TEXT,
    reports INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX host_tokens_hash ON host_tokens(token_hash);
  CREATE TABLE host_reports (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE host_unmatched (
    hostname TEXT PRIMARY KEY,
    ip TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    token_id INTEGER,
    at TEXT NOT NULL
  );
  `,
  // 18: which device fields hold what the device itself reported (kept up to date; replaced on an exchanged device)
  `ALTER TABLE devices ADD COLUMN auto_fields TEXT NOT NULL DEFAULT '{}';`,
  // 19: dependencies - a monitor behind another one (switch, router, internet line) is not reported on its own while
  // that one is down; its status is then 'unreachable' (follow-up outage)
  `ALTER TABLE monitors ADD COLUMN parent_id INTEGER REFERENCES monitors(id) ON DELETE SET NULL;
   CREATE INDEX monitors_parent ON monitors(parent_id);`,
  // 20: long history - per hour also the measured value (response time or sensor value): count, sum, lowest, highest.
  // Filled from the raw checks of the last 7 days; older hours only have the average of the successful checks.
  `ALTER TABLE monitor_hourly ADD COLUMN v_n INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE monitor_hourly ADD COLUMN v_sum REAL NOT NULL DEFAULT 0;
   ALTER TABLE monitor_hourly ADD COLUMN v_min REAL;
   ALTER TABLE monitor_hourly ADD COLUMN v_max REAL;
   UPDATE monitor_hourly SET (v_n, v_sum, v_min, v_max) = (SELECT COUNT(c.ms), COALESCE(SUM(c.ms), 0), MIN(c.ms), MAX(c.ms) FROM checks c
     WHERE c.monitor_id = monitor_hourly.monitor_id AND c.at >= monitor_hourly.hour AND c.at < substr(monitor_hourly.hour, 1, 13) || ':99' AND c.ms IS NOT NULL);
   UPDATE monitor_hourly SET v_n = ok, v_sum = ms_sum WHERE v_n = 0 AND ok > 0 AND ms_sum > 0;`,
  // 21: escalation - per monitor after how many minutes (NULL = the setting for all) and to which channels
  // (empty = the escalation channels of the setting); escalated_at = this outage was escalated already
  `ALTER TABLE monitors ADD COLUMN escalate_min INTEGER;
   ALTER TABLE monitors ADD COLUMN escalate_channels TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE monitors ADD COLUMN escalated_at TEXT;`,
  // 22: host names typed by hand before the ownership rule (auto_fields.hostname = null: scans leave it alone) had no
  // entry and were still overwritten by scans. A device whose newest host name change in its history was a manual
  // edit ('edit' with a hostname field - not a scan 'change' or an SNMP/script report 'snmp') that set the name it
  // still has gets the entry now (a name cleared by hand and filled by a scan later stays the scan's).
  // Only devices without any hostname entry and with a host name; the host names themselves are never changed.
  `UPDATE devices SET auto_fields = json_set(CASE WHEN json_valid(auto_fields) AND json_type(auto_fields) = 'object' THEN auto_fields ELSE '{}' END, '$.hostname', json('null'))
   WHERE hostname <> ''
     AND CASE WHEN json_valid(auto_fields) THEN json_type(auto_fields) <> 'object' OR json_type(auto_fields, '$.hostname') IS NULL ELSE 1 END
     AND (SELECT CASE WHEN h.kind = 'edit' THEN (SELECT json_extract(f.value, '$.to') FROM json_each(h.detail, '$.fields') f
                   WHERE f.type = 'object' AND json_extract(f.value, '$.field') = 'hostname' LIMIT 1) END
          FROM device_history h
          WHERE h.device_id = devices.id AND CASE WHEN NOT json_valid(h.detail) THEN 0
            WHEN h.kind IN ('edit', 'snmp') THEN json_type(h.detail, '$.fields') = 'array'
              AND EXISTS (SELECT 1 FROM json_each(h.detail, '$.fields') f WHERE f.type = 'object' AND json_extract(f.value, '$.field') = 'hostname')
            WHEN h.kind = 'change' THEN json_extract(h.detail, '$.field') IS 'hostname'
            ELSE 0 END
          ORDER BY h.id DESC LIMIT 1) = devices.hostname;`,
  // Watch new devices by themselves: devices and hosts added from now on get a first monitor and a few sensors
  // (NULL = never - nothing changes for what is there already)
  `ALTER TABLE devices ADD COLUMN auto_watch TEXT;
   ALTER TABLE proxmox_hosts ADD COLUMN auto_watch TEXT;`,
  // 24: diagnostic package - the program's own log (30 days), since when which version runs, and the placeholders of
  // the anonymised packages (the same in every package). All three stay with each installation (failover).
  `CREATE TABLE IF NOT EXISTS server_log (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     level TEXT NOT NULL,
     message TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS server_log_at ON server_log(at);
   CREATE TABLE IF NOT EXISTS version_history (
     started_at TEXT PRIMARY KEY,
     version TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS diag_alias (
     kind TEXT NOT NULL,
     real TEXT NOT NULL,
     alias TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     PRIMARY KEY (kind, real)
   );`,
  // 25: "Do not show again" for the tip to monitor a Windows/Linux machine (or the nodes of a hypervisor) with the script
  `ALTER TABLE devices ADD COLUMN script_tip_hidden INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE proxmox_hosts ADD COLUMN script_tip_hidden INTEGER NOT NULL DEFAULT 0;`,
  // 26: light is the default look - accounts still on the old default "like the system" become light (dark stays dark);
  // new accounts are made light (users.js)
  `UPDATE users SET theme='light' WHERE theme='system';`,
  // 27: cloud accounts (AWS, Azure, Google Cloud) in the hosts table: regions, tenant, subscription, project, costs
  `ALTER TABLE proxmox_hosts ADD COLUMN options TEXT NOT NULL DEFAULT '{}';`,
  // 28: messages devices send by themselves (SNMP traps, syslog) - each installation keeps its own (failover.js)
  `CREATE TABLE events_in (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     source_ip TEXT NOT NULL,
     device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
     severity INTEGER NOT NULL,
     facility INTEGER,
     host TEXT NOT NULL DEFAULT '',
     app TEXT NOT NULL DEFAULT '',
     oid TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL
   );
   CREATE INDEX events_in_at ON events_in(at);
   CREATE INDEX events_in_device ON events_in(device_id, at);`,
  // 29: Windows fields of a message (NXLog) and event rules: chosen messages by mail / webhook / ticket system.
  // The rules travel to the standby; what they matched (event_rule_hits) stays with the installation, like the messages.
  `ALTER TABLE events_in ADD COLUMN event_id INTEGER;
   ALTER TABLE events_in ADD COLUMN channel TEXT NOT NULL DEFAULT '';
   ALTER TABLE events_in ADD COLUMN account TEXT NOT NULL DEFAULT '';
   CREATE TABLE event_rules (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     match TEXT NOT NULL DEFAULT '{}',
     channels TEXT NOT NULL DEFAULT '[]',
     mode TEXT NOT NULL DEFAULT 'each',
     digest_min INTEGER NOT NULL DEFAULT 15,
     max_per_hour INTEGER NOT NULL DEFAULT 20,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE event_rule_hits (
     id INTEGER PRIMARY KEY,
     rule_id INTEGER NOT NULL,
     event_id INTEGER NOT NULL REFERENCES events_in(id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     sent_at TEXT,
     failed INTEGER NOT NULL DEFAULT 0,
     tries INTEGER NOT NULL DEFAULT 0,
     next_try TEXT
   );
   CREATE INDEX event_rule_hits_open ON event_rule_hits(rule_id, sent_at);
   CREATE INDEX event_rule_hits_event ON event_rule_hits(event_id);`,
  // 30: the messages move into a file of their own (events.sqlite, attached as "ev" - see attachEvents): they would
  // swell the database and every daily backup. Moved once - a restored older backup only drops its copy.
  `INSERT INTO ev.events_in(at, kind, source_ip, device_id, severity, facility, host, app, oid, text, event_id, channel, account)
     SELECT at, kind, source_ip, device_id, severity, facility, host, app, oid, text, event_id, channel, account FROM main.events_in
     WHERE NOT EXISTS (SELECT 1 FROM ev.events_in) ORDER BY id;
   DROP TABLE main.event_rule_hits;
   DROP TABLE main.events_in;`,
  // 31: what is kept of a sender's messages (a switch only from "warning", a chatty device not at all) - settings,
  // so in the database (and on the standby), not in the messages file
  `CREATE TABLE event_source_filters (
     source_ip TEXT PRIMARY KEY,
     min_severity INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL DEFAULT ''
   );`,
  // 32: event rules with counting, a regular expression and open events (their settings - the state is in the messages file)
  `ALTER TABLE event_rules ADD COLUMN options TEXT NOT NULL DEFAULT '{}';`,
  // 33: the look follows the system again by default (light or dark as the computer is set) - accounts on light, which
  // migration 26 made of "like the system", go back to it; dark stays dark
  `UPDATE users SET theme='system' WHERE theme='light';`,
  // 34: ten daily backups by default (they are compressed now) - an installation still on the old default 7 gets 10
  `UPDATE settings SET value='10' WHERE key='backup.keep' AND value='7';`,
  // 35: new installations leave the usual Windows noise out (settings.js WIN_NOISE); one already in use keeps taking
  // what it took - its empty list is written down instead of following the new default
  `INSERT OR IGNORE INTO settings(key, value) SELECT 'events.winDeny', '""' WHERE EXISTS (SELECT 1 FROM users);`,
  // 36: the ready-made rule "failed sign-ins" as it was made (4625, Security-Auditing, nothing left out, no own words or
  // expression) leaves out the computer's own service logons and "no logon server" - like the rule made from now on.
  // A rule changed by hand in any of these stays as it is.
  `UPDATE event_rules SET match = json_set(match, '$.notWords', json('["Anmeldetyp: 5","Logon Type: 5","0xc000005e"]')), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE json_valid(match) AND json_extract(match, '$.eventIds') = '4625' AND lower(json_extract(match, '$.source')) = 'security-auditing'
       AND json_array_length(coalesce(json_extract(match, '$.notWords'), '[]')) = 0 AND json_array_length(coalesce(json_extract(match, '$.words'), '[]')) = 0
       AND coalesce(json_extract(match, '$.regex'), '') = '' AND json_array_length(coalesce(json_extract(match, '$.from'), '[]')) = 0;`,
  // 37: saved searches of the messages (search, severity, kind, time range) - one's own, or shared with everyone who
  // sees the messages
  `CREATE TABLE IF NOT EXISTS event_searches (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     query TEXT NOT NULL,
     shared INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS event_searches_user ON event_searches(user_id);`,
  // 38: the nightly light scan is off on new installations (WhatsOnMyNet scans nothing unless an administrator says
  // so) - one already in use keeps it as it was: its setting is written down instead of following the new default
  `INSERT OR IGNORE INTO settings(key, value) SELECT 'lightscan.enabled', 'true' WHERE EXISTS (SELECT 1 FROM users);`,
  // 39: groups of monitors (like Uptime Kuma): a name of its own ("Websites", "Telephony" …). Empty: the location of
  // the device, else "no group" - in the list by group, in maintenance windows, on status pages
  // (a database brought back to an older schema number - a restored copy, the tests - may have the column already)
  { sql: "ALTER TABLE monitors ADD COLUMN group_name TEXT NOT NULL DEFAULT '';", unless: "SELECT 1 FROM pragma_table_info('monitors') WHERE name = 'group_name'" },
  // 40: status pages without login (like Uptime Kuma): what is shown (items: groups and monitors), under which address
  // (slug: a secret link or a name of its own) and for which networks
  `CREATE TABLE IF NOT EXISTS status_pages (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE,
     access TEXT NOT NULL DEFAULT 'link' CHECK (access IN ('link','open')),
     networks TEXT NOT NULL DEFAULT '[]',
     description TEXT NOT NULL DEFAULT '',
     notice TEXT NOT NULL DEFAULT '',
     notice_level TEXT NOT NULL DEFAULT 'info',
     show_uptime INTEGER NOT NULL DEFAULT 1,
     language TEXT NOT NULL DEFAULT 'de',
     items TEXT NOT NULL DEFAULT '[]',
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
];

// The messages of the devices (SNMP traps, syslog, Windows events): a file of their own next to the database, attached
// to the same connection as schema "ev" - queries name the tables without schema and find them there. Not in the daily
// backups and not sent to the standby (each installation receives for itself). Space is given back as messages go
// (incremental auto-vacuum), so the file stays near its limit instead of only growing.
const EVENTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ev.events_in (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     source_ip TEXT NOT NULL,
     device_id INTEGER,
     severity INTEGER NOT NULL,
     facility INTEGER,
     host TEXT NOT NULL DEFAULT '',
     app TEXT NOT NULL DEFAULT '',
     oid TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL,
     event_id INTEGER,
     channel TEXT NOT NULL DEFAULT '',
     account TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX IF NOT EXISTS ev.events_in_at ON events_in(at);
   CREATE INDEX IF NOT EXISTS ev.events_in_device ON events_in(device_id, at);
   CREATE TABLE IF NOT EXISTS ev.event_rule_hits (
     id INTEGER PRIMARY KEY,
     rule_id INTEGER NOT NULL,
     event_id INTEGER NOT NULL REFERENCES events_in(id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     sent_at TEXT,
     failed INTEGER NOT NULL DEFAULT 0,
     tries INTEGER NOT NULL DEFAULT 0,
     next_try TEXT
   );
   CREATE INDEX IF NOT EXISTS ev.event_rule_hits_open ON event_rule_hits(rule_id, sent_at);
   CREATE INDEX IF NOT EXISTS ev.event_rule_hits_event ON event_rule_hits(event_id);`,
  // 2: one row per sender (the overview "by sender" without counting millions of rows), messages of one sender fast
  `CREATE INDEX IF NOT EXISTS ev.events_in_source ON events_in(source_ip, id);
   CREATE TABLE IF NOT EXISTS ev.event_senders (
     source_ip TEXT PRIMARY KEY,
     device_id INTEGER,
     host TEXT NOT NULL DEFAULT '',
     first_at TEXT NOT NULL,
     last_at TEXT NOT NULL,
     last_id INTEGER NOT NULL
   );
   INSERT OR REPLACE INTO ev.event_senders(source_ip, device_id, host, first_at, last_at, last_id)
     SELECT e.source_ip, e.device_id, e.host, g.first_at, e.at, e.id
     FROM (SELECT source_ip, MIN(at) first_at, MAX(id) last_id FROM ev.events_in GROUP BY source_ip) g JOIN ev.events_in e ON e.id = g.last_id;`,
  // 3: counting in rules (hits held until N came in the time window, per sender if wanted) and open events: one per
  // rule, sender and key (the first group of the expression, e.g. the port), acknowledged by a user, closed by the
  // counter-message ("link up"), by hand or after a while without news
  `ALTER TABLE ev.event_rule_hits ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE ev.event_rule_hits ADD COLUMN grp TEXT NOT NULL DEFAULT '';
   CREATE INDEX IF NOT EXISTS ev.event_rule_hits_held ON event_rule_hits(rule_id, held, grp, at);
   CREATE TABLE IF NOT EXISTS ev.event_open (
     id INTEGER PRIMARY KEY,
     rule_id INTEGER NOT NULL,
     source_ip TEXT NOT NULL,
     key TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL,
     first_at TEXT NOT NULL,
     last_at TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 1,
     first_event INTEGER,
     last_event INTEGER,
     ack_by TEXT NOT NULL DEFAULT '',
     ack_at TEXT,
     closed_at TEXT,
     closed_how TEXT NOT NULL DEFAULT '',
     closed_by TEXT NOT NULL DEFAULT '',
     close_event INTEGER
   );
   CREATE INDEX IF NOT EXISTS ev.event_open_live ON event_open(rule_id, source_ip, key, state);
   CREATE INDEX IF NOT EXISTS ev.event_open_closed ON event_open(closed_at);`,
  // 4: search over many gigabytes - a full-text index of words (SQLite FTS5) next to the messages, filled in the
  // background in batches (events.js): new messages are written as before, without waiting for the index, and a file
  // from before is indexed bit by bit after the update. "done" is the highest id in the index - everything up to it is
  // in, everything above is searched the slow way. A message that goes takes its words with it (only if they are in);
  // if the newest messages go, "done" follows, so a number given again is indexed again. Event ids get an index of
  // their own (a search for "4625").
  `CREATE VIRTUAL TABLE IF NOT EXISTS ev.events_fts USING fts5(text, app, host, channel, account, source_ip,
     content='events_in', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
   CREATE TABLE IF NOT EXISTS ev.events_fts_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
   INSERT OR REPLACE INTO ev.events_fts_state(k, v) VALUES ('done', COALESCE((SELECT MIN(id) FROM ev.events_in), 1) - 1);
   CREATE TRIGGER IF NOT EXISTS ev.events_fts_gone AFTER DELETE ON events_in BEGIN
     INSERT INTO events_fts(events_fts, rowid, text, app, host, channel, account, source_ip)
       SELECT 'delete', old.id, old.text, old.app, old.host, old.channel, old.account, old.source_ip
       WHERE old.id <= (SELECT v FROM events_fts_state WHERE k = 'done');
     UPDATE events_fts_state SET v = COALESCE((SELECT MAX(id) FROM events_in), 0)
       WHERE k = 'done' AND v > COALESCE((SELECT MAX(id) FROM events_in), 0);
   END;
   CREATE TRIGGER IF NOT EXISTS ev.events_fts_changed AFTER UPDATE OF text, app, host, channel, account, source_ip ON events_in
     WHEN old.id <= (SELECT v FROM events_fts_state WHERE k = 'done') BEGIN
     INSERT INTO events_fts(events_fts, rowid, text, app, host, channel, account, source_ip) VALUES ('delete', old.id, old.text, old.app, old.host, old.channel, old.account, old.source_ip);
     INSERT INTO events_fts(rowid, text, app, host, channel, account, source_ip) VALUES (new.id, new.text, new.app, new.host, new.channel, new.account, new.source_ip);
   END;
   CREATE INDEX IF NOT EXISTS ev.events_in_event ON events_in(event_id) WHERE event_id IS NOT NULL;`,
  // 5: counts kept as they come, so that what counts everything does not read every message - the timeline without a
  // search, the overview by sender, the space and who fills it. Per minute: sender, kind and severity; per hour: the
  // Windows event id. Filled in batches in the background like the search index ("counted" = the highest id in them;
  // a file from before is counted bit by bit, what is above is counted from the messages themselves). A message that
  // goes is taken off again.
  `CREATE TABLE IF NOT EXISTS ev.events_minute (minute INTEGER NOT NULL, source_ip TEXT NOT NULL, kind TEXT NOT NULL, severity INTEGER NOT NULL,
     n INTEGER NOT NULL, PRIMARY KEY (minute, source_ip, kind, severity)) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS ev.events_hour (hour INTEGER NOT NULL, source_ip TEXT NOT NULL, kind TEXT NOT NULL, severity INTEGER NOT NULL,
     n INTEGER NOT NULL, PRIMARY KEY (hour, source_ip, kind, severity)) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS ev.events_hour_id (hour INTEGER NOT NULL, event_id INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (hour, event_id)) WITHOUT ROWID;
   INSERT OR REPLACE INTO ev.events_fts_state(k, v) VALUES ('counted', COALESCE((SELECT MIN(id) FROM ev.events_in), 1) - 1);
   CREATE TRIGGER IF NOT EXISTS ev.events_counts_gone AFTER DELETE ON events_in BEGIN
     UPDATE events_minute SET n = n - 1 WHERE minute = CAST(strftime('%s', old.at) AS INTEGER) / 60 AND source_ip = old.source_ip AND kind = old.kind
       AND severity = old.severity AND old.id <= (SELECT v FROM events_fts_state WHERE k = 'counted');
     UPDATE events_hour SET n = n - 1 WHERE hour = CAST(strftime('%s', old.at) AS INTEGER) / 3600 AND source_ip = old.source_ip AND kind = old.kind
       AND severity = old.severity AND old.id <= (SELECT v FROM events_fts_state WHERE k = 'counted');
     UPDATE events_hour_id SET n = n - 1 WHERE old.event_id IS NOT NULL AND hour = CAST(strftime('%s', old.at) AS INTEGER) / 3600 AND event_id = old.event_id
       AND old.id <= (SELECT v FROM events_fts_state WHERE k = 'counted');
     UPDATE events_fts_state SET v = COALESCE((SELECT MAX(id) FROM events_in), 0)
       WHERE k = 'counted' AND v > COALESCE((SELECT MAX(id) FROM events_in), 0);
   END;
   CREATE TRIGGER IF NOT EXISTS ev.events_counts_changed AFTER UPDATE OF at, source_ip, kind, severity, event_id ON events_in
     WHEN old.id <= (SELECT v FROM events_fts_state WHERE k = 'counted') BEGIN
     UPDATE events_minute SET n = n - 1 WHERE minute = CAST(strftime('%s', old.at) AS INTEGER) / 60 AND source_ip = old.source_ip AND kind = old.kind AND severity = old.severity;
     UPDATE events_hour SET n = n - 1 WHERE hour = CAST(strftime('%s', old.at) AS INTEGER) / 3600 AND source_ip = old.source_ip AND kind = old.kind AND severity = old.severity;
     UPDATE events_hour_id SET n = n - 1 WHERE old.event_id IS NOT NULL AND hour = CAST(strftime('%s', old.at) AS INTEGER) / 3600 AND event_id = old.event_id;
     INSERT INTO events_minute(minute, source_ip, kind, severity, n) VALUES (CAST(strftime('%s', new.at) AS INTEGER) / 60, new.source_ip, new.kind, new.severity, 1)
       ON CONFLICT(minute, source_ip, kind, severity) DO UPDATE SET n = n + 1;
     INSERT INTO events_hour(hour, source_ip, kind, severity, n) VALUES (CAST(strftime('%s', new.at) AS INTEGER) / 3600, new.source_ip, new.kind, new.severity, 1)
       ON CONFLICT(hour, source_ip, kind, severity) DO UPDATE SET n = n + 1;
     INSERT INTO events_hour_id(hour, event_id, n) SELECT CAST(strftime('%s', new.at) AS INTEGER) / 3600, new.event_id, 1 WHERE new.event_id IS NOT NULL
       ON CONFLICT(hour, event_id) DO UPDATE SET n = n + 1;
   END;`,
  // 6: which senders sent which Windows event (and source) on which day - "from 812 computers" exact, also with
  // thousands of them (before: counted in the newest 500 messages). Small next to the messages: one row per computer,
  // event and day. Filled with the counts; a day leaves when its messages are gone. What is counted already is taken now.
  `CREATE TABLE IF NOT EXISTS ev.events_day_src (event_id INTEGER NOT NULL, app TEXT NOT NULL, day INTEGER NOT NULL, source_ip TEXT NOT NULL,
     PRIMARY KEY (event_id, app, day, source_ip)) WITHOUT ROWID;
   INSERT OR IGNORE INTO ev.events_day_src(event_id, app, day, source_ip)
     SELECT DISTINCT event_id, app, CAST(strftime('%s', at) AS INTEGER) / 86400, source_ip FROM ev.events_in
     WHERE event_id IS NOT NULL AND id <= (SELECT v FROM ev.events_fts_state WHERE k = 'counted');`,
  // 7: how a sender sends: the way of its newest message (udp, tcp, tls, trap) and when it last sent over UDP - to see
  // which devices could still go over to TCP (nothing lost in a flood, the device notices when no one listens)
  `ALTER TABLE ev.event_senders ADD COLUMN transport TEXT NOT NULL DEFAULT '';
   ALTER TABLE ev.event_senders ADD COLUMN udp_at TEXT;`,
];
export const eventsFile = (dbFile) => (dbFile === ':memory:' ? ':memory:' : path.join(path.dirname(dbFile), 'events.sqlite'));

/** Attaches the messages file as "ev" and brings it to the current shape */
export function attachEvents(db, dbFile) {
  const file = eventsFile(dbFile);
  const fresh = file === ':memory:' || !fs.existsSync(file);
  db.prepare('ATTACH DATABASE ? AS ev').run(file);
  if (fresh) db.pragma('ev.auto_vacuum = INCREMENTAL');
  if (file !== ':memory:') db.pragma('ev.journal_mode = WAL');
  const version = db.pragma('ev.user_version', { simple: true });
  if (version > EVENTS_SCHEMA.length) throw new DatabaseTooNewError(`The messages file ${file} belongs to a newer version of WhatsOnMyNet.`);
  for (let v = version; v < EVENTS_SCHEMA.length; v++) db.transaction(() => { db.exec(EVENTS_SCHEMA[v]); db.pragma(`ev.user_version = ${v + 1}`); })();
  if (file !== ':memory:') for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.chmodSync(f, 0o600); } catch { /* not there */ } }
  return file;
}

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
    const target = freeName(path.join(dir, `whatsonmynet-before-schema-${version + 1}-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.sqlite.gz`));
    gzipFileSync(file, target);
    log.info(`Backup before the schema update: ${target}`);
  }
  attachEvents(db, file);
  migrate(db, { quiet: file === ':memory:' });
  // much space left free by an update (the messages moved out): given back to the disk once
  if (file !== ':memory:') {
    const free = db.pragma('main.freelist_count', { simple: true }) * db.pragma('main.page_size', { simple: true });
    if (free > 50 * 1024 * 1024) { log.info(`Database: giving back ${Math.round(free / 1048576)} MB of free space`); db.exec('VACUUM main'); }
  }
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.chmodSync(f, 0o600); } catch { /* not there */ } }
  }
  return db;
}

export function migrate(db, { quiet = false } = {}) {
  // a connection without the messages file (trial migration of a backup, tests): an empty one in memory
  if (!db.pragma('database_list').some((d) => d.name === 'ev')) attachEvents(db, ':memory:');
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
        // a step whose result is there already (a column added before) is not done twice
        if (!(m.unless && db.prepare(m.unless).get())) db.exec(sql);
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
export async function backupDatabase(db, keep = 10, dir = paths.backups) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = freeName(path.join(dir, `whatsonmynet-${stamp}.sqlite.gz`));
  // a consistent copy first (SQLite online backup), then compressed - the database file itself is never read raw
  const raw = path.join(dir, `.whatsonmynet-${stamp}-${process.pid}.sqlite.tmp`);
  try {
    await db.backup(raw);
    fs.chmodSync(raw, 0o600);
    await gzipFile(raw, target);
  } finally { fs.rmSync(raw, { force: true }); }
  await tidyBackups(dir, keep);
  return target;
}

const DAILY = /^whatsonmynet-\d{4}-.*\.sqlite(\.gz)?$/;
const SPECIAL = [/^whatsonmynet-before-schema-.*\.sqlite(\.gz)?$/, /^whatsonmynet-before-restore-.*\.sqlite(\.gz)?$/];
/**
 * Older uncompressed copies are compressed once; the daily ones are cut to `keep`, the copies before a schema update
 * or a restore to the newest 10 each (they used to pile up for ever).
 */
/** Compress old uncompressed copies, then keep the newest `keep` daily ones and as many of each kind of special copy */
export async function tidyBackups(dir, keep) {
  for (const f of fs.readdirSync(dir).filter((x) => /^whatsonmynet-.*\.sqlite$/.test(x))) {
    const src = path.join(dir, f);
    try {
      if (!fs.existsSync(`${src}.gz`)) await gzipFile(src, `${src}.gz`);
      const st = fs.statSync(src);
      fs.utimesSync(`${src}.gz`, st.atime, st.mtime);   // the list sorts by time: the copy keeps the date of the original
      fs.rmSync(src, { force: true });
    } catch (e) { log.warn(`Backups: could not compress ${f}: ${e.message}`); }
  }
  // oldest first by their time, not by name: "before-schema-36" sorts before "before-schema-4" by name, and the newest
  // copies before an update were deleted while old ones stayed
  const cut = (re, n) => {
    const time = (f) => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } };
    const files = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => [f, time(f)]).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([f]) => f);
    for (const f of files.slice(0, Math.max(0, files.length - Math.max(1, n)))) fs.rmSync(path.join(dir, f), { force: true });
  };
  cut(DAILY, keep);
  for (const re of SPECIAL) cut(re, keep);
}
