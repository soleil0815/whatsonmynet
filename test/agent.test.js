import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startApp, tmp } from './helpers.js';
import { agentConfig, createClient } from '../src/agent.js';

test('agent configuration is checked', () => {
  assert.throws(() => agentConfig({ WOMN_AGENT_SERVER: 'http://x', WOMN_AGENT_TOKEN: 'a'.repeat(30) }), /https/);
  assert.throws(() => agentConfig({ WOMN_AGENT_SERVER: 'https://x:8743', WOMN_AGENT_TOKEN: 'short' }), /TOKEN/);
  assert.throws(() => agentConfig({ WOMN_AGENT_SERVER: 'https://x', WOMN_AGENT_TOKEN: 'a'.repeat(30), WOMN_AGENT_FINGERPRINT: 'AB:CD' }), /FINGERPRINT/);
  assert.equal(agentConfig({ WOMN_AGENT_SERVER: 'https://x/', WOMN_AGENT_TOKEN: 'a'.repeat(30), WOMN_AGENT_FINGERPRINT: 'ab:'.repeat(31) + 'ab' }).fingerprint.length, 64);
});

test('central side: token, own subnets only, jobs, nightly skip', async () => {
  const app = await startApp({ setupToken: 'agent-setup' });
  const { call, ctx } = app;
  try {
    await call('POST', '/api/setup', { code: 'agent-setup', username: 'admin', password: 'Admin-Passwort-1', email: 'a@x.de' });
    const loc = (await call('POST', '/api/locations', { name: 'Außenstelle', subnets: ['10.88.1.0/24'] })).data;
    await call('POST', '/api/locations', { name: 'Zentrale', subnets: ['10.88.0.0/24'] });
    const a = (await call('POST', '/api/agents', { name: 'Nord', location_id: loc.id })).data;
    assert.ok(a.token && a.token.length >= 40);
    assert.ok(!JSON.stringify((await call('GET', '/api/agents')).data).includes(a.token), 'token never listed');
    const raw = (method, p, body, token = a.token) => fetch(app.url + p, { method, headers: { Authorization: `Bearer ${token}`, 'X-WOMN-Request': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await raw('GET', '/api/agent/poll', null, 'x'.repeat(40))).status, 401);
    // scan from the central scan page → job for the agent, nothing scanned here
    const s = await call('POST', '/api/scans', { locationIds: [loc.id] });
    assert.deepEqual(s.data, { id: null, agentJobs: ['Nord'] });
    const poll = await (await raw('GET', '/api/agent/poll')).json();
    assert.deepEqual(poll.subnets, ['10.88.1.0/24']);
    assert.equal(poll.jobs.length, 1);
    assert.equal((await (await raw('GET', '/api/agent/poll')).json()).jobs.length, 0, 'a job is handed out once');
    const res = await (await raw('POST', '/api/agent/results', { kind: 'network', jobId: poll.jobs[0].id, startedAt: new Date().toISOString(), results: [
      { ip: '10.88.1.20', mac: 'AA:BB:CC:00:11:22', hostname: 'drucker-nord', vendor: 'HP', detected_type: 'printer', confidence: 0.8, facts: { ports: [9100] } },
      { ip: '10.88.0.5', mac: 'aa:bb:cc:00:11:33', detected_type: 'server' },
      { ip: '8.8.8.8' },
    ] })).json();
    assert.equal(res.accepted, 1);
    assert.equal(res.rejected, 2, 'addresses outside the agent location are refused');
    const scan = (await call('GET', `/api/scans/${res.scanId}`)).data;
    assert.equal(scan.user, 'agent:Nord');
    assert.equal(scan.results[0].status, 'new');
    assert.equal(scan.results[0].facts.agent, 'Nord');
    // known device takes over the new IP like with a local scan
    await call('POST', `/api/scans/${res.scanId}/adopt`, { ids: [scan.results[0].id] });
    const res2 = await (await raw('POST', '/api/agent/results', { kind: 'light', results: [{ ip: '10.88.1.21', mac: 'aa:bb:cc:00:11:22', facts: { light: true } }] })).json();
    assert.equal((await call('GET', `/api/scans/${res2.scanId}`)).data.results[0].status, 'changed');
    // the central nightly scan leaves the agent's subnets alone
    ctx.settings.set('lightscan.lastRun', '');
    let started = null;
    const orig = ctx.scanner.startLight;
    ctx.scanner.startLight = (t) => { started = t; return 1; };
    ctx.nightly.run();
    ctx.scanner.startLight = orig;
    assert.deepEqual(started.map((x) => x.cidr), ['10.88.0.0/24']);
    // switched off → no access
    await call('PUT', `/api/agents/${a.id}`, { name: 'Nord', location_id: loc.id, enabled: false });
    assert.equal((await raw('GET', '/api/agent/poll')).status, 401);
  } finally { await app.close(); }
});

test('agent client pins the certificate of the central server', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'pin-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=central',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  let sawToken = 0;
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    if (req.headers.authorization) sawToken++;
    res.setHeader('Content-Type', 'application/json'); res.end('{"jobs":[],"subnets":[]}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const fp = execFileSync('openssl', ['x509', '-in', path.join(dir, 'c.pem'), '-noout', '-fingerprint', '-sha256']).toString().split('=')[1].trim();
  const server = `https://127.0.0.1:${srv.address().port}`;
  const token = 't'.repeat(40);
  try {
    const ok = createClient(agentConfig({ WOMN_AGENT_SERVER: server, WOMN_AGENT_TOKEN: token, WOMN_AGENT_FINGERPRINT: fp }));
    assert.deepEqual((await ok.poll()).jobs, []);
    assert.equal(sawToken, 1);
    const wrong = createClient(agentConfig({ WOMN_AGENT_SERVER: server, WOMN_AGENT_TOKEN: token, WOMN_AGENT_FINGERPRINT: 'AB'.repeat(32) }));
    await assert.rejects(wrong.poll(), /fingerprint/);
    const noPin = createClient(agentConfig({ WOMN_AGENT_SERVER: server, WOMN_AGENT_TOKEN: token }));
    await assert.rejects(noPin.poll(), /self.signed|certificate/i);
    assert.equal(sawToken, 1, 'the token never reached an unverified server');
  } finally { srv.close(); }
});
