# Changelog

What changed in WhatsOnMyNet - the same texts the program shows under *About WhatsOnMyNet* (click on the version number at the bottom left). Deutsch: [CHANGELOG.md](CHANGELOG.md)

<!-- generated from public/js/changelog.js by tools/changelog.mjs - do not edit here -->

## Next version (not released yet)

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
