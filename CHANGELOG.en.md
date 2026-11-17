# Changelog

What changed in WhatsOnMyNet - the same texts the program shows under *About WhatsOnMyNet* (click on the version number at the bottom left). Deutsch: [CHANGELOG.md](CHANGELOG.md)

<!-- generated from public/js/changelog.js by tools/changelog.mjs - do not edit here -->

## Next version (not released yet)

- Windows script: when WhatsOnMyNet refused a report (e.g. key no longer valid) or could not be reached, the script wrote a warning 4100 to the PowerShell log on every run - fixed. The answer is now in womn-host-send.json next to the script, the scheduled task ends with result 2. Tested on real Windows (Server 2022 and 2025). The same goes for the Hyper-V script
- Windows scripts with a version number: in the first line, in the registry under HKLM\SOFTWARE\WhatsOnMyNet (HostScript or HyperVScript) to filter on in software distribution, and in the report - the device page marks machines with an older script as "outdated". The number only changes when the script changes. For this, roll out the script once more
- Storage pools: ZFS and Ceph from Proxmox (state, failed disks/OSDs, usage, last scrub), ZFS and software RAID (mdadm) in the Linux script, Storage Spaces in the Windows script - with sensors for state, usage, days since the scrub and failed members
- New: TrueNAS (25.04 or newer, WebSocket API, API key of a user with "Read-Only Administrator") - pools, alerts of TrueNAS, replications; and Ceph without Proxmox through the Ceph dashboard (user with role "read-only")
- Diagnostic package: storage pools, TrueNAS alerts and replications, and the version of the Windows script per machine (anonymised)
- Scanning only on request: on a new installation the nightly scan is off - WhatsOnMyNet scans nothing on its own. The page "Scan network" says so and offers administrators "Switch the nightly scan on"; switching it on or off is logged. Existing installations keep their setting
- Messages: leaving out per source - "1@Ntfs" no longer takes 1 of NTFS, but still 1 of Sysmon. "What takes the space?" shows a number of several sources in rows of their own, "Do not keep" takes the source along
- Copy for AI: events already left out are not asked again; the source is given per event, and the AI names numbers for one source as ID@source

## 0.41.0 - 2026-11-17

- Messages: the timeline without a search term, the overview "By sender" and the space page are there at once with millions of messages too - they read counts per minute and hour instead of every message (with 2 million messages about 10 milliseconds instead of 1 to 2 seconds). The figures stay exact. After the update an existing messages file is counted in the background
- Messages: "What takes the space?" shows which Windows events and senders send the most messages - with share, amount a day, estimated space, an example and hints (a rule needs it, usually important, usual noise). Admins leave an event out with one click; not one a rule needs. "Copy for AI" turns it into a question for an AI chat, with placeholders instead of names, addresses and accounts
- Messages: old messages go in pieces instead of all at once - a big day to remove no longer holds up the receiving

## 0.40.0 - 2026-11-17

- Messages: saved searches - under "Saved" keep search term, severity, kind and time range under a name and set them again with one click, for yourself or visible to everyone
- Windows script on Windows Server: it asked the Security Center, which only client Windows have (with another virus protection the Defender part is missing too) - the caught error still landed in the PowerShell log as warning 4100 "Invalid namespace" on every run. Now the script looks first whether the part is there. The automatic test now runs on Windows Server 2022 and 2025 and checks missing parts too

## 0.39.0 - 2026-11-16

- Messages: the search takes several terms - all must be there, in any order and any field: "PC-0001 4104 svc-pocketknife" finds the events 4104 of PC-0001 with svc-pocketknife in the text. "In quotes" is a fixed sequence of words, a minus leaves out ("4625 -svc-backup"). Before, several words counted as one sequence
- Windows script: on its first run (and until the first search for Windows updates) it wrote a warning 4100 to the PowerShell log, because it tried to read a status file not there yet - fixed. The script is now tested automatically on a real Windows with every change: set up by hand once, then run as scheduled task under SYSTEM, with script block logging on - any warning or error in the PowerShell log fails the test
- Failover: if master and standby run different versions for half an hour, the standby sends a reminder to the default channels - saying which server to bring to which version (again every 7 days while it stays so). If the standby cannot take the data any more because of the database version, the message comes at once, urgent and daily. When both are the same again, it says so once. The difference also shows under Settings → Failover, on the standby in the bar at the top too
- Messages: fast search in many gigabytes too - a search index finds whole words and beginnings of words ("m.muster", "link down", "print" for printer), upper/lower case and umlauts alike, over 30 or 90 days in a fraction of a second. Parts in the middle of a word (e.g. "006A" of 0xC000006A) on request: "Search parts of words too". After the update the index for the stored messages is built once in the background (about half a minute per million), you can search all the time
- About space: the search index takes about a quarter of the messages file. When the file is at its limit, the oldest messages go correspondingly earlier - to keep as many days, set a third more space under Receiving settings. The table in the manual now reckons with 2 KB per message

## 0.38.0 - 2026-11-16

- Messages: time range and timeline as in Splunk or Wazuh - last 15 minutes to 30 days or a custom range; above the list a timeline counts the hits per step of time (errors, warnings, the rest). Search for an event, then click a bar or drag across several: list and timeline narrow to it, "Back" goes one step back. A click on the time of a message shows what else came in the 5 minutes before and after

## 0.37.0 - 2026-11-16

- Backup: the number of backups kept is now set where the backups are - under Settings → Backup → Retention (default 10). It applies to the copies before an update and before a restore as well; saving deletes the ones over it at once. Single backups can be deleted in the list (with a question first)
- Settings tidied: "two-factor sign-in mandatory for administrators" is now with the users (section Sign-in), General keeps the name of the installation
- Manual and README: how much space do the messages need? - formula, values per sender and typical setups with recommended settings

## 0.36.0 - 2026-11-16

- Failed logons (4625): the ready-made rule counts without the computer's own service logons and without "no logon server reachable" (laptop starting before its VPN) - neither is an attack. A rule made that way gets the exceptions with the update, one changed by hand stays
- Windows sign-in events (4625, 4740, 4771, 4776): notifications and the message list show a summary instead of the cut start of the text - account, logon type, reason and origin
- Message texts are kept up to 4000 instead of 1000 characters, so long Windows events are complete; the list shows them shortened with "whole text". The NXLog example in the manual sends each message in one piece

## 0.35.0 - 2026-11-16

- Event rules and reports: a switch in the list shows at a glance whether a rule or report is active and turns it on or off with one click - without opening it

## 0.34.0 - 2026-11-16

- Event rules: new ready-made rules - new scheduled task (4698), user account created (4720), Defender real-time protection turned off (5001), PowerShell: suspicious script (4104, warnings only) and error of a command (4100); "log cleared" now also covers the system log (104). The manual says which auditing Windows needs for them

## 0.33.5 - 2026-11-16

- Windows script of the machines: no more "System error" (event 4100, warning) on every run - the cause was "Select-Object -First" (first network address, Defender status, the first 10 events): Windows PowerShell stops the query before it that way and logs it as system error. The first entries are now taken by index, the values stay the same. Takes effect after New script and distributing it again

## 0.33.4 - 2026-11-16

- Windows and Hyper-V script: no progress bar when reporting to WhatsOnMyNet (under the scheduled task there is no window for it)

## 0.33.3 - 2026-11-16

- Windows and Hyper-V script: Windows logged every run as a "suspicious" script block (event 4104, warning) - because of the built-in C# code for the pinned certificate and "-ExecutionPolicy Bypass". The certificate is now checked by PowerShell itself (just as strict: exactly this key or this certificate), the scheduled task runs under RemoteSigned. Takes effect after New script and distributing it again

## 0.33.2 - 2026-11-15

- Windows scripts of the machines: setting up again took all rights from the existing copy in C:\ProgramData\WhatsOnMyNet - afterwards not even SYSTEM could get at it ("access denied"). The rights are now set on the folder only, existing files inherit them again (also ones damaged that way), and nobody but SYSTEM and administrators has access to the folder

## 0.33.1 - 2026-11-15

- Windows scripts of the machines: setting up again (new script, update) failed with "access denied" when the old copy was read-only - for example because the setup file came from a package folder or a share. Now the read-only flag is cleared, a running report ended and it is tried several times; the new copy is never left read-only

## 0.33.0 - 2026-11-15

- Windows script of the machines: reads network cards, disks, Defender and firewall straight from WMI instead of through the PowerShell modules - with script block logging on, a run no longer leaves some 70 "suspicious" events 4104 but only a few "verbose" ones. Same values; takes effect after New script under Settings → Machine scripts and running or distributing it again

## 0.32.0 - 2026-11-15

- Database backups are kept compressed on the server (.sqlite.gz, mostly a fraction of the size); default now 10 instead of 7 (who had 7 set now has 10). Existing backups are compressed once, copies before updates and before a restore no longer pile up (the 10 newest each). Restoring takes .sqlite and .sqlite.gz
- Windows events: new installations do not take the usual noise at all (logons/logoffs, process start, object access, firewall connections, service state 7036, DCOM 10016, WMI 5858 …); existing ones keep their list and can add to it under Receiving settings with "Add the usual noise". Failed logons, account lockouts and the ready-made rules are not touched

## 0.31.0 - 2026-11-15

- Look: the default is "like the system" again - light or dark as the computer or phone is set; accounts on "light" were switched over, an own choice stays possible under My account

## 0.30.0 - 2026-11-15

- Event console: rules count ("from 5 matches in 10 minutes", per sender if wanted), check regular expressions (checked for dangerous shapes and speed before saving, a rule too slow while running switches itself off) and keep open events: the first match notifies, further ones only count up; acknowledge, close by the counter-message (e.g. "Port 7 link up" only closes port 7), by hand or after a time; view Messages → Open. New ready-made rules: SSH and Windows failed logons, switch port down, UPS on battery
- Messages: what is kept - for all from a severity on (Receiving settings) and per sender its own filter (everything, warning and worse, error and worse … or muted); muted senders stay in the list with the number of dropped messages
- Filter Windows events by id (Receiving settings): only take some ids and/or never some (e.g. 8004 group policy, 4624/4634 logon and logoff); rules for ids not taken are refused, the rule list warns
- Umlauts: UTF-8 and the Windows code page mixed in one line are both read right ("NT-AUTORITÄT … für" instead of "… fÃ¼r")

## 0.29.0 - 2026-11-15

- Messages by sender: one row per computer or device with the last message and the messages, warnings and errors of the last 24 hours; a click shows only its messages, "All messages" everything as before. On the device page: More → Messages of the device
- Umlauts in Windows messages (NXLog in the code page of Windows) are read right: "NT-AUTORITÄT" instead of "NT-AUTORIT�T"
- Diagnostic package: new file meldungen.json - syslog and trap receivers (ports, errors, connections), space of the messages file, messages in the period by kind, severity and NXLog format, event rules with matches, waiting and failed attempts; senders anonymised, words of the rules only counted
- Messages: count and space are right as soon as new messages come (showed the old figures for up to a minute, after switching on "0 stored" next to the list)

## 0.28.0 - 2026-11-15

- Messages in a file of their own (data/events.sqlite): the database and its daily backups stay small; existing messages move once with the update. The limit is now space instead of 200 000 pieces: 30 days in at most 2 GB, with a short disk at least 10 % stay free. The page shows the space used, messages a day, how many days the space lasts - and who sends the most when it does not

## 0.27.0 - 2026-11-15

- NAS (found in the first real diagnostic package): when a busy NAS answered only halfway, disks, volumes and storage pools counted as "not found" for one poll - at night that gave dozens of false alarms and all-clears. Now WhatsOnMyNet reads the tables one after the other, recognises incomplete answers and keeps missing entries for up to two polls
- Sensors with a limit only give the all-clear with a margin (2 °C or 2 percentage points) - a sensor swinging around its limit no longer alarms every 5 minutes
- Proxmox: a value missing for once now says "no value at the moment (not delivered by the host)" instead of "the account probably lacks read rights" - that only when rights are really missing
- Diagnostic package: the SMTP user name becomes a placeholder too
- Every monitor and sensor shows "How it is checked": what exactly is asked, where the values come from and how old they are, when it alarms (with the margin for the all-clear) and the last answer word for word
- Proxmox VE and Backup Server: failed tasks show the error lines from the task log and a plain name instead of "aptupdate" or "verificationjob". Upkeep tasks are yellow instead of red
- Package lists: when only a third-party repository fails (e.g. Webmin), that is a note, not an error - it alarms only when an official Proxmox or Debian repository fails
- New: cloud - AWS, Microsoft Azure and Google Cloud through an account that may only read: VMs with the checks of the provider (status checks, Resource Health) and scheduled maintenance, databases (RDS, Azure SQL/PostgreSQL/MySQL, Cloud SQL), load balancers, the alarms of the provider and, if wanted, the costs of the month - with sensors. Missing rights are named exactly
- New: messages of the devices - WhatsOnMyNet receives SNMP traps (v1, v2c) and syslog, matches them to the device and shows them under Monitoring → Messages. "Watch" turns a message into a monitor that alarms at once when it comes again. Off until switched on; ports 1162 and 1514 (redirect from 162/514 in the manual)
- New kinds of checks: mail servers (SMTP, IMAP, POP3 - STARTTLS/TLS and certificate expiry, without signing in), DNS resolution at a given server with an expected answer, LDAP/Active Directory (rootDSE, "domain controller not synchronized"), time servers (NTP: synchronized, offset) and Microsoft SQL Server (version, named instances too)
- Syslog also over TCP (RFC 6587, port 1514) and encrypted over TLS (RFC 5425, port 6514, with the certificate of this server) - messages are not lost and cannot be read on the way; lines without a syslog header too, like NXLog in its default format; switch on under Monitoring → Messages → Receiving settings
- New: event rules - chosen messages go by mail, webhook or to the ticket system, apart from the monitors and never to the default recipients; ready-made rules for Windows (virus found, software restriction, AppLocker, locked account, security group, cleared log, new service), one by one with a limit per hour or collected, test with the messages of the last 7 days; nothing is lost when a recipient cannot be reached
- Windows events through NXLog: event id, log, source and account are recognised and shown below the message - whether NXLog sends its default format, readable with [id] [log] or JSON; the search finds an event id
- Syslog over TCP/TLS: a single message that is too long is skipped instead of ending the connection
- New: Prometheus and Grafana - /metrics with the state of all monitors and sensors (only with a key, read only), the certificate to download for ca_file and a ready-made Grafana dashboard (Settings → Prometheus & Grafana)
- New: own checks - scripts in the checks folder of Windows and Linux machines print lines in the Checkmk format (OK/warning/critical/unknown), the machine script sends them along; sensor "Own check …". Only files nobody else can change are started, each for at most 30 seconds. Roll out the machine script again for this
- New: Veeam Backup & Replication (12 or newer) - jobs with last result, last and next run, repositories with space; sensors for errors and warnings, jobs that have not run for too long and full repositories. Account with the role "Veeam Backup Viewer"
- New: Microsoft 365 - service health, open incidents, subscriptions and free licences through Microsoft Graph (read permissions only); alarm when a service is degraded or a subscription runs out
- Switches: load of every port (in/out in Mbit/s and percent) from the byte counters, with the sensor "Load port …" (alarm from 80 %) - no value rather than a wrong one after a restart of the switch
- German messages: percent values now with a decimal comma (85,5 % instead of 85.5 %)

## 0.26.0 - 2026-11-15

- Failover: nothing can be changed on the standby any more - no channels, e-mail, webhooks, settings, users, hypervisors or reports, also not while it monitors in place of the master. The pages only show and say why. Still possible: the failover controls (unpair, make master, waiting time) and light/dark and language of one's own account

## 0.25.0 - 2026-11-14

- Notifications: display name (sender) per channel - shown above every message so one sees where it comes from; for e-mail as the sender name and in the subject, for ntfy, Gotify, Pushover & co. as the title, for Discord and Mattermost as the bot name, in the webhook as "sender"
- Outages in the history chart: reasons without a colon lost their first letter ("onnection refused") - now the reason is shown in full
- Manual, help and project page: all pictures in the new, light look

## 0.24.0 - 2026-11-14

- New look: calmer and lighter in the style of a Mac app - system font (San Francisco on a Mac, Inter elsewhere), soft surfaces, rounded buttons, tabs as segments, a translucent sidebar; the sign-in page with the radar on deep blue
- Light is the default now. Everyone switches to dark or "like the system" under My account → Appearance; accounts still on the old default "like the system" are light now

## 0.23.0 - 2026-11-14

- Tip "Monitor with script" now also for Linux machines and hypervisors such as Proxmox (so far mainly Windows), and under Virtualisation for Proxmox nodes without the script - in friendly words: additional information about the system. It disappears by itself once the device delivers values (script or iDRAC/iLO) and can be hidden per device with "Do not show again"
- Script dialogs and tip: link "What does the script bring?" straight to the matching section of the help; help and manual explain in more detail what the script is good for (especially on mini PCs without server hardware)

## 0.22.0 - 2026-11-14

- Tick several sensors or monitors and delete them: nothing happened after confirming - now they are deleted. The same for restoring an uploaded backup
- New NAS: sensors only on the data volumes (/volume1 …), not on the system partition (/, /opt) or internal folders such as /volume1/@docker
- UPS: runtime left under an hour in minutes ("lasts 25 min" instead of "lasts 0 h")
- Diagnostic package (Settings → Diagnostics): a ZIP for troubleshooting with log, warnings and errors, monitors, sensors, devices with their values, hypervisors, scans and settings - for 1 to 30 days or since the last update. Anonymised by default with placeholders that stay the same in every package and can be looked up; never with passwords or keys, nothing is sent anywhere. For it the program keeps its log for 30 days
- Help, manual and project description: allowing ping in a Proxmox LXC (set ping_group_range inside the LXC, step by step); the notice of the scan points there
- Nothing twice: a monitor or sensor for something watched already is refused (with the name of the existing one) - host name and IP of the same device count as the same target, several services of one server stay possible. Duplicates from before are merged once after the update (the running one stays)
- Scan: a device found that is probably in the inventory already (same host name, e.g. a second network card, or same IP with another MAC) is listed with a tip and skipped when adopting - "Assign to this device" or "Add as new device anyway"
- Inventory: devices that are probably in it twice are shown at the top and can be merged (monitors, sensors, history and values go along)
- Windows and Linux machines without script: tip on the device page "Monitor with script" (CPU, RAM, drives, services, updates); also after adopting from the scan

## 0.21.0 - 2026-11-14

- Watched right away: adopted or newly added devices get a monitor at once (web interface, else ping) and, as soon as they deliver values, a few important sensors - toner for printers, volumes, RAID and temperature for a NAS, CPU, RAM, system drive, temperature and services for machines with the script, nodes, storage and backups for hypervisors. Can be switched off under Settings → Notifications
- New pictures in the project description and the manual: chart with outages, sensor with limit, sensors, failover; "At a glance" overview
- Changelog also as a file in the project (CHANGELOG.md, English CHANGELOG.en.md) and as the text of every release on GitHub - the same texts as here

## 0.20.0 - 2026-11-14

- Failover (Settings → Failover): a second WhatsOnMyNet as standby. Pair it with address and code of the master; the standby takes a sign of life every minute and the data every 5 minutes, does not alarm itself and only shows. When the master does not answer for longer than set (10 minutes by default), the standby monitors and alarms; when the master is back, it hands back and takes its data. "Make this the master" for when the old one does not come back

## 0.19.0 - 2026-11-14

- Chart of a monitor or sensor: outages with a red background with start, end and length, listed below with their reason; summary (how often, how long); crosshair with time and value when pointing; for sensors the alarm limit as a line; time axis with hours and days, readable on a phone too
- Coffee button under "About WhatsOnMyNet" like the official Buy Me a Coffee button (yellow, cup logo, "Buy me a coffee"); the logo also small in the menu - all shipped with the program, nothing is loaded from the internet

## 0.18.0 - 2026-11-14

- Monitoring: tick several monitors or sensors (also "all shown") and edit them together - check interval, failed checks, time limit, repeat, escalation and channels, for sensors also condition and limit; only filled-in fields change. Pause, resume and delete work for all of them at once as well

## 0.17.0 - 2026-11-14

- Add sensor: values another sensor already watches are not offered again (also not through the hypervisor when the Linux script delivers the same value)
- Dialogs: Enter saves, errors are shown at the field concerned; settings on phones as a selection list
- Host name: typed by hand it stays - the scan only fills it while it is empty or came from the scan (also for names typed by hand before the update)
- Monitors with a stored password are paused when their device gets a new IP and show "device has a new IP - please enter the password again"; with a new password they continue at the new address. The notification channels of the monitor are told; when the device returns to the old address, it runs again by itself
- Adopt and ignore only from the newest scan of a subnet (older scans stay readable, "stop ignoring" still works); "maintenance" is shown from the start of the window
- Scan: only administrators may scan public networks; the deep check first asks port 4742 for unknown devices and checks card terminals gently only
- Security: CSV export also neutralises formulas after a comma; the backup for download is stored in the data folder, readable for WhatsOnMyNet only
- Code audit - security: HSTS never with an uploaded certificate that is self-signed; an uploaded certificate is no longer replaced by a generated one (not even with missing metadata or a renewal at the same time); additional protective browser headers
- Code audit - security: AD can no longer demote the last administrator; after a restore everyone signs in again; the list of ignored devices shows location-restricted accounts only their locations
- Code audit - stability: a Proxmox token with invalid characters can no longer stop the server (refused when saving); a broken timestamp in the Linux script no longer discards the whole report
- Code audit - inventory: a host script with the shared key never lands on a device with another MAC; monitors of all kinds follow the device to a new IP (also when changed by hand; with a stored password they stay at the old address); no duplicate devices without MAC when adopting; adopting from an older scan no longer shows the device online by mistake; web link no longer garbled on IP change; renaming only changes the device name at the start of monitor names; type change clears old SNMP messages; Redfish no longer turns a hypervisor into a server
- Code audit - scan: HPE devices (iLO, Aruba) are no longer taken for printers, Samsung/LG TVs and Dahua/Uniview cameras recognised; cancel acts at once; overlapping subnets are scanned once; the night scan also catches up after midnight; agent scans are cleaned up
- Code audit - alarms: an outage lasting beyond a maintenance window is not reported twice, and the all-clear states the full duration
- Usability: no duplicates when clicking save several times; error messages visible in dialogs; phone view without sideways scrolling; viewers and editors get fitting hints; port names without English terms in German; language switch on the sign-in/setup page keeps the input; better keyboard and screen reader support (skip link, menu, labels)

## 0.16.0 - 2026-11-13

- Edit sensor: choosing another value gives the sensor its name (e.g. "pve2: Temperature: NVMe nvme0 Sensor 2") - unless the name is changed in the dialog itself
- Once with the update: all sensors are named after their value, so old names like "Temperatur pve2" are right again after the value was changed

## 0.15.0 - 2026-11-13

- One dialog for all sensors: whether from the device in the inventory or from the host under Virtualization - a Proxmox node shows the same list with the values of Proxmox and those of the Linux script (every temperature, disks, services). Values both deliver (CPU, RAM, highest temperature) only once. Under Virtualization grouped by node. Existing sensors can be switched to any value of the list when editing

## 0.14.1 - 2026-11-13

- Add sensor: every temperature, disk and certificate is listed by name (e.g. "Temperature: NVMe nvme0 Sensor 2") instead of "Temperature" many times; with many values grouped by area
- Coffee button under "About WhatsOnMyNet" in yellow so it stands out

## 0.14.0 - 2026-11-13

- Alarms say what is going on: for measured values "limit exceeded - 83.9 °C (≥ 80)" and "back in the normal range", for states "fault"/"fine again", without values "no current values" - "down" only for web page, port and ping
- Sensors have their own menu entry under Monitoring (monitors - sensors - maintenance windows)
- Maintenance windows: choice by monitors and sensors, grouped per device or hypervisor, with search and "whole device"; on the page of each monitor/sensor "times without alarm" with "time window without alarm" for just this one

## 0.13.0 - 2026-11-13

- Proxmox VE cluster: entering one node is enough - WhatsOnMyNet gets the addresses and certificates of the other nodes from the cluster itself. If the entered node does not answer, the next one is asked (with the same token, certificate checked); the virtualisation page shows which node was read through

## 0.12.0 - 2026-11-13

- Sensor "Temperature" right at the Proxmox node (Virtualization → Add sensor): the highest temperature of the node with alarm, limit from the chip

## 0.11.0 - 2026-11-13

- Temperatures of Linux machines and Proxmox nodes: the Linux script reads CPU, NVMe, chipset and mainboard (like "sensors", without lm-sensors and without root) - with sensors "Temperature" and "the highest", warning limit from the chip itself. The virtualisation page shows the temperature at the node. Create the Linux script once more

## 0.10.2 - 2026-11-13

- Menu fits low windows too: it scrolls and moves closer together when there is little height - account, sign-out, version and coffee link always reachable
- Code audit - security: AD sign-in counts failed attempts per account (also for attempts at the same time and other spellings), no longer tells whether an AD password is right, and signed-in AD users are checked again every 15 minutes (disabled in AD → signed out, other group → new role)
- Code audit - security: a stored password (database, network drive, Proxmox token) only goes to the address it was entered for; a pinned company CA checks the server name again; database monitors can check the server certificate
- Code audit - security: location limits stay when a location is deleted; scan agents only change devices of their location; the shared machine key reaches no device with a key of its own; the Windows script protects its folder before copying
- Code audit - stability: a malicious device can no longer hold scan, monitoring and notifications or end the server (deadlines for the whole request, size limits, no crash from broken NetBIOS packets)
- Code audit - alarms: maintenance on the switch holds back the alarms behind it, certificate warnings come after a maintenance, all clear to the escalation also after a maintenance, no alarms of paused monitors, deleted channels leave all monitors, setting the clock back does not stop the checks
- Code audit - data: a restore checks the backup completely first (schema update tried, an administrator present) and keeps the latest changes in the copy before; two NAS volumes of the same size, serial numbers written differently and long Linux drive names are recognised correctly
- Self-signed certificate: the key stays when it is renewed - machine scripts go on reporting. Create Windows scripts once more (they now check the key instead of the certificate)
- Manual: tables are shown as tables; notes on KVM rights, Windows Update, scan agent with a company CA

## 0.10.1 - 2026-11-13

- Virtualisation, network controllers, server hardware: the compact view from two hosts on
- Coffee link visible at the bottom of the menu

## 0.10.0 - 2026-11-13

- Machine scripts report hardware (model, serial number, BIOS, CPU, memory, network cards), disks with health, updates and restart, virus protection, firewall, critical events and certificates - create and roll out the script once more
- Server hardware through iDRAC, iLO, XClarity, Supermicro (Redfish): fans, power supplies, temperatures, RAID and drives, overall and power state, with sensors
- Virtualisation clear also with many hosts: the situation in numbers, one line per host, problems first, search down to the VM
- About WhatsOnMyNet: reachable for everyone by the version number at the bottom left, with "What's new", source code, website and coffee link
- Proxmox Backup Server: port 8007 and token ID @pbs filled in correctly when adding

## 0.9.0 - 2026-11-13

- History over months: 30 days, 90 days and a year, with the range from lowest to highest value and an availability strip
- UPS values: Synology, UPS network cards (UPS-MIB, APC), Linux (NUT, apcupsd) and Windows (USB) - mains or battery, charge, runtime, load
- Escalation: when an outage is not solved after a set time, a message also goes to further channels

## 0.8.0 - 2026-11-13

- Dependencies: when a switch fails, one message instead of an alarm flood - everything behind it is a follow-up outage
- "Machine by script" right under "Monitor" and "Add monitor"
- Scan: ignored devices can be brought back

## 0.7.0 - 2026-11-13

- Monitor Windows and Linux machines by script, without agent - with uninstall script
- Device data stays current, an exchanged device at the same address is recognised
- Network controllers: UniFi, Omada and MikroTik; better recognition while scanning

## 0.6.0 - 2026-11-13

- An appearance of its own
- Monitoring: measured values right in the list
- 15 more notification services with instructions
- Virtualisation: VMware, XCP-ng, Hyper-V, Nutanix, oVirt and KVM next to Proxmox
- Renaming a device renames its monitors; serial number, model and firmware by SNMP into the device

## 0.5.0 - 2026-11-13

- A clearer interface
- Active Directory: fetch the certificate from the DC, test step by step
- Proxmox: guided setup; reports for single devices

## 0.4.0 - 2026-11-13

- Sensors on device values, Proxmox VE and Backup Server, network drives (SMB)
- Planned reports by e-mail, backup and restore in the browser
- Two-factor sign-in; manual as PDF and help in the app

## 0.3.0 - 2026-11-12

- Nightly light scan with notice of new devices, printers, switches and NAS by SNMP
- Monitor Docker containers and databases, network map
- Sign-in with Active Directory, rights per location, scan agent for branch offices

## 0.2.0 - 2026-11-12

- Monitoring: checks, alarms by e-mail, Telegram and webhook, certificates, maintenance windows
- Inventory: suggestions while typing and bulk edit

## 0.1.0 - 2026-11-12

- The first version: network scan, device recognition and inventory
