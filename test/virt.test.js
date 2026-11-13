// Hypervisors beside Proxmox: VMware (SOAP), XCP-ng (XAPI), Nutanix (Prism v2), oVirt (REST) against simulated APIs,
// Hyper-V/KVM host scripts that send on their own (token, merging of several nodes, offline after silence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, proxmoxMetrics } from '../src/proxmox.js';
import { parseObjects, cleanPush, mergePush, markStale, pushScript } from '../src/virt.js';
import { proxmoxCheck } from '../src/monitor/sensors.js';

const now = Math.floor(Date.now() / 1000);
const GiB = 1024 ** 3;

const SOAP = {
  RetrieveServiceContent: '<returnval><rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
    + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager></returnval>',
  CreateContainerView: '<returnval type="ContainerView">session[52]view-1</returnval>',
  RetrievePropertiesEx: '<returnval><token>page2</token>'
    + '<objects><obj type="HostSystem">host-10</obj>'
    + '<propSet><name>name</name><val xsi:type="xsd:string">esx01.firma.local</val></propSet>'
    + '<propSet><name>runtime.connectionState</name><val xsi:type="HostSystemConnectionState">connected</val></propSet>'
    + '<propSet><name>runtime.powerState</name><val xsi:type="HostSystemPowerState">poweredOn</val></propSet>'
    + '<propSet><name>summary.hardware.cpuMhz</name><val xsi:type="xsd:int">2000</val></propSet>'
    + '<propSet><name>summary.hardware.numCpuCores</name><val xsi:type="xsd:short">8</val></propSet>'
    + '<propSet><name>summary.hardware.memorySize</name><val xsi:type="xsd:long">68719476736</val></propSet>'
    + '<propSet><name>summary.quickStats.overallCpuUsage</name><val xsi:type="xsd:int">4000</val></propSet>'
    + '<propSet><name>summary.quickStats.overallMemoryUsage</name><val xsi:type="xsd:int">32768</val></propSet>'
    + '<propSet><name>summary.quickStats.uptime</name><val xsi:type="xsd:int">86400</val></propSet></objects>'
    + '<objects><obj type="VirtualMachine">vm-42</obj>'
    + '<propSet><name>name</name><val xsi:type="xsd:string">dc01 &amp; files</val></propSet>'
    + '<propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOn</val></propSet>'
    + '<propSet><name>runtime.host</name><val type="HostSystem" xsi:type="ManagedObjectReference">host-10</val></propSet>'
    + '<propSet><name>config.template</name><val xsi:type="xsd:boolean">false</val></propSet>'
    + '<propSet><name>summary.quickStats.overallCpuUsage</name><val xsi:type="xsd:int">500</val></propSet>'
    + '<propSet><name>runtime.maxCpuUsage</name><val xsi:type="xsd:int">4000</val></propSet>'
    + '<propSet><name>summary.quickStats.guestMemoryUsage</name><val xsi:type="xsd:int">2048</val></propSet>'
    + '<propSet><name>config.hardware.memoryMB</name><val xsi:type="xsd:int">8192</val></propSet></objects></returnval>',
  ContinueRetrievePropertiesEx: '<returnval><objects><obj type="VirtualMachine">vm-7</obj>'
    + '<propSet><name>name</name><val xsi:type="xsd:string">template-w2022</val></propSet>'
    + '<propSet><name>config.template</name><val xsi:type="xsd:boolean">true</val></propSet></objects>'
    + '<objects><obj type="Datastore">datastore-1</obj>'
    + '<propSet><name>summary.name</name><val xsi:type="xsd:string">vsan</val></propSet>'
    + '<propSet><name>summary.capacity</name><val xsi:type="xsd:long">1000000000000</val></propSet>'
    + '<propSet><name>summary.freeSpace</name><val xsi:type="xsd:long">250000000000</val></propSet></objects></returnval>',
};

function fakeHypervisors(dir) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=hv',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const seen = [];
  const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const p = req.url.split('?')[0];
      seen.push({ p, body, cookie: req.headers.cookie, auth: req.headers.authorization, version: req.headers.version });
      if (p === '/sdk') {
        const op = /<urn:(\w+)>/.exec(body)?.[1];
        if (op === 'Login') {
          if (!body.includes('<urn:userName>readonly@vsphere.local</urn:userName><urn:password>p&amp;w</urn:password>')) {
            res.writeHead(500); return res.end('<soapenv:Envelope><soapenv:Body><soapenv:Fault><faultstring>Cannot complete login due to an incorrect user name or password.</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>');
          }
          res.writeHead(200, { 'Set-Cookie': 'vmware_soap_session="abc"; Path=/; HttpOnly' });
          return res.end('<soapenv:Envelope><soapenv:Body><LoginResponse><returnval/></LoginResponse></soapenv:Body></soapenv:Envelope>');
        }
        if (op !== 'RetrieveServiceContent' && req.headers.cookie !== 'vmware_soap_session="abc"') { res.writeHead(500); return res.end('<faultstring>The session is not authenticated.</faultstring>'); }
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(`<soapenv:Envelope><soapenv:Body><${op}Response>${SOAP[op] || ''}</${op}Response></soapenv:Body></soapenv:Envelope>`);
      }
      if (p === '/jsonrpc') {
        const rq = JSON.parse(body);
        const R = {
          'session.login_with_password': rq.params[0] === 'root' && rq.params[1] === 'pw' ? 'OpaqueRef:s1' : null,
          'host.get_all_records': { 'OpaqueRef:h1': { name_label: 'xcp01', enabled: true, metrics: 'OpaqueRef:m1', other_config: { boot_time: String(now - 3600) } } },
          'host_metrics.get_all_records': { 'OpaqueRef:m1': { memory_total: 64 * GiB, memory_free: 16 * GiB, live: true } },
          'host_cpu.get_all_records': { a: { host: 'OpaqueRef:h1', utilisation: 0.2 }, b: { host: 'OpaqueRef:h1', utilisation: 0.4 } },
          'VM.get_all_records': { v1: { name_label: 'web01', uuid: 'u-1', power_state: 'Running', resident_on: 'OpaqueRef:h1' },
            v0: { name_label: 'Control domain', is_control_domain: true, power_state: 'Running' }, t: { name_label: 'tpl', is_a_template: true } },
          'SR.get_all_records': { s1: { name_label: 'Local storage', type: 'ext', content_type: 'user', physical_size: 1000 * GiB, physical_utilisation: 400 * GiB, shared: false },
            s2: { name_label: 'ISO', type: 'iso', content_type: 'iso', physical_size: 10 } },
          'PBD.get_all_records': { p1: { SR: 's1', host: 'OpaqueRef:h1' } },
          'session.logout': '',
        };
        if (rq.method === 'session.login_with_password' && !R[rq.method]) return json(res, { jsonrpc: '2.0', id: rq.id, error: { code: 1, message: 'SESSION_AUTHENTICATION_FAILED', data: ['root', 'Authentication failure'] } });
        if (rq.method !== 'session.login_with_password' && rq.params[0] !== 'OpaqueRef:s1') return json(res, { error: { message: 'SESSION_INVALID' } });
        return json(res, { jsonrpc: '2.0', id: rq.id, result: R[rq.method] });
      }
      if (req.headers.authorization !== `Basic ${Buffer.from('viewer:pw').toString('base64')}`) return json(res, {}, 401);
      if (p === '/api/nutanix/v2.0/hosts/') return json(res, { entities: [{ uuid: 'h-1', name: 'ntnx-a', state: 'NORMAL', memory_capacity_in_bytes: 256 * GiB, boot_time_in_usecs: (now - 7200) * 1e6, stats: { hypervisor_cpu_usage_ppm: '250000', hypervisor_memory_usage_ppm: '500000' } }] });
      if (p === '/api/nutanix/v2.0/vms/') return json(res, { entities: [{ uuid: 'v-1', name: 'sql01', power_state: 'on', host_uuid: 'h-1' }, { uuid: 'v-2', name: 'old', power_state: 'off' }] });
      if (p === '/api/nutanix/v2.0/storage_containers/') return json(res, { entities: [{ name: 'default', usage_stats: { 'storage.user_capacity_bytes': String(10 * GiB), 'storage.user_usage_bytes': String(9 * GiB) } }] });
      const st = (pairs) => ({ statistic: pairs.map(([name, datum]) => ({ name, values: { value: [{ datum }] } })) });
      if (p === '/ovirt-engine/api/hosts') return json(res, { host: [{ id: 'oh1', name: 'kvm-a', status: 'up', statistics: st([['cpu.current.user', 10], ['cpu.current.system', 5], ['memory.total', 100 * GiB], ['memory.used', 30 * GiB], ['boot.time', now - 60]]) }] });
      if (p === '/ovirt-engine/api/vms') return json(res, { vm: [{ id: 'ov1', name: 'app', status: 'up', host: { id: 'oh1' }, statistics: st([['cpu.current.guest', 7], ['memory.installed', 8 * GiB], ['memory.used', 2 * GiB]]) }] });
      if (p === '/ovirt-engine/api/storagedomains') return json(res, { storage_domain: [{ name: 'data1', type: 'data', used: String(70 * GiB), available: String(30 * GiB) }, { name: 'iso', type: 'iso', used: '1', available: '1' }] });
      return json(res, {}, 404);
    });
  });
  return { srv, seen };
}

test('parseObjects reads property values and references of a SOAP answer', () => {
  const objs = parseObjects(`<x>${SOAP.RetrievePropertiesEx}</x>`);
  assert.equal(objs.length, 2);
  assert.equal(objs[1].props.name, 'dc01 & files', 'XML entities decoded');
  assert.equal(objs[1].props['runtime.host'], 'host-10');
});

test('VMware, XCP-ng, Nutanix and oVirt: read through their API into the Proxmox shape', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'hv-'));
  const fake = fakeHypervisors(dir);
  await new Promise((r) => fake.srv.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${fake.srv.address().port}`;
  const ca = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  try {
    assert.throws(() => px.create({ name: 'x', kind: 'vmware', url, token_id: '', secret: 'pw', ca }), { code: 'err.virtUser' });

    const vm = await px.poll(px.create({ name: 'vcenter', kind: 'vmware', url, token_id: 'readonly@vsphere.local', secret: 'p&w', ca }).id);
    assert.equal(vm.last_ok, true, vm.last_error);
    assert.deepEqual(vm.data.nodes.map((n) => [n.name, n.online, n.cpu, n.mem, n.uptime]), [['esx01.firma.local', true, 25, 50, 86400]]);
    assert.deepEqual(vm.data.guests.map((g) => [g.name, g.node, g.status, g.cpu, g.mem]), [['dc01 & files', 'esx01.firma.local', 'running', 13, 25]], 'template left out, second page read');
    assert.deepEqual(vm.data.storages.map((s) => [s.name, s.pct]), [['vsan', 75]]);
    assert.ok(fake.seen.some((x) => x.p === '/sdk' && x.body.includes('<urn:Logout>')), 'signs out again');
    const wrong = await px.poll(px.create({ name: 'esx', kind: 'vmware', url, token_id: 'root', secret: 'nope', ca }).id);
    assert.equal(wrong.last_error, 'sign-in refused - user or password wrong');

    const xcp = await px.poll(px.create({ name: 'pool', kind: 'xcpng', url, token_id: 'root', secret: 'pw', ca }).id);
    assert.equal(xcp.last_ok, true, xcp.last_error);
    assert.deepEqual(xcp.data.nodes.map((n) => [n.name, n.cpu, n.mem]), [['xcp01', 30, 75]]);
    assert.ok(xcp.data.nodes[0].uptime >= 3600);
    assert.deepEqual(xcp.data.guests.map((g) => [g.name, g.status, g.node]), [['web01', 'running', 'xcp01']], 'no dom0, no templates');
    assert.deepEqual(xcp.data.storages.map((s) => [s.name, s.node, s.pct]), [['Local storage', 'xcp01', 40]], 'no ISO library');

    const ntnx = await px.poll(px.create({ name: 'prism', kind: 'nutanix', url, token_id: 'viewer', secret: 'pw', ca }).id);
    assert.equal(ntnx.last_ok, true, ntnx.last_error);
    assert.deepEqual(ntnx.data.nodes.map((n) => [n.name, n.cpu, n.mem]), [['ntnx-a', 25, 50]]);
    assert.deepEqual(ntnx.data.guests.map((g) => [g.name, g.status]), [['old', 'stopped'], ['sql01', 'running']]);
    assert.equal(ntnx.data.storages[0].pct, 90);

    const ov = await px.poll(px.create({ name: 'engine', kind: 'ovirt', url, token_id: 'viewer', secret: 'pw', ca }).id);
    assert.equal(ov.last_ok, true, ov.last_error);
    assert.deepEqual(ov.data.nodes.map((n) => [n.name, n.cpu, n.mem]), [['kvm-a', 15, 30]]);
    assert.deepEqual(ov.data.guests.map((g) => [g.name, g.cpu, g.mem]), [['app', 7, 25]]);
    assert.deepEqual(ov.data.storages.map((s) => [s.name, s.pct]), [['data1', 70]]);
    assert.equal(fake.seen.find((x) => x.p === '/ovirt-engine/api/hosts').version, '4');

    // Sensors work the same as for Proxmox (host online, CPU, storage, VM running) - no backup values outside Proxmox
    const m = proxmoxMetrics(vm.data);
    assert.deepEqual([...new Set(m.map((x) => x.metric))].sort(), ['guestRunning', 'nodeCpu', 'nodeMem', 'nodeOnline', 'storage']);
    const chk = proxmoxCheck(db, { options: JSON.stringify({ host: vm.id, metric: 'storage', key: '/vsan', op: 'ge', threshold: '70', label: 'vsan' }) });
    assert.equal(chk.ok, false);
    assert.equal(chk.data.v, 75);
    assert.ok(!JSON.stringify(px.list()).includes('p&w'), 'password never listed');
  } finally { fake.srv.close(); }
});

test('Hyper-V / KVM: the host sends with its token; several nodes merge; silence means offline', () => {
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  const hv = px.create({ name: 'Hyper-V Cluster', kind: 'hyperv', url: 'egal', token_id: 'egal' });
  assert.equal(hv.url, '', 'no address for a push host');
  assert.throws(() => px.push(hv.id, 'x'.repeat(40), {}), { code: 'err.unauthorized' }, 'no token yet');
  const { token, file, text } = px.newToken(hv.id, { server: 'https://womn.firma.local:8443', pin: { sha1: 'AB12' } });
  assert.equal(file, 'womn-hyperv.ps1');
  assert.ok(text.includes(`$Token = '${token}'`) && text.includes("'https://womn.firma.local:8443/api/proxmox/") && text.includes("$Thumb = 'AB12'"));
  assert.ok(!JSON.stringify(px.list()).includes(token), 'only the hash is stored');
  assert.throws(() => px.push(hv.id, `${token}x`, {}), { code: 'err.unauthorized' });
  assert.throws(() => px.newToken(hv.id, { server: 'javascript:alert(1)' }), { code: 'err.badRequest' });

  px.push(hv.id, token, { nodes: [{ name: 'HV1', cpu: 12, memUsed: 32 * GiB, memTotal: 128 * GiB, uptime: 999 }],
    guests: [{ vmid: 'a', name: 'dc01', status: 'running', cpu: 3, mem: 60 }, { name: '<b>x</b>'.repeat(50), status: 'evil' }],
    storages: [{ name: 'C:', used: 50, total: 100 }, { name: 'CSV1', node: '', used: 1, total: 4 }] });
  px.push(hv.id, token, { nodes: { name: 'HV2', cpu: 50, memUsed: 1, memTotal: 2 }, guests: [{ vmid: 'b', name: 'sql01', status: 'stopped' }], storages: [] });
  let h = px.get(hv.id);
  assert.equal(h.last_ok, true);
  assert.deepEqual(h.data.nodes.map((n) => [n.name, n.cpu, n.mem]), [['HV1', 12, 25], ['HV2', 50, 50]]);
  assert.deepEqual(h.data.guests.map((g) => [g.name.slice(0, 6), g.node, g.status]), [['<b>x</', 'HV1', 'unknown'], ['dc01', 'HV1', 'running'], ['sql01', 'HV2', 'stopped']]);
  assert.equal(h.data.guests[0].name.length, 120, 'cut to size');
  px.push(hv.id, token, { nodes: [{ name: 'HV2', cpu: 50, memUsed: 1, memTotal: 2 }], guests: [{ vmid: 'b', name: 'sql01', status: 'stopped' }], storages: [{ name: 'CSV1', node: '', used: 2, total: 4 }] });
  assert.deepEqual(px.get(hv.id).data.storages.map((x) => [x.name, x.node, x.pct]), [['C:', 'HV1', 50], ['CSV1', '', 50]], 'cluster volume once, not per node');
  // HV1 reports again without dc01: only its own part is replaced
  px.push(hv.id, token, { nodes: [{ name: 'HV1', cpu: 1, memUsed: 1, memTotal: 2 }], guests: [], storages: [] });
  assert.deepEqual(px.get(hv.id).data.guests.map((g) => g.name), ['sql01']);

  // 20 minutes of silence: offline, the sensor "host online" goes down
  const data = markStale(px.get(hv.id).data, 15, Date.now() + 20 * 60 * 1000);
  assert.deepEqual(data.nodes.map((n) => [n.online, n.stale]), [[false, true], [false, true]]);
  assert.throws(() => cleanPush({ nodes: [] }), /no node/);
  assert.deepEqual(mergePush('libvirt', {}, cleanPush({ nodes: [{ name: 'kvm1' }] })).nodes.map((n) => n.name), ['kvm1']);
});

test('KVM script: valid POSIX sh, reads virsh read-only and sends data the server accepts', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'kvm-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // virsh and curl as stand-ins: virsh answers like libvirt 9, curl keeps what it would send
  fs.writeFileSync(path.join(bin, 'virsh'), `#!/bin/sh
case "$*" in
  *"domstats --cpu-total"*) printf "Domain: 'web01'\\n  cpu.time=%s\\n\\nDomain: 'db \\"01\\"'\\n  cpu.time=5\\n" "$(date +%s)000000000" ;;
  *"list --all --uuid"*) printf 'aaaa-1\\nbbbb-2\\n' ;;
  *"domname aaaa-1"*) echo web01 ;;
  *"domname bbbb-2"*) echo 'db "01"' ;;
  *"domstate aaaa-1"*) echo running ;;
  *"domstate bbbb-2"*) echo 'shut off' ;;
  *"dommemstat aaaa-1"*) printf 'actual 4194304\\navailable 4000000\\nunused 1000000\\n' ;;
  *"pool-list --name"*) printf 'default\\nempty\\n' ;;
  *"pool-info default --bytes"*) printf 'Name:           default\\nCapacity:       2000398934016\\nAllocation:     1000199467008\\n' ;;
  *"pool-info empty --bytes"*) printf 'Capacity:       0\\n' ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/args"\ncat > "${dir}/body"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hostname'), '#!/bin/sh\necho kvm-host\n', { mode: 0o755 });
  const s = pushScript('libvirt', { server: 'https://womn:8443/', id: 7, token: "tok'en", pin: { spki: 'AAAA=' } });
  const file = path.join(dir, s.file);
  fs.writeFileSync(file, s.text);
  execFileSync('sh', ['-n', file]);
  execFileSync('sh', [file], { env: { PATH: `${bin}:/usr/bin:/bin` }, timeout: 15000 });
  const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
  assert.match(args, /-k --pinnedpubkey sha256\/\/AAAA=/);
  assert.match(args, /Authorization: Bearer tok'en/);
  assert.match(args, /https:\/\/womn:8443\/api\/proxmox\/7\/push/);
  const body = JSON.parse(fs.readFileSync(path.join(dir, 'body'), 'utf8'));
  const clean = cleanPush(body);
  assert.equal(clean.nodes[0].name, 'kvm-host');
  assert.ok(clean.nodes[0].memTotal > 0 && clean.nodes[0].cpu >= 0 && clean.nodes[0].cpu <= 100);
  assert.deepEqual(clean.guests.map((g) => [g.name, g.status, g.mem]), [['web01', 'running', 75], ['db "01"', 'stopped', null]]);
  assert.deepEqual(clean.storages.map((x) => [x.name, x.pct]), [['default', 50]], 'empty pool left out');
});

test('push route: reachable without a session, only with the token of the host', async () => {
  const { startApp } = await import('./helpers.js');
  const app = await startApp();
  try {
    const h = app.ctx.proxmox.create({ name: 'kvm', kind: 'libvirt' });
    const { token } = app.ctx.proxmox.newToken(h.id, { server: app.url });
    const send = (tok, body = { nodes: [{ name: 'kvm1', cpu: 5, memUsed: 1, memTotal: 4 }] }) => fetch(`${app.url}/api/proxmox/${h.id}/push`,
      { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'X-WOMN-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send('x'.repeat(43))).status, 401);
    const ok = await send(token);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, nodes: 1, guests: 0 });
    assert.equal(app.ctx.proxmox.get(h.id).data.nodes[0].mem, 25);
    assert.equal((await send(token, { nodes: [] })).status, 400);
  } finally { await app.close(); }
});
