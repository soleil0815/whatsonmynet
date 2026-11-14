// Failover: a second WhatsOnMyNet stands by and takes over when the first one (the master) is gone.
//
// Master: "Make this the master" creates a pairing code (a secret + the fingerprint of its certificate). Only a hash
//   of the secret is stored. The standby asks with the secret every minute; every few minutes it fetches a copy of
//   the whole database. The master stays as it is - it does not know or wait for the standby.
// Standby: address of the master + pairing code. It listens: no checks, no scans, no alarms, the interface shows the
//   data of the master (read only). When the master has not answered for the set time (10 minutes by default), it
//   takes over: monitoring, scans and alarms run here. As soon as the master answers again it is quiet again and
//   takes the data of the master once more - nothing goes back to the master. What happened meanwhile is kept here
//   as a takeover record. Only "Make this the master" turns a standby into the master for good; the old master is
//   told on its next contact and keeps quiet then.
//
// Everything about failover lives in data/failover.json (not in the database - that one is replaced on every sync).
// The connection to the master: HTTPS with the public key of its certificate pinned (from the pairing code) - checked
// before anything, the secret included, is sent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import tls from 'node:tls';
import http from 'node:http';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { HttpError, line } from './lib/http.js';
import { encrypt, decrypt, randomToken, currentKey, prepareKey, decryptWith, keyFromEnvironment } from './lib/crypto.js';
import { log } from './lib/log.js';
import { config } from './config.js';
import { MIGRATIONS } from './db.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const nowIso = () => new Date().toISOString();
const CODE_RE = /^WOMN1-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})$/;
// The standby: a question every minute; the data every 5 minutes (and right after pairing / handing back)
const HELLO_MS = 60 * 1000;
const SYNC_MS = 5 * 60 * 1000;
export const DELAY_MIN = { min: 3, max: 240, default: 10 };
const MAX_SNAPSHOT = 4 * 1024 * 1024 * 1024;
// Tables that stay with each installation: who is signed in here
const LOCAL_TABLES = new Set(['sessions']);
// While standby, the interface may only read - apart from signing in/out and the failover itself
const WRITE_OK = [/^\/api\/(login|logout|failover)(\/|$)/, /^\/api\/me$/];

/** SHA-256 of the public key of a certificate (as curl --pinnedpubkey does), base64url */
export function spkiPin(certOrPem) {
  const pub = typeof certOrPem === 'string' ? new crypto.X509Certificate(certOrPem).publicKey : certOrPem;
  return b64u(sha256(pub.export({ type: 'spki', format: 'der' })));
}

/** "10.0.10.5", "womn1.firma.local:8743", "https://10.0.10.5:8743/" → "https://10.0.10.5:8743" */
export function normalizeAddress(raw, defaultPort = config.httpsPort) {
  let s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) throw new HttpError(400, 'err.foAddress', '', 'address');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, 'err.foAddress', '', 'address'); }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.username || u.password || !u.hostname) throw new HttpError(400, 'err.foAddress', '', 'address');
  return `https://${u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname}:${u.port || defaultPort}`;
}

/** "WOMN1-<secret>-<pin>" → { secret, pin } */
export function parseCode(raw) {
  const m = CODE_RE.exec(String(raw ?? '').replace(/\s+/g, ''));
  if (!m) throw new HttpError(400, 'err.foCode', '', 'code');
  return { secret: m[1], pin: m[2] };
}

/**
 * One HTTPS request to the other installation. The TLS connection is made first and the public key of the
 * certificate compared with the pin - only then the request (with the secret) goes out. The name in the certificate
 * does not matter (the master may be reached by IP), the pin is stronger than a CA would be.
 * With `toFile` the answer body is written there (size-limited) instead of being returned.
 */
export function pinnedRequest({ address, pin, secret }, method, p, { body = null, toFile = null, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, `${address}/`);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let done = false;
    const fail = (e) => { if (!done) { done = true; clearTimeout(deadline); reject(e); } };
    const deadline = setTimeout(() => { socket.destroy(); fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); }, toFile ? 30 * 60 * 1000 : timeoutMs * 3);
    // rejectUnauthorized: false only because the check below replaces it - it runs before a single byte is written
    const socket = tls.connect({ host, port: Number(u.port || 443), servername: isIpLiteral(host) ? undefined : host, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    socket.once('error', (e) => fail(e));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      let ok = false;
      // the whole public key (SubjectPublicKeyInfo) from the certificate itself - `pubkey` is only the bare key for EC
      try { ok = !!cert?.raw && spkiPin(new crypto.X509Certificate(cert.raw).publicKey) === pin; } catch { ok = false; }
      if (!ok) { socket.destroy(); fail(Object.assign(new Error('the certificate of the other server does not match the pairing code'), { code: 'EPIN' })); return; }
      const data = body === null ? null : Buffer.from(JSON.stringify(body));
      // HTTP over the TLS connection checked above (the http client only writes to the socket it is given)
      const req = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, createConnection: () => socket, headers: {
        Host: u.host,
        Authorization: `Bearer ${secret}`, Accept: toFile ? 'application/octet-stream' : 'application/json', 'X-WOMN-Request': '1',
        'User-Agent': `WhatsOnMyNet-Failover/${config.version}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
        if (toFile && res.statusCode === 200) {
          let size = 0;
          res.on('data', (d) => { size += d.length; if (size > MAX_SNAPSHOT) res.destroy(new Error('copy too large')); });
          pipeline(res, fs.createWriteStream(toFile, { mode: 0o600 }))
            .then(() => { if (!done) { done = true; clearTimeout(deadline); resolve({ status: 200, headers: res.headers }); } }).catch(fail);
          return;
        }
        const chunks = []; let size = 0;
        res.on('data', (d) => { size += d.length; if (size <= maxBytes) chunks.push(d); else res.destroy(new Error('answer too large')); });
        res.on('end', () => {
          if (done) return;
          done = true; clearTimeout(deadline);
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
        res.on('error', fail);
      });
      req.on('error', fail);
      req.end(data || undefined);
    });
  });
}
const isIpLiteral = (h) => /^[\d.]+$/.test(h) || h.includes(':');

/** Failover errors in words (for the page and the log) */
export function whyText(e) {
  if (!e) return '';
  return { EPIN: 'certificate does not match the pairing code', ECONNREFUSED: 'connection refused', ETIMEDOUT: 'no answer', EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable', ENOTFOUND: 'name not found (DNS)', ECONNRESET: 'connection reset' }[e.code] || e.message;
}

/**
 * @param engines what runs only on the active installation: [{ start(), stop() }]
 * @param notify (ev) => Promise - alarm to the default channels (takeover / handing back)
 * @param certPem () => PEM of the own HTTPS certificate (for the pin in the pairing code)
 */
export function createFailover({ db, settings, dataDir, engines = [], notify = async () => {}, certPem = () => '', snapshot, discard, audit = () => {} }) {
  const file = path.join(dataDir, 'failover.json');
  let st = load();
  let timer = null;
  let running = false;      // engines started?
  let busy = false;
  let lastSyncTry = 0;
  let lastError = '';

  function load() {
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' ? s : { role: 'alone' }; } catch { return { role: 'alone' }; }
  }
  function save() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ---------------------------------------------------------------------------------------------- engines
  function setRunning(on) {
    if (on === running) return;
    running = on;
    for (const e of engines) { try { (on ? e.start : e.stop).call(e); } catch (err) { log.warn(`Failover: ${on ? 'start' : 'stop'}: ${err.message}`); } }
  }
  /** Does this installation check and alarm? (alone, master, or a standby that has taken over) */
  const active = () => st.role === 'alone' || st.role === 'master' || (st.role === 'standby' && st.standby?.state === 'active');

  // ---------------------------------------------------------------------------------------------- master side
  function masterAuth(req) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{43})$/.exec(String(req.get('authorization') || ''));
    const want = st.role === 'master' && st.master?.tokenHash ? Buffer.from(st.master.tokenHash, 'base64url') : null;
    // compared in constant time; without a master role a hash of nothing that never fits
    const got = sha256(m ? m[1] : crypto.randomBytes(16));
    if (!m || !want || want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new HttpError(401, 'err.unauthorized');
    st.master.peer = { ip: String(req.ip || '').slice(0, 64), version: line(req.get('x-womn-version') || req.get('user-agent')?.split('/')[1], 40), at: nowIso() };
    try { save(); } catch { /* the next contact writes it */ }
  }

  function makeCode() {
    const pem = certPem();
    if (!pem) throw new HttpError(500, 'err.internal');
    const secret = randomToken(32);
    st.master = { ...(st.master || {}), tokenHash: b64u(sha256(secret)), createdAt: nowIso(), peer: null };
    return `WOMN1-${secret}-${spkiPin(pem)}`;
  }

  // ---------------------------------------------------------------------------------------------- standby side
  const peer = () => ({ address: st.standby.address, pin: st.standby.pin, secret: decrypt(st.standby.token) });

  /** Takes over a copy of the master: checks it, then replaces every table but the local ones in one transaction */
  function importSnapshot(snapFile, key) {
    const check = new Database(snapFile, { readonly: true, fileMustExist: true });
    try {
      const v = check.pragma('user_version', { simple: true });
      const mine = db.pragma('user_version', { simple: true });
      if (v !== mine) throw Object.assign(new Error(`database version differs (master ${v}, here ${mine}) - bring both to the same program version`), { code: 'ESCHEMA' });
      if (v > MIGRATIONS.length) throw new Error('database of the master is newer');
      const kc = check.prepare("SELECT value FROM settings WHERE key='_keycheck'").get();
      // (as with a restore: every database a server has opened carries this check value)
      let opens = !kc;
      try { opens = opens || decryptWith(key, JSON.parse(kc.value)) === 'whatsonmynet'; } catch { opens = false; }
      if (!opens) throw new Error('the key of the master does not open its database');
      if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('copy of the master is damaged');
      if (!check.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1").get()) throw new Error('copy of the master has no administrator');
    } finally { check.close(); }

    // the master's key belongs to the data (stored passwords are encrypted with it): ready before, in use right after
    const newKey = prepareKey(key);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).filter((n) => !LOCAL_TABLES.has(n));
    db.prepare('ATTACH DATABASE ? AS snap').run(snapFile);
    let copied = false;
    try {
      const theirs = new Set(db.prepare("SELECT name FROM snap.sqlite_master WHERE type='table'").all().map((r) => r.name));
      for (const t of tables) if (!theirs.has(t)) throw new Error(`table ${t} missing in the copy of the master`);
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          // who is signed in here, by name: a session must never pass to another person with the same user id
          const signedIn = db.prepare('SELECT s.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id').all();
          for (const t of tables) {
            const cols = db.prepare(`PRAGMA main.table_info("${t}")`).all().map((c) => `"${c.name}"`).join(',');
            db.prepare(`DELETE FROM main."${t}"`).run();
            db.prepare(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM snap."${t}"`).run();
          }
          if (theirs.has('sqlite_sequence')) {
            db.prepare('DELETE FROM main.sqlite_sequence').run();
            db.prepare('INSERT INTO main.sqlite_sequence SELECT * FROM snap.sqlite_sequence').run();
          }
          // sessions of users that do not exist (or may not sign in) on the master are ended here as well
          db.prepare('DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users WHERE active=1)').run();
          const nameOf = db.prepare('SELECT u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?');
          const end = db.prepare('DELETE FROM sessions WHERE id=?');
          for (const x of signedIn) if (nameOf.get(x.id)?.username !== x.username) end.run(x.id);
        })();
        copied = true;
      } finally { db.pragma('foreign_keys = ON'); }
    } finally {
      db.prepare('DETACH DATABASE snap').run();
      if (newKey) (copied ? newKey.commit : newKey.discard)();
    }
    settings.clearCache?.();
  }

  async function sync(key) {
    const tmp = path.join(dataDir, `failover-copy-${process.pid}.sqlite`);
    const gz = `${tmp}.gz`;
    try {
      const r = await pinnedRequest(peer(), 'GET', '/api/failover/snapshot', { toFile: gz });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(tmp, { mode: 0o600 }));
      importSnapshot(tmp, key);
      st.standby.lastSync = nowIso();
      st.standby.syncError = '';
      return true;
    } finally {
      for (const f of [gz, tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
    }
  }

  /** One round of the standby: ask the master; take its data; take over or hand back */
  async function standbyTick() {
    const s = st.standby;
    let hello = null; let err = null;
    try {
      const r = await pinnedRequest(peer(), 'GET', '/api/failover/hello');
      if (r.status === 401) err = Object.assign(new Error('the master no longer knows this standby (pairing removed or new code)'), { code: 'EUNPAIRED' });
      else if (r.status !== 200 || !r.json?.ok) err = new Error(r.json?.error?.message || `HTTP ${r.status}`);
      else if (r.json.role === 'yielded') err = Object.assign(new Error('the master was replaced by another one'), { code: 'EUNPAIRED' });
      else hello = r.json;
    } catch (e) { err = e; }

    if (err?.code === 'EUNPAIRED') {
      // not a failure of the master: it said no. Quiet, until someone decides here.
      if (s.state === 'active') endTakeover('unpaired');
      s.state = 'detached';
      s.lastError = err.message;
      setRunning(false);
      save();
      return;
    }
    if (hello) {
      s.lastContact = nowIso();
      s.lastError = '';
      s.masterVersion = line(hello.version, 40);
      if (s.state === 'active') {
        endTakeover('back');
        notify({ kind: 'failover', what: 'back', master: s.address }).catch(() => {});
        log.info(`Failover: master ${s.address} answers again - this server is standby again`);
      }
      if (s.state !== 'listening') { s.state = 'listening'; setRunning(false); }
      const mine = db.pragma('user_version', { simple: true });
      if (hello.schema !== mine) {
        // different program versions: the data cannot be taken; taking over still works with the last copy
        s.syncError = `program versions differ (master ${s.masterVersion}, here ${config.version}) - update both`;
        save();
        return;
      }
      const due = !s.lastSync || Date.now() - Date.parse(s.lastSync) >= SYNC_MS || s.needSync;
      // after a failed attempt not again within the minute (a copy is large)
      if (due && (!s.syncError || Date.now() - lastSyncTry > 50 * 1000)) {
        lastSyncTry = Date.now();
        try {
          // the key only when the data are taken (stored passwords of the master are encrypted with it)
          const k = await pinnedRequest(peer(), 'GET', '/api/failover/hello?key=1');
          if (k.status !== 200 || !k.json?.key) throw new Error(`HTTP ${k.status}`);
          await sync(Buffer.from(String(k.json.key), 'base64'));
          s.needSync = false;
        } catch (e) {
          s.syncError = whyText(e);
          log.warn(`Failover: taking the data of the master failed: ${s.syncError}`);
        }
      }
      save();
      return;
    }
    // no answer
    s.lastError = whyText(err);
    const since = Date.parse(s.lastContact || s.pairedAt);
    if (s.state === 'listening' && Date.now() - since >= (s.delayMin || DELAY_MIN.default) * 60 * 1000) {
      s.state = 'active';
      s.activeSince = nowIso();
      st.takeovers = [{ from: s.activeSince, to: null, why: s.lastError, lastData: s.lastSync || null }, ...(st.takeovers || [])].slice(0, 20);
      setRunning(true);
      log.warn(`Failover: master ${s.address} has not answered for ${Math.round((Date.now() - since) / 60000)} min (${s.lastError}) - this server takes over`);
      audit('failover.takeover', s.address);
      notify({ kind: 'failover', what: 'takeover', master: s.address, min: Math.round((Date.now() - since) / 60000) }).catch(() => {});
    }
    save();
  }

  /** End of a takeover: what happened here meanwhile is kept with it (the data are replaced by the master's next) */
  function endTakeover(why) {
    const t = (st.takeovers || [])[0];
    if (!t || t.to) return;
    t.to = nowIso();
    t.end = why;
    try {
      t.events = db.prepare(`SELECT e.at, e.kind, e.message, e.notified, m.name FROM monitor_events e JOIN monitors m ON m.id=e.monitor_id
        WHERE e.at >= ? AND e.kind IN ('down','up','escalate','unreachable') ORDER BY e.at LIMIT 200`).all(t.from)
        .map((e) => ({ at: e.at, kind: e.kind, name: e.name, message: String(e.message || '').slice(0, 300), notified: String(e.notified || '').slice(0, 200) }));
    } catch (e) { log.warn(`Failover: takeover record: ${e.message}`); }
    st.standby.state = 'listening';
    st.standby.needSync = true;
    audit('failover.handback', st.standby.address);
  }

  /** Promoted master: tells the old one on its next contact, so it keeps quiet */
  async function formerTick() {
    try {
      const r = await pinnedRequest({ address: st.former.address, pin: st.former.pin, secret: decrypt(st.former.token) }, 'POST', '/api/failover/yield', { body: {} });
      if (r.status === 200 || r.status === 401) {
        log.info(`Failover: the former master ${st.former.address} ${r.status === 200 ? 'knows now that it was replaced' : 'no longer has the pairing'}`);
        delete st.former;
        save();
      }
    } catch { /* still away - next time */ }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (st.role === 'standby' && st.standby) await standbyTick();
      if (st.former) await formerTick();
    } catch (e) { lastError = e.message; log.warn(`Failover: ${e.message}`); } finally { busy = false; }
  }

  function startTimer() { if (!timer) { timer = setInterval(() => { tick(); }, HELLO_MS); timer.unref(); } }

  // ---------------------------------------------------------------------------------------------- public
  return {
    active,
    /** Standby (listening, detached) or replaced: the interface only reads */
    readOnly: () => !active(),
    /** At start: engines when this installation is active, the standby rounds when paired */
    boot() {
      setRunning(active());
      startTimer();
      if (st.role === 'standby' || st.former) setTimeout(() => { tick(); }, 3000).unref();
    },
    stop() { clearInterval(timer); timer = null; setRunning(false); },
    tick,
    /** Tests only: the state as it is stored */
    _state: () => st,
    /** Write block for the API while standby */
    middleware() {
      return (req, _res, next) => {
        if (active() || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || WRITE_OK.some((re) => re.test(req.originalUrl.split('?')[0]))) return next();
        next(new HttpError(409, st.role === 'yielded' ? 'err.foYielded' : 'err.foStandby'));
      };
    },

    /** What every user sees at the top: null when this installation works normally */
    banner() {
      const s = st.standby;
      if (st.role === 'yielded') return { mode: 'yielded', since: st.yielded?.at || null };
      if (st.role !== 'standby' || !s) return { mode: null };
      return { mode: s.state === 'active' ? 'active' : s.state === 'detached' ? 'detached' : 'standby', since: s.state === 'active' ? s.activeSince : null, lastSync: s.lastSync || null, syncError: s.syncError || '' };
    },

    status() {
      const s = st.standby;
      return {
        role: st.role,
        version: config.version,
        envKey: keyFromEnvironment(),
        master: st.role === 'master' ? { createdAt: st.master?.createdAt || null, peer: st.master?.peer || null } : null,
        standby: st.role === 'standby' && s ? { address: s.address, delayMin: s.delayMin, state: s.state, pairedAt: s.pairedAt, lastContact: s.lastContact || null,
          lastSync: s.lastSync || null, syncError: s.syncError || '', lastError: s.lastError || '', activeSince: s.state === 'active' ? s.activeSince : null, masterVersion: s.masterVersion || '' } : null,
        former: st.former ? { address: st.former.address } : null,
        yielded: st.role === 'yielded' ? st.yielded || {} : null,
        takeovers: st.takeovers || [],
      };
    },

    /** This installation becomes the master: a new pairing code (shown once). A standby with the old code is let go. */
    makeMaster() {
      if (st.role === 'standby') throw new HttpError(409, 'err.foIsStandby');
      const code = makeCode();
      st.role = 'master';
      delete st.yielded;
      save();
      setRunning(true);
      return { code };
    },

    /** Standby: pair with the master (address + code). Takes its data at once - only then it is standby. */
    async pair({ address, code, delayMin }) {
      if (st.role === 'master' && st.master?.peer) throw new HttpError(409, 'err.foIsMaster');
      const addr = normalizeAddress(address);
      const { secret, pin } = parseCode(code);
      const delay = Math.min(DELAY_MIN.max, Math.max(DELAY_MIN.min, Number(delayMin) || DELAY_MIN.default));
      const p = { address: addr, pin, secret };
      let hello;
      try { hello = await pinnedRequest(p, 'GET', '/api/failover/hello?key=1'); } catch (e) { throw new HttpError(502, 'err.foConnect', whyText(e)); }
      if (hello.status === 401) throw new HttpError(400, 'err.foCodeWrong', '', 'code');
      if (hello.status !== 200 || !hello.json?.ok) throw new HttpError(502, 'err.foConnect', `HTTP ${hello.status}`);
      const key = Buffer.from(String(hello.json.key || ''), 'base64');
      if (key.length !== 32) throw new HttpError(502, 'err.foConnect', 'no key');
      if (keyFromEnvironment() && Buffer.compare(key, currentKey()) !== 0) throw new HttpError(400, 'err.foEnvKey');
      if (hello.json.schema !== db.pragma('user_version', { simple: true })) throw new HttpError(400, 'err.foVersion', `${hello.json.version} / ${config.version}`);
      const before = st;
      setRunning(false);
      st = { ...st, role: 'standby', standby: { address: addr, pin, token: '', delayMin: delay, state: 'listening', pairedAt: nowIso(), lastContact: nowIso() } };
      delete st.master;
      try {
        // sync() uses peer(): the secret goes into the file only encrypted - with the key in use after the sync
        st.standby.token = encrypt(secret);
        await sync(key);
        st.standby.token = encrypt(secret);
      } catch (e) {
        st = before;
        setRunning(active());
        throw new HttpError(502, 'err.foSync', whyText(e));
      }
      save();
      startTimer();
      log.info(`Failover: standby of ${addr} - takes over after ${delay} min without an answer`);
      return this.status();
    },

    /** Standby: time until it takes over */
    setDelay(min) {
      if (st.role !== 'standby') throw new HttpError(409, 'err.badRequest');
      st.standby.delayMin = Math.min(DELAY_MIN.max, Math.max(DELAY_MIN.min, Math.round(Number(min)) || DELAY_MIN.default));
      save();
      return this.status();
    },

    /** Standby → master for good. The old master is told on its next contact (and keeps quiet). */
    promote() {
      if (st.role !== 'standby') throw new HttpError(409, 'err.badRequest');
      const s = st.standby;
      if (s.state === 'active') endTakeover('promoted');
      st.former = { address: s.address, pin: s.pin, token: s.token };
      delete st.standby;
      st.role = 'master';
      st.master = null;
      const { code } = this.makeMaster();
      startTimer();
      setTimeout(() => { tick(); }, 1000).unref();
      log.warn(`Failover: this server is the master now (replaces ${st.former.address})`);
      return { code };
    },

    /** Ends the pairing on this side: master → alone (its standby is let go), standby/replaced → alone and active */
    unpair() {
      const was = st.role;
      if (st.role === 'standby' && st.standby?.state === 'active') endTakeover('alone');
      st = { role: 'alone', takeovers: st.takeovers || [], ...(st.former ? { former: st.former } : {}) };
      save();
      setRunning(true);
      return { was };
    },

    // ---- endpoints of the master (called by the standby with its secret)
    hello(req) {
      masterAuth(req);
      return { ok: true, role: st.role, version: config.version, schema: db.pragma('user_version', { simple: true }), at: nowIso(),
        ...(req.query.key === '1' ? { key: currentKey().toString('base64') } : {}) };
    },
    async sendSnapshot(req, res) {
      masterAuth(req);
      const f = await snapshot();
      try {
        // who is signed in here stays here: the sessions (their ids sign in) leave the copy, overwritten on disk
        const c = new Database(f);
        try { c.pragma('secure_delete = ON'); c.prepare('DELETE FROM sessions').run(); } finally { c.close(); }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-WOMN-Schema', String(db.pragma('user_version', { simple: true })));
        await pipeline(fs.createReadStream(f), zlib.createGzip({ level: 6 }), res);
      } finally { discard(f); }
    },
    /** The standby was made master: this one keeps quiet from now on */
    yieldTo(req) {
      masterAuth(req);
      st.role = 'yielded';
      st.yielded = { at: nowIso(), ip: String(req.ip || '').slice(0, 64) };
      save();
      setRunning(false);
      log.warn(`Failover: ${st.yielded.ip} is the master now - this server keeps quiet (Settings → Failover)`);
      audit('failover.yielded', st.yielded.ip);
      return { ok: true };
    },
  };
}
