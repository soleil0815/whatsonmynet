// Sensors: monitors on values the devices already deliver (printer supplies, NAS volumes/disks/temperature,
// switch ports) and on any SNMP value (OID) – like the sensors of PRTG. A sensor check reads the latest state the
// pollers stored (no extra traffic to the device); the free SNMP sensor asks the device itself (read-only).
import { openSnmp, getValues, text } from '../scan/snmpwalk.js';
import { nasProblems } from '../scan/nas.js';
import { proxmoxMetrics } from '../proxmox.js';

export const OPS = ['lt', 'le', 'gt', 'ge', 'eq', 'ne', 'contains', 'notcontains'];
const OID = /^\.?([0-2])(\.\d{1,10}){2,40}$/;
export const validOid = (s) => OID.test(String(s || '').trim());
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };

/** a op b – numbers compared as numbers, the rest as text */
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
  if (d.type === 'nas' || d.type === 'switch') return r ? { kind: r.kind, at: r.at, ok: !!r.ok, data: parse(r.data, {}) } : { kind: d.type, data: null };
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
  } else if (s.kind === 'switch') {
    for (const p of (s.data.ports || []).filter((x) => !x.lag)) {
      out.push({ metric: 'port', key: String(p.ifIndex), name: `${p.name}${p.alias ? ` (${p.alias})` : ''}`, value: p.status, unit: '', kind: 'state' });
    }
    for (const p of (s.data.ports || []).filter((x) => x.inErrors > 0)) {
      out.push({ metric: 'portErrors', key: String(p.ifIndex), name: p.name, value: p.inErrors, unit: '', kind: 'number', op: 'gt', threshold: p.inErrors + 1000 });
    }
  }
  return out;
}

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
  if (Date.now() - Date.parse(s.at) > staleMin * 60 * 1000) return { ok: false, ms: null, message: 'no current data' };
  const label = o.label || o.metric;
  const num = (v, unit = '') => ({ v, text: `${v}${unit ? ` ${unit}` : ''}` });
  let val = null;
  switch (o.metric) {
    case 'supply': { const x = (s.data.supplies || []).find((y) => y.key === o.key); if (!x) return { ok: false, ms: null, message: `${label}: not found` };
      if (x.state === 'empty') return { ok: false, ms: 0, message: `${label}: empty` };
      if (x.pct === null || x.pct === undefined) return { ok: true, ms: null, message: `${label}: ${x.state}` };
      val = num(x.pct, '%'); break; }
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
    case 'portErrors': { const p = (s.data.ports || []).find((y) => String(y.ifIndex) === String(o.key)); if (!p) return { ok: false, ms: null, message: `${label}: not found` }; val = num(p.inErrors); break; }
    default: return { ok: false, ms: null, message: 'unknown sensor' };
  }
  if (val.v === null || val.v === undefined) return { ok: false, ms: null, message: `${label}: no value` };
  // The sensor is "down" when the alarm condition is met
  const alarm = compare(o.op, val.v, o.threshold);
  return { ok: !alarm, ms: Number.isFinite(Number(val.v)) ? Math.round(Number(val.v)) : null, message: `${label}: ${val.text}${alarm ? ` (${OP_TEXT[o.op]} ${o.threshold})` : ''}` };
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
      message: `${o.label || oid}: ${value}${alarm ? ` (${OP_TEXT[o.op]} ${o.threshold})` : ''}` };
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
  if (o.metric === 'nodeOnline') return x.value === 'online' ? { ok: true, ms: null, message: `${label}: online` } : { ok: false, ms: null, message: `${label}: offline` };
  if (o.metric === 'guestRunning') return x.value === 'running' ? { ok: true, ms: null, message: `${label}: running` } : { ok: false, ms: null, message: `${label}: ${x.value}` };
  if (x.value === null || x.value === undefined) return { ok: false, ms: null, message: `${label}: ${o.metric === 'backupAge' || o.metric === 'groupAge' ? 'no backup found' : 'no value'}` };
  const alarm = compare(o.op, x.value, o.threshold);
  return { ok: !alarm, ms: Math.round(Number(x.value)), message: `${label}: ${x.value}${x.unit ? ` ${x.unit}` : ''}${alarm ? ` (${OP_TEXT[o.op]} ${o.threshold})` : ''}` };
}
