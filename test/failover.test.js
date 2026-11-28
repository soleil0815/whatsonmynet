// Failover: master and standby, pairing with a code, the standby takes the data, keeps quiet, takes over when the
// master is gone, hands back its measurements when it answers again, and "make this the master" (the old one keeps quiet then).
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
  // the standby gives up while the copy is made (restarted for an update): a note in the log, not an error with a
  // stack trace (three of them a week on a real server), and the copy on disk is gone too
  {
    const { log } = await import('../src/lib/log.js');
    const { PassThrough } = await import('node:stream');
    const seen = [];
    const keep = { error: log.error, info: log.info };
    log.error = (m) => seen.push(['error', String(m)]); log.info = (m) => seen.push(['info', String(m)]);
    try {
      const headers = { authorization: `Bearer ${secret}` };
      const req = { get: (h) => headers[h.toLowerCase()], ip: '127.0.0.1', query: {} };
      for (const when of ['before', 'during']) {
        const res = new PassThrough(); res.setHeader = () => {};
        if (when === 'before') res.destroy(); else res.once('data', () => res.destroy());
        res.resume();
        await A.ctx.failover.sendSnapshot(req, res);
      }
    } finally { Object.assign(log, keep); }
    assert.deepEqual(seen.filter(([l]) => l === 'error'), []);
    assert.equal(seen.filter(([, m]) => /broke off/.test(m)).length, 2, JSON.stringify(seen));
  }
  // the master sees its standby
  assert.equal((await A.call('GET', '/api/failover')).data.master.peer.ip, '127.0.0.1');
  // a change on the master arrives with the next copy
  const add = await A.call('POST', '/api/monitors', { name: 'Drucker EG', type: 'tcp', target: '10.0.10.40', port: 9100, interval_s: 60 });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  B.ctx.failover._state().standby.needSync = true;
  await B.ctx.failover.tick();
  assert.deepEqual((await B.call('GET', '/api/monitors')).data.map((m) => m.name).sort(), ['Drucker EG', 'Intranet']);

  // the messages of the master (syslog, traps, Windows events) come over too - a message the standby got itself
  // (the sender sends to both) is not there twice
  const msg = (X, text, ip = '10.0.10.21', at = new Date()) => X.ctx.events.receive('syslog', ip, { severity: 4, text, eventId: 4625, app: 'Security' }, at);
  const now = new Date();
  msg(A, 'Anmeldung fehlgeschlagen: max', '10.0.10.21', now);
  msg(A, 'Anmeldung fehlgeschlagen: testadmin', '10.0.10.22', now);
  msg(B, 'Anmeldung fehlgeschlagen: max', '10.0.10.21', new Date(now.getTime() + 800));
  await B.ctx.failover.tick();
  const onB = (text) => B.db.prepare('SELECT COUNT(*) n FROM events_in WHERE text=?').get(text).n;
  assert.equal(onB('Anmeldung fehlgeschlagen: max'), 1, 'not twice');
  assert.equal(onB('Anmeldung fehlgeschlagen: testadmin'), 1);
  const ms = B.ctx.failover.status().standby.messages;
  assert.equal(ms.copied, 1);
  assert.equal(ms.error, '');
  // the next round goes on where it stopped
  msg(A, 'Dienst gestartet', '10.0.10.23');
  await B.ctx.failover.tick();
  assert.equal(onB('Dienst gestartet'), 1);
  assert.equal(B.ctx.failover.status().standby.messages.copied, 2);
  // a copy starts no rules or event monitors here (counted and searchable like any message)
  assert.equal(B.db.prepare("SELECT device_id FROM events_in WHERE text='Dienst gestartet'").get().device_id, null);
  // only for the standby with the secret
  assert.equal((await A.call('GET', '/api/failover/messages?after=0')).status, 401);
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
  // during the takeover the standby measures and alarms (as its engines would)
  const mid = B.db.prepare("SELECT id FROM monitors WHERE name='Intranet'").get().id;
  const pid = B.db.prepare("SELECT id FROM monitors WHERE name='Drucker EG'").get().id;
  const hourOf = (iso) => `${iso.slice(0, 13)}:00`;
  // the takeover began ten minutes ago (as if the set time had passed) - with the values of that hour as its start
  const tk = B.ctx.failover._state().takeovers[0];
  tk.from = new Date(Date.now() - 10 * 60000).toISOString();
  // the master's values of that hour, in its data and in the copy here
  const mid0 = B.db.prepare("SELECT id FROM monitors WHERE name='Intranet'").get().id;
  for (const X of [A, B]) X.db.prepare('INSERT INTO monitor_hourly(monitor_id,hour,ok,total,ms_sum) VALUES(?,?,5,5,50) ON CONFLICT(monitor_id,hour) DO UPDATE SET ok=ok+5,total=total+5').run(mid0, hourOf(tk.from));
  tk.base = { hour: hourOf(tk.from), rows: Object.fromEntries(B.db.prepare('SELECT monitor_id, ok, total, ms_sum, v_n, v_sum FROM monitor_hourly WHERE hour=?').all(hourOf(tk.from)).map((r) => [r.monitor_id, [r.ok, r.total, r.ms_sum, r.v_n, r.v_sum]])) };
  const from = tk.from;
  const at = (min) => new Date(Date.parse(from) + min * 60000).toISOString();
  // the hour of the takeover had values of the master already (from its last copy): those must not be added twice
  // (summed from the hour of the takeover on - the checks may fall into the next hour)
  const sumFrom = (X) => X.db.prepare('SELECT COALESCE(SUM(ok),0) ok, COALESCE(SUM(total),0) total FROM monitor_hourly WHERE monitor_id=? AND hour>=?').get(mid, hourOf(from));
  const aBase = sumFrom(A);
  const check = B.db.prepare('INSERT INTO checks(monitor_id,at,ok,ms,message) VALUES(?,?,?,?,?)');
  const hour = B.db.prepare(`INSERT INTO monitor_hourly(monitor_id,hour,ok,total,ms_sum) VALUES(?,?,?,1,?)
    ON CONFLICT(monitor_id,hour) DO UPDATE SET ok=ok+excluded.ok, total=total+1, ms_sum=ms_sum+excluded.ms_sum`);
  for (const [min, ok] of [[2, 1], [4, 0], [6, 0]]) { check.run(mid, at(min), ok, ok ? 12 : null, ok ? '' : 'timeout'); hour.run(mid, hourOf(at(min)), ok, ok ? 12 : 0); }
  B.db.prepare("INSERT INTO monitor_events(monitor_id,at,kind,message,notified) VALUES(?,?,'down','Intranet: timeout','Bereitschaft')").run(mid, at(4.1));
  // the printer: the master checked it itself meanwhile (only the standby was cut off from it) - it keeps its own
  check.run(pid, at(5), 0, null, 'standby: refused');
  // a message that reached only the standby while it had taken over
  B.ctx.events.receive('syslog', '10.0.10.24', { severity: 3, text: 'USV: Netzausfall', app: 'ups' }, new Date(Date.parse(from) + 3 * 60000));
  A.db.prepare("INSERT INTO checks(monitor_id,at,ok,ms,message) VALUES(?,?,1,5,'')").run(pid, at(5));
  // the master answers again: the standby hands back first, then takes the master's data - and its receivers follow
  // the master's settings at once (syslog on/off, lists of event ids)
  const refresh = B.ctx.events.refresh; let refreshed = 0;
  B.ctx.events.refresh = () => { refreshed++; return refresh(); };
  await listenA();
  await B.ctx.failover.tick();
  B.ctx.events.refresh = refresh;
  assert.ok(refreshed >= 1, 'the receivers follow the copy of the master');
  const b = B.ctx.failover.status();
  assert.equal(b.standby.state, 'listening');
  assert.equal(B.ctx.failover.active(), false);
  assert.ok(b.takeovers[0].to);
  assert.equal(b.takeovers[0].end, 'back');
  assert.deepEqual(b.takeovers[0].events.map((e) => [e.name, e.kind]), [['Intranet', 'down']]);
  assert.equal(b.takeovers[0].base, undefined, 'the start values are not shown');
  const hb = b.takeovers[0].handback;
  assert.equal(hb.state, 'done', JSON.stringify(hb));
  assert.equal(hb.checks, 3);
  assert.equal(hb.events, 1);
  assert.equal(hb.messages, 1, 'the message of the takeover went back');
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM events_in WHERE text='USV: Netzausfall'").get().n, 1);
  assert.deepEqual(hb.skipped, ['Drucker EG']);
  // now on the master: the checks, the alarm and the hourly values of the takeover - only the standby's share
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM checks WHERE monitor_id=? AND at >= ?").get(mid, from).n, 3);
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM monitor_events WHERE message='Intranet: timeout'").get().n, 1);
  const h = sumFrom(A);
  assert.deepEqual([h.ok - aBase.ok, h.total - aBase.total], [1, 3], 'only the share of the standby, not the start values again');
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM checks WHERE monitor_id=? AND message='standby: refused'").get(pid).n, 0, 'the master kept its own');
  // the master shows what it got; the standby has the master's data again - with what it handed back
  const got = (await A.call('GET', '/api/failover')).data.received;
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].checks, got[0].events, got[0].skipped], [3, 1, ['Drucker EG']]);
  assert.equal(B.db.prepare("SELECT COUNT(*) n FROM monitor_events WHERE message='Intranet: timeout'").get().n, 1);
  assert.ok(!fs.existsSync(path.join(dirB, 'failover-handback.json')), 'nothing left to hand back');
  // the same part again (a lost answer): taken only once
  const { secret, pin } = parseCode(code);
  const again = await pinnedRequest({ address: addr(), pin, secret }, 'POST', '/api/failover/handback',
    { body: { pack: got[0].pack, part: 0, of: 1, from: got[0].from, to: got[0].to, monitors: { [mid]: { name: 'Intranet', type: 'http' } }, checks: [[mid, at(3), 1, 5, '']] } });
  assert.equal(again.json.again, true);
  assert.equal(A.db.prepare('SELECT COUNT(*) n FROM checks WHERE monitor_id=? AND at=?').get(mid, at(3)).n, 0);
  // without the secret nothing is taken
  const bad = await pinnedRequest({ address: addr(), pin, secret: 'x'.repeat(43) }, 'POST', '/api/failover/handback', { body: { pack: 'a'.repeat(16), part: 0, of: 1, from, to: at(5) } });
  assert.equal(bad.status, 401);
});

test('a takeover from before this version: its alarms go back by the names of the monitors', async () => {
  const st = B.ctx.failover._state();
  const t0 = new Date(Date.now() - 2 * 86400000).toISOString();
  const t1 = new Date(Date.now() - 2 * 86400000 + 30 * 60000).toISOString();
  st.takeovers.push({ from: t0, to: t1, end: 'back', why: 'no answer', events: [
    { at: new Date(Date.parse(t0) + 60000).toISOString(), kind: 'down', name: 'intranet', message: 'Intranet: timeout (alt)', notified: 'Bereitschaft' },
    { at: new Date(Date.parse(t0) + 9 * 60000).toISOString(), kind: 'up', name: 'Intranet', message: 'Intranet: wieder da', notified: '' },
    { at: new Date(Date.parse(t0) + 2 * 60000).toISOString(), kind: 'down', name: 'Gibt es nicht', message: 'x', notified: '' }] });
  st.takeovers.push({ from: t0, to: t1, end: 'back', events: [] });
  await B.ctx.failover.tick();
  const old = B.ctx.failover.status().takeovers.find((x) => x.from === t0 && x.events.length);
  assert.equal(old.handback.state, 'done', JSON.stringify(old.handback));
  assert.equal(old.handback.events, 2);
  assert.deepEqual(old.handback.skipped, ['Gibt es nicht']);
  assert.equal(B.ctx.failover.status().takeovers.find((x) => x.from === t0 && !x.events.length).handback.state, 'nothing');
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM monitor_events WHERE message IN ('Intranet: timeout (alt)', 'Intranet: wieder da')").get().n, 2);
  // a second round hands nothing back twice
  await B.ctx.failover.tick();
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM monitor_events WHERE message='Intranet: timeout (alt)'").get().n, 1);
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
    assert.ok(eventText(sent[0], 'de').includes(`Version 99.0.0, dieses System (Standby) mit ${here}. Bitte diesen Standby auf 99.0.0 aktualisieren`), eventText(sent[0], 'de'));
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
    assert.ok(eventText(sent.at(-1), 'de').includes(`Bitte den Master auf ${here} aktualisieren`));
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
