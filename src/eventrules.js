// Event rules: chosen messages (Windows events through NXLog, syslog, traps) go to chosen recipients - a mailbox, a
// ticket system, a webhook - apart from the monitors and their alarms. "Defender found a virus", "AppLocker blocked a
// program", "an account was locked": each one a mail or ticket, nothing on the phone unless that channel is picked.
//
// - A rule only sends to the channels it names (never to the default channels of the monitors).
// - "each": one notification per message, at most N per hour; what comes beyond the limit is sent collected.
//   "digest": collected, one notification every X minutes.
// - What a rule matched is written down first (event_rule_hits) and marked when it went out: a mail server that is
//   down, a restart in between - nothing is lost; it is tried again every 5 minutes for an hour.
// - Only the active installation sends (alone, master, or a standby that has taken over): failover.js starts/stops this
//   like the other engines, so a sender that sends to both does not open two tickets.
import { HttpError, line } from './lib/http.js';
import { log } from './lib/log.js';

const MAX_LIST = 20;          // words, senders per rule
const MAX_IDS = 50;           // event id ranges per rule
const RETRY_MS = 5 * 60 * 1000;
const MAX_TRIES = 12;
const DIGEST_LIST = 50;       // messages listed in one collected notification
const ROUND_MS = 30 * 1000;

const lower = (s) => String(s ?? '').toLowerCase();
const words = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]/)).map((w) => line(w, 200).trim()).filter(Boolean);

/** "1116, 1117, 865-868" → [[1116,1116],[1117,1117],[865,868]]; null when something is not an id or range */
export function parseEventIds(text) {
  const out = [];
  for (const part of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(part);
    if (!m) return null;
    const lo = Number(m[1]); const hi = m[2] ? Number(m[2]) : lo;
    if (hi < lo || hi - lo > 100000) return null;
    out.push([lo, hi]);
  }
  return out;
}

/** The filter of a rule from the form → the stored shape (throws HttpError naming the field) */
export function cleanMatch(m = {}) {
  const kind = ['syslog', 'trap'].includes(m.kind) ? m.kind : '';
  const sv = m.maxSeverity === undefined || m.maxSeverity === null || m.maxSeverity === '' ? 7 : Number(m.maxSeverity);
  const maxSeverity = Number.isInteger(sv) ? Math.max(0, Math.min(7, sv)) : 7;
  const deviceId = Number(m.deviceId) > 0 ? Number(m.deviceId) : null;
  const eventIds = line(m.eventIds, 500).trim();
  const ranges = parseEventIds(eventIds);
  if (!ranges || ranges.length > MAX_IDS) throw new HttpError(400, 'err.ruleEventIds', undefined, 'eventIds');
  const from = words(m.from); const any = words(m.words); const none = words(m.notWords);
  if (from.length > MAX_LIST || any.length > MAX_LIST || none.length > MAX_LIST) throw new HttpError(400, 'err.ruleTooMany');
  const out = { kind, maxSeverity, deviceId, eventIds: ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', '),
    from, channel: line(m.channel, 120).trim(), source: line(m.source, 120).trim(), words: any, notWords: none };
  // a rule must choose something - "everything" would send every message
  if (!kind && maxSeverity === 7 && !deviceId && !out.eventIds && !from.length && !out.channel && !out.source && !any.length) throw new HttpError(400, 'err.ruleEmpty');
  return out;
}

/**
 * Does a stored message match the filter? row: events_in (+ device_name). A message without source and log (NXLog
 * without JSON: only time, host, severity, id and text) cannot say where it came from - there the event id decides alone.
 */
export function ruleMatches(m, row) {
  if (m.kind && row.kind !== m.kind) return false;
  if (row.severity > (m.maxSeverity ?? 7)) return false;
  if (m.deviceId && row.device_id !== m.deviceId) return false;
  if (m.eventIds) {
    const id = row.event_id;
    if (id === null || id === undefined) return false;
    if (!(m._ranges || parseEventIds(m.eventIds) || []).some(([a, b]) => id >= a && id <= b)) return false;
  }
  const unknownOrigin = row.event_id !== null && row.event_id !== undefined && !row.app && !row.channel;
  if (m.source && !unknownOrigin && !lower(row.app).includes(lower(m.source))) return false;
  if (m.channel && !unknownOrigin && !lower(row.channel).includes(lower(m.channel))) return false;
  if (m.from?.length) {
    const who = [row.source_ip, row.host, row.device_name].map(lower);
    if (!m.from.some((f) => who.some((w) => w.includes(lower(f))))) return false;
  }
  if (m.words?.length || m.notWords?.length) {
    const text = lower(`${row.app} ${row.text} ${row.account || ''}`);
    if (m.words?.length && !m.words.some((w) => text.includes(lower(w)))) return false;
    if (m.notWords?.some((w) => text.includes(lower(w)))) return false;
  }
  return true;
}

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function createEventRules({ db, channels, now = () => new Date() }) {
  let running = false; let timer = null; let rounds = 0;
  let cache = null; let cacheAt = 0;
  const singles = new Map();     // rule id → times of single notifications in the last hour
  const inflight = new Set();    // hits being sent right now
  const iso = () => now().toISOString();

  function shape(r) {
    if (!r) return null;
    const match = parse(r.match, {});
    return { id: r.id, name: r.name, enabled: !!r.enabled, match, channels: parse(r.channels, []), mode: r.mode, digest_min: r.digest_min, max_per_hour: r.max_per_hour,
      created_at: r.created_at, updated_at: r.updated_at };
  }
  function rules() {
    if (!cache || now() - cacheAt > ROUND_MS) {
      cache = db.prepare('SELECT * FROM event_rules WHERE enabled=1 ORDER BY id').all().map(shape)
        .map((r) => ({ ...r, match: { ...r.match, _ranges: parseEventIds(r.match.eventIds) || [] } }));
      cacheAt = now();
    }
    return cache;
  }
  const forget = () => { cache = null; };

  function clean(input = {}, old = null) {
    const name = line(input.name ?? old?.name, 120).trim();
    if (!name) throw new HttpError(400, 'err.nameRequired', undefined, 'name');
    const match = cleanMatch(input.match ?? old?.match ?? {});
    if (match.deviceId && !db.prepare('SELECT 1 FROM devices WHERE id=?').get(match.deviceId)) throw new HttpError(400, 'err.notFound', undefined, 'deviceId');
    const ids = [...new Set((Array.isArray(input.channels) ? input.channels : old?.channels || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 20);
    const known = ids.filter((id) => db.prepare('SELECT 1 FROM channels WHERE id=?').get(id));
    // never "all default channels": a rule names where it goes
    if (!known.length) throw new HttpError(400, 'err.ruleChannels', undefined, 'channels');
    const mode = (input.mode ?? old?.mode) === 'digest' ? 'digest' : 'each';
    const digest = Number(input.digest_min ?? old?.digest_min ?? 15);
    if (!Number.isInteger(digest) || digest < 1 || digest > 1440) throw new HttpError(400, 'err.ruleDigest', undefined, 'digest_min');
    const perHour = Number(input.max_per_hour ?? old?.max_per_hour ?? 20);
    if (!Number.isInteger(perHour) || perHour < 1 || perHour > 500) throw new HttpError(400, 'err.rulePerHour', undefined, 'max_per_hour');
    return { name, enabled: input.enabled === undefined ? (old ? old.enabled : true) : !!input.enabled, match, channels: known, mode, digest_min: digest, max_per_hour: perHour };
  }

  function stats(id) {
    const since = new Date(now() - 86400000).toISOString();
    const s = db.prepare(`SELECT COUNT(*) day, SUM(sent_at IS NULL) open, SUM(failed) failed, MAX(at) last FROM event_rule_hits WHERE rule_id=? AND at >= ?`).get(id, since);
    const last = s.last || db.prepare('SELECT MAX(at) last FROM event_rule_hits WHERE rule_id=?').get(id).last;
    return { hits24h: s.day || 0, open: s.open || 0, failed24h: s.failed || 0, lastHit: last || null };
  }

  /** The messages of the last days a filter would have matched (the form's "test"): newest first */
  function test(match, { days = 7, limit = 20 } = {}) {
    const m = { ...cleanMatch(match) }; m._ranges = parseEventIds(m.eventIds) || [];
    const since = new Date(now() - days * 86400000).toISOString();
    const rows = db.prepare(`SELECT e.*, d.name device_name FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE e.at >= ? AND e.severity <= ? ORDER BY e.id DESC LIMIT 20000`)
      .all(since, m.maxSeverity);
    const hit = rows.filter((r) => ruleMatches(m, r));
    return { count: hit.length, checked: rows.length, list: hit.slice(0, limit) };
  }

  const eventRow = (id) => db.prepare('SELECT e.*, d.name device_name FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE e.id=?').get(id);

  async function deliver(rule, list, count, since) {
    if (!rule.channels.length) return [];
    return channels.notifyIds(rule.channels, { kind: 'logRule', rule: { id: rule.id, name: rule.name }, events: list, count, since, at: iso() });
  }

  async function sendSingle(rule, hitId, row) {
    inflight.add(hitId);
    try {
      const reached = await deliver(rule, [row], 1, row.at);
      if (reached.length) db.prepare('UPDATE event_rule_hits SET sent_at=? WHERE id=?').run(iso(), hitId);
      else db.prepare('UPDATE event_rule_hits SET tries=tries+1, next_try=? WHERE id=?').run(new Date(now().getTime() + RETRY_MS).toISOString(), hitId);
    } catch (e) {
      log.warn(`Event rule "${rule.name}": ${e.message}`);
    } finally { inflight.delete(hitId); }
  }

  /** A message came in (events.js) → the rules it matches; returns the ids of those rules */
  function onEvent(row) {
    if (!running || !row?.id) return [];
    const list = rules();
    if (!list.length) return [];
    const full = { ...row, device_name: row.device_id ? db.prepare('SELECT name FROM devices WHERE id=?').get(row.device_id)?.name || '' : '' };
    const matched = [];
    for (const rule of list) {
      let ok = false;
      try { ok = ruleMatches(rule.match, full); } catch { ok = false; }
      if (!ok) continue;
      matched.push(rule.id);
      const hitId = Number(db.prepare('INSERT INTO event_rule_hits(rule_id, event_id, at) VALUES(?,?,?)').run(rule.id, row.id, row.at || iso()).lastInsertRowid);
      if (rule.mode !== 'each') continue;
      const t = now().getTime();
      const sent = (singles.get(rule.id) || []).filter((x) => t - x < 3600000);
      if (sent.length >= rule.max_per_hour) { singles.set(rule.id, sent); continue; } // beyond the limit: collected (flush)
      sent.push(t); singles.set(rule.id, sent);
      sendSingle(rule, hitId, full);
    }
    return matched;
  }

  /**
   * One round: collected notifications that are due. "digest": once the oldest open message is X minutes old.
   * "each": what was beyond the hourly limit or could not be sent, collected after the same time.
   */
  async function flush() {
    if (!running) return 0;
    let sentRounds = 0;
    const t = now().getTime();
    for (const rule of db.prepare('SELECT * FROM event_rules WHERE enabled=1').all().map(shape)) {
      const open = db.prepare('SELECT id, event_id, at, tries, next_try FROM event_rule_hits WHERE rule_id=? AND sent_at IS NULL ORDER BY id').all(rule.id)
        .filter((h) => !inflight.has(h.id));
      if (!open.length) continue;
      if (open.some((h) => h.next_try && Date.parse(h.next_try) > t)) continue;
      if (Date.parse(open[0].at) > t - rule.digest_min * 60000) continue;
      const list = open.slice(0, DIGEST_LIST).map((h) => eventRow(h.event_id)).filter(Boolean);
      const ids = open.map((h) => h.id);
      let reached = [];
      try { reached = await deliver(rule, list, open.length, open[0].at); } catch (e) { log.warn(`Event rule "${rule.name}": ${e.message}`); }
      const mark = (sql, ...args) => { for (let i = 0; i < ids.length; i += 500) { const part = ids.slice(i, i + 500); db.prepare(`${sql} WHERE id IN (${part.map(() => '?').join(',')})`).run(...args, ...part); } };
      if (reached.length) { mark('UPDATE event_rule_hits SET sent_at=?', iso()); sentRounds++; continue; }
      const tries = Math.max(...open.map((h) => h.tries)) + 1;
      if (tries >= MAX_TRIES) {
        mark('UPDATE event_rule_hits SET sent_at=?, failed=1', iso());
        log.warn(`Event rule "${rule.name}": ${open.length} message(s) could not be sent for an hour - given up (see the log of the channels)`);
      } else mark('UPDATE event_rule_hits SET tries=?, next_try=?', tries, new Date(t + RETRY_MS).toISOString());
    }
    // what went out a week ago is no longer needed (the messages themselves stay as long as set)
    if (++rounds % 120 === 1) db.prepare('DELETE FROM event_rule_hits WHERE sent_at IS NOT NULL AND sent_at < ?').run(new Date(t - 7 * 86400000).toISOString());
    return sentRounds;
  }

  return {
    list: () => db.prepare('SELECT * FROM event_rules ORDER BY name COLLATE NOCASE').all().map((r) => ({ ...shape(r), ...stats(r.id) })),
    get: (id) => shape(db.prepare('SELECT * FROM event_rules WHERE id=?').get(id)),
    create(input) {
      const c = clean(input);
      const ts = iso();
      const id = Number(db.prepare('INSERT INTO event_rules(name, enabled, match, channels, mode, digest_min, max_per_hour, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(c.name, c.enabled ? 1 : 0, JSON.stringify(c.match), JSON.stringify(c.channels), c.mode, c.digest_min, c.max_per_hour, ts, ts).lastInsertRowid);
      forget();
      return this.get(id);
    },
    update(id, input) {
      const old = this.get(id);
      if (!old) throw new HttpError(404, 'err.notFound');
      const c = clean(input, old);
      db.prepare('UPDATE event_rules SET name=?, enabled=?, match=?, channels=?, mode=?, digest_min=?, max_per_hour=?, updated_at=? WHERE id=?')
        .run(c.name, c.enabled ? 1 : 0, JSON.stringify(c.match), JSON.stringify(c.channels), c.mode, c.digest_min, c.max_per_hour, iso(), id);
      // switched off: what was still waiting is not sent any more
      if (!c.enabled) db.prepare('DELETE FROM event_rule_hits WHERE rule_id=? AND sent_at IS NULL').run(id);
      singles.delete(id);
      forget();
      return this.get(id);
    },
    remove(id) {
      if (!db.prepare('DELETE FROM event_rules WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
      db.prepare('DELETE FROM event_rule_hits WHERE rule_id=?').run(id);
      singles.delete(id);
      forget();
    },
    test,
    onEvent,
    flush,
    start() {
      running = true;
      if (!timer) { timer = setInterval(() => { flush().catch((e) => log.warn(`Event rules: ${e.message}`)); }, ROUND_MS); timer.unref(); }
    },
    stop() { running = false; clearInterval(timer); timer = null; },
    forget,
  };
}
