// Scan agent for branch offices: scans the subnets of its location there (ARP only works inside the network)
// and sends the results to the central WhatsOnMyNet over HTTPS. Stores nothing but a small state file.
//
// Environment:
//   WOMN_AGENT_SERVER       https://womn.firma.local:8743  (address of the central server)
//   WOMN_AGENT_TOKEN        token from Settings → Scan agents
//   WOMN_AGENT_CA           certificate of the central server (base64 of its PEM, shown in the central settings) –
//                           needed for the self-signed certificate; empty = normal check against public CAs
//   WOMN_AGENT_INTERVAL     seconds between two questions to the server (default 60)
import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { log } from './lib/log.js';
import { useEphemeralKey } from './lib/crypto.js';
import { openDatabase } from './db.js';
import { createSettings } from './settings.js';
import { createInventory } from './inventory.js';
import { createScanner } from './scan/engine.js';
import { isDue, localDay } from './scan/nightly.js';

const ALIVE = '/tmp/womn-agent.ok';

export function agentConfig(env = process.env) {
  const server = String(env.WOMN_AGENT_SERVER || '').trim().replace(/\/+$/, '');
  const token = String(env.WOMN_AGENT_TOKEN || '').trim();
  if (!/^https:\/\/[^\s/]+(:\d+)?$/i.test(server)) throw new Error('WOMN_AGENT_SERVER must be https://<central server>[:port]');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('WOMN_AGENT_TOKEN is missing or invalid - create one under Settings → Scan agents');
  let ca = '';
  let fingerprint = '';
  const raw = String(env.WOMN_AGENT_CA || '').trim();
  if (raw) {
    try {
      ca = raw.startsWith('-----BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      fingerprint = new crypto.X509Certificate(ca).fingerprint256;
    } catch { throw new Error('WOMN_AGENT_CA is not a certificate - copy it again from the central server (Settings → Scan agents)'); }
  }
  return { server, token, ca, fingerprint, interval: Math.max(15, Math.min(3600, Number(env.WOMN_AGENT_INTERVAL) || 60)) };
}

/**
 * HTTPS agent. With WOMN_AGENT_CA the central certificate is the only trusted one (pinned): the chain is checked
 * against it and the server must present exactly this certificate - then the name in it does not matter (the agent
 * may use an IP address). Without, the normal check against public CAs applies. The TLS check always happens
 * before anything - the token included - is sent.
 */
export function makeHttpsAgent(cfg) {
  if (!cfg.ca) return new https.Agent({ keepAlive: false });
  return new https.Agent({
    keepAlive: false,
    ca: [cfg.ca],
    checkServerIdentity: (_host, cert) => (cert?.fingerprint256 === cfg.fingerprint ? undefined
      : new Error('the server presents another certificate than WOMN_AGENT_CA')),
  });
}

export function createClient(cfg) {
  const agent = makeHttpsAgent(cfg);
  function request(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const u = new URL(p, `${cfg.server}/`);
      const req = https.request(u, { method, agent, timeout: 60000, headers: {
        Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', 'X-WOMN-Request': '1', 'X-WOMN-Agent-Version': config.version,
        'User-Agent': `WhatsOnMyNet-Agent/${config.version}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(Object.assign(new Error(json?.error?.message || `HTTP ${res.statusCode}`), { status: res.statusCode }));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(data || undefined);
    });
  }
  return { poll: () => request('GET', '/api/agent/poll'), report: (body) => request('POST', '/api/agent/results', body) };
}

/** Runs one scan locally (in-memory database) and returns the result rows */
export async function scanLocally(kind, subnets, scanSettings) {
  const db = openDatabase(':memory:');
  try {
    const settings = createSettings(db);
    for (const [k, v] of Object.entries(scanSettings || {})) if (v !== undefined) settings.set(`scan.${k}`, v);
    const inventory = createInventory(db);
    const scanner = createScanner({ db, settings, inventory });
    const targets = subnets.map((cidr) => ({ cidr, locationId: null }));
    const startedAt = new Date().toISOString();
    const id = kind === 'light' ? scanner.startLight(targets, 'agent') : scanner.startNetwork(targets, 'agent');
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const p = scanner.progress(id);
      if (!p || p.finished) break;
    }
    await new Promise((r) => setTimeout(r, 200));
    const results = db.prepare('SELECT ip, mac, hostname, vendor, detected_type, confidence, facts FROM scan_results WHERE scan_id=?').all(id)
      .map((r) => ({ ...r, facts: JSON.parse(r.facts || '{}') }));
    return { kind, startedAt, results };
  } finally {
    db.close();
  }
}

async function main() {
  const cfg = agentConfig();
  useEphemeralKey();
  const client = createClient(cfg);
  const stateFile = path.join(config.dataDir, 'agent-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first start */ }
  const save = () => { try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); } catch (e) { log.warn(`State file: ${e.message}`); } };
  log.info(`WhatsOnMyNet scan agent ${config.version} - server ${cfg.server}${cfg.ca ? ' (certificate pinned)' : ''}`);

  let busy = false;
  const run = async (kind, info, jobId = null) => {
    if (!info.subnets.length) { log.warn('No subnets at the location of this agent - add them in the central server under Locations.'); return; }
    log.info(`${kind === 'light' ? 'Light scan' : 'Scan'} of ${info.subnets.join(', ')} ...`);
    const out = await scanLocally(kind, info.subnets, info.scan);
    const r = await client.report({ ...out, jobId });
    log.info(`Sent ${out.results.length} device(s) - accepted ${r.accepted}${r.rejected ? `, refused ${r.rejected}` : ''}`);
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const info = await client.poll();
      fs.writeFileSync(ALIVE, new Date().toISOString());
      for (const j of info.jobs || []) await run(j.kind, info, j.id);
      if (info.nightly?.enabled && isDue(new Date(), info.nightly.time, state.lastNightly)) {
        state.lastNightly = localDay(new Date());
        save();
        await run('light', info);
      }
    } catch (e) {
      log.warn(`Server ${cfg.server}: ${e.message}${e.status === 401 ? ' - is the token right and the agent switched on?' : ''}`);
    } finally { busy = false; }
  };
  await tick();
  const timer = setInterval(tick, cfg.interval * 1000);
  const stop = (sig) => { log.info(`${sig} received, agent stops`); clearInterval(timer); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => { log.error(e.message); process.exit(1); });
}
