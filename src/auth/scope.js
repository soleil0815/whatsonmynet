// Location scope of a user: editors and viewers can be limited to some locations ("segment admins").
// null = everything (admins, and users without a limit). Otherwise a Set of location ids.
// Devices without a location and things that belong to no location are only visible to unlimited users.
import { HttpError } from '../lib/http.js';

export function scopeOf(db, user) {
  if (!user || user.role === 'admin') return null;
  const rows = db.prepare('SELECT location_id FROM user_locations WHERE user_id=?').all(user.id);
  return rows.length ? new Set(rows.map((r) => r.location_id)) : null;
}

/** Is a location (id or null) inside the scope? */
export const inScope = (scope, locationId) => !scope || (locationId !== null && locationId !== undefined && scope.has(Number(locationId)));

/** Device row if the user may see it, else 404 (the same answer as for a device that does not exist) */
export function deviceInScope(db, scope, id) {
  const d = db.prepare('SELECT id, location_id FROM devices WHERE id=?').get(id);
  if (!d || !inScope(scope, d.location_id)) throw new HttpError(404, 'err.notFound');
  return d;
}

/** Only for users without a limit (things that belong to no location: ad-hoc subnets, nightly scan, global monitors) */
export function requireUnscoped(req) {
  if (req.scope) throw new HttpError(403, 'err.scope');
}
