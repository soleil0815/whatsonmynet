// Windows and Linux machines that report on their own: a small script (PowerShell / POSIX sh) sends CPU, RAM, drives,
// uptime and services every 5 minutes - no agent, no open port, no account on the machine.
//
// Keys: one per device (the report belongs to exactly that device) or one shared key for many machines (software
// distribution, Ansible): a report with the shared key is matched to the inventory by MAC address, host name or IP.
// Machines that are not in the inventory are listed, nothing is created on its own. Keys are stored as hash only.
import crypto from 'node:crypto';
import { HttpError, line } from './lib/http.js';
import { normalizeMac } from './lib/net.js';
import { hostScript, SCRIPT_VERSIONS, scriptTemplate } from './hostscripts.js';
import { zfsFromScript, mdFromMdstat, spacesFromScript } from './pools.js';
import { fillDevice } from './devicefill.js';
import { cleanUps } from './scan/ups.js';
import { cleanPluginReport } from './plugins.js';
import { cleanHw, cleanPdisks, cleanUpdates, cleanSecurity, cleanEvents, cleanCerts, cleanTemps, cleanChecks, cleanNics } from './hostfacts.js';
import { portRates } from './portrates.js';

// devices whose ports come by SNMP even when a host script runs on them
const SNMP_PORT_TYPES = ['switch', 'nas', 'ups'];

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (used, total) => (total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : null);
const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const STALE_MIN = 15;
// Silent for a day: the script was most likely removed from the machine (or the machine is gone). Its last values stay
// for the sensors that watch them, but the machine is no longer offered for new sensors and its page asks what happened.
export const GONE_HOURS = 24;
/** Is a report from this time that old? (ISO time; a missing one counts as gone) */
export const reportGone = (at, now = Date.now()) => !(now - Date.parse(at) <= GONE_HOURS * 3600 * 1000);
/** ISO time before which a report counts as gone - for SQL (ISO times compare as text) */
export const goneBefore = (now = Date.now()) => new Date(now - GONE_HOURS * 3600 * 1000).toISOString();

/** windows or linux from what the machine says about itself */
export const hostOs = (os) => (/windows/i.test(String(os || '')) ? 'windows' : 'linux');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** The last self-update a script reports: { at, ok, version, message } or null */
function cleanSelfUpdate(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const at = Date.parse(String(v.at || ''));
  return { at: Number.isFinite(at) ? new Date(at).toISOString() : null, ok: v.ok === true || v.ok === 1 || v.ok === '1',
    version: /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(String(v.version ?? '')) ? String(v.version) : null, message: clip(v.message, 200) };
}

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
    // own checks from the checks folder of the machine (scripts from version 0.27 on) and the values of the plugins
    checks: cleanChecks(b.checks),
    // the files in the plugins folder and what became of them (scripts from 0.56 on; null: the script knows no plugins)
    plugins: Array.isArray(b.plugins) ? cleanPluginReport(b.plugins) : null,
    // ZFS pools and software RAID (Linux script), Storage Spaces (Windows script) - from 0.42 on
    pools: [...zfsFromScript(typeof b.zfs?.list === 'string' ? b.zfs.list.slice(0, 20000) : '', zfsStatus(b.zfs?.status)),
      ...mdFromMdstat(typeof b.mdstat === 'string' ? b.mdstat.slice(0, 20000) : ''), ...spacesFromScript(b.spaces)].slice(0, 64),
    // network cards (from 0.58 on) - kept only when the ports of the machine are watched (push)
    nics: cleanNics(b.nics),
    // the last self-update of the script (from 0.59 on): when, whether it worked, why not
    selfUpdate: cleanSelfUpdate(b.selfUpdate),
    // version of the Windows script (from 0.42 on; older ones send none)
    script: /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(String(b.script ?? '')) ? String(b.script) : null,
  };
}

/** zpool status per pool as the script sends it: { name: text } (at most 32, each cut at 20 000 characters) */
const zfsStatus = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).slice(0, 32).map(([k, v]) => [String(k).slice(0, 120), String(v ?? '').slice(0, 20000)]));

/** Is version a older than b (1.2.3)? */
const older = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };

/** Address of this server for the scripts: only scheme, host and port - it is written into a script */
export function serverBase(server) {
  let u;
  try { u = new URL(String(server || '')); } catch { throw new HttpError(400, 'err.badRequest'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !/^[A-Za-z0-9.\[\]:-]+$/.test(u.host) || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new HttpError(400, 'err.badRequest');
  }
  return `${u.protocol}//${u.host}`;
}

/**
 * Why a machine runs an older script than now: manual (before 0.59 - cannot update itself, hand it out once more),
 * error (its last try for this version failed), late (still old in a report more than an hour after the offer, no error -
 * e.g. another copy runs than the one it replaced; a machine switched off right after the offer is not late).
 * action: it will not catch up by itself (also when self-update is off). at: the time of its last report.
 */
export function scriptState(x, now, selfUpdate, at = Date.now()) {
  const manual = !x.script || older(x.script, '0.59.0');
  const error = x.selfUpdate?.ok === false && x.selfUpdate.version === now ? x.selfUpdate.message || 'failed' : null;
  const late = !manual && !error && !!selfUpdate && x.updateOffered?.version === now && Date.parse(x.updateOffered.at) < at - 3600_000;
  return { manual, error, late, action: manual || !!error || late || !selfUpdate };
}

export function createHosts({ db, plugins = null, settings = null }) {
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
    return { ...shapeToken(tokenRow(id)), token, script: { file: s.file, text: s.text, registry: s.registry }, uninstall: s.uninstall };
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
   * Returns { id, sure } - sure: matched by a device key (only then may the report say the hardware was exchanged).
   */
  function match(t, r, remoteIp) {
    if (t.device_id) return { id: t.device_id, sure: true };
    // Everything below comes with the shared key: every machine that runs the shared script holds it and writes the
    // report body itself (MACs are no secret on the LAN either). So such a match is never "sure" - serial, model and
    // MAC of a device are never overwritten by it - and a device with a known MAC is only reached when the report
    // names that MAC (by MAC, host name or IP alike). A laptop that reports only its dock's MAC while the inventory
    // knows its Wi-Fi MAC stays an unknown machine: it needs a script with its own key (device page).
    // The shared key never reaches a device that has a key of its own (its reports come only with that key)
    const free = 'id NOT IN (SELECT device_id FROM host_tokens WHERE device_id IS NOT NULL)';
    for (const m of r.macs) { const d = db.prepare(`SELECT id FROM devices WHERE mac=? AND ${free}`).get(m); if (d) return { id: d.id, sure: false }; }
    const macs = r.macs.length ? ` AND (mac IS NULL OR mac IN (${r.macs.map(() => '?').join(',')}))` : ' AND mac IS NULL';
    const short = r.hostname.toLowerCase().split('.')[0];
    // "name" or "name.domain" - compared as text (no LIKE: % and _ in a reported name would be wildcards)
    const byName = short ? db.prepare(`SELECT id FROM devices WHERE (lower(hostname)=? OR lower(name)=? OR substr(lower(hostname),1,length(?)+1)=?||'.'
      OR substr(lower(name),1,length(?)+1)=?||'.') AND ${free}${macs} ORDER BY id LIMIT 1`).get(short, short, short, short, short, short, ...r.macs) : null;
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
      const model = [r.hw?.vendor, r.hw?.model].filter(Boolean).join(' ').slice(0, 120);
      db.prepare(`INSERT INTO host_unmatched(hostname,ip,os,token_id,at,macs,serial,model) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(hostname) DO UPDATE SET ip=excluded.ip, os=excluded.os, token_id=excluded.token_id, at=excluded.at, macs=excluded.macs, serial=excluded.serial, model=excluded.model`)
        .run(r.hostname, r.ips[0] || ip, r.os, t.id, at, JSON.stringify(r.macs.slice(0, 8)), String(r.hw?.serial || '').slice(0, 100), model);
      // Kept small: whoever has the shared key could otherwise fill it with made-up names
      db.prepare('DELETE FROM host_unmatched WHERE rowid NOT IN (SELECT rowid FROM host_unmatched ORDER BY at DESC LIMIT 500)').run();
      throw new HttpError(404, 'err.hostUnknown', r.hostname);
    }
    // Network cards only when someone watches the ports of this machine: then load and new errors since the last report.
    // Switches, NAS and UPS keep their ports from SNMP (one source, the one the sensors use)
    const dev = db.prepare('SELECT watch_ports, type FROM devices WHERE id=?').get(deviceId);
    const wantNics = !!dev?.watch_ports && !SNMP_PORT_TYPES.includes(dev.type);
    if (wantNics && r.nics.length) {
      const prev = db.prepare('SELECT at, data FROM host_reports WHERE device_id=?').get(deviceId);
      let before = null;
      try { before = prev ? JSON.parse(prev.data) : null; } catch { before = null; }
      const now = { ports: r.nics, uptime: r.uptime };
      if (before?.nics?.length) portRates({ ports: before.nics, uptime: before.uptime }, prev.at, now, at);
      if (now.rateSeconds) r.nicsRateSeconds = now.rateSeconds;
    } else delete r.nics;
    // A newer script for this machine ("<version>:<sha256>", fetched by scripts from 0.59 on) - by the operating system
    // of its key, like the template it then fetches. When it was first offered is kept: a machine that has not caught
    // up an hour later needs a look (see scripts())
    const kind = t.os === 'linux' ? 'linux' : 'windows';
    const tpl = settings?.get('hosts.selfUpdate') && r.script && older(r.script, SCRIPT_VERSIONS[kind]) ? scriptTemplate(kind) : null;
    if (tpl) {
      const was = parse(db.prepare('SELECT data FROM host_reports WHERE device_id=?').get(deviceId)?.data, {}).updateOffered;
      r.updateOffered = { version: tpl.version, at: was?.version === tpl.version && was.at ? was.at : at };
    }
    db.prepare('INSERT INTO host_reports(device_id,at,data) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET at=excluded.at, data=excluded.data')
      .run(deviceId, at, JSON.stringify(r));
    db.prepare('DELETE FROM host_unmatched WHERE lower(hostname)=lower(?)').run(r.hostname);
    // Operating system and host name from the machine itself into empty fields of the device
    // … and what the machine knows about its hardware (manufacturer, model, serial number; a VM is a VM)
    const hw = r.hw || {};
    // Only a device key is sure enough to declare the hardware exchanged (MAC dropped, serial replaced)
    fillDevice(db, deviceId, { os: r.os, hostname: r.hostname, vendor: hw.vendor, model: hw.model, serial: hw.serial, type: hw.virtual ? 'vm' : undefined }, 'script', { mayReplace: found.sure });
    // which plugins this machine may run (id, version, fingerprint) - the script keeps the list for its next run
    const allowed = plugins ? plugins.allowedFor(deviceId, hostOs(r.os)) : [];
    // nics: whether the script should read the network cards from its next run on (nothing is read unless asked)
    return { ok: true, device: deviceId, plugins: plugins ? plugins.allowString(allowed) : '', nics: wantNics, ...(tpl ? { update: `${tpl.version}:${tpl.sha256}` } : {}) };
  }

  /** The template for the self-update of a script - for its own key only (host scripts, not Hyper-V/KVM) */
  function template(token) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token))) throw new HttpError(401, 'err.unauthorized');
    const t = db.prepare('SELECT * FROM host_tokens WHERE token_hash=?').get(sha(token));
    if (!t) throw new HttpError(401, 'err.unauthorized');
    if (!settings?.get('hosts.selfUpdate')) throw new HttpError(409, 'err.selfUpdateOff');
    return scriptTemplate(t.os === 'linux' ? 'linux' : 'windows');
  }

  /** Last report of a device with "stale" if it is older than 15 minutes; null if it never reported */
  function report(deviceId) {
    const row = db.prepare('SELECT at, data FROM host_reports WHERE device_id=?').get(deviceId);
    if (!row) return null;
    const data = parse(row.data, {});
    // a Windows script older than the one WhatsOnMyNet hands out now (none sent: before 0.42)
    const windows = /windows/i.test(String(data.os || ''));
    // Linux scripts carry a version from 0.56 on (older ones: none - "outdated" too)
    const now = SCRIPT_VERSIONS[windows ? 'windows' : 'linux'];
    const scriptOld = !data.script || older(data.script, now);
    // plugins: what is meant to run here and what the machine says about its plugins folder
    const pluginState = plugins ? plugins.overview(deviceId, hostOs(data.os), data.plugins) : null;
    return { ...data, at: row.at, stale: Date.now() - Date.parse(row.at) > STALE_MIN * 60 * 1000, gone: reportGone(row.at), scriptOld, scriptNow: now, selfUpdateOn: !!settings?.get('hosts.selfUpdate'),
      plugins: pluginState?.items.length ? pluginState : null };
  }

  /**
   * The script of this machine is gone: its last report and its own key go (a shared key stays - other machines use
   * it). The device page then offers "Monitor by script" again; sensors that watched its values report "no value".
   */
  function forget(deviceId) {
    return db.transaction(() => {
      const n = db.prepare('DELETE FROM host_reports WHERE device_id=?').run(deviceId).changes;
      return n + db.prepare('DELETE FROM host_tokens WHERE device_id=?').run(deviceId).changes;
    })();
  }

  return {
    create,
    renew: (id, opts) => issue(id, opts),
    push,
    template,
    /**
     * Machines whose script is older than the one WhatsOnMyNet hands out (the overview shows them): with self-update on
     * they catch up by themselves - listed are those that did not within an hour, or whose last self-update failed.
     */
    scripts(allowed = null) {
      // outdated: older than the current script; action: those that will not update on their own (from before 0.59, a
      // failed try, or self-update switched off) - only these need a look
      const out = { outdated: 0, action: 0, stuck: [], selfUpdate: !!settings?.get('hosts.selfUpdate') };
      // of each report only what decides it (table of its own, migration 48 - the overview asks on every visit)
      for (const row of db.prepare(`SELECT d.id, d.name, h.at, f.os, f.script, f.self_update su, f.offered
        FROM host_report_facts f JOIN host_reports h ON h.device_id=f.device_id JOIN devices d ON d.id=f.device_id WHERE h.at >= ?`).all(goneBefore())) {
        if (allowed && !allowed(row.id)) continue;
        const x = { os: row.os, script: row.script, selfUpdate: parse(row.su, null), updateOffered: parse(row.offered, null) };
        const now = SCRIPT_VERSIONS[hostOs(x.os)];
        if (x.script && !older(x.script, now)) continue;
        out.outdated++;
        const st = scriptState(x, now, out.selfUpdate, Date.parse(row.at));
        if (st.action) out.action++;
        out.stuck.push({ deviceId: row.id, name: row.name, version: x.script || null, now, manual: st.manual, error: st.error, late: st.late });
      }
      const needs = (s) => s.manual || !!s.error || s.late;
      out.stuck = out.stuck.sort((a, b) => needs(b) - needs(a) || a.name.localeCompare(b.name)).slice(0, 50);
      return out;
    },
    report,
    list: () => db.prepare('SELECT * FROM host_tokens ORDER BY device_id IS NOT NULL, name').all().map(shapeToken),
    forget,
    // The script of a single machine: with its key its last report goes too (nothing can send it any more)
    remove(id) {
      const t = tokenRow(id);
      if (!t) throw new HttpError(404, 'err.notFound');
      db.transaction(() => {
        db.prepare('DELETE FROM host_tokens WHERE id=?').run(id);
        if (t.device_id) db.prepare('DELETE FROM host_reports WHERE device_id=?').run(t.device_id);
      })();
      return t;
    },
    // unknown machines - with the device of the same name, if there is one (new hardware under the old name: its MAC no
    // longer fits, so the shared key does not reach it on its own - an administrator decides, see assignUnmatched)
    // (not one whose script still reports: then the old machine still runs - a clone or a second machine of that name)
    unmatched: () => db.prepare('SELECT hostname, ip, os, at, macs, serial, model FROM host_unmatched ORDER BY at DESC LIMIT 100').all().map((u) => {
      const short = String(u.hostname || '').toLowerCase().split('.')[0];
      const d = short ? db.prepare(`SELECT id, name FROM devices WHERE (lower(hostname)=? OR lower(name)=? OR substr(lower(hostname),1,length(?)+1)=?||'.')
        AND id NOT IN (SELECT device_id FROM host_tokens WHERE device_id IS NOT NULL)
        AND id NOT IN (SELECT device_id FROM host_reports WHERE at >= ?) ORDER BY id LIMIT 1`).get(short, short, short, short, new Date(Date.now() - 6 * 3600_000).toISOString()) : null;
      return { ...u, macs: parse(u.macs, []), suggest: d || null };
    }),
    /**
     * "New hardware, same machine": the unknown machine is this device. MAC address and serial number of the old
     * hardware are replaced by those the machine reported (the old ones go to the history), so from now on only a report
     * naming that MAC reaches the device. Only by hand: done on its own, any machine holding the shared key could take
     * over a device by sending its name.
     */
    assignUnmatched(hostname, deviceId, user = '') {
      const u = db.prepare('SELECT * FROM host_unmatched WHERE hostname=?').get(String(hostname || ''));
      if (!u) throw new HttpError(404, 'err.notFound');
      const d = db.prepare('SELECT id, mac, serial FROM devices WHERE id=?').get(Number(deviceId));
      if (!d) throw new HttpError(404, 'err.notFound');
      if (db.prepare('SELECT 1 FROM host_tokens WHERE device_id=?').get(d.id)) throw new HttpError(409, 'err.hostOwnKey');
      db.transaction(() => {
        // the first reported MAC of real hardware that no other device has - not one of a virtual adapter (Hyper-V,
        // VMware, VirtualBox, KVM) or a made-up one (locally administered: VPN, Wi-Fi privacy); none: none - then name
        // and address find the device
        const virtual = (m) => /^(00:15:5d|00:50:56|00:0c:29|00:05:69|00:1c:14|08:00:27|0a:00:27|52:54:00|00:16:3e)/.test(m) || (parseInt(m.slice(0, 2), 16) & 2) === 2;
        const mac = parse(u.macs, []).find((m) => !virtual(m) && !db.prepare('SELECT 1 FROM devices WHERE mac=? AND id<>?').get(m, d.id)) || null;
        db.prepare('UPDATE devices SET mac=?, serial=?, updated_at=? WHERE id=?').run(mac, String(u.serial || ''), now(), d.id);
        db.prepare('INSERT INTO device_history(device_id,at,user,kind,detail) VALUES(?,?,?,?,?)')
          .run(d.id, now(), user, 'hardwareSwapped', JSON.stringify({ host: u.hostname, mac: d.mac || null, serial: d.serial || null }));
        db.prepare('DELETE FROM host_unmatched WHERE hostname=?').run(u.hostname);
      })();
      return { ok: true };
    },
    forgetUnmatched: (hostname) => db.prepare('DELETE FROM host_unmatched WHERE hostname=?').run(String(hostname || '')),
    /** Devices that report (for the sensor form) - not those silent for a day */
    deviceIds: () => db.prepare('SELECT device_id FROM host_reports WHERE at >= ?').all(goneBefore()).map((r) => r.device_id),
  };
}

/**
 * Hottest temperature per machine that reports by script, by its short name - for the nodes on the virtualisation
 * page (Proxmox gives no temperatures; the node runs the Linux script and sends them): name → { c, name, warn, at, deviceId }
 */
export function hostTempsByName(db) {
  const out = new Map();
  // only machines with temperatures, and of their report only name and temperatures (table of their own, migration
  // 48 - the report itself is not read: a Windows report is some 25 KB, a thousand of them took a page half a second)
  for (const r of db.prepare(`SELECT d.id, d.name, d.hostname, h.at, f.hostname reported, f.temps
    FROM host_report_facts f JOIN host_reports h ON h.device_id=f.device_id JOIN devices d ON d.id=f.device_id WHERE f.temps IS NOT NULL`).all()) {
    const x = { hostname: r.reported };
    let temps;
    try { temps = JSON.parse(r.temps); } catch { continue; }
    temps = Array.isArray(temps) ? temps : [];
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

/**
 * What matters at a glance from a script report - for the page of a hypervisor, where the node or guest is shown
 * without its own inventory page: updates, restart, failed services, pools, disks, own checks. Only counts and names,
 * never more than the inventory shows anyway.
 */
export function hostGlance(x) {
  const fullDisks = (x.disks || []).filter((d) => d.pct >= 90).map((d) => ({ name: d.name, pct: d.pct })).slice(0, 5);
  const badPools = (x.pools || []).filter((p) => !p.good).map((p) => ({ name: p.name, state: p.state })).slice(0, 5);
  return {
    os: x.os || '', uptime: x.uptime || 0, cpu: x.cpu ?? null, mem: x.mem ?? null,
    updates: x.updates ? { pending: x.updates.pending ?? null, security: x.updates.security ?? null } : null,
    reboot: !!x.updates?.reboot,
    failed: (x.services || []).filter((s) => s.failed).map((s) => s.display || s.name).slice(0, 5),
    failedCount: (x.services || []).filter((s) => s.failed).length,
    pools: badPools, disks: fullDisks,
    pdisks: (x.pdisks || []).filter((d) => d.health === 'failed' || d.health === 'warning').length,
    checks: (x.checks || []).filter((c) => c.status > 0).length,
  };
}

/**
 * Machines whose script reports (not gone), by short name → { deviceId, at, stale }; the newest report wins when two
 * machines share a name. Names come from a table of their own (migration 48), not from the reports: a hypervisor is
 * polled every minute, and reading a thousand reports whole held the server up each time.
 */
const reportingCache = new WeakMap();
/** Tests: read the reports anew on the next call */
export const forgetReporting = (db) => { reportingCache.delete(db); glanceCache.delete(db); };
export function reportingHosts(db) {
  // one page lists many hypervisors: the names once for all of them (a few seconds are new enough)
  const hit = reportingCache.get(db);
  if (hit && Date.now() - hit.at < 3000) return hit.map;
  const out = new Map();
  for (const r of db.prepare(`SELECT d.id, d.name, d.hostname, h.at, f.hostname reported FROM host_reports h JOIN devices d ON d.id=h.device_id
    LEFT JOIN host_report_facts f ON f.device_id=h.device_id WHERE h.at >= ? ORDER BY h.at`)
    .all(goneBefore())) {
    const v = { deviceId: r.id, at: r.at, stale: Date.now() - Date.parse(r.at) > STALE_MIN * 60 * 1000 };
    for (const n of [r.reported, r.hostname, r.name]) { const k = String(n || '').toLowerCase().split('.')[0].trim(); if (k) out.set(k, v); }
  }
  reportingCache.set(db, { at: Date.now(), map: out });
  return out;
}

// What a report says at a glance - read only for the nodes and guests shown, and again only when a newer report came
const glanceCache = new WeakMap();
function glanceOf(db, deviceId, at) {
  let m = glanceCache.get(db);
  if (!m) glanceCache.set(db, (m = new Map()));
  const hit = m.get(deviceId);
  if (hit && hit.at === at) return hit.glance;
  let x = {};
  try { x = JSON.parse(db.prepare('SELECT data FROM host_reports WHERE device_id=?').pluck().get(deviceId)) || {}; } catch { /* name of the device only */ }
  const glance = hostGlance(x);
  if (m.size > 5000) m.clear();
  m.set(deviceId, { at, glance });
  return glance;
}

/**
 * Node and guest list of a hypervisor joined with the script of the same machine: which nodes run it (the interface
 * offers it for the others) and, for nodes and guests with a report, what it says at a glance and where it is in
 * the inventory.
 */
export function nodeScriptsInto(db, data) {
  const hasNodes = Array.isArray(data?.nodes) && data.nodes.length;
  const hasGuests = Array.isArray(data?.guests) && data.guests.length;
  if (!hasNodes && !hasGuests) return data;
  const hosts = reportingHosts(db);
  const of = (name) => hosts.get(String(name || '').toLowerCase().split('.')[0].trim());
  const join = (n) => { const r = of(n.name); return r ? { ...n, script: !r.stale, report: { ...r, glance: glanceOf(db, r.deviceId, r.at) } } : { ...n, script: false }; };
  return { ...data, ...(hasNodes ? { nodes: data.nodes.map(join) } : {}), ...(hasGuests ? { guests: data.guests.map(join) } : {}) };
}

/** Node list of a hypervisor with the temperature of each node that runs the Linux script (current reports only) */
export function nodeTempsInto(db, data) {
  if (!Array.isArray(data?.nodes) || !data.nodes.length) return data;
  const temps = hostTempsByName(db);
  if (!temps.size) return data;
  return { ...data, nodes: data.nodes.map((n) => { const x = temps.get(String(n.name || '').toLowerCase().split('.')[0]); return x && !x.stale ? { ...n, temp: x } : n; }) };
}
