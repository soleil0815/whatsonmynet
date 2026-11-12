// Overview: what is in the inventory, what the last scan found, what changed.
import { h, mount, fmtAgo, fmtDate } from '../dom.js';
import { get } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon, LOGO_MARK } from '../icons.js';
import { state } from '../app.js';
import { pageHead, TI } from './common.js';
import { historyText } from './device.js';

export async function renderDashboard(main) {
  const d = await get('/dashboard');
  state.waiting = d.waiting;
  const canScan = state.user.canEdit;
  const scanBtn = canScan ? h('a', { class: 'btn btn-primary btn-big', href: '/scan', 'data-link': true }, h('span', { html: icon('radar') }), t('dash.scanNow')) : null;

  const figures = h('div', { class: 'figures' },
    h('a', { class: 'figure', href: '/inventory', 'data-link': true }, h('b', {}, d.devices), h('span', {}, t('dash.devices'))),
    h('div', { class: 'figure' }, h('b', {}, d.online), h('span', {}, t('dash.online'))),
    d.missing ? h('a', { class: 'figure bad', href: '/inventory', 'data-link': true }, h('b', {}, d.missing), h('span', {}, t('dash.missing'))) : null,
    d.waiting ? h('a', { class: 'figure alert', href: d.lastScan ? `/scan/${d.lastScan.id}` : '/scan', 'data-link': true }, h('b', {}, d.waiting), h('span', {}, t('dash.waiting'))) : null,
    d.telematik ? h('a', { class: 'figure ti', href: '/inventory?type=telematik', 'data-link': true }, h('b', {}, d.telematik), h('span', {}, t('dash.telematik'))) : null,
  );

  const types = Object.entries(d.byType).sort((a, b) => b[1] - a[1]);
  const typePanel = h('section', { class: 'panel' },
    h('h2', {}, t('dash.byType')),
    types.length
      ? h('div', { class: 'typegrid' }, types.map(([type, n]) => h('a', { href: `/inventory?type=${encodeURIComponent(type)}`, 'data-link': true, class: TI.has(type) ? 'ti' : '' },
        h('span', { html: icon(type) }), t(`type.${type}`), h('b', {}, n))))
      : h('div', { class: 'empty' },
        h('h2', {}, t('dash.emptyTitle')), h('p', {}, t('dash.emptyText')), d.lastScan ? null : scanBtn));

  const ls = d.lastScan;
  const scanPanel = h('section', { class: 'panel' },
    h('div', { class: 'scan-cta' },
      h('span', { html: LOGO_MARK }),
      h('div', {},
        h('h2', {}, t('dash.lastScan')),
        ls ? h('p', {}, `${fmtDate(ls.started_at, getLang())} · ${ls.targets.map((x) => x.cidr).join(', ')}`, h('br'),
          `${t('dash.found', { n: ls.stats.probed ?? 0 })} · ${t('dash.duration', { s: Math.round((ls.stats.durationMs || 0) / 1000) })}`)
          : h('p', {}, t('dash.noScan')),
        h('div', { class: 'actions' },
          scanBtn ? h('a', { class: 'btn btn-primary', href: '/scan', 'data-link': true }, h('span', { html: icon('radar') }), t('dash.scanNow')) : null,
          ls && d.waiting ? h('a', { class: 'btn', href: `/scan/${ls.id}`, 'data-link': true }, t('dash.waitingAction'), h('span', { class: 'badge badge-new' }, d.waiting)) : null))));

  const recent = h('section', { class: 'panel' },
    h('h2', {}, t('dash.recent')),
    d.recent.length ? h('ul', { class: 'feed' }, d.recent.map((r) => h('li', {},
      h('a', { href: `/devices/${r.device_id}`, 'data-link': true }, r.device_name),
      h('span', { class: 'when', title: fmtDate(r.at, getLang()) }, fmtAgo(r.at, t)),
      h('span', { class: 'what' }, historyText(r)))))
      : h('p', { class: 'panel-pad muted' }, t('dash.noRecent')));

  const warranty = d.warranty.length ? h('section', { class: 'panel' },
    h('h2', {}, t('dash.warranty')),
    h('ul', { class: 'feed' }, d.warranty.map((w) => h('li', {},
      h('a', { href: `/devices/${w.id}`, 'data-link': true }, w.name),
      h('span', { class: 'when' }, fmtDate(w.warranty_until, getLang(), false)))))) : null;

  mount(main, h('div', { class: 'page' },
    pageHead(state.boot.title && state.boot.title !== 'WhatsOnMyNet' ? state.boot.title : t('dash.title'), null),
    h('div', { class: 'stack' },
      figures,
      h('div', { class: 'dash' },
        h('div', { class: 'stack' }, typePanel, recent),
        h('div', { class: 'stack' }, scanPanel, warranty)))));
}
