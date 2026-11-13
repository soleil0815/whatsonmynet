// More hypervisors beside Proxmox. Every reader returns the same shape as Proxmox VE, so the page, the sensors and the
// reports work the same for all of them:
//   { kind, nodes: [{ name, online, cpu, mem, memUsed, memTotal, uptime }], storages: [{ name, node, used, total, pct }],
//     guests: [{ vmid, name, kind, node, status, cpu, mem }] }
//
// Asked through their API with a read-only account (nothing installed there):
//   vmware    ESXi or vCenter - vSphere Web Services (SOAP, /sdk), works for both and gives host load and VM state
//   xcpng     XCP-ng / Citrix Hypervisor (XenServer) - XAPI JSON-RPC on the pool master
//   nutanix   Nutanix AHV - Prism REST API v2 (Prism Element or Central, port 9440)
//   ovirt     oVirt / Red Hat Virtualization / Oracle Linux Virtualization Manager - REST API of the engine
// Sending on their own (a small script on the host, every 5 minutes - no API to ask, no inbound port):
//   hyperv    Microsoft Hyper-V - PowerShell script as scheduled task
//   libvirt   KVM/QEMU with libvirt - POSIX sh script with "virsh -r" (read-only) as cron job
import crypto from 'node:crypto';
import { hostScript } from './hostscripts.js';
import { tlsRequest } from './proxmox.js';

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const pct = (used, total) => (total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : null);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);

export const API_KINDS = ['vmware', 'xcpng', 'nutanix', 'ovirt'];
export const PUSH_KINDS = ['hyperv', 'libvirt'];

// ---------------------------------------------------------------------------------------------- VMware (SOAP)
const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const xmlUnesc = (s) => String(s).replace(/&(lt|gt|amp|apos|quot|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' }[e.toLowerCase()]
  ?? (e[1] === 'x' || e[1] === 'X' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1))))));
const envelope = (inner) => `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:vim25" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml); return m ? xmlUnesc(m[1]) : null; };

/** Objects of a RetrievePropertiesEx answer: [{ type, id, props: { path: value } }] (scalar values and references) */
export function parseObjects(xml) {
  const out = [];
  for (const o of xml.matchAll(/<objects>([\s\S]*?)<\/objects>/g)) {
    const obj = /<obj type="([^"]+)">([^<]*)<\/obj>/.exec(o[1]);
    if (!obj) continue;
    const props = {};
    for (const p of o[1].matchAll(/<propSet><name>([^<]+)<\/name><val[^>]*>([\s\S]*?)<\/val><\/propSet>/g)) props[p[1]] = xmlUnesc(p[2]);
    out.push({ type: obj[1], id: xmlUnesc(obj[2]), props });
  }
  return out;
}

const VM_PROPS = {
  HostSystem: ['name', 'runtime.connectionState', 'runtime.powerState', 'runtime.inMaintenanceMode', 'summary.quickStats.overallCpuUsage', 'summary.quickStats.overallMemoryUsage',
    'summary.quickStats.uptime', 'summary.hardware.cpuMhz', 'summary.hardware.numCpuCores', 'summary.hardware.memorySize'],
  VirtualMachine: ['name', 'runtime.powerState', 'runtime.host', 'config.template', 'summary.quickStats.overallCpuUsage', 'runtime.maxCpuUsage',
    'summary.quickStats.guestMemoryUsage', 'config.hardware.memoryMB'],
  Datastore: ['summary.name', 'summary.capacity', 'summary.freeSpace', 'summary.accessible'],
};

/** Turns the objects of vCenter/ESXi into the common shape */
export function shapeVmware(objects) {
  const hostName = new Map(objects.filter((o) => o.type === 'HostSystem').map((o) => [o.id, o.props.name || o.id]));
  const nodes = objects.filter((o) => o.type === 'HostSystem').map((o) => {
    const p = o.props;
    const online = p['runtime.connectionState'] === 'connected' && p['runtime.powerState'] !== 'poweredOff' && p['runtime.powerState'] !== 'standBy';
    const cpuMax = (num(p['summary.hardware.cpuMhz']) || 0) * (num(p['summary.hardware.numCpuCores']) || 0);
    const memTotal = num(p['summary.hardware.memorySize']) || 0;
    const memUsed = (num(p['summary.quickStats.overallMemoryUsage']) || 0) * 1024 * 1024;
    return { name: clip(p.name || o.id), online, cpu: online ? pct(num(p['summary.quickStats.overallCpuUsage']) || 0, cpuMax) : null,
      mem: online ? pct(memUsed, memTotal) : null, memUsed: online ? memUsed : 0, memTotal, uptime: num(p['summary.quickStats.uptime']) || 0, maintenance: p['runtime.inMaintenanceMode'] === 'true' };
  });
  const guests = objects.filter((o) => o.type === 'VirtualMachine' && o.props['config.template'] !== 'true').map((o) => {
    const p = o.props;
    const st = { poweredOn: 'running', poweredOff: 'stopped', suspended: 'paused' }[p['runtime.powerState']] || 'unknown';
    const memMb = num(p['config.hardware.memoryMB']);
    return { vmid: o.id, name: clip(p.name || o.id), kind: 'vm', node: hostName.get(p['runtime.host']) || '', status: st,
      cpu: st === 'running' ? pct(num(p['summary.quickStats.overallCpuUsage']) || 0, num(p['runtime.maxCpuUsage']) || 0) : null,
      mem: st === 'running' && memMb ? pct(num(p['summary.quickStats.guestMemoryUsage']) || 0, memMb) : null };
  });
  const storages = objects.filter((o) => o.type === 'Datastore').map((o) => {
    const total = num(o.props['summary.capacity']) || 0; const free = num(o.props['summary.freeSpace']) || 0;
    return { name: clip(o.props['summary.name'] || o.id), node: '', active: o.props['summary.accessible'] !== 'false', used: Math.max(0, total - free), total, pct: pct(total - free, total) };
  });
  return { kind: 'vmware', nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)), storages: storages.sort((a, b) => a.name.localeCompare(b.name)),
    guests: guests.sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function readVmware(host) {
  let cookie = '';
  const call = async (inner) => {
    const res = await tlsRequest(host, 'POST', '/sdk', { body: envelope(inner),
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:vim25/6.7', ...(cookie ? { Cookie: cookie } : {}) } });
    const setCookie = [].concat(res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('vmware_soap_session'));
    if (setCookie) cookie = setCookie;
    if (res.status === 404) throw new Error('no vSphere API at this address (/sdk) - ESXi or vCenter address?');
    const fault = tag(res.text, 'faultstring');
    if (fault || res.status >= 400) throw new Error(fault ? fault.slice(0, 200) : `HTTP ${res.status}`);
    return res.text;
  };
  const sc = await call('<urn:RetrieveServiceContent><urn:_this type="ServiceInstance">ServiceInstance</urn:_this></urn:RetrieveServiceContent>');
  const ref = (name) => /<([^>\s]+)\s+type="([^"]+)">([^<]+)</.exec(new RegExp(`<${name} type="[^"]+">[^<]+</${name}>`).exec(sc)?.[0] || '') || [];
  const [, , , root] = ref('rootFolder'); const [, , , pc] = ref('propertyCollector'); const [, , , vm] = ref('viewManager'); const [, , , sm] = ref('sessionManager');
  if (!root || !pc || !vm || !sm) throw new Error('unexpected answer of the vSphere API');
  try {
    await call(`<urn:Login><urn:_this type="SessionManager">${xmlEsc(sm)}</urn:_this><urn:userName>${xmlEsc(host.token_id)}</urn:userName><urn:password>${xmlEsc(host.secretPlain)}</urn:password></urn:Login>`);
  } catch (e) {
    throw new Error(/incorrect user name or password|InvalidLogin/i.test(e.message) ? 'sign-in refused - user or password wrong' : e.message);
  }
  try {
    const view = tag(await call(`<urn:CreateContainerView><urn:_this type="ViewManager">${xmlEsc(vm)}</urn:_this><urn:container type="Folder">${xmlEsc(root)}</urn:container>`
      + '<urn:type>HostSystem</urn:type><urn:type>VirtualMachine</urn:type><urn:type>Datastore</urn:type><urn:recursive>true</urn:recursive></urn:CreateContainerView>'), 'returnval');
    const propSet = Object.entries(VM_PROPS).map(([type, paths]) => `<urn:propSet><urn:type>${type}</urn:type>${paths.map((p) => `<urn:pathSet>${p}</urn:pathSet>`).join('')}</urn:propSet>`).join('');
    const objectSet = `<urn:objectSet><urn:obj type="ContainerView">${xmlEsc(view)}</urn:obj><urn:skip>true</urn:skip><urn:selectSet xsi:type="urn:TraversalSpec">`
      + '<urn:name>view</urn:name><urn:type>ContainerView</urn:type><urn:path>view</urn:path><urn:skip>false</urn:skip></urn:selectSet></urn:objectSet>';
    let xml = await call(`<urn:RetrievePropertiesEx><urn:_this type="PropertyCollector">${xmlEsc(pc)}</urn:_this><urn:specSet>${propSet}${objectSet}</urn:specSet><urn:options/></urn:RetrievePropertiesEx>`);
    const objects = parseObjects(xml);
    // Large environments come in pages
    for (let i = 0; i < 50; i++) {
      const token = tag(xml, 'token');
      if (!token) break;
      xml = await call(`<urn:ContinueRetrievePropertiesEx><urn:_this type="PropertyCollector">${xmlEsc(pc)}</urn:_this><urn:token>${xmlEsc(token)}</urn:token></urn:ContinueRetrievePropertiesEx>`);
      objects.push(...parseObjects(xml));
    }
    return shapeVmware(objects);
  } finally {
    await call(`<urn:Logout><urn:_this type="SessionManager">${xmlEsc(sm)}</urn:_this></urn:Logout>`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------- XCP-ng (XAPI)
export async function readXcp(host) {
  let id = 0;
  const call = async (method, params) => {
    const res = await tlsRequest(host, 'POST', '/jsonrpc', { body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++id }), headers: { 'Content-Type': 'application/json' } });
    if (res.status === 404) throw new Error('no XAPI at this address (/jsonrpc) - XCP-ng 8 / XenServer 7.3 or newer?');
    const j = parse(res.text, null);
    if (!j) throw new Error(`HTTP ${res.status}`);
    if (j.error) {
      const data = [].concat(j.error.data || []);
      const code = String(j.error.message || data[0] || 'error');
      if (/HOST_IS_SLAVE/.test(code)) throw new Error(`this host is not the pool master - enter the master: ${data[1] || ''}`.trim());
      if (/SESSION_AUTHENTICATION_FAILED/.test(code)) throw new Error('sign-in refused - user or password wrong');
      if (/RBAC_PERMISSION_DENIED/.test(code)) throw new Error('the account lacks the right to read (role read-only)');
      throw new Error(code.slice(0, 200));
    }
    return j.result;
  };
  const session = await call('session.login_with_password', [host.token_id, host.secretPlain, '2.0', 'WhatsOnMyNet']);
  try {
    const [hosts, metrics, cpus, vms, srs, pbds] = await Promise.all(['host', 'host_metrics', 'host_cpu', 'VM', 'SR', 'PBD'].map((c) => call(`${c}.get_all_records`, [session])));
    const hostName = new Map(Object.entries(hosts || {}).map(([ref, x]) => [ref, clip(x.name_label || ref)]));
    const load = new Map();
    for (const c of Object.values(cpus || {})) { const l = load.get(c.host) || []; l.push(Number(c.utilisation) || 0); load.set(c.host, l); }
    const nodes = Object.entries(hosts || {}).map(([ref, x]) => {
      const m = metrics?.[x.metrics] || {};
      const memTotal = num(m.memory_total) || 0; const memUsed = memTotal ? memTotal - (num(m.memory_free) || 0) : 0;
      const online = m.live !== false && x.enabled !== false;
      const l = load.get(ref) || [];
      const boot = num(x.other_config?.boot_time);
      return { name: hostName.get(ref), online, cpu: online && l.length ? Math.round((l.reduce((a, b) => a + b, 0) / l.length) * 100) : null,
        mem: online ? pct(memUsed, memTotal) : null, memUsed, memTotal, uptime: boot ? Math.max(0, Math.round(Date.now() / 1000 - boot)) : 0 };
    });
    const guests = Object.entries(vms || {}).filter(([, v]) => !v.is_a_template && !v.is_control_domain && !v.is_a_snapshot).map(([ref, v]) => ({
      vmid: clip(v.uuid || ref, 64), name: clip(v.name_label || ref), kind: 'vm', node: hostName.get(v.resident_on) || '',
      status: { Running: 'running', Halted: 'stopped', Paused: 'paused', Suspended: 'paused' }[v.power_state] || 'unknown', cpu: null, mem: null }));
    const srHost = new Map();
    for (const p of Object.values(pbds || {})) if (!srHost.has(p.SR)) srHost.set(p.SR, p.host);
    const storages = Object.entries(srs || {}).filter(([, x]) => x.content_type !== 'iso' && !['iso', 'udev'].includes(x.type) && num(x.physical_size) > 0).map(([ref, x]) => {
      const total = num(x.physical_size) || 0; const used = num(x.physical_utilisation) || 0;
      return { name: clip(x.name_label || ref), node: x.shared ? '' : hostName.get(srHost.get(ref)) || '', active: true, used, total, pct: pct(used, total) };
    });
    return { kind: 'xcpng', nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)), storages: storages.sort((a, b) => a.name.localeCompare(b.name)), guests: guests.sort((a, b) => a.name.localeCompare(b.name)) };
  } finally {
    await call('session.logout', [session]).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------- Nutanix (Prism v2)
const basic = (host) => `Basic ${Buffer.from(`${host.token_id}:${host.secretPlain}`).toString('base64')}`;
async function getJson(host, path, extraHeaders = {}) {
  const res = await tlsRequest(host, 'GET', path, { headers: { Authorization: basic(host), Accept: 'application/json', ...extraHeaders } });
  if (res.status === 401) throw new Error('sign-in refused (401) - user or password wrong');
  if (res.status === 403) throw new Error('access denied (403) - the account lacks read rights');
  if (res.status === 404) throw new Error(`not found (404): ${path.split('?')[0]} - right address?`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const j = parse(res.text, null);
  if (j === null) throw new Error('answer is not JSON - right address?');
  return j;
}

export async function readNutanix(host) {
  const base = '/api/nutanix/v2.0';
  const [hosts, vms, ctrs] = await Promise.all([getJson(host, `${base}/hosts/`), getJson(host, `${base}/vms/?length=1000`), getJson(host, `${base}/storage_containers/`)]);
  const hostName = new Map((hosts.entities || []).map((x) => [x.uuid, clip(x.name || x.uuid)]));
  const nodes = (hosts.entities || []).map((x) => {
    const online = !x.state || x.state === 'NORMAL';
    const memTotal = num(x.memory_capacity_in_bytes) || 0;
    const memPpm = num(x.stats?.hypervisor_memory_usage_ppm);
    const boot = num(x.boot_time_in_usecs);
    return { name: hostName.get(x.uuid), online, cpu: online && num(x.stats?.hypervisor_cpu_usage_ppm) !== null ? Math.round(num(x.stats.hypervisor_cpu_usage_ppm) / 10000) : null,
      mem: online && memPpm !== null ? Math.round(memPpm / 10000) : null, memUsed: memPpm !== null ? Math.round((memTotal * memPpm) / 1e6) : 0, memTotal,
      uptime: boot ? Math.max(0, Math.round(Date.now() / 1000 - boot / 1e6)) : 0 };
  });
  const guests = (vms.entities || []).map((v) => ({ vmid: clip(v.uuid, 64), name: clip(v.name || v.uuid), kind: 'vm', node: hostName.get(v.host_uuid) || '',
    status: { on: 'running', off: 'stopped', paused: 'paused', suspended: 'paused' }[String(v.power_state).toLowerCase()] || 'unknown', cpu: null, mem: null }));
  const storages = (ctrs.entities || []).map((c) => {
    const u = c.usage_stats || {};
    const total = num(u['storage.user_capacity_bytes']) || num(u['storage.capacity_bytes']) || 0;
    const used = num(u['storage.user_usage_bytes']) ?? (total - (num(u['storage.user_free_bytes']) || 0));
    return { name: clip(c.name), node: '', active: true, used: used || 0, total, pct: pct(used || 0, total) };
  }).filter((s) => s.total);
  return { kind: 'nutanix', nodes, storages, guests: guests.sort((a, b) => a.name.localeCompare(b.name)) };
}

// ---------------------------------------------------------------------------------------------- oVirt / RHV
const stat = (x, name) => num(x.statistics?.statistic?.find((s) => s.name === name)?.values?.value?.[0]?.datum);
export async function readOvirt(host) {
  const base = '/ovirt-engine/api';
  const h = { Version: '4' };
  const [hosts, vms, sds] = await Promise.all([getJson(host, `${base}/hosts?follow=statistics`, h), getJson(host, `${base}/vms?follow=statistics`, h), getJson(host, `${base}/storagedomains`, h)]);
  const hostName = new Map((hosts.host || []).map((x) => [x.id, clip(x.name || x.id)]));
  const nodes = (hosts.host || []).map((x) => {
    const online = x.status === 'up';
    const memTotal = stat(x, 'memory.total') || num(x.memory) || 0; const memUsed = stat(x, 'memory.used') || 0;
    const cpu = stat(x, 'cpu.current.user') !== null ? (stat(x, 'cpu.current.user') || 0) + (stat(x, 'cpu.current.system') || 0) : null;
    const boot = stat(x, 'boot.time');
    return { name: hostName.get(x.id), online, cpu: online && cpu !== null ? Math.round(cpu) : null, mem: online ? pct(memUsed, memTotal) : null, memUsed, memTotal,
      uptime: boot ? Math.max(0, Math.round(Date.now() / 1000 - boot)) : 0 };
  });
  const guests = (vms.vm || []).map((v) => {
    const st = v.status === 'up' ? 'running' : ['down', 'image_locked'].includes(v.status) ? 'stopped' : ['paused', 'suspended'].includes(v.status) ? 'paused' : String(v.status || 'unknown');
    return { vmid: clip(v.id, 64), name: clip(v.name || v.id), kind: 'vm', node: hostName.get(v.host?.id) || '', status: st,
      cpu: st === 'running' && stat(v, 'cpu.current.guest') !== null ? Math.round(stat(v, 'cpu.current.guest')) : null,
      mem: st === 'running' ? pct(stat(v, 'memory.used') || 0, stat(v, 'memory.installed') || num(v.memory) || 0) : null };
  });
  const storages = (sds.storage_domain || []).filter((d) => d.type === 'data' || !d.type).map((d) => {
    const used = num(d.used) || 0; const total = used + (num(d.available) || 0);
    return { name: clip(d.name), node: '', active: d.external_status !== 'failure', used, total, pct: pct(used, total) };
  }).filter((s) => s.total);
  return { kind: 'ovirt', nodes, storages, guests: guests.sort((a, b) => a.name.localeCompare(b.name)) };
}

export const READERS = { vmware: readVmware, xcpng: readXcp, nutanix: readNutanix, ovirt: readOvirt };

// ---------------------------------------------------------------------------------------------- push (Hyper-V, libvirt)
/** New push token and how it is stored (only its hash) */
export function newPushToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, stored: `sha256:${crypto.createHash('sha256').update(token).digest('hex')}` };
}
export function pushTokenOk(stored, token) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(stored)) || !/^[A-Za-z0-9_-]{20,200}$/.test(String(token))) return false;
  const a = Buffer.from(stored.slice(7), 'hex');
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/** What a host script sends, checked and cut to size: never trust it more than a form */
export function cleanPush(body) {
  const b = body && typeof body === 'object' ? body : {};
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : v && typeof v === 'object' ? [v] : []);
  const node = list(b.nodes, 4).map((x) => ({ name: clip(x?.name, 80), online: x?.online !== false, cpu: pct(num(x?.cpu) || 0, 100),
    memUsed: Math.max(0, num(x?.memUsed) || 0), memTotal: Math.max(0, num(x?.memTotal) || 0), uptime: Math.max(0, Math.round(num(x?.uptime) || 0)) }))
    .filter((x) => x.name).map((x) => ({ ...x, mem: pct(x.memUsed, x.memTotal) }));
  if (!node.length) throw new Error('no node in the data');
  const me = node[0].name;
  const STATUS = ['running', 'stopped', 'paused', 'unknown'];
  const guests = list(b.guests, 1000).map((g) => ({ vmid: clip(g?.vmid ?? g?.name, 64), name: clip(g?.name, 120), kind: 'vm', node: clip(g?.node, 80) || me,
    status: STATUS.includes(g?.status) ? g.status : 'unknown', cpu: num(g?.cpu) === null ? null : pct(num(g.cpu), 100), mem: num(g?.mem) === null ? null : pct(num(g.mem), 100) }))
    .filter((g) => g.name);
  const storages = list(b.storages, 200).map((s) => {
    const total = Math.max(0, num(s?.total) || 0); const used = Math.max(0, Math.min(total, num(s?.used) || 0));
    // node '' = shared by the cluster (e.g. a Cluster Shared Volume): sent by every node, kept once
    return { name: clip(s?.name, 120), node: s?.node === '' ? '' : clip(s?.node, 80) || me, active: true, used, total, pct: pct(used, total) };
  }).filter((s) => s.name && s.total);
  return { nodes: node, guests, storages };
}

/**
 * Data of several hosts (e.g. every node of a Hyper-V cluster runs the script): what a node sends replaces its own
 * part, the rest stays. seen = when each node sent last; a node silent for long counts as offline.
 */
export function mergePush(kind, old, incoming, at = new Date().toISOString()) {
  const names = new Set(incoming.nodes.map((n) => n.name));
  const keep = (x) => !names.has(x.node ?? x.name);
  const prev = old && typeof old === 'object' ? old : {};
  const shared = new Set(incoming.storages.filter((x) => x.node === '').map((x) => x.name));
  return {
    kind,
    nodes: [...(prev.nodes || []).filter((n) => !names.has(n.name)), ...incoming.nodes.map((n) => ({ ...n, seen: at }))].sort((a, b) => a.name.localeCompare(b.name)),
    storages: [...(prev.storages || []).filter((x) => keep(x) && !(x.node === '' && shared.has(x.name))), ...incoming.storages].sort((a, b) => `${a.name}${a.node}`.localeCompare(`${b.name}${b.node}`)),
    guests: [...(prev.guests || []).filter(keep), ...incoming.guests].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Nodes that have not sent for `staleMin` minutes are offline (script stopped, host down); their values are old */
export function markStale(data, staleMin = 15, now = Date.now()) {
  if (!data?.nodes) return data;
  return { ...data, nodes: data.nodes.map((n) => (n.seen && now - Date.parse(n.seen) > staleMin * 60 * 1000 ? { ...n, online: false, cpu: null, mem: null, stale: true } : n)) };
}

// ---------------------------------------------------------------------------------------------- the host scripts
/**
 * Script for a Hyper-V / KVM host. server: address of WhatsOnMyNet as the browser uses it; pin: { sha1, spki } of a
 * self-signed certificate (empty when a public CA vouches for it) - the script then trusts exactly that certificate.
 */
export function pushScript(kind, { server, id, token, pin = {} }) {
  return hostScript(kind === 'hyperv' ? 'hyperv' : 'libvirt', { url: `${server.replace(/\/+$/, '')}/api/proxmox/${id}/push`, token, pin });
}
