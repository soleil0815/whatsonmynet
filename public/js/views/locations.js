// Locations with their subnets.
import { h, mount, modal, toast, confirmDialog, busy } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { state, fail } from '../app.js';
import { pageHead, field, input, btn } from './common.js';

export async function renderLocations(main) {
  const [list, net] = await Promise.all([get('/locations'), get('/network')]);
  const admin = state.user.isAdmin;
  const reload = () => renderLocations(main);

  const body = list.length ? list.map((l) => h('div', { class: 'loc-card' },
    h('span', { class: 'device-icon', style: { width: '40px', height: '40px' }, html: icon('location') }),
    h('div', { class: 'grow' },
      h('h2', {}, l.name),
      l.description ? h('p', { class: 'muted', style: { margin: '2px 0 6px' } }, l.description) : null,
      h('div', { class: 'chips' }, l.subnets.length
        ? l.subnets.map((s) => h('span', { class: 'port', title: s.label }, s.cidr, s.label ? ` · ${s.label}` : ''))
        : h('span', { class: 'muted small' }, t('loc.noSubnets'))),
      h('div', { class: 'small muted', style: { marginTop: '6px' } }, h('a', { href: `/inventory?location=${l.id}`, 'data-link': true }, t('loc.devices', { n: l.devices })))),
    admin ? h('div', { class: 'actions' },
      btn(t('edit'), { class: 'btn btn-sm', onclick: () => editor(l, net, reload) }, 'edit'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${l.name}`, html: icon('trash'), onclick: async () => {
        if (!await confirmDialog(t('delete'), t('loc.deleteConfirm', { name: l.name }), t('delete'), t('cancel'), { danger: true })) return;
        try { await del(`/locations/${l.id}`); toast(t('deleted')); reload(); } catch (e) { fail(e); }
      } })) : null))
    : h('div', { class: 'empty' }, h('p', {}, t('loc.empty')), admin ? btn(t('loc.add'), { class: 'btn btn-primary', onclick: () => editor(null, net, reload) }, 'plus') : null);

  mount(main, h('div', { class: 'page' },
    pageHead(t('loc.title'), t('loc.lead'), admin && list.length ? btn(t('loc.add'), { class: 'btn btn-primary', onclick: () => editor(null, net, reload) }, 'plus') : null),
    h('section', { class: 'panel' }, body)));
}

function editor(loc, net, done) {
  const rows = h('div', { style: { display: 'grid', gap: '8px' } });
  const addRow = (cidr = '', label = '') => {
    const row = h('div', { class: 'subnet-row' },
      input('cidr', cidr, { class: 'mono', placeholder: '192.168.1.0/24', 'aria-label': t('loc.subnet') }),
      input('label', label, { placeholder: t('loc.label'), 'aria-label': t('loc.label') }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('delete'), html: icon('trash'), onclick: () => row.remove() }));
    rows.append(row);
  };
  for (const s of loc?.subnets || []) addRow(s.cidr, s.label);
  if (!loc?.subnets?.length) addRow(loc ? '' : (net.suggestions[0] || ''));
  const name = input('name', loc?.name || '', { required: true, maxlength: 80 });
  const desc = input('description', loc?.description || '', { maxlength: 500 });
  const form = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
    field(t('loc.name'), name), field(t('loc.description'), desc),
    h('div', { class: 'field' }, t('loc.subnets'), rows,
      h('div', { class: 'actions' }, btn(t('loc.addSubnet'), { class: 'btn btn-sm', onclick: () => addRow() }, 'plus'),
        net.suggestions.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => addRow(c) }, c)))));
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save() }, t('save'));
  const m = modal(loc ? loc.name : t('loc.add'), form, { wide: true, actions: [
    btn(t('cancel'), { onclick: () => m.close() }),
    saveBtn,
  ] });
  name.focus();
  async function save() {
    if (!form.reportValidity()) return;
    const subnets = [...rows.querySelectorAll('.subnet-row')].map((r) => ({ cidr: r.querySelector('[name=cidr]').value.trim(), label: r.querySelector('[name=label]').value.trim() })).filter((s) => s.cidr);
    await busy(saveBtn, async () => {
      try {
        const body = { name: name.value, description: desc.value, subnets };
        if (loc) await put(`/locations/${loc.id}`, body); else await post('/locations', body);
        m.close();
        toast(t('saved'));
        done();
      } catch (e) { fail(e); }
    });
  }
}
