// The chart on the page of a monitor or sensor: line (response time or measured value), outages as shaded periods
// with start, end and length, the alarm limit of a sensor, and a crosshair that tells time and value under the pointer.
// Below: the outages of the shown range as a list - pointing at one highlights it in the chart and the other way round.
import { h } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { checkText } from '../checktext.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const loc = () => (getLang() === 'en' ? 'en-GB' : 'de-DE');
const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
let uid = 0;

const num = (v, digits = 1) => Number(v).toLocaleString(loc(), { maximumFractionDigits: digits });
const time = (ms) => new Date(ms).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
const dayShort = (ms) => new Date(ms).toLocaleDateString(loc(), { weekday: 'short', day: '2-digit', month: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
/** "Sa 14.11. 14:02" - the day only where it is not today */
const when = (ms) => (sameDay(ms, Date.now()) ? time(ms) : `${dayShort(ms)} ${time(ms)}`);
/** "14:02 – 14:17", "Fr 13.11. 23:50 – Sa 14.11. 00:20" */
const fromTo = (a, b) => (b === null ? `${when(a)} – ${t('chart.ongoing')}` : sameDay(a, b) ? `${when(a)} – ${time(b)}` : `${when(a)} – ${when(b)}`);

/** "< 1 Min.", "15 Min.", "2 Std. 5 Min.", "3 Tage 4 Std." */
export function duration(ms) {
  const m = Math.round(ms / MIN);
  if (m < 1) return t('chart.dur.lt1');
  if (m < 60) return t('chart.dur.m', { m });
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return m % 60 ? t('chart.dur.hm', { h: hrs, m: m % 60 }) : t('chart.dur.h', { h: hrs });
  const d = Math.floor(hrs / 24);
  return hrs % 24 ? t('chart.dur.dh', { d, h: hrs % 24 }) : t('chart.dur.d', { d });
}

/**
 * Periods of failed checks: from the first failed check to the next good one (or "still").
 * checks: [{ at, ok, message }] oldest first. Returns [{ from, to (null = ongoing), n, message }].
 */
export function outagesFromChecks(checks) {
  const out = []; let cur = null;
  for (const c of checks) {
    const at = Date.parse(c.at);
    if (!c.ok) {
      if (!cur) cur = { from: at, to: null, n: 0, message: c.message || '', lo: null, hi: null };
      cur.n += 1;
      if (c.ms !== null && c.ms !== undefined) { cur.lo = cur.lo === null ? c.ms : Math.min(cur.lo, c.ms); cur.hi = cur.hi === null ? c.ms : Math.max(cur.hi, c.ms); }
    } else if (cur) { cur.to = at; out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Periods from the events (long ranges, where single checks are no longer kept): "down" (or "unreachable") until "up".
 * events: newest first, as the server sends them. Only periods that touch [start, end].
 */
export function outagesFromEvents(events, start, end, stillDown) {
  const out = []; let cur = null;
  for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id)) {
    const at = Date.parse(e.at);
    if ((e.kind === 'down' || e.kind === 'unreachable') && !cur) cur = { from: at, to: null, n: null, message: e.kind === 'down' ? e.message || '' : t('mon.status.unreachable'), unreachable: e.kind === 'unreachable' };
    else if (e.kind === 'up' && cur) { cur.to = at; out.push(cur); cur = null; }
  }
  if (cur && stillDown) out.push(cur);
  return out.filter((o) => (o.to ?? end) >= start && o.from <= end);
}

/** 1, 2, 2.5, 5 × 10^n just above raw */
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Value axis: about four lines; response times from 0, measured values around what was measured (and the limit) */
function valueAxis(lo, hi, fromZero) {
  if (fromZero || lo >= 0 && lo < (hi - lo) * 0.6) lo = Math.min(0, lo);
  if (hi === lo) { hi += Math.max(1, Math.abs(hi) * 0.1); lo -= fromZero ? 0 : Math.max(1, Math.abs(lo) * 0.1); }
  const step = niceStep((hi - lo) / 4);
  const a = Math.floor(lo / step) * step; const b = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo: a, hi: b, ticks };
}

/** Time axis: steps that fall on full hours, midnights or the first of a month, at most about seven */
function timeTicks(start, end, most = 7) {
  const span = end - start;
  const steps = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY];
  const step = steps.find((s) => span / s <= most);
  const out = [];
  if (!step) {
    // months
    const d = new Date(start); d.setDate(1); d.setHours(0, 0, 0, 0);
    const every = Math.ceil(span / (30 * DAY) / most);
    for (d.setMonth(d.getMonth() + 1); d.getTime() <= end; d.setMonth(d.getMonth() + every)) out.push({ at: d.getTime(), label: d.toLocaleDateString(loc(), { month: 'short', year: '2-digit' }) });
    return out;
  }
  const d = new Date(start);
  if (step < DAY) {
    d.setMinutes(Math.ceil(d.getMinutes() / (step >= HOUR ? 60 : step / MIN)) * (step >= HOUR ? 60 : step / MIN), 0, 0);
    const hs = step / HOUR;
    while (hs >= 1 && d.getHours() % hs) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= end; d.setTime(d.getTime() + step)) {
      const at = d.getTime();
      out.push({ at, label: d.getHours() === 0 && d.getMinutes() === 0 ? dayShort(at) : time(at), day: d.getHours() === 0 && d.getMinutes() === 0 });
    }
  } else {
    d.setHours(24, 0, 0, 0);
    for (; d.getTime() <= end; d.setDate(d.getDate() + step / DAY)) out.push({ at: d.getTime(), label: dayShort(d.getTime()), day: true });
  }
  return out;
}

/**
 * m: the monitor as /monitors/:id sends it. hours: shown range.
 * opts: { valueMode, unit } - sensors show their measured value with unit and their alarm limit.
 */
export function historyChart(m, hours, { valueMode = false } = {}) {
  const id = `c${++uid}`;
  // Phones get a narrower drawing, so text and lines stay readable when it is scaled down
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches;
  const W = narrow ? 420 : 760; const H = narrow ? 250 : 228; const L = 40; const R = 10; const T = 20; const B = 26;
  const long = !!m.history;
  const unit = valueMode ? (m.data?.unit || '') : 'ms';
  // "Temperatur: NVMe nvme0 Sensor 2: 73.3 °C" → "73,3 °C" (the label of the sensor is in the heading already)
  const label = m.options?.label || '';
  const reason = (msg) => {
    const s = checkText(msg || '', getLang());
    const l = label && s.startsWith(`${label}: `) ? label.length + 2 : s.indexOf(': ') + 2;
    return s.slice(Math.max(0, l));
  };
  const fmtV = (v) => (v === null || v === undefined ? '–' : `${num(v, valueMode ? 1 : 0)}${unit ? ` ${unit}` : ''}`);
  const svg = svgEl('svg', { class: 'mon-chart2', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': valueMode ? t('sens.chart') : t('mon.chart') });
  const wrap = h('div', { class: 'chart-wrap' });

  const pts = long ? m.history : m.checks;
  if (!pts.length) {
    const tx = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'muted-text' });
    tx.textContent = t('mon.noChecks');
    svg.append(tx);
    wrap.append(svg);
    return wrap;
  }

  // ------------------------------------------------------------------------------------------- range and data
  const end = Date.now();
  const size = long ? m.bucketHours * HOUR : 0;
  const firstAt = Date.parse(pts[0].at);
  // Young monitors start at their first check instead of showing an empty day
  const start = long ? Math.max(end - hours * HOUR, firstAt - size) : Math.max(end - hours * HOUR, Math.min(firstAt - MIN, end - 10 * MIN));
  const x = (ms) => L + ((ms - start) / (end - start)) * (W - L - R);
  const vals = long ? pts.filter((b) => b.avg !== null) : pts.filter((c) => c.ms !== null && (c.ok || valueMode));
  const lows = long ? vals.map((b) => b.min ?? b.avg) : vals.map((c) => c.ms);
  const highs = long ? vals.map((b) => b.max ?? b.avg) : vals.map((c) => c.ms);
  const thr = valueMode && m.data && m.data.threshold !== '' && Number.isFinite(Number(m.data.threshold)) ? Number(m.data.threshold) : null;
  const ax = valueAxis(Math.min(...lows, ...(thr !== null ? [thr] : []), valueMode ? Infinity : 0), Math.max(...highs, ...(thr !== null ? [thr] : []), valueMode ? -Infinity : 10), !valueMode);
  if (!Number.isFinite(ax.lo)) { ax.lo = 0; ax.hi = 1; ax.ticks = [0, 1]; }
  const y = (v) => T + (1 - (v - ax.lo) / (ax.hi - ax.lo || 1)) * (H - T - B);
  const outages = long ? outagesFromEvents(m.events || [], start, end, m.status === 'down' || m.status === 'unreachable') : outagesFromChecks(pts);

  // ------------------------------------------------------------------------------------------------- drawing
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: `${id}g`, x1: 0, x2: 0, y1: 0, y2: 1 });
  grad.append(svgEl('stop', { offset: '0%', class: 'area-top' }), svgEl('stop', { offset: '100%', class: 'area-bottom' }));
  const clip = svgEl('clipPath', { id: `${id}c` });
  clip.append(svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B }));
  defs.append(grad, clip);
  svg.append(defs);

  for (const v of ax.ticks) {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === ax.lo ? 'base' : 'grid' }));
    const lab = svgEl('text', { x: L - 6, y: y(v) + 3, class: 'axis', 'text-anchor': 'end' });
    lab.textContent = num(v, 1);
    svg.append(lab);
  }
  if (unit) { const u = svgEl('text', { x: L - 6, y: 9, class: 'axis unit', 'text-anchor': 'end' }); u.textContent = unit; svg.append(u); }
  for (const tk of timeTicks(start, end, narrow ? 4 : 7)) {
    if (x(tk.at) < L + 20 || x(tk.at) > W - R - 20) continue;
    svg.append(svgEl('line', { x1: x(tk.at), x2: x(tk.at), y1: T, y2: H - B, class: tk.day ? 'grid day' : 'grid v' }));
    const lab = svgEl('text', { x: x(tk.at), y: H - B + 15, class: `axis${tk.day ? ' strong' : ''}`, 'text-anchor': 'middle' });
    lab.textContent = tk.label;
    svg.append(lab);
  }

  // outage periods behind the line
  const bands = outages.map((o, i) => {
    const x1 = Math.max(L, x(o.from)); const x2 = Math.min(W - R, x(o.to ?? end));
    const g = svgEl('g', { class: `outage${o.unreachable ? ' unreach' : ''}`, 'data-i': i });
    g.append(svgEl('rect', { x: x1, y: T, width: Math.max(2, x2 - x1), height: H - T - B, class: 'fill' }),
      svgEl('rect', { x: x1, y: T, width: Math.max(2, x2 - x1), height: 3, class: 'cap' }));
    svg.append(g);
    return g;
  });

  const plot = svgEl('g', { 'clip-path': `url(#${id}c)` });
  svg.append(plot);
  if (thr !== null) {
    plot.append(svgEl('line', { x1: L, x2: W - R, y1: y(thr), y2: y(thr), class: 'limit' }));
    const lab = svgEl('text', { x: W - R - 4, y: y(thr) - 4, class: 'axis limit-text', 'text-anchor': 'end' });
    lab.textContent = t('chart.limit', { v: fmtV(thr) });
    svg.append(lab);
  }
  // runs of drawn points (broken where checks failed, the monitor was paused or buckets are missing)
  const runs = []; let cur = [];
  if (long) {
    for (const b of vals) {
      if (cur.length && Date.parse(b.at) - Date.parse(cur[cur.length - 1].at) > size) { runs.push(cur); cur = []; }
      cur.push({ at: Date.parse(b.at) + size / 2, v: b.avg, lo: b.min ?? b.avg, hi: b.max ?? b.avg });
    }
  } else {
    let prev = null;
    for (const c of pts) {
      const drawn = c.ms !== null && (c.ok || valueMode);
      const at = Date.parse(c.at);
      // a gap of more than three intervals: the monitor was paused or the program off
      if (!drawn || (prev !== null && at - prev > Math.max(3 * (m.interval_s || 60) * 1000, 15 * MIN))) { if (cur.length) runs.push(cur); cur = []; }
      if (drawn) cur.push({ at, v: c.ms });
      prev = at;
    }
  }
  if (cur.length) runs.push(cur);
  const P = (p, v) => `${x(p.at).toFixed(1)},${y(v).toFixed(1)}`;
  for (const r of runs) {
    if (long) plot.append(svgEl('path', { d: `M${r.map((p) => P(p, p.hi)).join('L')}L${r.slice().reverse().map((p) => P(p, p.lo)).join('L')}Z`, class: 'band' }));
    const line = r.length > 1 ? `M${r.map((p) => P(p, p.v)).join('L')}` : `M${x(r[0].at) - 1.5},${y(r[0].v)}h3`;
    if (!long && r.length > 1) plot.append(svgEl('path', { d: `${line}L${x(r[r.length - 1].at).toFixed(1)},${y(ax.lo)}L${x(r[0].at).toFixed(1)},${y(ax.lo)}Z`, fill: `url(#${id}g)`, class: 'area' }));
    plot.append(svgEl('path', { d: line, class: 'line' }));
  }
  // single failed checks: small marks on the base line (also where the band is too narrow to see)
  if (!long) for (const c of pts) if (!c.ok) plot.append(svgEl('circle', { cx: x(Date.parse(c.at)), cy: H - B, r: 2.6, class: 'fail' }));
  // long ranges: availability strip per bucket on the base line
  if (long) {
    const bw = Math.max(1, x(start + size) - x(start) - 0.6);
    for (const b of m.history) {
      const share = b.total ? b.ok / b.total : 1;
      plot.append(svgEl('rect', { x: x(Date.parse(b.at)), y: H - B - 5, width: bw, height: 5, class: share >= 0.999 ? 'avail' : share >= 0.95 ? 'avail warn' : 'avail bad' }));
    }
  }

  // ------------------------------------------------------------------------------------------------ pointer
  const cross = svgEl('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4, class: 'focus', visibility: 'hidden' });
  const hit = svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B, class: 'hit' });
  svg.append(cross, dot, hit);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const at = (cx) => start + ((cx - L) / (W - L - R)) * (end - start);
  const items = long ? m.history.map((b) => ({ ...b, t: Date.parse(b.at) + size / 2 })) : pts.map((c) => ({ ...c, t: Date.parse(c.at) }));
  const nearest = (ms) => {
    let lo = 0; let hi = items.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid].t < ms) lo = mid + 1; else hi = mid; }
    return lo > 0 && Math.abs(items[lo - 1].t - ms) < Math.abs(items[lo].t - ms) ? items[lo - 1] : items[lo];
  };
  const inOutage = (ms) => outages.findIndex((o) => ms >= o.from && ms <= (o.to ?? end));
  function show(ev) {
    const box = svg.getBoundingClientRect();
    const cx = ((ev.clientX - box.left) / box.width) * W;
    if (cx < L || cx > W - R) { hide(); return; }
    const ms = at(cx);
    const p = nearest(ms);
    const oi = inOutage(ms);
    highlight(oi);
    cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t)); cross.setAttribute('visibility', 'visible');
    const v = long ? p.avg : p.ms !== null && (p.ok || valueMode) ? p.ms : null;
    if (v !== null) { dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(v)); dot.setAttribute('visibility', 'visible'); dot.classList.toggle('bad', !long && !p.ok); } else dot.setAttribute('visibility', 'hidden');
    const rows = [];
    if (long) {
      const b0 = Date.parse(p.at);
      rows.push(h('b', {}, m.bucketHours >= 24 ? dayShort(b0) : `${dayShort(b0)} ${time(b0)}–${time(b0 + size)}`));
      if (p.avg !== null) rows.push(h('span', {}, `${t('mon.histAvg')} ${fmtV(p.avg)}`, p.min !== null && p.max !== null && p.min !== p.max ? h('span', { class: 'muted' }, ` (${fmtV(p.min)} – ${fmtV(p.max)})`) : null));
      const share = p.total ? p.ok / p.total : 1;
      rows.push(h('span', { class: share < 0.999 ? 'tone-bad' : '' }, t(valueMode ? 'chart.okShareValue' : 'chart.okShare', { pct: num(Math.floor(share * 1000) / 10, 1), bad: p.total - p.ok })));
    } else {
      rows.push(h('b', {}, `${when(p.t)}`));
      rows.push(p.ok ? h('span', {}, v !== null ? fmtV(v) : reason(p.message) || t('chart.ok'))
        : h('span', { class: 'tone-bad' }, valueMode && v !== null ? `${fmtV(v)} · ${t('chart.overLimit')}` : reason(p.message) || t('chart.failed')));
    }
    if (oi >= 0) {
      const o = outages[oi];
      rows.push(h('span', { class: 'tip-out' }, `${t(valueMode ? 'chart.alarm' : 'chart.outage')}: ${fromTo(o.from, o.to)} · ${duration((o.to ?? end) - o.from)}`));
    }
    tip.replaceChildren(...rows.map((r) => h('div', {}, r)));
    tip.hidden = false;
    // keep the box inside the chart: right of the pointer, left of it near the right edge
    const px = ((x(p.t)) / W) * box.width;
    const left = px + 14 + tip.offsetWidth > box.width ? px - 14 - tip.offsetWidth : px + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, ((ev.clientY - box.top) - tip.offsetHeight - 10))}px`;
  }
  function hide() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; highlight(-1); }
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  // on a touch screen the box stays until the next touch
  hit.addEventListener('pointerleave', (ev) => { if (ev.pointerType !== 'touch') hide(); });

  // ----------------------------------------------------------------------------------------- outages: list
  let rowEls = [];
  function highlight(i) {
    bands.forEach((g, k) => g.classList.toggle('hl', k === i));
    rowEls.forEach((r, k) => r.classList.toggle('hl', k === i));
  }
  const total = outages.reduce((s, o) => s + Math.min(o.to ?? end, end) - Math.max(o.from, start), 0);
  const longest = outages.reduce((s, o) => Math.max(s, (o.to ?? end) - o.from), 0);
  const word = valueMode ? 'alarm' : 'outage';
  const summary = h('div', { class: `chart-sum${outages.length ? ' bad' : ''}` },
    h('i'), outages.length
      ? h('span', {}, h('b', {}, t(`chart.${word}s`, { n: outages.length })), ` · ${t('chart.total', { d: duration(total) })}${outages.length > 1 ? ` · ${t('chart.longest', { d: duration(longest) })}` : ''}`)
      : h('span', {}, t(`chart.no.${word}`)));
  const shown = [...outages.keys()].reverse();
  // why: the reason of an outage; for a sensor the highest (or lowest) value during the alarm
  const low = ['le', 'lt'].includes(m.data?.op);
  const why = (o) => (valueMode && o.hi !== null && o.hi !== undefined ? t(low ? 'chart.lowest' : 'chart.highest', { v: fmtV(low ? o.lo : o.hi) }) : reason(o.message));
  const MAXROWS = 8;
  let list = null;
  if (outages.length) {
    const rows = shown.map((i) => {
      const o = outages[i];
      const tr = h('tr', { tabindex: 0, 'data-i': i,
        onmouseenter: () => highlight(i), onmouseleave: () => highlight(-1), onfocus: () => highlight(i), onblur: () => highlight(-1) },
      h('td', { class: 'nowrap' }, when(o.from)),
      h('td', { class: 'nowrap' }, o.to === null ? h('span', { class: 'tone-bad' }, t('chart.ongoing')) : sameDay(o.from, o.to) ? time(o.to) : when(o.to)),
      h('td', { class: 'nowrap' }, h('b', {}, duration((o.to ?? end) - o.from))),
      h('td', { class: 'muted' }, `${why(o)}${o.n > 1 ? ` · ${t(valueMode ? 'chart.checksAlarm' : 'chart.checksFailed', { n: o.n })}` : ''}`));
      return tr;
    });
    rowEls = new Array(outages.length);
    shown.forEach((i, k) => { rowEls[i] = rows[k]; });
    const more = rows.length > MAXROWS ? h('button', { type: 'button', class: 'link-btn small', onclick: (e) => { rows.forEach((r) => { r.hidden = false; }); e.currentTarget.remove(); } }, t('chart.showAll', { n: rows.length })) : null;
    rows.forEach((r, k) => { r.hidden = k >= MAXROWS; });
    list = h('div', { class: 'chart-list' },
      h('table', { class: 'data compact' },
        h('thead', {}, h('tr', {}, h('th', {}, t('chart.from')), h('th', {}, t('chart.to')), h('th', {}, t('chart.length')), h('th', {}, t('chart.reason')))),
        h('tbody', {}, rows)), more);
    // a click into an outage in the chart shows its row
    hit.addEventListener('click', (ev) => {
      const box = svg.getBoundingClientRect();
      const i = inOutage(at(((ev.clientX - box.left) / box.width) * W));
      if (i < 0 || !rowEls[i]) return;
      rowEls[i].hidden = false;
      rowEls[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      rowEls[i].focus({ preventScroll: true });
    });
  }

  wrap.append(svg, tip);
  return h('div', { class: 'chart-box' }, summary, wrap, list);
}
