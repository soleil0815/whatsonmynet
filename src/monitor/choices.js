// One list of what a sensor can watch, the same whichever way it is opened: from a device in the inventory or from a
// host under Virtualization. A Proxmox node that is also a device (same name) shows the values of the hypervisor and
// those of the Linux script together; a server with a management chip (Redfish) shows its hardware values too.
// A value both sides deliver (CPU, RAM, the hottest temperature of a node with the script) is offered only once.
import { metricsFor } from './sensors.js';
import { proxmoxMetrics } from '../proxmox.js';
import { nodeTempsInto } from '../hosts.js';

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
/** "pve2.firma.local" → "pve2" */
export const shortName = (s) => String(s || '').toLowerCase().trim().split('.')[0];
const urlHost = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return ''; } };

// Values of a node the script on it has as well - the script's are offered, the hypervisor's not a second time
const SCRIPT_TWIN = { nodeCpu: 'hostCpu', nodeMem: 'hostMem', nodeTemp: 'hostTempMax' };
const NODE_METRICS = ['nodeOnline', 'nodeCpu', 'nodeMem', 'nodeTemp'];
// Kinds whose host is a single machine (not a cluster with nodes): the host itself can be a device
const SINGLE = ['pbs'];

export function createSensorChoices({ db, settings }) {
  const limits = () => ({ printerThreshold: Number(settings?.get('printer.threshold')) || 15, nasThreshold: Number(settings?.get('nas.threshold')) || 90 });
  const devValues = (id) => metricsFor(db, id, limits());
  const hostsAll = () => db.prepare('SELECT id, name, kind, url, data FROM proxmox_hosts ORDER BY name').all()
    .map((h) => ({ ...h, data: nodeTempsInto(db, parse(h.data, {})) }));

  /** name → device id for every device (inventory name, host name, the name its script reports); IP → device id */
  function deviceIndex() {
    const byName = new Map(); const byIp = new Map();
    const reported = new Map(db.prepare('SELECT device_id, data FROM host_reports').all().map((r) => [r.device_id, parse(r.data, {})?.hostname]));
    for (const d of db.prepare('SELECT id, name, hostname, ip FROM devices ORDER BY id').all()) {
      for (const n of [d.name, d.hostname, reported.get(d.id)]) { const k = shortName(n); if (k && !byName.has(k)) byName.set(k, d.id); }
      if (d.ip && !byIp.has(d.ip)) byIp.set(d.ip, d.id);
    }
    return { byName, byIp };
  }
  /** The device a host (single machine) is: by the address in its URL */
  function deviceOfHost(h, idx) {
    if (!SINGLE.includes(h.kind)) return null;
    const a = urlHost(h.url);
    return idx.byIp.get(a) || idx.byName.get(shortName(a)) || null;
  }

  /** Hypervisor values that belong to this one machine; `own` are its own device values (to leave out twins) */
  function hostValuesOf(h, deviceId, idx, own) {
    const has = new Set(own.map((x) => x.metric));
    const all = proxmoxMetrics(h.data);
    if (h.kind === 'redfish') return h.data?.deviceId === deviceId ? all : [];
    if (deviceOfHost(h, idx) === deviceId) return all;
    const nodes = new Set((h.data?.nodes || []).map((n) => n.name).filter((n) => idx.byName.get(shortName(n)) === deviceId));
    if (!nodes.size) return [];
    return all.filter((x) => (NODE_METRICS.includes(x.metric) && nodes.has(x.key) && !has.has(SCRIPT_TWIN[x.metric]))
      // storage that sits on this node only ("local", "local-zfs" of pve2)
      || (x.metric === 'storage' && nodes.has(String(x.key).split('/')[0])));
  }

  const dev = (deviceId, x, group) => ({ src: 'device', device: deviceId, group, ...x });
  const px = (h, x, group) => ({ src: 'host', host: h.id, hostName: h.name, group, ...x });

  return {
    /** Everything a sensor on this device can watch. withHosts = false for users limited to locations (hypervisors are not theirs) */
    forDevice(deviceId, { withHosts = true } = {}) {
      const own = devValues(deviceId);
      const out = own.map((x) => dev(deviceId, x, null));
      if (!withHosts) return out;
      const idx = deviceIndex();
      for (const h of hostsAll()) for (const x of hostValuesOf(h, deviceId, idx, own)) out.push(px(h, x, null));
      return out;
    },

    /** Everything of a host under Virtualization, each node together with the values of its script */
    forHost(hostId) {
      const h = hostsAll().find((x) => x.id === hostId);
      if (!h) return [];
      const idx = deviceIndex();
      const all = proxmoxMetrics(h.data);
      const out = [];
      const single = deviceOfHost(h, idx);
      if (single) {
        const own = devValues(single);
        out.push(...own.map((x) => dev(single, x, 'server')));
        out.push(...all.map((x) => px(h, x, 'server')));
        return out;
      }
      const nodes = h.data?.nodes || [];
      const done = new Set();
      for (const n of nodes) {
        const id = idx.byName.get(shortName(n.name));
        const own = id ? devValues(id) : [];
        const has = new Set(own.map((x) => x.metric));
        const group = `node:${n.name}`;
        for (const x of all) {
          const mine = (NODE_METRICS.includes(x.metric) && x.key === n.name) || (x.metric === 'storage' && String(x.key).split('/')[0] === n.name);
          if (!mine) continue;
          done.add(x);
          if (!has.has(SCRIPT_TWIN[x.metric])) out.push(px(h, x, group));
        }
        out.push(...own.map((x) => dev(id, x, group)));
      }
      for (const x of all) if (!done.has(x)) out.push(px(h, x, null));
      return out;
    },

    /** Does a device have anything to watch (for the button "Add sensor" on its page) */
    hasValues(deviceId, opts) { return this.forDevice(deviceId, opts).length > 0; },

    /** Devices that offer values (printers, NAS, switches, UPS, machines with script, nodes, servers with Redfish) */
    deviceIds() {
      const ids = new Set(db.prepare("SELECT id FROM devices WHERE type IN ('printer','nas','switch','ups')").all().map((r) => r.id));
      for (const r of db.prepare('SELECT device_id FROM host_reports').all()) ids.add(r.device_id);
      const idx = deviceIndex();
      for (const h of hostsAll()) {
        if (h.kind === 'redfish' && h.data?.deviceId) ids.add(h.data.deviceId);
        const single = deviceOfHost(h, idx);
        if (single) ids.add(single);
        for (const n of h.data?.nodes || []) { const id = idx.byName.get(shortName(n.name)); if (id) ids.add(id); }
      }
      return ids;
    },
  };
}
