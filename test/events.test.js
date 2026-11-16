// Messages devices send by themselves: syslog and SNMP traps over real UDP, matched to the inventory, flood protection,
// the event monitor that alarms on them - and that only admins switch the receivers on.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';

// free UDP ports for this test file (the config reads them when it is loaded)
const freePort = () => new Promise((resolve) => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
process.env.WOMN_TRAP_PORT = String(await freePort());
process.env.WOMN_SYSLOG_PORT = String(await freePort());
const { startApp } = await import('./helpers.js');
const { parseSyslog, describeTrap, eventMatches } = await import('../src/events.js');
const { LOCAL_TABLES } = await import('../src/failover.js');
const { checkText } = await import('../public/js/checktext.js');
const snmp = (await import('net-snmp')).default;

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => { ctx.events.stop(); return app.close(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sendSyslog = (text) => new Promise((resolve) => { const s = dgram.createSocket('udp4'); s.send(Buffer.from(text), Number(process.env.WOMN_SYSLOG_PORT), '127.0.0.1', () => s.close(resolve)); });
const until = async (fn, ms = 3000) => { for (let i = 0; i < ms / 50; i++) { const v = fn(); if (v) return v; await wait(50); } return fn(); };

test('syslog: RFC 3164, RFC 5424, devices that leave things out', () => {
  assert.deepEqual(parseSyslog('<34>Oct 11 22:14:15 sw-core sshd[812]: Failed password for root from 10.0.0.9'),
    { severity: 2, facility: 4, host: 'sw-core', app: 'sshd', text: 'Failed password for root from 10.0.0.9' });
  assert.deepEqual(parseSyslog('<165>1 2026-11-15T10:00:00.003Z fw01 firewall 1234 ID47 [exampleSDID@32473 iut="3" eventSource="App\\]x"] ﻿Link WAN1 down'),
    { severity: 5, facility: 20, host: 'fw01', app: 'firewall', text: 'Link WAN1 down' });
  // Synology, Ubiquiti and co. often send no host, or no time
  assert.equal(parseSyslog('<11>kernel: md2: disk failure on sdb').app, 'kernel');
  assert.equal(parseSyslog('<11>kernel: md2: disk failure on sdb').severity, 3);
  assert.deepEqual(parseSyslog('<12>fs01 smartd[512]: Device: /dev/sdb, 8 unreadable sectors'), { severity: 4, facility: 1, host: 'fs01', app: 'smartd', text: 'Device: /dev/sdb, 8 unreadable sectors' });
  assert.equal(parseSyslog('<11>Link is down on port 3').text, 'Link is down on port 3');
  assert.equal(parseSyslog('just text').severity, 5);
  assert.equal(parseSyslog('<999>x').text, '<999>x');
  assert.equal(parseSyslog(`<13>${'x'.repeat(9000)}`).text.length, 4000, 'cut to 4000 characters');
  assert.equal(parseSyslog('<13>a\x00b\x1bc').text, 'a b c');
});

test('traps: v1 and v2c, well-known ones in words, the port of linkDown', () => {
  const v1 = describeTrap({ type: snmp.PduType.Trap, enterprise: '1.3.6.1.4.1.9', generic: 2, specific: 0,
    varbinds: [{ oid: '1.3.6.1.2.1.2.2.1.1.3', type: snmp.ObjectType.Integer, value: 3 }, { oid: '1.3.6.1.2.1.31.1.1.1.1.3', type: snmp.ObjectType.OctetString, value: Buffer.from('Gi1/0/3') }] });
  assert.deepEqual([v1.oid, v1.name, v1.severity, v1.text], ['1.3.6.1.6.3.1.1.5.3', 'linkDown', 4, 'port down: Gi1/0/3']);
  const apc = describeTrap({ type: snmp.PduType.Trap, enterprise: '1.3.6.1.4.1.318', generic: 6, specific: 5, varbinds: [] });
  assert.deepEqual([apc.oid, apc.severity], ['1.3.6.1.4.1.318.0.5', 2]);
  const v2 = describeTrap({ type: snmp.PduType.TrapV2, varbinds: [{ oid: '1.3.6.1.2.1.1.3.0', value: 1 }, { oid: '1.3.6.1.6.3.1.1.4.1.0', type: snmp.ObjectType.OID, value: '1.3.6.1.4.1.6574.1.0.1' },
    { oid: '1.3.6.1.4.1.6574.1.1', type: snmp.ObjectType.OctetString, value: Buffer.from([0x00, 0xff, 0x10]) }] });
  assert.equal(v2.oid, '1.3.6.1.4.1.6574.1.0.1');
  assert.equal(v2.severity, 5);
  assert.match(v2.text, /^trap 1\.3\.6\.1\.4\.1\.6574\.1\.0\.1: 1\.3\.6\.1\.4\.1\.6574\.1\.1=00ff10$/);
});

test('setup: admin, viewer, a switch in the inventory', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'michael', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'viewer' });
  assert.equal((await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'viewer' })).status, 200);
  ctx.inventory.create({ name: 'sw-core', ip: '127.0.0.1', mac: '00:11:22:33:44:55', type: 'switch' }, 'michael');
});

test('off until an admin switches it on; viewers cannot', async () => {
  const r = await call('GET', '/api/events');
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.status.traps.on, r.data.status.syslog.on], [false, false]);
  assert.equal(r.data.settings.trapPort, Number(process.env.WOMN_TRAP_PORT));
  assert.equal((await call('PUT', '/api/events/settings', { traps: true, syslog: true }, { who: 'viewer' })).status, 403);
  assert.equal((await call('GET', '/api/events', undefined, { who: 'viewer' })).status, 403);
  assert.equal((await call('GET', '/api/events/senders', undefined, { who: 'viewer' })).status, 403);
  assert.ok(Array.isArray((await call('GET', '/api/events/senders')).data.senders));
  assert.equal((await call('PUT', '/api/events/senders/filter', { source: '10.0.0.9', min: -1 }, { who: 'viewer' })).status, 403);
  assert.equal((await call('PUT', '/api/events/senders/filter', { source: 'x y', min: -1 })).status, 400);
  assert.equal((await call('PUT', '/api/events/senders/filter', { source: '10.0.0.9', min: 9 })).status, 400);
  assert.equal((await call('PUT', '/api/events/senders/filter', { source: '10.0.0.9', min: -1 })).status, 200);
  assert.equal((await call('PUT', '/api/events/senders/filter', { source: '10.0.0.9', min: null })).status, 200);
  assert.equal((await call('PUT', '/api/events/settings', { traps: true, syslog: true, keepDays: 0 })).status, 400);
  const on = await call('PUT', '/api/events/settings', { traps: true, syslog: true, communities: 'Trap-Geheim, zweite' });
  assert.equal(on.status, 200);
  assert.deepEqual([on.data.status.traps.on, on.data.status.syslog.on, on.data.settings.communitiesSet], [true, true, true]);
  assert.equal(JSON.stringify(on.data).includes('Trap-Geheim'), false, 'the community never goes back to the browser');
});

test('syslog over UDP: stored, matched to the device, shown', async () => {
  await sendSyslog('<11>Nov 15 10:00:00 sw-core stp: Topology change on Gi1/0/24');
  const row = await until(() => db.prepare("SELECT * FROM events_in WHERE kind='syslog' ORDER BY id DESC").get());
  assert.ok(row, 'received');
  assert.deepEqual([row.source_ip, row.severity, row.app, row.text], ['127.0.0.1', 3, 'stp', 'Topology change on Gi1/0/24']);
  assert.ok(row.device_id);
  const list = (await call('GET', '/api/events?q=topology')).data.list;
  assert.equal(list[0].device_name, 'sw-core');
  assert.equal((await call('GET', '/api/events?q=nothing-like-this')).data.list.length, 0);
});

test('SNMP trap over UDP: with a known community stored, with another one not', async () => {
  const send = (community) => new Promise((resolve) => {
    const s = snmp.createSession('127.0.0.1', community, { version: snmp.Version2c, trapPort: Number(process.env.WOMN_TRAP_PORT) });
    s.trap('1.3.6.1.6.3.1.1.5.3', [{ oid: '1.3.6.1.2.1.31.1.1.1.1.7', type: snmp.ObjectType.OctetString, value: 'Gi1/0/7' }], () => { s.close(); resolve(); });
  });
  await send('falsch');
  await send('Trap-Geheim');
  const row = await until(() => db.prepare("SELECT * FROM events_in WHERE kind='trap' ORDER BY id DESC").get());
  assert.ok(row);
  assert.deepEqual([row.oid, row.app, row.severity, row.text], ['1.3.6.1.6.3.1.1.5.3', 'linkDown', 4, 'port down: Gi1/0/7']);
  await wait(200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events_in WHERE kind='trap'").get().n, 1, 'the trap with the wrong community is dropped');
});

test('a flood is cut: at most 20 per second from one sender', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM events_in').get().n;
  for (let i = 0; i < 50; i++) ctx.events.receive('syslog', '10.9.9.9', { severity: 6, text: `spam ${i}` });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events_in').get().n - before, 20);
});

test('event monitor: alarms on a matching message, quiet again after the hold time', async () => {
  const dev = db.prepare("SELECT id FROM devices WHERE name='sw-core'").get().id;
  const r = await call('POST', '/api/monitors', { name: 'sw-core: Ports', type: 'event', device_id: dev, options: { source: 'trap', maxSeverity: 4, match: 'port down', holdMin: 30 }, interval_s: 60 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.fail_threshold, 1);
  assert.equal(r.data.target, 'sw-core');
  const m = await ctx.monitoring.checkNow(r.data.id);
  assert.equal(m.status, 'down');
  assert.match(m.last_message, /^trap warning from 127\.0\.0\.1: linkDown: port down: Gi1\/0\/7$/);
  assert.equal(checkText(m.last_message), 'Trap Warnung von 127.0.0.1: linkDown: Port getrennt: Gi1/0/7');
  // the same thing a second time is refused (no duplicates)
  assert.equal((await call('POST', '/api/monitors', { name: 'x', type: 'event', device_id: dev, options: { source: 'trap', maxSeverity: 4, match: 'Port Down', holdMin: 5 } })).status, 409);
  // older than the hold time: fine again
  db.prepare("UPDATE events_in SET at='2020-01-01T00:00:00.000Z'").run();
  assert.equal((await ctx.monitoring.checkNow(r.data.id)).status, 'up');
  // filter: other device, too mild, other text - no match
  const row = { kind: 'trap', device_id: dev, severity: 4, app: 'linkDown', text: 'port down: Gi1' };
  assert.equal(eventMatches(row, { source: 'trap', maxSeverity: 4, match: 'port down' }, dev), true);
  assert.equal(eventMatches(row, { source: 'syslog', maxSeverity: 4 }, dev), false);
  assert.equal(eventMatches(row, { source: 'any', maxSeverity: 3 }, dev), false);
  assert.equal(eventMatches(row, { source: 'any', maxSeverity: 4 }, dev + 1), false);
  assert.equal(eventMatches(row, { source: 'any', maxSeverity: 4, match: 'fan' }, null), false);
  // "So wird geprüft"
  const how = (await call('GET', `/api/monitors/${r.data.id}`)).data.how;
  assert.deepEqual([how.eventSource, how.maxSeverity, how.holdMin, how.match], ['trap', 4, 30, 'port down']);
  assert.match(how.device, /^sw-core/);
});

test('only from inventory devices when asked; each installation keeps its own messages', async () => {
  const bad = await call('PUT', '/api/events/settings', { traps: false, syslog: false, winAllow: '1116, abc' });
  assert.deepEqual([bad.status, bad.data.error.field], [400, 'winAllow']);
  const tidy = await call('PUT', '/api/events/settings', { traps: false, syslog: false, winDeny: '8004 4624,4634' });
  assert.equal(tidy.data.settings.winDeny, '8004, 4624, 4634');
  assert.equal((await call('PUT', '/api/events/settings', { traps: false, syslog: false, winDeny: '' })).data.settings.winDeny, '');
  assert.equal((await call('PUT', '/api/events/settings', { traps: false, syslog: false, onlyKnown: true })).status, 200);
  assert.equal(ctx.events.receive('syslog', '10.77.0.1', { severity: 3, text: 'unknown sender' }), null);
  assert.ok(ctx.events.receive('syslog', '127.0.0.1', { severity: 3, text: 'known sender' }));
  // in a file of their own: not in the database the standby takes, nor in its backups
  assert.equal(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='events_in'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM ev.sqlite_master WHERE name='events_in'").get());
  assert.ok(LOCAL_TABLES);
  db.prepare("UPDATE events_in SET at='2000-01-01T00:00:00.000Z' WHERE text='known sender'").run();
  ctx.events.prune();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events_in WHERE text='known sender'").get().n, 0);
});
