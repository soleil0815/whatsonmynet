// Status pages without login (Monitoring → Status pages, administrators): which groups and monitors a page shows,
// under which name, at which address and for which networks. The page itself is served by the server (/status/…).
import { h, mount, modal, toast, confirmDialog, fmtDate } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, fail } from '../app.js';
import { pageHead, field, input, select, btn, formData } from './common.js';
import { groupOf } from './monitoring.js';

export const pageUrl = (p) => `${location.origin}/status/${p.slug}`;

const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast(t('agent.copied')); } catch { toast(text); } };

export async function renderStatusPages(main, tabBar) {
  const admin = state.user.isAdmin;
  const [list, monitors] = await Promise.all([admin ? get('/status-pages') : [], get('/monitors')]);
  const reload = () => renderStatusPages(main, tabBar);
  const what = (p) => p.items.map((x) => (x.type === 'group' ? x.label || x.group : x.label || monitors.find((m) => m.id === x.id)?.name || `#${x.id}`));
  mount(main, h('div', { class: 'page' },
    pageHead(t('mon.tab.status'), t('sp.lead'), admin ? btn(t('sp.add'), { class: 'btn btn-primary', onclick: () => pageForm(null, monitors, reload) }, 'plus') : null),
    tabBar('status'),
    !admin ? h('section', { class: 'panel panel-pad' }, h('p', { class: 'muted', style: { margin: 0 } }, t('sp.adminOnly')))
      : h('section', { class: 'panel' }, list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, t('sp.name')), h('th', {}, t('sp.address')), h('th', {}, t('sp.shows')), h('th', {}))),
        h('tbody', {}, list.map((p) => h('tr', {},
          h('td', {}, h('span', { class: 'name' }, p.name), p.enabled ? null : h('span', { class: 'badge', style: { marginLeft: '6px' } }, t('sp.off'))),
          h('td', {}, h('div', { class: 'sp-url' },
            h('a', { href: pageUrl(p), target: '_blank', rel: 'noopener', class: 'mono small' }, p.access === 'link' ? `/status/${p.slug.slice(0, 6)}…` : `/status/${p.slug}`),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('sp.copy'), title: t('sp.copy'), html: icon('copy'), onclick: () => copy(pageUrl(p)) })),
          h('span', { class: 'muted small' }, [t(p.access === 'link' ? 'sp.accessLink' : 'sp.accessOpen'), p.networks.length ? t('sp.onlyNets', { n: p.networks.length }) : null].filter(Boolean).join(' · '))),
          h('td', { class: 'small' }, what(p).slice(0, 4).join(', ') + (p.items.length > 4 ? ` ${t('maint.more', { n: p.items.length - 4 })}` : '') || h('span', { class: 'muted' }, t('sp.nothing'))),
          h('td', { class: 'min' }, h('div', { class: 'actions' },
            btn(t('edit'), { class: 'btn btn-sm', onclick: () => pageForm(p, monitors, reload) }),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${p.name}`, html: icon('trash'), onclick: async () => {
              if (!await confirmDialog(t('delete'), t('sp.deleteConfirm', { name: p.name }), t('delete'), t('cancel'), { danger: true })) return;
              try { await del(`/status-pages/${p.id}`); reload(); } catch (e) { fail(e); }
            } }))))))))
        : h('div', { class: 'empty' }, h('p', {}, t('sp.empty')), btn(t('sp.add'), { class: 'btn btn-primary', onclick: () => pageForm(null, monitors, reload) }, 'plus')))));
}

/** The list of what a page shows: groups and single monitors, each under a name of its own, in this order */
function itemsEditor(start, monitors) {
  const items = start.map((x) => ({ ...x }));
  const box = h('div', { class: 'sp-items' });
  const groups = [...new Set(monitors.map(groupOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; draw(); };
  function row(x, i) {
    const members = monitors.filter((m) => m.type !== 'group' && groupOf(m).toLowerCase() === String(x.group || '').toLowerCase());
    const what = x.type === 'group'
      ? h('div', {}, h('strong', {}, t('sp.group', { name: x.group })), h('span', { class: 'muted small' }, ` · ${t('sp.members', { n: members.length })}`))
      : h('div', {}, h('strong', {}, byId.get(x.id)?.name || `#${x.id}`), h('span', { class: 'muted small' }, ` · ${t(`mon.type.${byId.get(x.id)?.type || 'http'}`)}`));
    const label = h('input', { type: 'text', value: x.label || '', maxlength: 80, placeholder: x.type === 'group' ? x.group : byId.get(x.id)?.name || '',
      'aria-label': t('sp.label'), oninput: (e) => { x.label = e.currentTarget.value; } });
    const each = x.type === 'group' ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!x.members, onchange: (e) => { x.members = e.currentTarget.checked; } }), t('sp.eachMember')) : null;
    return h('div', { class: 'sp-item' },
      h('div', { class: 'sp-item-main' }, what, h('label', { class: 'field' }, t('sp.label'), label), each),
      h('div', { class: 'sp-item-btns' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('sp.up'), html: icon('chevron-up'), disabled: i === 0, onclick: () => move(i, -1) }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('sp.down'), html: icon('chevron-down'), disabled: i === items.length - 1, onclick: () => move(i, 1) }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('delete'), html: icon('trash'), onclick: () => { items.splice(i, 1); draw(); } })));
  }
  const groupSel = h('select', { 'aria-label': t('sp.addGroup') }, h('option', { value: '' }, t('sp.addGroup')), groups.map((g) => h('option', { value: g }, g)));
  groupSel.addEventListener('change', () => { if (groupSel.value) items.push({ type: 'group', group: groupSel.value, label: '', members: false }); groupSel.value = ''; draw(); });
  const monSel = h('select', { 'aria-label': t('sp.addMonitor') }, h('option', { value: '' }, t('sp.addMonitor')),
    monitors.filter((m) => m.type !== 'group').sort((a, b) => a.name.localeCompare(b.name)).map((m) => h('option', { value: String(m.id) }, m.name)));
  monSel.addEventListener('change', () => { if (monSel.value) items.push({ type: 'monitor', id: Number(monSel.value), label: '' }); monSel.value = ''; draw(); });
  function draw() {
    mount(box, items.length ? items.map(row) : h('p', { class: 'muted small', style: { margin: 0 } }, t('sp.itemsNone')),
      h('div', { class: 'sp-add' }, groups.length ? groupSel : null, monSel));
  }
  draw();
  return { el: box, items: () => items.map((x) => (x.type === 'group' ? { type: 'group', group: x.group, label: x.label?.trim() || '', members: !!x.members } : { type: 'monitor', id: x.id, label: x.label?.trim() || '' })) };
}

function pageForm(p, monitors, done) {
  const v = p || { name: '', access: 'link', slug: '', networks: [], description: '', notice: '', notice_level: 'info', show_uptime: true, language: getLang() === 'en' ? 'en' : 'de', items: [], enabled: true };
  const access = select('access', [['link', t('sp.accessLink')], ['open', t('sp.accessOpen')]], v.access);
  const slugBox = h('div', { class: 'full' }, field(t('sp.slug'), input('slug', v.access === 'open' ? v.slug : '', { maxlength: 40, placeholder: 'it', class: 'mono', autocapitalize: 'off', spellcheck: 'false' }),
    t('sp.slugHint', { base: `${location.origin}/status/` })));
  const linkBox = h('div', { class: 'full note' }, h('div', {},
    h('p', { style: { margin: 0 } }, t(p?.access === 'link' ? 'sp.linkIs' : 'sp.linkNew')),
    p?.access === 'link' ? h('div', { class: 'sp-url', style: { marginTop: '6px' } }, h('code', { class: 'small' }, pageUrl(p)),
      btn(t('sp.copy'), { class: 'btn btn-sm', onclick: () => copy(pageUrl(p)) }, 'copy'),
      btn(t('sp.newLink'), { class: 'btn btn-sm', onclick: async () => {
        if (!await confirmDialog(t('sp.newLink'), t('sp.newLinkConfirm'), t('sp.newLink'), t('cancel'))) return;
        try { await post(`/status-pages/${p.id}/new-link`, {}); dlg.close(); toast(t('sp.newLinkDone')); done(); } catch (e) { fail(e); }
      } })) : null));
  const sync = () => { slugBox.hidden = access.value !== 'open'; linkBox.hidden = access.value !== 'link'; };
  access.addEventListener('change', sync);
  const items = itemsEditor(v.items, monitors);
  const form = h('form', { class: 'form-grid' },
    h('div', { class: 'full' }, field(t('sp.name'), input('name', v.name, { required: true, maxlength: 80, placeholder: t('sp.namePh') }), t('sp.nameHint'))),
    field(t('sp.access'), access),
    field(t('sp.language'), select('language', [['de', 'Deutsch'], ['en', 'English']], v.language)),
    slugBox, linkBox,
    h('div', { class: 'full' }, field(t('sp.networks'), h('textarea', { name: 'networks', rows: 2, class: 'mono', placeholder: '10.0.10.0/24' }, v.networks.join('\n')), t('sp.networksHint'))),
    h('div', { class: 'full field' }, t('sp.items'), items.el, h('span', { class: 'hint' }, t('sp.itemsHint'))),
    h('div', { class: 'full' }, field(t('sp.description'), h('textarea', { name: 'description', rows: 2, maxlength: 1000, placeholder: t('sp.descriptionPh') }, v.description))),
    h('div', { class: 'full' }, field(t('sp.notice'), h('textarea', { name: 'notice', rows: 2, maxlength: 1000, placeholder: t('sp.noticePh') }, v.notice), t('sp.noticeHint'))),
    field(t('sp.noticeLevel'), select('notice_level', [['info', t('sp.level.info')], ['warn', t('sp.level.warn')], ['bad', t('sp.level.bad')]], v.notice_level)),
    field(t('sp.showUptime'), h('input', { type: 'checkbox', name: 'show_uptime', checked: v.show_uptime })),
    field(t('sp.enabled'), h('input', { type: 'checkbox', name: 'enabled', checked: v.enabled }), p ? t('sp.updated', { when: fmtDate(p.updated_at, getLang()) }) : null));
  sync();
  const dlg = modal(p ? p.name : t('sp.add'), form, { wide: true, onSubmit: async () => {
    const d = formData(form);
    const body = { name: d.name, access: d.access, slug: d.slug, networks: d.networks, description: d.description, notice: d.notice, notice_level: d.notice_level,
      show_uptime: d.show_uptime, language: d.language, enabled: d.enabled, items: items.items() };
    try {
      const saved = p ? await put(`/status-pages/${p.id}`, body) : await post('/status-pages', body);
      dlg.close(); toast(t('saved')); done();
      if (!p) showLink(saved);
    } catch (e) { fail(e); }
  }, actions: [
    btn(t('cancel'), { onclick: () => dlg.close() }),
    h('button', { class: 'btn btn-primary', type: 'submit' }, t('save')),
  ] });
}

/** After the first save: where the page is now */
function showLink(p) {
  const dlg = modal(t('sp.readyTitle'), h('div', {},
    h('p', {}, t(p.access === 'link' ? 'sp.readyLink' : 'sp.readyOpen')),
    h('div', { class: 'sp-url' }, h('code', {}, pageUrl(p))),
    p.networks.length ? h('p', { class: 'muted small' }, t('sp.readyNets', { nets: p.networks.join(', ') })) : null), { actions: [
    btn(t('sp.copy'), { onclick: () => copy(pageUrl(p)) }, 'copy'),
    h('a', { class: 'btn btn-primary', href: pageUrl(p), target: '_blank', rel: 'noopener' }, t('sp.open')),
    btn(t('close'), { onclick: () => dlg.close() }),
  ] });
}
