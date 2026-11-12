// Certificate for the built-in HTTPS server.
//
// * First start: a self-signed certificate is generated (OpenSSL), so the connection is encrypted right away.
//   Names: host name, localhost, the address in WOMN_BASE_URL and all IPv4 addresses of the host.
//   It is renewed automatically 30 days before it expires (and when WOMN_BASE_URL names a new host).
// * The admin can upload an own certificate (PEM with chain + key, or a PKCS#12/.pfx file) in the web interface.
//   It is checked before it is used (key matches, not expired, usable by Node) and applied without restart.
// * Files in <data>/tls: cert.pem, key.pem (0600), meta.json (source: self-signed | custom).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths, config } from './config.js';
import { localInterfaces, isIPv4 } from './lib/net.js';
import { HttpError } from './lib/http.js';
import { log } from './lib/log.js';

const run = promisify(execFile);
const RENEW_DAYS = 30;
const SELF_SIGNED_DAYS = 825;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function createTls(dir = paths.tlsDir) {
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  const metaFile = path.join(dir, 'meta.json');

  const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return {}; } };

  function writeFiles(certPem, keyPem, meta) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Write next to the files and rename: never a half-written certificate
    for (const [file, data, mode] of [[keyFile, keyPem, 0o600], [certFile, certPem, 0o644], [metaFile, JSON.stringify(meta, null, 2), 0o644]]) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, data, { mode });
      fs.renameSync(tmp, file);
    }
  }

  /** Names for the self-signed certificate */
  function wantedNames() {
    const dns = new Set(['localhost']);
    const host = os.hostname();
    if (DNS_NAME.test(host)) dns.add(host.toLowerCase());
    const ips = new Set(['127.0.0.1']);
    if (config.baseUrl) {
      const h = new URL(config.baseUrl).hostname.toLowerCase();
      if (isIPv4(h)) ips.add(h); else if (DNS_NAME.test(h)) dns.add(h);
    }
    for (const i of localInterfaces()) if (!i.virtual) ips.add(i.address);
    return { dns: [...dns], ips: [...ips] };
  }

  async function generateSelfSigned() {
    const { dns, ips } = wantedNames();
    const san = [...dns.map((d) => `DNS:${d}`), ...ips.map((i) => `IP:${i}`)].join(',');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'womn-tls-'));
    try {
      const k = path.join(tmp, 'key.pem');
      const c = path.join(tmp, 'cert.pem');
      await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', k, '-out', c, '-days', String(SELF_SIGNED_DAYS),
        '-subj', `/CN=${(dns[1] || 'WhatsOnMyNet').slice(0, 60)}/O=WhatsOnMyNet (self-signed)`,
        '-addext', `subjectAltName=${san}`,
        '-addext', 'basicConstraints=critical,CA:FALSE',
        '-addext', 'keyUsage=critical,digitalSignature',
        '-addext', 'extendedKeyUsage=serverAuth'], { timeout: 30_000 });
      writeFiles(fs.readFileSync(c, 'utf8'), fs.readFileSync(k, 'utf8'), { source: 'self-signed', names: { dns, ips }, installedAt: new Date().toISOString() });
      log.info(`Self-signed certificate created for ${[...dns, ...ips].join(', ')}`);
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('OpenSSL is missing – it is needed to create the certificate.');
      throw new Error(`Could not create the certificate: ${e.stderr || e.message}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  function current() {
    try {
      return { cert: fs.readFileSync(certFile, 'utf8'), key: fs.readFileSync(keyFile, 'utf8'), meta: readMeta() };
    } catch { return null; }
  }

  /** Creates or renews the self-signed certificate when needed. Returns true if it changed. */
  async function ensure() {
    const cur = current();
    if (cur) {
      try {
        const info = describePem(cur.cert);
        tls.createSecureContext({ cert: cur.cert, key: cur.key });
        const daysLeft = (Date.parse(info.validTo) - Date.now()) / 86400000;
        if (cur.meta.source === 'custom') {
          if (daysLeft < 0) log.warn('The uploaded certificate has expired – upload a new one under Settings → HTTPS.');
          return false;
        }
        // Self-signed: renew before it expires or when the base address names a host that is missing
        const want = wantedNames();
        const have = new Set([...(cur.meta.names?.dns || []), ...(cur.meta.names?.ips || [])]);
        const missing = [...want.dns, ...want.ips].filter((n) => !have.has(n));
        if (daysLeft > RENEW_DAYS && !missing.length) return false;
        log.info(daysLeft <= RENEW_DAYS ? 'Self-signed certificate expires soon – renewing' : `Self-signed certificate is missing ${missing.join(', ')} – renewing`);
      } catch (e) {
        if (cur.meta.source === 'custom') { log.error(`Uploaded certificate cannot be used (${e.message}) – falling back to a self-signed one`); }
      }
    }
    await generateSelfSigned();
    return true;
  }

  /**
   * Checks an uploaded certificate and installs it. Either PEM (certificate incl. chain + private key, key may be
   * encrypted with `passphrase`) or a PKCS#12 file (`pfx` as Buffer + `passphrase`).
   */
  async function installCustom({ certPem, keyPem, pfx, passphrase = '' }) {
    let cert = String(certPem || '');
    let key = String(keyPem || '');
    if (pfx && pfx.length) ({ cert, key } = await pfxToPem(pfx, passphrase));
    const certs = splitPem(cert);
    if (!certs.length) throw new HttpError(400, 'err.tlsNoCert');
    let privateKey;
    try {
      privateKey = crypto.createPrivateKey({ key, format: 'pem', passphrase: passphrase || undefined });
    } catch {
      throw new HttpError(400, 'err.tlsBadKey');
    }
    let parsed;
    try { parsed = certs.map((c) => new crypto.X509Certificate(c)); } catch { throw new HttpError(400, 'err.tlsNoCert'); }
    // The certificate that belongs to the key goes first, the chain after it (PKCS#12 files do not fix the order)
    const at = parsed.findIndex((c) => c.checkPrivateKey(privateKey));
    if (at < 0) throw new HttpError(400, 'err.tlsKeyMismatch');
    const leaf = parsed[at];
    if (Date.parse(leaf.validTo) < Date.now()) throw new HttpError(400, 'err.tlsExpired');
    const plainKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const chain = [certs[at], ...certs.filter((_, i) => i !== at)].join('\n');
    try { tls.createSecureContext({ cert: chain, key: plainKey }); } catch (e) { throw new HttpError(400, 'err.tlsUnusable', e.message); }
    writeFiles(chain, plainKey, { source: 'custom', installedAt: new Date().toISOString() });
    log.info(`Own certificate installed: ${leaf.subject.replace(/\n/g, ', ')}`);
    return describe();
  }

  async function resetToSelfSigned() {
    await generateSelfSigned();
    return describe();
  }

  function describe() {
    const cur = current();
    if (!cur) return null;
    try {
      return { ...describePem(cur.cert), source: cur.meta.source || 'self-signed', installedAt: cur.meta.installedAt || null,
        chain: splitPem(cur.cert).length };
    } catch { return { source: cur.meta.source, error: true }; }
  }

  return { ensure, current, installCustom, resetToSelfSigned, describe };
}

export function splitPem(text) {
  return String(text || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

export function describePem(pem) {
  const c = new crypto.X509Certificate(splitPem(pem)[0] || pem);
  const names = String(c.subjectAltName || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/^DNS:/, '').replace(/^IP Address:/, ''));
  const cn = /CN=([^\n,]+)/.exec(c.subject)?.[1] || '';
  return {
    subject: cn || c.subject.replace(/\n/g, ', '),
    issuer: /CN=([^\n,]+)/.exec(c.issuer)?.[1] || c.issuer.replace(/\n/g, ', '),
    names,
    validFrom: new Date(c.validFrom).toISOString(),
    validTo: new Date(c.validTo).toISOString(),
    fingerprint: c.fingerprint256,
    selfSigned: c.subject === c.issuer,
  };
}

/** PKCS#12 → PEM with OpenSSL (also older files with legacy encryption). The password goes via the environment. */
async function pfxToPem(pfx, passphrase) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'womn-pfx-'));
  const file = path.join(tmp, 'upload.pfx');
  fs.writeFileSync(file, pfx, { mode: 0o600 });
  const env = { ...process.env, WOMN_PFX_PASS: String(passphrase || '') };
  const opts = { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 };
  const conv = async (what, legacy) => {
    const args = ['pkcs12', '-in', file, '-passin', 'env:WOMN_PFX_PASS', ...(what === 'cert' ? ['-nokeys'] : ['-nocerts', '-nodes'])];
    if (legacy) args.push('-legacy');
    return (await run('openssl', args, opts)).stdout;
  };
  try {
    let cert; let key;
    try { cert = await conv('cert'); key = await conv('key'); } catch {
      cert = await conv('cert', true); key = await conv('key', true);
    }
    // Leaf first: OpenSSL lists the certificate with the key ("localKeyID") – the order is kept as delivered
    return { cert: splitPem(cert).join('\n'), key: (key.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/) || [''])[0] };
  } catch {
    throw new HttpError(400, 'err.tlsBadPfx');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
