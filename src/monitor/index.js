// Monitoring: monitors (ping, TCP port, web address), the scheduler that runs their checks, status changes with
// notifications (only after several failed checks in a row), certificate expiry warnings, availability statistics.
import { HttpError, line, str, int, ids } from '../lib/http.js';
import { isIPv4 } from '../lib/net.js';
import { log } from '../lib/log.js';
import { runCheck, validStatusSpec } from './checks.js';
import { CONTAINER_NAME, DEFAULT_PORTS } from './services.js';
import { OPS, validOid } from './sensors.js';
import { SHARE, SMB_USER, SMB_DOMAIN, smbPath } from './smb.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { pingAvailable } from '../scan/probes.js';
import { bestWebUrl } from '../scan/engine.js';

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const MAX_PARALLEL = 25;
const KEEP_CHECKS_DAYS = 7;
const KEEP_HOURLY_DAYS = 400;
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const iso = (d = new Date()) => d.toISOString();
const hourOf = (d) => `${d.toISOString().slice(0, 13)}:00`;

export function parseCertDays(v) {
  const list = String(v ?? '30,14,7').split(/[,\s]+/).filter(Boolean).map(Number);
  if (!list.length) return [];
  if (list.some((n) => !Number.isInteger(n) || n < 1 || n > 365) || list.length > 5) throw new HttpError(400, 'err.certDays');
  return [...new Set(list)].sort((a, b) => b - a);
}

/**
 * Which warning step applies for `days` left: the smallest threshold that is still ≥ days; -1 when expired;
 * null when outside all thresholds.
 */
export function certStep(days, thresholds) {
  if (days < 0) return -1;
  const fit = thresholds.filter((t) => days <= t);
  return fit.length ? Math.min(...fit) : null;
}

export const MONITOR_TYPES = ['http', 'tcp', 'ping', 'docker', 'mysql', 'postgres', 'redis', 'sensor', 'snmp', 'proxmox', 'smb'];
export const PROXMOX_METRICS = ['nodeOnline', 'nodeCpu', 'nodeMem', 'storage', 'guestRunning', 'backupAge', 'backupFailed', 'datastore', 'groupAge', 'tasksFailed', 'netOnline', 'netClients', 'netCpu', 'netMem', 'clientsTotal', 'netUpdates'];
export const SENSOR_METRICS = ['supply', 'pages', 'printerErrors', 'volume', 'temp', 'diskTemp', 'disk', 'raid', 'health', 'port', 'portErrors', 'hostOnline', 'hostCpu', 'hostMem', 'hostDisk', 'servicesFailed', 'service'];
const DB_TYPES = ['mysql', 'postgres', 'redis'];
const SECRET_TYPES = [...DB_TYPES, 'smb'];

export function createMonitoring({ db, channels, maintenance, settings = null, now = () => new Date() }) {
  const checkCtx = {
    dockerUrl: (id) => (id ? db.prepare('SELECT url FROM docker_hosts WHERE id=?').get(id)?.url : null),
    secret: (m) => { if (!m.secret) return ''; try { return decrypt(m.secret); } catch { return ''; } },
    db,
    communities: () => {
      const list = String(settings?.get('scan.snmpCommunities') || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
      return list.length ? list : ['public'];
    },
  };
  const sensorOptions = (input, old) => {
    const prev = old ? parse(old.options, {}) : {};
    const o = input.options && typeof input.options === 'object' ? input.options : {};
    const op = o.op ?? prev.op;
    if (!OPS.includes(op)) throw new HttpError(400, 'err.sensorOp');
    return { op, threshold: line(o.threshold ?? prev.threshold ?? '', 60), label: line(o.label ?? prev.label ?? '', 120) };
  };
  const nextRun = new Map();
  const running = new Set();
  let timer = null;

  // ---------------------------------------------------------------------------------------------------- input
  async function clean(input, old = null) {
    const type = old ? (input.type ?? old.type) : input.type;
    if (!MONITOR_TYPES.includes(type)) throw new HttpError(400, 'err.monitorType');
    const v = {
      name: line(input.name ?? old?.name, 120),
      type,
      interval_s: Math.min(86400, Math.max(20, int(String(input.interval_s ?? old?.interval_s ?? 60)) || 60)),
      timeout_s: Math.min(60, Math.max(1, int(String(input.timeout_s ?? old?.timeout_s ?? 10)) || 10)),
      fail_threshold: Math.min(10, Math.max(1, int(String(input.fail_threshold ?? old?.fail_threshold ?? 3)) || 3)),
      resend_min: Math.min(1440, Math.max(0, int(String(input.resend_min ?? old?.resend_min ?? 0)) || 0)),
      http_status: line(input.http_status ?? old?.http_status ?? '200-399', 60) || '200-399',
      http_keyword: str(input.http_keyword ?? old?.http_keyword ?? '', 200),
      tls_verify: (input.tls_verify ?? old?.tls_verify) ? 1 : 0,
      cert_check: (input.cert_check ?? old?.cert_check ?? 1) ? 1 : 0,
      cert_days: parseCertDays(input.cert_days ?? old?.cert_days).join(','),
      channels: JSON.stringify(ids(input.channels ?? parse(old?.channels, []), 50)),
    };
    if (!v.name) throw new HttpError(400, 'err.nameRequired');
    if (!validStatusSpec(v.http_status)) throw new HttpError(400, 'err.httpStatus');
    v.timeout_s = Math.min(v.timeout_s, v.interval_s - 1);
    for (const c of parse(v.channels, [])) if (!db.prepare('SELECT 1 FROM channels WHERE id=?').get(c)) throw new HttpError(400, 'err.channel');
    const target = line(input.target ?? old?.target, 1000);
    v.docker_host_id = null;
    v.options = '{}';
    if (!SECRET_TYPES.includes(type)) v.secret = '';
    if (type === 'sensor') {
      const prev = old && old.type === 'sensor' ? parse(old.options, {}) : {};
      const o = input.options && typeof input.options === 'object' ? input.options : {};
      const metric = o.metric ?? prev.metric;
      if (!SENSOR_METRICS.includes(metric)) throw new HttpError(400, 'err.sensorMetric');
      const deviceId = old ? old.device_id : Number(input.device_id);
      if (!deviceId || !db.prepare('SELECT 1 FROM devices WHERE id=?').get(deviceId)) throw new HttpError(400, 'err.sensorDevice');
      const base = ['printerErrors', 'health', 'disk', 'raid', 'port', 'hostOnline', 'service'].includes(metric) ? { op: 'eq', threshold: '', label: line(o.label ?? prev.label ?? '', 120) } : sensorOptions(input, old && old.type === 'sensor' ? old : null);
      v.options = JSON.stringify({ metric, key: line(o.key ?? prev.key ?? '', 120), ...base });
      v.target = (base.label || metric).slice(0, 200);
      v.port = null;
    } else if (type === 'proxmox') {
      const prev = old && old.type === 'proxmox' ? parse(old.options, {}) : {};
      const o = input.options && typeof input.options === 'object' ? input.options : {};
      const host = Number(o.host ?? prev.host);
      if (!host || !db.prepare('SELECT 1 FROM proxmox_hosts WHERE id=?').get(host)) throw new HttpError(400, 'err.proxmoxHost');
      const metric = o.metric ?? prev.metric;
      if (!PROXMOX_METRICS.includes(metric)) throw new HttpError(400, 'err.sensorMetric');
      const base = ['nodeOnline', 'guestRunning', 'netOnline'].includes(metric) ? { op: 'eq', threshold: '', label: line(o.label ?? prev.label ?? '', 120) } : sensorOptions(input, old && old.type === 'proxmox' ? old : null);
      v.options = JSON.stringify({ host, metric, key: line(o.key ?? prev.key ?? '', 200), ...base });
      v.target = (base.label || metric).slice(0, 200);
      v.port = null;
    } else if (type === 'snmp') {
      if (!(isIPv4(target) || HOST.test(target))) throw new HttpError(400, 'err.host');
      v.target = target.toLowerCase();
      const p = int(String(input.port ?? old?.port ?? '')) || 161;
      if (p < 1 || p > 65535) throw new HttpError(400, 'err.port');
      v.port = p;
      const prev = old && old.type === 'snmp' ? parse(old.options, {}) : {};
      const oid = line(input.options?.oid ?? prev.oid ?? '', 200).replace(/^\./, '');
      if (!validOid(oid)) throw new HttpError(400, 'err.oid');
      v.options = JSON.stringify({ oid, ...sensorOptions(input, old && old.type === 'snmp' ? old : null) });
    } else if (type === 'smb') {
      // Network drive: \\host\share, optional folder or file, read-only account, warning below free space
      if (!(isIPv4(target) || HOST.test(target))) throw new HttpError(400, 'err.host');
      v.target = target.toLowerCase();
      const p = int(String(input.port ?? old?.port ?? '')) || 445;
      if (p < 1 || p > 65535) throw new HttpError(400, 'err.port');
      v.port = p;
      const prev = old && old.type === 'smb' ? parse(old.options, {}) : {};
      const o = input.options && typeof input.options === 'object' ? input.options : {};
      const share = line(o.share ?? prev.share ?? '', 80).replace(/^[\\/]+|[\\/]+$/g, '');
      if (!SHARE.test(share)) throw new HttpError(400, 'err.smbShare');
      const path = smbPath(o.path ?? prev.path ?? '');
      if (path === null) throw new HttpError(400, 'err.smbPath');
      const user = line(o.user ?? prev.user ?? '', 104);
      if (user && !SMB_USER.test(user)) throw new HttpError(400, 'err.smbUser');
      const domain = line(o.domain ?? prev.domain ?? '', 63);
      if (domain && !SMB_DOMAIN.test(domain)) throw new HttpError(400, 'err.smbDomain');
      const pct = Number(o.minFreePct ?? prev.minFreePct ?? 0) || 0;
      const gb = Number(o.minFreeGb ?? prev.minFreeGb ?? 0) || 0;
      if (pct < 0 || pct > 99 || gb < 0 || gb > 1e6) throw new HttpError(400, 'err.smbFree');
      v.options = JSON.stringify({ share, path, user, domain, minFreePct: Math.round(pct * 10) / 10, minFreeGb: Math.round(gb * 10) / 10 });
      if (typeof input.password === 'string' && input.password !== '') v.secret = encrypt(input.password.slice(0, 512));
      else if (input.clearPassword || !user) v.secret = '';
      else if (old && old.type === 'smb') v.secret = old.secret || '';
      else v.secret = '';
    } else if (type === 'docker') {
      if (!CONTAINER_NAME.test(target)) throw new HttpError(400, 'err.container');
      const hostId = int(String(input.docker_host_id ?? old?.docker_host_id ?? ''));
      if (!hostId || !db.prepare('SELECT 1 FROM docker_hosts WHERE id=?').get(hostId)) throw new HttpError(400, 'err.dockerHost');
      v.target = target;
      v.docker_host_id = hostId;
      v.port = null;
    } else if (DB_TYPES.includes(type)) {
      if (!(isIPv4(target) || HOST.test(target))) throw new HttpError(400, 'err.host');
      v.target = target.toLowerCase();
      const p = int(String(input.port ?? old?.port ?? '')) || DEFAULT_PORTS[type];
      if (p < 1 || p > 65535) throw new HttpError(400, 'err.port');
      v.port = p;
      const oldOpts = old && old.type === type ? parse(old.options, {}) : {};
      const o = input.options && typeof input.options === 'object' ? input.options : {};
      v.options = JSON.stringify({
        user: line(o.user ?? oldOpts.user ?? '', 120),
        database: type === 'redis' ? '' : line(o.database ?? oldOpts.database ?? '', 120),
        tls: !!(o.tls ?? oldOpts.tls),
      });
      // Password: only replaced when a new one is sent; kept otherwise (never sent back to the browser)
      if (typeof input.password === 'string' && input.password !== '') v.secret = encrypt(input.password.slice(0, 512));
      else if (input.clearPassword) v.secret = '';
      else if (old && old.type === type) v.secret = old.secret || '';
      else v.secret = '';
    } else if (type === 'http') {
      let u;
      try { u = new URL(target); } catch { throw new HttpError(400, 'err.url'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new HttpError(400, 'err.url');
      v.target = u.toString();
      v.port = null;
    } else {
      if (!(isIPv4(target) || HOST.test(target))) throw new HttpError(400, 'err.host');
      v.target = target.toLowerCase();
      if (type === 'tcp') {
        const p = int(String(input.port ?? old?.port ?? ''));
        if (!p || p < 1 || p > 65535) throw new HttpError(400, 'err.port');
        v.port = p;
      } else {
        v.port = null;
        if (!old || old.type !== 'ping') { if (!(await pingAvailable())) throw new HttpError(400, 'err.pingUnavailable'); }
      }
    }
    if (!old) {
      const dev = input.device_id ? Number(input.device_id) : null;
      if (type === 'sensor' && !dev) throw new HttpError(400, 'err.sensorDevice');
      if (dev && !db.prepare('SELECT 1 FROM devices WHERE id=?').get(dev)) throw new HttpError(400, 'err.notFound');
      v.device_id = dev;
    }
    if ('enabled' in input) v.enabled = input.enabled ? 1 : 0;
    return v;
  }

  /** Sensible first monitor for an inventory device: its web interface, else ping, else an open port */
  async function suggestionFor(deviceId) {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    if (!d) throw new HttpError(404, 'err.notFound');
    if (!d.ip) throw new HttpError(400, 'err.noIp');
    const facts = parse(d.facts, {});
    const web = d.web_url && /^https?:/i.test(d.web_url) ? d.web_url : bestWebUrl(d.ip, facts, d.type);
    if (web) return { name: d.name, type: 'http', target: web, tls_verify: false, device_id: d.id };
    if (await pingAvailable()) return { name: d.name, type: 'ping', target: d.ip, device_id: d.id };
    const port = (facts.ports || [])[0] || 22;
    return { name: d.name, type: 'tcp', target: d.ip, port, device_id: d.id };
  }

  // ---------------------------------------------------------------------------------------------------- CRUD
  async function create(input) {
    const v = await clean(input);
    const ts = iso();
    const cols = { ...v, created_at: ts, updated_at: ts, status: 'pending', status_since: ts };
    const keys = Object.keys(cols);
    const id = Number(db.prepare(`INSERT INTO monitors(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k])).lastInsertRowid);
    nextRun.set(id, 0);
    return get(id);
  }

  async function update(id, input) {
    const old = db.prepare('SELECT * FROM monitors WHERE id=?').get(id);
    if (!old) throw new HttpError(404, 'err.notFound');
    const v = await clean(input, old);
    const keys = Object.keys(v);
    db.prepare(`UPDATE monitors SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...keys.map((k) => v[k]), iso(), id);
    if (v.target !== old.target || v.type !== old.type || v.port !== old.port || v.docker_host_id !== old.docker_host_id) {
      db.prepare("UPDATE monitors SET status='pending', status_since=?, fail_count=0, cert_valid_to=NULL, cert_alert_days=NULL, data='{}' WHERE id=?").run(iso(), id);
    }
    nextRun.set(id, 0);
    return get(id);
  }

  function setEnabled(id, on) {
    const r = db.prepare(`UPDATE monitors SET enabled=?, status=?, status_since=?, fail_count=0, updated_at=? WHERE id=?`)
      .run(on ? 1 : 0, on ? 'pending' : 'paused', iso(), iso(), id);
    if (!r.changes) throw new HttpError(404, 'err.notFound');
    nextRun.set(id, 0);
    return get(id);
  }

  function remove(id) {
    if (!db.prepare('DELETE FROM monitors WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
    nextRun.delete(id);
  }

  // ---------------------------------------------------------------------------------------------------- stats
  function uptime(id, hours) {
    const since = hourOf(new Date(now().getTime() - hours * 3600 * 1000));
    const r = db.prepare('SELECT SUM(ok) ok, SUM(total) total, SUM(ms_sum) ms FROM monitor_hourly WHERE monitor_id=? AND hour>=?').get(id, since);
    return r.total ? { pct: Math.round((r.ok / r.total) * 10000) / 100, avgMs: r.ok ? Math.round(r.ms / r.ok) : null, checks: r.total } : { pct: null, avgMs: null, checks: 0 };
  }

  function shape(m) {
    if (!m) return null;
    const certDays = m.cert_valid_to ? Math.floor((Date.parse(m.cert_valid_to) - now().getTime()) / 86400000) : null;
    const { secret, data, ...rest } = m;
    return { ...rest, data: parse(data, {}), channels: parse(m.channels, []), options: parse(m.options, {}), has_password: !!secret, enabled: !!m.enabled, tls_verify: !!m.tls_verify,
      cert_check: !!m.cert_check, cert_days_left: certDays,
      docker_host: m.docker_host_id ? db.prepare('SELECT id, name FROM docker_hosts WHERE id=?').get(m.docker_host_id) || null : null };
  }

  function get(id) { return shape(db.prepare('SELECT * FROM monitors WHERE id=?').get(id)); }

  function list() {
    const rows = db.prepare('SELECT m.*, d.name device_name FROM monitors m LEFT JOIN devices d ON d.id=m.device_id ORDER BY m.name').all();
    const beats = db.prepare(`SELECT monitor_id, ok, ms, at, message FROM (
      SELECT monitor_id, ok, ms, at, message, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY id DESC) rn FROM checks
      WHERE at >= ?) WHERE rn <= 40 ORDER BY monitor_id, at`).all(iso(new Date(now().getTime() - 86400000)));
    const byMon = new Map();
    for (const b of beats) { if (!byMon.has(b.monitor_id)) byMon.set(b.monitor_id, []); byMon.get(b.monitor_id).push({ ok: !!b.ok, ms: b.ms, at: b.at, message: b.message }); }
    return rows.map((m) => ({ ...shape(m), uptime24: uptime(m.id, 24).pct, beats: byMon.get(m.id) || [] }));
  }

  function detail(id, hours = 24) {
    const m = get(id);
    if (!m) throw new HttpError(404, 'err.notFound');
    const span = Math.min(24 * 7, Math.max(1, Number(hours) || 24));
    const checks = db.prepare('SELECT at, ok, ms, message FROM checks WHERE monitor_id=? AND at>=? ORDER BY at')
      .all(id, iso(new Date(now().getTime() - span * 3600 * 1000))).map((c) => ({ ...c, ok: !!c.ok }));
    const device = m.device_id ? db.prepare('SELECT id, name, type FROM devices WHERE id=?').get(m.device_id) : null;
    return {
      ...m, device,
      uptime: { h24: uptime(id, 24), d7: uptime(id, 24 * 7), d30: uptime(id, 24 * 30) },
      checks,
      events: db.prepare('SELECT * FROM monitor_events WHERE monitor_id=? ORDER BY id DESC LIMIT 100').all(id),
      maintenance: !!maintenance.activeFor(id, now()),
    };
  }

  /** keep(m): optional filter (location limit of the user) */
  function summary(keep = null) {
    const rows = db.prepare('SELECT id, name, status, status_since, last_message, enabled, cert_valid_to, device_id FROM monitors').all().filter((m) => !keep || keep(m));
    const soon = rows.filter((m) => m.cert_valid_to && (Date.parse(m.cert_valid_to) - now().getTime()) / 86400000 <= 30)
      .map((m) => ({ id: m.id, name: m.name, cert_valid_to: m.cert_valid_to }));
    return {
      total: rows.length,
      up: rows.filter((m) => m.status === 'up').length,
      down: rows.filter((m) => m.status === 'down').map((m) => ({ id: m.id, name: m.name, since: m.status_since, message: m.last_message })),
      pending: rows.filter((m) => m.status === 'pending' && m.enabled).length,
      paused: rows.filter((m) => !m.enabled).length,
      maintenance: rows.filter((m) => m.status === 'maintenance').length,
      certs: soon,
    };
  }

  /** Status per inventory device (worst of its monitors): up | down | pending | maintenance | paused */
  function deviceStatus() {
    const order = { down: 5, pending: 4, maintenance: 3, up: 2, paused: 1 };
    const map = {};
    for (const m of db.prepare('SELECT device_id, status FROM monitors WHERE device_id IS NOT NULL').all()) {
      if (!map[m.device_id] || (order[m.status] || 0) > (order[map[m.device_id]] || 0)) map[m.device_id] = m.status;
    }
    return map;
  }

  // ---------------------------------------------------------------------------------------------------- checks
  function event(m, kind, message, notified = []) {
    db.prepare('INSERT INTO monitor_events(monitor_id,at,kind,message,notified) VALUES(?,?,?,?,?)').run(m.id, iso(now()), kind, String(message).slice(0, 500), notified.join(', '));
  }

  async function checkNow(id) {
    const m = db.prepare('SELECT * FROM monitors WHERE id=?').get(id);
    if (!m) throw new HttpError(404, 'err.notFound');
    await runOne(m);
    return get(id);
  }

  async function runOne(m) {
    if (running.has(m.id)) return;
    running.add(m.id);
    try {
      const res = await runCheck(m, checkCtx);
      await record(m, res);
    } catch (e) {
      log.warn(`Monitor ${m.id} (${m.name}): ${e.message}`);
    } finally {
      running.delete(m.id);
      nextRun.set(m.id, Date.now() + m.interval_s * 1000);
    }
  }

  async function record(m0, res) {
    const at = now();
    const m = db.prepare('SELECT * FROM monitors WHERE id=?').get(m0.id);
    if (!m) return; // deleted meanwhile
    const ok = res.ok ? 1 : 0;
    const msg = String(res.message || '').slice(0, 300);
    db.transaction(() => {
      db.prepare('INSERT INTO checks(monitor_id,at,ok,ms,message) VALUES(?,?,?,?,?)').run(m.id, iso(at), ok, res.ms ?? null, msg);
      db.prepare(`INSERT INTO monitor_hourly(monitor_id,hour,ok,total,ms_sum) VALUES(?,?,?,1,?)
        ON CONFLICT(monitor_id,hour) DO UPDATE SET ok=ok+excluded.ok, total=total+1, ms_sum=ms_sum+excluded.ms_sum`).run(m.id, hourOf(at), ok, ok ? (res.ms || 0) : 0);
    })();

    const inMaintenance = !!maintenance.activeFor(m.id, at);
    const set = { last_check: iso(at), last_ms: res.ms ?? null, last_message: msg };
    if (res.data && typeof res.data === 'object') set.data = JSON.stringify({ ...res.data, at: iso(at) });
    // Measured values: without a value in this check the old one must not stay on display
    else if (['sensor', 'snmp', 'proxmox'].includes(m.type)) set.data = '{}';
    let notifyEv = null;

    if (inMaintenance) {
      if (m.status !== 'maintenance') { set.status = 'maintenance'; set.status_since = iso(at); event(m, 'maintenance', msg); }
      set.fail_count = 0;
    } else if (ok) {
      set.fail_count = 0;
      if (m.status !== 'up') {
        set.status = 'up';
        set.status_since = iso(at);
        if (m.notified_down) {
          const downSince = Date.parse(m.status_since) || at.getTime();
          notifyEv = { kind: 'up', downtimeMin: Math.max(1, Math.round((at.getTime() - downSince) / 60000)) };
          set.notified_down = 0;
        }
        if (m.status === 'down' || notifyEv) event(m, 'up', msg);
      }
    } else {
      set.fail_count = m.fail_count + 1;
      if (set.fail_count >= m.fail_threshold) {
        if (m.status !== 'down') {
          set.status = 'down';
          set.status_since = iso(at);
          notifyEv = { kind: 'down', message: msg };
          set.notified_down = 1;
          set.last_alert_at = iso(at);
        } else if (m.resend_min > 0 && m.last_alert_at && at.getTime() - Date.parse(m.last_alert_at) >= m.resend_min * 60000) {
          notifyEv = { kind: 'down', message: msg };
          set.last_alert_at = iso(at);
        }
      } else if (m.status === 'up' || m.status === 'maintenance') {
        set.status = 'pending';
        set.status_since = iso(at);
      }
    }

    // Certificate expiry
    let certEv = null;
    if (res.cert?.validTo && m.cert_check) {
      set.cert_valid_to = res.cert.validTo;
      const days = Math.floor((Date.parse(res.cert.validTo) - at.getTime()) / 86400000);
      const step = certStep(days, parseCertDays(m.cert_days));
      if (step === null) set.cert_alert_days = null;
      else if (m.cert_alert_days === null || step < m.cert_alert_days) {
        set.cert_alert_days = step;
        if (!inMaintenance) certEv = { kind: 'cert', certDays: days, certValidTo: res.cert.validTo };
      }
    }

    const keys = Object.keys(set);
    db.prepare(`UPDATE monitors SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => set[k]), m.id);

    const mon = { id: m.id, name: m.name, target: m.type === 'tcp' ? `${m.target}:${m.port}` : m.target, channels: m.channels };
    for (const ev of [notifyEv, certEv].filter(Boolean)) {
      const reached = await channels.notify(mon, { ...ev, monitor: mon, at: iso(at) });
      if (ev.kind === 'down') event(m, 'down', msg, reached);
      if (ev.kind === 'cert') event(m, 'cert', `${ev.certDays}`, reached);
      if (ev.kind === 'up') db.prepare("UPDATE monitor_events SET notified=? WHERE id=(SELECT MAX(id) FROM monitor_events WHERE monitor_id=? AND kind='up')").run(reached.join(', '), m.id);
    }
  }

  function tick() {
    const t = Date.now();
    const due = db.prepare('SELECT * FROM monitors WHERE enabled=1').all()
      .filter((m) => !running.has(m.id) && (nextRun.get(m.id) ?? 0) <= t);
    for (const m of due.slice(0, Math.max(0, MAX_PARALLEL - running.size))) {
      nextRun.set(m.id, t + m.interval_s * 1000);
      runOne(m);
    }
  }

  return {
    create, update, remove, get, list, detail, summary, deviceStatus, suggestionFor, checkNow,
    pause: (id) => setEnabled(id, false),
    resume: (id) => setEnabled(id, true),
    record,
    start() {
      if (timer) return;
      // Spread the first checks over a few seconds after start
      for (const m of db.prepare('SELECT id, interval_s FROM monitors').all()) nextRun.set(m.id, Date.now() + Math.floor(Math.random() * Math.min(15, m.interval_s) * 1000));
      timer = setInterval(tick, 1000);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    cleanup() {
      db.prepare('DELETE FROM checks WHERE at < ?').run(iso(new Date(Date.now() - KEEP_CHECKS_DAYS * 86400000)));
      db.prepare('DELETE FROM monitor_hourly WHERE hour < ?').run(hourOf(new Date(Date.now() - KEEP_HOURLY_DAYS * 86400000)));
      db.prepare('DELETE FROM monitor_events WHERE at < ?').run(iso(new Date(Date.now() - KEEP_HOURLY_DAYS * 86400000)));
    },
  };
}
