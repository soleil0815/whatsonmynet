// What takes the space: Windows events and senders by share over the last days, with what speaks for keeping one -
// and leaving one out with a click. As a question for an AI chat without names, addresses or accounts of the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { createMasker } from '../src/lib/aimask.js';
import { parseDenyList, formatDenyList, denies } from '../src/eventrules.js';

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
  // 59 is left out since the test before: not asked again, only named in the list at the end
  assert.doesNotMatch(text, /^- 59 /m);
  assert.match(text, /- 4625 \(Microsoft-Windows-Security-Auditing, Protokoll Security\)/);
  assert.match(text, /als ID@Quelle, z\. B\. 1@Microsoft-Windows-Ntfs/);
  assert.match(text, /von einer Benachrichtigungsregel gebraucht/);
  assert.match(text, /Schon ausgeschlossen: .*59/);
  for (const secret of ['m.muster', 'FIRMA', 'firma.local', '10.0.10.', 'PC-001', 'pc-0011']) assert.ok(!text.includes(secret), `${secret} left in:\n${text}`);
  assert.match(text, /Kontoname: <Konto 1> Kontodomäne: <Domäne 1> Quellnetzwerkadresse: <Adresse 1>/);
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

// One number, several sources: 1 of Ntfs is noise, 1 of Sysmon a process start - left out per source
test('the list with sources: written, read back, matched like a rule (contains, any case)', () => {
  assert.deepEqual(parseDenyList('4624 4634, 100-110; 1@Ntfs\n7036 @ Service  Control Manager'),
    { ranges: [[4624, 4624], [4634, 4634], [100, 110]], pairs: [{ id: 1, src: 'Ntfs' }, { id: 7036, src: 'Service Control Manager' }] });
  for (const bad of ['1@', '@Ntfs', 'x@Ntfs', '1@a@b', 'abc', '5-3']) assert.equal(parseDenyList(bad), null, bad);
  assert.equal(formatDenyList(parseDenyList('8004, 4624, 1@Ntfs, 1@ntfs, 4624')), '8004, 4624, 1@Ntfs');
  const l = parseDenyList('4624, 1@Ntfs');
  assert.equal(denies(l, 1, 'Microsoft-Windows-Ntfs'), true);
  assert.equal(denies(l, 1, 'Microsoft-Windows-Sysmon'), false);
  assert.equal(denies(l, 1, ''), false, 'a message without its source is kept');
  assert.equal(denies(l, 4624, ''), true);
});

test('one number from two sources: two rows; leaving out one source keeps the other', async () => {
  db.transaction(() => {
    for (let i = 0; i < 40; i++) ins.run(ago(i * 5), '10.0.10.14', 6, 'PC-0014', 'Microsoft-Windows-Ntfs', 'Microsoft-Windows-Ntfs/Operational', 'Volume C: mounted', 1);
    for (let i = 0; i < 10; i++) ins.run(ago(i * 7), '10.0.10.14', 4, 'PC-0014', 'Microsoft-Windows-Sysmon', 'Microsoft-Windows-Sysmon/Operational', 'Process Create: powershell.exe', 1);
  })();
  while (ctx.events.countBatch() > 0);
  let d = (await call('GET', '/api/events/noise?days=7')).data;
  const ones = d.events.filter((e) => e.id === 1);
  assert.deepEqual(ones.map((e) => [e.app, e.n, e.estimated, e.denied]), [['Microsoft-Windows-Ntfs', 40, false, false], ['Microsoft-Windows-Sysmon', 10, false, false]]);
  // "Do not keep" on the Ntfs row: with its source
  const r = await call('POST', '/api/events/noise/deny', { id: 1, src: 'Microsoft-Windows-Ntfs' });
  assert.equal(r.status, 200);
  assert.match(r.data.winDeny, /(^|, )1@Microsoft-Windows-Ntfs$/);
  assert.equal((await call('POST', '/api/events/noise/deny', { id: 1, src: 'microsoft-windows-ntfs' })).data.winDeny, r.data.winDeny, 'not twice');
  assert.match(ctx.db.prepare("SELECT detail FROM audit WHERE action='events.settings' ORDER BY id DESC LIMIT 1").pluck().get(), /event 1 of Microsoft-Windows-Ntfs/);
  d = (await call('GET', '/api/events/noise?days=7')).data;
  // (the one left out goes to the end, apart)
  assert.deepEqual(d.events.filter((e) => e.id === 1).map((e) => [e.app, e.denied]), [['Microsoft-Windows-Sysmon', false], ['Microsoft-Windows-Ntfs', true]]);
  // new ones: 1 of Ntfs no longer kept, 1 of Sysmon still
  assert.equal(ctx.events.receive('syslog', '10.0.10.14', { severity: 6, text: 'x', eventId: 1, app: 'Microsoft-Windows-Ntfs' }), null);
  assert.ok(ctx.events.receive('syslog', '10.0.10.14', { severity: 4, text: 'y', eventId: 1, app: 'Microsoft-Windows-Sysmon' }));
  // the AI text: the Ntfs row is not asked again, the Sysmon row is, with its source
  const text = (await call('GET', '/api/events/noise/text?days=7&lang=de')).data.text;
  assert.doesNotMatch(text, /^- 1 \(Microsoft-Windows-Ntfs/m);
  assert.match(text, /^- 1 \(Microsoft-Windows-Sysmon[,)]/m);
  // a rule for 1 of Sysmon does not stop leaving out 1 of another source - a rule for every 1 does
  db.prepare("INSERT INTO event_rules(name, enabled, match, channels, mode, digest_min, max_per_hour, options, created_at, updated_at) VALUES('Sysmon-Start', 1, ?, '[]', 'each', 0, 0, '{}', ?, ?)")
    .run(JSON.stringify({ eventIds: '1', source: 'Sysmon' }), ago(0), ago(0));
  assert.equal((await call('POST', '/api/events/noise/deny', { id: 1, src: 'Microsoft-Windows-Kernel-General' })).status, 200);
  const both = await call('POST', '/api/events/noise/deny', { id: 1, src: 'Microsoft-Windows-Sysmon' });
  assert.equal(both.status, 400);
  assert.match(JSON.stringify(both.data), /Sysmon-Start/);
});

test('the settings take the list with sources; a wrong entry names the field', async () => {
  const s = (await call('GET', '/api/events/senders')).data.settings;
  const put = (winDeny) => call('PUT', '/api/events/settings', { ...s, winDeny });
  const ok = await put('4624, 4634; 1@Ntfs, 7036@Service Control Manager');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.winDeny, '4624, 4634, 1@Ntfs, 7036@Service Control Manager');
  const bad = await put('4624, 1@');
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.field, 'winDeny');
  assert.equal(ctx.settings.get('events.winDeny'), '4624, 4634, 1@Ntfs, 7036@Service Control Manager', 'nothing changed');
  // a rule for event 4625 is not blocked by an entry for another number's source
  assert.ok(ctx.events.receive('syslog', '10.0.10.14', { severity: 6, text: 'started', eventId: 7036, app: 'Service Control Manager' }) === null);
  assert.ok(ctx.events.receive('syslog', '10.0.10.14', { severity: 6, text: 'other', eventId: 7036, app: 'Something Else' }));
});

test('many computers: how many sent an event is exact (not the newest 500), the rest of the senders, by type of device', async () => {
  db.prepare("INSERT INTO devices(name, ip, type, first_seen, last_seen, created_at, updated_at) VALUES('dc01', '10.0.20.1', 'server', ?, ?, ?, ?)").run(ago(0), ago(0), ago(0), ago(0));
  const dc = db.prepare("SELECT id FROM devices WHERE ip='10.0.20.1'").pluck().get();
  db.transaction(() => {
    // 1200 clients each with one 10016 now and then, a domain controller with many
    for (let i = 0; i < 1200; i++) ins.run(ago(30 + (i % 600)), `10.1.${i >> 8}.${i & 255}`, 6, `PC-${String(i).padStart(4, '0')}`, 'Microsoft-Windows-DistributedCOM', 'System', 'DCOM-Berechtigung', 10016);
    for (let i = 0; i < 900; i++) ins.run(ago(10 + (i % 300)), '10.0.20.1', 6, 'dc01', 'Microsoft-Windows-DistributedCOM', 'System', 'DCOM-Berechtigung', 10016);
  })();
  db.prepare("UPDATE events_in SET device_id = ? WHERE source_ip = '10.0.20.1'").run(dc);
  db.exec("INSERT OR REPLACE INTO event_senders(source_ip, device_id, host, first_at, last_at, last_id) SELECT source_ip, MAX(device_id), MAX(host), MIN(at), MAX(at), MAX(id) FROM events_in GROUP BY source_ip");
  while (ctx.events.countBatch() > 0);
  // and a few newer than the counts: counted from the messages
  for (let i = 0; i < 3; i++) ins.run(ago(1), `10.2.0.${i}`, 6, `PC-9${i}`, 'Microsoft-Windows-DistributedCOM', 'System', 'DCOM-Berechtigung', 10016);
  const d = (await call('GET', '/api/events/noise?days=7', undefined, { who: 'editor' })).data;
  const dcom = d.events.find((e) => e.id === 10016);
  assert.equal(dcom.computers, 1204, '1200 clients, the DC and 3 newer ones');
  assert.equal(dcom.senders.length + dcom.moreSenders, 1204);
  assert.ok(d.senderCount > 15);
  assert.equal(d.senders.length, 15);
  assert.equal(d.rest.senders, d.senderCount - 15);
  assert.equal(d.senders.reduce((a, x) => a + x.n, 0) + d.rest.n, d.total, 'the 15 and the rest are all');
  const server = d.groups.find((x) => x.type === 'server');
  assert.deepEqual([server.senders, server.n], [1, 900]);
  assert.equal(d.groups.reduce((a, x) => a + x.n, 0), d.total);
  assert.equal(d.groups.find((x) => x.type === '-').senders, d.senderCount - 1, 'the rest is not in the inventory');
  // the text for the AI chat names the number of computers
  const txt = (await call('GET', '/api/events/noise/text?days=7&lang=de', undefined, { who: 'editor' })).data;
  assert.match(JSON.stringify(txt), /von 1204 Rechnern/);
});

test('by sender a page at a time: quick filters, type of device, order, the next page', async () => {
  db.prepare("INSERT INTO events_in(at,kind,source_ip,severity,host,app,channel,text,event_id) VALUES(?, 'syslog', '10.1.0.7', 3, 'PC-0007', 'Disk', 'System', 'Fehler', 7)").run(ago(1));
  db.exec("UPDATE event_senders SET last_id = (SELECT MAX(id) FROM events_in WHERE source_ip = '10.1.0.7'), last_at = (SELECT MAX(at) FROM events_in WHERE source_ip = '10.1.0.7') WHERE source_ip = '10.1.0.7'");
  // one that has been quiet for two days
  const old = ins.run(ago(2900), '10.3.0.1', 6, 'PC-ALT', 'x', '', 'alt', null).lastInsertRowid;
  db.prepare("INSERT INTO event_senders(source_ip, host, first_at, last_at, last_id) VALUES('10.3.0.1', 'PC-ALT', ?, ?, ?)").run(ago(2900), ago(2900), old);
  ctx.events.setSenderFilter('10.0.20.1', 4, 'testadmin');
  const get = async (q) => (await call('GET', `/api/events/senders?${new URLSearchParams(q)}`, undefined, { who: 'editor' })).data;
  const first = await get({});
  assert.equal(first.senders.length, 100);
  assert.equal(first.total, first.all);
  assert.ok(first.all > 1200);
  assert.ok(first.senders[0].last_text !== undefined, 'the page has the newest message of each');
  const next = await get({ offset: 100 });
  assert.equal(next.offset, 100);
  assert.equal(new Set([...first.senders, ...next.senders].map((x) => x.source_ip)).size, 200, 'no sender twice');
  assert.deepEqual((await get({ show: 'err' })).senders.map((x) => x.source_ip), ['10.1.0.7']);
  assert.deepEqual((await get({ show: 'silent' })).senders.map((x) => x.source_ip), ['10.3.0.1']);
  assert.deepEqual((await get({ show: 'filter' })).senders.map((x) => [x.source_ip, x.filter]), [['10.0.20.1', 4]]);
  const counts = first.counts;
  assert.deepEqual([counts.err, counts.silent, counts.filter], [1, 1, 1]);
  assert.deepEqual((await get({ type: 'server' })).senders.map((x) => x.device_name), ['dc01']);
  assert.ok(first.types.some((x) => x.type === 'server' && x.n === 1));
  const busiest = await get({ sort: 'day', limit: 1 });
  assert.equal(busiest.senders[0].source_ip, '10.0.20.1');
  const named = await get({ sort: 'name', limit: 3, q: 'pc-000' });
  assert.deepEqual(named.senders.map((x) => x.host), ['PC-0000', 'PC-0001', 'PC-0002']);
  // nonsense is ignored, never an error
  assert.equal((await call('GET', '/api/events/senders?show=x&sort=y&offset=-5&limit=99999', undefined, { who: 'editor' })).status, 200);
});

test('left out already: at the end, apart, with the day it is gone; the figure of what goes by itself', async () => {
  // 59 goes into the list "never take" - its older messages are still stored
  ctx.settings.set('events.winDeny', `${ctx.settings.get('events.winDeny')}, 59`);
  // the newest one came just before it was left out (ids grow with the time, as when they arrive)
  ins.run(ago(0), '10.0.10.11', 6, 'PC-0011', 'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS', 'Application', 'RpcGetCurrentSessionCapabilities', 59);
  const d = (await call('GET', '/api/events/noise?days=7', undefined, { who: 'editor' })).data;
  const i59 = d.events.findIndex((e) => e.id === 59);
  assert.ok(i59 >= 0);
  assert.ok(d.events.slice(0, i59).every((e) => !e.denied) && d.events.slice(i59).every((e) => e.denied), 'the left-out ones last');
  const e59 = d.events[i59];
  assert.ok(d.events.some((e) => !e.denied && e.n < e59.n), 'though bigger than some of the others');
  const keep = d.keepDays;
  const newest = db.prepare('SELECT MAX(at) FROM events_in WHERE event_id = 59').pluck().get();
  assert.equal(e59.goneBy, new Date(Date.parse(newest) + keep * 86400000).toISOString());
  assert.equal(d.deniedPerDay, Math.round(d.events.filter((e) => e.denied).reduce((a, e) => a + e.n, 0) / 7));
  assert.equal(d.events.filter((e) => !e.denied).every((e) => e.goneBy === null), true);
  // the question for the AI chat leaves them out
  const txt = (await call('GET', '/api/events/noise/text?days=7&lang=de', undefined, { who: 'editor' })).data.text;
  assert.doesNotMatch(txt, /^- 59/m);
});
