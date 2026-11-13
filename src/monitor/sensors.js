// Sensors: monitors on values the devices already deliver (printer supplies, NAS volumes/disks/temperature,
// switch ports) and on any SNMP value (OID) - like the sensors of PRTG. A sensor check reads the latest state the
// pollers stored (no extra traffic to the device); the free SNMP sensor asks the device itself (read-only).
import { openSnmp, getValues, text } from '../scan/snmpwalk.js';
import { nasProblems } from '../scan/nas.js';
import { proxmoxMetrics } from '../proxmox.js';
import { certName, daysLeft } from '../hostfacts.js';

export const OPS = ['lt', 'le', 'gt', 'ge', 'eq', 'ne', 'contains', 'notcontains'];
const OID = /^\.?([0-2])(\.\d{1,10}){2,40}$/;
export const validOid = (s) => OID.test(String(s || '').trim());
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };

/** a op b - numbers compared as numbers, the rest as text */
export function compare(op, actual, expected) {
  const a = Number(actual); const b = Number(expected);
  const num = actual !== '' && actual !== null && Number.isFinite(a) && Number.isFinite(b);
  switch (op) {
    case 'lt': return num && a < b;
    case 'le': return num && a <= b;
    case 'gt': return num && a > b;
    case 'ge': return num && a >= b;
    case 'eq': return num ? a === b : String(actual) === String(expected);
    case 'ne': return num ? a !== b : String(actual) !== String(expected);
    case 'contains': return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case 'notcontains': return !String(actual).toLowerCase().includes(String(expected).toLowerCase());
    default: return false;
  }
}
const OP_TEXT = { lt: '<', le: '≤', gt: '>', ge: '≥', eq: '=', ne: '≠', contains: '∋', notcontains: '∌' };

/** Latest stored state of a device: { kind, at, ok, data } or null */
function stateOf(db, deviceId) {
  const d = db.prepare('SELECT type FROM devices WHERE id=?').get(deviceId);
  if (!d) return null;
  if (d.type === 'printer') {
    const r = db.prepare('SELECT * FROM printer_status WHERE device_id=?').get(deviceId);
    return r ? { kind: 'printer', at: r.at, ok: !!r.ok, data: parse(r.data, {}) } : { kind: 'printer', data: null };
  }
  const r = db.prepare('SELECT * FROM snmp_status WHERE device_id=?').get(deviceId);
  if ((d.type === 'nas' || d.type === 'switch' || d.type === 'ups') && r) return { kind: r.kind, at: r.at, ok: !!r.ok, data: parse(r.data, {}) };
  // Windows/Linux machine with the host script
  const h = db.prepare('SELECT at, data FROM host_reports WHERE device_id=?').get(deviceId);
  if (h) return { kind: 'host', at: h.at, ok: true, data: parse(h.data, {}) };
  if (d.type === 'nas' || d.type === 'switch' || d.type === 'ups') return { kind: d.type, data: null };
  return null;
}

/**
 * Everything a sensor can watch on a device, with the current value:
 * [{ metric, key, label, value, unit, kind: 'number'|'state', op, threshold }]
 */
export function metricsFor(db, deviceId, { printerThreshold = 15, nasThreshold = 90 } = {}) {
  const s = stateOf(db, deviceId);
  if (!s?.data) return [];
  const out = [];
  if (s.kind === 'printer') {
    for (const x of s.data.supplies || []) {
      out.push({ metric: 'supply', key: x.key, name: x.description, value: x.pct, unit: '%', receptacle: !!x.receptacle, kind: 'number', op: 'le', threshold: printerThreshold });
    }
    out.push({ metric: 'printerErrors', key: '', name: '', value: (s.data.errors || []).length, unit: '', kind: 'state' });
    if (s.data.pages !== null && s.data.pages !== undefined) out.push({ metric: 'pages', key: '', name: '', value: s.data.pages, unit: '', kind: 'number', op: 'ge', threshold: s.data.pages + 10000 });
  } else if (s.kind === 'nas') {
    for (const v of s.data.volumes || []) out.push({ metric: 'volume', key: v.name, name: v.name, value: v.pct, unit: '%', kind: 'number', op: 'ge', threshold: nasThreshold });
    if (s.data.temp) out.push({ metric: 'temp', key: '', name: '', value: s.data.temp, unit: '°C', kind: 'number', op: 'ge', threshold: 55 });
    for (const x of s.data.disks || []) {
      out.push({ metric: 'disk', key: x.name, name: x.name, value: x.bad ? x.status : 'normal', unit: '', kind: 'state' });
      if (x.temp) out.push({ metric: 'diskTemp', key: x.name, name: x.name, value: x.temp, unit: '°C', kind: 'number', op: 'ge', threshold: 50 });
    }
    for (const r of s.data.raids || []) out.push({ metric: 'raid', key: r.name, name: r.name, value: r.status, unit: '', kind: 'state' });
    if (s.data.system) out.push({ metric: 'health', key: '', name: '', value: [s.data.system, s.data.fan, s.data.power].includes('failed') ? 'failed' : 'normal', unit: '', kind: 'state' });
  } else if (s.kind === 'host') {
    const x = s.data;
    out.push({ metric: 'hostOnline', key: '', name: x.hostname || '', value: 'online', unit: '', kind: 'state' });
    out.push({ metric: 'hostCpu', key: '', name: '', value: x.cpu, unit: '%', kind: 'number', op: 'ge', threshold: 90 });
    out.push({ metric: 'hostMem', key: '', name: '', value: x.mem, unit: '%', kind: 'number', op: 'ge', threshold: 90 });
    for (const dk of x.disks || []) out.push({ metric: 'hostDisk', key: dk.name, name: dk.name, value: dk.pct, unit: '%', kind: 'number', op: 'ge', threshold: nasThreshold });
    out.push({ metric: 'servicesFailed', key: '', name: '', value: (x.services || []).filter((v) => v.failed).length, unit: '', kind: 'number', op: 'gt', threshold: 0 });
    for (const v of x.services || []) out.push({ metric: 'service', key: v.name, name: v.display && v.display !== v.name && !v.display.includes(`(${v.name})`) ? `${v.display} (${v.name})` : v.display || v.name, value: v.state, unit: '', kind: 'state' });
    // Physical disks, updates, protection, events, certificates
    for (const pd of x.pdisks || []) {
      const key = pdKey(pd);
      const nm = `${pd.model || pd.name}${pd.serial ? ` (${pd.serial})` : ''}`;
      out.push({ metric: 'hostPdHealth', key, name: nm, value: pd.health, unit: '', kind: 'state' });
      if (pd.temp !== null && pd.temp !== undefined) out.push({ metric: 'hostPdTemp', key, name: nm, value: pd.temp, unit: '°C', kind: 'number', op: 'ge', threshold: 55 });
      if (pd.wear !== null && pd.wear !== undefined) out.push({ metric: 'hostPdWear', key, name: nm, value: pd.wear, unit: '%', kind: 'number', op: 'ge', threshold: 80 });
    }
    if (x.updates?.pending !== null && x.updates?.pending !== undefined) {
      out.push({ metric: 'hostUpdates', key: '', name: '', value: x.updates.pending, unit: '', kind: 'number', op: 'gt', threshold: 0 });
      out.push({ metric: 'hostUpdatesSec', key: '', name: '', value: x.updates.security ?? 0, unit: '', kind: 'number', op: 'gt', threshold: 0 });
    }
    if (x.updates) out.push({ metric: 'hostReboot', key: '', name: '', value: x.updates.reboot ? 'required' : 'none', unit: '', kind: 'state' });
    if (x.antivirus) out.push({ metric: 'hostAv', key: '', name: x.antivirus.name, value: x.antivirus.state, unit: '', kind: 'state' });
    if (x.firewall) out.push({ metric: 'hostFirewall', key: '', name: x.firewall.name, value: x.firewall.state, unit: '', kind: 'state' });
    if (x.events) {
      out.push({ metric: 'hostEvCritical', key: '', name: '', value: x.events.critical, unit: '', kind: 'number', op: 'gt', threshold: 0 });
      out.push({ metric: 'hostEvErrors', key: '', name: '', value: x.events.errors, unit: '', kind: 'number', op: 'gt', threshold: 20 });
    }
    for (const c of x.certs || []) out.push({ metric: 'hostCert', key: c.thumb, name: certName(c), value: daysLeft(c.notAfter), unit: 'd', kind: 'number', op: 'le', threshold: 21 });
  } else if (s.kind === 'switch') {
    for (const p of (s.data.ports || []).filter((x) => !x.lag)) {
      out.push({ metric: 'port', key: String(p.ifIndex), name: `${p.name}${p.alias ? ` (${p.alias})` : ''}`, value: p.status, unit: '', kind: 'state' });
    }
    for (const p of (s.data.ports || []).filter((x) => x.inErrors > 0)) {
      out.push({ metric: 'portErrors', key: String(p.ifIndex), name: p.name, value: p.inErrors, unit: '', kind: 'number', op: 'gt', threshold: p.inErrors + 1000 });
    }
  }
  // UPS: on the NAS, the UPS device itself or seen by a host script - always the same four values
  const u = s.data.ups;
  if (u) {
    out.push({ metric: 'upsPower', key: '', name: u.model || '', value: u.status === 'battery' ? 'battery' : u.status === 'online' ? 'mains' : 'unknown', unit: '', kind: 'state' });
    if (u.charge !== null) out.push({ metric: 'upsCharge', key: '', name: '', value: u.charge, unit: '%', kind: 'number', op: 'le', threshold: 50 });
    if (u.runtime !== null) out.push({ metric: 'upsRuntime', key: '', name: '', value: Math.round(u.runtime / 60), unit: 'min', kind: 'number', op: 'le', threshold: 10 });
    if (u.load !== null) out.push({ metric: 'upsLoad', key: '', name: '', value: u.load, unit: '%', kind: 'number', op: 'ge', threshold: 80 });
  }
  return out;
}

/** A physical disk is the same disk by its serial number (names can change) */
const pdKey = (pd) => pd.serial || pd.name;

/**
 * Check of a "sensor" monitor. options: { metric, key, op, threshold, label }. ms = the value (for the chart).
 * Data older than `staleMin` minutes counts as a failure (the device no longer answers its poller).
 */
export function sensorCheck(db, m, { staleMin = 180 } = {}) {
  const o = parse(m.options, {});
  const s = stateOf(db, m.device_id);
  if (!s) return { ok: false, ms: null, message: 'device missing' };
  if (!s.data || !s.at) return { ok: false, ms: null, message: 'no data yet' };
  if (!s.ok) return { ok: false, ms: null, message: 'device does not answer SNMP' };
  // A host script reports every 5 minutes: 15 minutes of silence = the machine (or its scheduled task) is down
  if (s.kind === 'host') staleMin = 15;
  if (Date.now() - Date.parse(s.at) > staleMin * 60 * 1000) {
    if (s.kind === 'host') return { ok: false, ms: null, message: `no report for ${Math.round((Date.now() - Date.parse(s.at)) / 60000)} min`, data: o.metric === 'hostOnline' ? { state: 'offline' } : undefined };
    return { ok: false, ms: null, message: 'no current data' };
  }
  const label = o.label || o.metric;
  const num = (v, unit = '', extra = {}) => ({ v, unit, extra, text: `${v}${unit ? ` ${unit}` : ''}` });
  let val = null;
  switch (o.metric) {
    case 'supply': { const x = (s.data.supplies || []).find((y) => y.key === o.key); if (!x) return { ok: false, ms: null, message: `${label}: not found` };
      if (x.state === 'empty') return { ok: false, ms: 0, message: `${label}: empty` };
      if (x.pct === null || x.pct === undefined) return { ok: true, ms: null, message: `${label}: ${x.state}` };
      val = num(x.pct, '%', x.receptacle ? { free: true } : {}); break; }
    case 'pages': val = num(s.data.pages); break;
    case 'printerErrors': { const e = s.data.errors || []; return e.length ? { ok: false, ms: e.length, message: e.join(', ') } : { ok: true, ms: 0, message: 'no faults' }; }
    case 'volume': { const v = (s.data.volumes || []).find((y) => y.name === o.key); if (!v) return { ok: false, ms: null, message: `${label}: not found` }; val = num(v.pct, '%'); break; }
    case 'temp': val = num(s.data.temp, '°C'); break;
    case 'diskTemp': { const d = (s.data.disks || []).find((y) => y.name === o.key); if (!d) return { ok: false, ms: null, message: `${label}: not found` }; val = num(d.temp, '°C'); break; }
    case 'disk': { const d = (s.data.disks || []).find((y) => y.name === o.key); if (!d) return { ok: false, ms: null, message: `${label}: not found` };
      return d.bad ? { ok: false, ms: null, message: `${label}: ${d.status}` } : { ok: true, ms: d.temp || null, message: `${label}: normal` }; }
    case 'raid': { const r = (s.data.raids || []).find((y) => y.name === o.key); if (!r) return { ok: false, ms: null, message: `${label}: not found` };
      return r.bad ? { ok: false, ms: null, message: `${label}: ${r.status}` } : { ok: true, ms: null, message: `${label}: ${r.status}` }; }
    case 'health': { const bad = nasProblems({ system: s.data.system, fan: s.data.fan, power: s.data.power }).map((p) => p.kind);
      return bad.length ? { ok: false, ms: null, message: `failed: ${bad.join(', ')}` } : { ok: true, ms: null, message: 'system, fans, power supply normal' }; }
    case 'port': { const p = (s.data.ports || []).find((y) => String(y.ifIndex) === String(o.key)); if (!p) return { ok: false, ms: null, message: `${label}: not found` };
      return p.status === 'up' ? { ok: true, ms: p.speed || null, message: `${label}: up${p.speed ? ` · ${p.speed} Mbit/s` : ''}` } : { ok: false, ms: null, message: `${label}: ${p.status}` }; }
    case 'hostOnline': { const x = s.data; return { ok: true, ms: null, message: `${label}: online`, data: { state: 'online', uptime: x.uptime || 0, cpu: x.cpu ?? null, mem: x.mem ?? null } }; }
    case 'hostCpu': val = num(s.data.cpu, '%'); break;
    case 'hostMem': { const x = s.data; val = num(x.mem, '%', x.memTotal ? { used: x.memUsed, total: x.memTotal } : {}); break; }
    case 'hostDisk': { const dk = (s.data.disks || []).find((y) => y.name === o.key); if (!dk) return { ok: false, ms: null, message: `${label}: not found` }; val = num(dk.pct, '%', { used: dk.used, total: dk.total }); break; }
    case 'servicesFailed': { const f = (s.data.services || []).filter((v) => v.failed); val = num(f.length); if (f.length && compare(o.op, f.length, o.threshold)) return { ok: false, ms: f.length, message: `${label}: ${f.map((v) => v.display || v.name).slice(0, 5).join(', ')}`, data: valueData(f.length, '', o) }; break; }
    case 'service': { const v = (s.data.services || []).find((y) => y.name === o.key); if (!v) return { ok: false, ms: null, message: `${label}: not found` };
      return v.state === 'running' ? { ok: true, ms: null, message: `${label}: running`, data: { state: 'running' } } : { ok: false, ms: null, message: `${label}: ${v.state}`, data: { state: v.state === 'failed' ? 'failed' : 'stopped' } }; }
    case 'portErrors': { const p = (s.data.ports || []).find((y) => String(y.ifIndex) === String(o.key)); if (!p) return { ok: false, ms: null, message: `${label}: not found` }; val = num(p.inErrors); break; }
    case 'upsPower': { const u = s.data.ups; if (!u) return { ok: false, ms: null, message: `${label}: no UPS` };
      const extra = [u.charge !== null ? `${u.charge} %` : '', u.runtime !== null ? `${Math.round(u.runtime / 60)} min` : ''].filter(Boolean).join(', ');
      const info = { charge: u.charge, runtime: u.runtime };
      if (u.status === 'battery') return { ok: false, ms: u.charge, message: `${label}: on battery${extra ? ` (${extra})` : ''}${u.low ? ', battery low' : ''}`, data: { state: 'battery', ...info } };
      if (u.replace) return { ok: false, ms: u.charge, message: `${label}: replace battery`, data: { state: 'replace', ...info } };
      return { ok: true, ms: u.charge, message: `${label}: ${u.status === 'online' ? 'on mains' : 'state unknown'}${extra ? ` (${extra})` : ''}`, data: { state: u.status === 'online' ? 'mains' : 'unknown', ...info } }; }
    case 'hostPdHealth': case 'hostPdTemp': case 'hostPdWear': {
      const pd = (s.data.pdisks || []).find((y) => pdKey(y) === o.key);
      if (!pd) return { ok: false, ms: null, message: `${label}: not found` };
      if (o.metric === 'hostPdTemp') { val = num(pd.temp, '°C'); break; }
      if (o.metric === 'hostPdWear') { val = num(pd.wear, '%'); break; }
      const extra = [pd.temp !== null ? `${pd.temp} °C` : '', pd.wear !== null ? `${pd.wear} % worn` : '', pd.realloc ? `${pd.realloc} reallocated sectors` : ''].filter(Boolean).join(', ');
      return pd.health === 'ok' || pd.health === 'unknown'
        ? { ok: true, ms: pd.temp, message: `${label}: ${pd.health === 'ok' ? 'healthy' : 'no health data'}${extra ? ` (${extra})` : ''}`, data: { state: pd.health } }
        : { ok: false, ms: pd.temp, message: `${label}: ${pd.health}${extra ? ` (${extra})` : ''}`, data: { state: pd.health } }; }
    case 'hostUpdates': val = num(s.data.updates?.pending ?? null); break;
    case 'hostUpdatesSec': val = num(s.data.updates?.pending === null || s.data.updates?.pending === undefined ? null : s.data.updates.security ?? 0); break;
    case 'hostReboot': { const u = s.data.updates; if (!u) return { ok: false, ms: null, message: `${label}: no data` };
      return u.reboot ? { ok: false, ms: null, message: `${label}: restart required`, data: { state: 'required' } } : { ok: true, ms: null, message: `${label}: no restart needed`, data: { state: 'none' } }; }
    case 'hostAv': { const a = s.data.antivirus; if (!a) return { ok: false, ms: null, message: `${label}: no data` };
      const text = { ok: 'on and up to date', off: 'off', outdated: `signatures ${a.sigAge ?? '?'} days old` }[a.state];
      return { ok: a.state === 'ok', ms: a.sigAge, message: `${label}: ${a.name} ${text}`, data: { state: a.state } }; }
    case 'hostFirewall': { const f = s.data.firewall; if (!f) return { ok: false, ms: null, message: `${label}: no data` };
      const off = f.profiles ? Object.entries(f.profiles).filter(([, v]) => !v).map(([k]) => k) : [];
      return { ok: f.state === 'on', ms: null, message: `${label}: ${f.state}${off.length && f.state !== 'off' ? ` (off: ${off.join(', ')})` : ''}`, data: { state: f.state } }; }
    case 'hostEvCritical': case 'hostEvErrors': { const e = s.data.events; if (!e) return { ok: false, ms: null, message: `${label}: no data` };
      const n = o.metric === 'hostEvCritical' ? e.critical : e.errors;
      const last = (e.items || []).find((i) => (o.metric === 'hostEvCritical' ? i.level === 'critical' : i.level === 'error'));
      val = num(n, '', {});
      if (compare(o.op, n, o.threshold)) return { ok: false, ms: n, message: `${label}: ${n} in ${e.hours} h${last ? ` - newest: ${last.source}${last.id ? ` ${last.id}` : ''}: ${last.message}` : ''}`.slice(0, 400), data: valueData(n, '', o) };
      break; }
    case 'hostCert': { const c = (s.data.certs || []).find((y) => y.thumb === o.key); if (!c) return { ok: false, ms: null, message: `${label}: not found` };
      const d = daysLeft(c.notAfter);
      val = { v: d, unit: 'd', text: d < 0 ? `expired ${-d} days ago` : `${d} days left` }; break; }
    case 'upsCharge': val = num(s.data.ups?.charge ?? null, '%'); break;
    case 'upsRuntime': { const r = s.data.ups?.runtime; val = num(r === null || r === undefined ? null : Math.round(r / 60), 'min'); break; }
    case 'upsLoad': val = num(s.data.ups?.load ?? null, '%'); break;
    default: return { ok: false, ms: null, message: 'unknown sensor' };
  }
  if (val.v === null || val.v === undefined) return { ok: false, ms: null, message: `${label}: no value` };
  // The sensor is "down" when the alarm condition is met
  const alarm = compare(o.op, val.v, o.threshold);
  return { ok: !alarm, ms: Number.isFinite(Number(val.v)) ? Math.round(Number(val.v)) : null, message: `${label}: ${val.text}${alarm ? ` (${OP_TEXT[o.op]} ${o.threshold})` : ''}`,
    data: valueData(val.v, val.unit, o, val.extra) };
}

/** What the overview shows next to a measured value: the value, its unit and the alarm limit (plus used/total etc.) */
export function valueData(v, unit, o, extra = {}) {
  const n = Number(v);
  return { v: Number.isFinite(n) ? n : String(v), unit: unit || '', op: o.op || '', threshold: o.threshold ?? '', ...extra };
}

/** Free SNMP sensor: GET one OID. options: { oid, op, threshold, label } */
export async function snmpCheck(host, port, communities, o, timeoutS = 10) {
  const t0 = Date.now();
  const s = await openSnmp(host, communities, { port: port || 161, timeout: Math.min(5000, timeoutS * 1000) });
  if (!s) return { ok: false, ms: null, message: 'no SNMP answer (community?)' };
  try {
    const oid = String(o.oid).replace(/^\./, '');
    const v = (await getValues(s, [oid], timeoutS * 1000))[oid];
    if (v === undefined) return { ok: false, ms: null, message: `${oid}: no such value` };
    const value = Buffer.isBuffer(v) ? text(v, 200) : typeof v === 'object' ? String(v) : v;
    const alarm = compare(o.op, value, o.threshold);
    const n = Number(value);
    return { ok: !alarm, ms: Number.isFinite(n) && String(value) !== '' ? Math.round(n) : Date.now() - t0,
      message: `${o.label || oid}: ${value}${alarm ? ` (${OP_TEXT[o.op]} ${o.threshold})` : ''}`, data: valueData(value, o.unit, o) };
  } finally { s.close(); }
}

/** Proxmox sensor on the stored state of a PVE/PBS host. options: { host, metric, key, op, threshold, label } */
export function proxmoxCheck(db, m, { staleMin = 30 } = {}) {
  const o = parse(m.options, {});
  const h = db.prepare('SELECT name, last_at, last_ok, last_error, data FROM proxmox_hosts WHERE id=?').get(o.host);
  if (!h) return { ok: false, ms: null, message: 'Proxmox host missing' };
  if (!h.last_at) return { ok: false, ms: null, message: 'no data yet' };
  if (!h.last_ok) return { ok: false, ms: null, message: `${h.name}: ${h.last_error}` };
  if (Date.now() - Date.parse(h.last_at) > staleMin * 60 * 1000) return { ok: false, ms: null, message: 'no current data' };
  const label = o.label || o.metric;
  const x = proxmoxMetrics(parse(h.data, {})).find((y) => y.metric === o.metric && String(y.key) === String(o.key || ''));
  if (!x) return { ok: false, ms: null, message: `${label}: not found` };
  if (o.metric === 'netOnline') {
    const data = { state: x.value, uptime: x.uptime || 0, cpu: x.cpu ?? null, mem: x.mem ?? null };
    return x.value === 'online' ? { ok: true, ms: null, message: `${label}: online`, data } : { ok: false, ms: null, message: `${label}: offline`, data: { state: 'offline' } };
  }
  if (o.metric === 'nodeOnline') {
    const data = { state: x.value, uptime: x.uptime || 0, cpu: x.cpu ?? null, mem: x.mem ?? null };
    return x.value === 'online' ? { ok: true, ms: null, message: `${label}: online`, data } : { ok: false, ms: null, message: `${label}: offline`, data: { state: x.value } };
  }
  if (o.metric === 'guestRunning') {
    const data = { state: x.value, node: x.node || '', cpu: x.cpu ?? null, mem: x.mem ?? null };
    return x.value === 'running' ? { ok: true, ms: null, message: `${label}: running`, data } : { ok: false, ms: null, message: `${label}: ${x.value}`, data: { state: x.value, node: x.node || '' } };
  }
  if (x.value === null || x.value === undefined) {
    return { ok: false, ms: null, message: `${label}: ${o.metric === 'backupAge' || o.metric === 'groupAge' ? 'no backup found' : 'no value - the account probably lacks read rights (Monitoring → Virtualization)'}` };
  }
  const alarm = compare(o.op, x.value, o.threshold);
  const extra = x.total ? { used: x.used, total: x.total } : {};
  return { ok: !alarm, ms: Math.round(Number(x.value)), message: `${label}: ${x.value}${x.unit ? ` ${x.unit}` : ''}${alarm ? ` (${OP_TEXT[o.op]} ${o.threshold})` : ''}`,
    data: valueData(x.value, x.unit, o, extra) };
}
