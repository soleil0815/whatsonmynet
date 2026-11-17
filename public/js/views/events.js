// Messages devices sent by themselves (SNMP traps, syslog): the newest first, filtered and searched; one click turns a
// message into an event monitor. Admins switch the receivers on here.
import { h, mount, modal, toast, fmtDate } from '../dom.js';
import { get, put, post, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, fail, navigate } from '../app.js';
import { pageHead, field, input, select, btn, formData } from './common.js';
import { openMonitorForm } from './monitoring.js';
import { lockForEditing, isReadOnly } from './failover.js';
import { openRuleForm } from './eventrules.js';

export const SEV = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const sevTone = (s) => (s <= 3 ? 'bad' : s === 4 ? 'warn' : s === 5 ? '' : 'muted');
export const sevLabel = (s) => t(`ev.sev.${SEV[s]}`);
// what is kept: 7 everything … 2 critical and worse, -1 nothing
const keepOptions = () => [['7', t('ev.keep.all')], ['6', t('ev.keep.noDebug')], ['5', t('ev.keep.notice')], ['4', t('ev.keep.warning')], ['3', t('ev.keep.err')], ['2', t('ev.keep.crit')]];
const keepLabel = (n) => (n === -1 ? t('ev.keep.none') : (keepOptions().find(([v]) => Number(v) === n) || [])[1] || '');
const gb = (b) => (b < 1024 ** 3 ? `${Math.max(0.1, b / 1024 ** 2).toLocaleString(getLang(), { maximumFractionDigits: b < 10 * 1024 ** 2 ? 1 : 0 })} MB` : `${(b / 1024 ** 3).toLocaleString(getLang(), { maximumFractionDigits: 1 })} GB`);

// Long texts (Windows events reach 4000 characters): the start, the rest one click away
function longText(text) {
  const s = String(text ?? '');
  if (s.length <= 400) return h('span', { class: 'small' }, s);
  const rest = h('span', { hidden: true }, s.slice(400));
  const more = h('button', { type: 'button', class: 'btn-link small' }, ` … ${t('ev.textMore')}`);
  more.addEventListener('click', () => { rest.hidden = false; more.remove(); });
  return h('span', { class: 'small' }, s.slice(0, 400), rest, more);
}

// The time range (as in Splunk or Wazuh): the last minutes, hours or days, or a range of one's own - narrowed further by
// clicking or dragging over the bars of the timeline above the list
const RANGES = [['', 'ev.range.all'], ['15m', 'ev.range.15m'], ['1h', 'ev.range.1h'], ['24h', 'ev.range.24h'], ['7d', 'ev.range.7d'], ['30d', 'ev.range.30d'], ['custom', 'ev.range.custom']];
const RANGE_MS = { '15m': 900000, '1h': 3600000, '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; };
const locale = () => (getLang() === 'en' ? 'en-GB' : 'de-DE');
// "2026-11-16T14:05" for <input type=datetime-local> (local time) and back
const toLocalInput = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => { const ms = v ? new Date(v).getTime() : NaN; return Number.isFinite(ms) ? ms : null; };
/** "14:05", "Mo 16.11. 14:05" or "16.11.2026" - as much as the span needs */
function tick(ms, spanMs) {
  const d = new Date(ms);
  if (spanMs <= 86400000 && new Date().toDateString() === d.toDateString()) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (spanMs <= 14 * 86400000) return d.toLocaleString(locale(), { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}
const stepLabel = (s) => (s < 3600 ? t('ev.step.m', { n: s / 60 }) : s < 86400 ? t('ev.step.h', { n: s / 3600 }) : t('ev.step.d', { n: s / 86400 }));

export async function renderEvents(main) {
  if (!(state.user.canEditServer ?? state.user.canEdit)) { navigate('/', { replace: true }); return; }
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, body));
  const admin = state.user.isAdmin;
  let kind = ''; let maxSeverity = 7; let rows = []; let info = null;
  // By sender (default: one row per computer or device - all messages at once would flood the page) or all messages;
  // a sender picked shows only its messages. ?from=<address> opens one sender directly (link from the device page).
  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };
  let view = 'senders';
  try { view = localStorage.getItem('ev.view') === 'all' ? 'all' : 'senders'; } catch { /* default */ }
  if (new URLSearchParams(location.search).get('view') === 'open') view = 'open';
  let openList = []; let showClosed = false;
  let source = null; // { ip, label }
  const fromUrl = new URLSearchParams(location.search).get('from');
  if (fromUrl) source = { ip: fromUrl, label: fromUrl };
  let senders = [];
  // the overview by sender, a page at a time: quick filter, type of device, order; how many there are
  const senderOpt = { show: '', type: '', sort: 'last' };
  try { const o = localStorage.getItem('ev.senderSort'); if (['last', 'day', 'name'].includes(o)) senderOpt.sort = o; } catch { /* default */ }
  let senderInfo = { total: 0, all: 0, counts: {}, types: [] };
  const SENDER_PAGE = 100;
  // the time range: a preset (remembered) or a range of one's own; zooming in keeps the way back
  let range = '';
  try { range = RANGES.some(([v]) => v && v !== 'custom' && v === localStorage.getItem('ev.range')) ? localStorage.getItem('ev.range') : ''; } catch { /* default */ }
  let custom = { from: null, to: null }; // ms
  const back = []; // earlier ranges, newest last
  let hist = null; let dragging = false;
  // parts of words (e.g. "006A" of 0xC000006A): only on request - every message in the range is read then
  let part = false;
  const q = h('input', { type: 'search', placeholder: t('ev.search'), 'aria-label': t('ev.search'), title: t('ev.searchHint') });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('ev.view') });
  const sourceChip = h('div');
  const setView = (v) => { view = v; source = null; if (v !== 'open') remember('ev.view', v); q.value = ''; history.replaceState(null, '', v === 'open' ? '/events?view=open' : '/events'); load(); };
  const pick = (s) => { source = { ip: s.source_ip, label: s.device_name || s.host || s.source_ip }; q.value = ''; history.replaceState(null, '', `/events?from=${encodeURIComponent(s.source_ip)}`); load(); };
  const sevSel = h('select', { 'aria-label': t('ev.severity') }, [[7, t('ev.f.all')], [4, t('ev.f.warning')], [3, t('ev.f.err')], [2, t('ev.f.crit')]].map(([v, l]) => h('option', { value: String(v) }, l)));
  const chips = h('div', { class: 'inv-chips', role: 'group' });
  const statusBox = h('div');
  const spaceBox = h('div');
  const listBox = h('div');
  const more = h('div', { class: 'actions', style: { justifyContent: 'center' } });
  const rangeSel = h('select', { 'aria-label': t('ev.range') }, RANGES.map(([v, k]) => h('option', { value: v }, t(k))));
  rangeSel.value = range;
  const fromIn = h('input', { type: 'datetime-local', 'aria-label': t('ev.rangeFrom') });
  const toIn = h('input', { type: 'datetime-local', 'aria-label': t('ev.rangeTo') });
  const customBox = h('div', { class: 'ev-custom', hidden: true }, h('label', {}, h('span', { class: 'small muted' }, t('ev.rangeFrom')), fromIn), h('label', {}, h('span', { class: 'small muted' }, t('ev.rangeTo')), toIn));
  const histBox = h('div');
  // Saved searches: search, severity, kind and time range under a name - one click instead of typing it again
  const savedList = h('div', { class: 'menu-list ev-saved-list' });
  const savedMenu = h('details', { class: 'menu ev-saved' }, h('summary', { class: 'btn', title: t('ev.savedHint') }, h('span', { html: icon('history') }), t('ev.saved')), savedList);
  savedMenu.addEventListener('toggle', () => { if (savedMenu.open) drawSaved(); });
  document.addEventListener('click', (e) => { if (savedMenu.open && !savedMenu.contains(e.target)) savedMenu.open = false; });
  /** from and to (ISO) for the server: a preset counts back from now, so new messages keep coming in */
  const rangeNow = () => {
    if (range === 'custom') return { from: custom.from === null ? null : new Date(custom.from).toISOString(), to: custom.to === null ? null : new Date(custom.to).toISOString() };
    return RANGE_MS[range] ? { from: new Date(Date.now() - RANGE_MS[range]).toISOString(), to: null } : { from: null, to: null };
  };
  const setRange = (r, c = custom, { remember: keep = true } = {}) => {
    if (keep) back.push({ range, custom, q: q.value });
    if (back.length > 20) back.shift();
    range = r; custom = c;
    if (r !== 'custom') remember('ev.range', r);
    rangeSel.value = r;
    load();
  };
  const zoom = (fromMs, toMs) => setRange('custom', { from: fromMs, to: toMs });

  async function load(append = false) {
    if (view === 'open') {
      try {
        const [r, s] = await Promise.all([get(`/events/open${showClosed ? '?all=1' : ''}`), info ? null : get('/events/senders')]);
        if (s) info = s;
        info = { ...info, openEvents: r.open };
        openList = r.list;
        if (!body.isConnected) return;
        draw(false);
      } catch (e) { fail(e); }
      return;
    }
    if (view === 'senders' && !source) {
      try {
        // "more" adds the next page; a refresh keeps as many rows as are shown (up to 500)
        const limit = append ? SENDER_PAGE : Math.min(500, Math.max(SENDER_PAGE, senders.length));
        const r = await get(`/events/senders?${new URLSearchParams({ q: q.value.trim(), ...senderOpt, offset: String(append ? senders.length : 0), limit: String(limit) })}`);
        info = r; senders = append ? [...senders, ...r.senders] : r.senders;
        senderInfo = { total: r.total ?? r.senders.length, all: r.all ?? r.senders.length, counts: r.counts || {}, types: r.types || [] };
        if (!body.isConnected) return;
        draw(false);
      } catch (e) { fail(e); }
      return;
    }
    const p = new URLSearchParams({ q: q.value.trim(), kind, maxSeverity: String(maxSeverity) });
    if (part && q.value.trim()) p.set('part', '1');
    if (source) p.set('source', source.ip);
    const { from, to } = rangeNow();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const lp = new URLSearchParams(p); lp.set('limit', '200');
    if (append && rows.length) lp.set('before', String(rows[rows.length - 1].id));
    try {
      // the bars come with the first page of the list; more of the list leaves them as they are
      const [r, hg] = await Promise.all([get(`/events?${lp}`), append ? null : get(`/events/histogram?${p}`)]);
      if (hg) hist = hg;
      info = r;
      rows = append ? [...rows, ...r.list] : r.list;
      if (!body.isConnected) return;
      draw(r.list.length === 200);
    } catch (e) { fail(e); }
  }
  function draw(hasMore) {
    const s = info.status; const cfg = info.settings;
    const off = !s.traps.on && !s.syslog.on && !s.syslogTcp?.on && !s.syslogTls?.on;
    const recv = (on, label, port, err) => h('span', { class: `badge ${on ? 'badge-ok' : err ? 'badge-bad' : ''}`, title: err || '' }, `${label} ${on ? t(/Syslog/.test(label) ? 'ev.onTcp' : 'ev.onPort', { port }) : err ? t('ev.error') : t('ev.off')}`);
    const errs = [s.traps.error, s.syslog.error, s.syslogTcp?.error, s.syslogTls?.error].filter(Boolean);
    mount(statusBox, off && !errs.length
      ? h('div', { class: 'note' }, h('div', {}, h('strong', {}, t('ev.offTitle')), h('p', { style: { margin: '4px 0 8px' } }, t('ev.offText')),
        admin ? btn(t('ev.switchOn'), { class: 'btn btn-sm btn-primary', onclick: () => settingsDialog(cfg) }, 'bell') : h('span', { class: 'muted small' }, t('ev.askAdmin'))))
      : h('div', { class: 'actions', style: { justifyContent: 'flex-start', flexWrap: 'wrap', gap: '8px' } },
        recv(s.traps.on, 'SNMP-Traps', cfg.trapPort, s.traps.error), recv(s.syslog.on, 'Syslog UDP', cfg.syslogPort, s.syslog.error),
        cfg.syslogTcp || s.syslogTcp?.error ? recv(s.syslogTcp.on, 'Syslog TCP', `${cfg.syslogTcpPort}`, s.syslogTcp.error) : null,
        cfg.syslogTls || s.syslogTls?.error ? recv(s.syslogTls.on, 'Syslog TLS', `${cfg.syslogTlsPort}`, s.syslogTls.error) : null,
        h('span', { class: 'muted small' }, t('ev.total', { n: s.total })),
        s.searchIndex?.building ? h('span', { class: 'muted small', title: t('ev.indexHint') }, t('ev.indexBuilding', { pct: Math.floor(s.searchIndex.share * 100) })) : null,
        s.filtered ? h('span', { class: 'muted small', title: t('ev.filteredHint') }, t('ev.filtered', { n: s.filtered.toLocaleString(getLang()) })) : null,
        s.flooded ? h('span', { class: 'small warn-text', title: t('ev.floodedHint', { max: (s.perSecond || 3000).toLocaleString(getLang()) }) }, t('ev.flooded', { n: s.flooded.toLocaleString(getLang()) })) : null,
        s.storage ? h('span', { class: 'muted small' }, t(s.storage.short ? (s.storage.daysFit < 1 ? 'ev.space0' : 'ev.space') : 'ev.spaceOk', { used: gb(s.storage.used), limit: gb(s.storage.cap),
          day: s.storage.perDay.toLocaleString(getLang()), days: s.storage.daysFit, keep: s.storage.keepDays })) : null,
        errs.map((e) => h('span', { class: 'small bad-text' }, e))));
    // the space does not reach for the days set: say so, and who fills it
    const st = s.storage;
    mount(spaceBox, st && (st.short || st.diskShort) ? h('div', { class: 'note' }, h('div', { style: { minWidth: 0 } },
      h('strong', {}, st.short ? t(st.daysFit < 1 ? 'ev.shortTitle0' : 'ev.shortTitle', { days: st.daysFit, keep: st.keepDays }) : t('ev.diskTitle')),
      h('p', { style: { margin: '4px 0 0' } }, [st.diskShort ? t('ev.diskText', { limit: gb(st.limit), cap: gb(st.cap) }) : '',
        st.topSenders.length || st.topEvents.length ? t('ev.shortWho', { list: [...st.topSenders.map((x) => `${x.name} (${x.share} %)`), ...st.topEvents.map((x) => `${t('ev.eventId', { id: x.name })} (${x.share} %)`)].join(', ') }) : '',
        st.short ? t('ev.shortHelp') : ''].filter(Boolean).join(' ')))) : null);
    const chip = (key, label) => h('button', { type: 'button', class: `fchip${kind === key ? ' on' : ''}`, 'aria-pressed': String(kind === key), onclick: () => { kind = key; load(); } }, label);
    const bySender = view === 'senders' && !source;
    const openN = info?.openEvents || 0;
    mount(seg, ...[['senders', t('ev.bySender')], ['all', t('ev.allMessages')], ['open', openN ? t('ev.openN', { n: openN }) : t('ev.openView')]].map(([v, l]) => h('button', { type: 'button',
      class: (v === 'senders' ? view === 'senders' || (source && view !== 'open') : v === 'all' ? view === 'all' && !source : view === 'open') ? 'on' : '',
      'aria-pressed': String(v === view), onclick: () => setView(v) }, l)));
    if (view === 'open') {
      mount(chips, h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: showClosed, onchange: (e) => { showClosed = e.currentTarget.checked; load(); } }), t('ev.showClosed')));
      sevSel.hidden = true; q.hidden = true; q.parentElement.hidden = true; rangeSel.hidden = true; customBox.hidden = true; savedMenu.hidden = true;
      mount(histBox, null);
      mount(sourceChip, null);
      const stateBadge = (o) => (o.state === 'open' ? h('span', { class: 'badge badge-bad' }, t('ev.st.open')) : o.state === 'ack' ? h('span', { class: 'badge badge-warn' }, t('ev.st.ack'))
        : h('span', { class: 'badge' }, t(`ev.closed.${o.closed_how || 'user'}`)));
      mount(listBox, openList.length ? h('div', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-table' },
        h('thead', {}, h('tr', {}, h('th', {}, t('ev.openWhat')), h('th', {}, t('ev.from')), h('th', {}, t('ev.since')), h('th', {}, t('ev.lastMessage')), h('th', {}))),
        h('tbody', {}, openList.map((o) => h('tr', {},
          h('td', {}, h('span', { class: 'name' }, o.rule_name || '?'), o.key ? h('span', { class: 'muted' }, ` · ${o.key}`) : null, h('div', {}, stateBadge(o)),
            o.ack_by ? h('div', { class: 'sub' }, t('ev.ackBy', { who: o.ack_by, at: fmtDate(o.ack_at, getLang()) })) : null),
          h('td', {}, h('button', { type: 'button', class: 'ev-name-btn', onclick: () => { view = 'senders'; pick({ source_ip: o.source_ip, device_name: o.device_name, host: o.host }); } }, o.device_name || o.host || o.source_ip),
            h('div', { class: 'sub mono' }, o.source_ip)),
          h('td', { class: 'small nowrap' }, fmtDate(o.first_at, getLang()), h('div', { class: 'sub' }, t(o.count === 1 ? 'ev.dayCount1' : 'ev.dayCount', { n: o.count }))),
          h('td', { class: 'ev-text small' }, h('div', { class: 'muted nowrap' }, fmtDate(o.last_at, getLang())), String(o.last_text || '').slice(0, 200)),
          h('td', { class: 'min nowrap' }, isReadOnly() || o.state === 'closed' ? null : [
            o.state === 'open' ? btn(t('ev.ack'), { class: 'btn btn-sm', onclick: async () => { try { await post(`/events/open/${o.id}/ack`); load(); } catch (e) { fail(e); } } }, 'check') : null,
            btn(t('ev.close'), { class: 'btn btn-sm btn-ghost', onclick: async () => { try { await post(`/events/open/${o.id}/close`); toast(t('ev.closedToast')); load(); } catch (e) { fail(e); } } })])))))))
        : h('div', { class: 'panel panel-pad muted' }, t('ev.noOpen')));
      mount(more, null);
      lockForEditing(body);
      return;
    }
    q.hidden = false; q.parentElement.hidden = false;
    mount(chips, bySender ? senderControls() : [chip('', t('all')), chip('trap', 'Traps'), chip('syslog', 'Syslog')]);
    sevSel.hidden = bySender; savedMenu.hidden = false;
    // the overview by sender counts the last 24 hours; the range is for the messages themselves
    rangeSel.hidden = bySender; customBox.hidden = bySender || range !== 'custom';
    if (range === 'custom') { fromIn.value = custom.from === null ? '' : toLocalInput(custom.from); toIn.value = custom.to === null ? '' : toLocalInput(custom.to); }
    mount(histBox, bySender ? null : drawHist());
    q.placeholder = bySender ? t('ev.searchSenders') : t('ev.search');
    mount(sourceChip, source ? h('div', { class: 'actions', style: { justifyContent: 'flex-start', gap: '8px' } },
      h('span', {}, t('ev.onlyFrom')), h('strong', {}, source.label), source.label !== source.ip ? h('span', { class: 'muted mono small' }, source.ip) : null,
      btn(t('ev.allSenders'), { class: 'btn btn-sm', onclick: () => { source = null; view = 'senders'; history.replaceState(null, '', '/events'); load(); } })) : null);
    if (bySender) {
      mount(listBox, senders.length ? h('div', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-table' },
        h('thead', {}, h('tr', {}, h('th', {}, t('ev.from')), h('th', {}, t('ev.lastMessage')), h('th', { class: 'nowrap' }, t('ev.last24')), h('th', {}))),
        h('tbody', {}, senders.map((s) => h('tr', {},
          h('td', {}, h('button', { type: 'button', class: 'ev-name-btn', onclick: () => pick(s) }, s.device_name || s.host || s.source_ip),
            h('div', { class: 'sub mono' }, [s.source_ip, s.host && s.host !== s.device_name ? s.host : ''].filter(Boolean).join(' · ')),
            s.filter !== null && s.filter !== undefined ? h('div', {}, h('span', { class: `badge${s.filter === -1 ? ' badge-warn' : ''}`, title: t('ev.filterHint') }, s.filter === -1 ? t('ev.muted') : t('ev.keepsFrom', { what: keepLabel(s.filter) }))) : null,
            s.dropped ? h('div', { class: 'sub' }, t('ev.droppedSince', { n: s.dropped.toLocaleString(getLang()) })) : null),
          h('td', { class: 'ev-text' }, h('div', { class: 'small' }, h('span', { class: 'nowrap muted' }, s.last_at ? `${fmtDate(s.last_at, getLang())} ` : `${t('ev.nothingKept')} `),
            s.last_severity !== null ? h('span', { class: `badge ${sevTone(s.last_severity) === 'muted' ? '' : `badge-${sevTone(s.last_severity)}`}` }, sevLabel(s.last_severity)) : null),
            h('div', { class: 'small' }, s.last_event_id !== null && s.last_event_id !== undefined ? `${t('ev.eventId', { id: s.last_event_id })}: ` : s.last_app ? `${s.last_app}: ` : '',
              String(s.last_text || '').length > 160 ? `${String(s.last_text).slice(0, 159)}…` : s.last_text || '')),
          h('td', { class: 'nowrap small' }, t(s.day === 1 ? 'ev.dayCount1' : 'ev.dayCount', { n: s.day }),
            s.err ? h('div', {}, h('span', { class: 'badge badge-bad' }, t(s.err === 1 ? 'ev.errCount1' : 'ev.errCount', { n: s.err }))) : null,
            s.warn - s.err > 0 ? h('div', {}, h('span', { class: 'badge badge-warn' }, t(s.warn - s.err === 1 ? 'ev.warnCount1' : 'ev.warnCount', { n: s.warn - s.err }))) : null),
          h('td', { class: 'min nowrap' }, btn(t('ev.showMessages'), { class: 'btn btn-sm btn-ghost', onclick: () => pick(s) }, 'inventory'),
            admin && !isReadOnly() ? btn(t('ev.filter'), { class: 'btn btn-sm btn-ghost', title: t('ev.filterHint'), onclick: () => senderFilter(s) }, 'settings') : null)))))))
        : h('div', { class: 'panel panel-pad muted' }, off ? t('ev.noneOff') : q.value || senderOpt.show || senderOpt.type ? t('ev.noSender') : t('ev.none')));
      const n = (x) => x.toLocaleString(getLang());
      mount(more, senderInfo.total > SENDER_PAGE || senders.length < senderInfo.total ? [
        h('span', { class: 'muted small' }, t('ev.sendersShown', { n: n(senders.length), total: n(senderInfo.total) })),
        senders.length < senderInfo.total ? btn(t('ev.sendersMore', { n: n(Math.min(SENDER_PAGE, senderInfo.total - senders.length)) }), { class: 'btn btn-sm', onclick: () => load(true) }) : null] : null);
      lockForEditing(body);
      return;
    }
    mount(listBox, rows.length ? h('div', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-table' },
      h('thead', {}, h('tr', {}, h('th', {}, t('ev.when')), source ? null : h('th', {}, t('ev.from')), h('th', {}, t('ev.severity')), h('th', {}, t('ev.text')), h('th', {}))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap small' }, h('button', { type: 'button', class: 'btn-link ev-when', title: t('ev.aroundHint'),
          onclick: () => { const at = Date.parse(r.at); back.push({ range, custom, q: q.value }); q.value = ''; setRange('custom', { from: at - 5 * 60000, to: at + 5 * 60000 + 1000 }, { remember: false }); } }, fmtDate(r.at, getLang()))),
        source ? null : h('td', {}, r.device_id ? h('a', { class: 'name', href: `/devices/${r.device_id}`, 'data-link': true }, r.device_name || r.source_ip) : h('span', { class: 'name mono' }, r.source_ip),
          h('div', { class: 'sub mono' }, [r.device_id ? r.source_ip : '', r.host && r.host !== r.device_name ? r.host : ''].filter(Boolean).join(' · ') || null)),
        h('td', {}, h('span', { class: `badge ${sevTone(r.severity) === 'muted' ? '' : `badge-${sevTone(r.severity)}`}` }, sevLabel(r.severity)),
          h('div', { class: 'sub' }, r.kind === 'trap' ? 'Trap' : 'Syslog')),
        h('td', { class: 'ev-text' }, r.summary ? h('div', { class: 'small ev-summary' }, r.summary) : null,
          r.app && r.event_id === null ? h('strong', { class: 'small' }, `${r.app}: `) : null, longText(r.text),
          r.oid && r.kind === 'trap' && !r.app ? h('div', { class: 'sub mono' }, r.oid) : null,
          // Windows (NXLog): event id, log, source and account below the text, as in the event viewer
          r.event_id !== null && r.event_id !== undefined ? h('div', { class: 'sub' }, [t('ev.eventId', { id: r.event_id }), r.channel, r.event_id !== null && r.app ? r.app : '', r.account].filter(Boolean).join(' · ')) : null),
        h('td', { class: 'min nowrap' }, isReadOnly() ? null : [
          btn(t('ev.watch'), { class: 'btn btn-sm btn-ghost', title: t('ev.watchHint'), onclick: () => watch(r) }, 'pulse'),
          btn(t('ev.rule'), { class: 'btn btn-sm btn-ghost', title: t('ev.ruleHint'), onclick: () => ruleFrom(r) }, 'mail')])))))))
      : h('div', { class: 'panel panel-pad muted' }, off ? t('ev.noneOff') : q.value || kind || maxSeverity < 7 || range ? t('ev.noMatch') : t('ev.none'),
        // nothing as a word: offer parts of words
        q.value.trim() && !part ? h('div', { class: 'ev-part' }, t('ev.partOffer'), ' ', h('button', { type: 'button', class: 'btn-link', onclick: () => { part = true; load(); } }, t('ev.partTry'))) : null));
    if (q.value.trim() && part) listBox.prepend(h('div', { class: 'small muted ev-part' }, t('ev.partOn'), ' ', h('button', { type: 'button', class: 'btn-link', onclick: () => { part = false; load(); } }, t('ev.partOff'))));
    mount(more, hasMore ? btn(t('ev.more'), { class: 'btn btn-sm', onclick: () => load(true) }) : null);
    lockForEditing(body);
  }
  async function drawSaved() {
    const list = savedList;
    mount(list, h('span', { class: 'muted small', style: { padding: '8px 10px' } }, t('loading')));
    let saved = [];
    try { saved = await get('/events/searches'); } catch (e) { fail(e); }
    const what = (x) => [x.q ? `„${x.q}“` : '', x.kind ? (x.kind === 'trap' ? 'Traps' : 'Syslog') : '', x.maxSeverity < 7 ? t({ 4: 'ev.f.warning', 3: 'ev.f.err', 2: 'ev.f.crit' }[x.maxSeverity] || 'ev.f.all') : '',
      x.range ? t(`ev.range.${x.range}`) : '', x.part ? t('ev.savedPart') : ''].filter(Boolean).join(' · ');
    mount(list,
      saved.length ? saved.map((x) => h('div', { class: 'ev-saved-row' },
        h('button', { type: 'button', class: 'ev-saved-use', title: what(x), onclick: () => { savedMenu.open = false; applySaved(x); } },
          h('span', {}, x.name, x.shared ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, x.mine ? t('ev.savedShared') : x.owner) : null),
          h('span', { class: 'small muted' }, what(x))),
        x.mine || state.user?.isAdmin ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('ev.savedDelete', { name: x.name }), title: t('ev.savedDelete', { name: x.name }),
          onclick: async (e) => { e.stopPropagation(); try { await del(`/events/searches/${x.id}`); toast(t('ev.savedDeleted')); drawSaved(); } catch (ex) { fail(ex); } } }, '×') : null))
        : h('span', { class: 'muted small', style: { padding: '8px 10px', maxWidth: '280px' } }, t('ev.savedNone')),
      isReadOnly() ? null : h('button', { type: 'button', class: 'ev-saved-add', onclick: () => { savedMenu.open = false; saveDialog(saved); } }, h('span', { html: icon('plus') }), t('ev.savedAdd')));
  }
  function applySaved(x) {
    // a search is about messages: from the overview by sender or the open events to all messages
    if (view === 'open' || (view === 'senders' && !source)) { view = 'all'; remember('ev.view', 'all'); history.replaceState(null, '', '/events'); }
    q.value = x.q || ''; kind = x.kind || ''; maxSeverity = Number.isInteger(x.maxSeverity) ? x.maxSeverity : 7; sevSel.value = String(maxSeverity); part = !!x.part;
    setRange(x.range || '');
  }
  function saveDialog(saved) {
    const cur = { q: q.value.trim(), kind, maxSeverity, range: range === 'custom' ? '' : range, part: part && !!q.value.trim() };
    const name = input('name', cur.q.slice(0, 60), { required: true, maxlength: 60, autocomplete: 'off' });
    const shared = h('input', { type: 'checkbox', name: 'shared' });
    const form = h('form', { class: 'form' },
      h('p', { class: 'muted', style: { margin: 0 } }, t('ev.savedWhat'), ' ', h('strong', {}, [cur.q ? `„${cur.q}“` : t('ev.savedNoText'), cur.kind ? (cur.kind === 'trap' ? 'Traps' : 'Syslog') : '',
        cur.maxSeverity < 7 ? t({ 4: 'ev.f.warning', 3: 'ev.f.err', 2: 'ev.f.crit' }[cur.maxSeverity]) : '', cur.range ? t(`ev.range.${cur.range}`) : ''].filter(Boolean).join(' · ')),
        range === 'custom' ? h('span', { class: 'small' }, ` ${t('ev.savedNoCustom')}`) : null),
      field(t('ev.savedName'), name, saved.some((x) => x.mine) ? t('ev.savedNameHint') : ''),
      h('label', { class: 'check' }, shared, t('ev.savedShare')));
    const m = modal(t('ev.savedAdd'), form, { onSubmit: async () => {
      try { await post('/events/searches', { ...cur, name: name.value, shared: shared.checked }); m.close(); toast(t('ev.savedDone', { name: name.value.trim() })); } catch (e) { fail(e, form); }
    }, actions: [btn(t('cancel'), { onclick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
    name.focus(); name.select();
  }

  // The timeline: one bar per step of time, errors at the bottom, then warnings, then the rest. A click on a bar or
  // dragging over several narrows the range to them; arrow keys and Enter do the same without a mouse.
  function drawHist() {
    const hg = hist;
    const backBtn = back.length ? btn(t('ev.rangeBack'), { class: 'btn btn-sm btn-ghost', onclick: () => { const prev = back.pop(); q.value = prev.q; setRange(prev.range, prev.custom, { remember: false }); } }) : null;
    const allBtn = range ? btn(t('ev.range.all'), { class: 'btn btn-sm btn-ghost', onclick: () => setRange('') }) : null;
    if (!hg) return null;
    const from = Date.parse(hg.from); const to = Date.parse(hg.to); const span = to - from;
    const head = h('div', { class: 'ev-hist-head' },
      h('span', { class: 'small' }, h('strong', {}, t(hg.total === 1 ? 'ev.histTotal1' : 'ev.histTotal', { n: hg.total.toLocaleString(getLang()) })),
        hg.buckets.length ? ` · ${tick(from, span)} – ${tick(to, span)}` : ''),
      hg.buckets.length > 1 && hg.total ? h('span', { class: 'small muted hide-sm' }, t('ev.histHint', { step: stepLabel(hg.step) })) : null,
      h('span', { class: 'ev-hist-actions' }, backBtn, allBtn));
    if (!hg.total || !hg.buckets.length) return h('div', { class: 'panel panel-pad ev-hist' }, head);
    const n = hg.buckets.length; const W = 1000; const H = 72; const bw = W / n; const gap = bw > 4 ? 1 : 0;
    const max = Math.max(1, ...hg.buckets.map((b) => b.err + b.warn + b.other));
    const startOf = (i) => Date.parse(hg.buckets[i].at);
    const endOf = (i) => Math.min(to, startOf(i) + hg.step * 1000);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'ev-hist-svg', tabindex: '0', role: 'img',
      'aria-label': t('ev.histAria', { n: hg.total, from: tick(from, span), to: tick(to, span) }) });
    const sel = svgEl('rect', { class: 'ev-hist-sel', x: 0, y: 0, width: 0, height: H, visibility: 'hidden' });
    hg.buckets.forEach((b, i) => {
      const g = svgEl('g');
      const title = svgEl('title');
      title.textContent = `${tick(startOf(i), span)} – ${tick(endOf(i), span)}: ${t('ev.histBar', { n: b.err + b.warn + b.other, err: b.err, warn: b.warn })}`;
      g.append(title, svgEl('rect', { x: i * bw, y: 0, width: bw, height: H, fill: 'transparent' }));
      let y = H;
      for (const [k, cls] of [['err', 'ev-hist-err'], ['warn', 'ev-hist-warn'], ['other', 'ev-hist-other']]) {
        if (!b[k]) continue;
        const hh = Math.max(1.5, (b[k] / max) * (H - 2));
        y -= hh;
        g.append(svgEl('rect', { x: i * bw + gap / 2, y, width: Math.max(0.5, bw - gap), height: hh, class: cls }));
      }
      svg.append(g);
    });
    svg.append(sel);
    // choosing: pointer down on one bar, up on the same or another one
    let a = null; let cur = 0;
    const idx = (e) => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))); };
    const show = (i, j) => { const lo = Math.min(i, j); const hi = Math.max(i, j); sel.setAttribute('x', String(lo * bw)); sel.setAttribute('width', String((hi - lo + 1) * bw)); sel.setAttribute('visibility', 'visible'); };
    const pickBars = (i, j) => zoom(startOf(Math.min(i, j)), endOf(Math.max(i, j)));
    svg.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; dragging = true; a = idx(e); show(a, a); try { svg.setPointerCapture(e.pointerId); } catch { /* old browser */ } e.preventDefault(); });
    svg.addEventListener('pointermove', (e) => { if (a !== null) show(a, idx(e)); });
    svg.addEventListener('pointerup', (e) => { dragging = false; if (a === null) return; const i = a; a = null; pickBars(i, idx(e)); });
    svg.addEventListener('pointercancel', () => { dragging = false; a = null; sel.setAttribute('visibility', 'hidden'); });
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { cur = Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1))); show(cur, cur); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ' ') { pickBars(cur, cur); e.preventDefault(); }
    });
    svg.addEventListener('focus', () => { cur = Math.max(0, hg.buckets.findIndex((b) => b.err + b.warn + b.other)); show(cur, cur); });
    svg.addEventListener('blur', () => { if (a === null) sel.setAttribute('visibility', 'hidden'); });
    const axis = h('div', { class: 'ev-hist-axis small muted' }, h('span', {}, tick(from, span)), h('span', { class: 'hide-sm' }, tick(from + span / 2, span)), h('span', {}, tick(to, span)));
    const legend = h('div', { class: 'ev-hist-legend small muted' },
      h('span', {}, h('i', { class: 'ev-hist-err' }), t('ev.histErr')), h('span', {}, h('i', { class: 'ev-hist-warn' }), t('ev.histWarn')), h('span', {}, h('i', { class: 'ev-hist-other' }), t('ev.histOther')));
    return h('div', { class: 'panel panel-pad ev-hist' }, head, svg, axis, legend);
  }

  // A message → a monitor that alarms when it comes again: same sender, same kind, its severity, the start of its text
  function watch(r) {
    const words = String(r.text).replace(/\d+/g, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, 3).join(' ');
    const match = r.kind === 'trap' && r.app ? r.app : words.length >= 4 && String(r.text).includes(words) ? words : '';
    openMonitorForm(null, () => navigate('/monitoring'), { type: 'event', name: `${r.device_name || r.source_ip}: ${r.app || t('ev.message')}`.slice(0, 120),
      device_id: r.device_id || null, options: { source: r.kind, maxSeverity: Math.max(r.severity, 3), match, holdMin: 15 } });
  }
  // A message → an event rule that sends the same kind by mail / to the ticket system: event id and source for Windows,
  // otherwise the sender and the start of the text
  function ruleFrom(r) {
    const words = String(r.text).replace(/\d+/g, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, 3).join(' ');
    const match = r.event_id !== null && r.event_id !== undefined
      ? { eventIds: String(r.event_id), source: r.app || '', channel: r.app ? '' : r.channel || '' }
      : { from: r.device_name || r.host || r.source_ip, words: words.length >= 4 && String(r.text).includes(words) ? words : '', kind: r.kind, maxSeverity: Math.max(r.severity, 3) };
    const what = r.event_id !== null && r.event_id !== undefined ? `${t('ev.eventId', { id: r.event_id })}${r.app ? ` ${r.app.replace(/^Microsoft-Windows-/, '')}` : ''}` : `${r.device_name || r.source_ip}: ${r.app || t('ev.message')}`;
    openRuleForm(null, () => navigate('/events/rules'), { name: what.slice(0, 120), match });
  }
  // What is kept of one sender: as for all, from a severity on, or nothing
  function senderFilter(s) {
    const cfg = info?.settings || {};
    const sel = select('min', [['', t('ev.keep.asAll', { what: keepLabel(Number(cfg.minSeverity ?? 7)) })], ...keepOptions(), ['-1', t('ev.keep.none')]],
      s.filter === null || s.filter === undefined ? '' : String(s.filter));
    const form = h('form', { class: 'form' },
      h('p', { style: { margin: 0 } }, h('strong', {}, s.device_name || s.host || s.source_ip), ' ', h('span', { class: 'muted mono small' }, s.source_ip)),
      field(t('ev.keepWhat'), sel, t('ev.filterHint')));
    const m = modal(t('ev.filterTitle'), form, { onSubmit: async () => {
      try { await put('/events/senders/filter', { source: s.source_ip, min: sel.value === '' ? null : Number(sel.value) }); m.close(); toast(t('saved')); load(); } catch (e) { fail(e); }
    }, actions: [btn(t('cancel'), { onclick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  }
  /** Quick filters, type of device and order above the overview by sender (with how many each has) */
  function senderControls() {
    const c = senderInfo.counts || {};
    const set = (k, v) => { senderOpt[k] = v; if (k === 'sort') remember('ev.senderSort', v); senders = []; load(); };
    const fc = (key, label, n) => h('button', { type: 'button', class: `fchip${senderOpt.show === key ? ' on' : ''}`, 'aria-pressed': String(senderOpt.show === key),
      onclick: () => set('show', key) }, label, n !== undefined ? h('span', { class: 'chip-n' }, n.toLocaleString(getLang())) : null);
    const typeName = (k) => { if (k === '-') return t('ev.notInInventory'); const l = t(`type.${k}`); return l === `type.${k}` ? k : l; };
    const typeSel = h('select', { 'aria-label': t('ev.senderType'), onchange: (e) => set('type', e.currentTarget.value) },
      h('option', { value: '' }, t('ev.senderTypeAll')),
      // a type picked that has no sender left (search) stays in the list - else the select would show another one
      [...senderInfo.types, ...(senderOpt.type && !senderInfo.types.some((x) => x.type === senderOpt.type) ? [{ type: senderOpt.type, n: 0 }] : [])]
        .map((x) => h('option', { value: x.type }, `${typeName(x.type)} (${x.n.toLocaleString(getLang())})`)));
    typeSel.value = senderOpt.type;
    const sortSel = h('select', { 'aria-label': t('ev.senderSort'), onchange: (e) => set('sort', e.currentTarget.value) },
      [['last', t('ev.sort.last')], ['day', t('ev.sort.day')], ['name', t('ev.sort.name')]].map(([v, l]) => h('option', { value: v }, l)));
    sortSel.value = senderOpt.sort;
    return [fc('', t('all'), c.all), fc('err', t('ev.show.err'), c.err), fc('warn', t('ev.show.warn'), c.warn), fc('silent', t('ev.show.silent'), c.silent), fc('filter', t('ev.show.filter'), c.filter),
      senderInfo.types.length > 1 || senderOpt.type ? typeSel : null, sortSel];
  }

  // What takes the space: the Windows events and senders with the biggest share - to see what need not be collected.
  // With what speaks for keeping one (a rule needs it, usually important) and, for admins, leaving it out with a click.
  function noiseDialog() {
    let days = 7; let data = null;
    const daysSel = h('select', { 'aria-label': t('ev.noise.period'), style: { width: 'auto' } }, [[1, 'ev.range.24h'], [7, 'ev.range.7d'], [30, 'ev.range.30d']].map(([v, k]) => h('option', { value: String(v) }, t(k))));
    daysSel.value = '7';
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('loading')));
    const n = (x) => Number(x).toLocaleString(getLang());
    const perDay = (x) => (x.perDay < 1 && x.n > 0 ? '< 1' : n(x.perDay));
    const bar = (share) => h('span', { class: 'ev-share', title: `${share} %` }, h('span', { style: { width: `${Math.min(100, share)}%` } }));
    let changed = false;
    // the messages of one event: all messages, searched for its number, over the period looked at
    const show = (id) => { changed = false; m.close(); view = 'all'; source = null; remember('ev.view', 'all'); q.value = id; part = false;
      history.replaceState(null, '', '/events'); setRange(days === 1 ? '24h' : days === 30 ? '30d' : '7d'); };
    // with its source when it is known: only this number of this source, the same number of another one stays
    const label = (e) => (e.app ? `${e.id} · ${e.app.replace(/^Microsoft-Windows-/, '')}` : String(e.id));
    async function deny(e) {
      if (e.keep && !confirm(t('ev.noise.keepAsk', { id: label(e) }))) return;
      try { await post('/events/noise/deny', { id: e.id, src: e.app || '' }); toast(t('ev.noise.denied', { id: label(e) })); changed = true; await fetchIt(); } catch (ex) { fail(ex); }
    }
    function drawIt() {
      if (!data.total) { mount(box, h('p', { class: 'muted' }, t('ev.noise.none'))); return; }
      const hints = (e) => [
        e.rules.length ? h('span', { class: 'badge badge-ok', title: e.rules.join(', ') }, t('ev.noise.rule', { n: e.rules.length })) : null,
        e.keep ? h('span', { class: 'badge badge-warn', title: t('ev.noise.keepHint') }, t('ev.noise.keep')) : null,
        e.usual ? h('span', { class: 'badge', title: t('ev.noise.usualHint') }, t('ev.noise.usual')) : null,
        e.denied ? h('span', { class: 'badge' }, t('ev.noise.isDenied')) : null];
      const sevText = (w) => (w === null ? '' : w <= 3 ? t('ev.noise.worstErr') : w === 4 ? t('ev.noise.worstWarn') : t('ev.noise.worstInfo'));
      mount(box,
        h('p', { class: 'muted', style: { margin: 0 } }, t('ev.noise.lead', { day: n(data.perDay), keep: data.keepDays, used: gb(data.used) })),
        data.events.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-noise' },
          h('thead', {}, h('tr', {}, h('th', {}, t('ev.noise.event')), h('th', { class: 'num' }, t('ev.noise.perDay')), h('th', {}, t('ev.noise.share')),
            h('th', { class: 'num', title: t('ev.noise.spaceHint', { keep: data.keepDays }) }, t('ev.noise.space', { keep: data.keepDays })), h('th', {}))),
          h('tbody', {}, data.events.map((e) => h('tr', {},
            h('td', {}, h('strong', {}, String(e.id)), ' ', h('span', { class: 'muted small', title: e.app || e.example.channel || '' }, String(e.app || e.example.channel || t('ev.noise.noSource')).replace(/^Microsoft-Windows-/, '')),
              h('div', { class: 'sub' }, [e.computers > 3 ? t('ev.noise.computers', { n: n(e.computers) }) : '', e.senders.join(', '), e.moreSenders ? t('ev.noise.more', { n: n(e.moreSenders) }) : '', sevText(e.worst)].filter(Boolean).join(' · ')),
              e.example.text ? h('div', { class: 'sub ev-noise-text', title: e.example.text }, e.example.text.slice(0, 160)) : null,
              h('div', { class: 'row', style: { gap: '4px', flexWrap: 'wrap', marginTop: '4px' } }, hints(e))),
            h('td', { class: 'num nowrap', title: e.estimated ? t('ev.noise.estimated') : '' }, e.estimated ? '≈ ' : '', perDay(e)),
            h('td', { class: 'nowrap' }, bar(e.share), ` ${e.share.toLocaleString(getLang())} %`),
            h('td', { class: 'num nowrap' }, `≈ ${gb(e.bytes)}`),
            h('td', { class: 'min' }, h('div', { class: 'ev-noise-act' },
              btn(t('ev.noise.show'), { class: 'btn btn-sm btn-ghost', onclick: () => show(String(e.id)) }),
              admin && !isReadOnly() && !e.denied ? btn(t('ev.noise.deny'), { class: 'btn btn-sm', disabled: e.rules.length > 0,
                title: e.rules.length ? t('ev.noise.ruleBlocks', { list: e.rules.join(', ') }) : e.app ? t('ev.noise.denyHintSrc', { what: label(e) }) : t('ev.noise.denyHint'), onclick: () => deny(e) }) : null)))))))
          : null,
        // by type of device: clients, servers, NAS … (worth it only with more than one type)
        data.groups?.length > 1 ? h('div', {}, h('h3', { style: { margin: '8px 0 4px' } }, t('ev.noise.groups')),
          h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-noise' },
            h('thead', {}, h('tr', {}, h('th', {}, t('ev.senderType')), h('th', { class: 'num' }, t('ev.noise.senderN')), h('th', { class: 'num' }, t('ev.noise.perDay')), h('th', {}, t('ev.noise.share')),
              h('th', { class: 'num' }, t('ev.noise.space', { keep: data.keepDays })))),
            h('tbody', {}, data.groups.map((x) => h('tr', {},
              h('td', {}, x.type === '-' ? t('ev.notInInventory') : (t(`type.${x.type}`) === `type.${x.type}` ? x.type : t(`type.${x.type}`))),
              h('td', { class: 'num nowrap' }, n(x.senders)),
              h('td', { class: 'num nowrap' }, perDay(x)),
              h('td', { class: 'nowrap' }, bar(x.share), ` ${x.share.toLocaleString(getLang())} %`),
              h('td', { class: 'num nowrap' }, `≈ ${gb(x.bytes)}`))))))) : null,
        data.senders.length ? h('div', {}, h('h3', { style: { margin: '8px 0 4px' } }, t('ev.noise.senders')),
          h('p', { class: 'muted small', style: { margin: '0 0 6px' } }, t('ev.noise.sendersLead')),
          h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-noise' },
            h('thead', {}, h('tr', {}, h('th', {}, t('ev.from')), h('th', { class: 'num' }, t('ev.noise.perDay')), h('th', {}, t('ev.noise.share')), h('th', { class: 'num' }, t('ev.noise.info')),
              h('th', { class: 'num' }, t('ev.noise.space', { keep: data.keepDays })), h('th', {}))),
            h('tbody', {}, data.senders.map((x) => h('tr', {},
              h('td', {}, h('span', { class: 'name' }, x.name || x.source_ip), x.name ? h('div', { class: 'sub mono' }, x.source_ip) : null),
              h('td', { class: 'num nowrap' }, perDay(x)),
              h('td', { class: 'nowrap' }, bar(x.share), ` ${x.share.toLocaleString(getLang())} %`),
              h('td', { class: 'num nowrap' }, `${x.info} %`),
              h('td', { class: 'num nowrap' }, `≈ ${gb(x.bytes)}`),
              h('td', { class: 'min nowrap' }, admin && !isReadOnly() ? btn(t('ev.filter'), { class: 'btn btn-sm', onclick: () => senderFilter({ source_ip: x.source_ip, host: x.name, filter: x.filter }) }) : null))),
              // all the others together: with thousands of computers most of the space can be there
              data.rest ? h('tr', { class: 'muted' },
                h('td', {}, t('ev.noise.rest', { n: n(data.rest.senders) })),
                h('td', { class: 'num nowrap' }, perDay(data.rest)),
                h('td', { class: 'nowrap' }, bar(data.rest.share), ` ${data.rest.share.toLocaleString(getLang())} %`),
                h('td', {}),
                h('td', { class: 'num nowrap' }, `≈ ${gb(data.rest.bytes)}`),
                h('td', {})) : null)))) : null,
        h('p', { class: 'muted small', style: { margin: 0 } }, t('ev.noise.foot')));
    }
    async function fetchIt() {
      try { data = await get(`/events/noise?days=${days}`); drawIt(); } catch (e) { fail(e); }
    }
    // the list as a question for an AI chat: shown first, so one sees what leaves the house
    async function forAi() {
      try {
        const r = await get(`/events/noise/text?days=${days}&lang=${getLang()}`);
        const area = h('textarea', { readonly: true, rows: 16, class: 'mono small', style: { width: '100%' }, 'aria-label': t('ev.noise.aiTitle') }, r.text);
        const a = modal(t('ev.noise.aiTitle'), h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, t('ev.noise.aiLead')), area), { wide: true, actions: [
          btn(t('close'), { onclick: () => a.close() }),
          btn(t('agent.copy'), { class: 'btn btn-primary', onclick: async () => {
            try { await navigator.clipboard.writeText(r.text); toast(t('agent.copied')); } catch { area.select(); toast(t('ev.noise.copyHand')); }
          } }, 'download')] });
      } catch (e) { fail(e); }
    }
    daysSel.addEventListener('change', () => { days = Number(daysSel.value); fetchIt(); });
    const m = modal(t('ev.noise.title'), h('div', { class: 'stack' },
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, daysSel,
        btn(t('ev.noise.ai'), { class: 'btn btn-sm', title: t('ev.noise.aiHint'), onclick: forAi }, 'chat')), box), { wide: true,
      actions: [btn(t('close'), { onclick: () => m.close() })], onClose: () => { if (changed) load(); } });
    fetchIt();
  }
  function settingsDialog(cfg) {
    const traps = h('input', { type: 'checkbox', name: 'traps', checked: cfg.traps });
    const syslog = h('input', { type: 'checkbox', name: 'syslog', checked: cfg.syslog });
    const winDeny = h('textarea', { name: 'winDeny', rows: 3, class: 'mono', placeholder: '4624, 4634, 5858, 1@Ntfs', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' } }, cfg.winDeny || '');
    // entries as the list understands them: "1@Ntfs" is number 1 of the source Ntfs only - shown readable below the field
    const entries = (v) => v.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).flatMap((x) => (x.includes('@') ? [x.replace(/\s*@\s*/, '@')] : x.split(/\s+/)));
    const withSource = h('div', { class: 'muted small', style: { width: '100%' } });
    const showSources = () => {
      const list = entries(winDeny.value).filter((x) => x.includes('@'));
      mount(withSource, list.length ? `${t('ev.s.winDenyOnly')} ${list.map((x) => x.replace('@', ' · ')).join(', ')}` : '');
    };
    winDeny.addEventListener('input', showSources); showSources();
    const form = h('form', { class: 'form' },
      field(t('ev.s.traps', { port: cfg.trapPort }), traps, t('ev.s.trapsHint')),
      field(t('ev.s.communities'), h('textarea', { name: 'communities', rows: 2, class: 'mono', autocomplete: 'off', spellcheck: 'false',
        placeholder: cfg.communitiesSet ? '••••••' : t('ev.s.communitiesPh') }), cfg.communitiesSet ? t('ev.s.communitiesSet') : t('ev.s.communitiesHint')),
      field(t('ev.s.syslog', { port: cfg.syslogPort }), syslog, t('ev.s.syslogHint')),
      field(t('ev.s.syslogTcp', { port: cfg.syslogTcpPort }), h('input', { type: 'checkbox', name: 'syslogTcp', checked: cfg.syslogTcp }), t('ev.s.syslogTcpHint')),
      field(t('ev.s.syslogTls', { port: cfg.syslogTlsPort }), h('input', { type: 'checkbox', name: 'syslogTls', checked: cfg.syslogTls }), t('ev.s.syslogTlsHint')),
      field(t('ev.s.onlyKnown'), h('input', { type: 'checkbox', name: 'onlyKnown', checked: cfg.onlyKnown }), t('ev.s.onlyKnownHint')),
      field(t('ev.s.minSeverity'), select('minSeverity', keepOptions(), String(cfg.minSeverity ?? 7)), t('ev.s.minSeverityHint')),
      field(t('ev.s.winAllow'), input('winAllow', cfg.winAllow || '', { class: 'mono', placeholder: t('ev.s.winAllowPh'), autocomplete: 'off' }), t('ev.s.winAllowHint')),
      field(t('ev.s.winDeny'), h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, winDeny,
        cfg.winNoise ? btn(t('ev.s.winNoise'), { class: 'btn btn-sm', type: 'button', title: cfg.winNoise, onclick: () => {
          // the usual noise added to what is there - nothing removed; tidied up by the server when saved
          winDeny.value = [...new Set([...entries(winDeny.value), ...entries(cfg.winNoise)])].join(', ');
          showSources();
        } }) : null, withSource), t('ev.s.winDenyHint')),
      field(t('ev.s.keep'), input('keepDays', cfg.keepDays, { type: 'number', min: 1, max: 365 }), t('ev.s.keepHint')),
      field(t('ev.s.maxGb'), input('maxGb', cfg.maxGb, { type: 'number', min: 0.1, max: 1000, step: 0.1 }), t('ev.s.maxGbHint')),
      h('div', { class: 'note', style: { margin: 0 } }, h('div', { style: { minWidth: 0 } },
        h('strong', {}, t('ev.s.portsTitle')), h('p', { style: { margin: '4px 0 6px' } }, t('ev.s.ports', { trap: cfg.trapPort, syslog: cfg.syslogPort })),
        h('pre', { class: 'mono small', style: { margin: 0, whiteSpace: 'pre-wrap' } },
          `iptables -t nat -A PREROUTING -p udp --dport 162 -j REDIRECT --to-ports ${cfg.trapPort}\niptables -t nat -A PREROUTING -p udp --dport 514 -j REDIRECT --to-ports ${cfg.syslogPort}\niptables -t nat -A PREROUTING -p tcp --dport 514 -j REDIRECT --to-ports ${cfg.syslogTcpPort}`))));
    const m = modal(t('ev.settings'), form, { wide: true, onSubmit: async () => {
      const d = formData(form);
      if (!d.communities.trim()) delete d.communities;
      d.keepDays = Number(d.keepDays);
      d.maxGb = Number(d.maxGb);
      d.minSeverity = Number(d.minSeverity);
      try { await put('/events/settings', d); m.close(); toast(t('saved')); load(); } catch (ex) { fail(ex); }
    }, actions: [btn(t('cancel'), { onclick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  }

  let timer = null;
  q.addEventListener('input', () => { part = false; clearTimeout(timer); timer = setTimeout(() => { senders = []; load(); }, 300); });
  sevSel.addEventListener('change', () => { maxSeverity = Number(sevSel.value); load(); });
  rangeSel.addEventListener('change', () => {
    // a range of one's own starts with what was shown: the last 24 hours, or the preset just chosen
    if (rangeSel.value === 'custom') { const r = rangeNow(); setRange('custom', { from: r.from ? Date.parse(r.from) : Date.now() - 86400000, to: Date.now() }); }
    else setRange(rangeSel.value);
  });
  const applyCustom = () => {
    const f = fromLocalInput(fromIn.value); const tt = fromLocalInput(toIn.value);
    const bad = f !== null && tt !== null && f >= tt;
    fromIn.setAttribute('aria-invalid', String(bad)); toIn.setAttribute('aria-invalid', String(bad));
    if (bad) { toast(t('ev.rangeBad')); return; }
    setRange('custom', { from: f, to: tt });
  };
  fromIn.addEventListener('change', applyCustom);
  toIn.addEventListener('change', applyCustom);
  const head = pageHead(t('ev.title'), t('ev.lead'),
    btn(t('ev.rules'), { class: 'btn', onclick: () => navigate('/events/rules') }, 'mail'),
    btn(t('ev.noise.title'), { class: 'btn', title: t('ev.noise.hint'), onclick: () => noiseDialog() }, 'gauge'),
    admin ? btn(t('ev.settings'), { class: 'btn', onclick: () => info && settingsDialog(info.settings) }, 'settings') : null,
    btn(t('ev.reload'), { class: 'btn', onclick: () => load() }, 'refresh'));
  mount(body, head, statusBox, spaceBox,
    h('div', { class: 'vo-toolbar ev-toolbar' }, seg, h('label', { class: 'search' }, h('span', { class: 'ico', html: icon('search') }), q), savedMenu, sevSel, rangeSel, chips),
    customBox, sourceChip, histBox, listBox, more);
  await load();
  // new messages show up by themselves while the page is open (not while searching through older ones)
  const auto = setInterval(() => { if (!body.isConnected) { clearInterval(auto); return; } if (dragging) return; if ((view === 'senders' && !source) || (rows.length <= 200 && !document.hidden)) { if (!document.hidden) load(); } }, 15000);
}
