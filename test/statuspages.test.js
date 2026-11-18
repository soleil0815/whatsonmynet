// Status pages without login: only what is chosen, never addresses or error texts; secret link or own address, limited
// to networks if wanted; off, unknown or not allowed is the same "not found".
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { parseNetworks, addressAllowed, renderStatusPage, DAYS } from '../src/statuspages.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => app.close());

const ids = {};
const hourOf = (d) => `${d.toISOString().slice(0, 13)}:00`;
test('setup: a location with two servers, a website group, a check with a secret target and error text', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  const at = new Date().toISOString();
  const loc = db.prepare("INSERT INTO locations(name,created_at) VALUES('Hauptgebäude',?)").run(at).lastInsertRowid;
  const dev = (name, ip) => db.prepare("INSERT INTO devices(name,type,ip,location_id,created_at,updated_at) VALUES(?,'server',?,?,?,?)").run(name, ip, loc, at, at).lastInsertRowid;
  const mon = (name, type, target, deviceId, group, status, message) => db.prepare(`INSERT INTO monitors(name,type,target,device_id,group_name,status,last_message,interval_s,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,60,?,?)`).run(name, type, target, deviceId, group, status, message, at, at).lastInsertRowid;
  ids.dc = mon('DC01 Ping', 'ping', '10.0.10.5', dev('DC01', '10.0.10.5'), '', 'up', '');
  ids.fs = mon('FS01 SMB', 'tcp', '10.0.10.6:445', dev('FS01', '10.0.10.6'), '', 'down', 'connect ECONNREFUSED 10.0.10.6:445');
  ids.web = mon('Intranet', 'http', 'https://intranet.firma.local/geheim', null, 'Webseiten', 'up', '');
  ids.shop = mon('Shop', 'http', 'https://shop.firma.local/', null, 'Webseiten', 'up', '');
  // two days of history for the intranet: yesterday a few failures
  const ins = db.prepare('INSERT INTO monitor_hourly(monitor_id,hour,ok,total,ms_sum) VALUES(?,?,?,?,0)');
  const y = new Date(Date.now() - 86400000);
  ins.run(ids.web, hourOf(y), 50, 60);
  ins.run(ids.web, hourOf(new Date()), 60, 60);
});

test('networks: CIDR or single address, anything else refused; empty list = everybody', () => {
  assert.deepEqual(parseNetworks('10.0.10.0/24\n192.168.5.7, 10.0.10.9/24'), ['10.0.10.0/24', '192.168.5.7/32']);
  assert.throws(() => parseNetworks('10.0.10.0/33'), { code: 'err.statusNetwork' });
  assert.throws(() => parseNetworks('intranet'), { code: 'err.statusNetwork' });
  assert.equal(addressAllowed([], '8.8.8.8'), true);
  assert.equal(addressAllowed(['10.0.10.0/24'], '::ffff:10.0.10.77'), true);
  assert.equal(addressAllowed(['10.0.10.0/24'], '10.0.11.1'), false);
  assert.equal(addressAllowed(['10.0.10.0/24'], '::1'), false);
});

let link; let open;
test('only administrators make them; secret link by default, own address checked', async () => {
  assert.equal((await call('GET', '/api/status-pages')).status, 200);
  assert.equal((await call('POST', '/api/users', { username: 'max', password: 'Sicher-Passwort-2', role: 'editor' })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'max', password: 'Sicher-Passwort-2' }, { who: 'editor' })).status, 200);
  assert.equal((await call('GET', '/api/status-pages', undefined, { who: 'editor' })).status, 403);
  assert.equal((await call('POST', '/api/status-pages', { name: 'x' }, { who: 'editor' })).status, 403);

  const a = await call('POST', '/api/status-pages', { name: 'IT-Status', items: [
    { type: 'group', group: 'Webseiten', label: 'Webseiten' },
    { type: 'group', group: 'hauptgebäude', label: 'Server', members: true },
    { type: 'monitor', id: ids.dc, label: 'Anmeldung' }] });
  assert.equal(a.status, 201);
  link = a.data;
  assert.equal(link.access, 'link');
  assert.match(link.slug, /^[a-z0-9]{24}$/);
  assert.equal((await call('POST', '/api/status-pages', { name: 'x', access: 'open', slug: 'IT Status' })).data.error.code, 'err.statusSlug');
  assert.equal((await call('POST', '/api/status-pages', { name: 'x', access: 'open', slug: 'api' })).data.error.code, 'err.statusSlug');
  assert.equal((await call('POST', '/api/status-pages', { name: 'x', items: [{ type: 'monitor', id: 99999 }] })).status, 400);
  assert.equal((await call('POST', '/api/status-pages', { name: 'x', items: [{ type: 'group', group: '' }] })).status, 400);
  const o = await call('POST', '/api/status-pages', { name: 'Flur', access: 'open', slug: 'flur', networks: '10.0.10.0/24', items: [{ type: 'monitor', id: ids.web }] });
  assert.equal(o.status, 201);
  open = o.data;
  assert.deepEqual(open.networks, ['10.0.10.0/24']);
  assert.equal((await call('POST', '/api/status-pages', { name: 'y', access: 'open', slug: 'flur' })).status, 409);
  // editing keeps the secret link; "new link" changes it
  const e = await call('PUT', `/api/status-pages/${link.id}`, { notice: 'Heute 18-20 Uhr Wartung' });
  assert.equal(e.data.slug, link.slug);
  const n = await call('POST', `/api/status-pages/${link.id}/new-link`, {});
  assert.notEqual(n.data.slug, link.slug);
  assert.equal(ctx.statusPages.forVisitor(link.slug, '10.0.10.1'), null, 'the old link is gone');
  link = n.data;
});

test('what a page shows: group as one line (partly down), group with members, monitor under its own name, 90 days', () => {
  const v = ctx.statusPages.view(link.id);
  assert.equal(v.sections.length, 3);
  assert.deepEqual(v.sections[0].lines.map((l) => [l.name, l.state]), [['Webseiten', 'up']]);
  assert.equal(v.sections[1].title, 'Server');
  assert.deepEqual(v.sections[1].lines.map((l) => [l.name, l.state]), [['DC01 Ping', 'up'], ['FS01 SMB', 'down']]);
  assert.deepEqual(v.sections[2].lines.map((l) => [l.name, l.state]), [['Anmeldung', 'up']]);
  assert.equal(v.overall, 'partial');
  assert.equal(v.bad, 1);
  const web = v.sections[0].lines[0];
  assert.equal(web.bars.length, DAYS);
  assert.equal(web.bars.at(-1).pct, 100);
  assert.equal(web.uptime, 91.66);
  // a group of two where one fails: partly down
  db.prepare("UPDATE monitors SET status='down' WHERE id=?").run(ids.shop);
  assert.equal(ctx.statusPages.view(link.id).sections[0].lines[0].state, 'partial');
  db.prepare("UPDATE monitors SET status='up' WHERE id=?").run(ids.shop);
  // paused counts as "not monitored", not as down
  db.prepare('UPDATE monitors SET enabled=0 WHERE id=?').run(ids.fs);
  assert.equal(ctx.statusPages.view(link.id).sections[1].lines[1].state, 'off');
  assert.equal(ctx.statusPages.view(link.id).overall, 'up');
  db.prepare('UPDATE monitors SET enabled=1 WHERE id=?').run(ids.fs);
});

test('the page without login: no addresses, targets or error texts; no script; noindex', async () => {
  const res = await fetch(`${app.url}/status/${link.slug}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  const html = await res.text();
  assert.match(html, /<h1>IT-Status<\/h1>/);
  assert.match(html, /Störung bei 1 von 4/);
  assert.match(html, /Heute 18-20 Uhr Wartung/);
  assert.match(html, /Teilweise gestört|Gestört/);
  for (const secret of ['10.0.10.5', '10.0.10.6', 'intranet.firma.local', 'geheim', 'ECONNREFUSED', 'DC01"', 'FS01"', 'Intranet']) assert.ok(!html.includes(secret), secret);
  assert.ok(!/<script/i.test(html));
  assert.match(html, /<link rel="stylesheet" href="\/css\/status.css">/);
  assert.equal((await fetch(`${app.url}/css/status.css`)).status, 200);
});

test('not found: unknown, switched off, not from an allowed network - all the same', async () => {
  const notFound = async (p) => { const r = await fetch(`${app.url}${p}`); assert.equal(r.status, 404, p); return r.text(); };
  const body = await notFound('/status/gibt-es-nicht');
  await notFound(`/status/${open.slug}`); // the test client comes from 127.0.0.1, the page is for 10.0.10.0/24
  assert.ok(ctx.statusPages.forVisitor('flur', '10.0.10.20'));
  await call('PUT', `/api/status-pages/${link.id}`, { enabled: false });
  assert.equal(await notFound(`/status/${link.slug}`), body);
  await call('PUT', `/api/status-pages/${link.id}`, { enabled: true });
  assert.equal((await fetch(`${app.url}/status/${link.slug}`)).status, 200);
  await notFound('/status/..%2Fapi');
});

test('names are escaped', () => {
  const html = renderStatusPage({ title: '<b>x</b>', description: 'a\n"b"', notice: '', notice_level: 'info', show_uptime: true, language: 'en',
    sections: [{ title: '<i>', lines: [{ name: '<img src=x>', state: 'up', uptime: 99.5, bars: [{ day: '2026-11-18', pct: null }] }] }], overall: 'up', bad: 0, total: 1, at: new Date().toISOString(), days: [] });
  assert.ok(!html.includes('<b>x</b>') && !html.includes('<img src=x>') && !html.includes('<i>'));
  assert.match(html, /All systems operational/);
  assert.match(html, /a<br>&quot;b&quot;/);
});

test('deleted: gone from the list, its address is "not found"; a deleted monitor drops out of the page', async () => {
  db.prepare('DELETE FROM monitors WHERE id=?').run(ids.dc);
  assert.deepEqual(ctx.statusPages.view(link.id).sections.map((s) => s.lines.length), [1, 1]);
  assert.equal((await call('DELETE', `/api/status-pages/${open.id}`)).status, 200);
  assert.equal((await call('GET', '/api/status-pages')).data.length, 1);
  assert.equal((await call('DELETE', `/api/status-pages/${open.id}`)).status, 404);
});
