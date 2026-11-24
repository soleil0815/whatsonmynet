// Which addresses a user who is not an administrator may make the server contact (monitors, device addresses). The
// boundary is what lies inside - the WhatsOnMyNet host itself and internal networks the user may not reach - and the
// stored SNMP access data. The internet as such is no boundary (a monitor on https://www.example.com is fine).
//   - never: the host itself (127.x, ::1), link-local (169.254.x, fe80::/10), 0.x and ::, also as ::ffff:x.x.x.x;
//   - editors without a location limit: everything else;
//   - users limited to locations: public addresses; private ones (and multicast/reserved) only inside the subnets of
//     their locations - when their locations have no subnets at all, the private ranges (the address cannot tell);
//   - SNMP monitors (they send the stored communities and v3 users): only private ranges and location subnets; for a
//     user limited to locations only the subnets of his locations (no subnets: the private ranges).
// Host names are resolved when saved. With IPv4 answers those decide (each must pass) and the IPv6 answers only must not
// be one of the "never" addresses (dual stack with global IPv6); with IPv6 answers only, each must pass (unique local
// fc00::/7 counts as private). The check itself resolves again later: a name whose owner changes its DNS answer
// afterwards is not caught - see README.
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './http.js';
import { cidrContains, cidrCovers, isPrivateCidr } from './net.js';
import { scopeOf } from '../auth/scope.js';

const NEVER_V4 = ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8'];
// neither private nor public: multicast and reserved (with the broadcast address)
const SPECIAL_V4 = ['224.0.0.0/4', '240.0.0.0/4'];
const LOOKUP_MS = 3000;

const systemLookup = (host) => dns.lookup(host, { all: true, verbatim: true });
let lookup = systemLookup;
/** Tests: answer names without a DNS server (fn(host) → [{ address, family }]); null restores the system resolver */
export function setLookupForTests(fn) { lookup = fn || systemLookup; }

/** The rule of a user: null for administrators (no limit), else { subnets, scoped } */
export function targetRule(db, user) {
  if (!user || user.role === 'admin') return null;
  const scope = scopeOf(db, user);
  const rows = db.prepare('SELECT cidr, location_id FROM subnets').all();
  return { scoped: !!scope, subnets: rows.filter((r) => !scope || scope.has(r.location_id)).map((r) => r.cidr) };
}

/** An address to compare: { v: 4, a: dotted } (also from ::ffff:…) or { v: 6, a: canonical lower case }; null if none */
function normalize(ip) {
  const a = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return { v: 4, a };
  if (!net.isIPv6(a) || a.includes('%')) return null;
  let c;
  try { c = new URL(`http://[${a}]/`).hostname.replace(/^\[|\]$/g, ''); } catch { return null; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(c);
  if (mapped) {
    const hi = parseInt(mapped[1], 16); const lo = parseInt(mapped[2], 16);
    return { v: 4, a: [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.') };
  }
  return { v: 6, a: c };
}

/** Never for a non-admin: the host itself, link-local, the "any" address (also IPv4-mapped) - and anything unparsable */
export function addressNever(ip) {
  const n = normalize(ip);
  if (!n) return true;
  if (n.v === 4) return NEVER_V4.some((c) => cidrContains(c, n.a));
  return n.a === '::1' || n.a === '::' || /^fe[89ab][0-9a-f]:/.test(n.a);
}

/** May an address (IPv4 or IPv6 literal) be contacted under this rule? snmp: the stored SNMP access data go there */
export function addressAllowed(ip, rule, { snmp = false } = {}) {
  if (!rule) return true;
  if (addressNever(ip)) return false;
  const n = normalize(ip);
  // location subnets are IPv4
  const inSubnets = n.v === 4 && rule.subnets.some((s) => cidrCovers(s, n.a));
  const priv = n.v === 4 ? isPrivateCidr(n.a) : /^f[cd][0-9a-f]{0,2}:/.test(n.a);
  const special = n.v === 4 ? SPECIAL_V4.some((c) => cidrContains(c, n.a)) : /^ff[0-9a-f]{0,2}:/.test(n.a);
  // limited to locations without any subnet: the address cannot be matched to them, the private ranges count instead
  const fallback = rule.scoped && !rule.subnets.length;
  if (snmp) return rule.scoped ? (fallback ? priv : inSubnets) : (priv || inSubnets);
  if (!rule.scoped || (!priv && !special)) return true;
  return fallback ? priv : inSubnets;
}

/** The answers for one name together: the IPv4 ones decide when there are any (IPv6 then only not "never"), else IPv6 */
export function addressesAllowed(addrs, rule, opts = {}) {
  if (!rule) return true;
  const v4 = addrs.filter((a) => normalize(a)?.v === 4);
  if (!v4.length) return addrs.length > 0 && addrs.every((a) => addressAllowed(a, rule, opts));
  return v4.every((a) => addressAllowed(a, rule, opts)) && addrs.every((a) => !addressNever(a));
}

/**
 * Throws 403 unless every host (IP literal or name) is allowed for this user. Names are resolved now; a name that does
 * not resolve cannot be checked and is refused. snmp: an SNMP monitor (the stored access data go there).
 */
export async function assertTargetsAllowed(db, user, hosts, { snmp = false } = {}) {
  const rule = targetRule(db, user);
  if (!rule) return;
  for (const raw of hosts) {
    const host = String(raw || '').trim().replace(/^\[|\]$/g, '');
    if (!host) continue;
    let addrs;
    if (net.isIP(host)) addrs = [host];
    else {
      try {
        const list = await Promise.race([lookup(host),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), LOOKUP_MS).unref())]);
        addrs = list.map((x) => x.address);
      } catch { addrs = []; }
      if (!addrs.length) throw new HttpError(403, 'err.monitorTargetDns', host.slice(0, 80));
    }
    if (!addressesAllowed(addrs, rule, { snmp })) throw new HttpError(403, 'err.monitorTarget', host.slice(0, 80));
  }
}
