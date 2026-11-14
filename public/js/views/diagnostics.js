// Settings → Diagnostics: the diagnostic package (download) and what a placeholder of an anonymised package stands for.
import { h, mount, toast } from '../dom.js';
import { get } from '../api.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { fail } from '../app.js';
import { field, btn } from './common.js';

const PERIODS = [1, 3, 7, 14, 30, 0];

export async function diagnosticsSettings(body) {
  let info = { aliases: 0, keepDays: 30 };
  try { info = await get('/diagnostics'); } catch (e) { fail(e); }
  const days = h('select', { name: 'days' }, PERIODS.map((d) => h('option', { value: String(d), selected: d === 7 }, d ? t('diag.days', { n: d }) : t('diag.sinceUpdate'))));
  const anon = h('input', { type: 'checkbox', name: 'anon', checked: true });
  const warn = h('p', { class: 'note warn', hidden: true }, t('diag.notAnonWarn'));
  anon.addEventListener('change', () => { warn.hidden = anon.checked; });
  const link = () => `/api/diagnostics/package?days=${encodeURIComponent(days.value)}&anon=${anon.checked ? 1 : 0}`;
  const dl = h('a', { class: 'btn btn-primary', href: link(), download: '' }, h('span', { html: icon('download') }), t('diag.download'));
  const refresh = () => { dl.href = link(); };
  days.addEventListener('change', refresh);
  anon.addEventListener('change', refresh);

  const q = h('input', { type: 'search', placeholder: 'GERAET-001, 10.99.0.7 …', 'aria-label': t('diag.lookup'), maxlength: 200 });
  const out = h('div', { class: 'diag-lookup', 'aria-live': 'polite' });
  async function lookup(e) {
    e?.preventDefault();
    if (!q.value.trim()) { mount(out); return; }
    try {
      const { list } = await get(`/diagnostics/lookup?q=${encodeURIComponent(q.value.trim())}`);
      mount(out, list.length ? h('dl', { class: 'kv' }, list.map((x) => [h('dt', {}, x.alias), h('dd', {}, x.real, h('span', { class: 'muted small' }, ` · ${t(`diag.kind.${x.kind}`) === `diag.kind.${x.kind}` ? x.kind : t(`diag.kind.${x.kind}`)}`))]))
        : h('p', { class: 'muted' }, t('diag.lookupNone')));
    } catch (ex) { fail(ex); }
  }

  mount(body,
    h('section', { class: 'panel panel-pad' },
      h('h2', { class: 'section-title' }, t('diag.title')),
      h('p', { class: 'muted', style: { marginTop: 0 } }, t('diag.lead', { days: info.keepDays })),
      h('div', { class: 'form-grid' },
        field(t('diag.period'), days, t('diag.periodHint')),
        h('div', { class: 'full' }, field(t('diag.anon'), anon, t('diag.anonHint')))),
      warn,
      h('div', { class: 'actions' }, dl),
      h('p', { class: 'note', style: { marginBottom: 0 } }, t('diag.never'))),
    h('section', { class: 'panel panel-pad', style: { marginTop: '16px' } },
      h('h2', { class: 'section-title' }, t('diag.lookupTitle')),
      h('p', { class: 'muted', style: { marginTop: 0 } }, t('diag.lookupLead', { n: info.aliases })),
      h('form', { class: 'diag-search', onsubmit: lookup }, q, btn(t('diag.lookupBtn'), { type: 'submit' }, 'search')),
      out,
      info.aliases ? h('div', { class: 'actions' }, h('a', { class: 'btn btn-sm', href: '/api/diagnostics/aliases.csv', download: '', onclick: () => toast(t('diag.csvNote')) }, t('diag.csv'))) : null));
}
