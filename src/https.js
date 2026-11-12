// HTTPS rules.
//
// Direct access (the normal case): WhatsOnMyNet speaks HTTPS itself on WOMN_HTTPS_PORT (8743). The HTTP port
// (WOMN_HTTP_PORT, 8780) only redirects to HTTPS – the target comes from WOMN_BASE_URL, or else from the host name
// the browser used (checked, port replaced by the HTTPS port).
//
// HSTS on direct access only with an uploaded (trusted) certificate: with HSTS a browser no longer lets anyone
// click past the warning for a self-signed certificate – that would lock users out.
//
// Behind a reverse proxy (WOMN_TRUST_PROXY = its address): the proxy may also talk plain HTTP to the HTTP port; such
// requests are served instead of redirected. The rules are the same as in Catalytix, AssetLotse and Helfi.Space:
// once the https:// address of WOMN_BASE_URL was reached through the proxy, requests the proxy forwards over plain
// HTTP are redirected to it (remembered in https-hosts.txt); HSTS only where WhatsOnMyNet had to redirect itself
// (a proxy that redirects on its own usually sends HSTS too – never twice). WOMN_HSTS=off never, preload always.
import fs from 'node:fs';
import path from 'node:path';
import { isIPv4 } from './lib/net.js';
import { log } from './lib/log.js';

export const HSTS = 'max-age=31536000';
const HSTS_PRELOAD = `${HSTS}; includeSubDomains; preload`;
const MAX_HOSTS = 50;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SIMPLE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** What WhatsOnMyNet has seen through the reverse proxy, per host (same file format as the other programs). */
export function createHttpsHosts(file) {
  const hosts = new Set();
  const redirected = new Set();
  if (file) try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      const parts = l.trim().split(/\s+/);
      if (parts[0] && HOSTNAME.test(parts[0])) {
        hosts.add(parts[0]);
        if (parts.slice(1).includes('redirected')) redirected.add(parts[0]);
      }
    }
  } catch { /* not there yet */ }

  const save = (message, host) => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, [...hosts].sort().map((h) => h + (redirected.has(h) ? ' redirected' : '')).join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
      log.info(message.replace('%s', host));
    } catch (e) { log.warn(`Could not remember the HTTPS host: ${e.message}`); }
  };

  return {
    known: (host) => hosts.has(host),
    wasRedirected: (host) => redirected.has(host),
    learn(host) {
      if (hosts.has(host) || !HOSTNAME.test(host) || hosts.size >= MAX_HOSTS) return;
      hosts.add(host);
      save('HTTPS through the reverse proxy detected for %s – HTTP is now redirected to HTTPS', host);
    },
    markRedirected(host) {
      if (redirected.has(host) || !hosts.has(host)) return;
      redirected.add(host);
      save('The reverse proxy does not redirect %s to HTTPS itself – HSTS is now sent', host);
    },
  };
}

/** Is the request from a trusted reverse proxy? */
export function fromTrustedProxy(app, req) {
  const trust = app.get('trust proxy fn');
  return typeof trust === 'function' && !!req.socket?.remoteAddress && trust(req.socket.remoteAddress, 0);
}

/** Protocol the visitor used according to a trusted proxy: 'http' | 'https', or null. */
export function proxyProtocol(app, req) {
  if (!fromTrustedProxy(app, req)) return null;
  const proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'http' || proto === 'https' ? proto : null;
  const p = String(req.get('x-forwarded-port') || '').split(',')[0].trim();
  return p === '80' ? 'http' : p === '443' ? 'https' : null;
}

/**
 * Where a plain HTTP request is sent: WOMN_BASE_URL, or the host name of the request with the HTTPS port.
 * Only real host names and IPv4 addresses are used from the Host header (no open redirect to odd values).
 */
export function redirectTarget(req, { baseUrl, httpsPort }) {
  const pathAndQuery = `/${String(req.originalUrl || req.url || '/').replace(/^\/+/, '')}`;
  if (baseUrl) {
    const u = new URL(baseUrl);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${pathAndQuery}`;
  }
  const raw = String(req.headers.host || '').trim().toLowerCase();
  let host = raw.startsWith('[') ? '' : raw.replace(/:\d+$/, '');
  if (!(isIPv4(host) || HOSTNAME.test(host) || SIMPLE_HOST.test(host))) host = 'localhost';
  return `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}${pathAndQuery}`;
}

/**
 * Middleware for the plain HTTP port: health check stays reachable, a trusted proxy is served (with the proxy
 * rules below), everyone else is redirected to HTTPS.
 */
export function httpPortMiddleware(app, { baseUrl, httpsPort }) {
  return (req, res, next) => {
    if (req.path === '/healthz') return next();
    if (fromTrustedProxy(app, req)) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, redirectTarget(req, { baseUrl, httpsPort }));
  };
}

/** Proxy rules (redirect + HSTS) for requests that came through the trusted reverse proxy. */
export function proxyHttpsMiddleware(app, { baseUrl, hsts = 'on', hosts = null }) {
  if (!String(baseUrl).startsWith('https://')) return null;
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  if (!HOSTNAME.test(host)) return null;
  const basePath = url.pathname.replace(/\/+$/, '');
  const store = hosts || createHttpsHosts(null);

  return (req, res, next) => {
    if (req.path === '/healthz') return next();
    const proto = proxyProtocol(app, req);
    if (!proto) return next();
    if (proto === 'https') {
      store.learn(host);
      const send = hsts === 'preload' || (hsts !== 'off' && store.wasRedirected(host));
      if (send && !res.getHeader('Strict-Transport-Security')) res.setHeader('Strict-Transport-Security', hsts === 'preload' ? HSTS_PRELOAD : HSTS);
      return next();
    }
    if (!store.known(host)) return next();
    store.markRedirected(host);
    const pathAndQuery = `/${String(req.originalUrl || '/').replace(/^\/+/, '')}`;
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, `${url.origin}${basePath}${pathAndQuery}`);
  };
}

/** HSTS for direct HTTPS access – only with a trusted (uploaded) certificate and a host name. */
export function directHstsMiddleware({ hsts, certSource }) {
  return (req, res, next) => {
    if (hsts !== 'off' && req.socket?.encrypted && certSource() === 'custom') {
      const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      if (HOSTNAME.test(host)) res.setHeader('Strict-Transport-Security', hsts === 'preload' ? HSTS_PRELOAD : HSTS);
    }
    next();
  };
}
