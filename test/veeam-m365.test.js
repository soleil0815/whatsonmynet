// Veeam Backup & Replication (REST API, own certificate) and Microsoft 365 (Graph) against simulated servers:
// what is read, what alarms, wrong account, missing rights - and that the token goes nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, proxmoxMetrics } from '../src/proxmox.js';
import { proxmoxCheck } from '../src/monitor/sensors.js';
import { hostPicks } from '../src/monitor/autowatch.js';
import { setCloudTransport } from '../src/cloud.js';
import { checkText } from '../public/js/checktext.js';

const H = 3600 * 1000;
const check = (db, host, metric, key = '', op = '', threshold = '') => proxmoxCheck(db, { status: 'up', options: JSON.stringify({ host, metric, key, op, threshold, label: metric }) });

function fakeVeeam(state) {
  const dir = fs.mkdtempSync(path.join(tmp, 'vbr-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=vbr01',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const seen = [];
  const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const p = req.url.split('?')[0];
      seen.push(`${req.method} ${p} ${req.headers['x-api-version']}`);
      if (p === '/api/oauth2/token') {
        const f = new URLSearchParams(body);
        if (f.get('username') !== 'FIRMA\\womn-viewer' || f.get('password') !== 'Lese-Geheim') return json(res, { error: 'invalid_grant' }, 400);
        return json(res, { access_token: 'tok-123', token_type: 'bearer', expires_in: 900 });
      }
      if (p === '/api/oauth2/logout') { res.writeHead(200); return res.end(); }
      if (req.headers.authorization !== 'Bearer tok-123') return json(res, {}, 401);
      if (state.forbidden) return json(res, { errorCode: 'Forbidden' }, 403);
      if (p === '/api/v1/serverInfo') return json(res, { name: 'vbr01', buildVersion: '12.3.1.1139' });
      if (p === '/api/v1/jobs/states') {
        return json(res, { data: [
          { id: 'j1', name: 'Fileserver täglich', type: 'Backup', status: 'Inactive', lastResult: state.jobResult || 'Success', lastRun: new Date(Date.now() - 5 * H).toISOString(), nextRun: new Date(Date.now() + 19 * H).toISOString(), objectsCount: 3, repositoryName: 'Repo NAS' },
          { id: 'j2', name: 'SQL stündlich', type: 'Backup', status: 'Running', lastResult: 'Warning', lastRun: new Date(Date.now() - 40 * H).toISOString(), nextRun: new Date(Date.now() + H).toISOString(), repositoryName: 'Repo NAS' },
          { id: 'j3', name: 'Alt', type: 'Backup', status: 'Disabled', lastResult: 'Failed', lastRun: '2025-01-01T00:00:00Z', nextRun: null },
        ], pagination: { total: 3, count: 3, skip: 0, limit: 200 } });
      }
      if (p === '/api/v1/backupInfrastructure/repositories/states') {
        return json(res, { data: [{ id: 'r1', name: 'Repo NAS', type: 'Nfs', hostName: 'nas01', capacityGB: 1000, freeGB: 100, usedSpaceGB: 880 }], pagination: { total: 1 } });
      }
      return json(res, {}, 404);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `https://127.0.0.1:${srv.address().port}`, srv, seen })));
}

test('Veeam: jobs and repositories, last result and age alarm, disabled jobs stay quiet', async () => {
  const state = {};
  const f = await fakeVeeam(state);
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  try {
    const h = px.create({ name: 'VBR', kind: 'veeam', url: f.url, token_id: 'FIRMA\\womn-viewer', secret: 'Lese-Geheim', verify: false });
    const r = await px.poll(h.id);
    assert.equal(r.last_error, '');
    const d = r.data;
    assert.deepEqual([d.name, d.version], ['vbr01', '12.3.1.1139']);
    assert.deepEqual(d.jobs.map((j) => [j.name, j.status, j.result]), [['Alt', 'disabled', 'Failed'], ['Fileserver täglich', 'inactive', 'Success'], ['SQL stündlich', 'running', 'Warning']]);
    assert.deepEqual([d.repos[0].pct, Math.round(d.repos[0].total / 1024 ** 3)], [90, 1000]);
    assert.ok(f.seen.every((s) => / 1\.1-rev0$/.test(s)), 'API version sent with every request');
    assert.ok(f.seen.includes('POST /api/oauth2/logout 1.1-rev0'), 'the session is ended');
    assert.equal(check(db, h.id, 'jobResult', 'j1').ok, true);
    const warn = check(db, h.id, 'jobResult', 'j2');
    assert.deepEqual([warn.ok, warn.message], [false, 'jobResult: last run warning']);
    assert.equal(checkText(warn.message), 'jobResult: letzter Lauf mit Warnung');
    assert.equal(check(db, h.id, 'jobResult', 'j3').ok, true, 'a disabled job does not alarm');
    assert.equal(check(db, h.id, 'jobAge', 'j2', 'gt', 26).ok, false, '40 hours without a run');
    assert.equal(check(db, h.id, 'jobAge', 'j1', 'gt', 26).ok, true);
    assert.equal(proxmoxMetrics(d).some((x) => x.metric === 'jobAge' && x.key === 'j3'), false);
    assert.equal(check(db, h.id, 'repoUsed', 'r1', 'ge', 85).ok, false);
    assert.equal(check(db, h.id, 'jobsFailed', '', 'gt', 0).message, 'jobsFailed: 1 (> 0)');
    assert.deepEqual(hostPicks('veeam').map((x) => x[0]), ['jobsFailed', 'repoUsed']);
    state.jobResult = 'Failed';
    await px.poll(h.id);
    assert.equal(check(db, h.id, 'jobResult', 'j1').message, 'jobResult: last run failed');
    // wrong password, missing role
    px.update(h.id, { name: 'VBR', url: f.url, token_id: 'FIRMA\\womn-viewer', secret: 'falsch', verify: false });
    assert.match((await px.poll(h.id)).last_error, /user or password wrong/);
    px.update(h.id, { name: 'VBR', url: f.url, token_id: 'FIRMA\\womn-viewer', secret: 'Lese-Geheim', verify: false });
    state.forbidden = true;
    assert.match((await px.poll(h.id)).last_error, /Veeam Backup Viewer/);
  } finally { f.srv.close(); }
});

test('Microsoft 365: services, open incidents, subscriptions and free licences', async () => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  let scope = '';
  let svcStatus = 'serviceDegradation';
  setCloudTransport(async ({ url, headers, body }) => {
    const u = new URL(url);
    if (u.hostname === 'login.microsoftonline.com') { scope = new URLSearchParams(body).get('scope'); return { status: 200, headers: {}, text: JSON.stringify({ access_token: 'gtok' }) }; }
    assert.equal(u.hostname, 'graph.microsoft.com');
    assert.equal(headers.Authorization, 'Bearer gtok');
    const p = u.pathname.replace('/v1.0', '');
    const ok = (o) => ({ status: 200, headers: {}, text: JSON.stringify(o) });
    if (p === '/organization') return ok({ value: [{ displayName: 'Institut für Beispiele' }] });
    if (u.searchParams.get('$skiptoken')) return ok({ value: [] });
    if (p === '/admin/serviceAnnouncement/healthOverviews') {
      return ok({ value: [{ id: 'Exchange', service: 'Exchange Online', status: svcStatus }, { id: 'microsoftteams', service: 'Microsoft Teams', status: 'serviceOperational' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews?$skiptoken=2' });
    }
    if (p === '/admin/serviceAnnouncement/issues') {
      assert.equal(u.searchParams.get('$filter'), 'isResolved eq false');
      return ok({ value: [{ id: 'EX123456', title: 'Users cannot send mail', service: 'Exchange Online', status: 'serviceDegradation', classification: 'incident', startDateTime: '2026-11-15T07:00:00Z' },
        { id: 'TM98765', title: 'Delays in chat', service: 'Microsoft Teams', status: 'investigating', classification: 'advisory', startDateTime: '2026-11-15T06:00:00Z' }] });
    }
    if (p === '/subscribedSkus') {
      return ok({ value: [{ skuId: 's1', skuPartNumber: 'M365EDU_A3_FACULTY', capabilityStatus: 'Enabled', consumedUnits: 120, prepaidUnits: { enabled: 120, warning: 0, suspended: 0 } },
        { skuId: 's2', skuPartNumber: 'POWER_BI_PRO', capabilityStatus: 'Warning', consumedUnits: 3, prepaidUnits: { enabled: 5, warning: 5 } },
        { skuId: 's3', skuPartNumber: 'FLOW_FREE', capabilityStatus: 'Enabled', consumedUnits: 4, prepaidUnits: { enabled: 0 } }] });
    }
    return { status: 404, headers: {}, text: '{}' };
  });
  try {
    const h = px.create({ name: 'M365', kind: 'm365', token_id: '11111111-1111-4111-8111-111111111111', secret: 'Geheim~123', tenant: 'institut.onmicrosoft.com' });
    assert.deepEqual(h.options, { costs: false, tenant: 'institut.onmicrosoft.com' });
    const r = await px.poll(h.id);
    assert.equal(r.last_error, '');
    assert.equal(scope, 'https://graph.microsoft.com/.default');
    const d = r.data;
    assert.equal(d.account, 'Institut für Beispiele');
    assert.deepEqual(d.services.map((s) => [s.name, s.good]), [['Exchange Online', false], ['Microsoft Teams', true]]);
    assert.deepEqual(d.licenses.map((l) => [l.name, l.status, l.free]), [['Microsoft 365 A3 (faculty)', 'Enabled', 0], ['Power BI Pro', 'Warning', 2]]);
    assert.equal(check(db, h.id, 'm365Service', 'Exchange').ok, false);
    assert.equal(checkText(check(db, h.id, 'm365Service', 'Exchange').message), 'm365Service: eingeschränkt');
    assert.equal(check(db, h.id, 'm365Issues', '', 'gt', 0).ok, false, 'one open incident (advisories do not count)');
    assert.equal(check(db, h.id, 'm365Sku', 's2').ok, false, 'a subscription in its grace period alarms');
    assert.equal(check(db, h.id, 'm365Free', 's1', 'lt', 1).ok, false, 'no licence left');
    assert.deepEqual(hostPicks('m365').map((x) => x[0]), ['m365Issues', 'm365Sku']);
    svcStatus = 'serviceRestored';
    await px.poll(h.id);
    assert.equal(check(db, h.id, 'm365Service', 'Exchange').ok, true);
  } finally { setCloudTransport(null); }
});

test('Microsoft 365: a missing permission is named, the rest is read', async () => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  setCloudTransport(async ({ url }) => {
    const u = new URL(url);
    if (u.hostname === 'login.microsoftonline.com') return { status: 200, headers: {}, text: JSON.stringify({ access_token: 't' }) };
    if (/subscribedSkus|organization/.test(u.pathname)) return { status: 403, headers: {}, text: JSON.stringify({ error: { code: 'Authorization_RequestDenied' } }) };
    return { status: 200, headers: {}, text: JSON.stringify({ value: [] }) };
  });
  try {
    const h = px.create({ name: 'M365', kind: 'm365', token_id: '11111111-1111-4111-8111-111111111111', secret: 'x', tenant: '33333333-3333-4333-8333-333333333333' });
    const d = (await px.poll(h.id)).data;
    assert.deepEqual(d.missing, ['Organization.Read.All']);
    assert.equal(d.account, '33333333-3333-4333-8333-333333333333');
  } finally { setCloudTransport(null); }
});
