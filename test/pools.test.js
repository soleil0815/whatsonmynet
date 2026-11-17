// Storage pools: ZFS (Proxmox, Linux script), Ceph (Proxmox, Ceph dashboard, Prometheus text of the manager), Linux
// software RAID (/proc/mdstat), Windows Storage Spaces - one shape, the same sensors. What must not go unnoticed:
// a pool that runs degraded, a disk or OSD gone, a scrub that found errors or has not run for weeks.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { zfsScan, zfsFromPve, zfsFromScript, mdFromMdstat, spacesFromScript, cephPool, cephFromPrometheus, poolMetrics, pools } from '../src/pools.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, proxmoxMetrics } from '../src/proxmox.js';
import { proxmoxCheck } from '../src/monitor/sensors.js';

test('ZFS: the scan line, members not online, errors - from Proxmox', () => {
  assert.deepEqual(zfsScan('scrub repaired 0B in 00:01:23 with 0 errors on Sun Nov  9 00:25:24 2025'), { at: new Date('Nov 9, 2025 00:25:24').toISOString(), errors: 0, running: false });
  assert.equal(zfsScan('scrub repaired 12K in 01:00:00 with 3 errors on Mon Oct 6 02:00:00 2025').errors, 3);
  assert.deepEqual(zfsScan('scrub in progress since Sun Nov 16 00:24:01 2025'), { at: null, errors: null, running: true });
  assert.deepEqual(zfsScan('none requested'), { at: null, errors: null, running: false });
  const fine = zfsFromPve({ name: 'rpool', health: 'ONLINE', size: 1000, alloc: 420 }, { state: 'ONLINE', scan: 'scrub repaired 0B in 00:01:23 with 0 errors on Sun Nov  9 00:25:24 2025',
    errors: 'No known data errors', children: [{ name: 'mirror-0', state: 'ONLINE', children: [{ name: 'sda3', state: 'ONLINE' }, { name: 'sdb3', state: 'ONLINE' }] }] }, 'pve1');
  assert.deepEqual([fine.kind, fine.name, fine.node, fine.state, fine.good, fine.pct, fine.down, fine.text], ['zfs', 'rpool', 'pve1', 'ONLINE', true, 42, 0, '']);
  const bad = zfsFromPve({ name: 'tank', health: 'DEGRADED', size: 1000, alloc: 900 }, { state: 'DEGRADED', scan: 'none requested', errors: '2 data errors, use \'-v\' for a list',
    children: [{ name: 'raidz1-0', state: 'DEGRADED', children: [{ name: 'sdc', state: 'ONLINE' }, { name: 'sdd', state: 'FAULTED' }] }] }, 'pve2');
  assert.deepEqual([bad.good, bad.down, bad.scrubAt], [false, 1, null]);
  assert.equal(bad.text, 'DEGRADED · sdd FAULTED · 2 data errors, use \'-v\' for a list');
  // ONLINE, but the last scrub found errors: not fine either
  assert.equal(zfsFromPve({ name: 'p', health: 'ONLINE', size: 1, alloc: 0 }, { state: 'ONLINE', scan: 'scrub repaired 4K in 00:00:10 with 2 errors on Sun Nov 9 00:00:00 2025', errors: 'No known data errors' }, 'n').good, false);
  // without details (the second call failed): the health of the list
  assert.equal(zfsFromPve({ name: 'p', health: 'ONLINE', size: 10, alloc: 5 }, null, 'n').good, true);
});

test('ZFS from the Linux script: zpool list and zpool status as text', () => {
  const st = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 00:41:12 with 0 errors on Sun Nov  9 00:41:13 2025
config:

\tNAME        STATE     READ WRITE CKSUM
\ttank        ONLINE       0     0     0
\t  mirror-0  ONLINE       0     0     0
\t    sda     ONLINE       0     0     0
\t    sdb     ONLINE       0     0     0
\tlogs
\t  nvme0n1   ONLINE       0     0     0

errors: No known data errors
`;
  const off = `  pool: data
 state: DEGRADED
status: One or more devices has been taken offline by the administrator.
  scan: resilvered 1.2G in 00:02:00 with 0 errors on Sat Nov 15 10:00:00 2025
config:

\tNAME        STATE     READ WRITE CKSUM
\tdata        DEGRADED     0     0     0
\t  raidz2-0  DEGRADED     0     0     0
\t    sdc     ONLINE       0     0     0
\t    sdd     OFFLINE      0     0     0
\t    sde     REMOVED      0     0     0

errors: No known data errors
`;
  const r = zfsFromScript('tank\tONLINE\t4000\t1000\ndata\tDEGRADED\t2000\t1900\n\ngarbage', { tank: st, data: off });
  assert.deepEqual(r.map((p) => [p.name, p.state, p.good, p.pct, p.down, p.scrubErrors]), [['tank', 'ONLINE', true, 25, 0, 0], ['data', 'DEGRADED', false, 95, 2, null]]);
  assert.equal(r[1].text, 'DEGRADED · sdd OFFLINE, sde REMOVED');
  assert.equal(r[1].scrubAt, null, 'a resilver is no scrub');
});

test('Linux software RAID: /proc/mdstat', () => {
  const md = `Personalities : [raid1] [raid6] [raid5] [raid4]
md0 : active raid1 sdb1[1] sda1[0]
      976630464 blocks super 1.2 [2/2] [UU]
      bitmap: 1/8 pages [4KB], 65536KB chunk

md1 : active raid5 sde1[3](F) sdd1[1] sdc1[0]
      1953260544 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [UU_]

md2 : active raid1 sdg1[2] sdf1[0]
      488253440 blocks super 1.2 [2/1] [U_]
      [=>...................]  recovery =  8.4% (41045504/488253440) finish=37.7min speed=197511K/sec

md3 : active raid6 sdh1[0] sdi1[1] sdj1[2] sdk1[3]
      976512 blocks super 1.2 level 6, 512k chunk, algorithm 2 [4/4] [UUUU]
      [==>..................]  check = 12.1% (59392/488256) finish=0.1min speed=59392K/sec

md4 : inactive sdl1[0](S)
      976630464 blocks super 1.2

unused devices: <none>
`;
  const r = mdFromMdstat(md);
  assert.deepEqual(r.map((p) => [p.name, p.state, p.good, p.down]), [['md0', 'clean', true, 0], ['md1', 'degraded', false, 2], ['md2', 'degraded', false, 1], ['md3', 'check', true, 0], ['md4', 'inactive', false, 0]]);
  assert.equal(r[0].total, 976630464 * 1024);
  assert.equal(r[2].text, 'raid1 · 1 member(s) missing or failed · recovery 8.4%');
  assert.deepEqual(mdFromMdstat('Personalities :\nunused devices: <none>\n'), []);
});

test('Windows Storage Spaces from the script', () => {
  const r = spacesFromScript([{ name: 'Daten', health: 0, size: 4000, alloc: 1000, vdisks: [{ name: 'Spiegel', health: 0 }], badDisks: 0 },
    { name: 'Archiv', health: 1, size: 100, alloc: 90, vdisks: [{ name: 'Parität', health: 2 }], badDisks: 1 }]);
  assert.deepEqual(r.map((p) => [p.kind, p.name, p.state, p.good, p.pct, p.down, p.text]), [['spaces', 'Daten', 'healthy', true, 25, 0, ''],
    ['spaces', 'Archiv', 'warning', false, 90, 1, 'warning · Parität unhealthy · 1 disk(s) not healthy']]);
});

test('Ceph: ceph status (Proxmox), dashboard and Prometheus text', () => {
  // ceph status as Proxmox passes it on
  const st = { health: { status: 'HEALTH_WARN', checks: { OSD_DOWN: { severity: 'HEALTH_WARN', summary: { message: '1 osds down' } }, PG_DEGRADED: { severity: 'HEALTH_WARN', summary: { message: 'Degraded data redundancy: 120/3000 objects degraded' } } } },
    osdmap: { num_osds: 6, num_up_osds: 5, num_in_osds: 6 }, pgmap: { bytes_used: 300, bytes_total: 1000, pgs_by_state: [{ state_name: 'active+clean', count: 100 }, { state_name: 'active+undersized+degraded', count: 28 }] } };
  const c = cephPool(st);
  assert.deepEqual([c.kind, c.name, c.state, c.good, c.pct, c.down], ['ceph', 'Ceph', 'HEALTH_WARN', false, 30, 1]);
  assert.equal(c.text, 'OSD_DOWN: 1 osds down · PG_DEGRADED: Degraded data redundancy: 120/3000 objects degraded · 1 of 6 OSDs down · 28 PGs not active+clean');
  // an older Ceph: osdmap one level deeper
  assert.equal(cephPool({ health: { status: 'HEALTH_OK' }, osdmap: { osdmap: { num_osds: 3, num_up_osds: 3 } }, pgmap: { pgs_by_state: [{ state_name: 'active+clean', count: 64 }] } }).good, true);
  // the dashboard (/api/health/minimal)
  const d = cephPool({ health: { status: 'HEALTH_ERR', checks: [{ type: 'MON_DOWN', severity: 'HEALTH_ERR', summary: { message: '1/3 mons down' } }] },
    osd_map: { osds: [{ up: 1, in: 1 }, { up: 1, in: 1 }, { up: 0, in: 0 }] }, pg_info: { statuses: { 'active+clean': 64 } }, df: { stats: { total_bytes: 400, total_used_raw_bytes: 100 } } }, 'ceph-cluster');
  assert.deepEqual([d.name, d.state, d.good, d.down, d.pct, d.text], ['ceph-cluster', 'HEALTH_ERR', false, 1, 25, 'MON_DOWN: 1/3 mons down · 1 of 3 OSDs down']);
  assert.equal(cephPool({ health: {} }), null, 'no Ceph answer');
  assert.equal(cephPool('Ceph is not installed'), null);
  // the Prometheus text of the manager
  const prom = `# HELP ceph_health_status Cluster health status
ceph_health_status 1.0
ceph_health_detail{name="OSD_DOWN",severity="HEALTH_WARN"} 1.0
ceph_health_detail{name="POOL_NEARFULL",severity="HEALTH_WARN"} 0.0
ceph_osd_up{ceph_daemon="osd.0"} 1.0
ceph_osd_up{ceph_daemon="osd.1"} 0.0
ceph_osd_up{ceph_daemon="osd.2"} 1.0
ceph_cluster_total_bytes 1000.0
ceph_cluster_total_used_bytes 800.0
`;
  const p = cephFromPrometheus(prom);
  assert.deepEqual([p.state, p.good, p.pct, p.down, p.text], ['HEALTH_WARN', false, 80, 1, 'OSD_DOWN · 1 of 3 OSDs down']);
  assert.equal(cephFromPrometheus('nothing'), null);
});

test('sensors: state, usage (ZFS 80 %, Ceph 75 %), days since the scrub, members down', () => {
  const list = pools([{ kind: 'zfs', name: 'tank', node: 'pve1', state: 'ONLINE', good: true, used: 85, total: 100, scrubAt: new Date(Date.now() - 40 * 86400000).toISOString(), down: 0 },
    { kind: 'ceph', name: 'Ceph', state: 'HEALTH_OK', good: true, used: 1, total: 10, down: 0 }, { kind: 'md', name: 'md0', state: 'clean', good: true, down: 0 }]);
  const m = poolMetrics(list);
  assert.deepEqual(m.map((x) => [x.metric, x.key, x.value, x.threshold ?? null]), [
    ['pool', 'zfs:pve1/tank', 'ONLINE', null], ['poolUsed', 'zfs:pve1/tank', 85, 80], ['poolScrub', 'zfs:pve1/tank', 40, 35], ['poolDown', 'zfs:pve1/tank', 0, 0],
    ['pool', 'ceph:Ceph', 'HEALTH_OK', null], ['poolUsed', 'ceph:Ceph', 10, 75], ['poolDown', 'ceph:Ceph', 0, 0],
    ['pool', 'md:md0', 'clean', null], ['poolDown', 'md:md0', 0, 0]]);
  assert.equal(m[0].name, 'ZFS tank (pve1)');
  assert.deepEqual(poolMetrics(list, 'host').map((x) => x.metric).slice(0, 4), ['hostPool', 'hostPoolUsed', 'hostPoolScrub', 'hostPoolDown']);
});

test('Proxmox VE: ZFS of every node and the Ceph cluster, read with the token; sensors on them', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'pools-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=pve',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  let ceph = true; const asked = [];
  const routes = {
    '/api2/json/cluster/resources': [{ type: 'node', node: 'pve1', status: 'online', cpu: 0.1, mem: 1, maxmem: 2 }, { type: 'node', node: 'pve2', status: 'online', cpu: 0.1, mem: 1, maxmem: 2 },
      { type: 'node', node: 'pve3', status: 'offline' }],
    '/api2/json/access/permissions': { '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'Datastore.Audit': 1 } },
    '/api2/json/nodes/pve1/disks/zfs': [{ name: 'rpool', health: 'ONLINE', size: 1000, alloc: 300, free: 700, frag: 5, dedup: 1 }],
    '/api2/json/nodes/pve1/disks/zfs/rpool': { name: 'rpool', state: 'ONLINE', scan: 'scrub repaired 0B in 00:01:23 with 0 errors on Sun Nov  9 00:25:24 2025', errors: 'No known data errors',
      children: [{ name: 'mirror-0', state: 'ONLINE', children: [{ name: 'sda3', state: 'ONLINE' }, { name: 'sdb3', state: 'ONLINE' }] }] },
    '/api2/json/nodes/pve2/disks/zfs': [{ name: 'tank', health: 'DEGRADED', size: 2000, alloc: 1800 }],
    '/api2/json/nodes/pve2/disks/zfs/tank': { name: 'tank', state: 'DEGRADED', scan: 'none requested', errors: 'No known data errors',
      children: [{ name: 'raidz1-0', state: 'DEGRADED', children: [{ name: 'sdc', state: 'ONLINE' }, { name: 'sdd', state: 'UNAVAIL' }] }] },
  };
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    const p = req.url.split('?')[0]; asked.push(`${req.method} ${p}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'PVEAPIToken=monitor@pve!womn=secret-1') { res.statusCode = 401; return res.end('{}'); }
    if (p === '/api2/json/cluster/ceph/status') {
      if (!ceph) { res.statusCode = 500; return res.end(JSON.stringify({ data: null, message: 'binary not installed: /usr/bin/ceph-mon\n' })); }
      return res.end(JSON.stringify({ data: { health: { status: 'HEALTH_OK', checks: {} }, osdmap: { num_osds: 3, num_up_osds: 3, num_in_osds: 3 }, pgmap: { bytes_used: 100, bytes_total: 1000, pgs_by_state: [{ state_name: 'active+clean', count: 129 }] } } }));
    }
    if (/\/tasks$/.test(p)) return res.end(JSON.stringify({ data: [] }));
    if (routes[p]) return res.end(JSON.stringify({ data: routes[p] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  try {
    const h = px.create({ name: 'pve', kind: 'pve', url: `https://127.0.0.1:${srv.address().port}`, token_id: 'monitor@pve!womn', secret: 'secret-1', ca: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') });
    let r = await px.poll(h.id);
    assert.equal(r.last_ok, true, r.last_error);
    assert.deepEqual(r.data.pools.map((p) => [p.kind, p.node, p.name, p.state, p.good, p.down]), [['zfs', 'pve1', 'rpool', 'ONLINE', true, 0], ['zfs', 'pve2', 'tank', 'DEGRADED', false, 1], ['ceph', '', 'Ceph', 'HEALTH_OK', true, 0]]);
    assert.ok(!asked.some((a) => a.includes('pve3')), 'an offline node is not asked');
    assert.ok(asked.every((a) => a.startsWith('GET ')), 'only reading');
    // sensors
    const sensor = (metric, key) => proxmoxCheck(db, { options: JSON.stringify({ host: h.id, metric, key, op: 'ge', threshold: 80, label: 'x' }) });
    assert.deepEqual(sensor('pool', 'zfs:pve1/rpool'), { ok: true, ms: null, message: 'x: ONLINE', data: { state: 'ok' } });
    const t = sensor('pool', 'zfs:pve2/tank');
    assert.equal(t.ok, false);
    assert.equal(t.message, 'x: DEGRADED - DEGRADED · sdd UNAVAIL');
    assert.equal(sensor('poolUsed', 'zfs:pve2/tank').ok, false, '90 % ≥ 80 %');
    assert.equal(proxmoxCheck(db, { options: JSON.stringify({ host: h.id, metric: 'poolScrub', key: 'zfs:pve2/tank', op: 'gt', threshold: 35, label: 'x' }) }).message, 'x: no scrub found - start one (zpool scrub) or set up a monthly one');
    assert.equal(sensor('pool', 'ceph:Ceph').ok, true);
    assert.ok(proxmoxMetrics(r.data).some((x) => x.metric === 'poolDown' && x.key === 'ceph:Ceph'));
    // a cluster without Ceph: no error, no Ceph entry
    ceph = false;
    r = await px.poll(h.id);
    assert.equal(r.last_ok, true);
    assert.deepEqual(r.data.pools.map((p) => p.kind), ['zfs', 'zfs']);
  } finally { srv.close(); px.stop?.(); }
});
