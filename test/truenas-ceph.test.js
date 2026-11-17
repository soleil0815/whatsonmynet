// TrueNAS (JSON-RPC over WebSocket, API key of a read-only user) and a Ceph of its own (dashboard API, read-only
// user): pools, alerts, replications, health - read through the pinned certificate, never written to.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, proxmoxMetrics } from '../src/proxmox.js';
import { proxmoxCheck } from '../src/monitor/sensors.js';
import { truenasPool } from '../src/truenas.js';

function cert(dir) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=nas',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')), ca: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') };
}

/** A server frame (unmasked), split in two when asked (fragmented message) */
function frames(text, split = false) {
  const enc = (op, fin, data) => {
    const len = data.length;
    const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, len]) : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | op, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    return Buffer.concat([head, data]);
  };
  const b = Buffer.from(text);
  if (!split) return enc(1, true, b);
  const h = Math.floor(b.length / 2);
  return Buffer.concat([enc(1, false, b.subarray(0, h)), enc(9, true, Buffer.from('ping')), enc(0, true, b.subarray(h))]);
}

/** Client frames (masked) out of a buffer → texts */
function readFrames(buf) {
  const out = []; let at = 0;
  while (buf.length - at >= 6) {
    const op = buf[at] & 15; let len = buf[at + 1] & 127; let p = at + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; } else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (buf.length < p + 4 + len) break;
    const mask = buf.subarray(p, p + 4); const data = Buffer.from(buf.subarray(p + 4, p + 4 + len).map((x, i) => x ^ mask[i & 3]));
    out.push({ op, text: data.toString('utf8') }); at = p + 4 + len;
  }
  return { out, rest: buf.subarray(at) };
}

test('TrueNAS: pool shape - members not online, scrub errors, the last scrub only when it was one', () => {
  const p = truenasPool({ name: 'tank', status: 'DEGRADED', healthy: false, status_detail: 'One or more devices are faulted.', size: 1000, allocated: 820,
    scan: { function: 'SCRUB', state: 'FINISHED', end_time: { $date: Date.parse('2026-11-01T03:00:00Z') }, errors: 0 },
    topology: { data: [{ type: 'RAIDZ1', status: 'DEGRADED', children: [{ type: 'DISK', disk: 'sda', status: 'ONLINE' }, { type: 'DISK', disk: 'sdb', status: 'FAULTED' }] }], log: [], cache: [], spare: [] } });
  assert.deepEqual([p.state, p.good, p.pct, p.down, p.scrubAt, p.text], ['DEGRADED', false, 82, 1, '2026-11-01T03:00:00.000Z', 'DEGRADED · sdb FAULTED · One or more devices are faulted.']);
  const r = truenasPool({ name: 'boot-pool', status: 'ONLINE', healthy: true, size: 100, allocated: 10, scan: { function: 'RESILVER', state: 'FINISHED', end_time: { $date: 1 } }, topology: { data: [] } });
  assert.deepEqual([r.good, r.scrubAt], [true, null]);
});

test('TrueNAS through its WebSocket API: login with the key, pools, alerts, replications; sensors', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'truenas-'));
  const c = cert(dir);
  const calls = []; let keyOk = 'tn-key-1'; let poolsDenied = false;
  const srv = https.createServer({ key: c.key, cert: c.cert }, (req, res) => { res.statusCode = 404; res.end(); });
  srv.on('upgrade', (req, socket) => {
    if (req.url !== '/api/current') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0); let authed = false;
    socket.on('error', () => {});
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const { out, rest } = readFrames(buf); buf = rest;
      for (const f of out) {
        if (f.op === 8) { socket.end(); return; }
        if (f.op !== 1) continue;
        const m = JSON.parse(f.text); calls.push(m.method);
        const send = (result, split = false) => socket.write(frames(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), split));
        // an event without id in between - must be ignored
        socket.write(frames(JSON.stringify({ jsonrpc: '2.0', method: 'collection_update', params: { msg: 'changed' } })));
        if (m.method === 'auth.login_ex') {
          const p = m.params[0];
          authed = p.mechanism === 'API_KEY_PLAIN' && p.username === 'womn-readonly' && p.api_key === keyOk;
          send({ response_type: authed ? 'SUCCESS' : 'AUTH_ERR' });
        } else if (!authed) socket.write(frames(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'Method call error', data: { reason: 'Not authenticated' } } })));
        else if (m.method === 'system.info') send({ hostname: 'nas01', version: 'TrueNAS-26.04.0' });
        else if (m.method === 'pool.query') {
          if (poolsDenied) { socket.write(frames(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'Method call error', data: { reason: '[EACCES] Not authorized' } } }))); continue; }
          send([{ name: 'tank', status: 'ONLINE', healthy: true, size: 4000, allocated: 3400, scan: { function: 'SCRUB', state: 'FINISHED', end_time: { $date: Date.now() - 50 * 86400000 }, errors: 0 },
            topology: { data: [{ type: 'MIRROR', status: 'ONLINE', children: [{ disk: 'sda', status: 'ONLINE' }, { disk: 'sdb', status: 'ONLINE' }] }] } },
          { name: 'backup', status: 'DEGRADED', healthy: false, size: 1000, allocated: 100, scan: null, topology: { data: [{ type: 'RAIDZ1', status: 'DEGRADED', children: [{ disk: 'sdc', status: 'ONLINE' }, { disk: 'sdd', status: 'UNAVAIL' }] }] },
            description: 'x'.repeat(70000) }], true);
        } else if (m.method === 'alert.list') send([{ level: 'CRITICAL', formatted: 'Pool backup state is DEGRADED', klass: 'VolumeStatus', dismissed: false, datetime: { $date: Date.now() } },
          { level: 'WARNING', formatted: 'Update available', klass: 'HasUpdate', dismissed: false }, { level: 'INFO', formatted: 'nothing', dismissed: false }, { level: 'CRITICAL', formatted: 'old', dismissed: true }]);
        else if (m.method === 'replication.query') send([{ id: 1, name: 'tank → offsite', enabled: true, state: { state: 'ERROR', datetime: { $date: Date.now() }, error: 'ssh: connect to host 10.0.10.9 port 22: No route to host' } },
          { id: 2, name: 'old', enabled: false, state: { state: 'ERROR' } }]);
        else socket.write(frames(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })));
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  const url = `https://127.0.0.1:${srv.address().port}`;
  try {
    // without the certificate: refused before anything is sent
    let h = px.create({ name: 'nas', kind: 'truenas', url, token_id: 'womn-readonly', secret: 'tn-key-1' });
    let r = await px.poll(h.id);
    assert.equal(r.last_ok, false);
    assert.match(r.last_error, /self-signed/);
    assert.deepEqual(calls, []);
    h = px.update(h.id, { name: 'nas', kind: 'truenas', url, token_id: 'womn-readonly', ca: c.ca });
    r = await px.poll(h.id);
    assert.equal(r.last_ok, true, r.last_error);
    assert.deepEqual(calls, ['auth.login_ex', 'system.info', 'pool.query', 'alert.list', 'replication.query'], 'only reading methods');
    assert.deepEqual([r.data.name, r.data.version, r.data.missing], ['nas01', 'TrueNAS-26.04.0', []]);
    assert.deepEqual(r.data.pools.map((p) => [p.name, p.state, p.good, p.pct, p.down]), [['tank', 'ONLINE', true, 85, 0], ['backup', 'DEGRADED', false, 10, 1]]);
    assert.deepEqual(r.data.alerts.map((a) => [a.level, a.text]), [['CRITICAL', 'Pool backup state is DEGRADED'], ['WARNING', 'Update available']], 'no INFO, no dismissed');
    assert.deepEqual(r.data.replications.map((x) => [x.name, x.enabled, x.state]), [['tank → offsite', true, 'ERROR'], ['old', false, 'ERROR']]);
    assert.ok(!JSON.stringify(px.list()).includes('tn-key-1'), 'the key never leaves');
    // sensors
    const m = proxmoxMetrics(r.data);
    assert.deepEqual(m.filter((x) => ['nasAlerts', 'nasAlertsCrit'].includes(x.metric)).map((x) => [x.metric, x.value]), [['nasAlerts', 2], ['nasAlertsCrit', 1]]);
    assert.deepEqual(m.filter((x) => x.metric === 'replication').map((x) => [x.key, x.good]), [['1', false]], 'a disabled task is not watched');
    const check = (metric, key, threshold = 0, op = 'gt') => proxmoxCheck(db, { options: JSON.stringify({ host: h.id, metric, key, op, threshold, label: 'x' }) });
    assert.equal(check('pool', 'zfs:backup').ok, false);
    assert.equal(check('poolUsed', 'zfs:tank', 80, 'ge').ok, false);
    assert.equal(check('poolScrub', 'zfs:tank', 35).ok, false, '50 days since the last scrub');
    assert.equal(check('replication', '1').message, 'x: ERROR - ssh: connect to host 10.0.10.9 port 22: No route to host');
    // a key without the read role for pools: named, the rest still read
    poolsDenied = true;
    r = await px.poll(h.id);
    assert.equal(r.last_ok, true, r.last_error);
    assert.deepEqual(r.data.missing, ['pool.query']);
    // wrong key
    keyOk = 'other';
    r = await px.poll(h.id);
    assert.equal(r.last_ok, false);
    assert.match(r.last_error, /sign-in refused/);
  } finally { srv.close(); px.stop?.(); }
});

test('Ceph through its dashboard: sign-in, health, OSDs, space; logged out again', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ceph-'));
  const c = cert(dir);
  const seen = []; let health = 'HEALTH_WARN';
  const srv = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${req.headers.accept}`);
      res.setHeader('Content-Type', 'application/vnd.ceph.api.v1.0+json');
      if (req.url === '/api/auth' && req.method === 'POST') {
        const b = JSON.parse(body);
        if (b.username !== 'womn-readonly' || b.password !== 'pw-1') { res.statusCode = 401; return res.end('{"detail":"Invalid credentials"}'); }
        res.statusCode = 201; return res.end(JSON.stringify({ token: 'jwt-1', username: 'womn-readonly', permissions: {} }));
      }
      if (req.url === '/api/auth/logout') { res.statusCode = 200; return res.end('{}'); }
      if (req.headers.authorization !== 'Bearer jwt-1') { res.statusCode = 401; return res.end('{}'); }
      if (req.url === '/api/health/minimal') {
        return res.end(JSON.stringify({ health: { status: health, checks: health === 'HEALTH_OK' ? [] : [{ type: 'OSD_DOWN', severity: 'HEALTH_WARN', summary: { message: '1 osds down' } }] },
          osd_map: { osds: [{ up: 1, in: 1 }, { up: 1, in: 1 }, { up: 0, in: 1 }] }, mon_status: { monmap: { mons: [{}, {}, {}] } },
          pg_info: { statuses: { 'active+clean': 120, 'active+undersized+degraded': 8 } }, df: { stats: { total_bytes: 1000, total_used_raw_bytes: 780, total_avail_bytes: 220 } } }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  try {
    const h = px.create({ name: 'ceph', kind: 'ceph', url: `https://127.0.0.1:${srv.address().port}`, token_id: 'womn-readonly', secret: 'pw-1', ca: c.ca });
    let r = await px.poll(h.id);
    assert.equal(r.last_ok, true, r.last_error);
    const p = r.data.pools[0];
    assert.deepEqual([p.kind, p.state, p.good, p.pct, p.down], ['ceph', 'HEALTH_WARN', false, 78, 1]);
    assert.equal(p.text, 'OSD_DOWN: 1 osds down · 1 of 3 OSDs down · 8 PGs not active+clean');
    assert.deepEqual([r.data.osds, r.data.mons], [{ n: 3, up: 2, in: 3 }, 3]);
    assert.ok(seen.every((s) => s.includes('application/vnd.ceph.api.v1.0+json')), 'the versioned API');
    assert.ok(seen.some((s) => s.startsWith('POST /api/auth/logout')), 'logged out again');
    const check = (metric, op, threshold) => proxmoxCheck(db, { options: JSON.stringify({ host: h.id, metric, key: 'ceph:Ceph', op, threshold, label: 'x' }) });
    assert.equal(check('pool').ok, false);
    assert.equal(check('poolUsed', 'ge', 75).ok, false);
    assert.equal(check('poolDown', 'gt', 0).ok, false);
    health = 'HEALTH_OK';
    r = await px.poll(h.id);
    assert.equal(check('pool').ok, true);
    // wrong password
    px.update(h.id, { name: 'ceph', kind: 'ceph', url: `https://127.0.0.1:${srv.address().port}`, token_id: 'womn-readonly', secret: 'falsch', ca: c.ca });
    r = await px.poll(h.id);
    assert.equal(r.last_ok, false);
    assert.match(r.last_error, /sign-in refused/);
  } finally { srv.close(); px.stop?.(); }
});
