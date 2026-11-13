// UPS values, read only. Over SNMP from three sources - whichever the device has:
//   Synology NAS with a UPS on USB or network: SYNOLOGY-UPS-MIB (the NAS tells what its UPS server sees)
//   network cards of UPS with the standard UPS-MIB (RFC 1628: Eaton, CyberPower, Riello, Socomec, many others)
//   APC network cards (PowerNet-MIB)
// and from the host scripts (Linux: local NUT or apcupsd, Windows: the UPS on USB that Windows sees like a battery).
// Everything ends up in one shape:
//   { source, vendor, model, serial, firmware, status: 'online'|'battery'|'unknown', low, replace,
//     charge (%), runtime (seconds), load (%) }
import { getValues, text } from './snmpwalk.js';

const SYN = {
  model: '1.3.6.1.4.1.6574.4.1.1.0', vendor: '1.3.6.1.4.1.6574.4.1.2.0', serial: '1.3.6.1.4.1.6574.4.1.3.0',
  status: '1.3.6.1.4.1.6574.4.2.1.0', load: '1.3.6.1.4.1.6574.4.2.12.1.0',
  charge: '1.3.6.1.4.1.6574.4.3.1.1.0', runtime: '1.3.6.1.4.1.6574.4.3.6.1.0',
};
// RFC 1628 UPS-MIB
const STD = {
  vendor: '1.3.6.1.2.1.33.1.1.1.0', model: '1.3.6.1.2.1.33.1.1.2.0', firmware: '1.3.6.1.2.1.33.1.1.3.0',
  battery: '1.3.6.1.2.1.33.1.2.1.0', minutes: '1.3.6.1.2.1.33.1.2.3.0', charge: '1.3.6.1.2.1.33.1.2.4.0',
  source: '1.3.6.1.2.1.33.1.4.1.0', load: '1.3.6.1.2.1.33.1.4.4.1.5.1',
};
// APC PowerNet-MIB
const APC = {
  model: '1.3.6.1.4.1.318.1.1.1.1.1.1.0', firmware: '1.3.6.1.4.1.318.1.1.1.1.2.1.0', serial: '1.3.6.1.4.1.318.1.1.1.1.2.3.0',
  battery: '1.3.6.1.4.1.318.1.1.1.2.1.1.0', charge: '1.3.6.1.4.1.318.1.1.1.2.2.1.0', runtime: '1.3.6.1.4.1.318.1.1.1.2.2.3.0',
  replace: '1.3.6.1.4.1.318.1.1.1.2.2.4.0', output: '1.3.6.1.4.1.318.1.1.1.4.1.1.0', load: '1.3.6.1.4.1.318.1.1.1.4.2.3.0',
};
export const UPS_OIDS = [...Object.values(SYN), ...Object.values(STD), ...Object.values(APC)];

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(Buffer.isBuffer(v) ? text(v, 30) : v);
  return Number.isFinite(n) ? n : null;
};
const pct = (v) => (num(v) === null || num(v) < 0 ? null : Math.min(100, Math.round(num(v))));
const secs = (v) => (num(v) === null || num(v) < 0 ? null : Math.round(num(v)));
const clip = (v, n = 80) => text(v, n);

/** Status text as NUT, apcupsd and Synology write it ("OL CHRG", "OB DISCHRG LB", "ONBATT") */
export function statusOf(raw) {
  const s = ` ${String(raw || '').toUpperCase().replace(/[^A-Z]+/g, ' ')} `;
  return {
    status: / OB | ONBATT | DISCHRG /.test(s) ? 'battery' : / OL | ONLINE | CHRG /.test(s) ? 'online' : 'unknown',
    low: / LB | LOWBATT /.test(s),
    replace: / RB | REPLACEBATT /.test(s),
  };
}

/** UPS values from one SNMP GET answer ({ oid: value }) - or null when the device knows no UPS */
export function upsFromValues(v) {
  // Synology: only filled while a UPS is connected and the UPS service is on
  const synStatus = clip(v[SYN.status], 60);
  if (synStatus) {
    return { source: 'synology', vendor: clip(v[SYN.vendor]), model: clip(v[SYN.model]), serial: clip(v[SYN.serial], 60), firmware: '',
      ...statusOf(synStatus), charge: pct(v[SYN.charge]), runtime: secs(v[SYN.runtime]), load: pct(v[SYN.load]) };
  }
  if (v[APC.output] !== undefined || v[APC.charge] !== undefined) {
    const out = num(v[APC.output]);
    const tt = num(v[APC.runtime]);
    return { source: 'apc', vendor: 'APC', model: clip(v[APC.model]), serial: clip(v[APC.serial], 60), firmware: clip(v[APC.firmware], 60),
      // 2 onLine, 3 onBattery, 4 onSmartBoost, 12 onSmartTrim … - only 3 is "on battery"
      status: out === 3 ? 'battery' : out === null ? 'unknown' : 'online', low: num(v[APC.battery]) === 3, replace: num(v[APC.replace]) === 2,
      charge: pct(v[APC.charge]), runtime: tt === null ? null : Math.round(tt / 100), load: pct(v[APC.load]) };
  }
  if (v[STD.source] !== undefined || v[STD.charge] !== undefined) {
    const src = num(v[STD.source]);
    const bat = num(v[STD.battery]);
    const min = num(v[STD.minutes]);
    return { source: 'ups-mib', vendor: clip(v[STD.vendor]), model: clip(v[STD.model]), serial: '', firmware: clip(v[STD.firmware], 60),
      // upsOutputSource 5 = battery; upsBatteryStatus 3 low, 4 depleted
      status: src === 5 ? 'battery' : src === null ? 'unknown' : 'online', low: bat === 3 || bat === 4, replace: false,
      charge: pct(v[STD.charge]), runtime: min === null ? null : Math.round(min * 60), load: pct(v[STD.load]) };
  }
  return null;
}

/** Asks an open SNMP session for UPS values (null = none) */
export async function readUpsValues(s) {
  return upsFromValues(await getValues(s, UPS_OIDS));
}

/** What a host script sends: { status (text), charge, runtime (s), load, model, vendor, kind } → the same shape */
export function cleanUps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const st = statusOf(raw.status);
  const out = { source: raw.kind === 'battery' ? 'battery' : 'script', vendor: clip(raw.vendor), model: clip(raw.model), serial: '', firmware: '',
    ...st, charge: pct(raw.charge), runtime: secs(raw.runtime), load: pct(raw.load) };
  // Without status and without any value there is nothing to show
  return out.status === 'unknown' && out.charge === null && out.runtime === null ? null : out;
}
