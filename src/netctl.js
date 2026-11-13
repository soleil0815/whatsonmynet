// Network controllers that homelabs and small businesses use a lot - read with an account that may only read:
//   unifi     UniFi Network (UniFi OS consoles like UDM/UCG/Cloud Key, or the self-hosted Network application)
//   omada     TP-Link Omada Controller (software, OC200/OC300, Omada gateways with controller)
//   mikrotik  MikroTik RouterOS 7 (REST API of the router/switch itself)
// Every reader returns the same shape:
//   { kind, controller: { version }, netdevices: [{ mac, name, model, type, ip, firmware, serial, online, clients, uptime,
//     cpu, mem, update }], clients }
// type is one of the inventory types: accesspoint, switch, router, firewall.
import { tlsRequest } from './proxmox.js';
import { normalizeMac } from './lib/net.js';

export const NET_KINDS = ['unifi', 'omada', 'mikrotik'];
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (v) => (num(v) === null ? null : Math.max(0, Math.min(100, Math.round(num(v)))));
const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** Small cookie jar for one sign-in */
function session(host) {
  const jar = new Map();
  const extra = {};
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function call(method, path, { body, headers = {} } = {}) {
    const res = await tlsRequest(host, method, path, {
      body: body === undefined ? null : JSON.stringify(body),
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar.size ? { Cookie: cookie() } : {}), ...extra, ...headers },
    });
    for (const c of [].concat(res.headers['set-cookie'] || [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
    return { status: res.status, headers: res.headers, json: parse(res.text, null), text: res.text };
  }
  return { call, extra };
}
const refused = () => new Error('sign-in refused - user or password wrong (or two-factor sign-in is on for this account)');

// ---------------------------------------------------------------------------------------------- UniFi
const UNIFI_TYPE = { uap: 'accesspoint', usw: 'switch', ugw: 'router', udm: 'router', uxg: 'router', ucg: 'router', uck: 'server', ubb: 'accesspoint', uph: 'phone' };

export function shapeUnifi(devices, health = []) {
  const netdevices = (devices || []).map((x) => ({
    mac: normalizeMac(x.mac) || '', name: clip(x.name || x.model || x.mac), model: clip(x.model_name || x.shortname || x.model, 80), modelCode: clip(x.model, 40),
    type: UNIFI_TYPE[x.type] || 'switch', ip: clip(x.ip, 45), firmware: clip(x.version, 60), serial: clip(x.serial, 60),
    online: Number(x.state) === 1, clients: num(x.num_sta) ?? num(x['user-num_sta']) ?? null, uptime: num(x.uptime) || 0,
    cpu: pct(x['system-stats']?.cpu), mem: pct(x['system-stats']?.mem), update: x.upgradable ? clip(x.upgrade_to_firmware || 'yes', 60) : '',
  })).filter((d) => d.mac).sort(byName);
  const users = (health || []).filter((s) => s.subsystem === 'wlan' || s.subsystem === 'lan').reduce((a, s) => a + (num(s.num_user) || 0), 0);
  return { kind: 'unifi', netdevices, clients: users || netdevices.filter((d) => d.type === 'accesspoint').reduce((a, d) => a + (d.clients || 0), 0) };
}

export async function readUnifi(host) {
  const s = session(host);
  // UniFi OS consoles (UDM, UCG, Cloud Key Gen2+): /api/auth/login, Network app below /proxy/network
  let prefix = '/proxy/network';
  let r = await s.call('POST', '/api/auth/login', { body: { username: host.token_id, password: host.secretPlain, rememberMe: false } });
  if (r.status === 404 || r.status === 405) {
    // Self-hosted Network application (port 8443)
    prefix = '';
    r = await s.call('POST', '/api/login', { body: { username: host.token_id, password: host.secretPlain } });
  }
  if (r.status === 401 || r.status === 400 || r.status === 403) throw refused();
  if (r.status === 429) throw new Error('too many sign-ins - UniFi blocks for a few minutes');
  if (r.status !== 200) throw new Error(`no UniFi controller at this address (HTTP ${r.status})`);
  const csrf = r.headers['x-csrf-token'] || r.headers['x-updated-csrf-token'];
  if (csrf) s.extra['X-CSRF-Token'] = csrf;
  try {
    const sites = (await s.call('GET', `${prefix}/api/self/sites`)).json?.data || [];
    const devices = []; const health = [];
    for (const site of sites.slice(0, 20)) {
      const name = encodeURIComponent(site.name);
      const d = await s.call('GET', `${prefix}/api/s/${name}/stat/device`);
      if (d.status === 401 || d.status === 403) throw new Error('the account may not read this site');
      devices.push(...(d.json?.data || []));
      health.push(...((await s.call('GET', `${prefix}/api/s/${name}/stat/health`)).json?.data || []));
    }
    const out = shapeUnifi(devices, health);
    return { ...out, sites: sites.length };
  } finally {
    await s.call('POST', prefix ? '/api/auth/logout' : '/api/logout', { body: {} }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------- Omada
const OMADA_TYPE = { ap: 'accesspoint', switch: 'switch', gateway: 'router', olt: 'switch' };

export function shapeOmada(devices) {
  const netdevices = (devices || []).map((x) => {
    const online = x.statusCategory !== undefined ? Number(x.statusCategory) === 1 : (Number(x.status) >= 14 && Number(x.status) <= 17);
    return { mac: normalizeMac(x.mac) || '', name: clip(x.name || x.model || x.mac), model: clip(x.showModel || x.model, 80), modelCode: clip(x.model, 40),
      type: OMADA_TYPE[x.type] || 'switch', ip: clip(x.ip, 45), firmware: clip(x.firmwareVersion || x.version, 60), serial: clip(x.sn, 60),
      online, clients: num(x.clientNum) ?? null, uptime: num(x.uptimeLong) ?? 0, cpu: pct(x.cpuUtil), mem: pct(x.memUtil), update: x.needUpgrade ? 'yes' : '' };
  }).filter((d) => d.mac).sort(byName);
  return { kind: 'omada', netdevices, clients: netdevices.reduce((a, d) => a + (d.type === 'accesspoint' ? d.clients || 0 : 0), 0) };
}

export async function readOmada(host) {
  const s = session(host);
  const info = await s.call('GET', '/api/info');
  const id = info.json?.result?.omadacId;
  if (!id || !/^[A-Za-z0-9]{1,64}$/.test(id)) throw new Error(`no Omada controller at this address (HTTP ${info.status})`);
  const ok = (r, what) => {
    if (r.json?.errorCode === 0) return r.json.result;
    if (r.json?.errorCode === -30109 || r.json?.errorCode === -30101 || r.status === 401) throw refused();
    throw new Error(`${what}: ${clip(r.json?.msg || `HTTP ${r.status}`, 160)}`);
  };
  const login = ok(await s.call('POST', `/${id}/api/v2/login`, { body: { username: host.token_id, password: host.secretPlain } }), 'sign-in');
  if (login?.token) s.extra['Csrf-Token'] = login.token;
  try {
    const sites = ok(await s.call('GET', `/${id}/api/v2/sites?currentPage=1&currentPageSize=100`), 'sites')?.data || [];
    const devices = [];
    for (const site of sites.slice(0, 20)) devices.push(...(ok(await s.call('GET', `/${id}/api/v2/sites/${encodeURIComponent(site.id)}/devices`), 'devices') || []));
    return { ...shapeOmada(devices), controller: { version: clip(info.json?.result?.controllerVer, 40) }, sites: sites.length };
  } finally {
    await s.call('POST', `/${id}/api/v2/logout`, { body: {} }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------- MikroTik
/** "1w2d3h4m5s" → seconds */
export function rosUptime(s) {
  let sec = 0;
  for (const [, n, u] of String(s || '').matchAll(/(\d+)([wdhms])/g)) sec += Number(n) * { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }[u];
  return sec;
}

export function shapeMikrotik({ resource = {}, routerboard = {}, identity = {}, ifaces = [], wireless = [] }) {
  const board = String(resource['board-name'] || routerboard.model || '');
  // CRS = switch, cAP/wAP = access point, the rest (hAP, hEX, RB, CCR, CHR) routes
  const type = /^CRS|^CSS/i.test(board) ? 'switch' : /^(cAP|wAP)/i.test(board) ? 'accesspoint' : 'router';
  const total = num(resource['total-memory']); const free = num(resource['free-memory']);
  const ether = (ifaces || []).find((i) => i.type === 'ether' && i['mac-address']) || (ifaces || []).find((i) => i['mac-address']);
  const self = {
    mac: normalizeMac(ether?.['mac-address']) || '', name: clip(identity.name || board), model: clip(routerboard.model || board, 80), modelCode: clip(board, 40), type,
    ip: '', firmware: clip(`RouterOS ${resource.version || ''}`.trim(), 60), serial: clip(routerboard['serial-number'], 60), online: true,
    clients: (wireless || []).length || null, uptime: rosUptime(resource.uptime), cpu: pct(resource['cpu-load']), mem: total ? pct(((total - (free || 0)) / total) * 100) : null, update: '',
  };
  const ports = (ifaces || []).filter((i) => i.type === 'ether').map((i) => ({ name: clip(i.name, 40), up: i.running === 'true' || i.running === true, disabled: i.disabled === 'true' || i.disabled === true }));
  return { kind: 'mikrotik', netdevices: [self], ports, clients: self.clients || 0 };
}

export async function readMikrotik(host) {
  const auth = `Basic ${Buffer.from(`${host.token_id}:${host.secretPlain}`).toString('base64')}`;
  const get = async (path, optional = false) => {
    const r = await tlsRequest(host, 'GET', `/rest${path}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (r.status === 401) throw refused();
    if (r.status === 404 && !optional) throw new Error('no RouterOS REST API at this address - RouterOS 7 with "www-ssl" service on?');
    if (r.status !== 200) { if (optional) return []; throw new Error(`HTTP ${r.status}`); }
    return parse(r.text, null);
  };
  const [resource, routerboard, identity, ifaces] = await Promise.all([get('/system/resource'), get('/system/routerboard', true), get('/system/identity', true), get('/interface', true)]);
  const wireless = await get('/interface/wifi/registration-table', true).then((x) => (Array.isArray(x) && x.length ? x : get('/interface/wireless/registration-table', true)));
  return shapeMikrotik({ resource, routerboard: Array.isArray(routerboard) ? {} : routerboard, identity: Array.isArray(identity) ? {} : identity, ifaces, wireless: Array.isArray(wireless) ? wireless : [] });
}

export const NET_READERS = { unifi: readUnifi, omada: readOmada, mikrotik: readMikrotik };
