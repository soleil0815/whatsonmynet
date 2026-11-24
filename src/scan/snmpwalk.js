// Read-only SNMP helpers for the device pollers (printers, later switches and NAS): open a session with the first
// community that answers, read single values and whole tables. Only GET/GETNEXT/GETBULK - never SET.
import snmp from 'net-snmp';
import { orderFor, rememberAccess, v3Session, accessLabel } from '../snmpcreds.js';

const SYS_DESCR = '1.3.6.1.2.1.1.1.0';

function tryGet(session, oids, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    session.get(oids, (err, vbs) => end({ vbs: err || !vbs ? null : vbs, silent: !!err && err instanceof snmp.RequestTimedOutError }));
    setTimeout(() => end({ vbs: null, silent: true }), timeout + 500).unref();
  });
}

/**
 * Opens a session with the first access that answers: communities (v2c, then v1), then SNMPv3 users. The access that
 * worked last time for this device is tried first. A device silent to v3 (no answer to the engine discovery) is not
 * asked again with every other user.
 * Returns { session, version, access, close() } or null. Community and keys never leave this module.
 */
export async function openSnmp(ip, communities = ['public'], { timeout = 1500, port = 161 } = {}) {
  let v3Silent = false;
  for (const c of orderFor(ip, communities)) {
    const tries = typeof c === 'string' ? [[snmp.Version2c, '2c'], [snmp.Version1, '1']] : [[null, '3']];
    for (const [version, label] of tries) {
      if (label === '3' && v3Silent) continue;
      let session;
      try { session = label === '3' ? v3Session(ip, c, { timeout, retries: 1, port }) : snmp.createSession(ip, c, { version, timeout, retries: 1, port }); } catch { continue; }
      session.on('error', () => {});
      const r = await tryGet(session, [SYS_DESCR], timeout);
      if (r.vbs && !snmp.isVarbindError(r.vbs[0])) {
        rememberAccess(ip, c);
        return { session, version: label, access: accessLabel(c, label), close: () => { try { session.close(); } catch { /* closed */ } } };
      }
      // silent to v3 altogether: not even the engine discovery got an answer (a device that knows v3 but drops an
      // unknown user without a report still gets asked with the next user)
      if (label === '3' && r.silent && !session.msgSecurityParameters) v3Silent = true;
      try { session.close(); } catch { /* closed */ }
    }
  }
  return null;
}

/** Plain JS value of a varbind (Buffer → text, Counter64 → number) */
export function vbValue(vb) {
  const v = vb.value;
  if (Buffer.isBuffer(v)) {
    if (vb.type === snmp.ObjectType.Counter64) return Number(BigInt(`0x${v.toString('hex') || '0'}`));
    return v;
  }
  return v;
}

/** Text from an OctetString: printable characters only, trimmed */
export function text(v, max = 200) {
  if (v === null || v === undefined) return '';
  const s = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** GET of several OIDs → { oid: value } (missing ones left out) */
export function getValues(s, oids, timeout = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    s.session.get(oids, (err, vbs) => {
      if (err || !vbs) {
        // v1 agents fail the whole request when one OID is missing: ask one by one
        if (oids.length > 1) {
          Promise.all(oids.map((o) => getValues(s, [o], timeout))).then((parts) => end(Object.assign({}, ...parts)));
          return;
        }
        return end({});
      }
      const out = {};
      for (const vb of vbs) if (!snmp.isVarbindError(vb)) out[vb.oid] = vbValue(vb);
      end(out);
    });
    setTimeout(() => end({}), timeout * 3).unref();
  });
}

/**
 * Walks a subtree → Map(oid suffix after `base` → value). Stops after `max` rows (protects against broken agents).
 * map.complete: false when the walk ended on an error or the timeout - the table may lack rows then (a busy NAS
 * answers late), which the poller must not take for "the disk is gone".
 */
export function walk(s, base, { max = 2000, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const out = new Map();
    out.complete = false;
    let done = false;
    const end = (complete = false) => { if (!done) { done = true; out.complete = complete; resolve(out); } };
    const prefix = `${base}.`;
    const seen = new Set();
    const feed = (vbs) => {
      // ended already (timeout): returning true tells net-snmp to stop asking - otherwise it would keep sending GETBULKs
      if (done) return true;
      for (const vb of vbs) {
        // end of the table: past its end, "no such object" or end of the MIB. Some agents answer a GETBULK past the end
        // of their MIB with an OID they gave before (the asked one again, or going back and forth) - net-snmp would then
        // ask in a loop until the time runs out (load on the device and on WhatsOnMyNet), so any repeated OID ends the
        // walk too (a correct agent never repeats one: the OIDs of a walk only grow).
        if (snmp.isVarbindError(vb) || !vb.oid.startsWith(prefix) || seen.has(vb.oid)) { end(true); return true; }
        seen.add(vb.oid);
        out.set(vb.oid.slice(prefix.length), vbValue(vb));
        if (out.size >= max) { end(true); return true; }
      }
      return false;
    };
    try {
      s.session.subtree(base, 20, feed, (err) => end(!err));
    } catch { end(false); }
    setTimeout(() => end(false), timeout).unref();
  });
}
