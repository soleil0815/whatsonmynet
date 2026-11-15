// "How it is checked": what exactly a monitor or sensor asks, where its values come from, how old they are and when
// it alarms - so a message can be traced back to its source (nothing is hidden behind a red dot).
// Plain facts; the interface puts them into words (DE/EN).
import { stateOf, HYSTERESIS } from './sensors.js';

const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };
// Sensors that judge a state, not a number against a limit
const STATE_METRICS = new Set(['disk', 'raid', 'health', 'upsPower', 'service', 'hostOnline', 'nodeOnline', 'netOnline', 'guestRunning', 'port',
  'printerErrors', 'rfHealth', 'rfPower', 'rfFan', 'rfPsu', 'rfDrive', 'rfMemory', 'rfCpu', 'cloudCheck', 'dbState']);

export function explain(db, settings, m) {
  const o = parse(m.options);
  const out = { type: m.type, interval_s: m.interval_s, timeout_s: m.timeout_s, fail_threshold: m.fail_threshold, last_check: m.last_check,
    last_message: m.last_message || '' };
  if (m.type === 'sensor') {
    const s = stateOf(db, m.device_id);
    const kind = s?.kind || null;
    const every = kind === 'printer' ? Number(settings.get('printer.interval')) || 60 : kind === 'host' ? 5 : Number(settings.get('snmpdev.interval')) || 15;
    out.source = { kind, at: s?.at || null, everyMin: kind ? every : null, staleMin: kind === 'host' ? 15 : 180, ok: s ? s.ok !== false : null,
      kept: s?.data?.kept ? Object.keys(s.data.kept) : [] };
    Object.assign(out, metricFacts(o));
  } else if (m.type === 'proxmox') {
    const h = db.prepare('SELECT name, kind, last_at, last_ok, last_error FROM proxmox_hosts WHERE id=?').get(o.host);
    out.source = { kind: h?.kind || null, name: h?.name || '', at: h?.last_at || null, everyMin: 5, staleMin: 30, ok: h ? !!h.last_ok : null, error: h?.last_error || '' };
    Object.assign(out, metricFacts(o));
  } else if (m.type === 'snmp') {
    Object.assign(out, { oid: o.oid || '', op: o.op || '', threshold: o.threshold ?? '', unit: o.unit || '' });
  } else if (m.type === 'http') {
    Object.assign(out, { status: m.http_status || '', keyword: m.http_keyword || '', verify: !!m.tls_verify });
  } else if (m.type === 'smb') {
    Object.assign(out, { share: o.share || '', path: o.path || '', minFreePct: Number(o.minFreePct) || null, minFreeGb: Number(o.minFreeGb) || null });
  } else if (['dns', 'mail', 'ldap', 'ntp', 'mssql'].includes(m.type)) {
    Object.assign(out, { port: m.port, rtype: o.rtype || '', server: o.server || '', expect: o.expect || '', proto: o.proto || '', tlsMode: o.tls || '', verify: !!m.tls_verify,
      maxOffsetMs: o.maxOffsetMs || null, instance: o.instance || '' });
  } else if (m.type === 'event') {
    const d = m.device_id ? db.prepare('SELECT name, ip FROM devices WHERE id=?').get(m.device_id) : null;
    Object.assign(out, { eventSource: o.source || 'any', device: d ? `${d.name}${d.ip ? ` (${d.ip})` : ''}` : '', maxSeverity: o.maxSeverity ?? 4, holdMin: o.holdMin || 15, match: o.match || '' });
  } else if (m.type === 'docker') {
    const d = m.docker_host_id ? db.prepare('SELECT name FROM docker_hosts WHERE id=?').get(m.docker_host_id) : null;
    out.dockerHost = d?.name || '';
  }
  return out;
}

function metricFacts(o) {
  const state = STATE_METRICS.has(o.metric) || !o.op;
  return { metric: o.metric || '', key: o.key ?? '', label: o.label || o.metric || '', state, op: state ? '' : o.op, threshold: state ? '' : (o.threshold ?? ''),
    hysteresisFor: state ? null : HYSTERESIS };
}
