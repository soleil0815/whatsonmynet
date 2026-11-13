import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { memoryDb, tmp } from './helpers.js';
import { containerState, dockerCheck, dockerInfo, redisCheck, mysqlCheck, postgresCheck, validDockerUrl } from '../src/monitor/services.js';
import { createMonitoring } from '../src/monitor/index.js';
import { createMaintenance } from '../src/monitor/maintenance.js';
import { createDockerHosts } from '../src/monitor/docker.js';
import { MIGRATIONS, migrate } from '../src/db.js';

const listen = (srv, ...a) => new Promise((r) => srv.listen(...a, () => r(srv.address())));

test('docker addresses', () => {
  assert.ok(validDockerUrl('http://10.0.0.5:2375'));
  assert.ok(validDockerUrl('unix:///var/run/docker.sock'));
  assert.ok(!validDockerUrl('unix:///var/run/../etc/passwd.sock'));
  assert.ok(!validDockerUrl('ftp://x'));
  assert.ok(!validDockerUrl('http://10.0.0.5:2375/containers'));
});

test('container state', () => {
  assert.equal(containerState({ State: { Status: 'running', Running: true } }).ok, true);
  assert.equal(containerState({ State: { Status: 'running', Health: { Status: 'unhealthy' } } }).ok, false);
  assert.equal(containerState({ State: { Status: 'running', Health: { Status: 'healthy' } } }).message, 'running · healthy');
  assert.equal(containerState({ State: { Status: 'exited' } }).ok, false);
  assert.match(containerState({ State: { Status: 'restarting', Restarting: true }, RestartCount: 7 }).message, /restarts 7/);
});

function fakeDocker() {
  const containers = {
    web: { State: { Status: 'running', Running: true, Health: { Status: 'healthy' } }, Config: { Image: 'nginx' } },
    db: { State: { Status: 'exited' }, Config: { Image: 'mariadb' } },
  };
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') { res.statusCode = 403; return res.end('{}'); }
    if (req.url === '/version') return res.end(JSON.stringify({ Version: '27.3.1' }));
    if (req.url.startsWith('/containers/json')) return res.end(JSON.stringify([{ Names: ['/web'], Image: 'nginx', State: 'running', Status: 'Up 2 hours' }, { Names: ['/db'], Image: 'mariadb', State: 'exited', Status: 'Exited (1)' }]));
    const m = /^\/containers\/([^/]+)\/json$/.exec(req.url);
    if (m && containers[decodeURIComponent(m[1])]) return res.end(JSON.stringify(containers[decodeURIComponent(m[1])]));
    res.statusCode = 404; res.end('{"message":"No such container"}');
  });
}

test('docker check over TCP and unix socket', async () => {
  const srv = fakeDocker();
  const { port } = await listen(srv, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await dockerCheck(base, 'web')).ok, true);
  const down = await dockerCheck(base, 'db');
  assert.equal(down.ok, false);
  assert.equal(down.message, 'exited');
  assert.equal((await dockerCheck(base, 'nope')).message, 'container not found');
  const info = await dockerInfo(base);
  assert.equal(info.version, '27.3.1');
  assert.deepEqual(info.containers.map((c) => c.name), ['db', 'web']);
  srv.close();

  const sock = path.join(tmp, 'docker-test.sock');
  try { fs.rmSync(sock); } catch { /* none */ }
  const usrv = fakeDocker();
  await listen(usrv, sock);
  assert.equal((await dockerCheck(`unix://${sock}`, 'web')).ok, true);
  usrv.close();
  assert.match((await dockerCheck('http://127.0.0.1:1', 'web', 2)).message, /connection refused/);
});

function fakeRedis(password) {
  return net.createServer((s) => {
    let authed = !password;
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      // very small RESP reader: arrays of bulk strings
      for (;;) {
        const m = /^\*(\d+)\r\n/.exec(buf);
        if (!m) return;
        let off = m[0].length; const args = [];
        for (let i = 0; i < Number(m[1]); i++) {
          const b = /^\$(\d+)\r\n/.exec(buf.slice(off));
          if (!b) return;
          off += b[0].length; args.push(buf.slice(off, off + Number(b[1]))); off += Number(b[1]) + 2;
        }
        buf = buf.slice(off);
        if (args[0] === 'AUTH') { authed = args[args.length - 1] === password; s.write(authed ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n'); }
        else if (args[0] === 'PING') s.write(authed ? '+PONG\r\n' : '-NOAUTH Authentication required.\r\n');
      }
    });
  });
}

test('redis check: PING, AUTH, wrong password, no auth', async () => {
  const srv = fakeRedis('geheim');
  const { port } = await listen(srv, 0, '127.0.0.1');
  assert.equal((await redisCheck({ host: '127.0.0.1', port, password: 'geheim' })).ok, true);
  assert.match((await redisCheck({ host: '127.0.0.1', port, password: 'falsch' })).message, /wrong password/);
  assert.match((await redisCheck({ host: '127.0.0.1', port })).message, /NOAUTH/);
  srv.close();
});

test('database checks report refused connections cleanly', async () => {
  // nothing listens on port 1
  assert.match((await mysqlCheck({ host: '127.0.0.1', port: 1 }, 3)).message, /connection refused/);
  assert.match((await postgresCheck({ host: '127.0.0.1', port: 1 }, 3)).message, /connection refused/);
});

// Real servers - only where the CI provides them (WOMN_TEST_MYSQL=host:port:user:password etc.)
const real = (name) => { const v = process.env[name]; if (!v) return null; const [host, port, user, password] = v.split(':'); return { host, port: Number(port), user, password }; };
test('real MariaDB', { skip: !real('WOMN_TEST_MYSQL') }, async () => {
  const c = real('WOMN_TEST_MYSQL');
  const r = await mysqlCheck(c, 10);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /MariaDB|MySQL/);
  assert.match((await mysqlCheck({ ...c, password: 'falsch' }, 10)).message, /login failed/);
});
test('real PostgreSQL', { skip: !real('WOMN_TEST_POSTGRES') }, async () => {
  const c = real('WOMN_TEST_POSTGRES');
  const r = await postgresCheck(c, 10);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /PostgreSQL/);
  assert.match((await postgresCheck({ ...c, password: 'falsch' }, 10)).message, /login failed/);
});
test('real Redis', { skip: !real('WOMN_TEST_REDIS') }, async () => {
  const c = real('WOMN_TEST_REDIS');
  assert.equal((await redisCheck(c, 5)).ok, true);
});

test('monitors: docker and database types, password never returned', async () => {
  const db = memoryDb();
  const monitoring = createMonitoring({ db, channels: { notify: async () => [] }, maintenance: createMaintenance(db) });
  const hosts = createDockerHosts(db);
  const srv = fakeDocker();
  const { port } = await listen(srv, 0, '127.0.0.1');
  const h = hosts.create({ name: 'docker01', url: `http://127.0.0.1:${port}/` });
  assert.equal(h.url, `http://127.0.0.1:${port}`);
  await assert.rejects(monitoring.create({ name: 'x', type: 'docker', target: 'web' }), { code: 'err.dockerHost' });
  await assert.rejects(monitoring.create({ name: 'x', type: 'docker', target: '../etc', docker_host_id: h.id }), { code: 'err.container' });
  const d = await monitoring.create({ name: 'Web', type: 'docker', target: 'web', docker_host_id: h.id });
  assert.equal(d.docker_host.name, 'docker01');
  const r = await monitoring.checkNow(d.id);
  assert.equal(r.status === 'up' || r.last_message === 'running · healthy', true);
  assert.throws(() => hosts.remove(h.id), { code: 'err.dockerInUse' });

  const m = await monitoring.create({ name: 'DB', type: 'mysql', target: 'db.local', options: { user: 'monitor', database: 'app', tls: true }, password: 'Sehr-Geheim' });
  assert.equal(m.port, 3306);
  assert.equal(m.has_password, true);
  assert.equal(m.secret, undefined);
  assert.ok(!JSON.stringify(monitoring.list()).includes('Sehr-Geheim'));
  const raw = db.prepare('SELECT secret FROM monitors WHERE id=?').get(m.id).secret;
  assert.ok(raw && !raw.includes('Sehr-Geheim'), 'stored encrypted');
  const u = await monitoring.update(m.id, { name: 'DB 2' });
  assert.equal(u.has_password, true, 'kept when no new password is sent');
  assert.deepEqual(u.options, { user: 'monitor', database: 'app', tls: true, verify: false });
  const p = await monitoring.update(m.id, { type: 'ping', target: '127.0.0.1' }).catch((e) => e);
  if (!(p instanceof Error)) assert.equal(p.has_password, false, 'switching the type drops the password');
  srv.close();
});

test('schema 4 keeps monitors and their check history', () => {
  const db = memoryDb();
  // memoryDb is already migrated: go back to an empty database at schema 3
  const old = new (db.constructor)(':memory:');
  old.pragma('foreign_keys = ON');
  for (let v = 0; v < 3; v++) { old.exec(MIGRATIONS[v]); old.pragma(`user_version = ${v + 1}`); }
  const ts = new Date().toISOString();
  old.prepare("INSERT INTO monitors(name,type,target,created_at,updated_at) VALUES('Alt','ping','10.0.0.1',?,?)").run(ts, ts);
  old.prepare('INSERT INTO checks(monitor_id,at,ok) VALUES(1,?,1)').run(ts);
  old.prepare("INSERT INTO monitor_events(monitor_id,at,kind) VALUES(1,?,'up')").run(ts);
  migrate(old);
  assert.equal(old.pragma('user_version', { simple: true }), MIGRATIONS.length);
  assert.equal(old.prepare('SELECT COUNT(*) n FROM checks').get().n, 1);
  assert.equal(old.prepare('SELECT COUNT(*) n FROM monitor_events').get().n, 1);
  assert.equal(old.pragma('foreign_keys', { simple: true }), 1);
  old.prepare('DELETE FROM monitors WHERE id=1').run();
  assert.equal(old.prepare('SELECT COUNT(*) n FROM checks').get().n, 0, 'cascade still works after the rebuild');
});
