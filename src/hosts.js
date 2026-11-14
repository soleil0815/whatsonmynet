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
import { cleanUps } from './scan/ups.js';
import { cleanHw, cleanPdisks, cleanUpdates, cleanSecurity, cleanEvents, cleanCerts, cleanTemps } from './hostfacts.js';

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
    // UPS the machine sees (Linux: local NUT/apcupsd, Windows: UPS on USB)
    ups: cleanUps(b.ups),
    // Hardware, physical disks, updates, protection, events, certificates (scripts from version 0.10 on)
    hw: cleanHw(b.hw), pdisks: cleanPdisks(b.pdisks), updates: cleanUpdates(b.updates), ...cleanSecurity(b.av, b.firewall),
    events: cleanEvents(b.events), certs: cleanCerts(b.certs),
    // Temperatures (Linux script from version 0.11 on: hwmon)
    temps: cleanTemps(b.temps),
  };
}

/** Address of this server for the scripts: only scheme, host and port - it is written into a script */
export function serverBase(server) {
  let u;
  try { u = new URL(String(server || '')); } catch { throw new HttpError(400, 'err.badRequest'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !/^[A-Za-z0-9.\[\]:-]+$/.test(u.host) || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new HttpError(400, 'err.badRequest');
  }
  return `${u.protocol}//${u.host}`;
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
    server = serverBase(server);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('UPDATE host_tokens SET token_hash=? WHERE id=?').run(sha(token), id);
    const s = hostScript(t.os, { url: `${server.replace(/\/+$/, '')}/api/hosts/push`, token, pin });
    return { ...shapeToken(tokenRow(id)), token, script: { file: s.file, text: s.text }, uninstall: s.uninstall };
  }

  function create(input, opts) {
    const os = input?.os === 'linux' ? 'linux' : input?.os === 'windows' ? 'windows' : null;
    if (!os) throw new HttpError(400, 'err.badRequest');
    serverBase(opts?.server); // checked before the old key of the device is given up
    const deviceId = input.device_id ? Number(input.device_id) : null;
    if (deviceId && !db.prepare('SELECT 1 FROM devices WHERE id=?').get(deviceId)) throw new HttpError(404, 'err.notFound');
    // One key per device: a new script for the same device replaces the old key
    const name = line(input.name, 80) || (deviceId ? db.prepare('SELECT name FROM devices WHERE id=?').get(deviceId).name : '');
    if (!name) throw new HttpError(400, 'err.nameRequired');
    return db.transaction(() => {
      if (deviceId) db.prepare('DELETE FROM host_tokens WHERE device_id=?').run(deviceId);
      const id = db.prepare('INSERT INTO host_tokens(name,os,device_id,token_hash,created_at) VALUES(?,?,?,?,?)').run(name, os, deviceId, '', now()).lastInsertRowid;
      return issue(id, opts);
    })();
  }

  /**
   * Which inventory device sent this? Device key: that one. Shared key: MAC, then host name, then IP.
   * Returns { id, sure } - sure: matched by device key or MAC (only then may the report say the hardware was exchanged).
   */
  function match(t, r, remoteIp) {
    if (t.device_id) return { id: t.device_id, sure: true };
    // The shared key never reaches a device that has a key of its own (its reports come only with that key)
    const free = 'id NOT IN (SELECT device_id FROM host_tokens WHERE device_id IS NOT NULL)';
    for (const m of r.macs) { const d = db.prepare(`SELECT id FROM devices WHERE mac=? AND ${free}`).get(m); if (d) return { id: d.id, sure: true }; }
    // A reused IP address never reaches a device with another MAC (it would mix two machines). The host name may: a
    // laptop docked on cable reports only that MAC while the inventory knows its Wi-Fi MAC. Such a match is not "sure",
    // so serial, model and MAC of the device are never overwritten by it.
    const macs = r.macs.length ? ` AND (mac IS NULL OR mac IN (${r.macs.map(() => '?').join(',')}))` : '';
    const short = r.hostname.toLowerCase().split('.')[0];
    // "name" or "name.domain" - compared as text (no LIKE: % and _ in a reported name would be wildcards)
    const byName = short ? db.prepare(`SELECT id FROM devices WHERE (lower(hostname)=? OR lower(name)=? OR substr(lower(hostname),1,length(?)+1)=?||'.'
      OR substr(lower(name),1,length(?)+1)=?||'.') AND ${free} ORDER BY id LIMIT 1`).get(short, short, short, short, short, short) : null;
    if (byName) return { id: byName.id, sure: false };
    for (const ip of r.ips) { const d = db.prepare(`SELECT id FROM devices WHERE ip=? AND ${free}${macs}`).get(ip, ...r.macs); if (d) return { id: d.id, sure: false }; }
    // The sender address (may be a NAT or proxy address) only for devices without MAC
    if (remoteIp) { const d = db.prepare(`SELECT id FROM devices WHERE ip=? AND mac IS NULL AND ${free}`).get(remoteIp); if (d) return { id: d.id, sure: false }; }
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
    const found = match(t, r, ip);
    const deviceId = found?.id || null;
    if (!deviceId) {
      db.prepare(`INSERT INTO host_unmatched(hostname,ip,os,token_id,at) VALUES(?,?,?,?,?)
        ON CONFLICT(hostname) DO UPDATE SET ip=excluded.ip, os=excluded.os, token_id=excluded.token_id, at=excluded.at`).run(r.hostname, r.ips[0] || ip, r.os, t.id, at);
      // Kept small: whoever has the shared key could otherwise fill it with made-up names
      db.prepare('DELETE FROM host_unmatched WHERE rowid NOT IN (SELECT rowid FROM host_unmatched ORDER BY at DESC LIMIT 500)').run();
      throw new HttpError(404, 'err.hostUnknown', r.hostname);
    }
    db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET at=excluded.at, data=excluded.data')
      .run(deviceId, at, JSON.stringify(r));
    db.prepare('DELETE FROM host_unmatched WHERE lower(hostname)=lower(?)').run(r.hostname);
    // Operating system and host name from the machine itself into empty fields of the device
    // … and what the machine knows about its hardware (manufacturer, model, serial number; a VM is a VM)
    const hw = r.hw || {};
    // A match by name or address alone is not sure enough to declare the hardware exchanged (MAC dropped, serial replaced)
    fillDevice(db, deviceId, { os: r.os, hostname: r.hostname, vendor: hw.vendor, model: hw.model, serial: hw.serial, type: hw.virtual ? 'vm' : undefined }, 'script', { mayReplace: found.sure });
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

/**
 * Hottest temperature per machine that reports by script, by its short name - for the nodes on the virtualisation
 * page (Proxmox gives no temperatures; the node runs the Linux script and sends them): name → { c, name, warn, at, deviceId }
 */
export function hostTempsByName(db) {
  const out = new Map();
  for (const r of db.prepare('SELECT d.id, d.name, d.hostname, h.at, h.data FROM host_reports h JOIN devices d ON d.id=h.device_id').all()) {
    let x;
    try { x = JSON.parse(r.data); } catch { continue; }
    const temps = Array.isArray(x?.temps) ? x.temps : [];
    if (!temps.length) continue;
    const hot = temps.reduce((a, b) => (b.c > a.c ? b : a));
    const v = { c: hot.c, name: hot.name, warn: hot.warn, at: r.at, deviceId: r.id, stale: Date.now() - Date.parse(r.at) > STALE_MIN * 60 * 1000 };
    for (const n of [x.hostname, r.hostname, r.name]) {
      const k = String(n || '').toLowerCase().split('.')[0].trim();
      if (k && !out.has(k)) out.set(k, v);
    }
  }
  return out;
}

/** Node list of a hypervisor with the temperature of each node that runs the Linux script (current reports only) */
export function nodeTempsInto(db, data) {
  if (!Array.isArray(data?.nodes) || !data.nodes.length) return data;
  const temps = hostTempsByName(db);
  if (!temps.size) return data;
  return { ...data, nodes: data.nodes.map((n) => { const x = temps.get(String(n.name || '').toLowerCase().split('.')[0]); return x && !x.stale ? { ...n, temp: x } : n; }) };
}
