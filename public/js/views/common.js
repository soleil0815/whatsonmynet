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
