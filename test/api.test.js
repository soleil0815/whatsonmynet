import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const app = await startApp();
const { call } = app;
test.after(() => app.close());

const ADMIN = { username: 'michael', password: 'Sicher-Passwort-1', email: 'm@example.org' };

test('setup: needs the code from the log, only once', async () => {
  assert.equal((await call('GET', '/api/bootstrap')).data.setupRequired, true);
  assert.equal((await call('POST', '/api/setup', { ...ADMIN, code: 'wrong' })).status, 403);
  assert.equal((await call('POST', '/api/setup', { ...ADMIN, code: 'setup-123', password: 'short' })).status, 400);
  const ok = await call('POST', '/api/setup', { ...ADMIN, code: 'setup-123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'admin');
  assert.equal((await call('POST', '/api/setup', { ...ADMIN, username: 'x', code: 'setup-123' }, { who: 'other' })).status, 409);
  assert.equal((await call('GET', '/api/bootstrap')).data.user.username, 'michael');
});

test('writing calls need the CSRF header', async () => {
  assert.equal((await call('POST', '/api/locations', { name: 'X' }, { csrf: false })).status, 403);
});

test('sign-in with wrong password, lockout after many attempts', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await call('POST', '/api/login', { username: 'nobody', password: 'x' }, { who: 'anon' })).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'nobody', password: 'x' }, { who: 'anon' })).status, 429);
  assert.equal((await call('GET', '/api/devices', undefined, { who: 'anon' })).status, 401);
});

test('roles: viewer reads, editor scans, only admin changes settings', async () => {
  assert.equal((await call('POST', '/api/users', { username: 'leser', password: 'Lesen-Lesen-1', role: 'viewer' })).status, 201);
  assert.equal((await call('POST', '/api/users', { username: 'bearbeiter', password: 'Bearbeiten-1', role: 'editor' })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'leser', password: 'Lesen-Lesen-1' }, { who: 'viewer' })).status, 200);
  assert.equal((await call('POST', '/api/login', { username: 'bearbeiter', password: 'Bearbeiten-1' }, { who: 'editor' })).status, 200);
  assert.equal((await call('GET', '/api/devices', undefined, { who: 'viewer' })).status, 200);
  assert.equal((await call('POST', '/api/devices', { name: 'x' }, { who: 'viewer' })).status, 403);
  assert.equal((await call('POST', '/api/scans', { cidrs: ['127.0.0.1/32'] }, { who: 'viewer' })).status, 403);
  assert.equal((await call('GET', '/api/settings', undefined, { who: 'editor' })).status, 403);
  assert.equal((await call('POST', '/api/devices', { name: 'Switch Keller', type: 'switch', ip: '192.168.1.2' }, { who: 'editor' })).status, 201);
  // the last admin cannot be demoted or deleted
  const me = (await call('GET', '/api/me')).data;
  assert.equal((await call('PATCH', `/api/users/${me.id}`, { role: 'viewer' })).status, 400);
  assert.equal((await call('DELETE', `/api/users/${me.id}`)).status, 400);
  // own account: role cannot be raised
  const ed = (await call('PATCH', '/api/me', { role: 'admin', theme: 'dark' }, { who: 'editor' })).data;
  assert.equal(ed.role, 'editor');
  assert.equal(ed.theme, 'dark');
});

test('locations with subnets; a subnet belongs to one location only', async () => {
  const a = await call('POST', '/api/locations', { name: 'Hauptgebäude', subnets: ['192.168.10.7/24', { cidr: '192.168.20.0/24', label: 'Server' }] });
  assert.equal(a.status, 201);
  assert.deepEqual(a.data.subnets.map((s) => s.cidr), ['192.168.10.0/24', '192.168.20.0/24']);
  assert.equal((await call('POST', '/api/locations', { name: 'Außenstelle', subnets: ['192.168.10.0/24'] })).status, 409);
  assert.equal((await call('POST', '/api/locations', { name: 'Zu groß', subnets: ['10.0.0.0/8'] })).status, 400);
  assert.equal((await call('POST', '/api/locations', { name: 'hauptgebäude' })).status, 409);
});

test('scan input is validated', async () => {
  assert.equal((await call('POST', '/api/scans', {})).status, 400);
  const r = await call('POST', '/api/scans', { cidrs: ['10.0.0.0/8'] });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /zu groß/);
});

test('device edit, history, export, delete', async () => {
  const d = (await call('POST', '/api/devices', { name: 'Drucker EG', type: 'printer', ip: '192.168.1.40', mac: '3c:2a:f4:00:00:09' })).data;
  const u = await call('PATCH', `/api/devices/${d.id}`, { owner: 'IT', warranty_until: '2027-03-01' });
  assert.equal(u.data.owner, 'IT');
  const full = (await call('GET', `/api/devices/${d.id}`)).data;
  assert.deepEqual(full.history.map((h) => h.kind), ['edit', 'created']);
  const csv = await call('GET', '/api/devices/export.csv', undefined, { raw: true });
  assert.match(await csv.text(), /Drucker EG/);
  assert.equal((await call('DELETE', `/api/devices/${d.id}`)).status, 200);
  assert.equal((await call('GET', `/api/devices/${d.id}`)).status, 404);
  assert.equal((await call('GET', '/api/devices/abc')).status, 404);
});

test('settings: secrets are never sent back', async () => {
  await call('PUT', '/api/settings/smtp', { host: 'mail.example.org', port: 587, security: 'starttls', user: 'u', password: 'geheim', from: 'net@example.org' });
  await call('PUT', '/api/settings/scan', { snmpCommunities: 'public\nprivat123', rate: 1000 });
  const s = (await call('GET', '/api/settings')).data;
  assert.deepEqual(s.smtp.password, { set: true });
  assert.deepEqual(s.scan.snmpCommunities, { set: true });
  assert.equal(s.scan.rate, 200);
  assert.ok(!JSON.stringify(s).includes('geheim') && !JSON.stringify(s).includes('privat123'));
  assert.equal(app.ctx.settings.get('scan.snmpCommunities'), 'public\nprivat123');
  // stored encrypted
  const raw = app.db.prepare("SELECT value FROM settings WHERE key='smtp.password'").get().value;
  assert.ok(!raw.includes('geheim'));
});

test('own password change signs out other sessions', async () => {
  await call('POST', '/api/login', ADMIN, { who: 'second' });
  assert.equal((await call('GET', '/api/me', undefined, { who: 'second' })).status, 200);
  assert.equal((await call('POST', '/api/me/password', { current: 'wrong', password: 'Neues-Passwort-2' })).status, 400);
  assert.equal((await call('POST', '/api/me/password', { current: ADMIN.password, password: 'Neues-Passwort-2' })).status, 200);
  assert.equal((await call('GET', '/api/me')).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, { who: 'second' })).status, 401);
});

test('pages and security headers', async () => {
  const res = await call('GET', '/inventory', undefined, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});

test('monitoring: roles and secrets', async () => {
  assert.equal((await call('POST', '/api/channels', { name: 'TG', type: 'telegram', config: { token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', chatId: '-100123' } }, { who: 'editor' })).status, 403);
  const ch = await call('POST', '/api/channels', { name: 'TG', type: 'telegram', config: { token: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', chatId: '-100123' } });
  assert.equal(ch.status, 201);
  const asViewer = (await call('GET', '/api/channels', undefined, { who: 'viewer' })).data;
  assert.deepEqual(Object.keys(asViewer[0]).sort(), ['enabled', 'id', 'is_default', 'name', 'type']);
  const asAdmin = JSON.stringify((await call('GET', '/api/channels')).data);
  assert.ok(!asAdmin.includes('AAAAAAAAAA'));
  assert.equal((await call('POST', '/api/monitors', { name: 'Web', type: 'http', target: 'https://intranet.firma.local/' }, { who: 'viewer' })).status, 403);
  const m = await call('POST', '/api/monitors', { name: 'Web', type: 'http', target: 'https://intranet.firma.local/', channels: [ch.data.id] }, { who: 'editor' });
  assert.equal(m.status, 201);
  assert.equal((await call('GET', `/api/monitors/${m.data.id}`, undefined, { who: 'viewer' })).data.name, 'Web');
  assert.equal((await call('POST', `/api/monitors/${m.data.id}/pause`, {}, { who: 'editor' })).data.status, 'paused');
  assert.equal((await call('GET', '/api/dashboard')).data.monitoring.paused, 1);
  assert.equal((await call('POST', '/api/maintenance', { name: 'x', kind: 'weekly', weekdays: [1], time_from: '01:00', time_to: '02:00' }, { who: 'viewer' })).status, 403);
  assert.equal((await call('DELETE', `/api/monitors/${m.data.id}`, undefined, { who: 'editor' })).status, 200);
});

test('API requests are rate-limited per address', async () => {
  const { startApp: start } = await import('./helpers.js');
  const other = await start();
  let last;
  for (let i = 0; i < 605; i++) last = await other.call('GET', '/api/bootstrap', undefined, { raw: true });
  assert.equal(last.status, 429);
  assert.match((await last.json()).error.message, /Zu viele Anfragen|Too many requests/);
  await other.close();
});

test('bulk edit and bulk delete need the editor role', async () => {
  const a = (await call('POST', '/api/devices', { name: 'Bulk A', vendor: 'HP', model: 'M404' }, { who: 'editor' })).data;
  const b = (await call('POST', '/api/devices', { name: 'Bulk B' }, { who: 'editor' })).data;
  assert.equal((await call('POST', '/api/devices/bulk', { ids: [a.id, b.id], set: { owner: 'IT' } }, { who: 'viewer' })).status, 403);
  const r = await call('POST', '/api/devices/bulk', { ids: [a.id, b.id], set: { owner: 'IT' }, tagsAdd: ['EG'] }, { who: 'editor' });
  assert.equal(r.data.updated, 2);
  assert.equal((await call('GET', `/api/devices/${b.id}`)).data.tags, 'EG');
  const s = (await call('GET', '/api/devices/suggestions', undefined, { who: 'viewer' })).data;
  assert.ok(s.owner.includes('IT'));
  assert.deepEqual(s.models.m404, { vendor: 'HP', type: 'unknown' });
  assert.equal((await call('POST', '/api/devices/bulk-delete', { ids: [a.id, b.id] }, { who: 'viewer' })).status, 403);
  assert.equal((await call('POST', '/api/devices/bulk-delete', { ids: [a.id, b.id] }, { who: 'editor' })).data.deleted, 2);
});

test('light scan and printer settings', async () => {
  assert.equal((await call('PUT', '/api/settings/lightscan', { time: '25:00' })).status, 400);
  const r = await call('PUT', '/api/settings/lightscan', { enabled: true, time: '03:15', notify: false, channels: [999] });
  assert.equal(r.data.time, '03:15');
  assert.deepEqual(r.data.channels, [], 'unknown channels are dropped');
  const p = await call('PUT', '/api/settings/printer', { interval: 1, threshold: 99 });
  assert.equal(p.data.interval, 5);
  assert.equal(p.data.threshold, 50);
  assert.equal((await call('PUT', '/api/settings/printer', { interval: 30 }, { who: 'editor' })).status, 403);
  const s = (await call('GET', '/api/settings')).data;
  assert.ok('lightscan' in s && 'printer' in s);
  // printer query only for devices of type printer
  const d = (await call('POST', '/api/devices', { name: 'Kein Drucker', type: 'server', ip: '127.0.0.1' }, { who: 'editor' })).data;
  assert.equal((await call('POST', `/api/devices/${d.id}/printer`, {}, { who: 'editor' })).status, 404);
  assert.equal((await call('POST', '/api/lightscan/run', {}, { who: 'viewer' })).status, 403);
});

test('sign-in through the directory', async () => {
  const realVerify = app.ctx.directory.verify;
  const realEnabled = app.ctx.directory.enabled;
  app.ctx.directory.enabled = () => true;
  app.ctx.directory.verify = async (name, pw) => {
    if (pw !== 'Richtig-1234') throw Object.assign(new Error('x'), { status: 401 });
    if (name === 'ohnegruppe') return { username: 'ohnegruppe', role: null, dn: 'CN=x', groups: [] };
    return { username: 'erika', display_name: 'Erika AD', email: 'erika@firma.local', role: 'editor', dn: 'CN=Erika', groups: [] };
  };
  try {
    const ok = await call('POST', '/api/login', { username: 'FIRMA\\erika', password: 'Richtig-1234' }, { who: 'ad' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.source, 'ldap');
    assert.equal(ok.data.user.canEdit, true);
    assert.equal((await call('POST', '/api/me/password', { current: 'x', password: 'Neues-Passwort-1' }, { who: 'ad' })).status, 400);
    assert.equal((await call('POST', '/api/login', { username: 'erika', password: 'falsch' }, { who: 'ad2' })).status, 401);
    assert.equal((await call('POST', '/api/login', { username: 'ohnegruppe', password: 'Richtig-1234' }, { who: 'ad3' })).status, 403);
    // a local account is never checked against the directory
    let asked = false;
    app.ctx.directory.verify = async () => { asked = true; throw Object.assign(new Error('x'), { status: 401 }); };
    assert.equal((await call('POST', '/api/login', { username: 'bearbeiter', password: 'falsch' }, { who: 'ad4' })).status, 401);
    assert.equal(asked, false);
  } finally {
    app.ctx.directory.verify = realVerify;
    app.ctx.directory.enabled = realEnabled;
  }
});
