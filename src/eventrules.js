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
// - Counting: "from 5 matches in 10 minutes" (per sender if wanted) - matches are held until the number is reached, then
//   one notification with all of them; fewer in the window are dropped without a word.
// - Regular expression on the text (saferegex.js: checked when saved, and a rule whose expression is ever slow on a
//   message is switched off).
// - Open events: the first match opens one (per rule, sender and key - the first group of the expression, e.g. the
//   port), further matches only count up instead of notifying again; a user acknowledges it; the counter-message
//   ("link up"), a click or a time without news closes it.
import { performance } from 'node:perf_hooks';
import { HttpError, line } from './lib/http.js';
import { log } from './lib/log.js';
import { checkRegexStatic, checkRegexTime, compileRegex, SLOW_MS } from './lib/saferegex.js';

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

/**
 * The list "Windows events: never take these ids": numbers and ranges as before ("4624, 4634, 100-110"), and a number
 * for one source only ("1@Ntfs", "7036@Service Control Manager") - the same number means different things to
 * different sources (1 of Sysmon is a process start). Entries are separated by commas, semicolons or lines; a plain
 * number may also stand after a space. → { ranges: [[a, b]], pairs: [{ id, src }] } or null when an entry is not valid
 */
export function parseDenyList(text) {
  const ranges = []; const pairs = [];
  for (const chunk of String(text ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const at = /^(\d{1,6})\s*@\s*(\S(?:[^@]{0,78}\S)?)$/.exec(chunk);
    if (at) { pairs.push({ id: Number(at[1]), src: at[2].replace(/\s+/g, ' ') }); continue; }
    if (chunk.includes('@')) return null;
    const r = parseEventIds(chunk);
    if (!r) return null;
    ranges.push(...r);
  }
  return { ranges, pairs };
}
/** The list written back: numbers and ranges first (in the order given), then the number@source entries, each once */
export function formatDenyList({ ranges = [], pairs = [] }) {
  const seen = new Set();
  const out = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  for (const p of pairs) { const k = `${p.id}@${p.src.toLowerCase()}`; if (!seen.has(k)) { seen.add(k); out.push(`${p.id}@${p.src}`); } }
  return [...new Set(out)].join(', ');
}
/** Does the list leave out this event? A source entry needs the source of the message (as a rule: "contains") */
export function denies(list, id, app) {
  if (!list || !Number.isInteger(id)) return false;
  if (list.ranges.some(([a, b]) => id >= a && id <= b)) return true;
  const a = String(app || '').toLowerCase();
  return !!a && list.pairs.some((p) => p.id === id && a.includes(p.src.toLowerCase()));
}

/** Is [a, b] fully inside the ranges? */
export function covered(a, b, list) {
  let at = a;
  for (const [x, y] of [...list].sort((p, q) => p[0] - q[0])) { if (x > at) break; if (y >= at) at = y + 1; if (at > b) return true; }
  return at > b;
}
const overlaps = (a, b, list) => list.some(([x, y]) => x <= b && y >= a);

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
  const regex = checkRegexStatic(String(m.regex ?? '').slice(0, 1000), 'regex') || '';
  const out = { kind, maxSeverity, deviceId, eventIds: ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', '),
    from, channel: line(m.channel, 120).trim(), source: line(m.source, 120).trim(), words: any, notWords: none, regex };
  // a rule must choose something - "everything" would send every message
  if (!kind && maxSeverity === 7 && !deviceId && !out.eventIds && !from.length && !out.channel && !out.source && !any.length && !regex) throw new HttpError(400, 'err.ruleEmpty');
  return out;
}

/** Counting and open events of a rule from the form → the stored shape */
export function cleanOptions(o = {}) {
  const int = (v, lo, hi, def, field) => {
    const n = v === undefined || v === null || v === '' ? def : Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, 'err.ruleOption', `${lo}-${hi}`, field);
    return n;
  };
  const c = o.count || {};
  const count = { n: int(c.n, 1, 1000, 1, 'count_n'), minutes: int(c.minutes, 1, 1440, 10, 'count_minutes'), perSender: !!c.perSender };
  const s = o.state || {};
  const closeIds = line(s.closeIds, 500).trim();
  const closeRanges = parseEventIds(closeIds);
  if (!closeRanges || closeRanges.length > MAX_IDS) throw new HttpError(400, 'err.ruleEventIds', undefined, 'closeIds');
  const closeWords = words(s.closeWords);
  if (closeWords.length > MAX_LIST) throw new HttpError(400, 'err.ruleTooMany');
  const state = { open: !!s.open, closeWords, closeIds: closeRanges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', '),
    closeRegex: checkRegexStatic(String(s.closeRegex ?? '').slice(0, 1000), 'closeRegex') || '', expireHours: int(s.expireHours, 0, 720, 0, 'expireHours'), notifyClose: !!s.notifyClose };
  return { count, state };
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
  if (m.regex) {
    if (!m._re) Object.defineProperty(m, '_re', { value: compileRegex(m.regex), enumerable: false });
    if (!m._re.test(String(row.text ?? ''))) return false;
  }
  return true;
}

/** The key of an open event: the first group of the expression (e.g. the port in "Port (\d+) link down"), else '' */
function keyOf(re, text) {
  if (!re) return '';
  const m = re.exec(String(text ?? ''));
  return m && m[1] !== undefined ? String(m[1]).slice(0, 120) : '';
}

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function createEventRules({ db, channels, settings = null, now = () => new Date() }) {
  let running = false; let timer = null; let rounds = 0;
  let cache = null; let cacheAt = 0;
  const singles = new Map();     // rule id → times of single notifications in the last hour
  const inflight = new Set();    // hits being sent right now
  const iso = () => now().toISOString();

  function shape(r) {
    if (!r) return null;
    const match = parse(r.match, {});
    const options = parse(r.options || '{}', {});
    return { id: r.id, name: r.name, enabled: !!r.enabled, match, channels: parse(r.channels, []), mode: r.mode, digest_min: r.digest_min, max_per_hour: r.max_per_hour,
      count: options.count || { n: 1, minutes: 10, perSender: false }, state: options.state || { open: false, closeWords: [], closeIds: '', closeRegex: '', expireHours: 0, notifyClose: false },
      disabled_reason: options.disabledReason || '', created_at: r.created_at, updated_at: r.updated_at };
  }
  function rules() {
    if (!cache || now() - cacheAt > ROUND_MS) {
      cache = db.prepare('SELECT * FROM event_rules WHERE enabled=1 ORDER BY id').all().map(shape)
        .map((r) => {
          const x = { ...r, match: { ...r.match, _ranges: parseEventIds(r.match.eventIds) || [] }, state: { ...r.state, _ranges: parseEventIds(r.state.closeIds) || [] } };
          try { x.state._re = r.state.closeRegex ? compileRegex(r.state.closeRegex) : null; } catch { x.state._re = null; }
          try { x._keyRe = r.match.regex ? compileRegex(r.match.regex) : null; } catch { x._keyRe = null; }
          return x;
        });
      cacheAt = now();
    }
    return cache;
  }
  const forget = () => { cache = null; };

  /** The ids of a rule the receiving does not take (Messages → Receiving settings → Windows events) */
  function blockedIds(eventIds) {
    if (!eventIds || !settings) return [];
    const allow = parseEventIds(String(settings.get('events.winAllow') || '')) || [];
    // only plain numbers block a rule - a number left out for one source leaves the others to the rule
    const deny = parseDenyList(String(settings.get('events.winDeny') || ''))?.ranges || [];
    return (parseEventIds(eventIds) || []).filter(([a, b]) => (allow.length && !covered(a, b, allow)) || overlaps(a, b, deny))
      .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  }

  function clean(input = {}, old = null) {
    const name = line(input.name ?? old?.name, 120).trim();
    if (!name) throw new HttpError(400, 'err.nameRequired', undefined, 'name');
    const match = cleanMatch(input.match ?? old?.match ?? {});
    const bad = blockedIds(match.eventIds);
    // a rule for numbers the receiving does not take would never fire: said at once, not found out weeks later
    if (bad.length) throw new HttpError(400, 'err.ruleIdsFiltered', bad.join(', '), 'eventIds');
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
    const options = cleanOptions({ count: input.count ?? old?.count, state: input.state ?? old?.state });
    return { name, enabled: input.enabled === undefined ? (old ? old.enabled : true) : !!input.enabled, match, channels: known, mode, digest_min: digest, max_per_hour: perHour, options };
  }

  function stats(id) {
    const since = new Date(now() - 86400000).toISOString();
    const s = db.prepare(`SELECT COUNT(*) day, SUM(sent_at IS NULL AND held=0) open, SUM(sent_at IS NULL AND held=1) counting, SUM(failed) failed, MAX(at) last
      FROM event_rule_hits WHERE rule_id=? AND at >= ?`).get(id, since);
    const last = s.last || db.prepare('SELECT MAX(at) last FROM event_rule_hits WHERE rule_id=?').get(id).last;
    const live = db.prepare("SELECT COUNT(*) n FROM event_open WHERE rule_id=? AND state IN ('open','ack')").get(id).n;
    return { hits24h: s.day || 0, open: s.open || 0, counting: s.counting || 0, failed24h: s.failed || 0, lastHit: last || null, openEvents: live };
  }

  /** The messages of the last days a filter would have matched (the form's "test"): newest first */
  function test(match, { days = 7, limit = 20 } = {}) {
    const m = { ...cleanMatch(match) }; m._ranges = parseEventIds(m.eventIds) || [];
    const since = new Date(now() - days * 86400000).toISOString();
    const rows = db.prepare(`SELECT e.*, d.name device_name FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE e.at >= ? AND e.severity <= ? ORDER BY e.id DESC LIMIT 20000`)
      .all(since, m.maxSeverity);
    // a time budget too: the expression was tried before (checkTimes), this is the second belt
    const hit = []; const t0 = performance.now(); let checked = 0;
    for (const r of rows) { if (performance.now() - t0 > 2000) break; checked++; if (ruleMatches(m, r)) hit.push(r); }
    return { count: hit.length, checked, list: hit.slice(0, limit) };
  }

  const eventRow = (id) => db.prepare('SELECT e.*, d.name device_name FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE e.id=?').get(id);

  async function deliver(rule, list, count, since, extra = {}) {
    if (!rule.channels.length) return [];
    return channels.notifyIds(rule.channels, { kind: 'logRule', rule: { id: rule.id, name: rule.name }, events: list, count, since, at: iso(), ...extra });
  }
  const markHits = (ids, sql, ...args) => { for (let i = 0; i < ids.length; i += 500) { const part = ids.slice(i, i + 500); db.prepare(`${sql} WHERE id IN (${part.map(() => '?').join(',')})`).run(...args, ...part); } };

  // ------------------------------------------------------------------------------------------------- open events
  /** The first match opens an event; later ones only count it up (no new notification). Returns true when counted up. */
  function openOrBump(rule, row) {
    const key = keyOf(rule._keyRe, row.text);
    const live = db.prepare("SELECT id FROM event_open WHERE rule_id=? AND source_ip=? AND key=? AND state IN ('open','ack') ORDER BY id DESC LIMIT 1").get(rule.id, row.source_ip, key);
    if (live) {
      db.prepare('UPDATE event_open SET count=count+1, last_at=?, last_event=? WHERE id=?').run(row.at || iso(), row.id, live.id);
      return true;
    }
    db.prepare("INSERT INTO event_open(rule_id, source_ip, key, state, first_at, last_at, first_event, last_event) VALUES(?,?,?, 'open', ?,?,?,?)")
      .run(rule.id, row.source_ip, key, row.at || iso(), row.at || iso(), row.id, row.id);
    return false;
  }
  /** Is this the counter-message of the rule ("link up")? */
  function closes(rule, row) {
    const s = rule.state;
    if (!s?.open) return false;
    if (s._ranges?.length && row.event_id !== null && row.event_id !== undefined && s._ranges.some(([a, b]) => row.event_id >= a && row.event_id <= b)) return true;
    const text = lower(`${row.app} ${row.text}`);
    if (s.closeWords?.length && s.closeWords.some((w) => text.includes(lower(w)))) return true;
    return !!(s._re && s._re.test(String(row.text ?? '')));
  }
  /** Closes the open events of this sender (with this key, if the counter-message has one); entwarnung when wanted */
  function closeBy(rule, row) {
    const key = keyOf(rule.state._re, row.text);
    const live = db.prepare(`SELECT id, key FROM event_open WHERE rule_id=? AND source_ip=? AND state IN ('open','ack')${key ? ' AND key=?' : ''}`).all(...[rule.id, row.source_ip, ...(key ? [key] : [])]);
    if (!live.length) return 0;
    for (const e of live) db.prepare("UPDATE event_open SET state='closed', closed_at=?, closed_how='message', close_event=? WHERE id=?").run(row.at || iso(), row.id, e.id);
    if (rule.state.notifyClose) deliver(rule, [row], 1, row.at, { closed: true, key: live.map((e) => e.key).filter(Boolean).join(', ') }).catch((e) => log.warn(`Event rule "${rule.name}": ${e.message}`));
    return live.length;
  }

  /** An expression that was slow on a message: the rule is switched off, with the reason (it shows in the list) */
  function switchOffSlow(rule, ms) {
    const o = parse(db.prepare('SELECT options FROM event_rules WHERE id=?').get(rule.id)?.options || '{}', {});
    o.disabledReason = `regex slow (${Math.round(ms)} ms)`;
    db.prepare('UPDATE event_rules SET enabled=0, options=?, updated_at=? WHERE id=?').run(JSON.stringify(o), iso(), rule.id);
    log.warn(`Event rule "${rule.name}": its regular expression took ${Math.round(ms)} ms on one message - the rule was switched off`);
    forget();
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
      // the counter-message closes - and never opens anything itself
      if (rule.state?.open) {
        const a = performance.now();
        const isClose = closes(rule, full);
        if (rule.state.closeRegex && performance.now() - a > SLOW_MS) { switchOffSlow(rule, performance.now() - a); continue; }
        if (isClose) { closeBy(rule, full); continue; }
      }
      let ok = false;
      const t0 = performance.now();
      try { ok = ruleMatches(rule.match, full); } catch { ok = false; }
      const took = performance.now() - t0;
      if (rule.match.regex && took > SLOW_MS) { switchOffSlow(rule, took); continue; }
      if (!ok) continue;
      matched.push(rule.id);
      const at = row.at || iso();
      // counting: held until N came in the window (per sender if wanted), then all together in one notification
      if (rule.count?.n > 1) {
        const grp = rule.count.perSender ? row.source_ip : '';
        db.prepare('INSERT INTO event_rule_hits(rule_id, event_id, at, held, grp) VALUES(?,?,?,1,?)').run(rule.id, row.id, at, grp);
        const held = db.prepare('SELECT id, event_id, at FROM event_rule_hits WHERE rule_id=? AND held=1 AND grp=? AND sent_at IS NULL AND at >= ? ORDER BY id')
          .all(rule.id, grp, new Date(now().getTime() - rule.count.minutes * 60000).toISOString());
        if (held.length < rule.count.n) continue;
        const ids = held.map((h) => h.id);
        markHits(ids, 'UPDATE event_rule_hits SET held=0');
        if (rule.state?.open && openOrBump(rule, full)) { markHits(ids, 'UPDATE event_rule_hits SET sent_at=?', iso()); continue; }
        const events = held.slice(-DIGEST_LIST).map((h) => eventRow(h.event_id)).filter(Boolean);
        for (const id of ids) inflight.add(id);
        deliver(rule, events, held.length, held[0].at, { threshold: { n: rule.count.n, minutes: rule.count.minutes, who: grp ? (full.device_name || full.host || grp) : '' } })
          .then((reached) => { if (reached.length) markHits(ids, 'UPDATE event_rule_hits SET sent_at=?', iso()); else markHits(ids, 'UPDATE event_rule_hits SET tries=tries+1, next_try=?', new Date(now().getTime() + RETRY_MS).toISOString()); })
          .catch((e) => log.warn(`Event rule "${rule.name}": ${e.message}`))
          .finally(() => { for (const id of ids) inflight.delete(id); });
        continue;
      }
      const hitId = Number(db.prepare('INSERT INTO event_rule_hits(rule_id, event_id, at) VALUES(?,?,?)').run(rule.id, row.id, at).lastInsertRowid);
      // an open event that is already there: counted up, no new notification
      if (rule.state?.open && openOrBump(rule, full)) { db.prepare('UPDATE event_rule_hits SET sent_at=? WHERE id=?').run(iso(), hitId); continue; }
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
      // counting: what did not reach the number in its window is dropped without a word
      if (rule.count?.n > 1) db.prepare('UPDATE event_rule_hits SET held=0, sent_at=? WHERE rule_id=? AND held=1 AND at < ?').run(iso(), rule.id, new Date(t - rule.count.minutes * 60000).toISOString());
      // open events without news for the time set close by themselves
      if (rule.state?.open && rule.state.expireHours > 0) {
        db.prepare("UPDATE event_open SET state='closed', closed_at=?, closed_how='expired' WHERE rule_id=? AND state IN ('open','ack') AND last_at < ?")
          .run(iso(), rule.id, new Date(t - rule.state.expireHours * 3600000).toISOString());
      }
      const open = db.prepare('SELECT id, event_id, at, tries, next_try FROM event_rule_hits WHERE rule_id=? AND sent_at IS NULL AND held=0 ORDER BY id').all(rule.id)
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
    if (++rounds % 120 === 1) {
      db.prepare('DELETE FROM event_rule_hits WHERE sent_at IS NOT NULL AND sent_at < ?').run(new Date(t - 7 * 86400000).toISOString());
      db.prepare('DELETE FROM event_open WHERE closed_at IS NOT NULL AND closed_at < ?').run(new Date(t - 7 * 86400000).toISOString());
    }
    return sentRounds;
  }

  return {
    list: () => db.prepare('SELECT * FROM event_rules ORDER BY name COLLATE NOCASE').all().map((r) => { const x = shape(r); return { ...x, ...stats(r.id), blocked: blockedIds(x.match.eventIds) }; }),
    get: (id) => shape(db.prepare('SELECT * FROM event_rules WHERE id=?').get(id)),
    create(input) {
      const c = clean(input);
      const ts = iso();
      const id = Number(db.prepare('INSERT INTO event_rules(name, enabled, match, channels, mode, digest_min, max_per_hour, options, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(c.name, c.enabled ? 1 : 0, JSON.stringify(c.match), JSON.stringify(c.channels), c.mode, c.digest_min, c.max_per_hour, JSON.stringify(c.options), ts, ts).lastInsertRowid);
      forget();
      return this.get(id);
    },
    update(id, input) {
      const old = this.get(id);
      if (!old) throw new HttpError(404, 'err.notFound');
      const c = clean(input, old);
      db.prepare('UPDATE event_rules SET name=?, enabled=?, match=?, channels=?, mode=?, digest_min=?, max_per_hour=?, options=?, updated_at=? WHERE id=?')
        .run(c.name, c.enabled ? 1 : 0, JSON.stringify(c.match), JSON.stringify(c.channels), c.mode, c.digest_min, c.max_per_hour, JSON.stringify(c.options), iso(), id);
      // switched off: what was still waiting is not sent any more, open events are closed
      if (!c.enabled) {
        db.prepare('DELETE FROM event_rule_hits WHERE rule_id=? AND sent_at IS NULL').run(id);
        db.prepare("UPDATE event_open SET state='closed', closed_at=?, closed_how='rule' WHERE rule_id=? AND state IN ('open','ack')").run(iso(), id);
      }
      singles.delete(id);
      forget();
      return this.get(id);
    },
    /** Switch a rule on or off - from the list, without opening it. Off: what was waiting is dropped, open events close
     * (as when saved off); on: the reason it was switched off by itself goes */
    setEnabled(id, on) {
      const row = db.prepare('SELECT options FROM event_rules WHERE id=?').get(id);
      if (!row) throw new HttpError(404, 'err.notFound');
      const o = parse(row.options || '{}', {});
      if (on) delete o.disabledReason;
      db.prepare('UPDATE event_rules SET enabled=?, options=?, updated_at=? WHERE id=?').run(on ? 1 : 0, JSON.stringify(o), iso(), id);
      if (!on) {
        db.prepare('DELETE FROM event_rule_hits WHERE rule_id=? AND sent_at IS NULL').run(id);
        db.prepare("UPDATE event_open SET state='closed', closed_at=?, closed_how='rule' WHERE rule_id=? AND state IN ('open','ack')").run(iso(), id);
      }
      singles.delete(id);
      forget();
      return this.get(id);
    },
    remove(id) {
      if (!db.prepare('DELETE FROM event_rules WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
      db.prepare('DELETE FROM event_rule_hits WHERE rule_id=?').run(id);
      db.prepare('DELETE FROM event_open WHERE rule_id=?').run(id);
      singles.delete(id);
      forget();
    },
    /** Open (and acknowledged) events, newest news first - for the page; closed ones of the last day with all=true */
    openEvents({ all = false } = {}) {
      return db.prepare(`SELECT o.*, r.name rule_name, s.host, d.name device_name, e.text last_text, e.severity last_severity, e.event_id last_event_id
        FROM event_open o LEFT JOIN event_rules r ON r.id=o.rule_id LEFT JOIN event_senders s ON s.source_ip=o.source_ip LEFT JOIN devices d ON d.id=s.device_id
        LEFT JOIN events_in e ON e.id=o.last_event
        WHERE ${all ? "o.state IN ('open','ack') OR o.closed_at >= ?" : "o.state IN ('open','ack') AND ? IS NOT NULL"} ORDER BY o.state='ack', o.last_at DESC LIMIT 500`)
        .all(new Date(now().getTime() - 86400000).toISOString());
    },
    openCount: () => db.prepare("SELECT COUNT(*) n FROM event_open WHERE state='open'").get().n,
    /** A user acknowledges (seen, being dealt with) or closes an open event */
    ack(id, by) {
      if (!db.prepare("UPDATE event_open SET state='ack', ack_by=?, ack_at=? WHERE id=? AND state='open'").run(String(by).slice(0, 120), iso(), id).changes) throw new HttpError(404, 'err.notFound');
    },
    close(id, by) {
      if (!db.prepare("UPDATE event_open SET state='closed', closed_at=?, closed_how='user', closed_by=? WHERE id=? AND state IN ('open','ack')").run(iso(), String(by).slice(0, 120), id).changes) throw new HttpError(404, 'err.notFound');
    },
    test,
    /** Before saving or testing: the expressions of a rule tried in a separate thread on hostile texts and real messages */
    async checkTimes(input = {}) {
      const samples = db.prepare('SELECT text FROM events_in ORDER BY id DESC LIMIT 200').all().map((r) => r.text);
      const m = input.match || {}; const s = input.state || {};
      if (m.regex) { checkRegexStatic(String(m.regex), 'regex'); await checkRegexTime(String(m.regex), samples, { field: 'regex' }); }
      if (s.closeRegex) { checkRegexStatic(String(s.closeRegex), 'closeRegex'); await checkRegexTime(String(s.closeRegex), samples, { field: 'closeRegex' }); }
    },
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
