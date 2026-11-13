// Locations group subnets ("Main building": 192.168.10.0/24, 192.168.20.0/24). Before a scan the admin ticks the
// locations to scan; found devices get their location automatically.
import { HttpError, line, str } from './lib/http.js';
import { parseCidr, MAX_PREFIX_HOSTS, ipToInt } from './lib/net.js';
import { forgetLocation } from './lib/idlists.js';

export function createLocations(db) {
  const now = () => new Date().toISOString();

  function list() {
    const locs = db.prepare('SELECT * FROM locations ORDER BY name').all();
    const subnets = db.prepare('SELECT * FROM subnets ORDER BY cidr').all();
    const counts = Object.fromEntries(db.prepare('SELECT location_id, COUNT(*) n FROM devices WHERE location_id IS NOT NULL GROUP BY location_id').all().map((r) => [r.location_id, r.n]));
    return locs.map((l) => ({ ...l, devices: counts[l.id] || 0,
      subnets: subnets.filter((s) => s.location_id === l.id).sort((a, b) => ipToInt(a.cidr.split('/')[0]) - ipToInt(b.cidr.split('/')[0])) }));
  }

  function checkCidr(raw) {
    const c = parseCidr(raw);
    if (!c) throw new HttpError(400, 'err.cidr', String(raw).slice(0, 40));
    if (c.hosts > MAX_PREFIX_HOSTS) throw new HttpError(400, 'err.cidrTooLarge', c.cidr);
    return c.cidr;
  }

  function save(id, input) {
    const name = line(input.name, 80);
    if (!name) throw new HttpError(400, 'err.nameRequired');
    const description = str(input.description, 500).trim();
    const cidrs = Array.isArray(input.subnets) ? input.subnets.slice(0, 64) : [];
    const subnets = cidrs.map((s) => ({ cidr: checkCidr(typeof s === 'string' ? s : s?.cidr), label: line(s?.label, 80) }));
    if (new Set(subnets.map((s) => s.cidr)).size !== subnets.length) throw new HttpError(400, 'err.cidrDuplicate');
    return db.transaction(() => {
      const other = db.prepare('SELECT id FROM locations WHERE name=? AND id IS NOT ?').get(name, id);
      if (other) throw new HttpError(409, 'err.locationExists');
      let locId = id;
      if (id) {
        if (!db.prepare('UPDATE locations SET name=?, description=? WHERE id=?').run(name, description, id).changes) throw new HttpError(404, 'err.notFound');
      } else {
        locId = Number(db.prepare('INSERT INTO locations(name,description,created_at) VALUES(?,?,?)').run(name, description, now()).lastInsertRowid);
      }
      for (const s of subnets) {
        const taken = db.prepare('SELECT l.name FROM subnets s JOIN locations l ON l.id=s.location_id WHERE s.cidr=? AND s.location_id<>?').get(s.cidr, locId);
        if (taken) throw new HttpError(409, 'err.cidrTaken', `${s.cidr} → ${taken.name}`);
      }
      db.prepare('DELETE FROM subnets WHERE location_id=?').run(locId);
      const ins = db.prepare('INSERT INTO subnets(location_id,cidr,label,created_at) VALUES(?,?,?,?)');
      for (const s of subnets) ins.run(locId, s.cidr, s.label, now());
      return list().find((l) => l.id === locId);
    })();
  }

  return {
    list,
    create: (input) => save(null, input),
    update: (id, input) => save(id, input),
    remove(id) {
      // A user limited to locations must never end up limited to none: no rows means "everything" (see auth/scope.js)
      const only = db.prepare(`SELECT u.username FROM users u JOIN user_locations ul ON ul.user_id=u.id
        WHERE ul.location_id=? AND u.role<>'admin' AND (SELECT COUNT(*) FROM user_locations x WHERE x.user_id=u.id)=1 ORDER BY u.username`).all(id);
      if (only.length) throw new HttpError(409, 'err.locationLastScope', only.map((u) => u.username).slice(0, 10).join(', '));
      db.transaction(() => {
        if (!db.prepare('DELETE FROM locations WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
        forgetLocation(db, id);
      })();
    },
    /** Scan targets of the chosen locations */
    targets(ids) {
      if (!ids.length) return [];
      return db.prepare(`SELECT cidr, location_id FROM subnets WHERE location_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
        .map((s) => ({ cidr: s.cidr, locationId: s.location_id }));
    },
    /** Location whose subnet contains the address (for ad-hoc scans) */
    locationForCidr(cidr) {
      return db.prepare('SELECT location_id FROM subnets WHERE cidr=?').get(cidr)?.location_id || null;
    },
  };
}
