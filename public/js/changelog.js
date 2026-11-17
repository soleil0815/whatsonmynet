// What changed, per version, in plain words for the users of the program (not for developers).
// The newest version first. Entries of 'next' belong to the version being built: in a released image they are shown
// under its version number (see whatsNew in views/about.js). At the next release they get their number here.
export const CHANGELOG = [
  { version: 'next', de: [
    'Windows-Skript: Weist WhatsOnMyNet einen Bericht ab (z. B. Schlüssel nicht mehr gültig) oder ist nicht erreichbar, schrieb das Skript bei jedem Lauf eine Warnung 4100 ins PowerShell-Protokoll - behoben. Die Antwort steht jetzt in womn-host-send.json neben dem Skript, die geplante Aufgabe endet mit Ergebnis 2. Getestet auf echtem Windows (Server 2022 und 2025). Das gilt auch für das Hyper-V-Skript',
    'Windows-Skripte mit Versionsnummer: in der ersten Zeile, in der Registry unter HKLM\\SOFTWARE\\WhatsOnMyNet (HostScript bzw. HyperVScript) zum Filtern in der Softwareverteilung, und im Bericht - die Geräteseite markiert Rechner mit einem älteren Skript als „veraltet“. Die Nummer ändert sich nur, wenn sich das Skript ändert. Dafür das Skript einmal neu verteilen',
    'Speicherpools: ZFS und Ceph aus Proxmox (Zustand, ausgefallene Platten/OSDs, Belegung, letzter Scrub), ZFS und Software-RAID (mdadm) im Linux-Skript, Storage Spaces im Windows-Skript - mit Sensoren für Zustand, Belegung, Tage seit dem Scrub und ausgefallene Mitglieder',
    'Neu: TrueNAS (ab 25.04, WebSocket-API, API-Schlüssel eines Benutzers mit „Read-Only Administrator“) - Pools, Warnungen von TrueNAS, Replikationen; und Ceph ohne Proxmox über das Ceph-Dashboard (Benutzer mit Rolle „read-only“)',
    'Diagnosepaket: Speicherpools, TrueNAS-Warnungen und Replikationen sowie die Version des Windows-Skripts je Rechner (anonymisiert)',
    'Scan nur auf Wunsch: Bei einer neuen Installation ist der nächtliche Scan aus - WhatsOnMyNet scannt nichts von sich aus. Die Seite „Netzwerk scannen“ sagt das und bietet Administratoren „Nächtlichen Scan einschalten“ an; Ein- und Ausschalten steht im Protokoll. Bestehende Installationen behalten ihre Einstellung',
  ], en: [
    'Windows script: when WhatsOnMyNet refused a report (e.g. key no longer valid) or could not be reached, the script wrote a warning 4100 to the PowerShell log on every run - fixed. The answer is now in womn-host-send.json next to the script, the scheduled task ends with result 2. Tested on real Windows (Server 2022 and 2025). The same goes for the Hyper-V script',
    'Windows scripts with a version number: in the first line, in the registry under HKLM\\SOFTWARE\\WhatsOnMyNet (HostScript or HyperVScript) to filter on in software distribution, and in the report - the device page marks machines with an older script as "outdated". The number only changes when the script changes. For this, roll out the script once more',
    'Storage pools: ZFS and Ceph from Proxmox (state, failed disks/OSDs, usage, last scrub), ZFS and software RAID (mdadm) in the Linux script, Storage Spaces in the Windows script - with sensors for state, usage, days since the scrub and failed members',
    'New: TrueNAS (25.04 or newer, WebSocket API, API key of a user with "Read-Only Administrator") - pools, alerts of TrueNAS, replications; and Ceph without Proxmox through the Ceph dashboard (user with role "read-only")',
    'Diagnostic package: storage pools, TrueNAS alerts and replications, and the version of the Windows script per machine (anonymised)',
    'Scanning only on request: on a new installation the nightly scan is off - WhatsOnMyNet scans nothing on its own. The page "Scan network" says so and offers administrators "Switch the nightly scan on"; switching it on or off is logged. Existing installations keep their setting',
  ] },
  { version: '0.41.0', date: '2026-11-17', de: [
    'Meldungen: Zeitleiste ohne Suchbegriff, Übersicht „Nach Absender“ und Seite „Platz“ sind auch bei Millionen Meldungen sofort da - sie lesen eine Zählung je Minute und Stunde statt aller Meldungen (bei 2 Millionen Meldungen etwa 10 Millisekunden statt 1 bis 2 Sekunden). Die Zahlen bleiben genau. Nach dem Update wird eine bestehende Meldungsdatei im Hintergrund nachgezählt',
    'Meldungen: „Was belegt den Platz?“ zeigt, welche Windows-Ereignisse und Absender die meisten Meldungen schicken - mit Anteil, Menge pro Tag, geschätztem Platz, Beispiel und Hinweisen (eine Regel braucht es, meist wichtig, übliches Rauschen). Administratoren schließen ein Ereignis mit einem Klick aus; eins, das eine Regel braucht, nicht. „Für KI kopieren“ macht daraus eine Frage an einen KI-Chat, mit Platzhaltern statt Namen, Adressen und Konten',
    'Meldungen: Alte Meldungen gehen in Stücken statt mit einem Mal - ein großer Tag zum Löschen hält den Empfang nicht mehr auf',
  ], en: [
    'Messages: the timeline without a search term, the overview "By sender" and the space page are there at once with millions of messages too - they read counts per minute and hour instead of every message (with 2 million messages about 10 milliseconds instead of 1 to 2 seconds). The figures stay exact. After the update an existing messages file is counted in the background',
    'Messages: "What takes the space?" shows which Windows events and senders send the most messages - with share, amount a day, estimated space, an example and hints (a rule needs it, usually important, usual noise). Admins leave an event out with one click; not one a rule needs. "Copy for AI" turns it into a question for an AI chat, with placeholders instead of names, addresses and accounts',
    'Messages: old messages go in pieces instead of all at once - a big day to remove no longer holds up the receiving',
  ] },
  { version: '0.40.0', date: '2026-11-17', de: [
    'Meldungen: Suchen speichern - unter „Gespeichert“ Suchbegriff, Schwere, Art und Zeitraum unter einem Namen ablegen und mit einem Klick wieder einstellen, für sich oder für alle sichtbar',
    'Windows-Skript auf Windows Server: Es fragte das Sicherheitscenter ab, das es nur auf Client-Windows gibt (bei anderem Virenschutz fehlt auch der Defender-Bereich) - der abgefangene Fehler landete trotzdem bei jedem Lauf als Warnung 4100 „Ungültiger Namespace“ im PowerShell-Protokoll. Jetzt schaut das Skript erst nach, ob es den Bereich gibt. Der automatische Test läuft jetzt auf Windows Server 2022 und 2025 und prüft auch fehlende Bereiche',
  ], en: [
    'Messages: saved searches - under "Saved" keep search term, severity, kind and time range under a name and set them again with one click, for yourself or visible to everyone',
    'Windows script on Windows Server: it asked the Security Center, which only client Windows have (with another virus protection the Defender part is missing too) - the caught error still landed in the PowerShell log as warning 4100 "Invalid namespace" on every run. Now the script looks first whether the part is there. The automatic test now runs on Windows Server 2022 and 2025 and checks missing parts too',
  ] },
  { version: '0.39.0', date: '2026-11-16', de: [
    'Meldungen: Die Suche nimmt mehrere Begriffe - alle müssen vorkommen, egal in welcher Reihenfolge und in welchem Feld: „PC-0001 4104 svc-pocketknife“ findet die Ereignisse 4104 von PC-0001 mit svc-pocketknife im Text. „In Anführungszeichen“ steht eine feste Wortfolge, ein Minus schließt aus („4625 -svc-backup“). Bisher galten mehrere Wörter als eine Wortfolge',
    'Windows-Skript: Beim ersten Lauf (und bis zur ersten Suche nach Windows-Updates) schrieb es eine Warnung 4100 ins PowerShell-Protokoll, weil es eine noch nicht vorhandene Statusdatei lesen wollte - behoben. Das Skript wird jetzt bei jeder Änderung automatisch auf einem echten Windows getestet: einmal von Hand eingerichtet, dann als geplante Aufgabe unter SYSTEM, mit eingeschalteter Skriptblock-Protokollierung - jede Warnung oder jeder Fehler im PowerShell-Protokoll lässt den Test scheitern',
    'Ausfallsicherung: Laufen Master und Standby eine halbe Stunde lang mit unterschiedlichen Versionen, schickt der Standby eine Erinnerung an die Standard-Kanäle - mit dem Hinweis, welches System auf welche Version zu bringen ist (alle 7 Tage wieder, solange es so bleibt). Kann der Standby die Daten wegen der Datenbankversion nicht mehr übernehmen, kommt die Meldung sofort, dringend und täglich. Sind beide wieder gleich, meldet er das einmal. Der Unterschied steht auch unter Einstellungen → Ausfallsicherung, auf dem Standby zusätzlich in der Leiste oben',
    'Meldungen: schnelle Suche auch in vielen Gigabyte - ein Suchindex findet ganze Wörter und Wortanfänge („m.muster“, „link down“, „Druck“ für Druckwarteschlange), Groß-/Kleinschreibung und Umlaute egal, über 30 oder 90 Tage in Sekundenbruchteilen. Teile mitten im Wort (z. B. „006A“ aus 0xC000006A) auf Wunsch: „Auch in Wortteilen suchen“. Nach dem Update wird der Index für die gespeicherten Meldungen einmal im Hintergrund aufgebaut (etwa eine halbe Minute je Million), gesucht werden kann die ganze Zeit',
    'Hinweis zum Platz: Der Suchindex braucht etwa ein Viertel der Meldungsdatei. Ist die Datei an ihrer Grenze, gehen die ältesten Meldungen entsprechend früher - wer gleich viele Tage behalten will, stellt unter Empfang einstellen ein Drittel mehr Platz ein. Die Tabelle im Handbuch rechnet jetzt mit 2 KB je Meldung',
  ], en: [
    'Messages: the search takes several terms - all must be there, in any order and any field: "PC-0001 4104 svc-pocketknife" finds the events 4104 of PC-0001 with svc-pocketknife in the text. "In quotes" is a fixed sequence of words, a minus leaves out ("4625 -svc-backup"). Before, several words counted as one sequence',
    'Windows script: on its first run (and until the first search for Windows updates) it wrote a warning 4100 to the PowerShell log, because it tried to read a status file not there yet - fixed. The script is now tested automatically on a real Windows with every change: set up by hand once, then run as scheduled task under SYSTEM, with script block logging on - any warning or error in the PowerShell log fails the test',
    'Failover: if master and standby run different versions for half an hour, the standby sends a reminder to the default channels - saying which server to bring to which version (again every 7 days while it stays so). If the standby cannot take the data any more because of the database version, the message comes at once, urgent and daily. When both are the same again, it says so once. The difference also shows under Settings → Failover, on the standby in the bar at the top too',
    'Messages: fast search in many gigabytes too - a search index finds whole words and beginnings of words ("m.muster", "link down", "print" for printer), upper/lower case and umlauts alike, over 30 or 90 days in a fraction of a second. Parts in the middle of a word (e.g. "006A" of 0xC000006A) on request: "Search parts of words too". After the update the index for the stored messages is built once in the background (about half a minute per million), you can search all the time',
    'About space: the search index takes about a quarter of the messages file. When the file is at its limit, the oldest messages go correspondingly earlier - to keep as many days, set a third more space under Receiving settings. The table in the manual now reckons with 2 KB per message',
  ] },
  { version: '0.38.0', date: '2026-11-16', de: [
    'Meldungen: Zeitraum und Zeitleiste wie in Splunk oder Wazuh - letzte 15 Minuten bis 30 Tage oder ein eigener Zeitraum; über der Liste zählt eine Zeitleiste die Treffer je Zeitabschnitt (Fehler, Warnungen, Rest). Nach einem Ereignis suchen, dann einen Balken anklicken oder über mehrere ziehen: Liste und Zeitleiste grenzen sich darauf ein, „Zurück“ geht einen Schritt zurück. Ein Klick auf die Uhrzeit einer Meldung zeigt, was in den 5 Minuten davor und danach sonst kam',
  ], en: [
    'Messages: time range and timeline as in Splunk or Wazuh - last 15 minutes to 30 days or a custom range; above the list a timeline counts the hits per step of time (errors, warnings, the rest). Search for an event, then click a bar or drag across several: list and timeline narrow to it, "Back" goes one step back. A click on the time of a message shows what else came in the 5 minutes before and after',
  ] },
  { version: '0.37.0', date: '2026-11-16', de: [
    'Sicherung: Die Anzahl der aufbewahrten Sicherungen stellst du jetzt dort ein, wo die Sicherungen sind - unter Einstellungen → Sicherung → Aufbewahrung (Standard 10). Sie gilt auch für die Kopien vor einem Update und vor einer Wiederherstellung; beim Speichern werden überzählige gleich gelöscht. Einzelne Sicherungen lassen sich in der Liste löschen (mit Rückfrage)',
    'Einstellungen aufgeräumt: „Zwei-Faktor-Anmeldung für Administratoren verpflichtend“ steht jetzt bei den Benutzern (Abschnitt Anmeldung), unter Allgemein bleibt der Name der Installation',
    'Handbuch und README: Wie viel Platz brauchen die Meldungen? - Formel, Werte je Absender und typische Umgebungen mit empfohlenen Einstellungen',
  ], en: [
    'Backup: the number of backups kept is now set where the backups are - under Settings → Backup → Retention (default 10). It applies to the copies before an update and before a restore as well; saving deletes the ones over it at once. Single backups can be deleted in the list (with a question first)',
    'Settings tidied: "two-factor sign-in mandatory for administrators" is now with the users (section Sign-in), General keeps the name of the installation',
    'Manual and README: how much space do the messages need? - formula, values per sender and typical setups with recommended settings',
  ] },
  { version: '0.36.0', date: '2026-11-16', de: [
    'Fehlgeschlagene Anmeldungen (4625): Die fertige Regel zählt ohne die Dienst-Anmeldungen des Rechners selbst und ohne „kein Anmeldeserver erreichbar“ (Laptop beim Hochfahren vor dem VPN) - beides ist kein Angriff. Eine so angelegte Regel bekommt die Ausnahmen beim Update, eine von Hand geänderte bleibt',
    'Windows-Anmeldeereignisse (4625, 4740, 4771, 4776): In Benachrichtigungen und in der Meldungsliste steht statt des abgeschnittenen Textanfangs eine Kurzfassung - Konto, Anmeldeart, Grund und Herkunft',
    'Meldungstexte werden bis 4000 statt 1000 Zeichen gespeichert, damit auch lange Windows-Ereignisse vollständig sind; die Liste zeigt sie gekürzt mit „ganzer Text“. Das NXLog-Beispiel im Handbuch schickt jede Meldung am Stück',
  ], en: [
    'Failed logons (4625): the ready-made rule counts without the computer\'s own service logons and without "no logon server reachable" (laptop starting before its VPN) - neither is an attack. A rule made that way gets the exceptions with the update, one changed by hand stays',
    'Windows sign-in events (4625, 4740, 4771, 4776): notifications and the message list show a summary instead of the cut start of the text - account, logon type, reason and origin',
    'Message texts are kept up to 4000 instead of 1000 characters, so long Windows events are complete; the list shows them shortened with "whole text". The NXLog example in the manual sends each message in one piece',
  ] },
  { version: '0.35.0', date: '2026-11-16', de: [
    'Ereignis-Regeln und Berichte: ein Schalter in der Liste zeigt auf einen Blick, ob eine Regel bzw. ein Bericht aktiv ist, und schaltet sie mit einem Klick ein oder aus - ohne sie zu öffnen',
  ], en: [
    'Event rules and reports: a switch in the list shows at a glance whether a rule or report is active and turns it on or off with one click - without opening it',
  ] },
  { version: '0.34.0', date: '2026-11-16', de: [
    'Ereignis-Regeln: neue fertige Regeln - neue geplante Aufgabe (4698), Benutzerkonto angelegt (4720), Echtzeitschutz von Defender ausgeschaltet (5001), PowerShell: verdächtiges Skript (4104, nur Warnungen) und Fehler eines Befehls (4100); „Protokoll gelöscht“ erkennt jetzt auch das Systemprotokoll (104). Im Handbuch steht, welche Überwachung Windows dafür braucht',
  ], en: [
    'Event rules: new ready-made rules - new scheduled task (4698), user account created (4720), Defender real-time protection turned off (5001), PowerShell: suspicious script (4104, warnings only) and error of a command (4100); "log cleared" now also covers the system log (104). The manual says which auditing Windows needs for them',
  ] },
  { version: '0.33.5', date: '2026-11-16', de: [
    'Windows-Skript der Rechner: kein „Systemfehler“ (Ereignis 4100, Warnung) mehr bei jedem Lauf - die Ursache war „Select-Object -First“ (erste Netzwerkadresse, Defender-Status, die ersten 10 Ereignisse): Windows PowerShell bricht damit die Abfrage davor ab und protokolliert das als Systemfehler. Die ersten Einträge werden jetzt per Index genommen, die Werte bleiben gleich. Wirkt nach Neues Skript und erneutem Verteilen',
  ], en: [
    'Windows script of the machines: no more "System error" (event 4100, warning) on every run - the cause was "Select-Object -First" (first network address, Defender status, the first 10 events): Windows PowerShell stops the query before it that way and logs it as system error. The first entries are now taken by index, the values stay the same. Takes effect after New script and distributing it again',
  ] },
  { version: '0.33.4', date: '2026-11-16', de: [
    'Windows- und Hyper-V-Skript: ohne Fortschrittsanzeige bei der Meldung an WhatsOnMyNet (unter der geplanten Aufgabe gibt es kein Fenster dafür)',
  ], en: [
    'Windows and Hyper-V script: no progress bar when reporting to WhatsOnMyNet (under the scheduled task there is no window for it)',
  ] },
  { version: '0.33.3', date: '2026-11-16', de: [
    'Windows- und Hyper-V-Skript: Windows protokollierte jeden Lauf als „verdächtigen“ Skriptblock (Ereignis 4104, Warnung) - wegen des eingebauten C#-Codes für das angeheftete Zertifikat und „-ExecutionPolicy Bypass“. Das Zertifikat wird jetzt in PowerShell selbst geprüft (gleich streng: genau dieser Schlüssel bzw. dieses Zertifikat), die geplante Aufgabe läuft unter RemoteSigned. Wirkt nach Neues Skript und erneutem Verteilen',
  ], en: [
    'Windows and Hyper-V script: Windows logged every run as a "suspicious" script block (event 4104, warning) - because of the built-in C# code for the pinned certificate and "-ExecutionPolicy Bypass". The certificate is now checked by PowerShell itself (just as strict: exactly this key or this certificate), the scheduled task runs under RemoteSigned. Takes effect after New script and distributing it again',
  ] },
  { version: '0.33.2', date: '2026-11-15', de: [
    'Windows-Skripte der Rechner: Das erneute Einrichten nahm der vorhandenen Kopie unter C:\\ProgramData\\WhatsOnMyNet alle Rechte - danach kam selbst SYSTEM nicht mehr daran („Zugriff verweigert“). Die Rechte werden jetzt nur am Ordner gesetzt, vorhandene Dateien erben sie wieder (auch so beschädigte), und außer SYSTEM und Administratoren hat niemand Zugriff auf den Ordner',
  ], en: [
    'Windows scripts of the machines: setting up again took all rights from the existing copy in C:\\ProgramData\\WhatsOnMyNet - afterwards not even SYSTEM could get at it ("access denied"). The rights are now set on the folder only, existing files inherit them again (also ones damaged that way), and nobody but SYSTEM and administrators has access to the folder',
  ] },
  { version: '0.33.1', date: '2026-11-15', de: [
    'Windows-Skripte der Rechner: Das erneute Einrichten (neues Skript, Update) scheiterte mit „Zugriff verweigert“, wenn die alte Kopie schreibgeschützt war - etwa weil die Einrichtungsdatei aus einem Paketordner oder einer Freigabe kam. Jetzt wird der Schreibschutz aufgehoben, ein laufender Bericht beendet und mehrmals versucht; die neue Kopie bleibt nie schreibgeschützt',
  ], en: [
    'Windows scripts of the machines: setting up again (new script, update) failed with "access denied" when the old copy was read-only - for example because the setup file came from a package folder or a share. Now the read-only flag is cleared, a running report ended and it is tried several times; the new copy is never left read-only',
  ] },
  { version: '0.33.0', date: '2026-11-15', de: [
    'Windows-Skript der Rechner: liest Netzwerkkarten, Festplatten, Defender und Firewall direkt aus WMI statt über die PowerShell-Module - mit eingeschaltetem Skriptblockprotokoll entstehen pro Lauf nicht mehr rund 70 „verdächtige“ Ereignisse 4104, sondern nur wenige „ausführliche“. Gleiche Werte; wirkt nach Neues Skript unter Einstellungen → Rechner-Skripte und erneutem Ausführen bzw. Verteilen',
  ], en: [
    'Windows script of the machines: reads network cards, disks, Defender and firewall straight from WMI instead of through the PowerShell modules - with script block logging on, a run no longer leaves some 70 "suspicious" events 4104 but only a few "verbose" ones. Same values; takes effect after New script under Settings → Machine scripts and running or distributing it again',
  ] },
  { version: '0.32.0', date: '2026-11-15', de: [
    'Sicherungen der Datenbank liegen komprimiert auf dem Server (.sqlite.gz, meist nur ein Bruchteil der Größe); Standard jetzt 10 statt 7 (wer 7 eingestellt hatte, hat jetzt 10). Vorhandene Sicherungen werden einmal komprimiert, Kopien vor Updates und vor dem Einspielen sammeln sich nicht mehr an (je die 10 neuesten). Einspielen geht mit .sqlite und .sqlite.gz',
    'Windows-Ereignisse: neue Installationen nehmen das übliche Rauschen gar nicht erst an (An-/Abmeldungen, Prozessstart, Objektzugriffe, Firewall-Verbindungen, Dienststatus 7036, DCOM 10016, WMI 5858 …); bestehende behalten ihre Liste und können sie unter Empfang einstellen mit „Übliches Rauschen einsetzen“ ergänzen. Fehlanmeldungen, Kontosperren und die fertigen Regeln bleiben unberührt',
  ], en: [
    'Database backups are kept compressed on the server (.sqlite.gz, mostly a fraction of the size); default now 10 instead of 7 (who had 7 set now has 10). Existing backups are compressed once, copies before updates and before a restore no longer pile up (the 10 newest each). Restoring takes .sqlite and .sqlite.gz',
    'Windows events: new installations do not take the usual noise at all (logons/logoffs, process start, object access, firewall connections, service state 7036, DCOM 10016, WMI 5858 …); existing ones keep their list and can add to it under Receiving settings with "Add the usual noise". Failed logons, account lockouts and the ready-made rules are not touched',
  ] },
  { version: '0.31.0', date: '2026-11-15', de: [
    'Aussehen: Standard ist wieder „wie das System“ - hell oder dunkel, wie der Rechner oder das Handy eingestellt ist; Konten auf „hell“ wurden umgestellt, eine eigene Wahl bleibt unter Mein Konto möglich',
  ], en: [
    'Look: the default is "like the system" again - light or dark as the computer or phone is set; accounts on "light" were switched over, an own choice stays possible under My account',
  ] },
  { version: '0.30.0', date: '2026-11-15', de: [
    'Ereignis-Konsole: Regeln zählen („ab 5 Treffern in 10 Minuten“, auf Wunsch je Absender), prüfen reguläre Ausdrücke (vor dem Speichern auf gefährliche Formen und Tempo geprüft, eine im Betrieb zu langsame Regel schaltet sich ab) und führen offene Ereignisse: der erste Treffer meldet, weitere zählen nur hoch; Quittieren, Schließen durch die Gegenmeldung (z. B. „Port 7 link up“ schließt nur Port 7), von Hand oder nach Zeit; Ansicht Meldungen → Offen. Neue fertige Regeln: SSH- und Windows-Anmeldefehler, Switch-Port down, USV auf Batterie',
    'Meldungen: was gespeichert wird - für alle ab einer Schwere (Empfang einstellen) und je Absender eigener Filter (alles, ab Warnung, ab Fehler … oder stumm); stumme Absender bleiben mit der Zahl der verworfenen Meldungen in der Liste',
    'Windows-Ereignisse nach Nummer filtern (Empfang einstellen): nur bestimmte Nummern annehmen und/oder bestimmte nie (z. B. 8004 Gruppenrichtlinie, 4624/4634 An- und Abmeldung); Regeln für nicht angenommene Nummern werden abgelehnt, die Regelliste warnt',
    'Umlaute: UTF-8 und Codepage von Windows gemischt in einer Zeile werden beide richtig gelesen („NT-AUTORITÄT … für“ statt „… fÃ¼r“)',
  ], en: [
    'Event console: rules count ("from 5 matches in 10 minutes", per sender if wanted), check regular expressions (checked for dangerous shapes and speed before saving, a rule too slow while running switches itself off) and keep open events: the first match notifies, further ones only count up; acknowledge, close by the counter-message (e.g. "Port 7 link up" only closes port 7), by hand or after a time; view Messages → Open. New ready-made rules: SSH and Windows failed logons, switch port down, UPS on battery',
    'Messages: what is kept - for all from a severity on (Receiving settings) and per sender its own filter (everything, warning and worse, error and worse … or muted); muted senders stay in the list with the number of dropped messages',
    'Filter Windows events by id (Receiving settings): only take some ids and/or never some (e.g. 8004 group policy, 4624/4634 logon and logoff); rules for ids not taken are refused, the rule list warns',
    'Umlauts: UTF-8 and the Windows code page mixed in one line are both read right ("NT-AUTORITÄT … für" instead of "… fÃ¼r")',
  ] },
  { version: '0.29.0', date: '2026-11-15', de: [
    'Meldungen nach Absender: je Rechner oder Gerät eine Zeile mit der letzten Meldung und den Meldungen, Warnungen und Fehlern der letzten 24 Stunden; ein Klick zeigt nur seine Meldungen, „Alle Meldungen“ wie bisher alles. Auf der Geräteseite: Mehr → Meldungen des Geräts',
    'Umlaute in Windows-Meldungen (NXLog in der Codepage von Windows) werden richtig gelesen: „NT-AUTORITÄT“ statt „NT-AUTORIT\uFFFDT“',
    'Diagnosepaket: neue Datei meldungen.json - Empfänger von Syslog und Traps (Ports, Fehler, Verbindungen), Platz der Meldungsdatei, Meldungen im Zeitraum nach Art, Schwere und NXLog-Format, Ereignisregeln mit Treffern, Wartenden und Fehlversuchen; Absender anonymisiert, Wörter der Regeln nur gezählt',
    'Meldungen: Anzahl und Platz stimmen sofort, sobald neue Meldungen kommen (zeigten bis zu einer Minute lang noch den alten Stand, nach dem Einschalten „0 gespeichert“ neben der Liste)',
  ], en: [
    'Messages by sender: one row per computer or device with the last message and the messages, warnings and errors of the last 24 hours; a click shows only its messages, "All messages" everything as before. On the device page: More → Messages of the device',
    'Umlauts in Windows messages (NXLog in the code page of Windows) are read right: "NT-AUTORITÄT" instead of "NT-AUTORIT\uFFFDT"',
    'Diagnostic package: new file meldungen.json - syslog and trap receivers (ports, errors, connections), space of the messages file, messages in the period by kind, severity and NXLog format, event rules with matches, waiting and failed attempts; senders anonymised, words of the rules only counted',
    'Messages: count and space are right as soon as new messages come (showed the old figures for up to a minute, after switching on "0 stored" next to the list)',
  ] },
  { version: '0.28.0', date: '2026-11-15', de: [
    'Meldungen in einer eigenen Datei (data/events.sqlite): die Datenbank und ihre täglichen Sicherungen bleiben klein; vorhandene Meldungen ziehen beim Update einmal um. Grenze jetzt in Speicherplatz statt 200 000 Stück: 30 Tage in höchstens 2 GB, bei knappem Datenträger bleiben mindestens 10 % frei. Die Seite zeigt belegten Platz, Meldungen am Tag, wie viele Tage der Platz reicht - und wer die meisten Meldungen schickt, wenn er nicht reicht',
  ], en: [
    'Messages in a file of their own (data/events.sqlite): the database and its daily backups stay small; existing messages move once with the update. The limit is now space instead of 200 000 pieces: 30 days in at most 2 GB, with a short disk at least 10 % stay free. The page shows the space used, messages a day, how many days the space lasts - and who sends the most when it does not',
  ] },
  { version: '0.27.0', date: '2026-11-15', de: [
    'NAS (gefunden im ersten echten Diagnosepaket): Antwortet ein beschäftigtes NAS nur halb, galten Platten, Volumes und Speicherpools für eine Abfrage als „nicht gefunden“ - nachts kamen so Dutzende Fehlalarme und Entwarnungen. Jetzt fragt WhatsOnMyNet die Tabellen nacheinander ab, erkennt unvollständige Antworten und behält fehlende Einträge bis zu zwei Abfragen lang',
    'Sensoren mit Grenze geben erst mit Abstand Entwarnung (2 °C bzw. 2 Prozentpunkte) - ein Fühler, der um seine Grenze pendelt, alarmiert nicht mehr alle 5 Minuten',
    'Proxmox: Fehlt ein Wert nur einmal, heißt es „gerade kein Wert (vom Host nicht geliefert)“ statt „dem Konto fehlen wohl Leserechte“ - das nur noch, wenn wirklich Rechte fehlen',
    'Diagnosepaket: auch der SMTP-Benutzername wird zum Platzhalter',
    'Jeder Monitor und Sensor zeigt „So wird geprüft“: was genau gefragt wird, woher die Werte kommen und wie alt sie sind, wann alarmiert wird (mit Abstand für die Entwarnung) und die letzte Antwort im Wortlaut',
    'Proxmox VE und Backup Server: Fehlgeschlagene Aufgaben zeigen die Fehlerzeilen aus dem Aufgabenprotokoll und einen verständlichen Namen statt „aptupdate“ oder „verificationjob“. Wartungsaufgaben sind gelb statt rot',
    'Paketlisten: Scheitert nur eine fremde Paketquelle (z. B. Webmin), ist das ein Hinweis und kein Fehler - Alarm gibt es nur, wenn eine offizielle Quelle von Proxmox oder Debian nicht klappt',
    'Neu: Cloud - AWS, Microsoft Azure und Google Cloud über ein Konto, das nur lesen darf: VMs mit den Prüfungen des Anbieters (Status-Checks, Resource Health) und geplanten Wartungen, Datenbanken (RDS, Azure SQL/PostgreSQL/MySQL, Cloud SQL), Load Balancer, die Alarme des Anbieters und auf Wunsch die Kosten des Monats - mit Sensoren. Fehlende Rechte werden genau benannt',
    'Neu: Meldungen der Geräte - WhatsOnMyNet empfängt SNMP-Traps (v1, v2c) und Syslog, ordnet sie dem Gerät zu und zeigt sie unter Überwachung → Meldungen. Mit „Überwachen“ wird aus einer Meldung ein Monitor, der sofort alarmiert, wenn sie wiederkommt. Aus, bis man es einschaltet; Ports 1162 und 1514 (Umleitung von 162/514 im Handbuch)',
    'Neue Prüfarten: Mailserver (SMTP, IMAP, POP3 - STARTTLS/TLS und Ablauf des Zertifikats, ohne Anmeldung), DNS-Auflösung an einem bestimmten Server mit erwarteter Antwort, LDAP/Active Directory (rootDSE, „Domänencontroller nicht synchronisiert“), Zeitserver (NTP: synchronisiert, Abweichung) und Microsoft SQL Server (Version, auch benannte Instanzen)',
    'Syslog auch über TCP (RFC 6587, Port 1514) und verschlüsselt über TLS (RFC 5425, Port 6514, mit dem Zertifikat dieses Servers) - Meldungen gehen nicht verloren und lassen sich nicht mitlesen; auch Zeilen ohne Syslog-Kopf wie von NXLog im Standardformat; einschalten unter Überwachung → Meldungen → Empfang einstellen',
    'Neu: Ereignisregeln - ausgewählte Meldungen gehen per Mail, Webhook oder ans Ticketsystem, getrennt von den Monitoren und nie an die Standard-Empfänger; fertige Regeln für Windows (Virenfund, Software-Einschränkung, AppLocker, gesperrtes Konto, Sicherheitsgruppe, gelöschtes Protokoll, neuer Dienst), einzeln mit Obergrenze je Stunde oder gesammelt, Test mit den Meldungen der letzten 7 Tage; nichts geht verloren, wenn ein Empfänger nicht erreichbar ist',
    'Windows-Ereignisse über NXLog: Ereignisnummer, Protokoll, Quelle und Konto werden erkannt und unter der Meldung gezeigt - ob NXLog im Standardformat, lesbar mit [Nummer] [Protokoll] oder als JSON schickt; die Suche findet eine Ereignisnummer',
    'Syslog über TCP/TLS: Eine einzelne zu lange Meldung wird übersprungen, statt die Verbindung zu beenden',
    'Neu: Prometheus und Grafana - /metrics mit dem Zustand aller Monitore und Sensoren (nur mit Schlüssel, nur lesend), Zertifikat zum Herunterladen für ca_file und ein fertiges Grafana-Dashboard (Einstellungen → Prometheus & Grafana)',
    'Neu: Eigene Prüfungen - Skripte im Ordner checks auf Windows- und Linux-Rechnern geben Zeilen im Checkmk-Format aus (OK/Warnung/kritisch/unbekannt), das Rechner-Skript schickt sie mit; Sensor „Eigene Prüfung …“. Gestartet wird nur, was niemand sonst ändern kann, je höchstens 30 Sekunden. Rechner-Skript dafür neu ausrollen',
    'Neu: Veeam Backup & Replication (ab 12) - Jobs mit letztem Ergebnis, letztem und nächstem Lauf, Repositories mit Platz; Sensoren für Fehler und Warnungen, zu lange nicht gelaufene Jobs und volle Repositories. Konto mit der Rolle „Veeam Backup Viewer“',
    'Neu: Microsoft 365 - Zustand der Dienste, offene Störungen, Abonnements und freie Lizenzen über Microsoft Graph (nur Leserechte); Alarm, wenn ein Dienst gestört ist oder ein Abonnement ausläuft',
    'Switches: Auslastung jedes Ports (ein/aus in Mbit/s und Prozent) aus den Byte-Zählern, mit Sensor „Auslastung Port …“ (Alarm ab 80 %) - kein Wert statt eines falschen nach einem Neustart des Switches',
    'Deutsche Meldungen: Prozentwerte jetzt mit Komma (85,5 % statt 85.5 %)',
  ], en: [
    'NAS (found in the first real diagnostic package): when a busy NAS answered only halfway, disks, volumes and storage pools counted as "not found" for one poll - at night that gave dozens of false alarms and all-clears. Now WhatsOnMyNet reads the tables one after the other, recognises incomplete answers and keeps missing entries for up to two polls',
    'Sensors with a limit only give the all-clear with a margin (2 °C or 2 percentage points) - a sensor swinging around its limit no longer alarms every 5 minutes',
    'Proxmox: a value missing for once now says "no value at the moment (not delivered by the host)" instead of "the account probably lacks read rights" - that only when rights are really missing',
    'Diagnostic package: the SMTP user name becomes a placeholder too',
    'Every monitor and sensor shows "How it is checked": what exactly is asked, where the values come from and how old they are, when it alarms (with the margin for the all-clear) and the last answer word for word',
    'Proxmox VE and Backup Server: failed tasks show the error lines from the task log and a plain name instead of "aptupdate" or "verificationjob". Upkeep tasks are yellow instead of red',
    'Package lists: when only a third-party repository fails (e.g. Webmin), that is a note, not an error - it alarms only when an official Proxmox or Debian repository fails',
    'New: cloud - AWS, Microsoft Azure and Google Cloud through an account that may only read: VMs with the checks of the provider (status checks, Resource Health) and scheduled maintenance, databases (RDS, Azure SQL/PostgreSQL/MySQL, Cloud SQL), load balancers, the alarms of the provider and, if wanted, the costs of the month - with sensors. Missing rights are named exactly',
    'New: messages of the devices - WhatsOnMyNet receives SNMP traps (v1, v2c) and syslog, matches them to the device and shows them under Monitoring → Messages. "Watch" turns a message into a monitor that alarms at once when it comes again. Off until switched on; ports 1162 and 1514 (redirect from 162/514 in the manual)',
    'New kinds of checks: mail servers (SMTP, IMAP, POP3 - STARTTLS/TLS and certificate expiry, without signing in), DNS resolution at a given server with an expected answer, LDAP/Active Directory (rootDSE, "domain controller not synchronized"), time servers (NTP: synchronized, offset) and Microsoft SQL Server (version, named instances too)',
    'Syslog also over TCP (RFC 6587, port 1514) and encrypted over TLS (RFC 5425, port 6514, with the certificate of this server) - messages are not lost and cannot be read on the way; lines without a syslog header too, like NXLog in its default format; switch on under Monitoring → Messages → Receiving settings',
    'New: event rules - chosen messages go by mail, webhook or to the ticket system, apart from the monitors and never to the default recipients; ready-made rules for Windows (virus found, software restriction, AppLocker, locked account, security group, cleared log, new service), one by one with a limit per hour or collected, test with the messages of the last 7 days; nothing is lost when a recipient cannot be reached',
    'Windows events through NXLog: event id, log, source and account are recognised and shown below the message - whether NXLog sends its default format, readable with [id] [log] or JSON; the search finds an event id',
    'Syslog over TCP/TLS: a single message that is too long is skipped instead of ending the connection',
    'New: Prometheus and Grafana - /metrics with the state of all monitors and sensors (only with a key, read only), the certificate to download for ca_file and a ready-made Grafana dashboard (Settings → Prometheus & Grafana)',
    'New: own checks - scripts in the checks folder of Windows and Linux machines print lines in the Checkmk format (OK/warning/critical/unknown), the machine script sends them along; sensor "Own check …". Only files nobody else can change are started, each for at most 30 seconds. Roll out the machine script again for this',
    'New: Veeam Backup & Replication (12 or newer) - jobs with last result, last and next run, repositories with space; sensors for errors and warnings, jobs that have not run for too long and full repositories. Account with the role "Veeam Backup Viewer"',
    'New: Microsoft 365 - service health, open incidents, subscriptions and free licences through Microsoft Graph (read permissions only); alarm when a service is degraded or a subscription runs out',
    'Switches: load of every port (in/out in Mbit/s and percent) from the byte counters, with the sensor "Load port …" (alarm from 80 %) - no value rather than a wrong one after a restart of the switch',
    'German messages: percent values now with a decimal comma (85,5 % instead of 85.5 %)',
  ] },
  { version: '0.26.0', date: '2026-11-15', de: [
    'Ausfallsicherung: Auf dem Standby lässt sich nichts mehr verstellen - keine Kanäle, E-Mail, Webhooks, Einstellungen, Benutzer, Hypervisoren oder Berichte, auch nicht, während er für den Master überwacht. Die Seiten zeigen nur an und sagen warum. Erlaubt bleiben die Steuerung der Ausfallsicherung (Entkoppeln, zum Master machen, Wartezeit) und Hell/Dunkel und Sprache des eigenen Kontos',
  ], en: [
    'Failover: nothing can be changed on the standby any more - no channels, e-mail, webhooks, settings, users, hypervisors or reports, also not while it monitors in place of the master. The pages only show and say why. Still possible: the failover controls (unpair, make master, waiting time) and light/dark and language of one\'s own account',
  ] },
  { version: '0.25.0', date: '2026-11-14', de: [
    'Benachrichtigungen: Anzeigename (Absender) pro Kanal - steht über jeder Meldung, damit man sieht, woher sie kommt; bei E-Mail als Absendername und im Betreff, bei ntfy, Gotify, Pushover & Co. als Titel, bei Discord und Mattermost als Name des Bots, im Webhook als „sender“',
    'Ausfälle in der Verlaufsgrafik: Bei Gründen ohne Doppelpunkt fehlte der erste Buchstabe („onnection refused“) - jetzt steht der Grund vollständig da',
    'Handbuch, Hilfe und Projektseite: alle Bilder im neuen, hellen Aussehen',
  ], en: [
    'Notifications: display name (sender) per channel - shown above every message so one sees where it comes from; for e-mail as the sender name and in the subject, for ntfy, Gotify, Pushover & co. as the title, for Discord and Mattermost as the bot name, in the webhook as "sender"',
    'Outages in the history chart: reasons without a colon lost their first letter ("onnection refused") - now the reason is shown in full',
    'Manual, help and project page: all pictures in the new, light look',
  ] },
  { version: '0.24.0', date: '2026-11-14', de: [
    'Neues Aussehen: ruhiger und heller im Stil einer Mac-App - Systemschrift (San Francisco auf dem Mac, sonst Inter), weiche Flächen, abgerundete Schaltflächen, Reiter als Segmente, durchscheinende Seitenleiste; die Anmeldeseite mit dem Radar auf tiefem Blau',
    'Hell ist jetzt der Standard. Dunkel oder „Wie das System“ stellt jeder unter Mein Konto → Darstellung um; Konten, die noch auf dem alten Standard „Wie das System“ standen, sind jetzt hell',
  ], en: [
    'New look: calmer and lighter in the style of a Mac app - system font (San Francisco on a Mac, Inter elsewhere), soft surfaces, rounded buttons, tabs as segments, a translucent sidebar; the sign-in page with the radar on deep blue',
    'Light is the default now. Everyone switches to dark or "like the system" under My account → Appearance; accounts still on the old default "like the system" are light now',
  ] },
  { version: '0.23.0', date: '2026-11-14', de: [
    'Tipp „Per Skript überwachen“ jetzt auch bei Linux-Rechnern und Hypervisoren wie Proxmox (bisher vor allem Windows) und unter Virtualisierung bei Proxmox-Knoten ohne Skript - freundlich formuliert: zusätzliche Infos über das System. Er verschwindet von selbst, sobald das Gerät Werte liefert (Skript oder iDRAC/iLO), und lässt sich pro Gerät mit „Nicht mehr anzeigen“ ausblenden',
    'Skript-Dialoge und Tipp: Link „Was bringt das Skript?“ direkt zum passenden Abschnitt der Hilfe; Hilfe und Handbuch erklären ausführlicher, wofür das Skript gut ist (gerade bei Mini-PCs ohne Server-Hardware)',
  ], en: [
    'Tip "Monitor with script" now also for Linux machines and hypervisors such as Proxmox (so far mainly Windows), and under Virtualisation for Proxmox nodes without the script - in friendly words: additional information about the system. It disappears by itself once the device delivers values (script or iDRAC/iLO) and can be hidden per device with "Do not show again"',
    'Script dialogs and tip: link "What does the script bring?" straight to the matching section of the help; help and manual explain in more detail what the script is good for (especially on mini PCs without server hardware)',
  ] },
  { version: '0.22.0', date: '2026-11-14', de: [
    'Mehrere Sensoren oder Monitore ankreuzen und löschen: nach dem Bestätigen passierte nichts - jetzt werden sie gelöscht. Ebenso das Einspielen einer hochgeladenen Sicherung',
    'Neue NAS: Sensoren nur auf den Datenvolumes (/volume1 …), nicht auf der Systempartition (/, /opt) oder internen Ordnern wie /volume1/@docker',
    'USV: die Restlaufzeit unter einer Stunde in Minuten („reicht 25 Min.“ statt „reicht 0 Std.“)',
    'Diagnosepaket (Einstellungen → Diagnose): ein ZIP für die Fehlersuche mit Protokoll, Warnungen und Fehlern, Monitoren, Sensoren, Geräten mit ihren Werten, Hypervisoren, Scans und Einstellungen - für 1 bis 30 Tage oder seit dem letzten Update. Standardmäßig anonymisiert mit Platzhaltern, die in jedem Paket gleich bleiben und sich nachschlagen lassen; nie mit Kennwörtern oder Schlüsseln, nichts wird verschickt. Das Programm bewahrt sein Protokoll dafür 30 Tage auf',
    'Hilfe, Handbuch und Projektbeschreibung: Ping in einem Proxmox-LXC freischalten (ping_group_range im LXC setzen, Schritt für Schritt); der Hinweis beim Scan zeigt dorthin',
    'Nichts doppelt: Einen Monitor oder Sensor für etwas, das schon überwacht wird, gibt es kein zweites Mal (Hinweis mit dem Namen des vorhandenen) - Rechnername und IP desselben Geräts gelten als dasselbe Ziel, mehrere Dienste eines Servers bleiben möglich. Schon vorhandene Doppelte werden nach dem Update einmal zusammengelegt (der laufende bleibt)',
    'Scan: Ein gefundenes Gerät, das vermutlich schon im Inventar ist (gleicher Rechnername, z. B. zweite Netzwerkkarte, oder gleiche IP mit anderer MAC), steht mit Tipp in der Liste und wird beim Übernehmen übersprungen - „Diesem Gerät zuordnen“ oder „Trotzdem als neues Gerät“',
    'Inventar: Geräte, die vermutlich doppelt drin sind, stehen oben als Hinweis und lassen sich zusammenführen (Monitore, Sensoren, Verlauf und Werte gehen mit)',
    'Windows- und Linux-Rechner ohne Skript: Tipp auf der Geräteseite „Per Skript überwachen“ (CPU, RAM, Laufwerke, Dienste, Updates); auch nach dem Übernehmen aus dem Scan',
  ], en: [
    'Tick several sensors or monitors and delete them: nothing happened after confirming - now they are deleted. The same for restoring an uploaded backup',
    'New NAS: sensors only on the data volumes (/volume1 …), not on the system partition (/, /opt) or internal folders such as /volume1/@docker',
    'UPS: runtime left under an hour in minutes ("lasts 25 min" instead of "lasts 0 h")',
    'Diagnostic package (Settings → Diagnostics): a ZIP for troubleshooting with log, warnings and errors, monitors, sensors, devices with their values, hypervisors, scans and settings - for 1 to 30 days or since the last update. Anonymised by default with placeholders that stay the same in every package and can be looked up; never with passwords or keys, nothing is sent anywhere. For it the program keeps its log for 30 days',
    'Help, manual and project description: allowing ping in a Proxmox LXC (set ping_group_range inside the LXC, step by step); the notice of the scan points there',
    'Nothing twice: a monitor or sensor for something watched already is refused (with the name of the existing one) - host name and IP of the same device count as the same target, several services of one server stay possible. Duplicates from before are merged once after the update (the running one stays)',
    'Scan: a device found that is probably in the inventory already (same host name, e.g. a second network card, or same IP with another MAC) is listed with a tip and skipped when adopting - "Assign to this device" or "Add as new device anyway"',
    'Inventory: devices that are probably in it twice are shown at the top and can be merged (monitors, sensors, history and values go along)',
    'Windows and Linux machines without script: tip on the device page "Monitor with script" (CPU, RAM, drives, services, updates); also after adopting from the scan',
  ] },
  { version: '0.21.0', date: '2026-11-14', de: [
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
