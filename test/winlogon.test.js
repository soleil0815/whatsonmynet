// Windows sign-in events in notifications: account, how, why and from where instead of the start of a long text; the
// ready-made rule leaves out the computer's own service logons and "no logon server"; texts keep up to 4000 characters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { logonSummary } from '../src/lib/winlogon.js';
import { ruleMatches, cleanMatch } from '../src/eventrules.js';
import { eventText } from '../src/monitor/notify.js';
import { parseSyslog, TEXT_MAX } from '../src/events.js';
import { memoryDb } from './helpers.js';
import { migrate } from '../src/db.js';

// as NXLog sends them, line breaks already spaces (neutral example data)
const de4625 = (type, status, sub, src = '-') => `Fehler beim Anmelden eines Kontos. Antragsteller: Sicherheits-ID: S-1-5-18 Kontoname: PC-0001$ Kontodomäne: FIRMA Anmelde-ID: 0x3E7 Anmeldetyp: ${type} Konto, für das die Anmeldung fehlgeschlagen ist: Sicherheits-ID: S-1-0-0 Kontoname: m.muster Kontodomäne: FIRMA Fehlerinformationen: Fehlerursache: Unbekannter Benutzername oder ungültiges Kennwort. Status: ${status} Unterstatus: ${sub} Prozessinformationen: Aufrufprozess-ID: 0x2a4 Aufrufprozessname: C:\\Windows\\System32\\svchost.exe Netzwerkinformationen: Arbeitsstationsname: PC-0001 Quellnetzwerkadresse: ${src} Quellport: 0 Detaillierte Authentifizierungsinformationen: Anmeldeprozess: Advapi Authentifizierungspaket: Negotiate ${'Diese Ereignis wird generiert, wenn eine Anmeldeanforderung fehlschlägt. '.repeat(20)}`;
const en4625 = 'An account failed to log on. Subject: Security ID: S-1-0-0 Account Name: - Account Domain: - Logon ID: 0x0 Logon Type: 3 Account For Which Logon Failed: Security ID: S-1-0-0 Account Name: administrator Account Domain: FIRMA Failure Information: Failure Reason: Unknown user name or bad password. Status: 0xC000006D Sub Status: 0xC000006A Process Information: Caller Process ID: 0x0 Caller Process Name: - Network Information: Workstation Name: KALI Source Network Address: ::ffff:192.0.2.44 Source Port: 51234';

test('sign-in events: the summary names account, way, reason and source - German and English', () => {
  assert.equal(logonSummary(4625, de4625(5, '0xc000005e', '0x0'), 'de'), 'Konto FIRMA\\m.muster · Dienst (5) · kein Anmeldeserver erreichbar (0xC000005E) · svchost.exe · von PC-0001');
  assert.equal(logonSummary(4625, de4625(3, '0xc000006d', '0xc000006a', '10.0.10.23'), 'de'), 'Konto FIRMA\\m.muster · Netzwerk (3) · falsches Kennwort (0xC000006A) · svchost.exe · von 10.0.10.23 (PC-0001)');
  assert.equal(logonSummary(4625, en4625, 'en'), 'account FIRMA\\administrator · network (3) · wrong password (0xC000006A) · from 192.0.2.44 (KALI)');
  assert.equal(logonSummary(4740, 'Ein Benutzerkonto wurde gesperrt. Antragsteller: Sicherheits-ID: S-1-5-18 Kontoname: DC01$ Kontodomäne: FIRMA Gesperrtes Konto: Sicherheits-ID: S-1-5-21-1 Kontoname: m.muster Zusätzliche Informationen: Aufrufername: PC-0001', 'de'),
    'Konto m.muster gesperrt · ausgelöst von PC-0001');
  assert.equal(logonSummary(4771, 'Kerberos pre-authentication failed. Account Information: Security ID: S-1-5-21-1 Account Name: m.muster Service Information: Service Name: krbtgt/FIRMA.LOCAL Network Information: Client Address: ::ffff:10.0.10.23 Client Port: 50000 Additional Information: Ticket Options: 0x40810010 Failure Code: 0x18', 'en'),
    'account m.muster · wrong password (0x18) · from 10.0.10.23');
  assert.equal(logonSummary(4776, 'Der Computer hat versucht, die Anmeldeinformationen eines Kontos zu überprüfen. Authentifizierungspaket: MICROSOFT_AUTHENTICATION_PACKAGE_V1_0 Anmeldekonto: m.muster Quellarbeitsstation: PC-0001 Fehlercode: 0xc0000064', 'de'),
    'Konto m.muster · Benutzer unbekannt (0xC0000064) · von PC-0001');
  assert.equal(logonSummary(1116, 'Malware found', 'de'), '', 'other events keep their text');
  assert.equal(logonSummary(4625, 'Fehler beim Anmelden eines Kontos.', 'de'), '', 'too little to say anything');
});

test('the notification shows the summary instead of the cut start of the text', () => {
  const e = { at: '2026-11-16T12:19:00Z', event_id: 4625, app: 'Microsoft-Windows-Security-Auditing', host: 'PC-0001', text: de4625(3, '0xc000006d', '0xc000006a', '10.0.10.23') };
  const t = eventText({ kind: 'logRule', rule: { name: 'Anmeldungen' }, events: [e] }, 'de');
  assert.match(t, /Konto FIRMA\\m\.muster · Netzwerk \(3\) · falsches Kennwort/);
  assert.doesNotMatch(t, /Antragsteller/);
});

test('texts are kept up to 4000 characters - the reason of a failed sign-in is no longer cut off', () => {
  assert.equal(TEXT_MAX, 4000);
  const text = de4625(3, '0xc000006d', '0xc000006a');
  assert.ok(text.length > 1500 && text.length < 4000);
  const ev = parseSyslog(Buffer.from(`<13>Nov 16 13:19:00 PC-0001 ERROR 4625 ${text}`), '10.0.10.5');
  assert.ok(ev.text.includes('Unterstatus: 0xc000006a'), 'the end is there');
  assert.equal(parseSyslog(Buffer.from(`<13>Nov 16 13:19:00 pc x ${'y'.repeat(6000)}`), '10.0.10.5').text.length <= 4000, true);
});

test('ready-made rule "failed sign-ins": service logons and "no logon server" left out, wrong passwords counted', () => {
  const m = cleanMatch({ eventIds: '4625', source: 'Security-Auditing', notWords: 'Anmeldetyp: 5, Logon Type: 5, 0xc000005e' });
  const row = (text) => ({ kind: 'syslog', severity: 3, event_id: 4625, app: '', channel: '', text, source_ip: '10.0.10.5', host: 'PC-0001' });
  assert.equal(ruleMatches(m, row(de4625(5, '0xc000006d', '0xc0000064'))), false, 'the computer\'s own service logon');
  assert.equal(ruleMatches(m, row(de4625(2, '0xc000005e', '0x0'))), false, 'laptop at start-up before the VPN');
  assert.equal(ruleMatches(m, row(de4625(3, '0xc000006d', '0xc000006a'))), true, 'wrong password over the network');
  assert.equal(ruleMatches(m, row(en4625)), true);
  assert.equal(ruleMatches(m, row(en4625.replace('Logon Type: 3', 'Logon Type: 5'))), false);
});

test('migration 36: the rule as it was made gets the exceptions, a rule changed by hand stays', () => {
  const db = memoryDb();
  const add = (name, match) => db.prepare("INSERT INTO event_rules(name, match, created_at, updated_at) VALUES(?, ?, 'x', 'x')").run(name, JSON.stringify(match));
  const base = { kind: '', maxSeverity: 7, deviceId: null, eventIds: '4625', from: [], channel: '', source: 'Security-Auditing', words: [], notWords: [], regex: '' };
  add('Vorlage', base);
  add('Eigene Ausnahme', { ...base, notWords: ['HW030$'] });
  add('Eigene Wörter', { ...base, words: ['administrator'] });
  add('Andere Nummer', { ...base, eventIds: '4625, 4771' });
  db.pragma('user_version = 35');
  migrate(db, { quiet: true });
  const nw = Object.fromEntries(db.prepare('SELECT name, match FROM event_rules').all().map((r) => [r.name, JSON.parse(r.match).notWords]));
  assert.deepEqual(nw, { 'Vorlage': ['Anmeldetyp: 5', 'Logon Type: 5', '0xc000005e'], 'Eigene Ausnahme': ['HW030$'], 'Eigene Wörter': [], 'Andere Nummer': [] });
  const r = JSON.parse(db.prepare("SELECT match FROM event_rules WHERE name='Vorlage'").get().match);
  assert.equal(r.eventIds, '4625', 'the rest of the rule stays');
});
