// Manufacturer from the MAC address (IEEE registry, package oui-data – updated by Dependabot).
import { createRequire } from 'node:module';
import { normalizeMac, isRandomMac } from '../lib/net.js';

const require = createRequire(import.meta.url);
let table = null;

// Long legal names → the name people know
const SHORT = [
  [/^Proxmox Server Solutions/i, 'Proxmox'],
  [/^Synology/i, 'Synology'],
  [/^QNAP/i, 'QNAP'],
  [/^TP-?LINK/i, 'TP-Link'],
  [/^AVM Audiovisuelles/i, 'AVM'],
  [/^LANCOM/i, 'LANCOM'],
  [/^Hewlett[ -]Packard Enterprise/i, 'HPE'],
  [/^(Hewlett[ -]Packard|HP Inc)/i, 'HP'],
  [/^Brother Industries/i, 'Brother'],
  [/^KYOCERA/i, 'Kyocera'],
  [/^Canon/i, 'Canon'],
  [/^Seiko Epson/i, 'Epson'],
  [/^Ricoh/i, 'Ricoh'],
  [/^Xerox/i, 'Xerox'],
  [/^Lexmark/i, 'Lexmark'],
  [/^KONICA MINOLTA/i, 'Konica Minolta'],
  [/^Sharp/i, 'Sharp'],
  [/^Raspberry Pi/i, 'Raspberry Pi'],
  [/^Microsoft/i, 'Microsoft'],
  [/^VMware/i, 'VMware'],
  [/^Apple/i, 'Apple'],
  [/^Samsung/i, 'Samsung'],
  [/^Intel Corporate/i, 'Intel'],
  [/^Dell/i, 'Dell'],
  [/^Lenovo/i, 'Lenovo'],
  [/^Fujitsu/i, 'Fujitsu'],
  [/^Cisco/i, 'Cisco'],
  [/^Ubiquiti/i, 'Ubiquiti'],
  [/^Routerboard|^MikroTik/i, 'MikroTik'],
  [/^NETGEAR/i, 'Netgear'],
  [/^D-Link/i, 'D-Link'],
  [/^Zyxel/i, 'Zyxel'],
  [/^Juniper/i, 'Juniper'],
  [/^Fortinet/i, 'Fortinet'],
  [/^Sophos/i, 'Sophos'],
  [/^Super Micro/i, 'Supermicro'],
  [/^Realtek/i, 'Realtek'],
  [/^ASUSTek/i, 'ASUS'],
  [/^Giga-Byte/i, 'Gigabyte'],
  [/^Micro-Star/i, 'MSI'],
  [/^American Power Conversion|^Schneider Electric/i, 'APC'],
  [/^Eaton/i, 'Eaton'],
  [/^Hikvision|^Hangzhou Hikvision/i, 'Hikvision'],
  [/^Axis Communications/i, 'Axis'],
  [/^Yealink/i, 'Yealink'],
  [/^Gigaset/i, 'Gigaset'],
  [/^snom/i, 'Snom'],
  [/^Unify/i, 'Unify'],
  [/^secunet/i, 'secunet'],
  [/^Ingenico/i, 'Ingenico'],
  [/^CHERRY/i, 'Cherry'],
  [/^Shelly|^Allterco/i, 'Shelly'],
  [/^Espressif/i, 'Espressif'],
  [/^Sonos/i, 'Sonos'],
  [/^Google/i, 'Google'],
  [/^Amazon/i, 'Amazon'],
];

function load() {
  if (!table) table = require('oui-data');
  return table;
}

export function shortVendor(name) {
  const n = String(name || '').trim();
  for (const [re, short] of SHORT) if (re.test(n)) return short;
  return n.replace(/[,.]?\s+(Inc|Corp|Corporation|Co|Ltd|LTD|Limited|GmbH|AG|S\.?A|B\.?V|LLC|Technologies|Technology|Electronics)\.?\b.*$/i, '').trim() || n;
}

/**
 * { vendor, vendorFull, random } – the longest registered prefix wins (MA-S 36 bit, MA-M 28 bit, MA-L 24 bit).
 * Randomised MAC addresses (phones, laptops with "private address") have no manufacturer.
 */
export function lookupVendor(mac) {
  const m = normalizeMac(mac);
  if (!m) return { vendor: '', vendorFull: '', random: false };
  // QEMU/KVM default prefix (locally administered, but always a virtual machine)
  if (m.startsWith('52:54:00')) return { vendor: 'QEMU/KVM', vendorFull: 'QEMU/KVM virtual network card', random: false };
  if (isRandomMac(m)) return { vendor: '', vendorFull: '', random: true };
  const hex = m.replace(/:/g, '').toUpperCase();
  const t = load();
  const full = (t[hex.slice(0, 9)] || t[hex.slice(0, 7)] || t[hex.slice(0, 6)] || '').split('\n')[0].trim();
  return { vendor: shortVendor(full), vendorFull: full, random: false };
}
