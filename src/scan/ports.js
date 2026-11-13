// Port lists. The normal scan only checks a short, fixed list of typical ports - enough to recognise
// servers, NAS, printers, switches and Telematik devices without looking like an attack.

/** Gentle scan (default): 26 ports */
export const GENTLE_PORTS = [
  22, 23, 53, 80, 88, 135, 139, 389, 443, 445, 515, 554, 631, 902, 3389,
  4742, 5000, 5001, 5900, 8006, 8007, 8080, 8291, 8443, 9100, 9443,
];

/** Deep check of a single device (started by hand) */
export const DEEP_PORTS = [...new Set([
  ...GENTLE_PORTS,
  20, 21, 25, 81, 110, 111, 119, 143, 161, 179, 199, 264, 427, 465, 500, 548, 587, 593, 636, 873, 993, 995,
  1080, 1194, 1433, 1521, 1723, 1883, 1900, 2000, 2049, 2082, 2083, 2222, 2375, 2376, 3000, 3128, 3260, 3268,
  3306, 3478, 4000, 4443, 4444, 5060, 5061, 5432, 5555, 5601, 5666, 5985, 5986, 6379, 6443, 6789, 7070, 7443,
  8000, 8008, 8009, 8081, 8088, 8123, 8181, 8200, 8291, 8333, 8834, 8880, 8888, 9000, 9001, 9090, 9091, 9200,
  9300, 9418, 10000, 10050, 10051, 11211, 27017, 32400, 49152,
])].sort((a, b) => a - b);

/** Ports used to find hosts in routed subnets (no ARP there) */
export const DISCOVERY_PORTS = [443, 80, 22, 445, 3389];

/** Web interfaces: port → protocol */
export const WEB_PORTS = new Map([
  [80, 'http'], [81, 'http'], [443, 'https'], [5000, 'http'], [5001, 'https'], [8000, 'http'], [8006, 'https'],
  [8007, 'https'], [8080, 'http'], [8081, 'http'], [8088, 'http'], [8123, 'http'], [8443, 'https'], [8880, 'http'],
  [8888, 'http'], [9000, 'http'], [9090, 'https'], [9443, 'https'], [10000, 'https'], [7443, 'https'], [4443, 'https'],
  [3000, 'http'], [631, 'http'],
]);

// Shown as they are in both languages: protocol and product names only, no English words
export const SERVICE_NAMES = {
  20: 'FTP-Data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 81: 'HTTP', 88: 'Kerberos',
  110: 'POP3', 111: 'RPC', 119: 'NNTP', 135: 'MS RPC', 139: 'NetBIOS', 143: 'IMAP', 161: 'SNMP', 179: 'BGP',
  389: 'LDAP', 427: 'SLP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 500: 'IKE', 515: 'LPD', 548: 'AFP', 554: 'RTSP',
  587: 'SMTP Submission', 631: 'IPP', 636: 'LDAPS', 873: 'rsync', 902: 'VMware', 993: 'IMAPS', 995: 'POP3S',
  1433: 'MS SQL', 1521: 'Oracle', 1723: 'PPTP', 1883: 'MQTT', 1900: 'UPnP', 2049: 'NFS', 2375: 'Docker',
  2376: 'Docker TLS', 3000: 'HTTP', 3128: 'Proxy', 3260: 'iSCSI', 3268: 'Global Catalog', 3306: 'MySQL/MariaDB',
  3389: 'RDP', 4742: 'SICCT', 5000: 'HTTP (Synology)', 5001: 'HTTPS (Synology)', 5060: 'SIP',
  5061: 'SIP TLS', 5432: 'PostgreSQL', 5900: 'VNC', 5985: 'WinRM', 5986: 'WinRM TLS', 6379: 'Redis',
  6443: 'Kubernetes', 8006: 'Proxmox VE', 8007: 'Proxmox Backup', 8080: 'HTTP', 8081: 'HTTP',
  8123: 'Home Assistant', 8291: 'MikroTik Winbox', 8443: 'HTTPS', 9000: 'HTTP', 9090: 'Cockpit',
  9100: 'JetDirect', 9200: 'Elasticsearch', 9443: 'HTTPS', 10000: 'Webmin', 10050: 'Zabbix',
  11211: 'Memcached', 27017: 'MongoDB', 32400: 'Plex',
};
