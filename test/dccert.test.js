import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { memoryDb, tmp } from './helpers.js';
import { fetchChain, completeViaAia, completeFrom, orderChain, complete, issuedBy, describe, parseLdapUrl, aiaUrls } from '../src/auth/dccert.js';
import { createDirectory } from '../src/auth/directory.js';
import { createSettings } from '../src/settings.js';

// A small PKI like an AD CS: root CA → intermediate CA → certificate of the domain controller.
// The AIA address of each certificate points to its issuer on a local web server.
const dir = path.join(tmp, 'pki');
fs.mkdirSync(dir, { recursive: true });
const f = (n) => path.join(dir, n);
const ossl = (...a) => execFileSync('openssl', a, { stdio: ['ignore', 'pipe', 'pipe'] });
const aia = http.createServer((req, res) => {
  const name = { '/root.crt': 'root.der', '/inter.crt': 'inter.der', '/evil.crt': 'evil.der', '/big.crt': null }[req.url];
  if (name === null) { res.end(Buffer.alloc(300 * 1024)); return; }
  if (!name) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', 'application/pkix-cert');
  res.end(fs.readFileSync(f(name)));
});
await new Promise((r) => aia.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${aia.address().port}`;

function makeCa(name, subj, { signer = null, aiaPath = null } = {}) {
  ossl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', subj, '-keyout', f(`${name}.key`), '-out', f(`${name}.csr`));
  const ext = f(`${name}.ext`);
  fs.writeFileSync(ext, `basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n${signer ? 'authorityKeyIdentifier=keyid\n' : ''}${aiaPath ? `authorityInfoAccess=caIssuers;URI:${base}${aiaPath}\n` : ''}`);
  if (signer) ossl('x509', '-req', '-in', f(`${name}.csr`), '-CA', f(`${signer}.pem`), '-CAkey', f(`${signer}.key`), '-CAcreateserial', '-days', '30', '-extfile', ext, '-out', f(`${name}.pem`));
  else ossl('x509', '-req', '-in', f(`${name}.csr`), '-signkey', f(`${name}.key`), '-days', '30', '-extfile', ext, '-out', f(`${name}.pem`));
  ossl('x509', '-in', f(`${name}.pem`), '-outform', 'DER', '-out', f(`${name}.der`));
}
makeCa('root', '/O=Firma/CN=Firma Root CA');
makeCa('evil', '/O=Firma/CN=Firma Root CA'); // same name, other key – must never be accepted
makeCa('inter', '/O=Firma/CN=Firma Issuing CA', { signer: 'root', aiaPath: '/root.crt' });
ossl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/O=Firma/OU=IT/CN=dc01.firma.local', '-keyout', f('dc.key'), '-out', f('dc.csr'));
fs.writeFileSync(f('dc.ext'), `basicConstraints=CA:false\nsubjectAltName=DNS:dc01.firma.local,DNS:localhost,IP:127.0.0.1\nauthorityKeyIdentifier=keyid\nauthorityInfoAccess=caIssuers;URI:${base}/inter.crt\n`);
ossl('x509', '-req', '-in', f('dc.csr'), '-CA', f('inter.pem'), '-CAkey', f('inter.key'), '-CAcreateserial', '-days', '30', '-extfile', f('dc.ext'), '-out', f('dc.pem'));
const cert = (n) => new X509Certificate(fs.readFileSync(f(`${n}.pem`)));
const [rootC, interC, dcC, evilC] = ['root', 'inter', 'dc', 'evil'].map(cert);
const key = fs.readFileSync(f('dc.key'));

// LDAPS server (only the DC certificate is sent – like a DC without the chain configured)
const ldaps = tls.createServer({ key, cert: fs.readFileSync(f('dc.pem')) }, (s) => s.end());
await new Promise((r) => ldaps.listen(0, '0.0.0.0', r));
// LDAP with StartTLS: answers the ExtendedRequest with success, then speaks TLS
const ldap = net.createServer((sock) => {
  sock.once('data', () => {
    sock.write(Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x01, 0x78, 0x07, 0x0a, 0x01, 0x00, 0x04, 0x00, 0x04, 0x00]));
    const s = new tls.TLSSocket(sock, { isServer: true, key, cert: fs.readFileSync(f('dc.pem')) + fs.readFileSync(f('inter.pem')) });
    s.on('error', () => {});
  });
  sock.on('error', () => {});
});
await new Promise((r) => ldap.listen(0, '127.0.0.1', r));
// LDAP without StartTLS (answers "unwilling to perform")
const noTls = net.createServer((sock) => {
  sock.once('data', () => sock.end(Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x01, 0x78, 0x07, 0x0a, 0x01, 0x35, 0x04, 0x00, 0x04, 0x00])));
});
await new Promise((r) => noTls.listen(0, '127.0.0.1', r));
test.after(() => { aia.close(); ldaps.close(); ldap.close(); noTls.close(); });

test('signature check: only the real issuer counts', () => {
  assert.ok(issuedBy(dcC, interC));
  assert.ok(issuedBy(interC, rootC));
  assert.ok(!issuedBy(interC, evilC), 'same name, other key');
  assert.ok(complete([dcC, interC, rootC]));
  assert.ok(!complete([dcC, interC]));
  assert.deepEqual(orderChain([rootC, dcC, interC]).map((c) => c.subject), [dcC, interC, rootC].map((c) => c.subject));
  assert.deepEqual(aiaUrls(dcC), [`${base}/inter.crt`]);
  const d = describe(dcC, { role: 'server' });
  assert.equal(d.cn, 'dc01.firma.local');
  assert.equal(d.org, 'Firma · IT');
  assert.deepEqual(d.names, ['dc01.firma.local', 'localhost']);
  assert.equal(describe(rootC).role, 'root');
  assert.equal(describe(interC).role, 'intermediate');
  assert.deepEqual(parseLdapUrl('ldap://dc01:3268'), { host: 'dc01', port: 3268, ldaps: false });
  assert.equal(parseLdapUrl('ldaps://dc01').port, 636);
  assert.equal(parseLdapUrl('http://dc01'), null);
});

test('fetch over LDAPS and complete the chain via AIA', async () => {
  const got = await fetchChain({ url: `ldaps://127.0.0.1:${ldaps.address().port}` });
  assert.equal(got.certs.length, 1);
  assert.equal(got.nameOk, true);
  const r = await completeViaAia(got.certs);
  assert.equal(r.chain.length, 3);
  assert.ok(complete(r.chain));
  assert.equal(r.added.length, 2);
  // the name in the certificate does not fit this address
  assert.equal((await fetchChain({ url: `ldaps://127.0.0.2:${ldaps.address().port}` })).nameOk, false);
});

test('fetch over StartTLS (server sends DC + intermediate)', async () => {
  const got = await fetchChain({ url: `ldap://127.0.0.1:${ldap.address().port}`, startTls: true });
  assert.deepEqual(got.certs.map((c) => describe(c).cn), ['dc01.firma.local', 'Firma Issuing CA']);
  await assert.rejects(fetchChain({ url: `ldap://127.0.0.1:${noTls.address().port}`, startTls: true }), /StartTLS/);
  await assert.rejects(fetchChain({ url: `ldap://127.0.0.1:${ldap.address().port}` }), { code: 'err.adPlain' });
});

test('AIA: wrong issuer, unreachable or too large is ignored', async () => {
  const fake = (body, status = 200) => async () => new Response(body, { status });
  const evil = await completeViaAia([interC], { fetchImpl: fake(fs.readFileSync(f('evil.der'))) });
  assert.equal(evil.chain.length, 1);
  assert.equal(evil.tried[0].error, 'not the issuer');
  const gone = await completeViaAia([interC], { fetchImpl: fake('nope', 404) });
  assert.match(gone.tried[0].error, /404/);
  const big = await completeViaAia([interC], { fetchImpl: fake(Buffer.alloc(300 * 1024)) });
  assert.equal(big.tried[0].error, 'too large');
  // a PEM file with several certificates: the right one is picked
  const pem = await completeViaAia([interC], { fetchImpl: fake(fs.readFileSync(f('evil.pem')) + fs.readFileSync(f('root.pem'))) });
  assert.ok(complete(pem.chain));
  assert.equal(completeFrom([dcC, interC], [evilC, rootC]).added[0].fingerprint256, rootC.fingerprint256);
});

test('directory: fetch, confirm, root CA from AD, remove', async () => {
  const db = memoryDb();
  const settings = createSettings(db);
  const seen = [];
  // AD stand-in: answers RootDSE and the Public Key Services search with the root CA
  const clientFactory = (opts) => ({
    async startTLS(o) { seen.push(o); },
    async bind(dn, pw) { seen.push({ bind: dn, pw }); },
    async search(baseDn, o) {
      if (baseDn === '') return { searchEntries: [{ configurationNamingContext: 'CN=Configuration,DC=firma,DC=local' }] };
      assert.equal(baseDn, 'CN=Public Key Services,CN=Services,CN=Configuration,DC=firma,DC=local');
      assert.deepEqual(o.explicitBufferAttributes, ['cACertificate']);
      return { searchEntries: [{ cACertificate: [fs.readFileSync(f('evil.der'))] }, { cACertificate: fs.readFileSync(f('root.der')) }] };
    },
    async unbind() {},
    opts,
  });
  const directory = createDirectory(settings, { clientFactory: (o) => { seen.push(o); return clientFactory(o); } });
  directory.save({ enabled: false, url: `ldap://127.0.0.1:${ldap.address().port}`, startTls: true, baseDn: 'DC=firma,DC=local', bindDn: 'svc@firma.local', bindPassword: 'svc-pw', verify: false });

  // AIA off for this case: the intermediate has no AIA reachable → root from AD after confirming
  const fetched = await directory.fetchCert({});
  assert.equal(fetched.certs[0].role, 'server');
  assert.equal(fetched.certs[0].source, 'server');
  assert.equal(fetched.complete, true, 'the intermediate CA points to the root via AIA');
  assert.equal(fetched.certs[2].source, 'aia');

  // Confirm only DC + intermediate: the root is then looked up in AD over a trusted connection
  const partial = fs.readFileSync(f('dc.pem'), 'utf8') + fs.readFileSync(f('inter.pem'), 'utf8');
  const res = await directory.confirmCert({ pem: partial, bindPassword: 'form-pw' });
  assert.equal(res.added, 1);
  assert.equal(res.complete, true);
  assert.deepEqual(res.certs.map((c) => c.role), ['server', 'intermediate', 'root']);
  assert.equal(settings.get('ad.verify'), true);
  const startTls = seen.find((o) => o && o.allowPartialTrustChain);
  assert.equal(startTls.rejectUnauthorized, true, 'AD lookup only over a verified connection');
  assert.ok(String(startTls.ca[0]).includes('BEGIN CERTIFICATE'));
  assert.deepEqual(seen.find((o) => o && o.bind), { bind: 'svc@firma.local', pw: 'form-pw' });
  assert.equal(directory.certInfo().certs.length, 3);

  // Nothing but certificates; at most 10
  await assert.rejects(directory.confirmCert({ pem: 'hallo' }), { code: 'err.adCa' });
  await assert.rejects(directory.confirmCert({ pem: `${partial}\nrm -rf /` }), { code: 'err.adCa' });
  await assert.rejects(directory.confirmCert({ pem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' }), { code: 'err.adCa' });
  await assert.rejects(directory.fetchCert({ url: 'http://dc01' }), { code: 'err.adUrl' });

  // Saving the form leaves the certificate alone
  directory.save({ ...directory.config(), bindPassword: undefined });
  assert.equal(directory.certInfo().certs.length, 3);
  assert.equal(directory.removeCert().certs.length, 0);
  assert.equal(settings.get('ad.ca'), '');
});

test('a pinned certificate or CA is enough, a foreign one is refused', async () => {
  const optsFor = (pem) => {
    const settings = createSettings(memoryDb());
    let got;
    const d = createDirectory(settings, { clientFactory: (o) => { got = o; return { unbind: async () => {}, bind: async () => {}, search: async () => ({ searchEntries: [] }) }; } });
    d.save({ enabled: false, url: `ldaps://127.0.0.1:${ldaps.address().port}`, baseDn: 'DC=x', verify: true, ca: pem });
    return d.verify('x', '', { checkPassword: false }).catch(() => got.tlsOptions);
  };
  const hs = (o) => new Promise((resolve) => {
    const s = tls.connect({ ...o, host: '127.0.0.1', port: ldaps.address().port }, () => { s.destroy(); resolve('ok'); });
    s.on('error', (e) => resolve(e.code || e.message));
  });
  const read = (n) => fs.readFileSync(f(`${n}.pem`), 'utf8');
  assert.equal(await hs(await optsFor(read('dc'))), 'ok', 'only the DC certificate (no root found)');
  assert.equal(await hs(await optsFor(read('inter') + read('root'))), 'ok', 'renewed DC certificate: the CA is enough');
  assert.notEqual(await hs(await optsFor(read('evil'))), 'ok', 'foreign CA is refused');
});

test('a self-signed certificate is never "publicly trusted"', async () => {
  const { publiclyTrusted } = await import('../src/auth/dccert.js');
  assert.equal(publiclyTrusted([rootC]), false);
  assert.equal(publiclyTrusted([dcC, interC, rootC]), false);
  const sys = new X509Certificate(tls.rootCertificates[0]);
  assert.equal(publiclyTrusted([sys]), true);
});
