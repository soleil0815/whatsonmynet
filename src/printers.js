// Printer status: asks every printer in the inventory via SNMP (Printer-MIB) at a set interval, keeps the latest
// status and one page count per day, and reports supplies that run low (once per supply until it is replaced).
import { readPrinter } from './scan/printer.js';
import { HttpError } from './lib/http.js';
import { log } from './lib/log.js';
import { localDay } from './scan/nightly.js';

const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };
const REARM = 10; // a supply is "replaced" when it rises this many points above the threshold

/**
 * Decides which supplies to report. alerts: { supplyKey: 'low' | 'empty' } of earlier reports.
 * Returns { events, alerts } - events: [{ supply, empty }]
 */
export function supplyAlerts(supplies, previous, threshold) {
  const alerts = { ...previous };
  const events = [];
  for (const s of supplies) {
    const empty = s.state === 'empty';
    const low = empty || (s.pct !== null && s.pct <= threshold);
    const had = alerts[s.key];
    if (low) {
      if (empty && had !== 'empty') { events.push({ supply: s, empty: true }); alerts[s.key] = 'empty'; }
      else if (!had) { events.push({ supply: s, empty: false }); alerts[s.key] = 'low'; }
    } else if (had && s.pct !== null && s.pct > threshold + REARM) {
      delete alerts[s.key];
    }
  }
  for (const k of Object.keys(alerts)) if (!supplies.some((s) => s.key === k)) delete alerts[k];
  return { events, alerts };
}

export function createPrinters({ db, settings, channels }) {
  const communities = () => {
    const list = String(settings.get('scan.snmpCommunities') || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
    return list.length ? list : ['public'];
  };
  const busy = new Set();
  let timer = null;
  let reader = readPrinter; // replaced in tests

  const getStatus = db.prepare('SELECT * FROM printer_status WHERE device_id=?');
  const upsert = db.prepare(`INSERT INTO printer_status(device_id,at,ok,error,data,alerts) VALUES(@device_id,@at,@ok,@error,@data,@alerts)
    ON CONFLICT(device_id) DO UPDATE SET at=excluded.at, ok=excluded.ok, error=excluded.error,
      data=CASE WHEN excluded.ok=1 THEN excluded.data ELSE printer_status.data END, alerts=excluded.alerts`);
  const pageRow = db.prepare('INSERT INTO printer_pages(device_id,day,count) VALUES(?,?,?) ON CONFLICT(device_id,day) DO UPDATE SET count=excluded.count');

  function shape(row) {
    if (!row) return null;
    const data = parse(row.data);
    return { at: row.at, ok: !!row.ok, error: row.error, ...data, pages30: pagesSince(row.device_id, 30) };
  }

  /** Pages printed in the last `days` days (from the daily counter) - null if not known yet */
  function pagesSince(deviceId, days) {
    const rows = db.prepare('SELECT day, count FROM printer_pages WHERE device_id=? ORDER BY day DESC LIMIT ?').all(deviceId, days + 1);
    if (rows.length < 2) return null;
    const diff = rows[0].count - rows[rows.length - 1].count;
    return diff >= 0 ? diff : null;
  }

  async function poll(deviceId) {
    const d = db.prepare('SELECT id, name, ip, type FROM devices WHERE id=?').get(deviceId);
    if (!d) throw new HttpError(404, 'err.notFound');
    if (!d.ip) throw new HttpError(400, 'err.noIp');
    if (busy.has(d.id)) return shape(getStatus.get(d.id));
    busy.add(d.id);
    const at = new Date();
    const prev = getStatus.get(d.id);
    try {
      let data = null; let error = '';
      try { data = await reader(d.ip, communities()); } catch (e) { error = e.message === 'snmp' || e.message === 'noPrinterMib' ? e.message : 'snmp'; }
      let alerts = parse(prev?.alerts);
      if (data) {
        if (data.pages !== null && data.pages !== undefined) pageRow.run(d.id, localDay(at), data.pages);
        const r = supplyAlerts(data.supplies || [], alerts, Number(settings.get('printer.threshold')) || 15);
        alerts = r.alerts;
        if (r.events.length && settings.get('printer.notify')) {
          for (const ev of r.events) {
            const reached = await channels.notifyIds(settings.get('printer.channels'), { kind: 'supply', device: { id: d.id, name: d.name, ip: d.ip },
              supply: { description: ev.supply.description, pct: ev.supply.pct, color: ev.supply.color, receptacle: ev.supply.receptacle }, empty: ev.empty, at: at.toISOString() });
            if (reached.length) log.info(`Printer ${d.name}: ${ev.supply.description} reported via ${reached.join(', ')}`);
          }
        }
      }
      upsert.run({ device_id: d.id, at: at.toISOString(), ok: data ? 1 : 0, error, data: JSON.stringify(data || {}), alerts: JSON.stringify(alerts) });
      // Old daily counters: keep 400 days
      db.prepare('DELETE FROM printer_pages WHERE device_id=? AND day < ?').run(d.id, localDay(new Date(at.getTime() - 400 * 864e5)));
      return shape(getStatus.get(d.id));
    } finally {
      busy.delete(d.id);
    }
  }

  /** Printers whose last query is older than the interval */
  let polling = false;
  async function pollDue(now = Date.now()) {
    if (!settings.get('printer.enabled') || polling) return 0;
    polling = true;
    try { return await pollDueNow(now); } finally { polling = false; }
  }

  async function pollDueNow(now) {
    const every = Math.max(5, Number(settings.get('printer.interval')) || 60) * 60 * 1000;
    const due = db.prepare(`SELECT d.id, p.at FROM devices d LEFT JOIN printer_status p ON p.device_id=d.id
      WHERE d.type='printer' AND d.ip IS NOT NULL AND d.ip<>''`).all().filter((r) => !r.at || now - Date.parse(r.at) >= every);
    for (const r of due.slice(0, 20)) {
      try { await poll(r.id); } catch (e) { log.warn(`Printer ${r.id}: ${e.message}`); }
    }
    return due.length;
  }

  return {
    poll,
    pollDue,
    status: (deviceId) => shape(getStatus.get(deviceId)),
    /** Supplies at or below the threshold, for the dashboard */
    low() {
      const threshold = Number(settings.get('printer.threshold')) || 15;
      const out = [];
      for (const row of db.prepare(`SELECT p.*, d.name FROM printer_status p JOIN devices d ON d.id=p.device_id WHERE d.type='printer'`).all()) {
        const data = parse(row.data);
        for (const s of data.supplies || []) {
          if (s.state === 'empty' || (s.pct !== null && s.pct <= threshold)) out.push({ deviceId: row.device_id, device: row.name, ...s });
        }
      }
      return out.sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0)).slice(0, 12);
    },
    setReaderForTests(fn) { reader = fn; },
    start() {
      if (timer) return;
      const run = () => pollDue().catch((e) => log.warn(`Printer check: ${e.message}`));
      timer = setInterval(run, 60 * 1000);
      timer.unref();
      setTimeout(run, 20 * 1000).unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
