// Status pages (like Uptime Kuma): a page without login that shows what runs and what does not - for colleagues,
// the reception desk, a screen in the corridor. Off until an administrator makes one. Each page shows only what is
// chosen for it (groups or single monitors, under a name of its own) with state, 90 days as bars and the uptime.
// Never addresses, targets or error texts - only names (the ones given here, else those of the monitors): a group
// "Telephony" says "partly down", not why.
//
// Access: a secret link (random, cannot be guessed - the default) or an address of its own (e.g. /status/it); either
// can be limited to networks (e.g. only the institute's network). A page that is off, unknown or not allowed answers
// the same "not found" - nobody learns which pages exist.
import crypto from 'node:crypto';
import { HttpError, line } from './lib/http.js';
import { parseCidr, cidrContains } from './lib/net.js';
import { localDay } from './scan/nightly.js';

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
// Words of the program itself under /status/… - not an address of its own
const RESERVED = new Set(['api', 'css', 'js', 'img', 'fonts', 'help', 'new', 'edit', 'admin', 'login', 'status']);
export const DAYS = 90;
const MAX_ITEMS = 60;
const GROUP_OF = "COALESCE(NULLIF(m.group_name, ''), l.name, '')";

// 24 characters of a-z and 0-9, each drawn evenly (about 124 bits): cannot be guessed, readable in a URL
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newLink = () => Array.from({ length: 24 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

/** "10.0.10.0/24, 192.168.5.7" → ['10.0.10.0/24', '192.168.5.7/32'] (one per line or separated by commas) */
export function parseNetworks(text) {
  const out = [];
  for (const part of String(text || '').split(/[\s,;]+/).filter(Boolean).slice(0, 50)) {
    const c = parseCidr(part);
    if (!c) throw new HttpError(400, 'err.statusNetwork', part.slice(0, 60), 'networks');
    out.push(c.cidr);
  }
  return [...new Set(out)];
}

/** Is this client address allowed? (IPv4-mapped IPv6 as IPv4; no list = everybody) */
export function addressAllowed(networks, ip) {
  if (!networks.length) return true;
  const v4 = String(ip || '').replace(/^::ffff:/, '');
  return networks.some((n) => cidrContains(n, v4));
}

export function createStatusPages({ db, shownStatus, now = () => new Date() }) {
  const row = (id) => db.prepare('SELECT * FROM status_pages WHERE id=?').get(id);
  const shape = (p) => (p ? { id: p.id, name: p.name, slug: p.slug, access: p.access, networks: parse(p.networks, []), description: p.description,
    notice: p.notice, notice_level: p.notice_level, show_uptime: !!p.show_uptime, language: p.language, items: parse(p.items, []), enabled: !!p.enabled,
    created_at: p.created_at, updated_at: p.updated_at } : null);

  /** What is shown, checked: groups (as one line or with their members) and single monitors */
  function cleanItems(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'err.badRequest', 'items');
    if (list.length > MAX_ITEMS) throw new HttpError(400, 'err.badRequest', `at most ${MAX_ITEMS}`);
    const exists = db.prepare('SELECT 1 FROM monitors WHERE id=?');
    return list.map((x) => {
      if (x?.type === 'group') {
        const group = line(x.group, 60);
        if (!group) throw new HttpError(400, 'err.groupRequired', '', 'items');
        return { type: 'group', group, label: line(x.label, 80), members: x.members === true };
      }
      const id = Number(x?.id);
      if (x?.type !== 'monitor' || !Number.isInteger(id) || !exists.get(id)) throw new HttpError(400, 'err.notFound', 'monitor', 'items');
      return { type: 'monitor', id, label: line(x.label, 80) };
    });
  }

  function clean(input, old) {
    const name = line(input.name ?? old?.name, 80);
    if (!name) throw new HttpError(400, 'err.nameRequired', '', 'name');
    const access = (input.access ?? old?.access) === 'open' ? 'open' : 'link';
    let slug;
    if (access === 'open') {
      slug = String(input.slug ?? old?.slug ?? '').trim().toLowerCase();
      if (!SLUG.test(slug) || RESERVED.has(slug)) throw new HttpError(400, 'err.statusSlug', '', 'slug');
    } else {
      // a secret link stays the same when the page is edited - "new link" makes another one
      slug = old?.access === 'link' ? old.slug : newLink();
    }
    const taken = db.prepare('SELECT id FROM status_pages WHERE slug=?').get(slug);
    if (taken && taken.id !== old?.id) throw new HttpError(409, 'err.statusSlugTaken', '', 'slug');
    const level = ['info', 'warn', 'bad'].includes(input.notice_level ?? old?.notice_level) ? (input.notice_level ?? old?.notice_level) : 'info';
    return {
      name, slug, access,
      networks: JSON.stringify(parseNetworks(input.networks !== undefined ? (Array.isArray(input.networks) ? input.networks.join('\n') : input.networks) : parse(old?.networks, []).join('\n'))),
      description: String(input.description ?? old?.description ?? '').replace(/\r/g, '').trim().slice(0, 1000),
      notice: String(input.notice ?? old?.notice ?? '').replace(/\r/g, '').trim().slice(0, 1000),
      notice_level: level,
      show_uptime: (input.show_uptime ?? (old ? !!old.show_uptime : true)) ? 1 : 0,
      language: (input.language ?? old?.language) === 'en' ? 'en' : 'de',
      items: JSON.stringify(cleanItems(input.items ?? parse(old?.items, []))),
      enabled: (input.enabled ?? (old ? !!old.enabled : true)) ? 1 : 0,
    };
  }

  function create(input) {
    const v = clean(input || {}, null);
    const at = now().toISOString();
    const id = db.prepare(`INSERT INTO status_pages(name,slug,access,networks,description,notice,notice_level,show_uptime,language,items,enabled,created_at,updated_at)
      VALUES(@name,@slug,@access,@networks,@description,@notice,@notice_level,@show_uptime,@language,@items,@enabled,@at,@at)`).run({ ...v, at }).lastInsertRowid;
    return shape(row(id));
  }
  function update(id, input) {
    const old = row(id);
    if (!old) throw new HttpError(404, 'err.notFound');
    const v = clean(input || {}, old);
    db.prepare(`UPDATE status_pages SET name=@name, slug=@slug, access=@access, networks=@networks, description=@description, notice=@notice,
      notice_level=@notice_level, show_uptime=@show_uptime, language=@language, items=@items, enabled=@enabled, updated_at=@at WHERE id=@id`)
      .run({ ...v, at: now().toISOString(), id });
    return shape(row(id));
  }
  /** A new secret link: the old one stops working at once (it was passed on too far) */
  function renewLink(id) {
    const old = row(id);
    if (!old) throw new HttpError(404, 'err.notFound');
    if (old.access !== 'link') throw new HttpError(400, 'err.badRequest');
    db.prepare('UPDATE status_pages SET slug=?, updated_at=? WHERE id=?').run(newLink(), now().toISOString(), id);
    return shape(row(id));
  }
  function remove(id) { if (!db.prepare('DELETE FROM status_pages WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound'); }

  // ---------------------------------------------------------------------------------------------------- what a page shows
  /** The last DAYS local days, oldest first */
  function dayList(at = now()) {
    const out = [];
    for (let i = DAYS - 1; i >= 0; i--) out.push(localDay(new Date(at.getTime() - i * 86400000)));
    return out;
  }
  /** Checks per local day for these monitors together: Map(day → { ok, total }) */
  function daily(ids, at = now()) {
    const out = new Map();
    if (!ids.length) return out;
    const since = new Date(at.getTime() - (DAYS + 1) * 86400000).toISOString().slice(0, 13);
    const q = db.prepare(`SELECT hour, ok, total FROM monitor_hourly WHERE monitor_id IN (${ids.map(() => '?').join(',')}) AND hour >= ?`);
    for (const r of q.iterate(...ids, since)) {
      const day = localDay(new Date(`${r.hour}:00Z`));
      const d = out.get(day) || { ok: 0, total: 0 };
      d.ok += r.ok; d.total += r.total;
      out.set(day, d);
    }
    return out;
  }
  /** One state for the public: up, down, partial, maintenance, pending, off */
  const publicState = (s) => (s === 'up' ? 'up' : s === 'down' || s === 'unreachable' ? 'down' : s === 'maintenance' ? 'maintenance' : s === 'paused' || s === 'off' ? 'off' : 'pending');
  function combine(states) {
    const counted = states.filter((s) => s === 'up' || s === 'down');
    const down = counted.filter((s) => s === 'down').length;
    if (counted.length) return down === 0 ? 'up' : down === counted.length ? 'down' : 'partial';
    if (states.includes('maintenance')) return 'maintenance';
    return states.length && states.every((s) => s === 'off') ? 'off' : 'pending';
  }
  const monitorRow = db.prepare('SELECT id, name, type, status, enabled FROM monitors WHERE id=?');
  const stateOf = (m) => publicState(m.enabled ? shownStatus(m) : 'off');
  const membersOf = (group) => db.prepare(`SELECT m.id, m.name, m.type, m.status, m.enabled FROM monitors m LEFT JOIN devices d ON d.id = m.device_id
    LEFT JOIN locations l ON l.id = d.location_id WHERE m.type <> 'group' AND lower(${GROUP_OF}) = lower(?) ORDER BY m.name COLLATE NOCASE`).all(group);

  /** A line: name, state, bars of the days, uptime (over the days with checks) */
  function lineOf(name, ids, state, days, at) {
    const d = daily(ids, at);
    let ok = 0; let total = 0;
    const bars = days.map((day) => { const x = d.get(day); if (x) { ok += x.ok; total += x.total; } return { day, pct: x?.total ? Math.round((x.ok / x.total) * 1000) / 10 : null }; });
    return { name, state, bars, uptime: total ? Math.floor((ok / total) * 10000) / 100 : null };
  }

  /** Everything a page shows - names, states, numbers; nothing else leaves the server */
  function view(p, at = now()) {
    const days = dayList(at);
    const sections = [];
    let loose = null;
    for (const it of parse(p.items, [])) {
      if (it.type === 'group') {
        const members = membersOf(it.group);
        const label = it.label || it.group;
        if (it.members) {
          sections.push({ title: label, lines: members.map((m) => lineOf(m.name, [m.id], stateOf(m), days, at)) });
          loose = null;
        } else {
          if (!loose) sections.push((loose = { title: '', lines: [] }));
          loose.lines.push(lineOf(label, members.filter((m) => m.enabled).map((m) => m.id), members.length ? combine(members.map(stateOf)) : 'pending', days, at));
        }
      } else {
        const m = monitorRow.get(it.id);
        if (!m) continue;
        if (!loose) sections.push((loose = { title: '', lines: [] }));
        loose.lines.push(lineOf(it.label || m.name, [m.id], stateOf(m), days, at));
      }
    }
    const all = sections.flatMap((s) => s.lines);
    const bad = all.filter((l) => l.state === 'down' || l.state === 'partial').length;
    const overall = bad ? (all.every((l) => l.state === 'down') ? 'down' : 'partial') : all.some((l) => l.state === 'maintenance') ? 'maintenance' : all.length ? 'up' : 'pending';
    return { title: p.name, description: p.description, notice: p.notice, notice_level: p.notice_level, show_uptime: !!p.show_uptime, language: p.language,
      sections, overall, bad, total: all.length, at: at.toISOString(), days };
  }

  /** The page for a visitor - null when it is off, unknown or not for this address (the caller answers "not found") */
  function forVisitor(slug, ip) {
    const s = String(slug || '').toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(s)) return null;
    const p = db.prepare('SELECT * FROM status_pages WHERE slug=? AND enabled=1').get(s);
    if (!p || !addressAllowed(parse(p.networks, []), ip)) return null;
    return view(p);
  }

  return {
    list: () => db.prepare('SELECT * FROM status_pages ORDER BY name COLLATE NOCASE').all().map(shape),
    get: (id) => shape(row(id)),
    create, update, remove, renewLink, view: (id) => { const p = row(id); if (!p) throw new HttpError(404, 'err.notFound'); return view(p); },
    forVisitor,
  };
}

// ---------------------------------------------------------------------------------------------------- the page itself
const TEXT = {
  de: { up: 'In Betrieb', down: 'Gestört', partial: 'Teilweise gestört', maintenance: 'Wartung', pending: 'Wird geprüft', off: 'Nicht überwacht',
    all: { up: 'Alles in Betrieb', down: 'Störung', partial: 'Störung bei {n} von {m}', maintenance: 'Wartung', pending: 'Wird geprüft' },
    asOf: 'Stand {time} · aktualisiert sich jede Minute', days: 'Letzte {n} Tage', today: 'heute', noData: 'keine Daten', uptime: '{pct} %',
    notFound: 'Diese Seite gibt es nicht.', empty: 'Auf dieser Seite ist noch nichts ausgewählt.' },
  en: { up: 'Operational', down: 'Down', partial: 'Partly down', maintenance: 'Maintenance', pending: 'Checking', off: 'Not monitored',
    all: { up: 'All systems operational', down: 'Outage', partial: 'Outage at {n} of {m}', maintenance: 'Maintenance', pending: 'Checking' },
    asOf: 'As of {time} · refreshes every minute', days: 'Last {n} days', today: 'today', noData: 'no data', uptime: '{pct} %',
    notFound: 'This page does not exist.', empty: 'Nothing has been chosen for this page yet.' },
};
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const num = (n, lang) => n.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { minimumFractionDigits: n === 100 ? 0 : 2, maximumFractionDigits: 2 });
const barClass = (pct) => (pct === null ? 'none' : pct >= 100 ? 'up' : pct >= 95 ? 'warn' : 'down');

const head = (title, lang, refresh) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">${refresh ? '\n<meta http-equiv="refresh" content="60">' : ''}
<title>${esc(title)}</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/css/status.css"></head>`;

/** HTML of a status page: no script, nothing from outside, refreshes itself */
export function renderStatusPage(v) {
  const lang = v.language === 'en' ? 'en' : 'de';
  const T = TEXT[lang];
  const time = new Date(v.at).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const dayName = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: 'numeric', month: 'short' });
  const lineHtml = (l) => {
    const bars = l.bars.map((b, i) => `<i class="${barClass(b.pct)}" title="${esc(i === l.bars.length - 1 ? T.today : dayName(b.day))}: ${b.pct === null ? T.noData : `${num(b.pct, lang)} %`}"></i>`).join('');
    return `<li class="line">
  <div class="line-head"><span class="name">${esc(l.name)}</span>${v.show_uptime && l.uptime !== null ? `<span class="uptime">${fill(T.uptime, { pct: num(l.uptime, lang) })}</span>` : ''}<span class="state s-${l.state}">${T[l.state]}</span></div>
  <div class="bars" role="img" aria-label="${esc(`${l.name}: ${fill(T.days, { n: DAYS })}`)}">${bars}</div>
</li>`;
  };
  const sections = v.sections.map((s) => `<section>${s.title ? `<h2>${esc(s.title)}</h2>` : ''}<ul>${s.lines.map(lineHtml).join('')}</ul></section>`).join('\n');
  const para = (s) => esc(s).replace(/\n/g, '<br>');
  return `${head(v.title, lang, true)}
<body><main>
<header><h1>${esc(v.title)}</h1>${v.description ? `<p class="lead">${para(v.description)}</p>` : ''}</header>
<div class="overall o-${v.overall}" role="status"><span class="dot"></span>${esc(fill(T.all[v.overall] || T.all.pending, { n: v.bad, m: v.total }))}</div>
${v.notice ? `<div class="notice n-${esc(v.notice_level)}">${para(v.notice)}</div>` : ''}
${v.total ? sections : `<p class="lead">${T.empty}</p>`}
${v.total ? `<p class="legend"><span class="d-long">${fill(T.days, { n: DAYS })}</span><span class="d-short">${fill(T.days, { n: 30 })}</span><span>${T.today}</span></p>` : ''}
<footer>${esc(fill(T.asOf, { time }))}</footer>
</main></body></html>
`;
}

/** The same answer for unknown, off and not allowed */
export function renderNotFound(lang = 'de') {
  const T = TEXT[lang === 'en' ? 'en' : 'de'];
  return `${head('404', lang, false)}
<body><main><header><h1>404</h1><p class="lead">${T.notFound}</p></header></main></body></html>
`;
}
