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
import { normalizeAddress, parseCode, spkiPin, pinnedRequest, compareVersions } from '../src/failover.js';
import { eventText } from '../src/monitor/notify.js';

const dirA = fs.mkdtempSync(path.join(tmp, 'fo-a-'));
const dirB = fs.mkdtempSync(path.join(tmp, 'fo-b-'));
const tlsA = createTls(path.join(dirA, 'tls'));
await tlsA.ensure();
const A = await startApp({ tls: tlsA, dataDir: dirA });
const tlsB = createTls(path.join(dirB, 'tls'));
await tlsB.ensure();
const B = await startApp({ tls: tlsB, dataDir: dirB });
// the master also on HTTPS (the standby only talks HTTPS)
let httpsA = null; let port = 0; let helloOverride = null;
const listenA = (cert = null, key = null) => new Promise((resolve) => {
  const c = tlsA.current();
  // helloOverride: the master answers as if it ran another version
  httpsA = https.createServer({ cert: cert || c.cert, key: key || c.key }, (req, res) => {
    if (helloOverride && req.url.startsWith('/api/failover/hello')) { const over = helloOverride; res.json = function json(o) { return Object.getPrototypeOf(this).json.call(this, { ...o, ...over }); }; }
    A.app(req, res);
  });
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
  // nothing at all can be set up or changed: channels, mail, settings, users, own password - only failover controls
  const blocked = [
    ['POST', '/api/channels', { name: 'Webhook', type: 'webhook', config: { url: 'https://hook.example/x' } }],
    ['PUT', '/api/settings/smtp', { host: 'smtp.example', from: 'x@example.com' }],
    ['PUT', '/api/settings/general', { title: 'x' }],
    ['POST', '/api/users', { username: 'neu', password: 'Neu-Passwort-123', role: 'viewer' }],
    ['POST', '/api/me/password', { current: 'x', password: 'Neu-Passwort-123' }],
    ['POST', '/api/failover/master', {}],
    ['POST', '/api/failover/pair', { address: addr(), code }],
  ];
  for (const [m, url, body] of blocked) assert.equal((await B.call(m, url, body)).status, 409, `${m} ${url}`);
  // the look of one's own account stays changeable - name and mail do not (they come from the master)
  const me = await B.call('PATCH', '/api/me', { theme: 'dark', display_name: 'Anders', email: 'anders@example.com' });
  assert.equal(me.status, 200);
  assert.equal(me.data.theme, 'dark');
  assert.notEqual(me.data.display_name, 'Anders');
  assert.notEqual(me.data.email, 'anders@example.com');
  assert.equal((await B.call('PUT', '/api/failover/delay', { delayMin: 10 })).status, 200);

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
  // while it monitors in place of the master it still only reads (its data come back from the master)
  assert.equal((await B.call('POST', '/api/monitors', { name: 'y', type: 'ping', target: '10.0.10.2' })).status, 409);
  assert.equal(B.ctx.failover.readOnly(), true);
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

test('master and standby on different versions: a reminder after half an hour, again when both are the same', async () => {
  assert.equal(compareVersions('0.38.0', '0.39.0'), -1);
  assert.equal(compareVersions('v1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('0.39.0', '0.39.0'), 0);
  assert.equal(compareVersions('dev', '0.39.0'), null);
  const sent = [];
  const real = B.ctx.channels.notifyIds;
  B.ctx.channels.notifyIds = async (ids, ev) => { sent.push(ev); return []; };
  const st = () => B.ctx.failover._state().standby;
  const here = B.ctx.failover.status().version;
  try {
    // the master was updated, this standby not yet - one after the other is normal: nothing yet
    helloOverride = { version: '99.0.0' };
    await B.ctx.failover.tick();
    assert.equal(sent.length, 0);
    assert.deepEqual((await B.call('GET', '/api/failover/banner')).data.versions, { master: '99.0.0', here, schema: false });
    assert.equal(B.ctx.failover.status().standby.versions.notifiedAt, null);
    // still so after half an hour: a reminder - which one to update
    st().gap.since = new Date(Date.now() - 31 * 60000).toISOString();
    await B.ctx.failover.tick();
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].kind, sent[0].what, sent[0].older, sent[0].schema], ['failover', 'versions', 'standby', false]);
    assert.match(eventText(sent[0], 'de'), new RegExp(`Version 99\\.0\\.0, dieses System \\(Standby\\) mit ${here.replace(/\./g, '\\.')}\\. Bitte diesen Standby auf 99\\.0\\.0 aktualisieren`));
    assert.match(eventText(sent[0], 'en'), /Please update this standby to 99\.0\.0/);
    // not every minute
    await B.ctx.failover.tick();
    assert.equal(sent.length, 1);
    // the database versions differ too: the data cannot be taken - told at once, urgent
    helloOverride = { version: '99.0.0', schema: 9999 };
    await B.ctx.failover.tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].schema, true);
    assert.match(eventText(sent[1], 'de'), /kann der Standby die Daten des Masters nicht mehr übernehmen/);
    assert.match(B.ctx.failover.status().standby.syncError, /program versions differ/);
    // an older master: that one is to be updated
    helloOverride = { version: '0.0.1' };
    await B.ctx.failover.tick();
    st().gap.since = new Date(Date.now() - 31 * 60000).toISOString();
    await B.ctx.failover.tick();
    assert.equal(sent.at(-1).older, 'master');
    assert.match(eventText(sent.at(-1), 'de'), new RegExp(`Bitte den Master auf ${here.replace(/\./g, '\\.')} aktualisieren`));
    // both the same again: said once, the note goes
    const n = sent.length;
    helloOverride = null;
    await B.ctx.failover.tick();
    assert.equal(sent.length, n + 1);
    assert.equal(sent.at(-1).what, 'versionsOk');
    assert.match(eventText(sent.at(-1), 'de'), /wieder mit derselben Version/);
    assert.equal(B.ctx.failover.status().standby.versions, null);
    assert.equal((await B.call('GET', '/api/failover/banner')).data.versions, null);
    await B.ctx.failover.tick();
    assert.equal(sent.length, n + 1);
    // different, but back to the same within the half hour: no message at all
    helloOverride = { version: '99.0.1' };
    await B.ctx.failover.tick();
    helloOverride = null;
    await B.ctx.failover.tick();
    assert.equal(sent.length, n + 1);
  } finally { helloOverride = null; B.ctx.channels.notifyIds = real; }
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
