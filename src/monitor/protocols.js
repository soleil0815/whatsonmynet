// Checks that speak the protocol of a service - more than "the port is open":
//   dns    resolve a name (at a given server), optionally expect a value in the answer
//   mail   SMTP, IMAP, POP3: greeting, STARTTLS or TLS, certificate - no sign-in, no mail is sent
//   ldap   LDAP / Active Directory: read the rootDSE (anonymous, allowed by AD), "DC synchronized?", certificate
//   ntp    time server: answers, synchronized, offset to this server's clock within a limit
//   mssql  Microsoft SQL Server: PRELOGIN handshake gives the version (no sign-in); named instances via SQL Browser
// Every check returns { ok, ms, message, cert? } and never throws.
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { promises as dnsp } from 'node:dns';
import { Client } from 'ldapts';

const clip = (s, n = 160) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const NET = { ECONNREFUSED: 'connection refused', ENOTFOUND: 'name not found (DNS)', EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable',
  ECONNRESET: 'connection reset', ETIMEDOUT: 'timeout', TIMEOUT: 'timeout', EAI_AGAIN: 'name not found (DNS)', EPIPE: 'connection closed',
  CERT_HAS_EXPIRED: 'certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate', SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in chain',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate cannot be verified', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'certificate cannot be verified', ERR_TLS_CERT_ALTNAME_INVALID: 'certificate is for another name' };
const netMessage = (e) => NET[e?.code] || clip(e?.message || String(e), 160);
const servername = (host) => (net.isIP(host) ? undefined : host);
function certOf(sock) {
  try {
    const c = sock?.getPeerCertificate?.();
    if (!c || !c.valid_to) return null;
    return { validTo: new Date(c.valid_to).toISOString(), subject: c.subject?.CN || '', issuer: c.issuer?.CN || c.issuer?.O || '' };
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------- DNS
export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'PTR', 'SOA'];
function dnsAnswers(type, r) {
  if (type === 'MX') return r.sort((a, b) => a.priority - b.priority).map((x) => `${x.priority} ${x.exchange}`);
  if (type === 'TXT') return r.map((x) => x.join(''));
  if (type === 'SRV') return r.map((x) => `${x.priority} ${x.weight} ${x.port} ${x.name}`);
  if (type === 'SOA') return [`${r.nsname} serial ${r.serial}`];
  return r.map(String);
}
export async function dnsCheck(name, { server = '', port = 53, type = 'A', expect = '' } = {}, timeoutS = 5) {
  const t0 = Date.now();
  const resolver = new dnsp.Resolver({ timeout: Math.max(500, Math.round((timeoutS * 1000) / 2)), tries: 2 });
  if (server) resolver.setServers([net.isIPv6(server) ? `[${server}]:${port}` : `${server}:${port}`]);
  try {
    const raw = type === 'PTR' ? await resolver.reverse(name) : await resolver.resolve(name, type);
    const answers = dnsAnswers(type, raw).map((x) => clip(x, 200));
    const ms = Date.now() - t0;
    if (!answers.length) return { ok: false, ms: null, message: `no ${type} record` };
    const text = answers.slice(0, 4).join(', ') + (answers.length > 4 ? ` (+${answers.length - 4})` : '');
    if (expect && !answers.some((a) => a.toLowerCase().includes(expect.toLowerCase()))) return { ok: false, ms: null, message: `answer without "${clip(expect, 80)}": ${text}` };
    return { ok: true, ms, message: text };
  } catch (e) {
    const m = { ENOTFOUND: 'name not found', ENODATA: `no ${type} record`, ESERVFAIL: 'server failure (SERVFAIL)', EREFUSED: 'query refused (REFUSED)', ETIMEOUT: 'timeout',
      ECONNREFUSED: 'connection refused', EBADNAME: 'invalid name', ENOTIMP: 'not implemented by the server' }[e.code];
    return { ok: false, ms: null, message: m || netMessage(e) };
  } finally { resolver.cancel(); }
}

// ---------------------------------------------------------------------------------------------- conversations over TCP
/** Line reader on a socket: reply(isComplete) waits for a complete answer */
function talk(sock, deadline) {
  let buf = '';
  let waiter = null;
  const feed = () => { if (waiter && waiter.done(buf)) { const w = waiter; waiter = null; const out = buf; buf = ''; w.resolve(out); } };
  const onData = (d) => { buf += d.toString('latin1'); if (buf.length > 65536) buf = buf.slice(-65536); feed(); };
  const onEnd = () => { if (waiter) { const w = waiter; waiter = null; w.reject(Object.assign(new Error('connection closed'), { code: 'EPIPE' })); } };
  sock.on('data', onData); sock.on('end', onEnd); sock.on('close', onEnd);
  return {
    reply: (done) => new Promise((resolve, reject) => { waiter = { done, resolve, reject }; feed(); }),
    send: (line) => sock.write(`${line}\r\n`),
    detach: () => { sock.off('data', onData); sock.off('end', onEnd); sock.off('close', onEnd); },
    deadline,
  };
}
function connect(host, port, { implicitTls, verify, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, timeout: timeoutMs };
    const sock = implicitTls ? tls.connect({ ...opts, servername: servername(host), rejectUnauthorized: !!verify }) : net.connect(opts);
    sock.once(implicitTls ? 'secureConnect' : 'connect', () => { sock.setTimeout(timeoutMs); resolve(sock); });
    sock.once('timeout', () => { sock.destroy(); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); });
    sock.once('error', reject);
  });
}
function upgrade(sock, host, verify, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket: sock, servername: servername(host), rejectUnauthorized: !!verify });
    const timer = setTimeout(() => { t.destroy(); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, timeoutMs);
    t.once('secureConnect', () => { clearTimeout(timer); resolve(t); });
    t.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
const withDeadline = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms).unref())]);

// ---------------------------------------------------------------------------------------------- mail
export const MAIL_PORTS = { smtp: { none: 25, starttls: 587, implicit: 465 }, imap: { none: 143, starttls: 143, implicit: 993 }, pop3: { none: 110, starttls: 110, implicit: 995 } };
const smtpDone = (b) => /(^|\r?\n)\d{3} [^\r\n]*\r?\n/.test(b);
const SMTP_LAST = (b) => (b.trim().split(/\r?\n/).pop() || '');
export async function mailCheck(host, port, { proto = 'smtp', tls: mode = 'starttls', verify = false } = {}, timeoutS = 10) {
  const t0 = Date.now();
  const timeoutMs = timeoutS * 1000;
  let sock;
  try {
    return await withDeadline((async () => {
      sock = await connect(host, port, { implicitTls: mode === 'implicit', verify, timeoutMs });
      let c = talk(sock);
      let greeting;
      if (proto === 'smtp') {
        greeting = SMTP_LAST(await c.reply(smtpDone));
        if (!/^220/.test(greeting)) return { ok: false, ms: null, message: `unexpected greeting: ${clip(greeting)}` };
        if (mode === 'starttls') {
          c.send('EHLO whatsonmynet');
          const ehlo = await c.reply(smtpDone);
          if (!/^250/m.test(SMTP_LAST(ehlo))) return { ok: false, ms: null, message: `EHLO refused: ${clip(SMTP_LAST(ehlo))}` };
          if (!/[\s-]STARTTLS\b/i.test(ehlo)) return { ok: false, ms: null, message: 'server offers no STARTTLS' };
          c.send('STARTTLS');
          const st = SMTP_LAST(await c.reply(smtpDone));
          if (!/^220/.test(st)) return { ok: false, ms: null, message: `STARTTLS refused: ${clip(st)}` };
          c.detach();
          sock = await upgrade(sock, host, verify, timeoutMs);
          c = talk(sock);
          c.send('EHLO whatsonmynet');
          await c.reply(smtpDone);
        }
        c.send('QUIT');
      } else if (proto === 'imap') {
        greeting = (await c.reply((b) => /\r?\n/.test(b))).split(/\r?\n/)[0];
        if (!/^\* (OK|PREAUTH)/i.test(greeting)) return { ok: false, ms: null, message: `unexpected greeting: ${clip(greeting)}` };
        if (mode === 'starttls') {
          c.send('a1 STARTTLS');
          const st = await c.reply((b) => /(^|\n)a1 [^\r\n]*\r?\n/.test(b));
          if (!/(^|\n)a1 OK/i.test(st)) return { ok: false, ms: null, message: 'server offers no STARTTLS' };
          c.detach();
          sock = await upgrade(sock, host, verify, timeoutMs);
          c = talk(sock);
        }
        c.send('a2 LOGOUT');
      } else {
        greeting = (await c.reply((b) => /\r?\n/.test(b))).split(/\r?\n/)[0];
        if (!/^\+OK/i.test(greeting)) return { ok: false, ms: null, message: `unexpected greeting: ${clip(greeting)}` };
        if (mode === 'starttls') {
          c.send('STLS');
          const st = (await c.reply((b) => /\r?\n/.test(b))).split(/\r?\n/)[0];
          if (!/^\+OK/i.test(st)) return { ok: false, ms: null, message: 'server offers no STARTTLS' };
          c.detach();
          sock = await upgrade(sock, host, verify, timeoutMs);
          c = talk(sock);
        }
        c.send('QUIT');
      }
      const cert = mode === 'none' ? null : certOf(sock);
      return { ok: true, ms: Date.now() - t0, message: `${clip(greeting.replace(/^(220[ -]|\* OK |\+OK )/i, ''), 120)}${mode === 'none' ? '' : ' · TLS'}`, cert };
    })(), timeoutMs + 2000);
  } catch (e) {
    return { ok: false, ms: null, message: netMessage(e) };
  } finally { try { sock?.destroy(); } catch { /* closed */ } }
}

// ---------------------------------------------------------------------------------------------- LDAP / Active Directory
const ROOT_ATTRS = ['defaultNamingContext', 'dnsHostName', 'isSynchronized', 'isGlobalCatalogReady', 'domainControllerFunctionality', 'namingContexts', 'supportedLDAPVersion', 'vendorName'];
let LdapClient = Client;
/** Tests use a stand-in for the LDAP client */
export function setLdapClient(c) { LdapClient = c || Client; }
export async function ldapCheck(host, port, { tls: mode = 'ldaps', verify = false } = {}, timeoutS = 10) {
  const t0 = Date.now();
  const tlsOptions = { rejectUnauthorized: !!verify, servername: servername(host) };
  const h = net.isIPv6(host) ? `[${host}]` : host;
  const client = new LdapClient({ url: `${mode === 'ldaps' ? 'ldaps' : 'ldap'}://${h}:${port}`, timeout: timeoutS * 1000, connectTimeout: timeoutS * 1000, tlsOptions, strictDN: false });
  try {
    if (mode === 'starttls') await client.startTLS(tlsOptions);
    const { searchEntries } = await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ROOT_ATTRS });
    const e = searchEntries?.[0] || {};
    const one = (k) => { const v = e[k]; return clip(Array.isArray(v) ? v[0] : Buffer.isBuffer(v) ? v.toString() : v ?? '', 200); };
    const cert = mode === 'none' ? null : certOf(client.socket);
    const ad = one('domainControllerFunctionality') !== '' || one('isSynchronized') !== '';
    if (ad && one('isSynchronized').toUpperCase() === 'FALSE') return { ok: false, ms: null, message: `domain controller not synchronized (${one('dnsHostName') || host})`, cert };
    const name = one('dnsHostName') || one('vendorName') || one('defaultNamingContext') || one('namingContexts');
    return { ok: true, ms: Date.now() - t0, message: [name || 'rootDSE readable', ad ? 'synchronized' : '', ad && one('isGlobalCatalogReady').toUpperCase() === 'TRUE' ? 'global catalog' : '', mode === 'none' ? '' : 'TLS'].filter(Boolean).join(' · '), cert };
  } catch (e) {
    const msg = /operationsError|Operations ?Error/i.test(`${e.name} ${e.message}`) ? 'rootDSE not readable without sign-in' : /StartTLS|unsupported extended|protocolError/i.test(`${e.message}`) && mode === 'starttls' ? 'server offers no StartTLS' : netMessage(e);
    return { ok: false, ms: null, message: msg };
  } finally { try { await client.unbind(); } catch { /* closed */ } }
}

// ---------------------------------------------------------------------------------------------- NTP
const NTP_EPOCH = 2208988800;
const toNtp = (ms, buf, at) => { const s = Math.floor(ms / 1000) + NTP_EPOCH; buf.writeUInt32BE(s >>> 0, at); buf.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0, at + 4); };
const fromNtp = (buf, at) => (buf.readUInt32BE(at) - NTP_EPOCH) * 1000 + (buf.readUInt32BE(at + 4) / 2 ** 32) * 1000;
/** SNTP query (RFC 4330): offset of the server's clock against this one, stratum, synchronized */
export function ntpCheck(host, port = 123, { maxOffsetMs = 1000 } = {}, timeoutS = 5) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    let done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch { /* closed */ } resolve(r); };
    const timer = setTimeout(() => end({ ok: false, ms: null, message: `timeout (${timeoutS} s)` }), timeoutS * 1000);
    const req = Buffer.alloc(48);
    req[0] = 0x23; // LI 0, version 4, mode 3 (client)
    const t1 = Date.now();
    toNtp(t1 + Math.random(), req, 40);
    const sent = req.subarray(40, 48);
    sock.on('error', (e) => end({ ok: false, ms: null, message: netMessage(e) }));
    sock.on('message', (b) => {
      const t4 = Date.now();
      // only the answer to this question (origin = what we sent) - a forged or late answer does not count
      if (b.length < 48 || (b[0] & 7) !== 4 || !b.subarray(24, 32).equals(sent)) return;
      const li = b[0] >> 6; const stratum = b[1];
      if (stratum === 0) return end({ ok: false, ms: null, message: `server refuses (kiss code ${clip(b.subarray(12, 16).toString('latin1'), 4)})` });
      if (li === 3 || stratum >= 16) return end({ ok: false, ms: null, message: 'server not synchronized' });
      const t2 = fromNtp(b, 32); const t3 = fromNtp(b, 40);
      const offset = Math.round(((t2 - t1) + (t3 - t4)) / 2);
      const delay = Math.max(0, Math.round((t4 - t1) - (t3 - t2)));
      const sign = offset > 0 ? '+' : '';
      if (Math.abs(offset) > maxOffsetMs) return end({ ok: false, ms: null, message: `offset ${sign}${offset} ms (limit ${maxOffsetMs} ms) · stratum ${stratum}` });
      end({ ok: true, ms: delay, message: `offset ${sign}${offset} ms · stratum ${stratum}` });
    });
    sock.send(req, port, host, (e) => { if (e) end({ ok: false, ms: null, message: netMessage(e) }); });
  });
}

// ---------------------------------------------------------------------------------------------- Microsoft SQL Server
const SQL_NAMES = { 17: '2025', 16: '2022', 15: '2019', 14: '2017', 13: '2016', 12: '2014', 11: '2012', 10: '2008' };
/** PRELOGIN (TDS 7.x): version and encryption of the server, without signing in */
export function prelogin() {
  const payload = Buffer.from([0x00, 0x00, 0x0b, 0x00, 0x06, 0x01, 0x00, 0x11, 0x00, 0x01, 0xff, 0, 0, 0, 0, 0, 0, 0x02]);
  const head = Buffer.from([0x12, 0x01, 0, 0, 0, 0, 0x01, 0x00]);
  head.writeUInt16BE(8 + payload.length, 2);
  return Buffer.concat([head, payload]);
}
export function parsePrelogin(buf) {
  if (buf.length < 8 || buf[0] !== 0x04) return null;
  const p = buf.subarray(8, buf.readUInt16BE(2));
  const out = {};
  for (let i = 0; i < p.length && p[i] !== 0xff; i += 5) {
    const tok = p[i]; const off = p.readUInt16BE(i + 1); const len = p.readUInt16BE(i + 3);
    if (off + len > p.length) return null;
    if (tok === 0x00 && len >= 6) out.version = `${p[off]}.${p[off + 1]}.${p.readUInt16BE(off + 2)}`;
    if (tok === 0x01 && len >= 1) out.encryption = ['off', 'on', 'not supported', 'required'][p[off]] || String(p[off]);
  }
  return out.version ? out : null;
}
/** SQL Browser (UDP 1434): the TCP port of a named instance */
export function browserPort(host, instance, timeoutS = 3) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    let done = false;
    const end = (v) => { if (!done) { done = true; clearTimeout(timer); try { sock.close(); } catch { /* closed */ } resolve(v); } };
    const timer = setTimeout(() => end(null), timeoutS * 1000);
    sock.on('error', () => end(null));
    sock.on('message', (b) => {
      if (b[0] !== 0x05) return;
      const m = /;tcp;(\d{1,5})(;|$)/i.exec(b.subarray(3).toString('latin1'));
      end(m ? Number(m[1]) : 0);
    });
    sock.send(Buffer.concat([Buffer.from([0x04]), Buffer.from(instance, 'latin1')]), 1434, host, (e) => { if (e) end(null); });
  });
}
export async function mssqlCheck(host, port, { instance = '' } = {}, timeoutS = 10) {
  const t0 = Date.now();
  let p = port;
  if (instance && !p) {
    p = await browserPort(host, instance, Math.min(5, timeoutS));
    if (p === null) return { ok: false, ms: null, message: 'SQL Browser does not answer (UDP 1434)' };
    if (!p) return { ok: false, ms: null, message: `instance ${instance} not found or without TCP` };
  }
  let sock;
  try {
    sock = await connect(host, p || 1433, { implicitTls: false, timeoutMs: timeoutS * 1000 });
    const answer = await withDeadline(new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= 8 && buf.length >= buf.readUInt16BE(2)) resolve(buf); });
      sock.on('error', reject);
      sock.on('end', () => resolve(buf));
      sock.write(prelogin());
    }), timeoutS * 1000);
    const r = parsePrelogin(answer);
    if (!r) return { ok: false, ms: null, message: 'unexpected answer (no SQL Server?)' };
    const major = Number(r.version.split('.')[0]);
    return { ok: true, ms: Date.now() - t0, message: `SQL Server${SQL_NAMES[major] ? ` ${SQL_NAMES[major]}` : ''} (${r.version})${instance ? ` · ${instance}` : ''}${r.encryption ? ` · encryption ${r.encryption}` : ''}` };
  } catch (e) {
    return { ok: false, ms: null, message: netMessage(e) };
  } finally { try { sock?.destroy(); } catch { /* closed */ } }
}
