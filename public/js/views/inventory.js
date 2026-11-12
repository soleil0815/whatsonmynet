// Inventory list with search, filters and grouping.
import { h, mount, clear, debounce, fmtAgo, fmtDate, modal, toast, confirmDialog } from '../dom.js';
import { get, post } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { monitorDot } from './monitoring.js';
import { pageHead, typeChip, presenceDot, select, input, field, typeOptions, formData, btn, suggestionLists, wireModelAutofill } from './common.js';

const VIEW_KEY = 'womn-inv-view';

export async function renderInventory(main) {
  const params = new URLSearchParams(location.search);
  const [locations, sugg] = await Promise.all([get('/locations'), get('/devices/suggestions').catch(() => null)]);
  const types = state.meta?.types || [];
  const edit = state.user.canEdit;
  const selected = new Set();
  let shown = [];
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
    shown = list;
    for (const id of [...selected]) if (!list.some((d) => d.id === id)) selected.delete(id);
    renderBulk();
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
      if (view !== 'list') rows.push(h('tr', { class: 'group' }, h('td', { colspan: edit ? 9 : 8 }, `${k} · ${groups.get(k).length}`)));
      for (const d of groups.get(k)) rows.push(row(d));
    }
    mount(body, h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        edit ? h('th', { class: 'min' }, allBox) : null,
        h('th', {}, h('span', { class: 'sr' }, t('col.status'))), h('th', {}, t('col.name')), h('th', {}, t('col.type')), h('th', {}, t('col.ip')),
        h('th', { class: 'hide-sm' }, t('col.mac')), h('th', { class: 'hide-sm' }, t('col.vendor')), h('th', { class: 'hide-sm' }, t('col.lastSeen')), h('th', {}, h('span', { class: 'sr' }, t('open.web'))))),
      h('tbody', {}, rows)));
  }

  function row(d) {
    const open = () => navigate(`/devices/${d.id}`);
    const box = edit ? h('input', { type: 'checkbox', checked: selected.has(d.id), 'aria-label': `${t('inv.select')}: ${d.name}`,
      onchange: (e) => { if (e.target.checked) selected.add(d.id); else selected.delete(d.id); e.target.closest('tr').classList.toggle('sel', e.target.checked); renderBulk(); } }) : null;
    return h('tr', { class: `click${selected.has(d.id) ? ' sel' : ''}`, onclick: (e) => { if (!e.target.closest('a,input,label')) open(); } },
      edit ? h('td', { class: 'min' }, box) : null,
      h('td', { class: 'min' }, d.monitor ? monitorDot(d.monitor) : presenceDot(d.presence)),
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

  // Selection for editing several devices at once
  const allBox = h('input', { type: 'checkbox', 'aria-label': t('scan.selectAll'), onchange: (e) => {
    for (const d of shown) { if (e.target.checked) selected.add(d.id); else selected.delete(d.id); }
    load();
  } });
  const bulk = h('div', { class: 'bulk', hidden: true });
  function renderBulk() {
    allBox.checked = shown.length > 0 && shown.every((d) => selected.has(d.id));
    allBox.indeterminate = !allBox.checked && shown.some((d) => selected.has(d.id));
    bulk.hidden = !selected.size;
    if (!selected.size) return;
    mount(bulk, h('span', { class: 'count grow' }, t('scan.selected', { n: selected.size })),
      btn(t('inv.clearSel'), { class: 'btn btn-ghost btn-sm', onclick: () => { selected.clear(); load(); } }),
      btn(t('inv.bulkDelete'), { class: 'btn btn-danger btn-sm', onclick: bulkDelete }, 'trash'),
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => bulkEdit([...selected], locations, types, sugg, () => { selected.clear(); load(); }) },
        h('span', { html: icon('edit') }), t('inv.bulkEdit')));
  }
  async function bulkDelete() {
    if (!await confirmDialog(t('inv.bulkDelete'), t('inv.bulkDeleteConfirm', { n: selected.size }), t('delete'), t('cancel'), { danger: true })) return;
    try {
      const r = await post('/devices/bulk-delete', { ids: [...selected] });
      toast(t('inv.bulkDeleted', { n: r.deleted }));
      selected.clear();
      load();
    } catch (e) { fail(e); }
  }

  const reload = debounce(load, 220);
  q.addEventListener('input', reload);
  typeSel.addEventListener('change', load);
  locSel.addEventListener('change', load);

  mount(main, h('div', { class: 'page' },
    pageHead(t('inv.title'), null,
      edit ? btn(t('inv.add'), { onclick: () => addDevice(locations, types, sugg) }, 'plus') : null,
      csvLink, jsonLink),
    h('section', { class: 'panel' },
      h('div', { class: 'toolbar' }, h('div', { class: 'search' }, h('span', { html: icon('search') }), q), typeSel, locSel, seg, count),
      bulk,
      body)));
  clear(body).append(h('div', { class: 'empty' }, t('loading')));
  await load();
  if (q.value) q.focus();
}

function addDevice(locations, types, sugg) {
  const form = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'full' }, field(t('f.name'), input('name', '', { required: true, maxlength: 120 }))),
    field(t('f.type'), select('type', typeOptions(types), 'unknown')),
    field(t('f.location'), select('location_id', [['', t('none')], ...locations.map((l) => [String(l.id), l.name])], '')),
    field(t('f.ip'), input('ip', '', { class: 'mono', placeholder: '192.168.1.10' })),
    field(t('f.mac'), input('mac', '', { class: 'mono', placeholder: 'aa:bb:cc:dd:ee:ff' })),
    field(t('f.vendor'), input('vendor', '', { list: 'dl-vendor', autocomplete: 'off' })),
    field(t('f.model'), input('model', '', { list: 'dl-model', autocomplete: 'off' })),
    suggestionLists(sugg));
  wireModelAutofill(form, sugg);
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

/** Change several devices at once: only filled-in fields are changed, tags can be added or removed */
function bulkEdit(deviceIds, locations, types, sugg, done) {
  const KEEP = '__keep__';
  const keep = t('inv.keep');
  const form = h('form', { class: 'form-grid' },
    h('p', { class: 'full muted', style: { margin: 0 } }, t('inv.bulkLead', { n: deviceIds.length })),
    field(t('f.location'), select('location_id', [[KEEP, keep], ['', t('none')], ...locations.map((l) => [String(l.id), l.name])], KEEP)),
    field(t('f.type'), select('type', [[KEEP, keep], ...typeOptions(types)], KEEP)),
    field(t('f.vendor'), input('vendor', '', { list: 'dl-vendor', autocomplete: 'off', placeholder: keep })),
    field(t('f.model'), input('model', '', { list: 'dl-model', autocomplete: 'off', placeholder: keep })),
    field(t('f.os'), input('os', '', { list: 'dl-os', autocomplete: 'off', placeholder: keep })),
    field(t('f.owner'), input('owner', '', { list: 'dl-owner', autocomplete: 'off', placeholder: keep })),
    field(t('f.supplier'), input('supplier', '', { list: 'dl-supplier', autocomplete: 'off', placeholder: keep })),
    field(t('f.purchase_date'), input('purchase_date', '', { type: 'date' })),
    field(t('f.warranty_until'), input('warranty_until', '', { type: 'date' })),
    field(t('f.maintenance_until'), input('maintenance_until', '', { type: 'date' })),
    field(t('inv.tagsAdd'), input('tagsAdd', '', { list: 'dl-tags', autocomplete: 'off' }), t('f.tagsHint')),
    field(t('inv.tagsRemove'), input('tagsRemove', '', { list: 'dl-tags', autocomplete: 'off' }), t('f.tagsHint')),
    suggestionLists(sugg));
  wireModelAutofill(form, sugg);
  const dlg = modal(t('inv.bulkEdit'), form, { wide: true, actions: [
    btn(t('cancel'), { onclick: () => dlg.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
      const d = formData(form);
      const set = {};
      for (const k of ['location_id', 'type']) if (d[k] !== KEEP) set[k] = d[k];
      for (const k of ['vendor', 'model', 'os', 'owner', 'supplier', 'purchase_date', 'warranty_until', 'maintenance_until']) if (d[k].trim()) set[k] = d[k].trim();
      const split = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
      const body = { ids: deviceIds, set, tagsAdd: split(d.tagsAdd), tagsRemove: split(d.tagsRemove) };
      if (!Object.keys(set).length && !body.tagsAdd.length && !body.tagsRemove.length) { dlg.close(); return; }
      try {
        const r = await post('/devices/bulk', body);
        dlg.close();
        toast(t('inv.bulkSaved', { n: r.updated }));
        done();
      } catch (e) { fail(e); }
    } }, t('inv.bulkApply')),
  ] });
}
