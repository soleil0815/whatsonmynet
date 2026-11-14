// What changed, per version, in plain words for the users of the program (not for developers).
// The newest version first. Entries of 'next' belong to the version being built: in a released image they are shown
// under its version number (see whatsNew in views/about.js). At the next release they get their number here.
export const CHANGELOG = [
  { version: 'next', de: [
    'Gleich überwacht: Übernommene oder neu angelegte Geräte bekommen sofort einen Monitor (Weboberfläche, sonst Ping) und, sobald sie Werte liefern, ein paar wichtige Sensoren - Toner beim Drucker, Volumes, RAID und Temperatur beim NAS, CPU, RAM, Systemlaufwerk, Temperatur und Dienste bei Rechnern mit Skript, Knoten, Speicher und Sicherungen bei Hypervisoren. Abschaltbar unter Einstellungen → Benachrichtigungen',
    'Neue Bilder in der Projektbeschreibung und im Handbuch: Diagramm mit Ausfällen, Sensor mit Grenzwert, Sensoren, Ausfallsicherung; Übersicht „Auf einen Blick“',
    'Neuigkeiten auch als Datei im Projekt (CHANGELOG.md, englisch CHANGELOG.en.md) und als Text jeder Version auf GitHub - dieselben Texte wie hier',
  ], en: [
    'Watched right away: adopted or newly added devices get a monitor at once (web interface, else ping) and, as soon as they deliver values, a few important sensors - toner for printers, volumes, RAID and temperature for a NAS, CPU, RAM, system drive, temperature and services for machines with the script, nodes, storage and backups for hypervisors. Can be switched off under Settings → Notifications',
    'New pictures in the project description and the manual: chart with outages, sensor with limit, sensors, failover; "At a glance" overview',
    'Changelog also as a file in the project (CHANGELOG.md, English CHANGELOG.en.md) and as the text of every release on GitHub - the same texts as here',
  ] },
  { version: '0.20.0', date: '2026-11-14', de: [
    'Ausfallsicherung (Einstellungen → Ausfallsicherung): ein zweites WhatsOnMyNet als Standby. Koppeln mit Adresse und Code vom Master; der Standby übernimmt jede Minute ein Lebenszeichen und alle 5 Minuten die Daten, alarmiert selbst nicht und zeigt nur an. Antwortet der Master länger als eingestellt (Standard 10 Minuten) nicht, überwacht und alarmiert der Standby; ist der Master wieder da, gibt er ab und holt dessen Daten. „Zum Master machen“ für den Fall, dass der alte nicht wiederkommt',
  ], en: [
    'Failover (Settings → Failover): a second WhatsOnMyNet as standby. Pair it with address and code of the master; the standby takes a sign of life every minute and the data every 5 minutes, does not alarm itself and only shows. When the master does not answer for longer than set (10 minutes by default), the standby monitors and alarms; when the master is back, it hands back and takes its data. "Make this the master" for when the old one does not come back',
  ] },
  { version: '0.19.0', date: '2026-11-14', de: [
    'Diagramm eines Monitors oder Sensors: Ausfälle rot hinterlegt mit Beginn, Ende und Dauer, darunter als Liste mit Grund; Zusammenfassung (wie oft, wie lange); Fadenkreuz mit Uhrzeit und Wert beim Zeigen; bei Sensoren der Grenzwert als Linie; Zeitachse mit Uhrzeiten und Tagen, auch am Telefon gut lesbar',
    'Kaffee-Knopf unter „Über WhatsOnMyNet“ wie der offizielle Buy-Me-a-Coffee-Knopf (gelb, Tassen-Logo, „Buy me a coffee“); das Logo auch klein im Menü - alles im Programm enthalten, nichts wird aus dem Internet geladen',
  ], en: [
    'Chart of a monitor or sensor: outages with a red background with start, end and length, listed below with their reason; summary (how often, how long); crosshair with time and value when pointing; for sensors the alarm limit as a line; time axis with hours and days, readable on a phone too',
    'Coffee button under "About WhatsOnMyNet" like the official Buy Me a Coffee button (yellow, cup logo, "Buy me a coffee"); the logo also small in the menu - all shipped with the program, nothing is loaded from the internet',
  ] },
  { version: '0.18.0', date: '2026-11-14', de: [
    'Überwachung: mehrere Monitore oder Sensoren ankreuzen (auch „alle angezeigten“) und gemeinsam bearbeiten - Prüfintervall, Fehlversuche, Zeitlimit, Wiederholung, Eskalation und Kanäle, bei Sensoren auch Bedingung und Grenzwert; nur ausgefüllte Felder werden geändert. Pausieren, Fortsetzen und Löschen gehen ebenfalls für alle auf einmal',
  ], en: [
    'Monitoring: tick several monitors or sensors (also "all shown") and edit them together - check interval, failed checks, time limit, repeat, escalation and channels, for sensors also condition and limit; only filled-in fields change. Pause, resume and delete work for all of them at once as well',
  ] },
  { version: '0.17.0', date: '2026-11-14', de: [
    'Sensor anlegen: Werte, die schon ein Sensor überwacht, werden nicht noch einmal angeboten (auch nicht über den Hypervisor, wenn das Linux-Skript denselben Wert liefert)',
    'Dialoge: Enter speichert, Fehler stehen direkt am betroffenen Feld; Einstellungen am Handy als Auswahlliste',
    'Rechnername: von Hand eingetragen bleibt er - der Scan füllt ihn nur, solange er leer ist oder vom Scan stammt (gilt auch für Namen, die vor dem Update von Hand eingetragen wurden)',
    'Monitore mit gespeichertem Passwort werden bei neuer IP des Geräts pausiert und zeigen „Gerät hat neue IP - Passwort bitte neu eingeben“; mit neuem Passwort laufen sie an der neuen Adresse weiter. Die Benachrichtigungskanäle des Monitors erfahren davon; kehrt das Gerät zur alten Adresse zurück, läuft er von selbst wieder',
    'Übernehmen und Ignorieren nur noch aus dem neuesten Scan eines Subnetzes (ältere Scans bleiben lesbar, „Nicht mehr ignorieren“ geht weiter); „Wartung“ wird ab Beginn des Wartungsfensters angezeigt',
    'Scan: öffentliche Netze dürfen nur Administratoren scannen; die Tiefenprüfung fragt bei unbekannten Geräten erst Port 4742 und prüft Kartenterminals nur schonend',
    'Sicherheit: CSV-Export entschärft auch Formeln nach einem Komma; die Sicherung zum Herunterladen liegt nur für WhatsOnMyNet lesbar im Datenordner',
    'Code-Audit - Sicherheit: HSTS nie mit einem hochgeladenen, selbst signierten Zertifikat; ein hochgeladenes Zertifikat wird nicht mehr durch ein selbst erzeugtes ersetzt (auch nicht bei fehlenden Metadaten oder gleichzeitiger Erneuerung); zusätzliche Schutz-Header für den Browser',
    'Code-Audit - Sicherheit: AD kann den letzten Administrator nicht mehr herabstufen; nach einer Wiederherstellung müssen sich alle neu anmelden; die Liste ignorierter Geräte zeigt standortbeschränkten Konten nur ihre Standorte',
    'Code-Audit - Stabilität: ein Proxmox-Token mit unzulässigen Zeichen kann den Server nicht mehr beenden (wird beim Speichern abgelehnt); ein kaputter Zeitstempel im Linux-Skript verwirft nicht mehr den ganzen Bericht',
    'Code-Audit - Inventar: ein Rechner-Skript mit dem gemeinsamen Schlüssel landet nie auf einem Gerät mit anderer MAC; Monitore aller Arten folgen dem Gerät bei neuer IP (auch bei Änderung von Hand; mit gespeichertem Passwort bleiben sie an der alten Adresse); keine doppelten Geräte ohne MAC bei der Übernahme; Übernahme aus einem älteren Scan zeigt das Gerät nicht fälschlich online; Weblink wird bei IP-Wechsel nicht mehr verfälscht; Umbenennen ändert nur den Gerätenamen am Anfang der Monitornamen; Typwechsel räumt alte SNMP-Meldungen weg; Redfish macht aus einem Hypervisor keinen Server',
    'Code-Audit - Scan: HPE-Geräte (iLO, Aruba) werden nicht mehr als Drucker erkannt, Samsung-/LG-Fernseher und Dahua-/Uniview-Kameras richtig; Abbruch wirkt sofort; überlappende Subnetze werden nur einmal gescannt; der Nacht-Scan läuft auch nach Mitternacht nach; Scans von Agenten werden aufgeräumt',
    'Code-Audit - Alarme: ein Ausfall, der über ein Wartungsfenster hinaus andauert, meldet sich nicht doppelt, und die Entwarnung nennt die ganze Dauer',
    'Bedienung: kein doppeltes Anlegen bei mehrfachem Klick auf Speichern; Fehlermeldungen in Dialogen sichtbar; Handy-Ansicht ohne seitliches Scrollen; Leser und Bearbeiter bekommen passende Hinweise; Portnamen ohne englische Begriffe; Sprachwechsel auf Anmelde-/Einrichtungsseite behält die Eingaben; besser per Tastatur und Screenreader bedienbar (Sprunglink, Menü, Beschriftungen)',
  ], en: [
    'Add sensor: values another sensor already watches are not offered again (also not through the hypervisor when the Linux script delivers the same value)',
    'Dialogs: Enter saves, errors are shown at the field concerned; settings on phones as a selection list',
    'Host name: typed by hand it stays - the scan only fills it while it is empty or came from the scan (also for names typed by hand before the update)',
    'Monitors with a stored password are paused when their device gets a new IP and show "device has a new IP - please enter the password again"; with a new password they continue at the new address. The notification channels of the monitor are told; when the device returns to the old address, it runs again by itself',
    'Adopt and ignore only from the newest scan of a subnet (older scans stay readable, "stop ignoring" still works); "maintenance" is shown from the start of the window',
    'Scan: only administrators may scan public networks; the deep check first asks port 4742 for unknown devices and checks card terminals gently only',
    'Security: CSV export also neutralises formulas after a comma; the backup for download is stored in the data folder, readable for WhatsOnMyNet only',
    'Code audit - security: HSTS never with an uploaded certificate that is self-signed; an uploaded certificate is no longer replaced by a generated one (not even with missing metadata or a renewal at the same time); additional protective browser headers',
    'Code audit - security: AD can no longer demote the last administrator; after a restore everyone signs in again; the list of ignored devices shows location-restricted accounts only their locations',
    'Code audit - stability: a Proxmox token with invalid characters can no longer stop the server (refused when saving); a broken timestamp in the Linux script no longer discards the whole report',
    'Code audit - inventory: a host script with the shared key never lands on a device with another MAC; monitors of all kinds follow the device to a new IP (also when changed by hand; with a stored password they stay at the old address); no duplicate devices without MAC when adopting; adopting from an older scan no longer shows the device online by mistake; web link no longer garbled on IP change; renaming only changes the device name at the start of monitor names; type change clears old SNMP messages; Redfish no longer turns a hypervisor into a server',
    'Code audit - scan: HPE devices (iLO, Aruba) are no longer taken for printers, Samsung/LG TVs and Dahua/Uniview cameras recognised; cancel acts at once; overlapping subnets are scanned once; the night scan also catches up after midnight; agent scans are cleaned up',
    'Code audit - alarms: an outage lasting beyond a maintenance window is not reported twice, and the all-clear states the full duration',
    'Usability: no duplicates when clicking save several times; error messages visible in dialogs; phone view without sideways scrolling; viewers and editors get fitting hints; port names without English terms in German; language switch on the sign-in/setup page keeps the input; better keyboard and screen reader support (skip link, menu, labels)',
  ] },
  { version: '0.16.0', date: '2026-11-13', de: [
    'Sensor bearbeiten: wird ein anderer Wert gewählt, bekommt der Sensor dessen Namen (z. B. „pve2: Temperatur: NVMe nvme0 Sensor 2“) - außer der Name wird im Dialog selbst geändert',
    'Beim Update einmalig: alle Sensoren werden nach ihrem Wert benannt, damit alte Namen wie „Temperatur pve2“ nach einem Wechsel des Werts wieder stimmen',
  ], en: [
    'Edit sensor: choosing another value gives the sensor its name (e.g. "pve2: Temperature: NVMe nvme0 Sensor 2") - unless the name is changed in the dialog itself',
    'Once with the update: all sensors are named after their value, so old names like "Temperatur pve2" are right again after the value was changed',
  ] },
  { version: '0.15.0', date: '2026-11-13', de: [
    'Ein Dialog für alle Sensoren: ob vom Gerät im Inventar oder vom Host unter Virtualisierung - ein Proxmox-Knoten zeigt dieselbe Liste mit den Werten von Proxmox und denen des Linux-Skripts (jede Temperatur, Festplatten, Dienste). Doppelte Werte (CPU, RAM, höchste Temperatur) nur einmal. Unter Virtualisierung nach Knoten gruppiert. Bestehende Sensoren lassen sich beim Bearbeiten auf jeden Wert der Liste umstellen',
  ], en: [
    'One dialog for all sensors: whether from the device in the inventory or from the host under Virtualization - a Proxmox node shows the same list with the values of Proxmox and those of the Linux script (every temperature, disks, services). Values both deliver (CPU, RAM, highest temperature) only once. Under Virtualization grouped by node. Existing sensors can be switched to any value of the list when editing',
  ] },
  { version: '0.14.1', date: '2026-11-13', de: [
    'Sensor anlegen: jede Temperatur, jede Festplatte und jedes Zertifikat steht mit Namen in der Auswahl (z. B. „Temperatur: NVMe nvme0 Sensor 2“) statt zigmal nur „Temperatur“; bei vielen Werten nach Bereichen gruppiert',
    'Kaffee-Knopf unter „Über WhatsOnMyNet“ gelb, damit er auffällt',
  ], en: [
    'Add sensor: every temperature, disk and certificate is listed by name (e.g. "Temperature: NVMe nvme0 Sensor 2") instead of "Temperature" many times; with many values grouped by area',
    'Coffee button under "About WhatsOnMyNet" in yellow so it stands out',
  ] },
  { version: '0.14.0', date: '2026-11-13', de: [
    'Alarme sagen, was los ist: bei Messwerten „Grenzwert überschritten - 83,9 °C (≥ 80)“ und „wieder im normalen Bereich“, bei Zuständen „Störung“/„wieder in Ordnung“, ohne Werte „keine aktuellen Werte“ - „nicht erreichbar“ nur noch für Webseite, Port und Ping. Ergebnisse der Prüfungen auf Deutsch',
    'Sensoren eigener Menüpunkt unter Überwachung (Monitore - Sensoren - Wartungsfenster)',
    'Wartungsfenster: Auswahl nach Monitoren und Sensoren, je Gerät bzw. Hypervisor gruppiert, mit Suche und „ganzes Gerät“; auf der Seite jedes Monitors/Sensors „Zeiten ohne Alarm“ mit „Zeitfenster ohne Alarm“ nur für diesen',
  ], en: [
    'Alarms say what is going on: for measured values "limit exceeded - 83.9 °C (≥ 80)" and "back in the normal range", for states "fault"/"fine again", without values "no current values" - "down" only for web page, port and ping',
    'Sensors have their own menu entry under Monitoring (monitors - sensors - maintenance windows)',
    'Maintenance windows: choice by monitors and sensors, grouped per device or hypervisor, with search and "whole device"; on the page of each monitor/sensor "times without alarm" with "time window without alarm" for just this one',
  ] },
  { version: '0.13.0', date: '2026-11-13', de: [
    'Proxmox-VE-Cluster: einen Knoten eintragen genügt - WhatsOnMyNet holt sich die Adressen und Zertifikate der anderen Knoten vom Cluster selbst. Antwortet der eingetragene Knoten nicht, wird der nächste gefragt (mit demselben Token, Zertifikat geprüft); die Seite Virtualisierung zeigt, über welchen Knoten gelesen wurde',
  ], en: [
    'Proxmox VE cluster: entering one node is enough - WhatsOnMyNet gets the addresses and certificates of the other nodes from the cluster itself. If the entered node does not answer, the next one is asked (with the same token, certificate checked); the virtualisation page shows which node was read through',
  ] },
  { version: '0.12.0', date: '2026-11-13', de: [
    'Sensor „Temperatur“ direkt am Proxmox-Knoten (Virtualisierung → Sensor anlegen): die höchste Temperatur des Knotens mit Alarm, Warnschwelle vom Chip',
  ], en: [
    'Sensor "Temperature" right at the Proxmox node (Virtualization → Add sensor): the highest temperature of the node with alarm, limit from the chip',
  ] },
  { version: '0.11.0', date: '2026-11-13', de: [
    'Temperaturen von Linux-Rechnern und Proxmox-Knoten: das Linux-Skript liest CPU, NVMe, Chipsatz und Mainboard (wie „sensors“, ohne lm-sensors und ohne root) - mit Sensoren „Temperatur“ und „die höchste“, Warnschwelle vom Chip selbst. Auf der Seite Virtualisierung steht die Temperatur am Knoten. Linux-Skript einmal neu erzeugen',
  ], en: [
    'Temperatures of Linux machines and Proxmox nodes: the Linux script reads CPU, NVMe, chipset and mainboard (like "sensors", without lm-sensors and without root) - with sensors "Temperature" and "the highest", warning limit from the chip itself. The virtualisation page shows the temperature at the node. Create the Linux script once more',
  ] },
  { version: '0.10.2', date: '2026-11-13', de: [
    'Menü passt auch in niedrige Fenster: es lässt sich scrollen und rückt bei wenig Höhe enger zusammen - Konto, Abmelden, Version und Kaffee-Link sind immer erreichbar',
    'Code-Audit - Sicherheit: AD-Anmeldung zählt Fehlversuche je Konto (auch bei gleichzeitigen Versuchen und anderer Schreibweise), verrät nicht mehr, ob ein AD-Passwort stimmt, und angemeldete AD-Benutzer werden alle 15 Minuten neu geprüft (im AD gesperrt → abgemeldet, andere Gruppe → neue Rolle)',
    'Code-Audit - Sicherheit: ein gespeichertes Passwort (Datenbank, Netzlaufwerk, Proxmox-Token) geht nur noch an die Adresse, für die es eingegeben wurde; ein angehefteter Firmen-CA prüft wieder den Namen des Servers; Datenbank-Monitore können das Server-Zertifikat prüfen',
    'Code-Audit - Sicherheit: Standort-Beschränkungen bleiben auch, wenn ein Standort gelöscht wird; Scan-Agenten ändern nur Geräte ihres Standorts; der gemeinsame Rechner-Schlüssel erreicht keine Geräte mit eigenem Schlüssel; Windows-Skript schützt seinen Ordner vor dem Kopieren',
    'Code-Audit - Stabilität: ein bösartiges Gerät kann Scan, Monitoring und Benachrichtigungen nicht mehr anhalten oder den Server beenden (Zeitlimits für die ganze Abfrage, Größengrenzen, kein Absturz durch kaputte NetBIOS-Pakete)',
    'Code-Audit - Alarme: Wartung am Switch hält die Alarme dahinter zurück, Zertifikatswarnungen kommen nach einer Wartung nach, Entwarnung an die Eskalation auch nach einer Wartung, keine Alarme pausierter Monitore, gelöschte Kanäle verschwinden aus allen Monitoren, Zeitumstellung der Uhr hält die Prüfungen nicht an',
    'Code-Audit - Daten: Wiederherstellung prüft die Sicherung vorher vollständig (Schema-Update probeweise, ein Administrator vorhanden) und behält die letzten Änderungen in der Kopie davor; zwei gleich große NAS-Volumes, anders geschriebene Seriennummern und lange Linux-Laufwerksnamen werden richtig erkannt',
    'Selbstsigniertes Zertifikat: bei der Erneuerung bleibt der Schlüssel - Rechner-Skripte melden weiter. Windows-Skripte einmal neu erzeugen (sie prüfen jetzt den Schlüssel statt des Zertifikats)',
    'Handbuch: Tabellen werden als Tabellen angezeigt; Hinweise zu KVM-Rechten, Windows-Update, Scan-Agent mit Firmen-CA',
  ], en: [
    'Menu fits low windows too: it scrolls and moves closer together when there is little height - account, sign-out, version and coffee link always reachable',
    'Code audit - security: AD sign-in counts failed attempts per account (also for attempts at the same time and other spellings), no longer tells whether an AD password is right, and signed-in AD users are checked again every 15 minutes (disabled in AD → signed out, other group → new role)',
    'Code audit - security: a stored password (database, network drive, Proxmox token) only goes to the address it was entered for; a pinned company CA checks the server name again; database monitors can check the server certificate',
    'Code audit - security: location limits stay when a location is deleted; scan agents only change devices of their location; the shared machine key reaches no device with a key of its own; the Windows script protects its folder before copying',
    'Code audit - stability: a malicious device can no longer hold scan, monitoring and notifications or end the server (deadlines for the whole request, size limits, no crash from broken NetBIOS packets)',
    'Code audit - alarms: maintenance on the switch holds back the alarms behind it, certificate warnings come after a maintenance, all clear to the escalation also after a maintenance, no alarms of paused monitors, deleted channels leave all monitors, setting the clock back does not stop the checks',
    'Code audit - data: a restore checks the backup completely first (schema update tried, an administrator present) and keeps the latest changes in the copy before; two NAS volumes of the same size, serial numbers written differently and long Linux drive names are recognised correctly',
    'Self-signed certificate: the key stays when it is renewed - machine scripts go on reporting. Create Windows scripts once more (they now check the key instead of the certificate)',
    'Manual: tables are shown as tables; notes on KVM rights, Windows Update, scan agent with a company CA',
  ] },
  { version: '0.10.1', date: '2026-11-13', de: [
    'Virtualisierung, Netzwerk-Controller, Server-Hardware: die kompakte Ansicht schon ab zwei Hosts',
    'Kaffee-Link sichtbar unten im Menü',
  ], en: [
    'Virtualisation, network controllers, server hardware: the compact view from two hosts on',
    'Coffee link visible at the bottom of the menu',
  ] },
  { version: '0.10.0', date: '2026-11-13', de: [
    'Rechner-Skripte melden Hardware (Modell, Seriennummer, BIOS, CPU, Speicher, Netzwerkkarten), Festplatten mit Zustand, Updates und Neustart, Virenschutz, Firewall, kritische Ereignisse und Zertifikate - Skript einmal neu erzeugen und verteilen',
    'Server-Hardware über iDRAC, iLO, XClarity, Supermicro (Redfish): Lüfter, Netzteile, Temperaturen, RAID und Laufwerke, Gesamt- und Stromzustand, mit Sensoren',
    'Virtualisierung übersichtlich auch bei vielen Hosts: Lage in Zahlen, eine Zeile je Host, Probleme zuerst, Suche bis hinunter zur VM',
    'Über WhatsOnMyNet: für alle über die Versionsnummer unten links erreichbar, mit „Was ist neu“, Quellcode, Website und Kaffee-Link',
    'Proxmox Backup Server: Port 8007 und Token-ID @pbs beim Anlegen richtig vorbelegt',
  ], en: [
    'Machine scripts report hardware (model, serial number, BIOS, CPU, memory, network cards), disks with health, updates and restart, virus protection, firewall, critical events and certificates - create and roll out the script once more',
    'Server hardware through iDRAC, iLO, XClarity, Supermicro (Redfish): fans, power supplies, temperatures, RAID and drives, overall and power state, with sensors',
    'Virtualisation clear also with many hosts: the situation in numbers, one line per host, problems first, search down to the VM',
    'About WhatsOnMyNet: reachable for everyone by the version number at the bottom left, with "What\'s new", source code, website and coffee link',
    'Proxmox Backup Server: port 8007 and token ID @pbs filled in correctly when adding',
  ] },
  { version: '0.9.0', date: '2026-11-13', de: [
    'Verlauf über Monate: 30 Tage, 90 Tage und ein Jahr, mit Spanne vom niedrigsten zum höchsten Wert und Verfügbarkeitsleiste',
    'USV-Werte: Synology, USV-Netzwerkkarten (UPS-MIB, APC), Linux (NUT, apcupsd) und Windows (USB) - Netz oder Akku, Akkustand, Restlaufzeit, Last',
    'Eskalation: ist eine Störung nach einer eingestellten Zeit nicht behoben, geht eine Meldung zusätzlich an weitere Kanäle',
  ], en: [
    'History over months: 30 days, 90 days and a year, with the range from lowest to highest value and an availability strip',
    'UPS values: Synology, UPS network cards (UPS-MIB, APC), Linux (NUT, apcupsd) and Windows (USB) - mains or battery, charge, runtime, load',
    'Escalation: when an outage is not solved after a set time, a message also goes to further channels',
  ] },
  { version: '0.8.0', date: '2026-11-13', de: [
    'Abhängigkeiten: fällt ein Switch aus, kommt eine Meldung statt einer Alarmflut - alles dahinter ist Folgestörung',
    '„Rechner per Skript“ direkt unter „Überwachen“ und „Monitor anlegen“',
    'Scan: ignorierte Geräte lassen sich zurückholen',
  ], en: [
    'Dependencies: when a switch fails, one message instead of an alarm flood - everything behind it is a follow-up outage',
    '"Machine by script" right under "Monitor" and "Add monitor"',
    'Scan: ignored devices can be brought back',
  ] },
  { version: '0.7.0', date: '2026-11-13', de: [
    'Windows- und Linux-Rechner per Skript überwachen, ohne Agent - mit Deinstallationsskript',
    'Gerätedaten bleiben aktuell, ein Gerätetausch an gleicher Adresse wird erkannt',
    'Netzwerk-Controller: UniFi, Omada und MikroTik; bessere Erkennung beim Scan',
  ], en: [
    'Monitor Windows and Linux machines by script, without agent - with uninstall script',
    'Device data stays current, an exchanged device at the same address is recognised',
    'Network controllers: UniFi, Omada and MikroTik; better recognition while scanning',
  ] },
  { version: '0.6.0', date: '2026-11-13', de: [
    'Eigenes Erscheinungsbild',
    'Monitoring: Messwerte direkt in der Liste',
    '15 weitere Benachrichtigungsdienste mit Anleitung',
    'Virtualisierung: VMware, XCP-ng, Hyper-V, Nutanix, oVirt und KVM neben Proxmox',
    'Gerät umbenennen nimmt die Monitore mit; Seriennummer, Modell und Firmware per SNMP ins Gerät',
  ], en: [
    'An appearance of its own',
    'Monitoring: measured values right in the list',
    '15 more notification services with instructions',
    'Virtualisation: VMware, XCP-ng, Hyper-V, Nutanix, oVirt and KVM next to Proxmox',
    'Renaming a device renames its monitors; serial number, model and firmware by SNMP into the device',
  ] },
  { version: '0.5.0', date: '2026-11-13', de: [
    'Übersichtlichere Oberfläche',
    'Active Directory: Zertifikat vom DC abrufen, Test Schritt für Schritt',
    'Proxmox: geführte Einrichtung; Berichte für einzelne Geräte',
  ], en: [
    'A clearer interface',
    'Active Directory: fetch the certificate from the DC, test step by step',
    'Proxmox: guided setup; reports for single devices',
  ] },
  { version: '0.4.0', date: '2026-11-13', de: [
    'Sensoren auf Gerätewerte, Proxmox VE und Backup Server, Netzlaufwerke (SMB)',
    'Geplante Berichte per E-Mail, Sicherung und Wiederherstellung im Browser',
    'Anmeldung mit zweitem Faktor; Handbuch als PDF und Hilfe in der App',
  ], en: [
    'Sensors on device values, Proxmox VE and Backup Server, network drives (SMB)',
    'Planned reports by e-mail, backup and restore in the browser',
    'Two-factor sign-in; manual as PDF and help in the app',
  ] },
  { version: '0.3.0', date: '2026-11-12', de: [
    'Nächtlicher Leicht-Scan mit Meldung neuer Geräte, Drucker, Switches und NAS per SNMP',
    'Docker-Container und Datenbanken überwachen, Netzplan',
    'Anmeldung mit Active Directory, Rechte pro Standort, Scan-Agent für Außenstellen',
  ], en: [
    'Nightly light scan with notice of new devices, printers, switches and NAS by SNMP',
    'Monitor Docker containers and databases, network map',
    'Sign-in with Active Directory, rights per location, scan agent for branch offices',
  ] },
  { version: '0.2.0', date: '2026-11-12', de: [
    'Monitoring: Prüfungen, Alarme per E-Mail, Telegram und Webhook, Zertifikate, Wartungsfenster',
    'Inventar: Vorschläge beim Tippen und Sammelbearbeitung',
  ], en: [
    'Monitoring: checks, alarms by e-mail, Telegram and webhook, certificates, maintenance windows',
    'Inventory: suggestions while typing and bulk edit',
  ] },
  { version: '0.1.0', date: '2026-11-12', de: ['Die erste Version: Netzwerkscan, Geräteerkennung und Inventar'], en: ['The first version: network scan, device recognition and inventory'] },
];
