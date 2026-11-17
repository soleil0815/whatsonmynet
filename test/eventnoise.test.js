// What takes the space: Windows events and senders by share over the last days, with what speaks for keeping one -
// and leaving one out with a click. As a question for an AI chat without names, addresses or accounts of the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { createMasker } from '../src/lib/aimask.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => { ctx.events.stop(); return app.close(); });

const ins = db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,app,channel,text,event_id) VALUES(?, 'syslog', ?, ?, ?, ?, ?, ?, ?)");
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

test('setup: a chatty event, a failed logon, a switch', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'editor' });
  assert.equal((await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'editor' })).status, 200);
  db.transaction(() => {
    for (let i = 0; i < 600; i++) ins.run(ago(i * 2), `10.0.10.${11 + (i % 3)}`, 6, `PC-00${11 + (i % 3)}`, 'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS', 'Application',
      'RpcGetCurrentSessionCapabilities von FIRMA\\m.muster auf pc-0011.firma.local (10.0.10.11)', 59);
    for (let i = 0; i < 60; i++) ins.run(ago(i * 20), '10.0.10.11', 4, 'PC-0011', 'Microsoft-Windows-Security-Auditing', 'Security',
      'Fehler beim Anmelden eines Kontos. Kontoname: m.muster Kontodomäne: FIRMA Quellnetzwerkadresse: 10.0.10.50', 4625);
    for (let i = 0; i < 300; i++) ins.run(ago(i * 3), '10.0.10.2', 6, 'sw-core', 'PORT', '', `Port ${i % 24} link up`, null);
  })();
  db.exec("INSERT INTO event_senders(source_ip, host, first_at, last_at, last_id) SELECT source_ip, MAX(host), MIN(at), MAX(at), MAX(id) FROM events_in GROUP BY source_ip");
  while (ctx.events.countBatch() > 0);
});

test('the overview: events by share with an example, the senders, what speaks for keeping', async () => {
  // a rule waits for the failed logons
  db.prepare("INSERT INTO event_rules(name, enabled, match, channels, mode, digest_min, max_per_hour, options, created_at, updated_at) VALUES('Anmeldefehler', 1, ?, '[]', 'each', 0, 0, '{}', ?, ?)")
    .run(JSON.stringify({ eventIds: '4625' }), ago(0), ago(0));
  const r = await call('GET', '/api/events/noise?days=7', undefined, { who: 'editor' });
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.total, 960);
  assert.deepEqual(d.events.map((e) => e.id), [59, 4625]);
  const [chatty, logon] = d.events;
  assert.equal(chatty.share, 62.5);
  assert.deepEqual(chatty.senders.sort(), ['PC-0011', 'PC-0012', 'PC-0013']);
  assert.equal(chatty.worst, 6);
  assert.equal(chatty.example.app, 'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS');
  assert.deepEqual([chatty.rules, chatty.keep], [[], false]);
  assert.deepEqual([logon.rules, logon.keep, logon.worst], [['Anmeldefehler'], true, 4]);
  assert.ok(chatty.bytes > 0);
  assert.equal(d.senders[0].name, 'sw-core');
  assert.equal(d.senders[0].info, 100);
  assert.equal((await call('GET', '/api/events/noise?days=1', undefined, { who: 'editor' })).data.days, 1);
});

test('leaving one out: admins only, not while a rule needs it, once in the list', async () => {
  assert.equal((await call('POST', '/api/events/noise/deny', { id: 59 }, { who: 'editor' })).status, 403);
  const rule = await call('POST', '/api/events/noise/deny', { id: 4625 });
  assert.equal(rule.status, 400);
  assert.match(JSON.stringify(rule.data), /Anmeldefehler/);
  assert.equal((await call('POST', '/api/events/noise/deny', { id: 'x' })).status, 400);
  const before = String(ctx.settings.get('events.winDeny'));
  const r = await call('POST', '/api/events/noise/deny', { id: 59 });
  assert.equal(r.status, 200);
  assert.ok(r.data.winDeny.split(', ').includes('59'));
  assert.equal((await call('POST', '/api/events/noise/deny', { id: 59 })).data.winDeny, r.data.winDeny, 'not twice');
  assert.equal(r.data.winDeny.split(', ').length, before.split(', ').filter(Boolean).length + 1);
  // new ones are no longer kept, the overview says so for the old ones
  assert.equal(ctx.events.receive('syslog', '10.0.10.11', { severity: 6, text: 'x', eventId: 59, app: 'RdpCoreTS' }), null);
  const d = (await call('GET', '/api/events/noise?days=7')).data;
  assert.equal(d.events.find((e) => e.id === 59).denied, true);
});

test('as a question for an AI: no names, addresses, accounts or domains of the network', async () => {
  const r = await call('GET', '/api/events/noise/text?days=7&lang=de', undefined, { who: 'editor' });
  assert.equal(r.status, 200);
  const text = r.data.text;
  assert.match(text, /- 59 \(Microsoft-Windows-RemoteDesktopServices-RdpCoreTS, Protokoll Application\)/);
  assert.match(text, /von einer Benachrichtigungsregel gebraucht/);
  assert.match(text, /Schon ausgeschlossen: .*59/);
  for (const secret of ['m.muster', 'FIRMA', 'firma.local', '10.0.10.', 'PC-001', 'pc-0011']) assert.ok(!text.includes(secret), `${secret} left in:\n${text}`);
  assert.match(text, /<Domäne 1>\\<Konto 1>/);
  const en = (await call('GET', '/api/events/noise/text?days=1&lang=en')).data.text;
  assert.match(en, /last 24 hours/);
});

test('the masker: the same value keeps its placeholder; Windows words, files and built-in accounts stay', () => {
  const mask = createMasker({ names: ['PC-0001', 'srv-file'], lang: 'en' });
  assert.equal(mask('PC-0001 to srv-file, again PC-0001'), '<Computer 1> to <Computer 2>, again <Computer 1>');
  assert.equal(mask('NT AUTHORITY\\SYSTEM ran C:\\Windows\\system32\\svchost.exe'), 'NT AUTHORITY\\SYSTEM ran C:\\Windows\\system32\\svchost.exe');
  assert.equal(mask('Account Name: - Account Name: max.muster'), 'Account Name: - Account Name: <Account 1>');
  assert.equal(mask('mail to m.muster@firma.local from 192.168.1.20 and fe80::1'), 'mail to <Email 1> from <Address 1> and fe80::1');
  assert.equal(createMasker()('C:\\Users\\m.muster\\AppData and C:\\Users\\Public'), 'C:\\Users\\<Konto 1>\\AppData and C:\\Users\\Public');
  assert.equal(mask('update from download.windowsupdate.com for host1.firma.local'), 'update from download.windowsupdate.com for <Domain 1>');
  assert.equal(mask('S-1-5-21-1111111111-2222222222-3333333333-1105 and S-1-5-18'), '<SID 1> and S-1-5-18');
  assert.equal(mask('version 10.0.19045.1234'), 'version 10.0.19045.1234');
});
