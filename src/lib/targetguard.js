// Which addresses a user who is not an administrator may make the server contact (monitors, device addresses): the same
// rule as for scans - private ranges and the subnets of the locations; a user limited to locations only the subnets of
// his locations. Never the WhatsOnMyNet host itself (127.x, ::1), link-local (169.254.x) or 0.x. Host names are resolved
// when saved and every address they resolve to must be allowed (the check itself resolves again later: a name whose
// owner changes its DNS answer afterwards is not caught - see README).
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './http.js';
import { cidrContains, cidrCovers, scanTargetAllowed } from './net.js';
import { scopeOf } from '../auth/scope.js';

const NEVER = ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8'];
const LOOKUP_MS = 3000;

/** The rule of a user: null for administrators (no limit), else { subnets, scoped } */
export function targetRule(db, user) {
  if (!user || user.role === 'admin') return null;
  const scope = scopeOf(db, user);
  const rows = db.prepare('SELECT cidr, location_id FROM subnets').all();
  return { scoped: !!scope, subnets: rows.filter((r) => !scope || scope.has(r.location_id)).map((r) => r.cidr) };
}

/** May an address (IPv4 or IPv6 literal) be contacted under this rule? */
export function addressAllowed(ip, rule) {
  if (!rule) return true;
  let a = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    if (NEVER.some((c) => cidrContains(c, a))) return false;
    return rule.scoped ? rule.subnets.some((s) => cidrCovers(s, a)) : scanTargetAllowed(a, rule.subnets);
  }
  // IPv6: only unique local addresses (fc00::/7, the private range of IPv6), and not for users limited to locations
  // (their subnets are IPv4)
  if (net.isIPv6(a)) return !rule.scoped && /^f[cd][0-9a-f]{0,2}:/i.test(a);
  return false;
}

/**
 * Throws 403 unless every host (IP literal or name) is allowed for this user. Names are resolved now; a name that does
 * not resolve cannot be checked and is refused.
 */
export async function assertTargetsAllowed(db, user, hosts) {
  const rule = targetRule(db, user);
  if (!rule) return;
  for (const raw of hosts) {
    const host = String(raw || '').trim().replace(/^\[|\]$/g, '');
    if (!host) continue;
    let addrs;
    if (net.isIP(host)) addrs = [host];
    else {
      try {
        const list = await Promise.race([dns.lookup(host, { all: true, verbatim: true }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), LOOKUP_MS).unref())]);
        addrs = list.map((x) => x.address);
      } catch { addrs = []; }
      if (!addrs.length) throw new HttpError(403, 'err.monitorTargetDns', host.slice(0, 80));
    }
    if (!addrs.every((a) => addressAllowed(a, rule))) throw new HttpError(403, 'err.monitorTarget', host.slice(0, 80));
  }
}
