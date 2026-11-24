// Scan agents: a second WhatsOnMyNet container in a branch office scans its subnets there (ARP works only
// inside the network) and sends the results to this server over HTTPS. Each agent belongs to one location,
// signs in with its own token (only a hash is stored) and may only report addresses of its location's subnets.
// SNMP access data an agent gets is chosen per agent (snmp_mode): none (only "public"), its own (stored encrypted on the
// agent) or all of this server (agents from before 0.57 keep that, so their scans go on as before). An agent never gets
// access data of other locations unless an admin chose "all" for it.
import crypto from 'node:crypto';
import { HttpError, line, str } from './lib/http.js';
import { parseCidr, cidrContains, isIPv4, normalizeMac } from './lib/net.js';
import { TYPES } from './scan/classify.js';
import { randomToken } from './lib/crypto.js';
import { cleanScanFacts } from './scanfacts.js';
import { encrypt, decrypt } from './lib/crypto.js';
import { parseV3, v3FromForm, v3Public, communitiesFromForm, parseCommunities } from './snmpcreds.js';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const MAX_RESULTS = 4096;
export const SNMP_MODES = ['none', 'own', 'all'];
const open = (blob) => { try { return decrypt(blob); } catch { return ''; } };

export function createAgents({ db, settings, inventory, scanner }) {
  // What the admin page sees of an agent: the mode, whether communities are stored and the v3 users without keys
  const shown = (a) => {
    if (!a) return a;
    const { snmp_communities: c, snmp_v3: v, ...rest } = a;
    return { ...rest, snmp_communities_set: !!open(c), snmp_v3: v3Public(open(v)) };
  };
  const COLS = 'a.id, a.name, a.location_id, l.name location_name, a.enabled, a.created_at, a.last_seen, a.last_ip, a.version, a.snmp_mode, a.snmp_communities, a.snmp_v3';
  const get = (id) => shown(db.prepare(`SELECT ${COLS} FROM agents a JOIN locations l ON l.id=a.location_id WHERE a.id=?`).get(id));
  const subnetsOf = (locationId) => db.prepare('SELECT cidr FROM subnets WHERE location_id=? ORDER BY cidr').all(locationId).map((r) => r.cidr);
  const insertResult = db.prepare(`INSERT INTO scan_results(scan_id,ip,mac,hostname,vendor,detected_type,confidence,facts,status,location_id)
    VALUES(@scan_id,@ip,@mac,@hostname,@vendor,@detected_type,@confidence,@facts,'pending',@location_id)`);

  function clean(input) {
    const name = line(input.name, 80);
    if (!name) throw new HttpError(400, 'err.nameRequired');
    const loc = Number(input.location_id);
    if (!loc || !db.prepare('SELECT 1 FROM locations WHERE id=?').get(loc)) throw new HttpError(400, 'err.location');
    return { name, location_id: loc };
  }

  /**
   * SNMP choice of the form → columns. Communities are only replaced when sent (empty string = none stored), a v3 key
   * left empty keeps the stored one of that user (the page never gets the keys). Leaving "own" forgets the stored data.
   */
  function snmpOf(input, old) {
    const mode = SNMP_MODES.includes(input.snmp_mode) ? input.snmp_mode : (old?.snmp_mode || 'none');
    if (mode !== 'own') return { snmp_mode: mode, snmp_communities: '', snmp_v3: '' };
    const comm = typeof input.snmp_communities === 'string' ? communitiesFromForm(input.snmp_communities) : open(old?.snmp_communities || '');
    const v3 = Array.isArray(input.snmp_v3) ? v3FromForm(input.snmp_v3, parseV3(open(old?.snmp_v3 || ''))) : parseV3(open(old?.snmp_v3 || ''));
    return { snmp_mode: mode, snmp_communities: encrypt(comm), snmp_v3: v3.length ? encrypt(JSON.stringify(v3)) : '' };
  }

  /** The access data this agent may use - in the format of the settings (communities by line, v3 users as JSON) */
  function credentialsFor(agent) {
    if (agent.snmp_mode === 'all') return { communities: String(settings.get('scan.snmpCommunities') || ''), v3: String(settings.get('scan.snmpV3') || '') };
    if (agent.snmp_mode !== 'own') return { communities: '', v3: '' };
    const v3 = parseV3(open(agent.snmp_v3)).map(({ v3: _v, ...u }) => u);
    return { communities: parseCommunities(open(agent.snmp_communities)).join('\n'), v3: v3.length ? JSON.stringify(v3) : '' };
  }

  /** Token check for the agent endpoints → agent row (enabled) or 401 */
  function authenticate(req) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(String(req.get('authorization') || ''));
    if (!m) throw new HttpError(401, 'err.unauthorized');
    const a = db.prepare('SELECT * FROM agents WHERE token_hash=?').get(sha256(m[1]));
    if (!a || !a.enabled) throw new HttpError(401, 'err.unauthorized');
    db.prepare('UPDATE agents SET last_seen=?, last_ip=?, version=? WHERE id=?').run(new Date().toISOString(), String(req.ip || '').slice(0, 64), line(req.get('x-womn-agent-version'), 40), a.id);
    return a;
  }

  /** What the agent needs: its subnets, the scan settings, the nightly time and open jobs (taken now) */
  function poll(agent) {
    const ts = new Date().toISOString();
    const jobs = db.prepare('SELECT id, kind FROM agent_jobs WHERE agent_id=? AND taken_at IS NULL ORDER BY id LIMIT 5').all(agent.id);
    for (const j of jobs) db.prepare('UPDATE agent_jobs SET taken_at=? WHERE id=?').run(ts, j.id);
    const cred = credentialsFor(agent);
    return {
      agent: { id: agent.id, name: agent.name },
      subnets: subnetsOf(agent.location_id),
      scan: { ping: !!settings.get('scan.ping'), snmp: !!settings.get('scan.snmp'), httpTitles: !!settings.get('scan.httpTitles'), rate: settings.get('scan.rate'), snmpCommunities: cred.communities, snmpV3: cred.v3 },
      nightly: { enabled: !!settings.get('lightscan.enabled'), time: settings.get('lightscan.time') },
      jobs,
    };
  }

  /** Results of one scan of the agent → a scan here (like a local one: inventory update, notices, history) */
  function report(agent, body) {
    const kind = body.kind === 'light' ? 'light' : 'network';
    const subnets = subnetsOf(agent.location_id).map(parseCidr).filter(Boolean);
    const list = Array.isArray(body.results) ? body.results.slice(0, MAX_RESULTS) : [];
    const ts = new Date().toISOString();
    // The agent's clock is not trusted: a start in the future (or no valid time) is the time it arrived here - a scan
    // "from the future" would make every device seen by later scans look missing
    const sent = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(String(body.startedAt || '')) ? Date.parse(body.startedAt) : NaN;
    const startedAt = Number.isFinite(sent) && sent <= Date.parse(ts) ? new Date(sent).toISOString() : ts;
    const scanId = Number(db.prepare('INSERT INTO scans(kind,status,targets,started_at,finished_at,user,stats) VALUES(?,?,?,?,?,?,?)').run(kind, 'done',
      JSON.stringify(subnets.map((c) => ({ cidr: c.cidr, locationId: agent.location_id }))), startedAt, ts, `agent:${agent.name}`,
      JSON.stringify({ probed: 0, durationMs: Math.max(0, Date.parse(ts) - Date.parse(startedAt)), agent: agent.name })).lastInsertRowid);
    let n = 0; let rejected = 0;
    for (const r of list) {
      const ip = line(r?.ip, 15);
      // Only addresses of the agent's own location - an agent can never write into another network
      if (!isIPv4(ip) || !subnets.some((c) => cidrContains(c, ip))) { rejected++; continue; }
      let facts = JSON.stringify({ ...cleanScanFacts(r.facts), agent: agent.name });
      if (facts.length > 64 * 1024) facts = JSON.stringify({ agent: agent.name });
      const id = insertResult.run({ scan_id: scanId, ip, mac: normalizeMac(r.mac) || null, hostname: line(r.hostname, 200), vendor: line(r.vendor, 120),
        detected_type: TYPES.includes(r.detected_type) ? r.detected_type : 'unknown', confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
        facts, location_id: agent.location_id }).lastInsertRowid;
      inventory.applyResult(id, { deep: false, onlyLocation: agent.location_id });
      n++;
    }
    db.prepare('UPDATE scans SET stats=? WHERE id=?').run(JSON.stringify({ probed: n, rejected, durationMs: Math.max(0, Date.parse(ts) - Date.parse(startedAt)), agent: agent.name }), scanId);
    inventory.finishScan(scanId);
    const jobId = Number(body.jobId) || null;
    if (jobId) db.prepare('UPDATE agent_jobs SET done_at=?, scan_id=? WHERE id=? AND agent_id=?').run(ts, scanId, jobId, agent.id);
    // Old scans go like after a local scan (otherwise every agent report would be kept forever)
    scanner?.pruneOld?.();
    return { scanId, accepted: n, rejected };
  }

  return {
    get,
    authenticate,
    poll,
    report,
    list: () => db.prepare(`SELECT ${COLS},
      (SELECT COUNT(*) FROM agent_jobs j WHERE j.agent_id=a.id AND j.done_at IS NULL) open_jobs
      FROM agents a JOIN locations l ON l.id=a.location_id ORDER BY a.name`).all().map(shown),
    /** New agent: the token is returned exactly once */
    create(input) {
      const v = clean(input);
      const sn = snmpOf(input, null);
      const token = randomToken(32);
      const id = db.prepare('INSERT INTO agents(name,location_id,token_hash,created_at,snmp_mode,snmp_communities,snmp_v3) VALUES(?,?,?,?,?,?,?)')
        .run(v.name, v.location_id, sha256(token), new Date().toISOString(), sn.snmp_mode, sn.snmp_communities, sn.snmp_v3).lastInsertRowid;
      return { ...get(id), token };
    },
    update(id, input) {
      const old = db.prepare('SELECT snmp_mode, snmp_communities, snmp_v3 FROM agents WHERE id=?').get(id);
      if (!old) throw new HttpError(404, 'err.notFound');
      const v = clean(input);
      const sn = snmpOf(input, old);
      db.prepare('UPDATE agents SET name=?, location_id=?, enabled=?, snmp_mode=?, snmp_communities=?, snmp_v3=? WHERE id=?')
        .run(v.name, v.location_id, input.enabled === false ? 0 : 1, sn.snmp_mode, sn.snmp_communities, sn.snmp_v3, id);
      return get(id);
    },
    newToken(id) {
      if (!get(id)) throw new HttpError(404, 'err.notFound');
      const token = randomToken(32);
      db.prepare('UPDATE agents SET token_hash=? WHERE id=?').run(sha256(token), id);
      return { ...get(id), token };
    },
    remove(id) { if (!db.prepare('DELETE FROM agents WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound'); },
    /** Scan job for the agent of a location (null = no agent there) */
    jobForLocation(locationId, kind, user) {
      const a = db.prepare('SELECT id, name FROM agents WHERE location_id=? AND enabled=1 ORDER BY id LIMIT 1').get(locationId);
      if (!a) return null;
      db.prepare('INSERT INTO agent_jobs(agent_id,kind,created_at,created_by) VALUES(?,?,?,?)').run(a.id, kind, new Date().toISOString(), str(user, 64));
      return a.name;
    },
    hasAgent: (locationId) => !!db.prepare('SELECT 1 FROM agents WHERE location_id=? AND enabled=1').get(locationId),
    scanner,
  };
}
