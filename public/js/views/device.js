// One device: details (editable), what the scan found, history, deep check.
import { h, mount, fmtDate, fmtAgo, toast, confirmDialog } from '../dom.js';
import { get, patch, del, post } from '../api.js';
import { t, getLang, reasonText } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { typeChip, presenceDot, field, input, select, typeOptions, formData, btn, confidenceBar, portList, TI } from './common.js';

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
  const [d, locations] = await Promise.all([get(`/devices/${id}`), get('/locations')]);
  const types = state.meta?.types || [];
  const services = state.meta?.services || {};
  const edit = state.user.canEdit;
  const ti = TI.has(d.type);
  const ro = edit ? {} : { disabled: true };
  const f = d.facts || {};
  const presence = d.presence || 'unknown';

  const form = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'full' }, field(t('f.name'), input('name', d.name, { required: true, maxlength: 120, ...ro }))),
    field(t('f.type'), select('type', typeOptions(types), d.type, ro)),
    field(t('f.location'), select('location_id', [['', t('none')], ...locations.map((l) => [String(l.id), l.name])], d.location_id ? String(d.location_id) : '', ro)),
    field(t('f.ip'), input('ip', d.ip || '', { class: 'mono', ...ro })),
    field(t('f.mac'), input('mac', d.mac || '', { class: 'mono', ...ro })),
    field(t('f.vendor'), input('vendor', d.vendor, ro)),
    field(t('f.model'), input('model', d.model, ro)),
    field(t('f.hostname'), input('hostname', d.hostname, ro)),
    field(t('f.os'), input('os', d.os, ro)),
    field(t('f.owner'), input('owner', d.owner, ro)),
    field(t('f.tags'), input('tags', d.tags, ro), t('f.tagsHint')),
    h('div', { class: 'full' }, field(t('f.web_url'), input('web_url', d.web_url, { class: 'mono', ...ro }), t('f.web_urlHint'))),
    h('div', { class: 'full' }, field(t('f.notes'), h('textarea', { name: 'notes', ...ro }, d.notes))),
    h('h3', { class: 'full section-title' }, t('dev.purchase')),
    field(t('f.serial'), input('serial', d.serial, ro)),
    field(t('f.supplier'), input('supplier', d.supplier, ro)),
    field(t('f.purchase_date'), input('purchase_date', d.purchase_date || '', { type: 'date', ...ro })),
    field(t('f.warranty_until'), input('warranty_until', d.warranty_until || '', { type: 'date', ...ro })),
    field(t('f.maintenance_until'), input('maintenance_until', d.maintenance_until || '', { type: 'date', ...ro })),
    edit ? h('div', { class: 'full actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))) : null);

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
  const detection = h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('dev.detection')),
    !f.ports && !f.snmp && !f.http ? h('p', { class: 'muted' }, t('dev.noFacts')) : h('dl', { class: 'kv' },
      c.type ? [h('dt', {}, t('dev.confidence')), h('dd', {}, typeChip(c.type), ' ', confidenceBar(c.confidence))] : null,
      c.reasons?.length ? [h('dt', {}, t('dev.reasons')), h('dd', {}, c.reasons.map(reasonText).join(' · '))] : null,
      [h('dt', {}, t('dev.ports')), h('dd', {}, f.ports?.length ? portList(f.ports, services) : '–')],
      f.vendorFull ? [h('dt', {}, t('dev.vendorFull')), h('dd', {}, f.vendorFull)] : null,
      f.randomMac ? [h('dt', {}, 'MAC'), h('dd', {}, t('dev.randomMac'))] : null,
      f.rdns ? [h('dt', {}, t('dev.rdns')), h('dd', { class: 'mono' }, f.rdns)] : null,
      f.netbios ? [h('dt', {}, t('dev.netbios')), h('dd', {}, [f.netbios.name, f.netbios.domain].filter(Boolean).join(' · '))] : null,
      f.ttl ? [h('dt', {}, t('dev.ttl')), h('dd', {}, f.ttl)] : null,
      f.snmp ? [h('dt', {}, t('dev.snmp')), h('dd', {}, [f.snmp.name, f.snmp.descr, f.snmp.location].filter(Boolean).join(' · '))] : null,
      f.http?.length ? [h('dt', {}, t('dev.web')), h('dd', {}, f.http.map((w) => h('div', {},
        h('a', { href: `${w.proto}://${d.ip}:${w.port}/`, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, `${w.proto}://${d.ip}:${w.port}`),
        ' ', w.title || w.server || '', w.cert?.subject ? h('span', { class: 'muted small' }, ` · ${w.cert.subject}`) : null)))] : null,
      f.deep?.at ? [h('dt', {}, t('dev.deep')), h('dd', {}, fmtDate(f.deep.at, getLang()))] : null,
    ));

  const meta = h('section', { class: 'panel panel-pad' },
    h('dl', { class: 'kv' },
      h('dt', {}, t('dev.firstSeen')), h('dd', {}, fmtDate(d.first_seen, getLang())),
      h('dt', {}, t('dev.lastSeen')), h('dd', {}, d.last_seen ? `${fmtDate(d.last_seen, getLang())} (${fmtAgo(d.last_seen, t)})` : t('never')),
      h('dt', {}, t('dev.created')), h('dd', {}, fmtDate(d.created_at, getLang()))));

  const hist = h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('dev.history')),
    h('ul', { class: 'timeline' }, d.history.map((r) => h('li', { class: r.kind },
      h('span', { class: 'when' }, `${fmtDate(r.at, getLang())} · ${r.user === 'scan' ? t('hist.byScan') : r.user}`), historyText(r)))));

  const deepBtn = edit && d.ip ? btn(t('dev.deep'), { title: ti ? t('dev.deepTi') : t('dev.deepHint'), onclick: (e) => deep(e.currentTarget) }, 'radar') : null;

  mount(main, h('div', { class: 'page' },
    h('div', { class: 'device-head' },
      h('div', { class: `device-icon${ti ? ' ti' : ''}`, html: icon(d.type) }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('h1', {}, d.name, ti ? h('span', { class: 'badge badge-ti' }, t('telematik')) : null),
        h('div', { class: 'meta' }, h('span', {}, presenceDot(presence), ' ', t(`presence.${presence}`)), typeChip(d.type),
          d.ip ? h('span', { class: 'mono' }, d.ip) : null, d.mac ? h('span', { class: 'mono' }, d.mac) : null)),
      h('div', { class: 'actions' },
        d.web_url ? h('a', { class: 'btn btn-primary', href: d.web_url, target: '_blank', rel: 'noopener noreferrer' }, h('span', { html: icon('open') }), t('open.web')) : null,
        deepBtn,
        edit ? btn(t('delete'), { class: 'btn btn-danger', onclick: remove }, 'trash') : null)),
    ti ? h('div', { class: 'note ti' }, t('dev.deepTi')) : null,
    h('div', { class: 'device-grid' },
      h('section', { class: 'panel panel-pad' }, h('h2', { class: 'section-title' }, t('dev.details')), form),
      h('div', { class: 'stack' }, detection, meta, hist))));
}
