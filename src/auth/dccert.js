// Certificate of the domain controller: fetch it, complete the chain up to the root CA, describe it.
//
// 1. fetchChain: asks the DC (LDAPS or LDAP + StartTLS) which certificates it presents – without trusting them yet.
//    Nothing is sent, no password.
// 2. completeViaAia: a missing issuer is downloaded from the "CA Issuers" address (AIA) in the certificate.
// 3. completeViaAd: after the admin has confirmed the fingerprint, the root CA can also come from AD itself
//    (Configuration partition, Public Key Services) – this connection already trusts the confirmed certificate.
// Every added CA must really have signed the certificate below it (signature check), otherwise it is ignored.
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
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

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*\.?$/;

/** Does the server certificate carry this name (DNS name or IP address)? */
export function nameFits(cert, host) {
  try { return net.isIP(host) ? !!cert.checkIP(host) : !!cert.checkHost(host); } catch { return false; }
}

/** Error text of openssl s_client, shortened to what the admin can act on */
function opensslError(out) {
  if (/STARTTLS/i.test(out)) return 'the server does not support StartTLS';
  if (/errno=111|Connection refused/i.test(out)) return 'connection refused';
  if (/errno=110|timed out/i.test(out)) return 'timeout';
  if (/getaddrinfo|Name or service not known|nodename nor servname/i.test(out)) return 'name not found';
  if (/no peer certificate|handshake failure|wrong version number|unexpected eof/i.test(out)) return 'no TLS handshake (wrong port or protocol?)';
  return (out.trim().split('\n').filter(Boolean).pop() || 'no answer').slice(0, 160);
}

/**
 * Asks the DC for its certificates – "openssl s_client -showcerts", the usual tool to look at a server's certificate
 * (LDAPS directly or with "-starttls ldap"). Nothing is sent and nothing is trusted here: the admin compares the
 * fingerprint and confirms; all real connections afterwards verify against the confirmed certificate.
 * Returns { certs (leaf first), nameOk, host }.
 */
/**
 * Asks a TLS server for its certificates – "openssl s_client -showcerts", the usual tool to look at a server's
 * certificate (optionally after "-starttls ldap"). Nothing is sent and nothing is trusted here: the admin compares the
 * fingerprint and confirms; all real connections afterwards verify against the confirmed certificate.
 * Returns { certs (leaf first), nameOk, host }.
 */
export function fetchTlsChain({ host, port, starttls = null, timeoutMs = 8000, openssl = process.env.WOMN_OPENSSL || 'openssl' }) {
  if (!(net.isIP(host) || HOSTNAME.test(String(host || ''))) || !(Number(port) > 0 && Number(port) < 65536)) {
    return Promise.reject(Object.assign(new Error('invalid address'), { code: 'err.adUrl' }));
  }
  const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  const args = ['s_client', '-connect', target, '-showcerts', '-verify_quiet'];
  if (!net.isIP(host)) args.push('-servername', host);
  if (starttls === 'ldap') args.push('-starttls', 'ldap');
  return new Promise((resolve, reject) => {
    const child = execFile(openssl, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH } }, (err, stdout, stderr) => {
      let certs = [];
      try { certs = parsePem(stdout); } catch { certs = []; }
      if (!certs.length) {
        if (err && err.killed) return reject(new Error(`timeout (${Math.round(timeoutMs / 1000)} s)`));
        return reject(new Error(opensslError(`${stderr}\n${stdout}`)));
      }
      resolve({ certs: orderChain(certs), nameOk: nameFits(certs[0], host), host });
    });
    child.stdin.end(); // send nothing: openssl closes the connection right after the handshake
  });
}

/** Certificate chain of a domain controller (LDAPS, or LDAP + StartTLS) */
export function fetchChain({ url, startTls = false, ...opts }) {
  const u = parseLdapUrl(url);
  if (!u) return Promise.reject(Object.assign(new Error('invalid url'), { code: 'err.adUrl' }));
  if (!u.ldaps && !startTls) return Promise.reject(Object.assign(new Error('no TLS'), { code: 'err.adPlain' }));
  return fetchTlsChain({ host: u.host, port: u.port, starttls: u.ldaps ? null : 'ldap', ...opts });
}

let systemRoots = null;
/** Is the chain trusted by the usual public CAs anyway (e.g. Let's Encrypt via ACME)? */
export function publiclyTrusted(chain) {
  if (!systemRoots) {
    systemRoots = [];
    for (const pem of tls.rootCertificates) { try { systemRoots.push(new X509Certificate(pem)); } catch { /* skip */ } }
  }
  // the chain has to end in one of the system's root CAs – a self-signed certificate of its own does not count
  const full = completeFrom(chain, systemRoots).chain;
  const top = full[full.length - 1];
  return !!top && complete(full) && systemRoots.some((r) => r.fingerprint256 === top.fingerprint256);
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
