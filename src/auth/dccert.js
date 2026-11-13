// Certificate of the domain controller: fetch it, complete the chain up to the root CA, describe it.
//
// 1. fetchChain: opens LDAPS (or LDAP + StartTLS) to the DC and takes the certificates the server sends – without
//    trusting them yet. No password goes over this connection.
// 2. completeViaAia: a missing issuer is downloaded from the "CA Issuers" address (AIA) in the certificate.
// 3. completeViaAd: after the admin has confirmed the fingerprint, the root CA can also come from AD itself
//    (Configuration partition, Public Key Services) – this connection already trusts the confirmed certificate.
// Every added CA must really have signed the certificate below it (signature check), otherwise it is ignored.
import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export function splitPem(pem) {
  return String(pem || '').match(PEM_RE) || [];
}

/** Parses PEM blocks to certificates; invalid blocks throw */
export function parsePem(pem) {
  return splitPem(pem).map((p) => new X509Certificate(p));
}

export function toPem(certs) {
  return certs.map((c) => c.toString().trim()).join('\n') + (certs.length ? '\n' : '');
}

/** Did `issuer` sign `cert`? (name and signature) */
export function issuedBy(cert, issuer) {
  try { return cert.checkIssued(issuer) && cert.verify(issuer.publicKey); } catch { return false; }
}
export const selfSigned = (c) => issuedBy(c, c);

const field = (dn, key) => {
  const m = new RegExp(`(?:^|\\n)${key}=([^\\n]+)`).exec(String(dn || ''));
  return m ? m[1].trim() : '';
};

/** Short, readable description for the interface */
export function describe(c, { role = null, source = 'server', now = Date.now() } = {}) {
  const san = String(c.subjectAltName || '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4));
  const cn = field(c.subject, 'CN') || san[0] || c.subject.split('\n').pop();
  const validTo = new Date(c.validTo).toISOString();
  return {
    role: role || (selfSigned(c) ? 'root' : c.ca ? 'intermediate' : 'server'),
    cn,
    org: [field(c.subject, 'O'), field(c.subject, 'OU')].filter(Boolean).join(' · '),
    subject: c.subject.split('\n').reverse().join(', '),
    issuer: field(c.issuer, 'CN') || c.issuer.split('\n').pop(),
    names: san.slice(0, 20),
    validFrom: new Date(c.validFrom).toISOString(),
    validTo,
    expired: Date.parse(validTo) < now,
    fingerprint256: c.fingerprint256,
    fingerprint: c.fingerprint, // SHA-1: the "thumbprint" Windows shows in the certificate console
    source,
  };
}

/** Sorts certificates into a chain leaf → … → root (as far as they belong together) */
export function orderChain(certs) {
  const left = [...certs];
  // the leaf is the one that did not issue any other certificate
  const leafIdx = left.findIndex((c) => !left.some((o) => o !== c && issuedBy(o, c)));
  const chain = [left.splice(leafIdx >= 0 ? leafIdx : 0, 1)[0]];
  for (;;) {
    const top = chain[chain.length - 1];
    if (selfSigned(top)) break;
    const i = left.findIndex((c) => issuedBy(top, c));
    if (i < 0) break;
    chain.push(left.splice(i, 1)[0]);
  }
  return chain;
}

export const complete = (chain) => chain.length > 0 && selfSigned(chain[chain.length - 1]);

/** "ldaps://dc01.firma.local:636" → { host, port, ldaps } */
export function parseLdapUrl(url) {
  const m = /^(ldaps?):\/\/(\[[^\]]+\]|[^\s/:]+)(?::(\d{1,5}))?\/?$/i.exec(String(url || '').trim());
  if (!m) return null;
  const ldaps = m[1].toLowerCase() === 'ldaps';
  return { host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) || (ldaps ? 636 : 389), ldaps };
}

// LDAP ExtendedRequest StartTLS (OID 1.3.6.1.4.1.1466.20037), message id 1
function startTlsRequest() {
  const oid = Buffer.from('1.3.6.1.4.1.1466.20037', 'ascii');
  const name = Buffer.concat([Buffer.from([0x80, oid.length]), oid]);
  const ext = Buffer.concat([Buffer.from([0x77, name.length]), name]);
  const body = Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), ext]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Connects and returns what the server presents: { certs (leaf first), nameOk, names, protocol }.
 * Nothing is trusted here; the admin confirms the fingerprint afterwards.
 */
export function fetchChain({ url, startTls = false, timeoutMs = 8000 }) {
  const u = parseLdapUrl(url);
  if (!u) return Promise.reject(Object.assign(new Error('invalid url'), { code: 'err.adUrl' }));
  if (!u.ldaps && !startTls) return Promise.reject(Object.assign(new Error('no TLS'), { code: 'err.adPlain' }));
  return new Promise((resolve, reject) => {
    let done = false;
    let sock = null;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* closed already */ }
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`timeout (${Math.round(timeoutMs / 1000)} s)`)), timeoutMs);
    const opts = { host: u.host, servername: net.isIP(u.host) ? undefined : u.host, rejectUnauthorized: false, minVersion: 'TLSv1.2' };
    const onSecure = (s) => {
      const peer = s.getPeerCertificate(true);
      const raw = [];
      const seen = new Set();
      for (let c = peer; c && c.raw && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
        seen.add(c.fingerprint256);
        raw.push(new X509Certificate(c.raw));
        if (!c.issuerCertificate || c.issuerCertificate === c) break;
      }
      if (!raw.length) return finish(new Error('the server sent no certificate'));
      const nameErr = tls.checkServerIdentity(u.host, peer);
      finish(null, { certs: orderChain(raw), nameOk: !nameErr, host: u.host, protocol: s.getProtocol() });
    };
    if (u.ldaps) {
      sock = tls.connect({ ...opts, port: u.port }, () => onSecure(sock));
      sock.on('error', finish);
      return;
    }
    const plain = net.connect({ host: u.host, port: u.port }, () => plain.write(startTlsRequest()));
    sock = plain;
    plain.on('error', finish);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf(0x78); // [APPLICATION 24] ExtendedResponse
      const r = i >= 0 ? buf.indexOf(Buffer.from([0x0a, 0x01]), i) : -1;
      if (r < 0 || buf.length < r + 3) { if (buf.length > 4096) finish(new Error('no StartTLS answer')); return; }
      plain.off('data', onData);
      if (buf[r + 2] !== 0) return finish(new Error('the server does not support StartTLS'));
      sock = tls.connect({ ...opts, socket: plain }, () => onSecure(sock));
      sock.on('error', finish);
    };
    plain.on('data', onData);
  });
}

/** Reads a downloaded certificate: DER or PEM (one or more) */
function certsFromBody(buf) {
  const text = buf.subarray(0, 64).toString('latin1');
  if (text.includes('-----BEGIN')) return parsePem(buf.toString('latin1'));
  return [new X509Certificate(buf)];
}

/** "CA Issuers" addresses (http/https) of a certificate */
export function aiaUrls(c) {
  return [...String(c.infoAccess || '').matchAll(/CA Issuers - URI:(\S+)/g)].map((m) => m[1]).filter((x) => /^https?:\/\//i.test(x)).slice(0, 4);
}

async function download(url, { timeoutMs = 6000, maxBytes = 256 * 1024, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/pkix-cert, application/x-x509-ca-cert, */*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new Error('too large');
  const chunks = [];
  let size = 0;
  for await (const ch of res.body) {
    size += ch.length;
    if (size > maxBytes) throw new Error('too large');
    chunks.push(Buffer.from(ch));
  }
  return Buffer.concat(chunks);
}

/**
 * Adds missing issuers from the AIA address of the certificate on top, up to the root (max. 4 steps).
 * Returns { chain, added: [cert], tried: [{ url, error }] }.
 */
export async function completeViaAia(chain, opts = {}) {
  const out = [...chain];
  const added = [];
  const tried = [];
  for (let step = 0; step < 4 && !complete(out); step++) {
    const top = out[out.length - 1];
    let found = null;
    for (const url of aiaUrls(top)) {
      try {
        found = certsFromBody(await download(url, opts)).find((c) => issuedBy(top, c)) || null;
        tried.push({ url, error: found ? null : 'not the issuer' });
      } catch (e) {
        tried.push({ url, error: e.message.slice(0, 120) });
      }
      if (found) break;
    }
    if (!found || out.some((c) => c.fingerprint256 === found.fingerprint256)) break;
    out.push(found);
    added.push(found);
  }
  return { chain: out, added, tried };
}

/** Certificate authorities registered in AD (AD CS): Configuration partition → Public Key Services */
export async function domainCAs(client) {
  const { searchEntries } = await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['configurationNamingContext'] });
  const cfgNc = [].concat(searchEntries[0]?.configurationNamingContext || [])[0];
  if (!cfgNc) return [];
  const { searchEntries: list } = await client.search(`CN=Public Key Services,CN=Services,${cfgNc}`, {
    scope: 'sub', filter: '(|(objectClass=certificationAuthority)(cn=NTAuthCertificates))',
    attributes: ['cACertificate'], explicitBufferAttributes: ['cACertificate'], sizeLimit: 200,
  });
  const out = [];
  for (const e of list) {
    for (const v of [].concat(e.cACertificate || [])) {
      if (!v || !v.length) continue;
      try { out.push(new X509Certificate(v)); } catch { /* not a certificate */ }
    }
  }
  return out;
}

/** Adds the issuers from a list of CAs (e.g. from AD) until the chain is complete */
export function completeFrom(chain, cas) {
  const out = [...chain];
  const added = [];
  for (let step = 0; step < 5 && !complete(out); step++) {
    const top = out[out.length - 1];
    const c = cas.find((x) => issuedBy(top, x) && !out.some((o) => o.fingerprint256 === x.fingerprint256));
    if (!c) break;
    out.push(c);
    added.push(c);
  }
  return { chain: out, added };
}
