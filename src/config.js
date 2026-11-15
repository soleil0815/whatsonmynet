// Central configuration from environment variables (.env).
// Everything that can be changed in the web interface (SMTP, SNMP, users ...) lives in the database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

// Version of docker-compose.yml that matches this code (raised when the file has to change).
export const COMPOSE_VERSION = 1;

export function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|ja|on)$/i.test(String(v).trim());
}

/** Port from the environment: 1–65535, 0 = off (only where allowed), otherwise the default. */
export function port(raw, def, { allowOff = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (allowOff && n === 0) return 0;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : def;
}

// Where users get the source code of exactly this program (AGPL-3.0, section 13).
const DEFAULT_SOURCE = 'https://github.com/soleil0815/whatsonmynet';
const sourceUrl = /^https?:\/\/[^\s"'<>]+$/i.test(process.env.WOMN_SOURCE_URL || '') ? process.env.WOMN_SOURCE_URL : DEFAULT_SOURCE;

const baseUrlRaw = String(process.env.WOMN_BASE_URL || '').trim().replace(/\/+$/, '');
const baseUrl = /^https:\/\/[^\s/"'<>]+(\/[^\s"'<>]*)?$/i.test(baseUrlRaw) ? baseUrlRaw : '';

const hstsRaw = String(process.env.WOMN_HSTS || 'on').trim().toLowerCase();

export const config = {
  version: pkg.version,
  sourceUrl,
  // Optional: the address users open (e.g. https://womn.firma.local:8743 or the reverse proxy address)
  baseUrl,
  baseUrlInvalid: !!baseUrlRaw && !baseUrl,
  httpsPort: port(process.env.WOMN_HTTPS_PORT, 8743),
  // Only redirects to HTTPS (and serves a trusted reverse proxy); 0 = off
  httpPort: port(process.env.WOMN_HTTP_PORT, 8780, { allowOff: true }),
  bind: String(process.env.WOMN_BIND || '').trim() || undefined,
  // Receiving SNMP traps and syslog (switched on in the interface): not 162/514 - no root rights in the container
  trapPort: port(process.env.WOMN_TRAP_PORT, 1162),
  syslogPort: port(process.env.WOMN_SYSLOG_PORT, 1514),
  syslogTcpPort: port(process.env.WOMN_SYSLOG_TCP_PORT, 1514),
  syslogTlsPort: port(process.env.WOMN_SYSLOG_TLS_PORT, 6514),
  hsts: ['off', 'no', 'false', '0', 'nein'].includes(hstsRaw) ? 'off' : hstsRaw === 'preload' ? 'preload' : 'on',
  trustProxy: process.env.WOMN_TRUST_PROXY || '',
  dataDir: path.resolve(process.env.WOMN_DATA_DIR || '/data'),
  logLevel: process.env.WOMN_LOG_LEVEL || 'info',
  sessionHours: Math.min(720, Math.max(1, Number(process.env.WOMN_SESSION_HOURS) || 12)),
  composeVersion: Number(process.env.WOMN_COMPOSE_VERSION || 0),
  publicDir: path.join(here, '..', 'public'),
};

export const paths = {
  db: path.join(config.dataDir, 'whatsonmynet.sqlite'),
  backups: path.join(config.dataDir, 'backups'),
  secretKey: path.join(config.dataDir, 'secret.key'),
  tlsDir: path.join(config.dataDir, 'tls'),
  httpsHosts: path.join(config.dataDir, 'https-hosts.txt'),
};
