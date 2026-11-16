// Saved searches of the messages: search, severity, kind and time range under a name - one's own, or shared with
// everyone who sees the messages. Only who made it (or an admin) deletes it; the same name again replaces it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const app = await startApp();
const { call, ctx, db } = app;
test.after(() => { ctx.events.stop(); return app.close(); });

test('save, list, replace, share, delete', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  ctx.users.create({ username: 'kollegin', password: 'Sicher-Passwort-2', role: 'editor' });
  ctx.users.create({ username: 'gast', password: 'Sicher-Passwort-3', role: 'viewer' });
  assert.equal((await call('POST', '/api/login', { username: 'kollegin', password: 'Sicher-Passwort-2' }, { who: 'k' })).status, 200);
  assert.equal((await call('POST', '/api/login', { username: 'gast', password: 'Sicher-Passwort-3' }, { who: 'g' })).status, 200);

  // what is saved: cleaned up - unknown kinds and ranges become "all", severity stays within 0-7
  let r = await call('POST', '/api/events/searches', { name: 'Pocket Knife', q: 'PC-0001 4104 svc-pocketknife', maxSeverity: 4, range: '24h', kind: 'syslog' }, { who: 'k' });
  assert.equal(r.status, 201);
  r = await call('POST', '/api/events/searches', { name: 'Sperren', q: '4740', range: 'gestern', kind: 'x', maxSeverity: 99, shared: true });
  assert.equal(r.status, 201);
  let mine = (await call('GET', '/api/events/searches', undefined, { who: 'k' })).data;
  assert.deepEqual(mine.map((x) => [x.name, x.mine, x.shared]), [['Pocket Knife', true, false], ['Sperren', false, true]], 'own and shared ones');
  assert.deepEqual(mine[0], { id: mine[0].id, name: 'Pocket Knife', shared: false, mine: true, owner: 'kollegin', q: 'PC-0001 4104 svc-pocketknife', kind: 'syslog', maxSeverity: 4, range: '24h', part: false });
  assert.deepEqual([mine[1].range, mine[1].kind, mine[1].maxSeverity, mine[1].owner], ['', '', 7, 'testadmin']);
  // the admin does not see the colleague's own search
  assert.deepEqual((await call('GET', '/api/events/searches')).data.map((x) => x.name), ['Sperren']);
  // the same name (any case) replaces
  r = await call('POST', '/api/events/searches', { name: 'pocket knife', q: 'svc-pocketknife -4104', range: '7d' }, { who: 'k' });
  assert.equal(r.status, 200);
  mine = (await call('GET', '/api/events/searches', undefined, { who: 'k' })).data;
  assert.deepEqual(mine.filter((x) => x.mine).map((x) => [x.name, x.q, x.range]), [['Pocket Knife', 'svc-pocketknife -4104', '7d']]);
  // refused: no name, nothing to save; viewers see no messages, so no searches either
  assert.equal((await call('POST', '/api/events/searches', { name: ' ', q: 'x' })).data.error.field, 'name');
  assert.equal((await call('POST', '/api/events/searches', { name: 'leer' })).data.error.code, 'err.searchEmpty');
  assert.equal((await call('GET', '/api/events/searches', undefined, { who: 'g' })).status, 403);
  // deleting: a shared one of someone else only by an admin; someone else's own one is not even there
  const shared = mine.find((x) => x.name === 'Sperren');
  assert.equal((await call('DELETE', `/api/events/searches/${shared.id}`, undefined, { who: 'k' })).status, 403);
  const own = mine.find((x) => x.mine);
  assert.equal((await call('DELETE', `/api/events/searches/${own.id}`)).status, 404);
  assert.equal((await call('DELETE', `/api/events/searches/${own.id}`, undefined, { who: 'k' })).status, 200);
  assert.equal((await call('DELETE', `/api/events/searches/${shared.id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) FROM event_searches').pluck().get(), 0);
  assert.ok(db.prepare("SELECT COUNT(*) FROM audit WHERE action LIKE 'events.search.%'").pluck().get() >= 4);
});

test('at most 50 per user; they go with the user', async () => {
  for (let i = 0; i < 50; i++) assert.equal((await call('POST', '/api/events/searches', { name: `s${i}`, q: `w${i}` }, { who: 'k' })).status, 201);
  assert.equal((await call('POST', '/api/events/searches', { name: 's50', q: 'x' }, { who: 'k' })).data.error.code, 'err.searchMax');
  assert.equal((await call('POST', '/api/events/searches', { name: 's7', q: 'neu' }, { who: 'k' })).status, 200, 'replacing still works');
  const id = db.prepare("SELECT id FROM users WHERE username='kollegin'").get().id;
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) FROM event_searches').pluck().get(), 0);
});
