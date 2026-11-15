// Protocol checks against small stand-in servers: DNS, SMTP/IMAP/POP3 with STARTTLS and TLS, LDAP/AD rootDSE,
// NTP (offset, not synchronized, forged answers), Microsoft SQL Server PRELOGIN - and their forms in the API.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startApp, tmp } from './helpers.js';
import { dnsCheck, mailCheck, ldapCheck, ntpCheck, mssqlCheck, setLdapClient, prelogin, parsePrelogin } from '../src/monitor/protocols.js';
import { checkText } from '../public/js/checktext.js';

const key = path.join(tmp, 'proto.key'); const crt = path.join(tmp, 'proto.crt');
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '20', '-subj', '/CN=mail.firma.local'], { stdio: 'ignore' });
const creds = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const udp = (handler) => new Promise((r) => { const s = dgram.createSocket('udp4'); s.on('message', (m, ri) => handler(m, ri, s)); s.bind(0, '127.0.0.1', () => r({ port: s.address().port, close: () => s.close() })); });

test('DNS: answer, expected value, missing name', async () => {
  // a tiny DNS server: A 10.0.0.5 for intranet.firma.local, NXDOMAIN otherwise
  const srv = await udp((q, ri, s) => {
    let i = 12; const labels = [];
    while (q[i]) { labels.push(q.subarray(i + 1, i + 1 + q[i]).toString()); i += q[i] + 1; }
    const qEnd = i + 5; const name = labels.join('.');
    const head = Buffer.from(q.subarray(0, 12)); head[2] = 0x81; head[3] = name === 'intranet.firma.local' ? 0x80 : 0x83;
    head.writeUInt16BE(name === 'intranet.firma.local' ? 1 : 0, 6);
    const ans = name === 'intranet.firma.local' ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 0, 0, 5]) : Buffer.alloc(0);
    s.send(Buffer.concat([head, q.subarray(12, qEnd), ans]), ri.port, ri.address);
  });
  try {
    const ok = await dnsCheck('intranet.firma.local', { server: '127.0.0.1', port: srv.port, type: 'A' }, 3);
    assert.deepEqual([ok.ok, ok.message], [true, '10.0.0.5']);
    const exp = await dnsCheck('intranet.firma.local', { server: '127.0.0.1', port: srv.port, type: 'A', expect: '10.0.0.9' }, 3);
    assert.equal(exp.ok, false);
    assert.equal(exp.message, 'answer without "10.0.0.9": 10.0.0.5');
    const nx = await dnsCheck('weg.firma.local', { server: '127.0.0.1', port: srv.port, type: 'A' }, 3);
    assert.deepEqual([nx.ok, nx.message], [false, 'name not found']);
    assert.equal(checkText('answer without "10.0.0.9": 10.0.0.5'), 'Antwort ohne „10.0.0.9“: 10.0.0.5');
  } finally { srv.close(); }
});

/** SMTP stand-in: greeting, EHLO (with or without STARTTLS), STARTTLS, QUIT */
function smtpServer({ starttls = true } = {}) {
  return net.createServer((sock) => {
    let s = sock;
    const serve = (conn, secure) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^EHLO/i.test(line)) conn.write(`250-mail.firma.local\r\n250-SIZE 52428800\r\n${starttls && !secure ? '250-STARTTLS\r\n' : ''}250 8BITMIME\r\n`);
          else if (/^STARTTLS/i.test(line)) {
            conn.write('220 2.0.0 Ready to start TLS\r\n');
            conn.removeAllListeners('data');
            s = new tls.TLSSocket(conn, { isServer: true, ...creds });
            serve(s, true);
          } else if (/^QUIT/i.test(line)) { conn.end('221 Bye\r\n'); }
        }
      });
      conn.on('error', () => {});
    };
    sock.write('220 mail.firma.local ESMTP Postfix\r\n');
    serve(sock, false);
  });
}

test('mail: SMTP with STARTTLS gives the certificate; without STARTTLS it says so; IMAP over TLS; POP3 plain', async () => {
  const a = smtpServer(); const pa = await listen(a);
  const b = smtpServer({ starttls: false }); const pb = await listen(b);
  const imap = tls.createServer(creds, (s) => { s.write('* OK [CAPABILITY IMAP4rev1] Dovecot ready.\r\n'); s.on('data', (d) => { if (/LOGOUT/.test(d)) s.end('* BYE\r\na2 OK\r\n'); }); s.on('error', () => {}); });
  const pi = await listen(imap);
  const pop = net.createServer((s) => { s.write('+OK POP3 ready\r\n'); s.on('data', () => s.end('+OK bye\r\n')); s.on('error', () => {}); });
  const pp = await listen(pop);
  try {
    const r = await mailCheck('127.0.0.1', pa, { proto: 'smtp', tls: 'starttls', verify: false }, 5);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, 'mail.firma.local ESMTP Postfix · TLS');
    assert.ok(r.cert && Date.parse(r.cert.validTo) > Date.now(), 'certificate read for its expiry');
    assert.equal(r.cert.subject, 'mail.firma.local');
    // the certificate is self-signed: with the check switched on it fails plainly
    const v = await mailCheck('127.0.0.1', pa, { proto: 'smtp', tls: 'starttls', verify: true }, 5);
    assert.deepEqual([v.ok, v.message], [false, 'self-signed certificate']);
    const n = await mailCheck('127.0.0.1', pb, { proto: 'smtp', tls: 'starttls' }, 5);
    assert.deepEqual([n.ok, n.message], [false, 'server offers no STARTTLS']);
    assert.equal(checkText(n.message), 'Server bietet kein STARTTLS an');
    const i = await mailCheck('127.0.0.1', pi, { proto: 'imap', tls: 'implicit' }, 5);
    assert.equal(i.ok, true, i.message);
    assert.match(i.message, /Dovecot ready\. · TLS$/);
    const p = await mailCheck('127.0.0.1', pp, { proto: 'pop3', tls: 'none' }, 5);
    assert.deepEqual([p.ok, p.message, p.cert], [true, 'POP3 ready', null]);
    const refused = await mailCheck('127.0.0.1', 1, { proto: 'smtp', tls: 'none' }, 3);
    assert.deepEqual([refused.ok, refused.message], [false, 'connection refused']);
  } finally { a.close(); b.close(); imap.close(); pop.close(); }
});

test('LDAP / AD: rootDSE, domain controller not synchronized, StartTLS', async () => {
  let entry = { dnsHostName: 'dc01.firma.local', isSynchronized: 'TRUE', isGlobalCatalogReady: 'TRUE', domainControllerFunctionality: '7', defaultNamingContext: 'DC=firma,DC=local' };
  const seen = [];
  setLdapClient(class {
    constructor(o) { seen.push(o.url); this.o = o; }
    async startTLS() { seen.push('starttls'); }
    async search(base, opts) { assert.equal(base, ''); assert.equal(opts.scope, 'base'); return { searchEntries: [entry] }; }
    async unbind() {}
  });
  try {
    const ok = await ldapCheck('dc01.firma.local', 636, { tls: 'ldaps' }, 5);
    assert.deepEqual([ok.ok, ok.message], [true, 'dc01.firma.local · synchronized · global catalog · TLS']);
    assert.equal(seen[0], 'ldaps://dc01.firma.local:636');
    await ldapCheck('dc01.firma.local', 389, { tls: 'starttls' }, 5);
    assert.deepEqual(seen.slice(1), ['ldap://dc01.firma.local:389', 'starttls']);
    entry = { ...entry, isSynchronized: 'FALSE' };
    const bad = await ldapCheck('dc01.firma.local', 636, { tls: 'ldaps' }, 5);
    assert.deepEqual([bad.ok, bad.message], [false, 'domain controller not synchronized (dc01.firma.local)']);
    assert.equal(checkText(bad.message), 'Domänencontroller nicht synchronisiert (dc01.firma.local)');
    entry = { vendorName: 'OpenLDAP', namingContexts: ['dc=firma,dc=local'] };
    assert.equal((await ldapCheck('ldap.firma.local', 389, { tls: 'none' }, 5)).message, 'OpenLDAP');
  } finally { setLdapClient(null); }
});

test('NTP: offset and stratum, a limit, not synchronized, a forged answer does not count', async () => {
  let mode = 'ok';
  const srv = await udp((q, ri, s) => {
    if (mode === 'silent') return;
    const r = Buffer.alloc(48);
    r[0] = (mode === 'unsync' ? 3 << 6 : 0) | (4 << 3) | 4; r[1] = 2;
    if (mode === 'forged') q.copy(r, 24, 32, 40); else q.copy(r, 24, 40, 48);
    const shift = mode === 'far' ? 5000 : 40;
    const now = Date.now() + shift; const sec = Math.floor(now / 1000) + 2208988800; const frac = Math.floor(((now % 1000) / 1000) * 2 ** 32);
    for (const at of [32, 40]) { r.writeUInt32BE(sec >>> 0, at); r.writeUInt32BE(frac >>> 0, at + 4); }
    s.send(r, ri.port, ri.address);
  });
  try {
    const ok = await ntpCheck('127.0.0.1', srv.port, { maxOffsetMs: 1000 }, 2);
    assert.equal(ok.ok, true, ok.message);
    assert.match(ok.message, /^offset \+(3\d|4\d) ms · stratum 2$/);
    mode = 'far';
    const far = await ntpCheck('127.0.0.1', srv.port, { maxOffsetMs: 1000 }, 2);
    assert.equal(far.ok, false);
    assert.match(far.message, /^offset \+\d{4} ms \(limit 1000 ms\) · stratum 2$/);
    assert.match(checkText(far.message), /^Abweichung \+\d{4} ms \(Grenze 1000 ms\) · Stratum 2$/);
    mode = 'unsync';
    assert.equal((await ntpCheck('127.0.0.1', srv.port, {}, 2)).message, 'server not synchronized');
    mode = 'forged';
    assert.equal((await ntpCheck('127.0.0.1', srv.port, {}, 1)).message, 'timeout (1 s)');
  } finally { srv.close(); }
});

test('SQL Server: PRELOGIN gives the version; something else answering is no SQL Server', async () => {
  const resp = (() => {
    const p = Buffer.from([0x00, 0x00, 0x0b, 0x00, 0x06, 0x01, 0x00, 0x11, 0x00, 0x01, 0xff, 16, 0, 0x10, 0x27, 0, 0, 0x00]);
    const h = Buffer.from([0x04, 0x01, 0, 0, 0, 0, 0x01, 0]); h.writeUInt16BE(8 + p.length, 2);
    return Buffer.concat([h, p]);
  })();
  assert.deepEqual(parsePrelogin(resp), { version: '16.0.4135', encryption: 'off' });
  assert.equal(prelogin()[0], 0x12);
  const sql = net.createServer((s) => { s.once('data', (d) => { assert.equal(d[0], 0x12); s.write(resp); }); s.on('error', () => {}); });
  const ps = await listen(sql);
  const web = net.createServer((s) => { s.once('data', () => s.end('HTTP/1.1 400 Bad Request\r\n\r\n')); s.on('error', () => {}); });
  const pw = await listen(web);
  try {
    const r = await mssqlCheck('127.0.0.1', ps, {}, 5);
    assert.deepEqual([r.ok, r.message], [true, 'SQL Server 2022 (16.0.4135) · encryption off']);
    const w = await mssqlCheck('127.0.0.1', pw, {}, 5);
    assert.deepEqual([w.ok, w.message], [false, 'unexpected answer (no SQL Server?)']);
  } finally { sql.close(); web.close(); }
});

test('forms: defaults per protocol, wrong input refused', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.call('POST', '/api/setup', { username: 'michael', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
    const mk = (body) => app.call('POST', '/api/monitors', { interval_s: 300, ...body });
    const mail = await mk({ name: 'Mail', type: 'mail', target: 'mail.firma.local', options: { proto: 'imap', tls: 'implicit' } });
    assert.equal(mail.status, 201, JSON.stringify(mail.data));
    assert.deepEqual([mail.data.port, mail.data.options], [993, { proto: 'imap', tls: 'implicit' }]);
    assert.equal((await mk({ name: 'LDAP', type: 'ldap', target: 'dc01.firma.local', options: { tls: 'starttls' } })).data.port, 389);
    assert.equal((await mk({ name: 'Zeit', type: 'ntp', target: 'ptbtime1.ptb.de', options: { maxOffsetMs: 500 } })).data.port, 123);
    const sql = await mk({ name: 'SQL', type: 'mssql', target: 'sql01.firma.local', options: { instance: 'SQLEXPRESS' } });
    assert.deepEqual([sql.data.port, sql.data.options.instance], [null, 'SQLEXPRESS']);
    const dns = await mk({ name: 'DNS', type: 'dns', target: 'intranet.firma.local', options: { server: '10.0.0.1', rtype: 'A', expect: '10.0.0.5' } });
    assert.deepEqual([dns.status, dns.data.port, dns.data.options.rtype], [201, 53, 'A']);
    // the same name, server and type once more: refused; another record type is another check
    assert.equal((await mk({ name: 'DNS 2', type: 'dns', target: 'intranet.firma.local', options: { server: '10.0.0.1', rtype: 'A', expect: '10.0.0.5' } })).status, 409);
    assert.equal((await mk({ name: 'DNS MX', type: 'dns', target: 'intranet.firma.local', options: { server: '10.0.0.1', rtype: 'MX' } })).status, 201);
    assert.equal((await mk({ name: 'x', type: 'dns', target: 'a.b', options: { server: 'dns.evil' } })).data.error.code, 'err.dnsServer');
    assert.equal((await mk({ name: 'x', type: 'ntp', target: 'a.b', options: { maxOffsetMs: 0 } })).data.error.code, 'err.ntpOffset');
    assert.equal((await mk({ name: 'x', type: 'mssql', target: 'a.b', options: { instance: 'A;B' } })).data.error.code, 'err.sqlInstance');
    assert.equal((await mk({ name: 'x', type: 'mail', target: 'a b' })).data.error.code, 'err.host');
    const how = (await app.call('GET', `/api/monitors/${mail.data.id}`)).data.how;
    assert.deepEqual([how.proto, how.tlsMode, how.port], ['imap', 'implicit', 993]);
  } finally { await app.close(); }
});
