// Groups of monitors (like Uptime Kuma): a group of its own or the location of the device, set for several at once,
// a group monitor that is down when one (or all) of its members are down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const app = await startApp();
const { call, db } = app;
test.after(() => app.close());

const at = new Date().toISOString();
const mk = async (body) => { const r = await call('POST', '/api/monitors', body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
// a check now → { ok, message } of the monitor afterwards
const run = async (id) => { const m = (await call('POST', `/api/monitors/${id}/check`)).data; return { ok: m.status === 'up', message: m.last_message }; };
const setStatus = (id, status) => db.prepare('UPDATE monitors SET status=? WHERE id=?').run(status, id);
let web1; let web2; let nas; let loc;

test('setup: a group of its own, the location of the device as group', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'Sicher-Passwort-1', email: 'a@example.org', code: 'setup-123' })).status, 200);
  loc = (await call('POST', '/api/locations', { name: 'Haus Nord', subnets: ['10.0.10.0/24'] })).data;
  const dev = Number(db.prepare("INSERT INTO devices(name,type,ip,location_id,created_at,updated_at) VALUES('NAS-01','nas','10.0.10.5',?,?,?)").run(loc.id, at, at).lastInsertRowid);
  web1 = await mk({ name: 'Webseite Institut', type: 'http', target: 'http://127.0.0.1:1/', group_name: '  Webseiten ' });
  web2 = await mk({ name: 'Intranet', type: 'http', target: 'http://127.0.0.1:2/', group_name: 'Webseiten' });
  nas = await mk({ name: 'NAS-01 SSH', type: 'tcp', target: '127.0.0.1', port: 1, device_id: dev });
  assert.equal(web1.group_name, 'Webseiten', 'trimmed');
  const list = (await call('GET', '/api/monitors')).data;
  assert.equal(list.find((m) => m.id === nas.id).location_name, 'Haus Nord', 'the location comes along for the group');
  assert.equal(list.find((m) => m.id === nas.id).group_name, '');
});

test('several at once: into a group and out again; a name too long is cut', async () => {
  let r = await call('POST', '/api/monitors/bulk', { ids: [nas.id], action: 'edit', changes: { group_name: 'Speicher' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.prepare('SELECT group_name FROM monitors WHERE id=?').pluck().get(nas.id), 'Speicher');
  r = await call('POST', '/api/monitors/bulk', { ids: [nas.id], action: 'edit', changes: { group_name: '' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT group_name FROM monitors WHERE id=?').pluck().get(nas.id), '');
  const long = await call('PUT', `/api/monitors/${web2.id}`, { group_name: `Webseiten${'x'.repeat(100)}` });
  assert.equal(long.data.group_name.length, 60);
  await call('PUT', `/api/monitors/${web2.id}`, { group_name: 'Webseiten' });
});

test('a group monitor: down when one member is down, or only when all are; paused and maintenance do not count', async () => {
  assert.equal((await call('POST', '/api/monitors', { name: 'Leer', type: 'group', options: { group: '' } })).status, 400);
  const g = await mk({ name: 'Gruppe Webseiten', type: 'group', options: { group: 'webseiten', mode: 'any' } });
  assert.equal(g.group_name, 'webseiten', 'it shows up in the group it watches');
  assert.equal(g.fail_threshold, 1);
  assert.equal((await call('POST', '/api/monitors', { name: 'Noch einmal', type: 'group', options: { group: 'Webseiten' } })).status, 409, 'the same group twice');
  const check = () => run(g.id);
  setStatus(web1.id, 'up'); setStatus(web2.id, 'up');
  let c = await check();
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.message, '2 of 2 up');
  setStatus(web2.id, 'down');
  c = await check();
  assert.equal(c.ok, false);
  assert.equal(c.message, '1 of 2 down: Intranet');
  // only when all are down
  await call('PUT', `/api/monitors/${g.id}`, { options: { group: 'Webseiten', mode: 'all' } });
  assert.equal((await check()).ok, true);
  setStatus(web1.id, 'unreachable');
  assert.equal((await check()).ok, false, 'behind something down counts as down');
  // a paused member does not count
  await call('POST', `/api/monitors/${web1.id}/pause`);
  c = await check();
  assert.equal(c.message, '1 of 1 down: Intranet');
  // a member in a maintenance window does not count either: none left → nothing to say against the group
  const w = await call('POST', '/api/maintenance', { name: 'Umbau', kind: 'once', starts_at: new Date(Date.now() - 60000).toISOString(),
    ends_at: new Date(Date.now() + 3600000).toISOString(), monitor_ids: [web2.id] });
  assert.equal(w.status, 201, JSON.stringify(w.data));
  c = await check();
  assert.equal(c.ok, true);
  assert.match(c.message, /^no member checked/);
  // the location as group: the NAS monitor belongs to "Haus Nord" without a group of its own
  const h = await mk({ name: 'Gruppe Nord', type: 'group', options: { group: 'Haus Nord' } });
  setStatus(nas.id, 'up');
  c = await run(h.id);
  assert.equal(c.message, '1 of 1 up');
  // a group monitor is no member of a group (not even of its own)
  const own = await mk({ name: 'Gruppe Leer', type: 'group', options: { group: 'Niemand' } });
  c = await run(own.id);
  assert.equal(c.ok, false);
  assert.match(c.message, /no members/);
});
