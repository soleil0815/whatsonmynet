// Failover: master and standby, pairing with a code, the standby takes the data, keeps quiet, takes over when the
// master is gone, hands back when it answers again, and "make this the master" (the old one keeps quiet then).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { tmp, startApp } from './helpers.js';
import { createTls } from '../src/tls.js';
import { normalizeAddress, parseCode, spkiPin, pinnedRequest } from '../src/failover.js';

const dirA = fs.mkdtempSync(path.join(tmp, 'fo-a-'));
const dirB = fs.mkdtempSync(path.join(tmp, 'fo-b-'));
const tlsA = createTls(path.join(dirA, 'tls'));
await tlsA.ensure();
const A = await startApp({ tls: tlsA, dataDir: dirA });
const tlsB = createTls(path.join(dirB, 'tls'));
await tlsB.ensure();
const B = await startApp({ tls: tlsB, dataDir: dirB });
// the master also on HTTPS (the standby only talks HTTPS)
let httpsA = null; let port = 0;
const listenA = (cert = null, key = null) => new Promise((resolve) => {
  const c = tlsA.current();
  httpsA = https.createServer({ cert: cert || c.cert, key: key || c.key }, A.app);
  httpsA.listen(port, '127.0.0.1', () => { port = httpsA.address().port; resolve(); });
});
await listenA();
const addr = () => `https://127.0.0.1:${port}`;
test.after(async () => { A.ctx.failover.stop(); B.ctx.failover.stop(); httpsA?.close(); await A.close(); await B.close(); });

const admin = async (X, user) => {
  assert.equal((await X.call('POST', '/api/setup', { username: user, password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
};

test('addresses and codes', () => {
  assert.equal(normalizeAddress('10.0.10.5', 8743), 'https://10.0.10.5:8743');
  assert.equal(normalizeAddress('womn1.firma.local:9000/', 8743), 'https://womn1.firma.local:9000');
  assert.equal(normalizeAddress('https://10.0.10.5:8743', 1), 'https://10.0.10.5:8743');
  for (const bad of ['', 'http://10.0.10.5', 'https://u:p@x', 'https://x/pfad', 'ftp://x']) assert.throws(() => normalizeAddress(bad, 1));
  assert.throws(() => parseCode('WOMN1-kurz-kurz'));
  const ok = `WOMN1-${'a'.repeat(43)}-${'b'.repeat(43)}`;
  assert.deepEqual(parseCode(` ${ok} `), { secret: 'a'.repeat(43), pin: 'b'.repeat(43) });
});

let code;
test('master: a pairing code with the pin of its certificate; without the secret nothing is answered', async () => {
  await admin(A, 'chef');
  // the same admin name on both (as usual): stays signed in on the standby after pairing
  await admin(B, 'chef');
  // something to take over: a monitor and a channel with a stored (encrypted) secret
  assert.equal((await A.call('POST', '/api/monitors', { name: 'Intranet', type: 'http', target: 'https://intranet.firma.local', interval_s: 60 })).status, 201);
  assert.equal((await A.call('POST', '/api/channels', { name: 'Bereitschaft', type: 'telegram', config: { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', chatId: '-100123' }, enabled: false })).status, 201);
  const r = await A.call('POST', '/api/failover/master');
  assert.equal(r.status, 200);
  assert.equal(r.data.role, 'master');
  code = r.data.code;
  assert.equal(parseCode(code).pin, spkiPin(tlsA.current().cert));
  // the secret is not stored, only its hash
  assert.ok(!fs.readFileSync(path.join(dirA, 'failover.json'), 'utf8').includes(parseCode(code).secret));
  assert.equal((await A.call('GET', '/api/failover/hello')).status, 401);
  // not admin-only routes for the outside: settings need a sign-in
  assert.equal((await A.call('GET', '/api/failover', undefined, { who: 'nobody' })).status, 401);
});

test('a wrong pin: the secret never leaves the standby', async () => {
  const { secret } = parseCode(code);
  await assert.rejects(pinnedRequest({ address: addr(), pin: 'x'.repeat(43), secret }, 'GET', '/api/failover/hello'), (e) => e.code === 'EPIN');
  const r = await B.call('POST', '/api/failover/pair', { address: addr(), code: `${code.slice(0, -43)}${'x'.repeat(43)}` });
  assert.equal(r.status, 502);
  assert.equal(B.ctx.failover.status().role, 'alone');
});

test('standby: pairs, takes the data of the master, only reads, alarms nothing', async () => {
  // a second account on the standby: its id is the id of another person on the master - it must not become that one
  assert.equal((await B.call('POST', '/api/users', { username: 'leser', password: 'Leser-Passwort-12', role: 'viewer' })).status, 201);
  assert.equal((await A.call('POST', '/api/users', { username: 'chefin', password: 'Chefin-Passwort-12', role: 'admin' })).status, 201);
  assert.equal((await B.call('POST', '/api/login', { username: 'leser', password: 'Leser-Passwort-12' }, { who: 'leser' })).status, 200);
  const r = await B.call('POST', '/api/failover/pair', { address: addr(), code, delayMin: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.role, 'standby');
  assert.equal(r.data.standby.state, 'listening');
  // the data of the master are here; the admin session lives on (same name, same id)
  const mons = (await B.call('GET', '/api/monitors')).data;
  assert.deepEqual(mons.map((m) => m.name), ['Intranet']);
  assert.ok(B.db.prepare("SELECT 1 FROM users WHERE username='chef'").get());
  assert.ok(!B.db.prepare("SELECT 1 FROM users WHERE username='leser'").get());
  // the stored secret of the channel can be read here (same key)
  assert.equal(B.ctx.channels.list()[0].name, 'Bereitschaft');
  // the viewer of the standby is signed out, not turned into the admin "chefin" of the master
  assert.equal((await B.call('GET', '/api/me', undefined, { who: 'leser' })).status, 401);
  // only reading
  const w = await B.call('POST', '/api/monitors', { name: 'x', type: 'ping', target: '10.0.10.1' });
  assert.equal(w.status, 409);
  assert.equal(w.data.error.code, 'err.foStandby');
  assert.equal((await B.call('GET', '/api/failover/banner')).data.mode, 'standby');
  assert.equal(B.ctx.failover.active(), false);
  // the secret is stored only encrypted
  assert.ok(!fs.readFileSync(path.join(dirB, 'failover.json'), 'utf8').includes(parseCode(code).secret));
  // the sessions of the master are not in the copy (they sign in)
  const { secret } = parseCode(code);
  const gz = path.join(dirB, 'probe.gz');
  await pinnedRequest({ address: addr(), pin: parseCode(code).pin, secret }, 'GET', '/api/failover/snapshot', { toFile: gz });
  const raw = (await import('node:zlib')).gunzipSync(fs.readFileSync(gz));
  const sid = A.db.prepare('SELECT id FROM sessions LIMIT 1').get().id;
  assert.ok(sid && !raw.includes(Buffer.from(sid)));
  fs.rmSync(gz);
  // the master sees its standby
  assert.equal((await A.call('GET', '/api/failover')).data.master.peer.ip, '127.0.0.1');
  // a change on the master arrives with the next copy
  const add = await A.call('POST', '/api/monitors', { name: 'Drucker EG', type: 'tcp', target: '10.0.10.40', port: 9100, interval_s: 60 });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  B.ctx.failover._state().standby.needSync = true;
  await B.ctx.failover.tick();
  assert.deepEqual((await B.call('GET', '/api/monitors')).data.map((m) => m.name).sort(), ['Drucker EG', 'Intranet']);
});

test('the master is gone longer than the set time: the standby takes over; it is back: the standby is quiet again', async () => {
  await new Promise((r) => httpsA.close(r));
  // not yet: the master was there a minute ago
  await B.ctx.failover.tick();
  assert.equal(B.ctx.failover.status().standby.state, 'listening');
  assert.ok(B.ctx.failover.status().standby.lastError);
  B.ctx.failover._state().standby.lastContact = new Date(Date.now() - 11 * 60000).toISOString();
  await B.ctx.failover.tick();
  const s = B.ctx.failover.status();
  assert.equal(s.standby.state, 'active');
  assert.equal(B.ctx.failover.active(), true);
  assert.equal((await B.call('GET', '/api/failover/banner')).data.mode, 'active');
  assert.equal(s.takeovers.length, 1);
  assert.equal(s.takeovers[0].to, null);
  // during the takeover something happens here (kept with the takeover, not sent back)
  const mid = B.db.prepare("SELECT id FROM monitors WHERE name='Intranet'").get().id;
  B.db.prepare("INSERT INTO monitor_events(monitor_id,at,kind,message,notified) VALUES(?,?,'down','Intranet: timeout','Bereitschaft')").run(mid, new Date().toISOString());
  // the master answers again
  await listenA();
  await B.ctx.failover.tick();
  const b = B.ctx.failover.status();
  assert.equal(b.standby.state, 'listening');
  assert.equal(B.ctx.failover.active(), false);
  assert.ok(b.takeovers[0].to);
  assert.equal(b.takeovers[0].end, 'back');
  assert.deepEqual(b.takeovers[0].events.map((e) => [e.name, e.kind]), [['Intranet', 'down']]);
  // and the data are the master's again (the event of the takeover is not in them)
  assert.equal(B.db.prepare("SELECT COUNT(*) n FROM monitor_events WHERE message='Intranet: timeout'").get().n, 0);
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM monitor_events WHERE message='Intranet: timeout'").get().n, 0);
});

test('the master gets a new certificate with the same key: the standby goes on by itself; another key: it does not talk', async () => {
  const key = tlsA.current().key;
  const kf = path.join(dirA, 'k.pem');
  fs.writeFileSync(kf, key, { mode: 0o600 });
  const renewed = spawnSync('openssl', ['req', '-x509', '-key', kf, '-subj', '/CN=renewed', '-days', '30', '-sha256'], { encoding: 'utf8' }).stdout;
  assert.match(renewed, /BEGIN CERTIFICATE/);
  const before = B.ctx.failover._state().standby.pem;
  await new Promise((r) => httpsA.close(r));
  await listenA(renewed, key);
  await B.ctx.failover.tick();
  assert.equal(B.ctx.failover.status().standby.lastError, '');
  assert.notEqual(B.ctx.failover._state().standby.pem, before);
  // a certificate with another key (someone else at that address): no contact, the secret is not sent
  const other = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', '-', '-subj', '/CN=fremd', '-days', '30'], { encoding: 'utf8' }).stdout;
  await new Promise((r) => httpsA.close(r));
  await listenA(other.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0], other.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)[0]);
  await B.ctx.failover.tick();
  assert.match(B.ctx.failover.status().standby.lastError, /pairing code/);
  await new Promise((r) => httpsA.close(r));
  await listenA();
  await B.ctx.failover.tick();
  assert.equal(B.ctx.failover.status().standby.lastError, '');
});

test('the time until it takes over can be set (3 to 240 minutes)', async () => {
  assert.equal((await B.call('PUT', '/api/failover/delay', { delayMin: 30 })).data.standby.delayMin, 30);
  assert.equal((await B.call('PUT', '/api/failover/delay', { delayMin: 1 })).data.standby.delayMin, 3);
  assert.equal((await B.call('PUT', '/api/failover/delay', { delayMin: 9999 })).data.standby.delayMin, 240);
});

test('the master ends the pairing: the standby keeps quiet (does not take over) until it is decided there', async () => {
  assert.equal((await A.call('POST', '/api/failover/unpair')).data.role, 'alone');
  await B.ctx.failover.tick();
  assert.equal(B.ctx.failover.status().standby.state, 'detached');
  assert.equal(B.ctx.failover.active(), false);
  assert.equal((await B.call('GET', '/api/failover/banner')).data.mode, 'detached');
});

test('make the standby the master: the old master is told and keeps quiet', async () => {
  code = (await A.call('POST', '/api/failover/master')).data.code;
  const p = await B.call('POST', '/api/failover/pair', { address: addr(), code });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const r = await B.call('POST', '/api/failover/promote');
  assert.equal(r.status, 200);
  assert.equal(r.data.role, 'master');
  assert.ok(r.data.code.startsWith('WOMN1-'));
  assert.equal(B.ctx.failover.active(), true);
  await B.ctx.failover.tick();
  assert.equal(B.ctx.failover.status().former, null);
  assert.equal(A.ctx.failover.status().role, 'yielded');
  assert.equal(A.ctx.failover.active(), false);
  const w = await A.call('POST', '/api/monitors', { name: 'x', type: 'ping', target: '10.0.10.1' });
  assert.equal(w.data.error.code, 'err.foYielded');
  // there it is decided: alone again (and active)
  assert.equal((await A.call('POST', '/api/failover/unpair')).data.role, 'alone');
  assert.equal(A.ctx.failover.active(), true);
});
