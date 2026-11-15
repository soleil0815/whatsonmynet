// Cloud accounts (AWS, Azure, Google Cloud) against simulated provider APIs: signature, what is read, what alarms,
// missing rights and unused services, and that the secret never goes anywhere but the provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { memoryDb } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, proxmoxMetrics } from '../src/proxmox.js';
import { proxmoxCheck } from '../src/monitor/sensors.js';
import { hostPicks } from '../src/monitor/autowatch.js';
import { signV4, parseXml, xall, xtext, setCloudTransport, cleanCloud, gcpKey } from '../src/cloud.js';
import { decrypt } from '../src/lib/crypto.js';

const AKEY = 'AKIAIOSFODNN7EXAMPLE';
const ASECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const xml = (root, inner) => `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>r1</requestId>${inner}</${root}>`;
const form = (body) => Object.fromEntries(new URLSearchParams(body || ''));
const res = (status, text) => ({ status, headers: {}, text: typeof text === 'string' ? text : JSON.stringify(text) });

test('Signature Version 4: the example of the AWS documentation', () => {
  const h = signV4({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: '', region: 'us-east-1', service: 'iam', key: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2015-08-30T12:36:00Z') });
  assert.equal(h.Authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

test('XML: namespaces, entities, CDATA, nested lists', () => {
  const x = parseXml('<?xml version="1.0"?><a:Resp xmlns:a="x"><list><item><n>1 &amp; 2</n></item><item><n><![CDATA[<3>]]></n></item><e/></list></a:Resp>');
  assert.equal(x.name, 'Resp');
  assert.deepEqual(xall(x, 'list/item').map((i) => xtext(i, 'n')), ['1 & 2', '<3>']);
  assert.equal(xtext(x, 'list/missing'), '');
});

// ------------------------------------------------------------------------------------------------- AWS
function fakeAws(state = {}) {
  const calls = [];
  return { calls, fn: async ({ url, headers, body }) => {
    const u = new URL(url);
    const p = form(body);
    calls.push({ host: u.hostname, action: p.Action || headers['x-amz-target'], auth: headers.Authorization });
    assert.match(headers.Authorization, new RegExp(`Credential=${AKEY}/\\d{8}/[a-z0-9-]+/[a-z0-9]+/aws4_request`));
    const svc = u.hostname.split('.')[0];
    if (state.badKey) return res(403, '<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error></ErrorResponse>');
    if (svc === 'sts') return res(200, '<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/womn</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>');
    if (svc === 'ec2' && p.Action === 'DescribeInstances') {
      if (!p.NextToken) return res(200, xml('DescribeInstancesResponse', `<reservationSet><item><instancesSet>
        <item><instanceId>i-0aaa</instanceId><instanceState><code>16</code><name>running</name></instanceState><instanceType>t3.medium</instanceType><placement><availabilityZone>eu-central-1a</availabilityZone></placement>
          <tagSet><item><key>env</key><value>prod</value></item><item><key>Name</key><value>web01</value></item></tagSet></item>
        <item><instanceId>i-0bbb</instanceId><instanceState><name>stopped</name></instanceState><instanceType>t3.small</instanceType><placement><availabilityZone>eu-central-1b</availabilityZone></placement></item>
        </instancesSet></item></reservationSet><nextToken>page2</nextToken>`));
      return res(200, xml('DescribeInstancesResponse', `<reservationSet><item><instancesSet>
        <item><instanceId>i-0ccc</instanceId><instanceState><name>terminated</name></instanceState></item>
        <item><instanceId>i-0ddd</instanceId><instanceState><name>running</name></instanceState><instanceType>m5.large</instanceType><placement><availabilityZone>eu-central-1a</availabilityZone></placement><tagSet><item><key>Name</key><value>db-proxy</value></item></tagSet></item>
        </instancesSet></item></reservationSet>`));
    }
    if (svc === 'ec2' && p.Action === 'DescribeInstanceStatus') {
      return res(200, xml('DescribeInstanceStatusResponse', `<instanceStatusSet>
        <item><instanceId>i-0aaa</instanceId><systemStatus><status>ok</status></systemStatus><instanceStatus><status>${state.impaired ? 'impaired' : 'ok'}</status></instanceStatus>
          <eventsSet><item><code>system-reboot</code><description>Scheduled reboot</description><notBefore>2026-11-20T02:00:00.000Z</notBefore></item></eventsSet></item>
        <item><instanceId>i-0ddd</instanceId><systemStatus><status>ok</status></systemStatus><instanceStatus><status>ok</status></instanceStatus></item>
        <item><instanceId>i-0bbb</instanceId><systemStatus><status>not-applicable</status></systemStatus><instanceStatus><status>not-applicable</status></instanceStatus></item>
        </instanceStatusSet>`));
    }
    if (svc === 'rds') {
      if (state.rdsDenied) return res(403, '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>User is not authorized to perform: rds:DescribeDBInstances</Message></Error></ErrorResponse>');
      return res(200, `<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances>
        <DBInstance><DBInstanceIdentifier>shop-db</DBInstanceIdentifier><DBInstanceStatus>available</DBInstanceStatus><Engine>mysql</Engine><AllocatedStorage>100</AllocatedStorage><AvailabilityZone>eu-central-1a</AvailabilityZone></DBInstance>
        <DBInstance><DBInstanceIdentifier>old-db</DBInstanceIdentifier><DBInstanceStatus>storage-full</DBInstanceStatus><Engine>postgres</Engine><AllocatedStorage>20</AllocatedStorage></DBInstance>
        <DBInstance><DBInstanceIdentifier>aurora-1</DBInstanceIdentifier><DBInstanceStatus>available</DBInstanceStatus><Engine>aurora-postgresql</Engine><AllocatedStorage>1</AllocatedStorage></DBInstance>
        </DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>`);
    }
    if (svc === 'elasticloadbalancing' && p.Action === 'DescribeTargetGroups') {
      return res(200, `<DescribeTargetGroupsResponse><DescribeTargetGroupsResult><TargetGroups>
        <member><TargetGroupArn>arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/web/abc</TargetGroupArn><TargetGroupName>web</TargetGroupName><LoadBalancerArns><member>arn:lb</member></LoadBalancerArns></member>
        <member><TargetGroupArn>arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/unused/def</TargetGroupArn><TargetGroupName>unused</TargetGroupName><LoadBalancerArns/></member>
        </TargetGroups></DescribeTargetGroupsResult></DescribeTargetGroupsResponse>`);
    }
    if (svc === 'elasticloadbalancing' && p.Action === 'DescribeTargetHealth') {
      assert.match(p.TargetGroupArn, /targetgroup\/web/);
      return res(200, `<DescribeTargetHealthResponse><DescribeTargetHealthResult><TargetHealthDescriptions>
        <member><Target><Id>i-0aaa</Id></Target><TargetHealth><State>healthy</State></TargetHealth></member>
        <member><Target><Id>i-0ddd</Id></Target><TargetHealth><State>${state.lbBad ? 'unhealthy' : 'healthy'}</State><Reason>Target.ResponseCodeMismatch</Reason><Description>Health checks failed with these codes: [502]</Description></TargetHealth></member>
        </TargetHealthDescriptions></DescribeTargetHealthResult></DescribeTargetHealthResponse>`);
    }
    if (svc === 'monitoring' && p.Action === 'DescribeAlarms') {
      assert.equal(p.StateValue, 'ALARM');
      return res(200, `<DescribeAlarmsResponse><DescribeAlarmsResult><MetricAlarms>${state.alarm ? '<member><AlarmName>shop-5xx</AlarmName><StateReason>Threshold Crossed: 1 datapoint [17.0] was greater than the threshold (5.0).</StateReason></member>' : ''}</MetricAlarms><CompositeAlarms/></DescribeAlarmsResult></DescribeAlarmsResponse>`);
    }
    if (svc === 'monitoring' && p.Action === 'GetMetricData') {
      const queries = Object.keys(p).filter((k) => /^MetricDataQueries\.member\.\d+\.Id$/.test(k)).map((k) => {
        const b = k.replace(/\.Id$/, '');
        return { id: p[k], name: p[`${b}.MetricStat.Metric.MetricName`], dim: p[`${b}.MetricStat.Metric.Dimensions.member.1.Value`] };
      });
      const v = (q) => ({ 'CPUUtilization|i-0aaa': state.cpu ?? 42.4, 'CPUUtilization|i-0ddd': 7.6, 'CPUUtilization|shop-db': 12, 'FreeStorageSpace|shop-db': 20 * 1024 ** 3 })[`${q.name}|${q.dim}`];
      return res(200, `<GetMetricDataResponse><GetMetricDataResult><MetricDataResults>${queries.map((q) => `<member><Id>${q.id}</Id><StatusCode>Complete</StatusCode><Timestamps/><Values>${v(q) === undefined ? '' : `<member>${v(q)}</member><member>1</member>`}</Values></member>`).join('')}</MetricDataResults></GetMetricDataResult></GetMetricDataResponse>`);
    }
    if (u.hostname === 'ce.us-east-1.amazonaws.com') {
      const j = JSON.parse(body);
      assert.equal(j.Granularity, 'MONTHLY');
      const now = new Date();
      const m = (back) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 10);
      return res(200, { ResultsByTime: [{ TimePeriod: { Start: m(1) }, Total: { UnblendedCost: { Amount: '250.4', Unit: 'USD' } } }, { TimePeriod: { Start: m(0) }, Total: { UnblendedCost: { Amount: '120.126', Unit: 'USD' } } }] });
    }
    return res(400, `<Response><Errors><Error><Code>InvalidAction</Code><Message>${p.Action}</Message></Error></Errors></Response>`);
  } };
}

function setup() {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  return { db, px };
}
const check = (db, host, metric, key = '', op = '', threshold = '', status = 'up') => proxmoxCheck(db, { status, options: JSON.stringify({ host, metric, key, op, threshold, label: metric }) });

test('AWS: instances, status checks, databases, load balancers, alarms, costs', async () => {
  const { db, px } = setup();
  const fake = fakeAws({ alarm: true, lbBad: true, impaired: true });
  setCloudTransport(fake.fn);
  try {
    const h = px.create({ name: 'AWS Produktion', kind: 'aws', token_id: AKEY.toLowerCase(), secret: ASECRET, regions: 'eu-central-1', costs: true });
    assert.equal(h.token_id, AKEY);
    assert.deepEqual(h.options, { costs: true, regions: ['eu-central-1'] });
    assert.equal(h.has_secret, true);
    assert.equal(JSON.stringify(h).includes(ASECRET), false, 'the secret never goes to the browser');
    const r = await px.poll(h.id);
    assert.equal(r.last_error, '');
    assert.equal(r.last_ok, true);
    const d = r.data;
    assert.equal(d.account, '123456789012');
    assert.deepEqual(d.guests.map((g) => [g.name, g.status, g.cpu, g.check]), [['db-proxy', 'running', 8, 'ok'], ['i-0bbb', 'stopped', null, null], ['web01', 'running', 42, 'impaired']]);
    assert.equal(d.guests.find((g) => g.name === 'web01').events, 1);
    assert.deepEqual(d.databases.map((x) => [x.name, x.good, x.cpu, x.storagePct]), [['aurora-1', true, null, null], ['old-db', false, null, null], ['shop-db', true, 12, 80]]);
    assert.deepEqual(d.balancers.map((b) => [b.name, b.healthy, b.unhealthy]), [['web', 1, 1]]);
    assert.match(d.balancers[0].reasons[0], /502/);
    assert.equal(d.alarms[0].name, 'shop-5xx');
    assert.equal(d.cost.amount, 120.13);
    assert.equal(d.cost.lastAmount, 250.4);
    assert.deepEqual(d.missing, []);
    // only AWS addresses, each request signed
    assert.ok(fake.calls.every((c) => /\.amazonaws\.com$/.test(c.host) && c.auth));

    // sensors
    const web = d.guests.find((g) => g.name === 'web01').vmid;
    assert.equal(check(db, h.id, 'guestRunning', web).ok, true);
    const c = check(db, h.id, 'cloudCheck', web);
    assert.equal(c.ok, false);
    assert.match(c.message, /instance check failed/);
    assert.equal(check(db, h.id, 'cloudCheck', 'i-0bbb').ok, true, 'a stopped VM has no check to fail');
    assert.equal(check(db, h.id, 'guestRunning', 'i-0bbb').ok, false);
    assert.equal(check(db, h.id, 'cloudCpu', 'i-0bbb', 'ge', 90).ok, true, 'no CPU while stopped is no alarm');
    assert.equal(check(db, h.id, 'cloudCpu', web, 'ge', 40).ok, false);
    assert.equal(check(db, h.id, 'dbState', 'old-db').ok, false);
    assert.equal(check(db, h.id, 'dbState', 'shop-db').ok, true);
    assert.equal(check(db, h.id, 'dbStorage', 'shop-db', 'ge', 85).ok, true);
    assert.equal(check(db, h.id, 'dbStorage', 'shop-db', 'ge', 75).ok, false);
    assert.equal(proxmoxMetrics(d).some((x) => x.metric === 'dbStorage' && x.key === 'aurora-1'), false, 'Aurora grows by itself');
    assert.equal(check(db, h.id, 'lbUnhealthy', d.balancers[0].id, 'gt', 0).ok, false);
    assert.equal(check(db, h.id, 'cloudAlarms', '', 'gt', 0).ok, false);
    const cost = proxmoxMetrics(d).find((x) => x.metric === 'costMonth');
    assert.equal(cost.threshold, 301, 'default limit: last month + 20 %');
    assert.equal(check(db, h.id, 'costMonth', '', 'gt', 100).ok, false);
    assert.match(check(db, h.id, 'costMonth', '', 'gt', 100).message, /120\.13 USD/);
    assert.equal(check(db, h.id, 'cloudCheck', 'i-gone').ok, false);
    // what is watched from the start
    assert.deepEqual(hostPicks('aws').map((x) => x[0]), ['cloudAlarms', 'cloudResources', 'cloudCheck', 'dbState', 'lbUnhealthy']);

    // costs are not asked again within 12 hours (Cost Explorer costs money per call)
    const before = fake.calls.filter((x) => /GetCostAndUsage/.test(x.action)).length;
    await px.poll(h.id);
    assert.equal(fake.calls.filter((x) => /GetCostAndUsage/.test(x.action)).length, before);
    assert.equal(px.get(h.id).data.cost.amount, 120.13, 'kept from the last time');
  } finally { setCloudTransport(null); }
});

test('AWS: a missing right is named, the rest is read; a wrong key stops with a plain message', async () => {
  const { db, px } = setup();
  setCloudTransport(fakeAws({ rdsDenied: true }).fn);
  try {
    const h = px.create({ name: 'AWS', kind: 'aws', token_id: AKEY, secret: ASECRET, regions: 'eu-central-1' });
    const d = (await px.poll(h.id)).data;
    assert.deepEqual(d.missing, ['rds:DescribeDBInstances']);
    assert.equal(d.guests.length, 3);
    assert.equal(d.cost, null, 'costs only when switched on');
    const m = check(db, h.id, 'dbState', 'shop-db');
    assert.equal(m.ok, false);
    assert.match(m.message, /lacks rights: rds:DescribeDBInstances/);
    setCloudTransport(fakeAws({ badKey: true }).fn);
    const r = await px.poll(h.id);
    assert.equal(r.last_ok, false);
    assert.match(r.last_error, /access key or secret wrong/);
    assert.match(check(db, h.id, 'guestRunning', 'i-0aaa').message, /access key or secret wrong/);
  } finally { setCloudTransport(null); }
});

test('Form: checked strictly; the secret stays with its key, is stored encrypted', () => {
  const { db, px } = setup();
  const err = (input) => { try { px.create({ name: 'x', ...input }); return null; } catch (e) { return e.code; } };
  assert.equal(err({ kind: 'aws', token_id: 'AKIA123', secret: ASECRET, regions: 'eu-central-1' }), 'err.cloudAwsKey');
  assert.equal(err({ kind: 'aws', token_id: AKEY, secret: 'short', regions: 'eu-central-1' }), 'err.cloudAwsSecret');
  assert.equal(err({ kind: 'aws', token_id: AKEY, secret: ASECRET, regions: 'eu-central-1, evil.com' }), 'err.cloudRegions');
  assert.equal(err({ kind: 'aws', token_id: AKEY, secret: ASECRET, regions: '' }), 'err.cloudRegions');
  assert.equal(err({ kind: 'aws', token_id: AKEY, regions: 'eu-central-1' }), 'err.cloudAwsSecret');
  assert.equal(err({ kind: 'azure', token_id: 'abc', secret: 's', tenant: 'firma.onmicrosoft.com', subscription: '00000000-0000-4000-8000-000000000001' }), 'err.cloudAzureClient');
  assert.equal(err({ kind: 'azure', token_id: '00000000-0000-4000-8000-000000000002', secret: 's', tenant: 'evil/../x', subscription: '00000000-0000-4000-8000-000000000001' }), 'err.cloudAzureTenant');
  assert.equal(err({ kind: 'gcp', secret: '{"type":"service_account"}', project: 'firma-prod-1' }), 'err.cloudGcpKey');
  const h = px.create({ name: 'AWS', kind: 'aws', token_id: AKEY, secret: ASECRET, regions: ['eu-central-1', 'EU-WEST-1', 'eu-central-1'] });
  assert.deepEqual(h.options.regions, ['eu-central-1', 'eu-west-1']);
  const row = db.prepare('SELECT secret FROM proxmox_hosts WHERE id=?').get(h.id);
  assert.equal(row.secret.includes(ASECRET), false);
  assert.equal(decrypt(row.secret), ASECRET);
  // another key without its secret: refused (the old secret would go out under a new name)
  assert.throws(() => px.update(h.id, { name: 'AWS', token_id: 'AKIAI44QH8DHBEXAMPLE', regions: 'eu-central-1' }), (e) => e.code === 'err.passwordAgain');
  // same key, other regions: keeps the secret
  assert.deepEqual(px.update(h.id, { name: 'AWS', token_id: AKEY, regions: 'eu-west-1' }).options.regions, ['eu-west-1']);
});

test('The secret only goes to the provider: links in an answer to other hosts are refused', async () => {
  const { px } = setup();
  const seen = [];
  setCloudTransport(async ({ url }) => {
    seen.push(new URL(url).hostname);
    if (url.includes('/oauth2/v2.0/token')) return res(200, { access_token: 'tok' });
    if (/\/subscriptions\/[^/]+\?/.test(url)) return res(200, { displayName: 'Prod', state: 'Enabled' });
    return res(200, { value: [], nextLink: 'https://evil.example.com/steal' });
  });
  try {
    const h = px.create({ name: 'Azure', kind: 'azure', token_id: '11111111-1111-4111-8111-111111111111', secret: 'Geheim~123', tenant: 'firma.onmicrosoft.com', subscription: '22222222-2222-4222-8222-222222222222' });
    const r = await px.poll(h.id);
    assert.equal(r.last_ok, false);
    assert.match(r.last_error, /refused to send the account to evil\.example\.com/);
    // only the two addresses of Azure were contacted - the link elsewhere never was
    assert.deepEqual([...new Set(seen)].sort(), ['login.microsoftonline.com', 'management.azure.com']);
  } finally { setCloudTransport(null); }
});

// ------------------------------------------------------------------------------------------------- Azure
test('Azure: VMs with Resource Health, databases, fired alerts, other broken resources, costs', async () => {
  const { db, px } = setup();
  const SUB = '/subscriptions/22222222-2222-4222-8222-222222222222';
  const vm1 = `${SUB}/resourceGroups/RG-WEB/providers/Microsoft.Compute/virtualMachines/vm-web`;
  const vm2 = `${SUB}/resourceGroups/rg-web/providers/Microsoft.Compute/virtualMachines/vm-batch`;
  const sql = `${SUB}/resourceGroups/rg-db/providers/Microsoft.Sql/servers/sql01`;
  const lb = `${SUB}/resourceGroups/rg-web/providers/Microsoft.Network/loadBalancers/lb-web`;
  let tokenBody = null;
  setCloudTransport(async ({ url, method, headers, body }) => {
    const u = new URL(url);
    if (u.hostname === 'login.microsoftonline.com') { tokenBody = form(body); assert.equal(u.pathname, '/firma.onmicrosoft.com/oauth2/v2.0/token'); return res(200, { access_token: 'tok', expires_in: 3599 }); }
    assert.equal(headers.Authorization, 'Bearer tok');
    const p = u.pathname;
    if (p === SUB) return res(200, { displayName: 'Produktion', state: 'Enabled' });
    if (p.endsWith('/availabilityStatuses')) {
      return res(200, { value: [
        { id: `${vm1.toLowerCase()}/providers/Microsoft.ResourceHealth/availabilityStatuses/current`, properties: { availabilityState: 'Degraded', summary: 'The host of the VM has a hardware problem' } },
        { id: `${vm2}/providers/Microsoft.ResourceHealth/availabilityStatuses/current`, properties: { availabilityState: 'Available' } },
        { id: `${lb}/providers/Microsoft.ResourceHealth/availabilityStatuses/current`, properties: { availabilityState: 'Unavailable', summary: 'No healthy backend' } },
      ] });
    }
    if (p.endsWith('/Microsoft.Compute/virtualMachines')) {
      assert.equal(u.searchParams.get('statusOnly'), 'true');
      return res(200, { value: [
        { id: vm1, name: 'vm-web', location: 'westeurope', properties: { vmId: 'aaaa-1', hardwareProfile: { vmSize: 'Standard_B2s' }, instanceView: { statuses: [{ code: 'ProvisioningState/succeeded' }, { code: 'PowerState/running' }] } } },
        { id: vm2, name: 'vm-batch', location: 'westeurope', properties: { vmId: 'aaaa-2', instanceView: { statuses: [{ code: 'PowerState/deallocated' }] } } },
      ] });
    }
    if (p.endsWith('/providers/Microsoft.Insights/metrics')) {
      const names = u.searchParams.get('metricnames').split(',');
      const v = { 'Percentage CPU': 63.2, cpu_percent: 5, storage_percent: 91.4 };
      return res(200, { value: names.map((n) => ({ name: { value: n }, timeseries: [{ data: [{ timeStamp: 't1', average: 1 }, { timeStamp: 't2', average: v[n] }, { timeStamp: 't3' }] }] })) });
    }
    if (p.endsWith('/Microsoft.Sql/servers')) return res(200, { value: [{ id: sql, name: 'sql01' }] });
    if (p === `${sql}/databases`) {
      return res(200, { value: [{ id: `${sql}/databases/master`, name: 'master', properties: { status: 'Online' } }, { id: `${sql}/databases/app`, name: 'app', location: 'westeurope', properties: { status: 'Online' } },
        { id: `${sql}/databases/sleepy`, name: 'sleepy', properties: { status: 'Paused' } }, { id: `${sql}/databases/broken`, name: 'broken', properties: { status: 'Inaccessible' } }] });
    }
    if (p.includes('DBforPostgreSQL')) return res(409, { error: { code: 'MissingSubscriptionRegistration', message: 'The subscription is not registered to use namespace Microsoft.DBforPostgreSQL' } });
    if (p.includes('DBforMySQL')) return res(403, { error: { code: 'AuthorizationFailed', message: "The client 'x' does not have authorization to perform action 'Microsoft.DBforMySQL/flexibleServers/read' over scope" } });
    if (p.endsWith('/Microsoft.AlertsManagement/alerts')) {
      return res(200, { value: [{ name: 'a1', properties: { essentials: { alertRule: `${SUB}/x/metricAlerts/cpu-high`, alertState: 'New', severity: 'Sev2', targetResourceName: 'vm-web' } } },
        { name: 'a2', properties: { essentials: { alertRule: 'closed-one', alertState: 'Closed' } } }] });
    }
    if (p.endsWith('/Microsoft.CostManagement/query')) {
      assert.equal(method, 'POST');
      const tf = JSON.parse(body).timeframe;
      return res(200, { properties: { columns: [{ name: 'Cost' }, { name: 'Currency' }], rows: [[tf === 'MonthToDate' ? 87.456 : 140, 'EUR']] } });
    }
    return res(404, { error: { code: 'NotFound', message: p } });
  });
  try {
    const h = px.create({ name: 'Azure', kind: 'azure', token_id: '11111111-1111-4111-8111-111111111111', secret: 'Geheim~123', tenant: 'Firma.onmicrosoft.com', subscription: '22222222-2222-4222-8222-222222222222', costs: 'on' });
    const r = await px.poll(h.id);
    assert.equal(r.last_error, '');
    assert.equal(tokenBody.client_secret, 'Geheim~123');
    assert.equal(tokenBody.scope, 'https://management.azure.com/.default');
    const d = r.data;
    assert.equal(d.account, 'Produktion');
    assert.deepEqual(d.guests.map((g) => [g.name, g.status, g.cpu, g.check]), [['vm-batch', 'stopped', null, null], ['vm-web', 'running', 63, 'impaired']]);
    assert.deepEqual(d.databases.map((x) => [x.name, x.good, x.cpu, x.storagePct]), [['sql01/app', true, 5, 91], ['sql01/broken', false, null, null], ['sql01/sleepy', true, null, null]]);
    assert.deepEqual(d.alarms.map((a) => a.name), ['cpu-high']);
    assert.deepEqual(d.resources.map((x) => [x.name, x.type, x.state]), [['lb-web', 'Microsoft.Network/loadBalancers', 'Unavailable']]);
    assert.deepEqual(d.missing, ['Microsoft.DBforMySQL/flexibleServers/read']);
    assert.equal(d.notes.length, 1);
    assert.deepEqual([d.cost.amount, d.cost.currency, d.cost.lastAmount], [87.46, 'EUR', 140]);
    const vm = d.guests.find((g) => g.name === 'vm-web').vmid;
    assert.match(check(db, h.id, 'cloudCheck', vm).message, /hardware problem/);
    assert.equal(check(db, h.id, 'dbState', d.databases.find((x) => x.name === 'sql01/sleepy').id).ok, true, 'a serverless database asleep is fine');
    assert.equal(check(db, h.id, 'dbStorage', d.databases.find((x) => x.name === 'sql01/app').id, 'ge', 85).ok, false);
    assert.equal(check(db, h.id, 'cloudResources', '', 'gt', 0).ok, false);
  } finally { setCloudTransport(null); }
});

test('Azure: an expired client secret is said plainly', async () => {
  const { px } = setup();
  setCloudTransport(async () => res(401, { error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys for app are expired.' }));
  try {
    const h = px.create({ name: 'Azure', kind: 'azure', token_id: '11111111-1111-4111-8111-111111111111', secret: 'alt', tenant: '33333333-3333-4333-8333-333333333333', subscription: '22222222-2222-4222-8222-222222222222' });
    assert.match((await px.poll(h.id)).last_error, /client secret has expired/);
  } finally { setCloudTransport(null); }
});

// ------------------------------------------------------------------------------------------------- Google Cloud
test('Google Cloud: signed sign-in, VMs with CPU, a service not switched on is a note', async () => {
  const { db, px } = setup();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = JSON.stringify({ type: 'service_account', project_id: 'firma-prod-1', client_email: 'womn@firma-prod-1.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  assert.equal(gcpKey(key).client_email, 'womn@firma-prod-1.iam.gserviceaccount.com');
  setCloudTransport(async ({ url, headers, body }) => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') {
      const [h, c, s] = form(body).assertion.split('.');
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), 'signed with the key of the service account');
      const claims = JSON.parse(Buffer.from(c, 'base64url'));
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform.read-only');
      assert.equal(claims.iss, 'womn@firma-prod-1.iam.gserviceaccount.com');
      return res(200, { access_token: 'gtok' });
    }
    assert.equal(headers.Authorization, 'Bearer gtok');
    if (u.hostname === 'compute.googleapis.com') {
      return res(200, { items: { 'zones/europe-west3-a': { instances: [
        { id: '111', name: 'web-1', status: 'RUNNING', zone: 'https://x/zones/europe-west3-a', machineType: 'https://x/machineTypes/e2-medium' },
        { id: '222', name: 'batch', status: 'TERMINATED', zone: 'https://x/zones/europe-west3-a', machineType: 'https://x/machineTypes/e2-small' },
        { id: '333', name: 'moved', status: 'REPAIRING', zone: 'https://x/zones/europe-west3-a' }] }, 'zones/us-east1-b': { warning: { code: 'NO_RESULTS_ON_PAGE' } } } });
    }
    if (u.hostname === 'sqladmin.googleapis.com') return res(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Cloud SQL Admin API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } });
    if (u.hostname === 'monitoring.googleapis.com') {
      assert.match(u.searchParams.get('filter'), /instance\/cpu\/utilization/);
      return res(200, { timeSeries: [{ resource: { labels: { instance_id: '111' } }, points: [{ value: { doubleValue: 0.274 } }, { value: { doubleValue: 0.9 } }] }] });
    }
    return res(404, {});
  });
  try {
    const h = px.create({ name: 'GCP', kind: 'gcp', secret: key, project: '' });
    assert.equal(h.options.project, 'firma-prod-1');
    assert.equal(h.token_id, 'womn@firma-prod-1.iam.gserviceaccount.com');
    assert.equal(JSON.stringify(h).includes('PRIVATE KEY'), false);
    const r = await px.poll(h.id);
    assert.equal(r.last_error, '');
    assert.deepEqual(r.data.guests.map((g) => [g.name, g.status, g.cpu, g.check]), [['batch', 'stopped', null, null], ['moved', 'running', null, 'impaired'], ['web-1', 'running', 27, 'ok']]);
    assert.deepEqual(r.data.notes, ['Cloud SQL Admin API not enabled in the project']);
    assert.deepEqual(r.data.missing, []);
    assert.equal(check(db, h.id, 'cloudCheck', '333').ok, false);
    assert.equal(proxmoxMetrics(r.data).some((x) => x.metric === 'cloudAlarms' || x.metric === 'costMonth'), false, 'Google: no alarms or costs to read');
    // editing without the key keeps it
    assert.equal(px.update(h.id, { name: 'GCP 2', project: 'firma-prod-1' }).has_secret, true);
  } finally { setCloudTransport(null); }
});

test('cleanCloud: Google key and project', () => {
  assert.throws(() => cleanCloud('gcp', { secret: 'not json', project: 'firma-prod-1' }), (e) => e.code === 'err.cloudGcpKey');
});

test('German alarms: the cloud messages are translated', async () => {
  const { checkText } = await import('../public/js/checktext.js');
  assert.equal(checkText('CPU web01: no value while it does not run'), 'CPU web01: kein Wert, solange sie nicht läuft');
  assert.equal(checkText('DB: not found - the account lacks rights: rds:DescribeDBInstances'), 'DB: nicht gefunden - dem Konto fehlen Rechte: rds:DescribeDBInstances');
  assert.equal(checkText('Prüfung web01: instance check failed'), 'Prüfung web01: Instanz-Prüfung fehlgeschlagen');
});
