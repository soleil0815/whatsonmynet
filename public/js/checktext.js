// Results of the checks are stored in English (they also go into logs and webhooks as they are). For German - on the
// page and in German alarms - they are put into German here. Used by the browser and the server (monitor/notify.js).
// Unknown texts stay as they are.

// Whole text after "<label>: " (or the whole message)
const WORDS = {
  'not found': 'nicht gefunden', 'no data': 'keine Daten', 'no data yet': 'noch keine Daten', 'no current data': 'keine aktuellen Daten',
  'no value': 'kein Wert', 'low (printer reports)': 'wenig (meldet der Drucker)', some: 'vorhanden', 'almost full (printer reports)': 'fast voll (meldet der Drucker)', 'script data removed': 'Skript-Daten entfernt', running: 'läuft', stopped: 'gestoppt', failed: 'gestört', paused: 'pausiert', empty: 'leer', normal: 'normal',
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
  'no value at the moment (not delivered by the host)': 'gerade kein Wert (vom Host nicht geliefert)',
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
  'server offers no STARTTLS': 'Server bietet kein STARTTLS an', 'server offers no StartTLS': 'Server bietet kein StartTLS an',
  'server not synchronized': 'Server nicht synchronisiert', 'name not found': 'Name nicht gefunden', 'server failure (SERVFAIL)': 'Serverfehler (SERVFAIL)',
  'query refused (REFUSED)': 'Anfrage abgelehnt (REFUSED)', 'invalid name': 'ungültiger Name', 'not implemented by the server': 'vom Server nicht unterstützt',
  'rootDSE not readable without sign-in': 'rootDSE ohne Anmeldung nicht lesbar', 'rootDSE readable': 'rootDSE lesbar',
  'unexpected answer (no SQL Server?)': 'unerwartete Antwort (kein SQL Server?)', 'SQL Browser does not answer (UDP 1434)': 'SQL Browser antwortet nicht (UDP 1434)',
  // Connections to hypervisors, backup servers, controllers, cloud accounts (Monitoring → Virtualization, Server hardware)
  'no data from the host script for more than 15 minutes - is the scheduled task running?': 'seit über 15 Minuten keine Daten vom Host-Skript - läuft die geplante Aufgabe?',
  'waiting for the first data from the host script': 'warte auf die ersten Daten vom Host-Skript',
  'self-signed certificate - Edit → Fetch certificate': 'selbstsigniertes Zertifikat - Bearbeiten → Zertifikat abrufen',
  'certificate of an unknown CA - Edit → Fetch certificate': 'Zertifikat einer unbekannten Zertifizierungsstelle - Bearbeiten → Zertifikat abrufen',
  'certificate cannot be verified - Edit → Fetch certificate': 'Zertifikat lässt sich nicht prüfen - Bearbeiten → Zertifikat abrufen',
  'certificate changed - fetch it again (Edit → Fetch certificate)': 'Zertifikat hat sich geändert - neu abrufen (Bearbeiten → Zertifikat abrufen)',
  'certificate is not the pasted one': 'Zertifikat ist nicht das hinterlegte',
  'name not found (DNS) - can WhatsOnMyNet reach the internet?': 'Name nicht gefunden (DNS) - kommt WhatsOnMyNet ins Internet?',
  'timeout - can WhatsOnMyNet reach the internet?': 'Zeitüberschreitung - kommt WhatsOnMyNet ins Internet?',
  'access denied (403) - the account lacks read rights': 'Zugriff verweigert (403) - dem Konto fehlen Leserechte',
  'access denied (403) - the token lacks the role PVEAuditor/Audit': 'Zugriff verweigert (403) - dem Token fehlt die Rolle PVEAuditor/Audit',
  'answer is not JSON - right address?': 'Antwort ist kein JSON - stimmt die Adresse?', 'answer is not JSON': 'Antwort ist kein JSON', 'answer too large': 'Antwort zu groß',
  'connection closed by the server': 'Verbindung vom Server geschlossen', 'no complete answer within 5 minutes': 'keine vollständige Antwort innerhalb von 5 Minuten',
  'no Ceph dashboard at this address - port 8443, module "dashboard" on?': 'kein Ceph-Dashboard unter dieser Adresse - Port 8443, Modul „dashboard“ an?',
  'no Redfish service at this address (no systems)': 'kein Redfish-Dienst unter dieser Adresse (keine Systeme)',
  'no RouterOS REST API at this address - RouterOS 7 with "www-ssl" service on?': 'keine RouterOS-REST-API unter dieser Adresse - RouterOS 7 mit Dienst „www-ssl“ an?',
  'no Veeam REST API at this address - port 9419, Veeam Backup & Replication 12 or newer?': 'keine Veeam-REST-API unter dieser Adresse - Port 9419, Veeam Backup & Replication 12 oder neuer?',
  'no XAPI at this address (/jsonrpc) - XCP-ng 8 / XenServer 7.3 or newer?': 'keine XAPI unter dieser Adresse (/jsonrpc) - XCP-ng 8 / XenServer 7.3 oder neuer?',
  'no vSphere API at this address (/sdk) - ESXi or vCenter address?': 'keine vSphere-API unter dieser Adresse (/sdk) - Adresse von ESXi oder vCenter?',
  'unexpected answer of the vSphere API': 'unerwartete Antwort der vSphere-API',
  'no health in the answer of the dashboard': 'kein Zustand in der Antwort des Dashboards', 'no node in the data': 'kein Knoten in den Daten',
  'not a WebSocket answer': 'keine WebSocket-Antwort', 'project not found - right project ID?': 'Projekt nicht gefunden - stimmt die Projekt-ID?',
  'session refused (401)': 'Sitzung abgelehnt (401)', 'sign-in refused (401)': 'Anmeldung abgelehnt (401)',
  'sign-in refused (401) - token ID or secret wrong': 'Anmeldung abgelehnt (401) - Token-ID oder Geheimnis falsch',
  'sign-in refused (401) - user or password wrong': 'Anmeldung abgelehnt (401) - Benutzer oder Passwort falsch',
  'sign-in refused - user or password wrong': 'Anmeldung abgelehnt - Benutzer oder Passwort falsch',
  'sign-in refused - user or password wrong (or the account is locked)': 'Anmeldung abgelehnt - Benutzer oder Passwort falsch (oder das Konto ist gesperrt)',
  'sign-in refused - user or password wrong (or two-factor sign-in is on for this account)': 'Anmeldung abgelehnt - Benutzer oder Passwort falsch (oder für das Konto ist die Zwei-Faktor-Anmeldung an)',
  'sign-in refused - user or API key wrong': 'Anmeldung abgelehnt - Benutzer oder API-Schlüssel falsch',
  'sign-in refused - client secret wrong (use the secret value, not its ID)': 'Anmeldung abgelehnt - Client-Geheimnis falsch (den Wert des Geheimnisses nehmen, nicht seine ID)',
  'sign-in refused - no app with this application (client) ID in this tenant': 'Anmeldung abgelehnt - keine App mit dieser Anwendungs-(Client-)ID in diesem Mandanten',
  'sign-in refused - tenant not found': 'Anmeldung abgelehnt - Mandant nicht gefunden',
  'sign-in refused - the client secret has expired: make a new one in the app registration': 'Anmeldung abgelehnt - das Client-Geheimnis ist abgelaufen: in der App-Registrierung ein neues anlegen',
  'sign-in: the controller sent an unusable session token': 'Anmeldung: der Controller hat ein unbrauchbares Sitzungstoken geschickt',
  'subscription not found - right ID, and may the app read it?': 'Abonnement nicht gefunden - stimmt die ID, und darf die App es lesen?',
  'the API key has expired - create a new one': 'der API-Schlüssel ist abgelaufen - einen neuen anlegen',
  'the Redfish service lists no server': 'der Redfish-Dienst nennt keinen Server',
  'the account lacks rights - give it the role "Veeam Backup Viewer"': 'dem Konto fehlen Rechte - ihm die Rolle „Veeam Backup Viewer“ geben',
  'the account lacks the right to read (role read-only)': 'dem Konto fehlt das Leserecht (Rolle read-only)',
  'the account may not read this - give it at least the read-only role': 'das Konto darf das nicht lesen - ihm mindestens die Rolle read-only geben',
  'the account may not read this site': 'das Konto darf diesen Standort nicht lesen',
  'the answer is no JSON - is this a Redfish service?': 'die Antwort ist kein JSON - ist das ein Redfish-Dienst?',
  'the private key of the service account cannot be read - paste the JSON key again': 'der private Schlüssel des Dienstkontos ist nicht lesbar - den JSON-Schlüssel neu einfügen',
  'the user may not read the health - give it the role "read-only"': 'der Benutzer darf den Zustand nicht lesen - ihm die Rolle „read-only“ geben',
  'the user may not use the API - give it the role "Read-Only Administrator"': 'der Benutzer darf die API nicht nutzen - ihm die Rolle „Read-Only Administrator“ geben',
  'the user needs a second factor (OTP) - use a user without it for the API key': 'der Benutzer braucht einen zweiten Faktor (OTP) - für den API-Schlüssel einen Benutzer ohne nehmen',
  'too many requests - is this a Redfish service?': 'zu viele Anfragen - ist das ein Redfish-Dienst?',
  'too many sign-ins - UniFi blocks for a few minutes': 'zu viele Anmeldungen - UniFi sperrt für ein paar Minuten',
  'XML too deep': 'XML zu tief verschachtelt', 'too big': 'zu groß', 'message too large': 'Nachricht zu groß',
  restarting: 'startet neu', unhealthy: 'ungesund', exited: 'beendet', created: 'angelegt', dead: 'abgestürzt',
};

const SEV_DE = { emerg: 'Notfall', alert: 'Alarm', crit: 'kritisch', err: 'Fehler', warning: 'Warnung', notice: 'Hinweis', info: 'Info', debug: 'Debug' };
const TRAP_DE = { 'port down': 'Port getrennt', 'port up': 'Port verbunden', 'device started': 'Gerät gestartet', 'device restarted': 'Gerät neu gestartet',
  'SNMP request with a wrong community': 'SNMP-Anfrage mit falscher Community', 'UPS on battery': 'USV auf Akku', 'UPS alarm cleared': 'USV-Alarm aufgehoben', 'UPS alarm': 'USV-Alarm',
  'UPS self-test completed': 'USV-Selbsttest beendet', 'APC UPS on battery': 'APC-USV auf Akku', 'APC UPS back on mains': 'APC-USV wieder am Netz', 'APC UPS battery low': 'APC-USV Akku schwach' };

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
  // messages devices sent (traps, syslog): the device's own text stays as it is
  [/^no matching message in the last (\d+) min$/, 'keine passende Meldung in den letzten $1 Min.'],
  [/^(\d+) of (\d+) down: (.*) \(\+(\d+) more\)$/, '$1 von $2 gestört: $3 (+$4 weitere)'],
  [/^(\d+) of (\d+) down: (.*)$/, '$1 von $2 gestört: $3'],
  [/^(\d+) of (\d+) up$/, '$1 von $2 in Ordnung'],
  [/^group "(.*)" has no members$/, 'Gruppe „$1“ hat keine Mitglieder'],
  [/^no member checked \((\d+) in maintenance, paused or waiting\)$/, 'kein Mitglied geprüft ($1 in Wartung, pausiert oder wartend)'],
  [/^(trap|syslog) (emerg|alert|crit|err|warning|notice|info|debug) from (\S+): ([\s\S]*)$/, (_, k, sev, ip, rest) => `${k === 'trap' ? 'Trap' : 'Syslog'} ${SEV_DE[sev]} von ${ip}: ${
    rest.replace(/^(\w+: )?(port down|port up|device started|device restarted|SNMP request with a wrong community|UPS on battery|UPS alarm cleared|UPS alarm|UPS self-test completed|APC UPS on battery|APC UPS back on mains|APC UPS battery low)/, (m, app, w) => `${app || ''}${TRAP_DE[w]}`)
      .replace(/ \(\+(\d+) more\)$/, ' (+$1 weitere)')}`],
  // protocol checks (DNS, mail, LDAP, NTP, SQL Server)
  [/^answer without "(.*)": (.*)$/, 'Antwort ohne „$1“: $2'],
  [/^no (\w+) record$/, 'kein $1-Eintrag'],
  [/^unexpected greeting: (.*)$/, 'unerwartete Begrüßung: $1'],
  [/^(EHLO|STARTTLS) refused: (.*)$/, '$1 abgelehnt: $2'],
  [/^domain controller not synchronized \((.*)\)$/, 'Domänencontroller nicht synchronisiert ($1)'],
  [/^offset ([+-]?\d+) ms \(limit (\d+) ms\) · stratum (\d+)$/, 'Abweichung $1 ms (Grenze $2 ms) · Stratum $3'],
  [/^offset ([+-]?\d+) ms · stratum (\d+)$/, 'Abweichung $1 ms · Stratum $2'],
  [/^server refuses \(kiss code (.*)\)$/, 'Server lehnt ab (Kiss-Code $1)'],
  [/^instance (\S+) not found or without TCP$/, 'Instanz $1 nicht gefunden oder ohne TCP'],
  // own checks (local checks of the machine scripts)
  [/^(OK|WARN|CRIT|UNKNOWN)(?: - ([\s\S]*))?$/, (_, st, rest) => `${{ OK: 'OK', WARN: 'WARNUNG', CRIT: 'KRITISCH', UNKNOWN: 'UNBEKANNT' }[st]}${rest ? ` - ${part(rest) ?? rest}` : ''}`],
  [/^not found - the check script no longer reports it$/, 'nicht gefunden - das Prüfskript meldet sie nicht mehr'],
  [/^no line in the check format \(exit code (-?\d+)\)$/, 'keine Zeile im Prüfformat (Exit-Code $1)'],
  [/^folder (.*) may be changed by others - checks not run$/, 'Ordner $1 ist für andere änderbar - Prüfungen nicht ausgeführt'],
  [/^the command timeout is missing - checks not run$/, 'der Befehl timeout fehlt - Prüfungen nicht ausgeführt'],
  [/^owner or rights not safe - not run \(owner must be Administrators\)$/, 'Besitzer oder Rechte nicht sicher - nicht ausgeführt (Besitzer muss „Administratoren“ sein)'],
  [/^could not start: (.*)$/, 'konnte nicht starten: $1'],
  // switch ports
  [/^no traffic \(port (\w+)\)$/, (_, st) => `kein Verkehr (Port ${WORDS[st] || st})`],
  [/^measuring - value after the next query$/, 'wird gemessen - Wert nach der nächsten Abfrage'],
  // Veeam, Microsoft 365
  [/^last run (success|warning|failed)$/, (_, r) => `letzter Lauf ${{ success: 'erfolgreich', warning: 'mit Warnung', failed: 'fehlgeschlagen' }[r]}`],
  [/^not run yet$/, 'noch nicht gelaufen'],
  [/^disabled$/, 'abgeschaltet'],
  [/^(serviceOperational|serviceDegradation|serviceInterruption|extendedRecovery|restoringService|investigating|verifyingService|serviceRestored|falsePositive|postIncidentReviewPublished|resolved|mitigated|confirmed|reported)$/,
    (_, s) => ({ serviceOperational: 'in Betrieb', serviceDegradation: 'eingeschränkt', serviceInterruption: 'unterbrochen', extendedRecovery: 'längere Wiederherstellung', restoringService: 'wird wiederhergestellt',
      investigating: 'wird untersucht', verifyingService: 'wird geprüft', serviceRestored: 'wiederhergestellt', falsePositive: 'Fehlalarm', postIncidentReviewPublished: 'Nachbericht veröffentlicht',
      resolved: 'behoben', mitigated: 'abgemildert', confirmed: 'bestätigt', reported: 'gemeldet' }[s])],
  [/^(Enabled|Warning|Suspended|LockedOut)$/, (_, s) => ({ Enabled: 'aktiv', Warning: 'läuft aus (Kulanzzeit)', Suspended: 'gesperrt', LockedOut: 'gesperrt (abgelaufen)' }[s])],
  // cloud accounts
  [/^no value while it does not run$/, 'kein Wert, solange sie nicht läuft'],
  [/^(\S+) - no check while it does not run$/, (_, st) => `${WORDS[st] || st} - keine Prüfung, solange sie nicht läuft`],
  [/^not found - the account lacks rights: (.*)$/, 'nicht gefunden - dem Konto fehlen Rechte: $1'],
  [/^instance check failed$/, 'Instanz-Prüfung fehlgeschlagen'],
  [/^system check failed$/, 'System-Prüfung fehlgeschlagen'],
  [/^system check failed, instance check failed$/, 'System- und Instanz-Prüfung fehlgeschlagen'],
  [/^device has a new IP \((.*)\) - please enter the password again$/, 'Gerät hat neue IP ($1) – Passwort bitte neu eingeben'],
  [/^(\S+): no such value$/, '$1: diesen Wert gibt es nicht'],
  // connections to hypervisors and other hosts, with an address, a code or a name in them
  [/^not found \(404\): (.*) - right address\?$/, 'nicht gefunden (404): $1 - stimmt die Adresse?'],
  [/^this host is not the pool master - enter the master: ?(.*)$/, 'dieser Host ist nicht der Pool-Master - den Master eintragen: $1'],
  [/^certificate of (\S+) not trusted - is a proxy breaking up TLS\?$/, 'Zertifikat von $1 wird nicht anerkannt - bricht ein Proxy TLS auf?'],
  [/^refused to send the account to (\S+)$/, 'Zugangsdaten werden nicht an $1 geschickt'],
  [/^region (\S+) is not enabled for this account$/, 'Region $1 ist für dieses Konto nicht freigeschaltet'],
  [/^no (Omada|UniFi) controller at this address \(HTTP (\d+)\)$/, 'kein $1-Controller unter dieser Adresse (HTTP $2)'],
  [/^sign-in failed \(HTTP (\d+)\)$/, 'Anmeldung fehlgeschlagen (HTTP $1)'],
  [/^sign-in refused \(([^)]*)\)$/, 'Anmeldung abgelehnt ($1)'],
  [/^sign-in refused - access key or secret wrong \(([^)]*)\)$/, 'Anmeldung abgelehnt - Zugriffsschlüssel oder Geheimnis falsch ($1)'],
  [/^sign-in refused - the key was deleted or the service account disabled \((.*)\)$/, 'Anmeldung abgelehnt - der Schlüssel wurde gelöscht oder das Dienstkonto abgeschaltet ($1)'],
  [/^(\S+): timeout$/, '$1: Zeitüberschreitung'],
  [/^program versions differ \(master (.*), here (.*)\) - update both$/, 'Programmversionen unterschiedlich (Master $1, hier $2) - beide aktualisieren'],
  [/^database version differs \(master (\d+), here (\d+)\) - bring both to the same program version$/, 'Datenbankversion unterschiedlich (Master $1, hier $2) - beide auf dieselbe Programmversion bringen'],
  [/^(on|off|partial) \(off: (.*)\)$/, (_, s, l) => `${WORDS[s]} (aus: ${l})`],
];
const BITS = [[/, battery low/g, ', Akku schwach'], [/ (\d+) % worn/g, ' $1 % verschlissen'], [/ (\d+) reallocated sectors/g, ' $1 umgelagerte Sektoren'],
  [/ (\d+) min\)/g, ' $1 Min.)'], [/ - newest: /g, ' - neueste: '],
  [/ \(in ([\d.]+ \w?bit\/s), out ([\d.]+ \w?bit\/s)\)/g, ' (ein $1, aus $2)'], [/ · synchronized/g, ' · synchronisiert'], [/ · global catalog/g, ' · globaler Katalog'], [/ · encryption (off|on|required|not supported)/g, (_, x) => ` · Verschlüsselung ${{ off: 'aus', on: 'an', required: 'erforderlich', 'not supported': 'nicht unterstützt' }[x]}`],
  // decimal comma for measured values: 83.9 °C → 83,9 °C (not in addresses or versions)
  [/(\d+)\.(\d+)(?= ?(?:°C|%|W|h|ms|RPM)(?![A-Za-z])|\s?°C| [kMG]?bit\/s)/g, '$1,$2']];

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
