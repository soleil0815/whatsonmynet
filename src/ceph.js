// A Ceph cluster of its own (not Proxmox - that one comes with the Proxmox host): through the REST API of the Ceph
// dashboard (port 8443) with a dashboard user of the role "read-only". Health with its checks, OSDs up, space, PGs.
//   { kind: 'ceph', name, version, pools: [one pool of pools.js for the cluster], osds: { n, up, in }, mons }
import { tlsRequest } from './proxmox.js';
import { cephPool, poolMetrics } from './pools.js';

const ACCEPT = 'application/vnd.ceph.api.v1.0+json';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);

export async function readCeph(host) {
  const auth = await tlsRequest(host, 'POST', '/api/auth', { body: JSON.stringify({ username: host.token_id, password: host.secretPlain }),
    headers: { Accept: ACCEPT, 'Content-Type': 'application/json' } });
  if (auth.status === 404) throw new Error('no Ceph dashboard at this address - port 8443, module "dashboard" on?');
  if (auth.status === 400 || auth.status === 401) throw new Error('sign-in refused - user or password wrong');
  const token = parse(auth.text)?.token;
  if (auth.status >= 300 || !token) throw new Error(`sign-in failed (HTTP ${auth.status})`);
  const headers = { Accept: ACCEPT, Authorization: `Bearer ${token}` };
  try {
    const r = await tlsRequest(host, 'GET', '/api/health/minimal', { headers });
    if (r.status === 403) throw new Error('the user may not read the health - give it the role "read-only"');
    if (r.status !== 200) throw new Error(`/api/health/minimal: HTTP ${r.status}`);
    const s = parse(r.text);
    const c = cephPool(s, 'Ceph');
    if (!c) throw new Error('no health in the answer of the dashboard');
    const osds = Array.isArray(s.osd_map?.osds) ? s.osd_map.osds : [];
    return { kind: 'ceph', name: clip(host.name), version: '', pools: [c],
      osds: { n: osds.length, up: osds.filter((o) => o.up).length, in: osds.filter((o) => o.in).length },
      mons: Array.isArray(s.mon_status?.monmap?.mons) ? s.mon_status.monmap.mons.length : null,
      checks: Array.isArray(s.health?.checks) ? s.health.checks.slice(0, 20).map((x) => ({ type: clip(x.type, 60), severity: clip(x.severity, 20), text: clip(x.summary?.message, 300) })) : [] };
  } finally {
    await tlsRequest(host, 'POST', '/api/auth/logout', { headers, body: '' }).catch(() => {});
  }
}

export const cephMetrics = (d) => poolMetrics(d.pools);
