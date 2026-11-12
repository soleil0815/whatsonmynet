// Building blocks shared by several pages.
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';

export const TI = new Set(['ti_connector', 'ti_terminal']);

export function typeChip(type, { label = true } = {}) {
  return h('span', { class: `typechip${TI.has(type) ? ' ti' : ''}`, title: t(`type.${type}`) },
    h('span', { html: icon(type) }), label ? t(`type.${type}`) : null);
}

export function presenceDot(p) {
  return h('span', { class: `dot ${p}`, title: t(`presence.${p}`), role: 'img', 'aria-label': t(`presence.${p}`) });
}

export function pageHead(title, lead, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), lead ? h('p', {}, lead) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

/** Labelled input. kind: text | password | email | number | date | textarea | select | checkbox */
export function field(label, input, hint) {
  if (input.type === 'checkbox') return h('label', { class: 'check' }, input, h('span', {}, label, hint ? h('span', { class: 'hint', style: { display: 'block' } }, hint) : null));
  return h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function input(name, value = '', attrs = {}) {
  return h('input', { type: 'text', name, value: value ?? '', ...attrs });
}

export function select(name, options, value, attrs = {}) {
  const el = h('select', { name, ...attrs }, options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = value ?? '';
  return el;
}

export function typeOptions(types) {
  return types.map((x) => [x, t(`type.${x}`)]).sort((a, b) => (a[0] === 'unknown') - (b[0] === 'unknown') || a[1].localeCompare(b[1]));
}

export function btn(label, attrs = {}, ico = null) {
  return h('button', { type: 'button', class: 'btn', ...attrs }, ico ? h('span', { html: icon(ico) }) : null, label);
}

/** Read named fields of a form into an object (checkboxes → boolean) */
export function formData(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

export function confidenceBar(c) {
  const pct = Math.round((c || 0) * 100);
  return h('span', { class: `conf${pct < 45 ? ' low' : ''}`, title: `${t('dev.confidence')}: ${pct} %` }, h('i', { style: { width: `${pct}%` } }));
}

export function portList(ports, services = {}) {
  return h('span', { class: 'ports' }, (ports || []).map((p) => h('span', { class: 'port', title: services[p] || '' }, p)));
}

/** <datalist> elements with values already used in the inventory (suggestions while typing) */
export function suggestionLists(sugg) {
  return ['vendor', 'model', 'os', 'owner', 'supplier', 'tags'].map((k) => h('datalist', { id: `dl-${k}` },
    (sugg?.[k] || []).map((v) => h('option', { value: v }))));
}

/**
 * Choosing a known model fills in manufacturer and type when they are still empty/unknown.
 * form: the form with fields named model, vendor and type
 */
export function wireModelAutofill(form, sugg) {
  const model = form.querySelector('[name=model]');
  if (!model) return;
  model.addEventListener('change', () => {
    const known = sugg?.models?.[model.value.trim().toLowerCase()];
    if (!known) return;
    const vendor = form.querySelector('[name=vendor]');
    const type = form.querySelector('[name=type]');
    if (vendor && !vendor.value.trim() && known.vendor) { vendor.value = known.vendor; vendor.dispatchEvent(new Event('input')); }
    if (type && (type.value === 'unknown' || !type.value) && known.type) type.value = known.type;
  });
}

/** Clickable chips of tags already in use: a click adds the tag to the comma list in `input` */
export function tagChips(input, tags, max = 14) {
  const current = () => input.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return h('div', { class: 'chips' }, (tags || []).slice(0, max).map((tg) => h('button', { type: 'button', class: 'chip', onclick: () => {
    if (current().includes(tg.toLowerCase())) return;
    input.value = [...input.value.split(',').map((x) => x.trim()).filter(Boolean), tg].join(', ');
    input.dispatchEvent(new Event('input'));
  } }, `+ ${tg}`)));
}

/** Checkboxes for notification channels. Nothing ticked = the default channels. Returns { el, value() } */
export function channelPicker(chans, selectedIds = []) {
  const sel = new Set(selectedIds || []);
  const boxes = chans.map((c) => [c.id, h('input', { type: 'checkbox', checked: sel.has(c.id) })]);
  const el = chans.length ? h('div', { class: 'field' }, t('mon.f.channels'),
    h('div', { class: 'chips' }, chans.map((c, i) => h('label', { class: 'check', style: { marginRight: '14px' } }, boxes[i][1],
      `${c.name}${c.is_default ? ` (${t('mon.f.default')})` : ''}`))),
    h('span', { class: 'hint' }, t('mon.f.channelsHint')))
    : h('p', { class: 'muted small' }, t('mon.f.noChannelsAdmin'));
  return { el, value: () => boxes.filter(([, b]) => b.checked).map(([id]) => id) };
}
