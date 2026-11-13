// Switches and NAS: asks them via SNMP at a set interval (read-only).
// Switch: ports, MAC table (→ "plugged in at switch X, port Y" for every device), LLDP neighbours, firmware.
// NAS: volumes, disks, RAID, temperature, health - problems are reported once and again when they are solved.
import { readSwitch } from './scan/switch.js';
import { fillDevice, snmpFacts } from './devicefill.js';
import { readNas, nasProblems } from './scan/nas.js';
import { HttpError } from './lib/http.js';
import { log } from './lib/log.js';
import { normalizeMac } from './lib/net.js';

export const SNMP_KINDS = { switch: 'switch', nas: 'nas' };
const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };

export function createSnmpDevices({ db, settings, channels }) {
  const communities = () => {
    const list = String(settings.get('scan.snmpCommunities') || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
    return list.length ? list : ['public'];
  };
  const readers = { switch: readSwitch, nas: readNas };
  const busy = new Set();
  let timer = null;
  let polling = false;

  const getStatus = db.prepare('SELECT * FROM snmp_status WHERE device_id=?');
  const upsert = db.prepare(`INSERT INTO snmp_status(device_id,kind,at,ok,error,data,alerts) VALUES(@device_id,@kind,@at,@ok,@error,@data,@alerts)
    ON CONFLICT(device_id) DO UPDATE SET kind=excluded.kind, at=excluded.at, ok=excluded.ok, error=excluded.error,
      data=CASE WHEN excluded.ok=1 THEN excluded.data ELSE snmp_status.data END, alerts=excluded.alerts`);

  function shape(row) {
    if (!row) return null;
    return { kind: row.kind, at: row.at, ok: !!row.ok, error: row.error, ...parse(row.data) };
  }

  /** Switch view: ports with the devices seen on them (names from the inventory) */
  function switchView(deviceId, data) {
    const rows = db.prepare(`SELECT s.mac, s.if_index, s.vlan, d.id device_id, d.name device_name, d.type device_type
      FROM switch_macs s LEFT JOIN devices d ON d.mac=s.mac WHERE s.switch_id=? ORDER BY s.if_index`).all(deviceId);
    const byIf = new Map();
    for (const r of rows) {
      if (!byIf.has(r.if_index)) byIf.set(r.if_index, []);
      byIf.get(r.if_index).push({ mac: r.mac, vlan: r.vlan || null, device: r.device_id ? { id: r.device_id, name: r.device_name, type: r.device_type } : null });
    }
    return { ...data, macs: undefined, ports: (data.ports || []).map((p) => ({ ...p, macs: byIf.get(p.ifIndex) || [] })) };
  }

  function status(deviceId) {
    const s = shape(getStatus.get(deviceId));
    if (!s) return null;
    return s.kind === 'switch' ? switchView(deviceId, s) : s;
  }

  /**
   * Where is this MAC plugged in? The port with the fewest addresses wins (an uplink sees many devices, the port of
   * the device itself only a few).
   */
  function locate(mac) {
    const m = normalizeMac(mac);
    if (!m) return null;
    const rows = db.prepare(`SELECT s.switch_id, s.if_index, s.port, s.vlan, s.seen_at, d.name switch_name,
        (SELECT COUNT(*) FROM switch_macs x WHERE x.switch_id=s.switch_id AND x.if_index=s.if_index) n
      FROM switch_macs s JOIN devices d ON d.id=s.switch_id WHERE s.mac=? ORDER BY n, s.seen_at DESC`).all(m);
    if (!rows.length) return null;
    const r = rows[0];
    return { switchId: r.switch_id, switchName: r.switch_name, port: r.port, ifIndex: r.if_index, vlan: r.vlan || null, seenAt: r.seen_at, macsOnPort: r.n };
  }

  function storeMacs(deviceId, data, at) {
    const portName = new Map((data.ports || []).map((p) => [p.ifIndex, p.name]));
    const ifs = new Set(portName.keys());
    db.transaction(() => {
      db.prepare('DELETE FROM switch_macs WHERE switch_id=?').run(deviceId);
      const ins = db.prepare('INSERT OR REPLACE INTO switch_macs(switch_id,mac,if_index,port,vlan,seen_at) VALUES(?,?,?,?,?,?)');
      // Only addresses on real ports (not on the CPU/VLAN interfaces of the switch itself)
      for (const m of (data.macs || []).slice(0, 8000)) if (ifs.has(m.ifIndex)) ins.run(deviceId, m.mac, m.ifIndex, portName.get(m.ifIndex) || '', m.vlan || 0, at);
    })();
  }

  async function notifyNas(device, prev, data, at) {
    const threshold = Number(settings.get('nas.threshold')) || 90;
    const now = nasProblems(data, threshold);
    const alerts = { ...prev };
    const events = [];
    for (const p of now) if (!alerts[p.key]) { alerts[p.key] = p; events.push({ ...p, solved: false }); }
    for (const k of Object.keys(alerts)) if (!now.some((p) => p.key === k)) { events.push({ ...alerts[k], solved: true }); delete alerts[k]; }
    if (events.length && settings.get('nas.notify')) {
      for (const ev of events) {
        const reached = await channels.notifyIds(settings.get('nas.channels'), { kind: 'nas', device: { id: device.id, name: device.name, ip: device.ip }, problem: ev, at });
        if (reached.length) log.info(`NAS ${device.name}: ${ev.key} ${ev.solved ? 'solved' : 'reported'} via ${reached.join(', ')}`);
      }
    }
    return alerts;
  }

  async function poll(deviceId) {
    const d = db.prepare('SELECT id, name, ip, type FROM devices WHERE id=?').get(deviceId);
    if (!d) throw new HttpError(404, 'err.notFound');
    const kind = SNMP_KINDS[d.type];
    if (!kind) throw new HttpError(400, 'err.snmpType');
    if (!d.ip) throw new HttpError(400, 'err.noIp');
    if (busy.has(d.id)) return status(d.id);
    busy.add(d.id);
    const at = new Date().toISOString();
    const prev = getStatus.get(d.id);
    try {
      let data = null; let error = '';
      try { data = await readers[kind](d.ip, communities()); } catch (e) { error = ['snmp', 'noIfMib', 'noNasMib'].includes(e.message) ? e.message : 'snmp'; log.debug?.(`SNMP ${d.name}: ${e.message}`); }
      let alerts = prev && prev.kind === kind ? parse(prev.alerts) : {};
      if (data && kind === 'switch') {
        storeMacs(d.id, data, at);
        delete data.macs;
      }
      if (data && kind === 'nas') alerts = await notifyNas(d, alerts, data, at);
      // Serial number, model, firmware from the device itself into the inventory (only empty fields)
      if (data) fillDevice(db, d.id, snmpFacts(kind, data));
      upsert.run({ device_id: d.id, kind, at, ok: data ? 1 : 0, error, data: JSON.stringify(data || {}), alerts: JSON.stringify(alerts) });
      return status(d.id);
    } finally {
      busy.delete(d.id);
    }
  }

  async function pollDue(now = Date.now()) {
    if (!settings.get('snmpdev.enabled') || polling) return 0;
    polling = true;
    try {
      const every = Math.max(5, Number(settings.get('snmpdev.interval')) || 15) * 60 * 1000;
      const due = db.prepare(`SELECT d.id, s.at FROM devices d LEFT JOIN snmp_status s ON s.device_id=d.id
        WHERE d.type IN ('switch','nas') AND d.ip IS NOT NULL AND d.ip<>''`).all().filter((r) => !r.at || now - Date.parse(r.at) >= every);
      for (const r of due.slice(0, 20)) {
        try { await poll(r.id); } catch (e) { log.warn(`SNMP device ${r.id}: ${e.message}`); }
      }
      return due.length;
    } finally { polling = false; }
  }

  return {
    poll,
    pollDue,
    status,
    locate,
    setReaderForTests(kind, fn) { readers[kind] = fn; },
    /** Dashboard: NAS problems that are open right now */
    problems() {
      const out = [];
      for (const row of db.prepare("SELECT s.device_id, s.alerts, d.name FROM snmp_status s JOIN devices d ON d.id=s.device_id WHERE s.kind='nas'").all()) {
        for (const p of Object.values(parse(row.alerts))) out.push({ deviceId: row.device_id, device: row.name, ...p });
      }
      return out.slice(0, 20);
    },
    start() {
      if (timer) return;
      const run = () => pollDue().catch((e) => log.warn(`SNMP check: ${e.message}`));
      timer = setInterval(run, 60 * 1000);
      timer.unref();
      setTimeout(run, 40 * 1000).unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
