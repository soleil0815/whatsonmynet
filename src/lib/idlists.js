// Lists of ids kept as JSON text (alarm channels of a monitor, monitors of a maintenance window, devices of a report …).
// When the thing behind an id is deleted, the id has to go out of every list: ids are given again to new rows, and a
// stale id would then point to something else (alarms to a new recipient, a maintenance window on another monitor).
const parse = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

/**
 * Removes `id` from the JSON list in `table.column` of every row.
 * onEmpty(row) is called for rows whose list becomes empty (where "empty" means "all", the caller decides what to do).
 * Returns the number of rows changed.
 */
export function dropId(db, table, column, id, onEmpty = null, idOf = Number) {
  const n = Number(id);
  let changed = 0;
  for (const row of db.prepare(`SELECT id, ${column} v FROM ${table} WHERE ${column} <> '[]'`).all()) {
    const list = parse(row.v);
    const rest = list.filter((x) => idOf(x) !== n);
    if (rest.length === list.length) continue;
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(JSON.stringify(rest), row.id);
    if (!rest.length && onEmpty) onEmpty(row);
    changed++;
  }
  return changed;
}

/**
 * Replaces id `from` by `to` in the JSON list in `table.column` of every row (no id twice afterwards).
 * idOf(entry) reads the id of an entry (null: an entry without one, kept as it is); withId(entry, id) gives the entry
 * with the other id (other fields of the entry, e.g. a label, stay).
 */
export function replaceId(db, table, column, from, to, idOf = Number, withId = (x, id) => id) {
  const f = Number(from); const t = Number(to);
  let changed = 0;
  for (const row of db.prepare(`SELECT id, ${column} v FROM ${table} WHERE ${column} <> '[]'`).all()) {
    const list = parse(row.v);
    if (!list.some((x) => idOf(x) === f)) continue;
    const seen = new Set();
    const next = [];
    for (const x of list) {
      const id = idOf(x);
      const y = id === f ? withId(x, t) : id === null || id === undefined || Number.isNaN(id) ? x : withId(x, id);
      const k = idOf(y);
      if (k !== null && k !== undefined && !Number.isNaN(k)) { if (seen.has(k)) continue; seen.add(k); }
      next.push(y);
    }
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(JSON.stringify(next), row.id);
    changed++;
  }
  return changed;
}

/** The same for a list stored as a setting */
export function dropIdFromSetting(settings, key, id) {
  const list = settings.get(key);
  if (!Array.isArray(list)) return false;
  const rest = list.filter((x) => Number(x) !== Number(id));
  if (rest.length === list.length) return false;
  settings.set(key, rest);
  return true;
}

// In maintenance windows and reports an empty list means "all": a window or report whose last chosen entry is
// deleted is switched off instead of suddenly applying to everything.
const offWindow = (db) => (row) => db.prepare('UPDATE maintenance SET enabled=0 WHERE id=?').run(row.id);
const offReport = (db) => (row) => {
  const r = db.prepare('SELECT device_ids, monitor_ids FROM reports WHERE id=?').get(row.id);
  if (r && r.device_ids === '[]' && r.monitor_ids === '[]') db.prepare('UPDATE reports SET enabled=0 WHERE id=?').run(row.id);
};

// Every JSON list that refers to monitors - kept in one place, so that deleting and merging monitors treat them all
// alike. Status pages hold objects ({ type: 'monitor', id, label } or a group, which names no monitor id); a page whose
// last line goes stays as it is (it shows "nothing chosen", never everything).
const statusItemId = (x) => (x && typeof x === 'object' && x.type === 'monitor' ? Number(x.id) : null);
export const MONITOR_ID_LISTS = [
  { table: 'maintenance', column: 'monitor_ids', onEmpty: offWindow },
  { table: 'reports', column: 'monitor_ids', onEmpty: offReport },
  { table: 'status_pages', column: 'items', idOf: statusItemId, withId: (x, id) => ({ ...x, id }) },
];

/** Monitors deleted (also through their device): out of maintenance windows, reports and status pages */
export function forgetMonitors(db, ids) {
  for (const id of ids) {
    for (const l of MONITOR_ID_LISTS) dropId(db, l.table, l.column, id, l.onEmpty ? l.onEmpty(db) : null, l.idOf);
  }
}

/** Monitor `from` merged into `to`: every list that named `from` names `to` (a status page line keeps its label) */
export function replaceMonitorId(db, from, to) {
  for (const l of MONITOR_ID_LISTS) replaceId(db, l.table, l.column, from, to, l.idOf, l.withId);
}

/** Devices deleted: out of reports, and their monitors out of everything above */
export function forgetDevices(db, ids, monitorIds = []) {
  for (const id of ids) dropId(db, 'reports', 'device_ids', id, offReport(db));
  // an event rule for only this device is switched off (the id could be given to another device later); its messages
  // stay, without the device (they live in their own file - no foreign key does it there)
  for (const id of ids) {
    db.prepare('UPDATE events_in SET device_id=NULL WHERE device_id=?').run(Number(id));
    db.prepare('UPDATE event_senders SET device_id=NULL WHERE device_id=?').run(Number(id));
    db.prepare("UPDATE event_rules SET enabled=0, match=json_set(match, '$.deviceId', NULL) WHERE json_extract(match, '$.deviceId') = ?").run(Number(id));
  }
  forgetMonitors(db, monitorIds);
}

/** Location deleted: out of reports (a report for only this location is switched off) */
export function forgetLocation(db, id) {
  dropId(db, 'reports', 'location_ids', id, (row) => db.prepare('UPDATE reports SET enabled=0 WHERE id=?').run(row.id));
}

/** Alarm channel deleted: out of monitors and the channel settings (an emptied list falls back to the default channels) */
export function forgetChannel(db, settings, id) {
  dropId(db, 'monitors', 'channels', id);
  dropId(db, 'monitors', 'escalate_channels', id);
  // an event rule never falls back to the default channels: without a channel left it is switched off
  dropId(db, 'event_rules', 'channels', id, (row) => db.prepare('UPDATE event_rules SET enabled=0 WHERE id=?').run(row.id));
  if (settings) for (const k of ['lightscan.channels', 'printer.channels', 'nas.channels', 'escalate.channels']) dropIdFromSetting(settings, k, id);
}
