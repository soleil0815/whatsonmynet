// Small DOM helpers. Text is always set as text (never as HTML) - only the fixed icons are SVG markup.
import { t as tr } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // only for fixed SVG icons from icons.js
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export function mount(el, ...children) { clear(el); append(el, children); return el; }

let toastBox;
export function toast(message, kind = 'ok') {
  if (!toastBox) toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  // An open modal <dialog> makes the rest of the page inert and covers it: show the message inside the topmost dialog.
  const open = [...document.querySelectorAll('dialog[open]')].pop();
  const host = open || document.body;
  if (toastBox.parentNode !== host) host.append(toastBox);
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3200);
}

let formSeq = 0;

/**
 * Modal dialog using <dialog>. Returns { close, el, form }.
 * Every dialog is a form: the body sits in a <form> (a <form> passed as body is used as it is - forms cannot be nested),
 * the primary button in `actions` is created with type: 'submit' and belongs to that form. Enter in a single-line field
 * submits it, textareas keep Enter as new line. onSubmit runs while the submit button is disabled (busy), so a double
 * click or Enter pressed twice sends one request. All other buttons are type=button.
 */
export function modal(title, body, { actions = [], wide = false, onClose, onSubmit } = {}) {
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-label': title });
  const close = () => { dlg.close(); };
  dlg.addEventListener('close', () => {
    if (toastBox?.parentNode === dlg) document.body.append(toastBox); // keep running messages visible after the dialog closes
    dlg.remove(); onClose?.();
  });
  const form = body?.tagName === 'FORM' ? body : h('form', { class: 'modal-form' }, body);
  if (!form.id) form.id = `modal-form-${++formSeq}`;
  const footer = actions.length ? h('footer', {}, actions) : null; // a dialog without buttons must not show the text "null"
  // A <button> without type is a submit button: only the ones marked as submit may submit the dialog
  for (const b of form.querySelectorAll('button')) if (b.getAttribute('type') !== 'submit') b.type = 'button';
  for (const b of footer ? footer.querySelectorAll('button') : []) {
    if (b.getAttribute('type') === 'submit') b.setAttribute('form', form.id); // the footer lies outside the form
    else b.type = 'button';
  }
  // Enter in a filter field (type=search) filters and never submits the dialog
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target?.type === 'search') e.preventDefault(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault(); // never navigate away
    if (!onSubmit) return undefined;
    clearFieldErrors(form);
    const submitter = e.submitter?.getAttribute?.('type') === 'submit' ? e.submitter : footer?.querySelector('button[type=submit]');
    return busy(submitter, () => onSubmit(e));
  });
  dlg.append(
    h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': tr('close'), onclick: close }, '×')),
    h('div', { class: 'modal-body' }, form),
    ...(footer ? [footer] : []),
  );
  document.body.append(dlg);
  dlg.showModal();
  return { close, el: dlg, form };
}

let errSeq = 0;
/** Removes the message of a field error from one input */
function clearFieldError(el) {
  const id = el.dataset?.errId;
  if (!id) return;
  [...(el.parentNode?.children || [])].find((c) => c.id === id)?.remove();
  const rest = (el.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== id);
  if (rest.length) el.setAttribute('aria-describedby', rest.join(' ')); else el.removeAttribute('aria-describedby');
  el.removeAttribute('aria-invalid');
  delete el.dataset.errId;
}

/** Removes all field errors shown in root */
export function clearFieldErrors(root) {
  for (const el of root?.querySelectorAll?.('[aria-invalid]') || []) clearFieldError(el);
}

/**
 * Shows a server validation error next to the input named `field` in root: aria-invalid, aria-describedby, focus.
 * With several inputs of that name, the one whose value the server reports in `detail` is marked.
 * Returns false when root has no such input (the caller shows a toast instead).
 */
export function showFieldError(root, field, message, detail) {
  if (!root || typeof field !== 'string' || !field) return false;
  const all = [...root.querySelectorAll('[name]')].filter((x) => x.name === field && !x.disabled && !x.closest('[hidden]'));
  if (!all.length) return false;
  const d = detail === undefined || detail === null ? '' : String(detail);
  const el = all.find((x) => d && x.value?.trim() && (d === x.value.trim() || d.startsWith(`${x.value.trim()} `))) || all[0];
  clearFieldError(el);
  const id = `field-err-${++errSeq}`;
  el.after(h('span', { class: 'field-error', id, role: 'alert' }, message));
  el.dataset.errId = id;
  el.setAttribute('aria-invalid', 'true');
  el.setAttribute('aria-describedby', [...(el.getAttribute('aria-describedby') || '').split(' ').filter(Boolean), id].join(' '));
  // A field folded away (e.g. in "Advanced") is opened, so the message can be seen
  for (let det = el.closest('details'); det; det = det.parentNode?.closest?.('details')) det.open = true;
  const clear = () => clearFieldError(el);
  el.addEventListener('input', clear, { once: true });
  el.addEventListener('change', clear, { once: true });
  el.focus();
  return true;
}

/**
 * Runs fn while button is disabled, so a double or triple click cannot send the same request twice.
 * The button is enabled again afterwards, also after an error. Returns fn's result (undefined if already busy).
 */
export async function busy(button, fn) {
  if (!button) return fn();
  if (button.disabled) return undefined;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

export function confirmDialog(title, text, okLabel, cancelLabel, { danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal(title, h('p', {}, text), {
      onClose: () => resolve(result),
      onSubmit: () => { result = true; m.close(); },
      actions: [
        h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, cancelLabel),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit' }, okLabel),
      ],
    });
  });
}

export function fmtDate(iso, lang, withTime = true) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', withTime
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtAgo(iso, t) {
  if (!iso) return t('never');
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return t('ago.now');
  if (s < 3600) return t('ago.min', { n: Math.round(s / 60) });
  if (s < 86400 * 2) return t('ago.h', { n: Math.round(s / 3600) });
  return t('ago.d', { n: Math.round(s / 86400) });
}

/** Debounce for search fields */
export function debounce(fn, ms = 200) {
  let id;
  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
}
