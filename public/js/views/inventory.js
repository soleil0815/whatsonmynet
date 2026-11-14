// Inventory list with search, filters and grouping.
import { h, mount, clear, debounce, fmtAgo, fmtDate, modal, toast, confirmDialog } from '../dom.js';
import { get, post } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { pageHead, select, input, field, typeOptions, formData, btn, suggestionLists, wireModelAutofill } from './common.js';

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
  // Quick filters as chips: all, with problems, the most common kinds (the type list stays for everything else)
  let quick = params.get('filter') === 'problems' ? 'problems' : '';
  const chips = h('div', { class: 'inv-chips', role: 'group', 'aria-label': t('inv.filterType') });
  let counts = null;
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
  const csvLink = h('a', { href: '#', download: true }, t('inv.exportCsv'));
  const jsonLink = h('a', { href: '/api/devices/export.json', download: true }, t('inv.exportJson'));
  const exportMenu = h('details', { class: 'menu' }, h('summary', { class: 'btn' }, h('span', { html: icon('download') }), t('inv.export')), h('div', { class: 'menu-list' }, csvLink, jsonLink));

  const problem = (d) => d.monitor === 'down' || d.presence === 'missing';
  function renderChips() {
    if (!counts) return;
    const chip = (key, label, n, onclick, on, dot) => h('button', { type: 'button', class: `fchip${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick },
      dot ? h('span', { class: `dot ${dot}` }) : null, label, h('span', { class: 'chip-n' }, n));
    const top = Object.entries(counts.byType).sort((a, b) => b[1] - a[1]).slice(0, 5);
    mount(chips,
      chip('all', t('all'), counts.all, () => { quick = ''; typeSel.value = ''; load(); }, !quick && !typeSel.value),
      counts.problems ? chip('problems', t('inv.problems'), counts.problems, () => { quick = quick === 'problems' ? '' : 'problems'; load(); }, quick === 'problems', 'missing') : null,
      top.map(([type, n]) => chip(type, t(`type.${type}`), n, () => { typeSel.value = typeSel.value === type ? '' : type; load(); }, typeSel.value === type)));
  }

  async function load() {
    const qs = exportQuery();
    const urlQs = [qs, quick ? `filter=${quick}` : ''].filter(Boolean).join('&');
    history.replaceState({}, '', `/inventory${urlQs ? `?${urlQs}` : ''}`);
    csvLink.href = `/api/devices/export.csv?${qs}`;
    let list;
    try { list = await get(`/devices?${qs}`); } catch (e) { fail(e); return; }
    // the chip numbers count the whole inventory (with the search and location applied, not the kind)
    if (!typeSel.value) {
      counts = { all: list.length, problems: list.filter(problem).length, byType: {} };
      for (const d of list) counts.byType[d.type] = (counts.byType[d.type] || 0) + 1;
    }
    if (quick === 'problems') list = list.filter(problem);
    renderChips();
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
      if (view !== 'list') rows.push(h('tr', { class: 'group' }, h('td', { colspan: edit ? 7 : 6 }, `${k} · ${groups.get(k).length}`)));
      for (const d of groups.get(k)) rows.push(row(d));
    }
    mount(body, h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        edit ? h('th', { class: 'min' }, allBox) : null,
        h('th', {}, t('inv.col.device')), h('th', {}, t('col.ip')), h('th', { class: 'hide-sm' }, t('f.location')),
        h('th', {}, t('col.status')), h('th', { class: 'hide-sm' }, t('col.lastSeen')), h('th', {}, h('span', { class: 'sr' }, t('open.web'))))),
      h('tbody', {}, rows)));
  }

  function row(d) {
    const open = () => navigate(`/devices/${d.id}`);
    const box = edit ? h('input', { type: 'checkbox', checked: selected.has(d.id), 'aria-label': `${t('inv.select')}: ${d.name}`,
      onchange: (e) => { if (e.target.checked) selected.add(d.id); else selected.delete(d.id); e.target.closest('tr').classList.toggle('sel', e.target.checked); renderBulk(); } }) : null;
    // State in words: what a person wants to know at a glance
    const st = d.monitor === 'down' ? ['bad', t('inv.st.monitorDown')] : d.presence === 'missing' ? ['bad', t('inv.st.missing')]
      : d.monitor === 'unreachable' ? ['muted', t('mon.status.unreachable')] : d.monitor === 'paused' ? ['muted', t('mon.status.paused')] : d.presence === 'online' || d.monitor === 'up' ? ['ok', t('inv.st.ok')] : ['muted', t(`presence.${d.presence}`)];
    const sub = [t(`type.${d.type}`), d.model && d.model !== d.name ? d.model : d.vendor && d.vendor !== d.name ? d.vendor : ''].filter(Boolean).join(' · ');
    return h('tr', { class: `click${selected.has(d.id) ? ' sel' : ''}`, onclick: (e) => { if (!e.target.closest('a,input,label')) open(); } },
      edit ? h('td', { class: 'min' }, box) : null,
      h('td', {}, h('div', { class: 'inv-dev' }, h('span', { class: `inv-ico${d.telematik ? ' ti' : ''}`, html: icon(d.type) }),
        h('div', { style: { minWidth: 0 } }, h('a', { href: `/devices/${d.id}`, 'data-link': true, class: 'name', style: { color: 'inherit', textDecoration: 'none' } }, d.name),
          h('div', { class: 'sub' }, sub)))),
      h('td', { class: 'mono', title: d.mac || '' }, d.ip || '–'),
      h('td', { class: 'hide-sm' }, d.location_name || h('span', { class: 'muted' }, '–')),
      h('td', {}, h('span', { class: `inv-st tone-${st[0]}` }, st[1])),
      h('td', { class: 'hide-sm muted', title: d.last_seen ? fmtDate(d.last_seen, getLang()) : '' }, fmtAgo(d.last_seen, t)),
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

  // Probably one device twice (same host name - e.g. both cards of a NAS adopted): a tip with "merge"
  const dupBox = h('div');
  async function loadDuplicates() {
    let list = [];
    try { ({ list } = await get('/devices/duplicates')); } catch { /* the tip is optional */ }
    if (!list.length) { mount(dupBox); return; }
    const link = (d) => h('a', { href: `/devices/${d.id}`, 'data-link': true }, d.name);
    mount(dupBox, h('div', { class: 'note warn dup-note' }, h('div', {},
      h('strong', {}, t('inv.dupTitle', { n: list.length })),
      h('p', { style: { margin: '4px 0 8px' } }, t('inv.dupLead')),
      h('ul', { class: 'dup-list' }, list.map((p) => h('li', {},
        link(p.keep), h('span', { class: 'muted small' }, ` ${p.keep.ip || ''}`), ' · ', link(p.drop), h('span', { class: 'muted small' }, ` ${p.drop.ip || ''}`),
        edit ? h('button', { type: 'button', class: 'btn btn-sm', style: { marginLeft: '10px' }, onclick: async (e) => {
          const b = e.currentTarget;
          if (!await confirmDialog(t('inv.dupMerge'), t('inv.dupMergeConfirm', { from: p.drop.name, to: p.keep.name }), t('inv.dupMerge'), t('cancel'))) return;
          b.disabled = true;
          try {
            const r = await post(`/devices/${p.keep.id}/merge`, { from: p.drop.id });
            toast(r.monitorsMerged ? `${t('inv.dupMerged', { name: p.keep.name })} · ${t('inv.dupMonitorsMerged', { n: r.monitorsMerged })}` : t('inv.dupMerged', { name: p.keep.name }));
            loadDuplicates(); load();
          } catch (ex) { fail(ex); b.disabled = false; }
        } }, t('inv.dupMerge')) : null))))));
  }

  mount(main, h('div', { class: 'page' },
    pageHead(t('inv.title'), null, exportMenu,
      edit ? btn(t('inv.add'), { class: 'btn btn-primary', onclick: () => addDevice(locations, types, sugg) }, 'plus') : null),
    dupBox,
    h('div', { class: 'inv-filter' }, h('div', { class: 'search' }, h('span', { html: icon('search') }), q), chips),
    h('section', { class: 'panel' },
      h('div', { class: 'toolbar' }, typeSel, locations.length > 1 ? locSel : null, seg, count),
      bulk,
      body)));
  clear(body).append(h('div', { class: 'empty' }, t('loading')));
  loadDuplicates();
  await load();
  if (q.value) q.focus();
}

function addDevice(locations, types, sugg) {
  const form = h('form', { class: 'form-grid' },
    h('div', { class: 'full' }, field(t('f.name'), input('name', '', { required: true, maxlength: 120 }))),
    field(t('f.type'), select('type', typeOptions(types), 'unknown')),
    field(t('f.location'), select('location_id', [['', t('none')], ...locations.map((l) => [String(l.id), l.name])], '')),
    field(t('f.ip'), input('ip', '', { class: 'mono', placeholder: '192.168.1.10' })),
    field(t('f.mac'), input('mac', '', { class: 'mono', placeholder: 'aa:bb:cc:dd:ee:ff' })),
    field(t('f.vendor'), input('vendor', '', { list: 'dl-vendor', autocomplete: 'off' })),
    field(t('f.model'), input('model', '', { list: 'dl-model', autocomplete: 'off' })),
    suggestionLists(sugg));
  wireModelAutofill(form, sugg);
  const m = modal(t('inv.add'), form, { wide: true, onSubmit: save, actions: [
    btn(t('cancel'), { onclick: () => m.close() }),
    h('button', { class: 'btn btn-primary', type: 'submit' }, t('save')),
  ] });
  async function save() {
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
  const dlg = modal(t('inv.bulkEdit'), form, { wide: true, onSubmit: async () => {
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
  }, actions: [
    btn(t('cancel'), { onclick: () => dlg.close() }),
    h('button', { class: 'btn btn-primary', type: 'submit' }, t('inv.bulkApply')),
  ] });
}
