// Server hardware through the management chip - Dell iDRAC, HPE iLO, Lenovo XClarity Controller, Supermicro,
// Fujitsu iRMC, Cisco CIMC … all speak the DMTF standard Redfish. Read only, with an account that may only read.
// What the operating system usually does not know: fans, power supplies, temperatures, RAID controllers, drives behind
// the controller, the overall health and the power state - also while the server is switched off.
//
// Shape: { kind: 'redfish', vendor, model, serial, sku, bios, power, health, cpus, cpuModel, memGiB, watts,
//   bmc: { model, firmware }, macs: [], fans: [], temps: [], psus: [], drives: [], volumes: [] }
import { tlsRequest } from './proxmox.js';
import { normalizeMac } from './lib/net.js';

const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n);
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const HEALTH = { ok: 'ok', warning: 'warning', critical: 'critical' };
/** Status { State, Health } → 'ok' | 'warning' | 'critical' | 'unknown'; null when the part is not there */
export function healthOf(status) {
  if (!status || typeof status !== 'object') return 'unknown';
  if (/^absent$/i.test(status.State || '')) return null;
  return HEALTH[String(status.Health || status.HealthRollup || '').toLowerCase()] || 'unknown';
}
const present = (x) => x && healthOf(x.Status) !== null;
// Only paths below /redfish/v1 of the same server, never somewhere else
const PATH = /^\/redfish\/v1(\/[A-Za-z0-9_.%:@!$&'()*+,;=~-]*)*$/;
const link = (x) => {
  const p = String(x?.['@odata.id'] || '').split('#')[0].replace(/\/+$/, '');
  return PATH.test(p) ? p : null;
};

function client(host) {
  const auth = `Basic ${Buffer.from(`${host.token_id}:${host.secretPlain}`).toString('base64')}`;
  let calls = 0;
  const started = Date.now();
  async function get(path, optional = false) {
    if (!path) return null;
    if (++calls > 250) throw new Error('too many requests - is this a Redfish service?');
    // One reading must not take for ever (the polling of all hosts waits for it)
    if (Date.now() - started > 5 * 60 * 1000) throw new Error('no complete answer within 5 minutes');
    const r = await tlsRequest(host, 'GET', path, { headers: { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' } });
    if (r.status === 401) throw new Error('sign-in refused - user or password wrong (or the account is locked)');
    if (r.status === 403) { if (optional) return null; throw new Error('the account may not read this - give it at least the read-only role'); }
    if (r.status !== 200) { if (optional) return null; throw new Error(r.status === 404 ? 'no Redfish service at this address (/redfish/v1 missing)' : `HTTP ${r.status}`); }
    try { return JSON.parse(r.text); } catch { if (optional) return null; throw new Error('the answer is no JSON - is this a Redfish service?'); }
  }
  /** The members of a collection, at most n, four at a time */
  async function members(col, n = 32) {
    const list = (col?.Members || []).map(link).filter(Boolean).slice(0, n);
    const out = [];
    for (let i = 0; i < list.length; i += 4) out.push(...(await Promise.all(list.slice(i, i + 4).map((p) => get(p, true)))));
    return out.filter(Boolean);
  }
  return { get, members, sub: (x, key) => get(link(x?.[key]), true) };
}

export async function readRedfish(host) {
  const c = client(host);
  const root = await c.get('/redfish/v1/');
  if (!root?.Systems) throw new Error('no Redfish service at this address (no systems)');
  const [system] = await c.members(await c.get(link(root.Systems)), 1);
  if (!system) throw new Error('the Redfish service lists no server');
  const [manager] = await c.members(await c.get(link(root.Managers), true), 1);
  const chassisPath = link((system.Links?.Chassis || [])[0]);
  const chassis = chassisPath ? await c.get(chassisPath, true) : (await c.members(await c.get(link(root.Chassis), true), 1))[0];

  // Fans, temperatures: Thermal (all versions) or ThermalSubsystem (newer firmware)
  const fans = []; const temps = [];
  const thermal = chassis ? await c.sub(chassis, 'Thermal') : null;
  if (thermal) {
    for (const f of (thermal.Fans || []).filter(present).slice(0, 48)) {
      const pctUnit = /percent/i.test(f.ReadingUnits || '');
      fans.push({ name: clip(f.Name || f.FanName || f.MemberId, 60), rpm: pctUnit ? null : num(f.Reading), pct: pctUnit ? num(f.Reading) : null, health: healthOf(f.Status) });
    }
    for (const s of (thermal.Temperatures || []).filter(present).slice(0, 64)) {
      if (num(s.ReadingCelsius) === null) continue;
      temps.push({ name: clip(s.Name || s.MemberId, 60), c: num(s.ReadingCelsius), warn: num(s.UpperThresholdNonCritical), crit: num(s.UpperThresholdCritical), health: healthOf(s.Status) });
    }
  } else if (chassis?.ThermalSubsystem) {
    const ts = await c.sub(chassis, 'ThermalSubsystem');
    for (const f of (await c.members(await c.sub(ts, 'Fans'), 48)).filter(present)) {
      fans.push({ name: clip(f.Name || f.Id, 60), rpm: null, pct: num(f.SpeedPercent?.Reading), health: healthOf(f.Status) });
    }
  }
  if (!temps.length && chassis?.Sensors) {
    for (const s of (await c.members(await c.sub(chassis, 'Sensors'), 64)).filter((x) => present(x) && /temperature/i.test(x.ReadingType || ''))) {
      if (num(s.Reading) === null) continue;
      temps.push({ name: clip(s.Name || s.Id, 60), c: num(s.Reading), warn: num(s.Thresholds?.UpperCaution?.Reading), crit: num(s.Thresholds?.UpperCritical?.Reading), health: healthOf(s.Status) });
    }
  }

  // Power supplies and consumption: Power or PowerSubsystem
  const psus = []; let watts = null;
  const power = chassis ? await c.sub(chassis, 'Power') : null;
  if (power) {
    for (const p of (power.PowerSupplies || []).filter(present).slice(0, 16)) {
      psus.push({ name: clip(p.Name || p.MemberId, 60), model: clip(p.Model, 60), capacity: num(p.PowerCapacityWatts), output: num(p.LastPowerOutputWatts ?? p.PowerOutputWatts), health: healthOf(p.Status) });
    }
    watts = num((power.PowerControl || [])[0]?.PowerConsumedWatts);
  } else if (chassis?.PowerSubsystem) {
    const ps = await c.sub(chassis, 'PowerSubsystem');
    for (const p of (await c.members(await c.sub(ps, 'PowerSupplies'), 16)).filter(present)) {
      psus.push({ name: clip(p.Name || p.Id, 60), model: clip(p.Model, 60), capacity: num(p.PowerCapacityWatts), output: null, health: healthOf(p.Status) });
    }
  }

  // RAID controllers, their drives and volumes
  const drives = []; const volumes = []; const controllers = [];
  for (const st of await c.members(await c.sub(system, 'Storage'), 8)) {
    const ctl = (st.StorageControllers || [])[0];
    if (ctl || st.Name) controllers.push({ name: clip(ctl?.Name || st.Name, 80), model: clip(ctl?.Model, 80), firmware: clip(ctl?.FirmwareVersion, 40), health: healthOf(ctl?.Status || st.Status) ?? 'unknown' });
    const dlinks = (st.Drives || []).map(link).filter(Boolean).slice(0, 48 - drives.length);
    for (let i = 0; i < dlinks.length; i += 4) {
      for (const d of (await Promise.all(dlinks.slice(i, i + 4).map((p) => c.get(p, true)))).filter(present)) {
        drives.push({ name: clip(d.Name || d.Id, 60), model: clip(d.Model, 80), serial: clip(d.SerialNumber, 60), size: num(d.CapacityBytes), media: clip(d.MediaType, 10),
          protocol: clip(d.Protocol, 10), life: num(d.PredictedMediaLifeLeftPercent), failurePredicted: d.FailurePredicted === true, health: healthOf(d.Status) });
      }
    }
    for (const v of (await c.members(await c.sub(st, 'Volumes'), 16)).filter(present)) {
      volumes.push({ name: clip(v.Name || v.Id, 60), raid: clip(v.RAIDType || v.VolumeType, 30), size: num(v.CapacityBytes), health: healthOf(v.Status) });
    }
  }

  // MAC addresses of the server (not of the management chip): to find it in the inventory
  const macs = (await c.members(await c.sub(system, 'EthernetInterfaces'), 16))
    .map((e) => normalizeMac(e.PermanentMACAddress || e.MACAddress)).filter(Boolean);

  const vendor = clip(system.Manufacturer, 80);
  return {
    kind: 'redfish', vendor, model: clip(system.Model, 100), serial: clip(system.SerialNumber, 60), sku: clip(system.SKU, 60),
    bios: clip(system.BiosVersion, 60), power: clip(system.PowerState, 20).toLowerCase() || 'unknown', health: healthOf(system.Status) ?? 'unknown',
    cpus: num(system.ProcessorSummary?.Count), cpuModel: clip(system.ProcessorSummary?.Model, 120), memGiB: num(system.MemorySummary?.TotalSystemMemoryGiB),
    watts, bmc: manager ? { model: clip(manager.Model || manager.Name, 60), firmware: clip(manager.FirmwareVersion, 60) } : null,
    macs: [...new Set(macs)], fans, temps, psus, drives, volumes, controllers,
  };
}

/** The serial number on the label: Dell calls it service tag and puts it into SKU */
export const labelSerial = (d) => (/dell/i.test(d.vendor || '') && d.sku ? d.sku : d.serial);

/** Every value a sensor can watch */
export function redfishMetrics(d) {
  const out = [];
  out.push({ metric: 'rfHealth', key: '', name: '', value: d.health, kind: 'state' });
  out.push({ metric: 'rfPower', key: '', name: '', value: d.power, kind: 'state' });
  for (const f of d.fans || []) out.push({ metric: 'rfFan', key: f.name, name: f.name, value: f.health, kind: 'state', rpm: f.rpm, pct: f.pct });
  for (const s of d.temps || []) out.push({ metric: 'rfTemp', key: s.name, name: s.name, value: s.c, unit: '°C', kind: 'number', op: 'ge', threshold: s.warn ?? 70 });
  for (const p of d.psus || []) out.push({ metric: 'rfPsu', key: p.name, name: p.name, value: p.health, kind: 'state' });
  for (const x of d.drives || []) {
    const name = `${x.name}${x.model ? ` (${x.model})` : ''}`;
    out.push({ metric: 'rfDrive', key: x.serial || x.name, name, value: x.failurePredicted && x.health === 'ok' ? 'warning' : x.health, kind: 'state' });
    if (x.life !== null && x.life !== undefined) out.push({ metric: 'rfDriveLife', key: x.serial || x.name, name, value: x.life, unit: '%', kind: 'number', op: 'le', threshold: 10 });
  }
  for (const v of d.volumes || []) out.push({ metric: 'rfVolume', key: v.name, name: `${v.name}${v.raid ? ` (${v.raid})` : ''}`, value: v.health, kind: 'state' });
  if (d.watts !== null && d.watts !== undefined) out.push({ metric: 'rfWatts', key: '', name: '', value: d.watts, unit: 'W', kind: 'number', op: 'ge', threshold: 1000 });
  return out;
}
export const RF_STATE = ['rfHealth', 'rfPower', 'rfFan', 'rfPsu', 'rfDrive', 'rfVolume'];
