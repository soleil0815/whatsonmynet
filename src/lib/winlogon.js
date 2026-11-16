// Windows sign-in events in a notification: instead of the first 200 characters of a long text ("Fehler beim Anmelden
// eines Kontos. Antragsteller: Sicherheits-ID: …") the few things that matter - which account, how (service, network,
// remote desktop …), why it failed and from where. Read from the text of the event as Windows writes it, German or
// English (NXLog sends the rendered message); whitespace is already single spaces (events.js). Anything not found is
// left out; an event that is not one of these, or a text without the fields, gives ''.

const T = {
  de: {
    account: 'Konto', locked: 'Konto {a} gesperrt', from: 'von', by: 'ausgelöst von',
    type: { 2: 'Anmeldung am Gerät', 3: 'Netzwerk', 4: 'Aufgabe', 5: 'Dienst', 7: 'Entsperren', 8: 'Netzwerk (Klartext)', 9: 'andere Anmeldedaten', 10: 'Remotedesktop', 11: 'zwischengespeichert' },
    status: {
      C000006A: 'falsches Kennwort', C0000064: 'Benutzer unbekannt', C000005E: 'kein Anmeldeserver erreichbar', C0000234: 'Konto gesperrt',
      C0000072: 'Konto deaktiviert', C000006F: 'außerhalb der erlaubten Zeit', C0000070: 'von diesem Rechner nicht erlaubt', C0000071: 'Kennwort abgelaufen',
      C0000193: 'Konto abgelaufen', C0000224: 'Kennwort muss geändert werden', C000015B: 'Anmeldeart nicht erlaubt', C00000DC: 'Anmeldeserver nicht bereit',
      C0000133: 'Uhrzeit weicht ab', C000018D: 'Vertrauensstellung fehlgeschlagen', C000006D: 'Anmeldung fehlgeschlagen', C0000413: 'Anmeldung nicht erlaubt (Firewall der Authentifizierung)',
    },
    krb: { '0x18': 'falsches Kennwort', '0x6': 'Benutzer unbekannt', '0x12': 'Konto gesperrt, deaktiviert oder abgelaufen', '0x17': 'Kennwort abgelaufen', '0x25': 'Uhrzeit weicht ab' },
  },
  en: {
    account: 'account', locked: 'account {a} locked out', from: 'from', by: 'caused by',
    type: { 2: 'sign-in at the device', 3: 'network', 4: 'task', 5: 'service', 7: 'unlock', 8: 'network (clear text)', 9: 'other credentials', 10: 'remote desktop', 11: 'cached' },
    status: {
      C000006A: 'wrong password', C0000064: 'unknown user', C000005E: 'no logon server reachable', C0000234: 'account locked out',
      C0000072: 'account disabled', C000006F: 'outside allowed hours', C0000070: 'not allowed from this computer', C0000071: 'password expired',
      C0000193: 'account expired', C0000224: 'password must be changed', C000015B: 'logon type not granted', C00000DC: 'logon server not ready',
      C0000133: 'clock skew', C000018D: 'trust relationship failed', C000006D: 'logon failed', C0000413: 'not allowed (authentication firewall)',
    },
    krb: { '0x18': 'wrong password', '0x6': 'unknown user', '0x12': 'account locked out, disabled or expired', '0x17': 'password expired', '0x25': 'clock skew' },
  },
};

// The value after a label: one word (names, addresses, codes) - "-" counts as empty
function after(text, labels, from = 0) {
  const re = new RegExp(`(?:^|[\\s:])(?:${labels})\\s*:\\s*(\\S+)`, 'i');
  const m = re.exec(text.slice(from));
  return m && m[1] !== '-' ? m[1] : '';
}
const at = (text, labels) => { const m = new RegExp(`(?:${labels})\\s*:`, 'i').exec(text); return m ? m.index + m[0].length : -1; };
const hex = (v) => { const m = /^0x([0-9a-f]+)$/i.exec(v || ''); return m ? m[1].toUpperCase().padStart(8, '0') : ''; };
const exe = (text) => { const m = /(?:Aufruferprozessname|Aufrufprozessname|Name des Aufruferprozesses|Caller Process Name|Prozessname|Process Name)\s*:\s*(.+?\.exe)\b/i.exec(text); return m ? m[1].split('\\').pop() : ''; };
const addr = (v) => v.replace(/^::ffff:/i, '');

const ACCOUNT = 'Kontoname|Account Name';
const DOMAIN = 'Kontodomäne|Account Domain';

/** Short line for a Windows sign-in event (4625, 4740, 4771, 4776), or '' */
export function logonSummary(eventId, text, lang = 'de') {
  const L = T[lang === 'en' ? 'en' : 'de'];
  const s = String(text || '');
  const id = Number(eventId);
  const reason = (code) => { const k = hex(code); return k ? `${L.status[k] || 'Status'} (0x${k})` : ''; };
  let parts = [];
  if (id === 4625) {
    // the account that failed comes after its own heading - the first "Kontoname" is the one asking (often SYSTEM)
    const p = at(s, 'Konto, für das die Anmeldung fehlgeschlagen ist|Account For Which Logon Failed');
    const name = p >= 0 ? after(s, ACCOUNT, p) : '';
    const dom = p >= 0 ? after(s, DOMAIN, p) : '';
    const type = after(s, 'Anmeldetyp|Logon Type');
    const sub = after(s, 'Unterstatus|Sub Status');
    const status = after(s, '(?<![A-Za-z])Status');
    const src = addr(after(s, 'Quellnetzwerkadresse|Source Network Address'));
    const ws = after(s, 'Arbeitsstationsname|Workstation Name');
    parts = [
      name ? `${L.account} ${dom ? `${dom}\\` : ''}${name}` : '',
      type ? `${L.type[type] || type} (${type})` : '',
      reason(hex(sub) && hex(sub) !== '00000000' ? sub : status),
      exe(s),
      src && src !== '127.0.0.1' && src !== '::1' ? `${L.from} ${src}${ws ? ` (${ws})` : ''}` : (ws ? `${L.from} ${ws}` : ''),
    ];
  } else if (id === 4740) {
    const p = at(s, 'Gesperrtes Konto|Account That Was Locked Out');
    const name = p >= 0 ? after(s, ACCOUNT, p) : '';
    const by = after(s, 'Aufrufername|Name des aufrufenden Computers|Caller Computer Name');
    parts = [name ? L.locked.replace('{a}', name) : '', by ? `${L.by} ${by}` : ''];
  } else if (id === 4771) {
    const name = after(s, ACCOUNT);
    const code = (after(s, 'Fehlercode|Failure Code') || '').toLowerCase().replace(/^0x0*([0-9a-f])/, '0x$1');
    const src = addr(after(s, 'Clientadresse|Client Address'));
    parts = [name ? `${L.account} ${name}` : '', code ? `${L.krb[code] || 'Kerberos'} (${code})` : '', src ? `${L.from} ${src}` : ''];
  } else if (id === 4776) {
    const name = after(s, 'Anmeldekonto|Logon Account');
    const ws = after(s, 'Quellarbeitsstation|Source Workstation');
    const code = after(s, 'Fehlercode|Error Code');
    parts = [name ? `${L.account} ${name}` : '', hex(code) && hex(code) !== '00000000' ? reason(code) : '', ws ? `${L.from} ${ws}` : ''];
  } else return '';
  const out = parts.filter(Boolean);
  return out.length >= 2 ? out.join(' · ') : '';
}
