// Prometheus: /metrics only with a key (made by admins, shown once, stored as hash), the text format with escaped
// labels, the values of monitors and sensors - and the Grafana dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { renderMetrics, grafanaDashboard } from '../src/metrics.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());
const scrape = async (key) => {
  const res = await fetch(`${app.url}/metrics`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
};

test('setup', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'michael', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'viewer' });
  assert.equal((await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'viewer' })).status, 200);
});

test('no key made: /metrics does not exist; keys only by admins, shown once, stored as hash', async () => {
  assert.equal((await scrape()).status, 404);
  assert.equal((await call('POST', '/api/apitokens', { name: 'x' }, { who: 'viewer' })).status, 403);
  const r = await call('POST', '/api/apitokens', { name: 'Prometheus "RZ"' });
  assert.equal(r.status, 201);
  assert.match(r.data.token, /^womn_[A-Za-z0-9_-]{43}$/);
  const stored = JSON.stringify(db.prepare("SELECT value FROM settings WHERE key='api.tokens'").get());
  assert.equal(stored.includes(r.data.token), false, 'only the hash is kept');
  const list = (await call('GET', '/api/apitokens')).data.list;
  assert.deepEqual(list.map((x) => [x.name, x.prefix, x.last_used]), [['Prometheus "RZ"', r.data.token.slice(0, 9), null]]);
  assert.equal(JSON.stringify(list).includes('hash'), false);
  globalThis.key = r.data.token; globalThis.keyId = r.data.id;
});

test('without or with a wrong key: 401; with the key: the metrics', async () => {
  assert.equal((await scrape()).status, 401);
  assert.equal((await scrape('womn_falschfalschfalschfalschfalschfalschfal')).status, 401);
  assert.equal((await scrape('Bearer junk')).status, 401);
  // a monitor that is down, one that is up, a sensor value, a certificate
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO monitors(name, type, target, port, interval_s, timeout_s, fail_threshold, status, status_since, enabled, last_ms, data, options, cert_valid_to, created_at, updated_at)
    VALUES(?,?,?,?,60,10,3,?,?,1,?,?,?,?,?,?)`);
  ins.run('Intranet "neu"\nTest', 'http', 'https://intranet.firma.local/', null, 'up', now, 123, '{}', '{}', new Date(Date.now() + 10 * 86400000).toISOString(), now, now);
  ins.run('SSH nas01', 'tcp', 'nas01', 22, 'down', new Date(Date.now() - 600000).toISOString(), null, '{}', '{}', null, now, now);
  ins.run('CPU pve01', 'proxmox', 'CPU pve01', null, 'up', now, 18, JSON.stringify({ v: 18.5, unit: '%', op: 'ge', threshold: 90 }), JSON.stringify({ metric: 'nodeCpu' }), null, now, now);
  const s = await scrape(globalThis.key);
  assert.equal(s.status, 200);
  assert.match(s.type, /^text\/plain; version=0\.0\.4/);
  assert.match(s.text, /^# HELP womn_info /m);
  assert.match(s.text, /^womn_info\{version="[^"]+",role="alone"\} 1$/m);
  assert.match(s.text, /^womn_monitor_up\{id="\d+",name="Intranet \\"neu\\"\\nTest",type="http",target="https:\/\/intranet\.firma\.local\/"\} 1$/m, 'quotes and line breaks escaped');
  assert.match(s.text, /^womn_monitor_up\{id="\d+",name="SSH nas01",type="tcp",target="nas01:22"\} 0$/m);
  assert.match(s.text, /^womn_monitor_down_seconds\{[^}]*name="SSH nas01"[^}]*\} (59\d|60\d)(\.\d+)?$/m);
  assert.match(s.text, /^womn_monitor_response_seconds\{[^}]*type="http"[^}]*\} 0\.123$/m);
  assert.match(s.text, /^womn_sensor_value\{[^}]*name="CPU pve01"[^}]*metric="nodeCpu",unit="%",limit="90"\} 18\.5$/m);
  const exp = Number(/^womn_cert_expiry_timestamp_seconds\{[^}]*\} (\d+(\.\d+)?)$/m.exec(s.text)[1]);
  assert.ok(Math.abs(exp - (Date.now() / 1000 + 10 * 86400)) < 120, 'expiry as Unix time');
  assert.match(s.text, /^womn_devices\{\} 0$/m);
  // every sample line has the valid form
  for (const l of s.text.trim().split('\n').filter((x) => !x.startsWith('#'))) assert.match(l, /^[a-z_]+\{.*\} -?\d+(\.\d+)?$/, l);
  assert.ok((await call('GET', '/api/apitokens')).data.list[0].last_used, 'last scrape shown');
});

test('a deleted key no longer works', async () => {
  assert.equal((await call('DELETE', `/api/apitokens/${globalThis.keyId}`)).status, 200);
  assert.equal((await scrape(globalThis.key)).status, 404);
});

test('paused monitors only as state, never as up/down', () => {
  db.prepare("UPDATE monitors SET enabled=0 WHERE name='SSH nas01'").run();
  const text = renderMetrics(db, { version: 'x' });
  assert.doesNotMatch(text, /womn_monitor_up\{[^}]*SSH nas01/);
  assert.match(text, /womn_monitor_state\{[^}]*name="SSH nas01"[^}]*state="paused"\} 1/);
});

test('Grafana dashboard: importable, asks for the Prometheus data source, in the language asked for', async () => {
  const r = await call('GET', '/api/grafana-dashboard.json');
  assert.equal(r.status, 200);
  assert.equal(r.data.__inputs[0].pluginId, 'prometheus');
  assert.ok(r.data.panels.length >= 8);
  assert.ok(r.data.panels.every((p) => p.targets.every((t) => t.datasource.uid === '${DS_PROMETHEUS}' && /womn_/.test(t.expr))));
  assert.equal(grafanaDashboard('en').panels[0].title, 'Down');
  assert.equal(grafanaDashboard('de').panels[0].title, 'Gestört');
  assert.equal((await call('GET', '/api/grafana-dashboard.json', undefined, { who: 'viewer' })).status, 403);
});
