// Watched from the start: a device taken into the inventory gets a first monitor at once (its web interface, else
// ping or a port), and as soon as it delivers values (printer, NAS, UPS, Windows/Linux script) a few sensors that
// matter - not everything, the user adds more. Likewise a host added under Virtualization / controllers / hardware.
//
// Only for what was added while "Watch new devices by themselves" is on (devices.auto_watch / proxmox_hosts.auto_watch
// not NULL: the language the names are written in). Each part once - a sensor deleted afterwards does not come back.
// Runs with the monitoring (so never on a standby that only shows the data of its master).
import { log } from '../lib/log.js';
import { metricsFor, sourceOf } from './sensors.js';
import { proxmoxMetrics } from '../proxmox.js';
import { nodeTempsInto } from '../hosts.js';
import { deviceValueLabel, hostValueLabel, sensorName } from './sensornames.js';

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const SETTING = 'autowatch.enabled';

// What is worth a sensor right away, per kind of source: [metric, how many, filter]
const SYSTEM_DRIVE = (x) => /^(c:|\/)$/i.test(String(x.key));
// A NAS: its data volumes (/volume1, /share/CACHEDEV1_DATA, /mnt/tank) - not the small system partition (/, /opt …)
// nor the internal folders of the NAS system (/volume1/@docker, /volume1/@accountdb/@accountcache)
export const DATA_VOLUME = (x) => {
  const p = String(x.key ?? '');
  return !/(^|\/)@/.test(p) && !/^\/$/.test(p) && !/^\/(opt|usr|var|etc|boot|root|lib)(\/|$)/i.test(p);
};
export const DEVICE_PICKS = {
  printer: [['supply', 4, (x) => !x.receptacle], ['printerErrors', 1]],
  nas: [['volume', 4, DATA_VOLUME], ['raid', 2], ['health', 1], ['temp', 1], ['upsPower', 1]],
  ups: [['upsPower', 1], ['upsCharge', 1], ['upsRuntime', 1]],
  switch: [],
  host: [['hostOnline', 1], ['hostCpu', 1], ['hostMem', 1], ['hostDisk', 1, SYSTEM_DRIVE], ['hostTempMax', 1], ['servicesFailed', 1], ['hostPool', 8], ['localCheck', 20]],
};
const NODE_KINDS = ['pve', 'vmware', 'hyperv', 'xcpng', 'nutanix', 'ovirt', 'libvirt'];
export function hostPicks(kind) {
  if (kind === 'pbs') return [['datastore', 3], ['tasksFailed', 1]];
  if (kind === 'redfish') return [['rfHealth', 1], ['rfTemp', 1]];
  if (['unifi', 'omada', 'mikrotik'].includes(kind)) return [['netOnline', 6]];
  // Cloud: what the provider itself reports as broken - its alarms, its checks of the VMs, the databases, the load balancers
  if (kind === 'veeam') return [['jobsFailed', 1], ['repoUsed', 3]];
  if (kind === 'truenas') return [['pool', 8], ['poolUsed', 8], ['nasAlertsCrit', 1], ['replication', 10]];
  if (kind === 'ceph') return [['pool', 1], ['poolUsed', 1], ['poolDown', 1]];
  if (kind === 'm365') return [['m365Issues', 1], ['m365Sku', 6]];
  if (['aws', 'azure', 'gcp'].includes(kind)) return [['cloudAlarms', 1], ['cloudResources', 1], ['cloudCheck', 6], ['dbState', 4], ['lbUnhealthy', 4]];
  // pools: ZFS of the nodes, the Ceph cluster - their state (degraded, a disk gone) is what must not go unnoticed
  if (NODE_KINDS.includes(kind)) return [['nodeOnline', 4], ['storage', 3], ['pool', 8], ['backupFailed', 1]];
  return [['nodeOnline', 4]];
}

/** The values of `metrics` worth a sensor, in the order of the picks; `taken` = "metric|key" already watched */
export function pick(metrics, picks, taken = new Set()) {
  const out = [];
  for (const [metric, n, filter] of picks) {
    let list = metrics.filter((x) => x.metric === metric && (!filter || filter(x)));
    // the system drive, else the first one; no data volume to be found: the first one
    if ((metric === 'hostDisk' || metric === 'volume') && !list.length) list = metrics.filter((x) => x.metric === metric).slice(0, 1);
    for (const x of list.slice(0, n)) if (!taken.has(`${x.metric}|${x.key ?? ''}`)) out.push(x);
  }
  return out;
}

export function createAutoWatch({ db, settings, monitoring }) {
  let timer = null;
  let busy = false;
  let again = false;
  const on = () => settings.get(SETTING) !== false;
  const limits = () => ({ printerThreshold: Number(settings.get('printer.threshold')) || 15, nasThreshold: Number(settings.get('nas.threshold')) || 90 });
  const takenOn = (where, ...args) => new Set(db.prepare(`SELECT options FROM monitors WHERE ${where}`).all(...args)
    .map((m) => parse(m.options, {})).map((o) => `${o.metric}|${o.key ?? ''}`));

  // A Proxmox node that also runs the Linux host script reports its ZFS pools twice: through the API (metric pool,
  // key "zfs:<node>/<pool>") and through the script (hostPool, key "zfs:<pool>"). One sensor per pool is enough -
  // whichever comes first; the node is matched to the device by its (short) name.
  const short = (n) => String(n ?? '').trim().toLowerCase().replace(/\.$/, '').split('.')[0];
  const namesOfDevice = (id) => {
    const d = db.prepare("SELECT d.name, d.hostname, json_extract(h.data,'$.hostname') reported FROM devices d LEFT JOIN host_reports h ON h.device_id=d.id WHERE d.id=?").get(id);
    return new Set([d?.name, d?.hostname, d?.reported].map(short).filter(Boolean));
  };
  const nodePool = (key) => { const m = /^([^:]+):([^/]+)\/(.+)$/.exec(String(key ?? '')); return m ? { kind: m[1], node: short(m[2]), name: m[3] } : null; };
  /** hostPool keys of this device already watched as a pool of its node (through a hypervisor host) */
  function poolsWatchedOnNode(deviceId) {
    const names = namesOfDevice(deviceId);
    const out = new Set();
    for (const m of db.prepare("SELECT json_extract(options,'$.key') k FROM monitors WHERE type='proxmox' AND json_extract(options,'$.metric')='pool'").all()) {
      const p = nodePool(m.k);
      if (p && names.has(p.node)) out.add(`hostPool|${p.kind}:${p.name}`);
    }
    return out;
  }
  /** pool keys of hypervisor nodes already watched as hostPool of the machine itself (host script) */
  function poolsWatchedOnDevice(metrics) {
    const out = new Set();
    const nodes = new Set(metrics.filter((x) => x.metric === 'pool').map((x) => nodePool(x.key)?.node).filter(Boolean));
    if (!nodes.size) return out;
    const rows = db.prepare("SELECT device_id, json_extract(options,'$.key') k FROM monitors WHERE type='sensor' AND json_extract(options,'$.metric')='hostPool'").all();
    for (const r of rows) {
      const names = namesOfDevice(r.device_id);
      for (const n of nodes) if (names.has(n)) out.add(`pool|${String(r.k).replace(/^([^:]+):/, `$1:${n}/`)}`);
    }
    return out;
  }

  async function sensor(input) {
    try { await monitoring.create(input); return 1; } catch (e) {
      // watched that way already (by hand, with another name or address): nothing to add
      if (e.status !== 409) log.warn(`Watch new devices: ${input.name}: ${e.message}`);
      return 0;
    }
  }

  async function forDevice(d) {
    const w = parse(d.auto_watch, null);
    if (!w) return 0;
    const lang = w.lang === 'en' ? 'en' : 'de';
    let n = 0; let changed = false;
    // 1. Reachable at all: its web interface, else ping, else a port - unless it is watched that way already
    if (!w.conn) {
      const has = db.prepare("SELECT 1 FROM monitors WHERE device_id=? AND type IN ('http','tcp','ping')").get(d.id);
      if (d.ip && !has) {
        try { const s = await monitoring.suggestionFor(d.id); n += await sensor({ ...s, name: d.name }); } catch (e) { if (e.status !== 409) log.warn(`Watch new devices: ${d.name}: ${e.message}`); }
      }
      w.conn = true; changed = true;
    }
    // 2. Its values, once they are there - per source (a script set up weeks later still brings its sensors)
    const src = sourceOf(db, d.id);
    if (src && DEVICE_PICKS[src] && !w[src]) {
      const metrics = metricsFor(db, d.id, limits());
      if (metrics.length) {
        const taken = takenOn("type='sensor' AND device_id=?", d.id);
        for (const k of poolsWatchedOnNode(d.id)) taken.add(k);
        for (const x of pick(metrics, DEVICE_PICKS[src], taken)) {
          const label = deviceValueLabel(x, lang);
          n += await sensor({ type: 'sensor', device_id: d.id, name: sensorName(d.name, label).slice(0, 120), interval_s: 300,
            options: { metric: x.metric, key: x.key ?? '', op: x.op, threshold: x.threshold ?? '', label: label.slice(0, 120) } });
        }
        w[src] = true; changed = true;
      }
    }
    if (changed) db.prepare('UPDATE devices SET auto_watch=? WHERE id=?').run(JSON.stringify(w), d.id);
    return n;
  }

  async function forHost(h) {
    const w = parse(h.auto_watch, null);
    if (!w || w.done || !h.last_ok) return 0;
    const lang = w.lang === 'en' ? 'en' : 'de';
    const metrics = proxmoxMetrics(nodeTempsInto(db, parse(h.data, {})));
    if (!metrics.length) return 0;
    const several = db.prepare('SELECT COUNT(*) n FROM proxmox_hosts').get().n > 1;
    let n = 0;
    const taken = takenOn("type='proxmox' AND json_extract(options,'$.host')=?", h.id);
    for (const k of poolsWatchedOnDevice(metrics)) taken.add(k);
    for (const x of pick(metrics, hostPicks(h.kind), taken)) {
      const label = hostValueLabel(x, lang);
      // node values name their node themselves; other values get the host when there are several (as in the dialog)
      const owner = several && !/^node/.test(x.metric) && x.metric !== 'storage' ? h.name : '';
      n += await sensor({ type: 'proxmox', name: sensorName(owner, label).slice(0, 120), interval_s: 300,
        options: { host: h.id, metric: x.metric, key: x.key ?? '', op: x.op, threshold: x.threshold ?? '', label: label.slice(0, 120) } });
    }
    db.prepare('UPDATE proxmox_hosts SET auto_watch=? WHERE id=?').run(JSON.stringify({ ...w, done: true }), h.id);
    return n;
  }

  /**
   * One round: everything added "to be watched" that has something new to watch. rerun: asked because something was
   * just marked - if a round runs right now, one more follows right after (not a minute later). The minute timer does
   * not ask for that: a long round would otherwise be followed by the next one at once, forever.
   */
  async function tick({ rerun = false } = {}) {
    if (busy) { if (rerun) again = true; return 0; }
    if (!on()) return 0;
    busy = true;
    let n = 0;
    try {
      do {
        again = false;
        for (const d of db.prepare('SELECT id, name, ip, auto_watch FROM devices WHERE auto_watch IS NOT NULL').all()) n += await forDevice(d);
        for (const h of db.prepare('SELECT id, name, kind, last_ok, data, auto_watch FROM proxmox_hosts WHERE auto_watch IS NOT NULL').all()) n += await forHost(h);
      } while (again && on());
      if (n) log.info(`Watch new devices: ${n} monitor(s)/sensor(s) created`);
    } catch (e) { log.warn(`Watch new devices: ${e.message}`); } finally { busy = false; again = false; }
    return n;
  }

  return {
    enabled: on,
    /** Newly added devices / hosts: to be watched (only while the setting is on); lang = language of the names */
    markDevices(ids, lang) {
      if (!on() || !ids?.length) return false;
      const set = db.prepare('UPDATE devices SET auto_watch=? WHERE id=? AND auto_watch IS NULL');
      const v = JSON.stringify({ lang: lang === 'en' ? 'en' : 'de' });
      for (const id of ids) set.run(v, id);
      if (timer) setImmediate(() => { tick({ rerun: true }); });
      return true;
    },
    markHost(id, lang) {
      if (!on()) return false;
      db.prepare('UPDATE proxmox_hosts SET auto_watch=? WHERE id=? AND auto_watch IS NULL').run(JSON.stringify({ lang: lang === 'en' ? 'en' : 'de' }), id);
      if (timer) setImmediate(() => { tick(); });
      return true;
    },
    tick,
    start() { if (!timer) { timer = setInterval(() => { tick(); }, 60 * 1000); timer.unref(); setTimeout(() => { tick(); }, 5000).unref(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
