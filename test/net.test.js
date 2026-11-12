import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';
import { parseCidr, hostsOf, cidrContains, normalizeMac, isRandomMac, readArpTable, defaultGateways, ipToInt } from '../src/lib/net.js';

test('parseCidr normalises and counts hosts', () => {
  assert.deepEqual(parseCidr('192.168.1.17/24').cidr, '192.168.1.0/24');
  assert.equal(parseCidr('192.168.1.0/24').hosts, 254);
  assert.equal(parseCidr('10.0.0.5').hosts, 1);
  assert.equal(parseCidr('10.0.0.4/31').hosts, 2);
  assert.equal(parseCidr('192.168.1.0/33'), null);
  assert.equal(parseCidr('192.168.01.0/24'), null);
  assert.equal(parseCidr('300.1.1.1/24'), null);
  assert.equal(parseCidr('1.2.3.4/24/1'), null);
  assert.equal(parseCidr(''), null);
});

test('hostsOf and cidrContains', () => {
  const list = [...hostsOf('192.168.5.0/30')];
  assert.deepEqual(list, ['192.168.5.1', '192.168.5.2']);
  assert.ok(cidrContains('192.168.5.0/24', '192.168.5.200'));
  assert.ok(!cidrContains('192.168.5.0/24', '192.168.6.1'));
  assert.equal(ipToInt('255.255.255.255'), 4294967295);
});

test('MAC addresses', () => {
  assert.equal(normalizeMac('BC-24-11-AA-BB-CC'), 'bc:24:11:aa:bb:cc');
  assert.equal(normalizeMac('bc2411aabbcc'), 'bc:24:11:aa:bb:cc');
  assert.equal(normalizeMac('00:00:00:00:00:00'), null);
  assert.equal(normalizeMac('xyz'), null);
  assert.ok(isRandomMac('da:a1:19:00:00:01'));
  assert.ok(!isRandomMac('bc:24:11:00:00:01'));
});

test('ARP table: only complete entries', () => {
  const f = path.join(tmp, 'arp');
  fs.writeFileSync(f, `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.1      0x1         0x2         3c:a6:2f:11:22:33     *        eth0
192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0
192.168.1.20     0x1         0x2         00:11:32:aa:bb:cc     *        eth0
`);
  const m = readArpTable(f);
  assert.equal(m.size, 2);
  assert.equal(m.get('192.168.1.20'), '00:11:32:aa:bb:cc');
});

test('default gateway from the routing table', () => {
  const f = path.join(tmp, 'route');
  fs.writeFileSync(f, `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth0	00000000	0101A8C0	0003	0	0	0	00000000	0	0	0
eth0	0001A8C0	00000000	0001	0	0	0	00FFFFFF	0	0	0
`);
  assert.deepEqual(defaultGateways(f), ['192.168.1.1']);
});
