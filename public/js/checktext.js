// Results of the checks are stored in English (they also go into logs and webhooks as they are). For German - on the
// page and in German alarms - they are put into German here. Used by the browser and the server (monitor/notify.js).
// Unknown texts stay as they are.

// Whole text after "<label>: " (or the whole message)
const WORDS = {
  'not found': 'nicht gefunden', 'no data': 'keine Daten', 'no data yet': 'noch keine Daten', 'no current data': 'keine aktuellen Daten',
  'no value': 'kein Wert', running: 'läuft', stopped: 'gestoppt', failed: 'gestört', paused: 'pausiert', empty: 'leer', normal: 'normal',
  online: 'online', offline: 'offline', up: 'verbunden', down: 'getrennt', on: 'an', off: 'aus', partial: 'teilweise', outdated: 'veraltet',
  'restart required': 'Neustart nötig', 'no restart needed': 'kein Neustart nötig', 'replace battery': 'Akku tauschen', 'no UPS': 'keine USV',
  'no temperatures': 'keine Temperaturen', 'no faults': 'keine Störungen', 'system, fans, power supply normal': 'System, Lüfter und Netzteil in Ordnung',
  'no answer': 'keine Antwort', 'connection refused': 'Verbindung abgelehnt', 'connection reset': 'Verbindung zurückgesetzt',
  'connection closed': 'Verbindung geschlossen', 'host unreachable': 'Host nicht erreichbar', 'name not found (DNS)': 'Name nicht gefunden (DNS)',
  'timeout': 'Zeitüberschreitung', 'invalid address': 'ungültige Adresse', 'certificate expired': 'Zertifikat abgelaufen',
  'self-signed certificate': 'selbstsigniertes Zertifikat', 'self-signed certificate in chain': 'selbstsigniertes Zertifikat in der Kette',
  'certificate cannot be verified': 'Zertifikat lässt sich nicht prüfen', 'certificate is for another name': 'Zertifikat gilt für einen anderen Namen',
  'device missing': 'Gerät fehlt', 'device does not answer SNMP': 'Gerät antwortet nicht auf SNMP', 'no SNMP answer (community?)': 'keine SNMP-Antwort (Community?)',
  'container not found': 'Container nicht gefunden', 'Docker host missing': 'Docker-Host fehlt', 'Proxmox host missing': 'Hypervisor fehlt',
  'ping not allowed on this host': 'Ping ist auf diesem Server nicht erlaubt', 'smbclient missing on this host': 'smbclient fehlt auf diesem Server',
  'login failed (user or password)': 'Anmeldung fehlgeschlagen (Benutzer oder Passwort)', 'database does not exist': 'Datenbank gibt es nicht',
  'wrong password': 'falsches Passwort', 'no database': 'keine Datenbank', 'unexpected answer (no Redis server?)': 'unerwartete Antwort (kein Redis-Server?)',
  'no backup found': 'keine Sicherung gefunden', 'unknown sensor': 'unbekannter Sensor', 'healthy': 'in Ordnung', 'no health data': 'keine Zustandsdaten',
  'state unknown': 'Zustand unbekannt', 'on mains': 'am Netz', 'on battery': 'auf Akku', 'battery low': 'Akku schwach',
  'no value - the account probably lacks read rights (Monitoring → Virtualization)': 'kein Wert - dem Konto fehlen wohl Leserechte (Überwachung → Virtualisierung)',
  'no current temperature - the Linux script on the node has not reported for 15 minutes': 'keine aktuelle Temperatur - das Linux-Skript auf dem Knoten hat sich seit 15 Minuten nicht gemeldet',
  'access denied by the socket proxy (CONTAINERS=1?)': 'vom Socket-Proxy abgelehnt (CONTAINERS=1?)',
  'name not found or not reachable': 'Name nicht gefunden oder nicht erreichbar', 'network unreachable': 'Netz nicht erreichbar',
  'access denied': 'Zugriff verweigert', 'account disabled': 'Konto gesperrt', 'account expired': 'Konto abgelaufen', 'account locked': 'Konto gesperrt',
  'password expired': 'Passwort abgelaufen', 'password must be changed': 'Passwort muss geändert werden', 'invalid domain': 'ungültige Domäne',
  'invalid share or path': 'ungültige Freigabe oder ungültiger Pfad', 'invalid user': 'ungültiger Benutzer', 'folder or file not found': 'Ordner oder Datei nicht gefunden',
  'share not found': 'Freigabe nicht gefunden', 'share readable': 'Freigabe lesbar', 'sign-in failed (user or password wrong)': 'Anmeldung fehlgeschlagen (Benutzer oder Passwort falsch)',
  'smbclient failed': 'smbclient fehlgeschlagen', 'no access to the socket': 'kein Zugriff auf den Socket', 'socket not found': 'Socket nicht gefunden',
  'certificate does not match the pairing code': 'Zertifikat passt nicht zum Kopplungscode',
  'the master no longer knows this standby (pairing removed or new code)': 'der Master kennt diesen Standby nicht mehr (Kopplung gelöst oder neuer Code)',
  'the master was replaced by another one': 'der Master wurde durch einen anderen ersetzt', 'copy of the master is damaged': 'Kopie des Masters ist beschädigt',
  'the key of the master does not open its database': 'der Schlüssel des Masters öffnet dessen Datenbank nicht', 'copy too large': 'Kopie zu groß',
  restarting: 'startet neu', unhealthy: 'ungesund', exited: 'beendet', created: 'angelegt', dead: 'abgestürzt',
};

// Texts with numbers or names in them
const PATTERNS = [
  [/^timeout \((\d+) s\)$/, 'Zeitüberschreitung ($1 s)'],
  [/^status (\d+)$/, 'Status $1'],
  [/^keyword not found \(status (\d+)\)$/, 'Stichwort nicht gefunden (Status $1)'],
  [/^port (\d+) open$/, 'Port $1 offen'],
  [/^no report for (\d+) min$/, 'seit $1 Min. keine Meldung'],
  [/^(-?\d+) days left$/, 'noch $1 Tage'],
  [/^expired (\d+) days ago$/, 'seit $1 Tagen abgelaufen'],
  [/^(\d+) in (\d+) h(.*)$/, '$1 in $2 Std.$3'],
  [/^(.*) on and up to date$/, '$1 an und aktuell'],
  [/^(.*) signatures (\d+|\?) days old$/, '$1 Signaturen $2 Tage alt'],
  [/^on battery(.*)$/, 'auf Akku$1'],
  [/^on mains(.*)$/, 'am Netz$1'],
  [/^state unknown(.*)$/, 'Zustand unbekannt$1'],
  [/^healthy(.*)$/, 'in Ordnung$1'],
  [/^no health data(.*)$/, 'keine Zustandsdaten$1'],
  [/^up · (.*)$/, 'verbunden · $1'],
  [/^unexpected answer (.*)$/, 'unerwartete Antwort $1'],
  [/^failed: (.*)$/, 'gestört: $1'],
  [/^device has a new IP \((.*)\) - please enter the password again$/, 'Gerät hat neue IP ($1) – Passwort bitte neu eingeben'],
  [/^(\S+): no such value$/, '$1: diesen Wert gibt es nicht'],
  [/^program versions differ \(master (.*), here (.*)\) - update both$/, 'Programmversionen unterschiedlich (Master $1, hier $2) - beide aktualisieren'],
  [/^database version differs \(master (\d+), here (\d+)\) - bring both to the same program version$/, 'Datenbankversion unterschiedlich (Master $1, hier $2) - beide auf dieselbe Programmversion bringen'],
  [/^(on|off|partial) \(off: (.*)\)$/, (_, s, l) => `${WORDS[s]} (aus: ${l})`],
];
const BITS = [[/, battery low/g, ', Akku schwach'], [/ (\d+) % worn/g, ' $1 % verschlissen'], [/ (\d+) reallocated sectors/g, ' $1 umgelagerte Sektoren'],
  [/ (\d+) min\)/g, ' $1 Min.)'], [/ - newest: /g, ' - neueste: '],
  // decimal comma for measured values: 83.9 °C → 83,9 °C (not in addresses or versions)
  [/(\d+)\.(\d+)(?= ?(°C|%|W|h|ms|RPM)\b|\s?°C)/g, '$1,$2']];

function part(s) {
  if (Object.hasOwn(WORDS, s)) return WORDS[s];
  for (const [re, to] of PATTERNS) if (re.test(s)) return BITS.reduce((x, [r, t]) => x.replace(r, t), s.replace(re, to));
  // "running · healthy", "exited · 2 restarts": part by part, when every part is known
  if (s.includes(' · ')) {
    const parts = s.split(' · ').map((x) => (Object.hasOwn(WORDS, x) ? WORDS[x] : PATTERNS.some(([re]) => re.test(x)) ? part(x) : null));
    if (parts.every((x) => x !== null)) return parts.join(' · ');
  }
  return null;
}

/** "Temperatur pve2: no current data" → "Temperatur pve2: keine aktuellen Daten" (German only; other languages unchanged) */
export function checkText(msg, lang = 'de') {
  const s = String(msg ?? '');
  if (lang !== 'de' || !s) return s;
  const whole = part(s);
  if (whole !== null) return whole;
  const i = s.indexOf(': ');
  if (i > 0) {
    const tail = part(s.slice(i + 2));
    if (tail !== null) return `${s.slice(0, i + 2)}${tail}`;
  }
  return BITS.reduce((x, [r, t]) => x.replace(r, t), s);
}
