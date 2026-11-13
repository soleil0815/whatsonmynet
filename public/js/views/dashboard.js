// Overview: what needs attention first, then the state of everything at a glance.
import { h, mount, fmtAgo, fmtDate } from '../dom.js';
import { get } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state } from '../app.js';
import { historyText } from './device.js';
import { supplyName } from './printer.js';
import { stText } from './snmpdev.js';

/** One line of "Needs attention": icon, what, details, one action */
function todo(kind, ico, title, detail, action, extra = null) {
  return h('li', { class: `todo todo-${kind}` },
    h('span', { class: 'todo-ico', html: icon(ico) }),
    h('div', { class: 'todo-text' }, h('div', { class: 'todo-title' }, title), detail ? h('div', { class: 'todo-detail' }, detail) : null, extra),
    action ? h('a', { class: 'btn btn-sm', href: action.href, 'data-link': true }, action.label) : null);
}

/** Line of the state card: dot, label, number, short state */
function stateRow(href, tone, label, n, note) {
  return h('a', { class: 'state-row', href, 'data-link': true },
    h('span', { class: `dot dot-${tone}` }), h('span', { class: 'state-label' }, label), h('b', {}, n), h('span', { class: `state-note tone-${tone}` }, note));
}

/**
 * Devices line: "all seen" only when every device was really seen in a scan.
 * Devices never scanned (added by hand, no scan yet) are neither "seen" nor "missing".
 */
function devicesRow(d) {
  const online = d.online ?? d.devices - (d.missing || 0);
  if (d.missing) return stateRow('/inventory', 'bad', t('dash.devicesShort'), d.devices, t('dash.notSeenN', { n: d.missing }));
  if (online >= d.devices) return stateRow('/inventory', 'ok', t('dash.devicesShort'), d.devices, t('dash.allSeen'));
  return stateRow('/inventory', 'muted', t('dash.devicesShort'), d.devices, online ? t('dash.seenOf', { n: online, total: d.devices }) : t('presence.unknown'));
}

export async function renderDashboard(main) {
  const d = await get('/dashboard');
  state.waiting = d.waiting;
  const mon = d.monitoring || { total: 0, up: 0, down: [], certs: [] };
  state.sensorsDown = mon.down.filter((m) => ['sensor', 'snmp', 'proxmox'].includes(m.type)).length;
  state.down = mon.down.length - state.sensorsDown;
  const canScan = state.user.canEdit;
  const lang = getLang();

  // Needs attention - most urgent first
  const items = [];
  if (mon.down.length) {
    const shown = mon.down.slice(0, 4);
    items.push(todo('bad', 'pulse', t('dash.monDown', { n: mon.down.length }), t('dash.monDownSince', { when: fmtAgo(mon.down[mon.down.length - 1].since, t) }),
      { href: '/monitoring', label: t('dash.look') },
      h('div', { class: 'todo-chips' }, shown.map((m) => h('a', { href: `/monitoring/${m.id}`, 'data-link': true, title: m.message }, m.name)),
        mon.down.length > shown.length ? h('span', {}, t('dash.more', { n: mon.down.length - shown.length })) : null,
        mon.unreachable ? h('a', { href: '/monitoring?status=unreachable', 'data-link': true, class: 'muted' }, t('dash.unreachable', { n: mon.unreachable })) : null)));
  }
  if (d.missing) items.push(todo('bad', 'inventory', t('dash.missingN', { n: d.missing }), t('dash.missingDetail'), { href: '/inventory?filter=problems', label: t('dash.look') }));
  if (d.waiting) {
    items.push(todo('new', 'radar', t('dash.newN', { n: d.waiting }), d.lastScan ? t('dash.newDetail', { when: fmtDate(d.lastScan.started_at, lang) }) : null,
      canScan ? { href: d.lastScan ? `/scan/${d.lastScan.id}` : '/scan', label: t('dash.adopt') } : null));
  }
  for (const s of d.printersLow || []) {
    const value = s.state === 'empty' ? (s.receptacle ? t('sup.full') : t('sup.empty')) : s.receptacle ? t('sup.freePct', { pct: s.pct }) : `${s.pct} %`;
    items.push(todo('new', 'printer', t('dash.supply', { name: supplyName(s), value }), s.device,
      { href: `/devices/${s.deviceId}`, label: t('dash.toDevice') },
      s.pct !== null && s.pct !== undefined && !s.receptacle ? h('div', { class: 'todo-bar' }, h('i', { style: { width: `${Math.max(2, s.pct)}%` } })) : null));
  }
  for (const p of d.nasProblems || []) {
    const what = p.kind === 'volume' ? t('nas.volumeFull', { name: p.name, pct: p.pct }) : [t(`nas.k.${p.kind}`), p.name, p.status ? stText(p.status) : ''].filter(Boolean).join(': ');
    items.push(todo('bad', 'nas', what, p.device, { href: `/devices/${p.deviceId}`, label: t('dash.toDevice') }));
  }
  for (const c of mon.certs || []) {
    items.push(todo('ti', 'lock', t('dash.cert', { name: c.name }), t('dash.certUntil', { date: fmtDate(c.cert_valid_to, lang, false) }), { href: `/monitoring/${c.id}`, label: t('dash.look') }));
  }
  for (const w of d.warranty || []) {
    items.push(todo('ti', 'history', t('dash.warrantyOf', { name: w.name }), t('dash.warrantyUntil', { date: fmtDate(w.warranty_until, lang, false) }), { href: `/devices/${w.id}`, label: t('dash.toDevice') }));
  }

  const empty = !d.devices;
  const attention = empty
    ? h('section', { class: 'panel empty' }, h('h2', {}, t('dash.emptyTitle')), h('p', {}, canScan ? t('dash.emptyText') : t('dash.noScanViewer')),
      canScan ? h('a', { class: 'btn btn-primary btn-big', href: '/scan', 'data-link': true }, h('span', { html: icon('radar') }), t('dash.scanNow')) : null)
    : h('section', { class: 'panel', 'aria-labelledby': 'todo-title' },
      h('h2', { id: 'todo-title' }, t('dash.attention')),
      items.length ? h('ul', { class: 'todo-list' }, items)
        : h('div', { class: 'todo-none' }, h('span', { class: 'todo-ico ok', html: icon('check') }), h('div', {}, h('strong', {}, t('dash.allGood')), h('div', { class: 'muted' }, t('dash.allGoodDetail')))));

  // State at a glance
  const lowN = (d.printersLow || []).length;
  const stateCard = h('section', { class: 'panel state-card', 'aria-label': t('dash.state') },
    devicesRow(d),
    mon.total ? stateRow('/monitoring', mon.down.length ? 'bad' : 'ok', t('nav.monitoring'), mon.total, mon.down.length ? t('dash.downN', { n: mon.down.length }) : t('dash.allUp')) : null,
    d.byType?.printer ? stateRow('/inventory?type=printer', lowN ? 'new' : 'ok', t('type.printer'), d.byType.printer, lowN ? t('dash.lowN', { n: lowN }) : t('dash.suppliesOk')) : null,
    d.telematik ? stateRow('/inventory?type=telematik', 'ti', t('dash.telematik'), d.telematik, t('dash.telematikNote')) : null);

  const recent = h('section', { class: 'panel panel-pad recent-card', 'aria-labelledby': 'recent-title' },
    h('h2', { id: 'recent-title', class: 'section-title' }, t('dash.recent')),
    d.recent.length ? h('ul', { class: 'recent' }, d.recent.slice(0, 5).map((r) => h('li', {},
      h('span', { class: 'when', title: fmtDate(r.at, lang) }, fmtAgo(r.at, t)),
      h('span', {}, h('a', { href: `/devices/${r.device_id}`, 'data-link': true }, r.device_name), ': ', historyText(r)))))
      : h('p', { class: 'muted', style: { margin: 0 } }, t('dash.noRecent')));

  const ls = d.lastScan;
  const scanLine = h('p', { class: 'muted small scan-line' }, ls
    ? t('dash.lastScanLine', { when: fmtDate(ls.started_at, lang), n: ls.stats.probed ?? 0, s: Math.round((ls.stats.durationMs || 0) / 1000) })
    : t(canScan ? 'dash.noScan' : 'dash.noScanViewer'));

  const n = items.length;
  mount(main, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, state.boot.title && state.boot.title !== 'WhatsOnMyNet' ? state.boot.title : t('dash.title')),
        empty ? null : h('p', { class: 'lead' }, n ? t(n === 1 ? 'dash.lead1' : 'dash.leadN', { n }) : t('dash.leadNone'))),
      canScan && !empty ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/scan', 'data-link': true }, h('span', { html: icon('radar') }), t('dash.scanNow'))) : null),
    h('div', { class: 'dash' },
      attention,
      empty ? null : h('div', { class: 'stack' }, stateCard, recent, scanLine))));
}
