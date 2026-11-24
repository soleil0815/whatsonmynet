// Overview: what needs attention first, then the state of everything at a glance.
import { h, mount, fmtAgo, fmtDate, toast } from '../dom.js';
import { get, put } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, fail } from '../app.js';
import { historyText } from './device.js';
import { supplyName, supplyValue } from './printer.js';
import { stText } from './snmpdev.js';
import { maintBadge } from '../maint.js';
import { shortcutLabel } from '../search.js';

// First steps of a new installation, in the order that makes sense; each one is ticked by the data itself
const STEPS = [
  ['location', 'location', '/locations'], ['scan', 'radar', '/scan'], ['devices', 'inventory', '/scan'],
  ['channel', 'bell', '/settings/notify'], ['monitor', 'pulse', '/monitoring'], ['totp', 'lock', '/account'],
];

/** "First steps" (administrators, until all is done or hidden): what to do next stands out, done steps are ticked */
function firstSteps(start, onHide) {
  const steps = STEPS.filter(([k]) => start[k] !== null && start[k] !== undefined);
  const done = steps.filter(([k]) => start[k]).length;
  if (done === steps.length) return null;
  const next = steps.find(([k]) => !start[k])?.[0];
  return h('section', { class: 'panel start-card', 'aria-labelledby': 'start-title' },
    h('div', { class: 'start-head' },
      h('div', {}, h('h2', { id: 'start-title' }, t('start.title')), h('p', { class: 'muted', style: { margin: '2px 0 0' } }, t('start.lead', { done, n: steps.length }))),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: onHide }, t('start.hide'))),
    h('div', { class: 'start-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': steps.length, 'aria-valuenow': done, 'aria-label': t('start.title') },
      h('i', { style: { width: `${Math.round((done / steps.length) * 100)}%` } })),
    h('ol', { class: 'start-list' }, steps.map(([k, ico, href]) => h('li', { class: start[k] ? 'done' : k === next ? 'next' : '' },
      h('span', { class: 'start-ico', html: icon(start[k] ? 'check' : ico) }),
      h('div', { class: 'start-text' }, h('div', { class: 'start-name' }, t(`start.${k}`)), start[k] ? null : h('div', { class: 'muted small' }, t(`start.${k}Hint`))),
      start[k] ? h('span', { class: 'muted small' }, t('start.done'))
        : h('a', { class: `btn btn-sm${k === next ? ' btn-primary' : ''}`, href, 'data-link': true }, t(`start.${k}Do`))))),
    h('p', { class: 'muted small start-tip' }, h('span', { html: icon('search') }), t('start.searchTip', { key: shortcutLabel() })));
}

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
    const value = supplyValue(s);
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
  const start = d.start ? firstSteps(d.start, async () => {
    try { await put('/settings/start', { hidden: true }); } catch (e) { fail(e); return; }
    renderDashboard(main);
    // hidden for good - unless undone right away
    toast(h('span', {}, t('start.hidden'), ' ', h('button', { type: 'button', class: 'btn btn-sm', onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      try { await put('/settings/start', { hidden: false }); if (location.pathname === '/') renderDashboard(main); } catch (e) { fail(e); }
    } }, t('start.undo'))), 'ok', 10000);
  }) : null;
  // a new installation: the first steps say what to do (instead of the empty "scan now" panel)
  const attention = empty && start ? null : empty
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
    // monitors not checked yet are neither fine nor down
    mon.total ? stateRow('/monitoring', mon.down.length ? 'bad' : mon.pending ? 'muted' : 'ok', t('nav.monitoring'), mon.total,
      mon.down.length ? t('dash.downN', { n: mon.down.length }) : mon.pending ? t('dash.pendingN', { n: mon.pending }) : t('dash.allUp')) : null,
    // what is in a maintenance window right now, calmly: name and until when
    mon.inMaintenance?.length ? h('div', { class: 'dash-maint' }, mon.inMaintenance.slice(0, 6).map((m) => h('a', { href: `/monitoring/${m.id}`, 'data-link': true, title: m.name },
      h('span', { class: 'name' }, m.name), ' ', maintBadge({ name: m.window, until: m.until }))),
      mon.inMaintenance.length > 6 ? h('span', { class: 'muted small' }, t('dash.more', { n: mon.inMaintenance.length - 6 })) : null) : null,
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
        empty ? null : h('p', { class: 'lead' }, n ? t(n === 1 ? 'dash.lead1' : 'dash.leadN', { n }) : mon.pending ? t('dash.leadPending', { n: mon.pending }) : t('dash.leadNone'))),
      canScan && !empty ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/scan', 'data-link': true }, h('span', { html: icon('radar') }), t('dash.scanNow'))) : null),
    start,
    h('div', { class: 'dash' },
      attention,
      empty ? null : h('div', { class: 'stack' }, stateCard, recent, scanLine))));
}
