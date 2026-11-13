// What changed, per version, in plain words for the users of the program (not for developers).
// The newest version first. Entries of 'next' belong to the version being built: in a released image they are shown
// under its version number (see whatsNew in views/about.js). At the next release they get their number here.
export const CHANGELOG = [
  { version: 'next', de: [
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
