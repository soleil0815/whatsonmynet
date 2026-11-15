# Integrations – what WhatsOnMyNet depends on

The list the monthly interface check works from (scheduled task "WhatsOnMyNet: Schnittstellen der Hersteller prüfen",
or run by hand). Every system WhatsOnMyNet reads, every format it understands and every platform it runs on – with the
code that depends on it and where its changes are announced.

**Keep it current:** a pull request that adds or changes an integration also adds or changes its row here. The result
of each check (date, versions seen, open points) goes to `.github/integrations-check.md`.

What to look for each month: new major/API versions, endpoints or fields deprecated or removed (with dates), new
sign-in rules (tokens, scopes, TLS, signing), changed defaults, new device generations or OS releases that answer
differently – and whether the code below is affected. Old and new versions must keep working side by side.

## 1. Hypervisors and backup

| System | Code | What is used | Watch |
|---|---|---|---|
| Proxmox VE | `src/proxmox.js` | `/api2/json`: cluster/resources, cluster/status, nodes/*/tasks, nodes/*/certificates/info, nodes/*/apt/update, access/permissions; token `PVEAPIToken`; role PVEAuditor | pve.proxmox.com roadmap and release notes, API viewer |
| Proxmox Backup Server | `src/proxmox.js` | status/datastore-usage, admin/datastore/*/groups, tasks; token `PBSAPIToken`; role Audit | pbs roadmap |
| VMware vCenter/ESXi | `src/virt.js` | REST (`/api/…`, session) | Broadcom release notes, vSphere Automation API changes |
| XCP-ng / XenServer, Nutanix Prism, oVirt/OLVM | `src/virt.js` | XO/XAPI, Prism v2/v3, oVirt REST | vendor API docs, end-of-life notices |
| Hyper-V | `src/hostscripts/womn-hyperv.ps1` | Get-VM, Cluster Shared Volumes | Windows Server release notes |
| KVM/libvirt | `src/hostscripts/womn-libvirt.sh` | `virsh -r` | libvirt news |
| Veeam Backup & Replication | `src/veeam.js` | REST `x-api-version: 1.1-rev0` (VBR 12), `/api/oauth2/token`, `/api/v1/jobs/states`, `/api/v1/backup…`, `/api/v1/server…`; role Veeam Backup Viewer | Veeam REST API reference: supported revisions per VBR version (when is 1.1-rev0 dropped?) |

## 2. Cloud and SaaS (`src/cloud.js`)

| System | What is used | Watch |
|---|---|---|
| AWS | SigV4 (own code), STS GetCallerIdentity, EC2 `Version=2016-11-15` DescribeInstances/DescribeInstanceStatus, RDS DescribeDBInstances, ELBv2 DescribeTargetGroups/DescribeTargetHealth, CloudWatch DescribeAlarms/GetMetricData, Cost Explorer GetCostAndUsage | AWS what's new, SDK changelogs, IAM action renames, regional endpoint changes |
| Azure | ARM `api-version=` 2022-12-01 (subscription), 2022-10-01 (Resource Health), 2024-07-01 (Compute), 2021-11-01 (SQL), flexibleServers, 2019-05-05-preview (Alerts Management), 2023-03-01 (Cost Management); OAuth client credentials | Azure REST API reference: deprecated api-versions (preview versions especially), Entra ID sign-in changes |
| Google Cloud | service account JWT → `oauth2.googleapis.com`, Compute v1 aggregated instances, Cloud SQL Admin v1, Monitoring v3 timeSeries (`compute…/cpu/utilization`, `cloudsql…/cpu|disk/utilization`) | Google Cloud release notes, metric deprecations |
| Microsoft 365 | Graph v1.0: `/admin/serviceAnnouncement/healthOverviews`, `/issues`, `/subscribedSkus`; permissions ServiceHealth.Read.All, Organization.Read.All | Graph changelog, permission changes |

## 3. Devices and hardware

| System | Code | Watch |
|---|---|---|
| Network controllers: UniFi Network (UniFi OS, API keys, official API), TP-Link Omada (OpenAPI), MikroTik RouterOS REST | `src/netctl.js` | vendor release notes, API key / auth changes |
| Redfish: iDRAC, iLO, XClarity, Supermicro, iRMC | `src/redfish.js` | DMTF schema (Thermal → ThermalSubsystem, Power → PowerSubsystem, Sensors), vendor firmware notes |
| SNMP: Printer-MIB, Host-Resources, IF-MIB (64-bit counters, port load), Bridge/Q-Bridge, LLDP, UPS-MIB/APC, Synology/QNAP MIBs | `src/scan/*`, `src/snmpdevices.js`, `src/printers.js` | changed OIDs in new firmware of common devices |
| SNMP traps (v1/v2c, informs), known trap OIDs | `src/events.js` (`KNOWN_TRAPS`) | net-snmp changes; SNMPv3 traps (not yet supported) |

## 4. Messages: syslog, Windows events, event rules

| What | Code | Watch |
|---|---|---|
| Syslog RFC 3164/5424 over UDP, TCP (RFC 6587, both framings), TLS (RFC 5425) | `src/events.js` | senders that frame differently |
| NXLog (Community and Enterprise Agent): default line format `date host LEVEL id text`, readable `[id] [log] text` via `to_syslog_bsd()`, JSON via `to_json()`; field names EventID, SourceName, Channel, Hostname, Severity, EventType, AccountName/Domain, TargetUserName | `src/events.js` (`windowsFields`, `NX_LINE`), manual "Windows-Ereignisse" | NXLog release notes: changed default output, renamed fields, new agent (key-value raw_event) |
| Code page: UTF-8 mixed with Windows-1252 | `src/events.js` (`decodeText`) | – |
| rsyslog, Synology Log Center (sending), switches/firewalls (remote syslog) | manual | default formats in new releases |
| Windows event ids in ready-made rules: Defender 1116/1117, SRP 865-868, AppLocker 8004/8007, 4740, 4728/4732/4756, 1102, 7045, 4625 | `public/js/views/eventrules.js` (`RULE_PRESETS`) | Microsoft docs: ids moved, renamed sources, new Defender/AppLocker/App Control events |
| Default noise list of Windows event ids not taken on new installations (`WIN_NOISE`) | `src/settings.js` | Microsoft docs: ids reused by other sources (like 8004 for AppLocker), ids that became important |
| Text of common device messages used by presets (sshd "Failed password/Invalid user", "Port N … down/up", UPS "on battery") | `RULE_PRESETS` | OpenSSH log wording changes |

## 5. Computers (scripts without an agent)

| What | Code | Watch |
|---|---|---|
| Windows script (Windows PowerShell 5.1): CIM/WMI classes, Get-PhysicalDisk / Get-StorageReliabilityCounter, Microsoft.Update.Session, Get-MpComputerStatus, Get-NetFirewallProfile, Get-WinEvent, certificate store, schtasks; own checks (Checkmk local check format, ACL check) | `src/hostscripts/womn-host.ps1`, `setup.ps1.part` | Windows deprecated/removed features (WMIC, VBScript, PowerShell 2.0), new Windows / Server releases, TLS defaults |
| Linux script (POSIX sh): lsblk, `smartctl -j`, journalctl, apt/dnf, /sys/class/hwmon and thermal, NUT/apcupsd, ufw/firewalld, reboot-required; own checks | `src/hostscripts/womn-host.sh` | smartmontools JSON changes, distribution releases (Debian, Ubuntu LTS, RHEL family) |
| Checkmk local check format | `src/hostfacts.js` (`cleanChecks`) | Checkmk docs (format extensions) |

## 6. Checks and services (`src/monitor/*`)

Docker Engine API (min/max version, socket proxy), MySQL/MariaDB, PostgreSQL, Redis/Valkey, SMB (smbclient), mail
(SMTP/IMAP/POP3 with STARTTLS/TLS), DNS, LDAP/AD, NTP, Microsoft SQL Server (TDS prelogin) – `src/monitor/protocols.js`,
`services.js`, `docker.js`, `smb.js`. Watch: protocol/TLS defaults (e.g. TLS 1.0/1.1 removal), Docker API version window.

## 7. Notifications, sign-in, export

| What | Code | Watch |
|---|---|---|
| Telegram Bot API, Microsoft Teams (Workflows webhooks – the old Office 365 connectors are switched off), Slack, Discord, Google Chat, Mattermost, Rocket.Chat, Matrix, Signal, WhatsApp (CallMeBot), ntfy, Gotify, Pushover, Pushbullet, Home Assistant, Apprise, webhooks, SMTP | `src/monitor/notify.js`, `providers.js` | provider API/webhook changes and retirements |
| Active Directory / LDAP (LDAP signing, channel binding, LDAPS) | `src/auth/directory.js` | Microsoft AD hardening timelines |
| Prometheus text format, Grafana dashboard JSON | `src/metrics.js` | Prometheus exposition format (OpenMetrics), Grafana dashboard schema changes |

## 8. Runtime and platform

Node.js LTS plan (Dockerfile, `engines`), Express, better-sqlite3, net-snmp, ldapts, nodemailer, mysql2, pg (only breaking
changes and end of life – normal updates come from Dependabot and the patch-day security update), Docker base image
(node:alpine), browsers for the interface (no build step: modern JavaScript only).

## 9. New things worth connecting

Each month also look out for systems or features that many small and mid-sized networks use and that WhatsOnMyNet does
not read yet – report them as suggestions only (with why and how much work), never build them unasked. Ideas noted so
far: SNMPv3 traps, Wazuh forwarding of chosen messages, software inventory from the machine scripts.
