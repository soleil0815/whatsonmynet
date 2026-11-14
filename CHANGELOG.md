# Neuigkeiten

Was sich in WhatsOnMyNet geändert hat - dieselben Texte wie im Programm unter *Über WhatsOnMyNet* (Klick auf die Versionsnummer unten links). English: [CHANGELOG.en.md](CHANGELOG.en.md)

<!-- generated from public/js/changelog.js by tools/changelog.mjs - do not edit here -->

## Nächste Version (noch nicht veröffentlicht)

- Mehrere Sensoren oder Monitore ankreuzen und löschen: nach dem Bestätigen passierte nichts - jetzt werden sie gelöscht. Ebenso das Einspielen einer hochgeladenen Sicherung
- Neue NAS: Sensoren nur auf den Datenvolumes (/volume1 …), nicht auf der Systempartition (/, /opt) oder internen Ordnern wie /volume1/@docker
- USV: die Restlaufzeit unter einer Stunde in Minuten („reicht 25 Min.“ statt „reicht 0 Std.“)

## 0.21.0 - 2026-11-14

- Gleich überwacht: Übernommene oder neu angelegte Geräte bekommen sofort einen Monitor (Weboberfläche, sonst Ping) und, sobald sie Werte liefern, ein paar wichtige Sensoren - Toner beim Drucker, Volumes, RAID und Temperatur beim NAS, CPU, RAM, Systemlaufwerk, Temperatur und Dienste bei Rechnern mit Skript, Knoten, Speicher und Sicherungen bei Hypervisoren. Abschaltbar unter Einstellungen → Benachrichtigungen
- Neue Bilder in der Projektbeschreibung und im Handbuch: Diagramm mit Ausfällen, Sensor mit Grenzwert, Sensoren, Ausfallsicherung; Übersicht „Auf einen Blick“
- Neuigkeiten auch als Datei im Projekt (CHANGELOG.md, englisch CHANGELOG.en.md) und als Text jeder Version auf GitHub - dieselben Texte wie hier

## 0.20.0 - 2026-11-14

- Ausfallsicherung (Einstellungen → Ausfallsicherung): ein zweites WhatsOnMyNet als Standby. Koppeln mit Adresse und Code vom Master; der Standby übernimmt jede Minute ein Lebenszeichen und alle 5 Minuten die Daten, alarmiert selbst nicht und zeigt nur an. Antwortet der Master länger als eingestellt (Standard 10 Minuten) nicht, überwacht und alarmiert der Standby; ist der Master wieder da, gibt er ab und holt dessen Daten. „Zum Master machen“ für den Fall, dass der alte nicht wiederkommt

## 0.19.0 - 2026-11-14

- Diagramm eines Monitors oder Sensors: Ausfälle rot hinterlegt mit Beginn, Ende und Dauer, darunter als Liste mit Grund; Zusammenfassung (wie oft, wie lange); Fadenkreuz mit Uhrzeit und Wert beim Zeigen; bei Sensoren der Grenzwert als Linie; Zeitachse mit Uhrzeiten und Tagen, auch am Telefon gut lesbar
- Kaffee-Knopf unter „Über WhatsOnMyNet“ wie der offizielle Buy-Me-a-Coffee-Knopf (gelb, Tassen-Logo, „Buy me a coffee“); das Logo auch klein im Menü - alles im Programm enthalten, nichts wird aus dem Internet geladen

## 0.18.0 - 2026-11-14

- Überwachung: mehrere Monitore oder Sensoren ankreuzen (auch „alle angezeigten“) und gemeinsam bearbeiten - Prüfintervall, Fehlversuche, Zeitlimit, Wiederholung, Eskalation und Kanäle, bei Sensoren auch Bedingung und Grenzwert; nur ausgefüllte Felder werden geändert. Pausieren, Fortsetzen und Löschen gehen ebenfalls für alle auf einmal

## 0.17.0 - 2026-11-14

- Sensor anlegen: Werte, die schon ein Sensor überwacht, werden nicht noch einmal angeboten (auch nicht über den Hypervisor, wenn das Linux-Skript denselben Wert liefert)
- Dialoge: Enter speichert, Fehler stehen direkt am betroffenen Feld; Einstellungen am Handy als Auswahlliste
- Rechnername: von Hand eingetragen bleibt er - der Scan füllt ihn nur, solange er leer ist oder vom Scan stammt (gilt auch für Namen, die vor dem Update von Hand eingetragen wurden)
- Monitore mit gespeichertem Passwort werden bei neuer IP des Geräts pausiert und zeigen „Gerät hat neue IP - Passwort bitte neu eingeben“; mit neuem Passwort laufen sie an der neuen Adresse weiter. Die Benachrichtigungskanäle des Monitors erfahren davon; kehrt das Gerät zur alten Adresse zurück, läuft er von selbst wieder
- Übernehmen und Ignorieren nur noch aus dem neuesten Scan eines Subnetzes (ältere Scans bleiben lesbar, „Nicht mehr ignorieren“ geht weiter); „Wartung“ wird ab Beginn des Wartungsfensters angezeigt
- Scan: öffentliche Netze dürfen nur Administratoren scannen; die Tiefenprüfung fragt bei unbekannten Geräten erst Port 4742 und prüft Kartenterminals nur schonend
- Sicherheit: CSV-Export entschärft auch Formeln nach einem Komma; die Sicherung zum Herunterladen liegt nur für WhatsOnMyNet lesbar im Datenordner
- Code-Audit - Sicherheit: HSTS nie mit einem hochgeladenen, selbst signierten Zertifikat; ein hochgeladenes Zertifikat wird nicht mehr durch ein selbst erzeugtes ersetzt (auch nicht bei fehlenden Metadaten oder gleichzeitiger Erneuerung); zusätzliche Schutz-Header für den Browser
- Code-Audit - Sicherheit: AD kann den letzten Administrator nicht mehr herabstufen; nach einer Wiederherstellung müssen sich alle neu anmelden; die Liste ignorierter Geräte zeigt standortbeschränkten Konten nur ihre Standorte
- Code-Audit - Stabilität: ein Proxmox-Token mit unzulässigen Zeichen kann den Server nicht mehr beenden (wird beim Speichern abgelehnt); ein kaputter Zeitstempel im Linux-Skript verwirft nicht mehr den ganzen Bericht
- Code-Audit - Inventar: ein Rechner-Skript mit dem gemeinsamen Schlüssel landet nie auf einem Gerät mit anderer MAC; Monitore aller Arten folgen dem Gerät bei neuer IP (auch bei Änderung von Hand; mit gespeichertem Passwort bleiben sie an der alten Adresse); keine doppelten Geräte ohne MAC bei der Übernahme; Übernahme aus einem älteren Scan zeigt das Gerät nicht fälschlich online; Weblink wird bei IP-Wechsel nicht mehr verfälscht; Umbenennen ändert nur den Gerätenamen am Anfang der Monitornamen; Typwechsel räumt alte SNMP-Meldungen weg; Redfish macht aus einem Hypervisor keinen Server
- Code-Audit - Scan: HPE-Geräte (iLO, Aruba) werden nicht mehr als Drucker erkannt, Samsung-/LG-Fernseher und Dahua-/Uniview-Kameras richtig; Abbruch wirkt sofort; überlappende Subnetze werden nur einmal gescannt; der Nacht-Scan läuft auch nach Mitternacht nach; Scans von Agenten werden aufgeräumt
- Code-Audit - Alarme: ein Ausfall, der über ein Wartungsfenster hinaus andauert, meldet sich nicht doppelt, und die Entwarnung nennt die ganze Dauer
- Bedienung: kein doppeltes Anlegen bei mehrfachem Klick auf Speichern; Fehlermeldungen in Dialogen sichtbar; Handy-Ansicht ohne seitliches Scrollen; Leser und Bearbeiter bekommen passende Hinweise; Portnamen ohne englische Begriffe; Sprachwechsel auf Anmelde-/Einrichtungsseite behält die Eingaben; besser per Tastatur und Screenreader bedienbar (Sprunglink, Menü, Beschriftungen)

## 0.16.0 - 2026-11-13

- Sensor bearbeiten: wird ein anderer Wert gewählt, bekommt der Sensor dessen Namen (z. B. „pve2: Temperatur: NVMe nvme0 Sensor 2“) - außer der Name wird im Dialog selbst geändert
- Beim Update einmalig: alle Sensoren werden nach ihrem Wert benannt, damit alte Namen wie „Temperatur pve2“ nach einem Wechsel des Werts wieder stimmen

## 0.15.0 - 2026-11-13

- Ein Dialog für alle Sensoren: ob vom Gerät im Inventar oder vom Host unter Virtualisierung - ein Proxmox-Knoten zeigt dieselbe Liste mit den Werten von Proxmox und denen des Linux-Skripts (jede Temperatur, Festplatten, Dienste). Doppelte Werte (CPU, RAM, höchste Temperatur) nur einmal. Unter Virtualisierung nach Knoten gruppiert. Bestehende Sensoren lassen sich beim Bearbeiten auf jeden Wert der Liste umstellen

## 0.14.1 - 2026-11-13

- Sensor anlegen: jede Temperatur, jede Festplatte und jedes Zertifikat steht mit Namen in der Auswahl (z. B. „Temperatur: NVMe nvme0 Sensor 2“) statt zigmal nur „Temperatur“; bei vielen Werten nach Bereichen gruppiert
- Kaffee-Knopf unter „Über WhatsOnMyNet“ gelb, damit er auffällt

## 0.14.0 - 2026-11-13

- Alarme sagen, was los ist: bei Messwerten „Grenzwert überschritten - 83,9 °C (≥ 80)“ und „wieder im normalen Bereich“, bei Zuständen „Störung“/„wieder in Ordnung“, ohne Werte „keine aktuellen Werte“ - „nicht erreichbar“ nur noch für Webseite, Port und Ping. Ergebnisse der Prüfungen auf Deutsch
- Sensoren eigener Menüpunkt unter Überwachung (Monitore - Sensoren - Wartungsfenster)
- Wartungsfenster: Auswahl nach Monitoren und Sensoren, je Gerät bzw. Hypervisor gruppiert, mit Suche und „ganzes Gerät“; auf der Seite jedes Monitors/Sensors „Zeiten ohne Alarm“ mit „Zeitfenster ohne Alarm“ nur für diesen

## 0.13.0 - 2026-11-13

- Proxmox-VE-Cluster: einen Knoten eintragen genügt - WhatsOnMyNet holt sich die Adressen und Zertifikate der anderen Knoten vom Cluster selbst. Antwortet der eingetragene Knoten nicht, wird der nächste gefragt (mit demselben Token, Zertifikat geprüft); die Seite Virtualisierung zeigt, über welchen Knoten gelesen wurde

## 0.12.0 - 2026-11-13

- Sensor „Temperatur“ direkt am Proxmox-Knoten (Virtualisierung → Sensor anlegen): die höchste Temperatur des Knotens mit Alarm, Warnschwelle vom Chip

## 0.11.0 - 2026-11-13

- Temperaturen von Linux-Rechnern und Proxmox-Knoten: das Linux-Skript liest CPU, NVMe, Chipsatz und Mainboard (wie „sensors“, ohne lm-sensors und ohne root) - mit Sensoren „Temperatur“ und „die höchste“, Warnschwelle vom Chip selbst. Auf der Seite Virtualisierung steht die Temperatur am Knoten. Linux-Skript einmal neu erzeugen

## 0.10.2 - 2026-11-13

- Menü passt auch in niedrige Fenster: es lässt sich scrollen und rückt bei wenig Höhe enger zusammen - Konto, Abmelden, Version und Kaffee-Link sind immer erreichbar
- Code-Audit - Sicherheit: AD-Anmeldung zählt Fehlversuche je Konto (auch bei gleichzeitigen Versuchen und anderer Schreibweise), verrät nicht mehr, ob ein AD-Passwort stimmt, und angemeldete AD-Benutzer werden alle 15 Minuten neu geprüft (im AD gesperrt → abgemeldet, andere Gruppe → neue Rolle)
- Code-Audit - Sicherheit: ein gespeichertes Passwort (Datenbank, Netzlaufwerk, Proxmox-Token) geht nur noch an die Adresse, für die es eingegeben wurde; ein angehefteter Firmen-CA prüft wieder den Namen des Servers; Datenbank-Monitore können das Server-Zertifikat prüfen
- Code-Audit - Sicherheit: Standort-Beschränkungen bleiben auch, wenn ein Standort gelöscht wird; Scan-Agenten ändern nur Geräte ihres Standorts; der gemeinsame Rechner-Schlüssel erreicht keine Geräte mit eigenem Schlüssel; Windows-Skript schützt seinen Ordner vor dem Kopieren
- Code-Audit - Stabilität: ein bösartiges Gerät kann Scan, Monitoring und Benachrichtigungen nicht mehr anhalten oder den Server beenden (Zeitlimits für die ganze Abfrage, Größengrenzen, kein Absturz durch kaputte NetBIOS-Pakete)
- Code-Audit - Alarme: Wartung am Switch hält die Alarme dahinter zurück, Zertifikatswarnungen kommen nach einer Wartung nach, Entwarnung an die Eskalation auch nach einer Wartung, keine Alarme pausierter Monitore, gelöschte Kanäle verschwinden aus allen Monitoren, Zeitumstellung der Uhr hält die Prüfungen nicht an
- Code-Audit - Daten: Wiederherstellung prüft die Sicherung vorher vollständig (Schema-Update probeweise, ein Administrator vorhanden) und behält die letzten Änderungen in der Kopie davor; zwei gleich große NAS-Volumes, anders geschriebene Seriennummern und lange Linux-Laufwerksnamen werden richtig erkannt
- Selbstsigniertes Zertifikat: bei der Erneuerung bleibt der Schlüssel - Rechner-Skripte melden weiter. Windows-Skripte einmal neu erzeugen (sie prüfen jetzt den Schlüssel statt des Zertifikats)
- Handbuch: Tabellen werden als Tabellen angezeigt; Hinweise zu KVM-Rechten, Windows-Update, Scan-Agent mit Firmen-CA

## 0.10.1 - 2026-11-13

- Virtualisierung, Netzwerk-Controller, Server-Hardware: die kompakte Ansicht schon ab zwei Hosts
- Kaffee-Link sichtbar unten im Menü

## 0.10.0 - 2026-11-13

- Rechner-Skripte melden Hardware (Modell, Seriennummer, BIOS, CPU, Speicher, Netzwerkkarten), Festplatten mit Zustand, Updates und Neustart, Virenschutz, Firewall, kritische Ereignisse und Zertifikate - Skript einmal neu erzeugen und verteilen
- Server-Hardware über iDRAC, iLO, XClarity, Supermicro (Redfish): Lüfter, Netzteile, Temperaturen, RAID und Laufwerke, Gesamt- und Stromzustand, mit Sensoren
- Virtualisierung übersichtlich auch bei vielen Hosts: Lage in Zahlen, eine Zeile je Host, Probleme zuerst, Suche bis hinunter zur VM
- Über WhatsOnMyNet: für alle über die Versionsnummer unten links erreichbar, mit „Was ist neu“, Quellcode, Website und Kaffee-Link
- Proxmox Backup Server: Port 8007 und Token-ID @pbs beim Anlegen richtig vorbelegt

## 0.9.0 - 2026-11-13

- Verlauf über Monate: 30 Tage, 90 Tage und ein Jahr, mit Spanne vom niedrigsten zum höchsten Wert und Verfügbarkeitsleiste
- USV-Werte: Synology, USV-Netzwerkkarten (UPS-MIB, APC), Linux (NUT, apcupsd) und Windows (USB) - Netz oder Akku, Akkustand, Restlaufzeit, Last
- Eskalation: ist eine Störung nach einer eingestellten Zeit nicht behoben, geht eine Meldung zusätzlich an weitere Kanäle

## 0.8.0 - 2026-11-13

- Abhängigkeiten: fällt ein Switch aus, kommt eine Meldung statt einer Alarmflut - alles dahinter ist Folgestörung
- „Rechner per Skript“ direkt unter „Überwachen“ und „Monitor anlegen“
- Scan: ignorierte Geräte lassen sich zurückholen

## 0.7.0 - 2026-11-13

- Windows- und Linux-Rechner per Skript überwachen, ohne Agent - mit Deinstallationsskript
- Gerätedaten bleiben aktuell, ein Gerätetausch an gleicher Adresse wird erkannt
- Netzwerk-Controller: UniFi, Omada und MikroTik; bessere Erkennung beim Scan

## 0.6.0 - 2026-11-13

- Eigenes Erscheinungsbild
- Monitoring: Messwerte direkt in der Liste
- 15 weitere Benachrichtigungsdienste mit Anleitung
- Virtualisierung: VMware, XCP-ng, Hyper-V, Nutanix, oVirt und KVM neben Proxmox
- Gerät umbenennen nimmt die Monitore mit; Seriennummer, Modell und Firmware per SNMP ins Gerät

## 0.5.0 - 2026-11-13

- Übersichtlichere Oberfläche
- Active Directory: Zertifikat vom DC abrufen, Test Schritt für Schritt
- Proxmox: geführte Einrichtung; Berichte für einzelne Geräte

## 0.4.0 - 2026-11-13

- Sensoren auf Gerätewerte, Proxmox VE und Backup Server, Netzlaufwerke (SMB)
- Geplante Berichte per E-Mail, Sicherung und Wiederherstellung im Browser
- Anmeldung mit zweitem Faktor; Handbuch als PDF und Hilfe in der App

## 0.3.0 - 2026-11-12

- Nächtlicher Leicht-Scan mit Meldung neuer Geräte, Drucker, Switches und NAS per SNMP
- Docker-Container und Datenbanken überwachen, Netzplan
- Anmeldung mit Active Directory, Rechte pro Standort, Scan-Agent für Außenstellen

## 0.2.0 - 2026-11-12

- Monitoring: Prüfungen, Alarme per E-Mail, Telegram und Webhook, Zertifikate, Wartungsfenster
- Inventar: Vorschläge beim Tippen und Sammelbearbeitung

## 0.1.0 - 2026-11-12

- Die erste Version: Netzwerkscan, Geräteerkennung und Inventar
