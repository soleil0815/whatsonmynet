// NAS via SNMP (read-only): volumes from HOST-RESOURCES-MIB (any NAS/Linux with SNMP), plus health, temperature,
// disks and RAID from the Synology MIB and the QNAP MIB where available.
import { openSnmp, walk, getValues, text } from './snmpwalk.js';
import { readUpsValues } from './ups.js';

const HR_STORAGE = '1.3.6.1.2.1.25.2.3.1';        // .2 type, .3 descr, .4 allocation unit, .5 size, .6 used
const FIXED_DISK = '1.3.6.1.2.1.25.2.1.4';
const SYN = {
  system: '1.3.6.1.4.1.6574.1.1.0', temp: '1.3.6.1.4.1.6574.1.2.0', power: '1.3.6.1.4.1.6574.1.3.0',
  fan: '1.3.6.1.4.1.6574.1.4.1.0', cpuFan: '1.3.6.1.4.1.6574.1.4.2.0',
  model: '1.3.6.1.4.1.6574.1.5.1.0', serial: '1.3.6.1.4.1.6574.1.5.2.0', version: '1.3.6.1.4.1.6574.1.5.3.0', upgrade: '1.3.6.1.4.1.6574.1.5.4.0',
};
const SYN_DISK = '1.3.6.1.4.1.6574.2.1.1';        // .2 id, .3 model, .5 status, .6 temperature
const SYN_RAID = '1.3.6.1.4.1.6574.3.1.1';        // .2 name, .3 status, .4 free, .5 total
const QNAP = { model: '1.3.6.1.4.1.24681.1.2.12.0', temp: '1.3.6.1.4.1.24681.1.2.6.0', version: '1.3.6.1.4.1.24681.1.4.1.1.1.1.1.4.0' };
const QNAP_DISK = '1.3.6.1.4.1.24681.1.2.11.1';  // .2 descr, .3 temp text, .4 status (0 ready, -5 noDisk, -6 invalid, -9 rwError), .5 model, .7 smart text

const DISK_STATUS = { 1: 'normal', 2: 'initialized', 3: 'notInitialized', 4: 'systemPartitionFailed', 5: 'crashed' };
const RAID_STATUS = { 1: 'normal', 2: 'repairing', 3: 'migrating', 4: 'expanding', 5: 'deleting', 6: 'creating', 7: 'raidSyncing', 8: 'raidParityChecking',
  9: 'raidAssembling', 10: 'canceling', 11: 'degrade', 12: 'crashed', 13: 'dataScrubbing', 14: 'raidDeploying', 15: 'raidUnDeploying',
  16: 'raidMountCache', 17: 'raidUnmountCache', 18: 'raidExpandingUnfinishedSHR', 19: 'raidConvertSHRToPool', 20: 'raidMigrateSHR1ToSHR2', 21: 'raidUnknownStatus' };
const RAID_BAD = new Set(['degrade', 'crashed', 'raidUnknownStatus']);
const DISK_BAD = new Set(['systemPartitionFailed', 'crashed']);

// Mount points that are not data volumes
const SKIP_STORAGE = /^(\/(dev|run|sys|proc|tmp)(\/|$)|\/boot|\/var\/run|\/volumeUSB\d+\/usbshare$|.*tmpfs|.*shm$|Physical memory|Virtual memory|Memory buffers|Cached memory|Shared memory|Swap space)/i;

/** Volumes from hrStorageTable (Map "<col>.<idx>" → value) */
export function parseStorage(map) {
  const rows = new Map();
  for (const [suffix, v] of map) {
    const [col, idx] = suffix.split('.');
    if (!idx) continue;
    if (!rows.has(idx)) rows.set(idx, {});
    rows.get(idx)[col] = v;
  }
  const out = [];
  for (const r of rows.values()) {
    const type = String(r[2] || '');
    const name = text(r[3], 120);
    if (type && type !== FIXED_DISK) continue;
    if (!name || SKIP_STORAGE.test(name)) continue;
    const unit = Number(r[4]) || 0;
    const size = (Number(r[5]) || 0) * unit;
    const used = (Number(r[6]) || 0) * unit;
    if (size < 1024 ** 3) continue; // under 1 GB: system partitions
    out.push({ name, size, used, pct: Math.round((used / size) * 100) });
  }
  // Synology lists the same volume under several mount points - keep the shortest name per size
  const bySize = new Map();
  for (const v of out) { const k = `${v.size}`; if (!bySize.has(k) || v.name.length < bySize.get(k).name.length) bySize.set(k, v); }
  return [...bySize.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function rowsOf(map) {
  const rows = new Map();
  for (const [suffix, v] of map) {
    const [col, ...rest] = suffix.split('.');
    const idx = rest.join('.');
    if (!idx) continue;
    if (!rows.has(idx)) rows.set(idx, {});
    rows.get(idx)[col] = v;
  }
  return [...rows.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, r]) => r);
}

export function parseSynologyDisks(map) {
  return rowsOf(map).map((r) => {
    const status = DISK_STATUS[Number(r[5])] || 'unknown';
    return { name: text(r[2], 40), model: text(r[3], 60), status, bad: DISK_BAD.has(status), temp: Number(r[6]) || null };
  }).filter((d) => d.name);
}

export function parseSynologyRaids(map) {
  return rowsOf(map).map((r) => {
    const status = RAID_STATUS[Number(r[3])] || 'raidUnknownStatus';
    return { name: text(r[2], 60), status, bad: RAID_BAD.has(status), free: Number(r[4]) || null, total: Number(r[5]) || null };
  }).filter((x) => x.name);
}

export function parseQnapDisks(map) {
  const st = { 0: 'normal', '-4': 'unknown', '-5': 'noDisk', '-6': 'invalid', '-9': 'rwError' };
  return rowsOf(map).map((r) => {
    const status = st[String(Number(r[4]))] || 'unknown';
    const temp = Number(/(-?\d+)\s*C/i.exec(text(r[3], 40))?.[1]) || null;
    return { name: text(r[2], 40), model: text(r[5], 60), status, bad: status === 'rwError' || status === 'invalid' || /abnormal|bad/i.test(text(r[7], 30)), temp };
  }).filter((d) => d.name && d.status !== 'noDisk');
}

export async function readNas(ip, communities, { port = 161 } = {}) {
  const s = await openSnmp(ip, communities, { port });
  if (!s) throw new Error('snmp');
  try {
    const [storage, syn, synDisks, synRaids, qnap, qnapDisks, ups] = await Promise.all([
      walk(s, HR_STORAGE, { max: 600 }),
      getValues(s, Object.values(SYN)),
      walk(s, SYN_DISK, { max: 400 }),
      walk(s, SYN_RAID, { max: 200 }),
      getValues(s, Object.values(QNAP)),
      walk(s, QNAP_DISK, { max: 400 }),
      // UPS on the NAS (Synology UPS server) or a UPS-MIB the NAS passes on
      readUpsValues(s).catch(() => null),
    ]);
    const volumes = parseStorage(storage);
    const isSyn = SYN.model in syn || synDisks.size > 0;
    const isQnap = !isSyn && (QNAP.model in qnap || qnapDisks.size > 0);
    if (!volumes.length && !isSyn && !isQnap) throw new Error('noNasMib');
    const out = { vendor: isSyn ? 'synology' : isQnap ? 'qnap' : 'generic', volumes, disks: [], raids: [], snmp: s.version, ups: ups || null };
    if (isSyn) {
      out.model = text(syn[SYN.model], 60);
      out.serial = text(syn[SYN.serial], 60);
      out.version = text(syn[SYN.version], 60);
      out.temp = Number(syn[SYN.temp]) || null;
      out.system = Number(syn[SYN.system]) === 2 ? 'failed' : syn[SYN.system] !== undefined ? 'normal' : '';
      out.power = Number(syn[SYN.power]) === 2 ? 'failed' : syn[SYN.power] !== undefined ? 'normal' : '';
      out.fan = [syn[SYN.fan], syn[SYN.cpuFan]].some((v) => Number(v) === 2) ? 'failed' : syn[SYN.fan] !== undefined ? 'normal' : '';
      out.upgrade = Number(syn[SYN.upgrade]) === 1;
      out.disks = parseSynologyDisks(synDisks);
      out.raids = parseSynologyRaids(synRaids);
    } else if (isQnap) {
      out.model = text(qnap[QNAP.model], 60);
      out.version = text(qnap[QNAP.version], 60);
      out.temp = Number(/(-?\d+)\s*C/i.exec(text(qnap[QNAP.temp], 40))?.[1]) || null;
      out.disks = parseQnapDisks(qnapDisks);
    }
    return out;
  } finally {
    s.close();
  }
}

/** Problems worth a notice: { key, kind, text-vars } - used by the poller to report each once */
export function nasProblems(d, usageThreshold = 90) {
  const p = [];
  if (d.system === 'failed') p.push({ key: 'system', kind: 'system' });
  if (d.power === 'failed') p.push({ key: 'power', kind: 'power' });
  if (d.fan === 'failed') p.push({ key: 'fan', kind: 'fan' });
  for (const r of d.raids || []) if (r.bad) p.push({ key: `raid:${r.name}`, kind: 'raid', name: r.name, status: r.status });
  for (const x of d.disks || []) if (x.bad) p.push({ key: `disk:${x.name}`, kind: 'disk', name: x.name, status: x.status });
  for (const v of d.volumes || []) if (v.pct >= usageThreshold) p.push({ key: `vol:${v.name}`, kind: 'volume', name: v.name, pct: v.pct });
  return p;
}

/** A UPS with its own network card: only the UPS values (read only) */
export async function readUpsDevice(ip, communities, { port = 161 } = {}) {
  const s = await openSnmp(ip, communities, { port });
  if (!s) throw new Error('snmp');
  try {
    const ups = await readUpsValues(s);
    if (!ups) throw new Error('noUpsMib');
    return { ups, model: ups.model, serial: ups.serial, firmware: ups.firmware, vendor: ups.vendor, snmp: s.version };
  } finally { s.close(); }
}
