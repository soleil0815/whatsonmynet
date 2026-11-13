// Single, gentle checks of one address: TCP port, ping, NetBIOS name, reverse DNS, SNMP, web interface.
// Every check has a short timeout and never sends more than a normal client would.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile } from 'node:child_process';
import snmp from 'net-snmp';
import { config } from '../config.js';
import { normalizeMac } from '../lib/net.js';

const UA = `WhatsOnMyNet/${config.version} (network inventory)`;

/** Limits new connection attempts per second across a whole scan (token bucket). */
export function createRateLimiter(perSecond = 40) {
  const rate = Math.max(1, Math.min(500, Number(perSecond) || 40));
  const interval = 1000 / rate;
  let next = Date.now();
  return {
    take() {
      const now = Date.now();
      const at = Math.max(now, next);
      next = at + interval;
      const wait = at - now;
      return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
    },
  };
}

/** Runs fn for every item with at most `limit` running at the same time. */
export async function pool(items, limit, fn, shouldStop = () => false) {
  const list = [...items];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length && !shouldStop()) {
      const idx = i++;
      await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** 'open' | 'closed' (host answered with a reset - it exists) | 'filtered' (no answer) */
export function tcpProbe(ip, port, timeout = 900) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port, timeout });
    let done = false;
    const end = (state) => { if (!done) { done = true; s.destroy(); resolve(state); } };
    s.once('connect', () => end('open'));
    s.once('timeout', () => end('filtered'));
    s.once('error', (e) => end(e.code === 'ECONNREFUSED' ? 'closed' : 'filtered'));
  });
}

let pingState = null; // null = unknown, true = works, false = not allowed / missing

/** Can this host send ICMP echo without root? (iputils ping with ping_group_range) */
export async function pingAvailable() {
  if (pingState !== null) return pingState;
  const r = await ping('127.0.0.1', 1, true);
  pingState = !!r?.alive;
  return pingState;
}

/** { alive, ttl } - null if ping is not available. */
export function ping(ip, timeoutSec = 1, force = false) {
  if (pingState === false && !force) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('ping', ['-n', '-c', '1', '-W', String(timeoutSec), ip], { timeout: (timeoutSec + 2) * 1000 }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const ttl = /ttl=(\d+)/i.exec(out);
      if (ttl) return resolve({ alive: true, ttl: Number(ttl[1]) });
      if (err && (err.code === 'ENOENT' || /permission|operation not permitted|socket/i.test(String(stderr)))) return resolve(null);
      resolve({ alive: false, ttl: null });
    });
  });
}

/** Rough operating system family from the TTL of a ping answer. */
export function osFromTtl(ttl) {
  if (!ttl) return '';
  if (ttl <= 64) return 'linux';      // Linux, macOS, BSD, most embedded devices
  if (ttl <= 128) return 'windows';
  return 'network';                     // routers, switches, printers (255)
}

// --- NetBIOS (UDP 137): the name a Windows/Samba machine gives itself, plus its MAC ---------------------

function nbstatQuery(id) {
  const name = Buffer.alloc(34);
  name[0] = 32;
  // "*" padded with zero bytes, first-level encoded
  const raw = Buffer.alloc(16); raw[0] = 0x2a;
  for (let i = 0; i < 16; i++) { name[1 + i * 2] = 0x41 + (raw[i] >> 4); name[2 + i * 2] = 0x41 + (raw[i] & 0x0f); }
  name[33] = 0;
  const head = Buffer.from([id >> 8, id & 255, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([head, name, Buffer.from([0x00, 0x21, 0x00, 0x01])]);
}

export function parseNbstat(msg) {
  try {
    let o = 12;
    // skip the name in the answer
    while (o < msg.length && msg[o] !== 0) o += msg[o] + 1;
    o += 1 + 2 + 2 + 4 + 2; // end, type, class, ttl, rdlength
    const count = msg[o]; o += 1;
    const names = [];
    for (let i = 0; i < count && o + 18 <= msg.length; i++, o += 18) {
      const n = msg.subarray(o, o + 15).toString('latin1').replace(/\0/g, '').trim();
      const suffix = msg[o + 15];
      const group = (msg[o + 16] & 0x80) === 0x80;
      names.push({ name: n, suffix, group });
    }
    const mac = normalizeMac(msg.subarray(o, o + 6).toString('hex'));
    const host = names.find((n) => !n.group && n.suffix === 0x00)?.name || names.find((n) => !n.group && n.suffix === 0x20)?.name || '';
    const domain = names.find((n) => n.group && n.suffix === 0x00)?.name || '';
    return { name: host, domain, mac };
  } catch { return null; }
}

/** Sends a NetBIOS status query. Also makes the kernel resolve the MAC (ARP) for local addresses. */
export function netbios(ip, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const id = Math.floor(Math.random() * 65535);
    let done = false;
    const end = (v) => { if (!done) { done = true; clearTimeout(t); try { sock.close(); } catch { /* closed */ } resolve(v); } };
    const t = setTimeout(() => end(null), timeout);
    sock.on('error', () => end(null));
    sock.on('message', (msg) => { if (msg.readUInt16BE(0) === id) end(parseNbstat(msg)); });
    sock.send(nbstatQuery(id), 137, ip, (err) => { if (err) end(null); });
  });
}

export async function reverseDns(ip, timeout = 1500) {
  try {
    const names = await Promise.race([dns.reverse(ip), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout))]);
    return String(names?.[0] || '').replace(/\.$/, '');
  } catch { return ''; }
}

// --- SNMP (read-only system information) -----------------------------------------------------------------

const SYS = {
  descr: '1.3.6.1.2.1.1.1.0',
  objectId: '1.3.6.1.2.1.1.2.0',
  uptime: '1.3.6.1.2.1.1.3.0',
  contact: '1.3.6.1.2.1.1.4.0',
  name: '1.3.6.1.2.1.1.5.0',
  location: '1.3.6.1.2.1.1.6.0',
};

function snmpGetOnce(ip, community, version, timeout) {
  return new Promise((resolve) => {
    let session;
    try {
      session = snmp.createSession(ip, community, { version, timeout, retries: 0, port: 161 });
    } catch { return resolve(null); }
    let done = false;
    const end = (v) => { if (!done) { done = true; try { session.close(); } catch { /* closed */ } resolve(v); } };
    session.on('error', () => end(null));
    const keys = Object.keys(SYS);
    session.get(keys.map((k) => SYS[k]), (err, vbs) => {
      if (err || !vbs) return end(null);
      const out = {};
      vbs.forEach((vb, i) => {
        if (snmp.isVarbindError(vb)) return;
        const v = vb.value;
        out[keys[i]] = Buffer.isBuffer(v) ? v.toString('utf8').replace(/[^\x20-\x7e -￿\n\r\t]/g, '').trim() : String(v);
      });
      end(Object.keys(out).length ? out : null);
    });
    setTimeout(() => end(null), timeout + 500).unref();
  });
}

/** sysDescr, sysObjectID, sysName ... with the first community that answers (v2c, then v1). */
export async function snmpSystem(ip, communities = ['public'], timeout = 900) {
  for (const c of communities) {
    const v2 = await snmpGetOnce(ip, c, snmp.Version2c, timeout);
    if (v2) return { ...v2, version: '2c' };
    const v1 = await snmpGetOnce(ip, c, snmp.Version1, timeout);
    if (v1) return { ...v1, version: '1' };
  }
  return null;
}

// --- Web interface: title, server header, certificate ---------------------------------------------------

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** { status, title, server, location, cert } of http(s)://ip:port/ - reads at most 64 KB. */
export function httpProbe(ip, port, proto = 'http', timeout = 3000) {
  return new Promise((resolve) => {
    const lib = proto === 'https' ? https : http;
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    const req = lib.request({
      host: ip, port, path: '/', method: 'GET', timeout,
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.5', Connection: 'close' },
      // Devices in the LAN almost always have self-signed certificates - we only read, never send data
      rejectUnauthorized: false,
      agent: false,
    }, (res) => {
      let cert = null;
      if (proto === 'https') {
        try {
          const c = res.socket.getPeerCertificate();
          if (c && c.subject) {
            cert = { subject: c.subject.CN || c.subject.O || '', org: c.subject.O || '', issuer: c.issuer?.CN || c.issuer?.O || '',
              validTo: c.valid_to ? new Date(c.valid_to).toISOString() : null,
              names: String(c.subjectaltname || '').split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean).slice(0, 10) };
          }
        } catch { /* no certificate */ }
      }
      const chunks = []; let size = 0;
      res.on('data', (d) => { if (size < 65536) { chunks.push(d); size += d.length; } else res.destroy(); });
      const finish = () => {
        const body = Buffer.concat(chunks).toString('utf8');
        end({ port, proto, status: res.statusCode, title: extractTitle(body), server: String(res.headers.server || '').slice(0, 120),
          location: String(res.headers.location || '').slice(0, 300), cert, body: body.slice(0, 4000) });
      };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('timeout', () => { req.destroy(); end(null); });
    req.on('error', () => end(null));
    req.end();
  });
}
