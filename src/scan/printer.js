// Printer status via SNMP (Printer-MIB RFC 3805 + Host-Resources-MIB): supplies (toner, ink, drum, waste toner),
// page counter, status, error flags and the text on the printer's display. Read-only.
import { openSnmp, getValues, walk, text } from './snmpwalk.js';

const SUPPLIES = '1.3.6.1.2.1.43.11.1.1';       // prtMarkerSuppliesEntry
const COLORANTS = '1.3.6.1.2.1.43.12.1.1.4';    // prtMarkerColorantValue
const LIFE_COUNT = '1.3.6.1.2.1.43.10.2.1.4';   // prtMarkerLifeCount (pages)
const DISPLAY = '1.3.6.1.2.1.43.16.5.1.2';      // prtConsoleDisplayBufferText
const HR_PRINTER = '1.3.6.1.2.1.25.3.5.1';      // hrPrinterStatus (.1), hrPrinterDetectedErrorState (.2)
const SERIAL = '1.3.6.1.2.1.43.5.1.1.17.1';     // prtGeneralSerialNumber
const HR_DESCR = '1.3.6.1.2.1.25.3.2.1.3';       // hrDeviceDescr - for the printer: its model
const ALERTS = '1.3.6.1.2.1.43.18.1.1';         // prtAlertEntry: .4 group, .5 group index, .7 code

// prtMarkerSuppliesType
const SUPPLY_TYPES = {
  3: 'toner', 4: 'wasteToner', 5: 'ink', 6: 'inkCartridge', 7: 'inkRibbon', 8: 'wasteInk', 9: 'drum', 10: 'developer',
  11: 'fuserOil', 15: 'fuser', 18: 'transferUnit', 19: 'tonerCartridge', 20: 'fuserOiler', 21: 'water', 22: 'wasteWater',
  25: 'bandingSupply', 26: 'bindingSupply', 32: 'staples',
};

// hrPrinterDetectedErrorState: two bytes, most significant bit first
const ERROR_BITS = [
  'lowPaper', 'noPaper', 'lowToner', 'noToner', 'doorOpen', 'jammed', 'offline', 'serviceRequested',
  'inputTrayMissing', 'outputTrayMissing', 'markerSupplyMissing', 'outputNearFull', 'outputFull', 'inputTrayEmpty', 'overduePreventMaint',
];
const HR_STATUS = { 1: 'other', 2: 'unknown', 3: 'idle', 4: 'printing', 5: 'warmup' };

export function decodeErrors(buf) {
  if (!buf || !buf.length) return [];
  const out = [];
  for (let i = 0; i < ERROR_BITS.length; i++) {
    const byte = buf[i >> 3];
    if (byte === undefined) break;
    if (byte & (0x80 >> (i % 8))) out.push(ERROR_BITS[i]);
  }
  return out;
}

const COLOR_WORDS = [
  ['black', /black|schwarz|noir|nero|\bbk\b|\bk\b/i], ['cyan', /cyan|\bc\b/i], ['magenta', /magenta|\bm\b/i], ['yellow', /yellow|gelb|jaune|giallo|\by\b/i],
];

/** Colour of a supply from the colorant name or the description */
export function supplyColor(colorant, description) {
  for (const src of [colorant, description]) {
    if (!src) continue;
    for (const [c, re] of COLOR_WORDS) if (re.test(src)) return c;
  }
  return '';
}

// prtAlertCode for one supply (group markerSupplies = 11, group index = prtMarkerSuppliesIndex). Many printers give no
// level for colour toner (only "some remaining") but raise these alerts - as on their own display ("Cyan low").
const ALERT_LOW = new Set([7, 13, 1104, 1105, 1106, 1107, 1108, 1111, 1113]);   // life almost over, almost empty / full
const ALERT_EMPTY = new Set([8, 14, 1101, 1102, 1103, 1109, 1110, 1112, 1114]); // life over, empty / receptacle full
const GROUP_SUPPLIES = 11;

/**
 * Supplies the printer itself calls low or empty, from its alert table.
 * alerts: Map("<column>.<hrDeviceIndex>.<alertIndex>" → value) → Map("<hrDeviceIndex>.<supplyIndex>" → 'low' | 'empty')
 */
export function supplyAlertStates(alerts = new Map()) {
  const rows = new Map();
  for (const [suffix, value] of alerts) {
    const [col, dev, idx] = suffix.split('.');
    if (!idx) continue;
    const k = `${dev}.${idx}`;
    if (!rows.has(k)) rows.set(k, { dev });
    rows.get(k)[Number(col)] = Number(value);
  }
  const out = new Map();
  for (const r of rows.values()) {
    if (r[4] !== GROUP_SUPPLIES || !(r[5] > 0)) continue;
    const state = ALERT_EMPTY.has(r[7]) ? 'empty' : ALERT_LOW.has(r[7]) ? 'low' : null;
    const key = `${r.dev}.${r[5]}`;
    if (state && out.get(key) !== 'empty') out.set(key, state);
  }
  return out;
}

/**
 * Turns the raw SNMP tables into a list of supplies.
 * supplies: Map("<column>.<hrDeviceIndex>.<index>" → value), colorants: Map("<hrDeviceIndex>.<index>" → value)
 */
export function parseSupplies(supplies, colorants = new Map(), alerted = new Map()) {
  const rows = new Map();
  for (const [suffix, value] of supplies) {
    const [col, dev, idx] = suffix.split('.');
    if (!idx) continue;
    const key = `${dev}.${idx}`;
    if (!rows.has(key)) rows.set(key, { key });
    rows.get(key)[Number(col)] = value;
  }
  const out = [];
  for (const r of rows.values()) {
    const description = text(r[6], 120);
    const type = SUPPLY_TYPES[r[5]] || 'other';
    const receptacle = Number(r[4]) === 4; // receptacleThatIsFilled (waste toner): "level" is the space left
    const max = Number(r[8]);
    const level = Number(r[9]);
    let pct = null;
    let state = 'ok';
    if (Number.isFinite(level) && level >= 0 && Number.isFinite(max) && max > 0) pct = Math.max(0, Math.min(100, Math.round((level / max) * 100)));
    else if (level === -3) state = 'some';        // "some remaining", no exact level
    else state = 'unknown';
    if (pct === 0 || (max === -2 && level === 0)) state = 'empty';
    // No level known: what the printer says about it (a known level always wins)
    if (pct === null && state !== 'empty' && alerted.has(r.key)) state = alerted.get(r.key);
    const colorant = r[3] ? text(colorants.get(`${r.key.split('.')[0]}.${r[3]}`), 40) : '';
    // level/max with unit (prtMarkerSuppliesSupplyUnit): 7 = impressions, 8 = sheets → "about n pages left"
    out.push({ key: r.key, description: description || type, type, color: supplyColor(colorant, description), receptacle, pct, state,
      level: Number.isFinite(level) && level >= 0 ? level : null, max: Number.isFinite(max) && max > 0 ? max : null, unit: Number(r[7]) || null });
  }
  // Order: colours first (K, C, M, Y), then the rest
  const order = { black: 0, cyan: 1, magenta: 2, yellow: 3 };
  return out.sort((a, b) => (order[a.color] ?? 9) - (order[b.color] ?? 9) || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/** Model of the printer: hrDeviceDescr of the device the printer table points to (otherwise the first entry) */
export function printerModel(hr, descr) {
  const idx = [...(hr?.keys() || [])].map((k) => k.split('.').slice(1).join('.')).find(Boolean);
  const v = (idx && descr?.get(idx)) || [...(descr?.values() || [])][0];
  return text(v, 80).replace(/\s*;.*$/, '');
}

/** Reads the status of one printer. Throws with a readable message if it does not answer. */
export async function readPrinter(ip, communities, { port = 161 } = {}) {
  const s = await openSnmp(ip, communities, { port });
  if (!s) throw new Error('snmp');
  try {
    const [supplies, colorants, counts, display, hr, single, descr, alerts] = await Promise.all([
      walk(s, SUPPLIES, { max: 600 }),
      walk(s, COLORANTS, { max: 60 }),
      walk(s, LIFE_COUNT, { max: 10 }),
      walk(s, DISPLAY, { max: 10 }),
      walk(s, HR_PRINTER, { max: 20 }),
      getValues(s, [SERIAL]),
      walk(s, HR_DESCR, { max: 20 }),
      // only the three columns needed (group, group index, code) - the table can be long on a busy printer
      Promise.all([4, 5, 7].map((c) => walk(s, `${ALERTS}.${c}`, { max: 100 }).catch(() => new Map())))
        .then((cols) => new Map(cols.flatMap((m, i) => [...m].map(([k, v]) => [`${[4, 5, 7][i]}.${k}`, v])))),
    ]);
    if (!supplies.size && !counts.size && !hr.size) throw new Error('noPrinterMib');
    let status = '';
    let errors = [];
    for (const [suffix, v] of hr) {
      if (suffix.startsWith('1.') && !status) status = HR_STATUS[Number(v)] || '';
      if (suffix.startsWith('2.') && !errors.length) errors = decodeErrors(Buffer.isBuffer(v) ? v : Buffer.alloc(0));
    }
    const pages = [...counts.values()].map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    return {
      supplies: parseSupplies(supplies, colorants, supplyAlertStates(alerts)),
      pages: pages.length ? Math.max(...pages) : null,
      status,
      errors,
      display: [...display.values()].map((v) => text(v, 80)).filter(Boolean).slice(0, 4),
      serial: text(single[SERIAL], 60),
      model: printerModel(hr, descr),
      snmp: s.version,
    };
  } finally {
    s.close();
  }
}
