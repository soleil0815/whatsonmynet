// One check of a monitor: ping, TCP port or web address (status code, keyword, certificate).
// Every check returns { ok, ms, message, cert? } and never throws.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { config } from '../config.js';
import { ping, pingAvailable } from '../scan/probes.js';
import { dockerCheck, mysqlCheck, postgresCheck, redisCheck, DEFAULT_PORTS } from './services.js';
import { sensorCheck, snmpCheck, proxmoxCheck } from './sensors.js';
import { smbCheck } from './smb.js';
import { eventCheck } from '../events.js';
import { dnsCheck, mailCheck, ldapCheck, ntpCheck, mssqlCheck } from './protocols.js';
import { resolveAllowed } from '../lib/targetguard.js';

const UA = `WhatsOnMyNet/${config.version} (monitoring)`;
const MAX_BODY = 1024 * 1024;

/** "200-399", "200,204,301-302" → function(status) */
export function statusMatcher(spec) {
  const parts = String(spec || '200-399').split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(p);
    return m ? [Number(m[1]), Number(m[2] || m[1])] : null;
  }).filter(Boolean);
  const ranges = parts.length ? parts : [[200, 399]];
  return (status) => ranges.some(([a, b]) => status >= a && status <= b);
}

export function validStatusSpec(spec) {
  return String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).every((p) => /^\d{3}(-\d{3})?$/.test(p));
}

export async function pingCheck(host, timeoutS = 5) {
  if (!(await pingAvailable())) return { ok: false, ms: null, message: 'ping not allowed on this host', unsupported: true };
  const t0 = Date.now();
  const r = await ping(host, Math.max(1, Math.min(10, timeoutS)));
  if (!r) return { ok: false, ms: null, message: 'ping not allowed on this host', unsupported: true };
  return r.alive ? { ok: true, ms: Date.now() - t0, message: `ttl ${r.ttl}` } : { ok: false, ms: null, message: 'no answer' };
}

export function tcpCheck(host, port, timeoutS = 10) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port, timeout: timeoutS * 1000 });
    let done = false;
    const end = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    s.once('connect', () => end({ ok: true, ms: Date.now() - t0, message: `port ${port} open` }));
    s.once('timeout', () => end({ ok: false, ms: null, message: `timeout (${timeoutS} s)` }));
    s.once('error', (e) => end({ ok: false, ms: null, message: e.code === 'ECONNREFUSED' ? 'connection refused' : e.code || e.message }));
  });
}

function certInfo(socket) {
  try {
    const c = socket.getPeerCertificate?.();
    if (!c || !c.valid_to) return null;
    return { validTo: new Date(c.valid_to).toISOString(), subject: c.subject?.CN || '', issuer: c.issuer?.CN || c.issuer?.O || '' };
  } catch { return null; }
}

/**
 * GET the address. Up if the status matches and (if set) the keyword is in the first MB of the answer.
 * verify: check the certificate chain (external sites); off for devices with self-signed certificates.
 * The certificate is always read, so its expiry can be watched either way.
 */
export function httpCheck(url, { timeoutS = 10, status = '200-399', keyword = '', verify = false, lookup = undefined } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ ok: false, ms: null, message: 'invalid address' }); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { resolve({ ok: false, ms: null, message: 'invalid address' }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    let done = false;
    let cert = null;
    // timeout counts silence on the socket only; a device that keeps sending a few bytes (a camera stream) would hold
    // the check for ever. So one deadline for the whole check as well.
    const deadline = setTimeout(() => { req.destroy(); end({ ok: false, ms: null, message: `timeout (${timeoutS} s)` }); }, timeoutS * 1000 + 500);
    const end = (r) => { if (!done) { done = true; clearTimeout(deadline); resolve({ ...r, cert }); } };
    const req = lib.request(u, {
      method: 'GET',
      timeout: timeoutS * 1000,
      headers: { 'User-Agent': UA, Accept: '*/*', Connection: 'close' },
      rejectUnauthorized: !!verify,
      agent: false,
      ...(lookup ? { lookup } : {}),
    }, (res) => {
      if (u.protocol === 'https:') cert = certInfo(res.socket);
      const matches = statusMatcher(status);
      const chunks = []; let size = 0;
      const finish = () => {
        const ms = Date.now() - t0;
        if (!matches(res.statusCode)) return end({ ok: false, ms, message: `status ${res.statusCode}` });
        if (keyword) {
          const body = Buffer.concat(chunks).toString('utf8');
          if (!body.includes(keyword)) return end({ ok: false, ms, message: `keyword not found (status ${res.statusCode})` });
        }
        end({ ok: true, ms, message: `status ${res.statusCode}` });
      };
      // Without a keyword the status is all we need: no reason to read the rest
      if (!keyword) { finish(); res.destroy(); return; }
      res.on('data', (d) => { if (size < MAX_BODY) { chunks.push(d); size += d.length; } else res.destroy(); });
      res.once('end', finish);
      res.once('close', finish);
    });
    req.on('socket', (sock) => sock.once('secureConnect', () => { cert = certInfo(sock); }));
    req.on('timeout', () => { req.destroy(); end({ ok: false, ms: null, message: `timeout (${timeoutS} s)` }); });
    req.on('error', (e) => end({ ok: false, ms: null, message: tlsMessage(e) }));
    req.end();
  });
}

function tlsMessage(e) {
  const map = {
    CERT_HAS_EXPIRED: 'certificate expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
    SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in chain',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate cannot be verified',
    ERR_TLS_CERT_ALTNAME_INVALID: 'certificate is for another name',
    ECONNREFUSED: 'connection refused',
    ENOTFOUND: 'name not found (DNS)',
    EHOSTUNREACH: 'host unreachable',
    ECONNRESET: 'connection reset',
  };
  return map[e.code] || e.code || e.message;
}

/** A lookup for net/tls/http that answers with the one address checked before (no second DNS question) */
export function pinnedLookup(address, family) {
  return (_host, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (opts && typeof opts === 'object' && opts.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

/** The one host a check contacts (as lib/targetguard.js checks it when saved): URL host, DNS server or the target */
function contactedHost(m) {
  if (m.type === 'http') { try { return new URL(m.target).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } }
  if (m.type === 'dns') { try { return String(JSON.parse(m.options || '{}').server || ''); } catch { return ''; } }
  return String(m.target || '');
}

/**
 * Runs the check of a monitor row. ctx.dockerUrl(id) gives the address of a Docker host, ctx.secret(m) the stored password.
 * A monitor whose address a non-admin set (target_rule: his rule at that time) is checked again on every run: the name
 * is resolved here, every answer must pass the rule, and the check contacts exactly the address checked - a DNS answer
 * that changes later (DNS rebinding) cannot point it at the host itself or at networks the user may not reach.
 */
export async function runCheck(m, ctx = {}) {
  if (!m.target_rule) return checkOf(m, ctx, null);
  let rule;
  try { rule = JSON.parse(m.target_rule); } catch { rule = null; }
  if (!rule || typeof rule !== 'object' || !Array.isArray(rule.subnets)) return { ok: false, ms: null, message: 'target not allowed' };
  const host = contactedHost(m);
  if (!host) return checkOf(m, ctx, null);
  const pin = await resolveAllowed(host, rule, { snmp: m.type === 'snmp' });
  if (pin.error) return { ok: false, ms: null, message: pin.error };
  return checkOf(m, ctx, { name: host, ...pin });
}

/** pin: { name, address, family } - the check contacts address (TLS still checks name); null = as typed */
function checkOf(m0, ctx, pin) {
  const m = pin && !['http', 'mysql', 'postgres', 'redis', 'mail', 'ldap'].includes(m0.type)
    ? (m0.type === 'dns' ? { ...m0, options: JSON.stringify({ ...JSON.parse(m0.options || '{}'), server: pin.address }) } : { ...m0, target: pin.address })
    : m0;
  const lookup = pin ? pinnedLookup(pin.address, pin.family) : undefined;
  if (m.type === 'ping') return pingCheck(m.target, Math.min(m.timeout_s, 10));
  if (m.type === 'tcp') return tcpCheck(m.target, m.port, m.timeout_s);
  if (m.type === 'proxmox') return Promise.resolve(ctx.db ? proxmoxCheck(ctx.db, m) : { ok: false, ms: null, message: 'no database' });
  if (m.type === 'sensor') return Promise.resolve(ctx.db ? sensorCheck(ctx.db, m) : { ok: false, ms: null, message: 'no database' });
  if (m.type === 'group') return Promise.resolve(ctx.group ? ctx.group(m) : { ok: false, ms: null, message: 'no database' });
  if (m.type === 'event') return Promise.resolve(ctx.db ? eventCheck(ctx.db, m) : { ok: false, ms: null, message: 'no database' });
  if (m.type === 'snmp') {
    let o = {};
    try { o = JSON.parse(m.options || '{}'); } catch { o = {}; }
    // A name is resolved here once and the check asks exactly that address (the one checked when saved, a DNS answer
    // cannot redirect the access data between the lookup and the query)
    return (async () => {
      let ip = m.target;
      if (!net.isIP(ip)) {
        try { ip = (await dnsLookup(m.target, { family: 4 })).address; } catch { return { ok: false, ms: null, message: 'name not found (DNS)' }; }
      }
      return snmpCheck(ip, m.port, ctx.communities?.(ip) || ['public'], o, m.timeout_s);
    })().catch((e) => ({ ok: false, ms: null, message: e.message }));
  }
  if (['dns', 'mail', 'ldap', 'ntp', 'mssql'].includes(m.type)) {
    let o = {};
    try { o = JSON.parse(m.options || '{}'); } catch { o = {}; }
    const verify = !!m.tls_verify;
    if (m.type === 'dns') return dnsCheck(m.target, { server: o.server || '', port: m.port || 53, type: o.rtype || 'A', expect: o.expect || '' }, Math.min(m.timeout_s, 30));
    if (m.type === 'mail') return mailCheck(m.target, m.port, { proto: o.proto, tls: o.tls, verify, lookup }, m.timeout_s);
    if (m.type === 'ldap') return ldapCheck(pin ? pin.address : m.target, m.port, { tls: o.tls, verify, name: pin?.name }, m.timeout_s);
    if (m.type === 'ntp') return ntpCheck(m.target, m.port || 123, { maxOffsetMs: o.maxOffsetMs || 1000 }, Math.min(m.timeout_s, 15));
    return mssqlCheck(m.target, m.port || 0, { instance: o.instance || '' }, m.timeout_s);
  }
  if (m.type === 'smb') {
    let o = {};
    try { o = JSON.parse(m.options || '{}'); } catch { o = {}; }
    return smbCheck(m.target, m.port || 445, o, ctx.secret?.(m) || '', m.timeout_s).catch((e) => ({ ok: false, ms: null, message: e.message }));
  }
  if (m.type === 'docker') {
    const url = ctx.dockerUrl?.(m.docker_host_id);
    if (!url) return Promise.resolve({ ok: false, ms: null, message: 'Docker host missing' });
    return dockerCheck(url, m.target, m.timeout_s);
  }
  if (m.type === 'mysql' || m.type === 'postgres' || m.type === 'redis') {
    let o = {};
    try { o = JSON.parse(m.options || '{}'); } catch { o = {}; }
    const opts = { host: m.target, port: m.port || DEFAULT_PORTS[m.type], user: o.user || '', database: o.database || '', tls: !!o.tls, verify: !!o.verify, password: ctx.secret?.(m) || '', pin };
    if (m.type === 'mysql') return mysqlCheck(opts, m.timeout_s);
    if (m.type === 'postgres') return postgresCheck(opts, m.timeout_s);
    return redisCheck(opts, m.timeout_s);
  }
  return httpCheck(m.target, { timeoutS: m.timeout_s, status: m.http_status, keyword: m.http_keyword, verify: !!m.tls_verify, lookup });
}
