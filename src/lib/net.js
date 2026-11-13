// IPv4 and MAC helpers: subnets (CIDR), addresses, the host's own interfaces and gateway.
import fs from 'node:fs';
import os from 'node:os';

// Largest subnet a single scan may cover (/20 = 4094 hosts) - larger ranges are split by the admin.
export const MAX_PREFIX_HOSTS = 4094;

export function ipToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255) || m.slice(1).some((p) => p.length > 1 && p.startsWith('0'))) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export const isIPv4 = (ip) => ipToInt(ip) !== null;

/**
 * Parses "192.168.1.0/24" (or a single address = /32). The network address is normalised
 * ("192.168.1.17/24" → 192.168.1.0/24). Returns null if invalid.
 */
export function parseCidr(input) {
  const s = String(input || '').trim();
  const [ip, bits = '32', ...rest] = s.split('/');
  if (rest.length || !/^\d{1,2}$/.test(bits)) return null;
  const n = ipToInt(ip);
  const prefix = Number(bits);
  if (n === null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (n & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  // Usable hosts: without network and broadcast address (except /31 and /32)
  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? network + size - 1 : network + size - 2;
  return { cidr: `${intToIp(network)}/${prefix}`, network, prefix, mask, first, last, hosts: last - first + 1 };
}

export function cidrContains(cidr, ip) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const n = ipToInt(ip);
  return !!c && n !== null && ((n & c.mask) >>> 0) === c.network;
}

export function* hostsOf(cidr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!c) return;
  for (let n = c.first; n <= c.last; n++) yield intToIp(n);
}

/** aa:bb:cc:dd:ee:ff (lower case) or null - accepts -, :, . and no separators */
export function normalizeMac(mac) {
  const hex = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || hex === '000000000000' || hex === 'ffffffffffff') return null;
  return hex.match(/../g).join(':');
}

/** Randomised ("private") MAC addresses of phones and laptops: locally administered bit set */
export function isRandomMac(mac) {
  const m = normalizeMac(mac);
  return !!m && (Number.parseInt(m.slice(0, 2), 16) & 0x02) === 0x02;
}

/** IPv4 interfaces of this host (with network_mode: host these are the host's interfaces). */
export function localInterfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const c = parseCidr(a.cidr || `${a.address}/32`);
      if (!c) continue;
      out.push({ name, address: a.address, mac: normalizeMac(a.mac), cidr: c.cidr, prefix: c.prefix,
        // Container or virtual bridges: not offered as scan suggestion first
        virtual: /^(docker|br-|veth|virbr|cni|flannel|cali|vxlan|tailscale|zt|wg|tun|tap|lxc)/i.test(name) });
    }
  }
  return out;
}

/** Default gateways from the routing table (IPv4). */
export function defaultGateways(file = '/proc/net/route') {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(1).map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length > 3 && p[1] === '00000000' && p[2] !== '00000000')
      .map((p) => {
        // little-endian hex
        const h = p[2];
        return [h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((x) => Number.parseInt(x, 16)).join('.');
      });
  } catch { return []; }
}

/** ARP/neighbour table of the kernel: Map ip → mac (only complete entries). */
export function readArpTable(file = '/proc/net/arp') {
  const map = new Map();
  try {
    for (const l of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
      const p = l.trim().split(/\s+/);
      if (p.length < 4) continue;
      // Flags 0x2 = complete; 0x0 = no answer
      if ((Number.parseInt(p[2], 16) & 0x2) !== 0x2) continue;
      const mac = normalizeMac(p[3]);
      if (mac && isIPv4(p[0])) map.set(p[0], mac);
    }
  } catch { /* not Linux or no /proc */ }
  return map;
}

/** Sort key for IP addresses (numeric). */
export function ipSortKey(ip) {
  const n = ipToInt(ip);
  return n === null ? Number.MAX_SAFE_INTEGER : n;
}
