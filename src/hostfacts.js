// What the host scripts tell beyond CPU/RAM/drives: hardware, physical disks, updates, virus protection, firewall,
// critical events and certificates. Windows and Linux send it a little differently; here both become one shape and
// everything is checked and cut to size - a script is never trusted more than a form.
import { normalizeMac } from './lib/net.js';

const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const nonNeg = (v, max = Number.MAX_SAFE_INTEGER) => (num(v) === null || num(v) < 0 ? null : Math.min(max, Math.round(num(v))));
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : v && typeof v === 'object' ? [v] : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const bool = (v) => (v === true || v === false ? v : null);
const isoOrNull = (v) => { const t = Date.parse(v); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null; };

/** Model, serial number, BIOS, processors, memory modules, network cards */
export function cleanHw(raw) {
  const h = obj(raw);
  if (!h) return null;
  // Linux sends the BIOS date as MM/DD/YYYY
  let biosDate = clip(h.biosDate, 20);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(biosDate);
  if (us) biosDate = `${us[3]}-${us[1]}-${us[2]}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(biosDate)) biosDate = '';
  const ram = list(h.ram, 64).map((m) => ({
    slot: clip(m?.slot, 40), size: nonNeg(m?.size) ?? (nonNeg(m?.sizeMb) === null ? null : nonNeg(m.sizeMb) * 1024 * 1024),
    speed: nonNeg(m?.speed, 100000), vendor: clip(m?.vendor, 60), part: clip(m?.part, 60),
  })).filter((m) => m.size);
  const nics = list(h.nics, 32).map((n) => {
    // Windows: bit/s, Linux: Mbit/s
    const mbit = nonNeg(n?.speedMb, 10_000_000) ?? (nonNeg(n?.speed) === null ? null : Math.round(nonNeg(n.speed) / 1e6));
    return { name: clip(n?.name, 60), desc: clip(n?.desc, 120), mac: normalizeMac(String(n?.mac || '').replace(/-/g, ':')) || '', speed: mbit && mbit < 10_000_000 ? mbit : null, up: n?.up === true };
  }).filter((n) => n.name);
  const out = {
    vendor: clip(h.vendor, 80), model: clip(h.model, 100), serial: clip(h.serial, 80), bios: clip(h.bios, 60), biosDate,
    cpu: clip(h.cpu, 120), sockets: nonNeg(h.sockets, 64), cores: nonNeg(h.cores, 4096), threads: nonNeg(h.threads, 8192),
    virtual: h.virtual === true, ram, ramTotal: ram.reduce((a, m) => a + m.size, 0) || null, nics,
  };
  return out.vendor || out.model || out.cpu || ram.length || nics.length ? out : null;
}

const HEALTH_WIN = { healthy: 'ok', warning: 'warning', unhealthy: 'failed' };
/** smartctl -j answer → the values we show */
function fromSmart(sm) {
  const s = obj(sm);
  if (!s) return {};
  const attr = new Map(list(s.ata_smart_attributes?.table, 100).map((a) => [Number(a?.id), a]));
  const raw = (id) => num(attr.get(id)?.raw?.value);
  const norm = (id) => num(attr.get(id)?.value);
  const nv = obj(s.nvme_smart_health_information_log) || {};
  // Wear in "% used": NVMe says it directly, SATA SSDs count down from 100 (177 Samsung, 231/233 Intel and others)
  const left = [177, 231, 233].map(norm).find((v) => v !== null && v <= 100);
  const wear = num(nv.percentage_used) ?? (left === undefined ? null : 100 - left);
  const realloc = raw(5); const pendingSec = raw(197); const offline = raw(198);
  const passed = s.smart_status?.passed;
  const bad = (realloc || 0) > 0 || (pendingSec || 0) > 0 || (offline || 0) > 0 || (num(nv.media_errors) || 0) > 0 || (num(nv.critical_warning) || 0) > 0;
  return {
    model: clip(s.model_name, 100), serial: clip(s.serial_number, 80),
    health: passed === false ? 'failed' : passed === true ? (bad ? 'warning' : 'ok') : 'unknown',
    temp: num(s.temperature?.current), hours: num(s.power_on_time?.hours), wear,
    readErrors: raw(187) ?? offline ?? num(nv.media_errors), writeErrors: null, realloc,
  };
}

/** Physical disks of Windows (Get-PhysicalDisk) or Linux (lsblk + smartctl) */
export function cleanPdisks(raw) {
  return list(raw, 32).map((d) => {
    if (!obj(d)) return null;
    const sm = fromSmart(d.smart);
    const tran = clip(d.tran || d.bus, 20);
    const media = /^nvme$/i.test(tran) ? 'NVMe' : d.rota === 0 ? 'SSD' : d.rota === 1 ? 'HDD' : /^(ssd|hdd|scm)$/i.test(d.media) ? String(d.media).toUpperCase() : '';
    const health = HEALTH_WIN[String(d.health || '').toLowerCase()] || sm.health || 'unknown';
    const pick = (a, b) => (num(a) !== null ? num(a) : b ?? null);
    const temp = pick(d.temp, sm.temp);
    return {
      name: clip(d.name, 80), model: clip(d.model || sm.model || (d.smart ? '' : d.name), 100), serial: clip(d.serial || sm.serial, 80),
      media, bus: tran.toUpperCase(), size: nonNeg(d.size), health,
      // 0 °C or 100+ °C are no readings, but placeholders of some controllers
      temp: temp !== null && temp > 0 && temp < 100 ? Math.round(temp) : null,
      wear: nonNeg(pick(d.wear, sm.wear), 100), hours: nonNeg(pick(d.hours, sm.hours)),
      readErrors: nonNeg(pick(d.readErrors, sm.readErrors)), writeErrors: nonNeg(d.writeErrors), realloc: nonNeg(sm.realloc),
    };
  }).filter((d) => d && d.name);
}

/** Windows: { pending, security, checkedAt, lastInstalled, reboot }; Linux: { cache: {…}, reboot } */
export function cleanUpdates(raw) {
  const u = obj(raw);
  if (!u) return null;
  const c = obj(u.cache) || u;
  const pending = nonNeg(c.pending, 100000);
  return {
    pending, security: pending === null ? null : nonNeg(c.security, 100000), checkedAt: isoOrNull(c.checkedAt), lastInstalled: isoOrNull(c.lastInstalled),
    reboot: u.reboot === true || c.reboot === true,
  };
}

/** Virus protection (Windows) and firewall (Windows profiles, Linux ufw/firewalld) */
export function cleanSecurity(av, fw) {
  const a = obj(av);
  const f = obj(fw);
  let firewall = null;
  if (f && ('domain' in f || 'private' in f || 'public' in f)) {
    const profiles = { domain: f.domain === true, private: f.private === true, public: f.public === true };
    const on = Object.values(profiles);
    firewall = { name: 'Windows', state: on.every(Boolean) ? 'on' : on.some(Boolean) ? 'partial' : 'off', profiles };
  } else if (f && 'on' in f) {
    firewall = { name: clip(f.name, 40), state: f.on === true ? 'on' : 'off', profiles: null };
  }
  const antivirus = a ? {
    name: clip(a.name, 80), enabled: a.enabled === true, realtime: bool(a.realtime), upToDate: bool(a.upToDate), sigAge: nonNeg(a.sigAge, 100000),
    state: a.enabled !== true || a.realtime === false ? 'off' : a.upToDate === false ? 'outdated' : 'ok',
  } : null;
  return { antivirus, firewall };
}

/** Critical events and errors of the last 24 hours (Windows event log or Linux journal) */
export function cleanEvents(raw) {
  const e = obj(raw);
  if (!e) return null;
  const items = e.journal
    ? list(e.journal, 10).map((j) => {
      const p = Number(j?.PRIORITY);
      const us = num(j?.__REALTIME_TIMESTAMP);
      return { at: us ? new Date(us / 1000).toISOString() : null, level: p <= 2 ? 'critical' : 'error',
        source: clip(j?.SYSLOG_IDENTIFIER || j?._COMM || j?._SYSTEMD_UNIT, 80), id: null, message: typeof j?.MESSAGE === 'string' ? clip(j.MESSAGE, 300) : '' };
    })
    : list(e.items, 10).map((i) => ({ at: isoOrNull(i?.at), level: i?.level === 'critical' ? 'critical' : 'error', source: clip(i?.source, 80), id: nonNeg(i?.id, 1e9), message: clip(i?.message, 300) }));
  return { hours: nonNeg(e.hours, 720) || 24, critical: nonNeg(e.critical, 1e6) ?? 0, errors: nonNeg(e.errors, 1e6) ?? 0, items };
}

/** Certificates of the machine; "days" is worked out when shown */
export function cleanCerts(raw) {
  return list(raw, 50).map((c) => ({
    subject: clip(c?.subject, 200), issuer: clip(c?.issuer, 200), name: clip(c?.name, 120), notAfter: isoOrNull(c?.notAfter),
    thumb: clip(c?.thumb, 64).replace(/[^0-9A-Fa-f]/g, '').toUpperCase(),
  })).filter((c) => c.thumb && c.notAfter);
}

/** CN of a subject ("CN=rdg.firma.de, O=…" → "rdg.firma.de") */
export const certName = (c) => /CN=([^,]+)/i.exec(c.subject || '')?.[1]?.trim() || c.name || c.subject || c.thumb;
export const daysLeft = (iso, now = Date.now()) => Math.floor((Date.parse(iso) - now) / 86400000);
