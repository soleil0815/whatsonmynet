import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createReports, reportDue, isoWeek } from '../src/reports.js';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);

test('schedule: weekly, monthly, daily, only once a day', () => {
  const s = { freq: 'weekly', weekday: 1, time: '08:00' };
  assert.equal(reportDue(s, null, at(2026, 11, 16, 8, 0)), true, 'Monday 8:00');
  assert.equal(reportDue(s, null, at(2026, 11, 17, 8, 0)), false, 'Tuesday');
  assert.equal(reportDue(s, null, at(2026, 11, 16, 7, 59)), false);
  assert.equal(reportDue(s, '2026-11-16', at(2026, 11, 16, 9, 0)), false, 'already sent today');
  assert.equal(reportDue({ freq: 'monthly', day: 1, time: '06:00' }, null, at(2026, 12, 1, 6, 30)), true);
  assert.equal(reportDue({ freq: 'daily', time: '06:00' }, null, at(2026, 12, 3, 6, 30)), true);
  assert.equal(isoWeek(at(2026, 11, 12, 12, 0)), 46);
});

function setup() {
  const db = memoryDb();
  const settings = createSettings(db);
  const sent = [];
  const reports = createReports({ db, settings, mailer: { send: async (m) => { sent.push(m); } } });
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO locations(name,created_at) VALUES('Büro',?)").run(ts);
  const add = (name, type, loc = 1) => db.prepare('INSERT INTO devices(name,type,model,location_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(name, type, 'HL-L3270', loc, ts, ts).lastInsertRowid;
  const p1 = add('Drucker <EG>', 'printer');
  const p2 = add('Drucker OG', 'printer');
  db.prepare('INSERT INTO printer_status(device_id,at,ok,data) VALUES(?,?,1,?)').run(p1, ts, JSON.stringify({ pages: 12345, errors: ['jammed'], supplies: [
    { key: '1.1', description: 'Toner Schwarz', type: 'toner', color: 'black', pct: 8, state: 'ok' }, { key: '1.2', description: 'Trommel', type: 'drum', pct: 60, state: 'ok' }] }));
  db.prepare('INSERT INTO printer_status(device_id,at,ok,data) VALUES(?,?,1,?)').run(p2, ts, JSON.stringify({ supplies: [{ key: '1.1', description: 'Toner Schwarz', type: 'toner', color: 'black', pct: 70, state: 'ok' }] }));
  return { db, sent, reports };
}

test('report mail: neutral, escaped, marks what to order', async () => {
  const { sent, reports } = setup();
  assert.throws(() => reports.create({ name: 'x', sections: [], recipients: 'a@b.de', schedule: { time: '08:00' } }), { code: 'err.reportSections' });
  assert.throws(() => reports.create({ name: 'x', sections: ['printers'], recipients: 'kein-mail', schedule: { time: '08:00' } }), { code: 'err.reportRecipients' });
  const r = reports.create({ name: 'Toner', sections: ['printers'], recipients: 'buero@firma.de; einkauf@firma.de', schedule: { freq: 'weekly', weekday: 1, time: '08:00' },
    subject: 'Tonerstand KW {kw}', intro: 'Hallo Büro,', signature: 'Ihre freundliche IT', from_name: 'IT "Team" <x>' });
  assert.deepEqual(r.recipients, ['buero@firma.de', 'einkauf@firma.de']);
  const m = reports.render(r, at(2026, 11, 16, 8, 0));
  assert.equal(m.subject, 'Tonerstand KW 47');
  assert.equal(m.count, 2);
  assert.equal(m.attention, 1);
  for (const body of [m.html, m.text]) {
    assert.ok(!/whatsonmynet/i.test(body), 'no program name');
    assert.ok(!/https?:\/\//i.test(body), 'no link');
    assert.match(body, /Ihre freundliche IT/);
  }
  assert.match(m.html, /Drucker &lt;EG&gt;/, 'device names are escaped');
  assert.match(m.text, /Toner Schwarz: 8 %\s+← bitte nachbestellen/);
  assert.match(m.text, /Papierstau/);
  // only devices that need action
  const only = reports.render({ ...r, only_attention: true });
  assert.equal(only.count, 1);
  await reports.send(r.id);
  assert.equal(sent[0].to, 'buero@firma.de, einkauf@firma.de');
  assert.equal(sent[0].fromName, 'IT Team x');
  await reports.send(r.id, { to: 'ich@firma.de' });
  assert.equal(sent[1].to, 'ich@firma.de');
});

test('scheduler sends once when due and records the result', async () => {
  const { db, sent, reports } = setup();
  const r = reports.create({ name: 'Toner', sections: ['printers', 'nas'], recipients: 'buero@firma.de', schedule: { freq: 'daily', time: '07:00' } });
  await reports.tick(at(2026, 11, 13, 7, 1));
  await reports.tick(at(2026, 11, 13, 7, 2));
  assert.equal(sent.length, 1);
  assert.equal(db.prepare('SELECT last_status FROM reports WHERE id=?').get(r.id).last_status, 'ok');
});

test('report for chosen devices; page counter and pages in the period', () => {
  const { db, reports } = setup();
  const [p1, p2] = db.prepare("SELECT id FROM devices WHERE type='printer' ORDER BY id").all().map((x) => x.id);
  // daily counter: 12 000 a week ago, 12 345 today
  const day = (d) => { const x = new Date(2026, 10, 16 - d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  db.prepare('INSERT INTO printer_pages(device_id,day,count) VALUES(?,?,?)').run(p1, day(8), 11900);
  db.prepare('INSERT INTO printer_pages(device_id,day,count) VALUES(?,?,?)').run(p1, day(7), 12000);
  db.prepare('INSERT INTO printer_pages(device_id,day,count) VALUES(?,?,?)').run(p1, day(0), 12345);
  // toner counted in pages
  const data = JSON.parse(db.prepare('SELECT data FROM printer_status WHERE device_id=?').get(p1).data);
  data.supplies[0] = { ...data.supplies[0], level: 480, max: 6000, unit: 7 };
  db.prepare('UPDATE printer_status SET data=? WHERE device_id=?').run(JSON.stringify(data), p1);

  const base = { name: 'Sekretariat', sections: ['printers', 'nas'], recipients: 'sek@firma.de', schedule: { freq: 'weekly', weekday: 1, time: '08:00' } };
  assert.throws(() => reports.create({ ...base, pick: 'some', device_ids: [] }), { code: 'err.reportDevices' });
  const nas = db.prepare("INSERT INTO devices(name,type,created_at,updated_at) VALUES('NAS','nas','x','x')").run().lastInsertRowid;
  const sw = db.prepare("INSERT INTO devices(name,type,created_at,updated_at) VALUES('SW','switch','x','x')").run().lastInsertRowid;
  // a switch does not fit the chosen content and is dropped; unknown ids too
  const r = reports.create({ ...base, pick: 'some', device_ids: [p1, sw, 9999] });
  assert.deepEqual(r.device_ids, [p1]);
  const m = reports.render(r, new Date(2026, 10, 16, 8, 0));
  assert.equal(m.count, 1, 'only the chosen printer');
  assert.ok(!m.text.includes('Drucker OG'));
  assert.ok(!/SPEICHERSYSTEME/.test(m.text), 'kinds without a chosen device are left out');
  assert.match(m.text, /Seiten gedruckt \(gesamt\): 12\.345/);
  assert.match(m.text, /Seiten in den letzten 7 Tagen: 345/);
  assert.match(m.text, /Toner Schwarz: 8 % · noch ca\. 480 Seiten/);
  assert.match(m.html, /Seiten gedruckt \(gesamt\)<\/td><td[^>]*>12\.345</);
  // back to all devices
  const all = reports.update(r.id, { ...base, pick: 'all', device_ids: [p1] });
  assert.deepEqual(all.device_ids, []);
  assert.equal(reports.render(all).count, 3);
  assert.ok(reports.candidates().printers.some((x) => x.id === p2));
  assert.ok(reports.candidates().nas.some((x) => x.id === nas));
});
