// Ports between two polls (switches, NAS and routers by SNMP, network cards of machines with the host script).

/**
 * Load of the ports between two polls, from the 64-bit byte counters (ifHCIn/OutOctets, or the byte counters of a
 * network card reported by a host script): bit/s in and out, in percent of the port speed, and the errors that came
 * up in between (newErrors). Only when the previous poll is 30 s to 6 h old and the switch was not restarted in
 * between (counters start at 0 again) - otherwise no value this time rather than a wrong one.
 * Changes `data.ports` in place.
 */
export function portRates(prevData, prevAt, data, at) {
  if (!prevData?.ports?.length || !data?.ports?.length) return data;
  const dt = (Date.parse(at) - Date.parse(prevAt)) / 1000;
  if (!(dt >= 30 && dt <= 6 * 3600)) return data;
  if (data.uptime && prevData.uptime && data.uptime < prevData.uptime) return data;
  const before = new Map(prevData.ports.map((p) => [p.ifIndex, p]));
  const pct = (bps, mbit) => Math.min(100, Math.round((bps / (mbit * 1e6)) * 1000) / 10);
  for (const p of data.ports) {
    const q = before.get(p.ifIndex);
    // new errors since the last poll (in, and out where both polls have it): a bad cable or port shows here first.
    // A counter that went back (port reset) gives no value this time.
    if (q && Number.isFinite(p.inErrors) && Number.isFinite(q.inErrors)) {
      const both = Number.isFinite(p.outErrors) && Number.isFinite(q.outErrors);
      const e = (p.inErrors - q.inErrors) + (both ? p.outErrors - q.outErrors : 0);
      if (p.inErrors >= q.inErrors && (!both || p.outErrors >= q.outErrors)) p.newErrors = e;
    }
    if (!q || [p.inOctets, p.outOctets, q.inOctets, q.outOctets].some((x) => x === null || x === undefined || !Number.isFinite(x))) continue;
    const dIn = p.inOctets - q.inOctets; const dOut = p.outOctets - q.outOctets;
    // a counter that went back: reset of the port or its module - no value this time
    if (dIn < 0 || dOut < 0) continue;
    p.inBps = Math.round((dIn * 8) / dt);
    p.outBps = Math.round((dOut * 8) / dt);
    if (p.speed > 0) {
      p.inPct = pct(p.inBps, p.speed);
      p.outPct = pct(p.outBps, p.speed);
      p.loadPct = Math.max(p.inPct, p.outPct);
    }
  }
  data.rateSeconds = Math.round(dt);
  return data;
}

