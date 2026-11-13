// Device type from what the scan found: manufacturer, open ports, web interface title, SNMP and NetBIOS.
// Each rule adds points for one type; the type with the most points wins. The confidence (0–1) tells the UI
// whether the guess should be checked ("unsure").

export const TYPES = [
  'router', 'firewall', 'switch', 'accesspoint', 'hypervisor', 'server', 'nas', 'printer', 'computer', 'vm',
  'mobile', 'phone', 'camera', 'ups', 'iot', 'media', 'ti_connector', 'ti_terminal', 'unknown',
];

/** Types that belong to the Telematik infrastructure (shown with their own mark and scanned extra gently) */
export const TELEMATIK_TYPES = new Set(['ti_connector', 'ti_terminal']);
export const isTelematik = (type) => TELEMATIK_TYPES.has(type);

const PRINTER_VENDORS = /^(HP|Brother|Kyocera|Canon|Epson|Ricoh|Xerox|Lexmark|Konica Minolta|Sharp|Oki|OKI|Toshiba TEC|Utax|Triumph-Adler|Develop|Olivetti|Zebra)/i;
const NETWORK_VENDORS = /^(TP-Link|Netgear|Cisco|LANCOM|Zyxel|D-Link|MikroTik|Ubiquiti|Juniper|Aruba|HPE|Extreme|Allied Telesis|Edgecore|Hirschmann|Moxa|Mellanox)/i;
const FIREWALL_VENDORS = /^(Fortinet|Sophos|Palo Alto|WatchGuard|SonicWall|Barracuda|Stormshield|Securepoint|Check Point|genua)/i;
const PHONE_VENDORS = /^(Yealink|Snom|Gigaset|Polycom|Grandstream|Unify|Mitel|Auerswald|Fanvil|Avaya|Alcatel-Lucent Enterprise)/i;
const CAMERA_VENDORS = /^(Hikvision|Axis|Dahua|Reolink|Mobotix|Hanwha|Uniview|Vivotek|Ezviz)/i;
const IOT_VENDORS = /^(Espressif|Shelly|Tuya|Philips Lighting|Signify|tado|Nuki|Bosch Thermotechnik|Fibaro|Sonoff|ITEAD|Murata|Particle)/i;
const MEDIA_VENDORS = /^(Sonos|Roku|Google|Amazon|LG Electronics|Sony|Panasonic|Denon|Bose|Yamaha|Samsung Electronics)/i;
const UPS_VENDORS = /^(APC|Eaton|Riello|Socomec|CyberPower|Legrand|Vertiv|Liebert|Online USV)/i;
const NAS_VENDORS = /^(Synology|QNAP|Asustor|TerraMaster|Western Digital|Buffalo|Netgear ReadyNAS)/i;
const TI_CONNECTOR_VENDORS = /^(secunet|Research Industrial Systems|RISE|CompuGroup|KoCo Connector|Telekom Healthcare)/i;
const TI_TERMINAL_VENDORS = /^(Ingenico|Cherry|Worldline|ORGA|Celectronic|Bluechip)/i;
const VM_VENDORS = /^(QEMU\/KVM|VMware|Microsoft|Proxmox|Xen|Parallels|innotek|Oracle VirtualBox)/i;

// sysObjectID enterprise numbers (1.3.6.1.4.1.<n>)
const ENTERPRISE = {
  11: 'HP', 2435: 'Brother', 1347: 'Kyocera', 367: 'Ricoh', 1602: 'Canon', 2001: 'OKI', 253: 'Xerox', 641: 'Lexmark',
  18334: 'Konica Minolta', 1248: 'Epson', 6574: 'Synology', 24681: 'QNAP', 2356: 'LANCOM', 11863: 'TP-Link',
  9: 'Cisco', 41112: 'Ubiquiti', 14988: 'MikroTik', 4526: 'Netgear', 890: 'Zyxel', 171: 'D-Link', 12356: 'Fortinet',
  2636: 'Juniper', 25506: 'HPE', 47196: 'HPE Aruba', 14823: 'Aruba', 318: 'APC', 534: 'Eaton', 705: 'Eaton',
  8072: 'net-snmp', 311: 'Microsoft', 674: 'Dell', 6876: 'VMware', 12325: 'FreeBSD',
};

export function enterpriseOf(objectId) {
  const m = /^(?:\.?1\.3\.6\.1\.4\.1)\.(\d+)/.exec(String(objectId || ''));
  return m ? { number: Number(m[1]), name: ENTERPRISE[Number(m[1])] || '' } : null;
}

/** Text that describes the device in its own words (titles, SNMP, certificate) */
function selfDescription(f) {
  return [
    f.snmp?.descr, f.snmp?.name,
    ...(f.http || []).flatMap((h) => [h.title, h.server, h.cert?.subject, h.cert?.org, h.cert?.issuer]),
  ].filter(Boolean).join(' | ');
}

export function classify(f) {
  const ports = new Set(f.ports || []);
  const has = (...p) => p.some((x) => ports.has(x));
  const vendor = f.vendor || '';
  const ent = enterpriseOf(f.snmp?.objectId);
  const brand = vendor || ent?.name || '';
  const text = selfDescription(f);
  const t = (re) => re.test(text);
  const score = Object.fromEntries(TYPES.map((x) => [x, 0]));
  const reasons = [];
  const add = (type, pts, why) => { score[type] += pts; reasons.push({ type, pts, why }); };
  let model = '';
  let os = '';

  // --- Telematik infrastructure (first: these devices must never be mistaken for something else)
  if (ports.has(4742)) add('ti_terminal', 6, 'port 4742 (SICCT)');
  if (TI_TERMINAL_VENDORS.test(brand)) add('ti_terminal', 3, `manufacturer ${brand}`);
  if (t(/ORGA\s?6\d{3}|ST-?1506|eHealth|Kartenterminal|card terminal|SICCT/i)) add('ti_terminal', 5, 'name of a card terminal');
  if (TI_CONNECTOR_VENDORS.test(brand)) add('ti_connector', 4, `manufacturer ${brand}`);
  if (t(/konnektor|kocobox|ti-?gateway|secunet konnektor|rise konnektor|connector\.sds/i)) add('ti_connector', 6, 'web interface of a TI connector');

  // --- Virtualisation
  if (has(8006)) add('hypervisor', 5, 'port 8006 (Proxmox VE)');
  if (has(8007)) add('server', 3, 'port 8007 (Proxmox Backup Server)');
  if (t(/proxmox virtual environment|pve-ssl|proxmox ve/i)) { add('hypervisor', 5, 'Proxmox web interface'); os = os || 'Proxmox VE'; }
  if (t(/proxmox backup server/i)) { add('server', 5, 'Proxmox Backup Server'); os = 'Proxmox Backup Server'; }
  if (t(/vmware esxi|esxi/i) || (has(902) && has(443) && /VMware/i.test(brand))) { add('hypervisor', 6, 'VMware ESXi'); os = 'VMware ESXi'; }
  if (VM_VENDORS.test(vendor) && !/^Microsoft$/i.test(vendor)) add('vm', 3, `virtual network card (${vendor})`);
  if (/^Microsoft$/i.test(vendor) && f.mac?.startsWith('00:15:5d')) add('vm', 3, 'Hyper-V network card');

  // --- NAS
  if (NAS_VENDORS.test(brand)) add('nas', 5, `manufacturer ${brand}`);
  if (t(/synology|diskstation|dsm/i)) { add('nas', 5, 'Synology DSM'); os = os || 'Synology DSM'; }
  if (t(/qnap|qts|quts/i)) { add('nas', 5, 'QNAP'); os = os || 'QNAP QTS'; }
  if (has(5000, 5001) && !score.nas) add('nas', 2, 'ports 5000/5001');
  if (t(/truenas|freenas|openmediavault|unraid/i)) add('nas', 5, 'NAS web interface');

  // --- Printers
  if (has(9100)) add('printer', 4, 'port 9100 (raw printing)');
  if (has(515)) add('printer', 2, 'port 515 (LPD)');
  if (has(631)) add('printer', 2, 'port 631 (IPP)');
  if (PRINTER_VENDORS.test(brand) && (has(9100, 515, 631) || f.snmp)) add('printer', 3, `printer manufacturer ${brand}`);
  if (t(/printer|drucker|laserjet|officejet|deskjet|ecosys|taskalfa|bizhub|imagerunner|i-sensys|workcentre|versalink|altalink|mfc-|hl-l|dcp-|ricoh|aficio|lexmark|epson.*(wf|et)-|web image monitor|embedded web server|command center/i)) add('printer', 4, 'printer name');

  // --- Network devices
  const isGw = !!f.isGateway;
  if (isGw) add('router', 4, 'default gateway');
  if (t(/fritz!?box/i)) { add('router', 6, 'FRITZ!Box'); model = model || 'FRITZ!Box'; }
  if (/^AVM$/i.test(brand) && !t(/fritz!?(repeater|powerline|dect)/i)) add('router', 3, 'AVM');
  if (t(/fritz!?(repeater|powerline)/i)) add('accesspoint', 5, 'FRITZ!Repeater');
  if (t(/opnsense|pfsense|sophos|fortigate|fortinet|watchguard|sonicwall|securepoint|untangle|ipfire|firewall/i)) add('firewall', 6, 'firewall web interface');
  if (FIREWALL_VENDORS.test(brand)) add('firewall', 4, `manufacturer ${brand}`);
  if (has(8291) || /^MikroTik$/i.test(brand) || t(/routeros|mikrotik/i)) add('router', 4, 'MikroTik');
  if (t(/\bswitch\b|jetstream|smart switch|managed switch|easy smart|gs\d{3,4}|sg\d{3,4}|catalyst|procurve|aruba.*switch|omada.*switch|tl-sg|lancom gs-|ex\d{4}/i)) add('switch', 5, 'switch name');
  if (/^LANCOM$/i.test(brand)) {
    if (t(/lancom (gs|xs)-/i)) add('switch', 4, 'LANCOM switch');
    else if (t(/lancom l-|lcos li/i)) add('accesspoint', 4, 'LANCOM access point');
    else add('router', 3, 'LANCOM');
  }
  if (NETWORK_VENDORS.test(brand) && (f.snmp || has(80, 443, 23, 22)) && !has(445, 3389, 9100)) add('switch', 2, `network manufacturer ${brand}`);
  if (t(/access point|\bap\b|omada.*eap|eap\d{3}|airos|aironet|wlan/i)) add('accesspoint', 4, 'access point name');
  if (/^Ubiquiti$/i.test(brand)) add('accesspoint', 2, 'Ubiquiti');
  // UniFi, Omada, MikroTik, Aruba Instant On: the model names say what it is (stronger than the manufacturer alone) -
  // they often appear only as host name (UniFi devices register with their model, e.g. USW-Lite-8-PoE)
  const named = [text, f.hostname, f.rdns, f.netbios?.name].filter(Boolean).join(' | ');
  const tn = (re) => re.test(named);
  const unifi = /^Ubiquiti$/i.test(brand) || tn(/unifi/i);
  if (unifi && tn(/\b(usw|us-?(8|16|24|48)|us-xg|usw-flex|switch (lite|pro|enterprise|aggregation))/i)) { add('switch', 6, 'UniFi switch'); model = model || /(usw[-\w]*|us-?\d+[-\w]*)/i.exec(named)?.[1] || ''; }
  if (unifi && tn(/\b(uap|u6|u7|nanohd|flexhd|ac-?(lite|lr|pro|mesh)|in-?wall|beaconhd)/i)) add('accesspoint', 6, 'UniFi access point');
  if (tn(/\b(udm|udr|ucg|usg|uxg|udw|dream (machine|router|wall)|cloud gateway|security gateway)\b/i)) { add('router', 7, 'UniFi gateway'); os = os || 'UniFi OS'; }
  if (unifi && tn(/cloud ?key|\buck\b|unifi network application|unifi network server|unifi controller|^unifi network$/i)) add('server', 7, 'UniFi Network application');
  if (tn(/\bEAP\d{3}/i)) add('accesspoint', 6, 'Omada access point');
  if (tn(/\bER(605|707|7206|7212|8411|2260)\b|omada.*(gateway|router)/i)) add('router', 6, 'Omada gateway');
  if (tn(/\bOC(200|220|300|400)\b|omada (software )?controller|omada network/i)) add('server', 6, 'Omada controller');
  if (tn(/\b(SG|TL-SG|SX)\d{3,4}|omada.*switch/i) && /^TP-Link$/i.test(brand)) add('switch', 3, 'Omada/JetStream switch');
  if (/^MikroTik$/i.test(brand) || tn(/routeros|mikrotik/i)) {
    if (tn(/\b(CRS|CSS)\d{3}/i)) add('switch', 7, 'MikroTik switch (CRS)');
    if (tn(/\b(cAP|wAP)\b/)) add('accesspoint', 7, 'MikroTik access point');
  }
  if (tn(/instant on/i)) { if (tn(/\bAP\d{2}\b/)) add('accesspoint', 6, 'Aruba Instant On AP'); else if (tn(/\b19[3-6]0\b/)) add('switch', 6, 'Aruba Instant On switch'); }
  if (UPS_VENDORS.test(brand) || t(/\bups\b|usv|smart-ups|network management card|powerware/i)) add('ups', 5, 'UPS');

  // --- Computers and servers
  if (f.isSelf) add('server', 8, 'this server (runs WhatsOnMyNet)');
  const win = has(135, 139, 445) || f.netbios?.name;
  if (has(88) && has(389) && has(53)) { add('server', 7, 'domain controller (Kerberos, LDAP, DNS)'); os = 'Windows Server (domain controller)'; }
  if (win && has(3389)) add('computer', 3, 'Windows with remote desktop');
  else if (win) add('computer', 2, 'SMB/NetBIOS');
  if (has(22) && !has(9100) && f.ttl && f.ttl <= 64) add('server', 2, 'SSH');
  if (has(1433, 3306, 5432, 1521, 27017)) add('server', 3, 'database port');
  if (has(25, 143, 993) ) add('server', 2, 'mail server port');
  if (t(/ubuntu|debian|centos|red hat|rhel|rocky|alma|suse|linux/i) && !score.nas && !score.printer) { add('server', 2, 'Linux'); os = os || (/(ubuntu|debian|centos|rocky|alma|suse)/i.exec(text)?.[1] || 'Linux'); }
  if (t(/windows server/i)) { add('server', 4, 'Windows Server'); os = os || 'Windows Server'; }
  if (/^(Dell|Lenovo|Fujitsu|Intel|ASUS|Gigabyte|MSI|Supermicro|HP|Microsoft|Apple|Realtek)$/i.test(vendor) && win) add('computer', 2, `PC manufacturer ${vendor}`);
  if (/^Supermicro$/i.test(vendor)) add('server', 3, 'Supermicro');
  if (/^Raspberry Pi$/i.test(vendor)) { add('iot', 2, 'Raspberry Pi'); add('server', 1, 'Raspberry Pi'); }
  if (/^Apple$/i.test(vendor)) { if (has(22, 445, 5900, 548)) add('computer', 3, 'Mac'); else add('mobile', 2, 'Apple device without services'); }
  if (f.random && !ports.size) add('mobile', 3, 'private (random) MAC address');
  if (f.random && ports.size) add('computer', 1, 'private (random) MAC address');

  // --- Other devices
  if (PHONE_VENDORS.test(brand) || t(/yealink|snom|gigaset|polycom|grandstream|voip|sip phone/i)) add('phone', 5, 'VoIP phone');
  if (CAMERA_VENDORS.test(brand) || (has(554) && t(/camera|kamera|ipc|nvr|dvr|hikvision|axis|reolink|dahua/i))) add('camera', 5, 'camera');
  else if (has(554)) add('camera', 2, 'port 554 (RTSP)');
  if (IOT_VENDORS.test(brand)) add('iot', 4, `manufacturer ${brand}`);
  if (t(/home assistant|shelly|tasmota|esphome|openhab|iobroker|homematic/i)) add('iot', 4, 'smart home');
  if (MEDIA_VENDORS.test(brand) && !has(22, 445)) add('media', 2, `manufacturer ${brand}`);

  // OS family from SNMP, NetBIOS or TTL
  if (!os) {
    if (/windows/i.test(f.snmp?.descr || '')) os = 'Windows';
    else if (f.netbios?.name && f.ttl && f.ttl > 64 && f.ttl <= 128) os = 'Windows';
    else if (/linux/i.test(f.snmp?.descr || '')) os = 'Linux';
  }

  // Model from SNMP or title
  if (!model) {
    const d = String(f.snmp?.descr || '');
    if (d && d.length <= 80 && !/linux|windows|version \d/i.test(d)) model = d.split(/[;,\n]/)[0].trim();
    else {
      const title = (f.http || []).map((h) => h.title).find((x) => x && x.length <= 60 && !/^(login|index|home|welcome|anmeldung|404|error|redirect)/i.test(x));
      if (title && !score.server && !score.computer) model = title;
    }
  }

  const ranked = Object.entries(score).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  let type = ranked[0]?.[0] || 'unknown';
  const best = ranked[0]?.[1] || 0;
  const second = ranked[1]?.[1] || 0;
  // A VM that also shows what runs inside (e.g. a server): keep the more useful type
  if (type === 'vm' && second >= best - 1 && ranked[1]) type = ranked[1][0];
  // Telematik devices win as soon as there is a clear sign
  if (score.ti_terminal >= 5 && type !== 'ti_terminal') type = 'ti_terminal';
  if (score.ti_connector >= 6 && type !== 'ti_connector' && type !== 'ti_terminal') type = 'ti_connector';
  const confidence = best === 0 ? 0 : Math.min(1, Math.round((Math.min(best, 10) / 10 * 0.7 + (best - second) / Math.max(best, 1) * 0.3) * 100) / 100);

  return {
    type,
    confidence,
    os: os || (f.ttl ? ({ linux: '', windows: 'Windows', network: '' })[f.ttl <= 64 ? 'linux' : f.ttl <= 128 ? 'windows' : 'network'] : ''),
    model: model.slice(0, 120),
    telematik: isTelematik(type),
    reasons: reasons.filter((r) => r.type === type).map((r) => r.why).slice(0, 6),
  };
}

const TYPE_LABEL = {
  router: 'Router', firewall: 'Firewall', switch: 'Switch', accesspoint: 'Access point', hypervisor: 'Hypervisor', server: 'Server',
  nas: 'NAS', printer: 'Printer', computer: 'Computer', vm: 'VM', mobile: 'Mobile', phone: 'Phone', camera: 'Camera', ups: 'UPS',
  iot: 'IoT', media: 'Media', ti_connector: 'TI connector', ti_terminal: 'Card terminal', unknown: 'Device',
};

/** A sensible name to start with: hostname, NetBIOS or SNMP name, otherwise type + manufacturer + last octet. */
export function suggestName(r) {
  const host = String(r.hostname || '').split('.')[0];
  if (host && !/^(localhost|unknown|android-[0-9a-f]+|\d+-\d+-\d+-\d+)$/i.test(host)) return host.slice(0, 80);
  if (r.facts?.netbios?.name) return r.facts.netbios.name.slice(0, 80);
  if (r.facts?.snmp?.name) return r.facts.snmp.name.slice(0, 80);
  const last = String(r.ip || '').split('.').pop();
  // A model name (from the web interface or SNMP) is name enough; manufacturer or type get the last octet
  if (r.model) return String(r.model).slice(0, 80);
  const kind = r.vendor || TYPE_LABEL[r.detected_type || r.type] || 'Device';
  return `${kind} .${last}`.slice(0, 80);
}
