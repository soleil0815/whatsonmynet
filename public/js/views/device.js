// One device: details (editable), what the scan found, history, deep check.
import { h, mount, fmtDate, fmtAgo, toast, confirmDialog } from '../dom.js';
import { get, patch, del, post } from '../api.js';
import { t, getLang, reasonText } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { monitorDot, statusPill, openMonitorForm } from './monitoring.js';
import { printerPanel } from './printer.js';
import { switchPanel, nasPanel, pluggedLine } from './snmpdev.js';
import { typeChip, presenceDot, field, input, select, typeOptions, formData, btn, confidenceBar, portList, TI, suggestionLists, wireModelAutofill, tagChips } from './common.js';

const FIELD_LABEL = (f) => t(`f.${f}`) !== `f.${f}` ? t(`f.${f}`) : f;

export function historyText(r) {
  const d = r.detail || {};
  switch (r.kind) {
    case 'created': return d.source === 'manual' ? t('hist.createdManual') : t('hist.created');
    case 'ip': return t('hist.ip', { from: d.from || '–', to: d.to || '–' });
    case 'change': return t('hist.change', { field: FIELD_LABEL(d.field), from: d.from || '–', to: d.to || '–' });
    case 'edit': return t('hist.edit', { fields: (d.fields || []).map((f) => FIELD_LABEL(f.field)).join(', ') });
    case 'deep': return t('hist.deep', { n: d.ports ?? 0 });
    default: return r.kind;
  }
}

export async function renderDevice(main, id) {
  const [d, locations, sugg] = await Promise.all([get(`/devices/${id}`), get('/locations'), get('/devices/suggestions').catch(() => null)]);
  const types = state.meta?.types || [];
  const services = state.meta?.services || {};
  const edit = state.user.canEdit;
  const ti = TI.has(d.type);
  const ro = edit ? {} : { disabled: true };
  const f = d.facts || {};
  const presence = d.presence || 'unknown';

  const tagsInput = input('tags', d.tags, ro);
  const form = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'full' }, field(t('f.name'), input('name', d.name, { required: true, maxlength: 120, ...ro }))),
    field(t('f.type'), select('type', typeOptions(types), d.type, ro)),
    field(t('f.location'), select('location_id', [['', t('none')], ...locations.map((l) => [String(l.id), l.name])], d.location_id ? String(d.location_id) : '', ro)),
    field(t('f.ip'), input('ip', d.ip || '', { class: 'mono', ...ro })),
    field(t('f.mac'), input('mac', d.mac || '', { class: 'mono', ...ro })),
    field(t('f.vendor'), input('vendor', d.vendor, { list: 'dl-vendor', autocomplete: 'off', ...ro })),
    field(t('f.model'), input('model', d.model, { list: 'dl-model', autocomplete: 'off', ...ro })),
    field(t('f.hostname'), input('hostname', d.hostname, ro)),
    field(t('f.os'), input('os', d.os, { list: 'dl-os', autocomplete: 'off', ...ro })),
    field(t('f.owner'), input('owner', d.owner, { list: 'dl-owner', autocomplete: 'off', ...ro })),
    h('div', {}, field(t('f.tags'), tagsInput, t('f.tagsHint')), edit ? tagChips(tagsInput, sugg?.tags) : null),
    h('div', { class: 'full' }, field(t('f.web_url'), input('web_url', d.web_url, { class: 'mono', ...ro }), t('f.web_urlHint'))),
    h('div', { class: 'full' }, field(t('f.notes'), h('textarea', { name: 'notes', ...ro }, d.notes))),
    h('h3', { class: 'full section-title' }, t('dev.purchase')),
    field(t('f.serial'), input('serial', d.serial, ro)),
    field(t('f.supplier'), input('supplier', d.supplier, { list: 'dl-supplier', autocomplete: 'off', ...ro })),
    field(t('f.purchase_date'), input('purchase_date', d.purchase_date || '', { type: 'date', ...ro })),
    field(t('f.warranty_until'), input('warranty_until', d.warranty_until || '', { type: 'date', ...ro })),
    field(t('f.maintenance_until'), input('maintenance_until', d.maintenance_until || '', { type: 'date', ...ro })),
    edit ? h('div', { class: 'full actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))) : null,
    suggestionLists(sugg));
  wireModelAutofill(form, sugg);

  async function save() {
    if (!form.reportValidity()) return;
    try {
      await patch(`/devices/${d.id}`, formData(form));
      toast(t('saved'));
      renderDevice(main, id);
    } catch (e) { fail(e); }
  }

  async function deep(button) {
    button.disabled = true;
    try {
      const r = await post(`/devices/${d.id}/deep`);
      toast(t('dev.deepStarted'));
      const poll = async () => {
        const s = await get(`/scans/${r.id}`);
        if (s.status === 'running') { setTimeout(poll, 1500); return; }
        toast(t('dev.deepDone'));
        if (location.pathname === `/devices/${id}`) renderDevice(main, id);
      };
      setTimeout(poll, 1500);
    } catch (e) { fail(e); button.disabled = false; }
  }

  async function remove() {
    if (!await confirmDialog(t('dev.delete'), t('dev.deleteConfirm', { name: d.name }), t('delete'), t('cancel'), { danger: true })) return;
    try { await del(`/devices/${d.id}`); toast(t('deleted')); navigate('/inventory'); } catch (e) { fail(e); }
  }

  const c = f.classification || {};
  const hasFacts = !!(f.ports || f.snmp || f.http);
  // Web interfaces found by the scan, plus the quick access address when it was entered by hand
  const sameTarget = (a, b) => {
    try {
      const x = new URL(a); const y = new URL(b);
      return x.protocol === y.protocol && x.hostname === y.hostname && (x.port || x.protocol) === (y.port || y.protocol);
    } catch { return false; }
  };
  const webs = (f.http || []).map((w) => ({ url: `${w.proto}://${d.ip}:${w.port}/`, label: `${w.proto}://${d.ip}:${w.port}`, w }));
  const quick = d.web_url ? webs.find((x) => sameTarget(x.url, d.web_url)) : null;
  if (d.web_url && !quick) webs.unshift({ url: d.web_url, label: d.web_url.replace(/\/$/, ''), manual: true });
  const quickBadge = (manual) => h('span', { class: 'badge badge-ok', title: manual ? t('dev.quickManual') : t('dev.quick') },
    manual ? `${t('dev.quick')} · ${t('dev.quickManual')}` : t('dev.quick'));
  const webRow = webs.length ? [h('dt', {}, t('dev.web')), h('dd', {}, webs.map((x) => h('div', { class: 'web-row' },
    h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, x.label),
    x.w ? [' ', x.w.title || x.w.server || '', x.w.cert?.subject ? h('span', { class: 'muted small' }, ` · ${x.w.cert.subject}`) : null] : null,
    x.manual ? [' ', quickBadge(true)] : x === quick ? [' ', quickBadge(false)] : null)))] : null;
  const detection = h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('dev.detection')),
    !hasFacts ? h('p', { class: 'muted' }, t('dev.noFacts')) : null,
    hasFacts || webRow || d.plugged ? h('dl', { class: 'kv' },
      hasFacts && c.type ? [h('dt', {}, t('dev.confidence')), h('dd', {}, typeChip(c.type), ' ', confidenceBar(c.confidence))] : null,
      hasFacts && c.reasons?.length ? [h('dt', {}, t('dev.reasons')), h('dd', {}, c.reasons.map(reasonText).join(' · '))] : null,
      hasFacts ? [h('dt', {}, t('dev.ports')), h('dd', {}, f.ports?.length ? portList(f.ports, services) : '–')] : null,
      f.vendorFull ? [h('dt', {}, t('dev.vendorFull')), h('dd', {}, f.vendorFull)] : null,
      f.randomMac ? [h('dt', {}, 'MAC'), h('dd', {}, t('dev.randomMac'))] : null,
      f.rdns ? [h('dt', {}, t('dev.rdns')), h('dd', { class: 'mono' }, f.rdns)] : null,
      f.netbios ? [h('dt', {}, t('dev.netbios')), h('dd', {}, [f.netbios.name, f.netbios.domain].filter(Boolean).join(' · '))] : null,
      f.ttl ? [h('dt', {}, t('dev.ttl')), h('dd', {}, f.ttl)] : null,
      f.snmp ? [h('dt', {}, t('dev.snmp')), h('dd', {}, [f.snmp.name, f.snmp.descr, f.snmp.location].filter(Boolean).join(' · '))] : null,
      webRow,
      f.deep?.at ? [h('dt', {}, t('dev.deep')), h('dd', {}, fmtDate(f.deep.at, getLang()))] : null,
      pluggedLine(d.plugged),
    ) : null);

  const monPanel = h('section', { class: 'panel panel-pad' },
    h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '8px' } }, h('h2', { class: 'section-title', style: { margin: 0 } }, t('mon.device')),
      h('div', { class: 'actions' },
        edit && ['printer', 'nas', 'switch'].includes(d.type) ? btn(t('sens.add'), { class: 'btn btn-sm btn-ghost', onclick: () =>
          openMonitorForm(null, () => renderDevice(main, id), { type: 'sensor', device_id: d.id, name: `${d.name} - Sensor`, interval_s: 300, fail_threshold: 1 }) }, 'plus') : null,
        edit && d.ip ? btn(t('mon.watch'), { class: 'btn btn-sm', onclick: async () => {
          try { const preset = await get(`/monitors/suggest/${d.id}`); openMonitorForm(null, () => renderDevice(main, id), preset); } catch (e) { fail(e); }
        } }, 'pulse') : null)),
    d.monitors?.length ? h('div', { class: 'history-list' }, d.monitors.map((m) => h('button', { type: 'button', onclick: () => navigate(`/monitoring/${m.id}`) },
      h('span', {}, monitorDot(m.status), ' ', h('strong', {}, m.name), h('span', { class: 'muted small mono', style: { display: 'block' } }, `${t(`mon.type.${m.type}`)} · ${m.type === 'tcp' ? `${m.target}:${m.port}` : m.target}`)),
      statusPill(m.status))))
      : h('p', { class: 'muted', style: { margin: 0 } }, t('mon.deviceNone')));

  const meta = h('section', { class: 'panel panel-pad' },
    h('dl', { class: 'kv' },
      h('dt', {}, t('dev.firstSeen')), h('dd', {}, fmtDate(d.first_seen, getLang())),
      h('dt', {}, t('dev.lastSeen')), h('dd', {}, d.last_seen ? `${fmtDate(d.last_seen, getLang())} (${fmtAgo(d.last_seen, t)})` : t('never')),
      h('dt', {}, t('dev.created')), h('dd', {}, fmtDate(d.created_at, getLang()))));

  const hist = h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('dev.history')),
    h('ul', { class: 'timeline' }, d.history.map((r) => h('li', { class: r.kind },
      h('span', { class: 'when' }, `${fmtDate(r.at, getLang())} · ${r.user === 'scan' ? t('hist.byScan') : r.user}`), historyText(r)))));

  // Read view of the details: only what is filled in; the form only after "Edit"
  const locName = locations.find((l) => l.id === d.location_id)?.name;
  const val = (k, v) => (v ? [h('dt', {}, t(`f.${k}`)), h('dd', { class: ['ip', 'mac', 'serial'].includes(k) ? 'mono' : '' }, v)] : null);
  const details = h('dl', { class: 'kv' },
    val('type', t(`type.${d.type}`)), val('location', locName), val('ip', d.ip), val('mac', d.mac), val('vendor', d.vendor), val('model', d.model),
    val('hostname', d.hostname), val('os', d.os), val('owner', d.owner), val('tags', d.tags), val('web_url', d.web_url),
    val('serial', d.serial), val('supplier', d.supplier),
    val('purchase_date', d.purchase_date ? fmtDate(d.purchase_date, getLang(), false) : ''),
    val('warranty_until', d.warranty_until ? fmtDate(d.warranty_until, getLang(), false) : ''),
    val('maintenance_until', d.maintenance_until ? fmtDate(d.maintenance_until, getLang(), false) : ''));
  const notes = d.notes ? h('div', { class: 'dev-notes' }, h('h3', { class: 'section-title' }, t('f.notes')), h('p', {}, d.notes)) : null;
  const detailsPanel = (editing) => h('section', { class: 'panel panel-pad' },
    h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '10px' } }, h('h2', { class: 'section-title', style: { margin: 0 } }, t('dev.details')),
      edit && !editing ? btn(t('edit'), { class: 'btn btn-sm', onclick: () => show('details', true) }, 'edit') : null),
    editing ? form : [details, notes]);

  // Short facts for the state tab when there is no printer, switch or NAS panel
  const facts = h('section', { class: 'panel panel-pad' }, h('h2', { class: 'section-title' }, t('dev.facts')),
    h('dl', { class: 'kv' }, val('vendor', d.vendor), val('model', d.model), val('os', d.os), val('owner', d.owner),
      val('warranty_until', d.warranty_until ? fmtDate(d.warranty_until, getLang(), false) : ''),
      [h('dt', {}, t('dev.lastSeen')), h('dd', {}, d.last_seen ? fmtAgo(d.last_seen, t) : t('never'))]), notes);
  const typePanel = d.type === 'printer' ? printerPanel(d) : d.type === 'switch' ? switchPanel(d) : d.type === 'nas' ? nasPanel(d) : null;
  const netShort = !(d.plugged || d.mac || f.ports?.length || webRow) ? null : h('section', { class: 'panel panel-pad' }, h('h2', { class: 'section-title' }, t('dev.net')),
    h('dl', { class: 'kv' }, pluggedLine(d.plugged), val('mac', d.mac),
      f.ports?.length ? [h('dt', {}, t('dev.ports')), h('dd', {}, portList(f.ports, services))] : null, webRow));

  const TABS = [['state', t('dev.tab.state')], ['details', t('dev.tab.details')], ['monitors', `${t('dev.tab.monitors')}${d.monitors?.length ? ` ${d.monitors.length}` : ''}`],
    ['network', t('dev.tab.network')], ['history', t('dev.tab.history')]];
  const content = h('div');
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  function show(tab, editing = false) {
    if (!TABS.some(([k]) => k === tab)) tab = 'state';
    history.replaceState({}, '', `${location.pathname}${tab === 'state' ? '' : `#${tab}`}`);
    mount(tabBar, TABS.map(([k, label]) => h('button', { type: 'button', role: 'tab', class: k === tab ? 'on' : '', 'aria-selected': String(k === tab), onclick: () => show(k) }, label)));
    const views = {
      state: () => h('div', { class: 'device-grid' }, h('div', { class: 'stack' }, typePanel || facts), h('div', { class: 'stack' }, monPanel, netShort)),
      details: () => detailsPanel(editing),
      monitors: () => monPanel,
      network: () => h('div', { class: 'stack' }, detection, meta),
      history: () => hist,
    };
    mount(content, views[tab]());
  }

  const more = edit ? h('details', { class: 'menu' }, h('summary', { class: 'btn', 'aria-label': t('dev.more') }, t('dev.more')),
    h('div', { class: 'menu-list' },
      d.ip ? h('button', { type: 'button', title: ti ? t('dev.deepTi') : t('dev.deepHint'), onclick: (e) => { e.currentTarget.closest('details').open = false; deep(e.currentTarget); } }, t('dev.deep')) : null,
      h('button', { type: 'button', class: 'danger', onclick: (e) => { e.currentTarget.closest('details').open = false; remove(); } }, t('dev.delete')))) : null;

  mount(main, h('div', { class: 'page' },
    h('a', { class: 'back-link', href: '/inventory', 'data-link': true }, t('nav.inventory')),
    h('div', { class: 'device-head' },
      h('div', { class: `device-icon${ti ? ' ti' : ''}`, html: icon(d.type) }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('h1', {}, d.name, ti ? h('span', { class: 'badge badge-ti' }, t('telematik')) : null),
        h('div', { class: 'meta' }, h('span', {}, presenceDot(presence), ' ', t(`presence.${presence}`)), h('span', {}, t(`type.${d.type}`)),
          d.ip ? h('span', { class: 'mono' }, d.ip) : null, locName ? h('span', {}, locName) : null)),
      h('div', { class: 'actions' },
        d.web_url ? h('a', { class: 'btn btn-primary', href: d.web_url, target: '_blank', rel: 'noopener noreferrer' }, h('span', { html: icon('open') }), t('open.web')) : null,
        edit ? btn(t('edit'), { onclick: () => show('details', true) }, 'edit') : null,
        more)),
    ti ? h('div', { class: 'note ti' }, t('dev.deepTi')) : null,
    tabBar,
    content));
  show(location.hash.slice(1) || 'state');
}
