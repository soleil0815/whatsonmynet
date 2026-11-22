// Plugins of the host script: own small scripts (PowerShell for Windows, sh for Linux) that an administrator writes in
// WhatsOnMyNet, downloads as a file and puts into the plugins folder of the machines - like the "own checks", but kept
// in one place, with a version, and for whom they are meant (all machines of the system, tags, locations, devices).
//
// Which plugin a machine may run, WhatsOnMyNet tells its host script in the answer to every report: id, version and the
// fingerprint (SHA-256) of the file. The host script runs a plugin only when the file is exactly that one - a changed
// file, an old version or a plugin that is not meant for this machine does not run (and the device page says why).
// The answer comes over the connection the script trusts (pinned certificate) - that is the signature. The script
// loads nothing: the file is brought by the administrator (software distribution, by hand).
import crypto from 'node:crypto';
import { HttpError, line } from './lib/http.js';

export const MAX_CODE = 64 * 1024;
export const OS = ['windows', 'linux'];
// how often a plugin may run (minutes) - the host script reports every 5 minutes and reuses the last result in between
export const INTERVALS = [5, 10, 15, 30, 60, 120, 360, 720, 1440];
export const DIRS = { windows: 'C:\\ProgramData\\WhatsOnMyNet\\plugins\\', linux: '/etc/whatsonmynet/plugins/' };
const now = () => new Date().toISOString();
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const ids = (v, max = 200) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, max);
const tagList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(','))
  .map((x) => String(x).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);

/** For whom a plugin is: { all: true } or any of tags, locations, devices */
export function cleanTargets(t) {
  const x = t && typeof t === 'object' ? t : {};
  if (x.all) return { all: true };
  const out = { tags: tagList(x.tags), locations: ids(x.locations), devices: ids(x.devices) };
  if (!out.tags.length && !out.locations.length && !out.devices.length) throw new HttpError(400, 'err.pluginTargets');
  return out;
}

/** Does a device belong to the targets? device: { id, location_id, tags } */
export function targetsMatch(t, d) {
  if (!t || !d) return false;
  if (t.all) return true;
  if ((t.devices || []).includes(Number(d.id))) return true;
  if (d.location_id && (t.locations || []).includes(Number(d.location_id))) return true;
  const mine = String(d.tags || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return (t.tags || []).some((x) => mine.includes(x));
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plugin';

/**
 * The file of a plugin exactly as it is downloaded: a header the host script reads (id and version) and the code.
 * Windows: UTF-8 with BOM (Windows PowerShell 5.1 reads umlauts only so) and CRLF; Linux: UTF-8 and LF, a first line
 * "#!..." of the code stays the first line. The fingerprint is taken over these bytes.
 */
export function pluginFile(p) {
  const name = String(p.name).replace(/[\r\n"]/g, ' ');
  const head = [
    `# womn-plugin id=${p.id} version=${p.version}`,
    `# WhatsOnMyNet plugin "${name}" (${p.os === 'windows' ? 'Windows' : 'Linux'}) - written in WhatsOnMyNet, not here:`,
    '# a changed file does not run. Put it into the plugins folder of the host script:',
    `#   ${DIRS[p.os]}`,
  ];
  let code = String(p.code).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  let shebang = '';
  if (p.os === 'linux' && code.startsWith('#!')) { const i = code.indexOf('\n'); shebang = i < 0 ? code : code.slice(0, i); code = i < 0 ? '' : code.slice(i + 1); }
  const lines = [...(shebang ? [shebang] : []), ...head, '', code, ''];
  const text = p.os === 'windows' ? lines.join('\r\n') : lines.join('\n');
  const bytes = Buffer.concat([p.os === 'windows' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
  return {
    file: `womn-plugin-${p.id}-${slug(p.name)}.${p.os === 'windows' ? 'ps1' : 'sh'}`,
    bytes, text, sha: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

/** What a machine reports about the files in its plugins folder: [{ file, id, version, state, text }] */
const STATES = ['ok', 'error', 'timeout', 'changed', 'outdated', 'notAssigned', 'noHeader', 'unsafe', 'deferred'];
export function cleanPluginReport(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((x) => {
    if (!x || typeof x !== 'object') return null;
    const state = STATES.includes(x.state) ? x.state : null;
    if (!state) return null;
    const id = Number(x.id);
    const version = Number(x.version);
    return { file: String(x.file ?? '').replace(/[\x00-\x1f]/g, ' ').slice(0, 120), id: Number.isInteger(id) && id > 0 ? id : null,
      version: Number.isInteger(version) && version > 0 ? version : null, state, text: String(x.text ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 300) };
  }).filter(Boolean);
}

export function createPlugins({ db }) {
  const files = new Map(); // id → { key, file } - built once per version
  const shape = (r) => ({ id: r.id, name: r.name, description: r.description, os: r.os, version: r.version, targets: parse(r.targets, { all: true }),
    timeout: r.timeout_s, interval: r.interval_min, enabled: !!r.enabled, created_at: r.created_at, updated_at: r.updated_at, updated_by: r.updated_by });
  function fileOf(r) {
    const key = `${r.version}|${r.updated_at}`;
    const hit = files.get(r.id);
    if (hit?.key === key) return hit.file;
    const file = pluginFile(r);
    files.set(r.id, { key, file });
    return file;
  }

  function validate(b, old) {
    const name = line(b.name ?? old?.name, 80);
    if (!name) throw new HttpError(400, 'err.nameRequired');
    const os = b.os ?? old?.os;
    if (!OS.includes(os)) throw new HttpError(400, 'err.badRequest');
    const code = typeof b.code === 'string' ? b.code : old?.code;
    if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'err.pluginCode');
    if (Buffer.byteLength(code) > MAX_CODE || code.includes('\0')) throw new HttpError(400, 'err.pluginTooLarge');
    const timeout = Math.min(120, Math.max(5, Number(b.timeout ?? old?.timeout_s ?? 30) || 30));
    const interval = Number(b.interval ?? old?.interval_min ?? 5);
    if (!INTERVALS.includes(interval)) throw new HttpError(400, 'err.badRequest');
    return { name, os, code, timeout, interval, description: String(b.description ?? old?.description ?? '').replace(/[\x00-\x08\x0b-\x1f]/g, ' ').trim().slice(0, 300),
      targets: cleanTargets(b.targets ?? parse(old?.targets, { all: true })), enabled: 'enabled' in b ? !!b.enabled : old ? !!old.enabled : true };
  }

  const row = (id) => db.prepare('SELECT * FROM plugins WHERE id=?').get(id);

  /**
   * How far each plugin is rolled out: per plugin the machines it is meant for (with a report of the host script) and
   * what they say - running, missing, outdated, changed … One query; the reports are read by SQLite (only os and
   * plugins), not parsed whole here - also with thousands of machines.
   */
  function rollout() {
    const rows = db.prepare(`SELECT h.device_id id, d.name, d.location_id, d.tags, json_extract(h.data,'$.os') os, json_extract(h.data,'$.plugins') pl
      FROM host_reports h JOIN devices d ON d.id=h.device_id`).all();
    const all = db.prepare('SELECT id, os, version, targets, enabled FROM plugins').all();
    const out = new Map(all.map((p) => [p.id, { expected: 0, ok: 0, problems: [] }]));
    for (const r of rows) {
      const os = /windows/i.test(String(r.os || '')) ? 'windows' : 'linux';
      const rep = parse(r.pl, null);
      for (const p of all) {
        if (!p.enabled || p.os !== os || !targetsMatch(parse(p.targets, null), r)) continue;
        const o = out.get(p.id);
        o.expected++;
        const mine = Array.isArray(rep) ? rep.find((x) => x?.id === p.id) : null;
        const state = !Array.isArray(rep) ? 'scriptOld' : !mine ? 'missing' : mine.state;
        if (state === 'ok') o.ok++;
        else if (o.problems.length < 50) o.problems.push({ device: r.id, name: r.name, state });
      }
    }
    return out;
  }

  return {
    list() {
      const roll = rollout();
      return db.prepare('SELECT * FROM plugins ORDER BY name COLLATE NOCASE').all().map((r) => ({ ...shape(r), file: fileOf(r).file, sha: fileOf(r).sha,
        rollout: roll.get(r.id) || { expected: 0, ok: 0, problems: [] } }));
    },
    /** For the editor: tags and locations to choose from, and the machines with the host script (by system) */
    choices() {
      const tags = new Set();
      for (const r of db.prepare("SELECT tags FROM devices WHERE tags <> ''").all()) for (const x of r.tags.split(',')) if (x.trim()) tags.add(x.trim().toLowerCase());
      return {
        tags: [...tags].sort().slice(0, 500),
        locations: db.prepare('SELECT id, name FROM locations ORDER BY name COLLATE NOCASE').all(),
        devices: db.prepare(`SELECT d.id, d.name, json_extract(h.data,'$.os') os FROM host_reports h JOIN devices d ON d.id=h.device_id ORDER BY d.name COLLATE NOCASE LIMIT 2000`).all()
          .map((d) => ({ id: d.id, name: d.name, os: /windows/i.test(String(d.os || '')) ? 'windows' : 'linux' })),
        dirs: DIRS,
      };
    },
    get(id) {
      const r = row(id);
      if (!r) throw new HttpError(404, 'err.notFound');
      const f = fileOf(r);
      return { ...shape(r), code: r.code, file: f.file, sha: f.sha };
    },
    create(b, who) {
      const v = validate(b || {});
      const at = now();
      const id = db.prepare(`INSERT INTO plugins(name,description,os,code,version,targets,timeout_s,interval_min,enabled,created_at,updated_at,updated_by)
        VALUES(?,?,?,?,1,?,?,?,?,?,?,?)`).run(v.name, v.description, v.os, v.code, JSON.stringify(v.targets), v.timeout, v.interval, v.enabled ? 1 : 0, at, at, String(who || '')).lastInsertRowid;
      return this.get(Number(id));
    },
    /** A new version only when the file changes (code, name, system) - other changes need no new download */
    update(id, b, who) {
      const old = row(id);
      if (!old) throw new HttpError(404, 'err.notFound');
      const v = validate(b || {}, old);
      const fileChanged = v.code !== old.code || v.name !== old.name || v.os !== old.os;
      db.prepare(`UPDATE plugins SET name=?, description=?, os=?, code=?, version=version+?, targets=?, timeout_s=?, interval_min=?, enabled=?, updated_at=?, updated_by=? WHERE id=?`)
        .run(v.name, v.description, v.os, v.code, fileChanged ? 1 : 0, JSON.stringify(v.targets), v.timeout, v.interval, v.enabled ? 1 : 0, now(), String(who || ''), id);
      return { ...this.get(id), newVersion: fileChanged };
    },
    remove(id) {
      if (!db.prepare('DELETE FROM plugins WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
      files.delete(id);
    },
    download(id) {
      const r = row(id);
      if (!r) throw new HttpError(404, 'err.notFound');
      return fileOf(r);
    },
    /** The plugins this device may run now: [{ id, version, sha, timeout }] (switched on, its system, its targets) */
    allowedFor(deviceId, os) {
      const d = db.prepare('SELECT id, location_id, tags FROM devices WHERE id=?').get(deviceId);
      if (!d || !OS.includes(os)) return [];
      return db.prepare('SELECT * FROM plugins WHERE enabled=1 AND os=? ORDER BY id').all(os)
        .filter((r) => targetsMatch(parse(r.targets, null), d))
        .map((r) => ({ id: r.id, version: r.version, sha: fileOf(r).sha, timeout: r.timeout_s, interval: r.interval_min }));
    },
    /** The list the host script reads: "id:version:sha256:timeout:interval" separated by spaces (no JSON needed in sh) */
    allowString(list) { return list.map((x) => `${x.id}:${x.version}:${x.sha}:${x.timeout}:${x.interval}`).join(' '); },
    /**
     * Per device: what is meant to run there and what the machine reports - running, missing, outdated, changed, not
     * meant for it. reported: the plugins of its last report (null: script too old to report plugins).
     */
    overview(deviceId, os, reported) {
      const want = this.allowedFor(deviceId, os);
      const names = new Map(db.prepare('SELECT id, name, version FROM plugins').all().map((r) => [r.id, r]));
      const rep = Array.isArray(reported) ? reported : [];
      const out = want.map((w) => {
        const r = rep.find((x) => x.id === w.id);
        return { id: w.id, name: names.get(w.id)?.name || '', version: w.version, file: r?.file || '', reportedVersion: r?.version ?? null,
          state: !r ? 'missing' : r.state, text: r?.text || '' };
      });
      for (const r of rep.filter((x) => !want.some((w) => w.id === x.id))) {
        const p = r.id ? names.get(r.id) : null;
        out.push({ id: r.id, name: p?.name || '', version: p?.version ?? null, file: r.file, reportedVersion: r.version, state: r.state === 'ok' ? 'notAssigned' : r.state, text: r.text });
      }
      return { scriptKnows: Array.isArray(reported), items: out };
    },
    count: () => db.prepare('SELECT COUNT(*) n FROM plugins').get().n,
  };
}
