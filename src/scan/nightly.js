// Nightly light scan and the notice about unknown devices.
//
// Once a night (setting "lightscan.time", local time) all subnets of all locations are scanned lightly: only ARP,
// NetBIOS and ping – no ports, no SNMP. Known devices get their new IP. Devices seen for the very first time are
// reported once through the notification channels; after that they wait in the scan result (adopt or ignore).
import { log } from '../lib/log.js';

const WINDOW_MIN = 4 * 60;   // still start up to 4 hours after the set time (e.g. after a restart)
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const validTime = (s) => TIME_RE.test(String(s || ''));

const pad = (n) => String(n).padStart(2, '0');
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Is `now` inside the start window of today's run that has not run yet? */
export function isDue(now, time, lastRun) {
  const m = TIME_RE.exec(time || '');
  if (!m) return false;
  if (lastRun === localDay(now)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const diff = minutes - start;
  return diff >= 0 && diff < WINDOW_MIN;
}

export function createNightly({ db, settings, scanner, channels }) {
  let timer = null;

  function targets() {
    return db.prepare('SELECT cidr, location_id FROM subnets ORDER BY cidr').all().map((s) => ({ cidr: s.cidr, locationId: s.location_id }));
  }

  function run(user = 'nightly') {
    const list = targets();
    if (!list.length) return null;
    return scanner.startLight(list, user);
  }

  function tick(now = new Date()) {
    if (!settings.get('lightscan.enabled')) return;
    if (!isDue(now, settings.get('lightscan.time'), settings.get('lightscan.lastRun'))) return;
    if (scanner.isRunning()) return; // try again next minute
    if (!targets().length) return;
    settings.set('lightscan.lastRun', localDay(now));
    try {
      const id = run();
      log.info(`Nightly light scan started (scan ${id})`);
    } catch (e) { log.warn(`Nightly light scan could not start: ${e.message}`); }
  }

  /**
   * After every network or light scan: remember all devices that are not in the inventory. Those seen for the first
   * time ever are reported (only after light scans – a manual scan shows them on screen anyway).
   */
  async function afterScan({ id, kind, status }) {
    if (!['network', 'light'].includes(kind) || status === 'failed') return [];
    const rows = db.prepare("SELECT ip, mac, vendor, hostname FROM scan_results WHERE scan_id=? AND status='new'").all(id);
    const ts = new Date().toISOString();
    // The very first scan after the update only learns what is already there – no flood of "new" devices
    const baseline = !settings.get('lightscan.baseline');
    if (baseline) settings.set('lightscan.baseline', true);
    const fresh = [];
    const getS = db.prepare('SELECT key FROM sightings WHERE key=?');
    const ins = db.prepare('INSERT INTO sightings(key,ip,mac,vendor,first_seen,last_seen) VALUES(?,?,?,?,?,?)');
    const upd = db.prepare('UPDATE sightings SET ip=?, vendor=?, last_seen=? WHERE key=?');
    db.transaction(() => {
      for (const r of rows) {
        const key = r.mac || `ip:${r.ip}`;
        if (getS.get(key)) { upd.run(r.ip, r.vendor || '', ts, key); continue; }
        ins.run(key, r.ip, r.mac || null, r.vendor || '', ts, ts);
        fresh.push({ key, ...r });
      }
    })();
    if (baseline || kind !== 'light' || !fresh.length || !settings.get('lightscan.notify')) return fresh;
    const devices = fresh.map((r) => ({ ip: r.ip, mac: r.mac || '', vendor: r.vendor || '', hostname: r.hostname || '' }));
    const reached = await channels.notifyIds(settings.get('lightscan.channels'), { kind: 'newDevices', devices, scanId: id, at: ts });
    if (reached.length) {
      const mark = db.prepare('UPDATE sightings SET notified_at=? WHERE key=?');
      for (const r of fresh) mark.run(ts, r.key);
    }
    log.info(`Light scan ${id}: ${fresh.length} new device(s)${reached.length ? `, reported via ${reached.join(', ')}` : ''}`);
    return fresh;
  }

  scanner.onFinished(afterScan);

  return {
    run,
    tick,
    afterScan,
    start() { if (!timer) { timer = setInterval(() => { try { tick(); } catch (e) { log.warn(`Nightly check: ${e.message}`); } }, 60 * 1000); timer.unref(); } },
    stop() { clearInterval(timer); timer = null; },
    /** Daily: forget devices not seen for a year (phones with changing private MAC addresses pile up otherwise) */
    cleanup() { db.prepare('DELETE FROM sightings WHERE last_seen < ?').run(new Date(Date.now() - 365 * 864e5).toISOString()); },
    lastLight() { return db.prepare("SELECT id, status, started_at, finished_at, stats FROM scans WHERE kind='light' ORDER BY id DESC LIMIT 1").get() || null; },
  };
}
