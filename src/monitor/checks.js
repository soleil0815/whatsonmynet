// One check of a monitor: ping, TCP port or web address (status code, keyword, certificate).
// Every check returns { ok, ms, message, cert? } and never throws.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from '../config.js';
import { ping, pingAvailable } from '../scan/probes.js';
import { dockerCheck, mysqlCheck, postgresCheck, redisCheck, DEFAULT_PORTS } from './services.js';
import { sensorCheck, snmpCheck, proxmoxCheck } from './sensors.js';

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
export function httpCheck(url, { timeoutS = 10, status = '200-399', keyword = '', verify = false } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ ok: false, ms: null, message: 'invalid address' }); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { resolve({ ok: false, ms: null, message: 'invalid address' }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    let done = false;
    let cert = null;
    const end = (r) => { if (!done) { done = true; resolve({ ...r, cert }); } };
    const req = lib.request(u, {
      method: 'GET',
      timeout: timeoutS * 1000,
      headers: { 'User-Agent': UA, Accept: '*/*', Connection: 'close' },
      rejectUnauthorized: !!verify,
      agent: false,
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
      if (!keyword) { res.resume(); res.once('end', finish); res.once('close', finish); return; }
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

/**
 * Runs the check of a monitor row. ctx.dockerUrl(id) gives the address of a Docker host, ctx.secret(m) the stored password.
 */
export function runCheck(m, ctx = {}) {
  if (m.type === 'ping') return pingCheck(m.target, Math.min(m.timeout_s, 10));
  if (m.type === 'tcp') return tcpCheck(m.target, m.port, m.timeout_s);
  if (m.type === 'proxmox') return Promise.resolve(ctx.db ? proxmoxCheck(ctx.db, m) : { ok: false, ms: null, message: 'no database' });
  if (m.type === 'sensor') return Promise.resolve(ctx.db ? sensorCheck(ctx.db, m) : { ok: false, ms: null, message: 'no database' });
  if (m.type === 'snmp') {
    let o = {};
    try { o = JSON.parse(m.options || '{}'); } catch { o = {}; }
    return snmpCheck(m.target, m.port, ctx.communities?.() || ['public'], o, m.timeout_s).catch((e) => ({ ok: false, ms: null, message: e.message }));
  }
  if (m.type === 'docker') {
    const url = ctx.dockerUrl?.(m.docker_host_id);
    if (!url) return Promise.resolve({ ok: false, ms: null, message: 'Docker host missing' });
    return dockerCheck(url, m.target, m.timeout_s);
  }
  if (m.type === 'mysql' || m.type === 'postgres' || m.type === 'redis') {
    let o = {};
    try { o = JSON.parse(m.options || '{}'); } catch { o = {}; }
    const opts = { host: m.target, port: m.port || DEFAULT_PORTS[m.type], user: o.user || '', database: o.database || '', tls: !!o.tls, password: ctx.secret?.(m) || '' };
    if (m.type === 'mysql') return mysqlCheck(opts, m.timeout_s);
    if (m.type === 'postgres') return postgresCheck(opts, m.timeout_s);
    return redisCheck(opts, m.timeout_s);
  }
  return httpCheck(m.target, { timeoutS: m.timeout_s, status: m.http_status, keyword: m.http_keyword, verify: !!m.tls_verify });
}
