// Inventory list with search, filters and grouping.
import { h, mount, clear, debounce, fmtAgo, fmtDate, modal, toast } from '../dom.js';
import { get, post } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { pageHead, typeChip, presenceDot, select, input, field, typeOptions, formData, btn } from './common.js';

const VIEW_KEY = 'womn-inv-view';

export async function renderInventory(main) {
  const params = new URLSearchParams(location.search);
  const locations = await get('/locations');
  const types = state.meta?.types || [];
  let view = 'list';
  try { view = localStorage.getItem(VIEW_KEY) || 'list'; } catch { /* storage blocked */ }

  const q = input('q', params.get('q') || '', { type: 'search', placeholder: t('inv.search'), 'aria-label': t('inv.search') });
  const typeSel = select('type', [['', `${t('inv.filterType')}: ${t('all')}`], ['telematik', t('type.telematik')], ...typeOptions(types)], params.get('type') || '', { 'aria-label': t('inv.filterType') });
  const locSel = select('location', [['', `${t('inv.filterLocation')}: ${t('all')}`], ['none', t('inv.noLocation')], ...locations.map((l) => [String(l.id), l.name])], params.get('location') || '', { 'aria-label': t('inv.filterLocation') });
  const count = h('span', { class: 'count' });
  const body = h('div', { class: 'table-wrap' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
    ['list', 'subnet', 'type'].map((v) => h('button', { type: 'button', class: view === v ? 'on' : '', 'aria-pressed': String(view === v),
      onclick: (e) => { view = v; try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ }
        seg.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); }); load(); } },
    t(`inv.view.${v}`))));

  const exportQuery = () => new URLSearchParams(Object.entries({ q: q.value.trim(), type: typeSel.value, location: locSel.value }).filter(([, v]) => v)).toString();
  const csvLink = h('a', { class: 'btn', href: '#', download: true }, h('span', { html: icon('download') }), t('inv.exportCsv'));
  const jsonLink = h('a', { class: 'btn btn-ghost', href: '/api/devices/export.json', download: true }, t('inv.exportJson'));

  async function load() {
    const qs = exportQuery();
    history.replaceState({}, '', `/inventory${qs ? `?${qs}` : ''}`);
    csvLink.href = `/api/devices/export.csv?${qs}`;
    let list;
    try { list = await get(`/devices?${qs}`); } catch (e) { fail(e); return; }
    count.textContent = t('inv.count', { n: list.length });
    if (!list.length) {
      const all = !q.value && !typeSel.value && !locSel.value;
      mount(body, h('div', { class: 'empty' }, h('p', {}, t(all ? 'inv.emptyAll' : 'inv.empty')),
        all && state.user.canEdit ? h('a', { class: 'btn btn-primary', href: '/scan', 'data-link': true }, h('span', { html: icon('radar') }), t('dash.scanNow')) : null));
      return;
    }
    const groups = new Map();
    for (const d of list) {
      const key = view === 'subnet' ? (d.ip ? `${d.ip.split('.').slice(0, 3).join('.')}.0/24` : '–')
        : view === 'type' ? t(`type.${d.type}`) : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    const keys = [...groups.keys()];
    if (view === 'type') keys.sort((a, b) => a.localeCompare(b));
    const rows = [];
    for (const k of keys) {
      if (view !== 'list') rows.push(h('tr', { class: 'group' }, h('td', { colspan: 8 }, `${k} · ${groups.get(k).length}`)));
      for (const d of groups.get(k)) rows.push(row(d));
    }
    mount(body, h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', {}, h('span', { class: 'sr' }, t('col.status'))), h('th', {}, t('col.name')), h('th', {}, t('col.type')), h('th', {}, t('col.ip')),
        h('th', { class: 'hide-sm' }, t('col.mac')), h('th', { class: 'hide-sm' }, t('col.vendor')), h('th', { class: 'hide-sm' }, t('col.lastSeen')), h('th', {}, h('span', { class: 'sr' }, t('open.web'))))),
      h('tbody', {}, rows)));
  }

  function row(d) {
    const open = () => navigate(`/devices/${d.id}`);
    return h('tr', { class: 'click', onclick: (e) => { if (!e.target.closest('a')) open(); } },
      h('td', { class: 'min' }, presenceDot(d.presence)),
      h('td', {}, h('a', { href: `/devices/${d.id}`, 'data-link': true, class: 'name', style: { color: 'inherit', textDecoration: 'none' } }, d.name),
        d.hostname && d.hostname.split('.')[0].toLowerCase() !== d.name.toLowerCase() ? h('div', { class: 'sub' }, d.hostname) : null,
        d.location_name ? h('div', { class: 'sub' }, d.location_name) : null),
      h('td', {}, typeChip(d.type)),
      h('td', { class: 'mono' }, d.ip || '–'),
      h('td', { class: 'mono hide-sm' }, d.mac || '–'),
      h('td', { class: 'hide-sm' }, d.vendor || (d.model ? null : h('span', { class: 'muted' }, '–')), d.model ? h('div', { class: d.vendor ? 'sub' : '' }, d.model) : null),
      h('td', { class: 'hide-sm', title: d.last_seen ? fmtDate(d.last_seen, getLang()) : '' }, fmtAgo(d.last_seen, t)),
      h('td', { class: 'min' }, d.web_url ? h('a', { class: 'icon-btn', href: d.web_url, target: '_blank', rel: 'noopener noreferrer', title: t('open.web'), 'aria-label': `${t('open.web')}: ${d.name}`, html: icon('open') }) : null));
  }

  const reload = debounce(load, 220);
  q.addEventListener('input', reload);
  typeSel.addEventListener('change', load);
  locSel.addEventListener('change', load);

  mount(main, h('div', { class: 'page' },
    pageHead(t('inv.title'), null,
      state.user.canEdit ? btn(t('inv.add'), { onclick: () => addDevice(locations, types) }, 'plus') : null,
      csvLink, jsonLink),
    h('section', { class: 'panel' },
      h('div', { class: 'toolbar' }, h('div', { class: 'search' }, h('span', { html: icon('search') }), q), typeSel, locSel, seg, count),
      body)));
  clear(body).append(h('div', { class: 'empty' }, t('loading')));
  await load();
  if (q.value) q.focus();
}

function addDevice(locations, types) {
  const form = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'full' }, field(t('f.name'), input('name', '', { required: true, maxlength: 120 }))),
    field(t('f.type'), select('type', typeOptions(types), 'unknown')),
    field(t('f.location'), select('location_id', [['', t('none')], ...locations.map((l) => [String(l.id), l.name])], '')),
    field(t('f.ip'), input('ip', '', { class: 'mono', placeholder: '192.168.1.10' })),
    field(t('f.mac'), input('mac', '', { class: 'mono', placeholder: 'aa:bb:cc:dd:ee:ff' })),
    field(t('f.vendor'), input('vendor')),
    field(t('f.model'), input('model')));
  const m = modal(t('inv.add'), form, { wide: true, actions: [
    btn(t('cancel'), { onclick: () => m.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save() }, t('save')),
  ] });
  async function save() {
    if (!form.reportValidity()) return;
    try {
      const d = await post('/devices', formData(form));
      m.close();
      toast(t('saved'));
      navigate(`/devices/${d.id}`);
    } catch (e) { fail(e); }
  }
}
