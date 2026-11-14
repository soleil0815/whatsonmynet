// Monitoring: monitors (ping, TCP port, web address), the scheduler that runs their checks, status changes with
// notifications (only after several failed checks in a row), certificate expiry warnings, availability statistics.
import { HttpError, line, str, int, ids } from '../lib/http.js';
import { isIPv4, normalizeMac } from '../lib/net.js';
import { log } from '../lib/log.js';
import { runCheck, validStatusSpec } from './checks.js';
import { CONTAINER_NAME, DEFAULT_PORTS } from './services.js';
import { OPS, validOid } from './sensors.js';
import { SHARE, SMB_USER, SMB_DOMAIN, smbPath } from './smb.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { pingAvailable } from '../scan/probes.js';
import { bestWebUrl } from '../scan/engine.js';
import { forgetMonitors } from '../lib/idlists.js';
import { onIpMovedPaused } from '../devicechange.js';

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
  if (list.some((n) => !Number.isInteger(n) || n < 1 || n > 365) || list.length > 5) throw new HttpError(400, 'err.certDays', undefined, 'cert_days');
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
export const PROXMOX_METRICS = ['nodeOnline', 'nodeCpu', 'nodeMem', 'nodeTemp', 'storage', 'guestRunning', 'backupAge', 'backupFailed', 'datastore', 'groupAge', 'tasksFailed', 'netOnline', 'netClients', 'netCpu', 'netMem', 'clientsTotal', 'netUpdates',
  'rfHealth', 'rfPower', 'rfFan', 'rfTemp', 'rfPsu', 'rfDrive', 'rfDriveLife', 'rfVolume', 'rfWatts'];
export const SENSOR_METRICS = ['supply', 'pages', 'printerErrors', 'volume', 'temp', 'diskTemp', 'disk', 'raid', 'health', 'port', 'portErrors', 'hostOnline', 'hostCpu', 'hostMem', 'hostDisk', 'servicesFailed', 'service', 'upsPower', 'upsCharge', 'upsRuntime', 'upsLoad',
  'hostPdHealth', 'hostPdTemp', 'hostPdWear', 'hostUpdates', 'hostUpdatesSec', 'hostReboot', 'hostAv', 'hostFirewall', 'hostEvCritical', 'hostEvErrors', 'hostCert', 'hostTemp', 'hostTempMax'];
const DB_TYPES = ['mysql', 'postgres', 'redis'];
const CONNECT_TYPES = ['http', 'tcp', 'ping'];
const VALUE_TYPES = ['sensor', 'snmp', 'proxmox'];

/** A stored password only stays with the address it was entered for: whoever moves the monitor to another host or port
 *  must type it again - otherwise an editor could have it sent to a machine of his own */
function keepSecret(old, v) {
  if (!old.secret) return '';
  if (String(old.target || '').toLowerCase() !== String(v.target || '').toLowerCase() || Number(old.port) !== Number(v.port)) throw new HttpError(400, 'err.passwordAgain');
  return old.secret;
}
const SECRET_TYPES = [...DB_TYPES, 'smb'];
// Monitors that say whether a device is reachable at all - only these make sense as "everything behind it" parent
export const REACH_TYPES = ['ping', 'tcp', 'http', 'snmp'];
const MAX_DEPTH = 20;

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

  // ---------------------------------------------------------------------------------------------------- escalation
  /** { min, ids } for a monitor: its own values, otherwise the setting for all monitors */
  function escalation(m) {
    const own = parse(m.escalate_channels, []);
    const min = m.escalate_min === null || m.escalate_min === undefined ? Number(settings?.get('escalate.min')) || 0 : m.escalate_min;
    const ids = own.length ? own : (settings?.get('escalate.channels') || []);
    return { min, ids: ids.map(Number).filter((x) => Number.isInteger(x) && x > 0) };
  }
  /** The channels the normal messages of a monitor go to (empty list = the default channels) */
  function normalChannelIds(m) {
    const own = parse(m.channels, []);
    return own.length ? own : db.prepare('SELECT id FROM channels WHERE enabled=1 AND is_default=1').all().map((r) => r.id);
  }

  // ---------------------------------------------------------------------------------------------------- dependencies
  const parentStmt = db.prepare('SELECT id, name, status, fail_count, enabled, parent_id FROM monitors WHERE id=?');
  /** "Depends on": an existing monitor, not itself, and no circle (A behind B behind A) */
  function cleanParent(input, old) {
    const raw = input.parent_id !== undefined ? input.parent_id : old?.parent_id;
    if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') return null;
    const pid = int(String(raw));
    if (!pid || !parentStmt.get(pid)) throw new HttpError(400, 'err.parentMonitor');
    if (old) {
      let id = pid;
      for (let i = 0; id && i < MAX_DEPTH; i++) {
        if (id === old.id) throw new HttpError(400, 'err.parentCycle');
        id = parentStmt.get(id)?.parent_id;
      }
    }
    return pid;
  }

  /**
   * Is something in front of this monitor down? → { state: 'down', mon } (then this one is only a follow-up),
   * { state: 'wait', mon } when the one in front failed its last check but is not down yet (checked again right away).
   */
  function blocker(m) {
    let id = m.parent_id;
    const seen = new Set([m.id]);
    while (id && !seen.has(id) && seen.size <= MAX_DEPTH) {
      seen.add(id);
      const p = parentStmt.get(id);
      if (!p) break;
      // In maintenance counts like down: the work on the switch is the reason, not the NAS behind it
      if (p.enabled && (p.status === 'down' || p.status === 'unreachable' || p.status === 'maintenance')) return { state: 'down', mon: p };
      if (p.enabled && p.fail_count > 0) return { state: 'wait', mon: p };
      id = p.parent_id;
    }
    return null;
  }

  // Which switch is a device plugged in at? The port with the fewest addresses (an uplink sees many devices).
  const locateStmt = db.prepare(`SELECT s.switch_id FROM switch_macs s WHERE s.mac=?
    ORDER BY (SELECT COUNT(*) FROM switch_macs x WHERE x.switch_id=s.switch_id AND x.if_index=s.if_index), s.seen_at DESC LIMIT 1`);
  function switchOf(deviceId) {
    const mac = normalizeMac(db.prepare('SELECT mac FROM devices WHERE id=?').get(deviceId)?.mac);
    const sw = mac ? locateStmt.get(mac)?.switch_id : null;
    return sw && sw !== deviceId ? sw : null;
  }
  /** The monitor that tells whether a device is reachable (ping first) */
  function reachMonitorOf(deviceId) {
    return db.prepare(`SELECT id, name FROM monitors WHERE device_id=? AND type IN (${REACH_TYPES.map(() => '?').join(',')})
      ORDER BY enabled DESC, CASE type WHEN 'ping' THEN 0 WHEN 'snmp' THEN 1 WHEN 'tcp' THEN 2 ELSE 3 END, id LIMIT 1`).get(deviceId, ...REACH_TYPES) || null;
  }
  /** For a new monitor of a device: the monitor of the switch it is plugged in at */
  function suggestParent(deviceId) {
    const sw = deviceId ? switchOf(deviceId) : null;
    return sw ? reachMonitorOf(sw) : null;
  }
  /** Monitors of devices plugged in at the device of this monitor that have no dependency yet */
  function childCandidates(id) {
    const m = db.prepare('SELECT id, type, device_id FROM monitors WHERE id=?').get(id);
    if (!m || !m.device_id || !REACH_TYPES.includes(m.type)) return [];
    return db.prepare('SELECT id, name, device_id FROM monitors WHERE parent_id IS NULL AND device_id IS NOT NULL AND device_id<>? AND id<>?').all(m.device_id, id)
      .filter((c) => switchOf(c.device_id) === m.device_id);
  }
  /** Set this monitor as dependency of the given monitors (only candidates, never a circle) */
  function adoptChildren(id, only) {
    const list = childCandidates(id).filter((c) => !only || only(c));
    const up = db.prepare('UPDATE monitors SET parent_id=? WHERE id=? AND parent_id IS NULL');
    let n = 0;
    db.transaction(() => { for (const c of list) if (!wouldCycle(c.id, id)) n += up.run(id, c.id).changes; })();
    return n;
  }
  function wouldCycle(childId, parentId) {
    let id = parentId;
    for (let i = 0; id && i < MAX_DEPTH; i++) { if (id === childId) return true; id = parentStmt.get(id)?.parent_id; }
    return false;
  }

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
      // Escalation: '' / null = the setting for all monitors, 0 = never, otherwise minutes
      escalate_min: (() => {
        const raw = input.escalate_min !== undefined ? input.escalate_min : old?.escalate_min;
        if (raw === null || raw === undefined || raw === '') return null;
        return Math.min(1440, Math.max(0, int(String(raw)) || 0));
      })(),
      escalate_channels: JSON.stringify(ids(input.escalate_channels ?? parse(old?.escalate_channels, []), 50)),
    };
    if (!v.name) throw new HttpError(400, 'err.nameRequired', undefined, 'name');
    v.parent_id = cleanParent(input, old);
    if (!validStatusSpec(v.http_status)) throw new HttpError(400, 'err.httpStatus', undefined, 'http_status');
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
      // On a change the sensor may move to another value of another device (also from a hypervisor value to the script of a node)
      const deviceId = input.device_id !== undefined && input.device_id !== null && input.device_id !== '' ? Number(input.device_id) : old?.device_id;
      if (!deviceId || !db.prepare('SELECT 1 FROM devices WHERE id=?').get(deviceId)) throw new HttpError(400, 'err.sensorDevice');
      if (old) v.device_id = deviceId;
      const base = ['printerErrors', 'health', 'disk', 'raid', 'port', 'hostOnline', 'service', 'upsPower', 'hostPdHealth', 'hostReboot', 'hostAv', 'hostFirewall'].includes(metric) ? { op: 'eq', threshold: '', label: line(o.label ?? prev.label ?? '', 120) } : sensorOptions(input, old && old.type === 'sensor' ? old : null);
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
      const base = ['nodeOnline', 'guestRunning', 'netOnline', 'rfHealth', 'rfPower', 'rfFan', 'rfPsu', 'rfDrive', 'rfVolume'].includes(metric) ? { op: 'eq', threshold: '', label: line(o.label ?? prev.label ?? '', 120) } : sensorOptions(input, old && old.type === 'proxmox' ? old : null);
      v.options = JSON.stringify({ host, metric, key: line(o.key ?? prev.key ?? '', 200), ...base });
      // A device sensor that becomes a hypervisor value no longer belongs to the device (hypervisors have no location)
      if (old && old.type === 'sensor') v.device_id = null;
      v.target = (base.label || metric).slice(0, 200);
      v.port = null;
    } else if (type === 'snmp') {
      if (!(isIPv4(target) || HOST.test(target))) throw new HttpError(400, 'err.host', undefined, 'target');
      v.target = target.toLowerCase();
      const p = int(String(input.port ?? old?.port ?? '')) || 161;
      if (p < 1 || p > 65535) throw new HttpError(400, 'err.port', undefined, 'port');
      v.port = p;
      const prev = old && old.type === 'snmp' ? parse(old.options, {}) : {};
      const oid = line(input.options?.oid ?? prev.oid ?? '', 200).replace(/^\./, '');
      if (!validOid(oid)) throw new HttpError(400, 'err.oid', undefined, 'oid');
      v.options = JSON.stringify({ oid, ...sensorOptions(input, old && old.type === 'snmp' ? old : null) });
    } else if (type === 'smb') {
      // Network drive: \\host\share, optional folder or file, read-only account, warning below free space
      if (!(isIPv4(target) || HOST.test(target))) throw new HttpError(400, 'err.host', undefined, 'target');
      v.target = target.toLowerCase();
      const p = int(String(input.port ?? old?.port ?? '')) || 445;
      if (p < 1 || p > 65535) throw new HttpError(400, 'err.port', undefined, 'port');
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
      else if (old && old.type === 'smb') v.secret = keepSecret(old, v);
      else v.secret = '';
    } else if (type === 'docker') {
      if (!CONTAINER_NAME.test(target)) throw new HttpError(400, 'err.container', undefined, 'target');
      const hostId = int(String(input.docker_host_id ?? old?.docker_host_id ?? ''));
      if (!hostId || !db.prepare('SELECT 1 FROM docker_hosts WHERE id=?').get(hostId)) throw new HttpError(400, 'err.dockerHost', undefined, 'docker_host_id');
      v.target = target;
      v.docker_host_id = hostId;
      v.port = null;
    } else if (DB_TYPES.includes(type)) {
      if (!(isIPv4(target) || HOST.test(target))) throw new HttpError(400, 'err.host', undefined, 'target');
      v.target = target.toLowerCase();
      const p = int(String(input.port ?? old?.port ?? '')) || DEFAULT_PORTS[type];
      if (p < 1 || p > 65535) throw new HttpError(400, 'err.port', undefined, 'port');
      v.port = p;
      const oldOpts = old && old.type === type ? parse(old.options, {}) : {};
      const o = input.options && typeof input.options === 'object' ? input.options : {};
      v.options = JSON.stringify({
        user: line(o.user ?? oldOpts.user ?? '', 120),
        database: type === 'redis' ? '' : line(o.database ?? oldOpts.database ?? '', 120),
        tls: !!(o.tls ?? oldOpts.tls),
        // Check the server's certificate too (otherwise TLS encrypts, but anyone in between could pose as the server)
        verify: !!(o.tls ?? oldOpts.tls) && !!(o.verify ?? oldOpts.verify),
      });
      // Password: only replaced when a new one is sent; kept otherwise (never sent back to the browser)
      if (typeof input.password === 'string' && input.password !== '') v.secret = encrypt(input.password.slice(0, 512));
      else if (input.clearPassword) v.secret = '';
      else if (old && old.type === type) v.secret = keepSecret(old, v);
      else v.secret = '';
    } else if (type === 'http') {
      let u;
      try { u = new URL(target); } catch { throw new HttpError(400, 'err.url', undefined, 'target'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new HttpError(400, 'err.url', undefined, 'target');
      v.target = u.toString();
      v.port = null;
    } else {
      if (!(isIPv4(target) || HOST.test(target))) throw new HttpError(400, 'err.host', undefined, 'target');
      v.target = target.toLowerCase();
      if (type === 'tcp') {
        const p = int(String(input.port ?? old?.port ?? ''));
        if (!p || p < 1 || p > 65535) throw new HttpError(400, 'err.port', undefined, 'port');
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
    const parent = suggestParent(d.id);
    const base = await suggestKind(d, facts);
    return parent ? { ...base, parent_id: parent.id } : base;
  }

  async function suggestKind(d, facts) {
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
    // Paused because its device got a new IP (see devicechange.js): saved with a newly typed password it runs again
    // (at the address it was saved for - the dialog offers the new one)
    const ipMoved = !old.enabled && !!parse(old.data, {})?.ipMoved;
    const resumed = ipMoved && typeof input.password === 'string' && input.password !== '' && !!v.secret && !('enabled' in input && !input.enabled);
    if (resumed) { v.enabled = 1; v.last_message = ''; v.data = '{}'; }
    const keys = Object.keys(v);
    db.prepare(`UPDATE monitors SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...keys.map((k) => v[k]), iso(), id);
    if (resumed || v.target !== old.target || v.type !== old.type || v.port !== old.port || v.docker_host_id !== old.docker_host_id || ('device_id' in v && v.device_id !== old.device_id)) {
      db.prepare("UPDATE monitors SET status='pending', status_since=?, fail_count=0, cert_valid_to=NULL, cert_alert_days=NULL, data='{}' WHERE id=?").run(iso(), id);
    }
    nextRun.set(id, 0);
    return get(id);
  }

  function setEnabled(id, on) {
    // Resumed by hand: the note about a new IP of the device is done with (the monitor keeps its address)
    const r = db.prepare(`UPDATE monitors SET enabled=?, status=?, status_since=?, fail_count=0, updated_at=?,
      data=CASE WHEN ? AND json_valid(data) AND json_extract(data,'$.ipMoved') IS NOT NULL THEN json_remove(data,'$.ipMoved') ELSE data END WHERE id=?`)
      .run(on ? 1 : 0, on ? 'pending' : 'paused', iso(), iso(), on ? 1 : 0, id);
    if (!r.changes) throw new HttpError(404, 'err.notFound');
    nextRun.set(id, 0);
    return get(id);
  }

  function remove(id) {
    db.transaction(() => {
      if (!db.prepare('DELETE FROM monitors WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
      forgetMonitors(db, [id]);
    })();
    nextRun.delete(id);
  }

  // ---------------------------------------------------------------------------------------------------- stats
  function uptime(id, hours) {
    const since = hourOf(new Date(now().getTime() - hours * 3600 * 1000));
    const r = db.prepare('SELECT SUM(ok) ok, SUM(total) total, SUM(ms_sum) ms FROM monitor_hourly WHERE monitor_id=? AND hour>=?').get(id, since);
    return r.total ? { pct: Math.round((r.ok / r.total) * 10000) / 100, avgMs: r.ok ? Math.round(r.ms / r.ok) : null, checks: r.total } : { pct: null, avgMs: null, checks: 0 };
  }

  // Long ranges from the hourly table, grouped into buckets so that a year stays a readable chart
  const MAX_HOURS = 24 * 366;
  const bucketHours = (span) => (span <= 24 * 31 ? 6 : 24);
  /** [{ at, ok, total, avg, min, max }] per bucket, oldest first; empty buckets are left out */
  function history(id, span) {
    const size = bucketHours(span) * 3600 * 1000;
    const since = hourOf(new Date(now().getTime() - span * 3600 * 1000));
    const out = new Map();
    for (const r of db.prepare('SELECT hour, ok, total, v_n, v_sum, v_min, v_max FROM monitor_hourly WHERE monitor_id=? AND hour>=? ORDER BY hour').iterate(id, since)) {
      const t0 = Math.floor(Date.parse(`${r.hour}:00Z`) / size) * size;
      let b = out.get(t0);
      if (!b) out.set(t0, (b = { at: new Date(t0).toISOString(), ok: 0, total: 0, n: 0, sum: 0, min: null, max: null }));
      b.ok += r.ok; b.total += r.total; b.n += r.v_n; b.sum += r.v_sum;
      if (r.v_min !== null && (b.min === null || r.v_min < b.min)) b.min = r.v_min;
      if (r.v_max !== null && (b.max === null || r.v_max > b.max)) b.max = r.v_max;
    }
    return [...out.values()].map(({ n, sum, ...b }) => ({ ...b, avg: n ? Math.round((sum / n) * 100) / 100 : null }));
  }

  /**
   * Status as the user sees it: a maintenance window shows "maintenance" from its first minute (not only after the next
   * check), and a window that is over no longer does ("pending" until the next check says up or down). Only what is
   * shown changes - the stored status, alarms and dependencies still follow the checks.
   */
  function shownStatus(m, at = now()) {
    if (!m.enabled || m.status === 'paused') return m.status;
    if (maintenance?.activeFor?.(m.id, at)) return 'maintenance';
    return m.status === 'maintenance' ? 'pending' : m.status;
  }

  function shape(m) {
    if (!m) return null;
    const certDays = m.cert_valid_to ? Math.floor((Date.parse(m.cert_valid_to) - now().getTime()) / 86400000) : null;
    const { secret, data, ...rest } = m;
    return { ...rest, status: shownStatus(m), data: parse(data, {}), channels: parse(m.channels, []), escalate_channels: parse(m.escalate_channels, []), options: parse(m.options, {}), has_password: !!secret, enabled: !!m.enabled, tls_verify: !!m.tls_verify,
      cert_check: !!m.cert_check, cert_days_left: certDays,
      docker_host: m.docker_host_id ? db.prepare('SELECT id, name FROM docker_hosts WHERE id=?').get(m.docker_host_id) || null : null };
  }

  const brief = (r) => (r ? { id: r.id, name: r.name, status: shownStatus(r) } : null);

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
    const span = Math.min(MAX_HOURS, Math.max(1, Number(hours) || 24));
    // Up to 7 days every single check, beyond that the hourly summary (raw checks are kept 7 days)
    const long = span > KEEP_CHECKS_DAYS * 24;
    const checks = long ? [] : db.prepare('SELECT at, ok, ms, message FROM checks WHERE monitor_id=? AND at>=? ORDER BY at')
      .all(id, iso(new Date(now().getTime() - span * 3600 * 1000))).map((c) => ({ ...c, ok: !!c.ok }));
    const device = m.device_id ? db.prepare('SELECT id, name, type FROM devices WHERE id=?').get(m.device_id) : null;
    return {
      ...m, device,
      uptime: { h24: uptime(id, 24), d7: uptime(id, 24 * 7), d30: uptime(id, 24 * 30), ...(long ? { span: uptime(id, span) } : {}) },
      checks,
      ...(long ? { history: history(id, span), bucketHours: bucketHours(span) } : {}),
      events: db.prepare('SELECT * FROM monitor_events WHERE monitor_id=? ORDER BY id DESC LIMIT 100').all(id),
      parent: m.parent_id ? brief(db.prepare('SELECT id, name, status, enabled FROM monitors WHERE id=?').get(m.parent_id)) : null,
      dependents: db.prepare('SELECT id, name, status, enabled FROM monitors WHERE parent_id=? ORDER BY name').all(id).map(brief),
      candidates: childCandidates(id).length,
      maintenance: !!maintenance.activeFor(id, now()),
    };
  }

  /** keep(m): optional filter (location limit of the user) */
  function summary(keep = null) {
    const rows = db.prepare('SELECT id, name, type, status, status_since, last_message, enabled, cert_valid_to, device_id FROM monitors').all().filter((m) => !keep || keep(m))
      .map((m) => ({ ...m, status: shownStatus(m) }));
    const soon = rows.filter((m) => m.cert_valid_to && (Date.parse(m.cert_valid_to) - now().getTime()) / 86400000 <= 30)
      .map((m) => ({ id: m.id, name: m.name, cert_valid_to: m.cert_valid_to }));
    return {
      total: rows.length,
      up: rows.filter((m) => m.status === 'up').length,
      down: rows.filter((m) => m.status === 'down').map((m) => ({ id: m.id, name: m.name, type: m.type, since: m.status_since, message: m.last_message })),
      unreachable: rows.filter((m) => m.status === 'unreachable').length,
      pending: rows.filter((m) => m.status === 'pending' && m.enabled).length,
      paused: rows.filter((m) => !m.enabled).length,
      maintenance: rows.filter((m) => m.status === 'maintenance').length,
      certs: soon,
    };
  }

  /** Status per inventory device (worst of its monitors): up | down | unreachable | pending | maintenance | paused */
  function deviceStatus() {
    const order = { down: 6, unreachable: 5, pending: 4, maintenance: 3, up: 2, paused: 1 };
    const map = {};
    for (const row of db.prepare('SELECT id, device_id, status, enabled FROM monitors WHERE device_id IS NOT NULL').all()) {
      const m = { ...row, status: shownStatus(row) };
      if (!map[m.device_id] || (order[m.status] || 0) > (order[map[m.device_id]] || 0)) map[m.device_id] = m.status;
    }
    return map;
  }

  // ---------------------------------------------------------------------------------------------------- checks
  function event(m, kind, message, notified = []) {
    db.prepare('INSERT INTO monitor_events(monitor_id,at,kind,message,notified) VALUES(?,?,?,?,?)').run(m.id, iso(now()), kind, String(message).slice(0, 500), notified.join(', '));
  }

  // A monitor with a stored password paused because its device has a new IP (devicechange.js): its channels are
  // told like for any other alarm - a database or share check must not stop silently
  onIpMovedPaused(db, async (list) => {
    for (const x of list) {
      const ev = db.prepare("SELECT id, at FROM monitor_events WHERE id=? AND monitor_id=? AND kind='ipMoved'").get(x.eventId, x.monitorId);
      const m = ev && db.prepare('SELECT * FROM monitors WHERE id=?').get(x.monitorId);
      if (!m) continue; // rolled back or deleted meanwhile
      const mon = { id: m.id, name: m.name, type: m.type, label: parse(m.options, {}).label || '', target: m.type === 'tcp' ? `${m.target}:${m.port}` : m.target, channels: m.channels };
      const reached = await channels.notify(mon, { kind: 'ipMoved', from: x.from, to: x.to, message: `${x.from} → ${x.to}`, monitor: mon, at: ev.at });
      db.prepare('UPDATE monitor_events SET notified=? WHERE id=?').run(reached.join(', '), ev.id);
    }
  });

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
      nextRun.set(m.id, performance.now() + m.interval_s * 1000);
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
      // v_*: every measured value (response time, sensor value - also while the alarm is on) for the long history
      const v = Number.isFinite(res.ms) ? res.ms : null;
      db.prepare(`INSERT INTO monitor_hourly(monitor_id,hour,ok,total,ms_sum,v_n,v_sum,v_min,v_max) VALUES(?,?,?,1,?,?,?,?,?)
        ON CONFLICT(monitor_id,hour) DO UPDATE SET ok=ok+excluded.ok, total=total+1, ms_sum=ms_sum+excluded.ms_sum,
          v_n=v_n+excluded.v_n, v_sum=v_sum+excluded.v_sum,
          v_min=CASE WHEN excluded.v_min IS NULL THEN v_min WHEN v_min IS NULL OR excluded.v_min<v_min THEN excluded.v_min ELSE v_min END,
          v_max=CASE WHEN excluded.v_max IS NULL THEN v_max WHEN v_max IS NULL OR excluded.v_max>v_max THEN excluded.v_max ELSE v_max END`)
        .run(m.id, hourOf(at), ok, ok ? (res.ms || 0) : 0, v === null ? 0 : 1, v ?? 0, v, v);
    })();
    // Paused while this check was running: the result is kept, but no state change and no alarm
    if (!m.enabled) return;

    const inMaintenance = !!maintenance.activeFor(m.id, at);
    const set = { last_check: iso(at), last_ms: res.ms ?? null, last_message: msg };
    if (res.data && typeof res.data === 'object') set.data = JSON.stringify({ ...res.data, at: iso(at) });
    // Measured values: without a value in this check the old one must not stay on display
    else if (['sensor', 'snmp', 'proxmox'].includes(m.type)) set.data = '{}';
    let notifyEv = null;
    // Start of the outage that was alarmed: a maintenance window in between moved status_since to its own start, the
    // "down" event of the alarm still has the real one
    // (the first "down" event after the last "up" - later ones are repeated alarms)
    const outageStart = () => {
      if (m.status !== 'maintenance') return m.status_since;
      const ev = db.prepare(`SELECT MIN(at) at FROM monitor_events WHERE monitor_id=? AND kind='down'
        AND id > COALESCE((SELECT MAX(id) FROM monitor_events WHERE monitor_id=? AND kind='up'), 0)`).get(m.id, m.id);
      return ev?.at && ev.at <= m.status_since ? ev.at : m.status_since;
    };
    // Alarmed outage, maintenance over, still failing: the same outage goes on - back to down without a second alarm
    // (only when no check inside the window succeeded - a recovery in between makes the next failure a new outage)
    const outageGoesOn = !inMaintenance && !ok && m.status === 'maintenance' && !!m.notified_down
      && !db.prepare('SELECT 1 FROM checks WHERE monitor_id=? AND ok=1 AND at>=? LIMIT 1').get(m.id, m.status_since);

    if (outageGoesOn) {
      set.fail_count = Math.max(m.fail_count + 1, m.fail_threshold);
      set.status = 'down';
      set.status_since = outageStart();
    } else if (inMaintenance) {
      if (m.status !== 'maintenance') { set.status = 'maintenance'; set.status_since = iso(at); event(m, 'maintenance', msg); }
      set.fail_count = 0;
    } else if (ok) {
      set.fail_count = 0;
      if (m.status !== 'up') {
        set.status = 'up';
        set.status_since = iso(at);
        if (m.notified_down) {
          const downSince = Date.parse(outageStart()) || at.getTime();
          notifyEv = { kind: 'up', downtimeMin: Math.max(1, Math.round((at.getTime() - downSince) / 60000)) };
          set.notified_down = 0;
        }
        if (m.status === 'down' || m.status === 'unreachable' || notifyEv) event(m, 'up', msg);
        // What hangs behind it is checked again right away: still failing means a problem of its own
        if (m.status === 'down' || m.status === 'unreachable') {
          for (const c of db.prepare("SELECT id FROM monitors WHERE parent_id=? AND status IN ('unreachable','pending')").all(m.id)) nextRun.set(c.id, 0);
        }
      }
    } else {
      set.fail_count = m.fail_count + 1;
      // Something in front of it (switch, router, line) is down: follow-up outage, no own alarm
      const b = set.fail_count >= m.fail_threshold && m.status !== 'down' ? blocker(m) : null;
      if (b?.state === 'down') {
        if (m.status !== 'unreachable') { set.status = 'unreachable'; set.status_since = iso(at); event(m, 'unreachable', b.mon.name); }
      } else if (b?.state === 'wait') {
        // The one in front failed too but is not down yet - wait for it instead of raising an alarm of our own
        if (m.status !== 'pending') { set.status = 'pending'; set.status_since = iso(at); }
        nextRun.set(b.mon.id, 0);
      } else if (set.fail_count >= m.fail_threshold) {
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

    // Escalation: still down after the set time - once more, to further channels (e.g. the boss, a second team)
    let escEv = null;
    const esc = escalation(m);
    const stillDown = (set.status ?? m.status) === 'down' && !inMaintenance;
    // Reset only when it is up again: an outage that went into a maintenance window still gets its all clear
    // to the escalation channels afterwards
    if (!stillDown) {
      if (m.escalated_at && (set.status ?? m.status) === 'up') set.escalated_at = null;
    } else if (!m.escalated_at && esc.min > 0 && esc.ids.length && (m.notified_down || set.notified_down)) {
      const since = Date.parse(set.status_since ?? m.status_since) || at.getTime();
      const downMin = Math.floor((at.getTime() - since) / 60000);
      if (downMin >= esc.min) { escEv = { kind: 'escalate', message: msg, downMin }; set.escalated_at = iso(at); }
    }

    // Certificate expiry
    let certEv = null;
    if (res.cert?.validTo && m.cert_check) {
      set.cert_valid_to = res.cert.validTo;
      const days = Math.floor((Date.parse(res.cert.validTo) - at.getTime()) / 86400000);
      const step = certStep(days, parseCertDays(m.cert_days));
      if (step === null) set.cert_alert_days = null;
      // During maintenance the warning waits (stored only once it was sent - otherwise it would be lost for good)
      else if ((m.cert_alert_days === null || step < m.cert_alert_days) && !inMaintenance) {
        set.cert_alert_days = step;
        certEv = { kind: 'cert', certDays: days, certValidTo: res.cert.validTo };
      }
    }

    const keys = Object.keys(set);
    db.prepare(`UPDATE monitors SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => set[k]), m.id);

    const mon = { id: m.id, name: m.name, type: m.type, label: parse(m.options, {}).label || '', target: m.type === 'tcp' ? `${m.target}:${m.port}` : m.target, channels: m.channels };
    // For the words of the alarm: connection (http, tcp, ping) - measured value over its limit - state - no values at all
    const family = CONNECT_TYPES.includes(m.type) ? 'reach' : res.data && res.data.v !== undefined && res.data.op ? 'value'
      : VALUE_TYPES.includes(m.type) && !res.data ? 'nodata' : 'state';
    for (const ev of [notifyEv, escEv]) if (ev) ev.family = family;
    if (escEv) {
      const reached = await channels.notifyIds(esc.ids, { ...escEv, monitor: mon, at: iso(at) });
      event(m, 'escalated', String(escEv.downMin), reached);
    }
    // All clear after an escalation: also to the escalation channels that did not get the normal message
    if (notifyEv?.kind === 'up' && m.escalated_at) {
      const normal = new Set(normalChannelIds(m));
      const extra = esc.ids.filter((id) => !normal.has(id));
      if (extra.length) await channels.notifyIds(extra, { ...notifyEv, monitor: mon, at: iso(at) });
    }
    for (const ev of [notifyEv, certEv].filter(Boolean)) {
      const reached = await channels.notify(mon, { ...ev, monitor: mon, at: iso(at) });
      if (ev.kind === 'down') event(m, 'down', msg, reached);
      if (ev.kind === 'cert') event(m, 'cert', `${ev.certDays}`, reached);
      if (ev.kind === 'up') db.prepare("UPDATE monitor_events SET notified=? WHERE id=(SELECT MAX(id) FROM monitor_events WHERE monitor_id=? AND kind='up')").run(reached.join(', '), m.id);
    }
  }

  function tick() {
    // Planned on the monotonic clock: setting the system time back (NTP, snapshot) must not pause the checks
    const t = performance.now();
    const due = db.prepare('SELECT * FROM monitors WHERE enabled=1').all()
      .filter((m) => !running.has(m.id) && (nextRun.get(m.id) ?? 0) <= t);
    for (const m of due.slice(0, Math.max(0, MAX_PARALLEL - running.size))) {
      nextRun.set(m.id, t + m.interval_s * 1000);
      runOne(m);
    }
  }

  return {
    create, update, remove, get, list, detail, summary, deviceStatus, suggestionFor, checkNow, childCandidates, adoptChildren,
    pause: (id) => setEnabled(id, false),
    resume: (id) => setEnabled(id, true),
    record,
    start() {
      if (timer) return;
      // Spread the first checks over a few seconds after start
      for (const m of db.prepare('SELECT id, interval_s FROM monitors').all()) nextRun.set(m.id, performance.now() + Math.floor(Math.random() * Math.min(15, m.interval_s) * 1000));
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
