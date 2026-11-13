// MAC addresses of routed subnets: ARP is only seen inside a subnet, but the router of that subnet knows every
// device. Its ARP table is read via SNMP (IP-MIB ipNetToMedia / ipNetToPhysical) - read-only.
import { openSnmp, walk } from './snmpwalk.js';
import { normalizeMac } from '../lib/net.js';

const NET_TO_MEDIA = '1.3.6.1.2.1.4.22.1.2';      // .<ifIndex>.<a.b.c.d> → MAC
const NET_TO_PHYSICAL = '1.3.6.1.2.1.4.35.1.4';   // .<ifIndex>.1.4.<a.b.c.d> → MAC (IPv4)

const macOf = (v) => (Buffer.isBuffer(v) && v.length === 6 ? normalizeMac(v.toString('hex')) : null);

/** Map ip → mac from the two tables (raw walk results) */
export function parseArp(media, physical = new Map()) {
  const out = new Map();
  for (const [suffix, v] of media) {
    const p = suffix.split('.');
    if (p.length !== 5) continue;
    const mac = macOf(v);
    if (mac) out.set(p.slice(1).join('.'), mac);
  }
  for (const [suffix, v] of physical) {
    const p = suffix.split('.');
    // ifIndex . addressType(1 = IPv4) . length(4) . a.b.c.d
    if (p.length !== 7 || p[1] !== '1' || p[2] !== '4') continue;
    const mac = macOf(v);
    const ip = p.slice(3).join('.');
    if (mac && !out.has(ip)) out.set(ip, mac);
  }
  return out;
}

export async function readRouterArp(ip, communities, { port = 161 } = {}) {
  const s = await openSnmp(ip, communities, { port });
  if (!s) return new Map();
  try {
    const [media, physical] = await Promise.all([walk(s, NET_TO_MEDIA, { max: 20000, timeout: 20000 }), walk(s, NET_TO_PHYSICAL, { max: 20000, timeout: 20000 })]);
    return parseArp(media, physical);
  } finally { s.close(); }
}
