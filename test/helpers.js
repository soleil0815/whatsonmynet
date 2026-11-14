// Test helpers: a temporary data folder, an in-memory database and the app on a free port (plain HTTP).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'womn-test-'));
process.env.WOMN_DATA_DIR = tmp;
process.env.WOMN_LOG_LEVEL = 'error';

const { setMasterKeyForTests } = await import('../src/lib/crypto.js');
setMasterKeyForTests(crypto.randomBytes(32));
const { openDatabase } = await import('../src/db.js');

export function memoryDb() {
  return openDatabase(':memory:');
}

/** Starts the app; returns { url, ctx, db, call(method, path, body, cookie), close } */
export async function startApp({ setupToken = 'setup-123', tls = null, dataDir = undefined } = {}) {
  process.env.WOMN_SETUP_TOKEN = setupToken;
  const { createApp } = await import('../src/app.js');
  const db = memoryDb();
  const origLog = console.log;
  console.log = () => {}; // setup banner
  const { app, ctx } = createApp(db, { plainHttp: true, tls, dataDir });
  console.log = origLog;
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(method, p, body, { who = 'default', csrf = true, raw = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (csrf && method !== 'GET') headers['X-WOMN-Request'] = '1';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar[who]) headers.Cookie = jar[who];
    const res = await fetch(url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) jar[who] = set.split(';')[0];
    if (raw) return res;
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data };
  }
  return { url, app, ctx, db, call, close: () => new Promise((r) => server.close(r)) };
}
