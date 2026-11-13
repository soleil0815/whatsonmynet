// Small DOM helpers. Text is always set as text (never as HTML) - only the fixed icons are SVG markup.
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
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3200);
}

/** Modal dialog using <dialog>. Returns { close, el }. */
export function modal(title, body, { actions = [], wide = false, onClose } = {}) {
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-label': title });
  const close = () => { dlg.close(); };
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.append(
    h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': '×', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('footer', {}, actions) : null,
  );
  document.body.append(dlg);
  dlg.showModal();
  return { close, el: dlg };
}

export function confirmDialog(title, text, okLabel, cancelLabel, { danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal(title, h('p', {}, text), {
      onClose: () => resolve(result),
      actions: [
        h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, cancelLabel),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => { result = true; m.close(); } }, okLabel),
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
