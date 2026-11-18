import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { startPrinterAgent } from './fixtures/printer-agent.js';
import { readPrinter, decodeErrors, supplyColor, parseSupplies, supplyAlertStates } from '../src/scan/printer.js';
import { createPrinters, supplyAlerts } from '../src/printers.js';
import { createSettings } from '../src/settings.js';
import { eventText } from '../src/monitor/notify.js';

test('error flags of hrPrinterDetectedErrorState', () => {
  assert.deepEqual(decodeErrors(Buffer.from([0x24, 0x00])), ['lowToner', 'jammed']);
  assert.deepEqual(decodeErrors(Buffer.from([0x00, 0x80])), ['inputTrayMissing']);
  assert.deepEqual(decodeErrors(Buffer.alloc(0)), []);
});

test('supply colour from colorant or description', () => {
  assert.equal(supplyColor('cyan', ''), 'cyan');
  assert.equal(supplyColor('', 'Toner Schwarz'), 'black');
  assert.equal(supplyColor('', 'Gelb (Y)'), 'yellow');
  assert.equal(supplyColor('', 'Fixiereinheit'), '');
});

test('supplies: percent, unknown level, empty', () => {
  const m = new Map([['5.1.1', 3], ['6.1.1', Buffer.from('Toner')], ['8.1.1', 200], ['9.1.1', 50],
    ['5.1.2', 3], ['6.1.2', Buffer.from('Toner 2')], ['8.1.2', -2], ['9.1.2', -3],
    ['5.1.3', 9], ['6.1.3', Buffer.from('Drum')], ['8.1.3', 100], ['9.1.3', 0]]);
  const s = parseSupplies(m);
  assert.equal(s.find((x) => x.key === '1.1').pct, 25);
  assert.equal(s.find((x) => x.key === '1.2').state, 'some');
  assert.equal(s.find((x) => x.key === '1.3').state, 'empty');
});

test('supplies without a level: low or empty as the own alerts of the printer say (prtAlertTable), a level always wins', () => {
  const m = new Map([['5.1.1', 3], ['6.1.1', Buffer.from('Black')], ['8.1.1', 100], ['9.1.1', 41],
    ['5.1.2', 3], ['6.1.2', Buffer.from('Cyan')], ['8.1.2', -2], ['9.1.2', -3],
    ['5.1.3', 3], ['6.1.3', Buffer.from('Magenta')], ['8.1.3', -2], ['9.1.3', -3],
    ['5.1.4', 3], ['6.1.4', Buffer.from('Yellow')], ['8.1.4', -2], ['9.1.4', -3]]);
  // group 11 (supplies): 2 almost empty (1104), 3 subunit empty (14), 1 almost empty too but has a level;
  // group 8 (input tray) index 4 - another unit, not supply 4; code 1 (other) means nothing
  const alerts = new Map([['4.1.1', 11], ['5.1.1', 2], ['7.1.1', 1104], ['4.1.2', 11], ['5.1.2', 3], ['7.1.2', 14],
    ['4.1.3', 11], ['5.1.3', 1], ['7.1.3', 1104], ['4.1.4', 8], ['5.1.4', 4], ['7.1.4', 1104], ['4.1.5', 11], ['5.1.5', 4], ['7.1.5', 1]]);
  const states = supplyAlertStates(alerts);
  assert.deepEqual([...states].sort(), [['1.1', 'low'], ['1.2', 'low'], ['1.3', 'empty']]);
  const s = parseSupplies(m, new Map(), states);
  const by = (k) => s.find((x) => x.key === k);
  assert.equal(by('1.1').pct, 41);
  assert.equal(by('1.1').state, 'ok');
  assert.equal(by('1.2').state, 'low');
  assert.equal(by('1.3').state, 'empty');
  assert.equal(by('1.4').state, 'some');
  assert.equal(supplyAlertStates().size, 0);
});

test('supply alerts without a level: reported once when the printer says low, re-armed when it no longer does', () => {
  const sup = (state) => [{ key: '1.2', description: 'Cyan', pct: null, state }];
  let r = supplyAlerts(sup('some'), {}, 15);
  assert.equal(r.events.length, 0);
  r = supplyAlerts(sup('low'), r.alerts, 15);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].empty, false);
  r = supplyAlerts(sup('low'), r.alerts, 15);
  assert.equal(r.events.length, 0);
  r = supplyAlerts(sup('some'), r.alerts, 15);
  assert.deepEqual(r.alerts, {});
  r = supplyAlerts(sup('low'), r.alerts, 15);
  assert.equal(r.events.length, 1);
});

test('reads a printer via SNMP (fake agent)', async () => {
  const agent = startPrinterAgent(16161, { supplies: [
    { colorant: 1, type: 3, descr: 'Black Toner', max: 100, level: 12 },
    { colorant: 2, type: 3, descr: 'Cyan Toner', max: 6000, level: 4500 },
    { cls: 4, type: 4, descr: 'Waste Toner Box', max: 100, level: 80 },
    { colorant: 3, type: 3, descr: 'Magenta Toner', max: -2, level: -3 },
    { colorant: 4, type: 3, descr: 'Yellow Toner', max: -2, level: -3 },
  ], errBytes: [0x04, 0x00], pages: 4711, alerts: [{ index: 4, code: 1104 }] });
  try {
    const r = await readPrinter('127.0.0.1', ['public'], { port: 16161 });
    assert.equal(r.pages, 4711);
    assert.equal(r.status, 'idle');
    assert.deepEqual(r.errors, ['jammed']);
    assert.deepEqual(r.supplies.map((s) => [s.color, s.pct, s.state]), [['black', 12, 'ok'], ['cyan', 75, 'ok'], ['magenta', null, 'low'], ['yellow', null, 'some'], ['', 80, 'ok']]);
    assert.equal(r.supplies[4].receptacle, true);
    assert.deepEqual(r.display, ['Bereit']);
    assert.equal(r.serial, 'E12345A6N789012');
    assert.equal(r.model, 'Fake Laser 4000 series');
  } finally { agent.close(); }
});

test('supply alerts: once per cartridge, escalate to empty, re-arm after replacing', () => {
  const sup = (pct, state = 'ok') => [{ key: '1.1', description: 'Black', pct, state }];
  let r = supplyAlerts(sup(40), {}, 15);
  assert.equal(r.events.length, 0);
  r = supplyAlerts(sup(14), r.alerts, 15);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].empty, false);
  r = supplyAlerts(sup(10), r.alerts, 15);
  assert.equal(r.events.length, 0, 'no second notice for the same cartridge');
  r = supplyAlerts(sup(0, 'empty'), r.alerts, 15);
  assert.equal(r.events[0].empty, true);
  r = supplyAlerts(sup(20), r.alerts, 15);
  assert.equal(r.alerts['1.1'], 'empty', 'a small rise is not a new cartridge');
  r = supplyAlerts(sup(100), r.alerts, 15);
  assert.equal(r.alerts['1.1'], undefined);
  r = supplyAlerts(sup(12), r.alerts, 15);
  assert.equal(r.events.length, 1);
});

test('printer service: stores status, daily pages, notifies once', async () => {
  const db = memoryDb();
  const settings = createSettings(db);
  const sent = [];
  const printers = createPrinters({ db, settings, channels: { notifyIds: async (ids, ev) => { sent.push(ev); return ['Test']; } } });
  const ts = new Date().toISOString();
  const id = db.prepare("INSERT INTO devices(name,type,ip,created_at,updated_at) VALUES('Laser 1','printer','10.0.0.9',?,?)").run(ts, ts).lastInsertRowid;
  let level = 9;
  printers.setReaderForTests(async () => ({ supplies: [{ key: '1.1', description: 'Black', type: 'toner', color: 'black', receptacle: false, pct: level, state: 'ok' }], pages: 100, status: 'idle', errors: [], display: [], serial: 'X1' }));
  const p = await printers.poll(id);
  assert.equal(p.ok, true);
  assert.equal(p.pages, 100);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'supply');
  await printers.poll(id);
  assert.equal(sent.length, 1);
  assert.equal(printers.low().length, 1);
  // SNMP fails: last known data stays, error is shown
  printers.setReaderForTests(async () => { throw new Error('snmp'); });
  const q = await printers.poll(id);
  assert.equal(q.ok, false);
  assert.equal(q.error, 'snmp');
  assert.equal(q.pages, 100);
  // pollDue: nothing due right after a poll
  level = 50;
  assert.equal(await printers.pollDue(), 0);
});

test('notification texts for supplies and new devices', () => {
  assert.match(eventText({ kind: 'supply', device: { name: 'Laser' }, supply: { description: 'Black', pct: 9 } }, 'de'), /Laser: Black nur noch 9 %/);
  assert.match(eventText({ kind: 'supply', device: { name: 'Laser' }, supply: { description: 'Waste', receptacle: true }, empty: true }, 'en'), /Waste is full/);
  assert.match(eventText({ kind: 'supply', device: { name: 'Laser' }, supply: { description: 'Cyan', pct: null } }, 'de'), /Laser: Cyan wird knapp \(meldet der Drucker\)/);
  assert.match(eventText({ kind: 'supply', device: { name: 'Laser' }, supply: { description: 'Waste', pct: null, receptacle: true } }, 'en'), /Waste almost full \(the printer reports\)/);
  assert.match(eventText({ kind: 'newDevices', devices: [{ ip: '10.0.0.5', vendor: 'HP' }] }, 'de'), /Neues Gerät im Netz: 10\.0\.0\.5 HP/);
  assert.match(eventText({ kind: 'newDevices', devices: [{ ip: '1' }, { ip: '2' }] }, 'en'), /2 new devices/);
});
