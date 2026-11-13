// Proxmox VE and Proxmox Backup Server via their REST API - nothing is installed there. An API token with read-only
// rights is enough (PVE: role PVEAuditor; PBS: role Audit/DatastoreAudit). The token secret is stored encrypted.
//
// PVE: nodes (online, CPU, RAM), storages (usage), VMs/containers (running/stopped), backup jobs (vzdump tasks).
// PBS: datastores (usage), backup groups (age of the last backup), failed tasks.
import crypto from 'node:crypto';
import https from 'node:https';
import { HttpError, line, str } from './lib/http.js';
import { encrypt, decrypt } from './lib/crypto.js';
import { log } from './lib/log.js';
import { fetchTlsChain, describe, publiclyTrusted, toPem } from './auth/dccert.js';
import { READERS, API_KINDS, PUSH_KINDS, newPushToken, pushTokenOk, cleanPush, mergePush, markStale, pushScript } from './virt.js';

/** Every kind of host on the page: Proxmox, hypervisors asked through their API, hypervisors that send on their own */
export const HOST_KINDS = ['pve', 'pbs', ...API_KINDS, ...PUSH_KINDS];

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
    const pinned = new crypto.X509Certificate(host.ca).fingerprint256;
    // allowPartialTrustChain: the pinned certificate may also be the server's own (not only a CA)
    return { ca: [host.ca], allowPartialTrustChain: true, checkServerIdentity: (_h, cert) => (chainFingerprints(cert).includes(pinned) ? undefined : new Error('certificate is not the pasted one')) };
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
    const req = https.request(u, { method, timeout: timeoutMs, agent: false, headers: { ...(data ? { 'Content-Length': data.length } : {}), ...headers }, ...tlsOptions(host) }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size < maxBytes) chunks.push(d); else res.destroy(new Error('answer too large')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => reject(netError(e)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(netError(e)));
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
  const shape = (h) => (h ? { id: h.id, name: h.name, kind: h.kind, url: h.url, token_id: h.token_id, has_secret: !!h.secret, verify: !!h.verify, ca: h.ca, ca_info: caInfo(h.ca),
    created_at: h.created_at, last_at: h.last_at, last_ok: !!h.last_ok, last_error: h.last_error, data: parse(h.data, {}) } : null);

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
    if (API_KINDS.includes(kind) ? !tokenId || /[\x00-\x1f]/.test(tokenId) : !PVE_TOKEN.test(tokenId)) throw new HttpError(400, API_KINDS.includes(kind) ? 'err.virtUser' : 'err.proxmoxToken');
    const ca = str(input.ca, 20000).trim();
    if (ca) { try { new crypto.X509Certificate(ca); } catch { throw new HttpError(400, 'err.adCa'); } }
    let secret = old?.secret || '';
    if (typeof input.secret === 'string' && input.secret.trim()) secret = encrypt(input.secret.trim().slice(0, 200));
    if (!secret) throw new HttpError(400, API_KINDS.includes(kind) ? 'err.virtUser' : 'err.proxmoxToken');
    return { name, kind, url, token_id: tokenId, secret, verify: input.verify === false ? 0 : 1, ca };
  }

  async function poll(id) {
    const h = rowOf(id);
    if (!h) throw new HttpError(404, 'err.notFound');
    const at = new Date().toISOString();
    // A host that sends on its own is not asked: only check whether its nodes still report
    if (PUSH_KINDS.includes(h.kind)) return checkPush(h);
    try {
      const data = h.kind === 'pbs' ? await readPbs(withSecret(h)) : READERS[h.kind] ? await READERS[h.kind](withSecret(h)) : await readPve(withSecret(h));
      db.prepare("UPDATE proxmox_hosts SET last_at=?, last_ok=1, last_error='', data=? WHERE id=?").run(at, JSON.stringify(data), id);
    } catch (e) {
      db.prepare('UPDATE proxmox_hosts SET last_at=?, last_ok=0, last_error=? WHERE id=?').run(at, String(e.message).slice(0, 300), id);
    }
    return shape(rowOf(id));
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
    if (!/^https?:\/\/[^\s/"'<>]+$/i.test(String(server || ''))) throw new HttpError(400, 'err.badRequest');
    const t = newPushToken();
    db.prepare('UPDATE proxmox_hosts SET secret=? WHERE id=?').run(t.stored, id);
    return { token: t.token, ...pushScript(h.kind, { server, id, token: t.token, pin }) };
  }

  async function pollAll() {
    if (polling) return;
    polling = true;
    try {
      const every = Math.max(1, Number(settings.get('proxmox.interval')) || 5) * 60 * 1000;
      for (const h of db.prepare('SELECT id, kind, last_at FROM proxmox_hosts').all()) {
        if (!PUSH_KINDS.includes(h.kind) && h.last_at && Date.now() - Date.parse(h.last_at) < every) continue;
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
    fetchCert,
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
