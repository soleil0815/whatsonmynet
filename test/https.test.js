import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import './helpers.js';
import { redirectTarget, httpPortMiddleware, proxyHttpsMiddleware, createHttpsHosts, directHstsMiddleware } from '../src/https.js';

const req = (host, url = '/x?y=1') => ({ headers: { host }, originalUrl: url, url });

test('redirect target from the host name, port replaced', () => {
  assert.equal(redirectTarget(req('192.168.1.5:8780'), { baseUrl: '', httpsPort: 8743 }), 'https://192.168.1.5:8743/x?y=1');
  assert.equal(redirectTarget(req('womn.firma.local'), { baseUrl: '', httpsPort: 443 }), 'https://womn.firma.local/x?y=1');
  assert.equal(redirectTarget(req('nas'), { baseUrl: '', httpsPort: 8743 }), 'https://nas:8743/x?y=1');
  // odd host headers never become a redirect target
  assert.equal(redirectTarget(req('evil.com/@x'), { baseUrl: '', httpsPort: 8743 }), 'https://localhost:8743/x?y=1');
  assert.equal(redirectTarget(req('a b'), { baseUrl: '', httpsPort: 8743 }), 'https://localhost:8743/x?y=1');
  // "//host" paths stay paths
  assert.equal(redirectTarget(req('nas', '//evil.com/'), { baseUrl: '', httpsPort: 8743 }), 'https://nas:8743/evil.com/');
  assert.equal(redirectTarget(req('anything'), { baseUrl: 'https://womn.firma.local:8743', httpsPort: 8743 }), 'https://womn.firma.local:8743/x?y=1');
});

async function serve(app) {
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() };
}

test('HTTP port redirects everyone except a trusted proxy and the health check', async () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(httpPortMiddleware(app, { baseUrl: '', httpsPort: 8743 }));
  app.get('*splat', (_q, r) => r.send('app'));
  const s = await serve(app);
  const r1 = await fetch(`${s.url}/inventory`, { redirect: 'manual' });
  assert.equal(r1.status, 301);
  assert.equal(r1.headers.get('location'), `https://127.0.0.1:8743/inventory`);
  const r2 = await fetch(`${s.url}/api/x`, { method: 'POST', redirect: 'manual' });
  assert.equal(r2.status, 308);
  assert.equal((await fetch(`${s.url}/healthz`)).status, 200);
  s.close();

  const app2 = express();
  app2.set('trust proxy', 'loopback');
  app2.use(httpPortMiddleware(app2, { baseUrl: '', httpsPort: 8743 }));
  app2.get('*splat', (_q, r) => r.send('app'));
  const s2 = await serve(app2);
  assert.equal(await (await fetch(`${s2.url}/inventory`, { redirect: 'manual' })).text(), 'app');
  s2.close();
});

test('proxy rules: learn HTTPS, then redirect HTTP and send HSTS', async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  const hosts = createHttpsHosts(null);
  app.use(proxyHttpsMiddleware(app, { baseUrl: 'https://womn.firma.local', hsts: 'on', hosts }));
  app.get('*splat', (_q, r) => r.send('ok'));
  const s = await serve(app);
  // plain HTTP before HTTPS was seen: no redirect into nothing
  assert.equal((await fetch(`${s.url}/a`, { headers: { 'X-Forwarded-Proto': 'http' }, redirect: 'manual' })).status, 200);
  const h1 = await fetch(`${s.url}/a`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(h1.headers.get('strict-transport-security'), null);
  const r = await fetch(`${s.url}/a?b=1`, { headers: { 'X-Forwarded-Proto': 'http' }, redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://womn.firma.local/a?b=1');
  const h2 = await fetch(`${s.url}/a`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(h2.headers.get('strict-transport-security'), 'max-age=31536000');
  s.close();
});

test('direct HSTS only with an own certificate and a host name', () => {
  const run = (source, host, encrypted = true) => {
    const headers = {};
    directHstsMiddleware({ hsts: 'on', certSource: () => source })({ socket: { encrypted }, headers: { host } }, { setHeader: (k, v) => { headers[k] = v; } }, () => {});
    return headers['Strict-Transport-Security'];
  };
  assert.equal(run('self-signed', 'womn.firma.local'), undefined);
  assert.equal(run('custom', '192.168.1.5:8743'), undefined);
  assert.equal(run('custom', 'womn.firma.local:8743'), 'max-age=31536000');
  assert.equal(run('custom', 'womn.firma.local', false), undefined);
});
