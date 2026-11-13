// Code audit 2026-11, through the API: sign-in through the directory, AD users signed out, input types, scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { recheckDirectoryUsers } from '../src/auth/adrecheck.js';

const app = await startApp();
const { call, ctx } = app;
test.after(() => app.close());

test('setup', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
});

test('directory sign-in: counted before the DC answers, one counter per account, no hints to the outside', async () => {
  const real = { verify: ctx.directory.verify, enabled: ctx.directory.enabled };
  ctx.directory.enabled = () => true;
  let asked = 0;
  ctx.directory.verify = async (name, pw) => {
    asked++;
    await new Promise((r) => setTimeout(r, 150));
    if (name.includes('down')) throw Object.assign(new Error('x'), { status: 502, code: 'err.adFailed', detail: 'connect ECONNREFUSED 10.0.0.10:636' });
    if (pw === 'Richtig-1234' && name.includes('ohnegruppe')) return { username: 'ohnegruppe', role: null, dn: 'CN=x', groups: [] };
    throw Object.assign(new Error('x'), { status: 401 });
  };
  try {
    // 30 at the same time: only the limit gets through to the directory
    const all = await Promise.all(Array.from({ length: 30 }, (_, i) => call('POST', '/api/login', { username: 'bob', password: `x${i}` }, { who: `p${i}` })));
    assert.ok(asked <= 8, `${asked} directory checks`);
    assert.ok(all.some((r) => r.status === 429));
    // the same account written in other ways
    asked = 0;
    for (const n of ['FIRMA\\carol', 'OTHER\\carol', 'carol@firma.local', 'Carol', 'X\\CAROL', 'Y\\carol', 'Z\\carol', 'W\\carol', 'V\\carol', 'U\\carol']) await call('POST', '/api/login', { username: n, password: 'x' }, { who: 'v' });
    assert.ok(asked <= 8, `${asked} directory checks`);
    // right password, no group: like a wrong password
    assert.equal((await call('POST', '/api/login', { username: 'ohnegruppe', password: 'Richtig-1234' }, { who: 'g' })).status, 401);
    // DC unreachable: no addresses for whoever opens the page
    const down = await call('POST', '/api/login', { username: 'down', password: 'x' }, { who: 'd' });
    assert.equal(down.status, 502);
    assert.ok(!JSON.stringify(down.data).includes('10.0.0.10'), JSON.stringify(down.data));
  } finally { Object.assign(ctx.directory, real); }
});

test('AD users with an open session are signed out when disabled, and get a new role at once', async () => {
  const db = ctx.db;
  const at = new Date().toISOString();
  const mk = (n, role) => db.prepare("INSERT INTO users(username,password_hash,role,source,created_at) VALUES(?,'',?,'ldap',?)").run(n, role, at).lastInsertRowid;
  const gone = mk('weg', 'admin'); const moved = mk('anders', 'admin');
  for (const id of [gone, moved]) db.prepare('INSERT INTO sessions(id,user_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)').run(`s${id}`, id, Date.now(), Date.now(), Date.now() + 3600000);
  const directory = { enabled: () => true, verify: async (n) => { if (n === 'weg') throw Object.assign(new Error('x'), { status: 401 }); return { username: n, role: 'viewer', dn: 'CN=x', groups: [] }; } };
  const r = await recheckDirectoryUsers({ db, directory, users: ctx.users });
  assert.equal(r.signedOut, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(gone).n, 0);
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(moved).role, 'viewer');
  // the DC cannot be reached: nobody is thrown out
  const before = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  await recheckDirectoryUsers({ db, directory: { enabled: () => true, verify: async () => { throw Object.assign(new Error('x'), { status: 502 }); } }, users: ctx.users });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, before);
});

test('wrong input types are a clear 400, not an internal error', async () => {
  assert.equal((await call('POST', '/api/devices/bulk', { ids: [1], set: 'x' })).status, 400);
});

test('a user limited to locations cannot read Docker hosts or hypervisors through a monitor', async () => {
  const la = (await call('POST', '/api/locations', { name: 'A', subnets: ['10.77.1.0/24'] })).data;
  const da = (await call('POST', '/api/devices', { name: 'Gerät A', ip: '10.77.1.5', location_id: la.id })).data;
  await call('POST', '/api/users', { username: 'seg', password: 'Standort-A-1234', role: 'editor', locations: [la.id] });
  assert.equal((await call('POST', '/api/login', { username: 'seg', password: 'Standort-A-1234' }, { who: 'seg' })).status, 200);
  const r = await call('POST', '/api/monitors', { name: 'x', type: 'docker', target: 'web', docker_host_id: 1, device_id: da.id }, { who: 'seg' });
  assert.equal(r.status, 403);
});
