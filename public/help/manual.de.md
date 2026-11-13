# WhatsOnMyNet – Handbuch

WhatsOnMyNet findet, was in deinem Netz läuft, und hält nur das im Inventar, was du übernimmst. Dazu überwacht es Geräte, Dienste und Webseiten, liest Drucker, Switches, NAS und Proxmox aus und meldet sich per E-Mail, Telegram oder Webhook, wenn etwas nicht stimmt.

![Übersicht](img/dashboard-de.png)

## Installation

WhatsOnMyNet läuft als Docker-Container mit Host-Netzwerk – nur so sieht der Scan die MAC-Adressen der Geräte.

1. `docker-compose.yml` und `env.example` aus dem Release in einen Ordner legen, `env.example` in `.env` umbenennen.
2. In der `.env` bei Bedarf Ports (`WOMN_HTTPS_PORT`, Standard 8743), Zeitzone (`TZ`) und Besitzer der Daten (`PUID`/`PGID`) anpassen.
3. `docker compose up -d` – oder den Stack in Dockhand anlegen.
4. Den **Einrichtungscode** aus dem Log holen (`docker compose logs whatsonmynet`) und `https://<server>:8743/setup` öffnen. Dort legst du den ersten Administrator an.

Die Oberfläche läuft immer über HTTPS. Beim ersten Start erzeugt WhatsOnMyNet ein selbstsigniertes Zertifikat; ein eigenes (PEM oder PFX) lädst du unter *Einstellungen → HTTPS-Zertifikat* hoch.

**Ping:** Der Container läuft ohne Root-Rechte. Ping funktioniert, wenn der Host normalen Benutzern ICMP erlaubt (`net.ipv4.ping_group_range`, bei Debian/Ubuntu/Proxmox Standard; in LXC-Containern `0 65535` setzen). Ohne Ping findet der Scan Geräte trotzdem über ARP und TCP.

## Erste Schritte

1. **Standort anlegen** (*Standorte*): Name und Subnetze, z. B. „Hauptgebäude“ mit `192.168.10.0/24`.
2. **Netzwerk scannen** (*Netzwerk scannen*): Standort anhaken, „Scan starten“. Der Radar zeigt die gefundenen Geräte; der Scan ist schonend (ARP, rund 25 typische Ports, SNMP nur lesend).
3. **Übernehmen**: Im Ergebnis unter „Neu“ Typ und Name prüfen, Geräte anhaken, „Ins Inventar übernehmen“. Was du nicht im Inventar willst, „Ignorieren“.

![Scan mit Radar](img/scan-de.png)

Die MAC-Adresse ist die Identität eines Geräts: Bekommt es eine neue IP, übernimmt der nächste Scan sie automatisch und schreibt es in den Verlauf.

## Inventar

![Inventar](img/inventory-de.png)

- **Suchen und filtern** nach Name, IP, MAC, Hersteller, Typ, Standort oder Schlagwort; Export als CSV oder JSON.
- **Geräteseite**: alle Angaben, Kauf- und Garantiedaten, Notizen, Schnellzugriff auf die Weboberfläche, was der Scan erkannt hat, Verlauf aller Änderungen.
- **Vorschläge beim Ausfüllen**: Hersteller, Modell, Betriebssystem, Verantwortlicher, Lieferant und Schlagwörter schlagen vor, was schon im Inventar steht. Ein bekanntes Modell füllt Hersteller und Typ aus.
- **Mehrfachauswahl**: Geräte anhaken und gemeinsam bearbeiten (Typ, Standort, Hersteller, Modell, Daten, Schlagwörter) oder löschen.
- **Tiefenprüfung**: prüft ein einzelnes Gerät mit einer längeren Port-Liste. Telematik-Geräte (Konnektor, Kartenterminal) werden immer nur schonend geprüft.

## Nächtlicher Leicht-Scan

Jede Nacht (Standard 02:30) sucht WhatsOnMyNet in allen Subnetzen deiner Standorte nur nach Geräten – ohne Ports, ohne SNMP. Bekannte Geräte bekommen ihre neue IP; ein Gerät, das zum allerersten Mal auftaucht, wird einmal gemeldet. Einstellungen, Uhrzeit und „Jetzt ausführen“ findest du unter *Einstellungen → Scan*.

## Monitoring

![Monitoring](img/monitoring-de.png)

Ein Monitor prüft regelmäßig (20 Sekunden bis 24 Stunden) und meldet sich erst nach mehreren Fehlversuchen hintereinander. Arten:

- **Web (HTTP/S)** mit Statuscodes, Stichwort und Ablaufdatum des Zertifikats (Warnung z. B. 30, 14 und 7 Tage vorher)
- **TCP-Port** und **Ping**
- **Docker-Container** (über einen Socket-Proxy, *Einstellungen → Docker*): läuft, startet ständig neu, Healthcheck „unhealthy“
- **Datenbanken**: MariaDB/MySQL, PostgreSQL, Redis/Valkey – Anmeldung und eine harmlose Abfrage
- **Netzlaufwerk (SMB)**: Windows-Freigaben und NAS – siehe unten
- **Sensor (Gerätewert)**, **SNMP-Wert (OID)** und **Proxmox** – siehe unten

Auf der Geräteseite legt „Überwachen“ einen passenden Monitor an. Ändert sich die IP eines Geräts, ziehen seine Monitore mit.

![Monitor mit Verlauf](img/monitor-de.png)

**Benachrichtigungen** (*Einstellungen → Benachrichtigungen*): E-Mail (über den SMTP-Server), Telegram-Bot und Webhook mit eigener JSON-Vorlage. Jeder Kanal hat eine Testnachricht. **Wartungsfenster** (einmalig oder wöchentlich) unterdrücken Alarme.

## Drucker, Switches und NAS

Geräte vom Typ *Drucker*, *Switch* und *NAS* werden per SNMP gefragt (nur lesend). Die Community stellst du unter *Einstellungen → Scan* ein; am Gerät muss SNMP v1/v2c an sein.

![Drucker](img/printer-de.png)

- **Drucker**: Toner bzw. Tinte je Farbe, Trommel, Resttoner, Seitenzähler, Störungen und Display-Text. Unter 15 % kommt eine Meldung – einmal pro Kartusche.
- **Switch**: Ports als Kacheln, welche Geräte an welchem Port hängen (auch mit VLANs), LLDP-Nachbarn, Firmware. Jede Geräteseite zeigt „Angeschlossen an“.
- **NAS**: Volumes, bei Synology auch Festplatten, RAID, Temperatur, Lüfter, Netzteil und DSM-Update. Probleme werden gemeldet – und wieder, wenn alles in Ordnung ist.

![Switch](img/switch-de.png)

![NAS](img/nas-de.png)

### Netzplan

Der *Netzplan* zeigt aus den MAC-Tabellen und LLDP, welches Gerät an welchem Port hängt und wie die Switches verbunden sind. Einfache Switches ohne SNMP erscheinen als Zweig hinter dem Port, an dem sie stecken. Hinter Routern liest der Scan die ARP-Tabelle der Router per SNMP, damit die MAC-Adresse auch dort die Identität bleibt.

![Netzplan](img/topology-de.png)

## Sensoren

Jeder Wert, den ein Gerät liefert, kann ein eigener Monitor werden – mit Verlauf, Alarm und Wartungsfenstern. Auf der Geräteseite „Sensor anlegen“, dann Wert und Bedingung wählen, z. B.:

- „Toner Cyan kleiner oder gleich 10 %“
- „Belegung /volume1 größer oder gleich 85 %“
- „Temperatur Drive 2 größer als 50 °C“
- „Port 10 (Uplink) verbunden“

Der Typ **SNMP-Wert (OID)** fragt jeden beliebigen SNMP-Wert ab (z. B. Restlaufzeit einer USV) und vergleicht mit kleiner, größer, gleich oder „enthält Text“.

## Netzlaufwerke (SMB)

![Netzlaufwerk](img/smb-de.png)

Der Typ **Netzlaufwerk (SMB)** meldet sich wirklich an einer Freigabe an – nicht nur am offenen Port. So fällt auch auf, wenn das Passwort abgelaufen ist, die Rechte nicht mehr stimmen oder ein Ordner fehlt.

1. Ein eigenes Konto nur mit **Leserecht** auf die Freigabe anlegen (im AD z. B. `FIRMA\monitor`, auf dem NAS ein lokaler Benutzer).
2. *Monitor anlegen* → Art **Netzlaufwerk (SMB)**. Einfach den Pfad einfügen, z. B. `\\fs01\Abteilung\Projekte` – Server, Freigabe und Ordner werden daraus übernommen.
3. Benutzer, Domäne (bei NAS-Konten leer) und Passwort eintragen. Optional: warnen unter … % oder … GB frei.

Geprüft wird über SMB 2/3: anmelden, die Freigabe (oder den Ordner bzw. die Datei) lesen, den freien Platz abfragen. WhatsOnMyNet schreibt nichts auf die Freigabe. Die Detailseite zeigt den freien Platz; im Bericht gibt es dafür den Abschnitt *Netzlaufwerke*.

## Proxmox VE und Backup Server

![Proxmox](img/proxmox-de.png)

Unter *Einstellungen → Proxmox* liest WhatsOnMyNet Proxmox über dessen API – dort wird nichts installiert.

1. In Proxmox VE: *Rechenzentrum → Berechtigungen → API-Token* anlegen, „Privilegien trennen“ an, dem Token die Rolle **PVEAuditor** auf `/` geben. Beim Backup Server: *Konfiguration → Zugriffskontrolle → API-Token*, Rolle **Audit**.
2. In WhatsOnMyNet Adresse (`https://pve01:8006` bzw. `:8007`), Token-ID (`monitor@pve!womn`) und Geheimnis eintragen.
3. Für das selbstsignierte Zertifikat den Inhalt von `/etc/pve/pve-root-ca.pem` (VE) bzw. `/etc/proxmox-backup/proxy.pem` (Backup Server) einfügen.

Angezeigt werden Knoten, Speicher, VMs und Container, Sicherungen, Datastores und fehlgeschlagene Aufgaben. „Sensor anlegen“ überwacht z. B. „VM 101 läuft“ oder „letzte Sicherung älter als 26 Stunden“.

## Berichte

![Bericht](img/report-de.png)

Unter *Einstellungen → Berichte* gehen Berichte zu festen Zeiten per E-Mail raus – z. B. jeden Montag um 8 Uhr die Tonerstände ans Büro.

- Inhalt: Drucker, NAS, Switches, Netzlaufwerke; auf Standorte beschränkbar; wahlweise nur Geräte mit Handlungsbedarf.
- **Geräte**: alle Geräte der gewählten Inhalte – oder nur ausgewählte, z. B. ein eigener Bericht für den Drucker im Sekretariat.
- Drucker zeigen die **gedruckten Seiten** (gesamt und im Berichtszeitraum, z. B. „in den letzten 7 Tagen“) und – wenn der Drucker es meldet – wie viele Seiten der Toner noch reicht.
- Die Mail ist **neutral**: kein Link, kein Programmname – nur dein Absendername, Betreff (`{kw}`, `{datum}`), Einleitung, die Geräte und dein Gruß.
- „Vorschau“, „Test an mich“ und „Jetzt senden“ direkt in der Liste.

## Benutzer und Rechte

- **Rollen**: *Administrator* (alles), *Bearbeiter* (scannen, übernehmen, pflegen, Monitore), *Nur lesen*.
- **Standorte**: Bearbeiter und Leser lassen sich auf Standorte beschränken – sie sehen und ändern dann nur deren Geräte, Scans und Monitore.
- **Active Directory** (*Einstellungen → Active Directory*): Anmeldung mit dem Windows-Konto über LDAPS oder StartTLS. Die Rolle kommt aus AD-Gruppen; wer in keiner Gruppe ist, kommt nicht herein. Lokale Konten haben bei gleichem Namen Vorrang. Unter *TLS-Zertifikat* holt „Zertifikat vom DC abrufen“ die Kette vom Domänencontroller (fehlende CAs über AIA oder aus dem AD); du vergleichst den Fingerabdruck mit certlm.msc und bestätigst.
- **Zwei-Faktor-Anmeldung** (*Mein Konto*): QR-Code mit einer Authenticator-App scannen, Code bestätigen, Wiederherstellungscodes aufbewahren. Für Administratoren lässt sie sich unter *Einstellungen → Allgemein* verpflichtend machen.

## Scan-Agent für Außenstellen

Für eine Außenstelle läuft dort ein zweiter Container als Scan-Agent. Unter *Einstellungen → Scan-Agenten* einen Agenten für den Standort anlegen; die angezeigte `.env` neben die `docker-compose.agent.yml` aus dem Release legen und `docker compose -f docker-compose.agent.yml up -d` starten. Der Agent öffnet keinen Port, holt sich Aufträge über HTTPS und meldet nur Adressen seines Standorts.

## Sicherung und Updates

- Jede Nacht sichert WhatsOnMyNet die Datenbank nach `data/backups/`; vor jedem Update der Datenbank zusätzlich.
- *Einstellungen → Sicherung*: Sicherung herunterladen, jetzt sichern, Sicherung einspielen (der aktuelle Stand wird vorher gesichert, dann startet das Programm neu).
- **Bewahre `data/secret.key` (bzw. `WOMN_SECRET`) mit auf** – ohne ihn sind gespeicherte Passwörter in einer Sicherung unlesbar.
- Updates: in Dockhand/Watchtower oder `docker compose pull && docker compose up -d`. Einmal im Monat erscheint ein Sicherheits-Update mit neuen Paketen.

## Fehlerbehebung

- **Oberfläche nicht erreichbar**: Firewall des Hosts für den HTTPS-Port öffnen. Mit Host-Netzwerk zeigt Docker/Dockhand keine Port-Zuordnung – das ist richtig so.
- **Keine Drucker-/Switch-Daten**: SNMP am Gerät einschalten, Community unter *Einstellungen → Scan* prüfen, auf der Geräteseite „Jetzt abfragen“.
- **Ausgesperrt**: `docker compose exec whatsonmynet womn-admin reset <benutzer>` setzt ein neues Passwort, macht das Konto wieder zum Administrator und schaltet die Zwei-Faktor-Anmeldung aus. `womn-admin create <benutzer>` legt einen neuen Administrator an.
- **Netzlaufwerk meldet „protocol not supported“**: Das Gerät kann nur das alte SMB1 – das wird aus Sicherheitsgründen nicht verwendet. SMB2/3 am Gerät einschalten (bei Synology: *Dateidienste → SMB → Erweitert*).
- **Protokoll**: *Einstellungen → Protokoll* zeigt, wer was geändert hat; technische Meldungen stehen im Container-Log.
