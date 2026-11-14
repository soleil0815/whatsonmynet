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
  host: [['hostOnline', 1], ['hostCpu', 1], ['hostMem', 1], ['hostDisk', 1, SYSTEM_DRIVE], ['hostTempMax', 1], ['servicesFailed', 1]],
};
const NODE_KINDS = ['pve', 'vmware', 'hyperv', 'xcpng', 'nutanix', 'ovirt', 'libvirt'];
export function hostPicks(kind) {
  if (kind === 'pbs') return [['datastore', 3], ['tasksFailed', 1]];
  if (kind === 'redfish') return [['rfHealth', 1], ['rfTemp', 1]];
  if (['unifi', 'omada', 'mikrotik'].includes(kind)) return [['netOnline', 6]];
  if (NODE_KINDS.includes(kind)) return [['nodeOnline', 4], ['storage', 3], ['backupFailed', 1]];
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
  const on = () => settings.get(SETTING) !== false;
  const limits = () => ({ printerThreshold: Number(settings.get('printer.threshold')) || 15, nasThreshold: Number(settings.get('nas.threshold')) || 90 });
  const takenOn = (where, ...args) => new Set(db.prepare(`SELECT options FROM monitors WHERE ${where}`).all(...args)
    .map((m) => parse(m.options, {})).map((o) => `${o.metric}|${o.key ?? ''}`));

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
        for (const x of pick(metrics, DEVICE_PICKS[src], takenOn("type='sensor' AND device_id=?", d.id))) {
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
    for (const x of pick(metrics, hostPicks(h.kind), takenOn("type='proxmox' AND json_extract(options,'$.host')=?", h.id))) {
      const label = hostValueLabel(x, lang);
      // node values name their node themselves; other values get the host when there are several (as in the dialog)
      const owner = several && !/^node/.test(x.metric) && x.metric !== 'storage' ? h.name : '';
      n += await sensor({ type: 'proxmox', name: sensorName(owner, label).slice(0, 120), interval_s: 300,
        options: { host: h.id, metric: x.metric, key: x.key ?? '', op: x.op, threshold: x.threshold ?? '', label: label.slice(0, 120) } });
    }
    db.prepare('UPDATE proxmox_hosts SET auto_watch=? WHERE id=?').run(JSON.stringify({ ...w, done: true }), h.id);
    return n;
  }

  /** One round: everything added "to be watched" that has something new to watch */
  async function tick() {
    if (busy || !on()) return 0;
    busy = true;
    let n = 0;
    try {
      for (const d of db.prepare('SELECT id, name, ip, auto_watch FROM devices WHERE auto_watch IS NOT NULL').all()) n += await forDevice(d);
      for (const h of db.prepare('SELECT id, name, kind, last_ok, data, auto_watch FROM proxmox_hosts WHERE auto_watch IS NOT NULL').all()) n += await forHost(h);
      if (n) log.info(`Watch new devices: ${n} monitor(s)/sensor(s) created`);
    } catch (e) { log.warn(`Watch new devices: ${e.message}`); } finally { busy = false; }
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
      if (timer) setImmediate(() => { tick(); });
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
