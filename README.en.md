# WhatsOnMyNet

*Deutsche Fassung: [README.md](README.md)*

**Find what is on your network – keep what matters.**

WhatsOnMyNet scans your network, recognises manufacturer and device type by itself (switches, Proxmox, Synology, printers, Telematik components …) and lets you tick what goes into your inventory. No typing of manufacturers and models, no marathon of required fields. After signing in you only see your clean inventory – new devices only when you start a scan yourself.

![Scan with radar](docs/images/scan-en.png)

> Built for own use. Whoever uses WhatsOnMyNet does so at their own risk.

## What version 0.1 does

- **Gentle network scan** – devices in local networks are found via ARP (every device answers, even with a closed firewall), in routed networks via ping and a few TCP connection attempts. Only 26 typical ports are checked, limited to 40 attempts per second. To a firewall this looks like normal traffic.
- **Automatic recognition** – manufacturer from the MAC address (IEEE registry), device type from open ports, web interface title, certificate, SNMP (read-only), NetBIOS name and reverse DNS. Unsure guesses are marked; you can change the type before adopting.
- **Telematik** – card terminals (SICCT port 4742, ORGA, Cherry …) and TI connectors (KoCoBox, secunet, RISE …) get their own icon and category. Their deep check always keeps the gentle profile.
- **Adopt only what you want** – scan results in four tabs: *New*, *Changed*, *Known*, *Ignored*. Tick new devices to adopt them or ignore them for good.
- **MAC address as identity** – when a known device gets a new IP, the next scan takes it over automatically, with an entry in the history.
- **Inventory** – search across everything, filter by type and location, view as list, by subnet or by type, "seen in the last scan" status, export as CSV (Excel) and JSON.
- **Quick access** – one click opens the device's web interface (Proxmox on 8006, Synology on 5001, printers …). The scan suggests the address.
- **Purchase, warranty, maintenance** – optional fields, with a notice on the overview when a warranty ends soon.
- **Deep check** – for single unclear devices, started by hand: about 120 ports and all web interfaces.
- **Locations** – group subnets. Before a scan you just tick them; devices found get their location automatically.
- **Users and roles** – administrator, editor, read only. Active Directory follows in a later version.
- **HTTPS from the first start** – generated certificate, own certificate (PEM or PFX) uploadable in the interface, HTTP always redirects to HTTPS.
- **German and English**, light and dark, usable on a phone.

![Inventory](docs/images/inventory-en.png)

## Installation

Requirement: a **Linux host with Docker** (server, VM, Proxmox LXC with Docker, Synology Container Manager). WhatsOnMyNet runs in the **host network** – only this way it sees the MAC addresses of your devices. Docker Desktop on Windows or macOS does not see the real network and is therefore not suitable.

```sh
mkdir whatsonmynet && cd whatsonmynet
curl -fsSLO https://raw.githubusercontent.com/soleil0815/whatsonmynet/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/soleil0815/whatsonmynet/main/env.example
docker compose up -d
docker compose logs whatsonmynet      # shows the setup code
```

Then open `https://<server-address>:8743`. The first time the browser warns about the generated certificate – that is expected. In the wizard you enter the setup code from the log and create the main administrator.

Then:

1. Create **locations** and enter their subnets (the server's networks are suggested).
2. **Scan network** → tick locations → *Start scan*.
3. In the *New* tab choose what goes into the inventory, adjust type and name if needed → *Adopt into inventory*.

### Changing ports

The ports are in `.env`, not in `docker-compose.yml`:

```sh
WOMN_HTTPS_PORT=8743   # web interface
WOMN_HTTP_PORT=8780    # only redirects to HTTPS (0 = off)
```

Then `docker compose up -d`.

### Ping

WhatsOnMyNet runs without root. Ping then only works if the host allows ICMP for normal users (`net.ipv4.ping_group_range`, default on Debian, Ubuntu and Proxmox). Without ping the scan still finds local devices via ARP and remote ones via TCP; the program shows a notice.

### SNMP

By default the scan asks devices with the community `public` (SNMP v2c, else v1) for name, description and vendor ID – read-only. Own communities go under *Settings → Scan*; they are stored encrypted. Devices without SNMP (e.g. simple TP-Link switches) are still recognised, just with fewer details.

## HTTPS and certificate

- On first start WhatsOnMyNet creates a self-signed certificate for the host name, `localhost`, all IPv4 addresses of the host and the address in `WOMN_BASE_URL`. It is renewed automatically 30 days before it expires.
- Under *Settings → HTTPS certificate* you upload your own certificate: PEM (certificate with chain + key) or PFX/P12 with password. It is checked first (key matches, not expired) and becomes active without a restart.
- HTTP on `WOMN_HTTP_PORT` always redirects to HTTPS.
- WhatsOnMyNet only sends HSTS with an own certificate and a host name. With a self-signed certificate HSTS would stop the browser from letting you past the warning – you would be locked out.

### Behind a reverse proxy

In `.env`:

```sh
WOMN_BASE_URL=https://womn.company.local
WOMN_TRUST_PROXY=10.0.10.5          # address of the proxy
```

The proxy then forwards either to `https://<server>:8743` (self-signed – "do not verify certificate" in the proxy) or to `http://<server>:8780`: the HTTP port accepts requests from the trusted proxy and redirects everyone else to HTTPS. The rules for redirects and HSTS are the same as in Catalytix, AssetLotse and Helfi.Space.

## Security

- Only scan networks you are responsible for.
- The normal scan is deliberately gentle. Still: add the server running WhatsOnMyNet as trusted in your firewall, IDS or antivirus, then even the deep check raises no alarm.
- The container runs without root, with read-only program files and without extra rights (`cap_drop: ALL`, `no-new-privileges`).
- Passwords are stored with scrypt, the SMTP password and SNMP communities encrypted with AES-256-GCM. Back up the key (`data/secret.key`).
- Please report vulnerabilities confidentially, see [SECURITY.md](SECURITY.md).

## Locked out?

```sh
docker compose exec whatsonmynet womn-admin list
docker compose exec whatsonmynet womn-admin reset <user>    # new random password, administrator again
docker compose exec whatsonmynet womn-admin create <user>   # new administrator
```

## Updates and backup

- Dockhand or Watchtower fetch updates automatically, or by hand: `docker compose pull && docker compose up -d`.
- Security updates are published on patch day (second Tuesday of the month) as `<version>-s<n>`: the same program with a new base image and updated Alpine and npm packages, built, tested and checked with Trivy. If nothing changed, nothing is published.
- Trivy checks the published image every day. Fixable vulnerabilities open an issue; the security update on patch day fixes them.
- In the week before patch day a ZAP scan attacks the program in a throwaway container without login. The monthly code audit evaluates the result.
- WhatsOnMyNet writes a daily database backup to `data/backups/` (number under *Settings → General*). Back up the whole `data/` folder, including `secret.key` and `tls/`.

## What comes next

| Version | Content |
| --- | --- |
| 2 | Monitoring like Uptime Kuma: online status, certificates, external targets, alarms via email, Telegram and webhook, maintenance windows, Docker and database monitoring, nightly light scan, printer data via SNMP (toner, drum) |
| 3 | Active Directory (LDAPS), roles per location/subnet |
| later | Scan agent for branch offices, topology via LLDP/CDP, MAC addresses of remote subnets via SNMP from the router |

## License

WhatsOnMyNet is open source under the [GNU Affero General Public License 3.0](LICENSE) (AGPL-3.0-or-later). Whoever offers a modified version over a network has to make its source code available (`WOMN_SOURCE_URL`).

Font: IBM Plex (SIL Open Font License, `public/fonts/OFL.txt`). Manufacturer list: IEEE via the package `oui-data` (BSD-2-Clause).
