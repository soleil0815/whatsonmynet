// One bar for a group of monitors (list "by group", like Uptime Kuma) - without the page, so the tests can use it.

/**
 * The time is cut into `slots` pieces as long as the slowest member's interval (1 to 60 minutes). Each piece:
 * { at, ok: checks that were fine, bad: names of the members that failed in it }. Oldest first.
 */
export function groupSlots(members, slots = 40, now = Date.now()) {
  const step = Math.min(3600, Math.max(60, ...members.map((m) => Number(m.interval_s) || 60))) * 1000;
  const start = now - slots * step;
  const bins = Array.from({ length: slots }, (_, i) => ({ at: new Date(start + i * step).toISOString(), ok: 0, bad: [] }));
  for (const m of members) {
    for (const b of m.beats || []) {
      const i = Math.floor((Date.parse(b.at) - start) / step);
      if (!(i >= 0 && i < slots)) continue;
      if (b.ok) bins[i].ok++; else if (!bins[i].bad.includes(m.name)) bins[i].bad.push(m.name);
    }
  }
  return bins;
}
