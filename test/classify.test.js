import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, suggestName, enterpriseOf } from '../src/scan/classify.js';
import { lookupVendor, shortVendor } from '../src/scan/oui.js';

test('manufacturer from the MAC address', () => {
  assert.equal(lookupVendor('bc:24:11:01:02:03').vendor, 'Proxmox');
  assert.equal(lookupVendor('00:11:32:01:02:03').vendor, 'Synology');
  assert.equal(lookupVendor('3c:2a:f4:01:02:03').vendor, 'Brother');
  assert.equal(lookupVendor('52:54:00:01:02:03').vendor, 'QEMU/KVM');
  assert.deepEqual(lookupVendor('da:a1:19:01:02:03'), { vendor: '', vendorFull: '', random: true });
  assert.equal(shortVendor('Hewlett Packard Enterprise'), 'HPE');
  assert.equal(shortVendor('Example Widgets Inc.'), 'Example Widgets');
});

test('Proxmox VE', () => {
  const c = classify({ ports: [22, 8006], http: [{ port: 8006, title: 'pve1 - Proxmox Virtual Environment' }], vendor: 'Supermicro' });
  assert.equal(c.type, 'hypervisor');
  assert.equal(c.os, 'Proxmox VE');
  assert.ok(c.confidence > 0.6);
});

test('Synology NAS', () => {
  const c = classify({ ports: [80, 443, 5000, 5001], vendor: 'Synology', http: [{ port: 5001, title: 'Synology DiskStation' }] });
  assert.equal(c.type, 'nas');
});

test('printers', () => {
  assert.equal(classify({ ports: [80, 443, 515, 631, 9100], vendor: 'Brother' }).type, 'printer');
  assert.equal(classify({ ports: [80, 9100], vendor: '', snmp: { descr: 'KYOCERA Document Solutions Printing System', objectId: '1.3.6.1.4.1.1347.41' } }).type, 'printer');
});

test('switches and routers', () => {
  assert.equal(classify({ ports: [80], vendor: 'TP-Link', http: [{ port: 80, title: 'TL-SG108E' }] }).type, 'switch');
  assert.equal(classify({ ports: [80, 443], vendor: 'LANCOM', snmp: { descr: 'LANCOM GS-2310P' } }).type, 'switch');
  assert.equal(classify({ ports: [53, 80, 443], vendor: 'AVM', isGateway: true, http: [{ title: 'FRITZ!Box' }] }).type, 'router');
  assert.equal(enterpriseOf('1.3.6.1.4.1.2356.11').name, 'LANCOM');
});

test('Telematik: card terminal and connector', () => {
  const t1 = classify({ ports: [4742], vendor: 'Ingenico' });
  assert.equal(t1.type, 'ti_terminal');
  assert.ok(t1.telematik);
  const t2 = classify({ ports: [443, 80], vendor: '', http: [{ port: 443, title: 'KoCoBox MED+ Konnektor' }] });
  assert.equal(t2.type, 'ti_connector');
  // A card terminal also offering a web page is still a card terminal
  assert.equal(classify({ ports: [80, 443, 4742], vendor: 'Cherry', http: [{ title: 'Web Admin' }] }).type, 'ti_terminal');
});

test('Windows domain controller and PCs', () => {
  const dc = classify({ ports: [53, 88, 135, 139, 389, 445, 3389], netbios: { name: 'DC01', domain: 'FIRMA' } });
  assert.equal(dc.type, 'server');
  assert.match(dc.os, /Windows Server/);
  assert.equal(classify({ ports: [135, 139, 445, 3389], vendor: 'Dell', netbios: { name: 'PC-12' }, ttl: 128 }).type, 'computer');
});

test('phones with private MAC and unknown devices', () => {
  assert.equal(classify({ ports: [], random: true }).type, 'mobile');
  const u = classify({ ports: [] });
  assert.equal(u.type, 'unknown');
  assert.equal(u.confidence, 0);
});

test('this server', () => {
  assert.equal(classify({ ports: [22], random: true, isSelf: true }).type, 'server');
});

test('suggested names', () => {
  assert.equal(suggestName({ hostname: 'pve1.firma.local', ip: '10.0.0.5' }), 'pve1');
  assert.equal(suggestName({ hostname: '', facts: { netbios: { name: 'PC-12' } }, ip: '10.0.0.5' }), 'PC-12');
  assert.equal(suggestName({ hostname: '', facts: {}, ip: '10.0.0.1', detected_type: 'router' }), 'Router .1');
  assert.equal(suggestName({ hostname: '', facts: {}, ip: '10.0.0.7', vendor: 'Brother' }), 'Brother .7');
  assert.equal(suggestName({ hostname: '', facts: {}, ip: '10.0.0.8', vendor: 'Brother', model: 'HL-L2350DW' }), 'HL-L2350DW');
});
