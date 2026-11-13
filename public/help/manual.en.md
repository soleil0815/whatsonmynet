# WhatsOnMyNet – Manual

WhatsOnMyNet finds what runs on your network and keeps only what you adopt in the inventory. It also monitors devices, services and websites, reads printers, switches, NAS and Proxmox, and reports by e-mail, Telegram or webhook when something is wrong.

![Overview](img/dashboard-en.png)

## Installation

WhatsOnMyNet runs as a Docker container with host networking – only this way the scan sees the MAC addresses of the devices.

1. Put `docker-compose.yml` and `env.example` from the release into a folder, rename `env.example` to `.env`.
2. Adjust ports (`WOMN_HTTPS_PORT`, default 8743), time zone (`TZ`) and owner of the data (`PUID`/`PGID`) in `.env` if needed.
3. `docker compose up -d` – or create the stack in Dockhand.
4. Get the **setup code** from the log (`docker compose logs whatsonmynet`) and open `https://<server>:8743/setup`. There you create the first administrator.

The interface always runs over HTTPS. On first start WhatsOnMyNet creates a self-signed certificate; upload your own (PEM or PFX) under *Settings → HTTPS certificate*.

**Ping:** the container runs without root rights. Ping works if the host allows ICMP for normal users (`net.ipv4.ping_group_range`, default on Debian/Ubuntu/Proxmox; set `0 65535` in LXC containers). Without ping the scan still finds devices via ARP and TCP.

## First steps

1. **Add a location** (*Locations*): name and subnets, e.g. "Main building" with `192.168.10.0/24`.
2. **Scan the network** (*Scan network*): tick the location, "Start scan". The radar shows the devices found; the scan is gentle (ARP, about 25 typical ports, SNMP read-only).
3. **Adopt**: in the result under "New" check type and name, tick devices, "Adopt into inventory". What you do not want in the inventory, "Ignore".

![Scan with radar](img/scan-en.png)

The MAC address is the identity of a device: if it gets a new IP, the next scan takes it over automatically and records it in the history.

## Inventory

![Inventory](img/inventory-en.png)

- **Search and filter** by name, IP, MAC, manufacturer, type, location or tag; export as CSV or JSON.
- **Device page**: all details, purchase and warranty dates, notes, quick access to the web interface, what the scan detected, history of all changes.
- **Suggestions while typing**: manufacturer, model, operating system, owner, supplier and tags suggest what is already in the inventory. A known model fills in manufacturer and type.
- **Multiple selection**: tick devices and edit them together (type, location, manufacturer, model, dates, tags) or delete them.
- **Deep check**: checks one device with a longer port list. Telematik devices (connector, card terminal) are always checked gently.

## Nightly light scan

Every night (default 02:30) WhatsOnMyNet looks for devices in all subnets of your locations – no ports, no SNMP. Known devices get their new IP; a device showing up for the very first time is reported once. Settings, time and "Run now" are under *Settings → Scan*.

## Monitoring

![Monitoring](img/monitoring-en.png)

A monitor checks regularly (20 seconds to 24 hours) and reports only after several failures in a row. Kinds:

- **Web (HTTP/S)** with status codes, keyword and certificate expiry (warning e.g. 30, 14 and 7 days before)
- **TCP port** and **ping**
- **Docker container** (through a socket proxy, *Settings → Docker*): running, restarting all the time, health check "unhealthy"
- **Databases**: MariaDB/MySQL, PostgreSQL, Redis/Valkey – sign-in and one harmless query
- **Network drive (SMB)**: Windows shares and NAS – see below
- **Sensor (device value)**, **SNMP value (OID)** and **Proxmox** – see below

On the device page "Monitor" creates a fitting monitor. If the IP of a device changes, its monitors follow.

![Monitor with history](img/monitor-en.png)

**Notifications** (*Settings → Notifications*): e-mail (through the SMTP server), Telegram bot and webhook with your own JSON template. Every channel has a test message. **Maintenance windows** (once or weekly) suppress alarms.

## Printers, switches and NAS

Devices of type *Printer*, *Switch* and *NAS* are queried via SNMP (read-only). Set the community under *Settings → Scan*; SNMP v1/v2c has to be on at the device.

![Printer](img/printer-en.png)

- **Printer**: toner or ink per colour, drum, waste toner, page counter, faults and display text. Below 15 % a notice is sent – once per cartridge.
- **Switch**: ports as tiles, which devices hang at which port (VLAN-aware), LLDP neighbours, firmware. Every device page shows "Plugged in at".
- **NAS**: volumes; on Synology also disks, RAID, temperature, fans, power supply and DSM update. Problems are reported – and again when everything is fine.

![Switch](img/switch-en.png)

![NAS](img/nas-en.png)

### Network map

The *Network map* shows from MAC tables and LLDP which device hangs at which port and how the switches are connected. Simple switches without SNMP show up as a branch behind the port they are plugged into. Behind routers the scan reads the ARP table of the routers via SNMP, so the MAC address stays the identity there too.

![Network map](img/topology-en.png)

## Sensors

Every value a device delivers can become a monitor of its own – with history, alarm and maintenance windows. On the device page "Add sensor", then choose value and condition, e.g.:

- "toner cyan less than or equal 10 %"
- "usage /volume1 greater than or equal 85 %"
- "temperature drive 2 greater than 50 °C"
- "port 10 (uplink) connected"

The kind **SNMP value (OID)** reads any SNMP value (e.g. runtime left of a UPS) and compares with less, greater, equal or "contains text".

## Network drives (SMB)

![Network drive](img/smb-en.png)

The kind **Network drive (SMB)** really signs in to a share – not just to the open port. So you also notice when the password expired, the rights changed or a folder is missing.

1. Create an account of its own with **read rights** on the share (in AD e.g. `COMPANY\monitor`, on a NAS a local user).
2. *Add monitor* → kind **Network drive (SMB)**. Just paste the path, e.g. `\\fs01\Department\Projects` – server, share and folder are taken from it.
3. Enter user, domain (empty for NAS accounts) and password. Optional: warn below … % or … GB free.

The check runs over SMB 2/3: sign in, read the share (or the folder or file), ask for the free space. WhatsOnMyNet writes nothing to the share. The detail page shows the free space; reports have the section *Network drives* for it.

## Proxmox VE and Backup Server

![Proxmox](img/proxmox-en.png)

Under *Settings → Proxmox* WhatsOnMyNet reads Proxmox through its API – nothing is installed there.

1. In Proxmox VE under *Datacenter → Permissions*:
   - Add a **user**: `whatsonmynet`, realm *Proxmox VE authentication server* (it needs no password).
   - Add an **API token**: user `whatsonmynet@pve`, token ID **only** `womn`, "Privilege Separation" on. Copy the secret right away – it is shown only once.
   - **Permissions**: role **PVEAuditor** on the path `/` (propagate on) – **twice**: as user permission for `whatsonmynet@pve` and as token permission for `whatsonmynet@pve!womn`. With separated privileges only what user *and* token have counts.
   - Or in the shell of a node:
     `pveum user add whatsonmynet@pve` · `pveum acl modify / --users whatsonmynet@pve --roles PVEAuditor` · `pveum user token add whatsonmynet@pve womn --privsep 1` · `pveum acl modify / --tokens 'whatsonmynet@pve!womn' --roles PVEAuditor`
   - Backup Server: the same under *Configuration → Access Control* with the role **Audit** (user `whatsonmynet@pbs`).
2. In WhatsOnMyNet enter the address (`https://pve01:8006` or `:8007`), the **full** token ID (`whatsonmynet@pve!womn`) and the secret. If the token lacks rights, the detail view says which.
3. For the self-signed certificate paste the content of `/etc/pve/pve-root-ca.pem` (VE) or `/etc/proxmox-backup/proxy.pem` (Backup Server).

Nodes, storage, VMs and containers, backups, datastores and failed tasks are shown. "Add sensor" watches e.g. "VM 101 running" or "last backup older than 26 hours".

## Reports

![Report](img/report-en.png)

Under *Settings → Reports* reports go out by e-mail at set times – e.g. the toner levels to the office every Monday at 8:00.

- Content: printers, NAS, switches, network drives; can be limited to locations; optionally only devices that need action.
- **Devices**: all devices of the chosen content – or only chosen ones, e.g. a report of its own for the printer in the front office.
- Printers show the **pages printed** (in total and in the report period, e.g. "in the last 7 days") and – if the printer reports it – how many pages the toner still lasts.
- The mail is **neutral**: no link, no program name – only your sender name, subject (`{week}`, `{date}`), introduction, the devices and your closing.
- "Preview", "Test to me" and "Send now" right in the list.

## Users and rights

- **Roles**: *Administrator* (everything), *Editor* (scan, adopt, maintain, monitors), *Read only*.
- **Locations**: editors and viewers can be limited to locations – they then only see and change devices, scans and monitors of these.
- **Active Directory** (*Settings → Active Directory*): sign-in with the Windows account over LDAPS or StartTLS. The role comes from AD groups; members of none cannot sign in. Local accounts win for the same name. Under *TLS certificate*, "Fetch certificate from DC" gets the chain from the domain controller (missing CAs via AIA or from AD); you compare the fingerprint with certlm.msc and confirm.
- **Two-factor sign-in** (*My account*): scan the QR code with an authenticator app, confirm a code, keep the recovery codes. It can be made mandatory for administrators under *Settings → General*.

## Scan agent for branch offices

For a branch office a second container runs there as scan agent. Under *Settings → Scan agents* add an agent for the location; put the `.env` shown next to `docker-compose.agent.yml` from the release and start `docker compose -f docker-compose.agent.yml up -d`. The agent opens no port, fetches jobs over HTTPS and reports only addresses of its location.

## Backup and updates

- Every night WhatsOnMyNet backs up the database to `data/backups/`; additionally before every database update.
- *Settings → Backup*: download a backup, back up now, restore a backup (the current state is backed up first, then the program restarts).
- **Keep `data/secret.key` (or `WOMN_SECRET`) as well** – without it stored passwords in a backup are unreadable.
- Updates: in Dockhand/Watchtower or `docker compose pull && docker compose up -d`. Once a month a security update with new packages is released.

## Troubleshooting

- **Interface not reachable**: open the host firewall for the HTTPS port. With host networking Docker/Dockhand shows no port mapping – that is correct.
- **No printer/switch data**: switch on SNMP at the device, check the community under *Settings → Scan*, "Query now" on the device page.
- **Locked out**: `docker compose exec whatsonmynet womn-admin reset <user>` sets a new password, makes the account administrator again and switches two-factor sign-in off. `womn-admin create <user>` adds a new administrator.
- **Network drive reports "protocol not supported"**: the device only speaks the old SMB1 – it is not used for security reasons. Switch on SMB2/3 at the device (Synology: *File Services → SMB → Advanced*).
- **Log**: *Settings → Log* shows who changed what; technical messages are in the container log.
