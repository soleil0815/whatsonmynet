// SNMP access data of the scan and the pollers: communities (v1/v2c) and SNMPv3 users (with authentication and
// encryption). Both are kept encrypted in the settings and never go to the browser. Which access works for a device is
// remembered (in memory), so the next poll asks with it first and does not wait for the others to time out.
import snmp from 'net-snmp';

export const V3_LEVELS = ['noAuthNoPriv', 'authNoPriv', 'authPriv'];
export const V3_AUTH = ['sha', 'sha256', 'sha512', 'sha224', 'sha384', 'md5'];
export const V3_PRIV = ['aes', 'aes256b', 'aes256r', 'des'];
export const MAX_V3 = 5;

/** Communities as typed (comma or line), at most 5; empty = "public" */
export function parseCommunities(raw) {
  return String(raw || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
}

/**
 * SNMPv3 users from the settings (JSON) - checked again on reading: name, level, procedures, keys of 8..128 characters
 * (RFC 3414 wants at least 8). Anything broken is left out instead of failing a scan.
 */
export function parseV3(raw) {
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw; } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const u of list.slice(0, MAX_V3)) {
    const user = String(u?.user || '').trim();
    if (!user || user.length > 64 || !V3_LEVELS.includes(u.level)) continue;
    const auth = u.level !== 'noAuthNoPriv';
    const priv = u.level === 'authPriv';
    const key = (k) => typeof k === 'string' && k.length >= 8 && k.length <= 128;
    if (auth && (!V3_AUTH.includes(u.authProtocol) || !key(u.authKey))) continue;
    if (priv && (!V3_PRIV.includes(u.privProtocol) || !key(u.privKey))) continue;
    out.push({ v3: true, user, level: u.level, authProtocol: auth ? u.authProtocol : null, authKey: auth ? u.authKey : null,
      privProtocol: priv ? u.privProtocol : null, privKey: priv ? u.privKey : null, context: String(u.context || '').slice(0, 64) });
  }
  return out;
}

/** What the browser may see of the v3 users: names, levels and procedures - never the keys */
export function v3Public(raw) {
  return parseV3(raw).map((u) => ({ user: u.user, level: u.level, authProtocol: u.authProtocol, privProtocol: u.privProtocol, context: u.context }));
}

/** All accesses to try, in this order: communities (or "public"), then the v3 users */
export function snmpCredentials(settings) {
  const comm = parseCommunities(settings.get('scan.snmpCommunities'));
  return [...(comm.length ? comm : ['public']), ...parseV3(settings.get('scan.snmpV3'))];
}

const keyOf = (c) => (typeof c === 'string' ? `c:${c}` : `u:${c.user}`);

// ip → key of the access that answered last time (bounded: a big scan must not make it grow without end)
const remembered = new Map();
export function rememberAccess(ip, cred) {
  if (remembered.size > 20000) remembered.clear();
  remembered.set(String(ip), keyOf(cred));
}
/** The accesses with the one that worked last time for this device first */
export function orderFor(ip, creds) {
  const k = remembered.get(String(ip));
  if (!k) return creds;
  const i = creds.findIndex((c) => keyOf(c) === k);
  return i <= 0 ? creds : [creds[i], ...creds.slice(0, i), ...creds.slice(i + 1)];
}
export function forgetAccess() { remembered.clear(); }

/** A v3 session (read-only use: GET/GETNEXT/GETBULK only) */
export function v3Session(ip, u, { timeout, retries = 1, port = 161 } = {}) {
  const user = { name: u.user, level: snmp.SecurityLevel[u.level] };
  if (u.authProtocol) { user.authProtocol = snmp.AuthProtocols[u.authProtocol]; user.authKey = u.authKey; }
  if (u.privProtocol) { user.privProtocol = snmp.PrivProtocols[u.privProtocol]; user.privKey = u.privKey; }
  return snmp.createV3Session(ip, user, { version: snmp.Version3, timeout, retries, port, ...(u.context ? { context: u.context } : {}) });
}

/** Label of an access for a device page or a log line - the community itself never appears */
export function accessLabel(cred, version) {
  if (cred && typeof cred === 'object') return `v3 · ${cred.user} · ${cred.level}`;
  return `v${version || '2c'}`;
}
