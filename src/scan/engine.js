// Runs scans: finds the devices of one or more subnets and checks each one gently.
//
// Finding devices (no root rights, no raw sockets):
// * Local subnets: one NetBIOS status query (UDP 137) per address – a normal Windows network request. To send it,
//   the kernel has to ask for the MAC address (ARP); every device answers ARP, even one with a closed firewall.
//   The kernel's ARP table then lists all devices with their MAC address.
// * Routed subnets (no ARP across routers): ping (if the host allows it) and a TCP connection attempt to a few ports
//   – a reset ("closed") also proves that the device exists.
// Checking each device: a short list of typical ports, reverse DNS, SNMP (read-only), title of the web interface.
// A deep check of one device (by hand) uses a longer port list; Telematik devices always get the gentle list.
import os from 'node:os';
import { parseCidr, hostsOf, cidrContains, localInterfaces, defaultGateways, readArpTable, normalizeMac, MAX_PREFIX_HOSTS } from '../lib/net.js';
import { log } from '../lib/log.js';
import { HttpError } from '../lib/http.js';
import { GENTLE_PORTS, DEEP_PORTS, DISCOVERY_PORTS, WEB_PORTS } from './ports.js';
import { tcpProbe, ping, pingAvailable, netbios, reverseDns, snmpSystem, httpProbe, createRateLimiter, pool } from './probes.js';
import { lookupVendor } from './oui.js';
import { classify, isTelematik } from './classify.js';

export const MAX_TOTAL_HOSTS = 16384;
const MAX_WEB_PROBES = 4;
const ARP_SETTLE_MS = 9000;

/** Checks scan targets: [{ cidr, locationId }] → normalised list or HttpError. */
export function validateTargets(targets) {
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const t of targets) {
    const c = parseCidr(t.cidr);
    if (!c) throw new HttpError(400, 'err.cidr', String(t.cidr).slice(0, 40));
    if (c.hosts > MAX_PREFIX_HOSTS) throw new HttpError(400, 'err.cidrTooLarge', c.cidr);
    if (seen.has(c.cidr)) continue;
    seen.add(c.cidr);
    total += c.hosts;
    out.push({ cidr: c.cidr, locationId: t.locationId || null });
  }
  if (!out.length) throw new HttpError(400, 'err.noTargets');
  if (total > MAX_TOTAL_HOSTS) throw new HttpError(400, 'err.tooManyHosts', String(MAX_TOTAL_HOSTS));
  return out;
}

/** Preferred address of the device's web interface (quick access button) */
export function bestWebUrl(ip, facts = {}, type = '') {
  const open = new Set(facts.ports || []);
  const order = type === 'hypervisor' ? [8006, 443, 80] : type === 'nas' ? [5001, 5000, 443, 80]
    : [443, 80, 8443, 9443, 8080, 5001, 5000, 8006, 8007, 10000, 9090, 8123, 631];
  const port = order.find((p) => open.has(p));
  if (!port) return '';
  const proto = WEB_PORTS.get(port) || 'http';
  const def = (proto === 'https' && port === 443) || (proto === 'http' && port === 80);
  return `${proto}://${ip}${def ? '' : `:${port}`}/`;
}

export function createScanner({ db, settings, inventory }) {
  const running = new Map(); // scanId → progress
  const finishedHooks = [];

  const insertScan = db.prepare('INSERT INTO scans(kind,status,targets,started_at,user) VALUES(?,?,?,?,?)');
  const finishScan = db.prepare('UPDATE scans SET status=?, finished_at=?, stats=?, error=? WHERE id=?');
  const insertResult = db.prepare(`INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status,location_id)
    VALUES(@scan_id,@ip,@mac,@hostname,@vendor,@detected_type,@confidence,@facts,'pending',@location_id)`);

  function communities() {
    const raw = String(settings.get('scan.snmpCommunities') || '');
    const list = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
    return list.length ? list : ['public'];
  }

  /** Everything about one address. `ports` = list to check. */
  async function probeHost(ip, { ports, limiter, mac = null, nb = null, pingRes = null, isGateway = false, isSelf = false, onStop = () => false }) {
    const open = [];
    await pool(ports, 6, async (p) => {
      if (onStop()) return;
      await limiter.take();
      if ((await tcpProbe(ip, p)) === 'open') open.push(p);
    }, onStop);
    open.sort((a, b) => a - b);
    const [rdns, snmpInfo, nbInfo] = await Promise.all([
      reverseDns(ip),
      settings.get('scan.snmp') ? snmpSystem(ip, communities()) : null,
      nb !== null ? nb : netbios(ip),
    ]);
    const http = [];
    if (settings.get('scan.httpTitles')) {
      const web = open.filter((p) => WEB_PORTS.has(p)).slice(0, MAX_WEB_PROBES);
      for (const p of web) {
        if (onStop()) break;
        await limiter.take();
        const r = await httpProbe(ip, p, WEB_PORTS.get(p));
        if (r) { const { body: _b, ...rest } = r; http.push(rest); }
      }
    }
    const macFinal = normalizeMac(mac) || normalizeMac(nbInfo?.mac) || null;
    const v = lookupVendor(macFinal);
    const facts = {
      ports: open,
      ttl: pingRes?.ttl || null,
      netbios: nbInfo && (nbInfo.name || nbInfo.domain) ? { name: nbInfo.name, domain: nbInfo.domain } : null,
      rdns: rdns || '',
      snmp: snmpInfo,
      http,
      vendorFull: v.vendorFull,
      randomMac: v.random,
      isGateway,
      isSelf,
      macSource: mac ? 'arp' : nbInfo?.mac ? 'netbios' : '',
    };
    const c = classify({ ...facts, vendor: v.vendor, mac: macFinal, random: v.random });
    facts.classification = { type: c.type, confidence: c.confidence, reasons: c.reasons, os: c.os, model: c.model };
    return {
      ip, mac: macFinal, vendor: v.vendor, hostname: rdns || nbInfo?.name || snmpInfo?.name || '',
      detected_type: c.type, confidence: c.confidence, facts,
    };
  }

  async function discover(target, ctx) {
    const c = parseCidr(target.cidr);
    const ifaces = localInterfaces();
    // Addresses in a network of this host are reached directly (ARP), all others through a router
    const onLink = (ip) => ifaces.some((i) => cidrContains(i.cidr, ip));
    const found = new Map(); // ip → { pingRes, nb }
    const ips = [...hostsOf(c)];
    const usePing = settings.get('scan.ping') && ctx.ping;
    ctx.progress.phase = 'discover';
    ctx.progress.total += ips.length;
    let onLinkCount = 0;
    let lastPoke = 0;

    await pool(ips, 48, async (ip) => {
      if (ctx.stopped()) return;
      await ctx.limiter.take();
      if (onLink(ip)) { onLinkCount++; lastPoke = Date.now(); }
      const [nb, pr] = await Promise.all([netbios(ip, 1000), usePing ? ping(ip, 1) : null]);
      let alive = !!nb || !!pr?.alive;
      if (!alive && !onLink(ip)) {
        for (const p of DISCOVERY_PORTS) {
          if (ctx.stopped()) break;
          await ctx.limiter.take();
          const s = await tcpProbe(ip, p, 700);
          if (s !== 'filtered') { alive = true; break; }
        }
      }
      if (alive) found.set(ip, { nb, pingRes: pr });
      ctx.progress.done++;
    }, ctx.stopped);

    // Read the ARP table only when the kernel has finished asking: an old ("stale") entry of a device that is gone
    // stays marked as complete until the kernel's re-check fails (about 5 s delay + 3 probes). Waiting until then
    // keeps devices that are switched off out of the result.
    const waitMs = onLinkCount ? Math.max(800, ARP_SETTLE_MS - (Date.now() - lastPoke)) : 0;
    if (waitMs && !ctx.stopped()) await new Promise((r) => setTimeout(r, waitMs));
    const arp = readArpTable();
    const hosts = [];
    for (const ip of ips) {
      const mac = arp.get(ip) || null;
      const f = found.get(ip);
      if (!mac && !f) continue;
      hosts.push({ ip, mac, nb: f?.nb ?? null, pingRes: f?.pingRes ?? null });
    }
    // This server itself is never in its own ARP table
    for (const i of ifaces) {
      if (cidrContains(c, i.address) && !hosts.some((h) => h.ip === i.address)) hosts.push({ ip: i.address, mac: i.mac, nb: null, pingRes: null, isSelf: true });
    }
    for (const h of hosts) if (ifaces.some((i) => i.address === h.ip)) h.isSelf = true;
    return { hosts };
  }

  async function runNetwork(scanId, targets) {
    const ctx = {
      limiter: createRateLimiter(settings.get('scan.rate')),
      progress: running.get(scanId),
      stopped: () => running.get(scanId)?.cancelled,
      ping: await pingAvailable(),
    };
    ctx.progress.pingAvailable = ctx.ping;
    const gateways = new Set(defaultGateways());
    const all = [];
    for (const t of targets) {
      if (ctx.stopped()) break;
      const { hosts } = await discover(t, ctx);
      for (const h of hosts) all.push({ ...h, target: t });
    }
    ctx.progress.phase = 'probe';
    ctx.progress.hosts = all.length;
    await pool(all, 12, async (h) => {
      if (ctx.stopped()) return;
      try {
        const r = await probeHost(h.ip, { ports: GENTLE_PORTS, limiter: ctx.limiter, mac: h.mac, nb: h.nb, pingRes: h.pingRes,
          isGateway: gateways.has(h.ip), isSelf: !!h.isSelf, onStop: ctx.stopped });
        if (r.facts.isSelf) r.hostname = r.hostname || os.hostname();
        const row = { scan_id: scanId, ...r, facts: JSON.stringify(r.facts), location_id: h.target.locationId };
        const id = insertResult.run(row).lastInsertRowid;
        inventory.applyResult(id);
        ctx.progress.probed++;
        ctx.progress.recent.push({ ip: r.ip, type: r.detected_type });
        if (ctx.progress.recent.length > 40) ctx.progress.recent.shift();
      } catch (e) {
        log.warn(`Check of ${h.ip} failed: ${e.message}`);
      }
    }, ctx.stopped);
    return { found: all.length, ping: ctx.ping };
  }

  /**
   * Light scan (nightly): only finds the devices – ARP/NetBIOS/ping, plus the name from DNS. No port checks, no SNMP,
   * no web requests. Known devices get their new IP, unknown ones land in the scan result for the admin.
   */
  async function runLight(scanId, targets) {
    const ctx = {
      limiter: createRateLimiter(Math.min(settings.get('scan.rate'), 40)),
      progress: running.get(scanId),
      stopped: () => running.get(scanId)?.cancelled,
      ping: await pingAvailable(),
    };
    ctx.progress.pingAvailable = ctx.ping;
    const gateways = new Set(defaultGateways());
    const all = [];
    for (const t of targets) {
      if (ctx.stopped()) break;
      const { hosts } = await discover(t, ctx);
      for (const h of hosts) all.push({ ...h, target: t });
    }
    ctx.progress.phase = 'probe';
    ctx.progress.hosts = all.length;
    await pool(all, 16, async (h) => {
      if (ctx.stopped()) return;
      const macFinal = normalizeMac(h.mac) || normalizeMac(h.nb?.mac) || null;
      const v = lookupVendor(macFinal);
      const rdns = await reverseDns(h.ip);
      const facts = { light: true, vendorFull: v.vendorFull, randomMac: v.random, isGateway: gateways.has(h.ip), isSelf: !!h.isSelf,
        macSource: h.mac ? 'arp' : h.nb?.mac ? 'netbios' : '', ttl: h.pingRes?.ttl || null };
      if (h.nb && (h.nb.name || h.nb.domain)) facts.netbios = { name: h.nb.name, domain: h.nb.domain };
      const c = classify({ ports: [], http: [], ...facts, rdns, vendor: v.vendor, mac: macFinal, random: v.random });
      facts.classification = { type: c.type, confidence: c.confidence, reasons: c.reasons, os: c.os, model: c.model };
      const hostname = rdns || h.nb?.name || (h.isSelf ? os.hostname() : '');
      const row = { scan_id: scanId, ip: h.ip, mac: macFinal, vendor: v.vendor, hostname, detected_type: c.type, confidence: c.confidence,
        facts: JSON.stringify(facts), location_id: h.target.locationId };
      try {
        inventory.applyResult(insertResult.run(row).lastInsertRowid);
      } catch (e) { log.warn(`Light scan: ${h.ip} failed: ${e.message}`); }
      ctx.progress.probed++;
      ctx.progress.recent.push({ ip: h.ip, type: c.type });
      if (ctx.progress.recent.length > 40) ctx.progress.recent.shift();
    }, ctx.stopped);
    return { found: all.length, ping: ctx.ping };
  }

  async function runDeep(scanId, device) {
    const facts = JSON.parse(device.facts || '{}');
    const telematik = isTelematik(device.type) || isTelematik(facts.classification?.type);
    const progress = running.get(scanId);
    progress.phase = 'probe';
    progress.total = 1;
    progress.hosts = 1;
    const limiter = createRateLimiter(telematik ? 5 : Math.min(settings.get('scan.rate'), 25));
    const pr = settings.get('scan.ping') && (await pingAvailable()) ? await ping(device.ip, 1) : null;
    const r = await probeHost(device.ip, { ports: telematik ? [...GENTLE_PORTS] : DEEP_PORTS, limiter, mac: device.mac || readArpTable().get(device.ip) || null,
      pingRes: pr, isGateway: defaultGateways().includes(device.ip), onStop: () => progress.cancelled });
    r.facts.deep = { at: new Date().toISOString(), gentle: telematik };
    const id = insertResult.run({ scan_id: scanId, ...r, facts: JSON.stringify(r.facts), location_id: device.location_id }).lastInsertRowid;
    inventory.applyResult(id, { deep: true });
    progress.done = 1; progress.probed = 1;
    return { found: 1, telematikGentle: telematik };
  }

  function launch(kind, targets, user, job) {
    if ([...running.values()].some((p) => !p.finished)) throw new HttpError(409, 'err.scanRunning');
    const id = Number(insertScan.run(kind, 'running', JSON.stringify(targets), new Date().toISOString(), user || '').lastInsertRowid);
    running.set(id, { id, kind, phase: 'start', total: 0, done: 0, hosts: 0, probed: 0, recent: [], cancelled: false, finished: false, startedAt: Date.now() });
    (async () => {
      let status = 'done'; let error = null; let stats = {};
      try {
        stats = await job(id);
        if (running.get(id).cancelled) status = 'cancelled';
      } catch (e) {
        status = 'failed'; error = e.message;
        log.error(`Scan ${id} failed: ${e.stack || e.message}`);
      }
      const p = running.get(id);
      stats = { ...stats, probed: p.probed, durationMs: Date.now() - p.startedAt };
      finishScan.run(status, new Date().toISOString(), JSON.stringify(stats), error, id);
      inventory.finishScan(id);
      p.finished = true; p.phase = status;
      for (const fn of finishedHooks) {
        try { await fn({ id, kind, status }); } catch (e) { log.warn(`After scan ${id}: ${e.message}`); }
      }
      log.info(`Scan ${id} (${kind}) ${status}: ${p.probed} device(s) in ${Math.round(stats.durationMs / 1000)} s`);
      setTimeout(() => running.delete(id), 10 * 60 * 1000).unref();
      pruneOld();
    })();
    return id;
  }

  function pruneOld() {
    const keep = Math.max(3, Math.min(500, Number(settings.get('scan.keepScans')) || 20));
    db.prepare(`DELETE FROM scans WHERE kind='network' AND status<>'running' AND id NOT IN (SELECT id FROM scans WHERE kind='network' ORDER BY id DESC LIMIT ?)`).run(keep);
    db.prepare(`DELETE FROM scans WHERE kind='light' AND status<>'running' AND id NOT IN (SELECT id FROM scans WHERE kind='light' ORDER BY id DESC LIMIT 14)`).run();
    db.prepare(`DELETE FROM scans WHERE kind='deep' AND status<>'running' AND id NOT IN (SELECT id FROM scans WHERE kind='deep' ORDER BY id DESC LIMIT 50)`).run();
  }

  return {
    startNetwork(targets, user) {
      const list = validateTargets(targets);
      return launch('network', list, user, (id) => runNetwork(id, list));
    },
    startLight(targets, user) {
      const list = validateTargets(targets);
      return launch('light', list, user, (id) => runLight(id, list));
    },
    /** fn({ id, kind, status }) runs after every scan */
    onFinished(fn) { finishedHooks.push(fn); },
    startDeep(device, user) {
      if (!device.ip) throw new HttpError(400, 'err.noIp');
      return launch('deep', [{ cidr: `${device.ip}/32`, deviceId: device.id }], user, (id) => runDeep(id, device));
    },
    progress(id) {
      const p = running.get(Number(id));
      return p ? { phase: p.phase, total: p.total, done: p.done, hosts: p.hosts, probed: p.probed, recent: p.recent.slice(-20),
        finished: p.finished, pingAvailable: p.pingAvailable } : null;
    },
    cancel(id) {
      const p = running.get(Number(id));
      if (!p || p.finished) return false;
      p.cancelled = true;
      return true;
    },
    isRunning: () => [...running.values()].some((p) => !p.finished),
    /** On start: scans left "running" by a restart are marked as interrupted */
    recover() {
      db.prepare("UPDATE scans SET status='failed', error='interrupted (restart)', finished_at=? WHERE status='running'").run(new Date().toISOString());
    },
  };
}
