# Changelog

What changed in WhatsOnMyNet - the same texts the program shows under *About WhatsOnMyNet* (click on the version number at the bottom left). Deutsch: [CHANGELOG.md](CHANGELOG.md)

<!-- generated from public/js/changelog.js by tools/changelog.mjs - do not edit here -->

## Next version (not released yet)

- Messages by sender: one row per computer or device with the last message and the messages, warnings and errors of the last 24 hours; a click shows only its messages, "All messages" everything as before. On the device page: More → Messages of the device
- Umlauts in Windows messages (NXLog in the code page of Windows) are read right: "NT-AUTORITÄT" instead of "NT-AUTORIT�T"
- Diagnostic package: new file meldungen.json - syslog and trap receivers (ports, errors, connections), space of the messages file, messages in the period by kind, severity and NXLog format, event rules with matches, waiting and failed attempts; senders anonymised, words of the rules only counted
- Messages: count and space are right as soon as new messages come (showed the old figures for up to a minute, after switching on "0 stored" next to the list)
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
