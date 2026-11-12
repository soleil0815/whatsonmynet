// Network map: which device hangs at which switch port, and how the switches are connected.
//
// Sources: the MAC tables of the switches (switch_macs) and their LLDP neighbours (snmp_status). A device belongs to
// the port with the fewest addresses that saw its MAC (an uplink sees many devices, the device's own port only a
// few). Switches are linked the same way (switch B's MAC on a port of switch A) or by LLDP (neighbour name = name or
// host name of another switch).
const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };
const short = (s) => String(s || '').toLowerCase().split('.')[0].trim();

export function buildTopology(db, { allowed = null } = {}) {
  const devices = db.prepare('SELECT id, name, type, ip, mac, hostname, location_id FROM devices').all()
    .filter((d) => !allowed || allowed.has(d.location_id));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const switches = devices.filter((d) => d.type === 'switch');
  const switchIds = new Set(switches.map((s) => s.id));
  const status = new Map(db.prepare("SELECT device_id, data, ok, at FROM snmp_status WHERE kind='switch'").all().map((r) => [r.device_id, { ...parse(r.data), ok: !!r.ok, at: r.at }]));

  // Port of every MAC: fewest addresses wins
  const rows = db.prepare('SELECT switch_id, mac, if_index, port FROM switch_macs').all().filter((r) => switchIds.has(r.switch_id));
  const count = new Map();
  for (const r of rows) count.set(`${r.switch_id}|${r.if_index}`, (count.get(`${r.switch_id}|${r.if_index}`) || 0) + 1);
  const best = new Map();
  for (const r of rows) {
    const n = count.get(`${r.switch_id}|${r.if_index}`);
    const cur = best.get(r.mac);
    if (!cur || n < cur.n) best.set(r.mac, { switchId: r.switch_id, ifIndex: r.if_index, port: r.port, n });
  }

  const links = [];        // switch ↔ switch
  const attached = new Map(); // switchId → [{ port, ifIndex, devices: [] }]
  const placed = new Set();
  const add = (sid, port, ifIndex, deviceId) => {
    if (!attached.has(sid)) attached.set(sid, new Map());
    const m = attached.get(sid);
    if (!m.has(ifIndex)) m.set(ifIndex, { port, ifIndex, devices: [] });
    m.get(ifIndex).devices.push(deviceId);
  };
  const linked = new Map();
  // The same link is usually seen from both sides (A sees B's MAC, B sees A's MAC): the second sighting adds its port
  const link = (a, aPort, b, bPort, kind) => {
    if (a === b) return;
    const key = [a, b].sort().join('|');
    const l = linked.get(key);
    if (!l) { const n = { from: a, fromPort: aPort || '', to: b, toPort: bPort || '', kind }; linked.set(key, n); links.push(n); return; }
    const portAt = (sw, port) => { if (!port) return; if (l.from === sw && !l.fromPort) l.fromPort = port; if (l.to === sw && !l.toPort) l.toPort = port; };
    portAt(a, aPort); portAt(b, bPort);
  };

  // LLDP: neighbour names → switches (also routers/APs if their name matches)
  const byName = new Map();
  for (const d of devices) for (const n of [d.name, d.hostname]) if (n) byName.set(short(n), d);
  for (const s of switches) {
    for (const nb of status.get(s.id)?.neighbours || []) {
      const other = byName.get(short(nb.name));
      if (!other || other.id === s.id) continue;
      if (switchIds.has(other.id)) link(s.id, nb.localPort, other.id, nb.port, 'lldp');
      else { add(s.id, nb.localPort, `lldp:${nb.localNum}`, other.id); placed.add(other.id); }
    }
  }
  // MAC tables
  for (const d of devices) {
    if (!d.mac || placed.has(d.id)) continue;
    const b = best.get(d.mac);
    if (!b || b.switchId === d.id) continue;
    if (switchIds.has(d.id)) link(b.switchId, b.port, d.id, '', 'mac');
    else { add(b.switchId, b.port, b.ifIndex, d.id); placed.add(d.id); }
  }

  // Tree: root = switch with a router/firewall directly attached, else the one with most switch links
  const adj = new Map(switches.map((s) => [s.id, []]));
  for (const l of links) { adj.get(l.from)?.push({ id: l.to, port: l.fromPort, remote: l.toPort, kind: l.kind }); adj.get(l.to)?.push({ id: l.from, port: l.toPort, remote: l.fromPort, kind: l.kind }); }
  const hasRouter = (sid) => [...(attached.get(sid)?.values() || [])].some((p) => p.devices.some((id) => ['router', 'firewall'].includes(byId.get(id)?.type)));
  const order = [...switches].sort((a, b) => (hasRouter(b.id) - hasRouter(a.id)) || (adj.get(b.id).length - adj.get(a.id).length) || a.name.localeCompare(b.name));
  const seen = new Set();
  const node = (sid, via = null) => {
    seen.add(sid);
    const st = status.get(sid);
    const s = byId.get(sid);
    const ports = [...(attached.get(sid)?.values() || [])]
      .map((p) => ({ port: p.port, devices: p.devices.map((id) => { const d = byId.get(id); return { id, name: d.name, type: d.type, ip: d.ip }; }) }))
      .sort((a, b) => String(a.port).localeCompare(String(b.port), undefined, { numeric: true }));
    const children = [];
    for (const n of adj.get(sid)) if (!seen.has(n.id)) { seen.add(n.id); children.push({ port: n.port, remote: n.remote, kind: n.kind, id: n.id }); }
    return {
      id: sid, name: s.name, ip: s.ip, via,
      snmp: st ? { ok: st.ok, at: st.at, portsUp: (st.ports || []).filter((p) => p.status === 'up').length, ports: (st.ports || []).length } : null,
      ports,
      children: children.map((c) => node(c.id, { port: c.port, remote: c.remote, kind: c.kind })),
    };
  };
  const roots = [];
  for (const s of order) if (!seen.has(s.id)) roots.push(node(s.id));

  return {
    roots,
    unplaced: devices.filter((d) => !placed.has(d.id) && !switchIds.has(d.id)).map((d) => ({ id: d.id, name: d.name, type: d.type, ip: d.ip, mac: d.mac }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    stats: { switches: switches.length, withData: switches.filter((s) => status.get(s.id)?.ports).length, placed: placed.size, links: links.length },
  };
}
