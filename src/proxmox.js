// Proxmox VE and Proxmox Backup Server via their REST API - nothing is installed there. An API token with read-only
// rights is enough (PVE: role PVEAuditor; PBS: role Audit/DatastoreAudit). The token secret is stored encrypted.
//
// PVE: nodes (online, CPU, RAM), storages (usage), VMs/containers (running/stopped), backup jobs (vzdump tasks).
// PBS: datastores (usage), backup groups (age of the last backup), failed tasks.
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import { HttpError, line, str } from './lib/http.js';
import { encrypt, decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';
import { fetchTlsChain, describe, publiclyTrusted, toPem } from './auth/dccert.js';
import { NET_KINDS, NET_READERS } from './netctl.js';
import { fillDevice } from './devicefill.js';
import { serverBase, hostTempsByName } from './hosts.js';
import { readRedfish, redfishMetrics, labelSerial } from './redfish.js';
import { READERS, API_KINDS, PUSH_KINDS, newPushToken, pushTokenOk, cleanPush, mergePush, markStale, pushScript } from './virt.js';

/** Every kind of host on the page: Proxmox, hypervisors asked through their API, hypervisors that send on their own */
export const HOST_KINDS = ['pve', 'pbs', ...API_KINDS, ...PUSH_KINDS, ...NET_KINDS, 'redfish'];
// Asked with user and password (everything but Proxmox and the hosts that send on their own)
const ACCOUNT_KINDS = [...API_KINDS, ...NET_KINDS, 'redfish'];

const URL_RE = /^https:\/\/[a-z0-9.\-[\]:]+(:\d{1,5})?$/i;
const PVE_TOKEN = /^[\w.@-]+![\w.-]+$/;   // user@realm!tokenid
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : null);

/** Fingerprints of a certificate chain as Node reports it (leaf → issuer → …) */
function chainFingerprints(cert) {
  const out = [];
  for (let c = cert, i = 0; c && i < 10; i++) {
    if (c.fingerprint256) out.push(c.fingerprint256);
    if (!c.issuerCertificate || c.issuerCertificate === c) break;
    c = c.issuerCertificate;
  }
  return out;
}

/** TLS options for a host: the pasted certificate pinned (name does not matter then), else the normal check or none */
export function tlsOptions(host) {
  if (host.ca) {
    const x = new crypto.X509Certificate(host.ca);
    const pinned = x.fingerprint256;
    // allowPartialTrustChain: the pinned certificate may also be the server's own (not only a CA).
    // The server's own certificate pinned: the name does not matter. A CA pinned (fetched from a server with a company
    // CA): the name must still fit - otherwise any certificate of that CA (a printer's) would pass as this host.
    return { ca: [host.ca], allowPartialTrustChain: true, checkServerIdentity: (name, cert) => {
      if (!chainFingerprints(cert).includes(pinned)) return new Error('certificate is not the pasted one');
      return x.ca && cert.fingerprint256 !== pinned ? tls.checkServerIdentity(name, cert) : undefined;
    } };
  }
  return { rejectUnauthorized: !!host.verify };
}

/** Network and TLS errors in words that say what to do */
export function netError(e) {
  return new Error({ DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate - Edit → Fetch certificate',
    SELF_SIGNED_CERT_IN_CHAIN: 'certificate of an unknown CA - Edit → Fetch certificate', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate cannot be verified - Edit → Fetch certificate',
    ECONNREFUSED: 'connection refused', ENOTFOUND: 'name not found (DNS)', EHOSTUNREACH: 'host unreachable', ECONNRESET: 'connection reset' }[e.code]
    || (/not the pasted one/.test(e.message) ? 'certificate changed - fetch it again (Edit → Fetch certificate)' : e.message));
}

/**
 * One HTTPS request to a hypervisor (Proxmox, vCenter, XCP-ng, Nutanix, oVirt) with the TLS rules of the host.
 * Resolves { status, headers, text } for every answer; rejects only on network/TLS errors.
 */
export function tlsRequest(host, method, path, { body = null, headers = {}, timeoutMs = 15000, maxBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, host.url);
    const data = body === null ? null : Buffer.from(body);
    // timeout = silence on the socket; the whole request gets a deadline too (an answer trickling in byte by byte
    // would otherwise hold the polling of all hosts)
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs * 4);
    const req = https.request(u, { method, timeout: timeoutMs, agent: false, headers: { ...(data ? { 'Content-Length': data.length } : {}), ...headers }, ...tlsOptions(host) }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size < maxBytes) chunks.push(d); else res.destroy(new Error('answer too large')); });
      res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', (e) => { clearTimeout(deadline); reject(netError(e)); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { clearTimeout(deadline); reject(netError(e)); });
    req.end(data || undefined);
  });
}

/** GET on the Proxmox API (token in the header) */
export async function apiGet(host, path, timeoutMs = 15000) {
  const auth = host.kind === 'pbs' ? `PBSAPIToken=${host.token_id}:${host.secretPlain}` : `PVEAPIToken=${host.token_id}=${host.secretPlain}`;
  const res = await tlsRequest(host, 'GET', `/api2/json${path}`, { headers: { Authorization: auth, Accept: 'application/json' }, timeoutMs, maxBytes: 8 * 1024 * 1024 });
  if (res.status === 401) throw Object.assign(new Error('sign-in refused (401) - token ID or secret wrong'), { status: 401 });
  if (res.status === 403) throw Object.assign(new Error('access denied (403) - the token lacks the role PVEAuditor/Audit'), { status: 403 });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return parse(res.text, null)?.data;
}

/** Reads a PVE cluster/node */
// Read rights a monitoring token needs (roles PVEAuditor / Audit). Proxmox does not refuse a token without them - it
// just shows almost nothing (nodes without values, no VMs, no storage) - so the missing ones are named in the interface.
const NEEDED = { pve: ['Sys.Audit', 'VM.Audit', 'Datastore.Audit'], pbs: ['Sys.Audit', 'Datastore.Audit'] };

/** Effective rights of the token (GET /access/permissions) → missing ones, or null if they cannot be read */
export async function missingRights(host, kind) {
  try {
    const perms = await apiGet(host, '/access/permissions');
    const have = new Set();
    for (const privs of Object.values(perms || {})) for (const [k, v] of Object.entries(privs || {})) if (v) have.add(k);
    return NEEDED[kind].filter((p) => !have.has(p));
  } catch {
    return null;
  }
}

export async function readPve(host) {
  const res = await apiGet(host, '/cluster/resources');
  const nodes = []; const storages = []; const guests = [];
  for (const r of res || []) {
    if (r.type === 'node') nodes.push({ name: r.node, online: r.status === 'online', cpu: typeof r.cpu === 'number' ? Math.round(r.cpu * 100) : null, mem: pct(r.mem, r.maxmem), memUsed: r.mem || 0, memTotal: r.maxmem || 0, disk: pct(r.disk, r.maxdisk), uptime: r.uptime || 0 });
    else if (r.type === 'storage') storages.push({ name: r.storage, node: r.node, active: r.status === 'available', used: r.disk || 0, total: r.maxdisk || 0, pct: pct(r.disk, r.maxdisk) });
    else if (r.type === 'qemu' || r.type === 'lxc') guests.push({ vmid: r.vmid, name: r.name || String(r.vmid), kind: r.type, node: r.node, status: r.status, template: !!r.template, cpu: Math.round((r.cpu || 0) * 100), mem: pct(r.mem, r.maxmem) });
  }
  // Backups: vzdump tasks of the last 8 days per node
  const backups = [];
  const since = Math.floor(Date.now() / 1000) - 8 * 86400;
  for (const n of nodes.filter((x) => x.online)) {
    try {
      const tasks = await apiGet(host, `/nodes/${encodeURIComponent(n.name)}/tasks?typefilter=vzdump&limit=200&since=${since}`);
      for (const t of tasks || []) backups.push({ node: n.name, vmid: t.id || '', start: t.starttime, end: t.endtime || null, ok: t.status === 'OK', status: t.status || 'running' });
    } catch (e) { log.debug(`Proxmox ${host.name}: tasks of ${n.name}: ${e.message}`); }
  }
  backups.sort((a, b) => b.start - a.start);
  return { kind: 'pve', missing: await missingRights(host, 'pve'), nodes, storages: storages.sort((a, b) => a.name.localeCompare(b.name)), guests: guests.filter((g) => !g.template).sort((a, b) => a.vmid - b.vmid), backups: backups.slice(0, 100) };
}

/** Reads a Proxmox Backup Server */
export async function readPbs(host) {
  const usage = await apiGet(host, '/status/datastore-usage');
  const datastores = (usage || []).map((d) => ({ name: d.store, used: d.used || 0, total: d.total || 0, pct: pct(d.used, d.total), gc: d['gc-status']?.['upid'] ? true : undefined }));
  const groups = [];
  for (const d of datastores) {
    try {
      for (const g of await apiGet(host, `/admin/datastore/${encodeURIComponent(d.name)}/groups`) || []) {
        groups.push({ store: d.name, type: g['backup-type'], id: String(g['backup-id']), last: g['last-backup'] || null, count: g['backup-count'] || 0, comment: g.comment || '' });
      }
    } catch (e) { log.debug(`PBS ${host.name}: groups of ${d.name}: ${e.message}`); }
  }
  let failed = [];
  try {
    const since = Math.floor(Date.now() / 1000) - 86400;
    failed = ((await apiGet(host, `/nodes/localhost/tasks?errors=true&limit=100&since=${since}`)) || [])
      .filter((t) => t.status && t.status !== 'OK').map((t) => ({ type: t.worker_type, id: t.worker_id || '', start: t.starttime, status: String(t.status).slice(0, 200) }));
  } catch (e) { log.debug(`PBS ${host.name}: tasks: ${e.message}`); }
  return { kind: 'pbs', missing: await missingRights(host, 'pbs'), datastores, groups: groups.sort((a, b) => `${a.store}/${a.type}/${a.id}`.localeCompare(`${b.store}/${b.type}/${b.id}`, undefined, { numeric: true })), failed };
}

/** Everything a Proxmox sensor can watch: [{ metric, key, name, value, unit, kind, op, threshold }] */
export function proxmoxMetrics(data) {
  const out = [];
  if (!data) return out;
  // Server hardware through its management chip (iDRAC, iLO, XClarity …)
  if (data.kind === 'redfish') return redfishMetrics(data);
  if (data.netdevices) {
    // Network controller: per device online, clients, load; all clients together
    for (const x of data.netdevices) {
      const name = x.name || x.mac;
      out.push({ metric: 'netOnline', key: x.mac, name, value: x.online ? 'online' : 'offline', kind: 'state', uptime: x.uptime, cpu: x.cpu, mem: x.mem });
      if (x.clients !== null && x.clients !== undefined) out.push({ metric: 'netClients', key: x.mac, name, value: x.clients, unit: '', kind: 'number', op: 'ge', threshold: 60 });
      if (x.cpu !== null && x.cpu !== undefined) out.push({ metric: 'netCpu', key: x.mac, name, value: x.cpu, unit: '%', kind: 'number', op: 'ge', threshold: 90 });
      if (x.mem !== null && x.mem !== undefined) out.push({ metric: 'netMem', key: x.mac, name, value: x.mem, unit: '%', kind: 'number', op: 'ge', threshold: 90 });
    }
    if (data.kind !== 'mikrotik') out.push({ metric: 'clientsTotal', key: '', name: '', value: data.clients ?? 0, unit: '', kind: 'number', op: 'lt', threshold: 1 });
    out.push({ metric: 'netUpdates', key: '', name: '', value: data.netdevices.filter((x) => x.update).length, unit: '', kind: 'number', op: 'gt', threshold: 0 });
    return out;
  }
  if (data.kind !== 'pbs') {
    for (const n of data.nodes || []) {
      out.push({ metric: 'nodeOnline', key: n.name, name: n.name, value: n.online ? 'online' : 'offline', kind: 'state', uptime: n.uptime || 0, cpu: n.cpu, mem: n.mem });
      out.push({ metric: 'nodeCpu', key: n.name, name: n.name, value: n.cpu, unit: '%', kind: 'number', op: 'ge', threshold: 90 });
      out.push({ metric: 'nodeMem', key: n.name, name: n.name, value: n.mem, unit: '%', kind: 'number', op: 'ge', threshold: 90, used: n.memUsed, total: n.memTotal });
    }
    for (const s of data.storages || []) out.push({ metric: 'storage', key: `${s.node}/${s.name}`, name: `${s.name} (${s.node})`, value: s.pct, unit: '%', kind: 'number', op: 'ge', threshold: 85, used: s.used, total: s.total });
    for (const g of data.guests || []) {
      out.push({ metric: 'guestRunning', key: String(g.vmid), name: `${g.vmid} ${g.name}`, value: g.status, kind: 'state', node: g.node, cpu: g.cpu, mem: g.mem });
      if (data.kind === 'pve') out.push({ metric: 'backupAge', key: String(g.vmid), name: `${g.vmid} ${g.name}`, value: backupAgeHours(data, g.vmid), unit: 'h', kind: 'number', op: 'gt', threshold: 26 });
    }
    if (data.kind === 'pve') out.push({ metric: 'backupFailed', key: '', name: '', value: (data.backups || []).filter((b) => !b.ok && b.end && Date.now() / 1000 - b.start < 86400).length, kind: 'number', op: 'gt', threshold: 0 });
  } else {
    for (const d of data.datastores || []) out.push({ metric: 'datastore', key: d.name, name: d.name, value: d.pct, unit: '%', kind: 'number', op: 'ge', threshold: 85, used: d.used, total: d.total });
    for (const g of data.groups || []) {
      out.push({ metric: 'groupAge', key: `${g.store}/${g.type}/${g.id}`, name: `${g.type}/${g.id}${g.comment ? ` (${g.comment})` : ''} - ${g.store}`,
        value: g.last ? Math.round((Date.now() / 1000 - g.last) / 3600) : null, unit: 'h', kind: 'number', op: 'gt', threshold: 26 });
    }
    out.push({ metric: 'tasksFailed', key: '', name: '', value: (data.failed || []).length, kind: 'number', op: 'gt', threshold: 0 });
  }
  return out;
}

/** Hours since the last successful backup of a guest (vzdump task with its vmid), null if none in 8 days */
export function backupAgeHours(data, vmid) {
  const b = (data.backups || []).find((x) => x.ok && String(x.vmid) === String(vmid));
  return b ? Math.round((Date.now() / 1000 - (b.end || b.start)) / 3600) : null;
}

export function createProxmox({ db, settings }) {
  let timer = null;
  let polling = false;
  const rowOf = (id) => db.prepare('SELECT * FROM proxmox_hosts WHERE id=?').get(id);
  const withSecret = (h) => { let s = ''; try { s = h.secret ? decrypt(h.secret) : ''; } catch { s = ''; } return { ...h, secretPlain: s }; };
  const caInfo = (pem) => { try { return pem ? describe(new crypto.X509Certificate(pem)) : null; } catch { return null; } };
  // Nodes that also run the Linux script get its hottest temperature (Proxmox itself gives none)
  const withTemps = (data) => {
    if (!Array.isArray(data?.nodes) || !data.nodes.length) return data;
    const temps = hostTempsByName(db);
    if (!temps.size) return data;
    return { ...data, nodes: data.nodes.map((n) => { const x = temps.get(String(n.name || '').toLowerCase().split('.')[0]); return x && !x.stale ? { ...n, temp: x } : n; }) };
  };
  const shape = (h) => (h ? { id: h.id, name: h.name, kind: h.kind, url: h.url, token_id: h.token_id, has_secret: !!h.secret, verify: !!h.verify, ca: h.ca, ca_info: caInfo(h.ca),
    created_at: h.created_at, last_at: h.last_at, last_ok: !!h.last_ok, last_error: h.last_error, data: withTemps(parse(h.data, {})) } : null);

  const hostPort = (u) => { try { const x = new URL(u); return `${x.hostname.toLowerCase()}:${x.port || (x.protocol === 'http:' ? 80 : 443)}`; } catch { return String(u); } };
  function clean(input, old = null) {
    const name = line(input.name, 80);
    if (!name) throw new HttpError(400, 'err.nameRequired');
    const kind = old ? old.kind : HOST_KINDS.includes(input.kind) ? input.kind : 'pve';
    // Hyper-V, KVM: the host sends - no address, no account; the token is made on creating
    if (PUSH_KINDS.includes(kind)) return { name, kind, url: '', token_id: '', secret: old?.secret || '', verify: 1, ca: '' };
    const url = line(input.url, 300).replace(/\/+$/, '');
    if (!URL_RE.test(url)) throw new HttpError(400, 'err.proxmoxUrl');
    const tokenId = line(input.token_id, 200);
    // Proxmox: token ID user@realm!name; other hypervisors: the user name of a read-only account (DOMAIN\\user, user@domain …)
    if (ACCOUNT_KINDS.includes(kind) ? !tokenId || /[\x00-\x1f]/.test(tokenId) : !PVE_TOKEN.test(tokenId)) throw new HttpError(400, ACCOUNT_KINDS.includes(kind) ? 'err.virtUser' : 'err.proxmoxToken');
    const ca = str(input.ca, 20000).trim();
    if (ca) { try { new crypto.X509Certificate(ca); } catch { throw new HttpError(400, 'err.adCa'); } }
    let secret = old?.secret || '';
    if (typeof input.secret === 'string' && input.secret.trim()) secret = encrypt(input.secret.trim().slice(0, 200));
    // The stored token or password only goes to the address it was entered for (see keepSecret in monitor/index.js)
    else if (secret && old && hostPort(old.url) !== hostPort(url)) throw new HttpError(400, 'err.passwordAgain');
    if (!secret) throw new HttpError(400, ACCOUNT_KINDS.includes(kind) ? 'err.virtUser' : 'err.proxmoxToken');
    return { name, kind, url, token_id: tokenId, secret, verify: input.verify === false ? 0 : 1, ca };
  }

  async function poll(id) {
    const h = rowOf(id);
    if (!h) throw new HttpError(404, 'err.notFound');
    const at = new Date().toISOString();
    // A host that sends on its own is not asked: only check whether its nodes still report
    if (PUSH_KINDS.includes(h.kind)) return checkPush(h);
    try {
      const data = h.kind === 'pbs' ? await readPbs(withSecret(h)) : h.kind === 'redfish' ? await readRedfish(withSecret(h)) : NET_READERS[h.kind] ? await NET_READERS[h.kind](withSecret(h))
        : READERS[h.kind] ? await READERS[h.kind](withSecret(h)) : await readPve(withSecret(h));
      if (data.netdevices) syncNetDevices(data);
      if (data.kind === 'redfish') syncRedfish(data);
      db.prepare("UPDATE proxmox_hosts SET last_at=?, last_ok=1, last_error='', data=? WHERE id=?").run(at, JSON.stringify(data), id);
    } catch (e) {
      db.prepare('UPDATE proxmox_hosts SET last_at=?, last_ok=0, last_error=? WHERE id=?').run(at, String(e.message).slice(0, 300), id);
    }
    return shape(rowOf(id));
  }

  /**
   * Devices of a network controller → inventory (by MAC): model, serial number, firmware, manufacturer and type from
   * the controller - the same rules as for SNMP (empty or still as reported → filled/kept current; exchanged → new).
   * Marks each controller device with its inventory id, so the page shows what is not in the inventory yet.
   */
  function syncNetDevices(data) {
    const vendor = { unifi: 'Ubiquiti', omada: 'TP-Link', mikrotik: 'MikroTik' }[data.kind];
    for (const x of data.netdevices) {
      const dev = x.mac ? db.prepare('SELECT id FROM devices WHERE mac=?').get(x.mac) : null;
      x.deviceId = dev?.id || null;
      if (dev) fillDevice(db, dev.id, { serial: x.serial, model: x.model, os: x.firmware, vendor, type: x.type }, 'controller');
    }
  }

  /**
   * The server behind a management chip → its inventory entry: found by the MAC addresses of its network cards (as the
   * scan saw them) or by its serial number; manufacturer, model and serial number by the usual rules.
   */
  function syncRedfish(data) {
    const serial = labelSerial(data);
    let dev = null;
    for (const mac of data.macs || []) { dev = db.prepare('SELECT id FROM devices WHERE mac=?').get(mac); if (dev) break; }
    if (!dev && serial) dev = db.prepare('SELECT id FROM devices WHERE serial=? COLLATE NOCASE').get(serial);
    data.deviceId = dev?.id || null;
    if (dev) fillDevice(db, dev.id, { serial, model: data.model, vendor: data.vendor, type: 'server' }, 'redfish');
  }

  /** The hardware of the server of a device, when a management chip reports it */
  function hardwareOf(deviceId) {
    const h = db.prepare("SELECT id, name, url, last_at, last_ok, last_error, data FROM proxmox_hosts WHERE kind='redfish' AND json_extract(data, '$.deviceId')=?").get(deviceId);
    return h ? { id: h.id, name: h.name, url: h.url, last_at: h.last_at, last_ok: !!h.last_ok, last_error: h.last_error, data: parse(h.data, {}) } : null;
  }

  /** Push hosts: nodes silent for 15 minutes count as offline; without any node that reports the host has an error */
  function checkPush(h) {
    const data = markStale(parse(h.data, {}), 15);
    const live = (data.nodes || []).filter((n) => !n.stale);
    const ok = live.length > 0;
    const error = ok ? '' : (data.nodes || []).length ? 'no data from the host script for more than 15 minutes - is the scheduled task running?' : 'waiting for the first data from the host script';
    db.prepare('UPDATE proxmox_hosts SET last_ok=?, last_error=?, data=? WHERE id=?').run(ok ? 1 : 0, error, JSON.stringify(data), h.id);
    return shape(rowOf(h.id));
  }

  /** Data a host script sends (Bearer token of this host) */
  function push(id, token, body) {
    const h = rowOf(id);
    if (!h || !PUSH_KINDS.includes(h.kind) || !pushTokenOk(h.secret, token)) throw new HttpError(401, 'err.unauthorized');
    let incoming;
    try { incoming = cleanPush(body); } catch (e) { throw new HttpError(400, 'err.badRequest', e.message); }
    const at = new Date().toISOString();
    const data = mergePush(h.kind, parse(h.data, {}), incoming, at);
    db.prepare("UPDATE proxmox_hosts SET last_at=?, last_ok=1, last_error='', data=? WHERE id=?").run(at, JSON.stringify(data), id);
    return { ok: true, nodes: incoming.nodes.length, guests: incoming.guests.length };
  }

  /** New token for a push host and the script with it (the token is shown only now) */
  function newToken(id, { server, pin }) {
    const h = rowOf(id);
    if (!h || !PUSH_KINDS.includes(h.kind)) throw new HttpError(404, 'err.notFound');
    const base = serverBase(server);
    const t = newPushToken();
    db.prepare('UPDATE proxmox_hosts SET secret=? WHERE id=?').run(t.stored, id);
    return { token: t.token, ...pushScript(h.kind, { server: base, id, token: t.token, pin }) };
  }

  async function pollAll() {
    if (polling) return;
    polling = true;
    try {
      const every = Math.max(1, Number(settings.get('proxmox.interval')) || 5) * 60 * 1000;
      for (const h of db.prepare('SELECT id, kind, last_at FROM proxmox_hosts').all()) {
        // A negative age means the clock was set back: then it is due, not hours later
        const age = h.last_at ? Date.now() - Date.parse(h.last_at) : Infinity;
        if (!PUSH_KINDS.includes(h.kind) && age >= 0 && age < every) continue;
        await poll(h.id).catch((e) => log.warn(`Proxmox ${h.id}: ${e.message}`));
      }
    } finally { polling = false; }
  }

  /**
   * Certificate of the server for the admin to confirm: { certs, publicTrust, pem }. pem is what gets pinned - the
   * top of the chain the server sends (its own CA if it sends it, otherwise its own certificate); '' if a public CA
   * (e.g. Let's Encrypt via ACME) vouches for it anyway.
   */
  async function fetchCert(rawUrl) {
    const url = line(rawUrl, 300).replace(/\/+$/, '');
    if (!URL_RE.test(url)) throw new HttpError(400, 'err.proxmoxUrl');
    const u = new URL(url);
    let got;
    try {
      got = await fetchTlsChain({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 443 });
    } catch (e) {
      if (e.code) throw new HttpError(400, 'err.proxmoxUrl');
      throw new HttpError(502, 'err.proxmoxFetch', e.message.slice(0, 200));
    }
    const publicTrust = publiclyTrusted(got.certs);
    const top = got.certs[got.certs.length - 1];
    return { certs: got.certs.map((c, i) => describe(c, { role: i === 0 && !c.ca ? 'server' : null })), publicTrust, pem: publicTrust ? '' : toPem([top]) };
  }

  return {
    fetchCert, hardwareOf,
    list: () => db.prepare('SELECT * FROM proxmox_hosts ORDER BY name').all().map(shape),
    get: (id) => shape(rowOf(id)),
    create(input) {
      const v = clean(input);
      const id = db.prepare('INSERT INTO proxmox_hosts(name,kind,url,token_id,secret,verify,ca,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(v.name, v.kind, v.url, v.token_id, v.secret, v.verify, v.ca, new Date().toISOString()).lastInsertRowid;
      return shape(rowOf(id));
    },
    update(id, input) {
      const old = rowOf(id);
      if (!old) throw new HttpError(404, 'err.notFound');
      const v = clean(input, old);
      if (PUSH_KINDS.includes(v.kind)) { db.prepare('UPDATE proxmox_hosts SET name=? WHERE id=?').run(v.name, id); return shape(rowOf(id)); }
      db.prepare('UPDATE proxmox_hosts SET name=?, kind=?, url=?, token_id=?, secret=?, verify=?, ca=?, last_at=NULL WHERE id=?').run(v.name, v.kind, v.url, v.token_id, v.secret, v.verify, v.ca, id);
      return shape(rowOf(id));
    },
    push,
    newToken,
    remove(id) {
      if (db.prepare("SELECT 1 FROM monitors WHERE type='proxmox' AND json_extract(options,'$.host')=?").get(id)) throw new HttpError(409, 'err.proxmoxInUse');
      if (!db.prepare('DELETE FROM proxmox_hosts WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
    },
    poll,
    pollAll,
    metrics: (id) => proxmoxMetrics(shape(rowOf(id))?.data),
    start() { if (!timer) { timer = setInterval(() => pollAll().catch(() => {}), 60 * 1000); timer.unref(); setTimeout(() => pollAll().catch(() => {}), 30 * 1000).unref(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
