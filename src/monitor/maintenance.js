// Maintenance windows: no alarms while a window is active. Once (from - to) or weekly (weekdays + time of day,
// local time of the container, TZ in .env). A weekly window may cross midnight (22:00–02:00).
import { HttpError, line, ids } from '../lib/http.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };

/** Is this window active at `now` (Date) for the monitor? */
export function windowActive(w, monitorId, now = new Date()) {
  if (!w.enabled) return false;
  const scope = parse(w.monitor_ids, []);
  if (scope.length && !scope.includes(monitorId)) return false;
  if (w.kind === 'once') {
    const a = Date.parse(w.starts_at); const b = Date.parse(w.ends_at);
    return Number.isFinite(a) && Number.isFinite(b) && now.getTime() >= a && now.getTime() < b;
  }
  const days = parse(w.weekdays, []);
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  if (w.time_from <= w.time_to) return days.includes(today) && hm >= w.time_from && hm < w.time_to;
  // crosses midnight: belongs to the weekday it starts on
  return (days.includes(today) && hm >= w.time_from) || (days.includes(yesterday) && hm < w.time_to);
}

/** When the occurrence of an active window that `at` lies in ends (Date) - "in maintenance until 10:00" */
export function windowEnd(w, at = new Date()) {
  if (w.kind === 'once') return new Date(w.ends_at);
  const [h, m] = String(w.time_to).split(':').map(Number);
  const end = new Date(at); end.setHours(h, m, 0, 0);
  // crosses midnight and started today: ends tomorrow
  if (w.time_from > w.time_to) {
    const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    if (hm >= w.time_from) end.setDate(end.getDate() + 1);
  }
  return end;
}

export function createMaintenance(db) {
  const now = () => new Date().toISOString();
  const shape = (r) => ({ ...r, weekdays: parse(r.weekdays, []), monitor_ids: parse(r.monitor_ids, []), enabled: !!r.enabled });

  function clean(input) {
    const name = line(input.name, 80);
    if (!name) throw new HttpError(400, 'err.nameRequired');
    const kind = input.kind === 'weekly' ? 'weekly' : 'once';
    const out = { name, kind, starts_at: null, ends_at: null, weekdays: '[]', time_from: null, time_to: null,
      monitor_ids: JSON.stringify(ids(input.monitor_ids, 500)), enabled: input.enabled === false ? 0 : 1 };
    if (kind === 'once') {
      const a = Date.parse(input.starts_at); const b = Date.parse(input.ends_at);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new HttpError(400, 'err.maintenanceTime');
      out.starts_at = new Date(a).toISOString();
      out.ends_at = new Date(b).toISOString();
    } else {
      const days = Array.isArray(input.weekdays) ? [...new Set(input.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
      if (!days.length || !TIME.test(String(input.time_from)) || !TIME.test(String(input.time_to)) || input.time_from === input.time_to) {
        throw new HttpError(400, 'err.maintenanceTime');
      }
      out.weekdays = JSON.stringify(days.sort());
      out.time_from = input.time_from;
      out.time_to = input.time_to;
    }
    return out;
  }

  // The windows are read once a second at most - a list of 500 monitors asks for each of them
  let cache = null; let cacheAt = 0;
  const windows = () => {
    if (!cache || Date.now() - cacheAt > 1000) { cache = db.prepare('SELECT * FROM maintenance WHERE enabled=1').all(); cacheAt = Date.now(); }
    return cache;
  };
  const changed = () => { cache = null; };

  return {
    list: () => db.prepare('SELECT * FROM maintenance ORDER BY name').all().map(shape),
    create(input) {
      const v = clean(input);
      const keys = Object.keys(v);
      const r = db.prepare(`INSERT INTO maintenance(${keys.join(',')},created_at) VALUES(${keys.map(() => '?').join(',')},?)`).run(...keys.map((k) => v[k]), now());
      changed();
      return shape(db.prepare('SELECT * FROM maintenance WHERE id=?').get(r.lastInsertRowid));
    },
    update(id, input) {
      const v = clean(input);
      const keys = Object.keys(v);
      if (!db.prepare(`UPDATE maintenance SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => v[k]), id).changes) throw new HttpError(404, 'err.notFound');
      changed();
      return shape(db.prepare('SELECT * FROM maintenance WHERE id=?').get(id));
    },
    remove(id) { if (!db.prepare('DELETE FROM maintenance WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound'); changed(); },
    /** Active window for a monitor right now (or null) */
    activeFor(monitorId, at = new Date()) {
      return windows().find((w) => windowActive(w, monitorId, at)) || null;
    },
    /**
     * For the pages: which window holds the monitor and until when. With several, the one that lasts longest -
     * that is when the monitor is out of maintenance.
     */
    infoFor(monitorId, at = new Date()) {
      let best = null;
      for (const w of windows()) {
        if (!windowActive(w, monitorId, at)) continue;
        const until = windowEnd(w, at);
        if (!best || until > best.until) best = { id: w.id, name: w.name, until };
      }
      return best && { id: best.id, name: best.name, until: best.until.toISOString() };
    },
    /** Windows active right now (with their end), for the list of windows */
    activeNow(at = new Date()) {
      const out = {};
      for (const w of windows()) {
        if (!w.enabled) continue;
        if (windowActive({ ...w, monitor_ids: '[]' }, 0, at)) out[w.id] = windowEnd(w, at).toISOString();
      }
      return out;
    },
    _changed: changed,
  };
}
