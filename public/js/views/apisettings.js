// Settings → Prometheus & Grafana: keys for /metrics (shown once), the scrape configuration, the Grafana dashboard.
import { h, mount, modal, toast, confirmDialog, fmtDate } from '../dom.js';
import { get, post, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, fail } from '../app.js';
import { field, input, btn, formData } from './common.js';

const copyBtn = (text) => btn(t('agent.copy'), { class: 'btn btn-sm', onclick: async () => { try { await navigator.clipboard.writeText(text); toast(t('agent.copied')); } catch { /* not allowed */ } } });
const codeBox = (text) => h('div', { class: 'cmd-box' }, h('pre', { class: 'mono' }, text), copyBtn(text));

/** prometheus.yml for this server; the key goes in as written (or as placeholder) */
export function scrapeConfig(host, key) {
  return ['scrape_configs:', '  - job_name: whatsonmynet', '    scheme: https', '    metrics_path: /metrics', '    scrape_interval: 60s',
    '    authorization:', `      credentials: ${key}`, '    tls_config:', '      ca_file: /etc/prometheus/whatsonmynet.crt   # ' + t('api.caComment'),
    '    static_configs:', `      - targets: ['${host}']`].join('\n');
}

export async function apiSettings(body, _s, reload) {
  const { list } = await get('/apitokens');
  const host = location.host;
  const create = () => {
    const form = h('form', { class: 'form' }, field(t('api.name'), input('name', '', { required: true, maxlength: 60, placeholder: 'Prometheus' }), t('api.nameHint')));
    const m = modal(t('api.create'), form, { onSubmit: async () => {
      try {
        const r = await post('/apitokens', formData(form));
        m.close();
        let shown = null;
        shown = modal(t('api.created'), h('div', {},
          h('p', { style: { marginTop: 0 } }, t('api.onlyOnce')),
          codeBox(r.token),
          h('h3', { class: 'px-step' }, t('api.config')),
          codeBox(scrapeConfig(host, r.token))), { wide: true, onClose: reload, actions: [btn(t('api.done'), { class: 'btn btn-primary', onclick: () => shown.close() })] });
      } catch (ex) { fail(ex); }
    }, actions: [btn(t('cancel'), { onclick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit' }, t('api.create'))] });
  };
  const download = (path, file) => h('a', { class: 'btn btn-sm', href: `/api${path}`, download: file }, h('span', { html: icon('download') }), t(file.endsWith('.crt') ? 'api.cert' : 'api.dashboard'));
  mount(body,
    h('section', { class: 'panel panel-pad' },
      h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '8px' } }, h('h2', { style: { margin: 0 } }, t('set.api')),
        state.user.isAdmin ? btn(t('api.create'), { class: 'btn btn-primary btn-sm', onclick: create }, 'plus') : null),
      h('p', { class: 'muted', style: { marginTop: 0 } }, t('api.lead')),
      list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, t('api.name')), h('th', {}, t('api.key')), h('th', { class: 'hide-sm' }, t('api.createdAt')), h('th', {}, t('api.lastUsed')), h('th', {}))),
        h('tbody', {}, list.map((x) => h('tr', {},
          h('td', {}, h('span', { class: 'name' }, x.name)),
          h('td', { class: 'mono small' }, `${x.prefix}…`),
          h('td', { class: 'hide-sm small' }, fmtDate(x.created_at, getLang())),
          h('td', { class: 'small' }, x.last_used ? fmtDate(x.last_used, getLang()) : h('span', { class: 'muted' }, t('api.never'))),
          h('td', { class: 'min' }, h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${x.name}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('api.deleteConfirm', { name: x.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/apitokens/${x.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
          } }))))))) : h('p', { class: 'muted small' }, t('api.none'))),
    h('section', { class: 'panel panel-pad' },
      h('h3', { class: 'sub-title', style: { marginTop: 0 } }, t('api.prometheus')),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, t('api.prometheusText')),
      codeBox(scrapeConfig(host, 'womn_…')),
      h('div', { class: 'actions', style: { justifyContent: 'flex-start', marginTop: '10px' } }, download('/server-certificate.crt', 'whatsonmynet.crt')),
      h('h3', { class: 'sub-title' }, t('api.grafana')),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, t('api.grafanaText')),
      h('div', { class: 'actions', style: { justifyContent: 'flex-start' } }, download('/grafana-dashboard.json', 'whatsonmynet-grafana.json')),
      h('h3', { class: 'sub-title' }, t('api.metrics')),
      h('ul', { class: 'small', style: { margin: 0, paddingLeft: '18px' } }, ['womn_monitor_up', 'womn_monitor_state', 'womn_monitor_down_seconds', 'womn_monitor_response_seconds', 'womn_sensor_value',
        'womn_cert_expiry_timestamp_seconds', 'womn_devices', 'womn_events_stored', 'womn_info'].map((n) => h('li', {}, h('code', {}, n), ` - ${t(`api.m.${n}`)}`)))));
}
