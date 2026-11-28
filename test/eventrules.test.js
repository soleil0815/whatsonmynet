// Event rules: Windows events (NXLog) are understood in all three shapes, a rule picks messages by event id, log,
// source, sender and words, and sends them only to the channels it names - one by one up to a limit per hour, beyond
// it and in "digest" mode collected; nothing is lost when the channel fails, and a standby sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { parseSyslog, windowsFields } from '../src/events.js';
import { createEventRules, cleanMatch, ruleMatches, parseEventIds } from '../src/eventrules.js';
import { createChannels, eventText } from '../src/monitor/notify.js';
import { forgetChannel, forgetDevices } from '../src/lib/idlists.js';
import { LOCAL_TABLES } from '../src/failover.js';

const DEFENDER = 'Microsoft Defender Antivirus hat Schadsoftware oder andere potenziell unerwünschte Software erkannt. Name: Virus:DOS/EICAR_Test_File';

test('Windows events: readable bracket format, JSON, NXLog line - and plain syslog stays as it was', () => {
  const r = parseSyslog(`<12>Nov 15 10:00:00 PC-0001 Microsoft-Windows-Windows Defender: [1116] [Microsoft-Windows-Windows Defender/Operational] ${DEFENDER}`);
  assert.deepEqual([r.host, r.app, r.eventId, r.channel, r.severity, r.text], ['PC-0001', 'Microsoft-Windows-Windows Defender', 1116, 'Microsoft-Windows-Windows Defender/Operational', 4, DEFENDER]);
  const j = parseSyslog(`<14>1 2026-11-15T10:00:00Z PC-0001 Microsoft-Windows-Security-Auditing 4 - - ${JSON.stringify({ Hostname: 'PC-0001.firma.local', EventType: 'AUDIT_SUCCESS', Severity: 'INFO', EventID: 4740,
    SourceName: 'Microsoft-Windows-Security-Auditing', Channel: 'Security', Domain: 'FIRMA', AccountName: 'DC01$', TargetUserName: 'max', TargetDomainName: 'FIRMA', Message: 'Ein Benutzerkonto wurde gesperrt.\r\n\r\nAntragsteller: …', param1: 'x' })}`);
  assert.deepEqual([j.host, j.eventId, j.channel, j.account, j.severity, j.text], ['PC-0001.firma.local', 4740, 'Security', 'FIRMA\\max', 6, 'Ein Benutzerkonto wurde gesperrt. Antragsteller: …']);
  assert.equal(JSON.stringify(j).includes('param1'), false, 'the other fields of the event are not shown');
  assert.equal(parseSyslog(`<14>1 2026-11-15T10:00:00Z PC-0001 x - - - ${JSON.stringify({ EventID: 4625, EventType: 'AUDIT_FAILURE', Severity: 'INFO', Message: 'failed' })}`).severity, 4, 'a failed logon is a warning');
  const l = parseSyslog('2026-11-15 10:00:00 PC-0001 WARNING 865 Der Zugriff auf C:\\Users\\max\\x.exe wurde eingeschränkt.');
  assert.deepEqual([l.host, l.eventId, l.severity, l.text], ['PC-0001', 865, 4, 'Der Zugriff auf C:\\Users\\max\\x.exe wurde eingeschränkt.']);
  assert.deepEqual(parseSyslog('<13>Oct 11 22:14:15 fs01 smartd[512]: Device /dev/sda [SAT], 8 Currently unreadable sectors'),
    { severity: 5, facility: 1, host: 'fs01', app: 'smartd', text: 'Device /dev/sda [SAT], 8 Currently unreadable sectors' });
  // Fluent Bit (winevtlog, "Format json_lines" over TCP): no syslog head, the level as a number, the audit result in
  // the keywords
  const fb = (x) => JSON.stringify({ date: 1763200800.123, ProviderName: 'Microsoft-Windows-Security-Auditing', ProviderGuid: '{54849625-5478-4994-A5BA-3E3B0328C30D}',
    Qualifiers: '', EventID: 4625, Version: 0, Level: 0, Task: 12544, Opcode: 0, Keywords: '0x8010000000000000', TimeCreated: '2026-11-15 10:00:00 +0100', EventRecordID: 99,
    Channel: 'Security', Computer: 'PC-0001.firma.local', Message: 'Fehler beim Anmelden eines Kontos.\r\n\r\nKontoname: max', ...x });
  const f = parseSyslog(fb({}));
  assert.deepEqual([f.host, f.app, f.eventId, f.channel, f.severity, f.text], ['PC-0001.firma.local', 'Microsoft-Windows-Security-Auditing', 4625, 'Security', 4, 'Fehler beim Anmelden eines Kontos. Kontoname: max']);
  assert.equal(parseSyslog(fb({ EventID: 4624, Keywords: '0x8020000000000000' })).severity, 6, 'audit success');
  assert.deepEqual([2, 3, 4, 5].map((lv) => parseSyslog(fb({ ProviderName: 'Service Control Manager', EventID: 7031, Level: lv, Keywords: '0x8080000000000000', Channel: 'System' })).severity), [3, 4, 6, 7]);
  assert.equal(parseSyslog(fb({ Level: 1, Keywords: '0x80000000000000' })).severity, 2, 'critical');
  // the account: Fluent Bit sends only the SID, NXLog's readable form none - taken from the text, after its own
  // heading (the first "Kontoname" is the one asking, here the domain controller itself)
  const failed = 'Fehler beim Anmelden eines Kontos.\r\n\r\nAntragsteller:\r\n\tSicherheits-ID:\t\tS-1-5-18\r\n\tKontoname:\t\tDC01$\r\n\tKontodomäne:\t\tFIRMA\r\n\r\nAnmeldetyp:\t\t\t3\r\n\r\nKonto, für das die Anmeldung fehlgeschlagen ist:\r\n\tSicherheits-ID:\t\tS-1-0-0\r\n\tKontoname:\t\tmax\r\n\tKontodomäne:\t\tFIRMA';
  assert.equal(parseSyslog(fb({ Message: failed, UserID: 'S-1-5-18' })).account, 'FIRMA\\max');
  assert.equal(parseSyslog(`<14>Nov 28 10:00:00 DC01.firma.local Microsoft-Windows-Security-Auditing[640]: [4625] [Security] ${failed.replace(/\s+/g, ' ')}`).account, 'FIRMA\\max', 'NXLog, readable form');
  const locked = 'Ein Benutzerkonto wurde gesperrt.\r\n\r\nAntragsteller:\r\n\tKontoname:\t\tDC01$\r\n\tKontodomäne:\t\tFIRMA\r\n\r\nGesperrtes Konto:\r\n\tSicherheits-ID:\t\tS-1-5-21-1\r\n\tKontoname:\t\tmax\r\n\r\nZusätzliche Informationen:\r\n\tName des aufrufenden Computers:\tPC-0011';
  assert.equal(parseSyslog(fb({ EventID: 4740, Message: locked })).account, 'max', '4740: the computer that follows is no domain');
  const created = 'A user account was created.\r\n\r\nSubject:\r\n\tAccount Name:\t\ttestadmin\r\n\tAccount Domain:\t\tFIRMA\r\n\r\nNew Account:\r\n\tAccount Name:\t\tm.muster\r\n\tAccount Domain:\t\tFIRMA';
  assert.equal(parseSyslog(fb({ EventID: 4720, Message: created })).account, 'FIRMA\\m.muster', 'not the administrator who did it');
  assert.equal(parseSyslog(fb({ EventID: 4776, Message: 'Anmeldeinformationen überprüft.\r\nAnmeldekonto:\tmax\r\nQuellarbeitsstation:\tPC-0011\r\nFehlercode:\t0xc000006a' })).account, 'max');
  // other events: nothing guessed; a field that is sent (NXLog JSON) stays as it is
  assert.equal(parseSyslog(fb({ EventID: 7036, Message: 'Kontoname: max' })).account, '');
  assert.equal(parseSyslog(fb({ Message: failed, TargetUserName: 'm.muster', TargetDomainName: 'FIRMA' })).account, 'FIRMA\\m.muster');
  // NXLog's readable form as it arrives (to_syslog_bsd): the source as tag with the process id - also a source longer
  // than the 32 characters of RFC 3164, and one with a space
  const ts = parseSyslog('<14>Nov 17 18:07:00 PC-0002.firma.local Microsoft-Windows-TerminalServices-LocalSessionManager[1564]: [59] [Microsoft-Windows-TerminalServices-LocalSessionManager/Operational] RpcGetCurrentSessionCapabilities von "C:\\Programme\\x.exe" ( #0x1/0x6856 )');
  assert.deepEqual([ts.host, ts.app, ts.eventId, ts.channel, ts.text], ['PC-0002.firma.local', 'Microsoft-Windows-TerminalServices-LocalSessionManager', 59,
    'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational', 'RpcGetCurrentSessionCapabilities von "C:\\Programme\\x.exe" ( #0x1/0x6856 )']);
  const dp = parseSyslog(`<12>Nov 17 18:07:00 PC-0001 Microsoft-Windows-Windows Defender[3120]: [1116] [Microsoft-Windows-Windows Defender/Operational] ${DEFENDER}`);
  assert.deepEqual([dp.app, dp.eventId, dp.channel, dp.text], ['Microsoft-Windows-Windows Defender', 1116, 'Microsoft-Windows-Windows Defender/Operational', DEFENDER]);
  const kc = parseSyslog('<14>Nov 17 15:50:00 PC-0001 Microsoft-Windows-Kernel-Cache[4]: [101] [Microsoft-Windows-Kernel-Cache/Operational] Initialisierte VolumeCacheMap');
  assert.deepEqual([kc.app, kc.eventId], ['Microsoft-Windows-Kernel-Cache', 101]);
  assert.equal(windowsFields('{"no":"event id"}'), null);
  assert.equal(windowsFields('{broken'), null);
  assert.equal(windowsFields('[12] not a log'), null);
});

test('rule filter: ids and ranges, source and log, unknown origin, senders, words', () => {
  assert.deepEqual(parseEventIds('1116, 1117 865-868'), [[1116, 1116], [1117, 1117], [865, 868]]);
  assert.equal(parseEventIds('1116, abc'), null);
  assert.throws(() => cleanMatch({ eventIds: '5-1' }), /err.ruleEventIds/);
  assert.throws(() => cleanMatch({}), /err.ruleEmpty/);
  assert.throws(() => cleanMatch({ words: Array.from({ length: 21 }, (_, i) => `w${i}`) }), /err.ruleTooMany/);
  const m = { ...cleanMatch({ eventIds: '1116,1117', source: 'Defender' }) };
  assert.equal(m.eventIds, '1116, 1117');
  const row = (x) => ({ kind: 'syslog', severity: 4, source_ip: '10.0.10.21', host: 'PC-0001', device_name: '', app: 'Microsoft-Windows-Windows Defender', channel: 'Microsoft-Windows-Windows Defender/Operational', event_id: 1116, text: DEFENDER, account: '', device_id: null, ...x });
  assert.equal(ruleMatches(m, row()), true);
  assert.equal(ruleMatches(m, row({ event_id: 1118 })), false);
  assert.equal(ruleMatches(m, row({ app: 'Something-Else', channel: 'Application' })), false, 'the same id from another source');
  assert.equal(ruleMatches(m, row({ app: '', channel: '' })), true, 'NXLog without source and log: the id decides');
  assert.equal(ruleMatches(m, row({ event_id: null })), false);
  const srp = cleanMatch({ eventIds: '865-868, 8004', from: 'pc-00, 10.0.20.', words: 'eingeschränkt, blocked', notWords: 'Test' });
  assert.equal(ruleMatches(srp, row({ event_id: 866, app: '', channel: '', text: 'Zugriff auf x.exe wurde eingeschränkt' })), true);
  assert.equal(ruleMatches(srp, row({ event_id: 866, text: 'Zugriff auf x.exe wurde eingeschränkt (Test)' })), false, 'a word that must not be there');
  assert.equal(ruleMatches(srp, row({ event_id: 866, host: 'SRV01', text: 'wurde eingeschränkt' })), false, 'another sender');
  assert.equal(ruleMatches(srp, row({ event_id: 8004, host: '', source_ip: '10.0.20.5', text: 'was blocked' })), true);
  const sev = cleanMatch({ maxSeverity: 3, kind: 'syslog' });
  assert.equal(ruleMatches(sev, row({ severity: 3 })), true);
  assert.equal(ruleMatches(sev, row({ severity: 4 })), false);
  assert.equal(ruleMatches(sev, row({ kind: 'trap', severity: 2 })), false);
});

function setup() {
  const db = memoryDb();
  const sent = []; let fail = false;
  const channels = { notifyIds: async (ids, ev) => { if (!ids.length) throw new Error('never the default channels'); if (fail) return []; sent.push({ ids, ev }); return ['Ticket']; } };
  let t = Date.parse('2026-11-15T10:00:00Z');
  const now = () => new Date(t);
  const rules = createEventRules({ db, channels, now });
  const chan = Number(db.prepare("INSERT INTO channels(name,type,config,language,is_default,enabled,created_at) VALUES('Ticket','email','x','de',0,1,?)").run(now().toISOString()).lastInsertRowid);
  let n = 0;
  const event = (x = {}) => {
    const r = { at: now().toISOString(), kind: 'syslog', source_ip: '10.0.10.21', device_id: null, severity: 4, facility: 1, host: 'PC-0001', app: 'Microsoft-Windows-Windows Defender',
      oid: '', text: `${DEFENDER} #${++n}`, event_id: 1116, channel: 'Microsoft-Windows-Windows Defender/Operational', account: '', ...x };
    r.id = Number(db.prepare('INSERT INTO events_in(at,kind,source_ip,device_id,severity,facility,host,app,oid,text,event_id,channel,account) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.at, r.kind, r.source_ip, r.device_id, r.severity, r.facility, r.host, r.app, r.oid, r.text, r.event_id, r.channel, r.account).lastInsertRowid);
    return r;
  };
  const tick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  return { db, rules, chan, event, sent, now, tick, later: (ms) => { t += ms; }, failing: (v) => { fail = v; } };
}

test('rules: only named channels, single up to the limit, the rest collected, digest mode', async () => {
  const { db, rules, chan, event, sent, tick, later } = setup();
  assert.throws(() => rules.create({ name: 'Virus', match: { eventIds: '1116' }, channels: [] }), /err.ruleChannels/, 'never the default channels');
  assert.throws(() => rules.create({ name: 'Virus', match: { eventIds: '1116' }, channels: [999] }), /err.ruleChannels/);
  const virus = rules.create({ name: 'Virenfund', match: { eventIds: '1116, 1117', source: 'Defender' }, channels: [chan], max_per_hour: 2, digest_min: 15 });
  rules.onEvent(event());
  assert.equal(sent.length, 0, 'a standby / a stopped installation sends nothing');
  rules.start();
  try {
    rules.onEvent(event({ event_id: 4624, app: 'Microsoft-Windows-Security-Auditing', channel: 'Security' }));
    for (let i = 0; i < 4; i++) rules.onEvent(event());
    await tick();
    assert.equal(sent.length, 2, 'two single notifications, then the hourly limit');
    assert.deepEqual(sent[0].ids, [chan]);
    assert.equal(sent[0].ev.kind, 'logRule');
    assert.equal(eventText(sent[0].ev, 'de'), `📋 Virenfund: PC-0001 - Ereignis 1116 · Microsoft-Windows-Windows Defender: ${DEFENDER} #3`);
    assert.equal(await rules.flush(), 0, 'what is beyond the limit waits for the collecting time');
    later(16 * 60000);
    assert.equal(await rules.flush(), 1);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].ev.count, 2);
    assert.match(eventText(sent[2].ev, 'de'), /^📋 Virenfund: 2 Meldungen seit /);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM event_rule_hits WHERE sent_at IS NULL').get().n, 0);
    assert.equal(rules.list()[0].hits24h, 4, 'the message before the start does not count');

    const digest = rules.create({ name: 'Fehler', match: { maxSeverity: 3 }, channels: [chan], mode: 'digest', digest_min: 5 });
    rules.onEvent(event({ severity: 3, event_id: null, app: 'kernel', channel: '', text: 'I/O error' }));
    rules.onEvent(event({ severity: 2, event_id: null, app: 'kernel', channel: '', text: 'disk failed' }));
    await tick();
    assert.equal(sent.length, 3, 'digest: nothing at once');
    later(6 * 60000);
    await rules.flush();
    assert.equal(sent.length, 4);
    assert.deepEqual([sent[3].ev.rule.name, sent[3].ev.count, sent[3].ev.events.map((e) => e.text)], ['Fehler', 2, ['I/O error', 'disk failed']]);

    // switched off: what still waits is dropped, nothing comes any more
    rules.update(digest.id, { enabled: false });
    rules.onEvent(event({ severity: 2, event_id: null, app: 'kernel', channel: '', text: 'again' }));
    later(10 * 60000); await rules.flush();
    assert.equal(sent.length, 4);
    rules.remove(virus.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM event_rule_hits WHERE rule_id=?').get(virus.id).n, 0);
  } finally { rules.stop(); }
});

test('rules: a channel that fails - tried again every 5 minutes, given up after an hour, nothing lost before', async () => {
  const { db, rules, chan, event, sent, tick, later, failing } = setup();
  rules.create({ name: 'Konto gesperrt', match: { eventIds: '4740' }, channels: [chan], digest_min: 1 });
  rules.start();
  try {
    failing(true);
    rules.onEvent(event({ event_id: 4740, app: 'Microsoft-Windows-Security-Auditing', channel: 'Security', text: 'Ein Benutzerkonto wurde gesperrt.' }));
    await tick();
    assert.equal(sent.length, 0);
    later(2 * 60000); await rules.flush();
    assert.equal(sent.length, 0, 'not before the 5 minutes');
    failing(false);
    later(4 * 60000); await rules.flush();
    assert.equal(sent.length, 1, 'sent once the channel works again');
    assert.equal(sent[0].ev.count, 1);
    assert.match(eventText(sent[0].ev, 'en'), /^📋 Konto gesperrt: PC-0001 - Event 4740 · Microsoft-Windows-Security-Auditing: Ein Benutzerkonto wurde gesperrt\.$/, 'one message reads like a single one');

    failing(true);
    rules.onEvent(event({ event_id: 4740, app: 'Microsoft-Windows-Security-Auditing', channel: 'Security', text: 'again' }));
    await tick();
    for (let i = 0; i < 14; i++) { later(5 * 60000 + 1000); await rules.flush(); }
    const h = db.prepare('SELECT sent_at, failed FROM event_rule_hits ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual([!!h.sent_at, h.failed], [true, 1], 'given up after an hour');
    assert.equal(rules.list()[0].failed24h, 1);
  } finally { rules.stop(); }
});

test('rules: a deleted channel or device switches the rule off; hits stay with the installation', () => {
  const { db, rules, chan } = setup();
  const dev = Number(db.prepare("INSERT INTO devices(name, ip, type, created_at, updated_at) VALUES('PC-0001','10.0.10.21','pc',?,?)").run('2026-11-15', '2026-11-15').lastInsertRowid);
  const a = rules.create({ name: 'A', match: { eventIds: '1116' }, channels: [chan] });
  const b = rules.create({ name: 'B', match: { deviceId: dev, maxSeverity: 3 }, channels: [chan] });
  forgetDevices(db, [dev]);
  assert.deepEqual([rules.get(b.id).enabled, rules.get(b.id).match.deviceId], [false, null]);
  assert.equal(rules.get(a.id).enabled, true);
  forgetChannel(db, null, chan);
  assert.deepEqual([rules.get(a.id).enabled, rules.get(a.id).channels], [false, []]);
  assert.ok(db.prepare("SELECT 1 FROM ev.sqlite_master WHERE name='event_rule_hits'").get(), 'what was sent stays with the installation, in the messages file');
  assert.ok(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='event_rules'").get() && !LOCAL_TABLES.has('event_rules'), 'the rules go to the standby');
});

test('notifications: mail for the ticket system - subject, details, collected list; webhook with the fields', async () => {
  const db = memoryDb();
  const mails = [];
  const ch = createChannels(db, { send: async (m) => { mails.push(m); } });
  const mail = ch.create({ name: 'Ticket', type: 'email', config: { to: 'ticket@firma.local', sender: 'WhatsOnMyNet' } });
  const e = { at: '2026-11-15T10:00:00Z', kind: 'syslog', source_ip: '10.0.10.21', host: 'PC-0001', device_name: 'PC-0001', severity: 4, event_id: 1116,
    channel: 'Microsoft-Windows-Windows Defender/Operational', app: 'Microsoft-Windows-Windows Defender', account: 'NT AUTHORITY\\SYSTEM', text: DEFENDER };
  await ch.notifyIds([mail.id], { kind: 'logRule', rule: { id: 1, name: 'Virenfund' }, events: [e], count: 1, at: e.at });
  assert.equal(mails[0].to, 'ticket@firma.local');
  assert.match(mails[0].subject, /^WhatsOnMyNet: Virenfund: PC-0001 - Ereignis 1116/);
  for (const l of ['Absender: PC-0001 · 10.0.10.21', 'Schweregrad: Warnung', 'Protokoll: Microsoft-Windows-Windows Defender/Operational', 'Konto: NT AUTHORITY\\SYSTEM', DEFENDER]) assert.ok(mails[0].text.includes(l), l);
  const many = Array.from({ length: 50 }, (_, i) => ({ ...e, text: `msg ${i}` }));
  await ch.notifyIds([mail.id], { kind: 'logRule', rule: { id: 1, name: 'Virenfund' }, events: many, count: 73, since: e.at, at: e.at });
  assert.match(mails[1].subject, /Virenfund: 73 Meldungen seit/);
  assert.ok(mails[1].text.includes('… und 23 weitere'));
  assert.equal(mails[1].text.split('\n').filter((x) => x.startsWith('• ')).length, 50);
});

test('API: editors manage rules, viewers do not; "test" shows what a filter would have matched', async () => {
  const { startApp } = await import('./helpers.js');
  const app = await startApp();
  const { call, ctx } = app;
  try {
    assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
    ctx.users.create({ username: 'lisa', password: 'Sicher-Passwort-2', role: 'viewer' });
    await call('POST', '/api/login', { username: 'lisa', password: 'Sicher-Passwort-2' }, { who: 'viewer' });
    const mail = ctx.channels.create({ name: 'Ticket', type: 'email', config: { to: 'ticket@firma.local' } });
    ctx.events.receive('syslog', '10.0.10.21', parseSyslog(`<12>Nov 15 10:00:00 PC-0001 Microsoft-Windows-Windows Defender: [1116] [Microsoft-Windows-Windows Defender/Operational] ${DEFENDER}`));
    ctx.events.receive('syslog', '10.0.10.21', parseSyslog('<14>Nov 15 10:00:01 PC-0001 Service Control Manager: [7036] [System] Der Dienst wurde gestartet.'));
    const list = (await call('GET', '/api/events?q=1116')).data.list;
    assert.deepEqual(list.map((r) => [r.event_id, r.channel, r.app]), [[1116, 'Microsoft-Windows-Windows Defender/Operational', 'Microsoft-Windows-Windows Defender']], 'a number finds the event id');
    const t = await call('POST', '/api/event-rules/test', { match: { eventIds: '1116-1117', source: 'Defender' } });
    assert.deepEqual([t.status, t.data.count, t.data.list[0].text], [200, 1, DEFENDER]);
    assert.equal((await call('POST', '/api/event-rules', { name: 'x', match: { eventIds: '1116' }, channels: [mail.id] }, { who: 'viewer' })).status, 403);
    assert.equal((await call('GET', '/api/event-rules', undefined, { who: 'viewer' })).status, 403);
    const bad = await call('POST', '/api/event-rules', { name: 'Virenfund', match: { eventIds: '1116' }, channels: [] });
    assert.deepEqual([bad.status, bad.data.error.code], [400, 'err.ruleChannels']);
    const ok = await call('POST', '/api/event-rules', { name: 'Virenfund', match: { eventIds: '1116, 1117', source: 'Defender' }, channels: [mail.id] });
    assert.equal(ok.status, 201);
    assert.equal((await call('PUT', `/api/event-rules/${ok.data.id}`, { enabled: false })).data.enabled, false);
    assert.equal((await call('GET', '/api/event-rules')).data[0].name, 'Virenfund');
    // on/off from the list: editors only, nothing else of the rule changes
    assert.equal((await call('POST', `/api/event-rules/${ok.data.id}/enabled`, { enabled: true }, { who: 'viewer' })).status, 403);
    const on = await call('POST', `/api/event-rules/${ok.data.id}/enabled`, { enabled: true });
    assert.deepEqual([on.status, on.data.enabled, on.data.match.eventIds], [200, true, '1116, 1117']);
    assert.equal((await call('POST', `/api/event-rules/${ok.data.id}/enabled`, {})).data.enabled, false, 'only true switches on');
    assert.equal((await call('POST', '/api/event-rules/9999/enabled', { enabled: true })).status, 404);
    assert.equal((await call('DELETE', `/api/event-rules/${ok.data.id}`)).status, 200);
    // expressions: checked for shape and for speed before saving (and before a test)
    const rev = (reversed) => [...reversed].reverse().join(''); // deliberately bad expressions, kept reversed (test data)
    const unsafe = await call('POST', '/api/event-rules', { name: 'x', match: { regex: rev('$+)+a(') }, channels: [mail.id] });
    assert.deepEqual([unsafe.status, unsafe.data.error.code, unsafe.data.error.field], [400, 'err.regexUnsafe', 'regex']);
    const slow = await call('POST', '/api/event-rules/test', { match: { regex: rev('$x*w\\*w\\*w\\*w\\*w\\^') } });
    assert.deepEqual([slow.status, slow.data.error.code], [400, 'err.regexSlow']);
    const closeBad = await call('POST', '/api/event-rules', { name: 'x', match: { words: 'down' }, channels: [mail.id], state: { open: true, closeRegex: rev('*)*x(') } });
    assert.equal(closeBad.data.error.field, 'closeRegex');
    // open events: only for editors; acknowledge and close
    const port = await call('POST', '/api/event-rules', { name: 'Ports', match: { regex: 'Port (\\d+) link down' }, channels: [mail.id], state: { open: true, closeRegex: 'Port (\\d+) link up' } });
    assert.equal(port.status, 201);
    assert.equal((await call('GET', '/api/events/open', undefined, { who: 'viewer' })).status, 403);
    ctx.eventRules.start();
    ctx.events.receive('syslog', '10.0.0.5', parseSyslog('<12>Nov 15 10:00:00 sw01 PORT: Port 7 link down'));
    const open = await call('GET', '/api/events/open');
    assert.deepEqual([open.data.open, open.data.list[0].key, open.data.list[0].rule_name], [1, '7', 'Ports']);
    assert.equal((await call('POST', `/api/events/open/${open.data.list[0].id}/ack`)).status, 200);
    assert.equal((await call('POST', `/api/events/open/${open.data.list[0].id}/ack`)).status, 404, 'already acknowledged');
    assert.equal((await call('POST', `/api/events/open/${open.data.list[0].id}/close`)).status, 200);
    assert.equal((await call('GET', '/api/events/open')).data.open, 0);
    ctx.eventRules.stop();
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM audit WHERE action LIKE 'eventrule.%'").get().n, 6, 'also the two switches');
  } finally { ctx.events.stop(); await app.close(); }
});
