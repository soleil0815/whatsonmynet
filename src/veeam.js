// Veeam Backup & Replication 12 or newer, through its REST API (port 9419) with an account of the role
// "Veeam Backup Viewer" - read only. Jobs with their last result and next run, repositories with their space.
//   { kind: 'veeam', name, version, jobs: [{ id, name, type, status, result, lastRun, nextRun, objects, repo }],
//     repos: [{ id, name, type, host, total, used, free, pct, online }] }
// The certificate of the server is checked like with the hypervisors (fetched and confirmed, or a public CA).
import { tlsRequest } from './proxmox.js';

const API_VERSION = '1.1-rev0';  // VBR 12.0; newer servers keep answering it
const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const GB = 1024 ** 3;
const iso = (s) => { const t = Date.parse(s); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null; };

export async function readVeeam(host) {
  const base = { 'x-api-version': API_VERSION, Accept: 'application/json' };
  const body = new URLSearchParams({ grant_type: 'password', username: host.token_id, password: host.secretPlain }).toString();
  const tok = await tlsRequest(host, 'POST', '/api/oauth2/token', { body, headers: { ...base, 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (tok.status === 404) throw new Error('no Veeam REST API at this address - port 9419, Veeam Backup & Replication 12 or newer?');
  const t = parse(tok.text);
  if (tok.status === 400 || tok.status === 401) throw new Error(/version/i.test(t?.message || '') ? `API version refused: ${clip(t.message, 160)}` : 'sign-in refused - user or password wrong');
  if (tok.status !== 200 || !t?.access_token) throw new Error(`sign-in failed (HTTP ${tok.status})`);
  const auth = { ...base, Authorization: `Bearer ${t.access_token}` };
  const get = async (path) => {
    const r = await tlsRequest(host, 'GET', path, { headers: auth });
    if (r.status === 401) throw new Error('session refused (401)');
    if (r.status === 403) throw new Error('the account lacks rights - give it the role "Veeam Backup Viewer"');
    if (r.status !== 200) throw new Error(`${path.split('?')[0]}: HTTP ${r.status}`);
    const j = parse(r.text);
    if (!j) throw new Error('answer is not JSON');
    return j;
  };
  const all = async (path) => {
    const out = [];
    for (let skip = 0; skip < 5000; skip += 200) {
      const j = await get(`${path}?skip=${skip}&limit=200`);
      const list = Array.isArray(j.data) ? j.data : [];
      out.push(...list);
      if (list.length < 200 || (num(j.pagination?.total) !== null && out.length >= j.pagination.total)) break;
    }
    return out;
  };
  try {
    const info = await get('/api/v1/serverInfo').catch(() => ({}));
    const [jobs, repos] = await Promise.all([all('/api/v1/jobs/states'), all('/api/v1/backupInfrastructure/repositories/states')]);
    return {
      kind: 'veeam',
      name: clip(info.name, 120),
      version: clip(info.buildVersion, 40),
      jobs: jobs.map((j) => ({ id: clip(j.id, 64), name: clip(j.name), type: clip(j.type, 40), status: clip(j.status, 20).toLowerCase(), result: clip(j.lastResult || 'None', 20),
        lastRun: iso(j.lastRun), nextRun: iso(j.nextRun), objects: num(j.objectsCount), repo: clip(j.repositoryName, 80) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      repos: repos.map((r) => {
        const total = (num(r.capacityGB) || 0) * GB; const free = (num(r.freeGB) || 0) * GB;
        const used = num(r.usedSpaceGB) !== null ? num(r.usedSpaceGB) * GB : Math.max(0, total - free);
        return { id: clip(r.id, 64), name: clip(r.name), type: clip(r.type, 40), host: clip(r.hostName, 80), total, used, free, pct: total > 0 ? Math.min(100, Math.round(((total - free) / total) * 100)) : null,
          online: r.isOnline !== false };
      }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    };
  } finally {
    await tlsRequest(host, 'POST', '/api/oauth2/logout', { headers: auth, body: '' }).catch(() => {});
  }
}

const RESULT_GOOD = new Set(['success', 'none']);
/** What a sensor can watch on a Veeam server */
export function veeamMetrics(d) {
  const out = [];
  for (const j of d.jobs || []) {
    const off = j.status === 'disabled';
    const res = String(j.result).toLowerCase();
    out.push({ metric: 'jobResult', key: j.id, name: j.name, value: off ? 'disabled' : res, kind: 'state', good: off || RESULT_GOOD.has(res),
      text: off ? 'disabled' : res === 'none' ? 'not run yet' : `last run ${res}` });
    // a job with a schedule that has not run for long: it was stopped, or its schedule fails silently
    if (!off && j.nextRun) out.push({ metric: 'jobAge', key: j.id, name: j.name, value: j.lastRun ? Math.round((Date.now() - Date.parse(j.lastRun)) / 3600000) : null, unit: 'h', kind: 'number', op: 'gt', threshold: 26 });
  }
  for (const r of d.repos || []) out.push({ metric: 'repoUsed', key: r.id, name: r.name, value: r.online ? r.pct : null, unit: '%', kind: 'number', op: 'ge', threshold: 85, used: r.used, total: r.total });
  out.push({ metric: 'jobsFailed', key: '', name: '', value: (d.jobs || []).filter((j) => j.status !== 'disabled' && ['failed', 'warning'].includes(String(j.result).toLowerCase())).length, unit: '', kind: 'number', op: 'gt', threshold: 0 });
  return out;
}
