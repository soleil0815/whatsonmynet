// Monitoring: list of monitors with heartbeat bar, detail with response time chart and events,
// form to add or edit a monitor, maintenance windows.
import { h, mount, modal, toast, confirmDialog, fmtDate, fmtAgo } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { pageHead, field, input, select, btn, formData } from './common.js';
import { openHostScript } from './hostscripts.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

export function statusPill(status) {
  return h('span', { class: `pill pill-${status}` }, h('i'), t(`mon.status.${status}`));
}

export function monitorDot(status) {
  return h('span', { class: `dot mon-${status}`, title: t(`mon.status.${status}`), role: 'img', 'aria-label': t(`mon.status.${status}`) });
}

// Monitors that measure a value (not a response time): device sensors, SNMP values and Proxmox values
const PX_STATE = ['nodeOnline', 'guestRunning'];
const PX_UNIT = { nodeCpu: ' %', nodeMem: ' %', storage: ' %', datastore: ' %', backupAge: ' h', groupAge: ' h' };
export const isValueType = (m) => m.type === 'sensor' || m.type === 'snmp' || (m.type === 'proxmox' && !PX_STATE.includes(m.options?.metric));
const unitOf = (m) => (m.type === 'proxmox' ? PX_UNIT[m.options?.metric] || '' : m.options?.unit ? ` ${m.options.unit}` : '');
/** Last measured value with its unit, '–' while there is none */
const valueText = (m) => (m.last_ms === null || m.last_ms === undefined ? '–' : `${m.last_ms}${unitOf(m)}`);
const OPS = ['lt', 'le', 'gt', 'ge', 'eq', 'ne', 'contains', 'notcontains'];
const loc = () => (getLang() === 'en' ? 'en-GB' : 'de-DE');
const num = (v) => (typeof v === 'number' ? v.toLocaleString(loc(), { maximumFractionDigits: 1 }) : String(v));
/** "21 %", "5 Std.", "41 °C" */
function withUnit(v, unit) {
  if (unit === 'h') return t('val.hours', { n: num(v) }).replace(' ', '\u00a0');
  return `${num(v)}${unit ? `\u00a0${unit}` : ''}`;
}
/** Running time of a node: "3 Tage", "5 Std." */
function fmtUptime(sec) {
  const hrs = Math.floor((Number(sec) || 0) / 3600);
  return hrs >= 48 ? t('val.days', { n: Math.floor(hrs / 24) }) : t('val.hours', { n: hrs });
}

/**
 * How a measured value stands against its alarm limit: ok, warn (close to the limit) or bad (limit reached).
 * Close = within 10 points for percentages, otherwise within 10 % of the limit.
 */
export function valueTone(d) {
  const v = Number(d?.v); const thr = Number(d?.threshold);
  if (!d || d.threshold === '' || d.threshold === null || d.threshold === undefined || !Number.isFinite(v) || !Number.isFinite(thr)) return 'ok';
  const near = d.unit === '%' ? 10 : Math.abs(thr) * 0.1;
  switch (d.op) {
    case 'ge': return v >= thr ? 'bad' : thr > near && v >= thr - near ? 'warn' : 'ok';
    case 'gt': return v > thr ? 'bad' : thr > near && v > thr - near ? 'warn' : 'ok';
    case 'le': return v <= thr ? 'bad' : v <= thr + near ? 'warn' : 'ok';
    case 'lt': return v < thr ? 'bad' : v < thr + near ? 'warn' : 'ok';
    case 'eq': return v === thr ? 'bad' : 'ok';
    case 'ne': return v !== thr ? 'bad' : 'ok';
    default: return 'ok';
  }
}

/**
 * What a monitor shows "now", readable without opening it:
 * { main, sub, tone, bar } - bar is a percentage for a small usage bar.
 */
export function nowParts(m) {
  const d = m.data || {};
  const parts = [];
  if (m.type === 'smb' && d.total) {
    return { main: t('smb.free', { size: fmtBytes(d.free) }), sub: t('smb.of', { total: fmtBytes(d.total), pct: pct(d.pct) }), tone: d.low ? 'bad' : 'ok', bar: 100 - d.pct };
  }
  if (d.state) {
    const up = ['online', 'running', 'mains', 'ok', 'on', 'none'].includes(d.state);
    if (d.uptime) parts.push(t('val.since', { time: fmtUptime(d.uptime) }));
    // UPS: battery charge and how long it lasts
    if (d.charge !== null && d.charge !== undefined) parts.push(t('ups.chargeShort', { n: d.charge }));
    if (d.runtime !== null && d.runtime !== undefined) parts.push(t('ups.leftShort', { time: fmtUptime(d.runtime) }));
    if (d.node && m.options?.metric === 'guestRunning') parts.push(t('val.onNode', { node: d.node }));
    if (up && d.cpu !== null && d.cpu !== undefined) parts.push(`CPU ${d.cpu} %`);
    if (up && d.mem !== null && d.mem !== undefined) parts.push(`RAM ${d.mem} %`);
    return { main: t(`val.state.${d.state}`) === `val.state.${d.state}` ? d.state : t(`val.state.${d.state}`), sub: parts.join(' · '), tone: up ? 'ok' : 'bad' };
  }
  if (d.v !== undefined && d.v !== null && d.v !== '') {
    const tone = valueTone(d);
    if (d.total) parts.push(t('val.usedOf', { used: fmtBytes(d.used).replace(' ', '\u00a0'), total: fmtBytes(d.total).replace(' ', '\u00a0') }));
    if (d.op && d.threshold !== '' && d.threshold !== undefined) parts.push(t(`val.limit.${d.op}`, { v: withUnit(Number.isFinite(Number(d.threshold)) ? Number(d.threshold) : d.threshold, d.unit) }));
    const main = `${withUnit(d.v, d.unit)}${d.free ? ` ${t('val.free')}` : ''}`;
    return { main, sub: parts.join(' · '), tone, bar: d.unit === '%' && typeof d.v === 'number' ? d.v : null };
  }
  if (m.type === 'sensor' && m.status === 'up' && m.last_message) return { main: m.last_message.replace(/^[^:]*:\s*/, ''), sub: '', tone: 'ok' };
  if (isValueType(m)) return { main: valueText(m), sub: '', tone: m.status === 'down' ? 'bad' : 'ok' };
  if (m.status === 'up' && m.last_ms !== null && m.last_ms !== undefined) return { main: `${m.last_ms} ms`, sub: '', tone: 'ok', plain: true };
  return { main: '–', sub: '', tone: 'muted', plain: true };
}

function nowCell(m) {
  const n = nowParts(m);
  return h('div', { class: `now${n.plain ? ' plain' : ''}` },
    h('div', { class: 'now-main' }, h('b', { class: `tone-${n.tone}` }, n.main),
      n.bar !== null && n.bar !== undefined ? h('span', { class: `now-bar now-${n.tone}`, 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(2, Math.min(100, n.bar))}%` } })) : null),
    n.sub ? h('div', { class: 'now-sub' }, n.sub.split(' · ').map((x, i) => [i ? ' · ' : null, h('span', {}, x)])) : null);
}

/** Readable name of a sensor value, e.g. "Toner: Black Toner (free %)" */
export function pxLabel(x) {
  return t(`px.m.${x.metric}`, { name: x.name || '' });
}

export function sensorLabel(x) {
  const base = t(`sens.m.${x.metric}`, { name: x.name || '' });
  return x.receptacle ? `${base} (${t('sens.free')})` : base;
}

const noUnit = (s) => String(s || '').replace(/\s\((%|h|°C)\)$/, '');
export function targetText(m) {
  if (m.type === 'proxmox') return noUnit(m.target);
  if (m.type === 'docker') return m.docker_host ? `${m.target} @ ${m.docker_host.name}` : m.target;
  if (m.type === 'sensor') return m.device_name ? `${m.device_name} · ${noUnit(m.target)}` : noUnit(m.target);
  if (m.type === 'snmp') return `${m.target}:${m.port} · ${m.options?.oid || ''}`;
  if (m.type === 'smb') return `\\\\${m.target}${m.port && m.port !== 445 ? `:${m.port}` : ''}\\${m.options?.share || ''}${m.options?.path ? `\\${m.options.path}` : ''}`;
  return ['tcp', 'mysql', 'postgres', 'redis'].includes(m.type) ? `${m.target}:${m.port}` : m.target;
}

function beatsBar(beats, slots = 40, valueMode = false) {
  const pad = Math.max(0, slots - beats.length);
  return h('span', { class: 'beats', 'aria-hidden': 'true' },
    Array.from({ length: pad }, () => h('i', { class: 'none' })),
    beats.slice(-slots).map((b) => h('i', { class: b.ok ? 'ok' : 'bad', title: `${fmtDate(b.at, getLang())} · ${valueMode || !b.ok ? b.message : `${b.ms ?? '–'} ms`}` })));
}

/** Size in bytes, readable: 31,8 GB */
export function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Number(n) || 0; let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toLocaleString(getLang() === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: v >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
}

/** "\\\\fs01\\Abteilung\\Projekte" or "//fs01/Abteilung" → { host, share, path }; null if not a UNC path */
export function parseUnc(s) {
  const m = /^(?:\\\\|\/\/|smb:\/\/)([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i.exec(String(s || '').trim());
  if (!m) return null;
  return { host: m[1], share: m[2], path: (m[3] || '').replace(/[\\/]+/g, '\\').replace(/\\$/, '') };
}

/**
 * Host, port and scheme of whatever was typed: https://nas.local:5001/, a UNC path (two backslashes, server, share), 10.0.0.5:22, [fe80::1]:80, nas.local
 */
export function splitAddress(raw) {
  const s = String(raw || '').trim();
  const unc = parseUnc(s);
  if (unc) return { host: unc.host, port: null, scheme: 'smb' };
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (m) {
    try { const u = new URL(s); return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : null, scheme: m[1].toLowerCase() }; } catch { /* fall through */ }
  }
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : null, scheme: '' };
  const hp = /^([^\s/:]+):(\d{1,5})$/.exec(s);
  if (hp) return { host: hp[1], port: Number(hp[2]), scheme: '' };
  return { host: s.replace(/\/.*$/, ''), port: null, scheme: '' };
}

const pct = (v) => (v === null || v === undefined ? '–' : `${v.toLocaleString(getLang() === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 2 })} %`);

export async function renderMonitoring(main, id, sub) {
  if (id) return renderDetail(main, Number(id));
  if (sub === 'maintenance') return renderMaintenance(main);
  const edit = state.user.canEdit;
  const tabs = tabBar('monitors');
  const body = h('section', { class: 'panel' });
  let timer = null;
  let alive = true;
  // Filter by state and search; the list is grouped so that what is down comes first
  let filter = new URLSearchParams(location.search).get('status') || '';
  let all = [];
  let byId = new Map();
  const q = h('input', { type: 'search', placeholder: t('mon.search'), 'aria-label': t('mon.search'), oninput: () => draw() });
  const chips = h('div', { class: 'inv-chips', role: 'group', 'aria-label': t('mon.col.name') });
  const ORDER = ['down', 'unreachable', 'pending', 'maintenance', 'up', 'paused'];

  function row(m) {
    return h('tr', { class: 'click', onclick: (e) => { if (!e.target.closest('a,button')) navigate(`/monitoring/${m.id}`); } },
      h('td', {}, h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, monitorDot(m.status),
        h('div', { style: { minWidth: 0 } }, h('a', { href: `/monitoring/${m.id}`, 'data-link': true, class: 'name' }, m.name),
          h('div', { class: 'sub' }, m.status === 'down' && m.last_message ? h('span', { class: 'tone-bad' }, m.last_message)
            : m.status === 'unreachable' ? h('span', {}, t('mon.behind', { name: byId.get(m.parent_id)?.name || '?' }))
              : h('span', { class: 'mono' }, `${t(`mon.type.${m.type}`)} · ${targetText(m)}`))))),
      h('td', { class: 'hide-sm' }, beatsBar(m.beats, 40, isValueType(m))),
      h('td', {}, pct(m.uptime24)),
      h('td', { class: 'hide-sm' }, nowCell(m)),
      h('td', { class: 'hide-sm' }, certBadge(m)));
  }

  function draw() {
    const counts = {};
    for (const m of all) counts[m.status] = (counts[m.status] || 0) + 1;
    const chip = (key, label, n, tone) => h('button', { type: 'button', class: `fchip${filter === key ? ' on' : ''}`, 'aria-pressed': String(filter === key),
      onclick: () => { filter = filter === key && key ? '' : key; history.replaceState({}, '', `/monitoring${filter ? `?status=${filter}` : ''}`); draw(); } },
      tone ? h('span', { class: `dot dot-${tone}` }) : null, label, h('span', { class: 'chip-n' }, n));
    mount(chips, chip('', t('all'), all.length), counts.down ? chip('down', t('mon.status.down'), counts.down, 'bad') : null,
      counts.unreachable ? chip('unreachable', t('mon.status.unreachable'), counts.unreachable) : null,
      counts.up ? chip('up', t('mon.status.up'), counts.up, 'ok') : null, counts.paused ? chip('paused', t('mon.status.paused'), counts.paused) : null);
    const term = q.value.trim().toLowerCase();
    const list = all.filter((m) => (!filter || m.status === filter) && (!term || `${m.name} ${m.target} ${t(`mon.type.${m.type}`)}`.toLowerCase().includes(term)));
    const rows = [];
    for (const st of ORDER) {
      const part = list.filter((m) => (ORDER.includes(m.status) ? m.status : 'pending') === st);
      if (!part.length) continue;
      rows.push(h('tr', { class: 'group' }, h('td', { colspan: 5 }, `${t(`mon.status.${st}`)} · ${part.length}`)));
      for (const m of part) rows.push(row(m));
    }
    mount(body, h('div', { class: 'table-wrap' }, rows.length ? h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('mon.col.name')), h('th', { class: 'hide-sm' }, t('mon.col.beats')),
        h('th', {}, t('mon.col.uptime')), h('th', { class: 'hide-sm' }, t('mon.col.now')), h('th', { class: 'hide-sm' }, t('mon.col.cert')))),
      h('tbody', {}, rows)) : h('div', { class: 'empty' }, t('mon.noMatch'))));
  }

  async function load() {
    let list;
    try { list = await get('/monitors'); } catch (e) { if (alive) fail(e); return; }
    if (!alive) return;
    all = list;
    byId = new Map(list.map((m) => [m.id, m]));
    if (!list.length) {
      mount(body, h('div', { class: 'empty' }, h('h2', {}, t('mon.emptyTitle')), h('p', {}, t('mon.emptyText')),
        edit ? btn(t('mon.add'), { class: 'btn btn-primary', onclick: () => openMonitorForm(null, load) }, 'plus') : null));
    } else {
      draw();
    }
    timer = setTimeout(load, 15000);
  }

  mount(main, h('div', { class: 'page' },
    pageHead(t('mon.title'), t('mon.lead'), edit ? btn(t('mon.add'), { class: 'btn btn-primary', onclick: () => openMonitorForm(null, load) }, 'plus') : null),
    tabs, h('div', { class: 'inv-filter' }, h('div', { class: 'search' }, h('span', { html: icon('search') }), q), chips), body));
  mount(body, h('div', { class: 'empty' }, t('loading')));
  await load();
  return () => { alive = false; clearTimeout(timer); };
}

function tabBar(active) {
  return h('div', { class: 'tabs page-tabs', role: 'tablist' },
    [['monitors', '/monitoring'], ['maintenance', '/monitoring/maintenance']].map(([k, href]) => h('a', { href, 'data-link': true, role: 'tab',
      class: active === k ? 'on' : '', 'aria-selected': String(active === k) }, t(`mon.tab.${k}`))));
}

function certBadge(m) {
  if (m.cert_days_left === null || m.cert_days_left === undefined) return '–';
  const d = m.cert_days_left;
  return h('span', { class: `badge${d < 0 ? ' badge-bad' : d <= 14 ? ' badge-new' : ''}`, title: fmtDate(m.cert_valid_to, getLang(), false) },
    d < 0 ? t('mon.certExpired') : t('mon.certDays', { n: d }));
}

/** Response time chart: line for answers, red marks for failed checks */
/** valueMode: sensors - the line shows the measured value (also while the alarm is on), without unit */
function chart(checks, hours, valueMode = false) {
  const W = 720; const H = 160; const P = 6;
  const svg = svgEl('svg', { class: 'mon-chart', viewBox: `0 0 ${W} ${H + 18}`, role: 'img', 'aria-label': t('mon.chart') });
  if (!checks.length) {
    const tx = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'muted-text' });
    tx.textContent = t('mon.noChecks');
    svg.append(tx);
    return svg;
  }
  const end = Date.now();
  // Young monitors: start at the first check instead of showing an empty day
  const first = Date.parse(checks[0].at);
  const start = Math.max(end - hours * 3600 * 1000, Math.min(first - 60000, end - 10 * 60000));
  const x = (at) => P + ((Date.parse(at) - start) / (end - start)) * (W - 2 * P);
  const drawn = (c) => c.ms !== null && (c.ok || valueMode);
  const max = Math.max(10, ...checks.filter(drawn).map((c) => c.ms));
  const y = (ms) => H - P - (ms / max) * (H - 2 * P - 10);
  for (const f of [0.5, 1]) {
    svg.append(svgEl('line', { x1: 0, x2: W, y1: y(max * f), y2: y(max * f), class: 'grid' }));
    const lab = svgEl('text', { x: 2, y: y(max * f) - 3, class: 'axis' });
    lab.textContent = `${Math.round(max * f)}${valueMode ? '' : ' ms'}`;
    svg.append(lab);
  }
  let d = ''; let pen = false;
  for (const c of checks) {
    if (!c.ok) svg.append(svgEl('rect', { x: x(c.at) - 1, y: H - 14, width: 2.5, height: 12, class: 'fail' }));
    if (!drawn(c)) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${x(c.at).toFixed(1)},${y(c.ms).toFixed(1)}`;
    pen = true;
  }
  svg.append(svgEl('path', { d, class: 'line' }));
  for (const [pos, at] of [[0, start], [W, end]]) {
    const lab = svgEl('text', { x: pos ? W - 2 : 2, y: H + 14, class: 'axis', 'text-anchor': pos ? 'end' : 'start' });
    lab.textContent = fmtDate(new Date(at).toISOString(), getLang());
    svg.append(lab);
  }
  return svg;
}

/**
 * Long ranges (30 days to a year) from the hourly summary: average line, the band from lowest to highest value,
 * and below a strip per bucket that shows how much of the time the monitor was reachable.
 */
function longChart(series, hours, bucketHours, valueMode = false) {
  const W = 720; const H = 160; const P = 6; const STRIP = 10;
  const svg = svgEl('svg', { class: 'mon-chart', viewBox: `0 0 ${W} ${H + 18}`, role: 'img', 'aria-label': t('mon.chart') });
  if (!series.length) {
    const tx = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'muted-text' });
    tx.textContent = t('mon.noChecks');
    svg.append(tx);
    return svg;
  }
  const size = bucketHours * 3600 * 1000;
  const end = Date.now();
  // Young monitors: start at the first data instead of showing months of nothing
  const start = Math.max(end - hours * 3600 * 1000, Date.parse(series[0].at) - size);
  const x = (ms) => P + ((ms - start) / (end - start)) * (W - 2 * P);
  const bw = Math.max(1, x(start + size) - x(start) - 0.5);
  const vals = series.filter((b) => b.avg !== null);
  const max = Math.max(10, ...vals.map((b) => b.max ?? b.avg));
  const top = H - STRIP - 4;
  const y = (v) => top - (v / max) * (top - P - 10);
  for (const f of [0.5, 1]) {
    svg.append(svgEl('line', { x1: 0, x2: W, y1: y(max * f), y2: y(max * f), class: 'grid' }));
    const lab = svgEl('text', { x: 2, y: y(max * f) - 3, class: 'axis' });
    lab.textContent = `${Math.round(max * f)}${valueMode ? '' : ' ms'}`;
    svg.append(lab);
  }
  // Band and line, broken where buckets are missing (monitor paused, program off)
  const mid = (b) => x(Date.parse(b.at) + size / 2);
  let runs = []; let cur = [];
  for (const b of vals) {
    if (cur.length && Date.parse(b.at) - Date.parse(cur[cur.length - 1].at) > size) { runs.push(cur); cur = []; }
    cur.push(b);
  }
  if (cur.length) runs.push(cur);
  for (const r of runs) {
    const hi = r.map((b) => `${mid(b).toFixed(1)},${y(b.max ?? b.avg).toFixed(1)}`);
    const lo = r.slice().reverse().map((b) => `${mid(b).toFixed(1)},${y(b.min ?? b.avg).toFixed(1)}`);
    svg.append(svgEl('path', { d: `M${hi.join('L')}L${lo.join('L')}Z`, class: 'band' }));
    svg.append(svgEl('path', { d: r.length > 1 ? `M${r.map((b) => `${mid(b).toFixed(1)},${y(b.avg).toFixed(1)}`).join('L')}` : `M${mid(r[0]) - 1},${y(r[0].avg)}h2`, class: 'line' }));
  }
  // Availability strip: full = always reachable, red the more checks failed
  const day = bucketHours >= 24;
  for (const b of series) {
    const share = b.total ? b.ok / b.total : 1;
    const rect = svgEl('rect', { x: x(Date.parse(b.at)), y: H - STRIP, width: bw, height: STRIP, class: share >= 0.999 ? 'avail' : share >= 0.95 ? 'avail warn' : 'avail bad' });
    const tip = svgEl('title');
    const when = fmtDate(b.at, getLang(), !day);
    tip.textContent = `${when}: ${t('mon.histUp', { pct: (Math.floor(share * 1000) / 10).toLocaleString(getLang()) })}${b.avg !== null ? ` · ${t('mon.histAvg')} ${b.avg}${valueMode ? '' : ' ms'}${b.min !== null && b.max !== null && b.min !== b.max ? ` (${b.min}–${b.max})` : ''}` : ''}`;
    rect.append(tip);
    svg.append(rect);
  }
  // Date marks: start, two in between, now
  for (let i = 0; i <= 3; i++) {
    const at = start + ((end - start) * i) / 3;
    const lab = svgEl('text', { x: i === 0 ? 2 : i === 3 ? W - 2 : x(at), y: H + 14, class: 'axis', 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle' });
    lab.textContent = fmtDate(new Date(at).toISOString(), getLang(), false);
    svg.append(lab);
  }
  return svg;
}

async function renderDetail(main, id) {
  const edit = state.user.canEdit;
  let hours = 24;
  let timer = null;
  let alive = true;
  const head = h('div'); const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, head, body));

  async function load() {
    let m;
    try { m = await get(`/monitors/${id}?hours=${hours}`); } catch (e) { if (alive) fail(e); return; }
    if (!alive) return;
    const reload = () => { clearTimeout(timer); load(); };
    mount(head, h('div', { class: 'device-head' },
      h('div', { class: `device-icon mon-icon mon-${m.status}`, html: icon('pulse') }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('h1', {}, m.name, statusPill(m.status)),
        h('div', { class: 'meta' }, h('span', { class: 'mono' }, `${t(`mon.type.${m.type}`)} · ${targetText(m)}`),
          h('span', {}, t('mon.every', { n: m.interval_s })),
          m.device ? h('a', { href: `/devices/${m.device.id}`, 'data-link': true }, m.device.name) : null)),
      edit ? h('div', { class: 'actions' },
        btn(t('mon.checkNow'), { onclick: async (e) => { e.currentTarget.disabled = true; try { await post(`/monitors/${id}/check`); reload(); } catch (ex) { fail(ex); } } }, 'radar'),
        btn(m.enabled ? t('mon.pause') : t('mon.resume'), { onclick: async () => { try { await post(`/monitors/${id}/${m.enabled ? 'pause' : 'resume'}`); reload(); } catch (ex) { fail(ex); } } }),
        btn(t('edit'), { onclick: () => openMonitorForm(m, reload) }, 'edit'),
        btn(t('delete'), { class: 'btn btn-danger', onclick: async () => {
          if (!await confirmDialog(t('delete'), t('mon.deleteConfirm', { name: m.name }), t('delete'), t('cancel'), { danger: true })) return;
          try { await del(`/monitors/${id}`); toast(t('deleted')); navigate('/monitoring'); } catch (ex) { fail(ex); }
        } }, 'trash')) : null));

    const span = h('div', { class: 'seg' }, [[24, '24 h'], [72, t('mon.r.3d')], [168, t('mon.r.7d')], [720, t('mon.r.30d')], [2160, t('mon.r.90d')], [8784, t('mon.r.1y')]].map(([v, l]) => h('button', { type: 'button', class: v === hours ? 'on' : '',
      onclick: () => { hours = v; reload(); } }, l)));
    mount(body,
      m.status === 'down' ? h('div', { class: 'note bad' }, t('mon.downSince', { when: fmtAgo(m.status_since, t), message: m.last_message })) : null,
      m.status === 'unreachable' && m.parent ? h('div', { class: 'note' }, h('span', {}, t('mon.unreachableNote', { when: fmtAgo(m.status_since, t) }), ' ',
        h('a', { href: `/monitoring/${m.parent.id}`, 'data-link': true }, m.parent.name))) : null,
      m.maintenance ? h('div', { class: 'note ti' }, t('mon.inMaintenance')) : null,
      h('div', { class: 'figures' },
        h('div', { class: 'figure' }, h('b', {}, pct(m.uptime.h24.pct)), h('span', {}, t('mon.uptime24'))),
        h('div', { class: 'figure' }, h('b', {}, pct(m.uptime.d7.pct)), h('span', {}, t('mon.uptime7'))),
        m.uptime.span ? h('div', { class: 'figure' }, h('b', {}, pct(m.uptime.span.pct)), h('span', {}, t('mon.uptimeSpan', { range: rangeName(hours) })))
          : h('div', { class: 'figure' }, h('b', {}, pct(m.uptime.d30.pct)), h('span', {}, t('mon.uptime30'))),
        isValueType(m) || m.data?.state ? (() => { const n = nowParts(m); return h('div', { class: `figure${n.tone === 'bad' ? ' bad' : n.tone === 'warn' ? ' alert' : ''}` }, h('b', {}, n.main), h('span', {}, n.sub || t('sens.current'))); })()
          : h('div', { class: 'figure' }, h('b', {}, m.uptime.h24.avgMs !== null ? `${m.uptime.h24.avgMs} ms` : '–'), h('span', {}, t('mon.avgMs'))),
        m.type === 'smb' && m.data && m.data.total ? h('div', { class: `figure${m.data.low ? ' alert' : ''}` }, h('b', {}, t('smb.free', { size: fmtBytes(m.data.free) })),
          h('span', {}, t('smb.of', { total: fmtBytes(m.data.total), pct: pct(m.data.pct) }))) : null,
        m.cert_valid_to ? h('div', { class: `figure${m.cert_days_left <= 14 ? ' alert' : ''}` }, h('b', {}, m.cert_days_left < 0 ? t('mon.certExpired') : m.cert_days_left),
          h('span', {}, t('mon.certLeft', { date: fmtDate(m.cert_valid_to, getLang(), false) }))) : null),
      h('section', { class: 'panel panel-pad' },
        h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '10px' } }, h('h2', { class: 'section-title', style: { margin: 0 } }, isValueType(m) ? t('sens.chart') : t('mon.chart')), span),
        m.history ? longChart(m.history, hours, m.bucketHours, isValueType(m)) : chart(m.checks, hours, isValueType(m)),
        m.history ? h('p', { class: 'muted small', style: { margin: '6px 0 0' } }, t(isValueType(m) ? 'mon.histLegendValue' : 'mon.histLegend', { bucket: m.bucketHours >= 24 ? t('mon.histDay') : t('mon.hist6h') })) : null),
      depPanel(m, edit, reload),
      h('section', { class: 'panel panel-pad' },
        h('h2', { class: 'section-title' }, t('mon.events')),
        m.events.length ? h('ul', { class: 'timeline' }, m.events.map((e) => h('li', { class: `ev-${e.kind}` },
          h('span', { class: 'when' }, fmtDate(e.at, getLang()), e.notified ? ` · ${t('mon.notified', { to: e.notified })}` : ''),
          eventLine(e))))
          : h('p', { class: 'muted' }, t('mon.noEvents'))));
    timer = setTimeout(load, 30000);
  }
  await load();
  return () => { alive = false; clearTimeout(timer); };
}

function eventLine(e) {
  if (e.kind === 'cert') return t('mon.ev.cert', { n: e.message });
  if (e.kind === 'unreachable') return t('mon.ev.unreachable', { name: e.message });
  if (e.kind === 'escalated') return t('mon.ev.escalated', { n: e.message });
  return `${t(`mon.ev.${e.kind}`)}${e.message && e.kind === 'down' ? ` - ${e.message}` : ''}`;
}

const rangeName = (hours) => ({ 720: t('mon.r.30dLong'), 2160: t('mon.r.90dLong'), 8784: t('mon.r.1yLong') }[hours] || `${hours} h`);

/** Dependencies: what this monitor sits behind, what sits behind it, and the devices at its switch that could */
function depPanel(m, edit, reload) {
  const deps = m.dependents || [];
  const offer = edit && m.candidates > 0;
  if (!m.parent && !deps.length && !offer) return null;
  const link = (x) => h('a', { href: `/monitoring/${x.id}`, 'data-link': true, class: 'dep-link' }, monitorDot(x.status), x.name);
  return h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('mon.dep.title')),
    h('dl', { class: 'kv' },
      m.parent ? [h('dt', {}, t('mon.f.parent')), h('dd', {}, link(m.parent))] : null,
      deps.length ? [h('dt', {}, t('mon.dep.behind', { n: deps.length })), h('dd', {}, h('div', { class: 'dep-list' }, deps.map(link)))] : null),
    deps.length ? h('p', { class: 'muted small', style: { margin: '8px 0 0' } }, t('mon.dep.explain')) : null,
    offer ? h('div', { class: 'note', style: { marginTop: '12px' } }, h('div', {},
      h('p', { style: { margin: '0 0 8px' } }, t('mon.dep.offer', { n: m.candidates })),
      btn(t('mon.dep.adopt'), { class: 'btn btn-sm', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { const r = await post(`/monitors/${m.id}/children`); toast(t('mon.dep.adopted', { n: r.count })); reload(); } catch (ex) { fail(ex); e.currentTarget.disabled = false; }
      } }, 'switch'))) : null);
}

/** Form to add or edit a monitor. `preset` fills a new one (e.g. from a device). */
// Step 1 of "Add monitor": what should be watched? One tile per kind, with a sentence what it checks
const PICK = [['http', 'open'], ['ping', 'radar'], ['tcp', 'switch'], ['smb', 'nas'], ['sensor', 'printer'], ['proxmox', 'hypervisor'], ['docker', 'server'], ['mysql', 'inventory'], ['snmp', 'router']];
function pickKind(done, preset) {
  const tile = (type, ico, onclick) => h('button', { type: 'button', class: 'pick', onclick },
    h('span', { class: 'pick-ico', html: icon(ico) }), h('span', { class: 'pick-title' }, t(`mon.pick.${type}`)), h('span', { class: 'pick-text' }, t(`mon.pick.${type}.d`)));
  const dlg = modal(t('mon.add'), h('div', {},
    h('p', { class: 'muted', style: { marginTop: 0 } }, t('mon.pick.lead')),
    h('div', { class: 'pick-grid' },
      PICK.map(([type, ico]) => tile(type, ico, () => { dlg.close(); openMonitorForm(null, done, { ...(preset || {}), type }); })),
      // Windows/Linux machines: no monitor of its own - a script reports load, drives and services (admins create the key)
      state.user.isAdmin ? tile('script', 'computer', () => { dlg.close(); startHostScript(preset, done); }) : null)),
  { wide: true, actions: [btn(t('cancel'), { onclick: () => dlg.close() })] });
}

// Machines that a script may report for: everything that runs Windows or Linux
const SCRIPT_TYPES = ['server', 'computer', 'vm', 'hypervisor', 'unknown'];

/** "Machine by script": for one device the script with its own key; otherwise choose the device or take the shared script */
async function startHostScript(preset, done) {
  try {
    if (preset?.device_id) { openHostScript(await get(`/devices/${preset.device_id}`), done); return; }
    const all = await get('/devices');
    const list = all.filter((d) => SCRIPT_TYPES.includes(d.type)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const devSel = select('device_id', [['', t('hs.pickDevice')], ...list.map((d) => [String(d.id), `${d.name}${d.ip ? ` (${d.ip})` : ''}`])], '', { required: true });
    const form = h('form', { class: 'form', onsubmit: (e) => e.preventDefault() },
      h('p', { style: { margin: 0 } }, t('hs.pickLead')),
      list.length ? field(t('sens.device'), devSel) : h('p', { class: 'muted', style: { margin: 0 } }, t('hs.pickNone')),
      h('div', { class: 'note', style: { margin: 0 } }, h('div', {},
        h('strong', {}, t('hs.pickManyTitle')), h('p', { style: { margin: '4px 0 8px' } }, t('hs.pickMany')),
        btn(t('hs.addShared'), { class: 'btn btn-sm', onclick: () => { dlg.close(); navigate('/settings/hostscripts'); } }, 'computer'))));
    const dlg = modal(t('mon.pick.script'), form, { actions: [
      btn(t('cancel'), { onclick: () => dlg.close() }),
      list.length ? h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        if (!form.reportValidity()) return;
        const d = await get(`/devices/${devSel.value}`).catch((e) => { fail(e); return null; });
        if (d) { dlg.close(); openHostScript(d, done); }
      } }, t('hs.next')) : null] });
  } catch (e) { fail(e); }
}

export async function openMonitorForm(m, done, preset = null) {
  if (!m && !preset?.type) { pickKind(done, preset); return; }
  let chans = [];
  try { chans = await get('/channels'); } catch { /* list stays empty */ }
  const v = m || { type: 'http', interval_s: 60, timeout_s: 10, fail_threshold: 3, resend_min: 0, http_status: '200-399', http_keyword: '',
    tls_verify: false, cert_check: true, cert_days: '30,14,7', channels: [], ...(preset || {}) };
  let dockerHosts = [];
  try { dockerHosts = await get('/docker/hosts'); } catch { /* none or no right */ }
  const TYPES = ['http', 'tcp', 'ping', 'smb', 'sensor', 'snmp', 'proxmox', 'docker', 'mysql', 'postgres', 'redis'];
  const DBT = ['mysql', 'postgres', 'redis'];
  const DEF_PORT = { mysql: 3306, postgres: 5432, redis: 6379 };
  // New monitors: admins also find "machine by script" here - it is no monitor type, it opens the script dialog
  const offerScript = !m && state.user.isAdmin;
  const typeSel = select('type', [...TYPES.map((x) => [x, t(`mon.type.${x}`)]), ...(offerScript ? [['script', t('mon.pick.script')]] : [])], v.type);
  const target = input('target', v.target || '', { required: true, class: 'mono', placeholder: 'https://intranet.firma.local/', list: 'dl-containers' });
  const targetLabel = h('span', {}, t('mon.f.target'));
  const port = input('port', v.port || '', { type: 'number', min: 1, max: 65535, class: 'mono' });
  const portBox = h('div', {}, field(t('mon.f.port'), port));
  // Docker: host + container (names offered from the host)
  const containers = h('datalist', { id: 'dl-containers' });
  const hostSel = select('docker_host_id', [['', t('mon.f.chooseHost')], ...dockerHosts.map((x) => [String(x.id), x.name])], v.docker_host_id ? String(v.docker_host_id) : (dockerHosts.length === 1 ? String(dockerHosts[0].id) : ''));
  const containerHint = h('span', { class: 'hint' });
  async function loadContainers() {
    mount(containers);
    containerHint.textContent = '';
    if (!hostSel.value || typeSel.value !== 'docker') return;
    try {
      const r = await get(`/docker/hosts/${hostSel.value}/containers`);
      mount(containers, r.containers.map((c) => h('option', { value: c.name }, `${c.state} · ${c.image}`)));
      containerHint.textContent = t('mon.f.containersFound', { n: r.containers.length, version: r.version });
    } catch (e) { containerHint.textContent = e.message; }
  }
  hostSel.addEventListener('change', loadContainers);
  const targetWrap = h('div', {}, h('label', { class: 'field' }, targetLabel, target), containers);
  const dockerBox = h('div', { class: 'form-grid full' },
    dockerHosts.length ? field(t('mon.f.dockerHost'), hostSel, containerHint)
      : h('p', { class: 'full muted small' }, state.user.isAdmin ? t('mon.f.noDockerAdmin') : t('mon.f.noDocker')));
  // Databases: login (password is never shown again)
  const o = v.options || {};
  const pw = input('password', '', { type: 'password', autocomplete: 'new-password', placeholder: v.has_password ? '••••••' : '' });
  const dbName = field(t('mon.f.database'), input('database', o.database || '', { maxlength: 120, class: 'mono' }), t('mon.f.databaseHint'));
  const dbBox = h('div', { class: 'form-grid full' },
    field(t('mon.f.dbUser'), input('db_user', o.user || '', { maxlength: 120, autocomplete: 'off', class: 'mono' }), t('mon.f.dbUserHint')),
    field(t('mon.f.dbPassword'), pw, v.has_password ? t('mon.f.dbPasswordSet') : null),
    dbName,
    field(t('mon.f.dbTls'), h('input', { type: 'checkbox', name: 'db_tls', checked: !!o.tls })),
    h('p', { class: 'full muted small', style: { margin: 0 } }, t('mon.f.dbHint')));
  // Network drive (SMB): share, optional folder/file, read-only account, warning below free space
  const smbShare = input('smb_share', o.share || '', { maxlength: 80, class: 'mono', placeholder: t('smb.sharePh') });
  const smbPw = input('smb_password', '', { type: 'password', autocomplete: 'new-password', placeholder: v.type === 'smb' && v.has_password ? '••••••' : '' });
  const smbBox = h('div', { class: 'form-grid full' },
    field(t('smb.share'), smbShare, t('smb.shareHint')),
    field(t('smb.path'), input('smb_path', o.path || '', { maxlength: 400, class: 'mono', placeholder: t('smb.pathPh') }), t('smb.pathHint')),
    field(t('smb.user'), input('smb_user', o.user || '', { maxlength: 104, autocomplete: 'off', class: 'mono', placeholder: 'monitor' }), t('smb.userHint')),
    field(t('smb.domain'), input('smb_domain', o.domain || '', { maxlength: 63, class: 'mono', placeholder: 'FIRMA' }), t('smb.domainHint')),
    field(t('mon.f.dbPassword'), smbPw, v.type === 'smb' && v.has_password ? t('mon.f.dbPasswordSet') : null),
    h('div', {}),
    field(t('smb.minPct'), input('smb_min_pct', o.minFreePct || '', { type: 'number', min: 0, max: 99, step: '0.1', placeholder: '10' }), t('smb.minPctHint')),
    field(t('smb.minGb'), input('smb_min_gb', o.minFreeGb || '', { type: 'number', min: 0, step: '0.1', placeholder: '50' }), t('smb.minGbHint')),
    h('p', { class: 'full muted small', style: { margin: 0 } }, t('smb.hint')));
  // A pasted \\\\server\\share\\folder fills server, share and folder
  target.addEventListener('change', () => {
    if (typeSel.value !== 'smb') return;
    const u = parseUnc(target.value);
    if (!u) return;
    target.value = u.host;
    smbShare.value = u.share;
    smbBox.querySelector('[name=smb_path]').value = u.path;
  });
  // Sensor: a value a device already delivers (printer supplies, NAS volumes, switch ports …)
  const so = v.options || {};
  // A new sensor is named after what it watches until the name is typed by hand
  const nameIn = input('name', v.name || '', { required: true, maxlength: 120 });
  nameIn.addEventListener('input', () => { nameIn.dataset.touched = '1'; });
  const autoName = (text) => { if (!m && text && !nameIn.dataset.touched) nameIn.value = text; };
  let sensorDevices = [];
  try {
    // Devices with values to watch: printers, switches, NAS - and every machine whose host script reports
    const [all, reporting] = await Promise.all([get('/devices'), get('/hosts/devices').catch(() => [])]);
    const rep = new Set(reporting);
    sensorDevices = all.filter((d) => ['printer', 'nas', 'switch', 'ups'].includes(d.type) || rep.has(d.id));
  } catch { /* none */ }
  const devSel = select('device_id', [['', t('sens.chooseDevice')], ...sensorDevices.map((d) => [String(d.id), `${d.name}${d.ip ? ` (${d.ip})` : ''}`])],
    v.device_id ? String(v.device_id) : '', m ? { disabled: true } : {});
  let metrics = [];
  const metricSel = h('select', { name: 'metric' });
  const opSel = select('op', OPS.map((x) => [x, t(`sens.op.${x}`)]), so.op || 'le');
  const thr = input('threshold', so.threshold ?? '', { maxlength: 60, class: 'mono' });
  const condBox = h('div', { class: 'form-grid full' }, field(t('sens.op'), opSel), field(t('sens.threshold'), thr));
  const metricHint = h('span', { class: 'hint' });
  const syncMetric = () => {
    const x = metrics.find((y) => `${y.metric}|${y.key}` === metricSel.value);
    condBox.hidden = typeSel.value === 'sensor' && (!x || x.kind === 'state');
    // State values in words ("on battery"), numbers with their unit
    const st = x && x.kind === 'state' && t(`val.state.${x.value}`) !== `val.state.${x.value}` ? t(`val.state.${x.value}`) : null;
    metricHint.textContent = x ? t('sens.now', { value: x.value === null || x.value === undefined ? '–' : st || `${x.value}${x.unit ? ` ${x.unit}` : ''}` }) : '';
    if (x && !m && x.kind === 'number' && !thr.dataset.touched) { opSel.value = x.op; thr.value = x.threshold; }
    const dev = sensorDevices.find((y) => String(y.id) === devSel.value);
    if (x && typeSel.value === 'sensor') autoName(`${dev ? `${dev.name}: ` : ''}${sensorLabel(x)}`);
  };
  thr.addEventListener('input', () => { thr.dataset.touched = '1'; });
  metricSel.addEventListener('change', syncMetric);
  async function loadMetrics() {
    mount(metricSel);
    metrics = [];
    if (!devSel.value) { syncMetric(); return; }
    try { metrics = await get(`/devices/${devSel.value}/sensors`); } catch { metrics = []; }
    mount(metricSel, metrics.length ? metrics.map((x) => h('option', { value: `${x.metric}|${x.key}` }, sensorLabel(x))) : h('option', { value: '' }, t('sens.noValues')));
    if (so.metric) metricSel.value = `${so.metric}|${so.key || ''}`;
    syncMetric();
  }
  devSel.addEventListener('change', loadMetrics);
  const sensorBox = h('div', { class: 'form-grid full' },
    field(t('sens.device'), devSel),
    h('div', {}, h('label', { class: 'field' }, t('sens.metric'), metricSel, metricHint)));
  // Proxmox: a value of a PVE/PBS host
  let pxHosts = [];
  try { pxHosts = await get('/proxmox'); } catch { /* none or no right */ }
  const pxSel = select('px_host', [['', t('px.chooseHost')], ...pxHosts.map((x) => [String(x.id), x.name])], so.host ? String(so.host) : (pxHosts.length === 1 ? String(pxHosts[0].id) : ''));
  let pxMetrics = [];
  const pxMetricSel = h('select', { name: 'px_metric' });
  const pxHint = h('span', { class: 'hint' });
  const syncPx = () => {
    const x = pxMetrics.find((y) => `${y.metric}|${y.key}` === pxMetricSel.value);
    if (typeSel.value === 'proxmox') condBox.hidden = !x || x.kind === 'state';
    pxHint.textContent = !x ? '' : x.value === null || x.value === undefined
      ? (x.kind === 'number' && !/Age$/.test(x.metric) ? t('px.noValue') : t('sens.now', { value: '–' }))
      : t('sens.now', { value: `${x.value}${x.unit ? ` ${x.unit}` : ''}` });
    if (x && !m && x.kind === 'number' && !thr.dataset.touched) { opSel.value = x.op; thr.value = x.threshold; }
    const host = pxHosts.find((y) => String(y.id) === pxSel.value);
    if (x && typeSel.value === 'proxmox') autoName(`${pxHosts.length > 1 && host ? `${host.name}: ` : ''}${pxLabel(x)}`);
  };
  pxMetricSel.addEventListener('change', syncPx);
  async function loadPx() {
    mount(pxMetricSel);
    pxMetrics = [];
    if (!pxSel.value) { syncPx(); return; }
    try { pxMetrics = await get(`/proxmox/${pxSel.value}/metrics`); } catch { pxMetrics = []; }
    mount(pxMetricSel, pxMetrics.length ? pxMetrics.map((x) => h('option', { value: `${x.metric}|${x.key}` }, pxLabel(x))) : h('option', { value: '' }, t('sens.noValues')));
    if (so.metric && so.host) pxMetricSel.value = `${so.metric}|${so.key || ''}`;
    syncPx();
  }
  pxSel.addEventListener('change', loadPx);
  const pxBox = h('div', { class: 'form-grid full' },
    pxHosts.length ? field(t('px.host'), pxSel) : h('p', { class: 'full muted small' }, t('px.noHosts')),
    h('div', {}, h('label', { class: 'field' }, t('sens.metric'), pxMetricSel, pxHint)));
  // Free SNMP value
  const oid = input('oid', so.oid || '', { class: 'mono', placeholder: '1.3.6.1.2.1.33.1.2.4.0' });
  const snmpBox = h('div', { class: 'form-grid full' },
    h('div', { class: 'full' }, field('OID', oid, t('sens.oidHint'))));
  const httpBox = h('div', { class: 'form-grid full' },
    field(t('mon.f.status'), input('http_status', v.http_status, { class: 'mono' }), t('mon.f.statusHint')),
    field(t('mon.f.keyword'), input('http_keyword', v.http_keyword, { maxlength: 200 }), t('mon.f.keywordHint')),
    h('div', { class: 'full' }, field(t('mon.f.tlsVerify'), h('input', { type: 'checkbox', name: 'tls_verify', checked: !!v.tls_verify }), t('mon.f.tlsVerifyHint'))),
    field(t('mon.f.certCheck'), h('input', { type: 'checkbox', name: 'cert_check', checked: v.cert_check !== false })),
    field(t('mon.f.certDays'), input('cert_days', v.cert_days, { class: 'mono' }), t('mon.f.certDaysHint')));
  const sync = () => {
    const ty = typeSel.value;
    const isDb = DBT.includes(ty);
    sensorBox.hidden = ty !== 'sensor';
    pxBox.hidden = ty !== 'proxmox';
    pxSel.required = ty === 'proxmox';
    snmpBox.hidden = ty !== 'snmp';
    targetWrap.hidden = ty === 'sensor' || ty === 'proxmox';
    target.required = ty !== 'sensor' && ty !== 'proxmox';
    devSel.required = ty === 'sensor';
    oid.required = ty === 'snmp';
    condBox.hidden = !(ty === 'snmp' || ty === 'sensor' || ty === 'proxmox');
    if (ty === 'sensor') syncMetric();
    if (ty === 'proxmox') { if (!pxMetrics.length && pxSel.value) loadPx(); else syncPx(); }
    if (ty === 'sensor' && !metrics.length && devSel.value) loadMetrics();
    portBox.hidden = ty !== 'tcp' && ty !== 'snmp' && ty !== 'smb' && !isDb;
    smbBox.hidden = ty !== 'smb';
    smbShare.required = ty === 'smb';
    httpBox.hidden = ty !== 'http';
    dockerBox.hidden = ty !== 'docker';
    dbBox.hidden = !isDb;
    dbName.hidden = ty === 'redis';
    port.required = ty === 'tcp';
    port.placeholder = isDb ? String(DEF_PORT[ty]) : ty === 'snmp' ? '161' : ty === 'smb' ? '445' : '';
    hostSel.required = ty === 'docker';
    targetLabel.textContent = ty === 'docker' ? t('mon.f.container') : ty === 'smb' ? t('smb.server') : t('mon.f.target');
    target.placeholder = ty === 'http' ? 'https://intranet.firma.local/' : ty === 'docker' ? 'nextcloud' : ty === 'smb' ? t('smb.serverPh') : '192.168.1.10';
    if (ty === 'docker' && !containers.children.length) loadContainers();
  };
  // Switching the kind carries the address over in the form the new kind needs: https://10.0.0.5:8443/ for a web
  // check, 10.0.0.5 for ping/SMB/SNMP/databases, 10.0.0.5 + port 8443 for a TCP port. Back to web gives the old URL again.
  let prevType = typeSel.value;
  let lastUrl = prevType === 'http' ? target.value.trim() : '';
  const NO_HOST = ['sensor', 'proxmox'];
  typeSel.addEventListener('change', () => {
    if (typeSel.value === 'script') {
      typeSel.value = prevType;
      const devId = v.device_id || (typeSel.value === 'sensor' && devSel.value ? Number(devSel.value) : null);
      dlg.close();
      startHostScript(devId ? { device_id: devId } : null, done);
      return;
    }
    const from = prevType; const to = typeSel.value;
    prevType = to;
    const raw = target.value.trim();
    if (!raw || NO_HOST.includes(to)) { sync(); return; }
    if (from === 'docker' || to === 'docker') { if (from !== to) target.value = ''; sync(); return; }
    const a = splitAddress(raw);
    if (from === 'http') lastUrl = raw;
    if (to === 'http') {
      if (!/^https?:\/\//i.test(raw)) {
        const old = lastUrl && splitAddress(lastUrl);
        const p = from === 'tcp' ? Number(port.value) || a.port : a.port;
        target.value = old && old.host === a.host ? lastUrl
          : `${p === 80 ? 'http' : 'https'}://${a.host.includes(':') ? `[${a.host}]` : a.host}${p && p !== 80 && p !== 443 ? `:${p}` : ''}/`;
      }
    } else {
      target.value = a.host;
    }
    // The port belongs to the old kind (e.g. 161 for SNMP); only a TCP check takes the one from the address
    const fromUrl = lastUrl ? splitAddress(lastUrl) : null;
    const known = a.port ? a : fromUrl && fromUrl.host === a.host ? fromUrl : a;
    if (from !== to) port.value = to === 'tcp' ? String(known.port || (known.scheme === 'https' ? 443 : known.scheme === 'http' ? 80 : '') || '') : '';
    sync();
  });
  const selected = new Set(v.channels || []);
  // Depends on: switch, router or line in front - while that is down this one is a follow-up and sends no alarm.
  // Not offered: itself and what already sits behind it (that would be a circle)
  let others = [];
  try { others = await get('/monitors'); } catch { /* list stays empty */ }
  const below = new Set(m ? [m.id] : []);
  for (let grew = true; grew;) { grew = false; for (const x of others) if (x.parent_id && below.has(x.parent_id) && !below.has(x.id)) { below.add(x.id); grew = true; } }
  const REACH = ['ping', 'tcp', 'http', 'snmp'];
  const parentChoices = others.filter((x) => !below.has(x.id)).sort((a, b) => (REACH.includes(b.type) - REACH.includes(a.type)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parentSel = select('parent_id', [['', t('mon.f.parentNone')], ...parentChoices.map((x) => [String(x.id), `${x.name} · ${t(`mon.type.${x.type}`)}`])], v.parent_id ? String(v.parent_id) : '');
  const parentBox = field(t('mon.f.parent'), parentSel, t('mon.f.parentHint'));
  const chanBox = chans.length ? h('div', { class: 'full field' }, t('mon.f.channels'),
    h('div', { class: 'chips' }, chans.map((c) => h('label', { class: 'check', style: { marginRight: '14px' } },
      h('input', { type: 'checkbox', name: `ch_${c.id}`, checked: selected.size ? selected.has(c.id) : false }), `${c.name}${c.is_default ? ` (${t('mon.f.default')})` : ''}`))),
    h('span', { class: 'hint' }, t('mon.f.channelsHint')))
    : h('p', { class: 'full muted small' }, state.user.isAdmin ? t('mon.f.noChannelsAdmin') : t('mon.f.noChannels'));
  // Escalation: still down after X minutes → also to these channels. Empty = the setting for all monitors
  const escDefault = state.meta?.escalateMin ? t('mon.f.escDefaultOn', { n: state.meta.escalateMin }) : t('mon.f.escDefaultOff');
  const escMin = v.escalate_min === null || v.escalate_min === undefined ? '' : String(v.escalate_min);
  const ESC_STEPS = [15, 30, 60, 120, 240, 480];
  const escSel = select('escalate_min', [['', escDefault], ['0', t('mon.f.escOff')],
    ...[...new Set([...ESC_STEPS, ...(escMin && escMin !== '0' ? [Number(escMin)] : [])])].sort((a, b) => a - b).map((n) => [String(n), t('mon.f.escAfter', { n })])], escMin);
  const escSelected = new Set(v.escalate_channels || []);
  const escChans = h('div', { class: 'chips' }, chans.map((c) => h('label', { class: 'check', style: { marginRight: '14px' } },
    h('input', { type: 'checkbox', name: `esc_${c.id}`, checked: escSelected.has(c.id) }), c.name)));
  const escBox = h('div', { class: 'full field' }, t('mon.f.escalate'),
    h('div', { class: 'esc-row' }, escSel),
    chans.length ? [escChans, h('span', { class: 'hint' }, t('mon.f.escHint'))] : null);
  const form = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'full' }, field(t('mon.f.name'), nameIn)),
    field(t('mon.f.type'), typeSel, offerScript ? t('mon.f.typeScript') : null),
    targetWrap,
    portBox,
    sensorBox,
    pxBox,
    snmpBox,
    condBox,
    dockerBox,
    dbBox,
    smbBox,
    chanBox,
    parentBox,
    // Rarely changed: how often, when to alarm, HTTP details - folded away with sensible defaults
    h('details', { class: 'adv full', open: !!m && ((m.type === 'http' && (m.http_keyword || m.http_status !== '200-399')) || (m.escalate_min !== null && m.escalate_min !== undefined)) },
      h('summary', {}, t('mon.f.advanced')),
      h('div', { class: 'form-grid' },
        field(t('mon.f.interval'), input('interval_s', v.interval_s, { type: 'number', min: 20, max: 86400 }), t('mon.f.intervalHint')),
        field(t('mon.f.retries'), input('fail_threshold', v.fail_threshold, { type: 'number', min: 1, max: 10 }), t('mon.f.retriesHint')),
        field(t('mon.f.timeout'), input('timeout_s', v.timeout_s, { type: 'number', min: 1, max: 60 })),
        field(t('mon.f.resend'), input('resend_min', v.resend_min, { type: 'number', min: 0, max: 1440 }), t('mon.f.resendHint')),
        escBox,
        httpBox)));
  sync();
  const dlg = modal(m ? m.name : t('mon.add'), form, { wide: true, actions: [
    btn(t('cancel'), { onclick: () => dlg.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save() }, t('save')),
  ] });
  async function save() {
    if (!form.reportValidity()) return;
    const d = formData(form);
    const body = { name: d.name, type: d.type, target: d.target.trim(), port: d.port, interval_s: d.interval_s, timeout_s: d.timeout_s,
      fail_threshold: d.fail_threshold, resend_min: d.resend_min, http_status: d.http_status, http_keyword: d.http_keyword,
      tls_verify: d.tls_verify, cert_check: d.cert_check, cert_days: d.cert_days,
      channels: chans.filter((c) => d[`ch_${c.id}`]).map((c) => c.id), parent_id: d.parent_id ? Number(d.parent_id) : null,
      escalate_min: d.escalate_min ?? '', escalate_channels: chans.filter((c) => d[`esc_${c.id}`]).map((c) => c.id) };
    // An address typed as URL for a host check ("https://nas:5001" with ping) only needs the host
    if (!['http', 'docker', 'smb'].includes(d.type) && /^[a-z][a-z0-9+.-]*:\/\//i.test(body.target)) body.target = splitAddress(body.target).host;
    if (d.type === 'docker') body.docker_host_id = d.docker_host_id;
    if (d.type === 'sensor') {
      const x = metrics.find((y) => `${y.metric}|${y.key}` === d.metric);
      if (!x && !m) { toast(t('err.sensorMetric'), 'error'); return; }
      const [metric, key] = (d.metric || `${so.metric}|${so.key || ''}`).split('|');
      body.device_id = Number(d.device_id || v.device_id);
      body.target = '';
      body.options = { metric, key, op: d.op, threshold: d.threshold, label: x ? sensorLabel(x) : so.label };
    }
    if (d.type === 'proxmox') {
      const x = pxMetrics.find((y) => `${y.metric}|${y.key}` === d.px_metric);
      if (!x && !m) { toast(t('err.sensorMetric'), 'error'); return; }
      const [metric, key] = (d.px_metric || `${so.metric}|${so.key || ''}`).split('|');
      body.target = '';
      body.options = { host: Number(d.px_host), metric, key, op: d.op, threshold: d.threshold, label: x ? pxLabel(x) : so.label };
    }
    if (d.type === 'snmp') body.options = { oid: d.oid.trim(), op: d.op, threshold: d.threshold, label: '' };
    if (d.type === 'smb') {
      const u = parseUnc(d.target);
      if (u) { body.target = u.host; d.smb_share = d.smb_share || u.share; d.smb_path = d.smb_path || u.path; }
      body.options = { share: d.smb_share.trim(), path: d.smb_path.trim(), user: d.smb_user.trim(), domain: d.smb_domain.trim(),
        minFreePct: d.smb_min_pct || 0, minFreeGb: d.smb_min_gb || 0 };
      if (d.smb_password) body.password = d.smb_password;
    }
    if (DBT.includes(d.type)) {
      body.options = { user: d.db_user, database: d.database, tls: d.db_tls };
      if (d.password) body.password = d.password;
    }
    if (!m && preset?.device_id) body.device_id = preset.device_id;
    try {
      const r = m ? await put(`/monitors/${m.id}`, body) : await post('/monitors', body);
      dlg.close();
      toast(t('saved'));
      if (done) done(r); else navigate(`/monitoring/${r.id}`);
    } catch (e) { fail(e); }
  }
}

// ------------------------------------------------------------------------------------------- maintenance windows
const DAYS = [1, 2, 3, 4, 5, 6, 0];

async function renderMaintenance(main) {
  const edit = state.user.canEdit;
  const [list, monitors] = await Promise.all([get('/maintenance'), get('/monitors')]);
  const reload = () => renderMaintenance(main);
  const names = Object.fromEntries(monitors.map((m) => [m.id, m.name]));
  const when = (w) => (w.kind === 'once'
    ? `${fmtDate(w.starts_at, getLang())} - ${fmtDate(w.ends_at, getLang())}`
    : `${w.weekdays.slice().sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).map((d) => t(`day.${d}`)).join(', ')} · ${w.time_from}–${w.time_to}`);
  mount(main, h('div', { class: 'page' },
    pageHead(t('mon.title'), t('maint.lead'), edit ? btn(t('maint.add'), { class: 'btn btn-primary', onclick: () => maintenanceForm(null, monitors, reload) }, 'plus') : null),
    tabBar('maintenance'),
    h('section', { class: 'panel' }, list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('maint.name')), h('th', {}, t('maint.when')), h('th', {}, t('maint.scope')), h('th', {}))),
      h('tbody', {}, list.map((w) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, w.name), w.enabled ? null : h('span', { class: 'badge', style: { marginLeft: '6px' } }, t('mon.status.paused'))),
        h('td', {}, when(w)),
        h('td', {}, w.monitor_ids.length ? w.monitor_ids.map((i) => names[i] || `#${i}`).join(', ') : t('maint.all')),
        h('td', { class: 'min' }, edit ? h('div', { class: 'actions' },
          btn(t('edit'), { class: 'btn btn-sm', onclick: () => maintenanceForm(w, monitors, reload) }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${w.name}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('maint.deleteConfirm', { name: w.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/maintenance/${w.id}`); reload(); } catch (e) { fail(e); }
          } })) : null))))))
      : h('div', { class: 'empty' }, h('p', {}, t('maint.empty'))))));
}

const localInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function maintenanceForm(w, monitors, done) {
  const v = w || { kind: 'weekly', weekdays: [0], time_from: '22:00', time_to: '02:00', monitor_ids: [], enabled: true };
  const kind = select('kind', [['weekly', t('maint.weekly')], ['once', t('maint.once')]], v.kind);
  const onceBox = h('div', { class: 'form-grid full' },
    field(t('maint.from'), input('starts_at', localInput(v.starts_at), { type: 'datetime-local' })),
    field(t('maint.to'), input('ends_at', localInput(v.ends_at), { type: 'datetime-local' })));
  const weeklyBox = h('div', { class: 'form-grid full' },
    h('div', { class: 'full field' }, t('maint.days'), h('div', { class: 'chips' }, DAYS.map((d) => h('label', { class: 'check', style: { marginRight: '12px' } },
      h('input', { type: 'checkbox', name: `d_${d}`, checked: v.weekdays.includes(d) }), t(`day.${d}`))))),
    field(t('maint.timeFrom'), input('time_from', v.time_from || '', { type: 'time' })),
    field(t('maint.timeTo'), input('time_to', v.time_to || '', { type: 'time' }), t('maint.midnight')));
  const sync = () => { onceBox.hidden = kind.value !== 'once'; weeklyBox.hidden = kind.value !== 'weekly'; };
  kind.addEventListener('change', sync);
  const form = h('form', { class: 'form-grid' },
    h('div', { class: 'full' }, field(t('maint.name'), input('name', v.name || '', { required: true, maxlength: 80, placeholder: t('maint.namePh') }))),
    field(t('maint.kind'), kind),
    field(t('user.active'), h('input', { type: 'checkbox', name: 'enabled', checked: v.enabled !== false })),
    onceBox, weeklyBox,
    monitors.length ? h('div', { class: 'full field' }, t('maint.scope'),
      h('div', { class: 'chips' }, monitors.map((m) => h('label', { class: 'check', style: { marginRight: '12px' } },
        h('input', { type: 'checkbox', name: `m_${m.id}`, checked: v.monitor_ids.includes(m.id) }), m.name))),
      h('span', { class: 'hint' }, t('maint.scopeHint'))) : null);
  sync();
  const dlg = modal(w ? w.name : t('maint.add'), form, { wide: true, actions: [
    btn(t('cancel'), { onclick: () => dlg.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
      if (!form.reportValidity()) return;
      const d = formData(form);
      const body = { name: d.name, kind: d.kind, enabled: d.enabled,
        starts_at: d.starts_at ? new Date(d.starts_at).toISOString() : null, ends_at: d.ends_at ? new Date(d.ends_at).toISOString() : null,
        weekdays: DAYS.filter((x) => d[`d_${x}`]), time_from: d.time_from, time_to: d.time_to,
        monitor_ids: monitors.filter((m) => d[`m_${m.id}`]).map((m) => m.id) };
      try { if (w) await put(`/maintenance/${w.id}`, body); else await post('/maintenance', body); dlg.close(); toast(t('saved')); done(); } catch (e) { fail(e); }
    } }, t('save')),
  ] });
}
