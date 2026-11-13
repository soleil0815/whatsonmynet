// Checks of services: Docker containers (Docker API, read-only - best through a socket proxy) and databases
// (MariaDB/MySQL, PostgreSQL, Redis: log in and run one harmless query). Every check returns { ok, ms, message }.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { config } from '../config.js';

const UA = `WhatsOnMyNet/${config.version} (monitoring)`;
const DOCKER_URL = /^(https?:\/\/[a-z0-9.\-[\]:]+(:\d{1,5})?\/?|unix:\/\/\/[\w./-]+\.sock)$/i;
export const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const DEFAULT_PORTS = { mysql: 3306, postgres: 5432, redis: 6379 };

export function validDockerUrl(u) {
  const s = String(u || '').trim();
  return DOCKER_URL.test(s) && !s.includes('..');
}

const withTimeout = (p, ms, label = 'timeout') => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(label), { code: 'TIMEOUT' })), ms).unref())]);

// ------------------------------------------------------------------------------------------------- Docker

/** GET on the Docker API → { status, json }. Reads at most 4 MB. */
export function dockerGet(base, path, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const opts = { method: 'GET', timeout: timeoutMs, headers: { 'User-Agent': UA, Accept: 'application/json', Host: 'docker' }, agent: false };
    let lib = http;
    if (base.startsWith('unix://')) {
      opts.socketPath = base.slice('unix://'.length);
      opts.path = path;
    } else {
      const u = new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
      lib = u.protocol === 'https:' ? https : http;
      Object.assign(opts, { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, rejectUnauthorized: false });
      opts.headers.Host = u.host;
    }
    const req = lib.request(opts, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size <= 4 * 1024 * 1024) chunks.push(d); else res.destroy(); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end();
  });
}

const netMessage = (e) => ({ ECONNREFUSED: 'connection refused', ENOENT: 'socket not found', EACCES: 'no access to the socket', TIMEOUT: 'timeout',
  ENOTFOUND: 'name not found (DNS)', EHOSTUNREACH: 'host unreachable', ECONNRESET: 'connection reset' }[e.code] || e.code || e.message);

/** Container state from GET /containers/{name}/json */
export function containerState(json) {
  const st = json?.State || {};
  const health = st.Health?.Status || '';
  const status = st.Status || (st.Running ? 'running' : 'unknown');
  const parts = [status];
  if (health) parts.push(health);
  if (st.Restarting || status === 'restarting') parts.push(`restarts ${json?.RestartCount ?? '?'}`);
  const ok = status === 'running' && health !== 'unhealthy';
  return { ok, message: parts.join(' · '), health, status, image: json?.Config?.Image || '', startedAt: st.StartedAt || null };
}

export async function dockerCheck(base, container, timeoutS = 10) {
  const t0 = Date.now();
  try {
    const r = await dockerGet(base, `/containers/${encodeURIComponent(container)}/json`, timeoutS * 1000);
    const ms = Date.now() - t0;
    if (r.status === 404) return { ok: false, ms: null, message: 'container not found' };
    if (r.status === 403) return { ok: false, ms: null, message: 'access denied by the socket proxy (CONTAINERS=1?)' };
    if (r.status !== 200 || !r.json) return { ok: false, ms: null, message: `Docker API status ${r.status}` };
    const s = containerState(r.json);
    return { ok: s.ok, ms, message: s.message };
  } catch (e) {
    return { ok: false, ms: null, message: `Docker: ${netMessage(e)}` };
  }
}

/** Version and containers of a Docker host (for the settings and the monitor form) */
export async function dockerInfo(base) {
  const v = await dockerGet(base, '/version', 8000);
  if (v.status !== 200 || !v.json) throw new Error(v.status === 403 ? 'access denied by the socket proxy' : `Docker API status ${v.status}`);
  const c = await dockerGet(base, '/containers/json?all=1', 8000);
  if (c.status !== 200 || !Array.isArray(c.json)) throw new Error(c.status === 403 ? 'access denied by the socket proxy (CONTAINERS=1?)' : `Docker API status ${c.status}`);
  return {
    version: String(v.json.Version || ''),
    containers: c.json.slice(0, 500).map((x) => ({
      name: String((x.Names || [])[0] || x.Id || '').replace(/^\//, ''),
      image: String(x.Image || '').slice(0, 200),
      state: String(x.State || ''),
      status: String(x.Status || '').slice(0, 80),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export const dockerError = (e) => netMessage(e);

// ---------------------------------------------------------------------------------------------- databases

const shortVersion = (s) => String(s || '').split(/[\s,(]/).slice(0, 2).join(' ').slice(0, 60);

export async function mysqlCheck({ host, port, user, password, database, tls: useTls }, timeoutS = 10) {
  const { default: mysql } = await import('mysql2/promise');
  const t0 = Date.now();
  let conn;
  try {
    conn = await withTimeout(mysql.createConnection({ host, port, user: user || undefined, password: password || undefined, database: database || undefined,
      connectTimeout: timeoutS * 1000, ssl: useTls ? { rejectUnauthorized: false } : undefined, multipleStatements: false }), timeoutS * 1000);
    const [rows] = await withTimeout(conn.query('SELECT VERSION() AS v'), timeoutS * 1000);
    const ms = Date.now() - t0;
    const v = String(rows?.[0]?.v || '');
    return { ok: true, ms, message: /mariadb/i.test(v) ? `MariaDB ${v.split('-')[0]}` : `MySQL ${v.split('-')[0]}` };
  } catch (e) {
    return { ok: false, ms: null, message: dbMessage(e) };
  } finally {
    try { conn?.destroy(); } catch { /* closed */ }
  }
}

export async function postgresCheck({ host, port, user, password, database, tls: useTls }, timeoutS = 10) {
  const { default: pg } = await import('pg');
  const t0 = Date.now();
  const client = new pg.Client({ host, port, user: user || 'postgres', password: password || undefined, database: database || 'postgres',
    connectionTimeoutMillis: timeoutS * 1000, query_timeout: timeoutS * 1000, ssl: useTls ? { rejectUnauthorized: false } : false,
    application_name: 'WhatsOnMyNet' });
  client.on('error', () => {});
  try {
    await withTimeout(client.connect(), timeoutS * 1000);
    const r = await withTimeout(client.query('SELECT version() AS v'), timeoutS * 1000);
    return { ok: true, ms: Date.now() - t0, message: shortVersion(r.rows?.[0]?.v) };
  } catch (e) {
    return { ok: false, ms: null, message: dbMessage(e) };
  } finally {
    client.end().catch(() => {});
  }
}

/** Redis/Valkey: (AUTH) + PING over the plain RESP protocol */
export function redisCheck({ host, port, user, password, tls: useTls }, timeoutS = 10) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const enc = (...args) => `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('')}`;
    const sock = useTls ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }) : net.connect({ host, port });
    sock.setTimeout(timeoutS * 1000);
    let buf = '';
    let done = false;
    const end = (r) => { if (!done) { done = true; sock.destroy(); resolve(r); } };
    const steps = [];
    if (password) steps.push(user ? enc('AUTH', user, password) : enc('AUTH', password));
    steps.push(enc('PING'));
    let expect = steps.length;
    sock.once(useTls ? 'secureConnect' : 'connect', () => sock.write(steps.join('')));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const lineStr = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (lineStr.startsWith('-')) return end({ ok: false, ms: null, message: lineStr.slice(1, 120).replace(/^WRONGPASS/, 'wrong password') });
        expect--;
        if (expect === 0) return end(lineStr === '+PONG' ? { ok: true, ms: Date.now() - t0, message: 'PONG' } : { ok: false, ms: null, message: `unexpected answer ${lineStr.slice(0, 40)}` });
      }
    });
    sock.on('timeout', () => end({ ok: false, ms: null, message: `timeout (${timeoutS} s)` }));
    sock.on('error', (e) => end({ ok: false, ms: null, message: netMessage(e) }));
    sock.on('close', () => end({ ok: false, ms: null, message: 'connection closed' }));
  });
}

function dbMessage(e) {
  if (e.code === 'ER_ACCESS_DENIED_ERROR' || e.code === '28P01' || e.code === '28000') return 'login failed (user or password)';
  if (e.code === 'ER_BAD_DB_ERROR' || e.code === '3D000') return 'database does not exist';
  if (e.code === 'ETIMEDOUT' || e.code === 'TIMEOUT') return 'timeout';
  return netMessage(e).slice(0, 160);
}
