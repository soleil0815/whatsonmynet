import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import './helpers.js';
import { parseNbstat, extractTitle, tcpProbe, httpProbe, createRateLimiter, pool, osFromTtl } from '../src/scan/probes.js';

test('NetBIOS status answer', () => {
  const name = (s, suffix, flags) => Buffer.concat([Buffer.from(s.padEnd(15, ' '), 'latin1'), Buffer.from([suffix, flags, 0])]);
  const qname = Buffer.alloc(34); qname[0] = 32; qname.fill(0x41, 1, 33); qname[33] = 0;
  const msg = Buffer.concat([
    Buffer.from([0x12, 0x34, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 0]),
    qname, Buffer.from([0, 0x21, 0, 1, 0, 0, 0, 0, 0, 0x65]),
    Buffer.from([3]), name('PC-12', 0x00, 0x04), name('FIRMA', 0x00, 0x84), name('PC-12', 0x20, 0x04),
    Buffer.from([0x00, 0x15, 0x5d, 0x01, 0x02, 0x03]),
  ]);
  assert.deepEqual(parseNbstat(msg), { name: 'PC-12', domain: 'FIRMA', mac: '00:15:5d:01:02:03' });
});

test('title of a web interface', () => {
  assert.equal(extractTitle('<html><head><title>\n  Synology&nbsp;DiskStation &amp; more</title>'), 'Synology DiskStation & more');
  assert.equal(extractTitle('no title'), '');
});

test('TCP probe: open, closed', async () => {
  const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  assert.equal(await tcpProbe('127.0.0.1', port), 'open');
  srv.close();
  await new Promise((r) => srv.once('close', r));
  assert.equal(await tcpProbe('127.0.0.1', port), 'closed');
});

test('HTTP probe reads title and server header', async () => {
  const srv = http.createServer((_q, s) => { s.setHeader('Server', 'lighttpd'); s.end('<title>TL-SG108E</title>'); }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const r = await httpProbe('127.0.0.1', srv.address().port, 'http');
  srv.close();
  assert.equal(r.title, 'TL-SG108E');
  assert.equal(r.server, 'lighttpd');
  assert.equal(r.status, 200);
});

test('rate limiter spaces out attempts', async () => {
  const lim = createRateLimiter(50);
  const t0 = Date.now();
  for (let i = 0; i < 11; i++) await lim.take();
  assert.ok(Date.now() - t0 >= 180, `took ${Date.now() - t0} ms`);
});

test('pool limits concurrency', async () => {
  let now = 0; let max = 0;
  await pool([...Array(20).keys()], 4, async () => { now++; max = Math.max(max, now); await new Promise((r) => setTimeout(r, 5)); now--; });
  assert.equal(max, 4);
  assert.equal(osFromTtl(128), 'windows');
  assert.equal(osFromTtl(64), 'linux');
  assert.equal(osFromTtl(255), 'network');
});
