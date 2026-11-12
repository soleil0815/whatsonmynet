// Switch via SNMP (read-only): ports (IF-MIB), which MAC addresses were seen on which port (BRIDGE-MIB / Q-BRIDGE-MIB),
// neighbours (LLDP-MIB) and firmware/serial (ENTITY-MIB). Works with managed switches that speak SNMP v1/v2c.
import { openSnmp, walk, getValues, text } from './snmpwalk.js';
import { normalizeMac } from '../lib/net.js';

const IF = {
  descr: '1.3.6.1.2.1.2.2.1.2', type: '1.3.6.1.2.1.2.2.1.3', speed: '1.3.6.1.2.1.2.2.1.5', admin: '1.3.6.1.2.1.2.2.1.7',
  oper: '1.3.6.1.2.1.2.2.1.8', lastChange: '1.3.6.1.2.1.2.2.1.9', inErrors: '1.3.6.1.2.1.2.2.1.14',
  name: '1.3.6.1.2.1.31.1.1.1.1', highSpeed: '1.3.6.1.2.1.31.1.1.1.15', alias: '1.3.6.1.2.1.31.1.1.1.18',
  hcIn: '1.3.6.1.2.1.31.1.1.1.6', hcOut: '1.3.6.1.2.1.31.1.1.1.10',
};
const BRIDGE_PORT_IF = '1.3.6.1.2.1.17.1.4.1.2';        // dot1dBasePortIfIndex: bridge port → ifIndex
const FDB_PORT = '1.3.6.1.2.1.17.4.3.1.2';              // dot1dTpFdbPort.<mac>
const FDB_STATUS = '1.3.6.1.2.1.17.4.3.1.3';            // 3 = learned
const QFDB_PORT = '1.3.6.1.2.1.17.7.1.2.2.1.2';         // dot1qTpFdbPort.<fdbId>.<mac>
const LLDP_REM = '1.0.8802.1.1.2.1.4.1.1';              // lldpRemEntry: .7 portId, .8 portDesc, .9 sysName
const LLDP_LOC_PORT = '1.0.8802.1.1.2.1.3.7.1.4';       // lldpLocPortDesc
const ENT = { softwareRev: '1.3.6.1.2.1.47.1.1.1.1.10', serial: '1.3.6.1.2.1.47.1.1.1.1.11', model: '1.3.6.1.2.1.47.1.1.1.1.13', firmwareRev: '1.3.6.1.2.1.47.1.1.1.1.9' };
const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';

const ETHERNET_TYPES = new Set([6, 62, 69, 117, 161]); // ethernetCsmacd, fastEther, fastEtherFX, gigabitEthernet, ieee8023adLag
const STATUS = { 1: 'up', 2: 'down', 3: 'testing', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };

/** "2.0.17.226.5.1" → "00:11:e2:05:01:…" from the last six numbers of an OID suffix */
export function macFromOid(suffix) {
  const n = suffix.split('.').slice(-6).map(Number);
  if (n.length !== 6 || n.some((x) => !(x >= 0 && x <= 255))) return null;
  return normalizeMac(n.map((x) => x.toString(16).padStart(2, '0')).join(':'));
}

/** Ports from IF-MIB columns (Maps ifIndex → value). Only physical/aggregated Ethernet ports. */
export function parsePorts(cols) {
  const out = [];
  for (const [idx, type] of cols.type) {
    const t = Number(type);
    if (!ETHERNET_TYPES.has(t)) continue;
    const name = text(cols.name.get(idx), 60) || text(cols.descr.get(idx), 60) || `Port ${idx}`;
    const high = Number(cols.highSpeed.get(idx));
    const speed = Number.isFinite(high) && high > 0 ? high : Math.round((Number(cols.speed.get(idx)) || 0) / 1e6);
    out.push({
      ifIndex: Number(idx), name, alias: text(cols.alias.get(idx), 80), descr: text(cols.descr.get(idx), 80),
      status: STATUS[Number(cols.oper.get(idx))] || 'unknown', admin: Number(cols.admin.get(idx)) === 2 ? 'down' : 'up',
      speed, lag: t === 161, inErrors: Number(cols.inErrors.get(idx)) || 0,
      inOctets: cols.hcIn.has(idx) ? Number(cols.hcIn.get(idx)) : null, outOctets: cols.hcOut.has(idx) ? Number(cols.hcOut.get(idx)) : null,
    });
  }
  return out.sort((a, b) => a.ifIndex - b.ifIndex);
}

/**
 * MAC table: [{ mac, ifIndex, vlan }]. qfdb: Map("<fdbId>.<mac6>" → bridgePort), fdb: Map("<mac6>" → bridgePort),
 * fdbStatus: Map("<mac6>" → status), bridgeIf: Map(bridgePort → ifIndex).
 */
export function parseFdb({ qfdb = new Map(), fdb = new Map(), fdbStatus = new Map(), bridgeIf = new Map() }) {
  const seen = new Map();
  const ifOf = (bp) => (bridgeIf.has(String(bp)) ? Number(bridgeIf.get(String(bp))) : Number(bp));
  for (const [suffix, bp] of qfdb) {
    const mac = macFromOid(suffix);
    if (!mac || !Number(bp)) continue;
    const vlan = Number(suffix.split('.')[0]) || null;
    seen.set(`${mac}|${vlan}`, { mac, ifIndex: ifOf(bp), vlan });
  }
  if (!seen.size) {
    for (const [suffix, bp] of fdb) {
      const mac = macFromOid(suffix);
      if (!mac || !Number(bp)) continue;
      const st = Number(fdbStatus.get(suffix));
      if (st && st !== 3) continue; // only learned entries, not the switch's own or static ones
      seen.set(mac, { mac, ifIndex: ifOf(bp), vlan: null });
    }
  }
  return [...seen.values()];
}

/** LLDP neighbours: [{ localPort, name, port }] */
export function parseLldp(rem, locPort = new Map()) {
  const rows = new Map();
  for (const [suffix, v] of rem) {
    const [col, , localNum, idx] = suffix.split('.');
    if (!idx) continue;
    const key = `${localNum}.${idx}`;
    if (!rows.has(key)) rows.set(key, { localNum });
    rows.get(key)[col] = v;
  }
  const out = [];
  for (const r of rows.values()) {
    const name = text(r[9], 80);
    if (!name && !r[7]) continue;
    const portDesc = text(r[8], 60);
    const portId = Buffer.isBuffer(r[7]) && r[7].length === 6 ? normalizeMac(r[7].toString('hex')) : text(r[7], 60);
    out.push({ localNum: Number(r.localNum), localPort: text(locPort.get(r.localNum), 60) || `#${r.localNum}`, name, port: portDesc || portId || '' });
  }
  return out;
}

function firstText(map) {
  for (const v of map.values()) { const s = text(v, 80); if (s) return s; }
  return '';
}

export async function readSwitch(ip, communities, { port = 161 } = {}) {
  const s = await openSnmp(ip, communities, { port });
  if (!s) throw new Error('snmp');
  try {
    const cols = {};
    await Promise.all(Object.entries(IF).map(async ([k, oid]) => { cols[k] = await walk(s, oid, { max: 1200 }); }));
    if (!cols.type.size) throw new Error('noIfMib');
    const [bridgeIf, qfdb, sys, rem, locPort, entSw, entFw, entSerial, entModel] = await Promise.all([
      walk(s, BRIDGE_PORT_IF, { max: 1200 }),
      walk(s, QFDB_PORT, { max: 8000, timeout: 15000 }),
      getValues(s, [SYS_DESCR, SYS_UPTIME]),
      walk(s, LLDP_REM, { max: 600 }),
      walk(s, LLDP_LOC_PORT, { max: 400 }),
      walk(s, ENT.softwareRev, { max: 50 }), walk(s, ENT.firmwareRev, { max: 50 }), walk(s, ENT.serial, { max: 50 }), walk(s, ENT.model, { max: 50 }),
    ]);
    let fdb = new Map(); let fdbStatus = new Map();
    if (!qfdb.size) [fdb, fdbStatus] = await Promise.all([walk(s, FDB_PORT, { max: 8000, timeout: 15000 }), walk(s, FDB_STATUS, { max: 8000, timeout: 15000 })]);
    const ports = parsePorts(cols);
    const macs = parseFdb({ qfdb, fdb, fdbStatus, bridgeIf });
    const remCols = new Map([...rem].filter(([k]) => /^(7|8|9)\./.test(k)));
    return {
      ports,
      macs,
      neighbours: parseLldp(remCols, locPort),
      firmware: firstText(entSw) || firstText(entFw),
      serial: firstText(entSerial),
      model: firstText(entModel),
      descr: text(sys[SYS_DESCR], 200),
      uptime: Number(sys[SYS_UPTIME]) || null,
      snmp: s.version,
    };
  } finally {
    s.close();
  }
}
