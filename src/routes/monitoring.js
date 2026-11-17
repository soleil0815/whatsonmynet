// API for monitors, notification channels and maintenance windows.
import crypto from 'node:crypto';
import express from 'express';
import { HttpError, int, str, ids } from '../lib/http.js';
import { BULK_MAX } from '../monitor/index.js';
import { requireRole } from '../auth/session.js';
import { inScope } from '../auth/scope.js';
import { config } from '../config.js';
import { parseEventIds, parseDenyList, formatDenyList, denies } from '../eventrules.js';
import { WIN_NOISE, WIN_KEEP } from '../settings.js';
import { createMasker } from '../lib/aimask.js';
import { logonSummary } from '../lib/winlogon.js';

export function createMonitoringApi(ctx) {
  const { db, monitoring, channels, maintenance, dockerHosts, settings } = ctx;
  const r = express.Router();
  const choices = ctx.sensorChoices;
  const editor = requireRole('editor');
  const admin = requireRole('admin');
  const who = (req) => req.user?.username || '';
  const audit = (req, action, detail = '') => {
    db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), who(req), action, String(detail).slice(0, 500));
  };
  const idParam = (req) => {
    const n = int(req.params.id);
    if (!n || n < 1) throw new HttpError(404, 'err.notFound');
    return n;
  };

  const unscoped = (req, _res, next) => next(req.scope ? new HttpError(403, 'err.scope') : undefined);
  // Location limit: a limited user only sees and changes monitors of devices in his locations
  const deviceOk = (req, deviceId) => !req.scope || (deviceId && inScope(req.scope, db.prepare('SELECT location_id FROM devices WHERE id=?').get(deviceId)?.location_id));
  const monitorOk = (req, id) => {
    const m = db.prepare('SELECT device_id FROM monitors WHERE id=?').get(id);
    if (!m || !deviceOk(req, m.device_id)) throw new HttpError(404, 'err.notFound');
  };

  // Monitors (reading for everyone signed in, changing for editors)
  r.get('/monitors', (req, res) => res.json(monitoring.list().filter((m) => deviceOk(req, m.device_id))));
  r.get('/monitors/summary', (req, res) => res.json(monitoring.summary(req.scope ? (m) => deviceOk(req, m.device_id) : null)));
  r.get('/monitors/suggest/:id', editor, async (req, res) => {
    if (!deviceOk(req, idParam(req))) throw new HttpError(404, 'err.notFound');
    res.json(await monitoring.suggestionFor(idParam(req)));
  });
  r.get('/monitors/:id', (req, res) => { monitorOk(req, idParam(req)); res.json(monitoring.detail(idParam(req), int(str(req.query.hours, 4)) || 24)); });
  // A limited user may only put a monitor behind one he can see
  const parentOk = (req) => {
    const pid = int(String(req.body?.parent_id ?? ''));
    if (pid) monitorOk(req, pid);
  };
  // Docker hosts and hypervisors belong to no location: a user limited to locations cannot read them elsewhere either
  const typeOk = (req, type) => { if (req.scope && ['docker', 'proxmox'].includes(type)) throw new HttpError(403, 'err.scope'); };
  r.post('/monitors', editor, async (req, res) => {
    if (!deviceOk(req, req.body.device_id ? Number(req.body.device_id) : null)) throw new HttpError(403, 'err.scope');
    parentOk(req);
    typeOk(req, req.body.type);
    const m = await monitoring.create(req.body);
    audit(req, 'monitor.create', `${m.name} (${m.type} ${m.target})`);
    res.status(201).json(m);
  });
  r.put('/monitors/:id', editor, async (req, res) => {
    monitorOk(req, idParam(req));
    // a sensor moved to another device: that one must be his as well
    if (req.body?.device_id !== undefined && req.body.device_id !== null && !deviceOk(req, Number(req.body.device_id))) throw new HttpError(403, 'err.scope');
    parentOk(req);
    typeOk(req, req.body.type ?? monitoring.get(idParam(req))?.type);
    const m = await monitoring.update(idParam(req), req.body);
    audit(req, 'monitor.update', m.name);
    res.json(m);
  });
  // Several at once: change how often / when to alarm, pause, resume, delete. A limited user gets 403 as soon as one
  // of the monitors is not his (then nothing changes at all).
  r.post('/monitors/bulk', editor, async (req, res) => {
    const raw = req.body?.ids;
    const list = ids(raw, BULK_MAX + 1);
    if (!Array.isArray(raw) || !list.length || raw.length > BULK_MAX || list.length > BULK_MAX) throw new HttpError(400, 'err.bulkIds', String(BULK_MAX));
    const action = str(req.body.action, 20);
    if (!['edit', 'pause', 'resume', 'delete'].includes(action)) throw new HttpError(400, 'err.badRequest', action);
    if (req.scope) {
      for (const id of list) {
        const m = db.prepare('SELECT device_id FROM monitors WHERE id=?').get(id);
        if (m && !deviceOk(req, m.device_id)) throw new HttpError(403, 'err.scope');
      }
    }
    const out = await monitoring.bulk(list, action, req.body.changes);
    if (out.changed) audit(req, 'monitor.bulk', `${action} ${out.changed} monitor(s)${action === 'edit' ? `: ${Object.keys(req.body.changes || {}).join(', ')}` : ''}`);
    res.json(out);
  });
  r.post('/monitors/:id/pause', editor, (req, res) => { monitorOk(req, idParam(req)); const m = monitoring.pause(idParam(req)); audit(req, 'monitor.pause', m.name); res.json(m); });
  r.post('/monitors/:id/resume', editor, (req, res) => { monitorOk(req, idParam(req)); const m = monitoring.resume(idParam(req)); audit(req, 'monitor.resume', m.name); res.json(m); });
  // Everything plugged in at the switch of this monitor: put it behind this monitor (no alarm flood when the switch fails)
  r.post('/monitors/:id/children', editor, (req, res) => {
    const id = idParam(req);
    monitorOk(req, id);
    const n = monitoring.adoptChildren(id, (c) => deviceOk(req, c.device_id));
    audit(req, 'monitor.children', `${monitoring.get(id)?.name} (${n})`);
    res.json({ count: n });
  });
  r.post('/monitors/:id/check', editor, async (req, res) => { monitorOk(req, idParam(req)); res.json(await monitoring.checkNow(idParam(req))); });
  r.delete('/monitors/:id', editor, (req, res) => {
    const id = idParam(req);
    monitorOk(req, id);
    const m = monitoring.get(id);
    monitoring.remove(id);
    audit(req, 'monitor.delete', m?.name);
    res.json({ ok: true });
  });

  // Sensors: what can be watched - one list per device or per host under Virtualization (the same values both ways)
  r.get('/sensors/sources', editor, (req, res) => {
    const ids = choices.deviceIds();
    const devices = db.prepare('SELECT id, name, ip, location_id FROM devices ORDER BY name COLLATE NOCASE').all()
      .filter((d) => ids.has(d.id) && (!req.scope || inScope(req.scope, d.location_id))).map(({ id, name, ip }) => ({ id, name, ip }));
    const hosts = req.scope ? [] : db.prepare('SELECT id, name, kind FROM proxmox_hosts ORDER BY name COLLATE NOCASE').all();
    res.json({ devices, hosts });
  });
  r.get('/sensors/choices', editor, (req, res) => {
    const device = int(str(req.query.device, 12));
    const host = int(str(req.query.host, 12));
    if (device) {
      if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(device) || !deviceOk(req, device)) throw new HttpError(404, 'err.notFound');
      return res.json(choices.forDevice(device, { withHosts: !req.scope }));
    }
    if (host) {
      if (req.scope) throw new HttpError(403, 'err.scope');
      return res.json(choices.forHost(host));
    }
    throw new HttpError(400, 'err.notFound');
  });

  // Docker hosts: names for editors (monitor form), addresses and changes for admins
  r.get('/docker/hosts', editor, (req, res) => {
    const list = dockerHosts.list();
    res.json(req.user.role === 'admin' ? list : list.map((h) => ({ id: h.id, name: h.name })));
  });
  r.post('/docker/hosts', admin, (req, res) => { const h = dockerHosts.create(req.body); audit(req, 'docker.create', `${h.name} (${h.url})`); res.status(201).json(h); });
  r.put('/docker/hosts/:id', admin, (req, res) => { const h = dockerHosts.update(idParam(req), req.body); audit(req, 'docker.update', h.name); res.json(h); });
  r.delete('/docker/hosts/:id', admin, (req, res) => { dockerHosts.remove(idParam(req)); audit(req, 'docker.delete', req.params.id); res.json({ ok: true }); });
  r.get('/docker/hosts/:id/containers', editor, unscoped, async (req, res) => res.json(await dockerHosts.info(idParam(req))));
  // One monitor for every container that has none yet
  r.post('/docker/hosts/:id/monitor-all', editor, unscoped, async (req, res) => {
    const id = idParam(req);
    const info = await dockerHosts.info(id);
    const have = new Set(db.prepare("SELECT target FROM monitors WHERE type='docker' AND docker_host_id=?").all(id).map((m) => m.target));
    const host = dockerHosts.get(id);
    const created = [];
    for (const c of info.containers) {
      if (have.has(c.name) || (req.body.runningOnly !== false && c.state !== 'running')) continue;
      created.push((await monitoring.create({ name: `${c.name} (${host.name})`, type: 'docker', target: c.name, docker_host_id: id, interval_s: 60 })).id);
    }
    if (created.length) audit(req, 'docker.monitorAll', `${created.length} monitor(s) on ${host.name}`);
    res.json({ created: created.length });
  });

  // Messages devices sent (SNMP traps, syslog): the list for editors; switching the receivers on for admins
  const eventSettings = () => ({ traps: !!settings.get('events.traps'), syslog: !!settings.get('events.syslog'), syslogTcp: !!settings.get('events.syslogTcp'), syslogTls: !!settings.get('events.syslogTls'),
    syslogTcpPort: config.syslogTcpPort, syslogTlsPort: config.syslogTlsPort, communitiesSet: !!settings.get('events.communities'),
    onlyKnown: !!settings.get('events.onlyKnown'), keepDays: Number(settings.get('events.keepDays')) || 30, maxGb: Number(settings.get('events.maxGb')) || 2, minSeverity: Number(settings.get('events.minSeverity') ?? 7), winAllow: String(settings.get('events.winAllow') || ''), winDeny: String(settings.get('events.winDeny') || ''), winNoise: WIN_NOISE, trapPort: config.trapPort, syslogPort: config.syslogPort });
  // The filters of the list and of its timeline: search, kind, severity, sender and a time range (from inclusive, to not)
  const when = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(String(v).slice(0, 40));
    if (!Number.isFinite(d.getTime())) throw new HttpError(400, 'err.badRequest', name, name);
    return d.toISOString();
  };
  const eventFilter = (q) => {
    const f = { q: String(q.q ?? ''), kind: String(q.kind ?? ''), maxSeverity: q.maxSeverity ?? 7, device: q.device || null, source: String(q.source ?? ''),
      from: when(q.from, 'from'), to: when(q.to, 'to'), part: q.part === '1' || q.part === 'true' };
    if (f.from && f.to && f.from >= f.to) throw new HttpError(400, 'err.eventRange', undefined, 'from');
    return f;
  };
  r.get('/events', editor, unscoped, (req, res) => {
    const q = req.query || {};
    res.json({ status: ctx.events.status(), settings: eventSettings(), openEvents: ctx.eventRules.openCount(),
      // sign-in events get a short line (account, way, reason, source) above their long text
      list: ctx.events.list({ ...eventFilter(q), before: q.before || null, limit: q.limit || 200 })
        .map((r) => { const summary = logonSummary(r.event_id, r.text, req.user?.language === 'en' ? 'en' : 'de'); return summary ? { ...r, summary } : r; }) });
  });
  // how many messages per step of time, with the same filters as the list (the bars above it)
  // Saved searches: search, severity, kind and time range (a preset - not a fixed day) under a name; one's own, or shared
  // with everyone who sees the messages. Only who made it (or an admin) deletes it.
  const SEARCH_RANGES = ['', '15m', '1h', '24h', '7d', '30d'];
  const SEARCHES_MAX = 50;
  const searchRow = (req) => (x) => {
    let q = {}; try { q = JSON.parse(x.query); } catch { /* broken: empty */ }
    return { id: x.id, name: x.name, shared: !!x.shared, mine: x.user_id === req.user.id, owner: x.owner || '', ...q };
  };
  r.get('/events/searches', editor, unscoped, (req, res) => {
    res.json(db.prepare(`SELECT s.*, COALESCE(NULLIF(u.display_name, ''), u.username) owner FROM event_searches s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ? OR s.shared = 1 ORDER BY s.name COLLATE NOCASE`).all(req.user.id).map(searchRow(req)));
  });
  r.post('/events/searches', editor, unscoped, (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 60).trim();
    if (!name) throw new HttpError(400, 'err.searchName', undefined, 'name');
    const q = {
      q: str(b.q, 200).trim(), kind: ['trap', 'syslog'].includes(b.kind) ? b.kind : '',
      maxSeverity: Math.max(0, Math.min(7, Number.isFinite(Number(b.maxSeverity)) ? Math.round(Number(b.maxSeverity)) : 7)),
      range: SEARCH_RANGES.includes(b.range) ? b.range : '', part: !!b.part,
    };
    if (!q.q && !q.kind && q.maxSeverity === 7 && !q.range) throw new HttpError(400, 'err.searchEmpty');
    // the same name again: the search is replaced (saving a changed search under its name)
    const same = db.prepare('SELECT id FROM event_searches WHERE user_id = ? AND name = ? COLLATE NOCASE').get(req.user.id, name);
    if (same) db.prepare('UPDATE event_searches SET query = ?, shared = ? WHERE id = ?').run(JSON.stringify(q), b.shared ? 1 : 0, same.id);
    else {
      if (db.prepare('SELECT COUNT(*) FROM event_searches WHERE user_id = ?').pluck().get(req.user.id) >= SEARCHES_MAX) throw new HttpError(400, 'err.searchMax', String(SEARCHES_MAX));
      db.prepare('INSERT INTO event_searches(user_id, name, query, shared, created_at) VALUES(?,?,?,?,?)').run(req.user.id, name, JSON.stringify(q), b.shared ? 1 : 0, new Date().toISOString());
    }
    audit(req, 'events.search.save', name);
    res.status(same ? 200 : 201).json({ ok: true });
  });
  r.delete('/events/searches/:id', editor, unscoped, (req, res) => {
    const x = db.prepare('SELECT * FROM event_searches WHERE id = ?').get(idParam(req));
    if (!x || (x.user_id !== req.user.id && !x.shared)) throw new HttpError(404, 'err.notFound');
    if (x.user_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'err.forbidden');
    db.prepare('DELETE FROM event_searches WHERE id = ?').run(x.id);
    audit(req, 'events.search.delete', x.name);
    res.json({ ok: true });
  });
  r.get('/events/histogram', editor, unscoped, (req, res) => res.json(ctx.events.histogram(eventFilter(req.query || {}))));
  // What is kept of one sender (admins, like the receiving settings): min severity 0-7, -1 = nothing, null = as for all
  r.put('/events/senders/filter', admin, (req, res) => {
    const b = req.body || {};
    const ip = String(b.source ?? '').trim();
    if (!/^[0-9a-fA-F:.]{2,64}$/.test(ip)) throw new HttpError(400, 'err.badRequest', 'source', 'source');
    const min = b.min === null || b.min === '' || b.min === undefined ? null : Number(b.min);
    if (min !== null && (!Number.isInteger(min) || min < -1 || min > 7)) throw new HttpError(400, 'err.badRequest', 'min', 'min');
    ctx.events.setSenderFilter(ip, min, who(req));
    audit(req, 'events.senderFilter', `${ip}: ${min === null ? 'as for all' : min === -1 ? 'muted' : `from severity ${min}`}`);
    res.json({ ok: true });
  });
  // the overview by sender (the list of all messages floods quickly)
  // What takes the space: Windows events and senders by share, with what speaks for keeping them (a rule uses the
  // event, it is usually important) - and, for admins, leaving one out with a click
  const inList = (list, id) => (parseEventIds(list) || []).some(([a, b]) => id >= a && id <= b);
  // the rules waiting for an event (number, and source when it is left out for one source only): a rule asking for
  // another source does not need it
  const rulesFor = (id, src = '') => ctx.eventRules.list().filter((x) => x.match?.eventIds && inList(x.match.eventIds, id)
    && !(src && x.match.source && !src.toLowerCase().includes(String(x.match.source).toLowerCase()))).map((x) => x.name);
  const denyList = () => parseDenyList(String(settings.get('events.winDeny') || '')) || { ranges: [], pairs: [] };
  function noiseView(days) {
    const n = ctx.events.noise({ days });
    const deny = denyList();
    return { ...n, events: n.events.map((e) => ({ ...e, rules: rulesFor(e.id, e.app), keep: inList(WIN_KEEP, e.id), usual: inList(WIN_NOISE, e.id), denied: denies(deny, e.id, e.app) })) };
  }
  r.get('/events/noise', editor, unscoped, (req, res) => res.json(noiseView(Number(req.query?.days) || 7)));
  // the same as a question for an AI chat - names, addresses, accounts and domains replaced by placeholders
  r.get('/events/noise/text', editor, unscoped, (req, res) => {
    const de = String(req.query?.lang || 'de') !== 'en';
    const v = noiseView(Number(req.query?.days) || 7);
    const names = [...db.prepare("SELECT host, source_ip FROM event_senders").all().flatMap((x) => [x.host, x.source_ip]),
      ...db.prepare("SELECT name FROM devices WHERE name IS NOT NULL AND name <> ''").pluck().all()];
    const mask = createMasker({ names, lang: de ? 'de' : 'en' });
    const num = (x) => Number(x).toLocaleString(de ? 'de-DE' : 'en-US');
    const sev = (x) => (x === null ? '' : x <= 3 ? (de ? ', auch Fehler' : ', errors too') : x === 4 ? (de ? ', auch Warnungen' : ', warnings too') : (de ? ', nur Info' : ', info only'));
    const lines = [de
      ? `Ich sammle mit WhatsOnMyNet (Netzwerk-Inventar und Monitoring) die Windows-Ereignisse und Syslog-Meldungen unserer Rechner und Geräte - in den letzten ${v.days === 1 ? '24 Stunden' : `${v.days} Tagen`} etwa ${num(v.perDay)} Meldungen pro Tag. Welche der folgenden Windows-Ereignisse sind für Betrieb und Sicherheit meist ohne Wert und können ausgeschlossen werden, und welche sollte ich auf jeden Fall behalten? Bitte je Ereignis-ID kurz begründen und am Ende die auszuschließenden IDs als Liste mit Komma nennen. Namen, Adressen und Konten sind durch Platzhalter ersetzt.`
      : `With WhatsOnMyNet (network inventory and monitoring) I collect the Windows events and syslog messages of our computers and devices - over the last ${v.days === 1 ? '24 hours' : `${v.days} days`} about ${num(v.perDay)} messages a day. Which of the following Windows events are usually of no value for operations and security and can be left out, and which should I keep in any case? Please give a short reason for each event id and at the end list the ids to leave out, separated by commas. Names, addresses and accounts are replaced by placeholders.`,
      // the same number means different things to different sources: then only for that source
      de ? 'Die Quelle steht in Klammern. Bedeutet eine Nummer bei anderen Quellen etwas Wichtiges (z. B. 1 bei Sysmon, 1006 beim Defender, 101 in der Aufgabenplanung), nenne sie nur für diese Quelle als ID@Quelle, z. B. 1@Microsoft-Windows-Ntfs.'
        : 'The source is in brackets. When a number means something important for other sources (e.g. 1 of Sysmon, 1006 of Defender, 101 of the Task Scheduler), name it for this source only as ID@source, e.g. 1@Microsoft-Windows-Ntfs.', '',
      de ? 'Windows-Ereignisse, die meisten zuerst:' : 'Windows events, most first:'];
    // already left out (older messages of the period): not asked again - they are in the list at the end
    for (const e of v.events.filter((x) => !x.denied)) {
      const src = [e.app || e.example.app, e.example.channel].filter(Boolean).join(de ? ', Protokoll ' : ', log ');
      lines.push(`- ${e.id}${src ? ` (${src})` : ''}: ${num(e.perDay)} ${de ? 'pro Tag' : 'a day'}, ${num(e.share)} %, ${de ? 'von' : 'from'} ${e.senders.length + e.moreSenders} ${de ? (e.senders.length + e.moreSenders === 1 ? 'Rechner' : 'Rechnern') : (e.senders.length + e.moreSenders === 1 ? 'computer' : 'computers')}${sev(e.worst)}${e.rules.length ? (de ? ', von einer Benachrichtigungsregel gebraucht' : ', used by a notification rule') : ''}`);
      if (e.example.text) lines.push(`  ${de ? 'Beispiel' : 'Example'}: "${mask(e.example.text).replace(/\s+/g, ' ').slice(0, 300)}"`);
    }
    const deny = String(settings.get('events.winDeny') || '');
    lines.push('', `${de ? 'Schon ausgeschlossen' : 'Already left out'}: ${deny || (de ? 'nichts' : 'none')}`);
    res.json({ text: lines.join('\n') });
  });
  r.post('/events/noise/deny', admin, (req, res) => {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id < 0 || id > 65535) throw new HttpError(400, 'err.badRequest', 'id', 'id');
    // with a source: only this number of this source (the same number of another source stays)
    const src = String(req.body?.src ?? '').replace(/[\x00-\x1f@,;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    // a rule waits for this event: leaving it out would silence the rule
    const rules = rulesFor(id, src);
    if (rules.length) throw new HttpError(400, 'err.noiseRule', rules.join(', '));
    const have = denyList();
    const inRange = have.ranges.some(([a, b]) => id >= a && id <= b);
    const already = inRange || (src && have.pairs.some((p) => p.id === id && p.src.toLowerCase() === src.toLowerCase()));
    if (!already) {
      if (src) have.pairs.push({ id, src }); else have.ranges.push([id, id]);
      if (have.ranges.length + have.pairs.length > 200) throw new HttpError(400, 'err.winDeny', undefined, 'winDeny');
      settings.set('events.winDeny', formatDenyList(have));
      ctx.events.apply();
      audit(req, 'events.settings', `Windows event ${id}${src ? ` of ${src}` : ''} no longer kept`);
    }
    res.json({ winDeny: settings.get('events.winDeny') });
  });
  r.get('/events/senders', editor, unscoped, (req, res) => res.json({ status: ctx.events.status(), settings: eventSettings(), openEvents: ctx.eventRules.openCount(), senders: ctx.events.senders({ q: String(req.query?.q ?? '') }) }));
  r.put('/events/settings', admin, (req, res) => {
    const b = req.body || {};
    const keep = Number(b.keepDays ?? settings.get('events.keepDays'));
    if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new HttpError(400, 'err.eventKeep', undefined, 'keepDays');
    const maxGb = Number(b.maxGb ?? settings.get('events.maxGb') ?? 2);
    if (!Number.isFinite(maxGb) || maxGb < 0.1 || maxGb > 1000) throw new HttpError(400, 'err.eventMaxGb', undefined, 'maxGb');
    settings.set('events.traps', !!b.traps);
    settings.set('events.syslog', !!b.syslog);
    settings.set('events.syslogTcp', !!b.syslogTcp);
    settings.set('events.syslogTls', !!b.syslogTls);
    settings.set('events.onlyKnown', !!b.onlyKnown);
    settings.set('events.keepDays', keep);
    settings.set('events.maxGb', Math.round(maxGb * 10) / 10);
    if (b.minSeverity !== undefined) {
      const ms = Number(b.minSeverity);
      if (!Number.isInteger(ms) || ms < 0 || ms > 7) throw new HttpError(400, 'err.badRequest', 'minSeverity', 'minSeverity');
      settings.set('events.minSeverity', ms);
    }
    // Windows event ids: "1116, 4740, 865-868" - stored in the same tidy form the rules use; the list of those never
    // taken may also name a source: "1@Ntfs"
    if (b.winAllow !== undefined) {
      const list = parseEventIds(String(b.winAllow ?? '').slice(0, 2000));
      if (!list || list.length > 200) throw new HttpError(400, 'err.ruleEventIds', undefined, 'winAllow');
      settings.set('events.winAllow', list.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(', '));
    }
    if (b.winDeny !== undefined) {
      const list = parseDenyList(String(b.winDeny ?? '').slice(0, 6000));
      if (!list || list.ranges.length + list.pairs.length > 200) throw new HttpError(400, 'err.winDeny', undefined, 'winDeny');
      settings.set('events.winDeny', formatDenyList(list));
    }
    if (typeof b.communities === 'string' && b.communities.trim()) {
      const list = b.communities.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (list.length > 10 || list.some((c) => c.length > 64 || /[\x00-\x1f]/.test(c))) throw new HttpError(400, 'err.snmpCommunity', undefined, 'communities');
      settings.set('events.communities', list.join('\n'));
    } else if (b.clearCommunities) settings.set('events.communities', '');
    ctx.events.apply();
    try { ctx.events.prune(); } catch { /* the next round */ }
    audit(req, 'events.settings', `traps ${b.traps ? 'on' : 'off'}, syslog UDP ${b.syslog ? 'on' : 'off'}, TCP ${b.syslogTcp ? 'on' : 'off'}, TLS ${b.syslogTls ? 'on' : 'off'}`);
    // the sockets open asynchronously - a moment later the state is known
    setTimeout(() => res.json({ status: ctx.events.status(), settings: eventSettings() }), 300);
  });

  // Event rules: chosen messages to chosen channels (mail, ticket system, webhook) - for editors, like monitors
  r.get('/event-rules', editor, unscoped, (req, res) => res.json(ctx.eventRules.list()));
  r.post('/event-rules/test', editor, unscoped, async (req, res) => {
    await ctx.eventRules.checkTimes({ match: req.body?.match || {} });
    res.json(ctx.eventRules.test(req.body?.match || {}));
  });
  r.post('/event-rules', editor, unscoped, async (req, res) => {
    await ctx.eventRules.checkTimes(req.body || {});
    const x = ctx.eventRules.create(req.body || {});
    audit(req, 'eventrule.create', x.name);
    res.status(201).json(x);
  });
  r.put('/event-rules/:id', editor, unscoped, async (req, res) => {
    await ctx.eventRules.checkTimes(req.body || {});
    const x = ctx.eventRules.update(idParam(req), req.body || {});
    audit(req, 'eventrule.update', `${x.name}${x.enabled ? '' : ' (off)'}`);
    res.json(x);
  });
  // on/off from the list; switching on checks the expressions again like saving does
  r.post('/event-rules/:id/enabled', editor, unscoped, async (req, res) => {
    const id = idParam(req);
    const on = req.body?.enabled === true;
    const old = ctx.eventRules.get(id);
    if (!old) throw new HttpError(404, 'err.notFound');
    if (on) await ctx.eventRules.checkTimes(old);
    const x = ctx.eventRules.setEnabled(id, on);
    audit(req, 'eventrule.update', `${x.name}${x.enabled ? ' (on)' : ' (off)'}`);
    res.json(x);
  });
  // open events: the list, acknowledge, close (editors - like the rules)
  r.get('/events/open', editor, unscoped, (req, res) => res.json({ list: ctx.eventRules.openEvents({ all: req.query?.all === '1' }), open: ctx.eventRules.openCount() }));
  r.post('/events/open/:id/ack', editor, unscoped, (req, res) => { ctx.eventRules.ack(idParam(req), who(req)); audit(req, 'eventopen.ack', req.params.id); res.json({ ok: true }); });
  r.post('/events/open/:id/close', editor, unscoped, (req, res) => { ctx.eventRules.close(idParam(req), who(req)); audit(req, 'eventopen.close', req.params.id); res.json({ ok: true }); });
  r.delete('/event-rules/:id', editor, unscoped, (req, res) => {
    const id = idParam(req);
    const name = ctx.eventRules.get(id)?.name || id;
    ctx.eventRules.remove(id);
    audit(req, 'eventrule.delete', name);
    res.json({ ok: true });
  });

  // Proxmox hosts: names and values for editors (monitor form), everything else for admins
  r.get('/proxmox', editor, (req, res) => {
    const list = ctx.proxmox.list();
    res.json(req.user.role === 'admin' ? list : list.map((h) => ({ id: h.id, name: h.name, kind: h.kind })));
  });
  r.put('/proxmox/:id/script-tip', admin, (req, res) => {
    if (!db.prepare('UPDATE proxmox_hosts SET script_tip_hidden=? WHERE id=?').run(req.body.hidden ? 1 : 0, Number(req.params.id) || 0).changes) throw new HttpError(404, 'err.notFound');
    res.json({ hidden: !!req.body.hidden });
  });
  r.post('/proxmox', admin, async (req, res) => {
    const h = ctx.proxmox.create(req.body);
    audit(req, 'proxmox.create', `${h.name} (${h.url || h.kind})`);
    // watched from the start: a few sensors once the first values are there
    ctx.autoWatch.markHost(h.id, req.user.language);
    res.status(201).json(await ctx.proxmox.poll(h.id));
  });
  r.put('/proxmox/:id', admin, async (req, res) => { const h = ctx.proxmox.update(idParam(req), req.body); audit(req, 'proxmox.update', h.name); res.json(await ctx.proxmox.poll(h.id)); });
  r.delete('/proxmox/:id', admin, (req, res) => { ctx.proxmox.remove(idParam(req)); audit(req, 'proxmox.delete', req.params.id); res.json({ ok: true }); });
  r.post('/proxmox/cert', admin, async (req, res) => res.json(await ctx.proxmox.fetchCert(req.body?.url)));
  r.post('/proxmox/:id/poll', admin, async (req, res) => res.json(await ctx.proxmox.poll(idParam(req))));
  r.get('/proxmox/:id/metrics', editor, unscoped, (req, res) => res.json(ctx.proxmox.metrics(idParam(req))));
  // New token + script for such a host; a self-signed certificate of this server is pinned in the script
  r.post('/proxmox/:id/token', admin, (req, res) => {
    const pin = {};
    const pem = String(ctx.tls?.current()?.cert || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (pem && ctx.tls?.describe()?.source !== 'custom') {
      const c = new crypto.X509Certificate(pem);
      pin.sha1 = c.fingerprint.replace(/:/g, '');
      pin.spki = crypto.createHash('sha256').update(c.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    }
    const out = ctx.proxmox.newToken(idParam(req), { server: str(req.body?.server, 300), pin });
    audit(req, 'proxmox.token', req.params.id);
    res.json(out);
  });

  // Maintenance windows (editors)
  r.get('/maintenance', (_req, res) => res.json(maintenance.list()));
  r.post('/maintenance', editor, unscoped, (req, res) => { const w = maintenance.create(req.body); audit(req, 'maintenance.create', w.name); res.status(201).json(w); });
  r.put('/maintenance/:id', editor, unscoped, (req, res) => { const w = maintenance.update(idParam(req), req.body); audit(req, 'maintenance.update', w.name); res.json(w); });
  r.delete('/maintenance/:id', editor, unscoped, (req, res) => { maintenance.remove(idParam(req)); audit(req, 'maintenance.delete', req.params.id); res.json({ ok: true }); });

  // Notification channels: names for everyone (to choose them on a monitor), settings for admins only
  r.get('/channels', (req, res) => {
    const list = channels.list();
    res.json(req.user.role === 'admin' ? list : list.map((c) => ({ id: c.id, name: c.name, type: c.type, is_default: c.is_default, enabled: c.enabled })));
  });
  r.post('/channels', admin, (req, res) => { const c = channels.create(req.body); audit(req, 'channel.create', `${c.name} (${c.type})`); res.status(201).json(c); });
  r.put('/channels/:id', admin, (req, res) => { const c = channels.update(idParam(req), req.body); audit(req, 'channel.update', c.name); res.json(c); });
  r.delete('/channels/:id', admin, (req, res) => { channels.remove(idParam(req)); audit(req, 'channel.delete', req.params.id); res.json({ ok: true }); });
  r.post('/channels/:id/test', admin, async (req, res) => { await channels.test(idParam(req)); audit(req, 'channel.test', req.params.id); res.json({ ok: true }); });

  return r;
}
