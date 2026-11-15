// Cloud accounts: Amazon Web Services, Microsoft Azure, Google Cloud - read through their own APIs with an account that
// may only read (nothing installed there). Every reader returns the shape of the hypervisors (guests = instances), plus
// what only a cloud has:
//   { kind, cloud: true, account, regions, nodes: [], storages: [],
//     guests:    [{ vmid, name, kind: 'vm', node, status, cpu, mem, size, check, checkText, events }],
//     databases: [{ id, name, engine, node, status, good, cpu, storagePct }],
//     balancers: [{ id, name, healthy, unhealthy, reasons }],                      (AWS target groups)
//     alarms:    [{ name, text, severity }],                                       (AWS CloudWatch, Azure Monitor)
//     resources: [{ name, type, state, text }],                                    (Azure Resource Health)
//     cost:      { month, amount, currency, lastMonth, lastAmount, at } | null,
//     missing:   ['ec2:DescribeInstances', …],   notes: ['Cloud SQL Admin API not enabled', …] }
//
// The secret only ever goes to the official addresses of the provider (fixed here, also for the "next page" links an
// answer brings): *.amazonaws.com, login.microsoftonline.com + management.azure.com, oauth2/compute/monitoring/
// sqladmin.googleapis.com - always with the normal certificate check (public CAs), never with a pinned or no check.
// Nothing else of WhatsOnMyNet reaches the internet because of this; it is only asked when a cloud account is entered.
import crypto from 'node:crypto';
import https from 'node:https';
import { HttpError, line, str } from './lib/http.js';
import { encrypt } from './lib/crypto.js';

export const CLOUD_KINDS = ['aws', 'azure', 'gcp', 'm365'];

const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, n);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, d = 0) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const COST_EVERY_MS = 12 * 3600 * 1000;
const MAX_METRIC_RESOURCES = 60;

// ---------------------------------------------------------------------------------------------- transport
// Hosts a secret may go to - checked before every request (the next-page links in an answer too)
const ALLOWED = {
  aws: /^[a-z0-9-]+(\.[a-z0-9-]+)?\.amazonaws\.com$/,
  azure: /^(login\.microsoftonline\.com|management\.azure\.com)$/,
  gcp: /^(oauth2|compute|monitoring|sqladmin)\.googleapis\.com$/,
  m365: /^(login\.microsoftonline\.com|graph\.microsoft\.com)$/,
};

function httpsTransport({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const data = body === null || body === undefined ? null : Buffer.from(body);
    let req;
    try {
      // the normal certificate check against the public CAs - a cloud API is never pinned or unchecked
      req = https.request(url, { method, timeout: 20000, agent: false, rejectUnauthorized: true, headers: { ...(data ? { 'Content-Length': data.length } : {}), ...headers } }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (d) => { size += d.length; if (size < 32 * 1024 * 1024) chunks.push(d); else res.destroy(new Error('answer too large')); });
        res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); });
        res.on('error', (e) => { clearTimeout(deadline); reject(e); });
      });
    } catch (e) { reject(e); return; }
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), 60000);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.end(data || undefined);
  });
}
let transport = httpsTransport;
/** Tests answer in place of the provider (the allowed hosts are still checked) */
export function setCloudTransport(fn) { transport = fn || httpsTransport; }

const NET_TEXT = { ENOTFOUND: 'name not found (DNS) - can WhatsOnMyNet reach the internet?', ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset',
  ETIMEDOUT: 'timeout - can WhatsOnMyNet reach the internet?', EAI_AGAIN: 'name not found (DNS) - can WhatsOnMyNet reach the internet?' };
async function request(kind, opts) {
  const u = new URL(opts.url);
  if (u.protocol !== 'https:' || !ALLOWED[kind].test(u.hostname)) throw new Error(`refused to send the account to ${u.hostname}`);
  // one more try for an overloaded provider (429, 5xx) or a short network hiccup
  for (let i = 0; ; i++) {
    let res;
    try { res = await transport(opts); } catch (e) {
      if (i === 0 && ['ECONNRESET', 'ETIMEDOUT'].includes(e.code)) { await sleep(1000); continue; }
      throw new Error(NET_TEXT[e.code] || (/certificate|self.signed|CERT_/i.test(`${e.code} ${e.message}`) ? `certificate of ${u.hostname} not trusted - is a proxy breaking up TLS?` : e.message));
    }
    if (i === 0 && (res.status === 429 || res.status >= 500 || /<Code>(Throttling|RequestLimitExceeded)<\/Code>/.test(res.text))) { await sleep(1500); continue; }
    return res;
  }
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/** A part of the account the read-only account may not see: noted, the rest is read */
class Denied extends Error { constructor(need) { super(`missing right: ${need}`); this.denied = need; } }
/** A service that is not switched on for the account (Google: API not enabled; Azure: provider not registered) */
class Unused extends Error { constructor(what) { super(what); this.unused = what; } }

/** Runs one part; missing rights and unused services are collected, everything else stops the whole poll */
async function part(out, fn) {
  try { return await fn(); } catch (e) {
    if (e.denied) { if (!out.missing.includes(e.denied)) out.missing.push(e.denied); return null; }
    if (e.unused) { if (!out.notes.includes(e.unused)) out.notes.push(e.unused); return null; }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------- small XML reader
const ENT = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };
const unesc = (s) => s.replace(/&(lt|gt|amp|apos|quot|#\d+|#x[0-9a-f]+);/gi, (m, e) => ENT[e.toLowerCase()]
  ?? (e[1] === 'x' || e[1] === 'X' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1)))));
/** XML → { name, children, text } of the top element (names without namespace prefix) */
export function parseXml(text) {
  const root = { name: '', children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of String(text).matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += unesc(m[6]);
    else if (m[3]) {
      const name = m[3].replace(/^[\w.-]+:/, '');
      if (m[2]) { if (stack.length > 1 && top.name === name) stack.pop(); continue; }
      const node = { name, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
      if (stack.length > 64) throw new Error('XML too deep');
    }
  }
  return root.children[0] || root;
}
/** All elements under `node` along a path like "reservationSet/item/instancesSet/item" */
export function xall(node, path) {
  let list = [node];
  for (const seg of path.split('/')) list = list.flatMap((n) => n.children.filter((c) => c.name === seg));
  return list;
}
export const xtext = (node, path) => (xall(node, path)[0]?.text ?? '').trim();

// ---------------------------------------------------------------------------------------------- AWS
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Signature Version 4: the headers to send (Authorization, x-amz-date) */
export function signV4({ method, url, headers = {}, body = '', region, service, key, secret, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host: u.host, 'x-amz-date': amzDate };
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(lower).sort();
  const query = [...u.searchParams].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, u.pathname || '/', query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), sha256(body || '')].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  return { ...headers, 'x-amz-date': amzDate, Authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const AWS_HOST = { ec2: 'ec2', monitoring: 'monitoring', rds: 'rds', elasticloadbalancing: 'elasticloadbalancing', sts: 'sts' };
const AWS_SIGNIN = /^(AuthFailure|InvalidClientTokenId|SignatureDoesNotMatch|IncompleteSignature|UnrecognizedClientException|InvalidAccessKeyId|MissingAuthenticationToken)$/;
const AWS_DENIED = /^(UnauthorizedOperation|AccessDenied|AccessDeniedException|AuthorizationError|UnauthorizedAccess)$/;

function awsError(res, need, region) {
  const x = res.text.trim().startsWith('<') ? parseXml(res.text) : null;
  const j = x ? null : parse(res.text, {});
  const code = x ? xtext(x, 'Errors/Error/Code') || xtext(x, 'Error/Code') : String(j.__type || j.code || '').split('#').pop();
  const message = x ? xtext(x, 'Errors/Error/Message') || xtext(x, 'Error/Message') : String(j.message || j.Message || '');
  if (AWS_SIGNIN.test(code)) return new Error(`sign-in refused - access key or secret wrong (${code})`);
  if (AWS_DENIED.test(code) || res.status === 403) return new Denied(need);
  if (code === 'OptInRequired') return new Error(`region ${region} is not enabled for this account`);
  return new Error(`${need}: ${code || `HTTP ${res.status}`}${message ? ` - ${clip(message, 200)}` : ''}`);
}

/** One call of an AWS Query API (form in, XML out) */
async function awsQuery(host, service, region, params, need) {
  const url = `https://${AWS_HOST[service]}.${region}.amazonaws.com/`;
  const body = Object.entries(params).map(([k, v]) => `${rfc3986(k)}=${rfc3986(String(v))}`).join('&');
  const headers = signV4({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body, region, service, key: host.token_id, secret: host.secretPlain });
  const res = await request('aws', { method: 'POST', url, headers, body });
  if (res.status !== 200) throw awsError(res, need, region);
  return parseXml(res.text);
}
/** Every page of a Query API answer: next(xml) gives the token for the next one, or '' */
async function awsPages(host, service, region, params, need, tokenParam, tokenPath, max = 20) {
  const pages = [];
  let token = '';
  for (let i = 0; i < max; i++) {
    const x = await awsQuery(host, service, region, token ? { ...params, [tokenParam]: token } : params, need);
    pages.push(x);
    token = xtext(x, tokenPath);
    if (!token) break;
  }
  return pages;
}

// RDS states in which the database answers (or is about to again by itself)
const RDS_GOOD = new Set(['available', 'backing-up', 'modifying', 'storage-optimization', 'maintenance', 'upgrading', 'configuring-enhanced-monitoring',
  'configuring-iam-database-auth', 'configuring-log-exports', 'renaming', 'rebooting', 'resetting-master-credentials', 'starting', 'creating', 'moving-to-vpc', 'converting-to-vpc']);
const EC2_STATE = { running: 'running', stopped: 'stopped', stopping: 'stopping', pending: 'starting', 'shutting-down': 'stopping' };

/** CloudWatch values of many resources in one go: [{ ns, name, dim, value, stat }] → value per index (newest point) */
async function awsMetrics(host, region, list) {
  const out = new Array(list.length).fill(null);
  const end = new Date(); const start = new Date(end.getTime() - 25 * 60 * 1000);
  for (let from = 0; from < list.length; from += 400) {
    const chunk = list.slice(from, from + 400);
    const p = { Action: 'GetMetricData', Version: '2010-08-01', StartTime: start.toISOString(), EndTime: end.toISOString(), ScanBy: 'TimestampDescending' };
    chunk.forEach((q, i) => {
      const b = `MetricDataQueries.member.${i + 1}`;
      Object.assign(p, { [`${b}.Id`]: `q${from + i}`, [`${b}.MetricStat.Metric.Namespace`]: q.ns, [`${b}.MetricStat.Metric.MetricName`]: q.name,
        [`${b}.MetricStat.Metric.Dimensions.member.1.Name`]: q.dim[0], [`${b}.MetricStat.Metric.Dimensions.member.1.Value`]: q.dim[1],
        [`${b}.MetricStat.Period`]: 300, [`${b}.MetricStat.Stat`]: q.stat || 'Average', [`${b}.ReturnData`]: 'true' });
    });
    for (const x of await awsPages(host, 'monitoring', region, p, 'cloudwatch:GetMetricData', 'NextToken', 'GetMetricDataResult/NextToken', 5)) {
      for (const r of xall(x, 'GetMetricDataResult/MetricDataResults/member')) {
        const i = Number(xtext(r, 'Id').slice(1));
        const v = num(xtext(r, 'Values/member'));
        if (Number.isInteger(i) && v !== null && out[i] === null) out[i] = v;
      }
    }
  }
  return out;
}

async function awsRegion(host, region, out) {
  const tag = (n, path) => xtext(n, path);
  // instances
  const guests = await part(out, async () => {
    const list = [];
    for (const x of await awsPages(host, 'ec2', region, { Action: 'DescribeInstances', Version: '2016-11-15', MaxResults: 1000 }, 'ec2:DescribeInstances', 'NextToken', 'nextToken')) {
      for (const i of xall(x, 'reservationSet/item/instancesSet/item')) {
        const state = tag(i, 'instanceState/name');
        if (state === 'terminated') continue;
        const id = tag(i, 'instanceId');
        const name = xall(i, 'tagSet/item').find((t) => tag(t, 'key') === 'Name');
        list.push({ vmid: clip(id, 64), name: clip(name ? tag(name, 'value') : id) || id, kind: 'vm', node: tag(i, 'placement/availabilityZone') || region,
          status: EC2_STATE[state] || state || 'unknown', cpu: null, mem: null, size: clip(tag(i, 'instanceType'), 40), check: null, checkText: '', events: 0 });
      }
    }
    return list;
  }) || [];
  // status checks of AWS (system and instance) and scheduled events (retirement, reboot for maintenance …)
  if (guests.length) {
    await part(out, async () => {
      const byId = new Map(guests.map((g) => [g.vmid, g]));
      for (const x of await awsPages(host, 'ec2', region, { Action: 'DescribeInstanceStatus', Version: '2016-11-15', IncludeAllInstances: 'true', MaxResults: 1000 }, 'ec2:DescribeInstanceStatus', 'NextToken', 'nextToken')) {
        for (const s of xall(x, 'instanceStatusSet/item')) {
          const g = byId.get(tag(s, 'instanceId'));
          if (!g || g.status !== 'running') continue;
          const sys = tag(s, 'systemStatus/status'); const inst = tag(s, 'instanceStatus/status');
          const bad = [sys === 'impaired' ? 'system check failed' : '', inst === 'impaired' ? 'instance check failed' : ''].filter(Boolean);
          g.check = bad.length ? 'impaired' : sys === 'ok' && inst === 'ok' ? 'ok' : 'pending';
          g.checkText = bad.join(', ');
          const events = xall(s, 'eventsSet/item').filter((e) => !/^\[Completed\]|^\[Canceled\]/i.test(tag(e, 'description')));
          g.events = events.length;
          if (events.length) g.eventText = clip(events.map((e) => `${tag(e, 'code')} ${tag(e, 'notBefore').slice(0, 10)}`).join(', '), 200);
        }
      }
    });
  }
  // databases
  const dbs = await part(out, async () => {
    const list = [];
    for (const x of await awsPages(host, 'rds', region, { Action: 'DescribeDBInstances', Version: '2014-10-31', MaxRecords: 100 }, 'rds:DescribeDBInstances', 'Marker', 'DescribeDBInstancesResult/Marker')) {
      for (const d of xall(x, 'DescribeDBInstancesResult/DBInstances/DBInstance')) {
        const status = tag(d, 'DBInstanceStatus');
        const engine = tag(d, 'Engine');
        list.push({ id: clip(tag(d, 'DBInstanceIdentifier'), 80), name: clip(tag(d, 'DBInstanceIdentifier'), 80), engine: clip(engine, 40), node: tag(d, 'AvailabilityZone') || region,
          status, good: RDS_GOOD.has(status), live: status === 'available', cpu: null, storagePct: null, noStorage: /^aurora/.test(engine), allocatedGb: /^aurora/.test(engine) ? null : num(tag(d, 'AllocatedStorage')) });
      }
    }
    return list;
  }) || [];
  // load balancers: per target group how many targets are healthy
  const balancers = await part(out, async () => {
    const list = [];
    for (const x of await awsPages(host, 'elasticloadbalancing', region, { Action: 'DescribeTargetGroups', Version: '2015-12-01', PageSize: 400 }, 'elasticloadbalancing:DescribeTargetGroups', 'Marker', 'DescribeTargetGroupsResult/NextMarker')) {
      for (const tg of xall(x, 'DescribeTargetGroupsResult/TargetGroups/member')) {
        if (!xall(tg, 'LoadBalancerArns/member').length) continue;
        list.push({ id: clip(tag(tg, 'TargetGroupArn'), 300), name: clip(tag(tg, 'TargetGroupName'), 80), node: region, healthy: 0, unhealthy: 0, reasons: [] });
      }
    }
    for (const b of list.slice(0, 50)) {
      const x = await awsQuery(host, 'elasticloadbalancing', region, { Action: 'DescribeTargetHealth', Version: '2015-12-01', TargetGroupArn: b.id }, 'elasticloadbalancing:DescribeTargetHealth');
      for (const t of xall(x, 'DescribeTargetHealthResult/TargetHealthDescriptions/member')) {
        const st = tag(t, 'TargetHealth/State');
        if (st === 'healthy') b.healthy++;
        else if (st === 'unhealthy' || st === 'unavailable') { b.unhealthy++; const r = tag(t, 'TargetHealth/Description') || tag(t, 'TargetHealth/Reason'); if (r && b.reasons.length < 3) b.reasons.push(clip(r, 120)); }
      }
    }
    return list.slice(0, 50);
  }) || [];
  // alarms the account already has in CloudWatch that are firing now
  const alarms = await part(out, async () => {
    const list = [];
    for (const x of await awsPages(host, 'monitoring', region, { Action: 'DescribeAlarms', Version: '2010-08-01', StateValue: 'ALARM', 'AlarmTypes.member.1': 'MetricAlarm', 'AlarmTypes.member.2': 'CompositeAlarm', MaxRecords: 100 },
      'cloudwatch:DescribeAlarms', 'NextToken', 'DescribeAlarmsResult/NextToken', 5)) {
      for (const a of [...xall(x, 'DescribeAlarmsResult/MetricAlarms/member'), ...xall(x, 'DescribeAlarmsResult/CompositeAlarms/member')]) {
        list.push({ name: clip(tag(a, 'AlarmName'), 120), text: clip(tag(a, 'StateReason'), 200), severity: '', node: region });
      }
    }
    return list;
  }) || [];
  // CPU of running instances, CPU and free space of databases
  const running = guests.filter((g) => g.status === 'running').slice(0, MAX_METRIC_RESOURCES);
  const live = dbs.filter((d) => d.live).slice(0, MAX_METRIC_RESOURCES);
  const q = [...running.map((g) => ({ ns: 'AWS/EC2', name: 'CPUUtilization', dim: ['InstanceId', g.vmid] })),
    ...live.map((d) => ({ ns: 'AWS/RDS', name: 'CPUUtilization', dim: ['DBInstanceIdentifier', d.id] })),
    ...live.map((d) => ({ ns: 'AWS/RDS', name: 'FreeStorageSpace', dim: ['DBInstanceIdentifier', d.id], stat: 'Minimum' }))];
  if (q.length) {
    const v = await part(out, () => awsMetrics(host, region, q));
    if (v) {
      running.forEach((g, i) => { g.cpu = round(v[i]); });
      live.forEach((d, i) => {
        d.cpu = round(v[running.length + i]);
        const free = v[running.length + live.length + i];
        if (free !== null && d.allocatedGb) d.storagePct = Math.max(0, Math.min(100, Math.round(100 - (free / (d.allocatedGb * 1024 ** 3)) * 100)));
      });
    }
  }
  out.guests.push(...guests); out.databases.push(...dbs); out.balancers.push(...balancers); out.alarms.push(...alarms);
}

const monthStart = (d, back = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)).toISOString().slice(0, 10);
/** Costs of this and the last month (Cost Explorer; AWS charges 0.01 USD per call - asked twice a day) */
async function awsCost(host) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10);
  const body = JSON.stringify({ TimePeriod: { Start: monthStart(now, 1), End: end }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'] });
  const url = 'https://ce.us-east-1.amazonaws.com/';
  const headers = signV4({ method: 'POST', url, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' }, body,
    region: 'us-east-1', service: 'ce', key: host.token_id, secret: host.secretPlain });
  const res = await request('aws', { method: 'POST', url, headers, body });
  if (res.status !== 200) throw awsError(res, 'ce:GetCostAndUsage', 'us-east-1');
  const j = parse(res.text, {});
  const rows = (j.ResultsByTime || []).map((r) => ({ start: r.TimePeriod?.Start, amount: num(r.Total?.UnblendedCost?.Amount), unit: r.Total?.UnblendedCost?.Unit }));
  const cur = rows.find((r) => r.start === monthStart(now)); const last = rows.find((r) => r.start === monthStart(now, 1));
  return { month: monthStart(now).slice(0, 7), amount: round(cur?.amount ?? 0, 2), currency: clip(cur?.unit || last?.unit || 'USD', 8),
    lastMonth: monthStart(now, 1).slice(0, 7), lastAmount: last ? round(last.amount, 2) : null, at: now.toISOString() };
}

const costDue = (prev, o) => o.costs && !(prev?.cost?.at && Date.now() - Date.parse(prev.cost.at) < COST_EVERY_MS && prev.cost.month === new Date().toISOString().slice(0, 7));
const keepCost = (prev, o) => (o.costs && prev?.cost?.month === new Date().toISOString().slice(0, 7) ? prev.cost : null);

function empty(kind, o) {
  return { kind, cloud: true, account: '', regions: o.regions || [], nodes: [], storages: [], guests: [], databases: [], balancers: [], alarms: [], resources: [], cost: null, missing: [], notes: [] };
}

export async function readAws(host, prev = {}) {
  const o = host.options || {};
  const out = empty('aws', o);
  const regions = o.regions?.length ? o.regions : ['eu-central-1'];
  // who am I - needs no right at all, so a wrong key is told at once and plainly
  const id = await awsQuery(host, 'sts', regions[0], { Action: 'GetCallerIdentity', Version: '2011-06-15' }, 'sts:GetCallerIdentity');
  out.account = clip(xtext(id, 'GetCallerIdentityResult/Account'), 20);
  for (const r of regions) await awsRegion(host, r, out);
  out.cost = costDue(prev, o) ? (await part(out, () => awsCost(host))) ?? keepCost(prev, o) : keepCost(prev, o);
  return finish(out);
}

// ---------------------------------------------------------------------------------------------- Azure
const ARM = 'https://management.azure.com';
async function azureToken(host, { kind = 'azure', scope = `${ARM}/.default` } = {}) {
  const o = host.options || {};
  const body = new URLSearchParams({ client_id: host.token_id, client_secret: host.secretPlain, scope, grant_type: 'client_credentials' }).toString();
  const res = await request(kind, { method: 'POST', url: `https://login.microsoftonline.com/${encodeURIComponent(o.tenant)}/oauth2/v2.0/token`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = parse(res.text, {});
  if (res.status === 200 && j.access_token) return j.access_token;
  const d = String(j.error_description || '');
  if (/AADSTS7000222/.test(d)) throw new Error('sign-in refused - the client secret has expired: make a new one in the app registration');
  if (/AADSTS7000215/.test(d)) throw new Error('sign-in refused - client secret wrong (use the secret value, not its ID)');
  if (/AADSTS700016/.test(d)) throw new Error('sign-in refused - no app with this application (client) ID in this tenant');
  if (/AADSTS90002|AADSTS900023/.test(d)) throw new Error('sign-in refused - tenant not found');
  throw new Error(`sign-in refused (${j.error || `HTTP ${res.status}`})`);
}

function azureError(res, need) {
  const e = parse(res.text, {}).error || {};
  const code = String(e.code || '');
  if (res.status === 401) return new Error(`sign-in refused (${code || 401})`);
  if (code === 'AuthorizationFailed' || res.status === 403) {
    const action = /action '([^']+)'/.exec(String(e.message || ''))?.[1];
    return new Denied(action || need);
  }
  if (code === 'MissingSubscriptionRegistration' || code === 'NoRegisteredProviderFound') return new Unused(`${need.split('/')[0]}: not in use in this subscription`);
  if (code === 'SubscriptionNotFound') return new Error('subscription not found - right ID, and may the app read it?');
  return new Error(`${need}: ${code || `HTTP ${res.status}`}${e.message ? ` - ${clip(e.message, 200)}` : ''}`);
}
async function azure(host, token, method, pathOrUrl, need, body = null) {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${ARM}${pathOrUrl}`;
  const res = await request('azure', { method, url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body });
  if (res.status !== 200) throw azureError(res, need);
  const j = parse(res.text, null);
  if (j === null) throw new Error(`${need}: answer is not JSON`);
  return j;
}
async function azureList(host, token, path, need, max = 20) {
  const items = [];
  let next = path;
  for (let i = 0; i < max && next; i++) {
    const j = await azure(host, token, 'GET', next, need);
    items.push(...(j.value || []));
    next = j.nextLink || '';
  }
  return items;
}
/** Newest average of each metric of one resource: { name: value } */
async function azureMetrics(host, token, id, names) {
  const end = new Date(); const start = new Date(end.getTime() - 30 * 60 * 1000);
  const q = new URLSearchParams({ 'api-version': '2023-10-01', metricnames: names.join(','), aggregation: 'Average', interval: 'PT5M', timespan: `${start.toISOString()}/${end.toISOString()}` });
  const j = await azure(host, token, 'GET', `${id}/providers/Microsoft.Insights/metrics?${q}`, 'Microsoft.Insights/metrics/read');
  const out = {};
  for (const m of j.value || []) {
    const pts = (m.timeseries?.[0]?.data || []).filter((p) => num(p.average) !== null);
    out[m.name?.value] = pts.length ? num(pts[pts.length - 1].average) : null;
  }
  return out;
}
const lc = (s) => String(s || '').toLowerCase();
const AZ_POWER = { running: 'running', deallocated: 'stopped', stopped: 'stopped', starting: 'starting', stopping: 'stopping', deallocating: 'stopping' };
// Azure SQL: Paused/AutoClosed = a serverless database asleep on purpose - fine
const AZ_SQL_GOOD = new Set(['online', 'paused', 'autoclosed', 'resuming', 'scaling', 'copying', 'creating', 'restoring', 'standby', 'onlinechangingdwperformancetiers', 'pausing']);
const AZ_FLEX_GOOD = new Set(['ready', 'starting', 'updating', 'provisioning']);

export async function readAzure(host, prev = {}) {
  const o = host.options || {};
  const out = empty('azure', o);
  const token = await azureToken(host);
  const sub = `/subscriptions/${encodeURIComponent(o.subscription)}`;
  const s = await azure(host, token, 'GET', `${sub}?api-version=2022-12-01`, 'Microsoft.Resources/subscriptions/read');
  out.account = clip(s.displayName || o.subscription, 80);
  if (s.state && s.state !== 'Enabled') out.alarms.push({ name: out.account, text: `subscription ${s.state}`, severity: 'Sev0' });
  // Resource Health: what Azure itself says about each resource (VM, database, load balancer, gateway …)
  const health = new Map();
  await part(out, async () => {
    for (const a of await azureList(host, token, `${sub}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2022-10-01`, 'Microsoft.ResourceHealth/availabilityStatuses/read')) {
      const orig = String(a.id || '').slice(0, lc(a.id).indexOf('/providers/microsoft.resourcehealth/') >>> 0);
      health.set(lc(orig), { id: orig, state: a.properties?.availabilityState || 'Unknown', text: clip(a.properties?.summary || a.properties?.reasonType || '', 200) });
    }
  });
  const used = new Set();
  // VMs
  const vms = await part(out, async () => (await azureList(host, token, `${sub}/providers/Microsoft.Compute/virtualMachines?api-version=2024-07-01&statusOnly=true`, 'Microsoft.Compute/virtualMachines/read'))
    .map((v) => {
      const power = (v.properties?.instanceView?.statuses || []).map((x) => String(x.code || '')).find((c) => c.startsWith('PowerState/'))?.slice(11) || '';
      const hh = health.get(lc(v.id));
      used.add(lc(v.id));
      const status = AZ_POWER[power] || power || 'unknown';
      return { vmid: clip(v.properties?.vmId || v.id, 64), rid: v.id, name: clip(v.name), kind: 'vm', node: clip(v.location, 40), status, cpu: null, mem: null,
        size: clip(v.properties?.hardwareProfile?.vmSize, 40), check: status !== 'running' || !hh || hh.state === 'Unknown' ? null : hh.state === 'Available' ? 'ok' : 'impaired',
        checkText: hh && hh.state !== 'Available' ? hh.text : '', events: 0 };
    })) || [];
  // databases: Azure SQL, PostgreSQL and MySQL flexible servers
  const dbs = [];
  await part(out, async () => {
    for (const srv of await azureList(host, token, `${sub}/providers/Microsoft.Sql/servers?api-version=2021-11-01`, 'Microsoft.Sql/servers/read')) {
      for (const d of await azureList(host, token, `${srv.id}/databases?api-version=2021-11-01`, 'Microsoft.Sql/servers/databases/read')) {
        if (lc(d.name) === 'master') continue;
        const status = String(d.properties?.status || 'Unknown');
        used.add(lc(d.id));
        dbs.push({ id: clip(d.id, 300), rid: d.id, name: clip(`${srv.name}/${d.name}`, 120), engine: 'Azure SQL', node: clip(d.location, 40), status, good: AZ_SQL_GOOD.has(lc(status)), cpu: null, storagePct: null, live: lc(status) === 'online' });
      }
    }
  });
  for (const [type, engine, ver] of [['Microsoft.DBforPostgreSQL', 'PostgreSQL', '2022-12-01'], ['Microsoft.DBforMySQL', 'MySQL', '2023-12-30']]) {
    await part(out, async () => {
      for (const d of await azureList(host, token, `${sub}/providers/${type}/flexibleServers?api-version=${ver}`, `${type}/flexibleServers/read`)) {
        const status = String(d.properties?.state || 'Unknown');
        used.add(lc(d.id));
        dbs.push({ id: clip(d.id, 300), rid: d.id, name: clip(d.name, 120), engine, node: clip(d.location, 40), status, good: AZ_FLEX_GOOD.has(lc(status)), cpu: null, storagePct: null, live: lc(status) === 'ready' });
      }
    });
  }
  // a database Azure itself reports as unavailable is not fine, whatever its own state says
  for (const d of dbs) { const hh = health.get(lc(d.rid)); if (hh && hh.state === 'Unavailable') { d.good = false; d.status = `${d.status} (${hh.text || 'unavailable'})`; } }
  // values: CPU of running VMs, CPU and used space of databases (one call each - capped)
  let budget = MAX_METRIC_RESOURCES;
  for (const v of vms.filter((x) => x.status === 'running')) {
    if (budget-- <= 0) break;
    const m = await part(out, () => azureMetrics(host, token, v.rid, ['Percentage CPU']));
    if (m) v.cpu = round(m['Percentage CPU'] ?? null);
  }
  for (const d of dbs.filter((x) => x.live)) {
    if (budget-- <= 0) break;
    const m = await part(out, () => azureMetrics(host, token, d.rid, ['cpu_percent', 'storage_percent']));
    if (m) { d.cpu = round(m.cpu_percent ?? null); d.storagePct = round(m.storage_percent ?? null); }
  }
  // fired alerts of Azure Monitor that nobody closed
  await part(out, async () => {
    for (const a of await azureList(host, token, `${sub}/providers/Microsoft.AlertsManagement/alerts?api-version=2019-05-05-preview&monitorCondition=Fired&timeRange=30d`, 'Microsoft.AlertsManagement/alerts/read', 5)) {
      const e = a.properties?.essentials || {};
      if (e.alertState === 'Closed') continue;
      out.alarms.push({ name: clip(e.alertRule ? String(e.alertRule).split('/').pop() : a.name, 120), text: clip([e.targetResourceName, e.description].filter(Boolean).join(': '), 200), severity: clip(e.severity, 8) });
    }
  });
  // every other resource Azure reports as degraded or unavailable (load balancers, gateways, storage …)
  for (const [rid, hh] of health) {
    if (used.has(rid) || !['Unavailable', 'Degraded'].includes(hh.state)) continue;
    // /subscriptions/…/resourceGroups/rg/providers/Microsoft.Network/loadBalancers/lb-web → Microsoft.Network/loadBalancers, lb-web
    const seg = hh.id.split('/');
    const at = seg.findIndex((x) => lc(x) === 'providers');
    const type = at < 0 ? '' : [seg[at + 1], ...seg.slice(at + 2, -1).filter((_, i) => i % 2 === 0)].join('/');
    out.resources.push({ name: clip(seg[seg.length - 1], 120), type: clip(type, 80), state: hh.state, text: hh.text });
  }
  out.guests = vms.map(({ rid, ...v }) => v);
  out.databases = dbs.map(({ rid, ...d }) => d);
  if (costDue(prev, o)) {
    out.cost = (await part(out, async () => {
      const q = (timeframe) => azure(host, token, 'POST', `${sub}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`, 'Microsoft.CostManagement/query/action',
        JSON.stringify({ type: 'ActualCost', timeframe, dataset: { granularity: 'None', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } } } }));
      const sum = (j) => {
        const cols = (j.properties?.columns || []).map((c) => lc(c.name));
        const row = j.properties?.rows?.[0] || [];
        return { amount: round(num(row[cols.indexOf('cost')]) ?? 0, 2), currency: clip(row[cols.indexOf('currency')] || '', 8) };
      };
      const cur = sum(await q('MonthToDate'));
      const last = sum(await q('TheLastMonth'));
      const now = new Date();
      return { month: monthStart(now).slice(0, 7), amount: cur.amount, currency: cur.currency || last.currency || 'EUR', lastMonth: monthStart(now, 1).slice(0, 7), lastAmount: last.amount, at: now.toISOString() };
    })) ?? keepCost(prev, o);
  } else out.cost = keepCost(prev, o);
  return finish(out);
}

// ---------------------------------------------------------------------------------------------- Google Cloud
const b64u = (b) => Buffer.from(b).toString('base64url');
async function gcpToken(host) {
  const key = parse(host.secretPlain, {});
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform.read-only', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  let sig;
  try { sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key.private_key).toString('base64url'); } catch { throw new Error('the private key of the service account cannot be read - paste the JSON key again'); }
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }).toString();
  const res = await request('gcp', { method: 'POST', url: 'https://oauth2.googleapis.com/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = parse(res.text, {});
  if (res.status === 200 && j.access_token) return j.access_token;
  if (j.error === 'invalid_grant') throw new Error(`sign-in refused - the key was deleted or the service account disabled (${clip(j.error_description, 120)})`);
  throw new Error(`sign-in refused (${j.error || `HTTP ${res.status}`})`);
}
function gcpError(res, need, service) {
  const e = parse(res.text, {}).error || {};
  const reasons = (e.details || []).map((d) => d.reason).filter(Boolean);
  if (reasons.includes('SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(String(e.message || ''))) return new Unused(`${service} API not enabled in the project`);
  if (res.status === 401) return new Error('sign-in refused (401)');
  if (res.status === 403 || e.status === 'PERMISSION_DENIED') return new Denied(need);
  if (res.status === 404) return new Error('project not found - right project ID?');
  return new Error(`${need}: ${e.status || `HTTP ${res.status}`}${e.message ? ` - ${clip(e.message, 200)}` : ''}`);
}
async function gcp(token, url, need, service) {
  const res = await request('gcp', { method: 'GET', url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status !== 200) throw gcpError(res, need, service);
  const j = parse(res.text, null);
  if (j === null) throw new Error(`${need}: answer is not JSON`);
  return j;
}
async function gcpPages(token, url, need, service, take, max = 20) {
  let pageToken = '';
  for (let i = 0; i < max; i++) {
    const j = await gcp(token, pageToken ? `${url}${url.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(pageToken)}` : url, need, service);
    take(j);
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
}
/** Newest value of a Cloud Monitoring metric per resource: label value → number */
async function gcpSeries(token, project, type, label) {
  const end = new Date(); const start = new Date(end.getTime() - 25 * 60 * 1000);
  const q = new URLSearchParams({ filter: `metric.type="${type}"`, 'interval.startTime': start.toISOString(), 'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': '300s', 'aggregation.perSeriesAligner': 'ALIGN_MEAN' });
  const out = new Map();
  await gcpPages(token, `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${q}`, 'monitoring.timeSeries.list', 'Cloud Monitoring', (j) => {
    for (const s of j.timeSeries || []) {
      const v = s.points?.[0]?.value; const x = num(v?.doubleValue ?? v?.int64Value);
      if (x !== null) out.set(String(s.resource?.labels?.[label] ?? ''), x);
    }
  }, 5);
  return out;
}
const GCE_STATE = { RUNNING: 'running', TERMINATED: 'stopped', STOPPED: 'stopped', SUSPENDED: 'paused', STOPPING: 'stopping', SUSPENDING: 'stopping', PROVISIONING: 'starting', STAGING: 'starting', REPAIRING: 'running' };
const last = (u) => String(u || '').split('/').pop();

export async function readGcp(host) {
  const o = host.options || {};
  const out = empty('gcp', o);
  const project = o.project;
  out.account = clip(project, 40);
  const token = await gcpToken(host);
  const p = encodeURIComponent(project);
  const guests = [];
  await part(out, () => gcpPages(token, `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/instances?maxResults=500`, 'compute.instances.list', 'Compute Engine', (j) => {
    for (const zone of Object.values(j.items || {})) {
      for (const i of zone.instances || []) {
        const status = GCE_STATE[i.status] || lc(i.status) || 'unknown';
        guests.push({ vmid: clip(i.id, 64), name: clip(i.name), kind: 'vm', node: clip(last(i.zone), 40), status, cpu: null, mem: null, size: clip(last(i.machineType), 40),
          // REPAIRING: Google is moving or repairing the VM after a host failure
          check: i.status === 'REPAIRING' ? 'impaired' : status === 'running' ? 'ok' : null, checkText: i.status === 'REPAIRING' ? 'Google is repairing the VM' : '', events: 0 });
      }
    }
  }));
  const dbs = [];
  await part(out, () => gcpPages(token, `https://sqladmin.googleapis.com/v1/projects/${p}/instances`, 'cloudsql.instances.list', 'Cloud SQL Admin', (j) => {
    for (const d of j.items || []) {
      const off = d.settings?.activationPolicy === 'NEVER';
      const state = off ? 'STOPPED' : String(d.state || 'UNKNOWN_STATE');
      dbs.push({ id: clip(d.name, 100), name: clip(d.name, 100), engine: clip(d.databaseVersion, 40), node: clip(d.region || d.gceZone, 40), status: lc(state),
        good: ['RUNNABLE', 'MAINTENANCE', 'PENDING_CREATE'].includes(state), live: state === 'RUNNABLE', cpu: null, storagePct: null });
    }
  }));
  if (guests.some((g) => g.status === 'running')) {
    const cpu = await part(out, () => gcpSeries(token, project, 'compute.googleapis.com/instance/cpu/utilization', 'instance_id'));
    if (cpu) for (const g of guests) if (g.status === 'running' && cpu.has(g.vmid)) g.cpu = round(cpu.get(g.vmid) * 100);
  }
  if (dbs.some((d) => d.live)) {
    const cpu = await part(out, () => gcpSeries(token, project, 'cloudsql.googleapis.com/database/cpu/utilization', 'database_id'));
    const disk = await part(out, () => gcpSeries(token, project, 'cloudsql.googleapis.com/database/disk/utilization', 'database_id'));
    for (const d of dbs) {
      const k = `${project}:${d.id}`;
      if (cpu?.has(k)) d.cpu = round(cpu.get(k) * 100);
      if (disk?.has(k)) d.storagePct = round(disk.get(k) * 100);
    }
  }
  out.guests = guests; out.databases = dbs;
  return finish(out);
}

function finish(out) {
  const by = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
  out.guests = out.guests.slice(0, 5000).sort(by);
  out.databases = out.databases.slice(0, 1000).sort(by);
  out.balancers = out.balancers.sort(by);
  out.alarms = out.alarms.slice(0, 200);
  out.resources = out.resources.slice(0, 200);
  out.missing.sort();
  return out;
}

// ---------------------------------------------------------------------------------------------- Microsoft 365
// Microsoft Graph with an app registration (application permissions ServiceHealth.Read.All, Organization.Read.All):
// the health of the services (Exchange, Teams, SharePoint …), open incidents, the subscriptions and their licences.
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SERVICE_BAD = new Set(['serviceDegradation', 'serviceInterruption', 'extendedRecovery', 'restoringService', 'investigating', 'confirmed', 'reported', 'verifyingService']);
// The usual subscriptions in words (the rest keeps its part number)
const SKU_NAMES = { ENTERPRISEPACK: 'Office 365 E3', STANDARDPACK: 'Office 365 E1', ENTERPRISEPREMIUM: 'Office 365 E5', SPE_E3: 'Microsoft 365 E3', SPE_E5: 'Microsoft 365 E5',
  SPB: 'Microsoft 365 Business Premium', O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard', O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  O365_BUSINESS: 'Microsoft 365 Apps for business', OFFICESUBSCRIPTION: 'Microsoft 365 Apps for enterprise', EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)', STANDARDWOFFPACK_FACULTY: 'Office 365 A1 (faculty)', STANDARDWOFFPACK_STUDENT: 'Office 365 A1 (students)',
  M365EDU_A3_FACULTY: 'Microsoft 365 A3 (faculty)', M365EDU_A3_STUDENT: 'Microsoft 365 A3 (students)', M365EDU_A5_FACULTY: 'Microsoft 365 A5 (faculty)',
  ENTERPRISEPACK_FACULTY: 'Office 365 A3 (faculty)', POWER_BI_STANDARD: 'Power BI (free)', POWER_BI_PRO: 'Power BI Pro', FLOW_FREE: 'Power Automate (free)',
  TEAMS_EXPLORATORY: 'Teams Exploratory', PROJECTPROFESSIONAL: 'Project Plan 3', VISIOCLIENT: 'Visio Plan 2', EMS: 'Enterprise Mobility + Security E3' };

function graphError(res, need) {
  const e = parse(res.text, {}).error || {};
  if (res.status === 401) return new Error(`sign-in refused (${e.code || 401})`);
  if (res.status === 403) return new Denied(need);
  return new Error(`${need}: ${e.code || `HTTP ${res.status}`}${e.message ? ` - ${clip(e.message, 200)}` : ''}`);
}
async function graph(token, path, need) {
  const items = [];
  let next = `${GRAPH}${path}`;
  for (let i = 0; i < 20 && next; i++) {
    const res = await request('m365', { method: 'GET', url: next, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (res.status !== 200) throw graphError(res, need);
    const j = parse(res.text, null);
    if (!j) throw new Error(`${need}: answer is not JSON`);
    if (!Array.isArray(j.value)) return j;
    items.push(...j.value);
    next = j['@odata.nextLink'] || '';
  }
  return items;
}

export async function readM365(host) {
  const o = host.options || {};
  const out = { ...empty('m365', o), services: [], issues: [], licenses: [] };
  const token = await azureToken(host, { kind: 'm365', scope: 'https://graph.microsoft.com/.default' });
  out.account = clip(o.tenant, 80);
  await part(out, async () => {
    const org = await graph(token, '/organization?$select=displayName', 'Organization.Read.All');
    out.account = clip(org[0]?.displayName || o.tenant, 80);
  });
  await part(out, async () => {
    out.services = (await graph(token, '/admin/serviceAnnouncement/healthOverviews', 'ServiceHealth.Read.All'))
      .map((s) => ({ id: clip(s.id, 60), name: clip(s.service, 80), status: clip(s.status, 40), good: !SERVICE_BAD.has(s.status) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  await part(out, async () => {
    out.issues = (await graph(token, "/admin/serviceAnnouncement/issues?$filter=isResolved eq false&$top=100", 'ServiceHealth.Read.All'))
      .map((i) => ({ id: clip(i.id, 30), title: clip(i.title, 200), service: clip(i.service, 80), status: clip(i.status, 40), kind: clip(i.classification, 20), start: i.startDateTime || null }))
      .sort((a, b) => String(b.start).localeCompare(String(a.start))).slice(0, 100);
  });
  await part(out, async () => {
    out.licenses = (await graph(token, '/subscribedSkus', 'Organization.Read.All')).map((s) => {
      const total = Number(s.prepaidUnits?.enabled) || 0; const used = Number(s.consumedUnits) || 0;
      return { id: clip(s.skuId, 40), sku: clip(s.skuPartNumber, 60), name: SKU_NAMES[s.skuPartNumber] || clip(s.skuPartNumber, 60), status: clip(s.capabilityStatus, 20),
        total, used, free: total - used, warning: Number(s.prepaidUnits?.warning) || 0, suspended: Number(s.prepaidUnits?.suspended) || 0 };
    }).filter((s) => s.total > 0 || s.status !== 'Enabled').sort((a, b) => a.name.localeCompare(b.name));
  });
  return finish(out);
}

export const CLOUD_READERS = { aws: readAws, azure: readAzure, gcp: readGcp, m365: readM365 };

// ---------------------------------------------------------------------------------------------- what a sensor can watch
export function cloudMetrics(data) {
  const out = [];
  if (data.kind === 'm365') {
    for (const s of data.services || []) out.push({ metric: 'm365Service', key: s.id, name: s.name, value: s.status, kind: 'state', good: s.good, text: s.status });
    out.push({ metric: 'm365Issues', key: '', name: '', value: (data.issues || []).filter((i) => i.kind === 'incident').length, unit: '', kind: 'number', op: 'gt', threshold: 0 });
    for (const l of data.licenses || []) {
      // Warning = runs out soon (grace period), Suspended/LockedOut = no longer usable
      out.push({ metric: 'm365Sku', key: l.id, name: l.name, value: l.status, kind: 'state', good: l.status === 'Enabled', text: l.status });
      out.push({ metric: 'm365Free', key: l.id, name: l.name, value: l.free, unit: '', kind: 'number', op: 'lt', threshold: 1 });
    }
    return out;
  }
  for (const g of data.guests || []) {
    const name = g.name;
    out.push({ metric: 'guestRunning', key: String(g.vmid), name, value: g.status, kind: 'state', node: g.node, cpu: g.cpu, mem: null });
    out.push({ metric: 'cloudCheck', key: String(g.vmid), name, value: g.check || (g.status === 'running' ? 'pending' : g.status), kind: 'state',
      good: g.status !== 'running' ? null : g.check !== 'impaired', text: g.checkText || g.check || '' });
    // a VM that does not run has no CPU value - that is no alarm (whether it should run, its own sensor says)
    out.push({ metric: 'cloudCpu', key: String(g.vmid), name, value: g.status === 'running' ? g.cpu ?? null : null, unit: '%', kind: 'number', op: 'ge', threshold: 90, idle: g.status !== 'running' });
  }
  for (const d of data.databases || []) {
    out.push({ metric: 'dbState', key: d.id, name: d.name, value: d.status, kind: 'state', good: !!d.good, text: d.status });
    out.push({ metric: 'dbCpu', key: d.id, name: d.name, value: d.live ? d.cpu ?? null : null, unit: '%', kind: 'number', op: 'ge', threshold: 90, idle: !d.live });
    // Aurora grows its storage by itself - there is no "full"
    if (!d.noStorage) out.push({ metric: 'dbStorage', key: d.id, name: d.name, value: d.live ? d.storagePct ?? null : null, unit: '%', kind: 'number', op: 'ge', threshold: 85, idle: !d.live });
  }
  for (const b of data.balancers || []) out.push({ metric: 'lbUnhealthy', key: b.id, name: b.name, value: b.unhealthy, unit: '', kind: 'number', op: 'gt', threshold: 0 });
  if (data.kind !== 'gcp') out.push({ metric: 'cloudAlarms', key: '', name: '', value: (data.alarms || []).length, unit: '', kind: 'number', op: 'gt', threshold: 0 });
  if (data.kind === 'azure') out.push({ metric: 'cloudResources', key: '', name: '', value: (data.resources || []).length, unit: '', kind: 'number', op: 'gt', threshold: 0 });
  if (data.cost) {
    const limit = data.cost.lastAmount ? Math.ceil(data.cost.lastAmount * 1.2) : 100;
    out.push({ metric: 'costMonth', key: '', name: data.cost.currency, value: data.cost.amount, unit: data.cost.currency, kind: 'number', op: 'gt', threshold: limit });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- the form
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION = /^(us|eu|ap|sa|ca|me|af|il|mx)(-gov)?-[a-z]+-\d$/;
const list = (v) => (Array.isArray(v) ? v : String(str(v, 500)).split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
const bad = (code, field) => new HttpError(400, code, undefined, field);

/** The private key of a pasted Google service account key: { client_email, private_key, project_id } */
export function gcpKey(text) {
  const k = parse(String(text || '').trim(), null);
  if (!k || k.type !== 'service_account' || !/^[^@\s]+@[a-z0-9.-]+\.gserviceaccount\.com$/i.test(String(k.client_email || '')) || !/BEGIN PRIVATE KEY/.test(String(k.private_key || ''))) throw bad('err.cloudGcpKey', 'secret');
  try { crypto.createPrivateKey(k.private_key); } catch { throw bad('err.cloudGcpKey', 'secret'); }
  return { client_email: String(k.client_email), private_key: String(k.private_key), project_id: String(k.project_id || '') };
}

/** Checks the form of a cloud account: { token_id, secret, options } (secret encrypted). old: the stored row. */
export function cleanCloud(kind, input, old = null) {
  const prevOpt = old ? parse(old.options, {}) : {};
  const opt = { costs: input.costs === true || input.costs === 'on' || input.costs === 'true' };
  let tokenId; let secret = old?.secret || ''; let rebind = false;
  const typed = typeof input.secret === 'string' && input.secret.trim() ? input.secret.trim() : '';
  if (kind === 'aws') {
    tokenId = line(input.token_id, 40).toUpperCase();
    if (!/^AKIA[A-Z0-9]{16}$/.test(tokenId)) throw bad('err.cloudAwsKey', 'token_id');
    const regions = [...new Set(list(input.regions))];
    if (!regions.length || regions.length > 10 || !regions.every((r) => REGION.test(r))) throw bad('err.cloudRegions', 'regions');
    opt.regions = regions;
    if (typed && !/^[A-Za-z0-9/+]{40}$/.test(typed)) throw bad('err.cloudAwsSecret', 'secret');
    rebind = old && old.token_id !== tokenId;
  } else if (kind === 'azure' || kind === 'm365') {
    tokenId = line(input.token_id, 40).toLowerCase();
    if (!GUID.test(tokenId)) throw bad('err.cloudAzureClient', 'token_id');
    const tenant = line(input.tenant, 120).toLowerCase();
    if (!GUID.test(tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(tenant)) throw bad('err.cloudAzureTenant', 'tenant');
    if (kind === 'azure') {
      const subscription = line(input.subscription, 40).toLowerCase();
      if (!GUID.test(subscription)) throw bad('err.cloudAzureSub', 'subscription');
      Object.assign(opt, { tenant, subscription });
    } else Object.assign(opt, { tenant, costs: false });
    if (typed && (typed.length > 200 || !/^[\x21-\x7e]+$/.test(typed))) throw bad('err.cloudAzureSecret', 'secret');
    // the secret stays with the app and tenant it was entered for
    rebind = old && (old.token_id !== tokenId || prevOpt.tenant !== tenant);
  } else {
    if (typed) {
      const k = gcpKey(str(input.secret, 8000));
      tokenId = k.client_email;
      secret = encrypt(JSON.stringify({ client_email: k.client_email, private_key: k.private_key }));
      opt.project = line(input.project, 40).toLowerCase() || k.project_id;
    } else {
      tokenId = old?.token_id || '';
      opt.project = line(input.project, 40).toLowerCase() || prevOpt.project || '';
    }
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(opt.project)) throw bad('err.cloudProject', 'project');
    opt.costs = false;
    if (!secret) throw bad('err.cloudGcpKey', 'secret');
    return { token_id: tokenId, secret, options: JSON.stringify(opt) };
  }
  if (typed) secret = encrypt(typed);
  else if (rebind) throw bad('err.passwordAgain', 'secret');
  if (!secret) throw bad(kind === 'aws' ? 'err.cloudAwsSecret' : 'err.cloudAzureSecret', 'secret');
  return { token_id: tokenId, secret, options: JSON.stringify(opt) };
}
