// Audit 2026-11: scanner, TLS and security header findings - each test reproduces one confirmed finding.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import snmp from 'net-snmp';
import { memoryDb, tmp, startApp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createInventory } from '../src/inventory.js';
import { tlsRequest, createProxmox } from '../src/proxmox.js';
import { classify } from '../src/scan/classify.js';
import { shortVendor } from '../src/scan/oui.js';
import { createScanner, validateTargets } from '../src/scan/engine.js';
import { cleanEvents } from '../src/hostfacts.js';
import * as nightlyMod from '../src/scan/nightly.js';
import { createTls } from '../src/tls.js';
import * as httpsMod from '../src/https.js';

const { isDue, createNightly } = nightlyMod;
const { directHstsMiddleware } = httpsMod;
const dueDay = (...a) => nightlyMod.dueDay(...a);
const hstsAllowed = (...a) => httpsMod.hstsAllowed(...a);

const fpOf = (pem) => new crypto.X509Certificate(pem).fingerprint256;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(tmp, 'audit-scan-'));

function makeCert(name, days = 30) {
  const key = path.join(work, `${name}.key`);
  const crt = path.join(work, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', String(days),
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(crt, 'utf8') };
}

// A certificate signed by a (test) CA - i.e. not self-signed
function makeCaSigned(name) {
  const caKey = path.join(work, 'ca.key'); const caCrt = path.join(work, 'ca.crt');
  if (!fs.existsSync(caCrt)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', caKey, '-out', caCrt, '-days', '30',
      '-subj', '/CN=Test CA firma.local', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  }
  const key = path.join(work, `${name}.key`); const csr = path.join(work, `${name}.csr`); const crt = path.join(work, `${name}.crt`);
  const ext = path.join(work, `${name}.ext`);
  fs.writeFileSync(ext, `subjectAltName=DNS:${name}\n`);
  execFileSync('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${name}`], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-out', crt, '-days', '20', '-extfile', ext], { stdio: 'ignore' });
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(crt, 'utf8') };
}

// ------------------------------------------------------------------------------------------ 1. tlsRequest deadline
test('tlsRequest: a header that https.request refuses rejects cleanly and the deadline timer does not crash later', async () => {
  const errors = [];
  const onErr = (e) => errors.push(e);
  process.prependListener('uncaughtException', onErr);
  try {
    await assert.rejects(tlsRequest({ url: 'https://192.0.2.10', verify: 1 }, 'GET', '/', { headers: { Authorization: 'PVEAPIToken=a@pve!b=x\ny' }, timeoutMs: 10 }));
    await sleep(120);
  } finally { process.off('uncaughtException', onErr); }
  assert.deepEqual(errors.map((e) => e.message), []);
});

test('Proxmox host: a token secret that cannot go into an HTTP header is refused on saving', () => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  for (const secret of ['abc\ndef', 'geheĀim', 'a b']) {
    assert.throws(() => px.create({ name: 'pve', kind: 'pve', url: 'https://10.0.10.5:8006', token_id: 'monitor@pve!womn', secret }), { code: 'err.proxmoxSecret' });
  }
  assert.ok(px.create({ name: 'pve', kind: 'pve', url: 'https://10.0.10.5:8006', token_id: 'monitor@pve!womn', secret: '0f1e2d3c-aaaa-bbbb-cccc-000000000001' }).id);
});

// ------------------------------------------------------------------------------------------ 2. HP vs HPE
test('classify: an HPE device (iLO, Aruba) is not taken for a printer', () => {
  const ilo = classify({ vendor: 'HPE', ports: [22, 443], snmp: { descr: 'Integrated Lights-Out 5', objectId: '1.3.6.1.4.1.232.9.4.10' } });
  assert.notEqual(ilo.type, 'printer');
  const printer = classify({ vendor: 'HP', ports: [80, 9100], snmp: { descr: 'HP ETHERNET MULTI-ENVIRONMENT' } });
  assert.equal(printer.type, 'printer');
});

// ------------------------------------------------------------------------------------------ 3. short vendor names
test('classify: short OUI vendor names (Samsung, LG, Dahua, Uniview) match their rules', () => {
  assert.equal(shortVendor('Zhejiang Dahua Technology Co., Ltd.'), 'Dahua');
  assert.equal(shortVendor('Zhejiang Uniview Technologies Co.,Ltd.'), 'Uniview');
  assert.equal(classify({ vendor: shortVendor('Zhejiang Dahua Technology Co., Ltd.'), ports: [80] }).type, 'camera');
  assert.equal(classify({ vendor: shortVendor('Zhejiang Uniview Technologies Co.,Ltd.'), ports: [80] }).type, 'camera');
  assert.equal(classify({ vendor: shortVendor('Samsung Electronics Co.,Ltd'), ports: [8001] }).type, 'media');
  assert.equal(classify({ vendor: shortVendor('LG Electronics'), ports: [3000] }).type, 'media');
  // LG/Samsung phones (no open port) are not taken for TVs
  assert.notEqual(classify({ vendor: shortVendor('LG Electronics (Mobile Communications)'), ports: [] }).type, 'media');
  assert.notEqual(classify({ vendor: shortVendor('Samsung Electronics Co.,Ltd'), ports: [] }).type, 'media');
  // Other LG companies are not TVs
  assert.notEqual(classify({ vendor: shortVendor('LG Innotek'), ports: [] }).type, 'media');
  assert.notEqual(classify({ vendor: 'LGS Innovations', ports: [] }).type, 'media');
});

// ------------------------------------------------------------------------------------------ 4. cancel skips router ARP
test('scanner: a cancelled scan does not ask the routers for their ARP table', { timeout: 60_000 }, async () => {
  const db = memoryDb();
  const settings = createSettings(db);
  settings.set('scan.routerArp', true);
  settings.set('scan.snmp', true);
  settings.set('scan.ping', false);
  const ts = new Date().toISOString();
  // Routers whose SNMP never answers (filtered): every one of them costs seconds of SNMP time-outs
  for (let i = 1; i <= 2; i++) db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES(?,'router',?,?,?)").run(`RT-000${i}`, `10.0.10.${i}`, ts, ts);
  let asked = 0;
  const sessions = mock.method(snmp, 'createSession', () => { asked++; return { on() {}, get() {}, close() {} }; });
  try {
    const scanner = createScanner({ db, settings, inventory: createInventory(db) });
    for (const start of [(t) => scanner.startNetwork(t, 'test'), (t) => scanner.startLight(t, 'test')]) {
      const id = start([{ cidr: '203.0.113.0/30' }]);
      scanner.cancel(id);
      const t0 = Date.now();
      while (!scanner.progress(id).finished) await sleep(50);
      assert.ok(Date.now() - t0 < 2500, `cancelled scan took ${Date.now() - t0} ms`);
    }
    assert.equal(asked, 0, 'routers were asked via SNMP after cancel');
  } finally { sessions.mock.restore(); }
});

// ------------------------------------------------------------------------------------------ 5. overlapping targets
test('scan targets: overlapping subnets are scanned and counted once', () => {
  assert.deepEqual(validateTargets([{ cidr: '192.168.0.0/22', locationId: 1 }, { cidr: '192.168.1.0/24', locationId: 2 }]), [{ cidr: '192.168.0.0/22', locationId: 1 }]);
  assert.deepEqual(validateTargets([{ cidr: '10.0.10.0/24' }, { cidr: '10.0.10.0/23' }]), [{ cidr: '10.0.10.0/23', locationId: null }]);
  // The /22 alone fits the limit - the contained /24 must not count twice
  assert.doesNotThrow(() => validateTargets([{ cidr: '192.168.0.0/22' }, { cidr: '192.168.1.0/24' }], 1022));
  // Disjoint subnets stay
  assert.equal(validateTargets([{ cidr: '10.0.10.0/24' }, { cidr: '10.0.11.0/24' }]).length, 2);
});

// ------------------------------------------------------------------------------------------ 6. journal timestamps
test('host report: an out-of-range journal timestamp does not reject the report', () => {
  const r = cleanEvents({ journal: [{ PRIORITY: '3', __REALTIME_TIMESTAMP: '9'.repeat(25), MESSAGE: 'disk error', SYSLOG_IDENTIFIER: 'kernel' }], errors: 1 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].at, null);
  assert.equal(r.items[0].message, 'disk error');
});

// ------------------------------------------------------------------------------------------ 7. nightly window over midnight
test('nightly window: a late schedule still runs after midnight within the 4 hours', () => {
  const at = (d, h, m) => new Date(2026, 10, d, h, m);
  assert.equal(isDue(at(13, 0, 15), '22:30', '2026-11-11'), true);
  assert.equal(dueDay(at(13, 0, 15), '22:30', '2026-11-11'), '2026-11-12');
  assert.equal(isDue(at(13, 0, 15), '22:30', '2026-11-12'), false, 'yesterday\'s run already happened');
  assert.equal(isDue(at(13, 2, 30), '22:30', '2026-11-11'), false, 'window is over');
  assert.equal(isDue(at(13, 22, 31), '22:30', '2026-11-12'), true, 'next evening is due again');
  // Through the nightly job: lastRun is the scheduled day, not the calendar day of the start
  const db = memoryDb();
  const settings = createSettings(db);
  const started = [];
  const scanner = { isRunning: () => false, startLight: (t) => { started.push(t); return 1; }, onFinished: () => {} };
  const nightly = createNightly({ db, settings, scanner, channels: { notifyIds: async () => [] } });
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO locations(name,created_at) VALUES('HQ',?)").run(ts);
  db.prepare("INSERT INTO subnets(location_id,cidr,created_at) VALUES(1,'10.0.10.0/24',?)").run(ts);
  settings.set('lightscan.enabled', true);
  settings.set('lightscan.time', '22:30');
  settings.set('lightscan.lastRun', '2026-11-11');
  nightly.tick(at(13, 0, 15));
  assert.equal(started.length, 1);
  assert.equal(settings.get('lightscan.lastRun'), '2026-11-12');
  nightly.tick(at(13, 22, 31));
  assert.equal(started.length, 2);
});

// ------------------------------------------------------------------------------------------ 8. HSTS with a self-signed upload
test('direct HSTS: not sent for an uploaded certificate that is itself self-signed or expired', () => {
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  const run = (info) => {
    const headers = {};
    directHstsMiddleware({ hsts: 'on', cert: () => info })({ socket: { encrypted: true }, headers: { host: 'womn.firma.local' } }, { setHeader: (k, v) => { headers[k] = v; } }, () => {});
    return headers['Strict-Transport-Security'];
  };
  assert.equal(run({ source: 'custom', selfSigned: true, validTo: future }), undefined);
  assert.equal(run({ source: 'custom', selfSigned: false, validTo: '2020-01-01T00:00:00.000Z' }), undefined);
  assert.equal(run({ source: 'custom', selfSigned: false, error: true }), undefined);
  assert.equal(run({ source: 'self-signed', selfSigned: true, validTo: future }), undefined);
  assert.equal(run({ source: 'custom', selfSigned: false, validTo: future }), 'max-age=31536000');
  assert.equal(hstsAllowed(null), false);
});

test('TLS: describe() is cached and refreshed on install and reset', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'tls-cache-'));
  const t = createTls(dir);
  await t.ensure();
  assert.equal(t.describe().source, 'self-signed');
  const reads = mock.method(fs, 'readFileSync');
  try {
    for (let i = 0; i < 5; i++) t.describe();
    assert.equal(reads.mock.callCount(), 0, 'describe() read files again');
  } finally { reads.mock.restore(); }
  const own = makeCaSigned('womn.firma.local');
  const info = await t.installCustom({ certPem: own.cert, keyPem: own.key });
  assert.equal(info.source, 'custom');
  assert.equal(t.describe().source, 'custom');
  assert.equal(hstsAllowed(t.describe()), true);
  const self = makeCert('self.firma.local');
  await t.installCustom({ certPem: self.cert, keyPem: self.key });
  assert.equal(t.describe().selfSigned, true);
  assert.equal(hstsAllowed(t.describe()), false);
  assert.equal((await t.resetToSelfSigned()).source, 'self-signed');
  assert.equal(t.describe().source, 'self-signed');
});

// ------------------------------------------------------------------------------------------ 9. classification without meta.json
test('TLS: an uploaded certificate survives a missing or stale meta.json', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'tls-meta-'));
  const own = makeCaSigned('meta.firma.local');
  await createTls(dir).installCustom({ certPem: own.cert, keyPem: own.key });
  // missing meta.json (e.g. a restored tls folder)
  fs.rmSync(path.join(dir, 'meta.json'));
  let t = createTls(dir);
  assert.equal(t.describe().source, 'custom');
  assert.equal(await t.ensure(), false);
  assert.equal(fpOf(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8')), fpOf(own.cert));
  // stale meta.json that says self-signed
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ source: 'self-signed', names: { dns: [], ips: [] } }));
  t = createTls(dir);
  assert.equal(t.describe().source, 'custom');
  assert.equal(await t.ensure(), false);
  assert.equal(fpOf(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8')), fpOf(own.cert));
  // An unusable uploaded certificate without meta.json is kept as a backup before it is replaced
  fs.rmSync(path.join(dir, 'meta.json'));
  fs.writeFileSync(path.join(dir, 'key.pem'), makeCert('other.firma.local').key);
  t = createTls(dir);
  assert.equal(await t.ensure(), true);
  assert.ok(fs.readdirSync(dir).some((f) => /^cert\.pem\..+\.bak$/.test(f)), 'no backup of the uploaded certificate');
  assert.equal(t.describe().source, 'self-signed');
});

// ------------------------------------------------------------------------------------------ 10. ensure vs upload race
test('TLS: an upload during a running ensure() is not overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'tls-race-'));
  const t = createTls(dir);
  const own = makeCaSigned('race.firma.local');
  const pending = t.ensure(); // no certificate yet: generates one (OpenSSL, async)
  const installed = t.installCustom({ certPem: own.cert, keyPem: own.key });
  await Promise.all([pending, installed]);
  assert.equal(t.describe().source, 'custom');
  assert.equal(createTls(dir).describe().subject, 'race.firma.local');
});

// ------------------------------------------------------------------------------------------ 11. security headers
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), screen-wake-lock=(), xr-spatial-tracking=(), publickey-credentials-get=(), fullscreen=(self), clipboard-read=(), clipboard-write=(self)';

test('security headers: COEP require-corp and Permissions-Policy on pages and API answers', async () => {
  const s = await startApp();
  try {
    for (const p of ['/', '/api/me', '/healthz', '/api/reports/1/preview']) {
      const r = await fetch(s.url + p, { redirect: 'manual' });
      assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp', p);
      assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin', p);
      assert.equal(r.headers.get('permissions-policy'), PERMISSIONS, p);
    }
  } finally { await s.close(); }
});
