// Windows and Linux machines that report on their own: a small script (PowerShell / POSIX sh) sends CPU, RAM, drives,
// uptime and services every 5 minutes - no agent, no open port, no account on the machine.
//
// Keys: one per device (the report belongs to exactly that device) or one shared key for many machines (software
// distribution, Ansible): a report with the shared key is matched to the inventory by MAC address, host name or IP.
// Machines that are not in the inventory are listed, nothing is created on its own. Keys are stored as hash only.
import crypto from 'node:crypto';
import { HttpError, line } from './lib/http.js';
import { normalizeMac } from './lib/net.js';
import { hostScript } from './hostscripts.js';
import { fillDevice } from './devicefill.js';

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (used, total) => (total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : null);
const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const STALE_MIN = 15;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** What a script sends, checked and cut to size: never trusted more than a form */
export function cleanReport(body) {
  const b = body && typeof body === 'object' ? body : {};
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const kb = (v) => (num(v) === null ? null : Math.max(0, num(v)) * 1024);
  const memTotal = Math.max(0, num(b.memTotal) ?? kb(b.memTotalKb) ?? 0);
  const memUsed = Math.max(0, Math.min(memTotal, num(b.memUsed) ?? (num(b.memAvailKb) !== null ? memTotal - kb(b.memAvailKb) : 0)));
  const disks = list(b.disks, 50).map((d) => {
    const total = Math.max(0, num(d?.total) ?? kb(d?.totalKb) ?? 0);
    const used = Math.max(0, Math.min(total, num(d?.used) ?? kb(d?.usedKb) ?? 0));
    return { name: clip(d?.name, 120), label: clip(d?.label, 80), used, total, pct: pct(used, total) };
  }).filter((d) => d.name && d.total);
  const STATES = ['running', 'stopped', 'failed'];
  const services = list(b.services, 500).map((s) => {
    const state = STATES.includes(s?.state) ? s.state : 'stopped';
    return { name: clip(s?.name, 120), display: clip(s?.display, 200), state, failed: s?.failed === true || state === 'failed' };
  }).filter((s) => s.name).sort((a, c) => a.name.localeCompare(c.name));
  const hostname = clip(b.hostname, 80);
  if (!hostname) throw new HttpError(400, 'err.badRequest', 'hostname missing');
  return {
    hostname, os: clip(b.os, 120), cpu: num(b.cpu) === null ? null : pct(num(b.cpu), 100), memTotal, memUsed, mem: pct(memUsed, memTotal),
    uptime: Math.max(0, Math.round(num(b.uptime) || 0)), disks, services,
    macs: [...new Set(list(b.macs, 20).map((m) => normalizeMac(m)).filter(Boolean))],
    ips: [...new Set(list(b.ips, 20).map((ip) => String(ip).trim()).filter((ip) => IPV4.test(ip)))],
  };
}

export function createHosts({ db }) {
  const now = () => new Date().toISOString();
  const tokenRow = (id) => db.prepare('SELECT * FROM host_tokens WHERE id=?').get(id);
  const shapeToken = (t) => (t ? { id: t.id, name: t.name, os: t.os, device_id: t.device_id, device_name: t.device_id ? db.prepare('SELECT name FROM devices WHERE id=?').get(t.device_id)?.name || '' : null,
    created_at: t.created_at, last_used: t.last_used, reports: t.reports } : null);

  /** The script with a new key (the key is shown only now; a renewed key makes the old script stop) */
  function issue(id, { server, pin }) {
    const t = tokenRow(id);
    if (!t) throw new HttpError(404, 'err.notFound');
    if (!/^https?:\/\/[^\s/"'<>]+$/i.test(String(server || ''))) throw new HttpError(400, 'err.badRequest');
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('UPDATE host_tokens SET token_hash=? WHERE id=?').run(sha(token), id);
    const s = hostScript(t.os, { url: `${server.replace(/\/+$/, '')}/api/hosts/push`, token, pin });
    return { ...shapeToken(tokenRow(id)), token, script: { file: s.file, text: s.text }, uninstall: s.uninstall };
  }

  function create(input, opts) {
    const os = input?.os === 'linux' ? 'linux' : input?.os === 'windows' ? 'windows' : null;
    if (!os) throw new HttpError(400, 'err.badRequest');
    const deviceId = input.device_id ? Number(input.device_id) : null;
    if (deviceId && !db.prepare('SELECT 1 FROM devices WHERE id=?').get(deviceId)) throw new HttpError(404, 'err.notFound');
    // One key per device: a new script for the same device replaces the old key
    if (deviceId) db.prepare('DELETE FROM host_tokens WHERE device_id=?').run(deviceId);
    const name = line(input.name, 80) || (deviceId ? db.prepare('SELECT name FROM devices WHERE id=?').get(deviceId).name : '');
    if (!name) throw new HttpError(400, 'err.nameRequired');
    const id = db.prepare('INSERT INTO host_tokens(name,os,device_id,token_hash,created_at) VALUES(?,?,?,?,?)').run(name, os, deviceId, '', now()).lastInsertRowid;
    return issue(id, opts);
  }

  /** Which inventory device sent this? Device key: that one. Shared key: MAC, then host name, then IP. */
  function match(t, r, remoteIp) {
    if (t.device_id) return t.device_id;
    for (const m of r.macs) { const d = db.prepare('SELECT id FROM devices WHERE mac=?').get(m); if (d) return d.id; }
    const short = r.hostname.toLowerCase().split('.')[0];
    const byName = db.prepare(`SELECT id FROM devices WHERE lower(hostname)=? OR lower(name)=? OR lower(hostname) LIKE ? OR lower(name) LIKE ? ORDER BY id LIMIT 1`)
      .get(short, short, `${short}.%`, `${short}.%`);
    if (byName) return byName.id;
    for (const ip of [...r.ips, remoteIp].filter(Boolean)) { const d = db.prepare('SELECT id FROM devices WHERE ip=?').get(ip); if (d) return d.id; }
    return null;
  }

  function push(token, body, remoteIp = '') {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token))) throw new HttpError(401, 'err.unauthorized');
    const t = db.prepare('SELECT * FROM host_tokens WHERE token_hash=?').get(sha(token));
    if (!t) throw new HttpError(401, 'err.unauthorized');
    const r = cleanReport(body);
    const at = now();
    db.prepare('UPDATE host_tokens SET last_used=?, reports=reports+1 WHERE id=?').run(at, t.id);
    const ip = IPV4.test(String(remoteIp).replace(/^::ffff:/, '')) ? String(remoteIp).replace(/^::ffff:/, '') : '';
    const deviceId = match(t, r, ip);
    if (!deviceId) {
      db.prepare(`INSERT INTO host_unmatched(hostname,ip,os,token_id,at) VALUES(?,?,?,?,?)
        ON CONFLICT(hostname) DO UPDATE SET ip=excluded.ip, os=excluded.os, token_id=excluded.token_id, at=excluded.at`).run(r.hostname, r.ips[0] || ip, r.os, t.id, at);
      throw new HttpError(404, 'err.hostUnknown', r.hostname);
    }
    db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET at=excluded.at, data=excluded.data')
      .run(deviceId, at, JSON.stringify(r));
    db.prepare('DELETE FROM host_unmatched WHERE lower(hostname)=lower(?)').run(r.hostname);
    // Operating system and host name from the machine itself into empty fields of the device
    fillDevice(db, deviceId, { os: r.os, hostname: r.hostname }, 'script');
    return { ok: true, device: deviceId };
  }

  /** Last report of a device with "stale" if it is older than 15 minutes; null if it never reported */
  function report(deviceId) {
    const row = db.prepare('SELECT at, data FROM host_reports WHERE device_id=?').get(deviceId);
    if (!row) return null;
    return { ...parse(row.data, {}), at: row.at, stale: Date.now() - Date.parse(row.at) > STALE_MIN * 60 * 1000 };
  }

  return {
    create,
    renew: (id, opts) => issue(id, opts),
    push,
    report,
    list: () => db.prepare('SELECT * FROM host_tokens ORDER BY device_id IS NOT NULL, name').all().map(shapeToken),
    remove(id) { if (!db.prepare('DELETE FROM host_tokens WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound'); },
    unmatched: () => db.prepare('SELECT hostname, ip, os, at FROM host_unmatched ORDER BY at DESC LIMIT 100').all(),
    forgetUnmatched: (hostname) => db.prepare('DELETE FROM host_unmatched WHERE hostname=?').run(String(hostname || '')),
    /** Devices that report (for the sensor form) */
    deviceIds: () => db.prepare('SELECT device_id FROM host_reports').all().map((r) => r.device_id),
  };
}
