// Read-only SNMP helpers for the device pollers (printers, later switches and NAS): open a session with the first
// community that answers, read single values and whole tables. Only GET/GETNEXT/GETBULK – never SET.
import snmp from 'net-snmp';

const SYS_DESCR = '1.3.6.1.2.1.1.1.0';

function tryGet(session, oids, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    session.get(oids, (err, vbs) => end(err || !vbs ? null : vbs));
    setTimeout(() => end(null), timeout + 500).unref();
  });
}

/**
 * Opens a session with the first community that answers (v2c, then v1).
 * Returns { session, version, close() } or null. The community never leaves this module.
 */
export async function openSnmp(ip, communities = ['public'], { timeout = 1500, port = 161 } = {}) {
  for (const c of communities) {
    for (const version of [snmp.Version2c, snmp.Version1]) {
      let session;
      try { session = snmp.createSession(ip, c, { version, timeout, retries: 1, port }); } catch { continue; }
      session.on('error', () => {});
      const vbs = await tryGet(session, [SYS_DESCR], timeout);
      if (vbs && !snmp.isVarbindError(vbs[0])) {
        return { session, version: version === snmp.Version2c ? '2c' : '1', close: () => { try { session.close(); } catch { /* closed */ } } };
      }
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
 */
export function walk(s, base, { max = 2000, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const out = new Map();
    let done = false;
    const end = () => { if (!done) { done = true; resolve(out); } };
    const prefix = `${base}.`;
    const feed = (vbs) => {
      for (const vb of vbs) {
        if (snmp.isVarbindError(vb) || !vb.oid.startsWith(prefix)) continue;
        out.set(vb.oid.slice(prefix.length), vbValue(vb));
        if (out.size >= max) { end(); return true; }
      }
      return false;
    };
    try {
      s.session.subtree(base, 20, feed, () => end());
    } catch { end(); }
    setTimeout(end, timeout).unref();
  });
}
