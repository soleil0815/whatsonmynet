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

export const SEV = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const sevTone = (s) => (s <= 3 ? 'bad' : s === 4 ? 'warn' : s === 5 ? '' : 'muted');
export const sevLabel = (s) => t(`ev.sev.${SEV[s]}`);

export async function renderEvents(main) {
  if (!(state.user.canEditServer ?? state.user.canEdit)) { navigate('/', { replace: true }); return; }
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, body));
  const admin = state.user.isAdmin;
  let kind = ''; let maxSeverity = 7; let rows = []; let info = null;
  const q = h('input', { type: 'search', placeholder: t('ev.search'), 'aria-label': t('ev.search') });
  const sevSel = h('select', { 'aria-label': t('ev.severity') }, [[7, t('ev.f.all')], [4, t('ev.f.warning')], [3, t('ev.f.err')], [2, t('ev.f.crit')]].map(([v, l]) => h('option', { value: String(v) }, l)));
  const chips = h('div', { class: 'inv-chips', role: 'group' });
  const statusBox = h('div');
  const listBox = h('div');
  const more = h('div', { class: 'actions', style: { justifyContent: 'center' } });

  async function load(append = false) {
    const p = new URLSearchParams({ q: q.value.trim(), kind, maxSeverity: String(maxSeverity), limit: '200' });
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
        errs.map((e) => h('span', { class: 'small bad-text' }, e))));
    const chip = (key, label) => h('button', { type: 'button', class: `fchip${kind === key ? ' on' : ''}`, 'aria-pressed': String(kind === key), onclick: () => { kind = key; load(); } }, label);
    mount(chips, chip('', t('all')), chip('trap', 'Traps'), chip('syslog', 'Syslog'));
    mount(listBox, rows.length ? h('div', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data ev-table' },
      h('thead', {}, h('tr', {}, h('th', {}, t('ev.when')), h('th', {}, t('ev.from')), h('th', {}, t('ev.severity')), h('th', {}, t('ev.text')), h('th', {}))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'nowrap small' }, fmtDate(r.at, getLang())),
        h('td', {}, r.device_id ? h('a', { class: 'name', href: `/devices/${r.device_id}`, 'data-link': true }, r.device_name || r.source_ip) : h('span', { class: 'name mono' }, r.source_ip),
          h('div', { class: 'sub mono' }, [r.device_id ? r.source_ip : '', r.host && r.host !== r.device_name ? r.host : ''].filter(Boolean).join(' · ') || null)),
        h('td', {}, h('span', { class: `badge ${sevTone(r.severity) === 'muted' ? '' : `badge-${sevTone(r.severity)}`}` }, sevLabel(r.severity)),
          h('div', { class: 'sub' }, r.kind === 'trap' ? 'Trap' : 'Syslog')),
        h('td', { class: 'ev-text' }, r.app ? h('strong', { class: 'small' }, `${r.app}: `) : null, h('span', { class: 'small' }, r.text),
          r.oid && r.kind === 'trap' && !r.app ? h('div', { class: 'sub mono' }, r.oid) : null),
        h('td', { class: 'min' }, isReadOnly() ? null : btn(t('ev.watch'), { class: 'btn btn-sm btn-ghost', title: t('ev.watchHint'), onclick: () => watch(r) }, 'pulse'))))))))
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
      field(t('ev.s.keep'), input('keepDays', cfg.keepDays, { type: 'number', min: 1, max: 365 }), t('ev.s.keepHint')),
      h('div', { class: 'note', style: { margin: 0 } }, h('div', { style: { minWidth: 0 } },
        h('strong', {}, t('ev.s.portsTitle')), h('p', { style: { margin: '4px 0 6px' } }, t('ev.s.ports', { trap: cfg.trapPort, syslog: cfg.syslogPort })),
        h('pre', { class: 'mono small', style: { margin: 0, whiteSpace: 'pre-wrap' } },
          `iptables -t nat -A PREROUTING -p udp --dport 162 -j REDIRECT --to-ports ${cfg.trapPort}\niptables -t nat -A PREROUTING -p udp --dport 514 -j REDIRECT --to-ports ${cfg.syslogPort}\niptables -t nat -A PREROUTING -p tcp --dport 514 -j REDIRECT --to-ports ${cfg.syslogTcpPort}`))));
    const m = modal(t('ev.settings'), form, { wide: true, onSubmit: async () => {
      const d = formData(form);
      if (!d.communities.trim()) delete d.communities;
      d.keepDays = Number(d.keepDays);
      try { await put('/events/settings', d); m.close(); toast(t('saved')); load(); } catch (ex) { fail(ex); }
    }, actions: [btn(t('cancel'), { onclick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  }

  let timer = null;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(), 300); });
  sevSel.addEventListener('change', () => { maxSeverity = Number(sevSel.value); load(); });
  const head = pageHead(t('ev.title'), t('ev.lead'),
    admin ? btn(t('ev.settings'), { class: 'btn', onclick: () => info && settingsDialog(info.settings) }, 'settings') : null,
    btn(t('ev.reload'), { class: 'btn', onclick: () => load() }, 'refresh'));
  mount(body, head, statusBox,
    h('div', { class: 'vo-toolbar ev-toolbar' }, h('label', { class: 'search' }, h('span', { class: 'ico', html: icon('search') }), q), sevSel, chips),
    listBox, more);
  await load();
  // new messages show up by themselves while the page is open (not while searching through older ones)
  const auto = setInterval(() => { if (!body.isConnected) { clearInterval(auto); return; } if (rows.length <= 200 && !document.hidden) load(); }, 15000);
}
