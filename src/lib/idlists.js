// Lists of ids kept as JSON text (alarm channels of a monitor, monitors of a maintenance window, devices of a report …).
// When the thing behind an id is deleted, the id has to go out of every list: ids are given again to new rows, and a
// stale id would then point to something else (alarms to a new recipient, a maintenance window on another monitor).
const parse = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

/**
 * Removes `id` from the JSON list in `table.column` of every row.
 * onEmpty(row) is called for rows whose list becomes empty (where "empty" means "all", the caller decides what to do).
 * Returns the number of rows changed.
 */
export function dropId(db, table, column, id, onEmpty = null) {
  const n = Number(id);
  let changed = 0;
  for (const row of db.prepare(`SELECT id, ${column} v FROM ${table} WHERE ${column} <> '[]'`).all()) {
    const list = parse(row.v);
    const rest = list.filter((x) => Number(x) !== n);
    if (rest.length === list.length) continue;
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(JSON.stringify(rest), row.id);
    if (!rest.length && onEmpty) onEmpty(row);
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

/** Monitors deleted (also through their device): out of maintenance windows and reports */
export function forgetMonitors(db, ids) {
  for (const id of ids) {
    dropId(db, 'maintenance', 'monitor_ids', id, offWindow(db));
    dropId(db, 'reports', 'monitor_ids', id, offReport(db));
  }
}

/** Devices deleted: out of reports, and their monitors out of everything above */
export function forgetDevices(db, ids, monitorIds = []) {
  for (const id of ids) dropId(db, 'reports', 'device_ids', id, offReport(db));
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
  if (settings) for (const k of ['lightscan.channels', 'printer.channels', 'nas.channels', 'escalate.channels']) dropIdFromSetting(settings, k, id);
}
