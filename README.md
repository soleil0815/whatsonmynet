# WhatsOnMyNet

*English version: [README.en.md](README.en.md)*

**Finde, was in deinem Netz läuft - und behalte nur, was wichtig ist.**

Netzwerk-Inventar, Monitoring und Sensoren in einem Container: WhatsOnMyNet scannt dein Netz, erkennt Geräte selbst, überwacht Webseiten, Dienste, Server und Hypervisoren und meldet sich, bevor jemand anruft. Läuft lokal, lädt nichts aus dem Internet, liest fremde Systeme nur.

> **Für den eigenen Einsatz gebaut - Nutzung in eigener Verantwortung.** Ich habe WhatsOnMyNet in erster Linie für mich selbst entwickelt, weil ich genau so ein Werkzeug in meiner eigenen Umgebung haben wollte: einfach im Einstieg wie Uptime Kuma, aber mit Inventar, Meldungen, Sensoren und Ausfallsicherung, wenn man tiefer gräbt. Ich nutze es selbst im Betrieb; Fehler fallen mir dadurch meist schnell auf und werden zügig behoben. Wenn du WhatsOnMyNet ebenfalls einsetzen möchtest: gern - aber in eigener Verantwortung. Es gibt keine Gewährleistung und keine Haftung (Abschnitte 15 und 16 der [Lizenz](LICENSE)). Probier es zuerst in einer Testumgebung aus und leg Sicherungen an. Fehlerberichte und Verbesserungsvorschläge sind willkommen - am besten als [Issue](https://github.com/soleil0815/whatsonmynet/issues); Sicherheitslücken bitte nicht öffentlich, sondern wie in [SECURITY.md](SECURITY.md) beschrieben melden. Support oder feste Antwortzeiten kann ich nicht zusagen.

![Meldungen durchsuchen und zeitlich eingrenzen](.github/readme/logsearch-de.webp)

<p>
  <img src=".github/readme/dashboard-de.webp" alt="Übersicht: was zu tun ist" width="49%">
  <img src=".github/readme/monitoring-de.webp" alt="Monitoring" width="49%">
  <img src=".github/readme/virtualization-de.webp" alt="Proxmox und Hyper-V" width="49%">
  <img src=".github/readme/topology-de.webp" alt="Netzplan" width="49%">
  <img src=".github/readme/eventrules-de.webp" alt="Windows-Ereignisse mit Regeln" width="49%">
  <img src=".github/readme/sensors-de.webp" alt="Sensoren mit Grenzwert" width="49%">
</p>

📖 **Handbuch:** [als PDF](public/help/WhatsOnMyNet-Handbuch.pdf) · in der App unter *Hilfe* · [English manual](public/help/WhatsOnMyNet-Manual.pdf) · **Neuigkeiten:** [CHANGELOG.md](CHANGELOG.md)

### Auf einen Blick

| | |
|---|---|
| 🔍 **Scan und Inventar** | Schonender Scan mit Radar, Hersteller und Gerätetyp von selbst (auch Telematik), Inventar per Häkchen, MAC als Ausweis, Netzplan aus den Switches |
| 📈 **Monitoring** | Neue Geräte sind gleich überwacht (Monitor und erste Sensoren von selbst); Web, TCP, Ping, Netzlaufwerke, Docker, MariaDB/PostgreSQL/Redis, Zertifikate - mit Eskalation, Abhängigkeiten, Gruppen (ein Alarm je Gruppe), Wartungsfenstern, Verlauf über ein Jahr und Statusseiten ohne Anmeldung (wie in Uptime Kuma) |
| 🌡️ **Sensoren wie bei PRTG** | Toner, Festplatten, Ports, USV, jede Temperatur, CPU, RAM, VMs und Sicherungen - mit Grenzwert, Alarm und Diagramm, das Ausfälle mit Beginn, Ende und Dauer zeigt |
| 🖥️ **Virtualisierung und Hardware** | Proxmox VE/Backup Server (auch Cluster), VMware, Hyper-V, XCP-ng, Nutanix, oVirt, KVM; UniFi, Omada, MikroTik; iDRAC, iLO, XClarity per Redfish. Läuft auf Knoten oder VMs das Skript, stehen Updates, Neustart, Dienste und Festplatten gleich mit dabei |
| 🧪 **Weitere Prüfungen** | Mailserver (SMTP/IMAP/POP3 mit TLS und Zertifikat), DNS, LDAP/Active Directory, Zeitserver (NTP), Microsoft SQL Server |
| 🔔 **Meldungen** | SNMP-Traps, Syslog (UDP, TCP, TLS) und Windows-Ereignisse (NXLog, Fluent Bit) empfangen, dem Gerät zuordnen, sofort alarmieren; Ereignisregeln schicken ausgewählte Meldungen per Mail oder ans Ticketsystem |
| 📈 **Prometheus & Grafana** | /metrics mit Schlüssel, fertiges Grafana-Dashboard |
| 🧩 **Eigene Prüfungen und Plugins** | Eigene Skripte im Checkmk-Format (Local Checks) auf Windows- und Linux-Rechnern; Plugins direkt in WhatsOnMyNet schreiben, für alle oder einzelne Rechner verteilen - es läuft nur genau die freigegebene Datei, ihre Werte werden Sensoren |
| 💾 **Veeam** | Jobs mit letztem Ergebnis, Repositories - Veeam Backup & Replication 12+ (REST, nur lesend) |
| ☁️ **Cloud** | AWS, Azure, Google Cloud, Microsoft 365 (Dienststatus, Störungen, Lizenzen): VMs mit den Prüfungen des Anbieters, Datenbanken, Load Balancer, Alarme, Kosten - nur lesend |
| 💻 **Rechner ohne Agent** | Windows und Linux melden sich per kleinem Skript: CPU, RAM, Laufwerke, Dienste, Updates, Virenschutz, Temperaturen |
| 🔔 **Benachrichtigungen** | E-Mail, Telegram, Teams, Slack, Discord, Matrix, Signal, ntfy, Gotify, Pushover, Home Assistant, Webhook und über Apprise 100 weitere |
| 🛟 **Ausfallsicherung** | Ein zweites WhatsOnMyNet als Standby übernimmt, wenn der Master ausfällt, und gibt danach samt Messwerten wieder ab; er weiß alles, was der Master weiß, auch die Meldungen - gekoppelt mit einem Code |
| 🔒 **Sicherheit** | HTTPS ab dem ersten Start, Active Directory, Zwei-Faktor-Anmeldung, Rechte pro Standort, Passwörter verschlüsselt, nur lesender Zugriff auf fremde Systeme |

| | | |
|---|---|---|
| ![Scan mit Radar](public/help/img/scan-de.png) | ![Netzplan](public/help/img/topology-de.png) | ![Monitoring](public/help/img/monitoring-de.png) |
| Schonender Scan mit Radar | Netzplan aus den Switches | Monitoring nach Gruppe, mit Verlauf |
| ![Monitor mit Ausfällen](public/help/img/monitor-de.png) | ![Sensor mit Grenzwert](public/help/img/sensor-de.png) | ![Sensoren](public/help/img/sensors-de.png) |
| Ausfälle mit Beginn, Ende und Dauer | Sensor mit Grenzwert und Alarmzeiten | Sensoren: Temperatur, RAM, Speicher, VMs |
| ![Drucker](public/help/img/printer-de.png) | ![Switch](public/help/img/switch-de.png) | ![Virtualisierung](public/help/img/proxmox-de.png) |
| Toner, Trommel, Zähler | Ports und angeschlossene Geräte | Proxmox, Hyper-V und mehr |
| ![Ausfallsicherung](public/help/img/failover-de.png) | ![Bericht](public/help/img/report-de.png) | ![Benachrichtigungen](public/help/img/settings-de.png) |
| Ausfallsicherung mit Standby | Geplante Berichte per E-Mail | Einstellungen mit kurzer Erklärung |
| ![Meldungen](public/help/img/events-de.png) | ![Ereignisregeln](public/help/img/eventrules-de.png) | ![Cloud](public/help/img/cloud-de.png) |
| Syslog, Traps und Windows-Ereignisse | Ereignisregeln: Mail oder Ticket | AWS, Azure, Google Cloud |
| ![Statusseite](public/help/img/statuspage-de.png) | ![Übersicht](public/help/img/dashboard-de.png) | ![NAS](public/help/img/nas-de.png) |
| Statusseite ohne Anmeldung | Übersicht auf einen Blick | NAS mit Platten und Volumes |

> Gebaut für den eigenen Einsatz. Wer WhatsOnMyNet nutzt, tut das in eigener Verantwortung.

## Was WhatsOnMyNet kann

- **Schonender Netzwerkscan** - Geräte im eigenen Netz werden über ARP gefunden (jedes Gerät antwortet darauf, auch mit geschlossener Firewall), in gerouteten Netzen über Ping und wenige TCP-Verbindungsversuche. Geprüft werden nur 26 typische Ports, gedrosselt auf 40 Versuche pro Sekunde. Für eine Firewall sieht das aus wie normaler Netzwerkverkehr.
- **Automatische Erkennung** - Hersteller aus der MAC-Adresse (IEEE-Liste), Gerätetyp aus offenen Ports, Titel der Weboberfläche, Zertifikat, SNMP (nur lesend; v1/v2c oder v3 mit Authentifizierung und Verschlüsselung), NetBIOS-Name und Reverse DNS. Unsichere Erkennungen sind markiert, den Typ kannst du vor dem Übernehmen ändern.
- **Telematik** - Kartenterminals (SICCT-Port 4742, ORGA, Cherry …) und TI-Konnektoren (KoCoBox, secunet, RISE …) bekommen ein eigenes Symbol und eine eigene Kategorie. Ihre Tiefenprüfung bleibt immer beim schonenden Profil - auch bei einem noch unklaren Gerät: Die Tiefenprüfung fragt zuerst nur Port 4742 (SICCT) ab; antwortet er, bleibt es beim schonenden Profil.
- **Nur übernehmen, was du willst** - Scan-Ergebnis in vier Reitern: *Neu*, *Geändert*, *Bekannt*, *Ignoriert*. Neue Geräte per Häkchen übernehmen oder dauerhaft ignorieren. Übernehmen und Ignorieren geht aus dem neuesten Scan eines Subnetzes; ältere Scans bleiben lesbar, „Nicht mehr ignorieren“ geht auch dort.
- **MAC-Adresse als Ausweis** - ändert sich die IP eines bekannten Geräts, übernimmt der nächste Scan die neue Adresse automatisch, mit Eintrag im Verlauf. Einen von Hand eingetragenen Rechnernamen lässt der Scan stehen; er füllt den Namen nur, solange er leer ist oder vom Scan stammt.
- **Inventar** - Suche über alles, Filter nach Typ und Standort, Ansicht als Liste, nach Subnetz oder nach Typ, Status „beim letzten Scan gesehen“, Export als CSV (Excel) und JSON.
- **Suche über alles und Erste Schritte** - Strg K (⌘K) findet von jeder Seite Geräte (auch per IP oder MAC), Monitore, Sensoren, Einstellungen und Kapitel im Handbuch. Auf einer neuen Installation führt die Liste „Erste Schritte“ auf der Übersicht vom Standort über den ersten Scan bis zum ersten Monitor.
- **Schnellzugriff** - ein Klick öffnet die Weboberfläche des Geräts (Proxmox auf 8006, Synology auf 5001, Drucker …). Die Adresse schlägt der Scan vor.
- **Kauf, Garantie, Wartung** - optionale Felder mit Hinweis auf der Übersicht, wenn die Garantie bald endet.
- **Tiefenprüfung** - für einzelne unklare Geräte, von Hand gestartet: rund 110 Ports und alle Weboberflächen.
- **Standorte** - fassen Subnetze zusammen. Vor dem Scan nur noch Häkchen setzen, gefundene Geräte bekommen ihren Standort automatisch.
- **Benutzer und Rollen** - Administrator, Bearbeiter, Nur lesen; Anmeldung auch über Active Directory, Rechte auf Standorte beschränkbar (ab 0.3).
- **HTTPS ab dem ersten Start** - selbst erzeugtes Zertifikat, eigenes Zertifikat (PEM oder PFX) in der Oberfläche hochladbar, HTTP leitet auf HTTPS um (außer für einen vertrauten Reverse Proxy, siehe unten).
- **Deutsch und Englisch**, hell und dunkel, auch am Handy bedienbar.

![Inventar](public/help/img/inventory-de.png)

## Monitoring (ab Version 0.2)

WhatsOnMyNet überwacht Geräte, Dienste und Webseiten und ersetzt damit Uptime Kuma für den Online-Status:

- **Prüfungen**: Web (HTTP/HTTPS mit gültigen Statuscodes und optionalem Stichwort), TCP-Port oder Ping, alle 20 Sekunden bis 24 Stunden.
- **Ohne Fehlalarme**: Ein Alarm kommt erst nach mehreren Fehlversuchen hintereinander (Standard 3), eine Entwarnung mit der Dauer des Ausfalls. Optional wiederholt sich der Alarm, solange die Störung anhält.
- **Zertifikate**: Bei HTTPS wird das Ablaufdatum gelesen, gewarnt wird z. B. 30, 14 und 7 Tage vorher, jede Stufe einmal. Die Prüfung von Kette und Name ist für Internetseiten einschaltbar; LAN-Geräte mit selbstsigniertem Zertifikat funktionieren ohne.
- **Benachrichtigungen** unter *Einstellungen → Benachrichtigungen*: Discord, Slack, Microsoft Teams, Google Chat, Mattermost, Rocket.Chat, Matrix, Signal, WhatsApp (CallMeBot), ntfy, Gotify, Pushover, Pushbullet, Home Assistant und Apprise (über 100 weitere Dienste), jeweils mit kurzer Anleitung im Formular; außerdem E-Mail (über den SMTP-Server), Telegram-Bot (Token von @BotFather, Chat-ID) und Webhook mit eigener JSON-Vorlage (`{{text}}`, `{{name}}`, `{{status}}`, `{{message}}`, `{{target}}`, `{{time}}`) und optionalem Header für einen Schlüssel. Token und Header werden verschlüsselt gespeichert. Jeder Kanal hat eine Testnachricht.
- **Wartungsfenster** einmalig oder wöchentlich (auch über Mitternacht), für alle oder ausgewählte Monitore - währenddessen keine Alarme. Der Status „Wartung“ steht ab Beginn des Fensters da, nicht erst nach der nächsten Prüfung.
- **Mehrere auf einmal**: In den Listen *Monitore* und *Sensoren* lassen sich Zeilen ankreuzen (auch alle angezeigten) und gemeinsam bearbeiten - Prüfintervall, Fehlversuche, Zeitlimit, Wiederholung, Eskalation, Kanäle, bei Sensoren auch Grenzwert - oder gemeinsam pausieren, fortsetzen und löschen.
- **Verfügbarkeit** über 24 Stunden, 7 und 30 Tage, Antwortzeit als Diagramm, Ereignisse mit Hinweis, an wen gemeldet wurde.
- **Geräte**: Auf der Seite eines Geräts legt „Überwachen“ einen passenden Monitor an (Weboberfläche, sonst Ping oder ein offener Port). Ändert der Scan die IP-Adresse eines Geräts, ziehen seine Monitore mit. Ein Monitor mit gespeichertem Passwort (Datenbank, Netzlaufwerk) zieht nicht mit: Er wird pausiert, seine Benachrichtigungskanäle bekommen eine Meldung, und mit dem neu eingegebenen Passwort läuft er an der neuen Adresse weiter - das Passwort geht nie ungefragt an eine andere Adresse. Kehrt das Gerät zur alten Adresse zurück, läuft er von selbst wieder.

Prüfergebnisse bleiben 7 Tage im Detail und stundenweise über ein Jahr gespeichert.

### Docker-Container und Datenbanken (ab Version 0.3)

- **Docker**: Unter *Einstellungen → Docker* trägst du deine Docker-Hosts ein. Ein Monitor vom Typ *Docker-Container* meldet, wenn ein Container nicht läuft, ständig neu startet oder sein Healthcheck „unhealthy“ meldet. „Alle laufenden überwachen“ legt mit einem Klick für jeden Container einen Monitor an.
  Empfohlen ist ein **Socket-Proxy** auf dem Docker-Host, der nur lesende Container-Abfragen erlaubt (z. B. `tecnativa/docker-socket-proxy` mit `CONTAINERS=1`, `POST=0`; Adresse dann `http://<host>:2375`). Die Vorlage steht in den Einstellungen. Den Docker-Socket direkt in den Container einzubinden ist nicht vorgesehen: WhatsOnMyNet läuft dort als normaler Benutzer ohne die Gruppe `docker` (und der Socket gäbe mehr Rechte als nötig) - nimm den Socket-Proxy.
- **Datenbanken**: MariaDB/MySQL, PostgreSQL und Redis/Valkey. Geprüft wird: anmelden und eine harmlose Abfrage (Version bzw. `PING`), auf Wunsch über TLS. Lege dafür am besten einen eigenen Benutzer nur mit Login-Recht an. Das Passwort wird verschlüsselt gespeichert und nie an den Browser zurückgegeben.

### Sensoren (ab Version 0.4)

Wie bei PRTG lässt sich jeder Wert, den ein Gerät liefert, als eigener Monitor überwachen - mit Verlauf, Alarm und Wartungsfenstern:

- **Sensor (Gerätewert)**: auf der Geräteseite „Sensor anlegen“, dann Wert und Bedingung wählen - z. B. „Toner Cyan kleiner oder gleich 10 %“, „Volume 1 größer oder gleich 85 %“, „Temperatur Drive 2 über 50 °C“, „Port 10 (Uplink) verbunden“, „Festplatte/Speicherpool in Ordnung“, „Störungen am Drucker“. Gelesen wird der letzte Stand der Drucker-/Switch-/NAS-Abfrage, ohne zusätzliche Anfragen ans Gerät. Werte, die schon ein anderer Sensor überwacht, bietet der Dialog nicht noch einmal an.
- **SNMP-Wert (OID)**: jeder per SNMP lesbare Wert mit eigener Bedingung (kleiner, größer, gleich, enthält Text …) - z. B. Restlaufzeit einer USV, Temperatur einer Klimaanlage, Sitzungen einer Firewall.
- Der Verlauf zeigt den gemessenen Wert über 24 Stunden bis zu einem Jahr (ab 30 Tagen als Stundenzusammenfassung).

### Netzlaufwerke (ab Version 0.4)

Der Typ **Netzlaufwerk (SMB)** meldet sich an einer Windows- oder NAS-Freigabe an (z. B. `\\fs01\Abteilung`), liest sie oder einen bestimmten Ordner und fragt den freien Platz ab - über SMB 2/3 und nur lesend. Gemeldet wird, wenn die Anmeldung scheitert (Passwort abgelaufen, Konto gesperrt), die Freigabe oder der Ordner fehlt, der Zugriff verweigert wird oder weniger als … % bzw. … GB frei sind. Am besten ein eigenes Konto nur mit Leserecht verwenden; das Passwort wird verschlüsselt gespeichert und nur über die Umgebung an `smbclient` übergeben, nie auf der Befehlszeile. Im Bericht gibt es den Abschnitt *Netzlaufwerke* mit dem freien Platz.

## Installation

Voraussetzung: ein **Linux-Host mit Docker** (Server, VM, Proxmox-LXC mit Docker, Synology Container Manager). WhatsOnMyNet läuft im **Host-Netzwerk** - nur so sieht es die MAC-Adressen deiner Geräte. Docker Desktop unter Windows oder macOS sieht das echte Netz nicht und eignet sich deshalb nicht.

```sh
mkdir whatsonmynet && cd whatsonmynet
curl -fsSLO https://raw.githubusercontent.com/soleil0815/whatsonmynet/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/soleil0815/whatsonmynet/main/env.example
docker compose up -d
docker compose logs whatsonmynet      # zeigt den Einrichtungscode
```

Dann `https://<adresse-des-servers>:8743` öffnen. Der Browser warnt beim ersten Mal vor dem selbst erzeugten Zertifikat - das ist erwartet. Im Assistenten gibst du den Einrichtungscode aus dem Protokoll ein und legst den Hauptadministrator an.

Danach:

1. **Standorte** anlegen und ihre Subnetze eintragen (die Netze des Servers werden vorgeschlagen).
2. **Netzwerk scannen** → Standorte ankreuzen → *Scan starten*.
3. Im Reiter *Neu* auswählen, was ins Inventar soll, Typ und Name bei Bedarf anpassen → *Ins Inventar übernehmen*.

### Ports ändern

Die Ports stehen in der `.env`, nicht in der `docker-compose.yml`:

```sh
WOMN_HTTPS_PORT=8743   # Weboberfläche
WOMN_HTTP_PORT=8780    # leitet nur auf HTTPS um (0 = aus)
```

Danach `docker compose up -d`.

## Nächtlicher Leicht-Scan und neue Geräte (ab Version 0.3)

**WhatsOnMyNet scannt nichts von sich aus.** Bei einer neuen Installation (ab 0.42) ist der nächtliche Scan **aus**; ein Administrator schaltet ihn unter *Einstellungen → Scan* oder direkt auf der Seite *Netzwerk scannen* ein - das steht im Protokoll. Installationen von vorher behalten ihre Einstellung.

Einmal pro Nacht (Standard 02:30 Uhr Ortszeit, `TZ` in der `.env`) sucht WhatsOnMyNet in allen Subnetzen deiner Standorte nur nach Geräten: ARP, NetBIOS und - wenn erlaubt - Ping; in gerouteten Subnetzen zusätzlich wenige TCP-Verbindungsversuche (Ports 443, 80, 22, 445, 3389) und die ARP-Tabelle der Router per SNMP. Keine Port-Prüfung der Geräte, keine Webanfragen. So bleibt der Scan unauffällig.

- Bekannte Geräte bekommen ihre neue IP-Adresse automatisch (die MAC-Adresse ist die Identität), ihre Monitore ziehen mit - außer Monitore mit gespeichertem Passwort: Sie werden pausiert und brauchen das Passwort neu (siehe Monitoring).
- Unbekannte Geräte landen im Scan-Ergebnis zum Übernehmen oder Ignorieren; die Übersicht zeigt, wie viele warten.
- **Neue Geräte melden**: Ein Gerät, das zum allerersten Mal auftaucht, wird einmal über die Benachrichtigungskanäle gemeldet. Der erste Scan nach dem Update lernt nur, was schon da ist - keine Flut an Meldungen.
- Uhrzeit, Kanäle und „Jetzt ausführen“ unter *Einstellungen → Scan*. Nach einem Neustart holt WhatsOnMyNet den Scan bis zu 4 Stunden später nach.

## Drucker per SNMP (ab Version 0.3)

Geräte vom Typ *Drucker* werden regelmäßig (Standard stündlich) per SNMP gefragt - nur lesend, über die Printer-MIB, die fast alle Netzwerkdrucker können:

- Toner bzw. Tinte je Farbe, Trommel, Resttonerbehälter, Fixiereinheit - als Balken in der Farbe des Toners
- Seitenzähler gesamt und der letzten 30 Tage, Zustand (bereit, druckt …), Fehler wie Papierstau, kein Papier, Klappe offen, und der Text auf dem Display
- **Meldung**, wenn ein Verbrauchsmaterial auf den Schwellwert fällt (Standard 15 %) und noch einmal, wenn es leer ist - einmal pro Kartusche, nach dem Wechsel wieder scharf
- Die Übersicht zeigt alle Drucker, bei denen etwas zur Neige geht

Einstellungen unter *Einstellungen → Drucker*. Die Community ist dieselbe wie beim Scan (*Einstellungen → Scan*). Am Drucker muss SNMP (v1/v2c oder v3) eingeschaltet sein.

## Switches und NAS per SNMP (ab Version 0.3)

Geräte vom Typ *Switch* und *NAS* werden regelmäßig (Standard alle 15 Minuten) per SNMP gefragt - nur lesend:

- **Switch**: alle Ports als Kacheln wie an der Front (verbunden/getrennt, Geschwindigkeit, Bezeichnung), welche Geräte an welchem Port hängen (MAC-Tabelle, auch mit VLANs), Nachbarn per LLDP, Modell, Firmware und Seriennummer.
- **Wo steckt das Gerät?** Auf der Seite jedes Geräts steht unter *Erkennung*, an welchem Switch und Port es angeschlossen ist. Hängen an einem Port viele Geräte, weist WhatsOnMyNet darauf hin, dass dazwischen vermutlich ein weiterer Switch oder Access Point steckt.
- **NAS**: Volumes mit Füllstand (jedes NAS bzw. jeder Linux-Server mit SNMP), bei Synology zusätzlich Festplatten mit Status und Temperatur, Speicherpools/RAID, Systemstatus, Lüfter, Netzteil, DSM-Version und verfügbare Updates; bei QNAP Festplatten und Temperatur.
- **Ins Inventar übernommen**: Seriennummer und Modell, die Drucker, Switches und NAS per SNMP melden, bei Switches und NAS zusätzlich die Firmware (bzw. DSM-Version), landen gleich in den Angaben des Geräts und bleiben aktuell; eigene abweichende Eingaben bleiben. Meldet ein Gerät unter derselben IP eine andere Seriennummer (Tausch), kommen Seriennummer, Modell und Firmware vom neuen Gerät und der nächste Scan übernimmt die neue MAC-Adresse; der Verlauf vermerkt den Tausch.
- **Meldung** bei einer gestörten Festplatte, einem eingeschränkten RAID, Lüfter- oder Netzteilfehler und wenn ein Volume voll läuft (Standard 90 %) - einmal beim Auftreten und einmal, wenn alles wieder in Ordnung ist. Die Übersicht zeigt offene NAS-Probleme.
- **Netzwerk-Ports anderer Geräte** (ab Version 0.58, je Gerät einschaltbar, standardmäßig aus): NAS, Router, Firewall per SNMP (IF-MIB, jeder Hersteller) und die Netzwerkkarten von Rechnern mit dem Rechner-Skript - mit Sensoren für *Port verbunden*, *Geschwindigkeit gesunken*, *neue Fehler* und *Auslastung*. Bei Switches kommen *Geschwindigkeit* und *neue Fehler* als Sensoren dazu.

Einstellungen unter *Einstellungen → Switches & NAS*. Einfache Switches ohne SNMP (z. B. TP-Link „Easy Smart“) liefern keine Daten; bei LANCOM, HP/Aruba, Cisco, Netgear Smart und Co. muss SNMP (v1/v2c oder v3) lesend aktiv sein.

## Netzplan (ab Version 0.3)

Der *Netzplan* zeigt aus den MAC-Tabellen und LLDP-Daten der Switches, welches Gerät an welchem Port hängt und wie die Switches untereinander verbunden sind - als Baum vom Switch mit dem Router aus. Geräte ohne Zuordnung (keine MAC-Adresse, WLAN, Switch ohne SNMP) stehen darunter.

**Entfernte Subnetze**: Hinter einem Router sieht der Scan keine MAC-Adressen. Ist SNMP an deinen Routern/Firewalls aktiv (im Inventar mit Typ *Router* oder *Firewall*), liest der Scan deren ARP-Tabelle - so bleibt die MAC-Adresse auch in entfernten Subnetzen die Identität eines Geräts (abschaltbar unter *Einstellungen → Scan*).

### Ping

WhatsOnMyNet läuft ohne Root-Rechte. Ping funktioniert dann nur, wenn der Host normalen Benutzern ICMP erlaubt (`net.ipv4.ping_group_range`, bei Debian, Ubuntu und Proxmox Standard). Ohne Ping findet der Scan lokale Geräte trotzdem über ARP und entfernte über TCP; das Programm zeigt dann einen Hinweis.

**Docker in einem Proxmox-LXC: Ping freischalten.** Im LXC ist ICMP für normale Benutzer meist aus (`cat /proc/sys/net/ipv4/ping_group_range` zeigt `1 0`). Weil WhatsOnMyNet im Host-Netzwerk läuft, gilt die Einstellung des LXC - sie wird **im LXC** gesetzt (nicht auf dem Proxmox-Host und nicht in der `docker-compose.yml`, Docker erlaubt `sysctls` im Host-Netzwerk nicht):

```sh
# im LXC als root - dauerhaft, auch nach einem Neustart
echo 'net.ipv4.ping_group_range = 0 65535' > /etc/sysctl.d/99-ping.conf
sysctl -p /etc/sysctl.d/99-ping.conf
# prüfen: jetzt "0 65535"
cat /proc/sys/net/ipv4/ping_group_range
# WhatsOnMyNet neu starten, damit es Ping wieder erkennt
docker compose restart
```

Danach verschwindet der Hinweis „Ping nicht möglich“ beim Scan, und Ping-Monitore funktionieren. Das geht auch im unprivilegierten LXC, ohne dem Container mehr Rechte zu geben. Höher als `65535` geht dort nicht (der Kernel meldet sonst „Invalid argument“) - im LXC gibt es nur die Gruppen 0–65535.

### SNMP

Standardmäßig fragt der Scan Geräte mit der Community `public` (SNMP v2c, sonst v1) nach Name, Beschreibung und Hersteller-ID - nur lesend. Eigene Communities trägst du unter *Einstellungen → Scan* ein; sie werden verschlüsselt gespeichert. Geräte, die nur SNMPv3 sprechen, fragt der Scan mit bis zu fünf Benutzern aus *Einstellungen → Scan → SNMPv3-Zugänge* (Authentifizierung und Verschlüsselung, Passwörter verschlüsselt gespeichert). Geräte ohne SNMP (z. B. einfache TP-Link-Switches) werden trotzdem erkannt, nur mit weniger Details.

## Anmeldung mit Active Directory (ab Version 0.3)

Unter *Einstellungen → Active Directory* meldest du dich mit dem Windows-Konto an:

- Aufbau wie in Helfi.Space: **Domänencontroller**, **Verschlüsselung** (LDAPS 636 oder StartTLS 389) und **Port** als eigene Felder; Vertrauen *abgerufenes Zertifikat*, *System-CAs* oder *nicht prüfen* (nur zum Testen); Servernamen prüfen abschaltbar (DC über IP).
- **Zertifikat vom DC abrufen** (ab 0.4): WhatsOnMyNet holt die Zertifikatskette direkt vom Domänencontroller und ergänzt fehlende CAs über die AIA-Adresse im Zertifikat. Du vergleichst den Fingerabdruck (SHA-256 und SHA-1, wie in certlm.msc) und bestätigst. Fehlt die Stamm-CA danach noch, wird sie über die nun vertrauenswürdige Verbindung aus dem AD gelesen (*Public Key Services*). Jede ergänzte CA muss das Zertifikat darunter tatsächlich signiert haben. Mit Stamm-CA wird auch ein erneuertes DC-Zertifikat ohne neue Bestätigung angenommen. PEM selbst einfügen geht weiterhin.
- Ein **Dienstkonto ohne besondere Rechte** sucht das Konto, das Passwort prüft der Domänencontroller selbst - WhatsOnMyNet speichert es nie.
- **Rollen über Gruppen**: je eine Gruppe für Administrator, Bearbeiter und Nur lesen, einfach mit dem **Gruppennamen** (z. B. `WOMN-Admins`) oder als DN; gesucht wird in der ganzen Domäne, verschachtelte Gruppen werden berücksichtigt. Die **Basis-DN** darf leer bleiben, sie wird aus dem AD ermittelt. Wer in keiner Gruppe ist, kann sich nicht anmelden. Name, E-Mail und Rolle werden bei jeder Anmeldung aus dem AD übernommen.
- Lokale Konten funktionieren weiter; bei gleichem Namen hat das **lokale Konto immer Vorrang** - so bleibt der lokale Admin der Notfallzugang.
- **Verbindung testen** prüft mit den Werten im Formular (auch ungespeichert) Schritt für Schritt: Verbindung, Dienstkonto, Basis-DN, jede Gruppe, Benutzer, Rolle und Passwort, jeweils mit ✓/✗ und dem Grund. Die Schritt-für-Schritt-Anleitung steht im Handbuch.

## Rechte pro Standort (ab Version 0.3)

Bearbeiter und Leser lassen sich unter *Einstellungen → Benutzer* auf einen oder mehrere Standorte beschränken - etwa für die IT einer Außenstelle. Ein beschränktes Konto sieht und ändert nur Geräte, Scan-Ergebnisse und Monitore dieser Standorte, scannt nur deren Subnetze und zählt auf der Übersicht nur sie. Geräte ohne Standort, freie Subnetze, der nächtliche Scan, Wartungsfenster und Docker-Hosts bleiben unbeschränkten Konten vorbehalten. Administratoren sind nie beschränkt; das gilt auch für Konten aus dem Active Directory.

**Erlaubte Scan-Ziele:** Bearbeiter scannen nur private Netze (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 und 100.64.0.0/10) und die Subnetze, die ein Administrator bei den Standorten eingetragen hat. Öffentliche Adressen - als Subnetz im Scan oder als Tiefenprüfung eines Geräts - darf nur ein Administrator scannen. Monitor-Ziele, die ein Nicht-Administrator einträgt, dürfen nie auf den WhatsOnMyNet-Rechner selbst (127.x, ::1), 169.254.x/fe80:: oder 0.x zeigen; sonst ist alles erlaubt, auch Internet-Adressen wie `https://www.example.com`. Benutzer mit Standort-Beschränkung erreichen private Adressen nur in den Subnetzen ihrer Standorte (haben diese keine Subnetze, gelten die privaten Netze). SNMP-Monitore schicken die gespeicherten Communities und v3-Benutzer – sie gehen bei Nicht-Administratoren nur an private Netze und Standort-Subnetze (mit Standort-Beschränkung nur an die eigenen). Hostnamen werden beim Speichern aufgelöst: Gibt es IPv4-Antworten, entscheiden diese (jede muss passen) und IPv6-Antworten dürfen nur nicht auf den Rechner selbst zeigen; nur IPv6-Antworten müssen jede passen (fc00::/7 gilt als privat). Bei jeder Prüfung wird der Name erneut aufgelöst und nach derselben Regel geprüft; die Prüfung geht dann genau an die geprüfte Adresse. Ändert der Besitzer eines Namens dessen DNS-Antwort später (DNS-Rebinding), meldet der Monitor „Zieladresse nicht erlaubt“, statt den Rechner selbst oder fremde Netze anzusprechen. Das gilt für Monitore, deren Adresse ab Version 0.57 ein Nicht-Administrator gespeichert hat. Drucker, Switches & NAS und die SNMP-Monitore eines Administrators fragen mit allen gespeicherten Zugängen. Die IP-Adresse eines Geräts, die ein Nicht-Administrator einträgt, folgt der SNMP-Regel, denn Drucker, Switches und NAS werden mit den hinterlegten Zugängen abgefragt.

## Scan-Agent für Außenstellen (ab Version 0.3)

ARP - und damit die MAC-Adresse - sieht man nur im eigenen Netz. Für eine Außenstelle läuft dort ein zweiter Container als **Scan-Agent**:

1. Zentrale: Standort der Außenstelle mit ihren Subnetzen anlegen, dann *Einstellungen → Scan-Agenten → Agent hinzufügen*. Angezeigt werden Schlüssel und - beim selbstsignierten Zertifikat - das Zertifikat der Zentrale als fertige `.env`. Dort auch wählen, welche SNMP-Zugangsdaten der Agent bekommt: keine (nur „public“, Standard), eigene nur für seinen Standort oder alle der Zentrale (ab 0.57; ältere Agenten stehen auf „alle“).
2. Außenstelle: `docker-compose.agent.yml` aus dem Release und die `.env` ablegen, `docker compose -f docker-compose.agent.yml up -d`.

Der Agent hat keine Weboberfläche und öffnet keinen Port. Er fragt die Zentrale jede Minute nach Aufträgen (`WOMN_AGENT_INTERVAL` in Sekunden, 15 bis 3600, Standard 60; HTTPS; beim selbstsignierten Zertifikat vertraut er genau diesem einen Zertifikat - geprüft, bevor der Schlüssel gesendet wird. Erneuert sich das Zertifikat, braucht der Agent den neuen Wert), scannt dort genauso schonend und folgt der Uhrzeit des nächtlichen Leicht-Scans. Er darf nur Adressen aus den Subnetzen seines Standorts melden. „Scan starten“ für diesen Standort geht in der Zentrale automatisch als Auftrag an den Agenten; die Ergebnisse erscheinen wie gewohnt unter *Frühere Scans*.

## Ausfallsicherung: Master und Standby (ab Version 0.20)

Ein zweites WhatsOnMyNet steht als **Standby** bereit und übernimmt, wenn der **Master** ausfällt:

1. Master: *Einstellungen → Ausfallsicherung → Zum Master machen* - ein Kopplungscode erscheint (einmalig).
2. Standby: dort *Dieses System als Standby*, Adresse des Masters und Code eintragen, Zeit bis zur Übernahme wählen (Standard 10 Minuten, 3 bis 240) - **Koppeln**.

Der Standby holt jede Minute ein Lebenszeichen und die neuen Meldungen der Geräte, alle 5 Minuten die übrigen Daten samt Empfangs-Einstellungen (über HTTPS; der Schlüssel des Master-Zertifikats ist im Code und wird vor dem Senden geprüft). Er prüft, scannt und alarmiert nicht und zeigt nur an. Antwortet der Master länger als eingestellt nicht, überwacht und alarmiert der Standby und meldet das an die Standard-Kanäle. Ist der Master wieder da, gibt der Standby ihm seine Messwerte und Alarme aus der Zwischenzeit zurück (Einstellungen gehen nie zurück), ist wieder still und holt sich dessen Daten. Kommt der alte Master nicht wieder: am Standby *Zum Master machen*. Beide Systeme brauchen dieselbe Version - laufen sie eine halbe Stunde lang unterschiedlich, erinnert der Standby über die Standard-Kanäle daran, welches zu aktualisieren ist; der Standby übernimmt auch den Schlüssel (`secret.key`) des Masters. Details im Handbuch.

## Proxmox VE und Backup Server (ab Version 0.4)

Unter *Überwachung → Virtualisierung* liest WhatsOnMyNet Proxmox VE und Proxmox Backup Server über ihre eingebaute API - dort wird nichts installiert. Ein eigener Benutzer mit einem API-Token, der nur lesen darf, genügt (VE: Rolle *PVEAuditor* auf `/`, Backup Server: Rolle *Audit*). Der Dialog *Host hinzufügen → Proxmox VE* führt in zwei Schritten durch: die Befehle zum Kopieren (oder die Klicks in der Proxmox-Oberfläche), dann Adresse, **Zertifikat abrufen** mit Fingerabdruck-Vergleich und das Geheimnis. Fehlen dem Token Rechte, nennt die Detailansicht sie samt Befehl zum Beheben; das Geheimnis wird verschlüsselt gespeichert.

Weitere Hypervisoren auf derselben Seite: **VMware ESXi/vCenter** (vSphere-API), **XCP-ng/XenServer** (XAPI), **Nutanix AHV** (Prism-API v2) und **oVirt/RHV/OLVM** (REST-API) werden mit einem Konto abgefragt, das nur lesen darf. **Hyper-V** und **KVM/libvirt** melden sich selbst: ein kleines Skript (PowerShell bzw. POSIX sh mit `virsh -r`) schickt alle 5 Minuten Hosts, Speicher und VMs - mit eigenem Schlüssel, ohne offenen Port auf dem Host. Alle erscheinen gleich und liefern dieselben Sensoren.

**Netzwerk-Controller:** UniFi Network (UniFi OS und Network-App), TP-Link Omada und MikroTik RouterOS 7 werden mit einem Lesekonto abgefragt (*Überwachung → Netzwerk-Controller*): Access Points, Switches und Gateways mit Modell, Firmware (und anstehendem Update), Clients und Zustand. Modell, Seriennummer, Firmware und Typ gehen per MAC ins Inventar; Sensoren für Online-Zustand, Clients, CPU/RAM und Firmware-Updates. Der Scan erkennt UniFi, Omada, MikroTik und Aruba Instant On an ihren Modellnamen.

**Windows- und Linux-Rechner ohne Agent:** Ein kleines Skript (PowerShell bzw. POSIX sh) meldet alle 5 Minuten CPU, RAM, Laufwerke, Laufzeit und Dienste - kein Agent-Paket, nichts wird heruntergeladen, kein offener Port, kein Konto. Beim ersten Aufruf richtet es nur sich selbst und eine geplante Aufgabe (cron) ein, ein Deinstallationsskript entfernt es wieder. Meldet es sich einen Tag lang nicht, fragt die Geräteseite, ob es entfernt wurde, und der Rechner wird für neue Sensoren nicht mehr angeboten. Ein gemeinsames Skript je Betriebssystem - dieselbe Datei für alle Rechner (*Einstellungen → Rechner-Skripte* oder *Geräteseite → Mehr → Per Skript überwachen*); Meldungen werden dem Inventar über MAC, Rechnername oder IP zugeordnet - ein Gerät mit bekannter MAC nur, wenn die Meldung diese MAC nennt (den Schlüssel haben alle Rechner), und Seriennummer, Modell und MAC ändert sie nie von selbst. Neue Hardware unter altem Namen ordnet ein Klick zu (*Hardware getauscht*), ein Notebook an wechselnden Dockingstationen bekommt als Ausnahme ein eigenes Skript. **Ab 0.59 aktualisieren sich die Skripte selbst** (ab Werk an, abschaltbar): Die neue Version kommt von derselben Adresse mit Schlüssel und Zertifikatsprüfung, nur mit passendem Fingerabdruck (SHA-256); Skripte vor 0.59 einmal neu verteilen, die Übersicht meldet sie.

- **VE**: Knoten (online, CPU, RAM), Speicher mit Belegung, VMs und Container (läuft/gestoppt), die letzten Sicherungen (vzdump) mit Fehlern
- **Backup Server**: Datastores mit Belegung, Sicherungsgruppen mit dem Alter der letzten Sicherung, fehlgeschlagene Aufgaben (Verify, GC …)
- **Sensoren** wie „Knoten online“, „Speicher local-zfs über 85 %“, „VM 101 läuft“, „letzte Sicherung von VM 101 älter als 26 Stunden“, „Datastore über 85 %“ oder „fehlgeschlagene Aufgaben“

## Geplante Berichte (ab Version 0.4)

Unter *Überwachung → Berichte* verschickt WhatsOnMyNet zu festen Zeiten Berichte per E-Mail - zum Beispiel jeden Montag um 8 Uhr die Tonerstände aller Drucker ans Büro, oder monatlich den Zustand der NAS.

- **Inhalt**: Drucker (Toner je Farbe, Trommel, Resttoner, Seitenzähler, Störungen), NAS (Belegung, Platten, Temperatur), Switches und Netzlaufwerke (freier Platz); auf Standorte oder **einzelne Geräte** beschränkbar (z. B. ein Bericht nur für den Drucker im Sekretariat), wahlweise nur Geräte mit Handlungsbedarf. Drucker zeigen die gedruckten Seiten gesamt und im Berichtszeitraum. Was bald nachbestellt werden muss, ist rot markiert.
- **Neutral**: Die Mail enthält keinen Link und keinen Programmnamen - nur deinen Absendernamen, Betreff (`{kw}`, `{datum}`), Einleitung, die Geräte und deinen Gruß, z. B. „Ihre freundliche IT“.
- Zeitplan täglich, wöchentlich oder monatlich; Vorschau, „Test an mich“ und „Jetzt senden“ direkt in den Einstellungen.

## Meldungen, Windows-Ereignisse und Ereignisregeln (ab Version 0.27)

- **Empfang** von SNMP-Traps (v1, v2c) und Syslog über UDP, TCP (RFC 6587) und TLS (RFC 5425, mit dem Zertifikat dieses Servers); jede Meldung wird über die Adresse dem Gerät im Inventar zugeordnet. Einschalten unter *Überwachung → Meldungen → Empfang einstellen*.
- **Windows-Ereignisse** über [NXLog](https://nxlog.co): Ereignisnummer, Protokoll, Quelle und Konto werden erkannt und unter der Meldung gezeigt. Eine gewöhnliche NXLog-Konfiguration reicht, nur der Ausgang zeigt auf WhatsOnMyNet (TCP 1514).
- **Überwachen** macht aus einer Meldung einen Monitor, der sofort alarmiert. **Ereignisregeln** schicken ausgewählte Meldungen - getrennt von den Monitoren und nie an die Standard-Empfänger - per Mail, Webhook oder ans Ticketsystem: fertige Regeln für Virenfund (Defender), Software-Einschränkung, AppLocker, gesperrtes Konto und mehr, einzeln mit Obergrenze je Stunde oder gesammelt; nichts geht verloren, wenn ein Empfänger kurz nicht erreichbar ist.
- **Ereignis-Konsole:** Regeln zählen („ab 5 Fehlanmeldungen in 10 Minuten je Rechner“), nutzen reguläre Ausdrücke (vor dem Speichern auf Tempo geprüft) und führen **offene Ereignisse** - der erste Treffer meldet, weitere zählen nur hoch, bis jemand quittiert oder die Gegenmeldung („Port 7 link up“) es schließt. Die Seite zeigt die Meldungen **nach Absender**; je Absender lässt sich festlegen, was gespeichert wird (alles, ab Warnung … oder stumm).
- **Zeitraum und Zeitleiste** (wie in Splunk oder Wazuh): letzte 15 Minuten bis 30 Tage oder ein eigener Zeitraum; über der Liste zählt eine Zeitleiste die Treffer je Zeitabschnitt (Fehler, Warnungen, Rest). Nach einem Ereignis suchen, dann einen Balken anklicken oder über mehrere ziehen - Liste und Zeitleiste grenzen sich darauf ein. Ein Klick auf die Uhrzeit einer Meldung zeigt die 5 Minuten davor und danach.
- **Schnelle Suche auch in vielen GB:** ein Suchindex findet ganze Wörter und Wortanfänge, mehrere Begriffe zugleich (`PC-0001 4104 svc-pocketknife`), feste Wortfolgen in Anführungszeichen und `-wort` zum Ausschließen in Sekundenbruchteilen, auch über 30 oder 90 Tage; Teile mitten im Wort auf Wunsch. **Suchen speichern** (für sich oder für alle) - ein Klick statt erneut tippen.
- Die Meldungen liegen in einer **eigenen Datei** (`data/events.sqlite`): 30 Tage in höchstens 2 GB, bei knappem Datenträger bleiben mindestens 10 % frei. Die Seite zeigt, wie lange der Platz reicht und wer die meisten Meldungen schickt.
- **Was belegt den Platz?** zeigt, welche Windows-Ereignisse und Absender den Speicher füllen - mit Hinweisen, was man behalten sollte, Ausschließen per Klick (auch nur für eine Quelle, z. B. `1@Ntfs`) und einer anonymisierten Frage zum Kopieren in den KI-Chat des Vertrauens.
- **Speicherpools überwacht:** ZFS und Ceph (Proxmox), ZFS und mdadm (Linux-Skript), Storage Spaces (Windows-Skript), **TrueNAS** und **Ceph** über ihre APIs - Alarm, wenn ein Pool degradiert, eine Platte ausfällt oder der Scrub überfällig ist.
- **Windows-Skript mit Versionsnummer** (Registry `HKLM\SOFTWARE\WhatsOnMyNet`, Wert `HostScript` bzw. `HyperVScript`) zum Filtern in der Softwareverteilung; die Geräteseite markiert veraltete Skripte. Ein abgewiesener Bericht landet in einer Statusdatei statt als Warnung 4100 im Ereignisprotokoll.
- **Zeitleiste und Übersicht sofort da**, auch bei Millionen Meldungen: eine Zählung je Minute und Stunde ersetzt das Durchlesen aller Meldungen - die Zahlen bleiben genau, alte Meldungen gehen in Stücken, ohne den Empfang aufzuhalten.
- **Platz planen:** gerechnet rund 2 KB je Meldung, samt Suchindex - *Platz ≈ Meldungen pro Tag × Tage × 2 KB*. Grob für 30 Tage:

  | Umgebung | Meldungen pro Tag | Platz für 30 Tage | Einstellung |
  |---|---:|---:|---|
  | Klein: 5 - 20 PCs, 1 Server, NAS, Switches | 5.000 - 10.000 | 0,3 - 0,6 GB | Standard (2 GB) |
  | Klein mit Domänencontroller | 20.000 - 40.000 | 1,2 - 2,4 GB | 4 GB oder DC *ab Warnung* |
  | Mittel: 20 - 100 PCs, 3 - 5 Server, 2 DCs | 50.000 - 150.000 | 3 - 9 GB | 10 GB |
  | Groß: 100 - 500 PCs, 10 - 20 Server, 2 - 4 DCs | 150.000 - 500.000 | 9 - 30 GB | 40 GB, Rauschen filtern |

  Für 90 Tage das Dreifache. Werte je Absender und das Vorgehen stehen im Handbuch (*Wie viel Platz brauchen die Meldungen?*).
- **Für große Netze:** Meldungen werden gesammelt geschrieben (auf einem kleinen Server mit SSD gemessen über 10.000 pro Sekunde). Über TCP/TLS geht bei einer Flut nichts verloren - der Absender wartet kurz. *Nach Absender* kommt seitenweise, mit Schnellfiltern (Fehler, Warnungen, still seit 24 Stunden, eigener Filter), Gerätetyp und Reihenfolge; *Was belegt den Platz?* zählt „von wie vielen Rechnern“ genau und zeigt, was alle übrigen Absender zusammen belegen. Was dein Server schafft, misst `docker compose exec whatsonmynet womn-admin loadtest`.

![Ereignisregeln](public/help/img/eventrules-de.png)

## Cloud, Microsoft 365 und Veeam (ab Version 0.27)

- **AWS, Azure, Google Cloud** über ein Konto, das nur lesen darf: VMs mit den Prüfungen des Anbieters, Datenbanken, Load Balancer, Alarme und Kosten; Sensoren für alles davon.
- **Microsoft 365** über Microsoft Graph: Zustand der Dienste, offene Störungen, Abonnements und freie Lizenzen.
- **Veeam Backup & Replication** (ab 12, REST): Jobs mit letztem Ergebnis und nächstem Lauf, Repositories mit Platz.

## Prometheus, Grafana und eigene Prüfungen (ab Version 0.27)

- **/metrics** für Prometheus mit dem Zustand aller Monitore und Sensoren - nur mit Schlüssel, nur lesend; ein fertiges **Grafana-Dashboard** zum Importieren unter *Einstellungen → Prometheus & Grafana*.
- **Eigene Prüfungen** (Local Checks im Checkmk-Format): Skripte im Ordner `checks` auf Windows- und Linux-Rechnern melden OK, Warnung, kritisch oder unbekannt - es laufen nur Dateien, die niemand sonst ändern kann, jede mit Zeitlimit.
- **Plugins für das Rechner-Skript**: unter *Einstellungen → Plugins* schreiben (PowerShell oder sh), für alle Rechner, Schlagwörter, Standorte oder einzelne Geräte freigeben, herunterladen und in den Plugin-Ordner legen. Zeilen wie `Backup-Alter: 26 h` werden Werte mit eigener Alarmgrenze. Ein Rechner führt nur genau die Datei aus, die WhatsOnMyNet ihm über die gesicherte Verbindung freigibt (Version und SHA-256) - veränderte, veraltete oder fremde Plugins laufen nicht; die Liste zeigt, wo ein Plugin läuft, fehlt oder veraltet ist. Langsame Plugins laufen auf Wunsch seltener (bis einmal am Tag), ein Lauf aller Plugins hat höchstens 3 Minuten.
- **Weitere Prüfarten**: Mailserver (SMTP, IMAP, POP3 mit STARTTLS/TLS und Ablauf des Zertifikats), DNS an einem bestimmten Server, LDAP/Active Directory, Zeitserver (NTP), Microsoft SQL Server; Auslastung jedes Switch-Ports.

Einzelheiten zu allem stehen im Handbuch.

## HTTPS und Zertifikat

- Beim ersten Start erzeugt WhatsOnMyNet ein selbstsigniertes Zertifikat für den Hostnamen, `localhost`, alle IPv4-Adressen des Hosts und die Adresse aus `WOMN_BASE_URL`. Es wird 30 Tage vor Ablauf automatisch erneuert.
- Unter *Einstellungen → HTTPS-Zertifikat* lädst du ein eigenes Zertifikat hoch: PEM (Zertifikat mit Kette + Schlüssel) oder PFX/P12 mit Kennwort. Es wird vorher geprüft (Schlüssel passt, nicht abgelaufen) und ohne Neustart aktiv.
- HTTP auf `WOMN_HTTP_PORT` leitet auf HTTPS um - außer für einen vertrauten Reverse Proxy (siehe unten).
- Ersetzt WhatsOnMyNet ein hochgeladenes Zertifikat (neues hochgeladen, zurück auf selbstsigniert, Schlüssel fehlt oder passt nicht), bleiben die alten Dateien als `*.<Zeit>.bak` in `<Daten>/tls`. Ist `cert.pem` oder `key.pem` vorhanden, aber nicht lesbar (Rechte), startet WhatsOnMyNet nicht und ersetzt nichts.
- HSTS sendet WhatsOnMyNet nur mit eigenem Zertifikat und nur für Hostnamen, die das Zertifikat enthält. Mit einem selbstsignierten Zertifikat würde HSTS dazu führen, dass der Browser die Warnung nicht mehr überspringen lässt - du kämst nicht mehr hinein.
- Hinter dem vertrauten Reverse Proxy sendet WhatsOnMyNet HSTS nur, wenn der Proxy nicht selbst auf HTTPS umleitet und WhatsOnMyNet das übernehmen musste. `WOMN_HSTS=off` schaltet HSTS ganz ab, `WOMN_HSTS=preload` sendet es immer (mit eigenem Zertifikat oder hinter dem Proxy, nie mit dem selbstsignierten); Standard ist `on`.

### Hinter einem Reverse Proxy

In der `.env`:

```sh
WOMN_BASE_URL=https://womn.firma.local
WOMN_TRUST_PROXY=10.0.10.5          # Adresse des Proxys
```

Der Proxy leitet dann entweder an `https://<server>:8743` (selbstsigniert, beim Proxy „Zertifikat nicht prüfen“) oder an `http://<server>:8780` weiter - vom vertrauten Proxy nimmt der HTTP-Port Anfragen an, alle anderen leitet er auf HTTPS um. Die Regeln für Weiterleitung und HSTS sind dieselben wie bei Catalytix, AssetLotse und Helfi.Space.

## Sicherheit

- Scanne nur Netze, für die du zuständig bist.
- Der normale Scan ist bewusst schonend. Trotzdem: Trage den Server mit WhatsOnMyNet in Firewall, IDS oder Virenschutz als vertrauenswürdig ein, dann gibt es auch bei der Tiefenprüfung keinen Alarm.
- Das Programm läuft ohne Root, mit schreibgeschütztem Programmverzeichnis (`cap_drop: ALL`, `no-new-privileges`). Der Container bekommt nur die wenigen Rechte zurück, die der Start braucht: Rechte an `./data` setzen und per su-exec zu PUID/PGID wechseln (`CHOWN`, `FOWNER`, `DAC_OVERRIDE`, `SETUID`, `SETGID`) sowie `KILL`, damit das Stopp-Signal ankommt.
- Passwörter werden mit scrypt gespeichert, SMTP-Passwort und SNMP-Communities mit AES-256-GCM verschlüsselt. Den Schlüssel (`data/secret.key`) bitte mitsichern.
- Sicherheitslücken bitte vertraulich melden, siehe [SECURITY.md](SECURITY.md).

## Zwei-Faktor-Anmeldung (ab Version 0.4)

Lokale Konten schalten unter *Mein Konto* die Zwei-Faktor-Anmeldung ein: QR-Code mit einer Authenticator-App scannen (Microsoft/Google Authenticator, Aegis, 2FAS, Bitwarden …), Code zusammen mit dem aktuellen Passwort bestätigen (andere Anmeldungen des Kontos werden dabei abgemeldet), die zehn **Wiederherstellungscodes** sicher aufbewahren. Danach fragt die Anmeldung nach dem sechsstelligen Code; jeder Code gilt nur einmal. Unter *Einstellungen → Benutzer* lässt sich die Zwei-Faktor-Anmeldung **für Administratoren verpflichtend** machen. Admins können sie bei verlorenem Handy für ein Konto zurücksetzen; Konten aus dem Active Directory schützt das AD selbst.

## Ausgesperrt?

```sh
docker compose exec whatsonmynet womn-admin list
docker compose exec whatsonmynet womn-admin reset <benutzer>    # neues Zufallspasswort, wieder Administrator, 2FA aus
docker compose exec whatsonmynet womn-admin create <benutzer>   # neuer Administrator
docker compose exec whatsonmynet womn-admin loadtest            # wie viele Meldungen pro Sekunde der Server schafft
```

## Updates und Sicherung

Was neu ist, steht in [CHANGELOG.md](CHANGELOG.md) (dieselben Texte wie im Programm unter *Über WhatsOnMyNet*) und bei jeder Version auf GitHub.

- Updates holen Dockhand oder Watchtower automatisch, oder von Hand: `docker compose pull && docker compose up -d`. Ob es eine neue Version gibt, zeigt *Einstellungen → Über → Jetzt nach Updates sehen* (auf Wunsch einmal am Tag, mit Hinweis im Menü und Nachricht an einen Kanal) - WhatsOnMyNet fragt dafür nur GitHub nach der Versionsnummer, und erst, wenn du es einschaltest.
- Sicherheitsupdates erscheinen am Patchday (zweiter Dienstag im Monat) als `<version>-s<n>`: dasselbe Programm mit neuem Basis-Image sowie aktualisierten Alpine- und npm-Paketen, gebaut, getestet und mit Trivy geprüft. Hat sich nichts geändert, wird nichts veröffentlicht. Hält Trivy eine Version auf, weil eine Lücke zwar behoben, die Behebung aber noch nicht im Basis-Image oder npm-Paket angekommen ist, gilt eine befristete Ausnahme: Lücken, die seit weniger als 14 Tagen bekannt sind, halten Release und Sicherheitsupdate nicht auf. Sie stehen als Warnung mit Datum im Lauf, und der tägliche Scan öffnet dafür ein Issue. Ältere Lücken halten weiter auf.
- Jeden Tag prüft Trivy das veröffentlichte Image. Gibt es behebbare Lücken, öffnet sich ein Issue, und das Sicherheitsupdate am Patchday behebt sie.
- In der Woche vor dem Patchday greift ein ZAP-Scan das Programm in einem Wegwerf-Container ohne Anmeldung an. Das Ergebnis wertet der monatliche Code-Audit aus.
- WhatsOnMyNet legt jeden Tag eine komprimierte Sicherung der Datenbank in `data/backups/` an (`.sqlite.gz`, standardmäßig die 10 neuesten, Anzahl unter *Einstellungen → Sicherung*; dort lassen sich einzelne Sicherungen auch löschen). Sichere den ganzen Ordner `data/`, inklusive `secret.key` und `tls/`. Die Meldungen der Geräte (Syslog, Traps) liegen in `data/events.sqlite` - nicht in der Datenbank und nicht in den täglichen Sicherungen; höchstens 2 GB (einstellbar).

Unter *Einstellungen → Sicherung* (ab 0.4) lädst du jederzeit eine aktuelle Sicherung herunter, legst eine an oder spielst eine ein - hochgeladen (`.sqlite` oder `.sqlite.gz`) oder aus der Liste auf dem Server. Die Datei wird vorher geprüft (WhatsOnMyNet-Datenbank, nicht neuer als diese Version, gleicher Schlüssel), der aktuelle Stand wird als `whatsonmynet-before-restore-…` gesichert, dann startet das Programm neu. Schlüssel und Konten bleiben dabei auf dem heutigen Stand: Agent-, Rechner- und /metrics-Schlüssel, Kennwörter und Zwei-Faktor-Anmeldung kommen aus der aktuellen Datenbank, seither gelöschte Schlüssel kommen nicht zurück und seither gelöschte Konten nur deaktiviert (gilt für Sicherungen derselben Installation, nicht beim Umzug auf einen neuen Server). **Bewahre `data/secret.key` (bzw. deinen `WOMN_SECRET`) mit auf** - ohne ihn sind gespeicherte Passwörter in einer Sicherung unlesbar.

**Diagnosepaket** (ab 0.22): *Einstellungen → Diagnose* erstellt ein ZIP für die Fehlersuche - Protokoll der letzten 1–30 Tage oder seit dem letzten Update, Warnungen und Fehler, Monitore, Sensoren, Geräte mit ihren Werten, Hypervisoren und Cloud, Meldungen und Ereignisregeln, Scans, Einstellungen. Standardmäßig anonymisiert (Platzhalter wie GERAET-001, die in jedem Paket gleich bleiben und sich nachschlagen lassen), nie mit Kennwörtern oder Schlüsseln, nichts wird automatisch verschickt.

**Handbuch neu bauen** (nach Änderungen an `public/help/manual.*.md` oder den Bildern): `node tools/build-manual.mjs` - braucht Playwright mit Chromium, ImageMagick macht die PDFs kleiner.

## Unterstützen

WhatsOnMyNet entsteht in der Freizeit. Wenn es dir hilft, freue ich mich über einen [Kaffee](https://buymeacoffee.com/soleil0815). Mehr von mir: [helfi.space](https://helfi.space).

Was sich in welcher Version geändert hat, steht im Programm selbst: Klick unten links auf die Versionsnummer (*Über WhatsOnMyNet → Was ist neu*), oder unter [Releases](https://github.com/soleil0815/whatsonmynet/releases).

## Lizenz

WhatsOnMyNet ist Open Source unter der [GNU Affero General Public License 3.0](LICENSE) (AGPL-3.0-or-later). Wer eine veränderte Fassung im Netz anbietet, muss deren Quellcode zugänglich machen (`WOMN_SOURCE_URL`).

Schriften: Inter und IBM Plex Mono (SIL Open Font License, `public/fonts/OFL.txt`). Herstellerliste: IEEE über das Paket `oui-data` (BSD-2-Clause).
