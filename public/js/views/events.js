// Messages devices sent by themselves (SNMP traps, syslog): the newest first, filtered and searched; one click turns a
// message into an event monitor. Admins switch the receivers on here.
import { h, mount, modal, toast, fmtDate } from '../dom.js';
import { get, put } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, fail, navigate } from '../app.js';
import { pageHead, field, input, btn, formData } from './common.js';
import { openMonitorForm } from './monitoring.js';
import { lockForEditing, isReadOnly } from './failover.js';
import { openRuleForm } from './eventrules.js';

export const SEV = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const sevTone = (s) => (s <= 3 ? 'bad' : s === 4 ? 'warn' : s === 5 ? '' : 'muted');
export const sevLabel = (s) => t(`ev.sev.${SEV[s]}`);
const gb = (b) => (b < 1024 ** 3 ? `${Math.max(0.1, b / 1024 ** 2).toLocaleString(getLang(), { maximumFractionDigits: b < 10 * 1024 ** 2 ? 1 : 0 })} MB` : `${(b / 1024 ** 3).toLocaleString(getLang(), { maximumFractionDigits: 1 })} GB`);

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
  let source = null; // { ip, label }
  const fromUrl = new URLSearchParams(location.search).get('from');
  if (fromUrl) source = { ip: fromUrl, label: fromUrl };
  let senders = [];
  const q = h('input', { type: 'search', placeholder: t('ev.search'), 'aria-label': t('ev.search') });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('ev.view') });
  const sourceChip = h('div');
  const setView = (v) => { view = v; source = null; remember('ev.view', v); q.value = ''; history.replaceState(null, '', '/events'); load(); };
  const pick = (s) => { source = { ip: s.source_ip, label: s.device_name || s.host || s.source_ip }; q.value = ''; history.replaceState(null, '', `/events?from=${encodeURIComponent(s.source_ip)}`); load(); };
  const sevSel = h('select', { 'aria-label': t('ev.severity') }, [[7, t('ev.f.all')], [4, t('ev.f.warning')], [3, t('ev.f.err')], [2, t('ev.f.crit')]].map(([v, l]) => h('option', { value: String(v) }, l)));
  const chips = h('div', { class: 'inv-chips', role: 'group' });
  const statusBox = h('div');
  const spaceBox = h('div');
  const listBox = h('div');
  const more = h('div', { class: 'actions', style: { justifyContent: 'center' } });

  async function load(append = false) {
    if (view === 'senders' && !source) {
      try {
        const r = await get(`/events/senders?${new URLSearchParams({ q: q.value.trim() })}`);
        info = r; senders = r.senders;
        if (!body.isConnected) return;
        draw(false);
      } catch (e) { fail(e); }
      return;
    }
    const p = new URLSearchParams({ q: q.value.trim(), kind, maxSeverity: String(maxSeverity), limit: '200' });
    if (source) p.set('source', source.ip);
    if (append && rows.length) p.set('before', String(rows[rows.length - 1].id));
    try {
      const r = await get(`/events?${p}`);
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
        s.filtered ? h('span', { class: 'muted small', title: t('ev.filteredHint') }, t('ev.filtered', { n: s.filtered.toLocaleString(getLang()) })) : null,
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
    mount(seg, ...[['senders', t('ev.bySender')], ['all', t('ev.allMessages')]].map(([v, l]) => h('button', { type: 'button', class: (v === 'senders' ? view === 'senders' || source : view === 'all' && !source) ? 'on' : '',
      'aria-pressed': String(v === view), onclick: () => setView(v) }, l)));
    mount(chips, bySender ? null : [chip('', t('all')), chip('trap', 'Traps'), chip('syslog', 'Syslog')]);
    sevSel.hidden = bySender;
    q.placeholder = bySender ? t('ev.searchSenders') : t('ev.search');
    mount(sourceChip, source ? h('div', { class: 'actions', style: { justifyContent: 'flex-start', gap: '8px' } },
      h('span', {}, t('ev.onlyFrom')), h('strong', {}, source.label), source.label !== source.ip ? h('span', { class: 'muted mono small' }, source.ip) : null,
      btn(t('ev.allSenders'), { class: 'btn btn-sm', onclick: () => { source = null; view = 'senders'; history.replaceState(null, '', '/events'); load(); } })) : null);
    if (bySender) {
      mount(listBox, senders.length ? h('div', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-table' },
        h('thead', {}, h('tr', {}, h('th', {}, t('ev.from')), h('th', {}, t('ev.lastMessage')), h('th', { class: 'nowrap' }, t('ev.last24')), h('th', {}))),
        h('tbody', {}, senders.map((s) => h('tr', {},
          h('td', {}, h('button', { type: 'button', class: 'ev-name-btn', onclick: () => pick(s) }, s.device_name || s.host || s.source_ip),
            h('div', { class: 'sub mono' }, [s.source_ip, s.host && s.host !== s.device_name ? s.host : ''].filter(Boolean).join(' · '))),
          h('td', { class: 'ev-text' }, h('div', { class: 'small' }, h('span', { class: 'nowrap muted' }, `${fmtDate(s.last_at, getLang())} `),
            s.last_severity !== null ? h('span', { class: `badge ${sevTone(s.last_severity) === 'muted' ? '' : `badge-${sevTone(s.last_severity)}`}` }, sevLabel(s.last_severity)) : null),
            h('div', { class: 'small' }, s.last_event_id !== null && s.last_event_id !== undefined ? `${t('ev.eventId', { id: s.last_event_id })}: ` : s.last_app ? `${s.last_app}: ` : '',
              String(s.last_text || '').length > 160 ? `${String(s.last_text).slice(0, 159)}…` : s.last_text || '')),
          h('td', { class: 'nowrap small' }, t(s.day === 1 ? 'ev.dayCount1' : 'ev.dayCount', { n: s.day }),
            s.err ? h('div', {}, h('span', { class: 'badge badge-bad' }, t(s.err === 1 ? 'ev.errCount1' : 'ev.errCount', { n: s.err }))) : null,
            s.warn - s.err > 0 ? h('div', {}, h('span', { class: 'badge badge-warn' }, t(s.warn - s.err === 1 ? 'ev.warnCount1' : 'ev.warnCount', { n: s.warn - s.err }))) : null),
          h('td', { class: 'min nowrap' }, btn(t('ev.showMessages'), { class: 'btn btn-sm btn-ghost', onclick: () => pick(s) }, 'inventory'))))))))
        : h('div', { class: 'panel panel-pad muted' }, off ? t('ev.noneOff') : q.value ? t('ev.noMatch') : t('ev.none')));
      mount(more, null);
      lockForEditing(body);
      return;
    }
    mount(listBox, rows.length ? h('div', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-table' },
      h('thead', {}, h('tr', {}, h('th', {}, t('ev.when')), source ? null : h('th', {}, t('ev.from')), h('th', {}, t('ev.severity')), h('th', {}, t('ev.text')), h('th', {}))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap small' }, fmtDate(r.at, getLang())),
        source ? null : h('td', {}, r.device_id ? h('a', { class: 'name', href: `/devices/${r.device_id}`, 'data-link': true }, r.device_name || r.source_ip) : h('span', { class: 'name mono' }, r.source_ip),
          h('div', { class: 'sub mono' }, [r.device_id ? r.source_ip : '', r.host && r.host !== r.device_name ? r.host : ''].filter(Boolean).join(' · ') || null)),
        h('td', {}, h('span', { class: `badge ${sevTone(r.severity) === 'muted' ? '' : `badge-${sevTone(r.severity)}`}` }, sevLabel(r.severity)),
          h('div', { class: 'sub' }, r.kind === 'trap' ? 'Trap' : 'Syslog')),
        h('td', { class: 'ev-text' }, r.app && r.event_id === null ? h('strong', { class: 'small' }, `${r.app}: `) : null, h('span', { class: 'small' }, r.text),
          r.oid && r.kind === 'trap' && !r.app ? h('div', { class: 'sub mono' }, r.oid) : null,
          // Windows (NXLog): event id, log, source and account below the text, as in the event viewer
          r.event_id !== null && r.event_id !== undefined ? h('div', { class: 'sub' }, [t('ev.eventId', { id: r.event_id }), r.channel, r.event_id !== null && r.app ? r.app : '', r.account].filter(Boolean).join(' · ')) : null),
        h('td', { class: 'min nowrap' }, isReadOnly() ? null : [
          btn(t('ev.watch'), { class: 'btn btn-sm btn-ghost', title: t('ev.watchHint'), onclick: () => watch(r) }, 'pulse'),
          btn(t('ev.rule'), { class: 'btn btn-sm btn-ghost', title: t('ev.ruleHint'), onclick: () => ruleFrom(r) }, 'mail')])))))))
      : h('div', { class: 'panel panel-pad muted' }, off ? t('ev.noneOff') : q.value || kind || maxSeverity < 7 ? t('ev.noMatch') : t('ev.none')));
    mount(more, hasMore ? btn(t('ev.more'), { class: 'btn btn-sm', onclick: () => load(true) }) : null);
    lockForEditing(body);
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
  function settingsDialog(cfg) {
    const traps = h('input', { type: 'checkbox', name: 'traps', checked: cfg.traps });
    const syslog = h('input', { type: 'checkbox', name: 'syslog', checked: cfg.syslog });
    const form = h('form', { class: 'form' },
      field(t('ev.s.traps', { port: cfg.trapPort }), traps, t('ev.s.trapsHint')),
      field(t('ev.s.communities'), h('textarea', { name: 'communities', rows: 2, class: 'mono', autocomplete: 'off', spellcheck: 'false',
        placeholder: cfg.communitiesSet ? '••••••' : t('ev.s.communitiesPh') }), cfg.communitiesSet ? t('ev.s.communitiesSet') : t('ev.s.communitiesHint')),
      field(t('ev.s.syslog', { port: cfg.syslogPort }), syslog, t('ev.s.syslogHint')),
      field(t('ev.s.syslogTcp', { port: cfg.syslogTcpPort }), h('input', { type: 'checkbox', name: 'syslogTcp', checked: cfg.syslogTcp }), t('ev.s.syslogTcpHint')),
      field(t('ev.s.syslogTls', { port: cfg.syslogTlsPort }), h('input', { type: 'checkbox', name: 'syslogTls', checked: cfg.syslogTls }), t('ev.s.syslogTlsHint')),
      field(t('ev.s.onlyKnown'), h('input', { type: 'checkbox', name: 'onlyKnown', checked: cfg.onlyKnown }), t('ev.s.onlyKnownHint')),
      field(t('ev.s.winAllow'), input('winAllow', cfg.winAllow || '', { class: 'mono', placeholder: t('ev.s.winAllowPh'), autocomplete: 'off' }), t('ev.s.winAllowHint')),
      field(t('ev.s.winDeny'), input('winDeny', cfg.winDeny || '', { class: 'mono', placeholder: '8004, 4624, 4634', autocomplete: 'off' }), t('ev.s.winDenyHint')),
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
      try { await put('/events/settings', d); m.close(); toast(t('saved')); load(); } catch (ex) { fail(ex); }
    }, actions: [btn(t('cancel'), { onclick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  }

  let timer = null;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(), 300); });
  sevSel.addEventListener('change', () => { maxSeverity = Number(sevSel.value); load(); });
  const head = pageHead(t('ev.title'), t('ev.lead'),
    btn(t('ev.rules'), { class: 'btn', onclick: () => navigate('/events/rules') }, 'mail'),
    admin ? btn(t('ev.settings'), { class: 'btn', onclick: () => info && settingsDialog(info.settings) }, 'settings') : null,
    btn(t('ev.reload'), { class: 'btn', onclick: () => load() }, 'refresh'));
  mount(body, head, statusBox, spaceBox,
    h('div', { class: 'vo-toolbar ev-toolbar' }, seg, h('label', { class: 'search' }, h('span', { class: 'ico', html: icon('search') }), q), sevSel, chips),
    sourceChip, listBox, more);
  await load();
  // new messages show up by themselves while the page is open (not while searching through older ones)
  const auto = setInterval(() => { if (!body.isConnected) { clearInterval(auto); return; } if ((view === 'senders' && !source) || (rows.length <= 200 && !document.hidden)) { if (!document.hidden) load(); } }, 15000);
}
