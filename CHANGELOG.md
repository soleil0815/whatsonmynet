# Neuigkeiten

Was sich in WhatsOnMyNet geändert hat - dieselben Texte wie im Programm unter *Über WhatsOnMyNet* (Klick auf die Versionsnummer unten links). English: [CHANGELOG.en.md](CHANGELOG.en.md)

<!-- generated from public/js/changelog.js by tools/changelog.mjs - do not edit here -->

## Nächste Version (noch nicht veröffentlicht)

- Ausfallsicherung: Kommt der Master wieder, gibt ihm der Standby zurück, was er in der Zwischenzeit gemessen hat - Prüfungen, Stundenwerte (Verfügbarkeit, Antwortzeiten, Sensorwerte) und Alarme. Der Verlauf des Masters hat so keine Lücke. Einstellungen gehen weiter nur vom Master zum Standby. Hat der Master einen Monitor selbst geprüft (nur der Standby war abgeschnitten), behält er seine Werte. Alarme früherer Übernahmen gehen nach dem Update ebenfalls zurück
- Einstellungen: Jeder Bereich beginnt mit einem kurzen Hinweis in einfachen Worten, wozu er da ist, mit Link ins Handbuch

## 0.48.0 - 2026-11-18

- Meldungen suchen: Unter dem Suchfeld stehen Beispiele zum Anklicken. „Ereignis 1002“ (auch „Event 1002“, „ID 1002“, „id:1002“) findet nur dieses Windows-Ereignis statt nichts. Findet die Suche nach einer Ereignis-ID nichts, steht da warum: nicht gespeichert, zuletzt am … (mit „Ganzen Zeitraum zeigen“) oder nie angekommen

## 0.47.0 - 2026-11-18

- Monitoring nach Gruppe wie in Uptime Kuma: Jede Gruppe ist eine eigene Zeile mit Zustand, einem Balken für alle Mitglieder (rot, wo eines gestört war), Verfügbarkeit und „2 von 6 gestört“, die Mitglieder stehen eingerückt darunter. Ein Gruppen-Monitor ist diese Zeile selbst statt eines weiteren Eintrags. Sobald es eine eigene Gruppe gibt, öffnet die Liste nach Gruppe - die Wahl über der Liste bleibt

## 0.46.0 - 2026-11-18

- Statusseiten ohne Anmeldung (wie in Uptime Kuma): Monitoring → Statusseiten. Du wählst Gruppen und Monitore und unter welchem Namen sie erscheinen; die Seite zeigt Zustand, die letzten 90 Tage und die Verfügbarkeit, dazu auf Wunsch einen Hinweis - nie Adressen oder Fehlertexte. Zugang über einen geheimen Link oder eine eigene Adresse, auf Wunsch nur aus bestimmten Netzen. Ohne Statusseite ist ohne Anmeldung nichts zu sehen

## 0.45.1 - 2026-11-18

- Drucker: Toner ohne Füllstand („vorhanden“) sieht nicht mehr voll aus - auf der Geräteseite ein gestreifter Balken in seiner Farbe, im Bericht ein heller. Meldet der Drucker selbst „wenig“ oder „leer“ (z. B. Lexmark bei Cyan und Magenta), steht das dort samt „bitte nachbestellen“, es kommt eine Meldung und ein Sensor schlägt an
- Drucker-Bericht: Fixiereinheit, Transfereinheit und Trommel in Blau wie auf der Geräteseite statt in Grau, das wie leer aussah

## 0.45.0 - 2026-11-18

- Gruppen für Monitore und Sensoren (wie in Uptime Kuma): eigene Gruppe im Formular oder für mehrere auf einmal, sonst gilt der Standort des Geräts. Neue Ansicht „Nach Gruppe“ mit Zusammenfassung je Gruppe; Gruppen mit einer Störung stehen oben und bleiben aufgeklappt
- Gruppen-Alarm: neue Monitor-Art „Gruppe“ – gestört, wenn ein Mitglied gestört ist oder erst, wenn alle gestört sind; mit eigenen Kanälen, Eskalation und Wartungsfenstern. So kommt für eine Gruppe ein Alarm statt einer pro Monitor
- Wartungsfenster: Monitore einer Gruppe lassen sich mit einem Haken zusammen wählen
- Rechner-Skript entfernt: Meldet sich das Skript eines Rechners einen Tag lang nicht, wird der Rechner für neue Sensoren nicht mehr angeboten. Seine Seite fragt, ob es entfernt wurde - mit „Skript neu erzeugen“ und „Skript-Daten entfernen“; danach steht dort wieder „Per Skript überwachen“. Bestehende Sensoren bleiben und melden danach „Skript-Daten entfernt“, bis du sie löschst. Wird das Skript eines einzelnen Rechners unter Einstellungen gelöscht, geht seine letzte Meldung gleich mit

## 0.44.0 - 2026-11-17

- Nach Absender: Jeder Absender zeigt, wie er schickt - UDP, TCP, TLS oder Trap; „auch UDP“, wenn er heute noch über UDP geschickt hat. Der Schnellfilter „Noch per UDP“ zeigt die Geräte, die man auf TCP umstellen kann (dort geht bei einer Flut nichts verloren). Bestehende Absender bekommen das Kennzeichen mit ihrer nächsten Meldung

## 0.43.1 - 2026-11-17

- Was belegt den Platz?: Schon ausgeschlossene Ereignisse stehen nicht mehr oben, sondern zugeklappt am Ende - mit dem Tag, an dem ihre älteren Meldungen weg sind. Oben steht, wie viel der Menge pro Tag nur noch solche Altlast ist; die Liste zeigt dafür die 30 größten, bei denen man noch etwas tun kann
- Was belegt den Platz?: Der Knopf „Nicht speichern“ war bei schmalerem Fenster rechts abgeschnitten - das Fenster ist breiter, die Spalten passen
- Lasttest: zeigt nur noch seine Tabelle, ohne Protokollzeilen dazwischen

## 0.43.0 - 2026-11-17

- Meldungen für große Netze: Neue Meldungen werden gesammelt geschrieben - ein Vielfaches schneller (auf einem kleinen Server mit SSD über 10.000 pro Sekunde). Der Schutz vor Flut nimmt jetzt 100 statt 20 pro Sekunde je Absender und 3.000 statt 300 insgesamt (änderbar mit WOMN_MESSAGES_PER_SECOND); über TCP und TLS geht dabei nichts mehr verloren - der Absender wartet kurz, statt dass Meldungen verworfen werden. Verworfene (UDP) stehen oben auf der Seite
- Nach Absender: seitenweise (100, dann „Weitere 100 anzeigen“), mit Schnellfiltern samt Anzahl - Fehler, Warnungen, still seit 24 Stunden, mit eigenem Filter -, Gerätetyp aus dem Inventar und Reihenfolge (neueste Meldung, meiste Meldungen, Name)
- Was belegt den Platz?: „von … Rechnern“ ist genau gezählt, auch bei Tausenden (vorher aus den neuesten 500 Meldungen geschätzt); unter den 15 größten Absendern steht, was alle übrigen zusammen belegen, und mit Geräten im Inventar die Verteilung nach Gerätetyp
- Lasttest: docker compose exec whatsonmynet womn-admin loadtest misst auf der eigenen Hardware, wie viele Meldungen pro Sekunde der Server schafft, und sagt, was das in Rechnern und Platz heißt (eigene Testdatei, wird danach gelöscht)

## 0.42.1 - 2026-11-17

- Handbuch: vollständige NXLog-Konfiguration als Beispiel, die Quelle und Protokoll mitschickt (damit greifen Ausschlüsse wie 1@Ntfs); Fluent Bit als zweiter kostenloser Agent mit fertiger Konfiguration, geprüft auf echtem Windows Server; Hinweise zu Winlogbeat und zur Windows-Ereignisweiterleitung
- Meldungen: Windows-Ereignisse von Fluent Bit (JSON) werden mit Schwere erkannt - die Stufe als Zahl und „Überwachung fehlgeschlagen“ aus den Schlüsselwörtern
- Windows-Skripte: Das Fenster zum Herunterladen nennt den Registry-Eintrag für Softwareverteilung und Inventar (HKLM\SOFTWARE\WhatsOnMyNet, Wert HostScript bzw. HyperVScript, aktuelle Version); das Handbuch zeigt ihn als Tabelle mit Abfrage und Erkennungsregel für Intune/SCCM
- Windows-Ereignisse aus NXLog (lesbare Form): Quellen mit mehr als 48 Zeichen (z. B. Microsoft-Windows-TerminalServices-LocalSessionManager) und Quellen mit Leerzeichen und Prozessnummer (Microsoft-Windows-Windows Defender[3120]) wurden nicht erkannt - Nummer, Quelle und Protokoll fehlten, und die Ausschlussliste griff nicht. Behoben

## 0.42.0 - 2026-11-17

- Windows-Skript: Weist WhatsOnMyNet einen Bericht ab (z. B. Schlüssel nicht mehr gültig) oder ist nicht erreichbar, schrieb das Skript bei jedem Lauf eine Warnung 4100 ins PowerShell-Protokoll - behoben. Die Antwort steht jetzt in womn-host-send.json neben dem Skript, die geplante Aufgabe endet mit Ergebnis 2. Getestet auf echtem Windows (Server 2022 und 2025). Das gilt auch für das Hyper-V-Skript
- Windows-Skripte mit Versionsnummer: in der ersten Zeile, in der Registry unter HKLM\SOFTWARE\WhatsOnMyNet (HostScript bzw. HyperVScript) zum Filtern in der Softwareverteilung, und im Bericht - die Geräteseite markiert Rechner mit einem älteren Skript als „veraltet“. Die Nummer ändert sich nur, wenn sich das Skript ändert. Dafür das Skript einmal neu verteilen
- Speicherpools: ZFS und Ceph aus Proxmox (Zustand, ausgefallene Platten/OSDs, Belegung, letzter Scrub), ZFS und Software-RAID (mdadm) im Linux-Skript, Storage Spaces im Windows-Skript - mit Sensoren für Zustand, Belegung, Tage seit dem Scrub und ausgefallene Mitglieder
- Neu: TrueNAS (ab 25.04, WebSocket-API, API-Schlüssel eines Benutzers mit „Read-Only Administrator“) - Pools, Warnungen von TrueNAS, Replikationen; und Ceph ohne Proxmox über das Ceph-Dashboard (Benutzer mit Rolle „read-only“)
- Diagnosepaket: Speicherpools, TrueNAS-Warnungen und Replikationen sowie die Version des Windows-Skripts je Rechner (anonymisiert)
- Scan nur auf Wunsch: Bei einer neuen Installation ist der nächtliche Scan aus - WhatsOnMyNet scannt nichts von sich aus. Die Seite „Netzwerk scannen“ sagt das und bietet Administratoren „Nächtlichen Scan einschalten“ an; Ein- und Ausschalten steht im Protokoll. Bestehende Installationen behalten ihre Einstellung
- Meldungen: Ausschließen je Quelle - „1@Ntfs“ nimmt die 1 von NTFS nicht mehr an, die 1 von Sysmon schon. „Was belegt den Platz?“ zeigt eine Nummer mehrerer Quellen in eigenen Zeilen, „Nicht speichern“ nimmt die Quelle mit
- Für KI kopieren: schon ausgeschlossene Ereignisse werden nicht noch einmal gefragt; die Quelle steht je Ereignis dabei, und die KI nennt Nummern für eine Quelle als ID@Quelle

## 0.41.0 - 2026-11-17

- Meldungen: Zeitleiste ohne Suchbegriff, Übersicht „Nach Absender“ und Seite „Platz“ sind auch bei Millionen Meldungen sofort da - sie lesen eine Zählung je Minute und Stunde statt aller Meldungen (bei 2 Millionen Meldungen etwa 10 Millisekunden statt 1 bis 2 Sekunden). Die Zahlen bleiben genau. Nach dem Update wird eine bestehende Meldungsdatei im Hintergrund nachgezählt
- Meldungen: „Was belegt den Platz?“ zeigt, welche Windows-Ereignisse und Absender die meisten Meldungen schicken - mit Anteil, Menge pro Tag, geschätztem Platz, Beispiel und Hinweisen (eine Regel braucht es, meist wichtig, übliches Rauschen). Administratoren schließen ein Ereignis mit einem Klick aus; eins, das eine Regel braucht, nicht. „Für KI kopieren“ macht daraus eine Frage an einen KI-Chat, mit Platzhaltern statt Namen, Adressen und Konten
- Meldungen: Alte Meldungen gehen in Stücken statt mit einem Mal - ein großer Tag zum Löschen hält den Empfang nicht mehr auf

## 0.40.0 - 2026-11-17

- Meldungen: Suchen speichern - unter „Gespeichert“ Suchbegriff, Schwere, Art und Zeitraum unter einem Namen ablegen und mit einem Klick wieder einstellen, für sich oder für alle sichtbar
- Windows-Skript auf Windows Server: Es fragte das Sicherheitscenter ab, das es nur auf Client-Windows gibt (bei anderem Virenschutz fehlt auch der Defender-Bereich) - der abgefangene Fehler landete trotzdem bei jedem Lauf als Warnung 4100 „Ungültiger Namespace“ im PowerShell-Protokoll. Jetzt schaut das Skript erst nach, ob es den Bereich gibt. Der automatische Test läuft jetzt auf Windows Server 2022 und 2025 und prüft auch fehlende Bereiche

## 0.39.0 - 2026-11-16

- Meldungen: Die Suche nimmt mehrere Begriffe - alle müssen vorkommen, egal in welcher Reihenfolge und in welchem Feld: „PC-0001 4104 svc-pocketknife“ findet die Ereignisse 4104 von PC-0001 mit svc-pocketknife im Text. „In Anführungszeichen“ steht eine feste Wortfolge, ein Minus schließt aus („4625 -svc-backup“). Bisher galten mehrere Wörter als eine Wortfolge
- Windows-Skript: Beim ersten Lauf (und bis zur ersten Suche nach Windows-Updates) schrieb es eine Warnung 4100 ins PowerShell-Protokoll, weil es eine noch nicht vorhandene Statusdatei lesen wollte - behoben. Das Skript wird jetzt bei jeder Änderung automatisch auf einem echten Windows getestet: einmal von Hand eingerichtet, dann als geplante Aufgabe unter SYSTEM, mit eingeschalteter Skriptblock-Protokollierung - jede Warnung oder jeder Fehler im PowerShell-Protokoll lässt den Test scheitern
- Ausfallsicherung: Laufen Master und Standby eine halbe Stunde lang mit unterschiedlichen Versionen, schickt der Standby eine Erinnerung an die Standard-Kanäle - mit dem Hinweis, welches System auf welche Version zu bringen ist (alle 7 Tage wieder, solange es so bleibt). Kann der Standby die Daten wegen der Datenbankversion nicht mehr übernehmen, kommt die Meldung sofort, dringend und täglich. Sind beide wieder gleich, meldet er das einmal. Der Unterschied steht auch unter Einstellungen → Ausfallsicherung, auf dem Standby zusätzlich in der Leiste oben
- Meldungen: schnelle Suche auch in vielen Gigabyte - ein Suchindex findet ganze Wörter und Wortanfänge („m.muster“, „link down“, „Druck“ für Druckwarteschlange), Groß-/Kleinschreibung und Umlaute egal, über 30 oder 90 Tage in Sekundenbruchteilen. Teile mitten im Wort (z. B. „006A“ aus 0xC000006A) auf Wunsch: „Auch in Wortteilen suchen“. Nach dem Update wird der Index für die gespeicherten Meldungen einmal im Hintergrund aufgebaut (etwa eine halbe Minute je Million), gesucht werden kann die ganze Zeit
- Hinweis zum Platz: Der Suchindex braucht etwa ein Viertel der Meldungsdatei. Ist die Datei an ihrer Grenze, gehen die ältesten Meldungen entsprechend früher - wer gleich viele Tage behalten will, stellt unter Empfang einstellen ein Drittel mehr Platz ein. Die Tabelle im Handbuch rechnet jetzt mit 2 KB je Meldung

## 0.38.0 - 2026-11-16

- Meldungen: Zeitraum und Zeitleiste wie in Splunk oder Wazuh - letzte 15 Minuten bis 30 Tage oder ein eigener Zeitraum; über der Liste zählt eine Zeitleiste die Treffer je Zeitabschnitt (Fehler, Warnungen, Rest). Nach einem Ereignis suchen, dann einen Balken anklicken oder über mehrere ziehen: Liste und Zeitleiste grenzen sich darauf ein, „Zurück“ geht einen Schritt zurück. Ein Klick auf die Uhrzeit einer Meldung zeigt, was in den 5 Minuten davor und danach sonst kam

## 0.37.0 - 2026-11-16

- Sicherung: Die Anzahl der aufbewahrten Sicherungen stellst du jetzt dort ein, wo die Sicherungen sind - unter Einstellungen → Sicherung → Aufbewahrung (Standard 10). Sie gilt auch für die Kopien vor einem Update und vor einer Wiederherstellung; beim Speichern werden überzählige gleich gelöscht. Einzelne Sicherungen lassen sich in der Liste löschen (mit Rückfrage)
- Einstellungen aufgeräumt: „Zwei-Faktor-Anmeldung für Administratoren verpflichtend“ steht jetzt bei den Benutzern (Abschnitt Anmeldung), unter Allgemein bleibt der Name der Installation
- Handbuch und README: Wie viel Platz brauchen die Meldungen? - Formel, Werte je Absender und typische Umgebungen mit empfohlenen Einstellungen

## 0.36.0 - 2026-11-16

- Fehlgeschlagene Anmeldungen (4625): Die fertige Regel zählt ohne die Dienst-Anmeldungen des Rechners selbst und ohne „kein Anmeldeserver erreichbar“ (Laptop beim Hochfahren vor dem VPN) - beides ist kein Angriff. Eine so angelegte Regel bekommt die Ausnahmen beim Update, eine von Hand geänderte bleibt
- Windows-Anmeldeereignisse (4625, 4740, 4771, 4776): In Benachrichtigungen und in der Meldungsliste steht statt des abgeschnittenen Textanfangs eine Kurzfassung - Konto, Anmeldeart, Grund und Herkunft
- Meldungstexte werden bis 4000 statt 1000 Zeichen gespeichert, damit auch lange Windows-Ereignisse vollständig sind; die Liste zeigt sie gekürzt mit „ganzer Text“. Das NXLog-Beispiel im Handbuch schickt jede Meldung am Stück

## 0.35.0 - 2026-11-16

- Ereignis-Regeln und Berichte: ein Schalter in der Liste zeigt auf einen Blick, ob eine Regel bzw. ein Bericht aktiv ist, und schaltet sie mit einem Klick ein oder aus - ohne sie zu öffnen

## 0.34.0 - 2026-11-16

- Ereignis-Regeln: neue fertige Regeln - neue geplante Aufgabe (4698), Benutzerkonto angelegt (4720), Echtzeitschutz von Defender ausgeschaltet (5001), PowerShell: verdächtiges Skript (4104, nur Warnungen) und Fehler eines Befehls (4100); „Protokoll gelöscht“ erkennt jetzt auch das Systemprotokoll (104). Im Handbuch steht, welche Überwachung Windows dafür braucht

## 0.33.5 - 2026-11-16

- Windows-Skript der Rechner: kein „Systemfehler“ (Ereignis 4100, Warnung) mehr bei jedem Lauf - die Ursache war „Select-Object -First“ (erste Netzwerkadresse, Defender-Status, die ersten 10 Ereignisse): Windows PowerShell bricht damit die Abfrage davor ab und protokolliert das als Systemfehler. Die ersten Einträge werden jetzt per Index genommen, die Werte bleiben gleich. Wirkt nach Neues Skript und erneutem Verteilen

## 0.33.4 - 2026-11-16

- Windows- und Hyper-V-Skript: ohne Fortschrittsanzeige bei der Meldung an WhatsOnMyNet (unter der geplanten Aufgabe gibt es kein Fenster dafür)

## 0.33.3 - 2026-11-16

- Windows- und Hyper-V-Skript: Windows protokollierte jeden Lauf als „verdächtigen“ Skriptblock (Ereignis 4104, Warnung) - wegen des eingebauten C#-Codes für das angeheftete Zertifikat und „-ExecutionPolicy Bypass“. Das Zertifikat wird jetzt in PowerShell selbst geprüft (gleich streng: genau dieser Schlüssel bzw. dieses Zertifikat), die geplante Aufgabe läuft unter RemoteSigned. Wirkt nach Neues Skript und erneutem Verteilen

## 0.33.2 - 2026-11-15

- Windows-Skripte der Rechner: Das erneute Einrichten nahm der vorhandenen Kopie unter C:\ProgramData\WhatsOnMyNet alle Rechte - danach kam selbst SYSTEM nicht mehr daran („Zugriff verweigert“). Die Rechte werden jetzt nur am Ordner gesetzt, vorhandene Dateien erben sie wieder (auch so beschädigte), und außer SYSTEM und Administratoren hat niemand Zugriff auf den Ordner

## 0.33.1 - 2026-11-15

- Windows-Skripte der Rechner: Das erneute Einrichten (neues Skript, Update) scheiterte mit „Zugriff verweigert“, wenn die alte Kopie schreibgeschützt war - etwa weil die Einrichtungsdatei aus einem Paketordner oder einer Freigabe kam. Jetzt wird der Schreibschutz aufgehoben, ein laufender Bericht beendet und mehrmals versucht; die neue Kopie bleibt nie schreibgeschützt

## 0.33.0 - 2026-11-15

- Windows-Skript der Rechner: liest Netzwerkkarten, Festplatten, Defender und Firewall direkt aus WMI statt über die PowerShell-Module - mit eingeschaltetem Skriptblockprotokoll entstehen pro Lauf nicht mehr rund 70 „verdächtige“ Ereignisse 4104, sondern nur wenige „ausführliche“. Gleiche Werte; wirkt nach Neues Skript unter Einstellungen → Rechner-Skripte und erneutem Ausführen bzw. Verteilen

## 0.32.0 - 2026-11-15

- Sicherungen der Datenbank liegen komprimiert auf dem Server (.sqlite.gz, meist nur ein Bruchteil der Größe); Standard jetzt 10 statt 7 (wer 7 eingestellt hatte, hat jetzt 10). Vorhandene Sicherungen werden einmal komprimiert, Kopien vor Updates und vor dem Einspielen sammeln sich nicht mehr an (je die 10 neuesten). Einspielen geht mit .sqlite und .sqlite.gz
- Windows-Ereignisse: neue Installationen nehmen das übliche Rauschen gar nicht erst an (An-/Abmeldungen, Prozessstart, Objektzugriffe, Firewall-Verbindungen, Dienststatus 7036, DCOM 10016, WMI 5858 …); bestehende behalten ihre Liste und können sie unter Empfang einstellen mit „Übliches Rauschen einsetzen“ ergänzen. Fehlanmeldungen, Kontosperren und die fertigen Regeln bleiben unberührt

## 0.31.0 - 2026-11-15

- Aussehen: Standard ist wieder „wie das System“ - hell oder dunkel, wie der Rechner oder das Handy eingestellt ist; Konten auf „hell“ wurden umgestellt, eine eigene Wahl bleibt unter Mein Konto möglich

## 0.30.0 - 2026-11-15

- Ereignis-Konsole: Regeln zählen („ab 5 Treffern in 10 Minuten“, auf Wunsch je Absender), prüfen reguläre Ausdrücke (vor dem Speichern auf gefährliche Formen und Tempo geprüft, eine im Betrieb zu langsame Regel schaltet sich ab) und führen offene Ereignisse: der erste Treffer meldet, weitere zählen nur hoch; Quittieren, Schließen durch die Gegenmeldung (z. B. „Port 7 link up“ schließt nur Port 7), von Hand oder nach Zeit; Ansicht Meldungen → Offen. Neue fertige Regeln: SSH- und Windows-Anmeldefehler, Switch-Port down, USV auf Batterie
- Meldungen: was gespeichert wird - für alle ab einer Schwere (Empfang einstellen) und je Absender eigener Filter (alles, ab Warnung, ab Fehler … oder stumm); stumme Absender bleiben mit der Zahl der verworfenen Meldungen in der Liste
- Windows-Ereignisse nach Nummer filtern (Empfang einstellen): nur bestimmte Nummern annehmen und/oder bestimmte nie (z. B. 8004 Gruppenrichtlinie, 4624/4634 An- und Abmeldung); Regeln für nicht angenommene Nummern werden abgelehnt, die Regelliste warnt
- Umlaute: UTF-8 und Codepage von Windows gemischt in einer Zeile werden beide richtig gelesen („NT-AUTORITÄT … für“ statt „… fÃ¼r“)

## 0.29.0 - 2026-11-15

- Meldungen nach Absender: je Rechner oder Gerät eine Zeile mit der letzten Meldung und den Meldungen, Warnungen und Fehlern der letzten 24 Stunden; ein Klick zeigt nur seine Meldungen, „Alle Meldungen“ wie bisher alles. Auf der Geräteseite: Mehr → Meldungen des Geräts
- Umlaute in Windows-Meldungen (NXLog in der Codepage von Windows) werden richtig gelesen: „NT-AUTORITÄT“ statt „NT-AUTORIT�T“
- Diagnosepaket: neue Datei meldungen.json - Empfänger von Syslog und Traps (Ports, Fehler, Verbindungen), Platz der Meldungsdatei, Meldungen im Zeitraum nach Art, Schwere und NXLog-Format, Ereignisregeln mit Treffern, Wartenden und Fehlversuchen; Absender anonymisiert, Wörter der Regeln nur gezählt
- Meldungen: Anzahl und Platz stimmen sofort, sobald neue Meldungen kommen (zeigten bis zu einer Minute lang noch den alten Stand, nach dem Einschalten „0 gespeichert“ neben der Liste)

## 0.28.0 - 2026-11-15

- Meldungen in einer eigenen Datei (data/events.sqlite): die Datenbank und ihre täglichen Sicherungen bleiben klein; vorhandene Meldungen ziehen beim Update einmal um. Grenze jetzt in Speicherplatz statt 200 000 Stück: 30 Tage in höchstens 2 GB, bei knappem Datenträger bleiben mindestens 10 % frei. Die Seite zeigt belegten Platz, Meldungen am Tag, wie viele Tage der Platz reicht - und wer die meisten Meldungen schickt, wenn er nicht reicht

## 0.27.0 - 2026-11-15

- NAS (gefunden im ersten echten Diagnosepaket): Antwortet ein beschäftigtes NAS nur halb, galten Platten, Volumes und Speicherpools für eine Abfrage als „nicht gefunden“ - nachts kamen so Dutzende Fehlalarme und Entwarnungen. Jetzt fragt WhatsOnMyNet die Tabellen nacheinander ab, erkennt unvollständige Antworten und behält fehlende Einträge bis zu zwei Abfragen lang
- Sensoren mit Grenze geben erst mit Abstand Entwarnung (2 °C bzw. 2 Prozentpunkte) - ein Fühler, der um seine Grenze pendelt, alarmiert nicht mehr alle 5 Minuten
- Proxmox: Fehlt ein Wert nur einmal, heißt es „gerade kein Wert (vom Host nicht geliefert)“ statt „dem Konto fehlen wohl Leserechte“ - das nur noch, wenn wirklich Rechte fehlen
- Diagnosepaket: auch der SMTP-Benutzername wird zum Platzhalter
- Jeder Monitor und Sensor zeigt „So wird geprüft“: was genau gefragt wird, woher die Werte kommen und wie alt sie sind, wann alarmiert wird (mit Abstand für die Entwarnung) und die letzte Antwort im Wortlaut
- Proxmox VE und Backup Server: Fehlgeschlagene Aufgaben zeigen die Fehlerzeilen aus dem Aufgabenprotokoll und einen verständlichen Namen statt „aptupdate“ oder „verificationjob“. Wartungsaufgaben sind gelb statt rot
- Paketlisten: Scheitert nur eine fremde Paketquelle (z. B. Webmin), ist das ein Hinweis und kein Fehler - Alarm gibt es nur, wenn eine offizielle Quelle von Proxmox oder Debian nicht klappt
- Neu: Cloud - AWS, Microsoft Azure und Google Cloud über ein Konto, das nur lesen darf: VMs mit den Prüfungen des Anbieters (Status-Checks, Resource Health) und geplanten Wartungen, Datenbanken (RDS, Azure SQL/PostgreSQL/MySQL, Cloud SQL), Load Balancer, die Alarme des Anbieters und auf Wunsch die Kosten des Monats - mit Sensoren. Fehlende Rechte werden genau benannt
- Neu: Meldungen der Geräte - WhatsOnMyNet empfängt SNMP-Traps (v1, v2c) und Syslog, ordnet sie dem Gerät zu und zeigt sie unter Überwachung → Meldungen. Mit „Überwachen“ wird aus einer Meldung ein Monitor, der sofort alarmiert, wenn sie wiederkommt. Aus, bis man es einschaltet; Ports 1162 und 1514 (Umleitung von 162/514 im Handbuch)
- Neue Prüfarten: Mailserver (SMTP, IMAP, POP3 - STARTTLS/TLS und Ablauf des Zertifikats, ohne Anmeldung), DNS-Auflösung an einem bestimmten Server mit erwarteter Antwort, LDAP/Active Directory (rootDSE, „Domänencontroller nicht synchronisiert“), Zeitserver (NTP: synchronisiert, Abweichung) und Microsoft SQL Server (Version, auch benannte Instanzen)
- Syslog auch über TCP (RFC 6587, Port 1514) und verschlüsselt über TLS (RFC 5425, Port 6514, mit dem Zertifikat dieses Servers) - Meldungen gehen nicht verloren und lassen sich nicht mitlesen; auch Zeilen ohne Syslog-Kopf wie von NXLog im Standardformat; einschalten unter Überwachung → Meldungen → Empfang einstellen
- Neu: Ereignisregeln - ausgewählte Meldungen gehen per Mail, Webhook oder ans Ticketsystem, getrennt von den Monitoren und nie an die Standard-Empfänger; fertige Regeln für Windows (Virenfund, Software-Einschränkung, AppLocker, gesperrtes Konto, Sicherheitsgruppe, gelöschtes Protokoll, neuer Dienst), einzeln mit Obergrenze je Stunde oder gesammelt, Test mit den Meldungen der letzten 7 Tage; nichts geht verloren, wenn ein Empfänger nicht erreichbar ist
- Windows-Ereignisse über NXLog: Ereignisnummer, Protokoll, Quelle und Konto werden erkannt und unter der Meldung gezeigt - ob NXLog im Standardformat, lesbar mit [Nummer] [Protokoll] oder als JSON schickt; die Suche findet eine Ereignisnummer
- Syslog über TCP/TLS: Eine einzelne zu lange Meldung wird übersprungen, statt die Verbindung zu beenden
- Neu: Prometheus und Grafana - /metrics mit dem Zustand aller Monitore und Sensoren (nur mit Schlüssel, nur lesend), Zertifikat zum Herunterladen für ca_file und ein fertiges Grafana-Dashboard (Einstellungen → Prometheus & Grafana)
- Neu: Eigene Prüfungen - Skripte im Ordner checks auf Windows- und Linux-Rechnern geben Zeilen im Checkmk-Format aus (OK/Warnung/kritisch/unbekannt), das Rechner-Skript schickt sie mit; Sensor „Eigene Prüfung …“. Gestartet wird nur, was niemand sonst ändern kann, je höchstens 30 Sekunden. Rechner-Skript dafür neu ausrollen
- Neu: Veeam Backup & Replication (ab 12) - Jobs mit letztem Ergebnis, letztem und nächstem Lauf, Repositories mit Platz; Sensoren für Fehler und Warnungen, zu lange nicht gelaufene Jobs und volle Repositories. Konto mit der Rolle „Veeam Backup Viewer“
- Neu: Microsoft 365 - Zustand der Dienste, offene Störungen, Abonnements und freie Lizenzen über Microsoft Graph (nur Leserechte); Alarm, wenn ein Dienst gestört ist oder ein Abonnement ausläuft
- Switches: Auslastung jedes Ports (ein/aus in Mbit/s und Prozent) aus den Byte-Zählern, mit Sensor „Auslastung Port …“ (Alarm ab 80 %) - kein Wert statt eines falschen nach einem Neustart des Switches
- Deutsche Meldungen: Prozentwerte jetzt mit Komma (85,5 % statt 85.5 %)

## 0.26.0 - 2026-11-15

- Ausfallsicherung: Auf dem Standby lässt sich nichts mehr verstellen - keine Kanäle, E-Mail, Webhooks, Einstellungen, Benutzer, Hypervisoren oder Berichte, auch nicht, während er für den Master überwacht. Die Seiten zeigen nur an und sagen warum. Erlaubt bleiben die Steuerung der Ausfallsicherung (Entkoppeln, zum Master machen, Wartezeit) und Hell/Dunkel und Sprache des eigenen Kontos

## 0.25.0 - 2026-11-14

- Benachrichtigungen: Anzeigename (Absender) pro Kanal - steht über jeder Meldung, damit man sieht, woher sie kommt; bei E-Mail als Absendername und im Betreff, bei ntfy, Gotify, Pushover & Co. als Titel, bei Discord und Mattermost als Name des Bots, im Webhook als „sender“
- Ausfälle in der Verlaufsgrafik: Bei Gründen ohne Doppelpunkt fehlte der erste Buchstabe („onnection refused“) - jetzt steht der Grund vollständig da
- Handbuch, Hilfe und Projektseite: alle Bilder im neuen, hellen Aussehen

## 0.24.0 - 2026-11-14

- Neues Aussehen: ruhiger und heller im Stil einer Mac-App - Systemschrift (San Francisco auf dem Mac, sonst Inter), weiche Flächen, abgerundete Schaltflächen, Reiter als Segmente, durchscheinende Seitenleiste; die Anmeldeseite mit dem Radar auf tiefem Blau
- Hell ist jetzt der Standard. Dunkel oder „Wie das System“ stellt jeder unter Mein Konto → Darstellung um; Konten, die noch auf dem alten Standard „Wie das System“ standen, sind jetzt hell

## 0.23.0 - 2026-11-14

- Tipp „Per Skript überwachen“ jetzt auch bei Linux-Rechnern und Hypervisoren wie Proxmox (bisher vor allem Windows) und unter Virtualisierung bei Proxmox-Knoten ohne Skript - freundlich formuliert: zusätzliche Infos über das System. Er verschwindet von selbst, sobald das Gerät Werte liefert (Skript oder iDRAC/iLO), und lässt sich pro Gerät mit „Nicht mehr anzeigen“ ausblenden
- Skript-Dialoge und Tipp: Link „Was bringt das Skript?“ direkt zum passenden Abschnitt der Hilfe; Hilfe und Handbuch erklären ausführlicher, wofür das Skript gut ist (gerade bei Mini-PCs ohne Server-Hardware)

## 0.22.0 - 2026-11-14

- Mehrere Sensoren oder Monitore ankreuzen und löschen: nach dem Bestätigen passierte nichts - jetzt werden sie gelöscht. Ebenso das Einspielen einer hochgeladenen Sicherung
- Neue NAS: Sensoren nur auf den Datenvolumes (/volume1 …), nicht auf der Systempartition (/, /opt) oder internen Ordnern wie /volume1/@docker
- USV: die Restlaufzeit unter einer Stunde in Minuten („reicht 25 Min.“ statt „reicht 0 Std.“)
- Diagnosepaket (Einstellungen → Diagnose): ein ZIP für die Fehlersuche mit Protokoll, Warnungen und Fehlern, Monitoren, Sensoren, Geräten mit ihren Werten, Hypervisoren, Scans und Einstellungen - für 1 bis 30 Tage oder seit dem letzten Update. Standardmäßig anonymisiert mit Platzhaltern, die in jedem Paket gleich bleiben und sich nachschlagen lassen; nie mit Kennwörtern oder Schlüsseln, nichts wird verschickt. Das Programm bewahrt sein Protokoll dafür 30 Tage auf
- Hilfe, Handbuch und Projektbeschreibung: Ping in einem Proxmox-LXC freischalten (ping_group_range im LXC setzen, Schritt für Schritt); der Hinweis beim Scan zeigt dorthin
- Nichts doppelt: Einen Monitor oder Sensor für etwas, das schon überwacht wird, gibt es kein zweites Mal (Hinweis mit dem Namen des vorhandenen) - Rechnername und IP desselben Geräts gelten als dasselbe Ziel, mehrere Dienste eines Servers bleiben möglich. Schon vorhandene Doppelte werden nach dem Update einmal zusammengelegt (der laufende bleibt)
- Scan: Ein gefundenes Gerät, das vermutlich schon im Inventar ist (gleicher Rechnername, z. B. zweite Netzwerkkarte, oder gleiche IP mit anderer MAC), steht mit Tipp in der Liste und wird beim Übernehmen übersprungen - „Diesem Gerät zuordnen“ oder „Trotzdem als neues Gerät“
- Inventar: Geräte, die vermutlich doppelt drin sind, stehen oben als Hinweis und lassen sich zusammenführen (Monitore, Sensoren, Verlauf und Werte gehen mit)
- Windows- und Linux-Rechner ohne Skript: Tipp auf der Geräteseite „Per Skript überwachen“ (CPU, RAM, Laufwerke, Dienste, Updates); auch nach dem Übernehmen aus dem Scan

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
