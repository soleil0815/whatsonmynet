// Printer panel on the device page and the "supplies running low" list on the dashboard.
import { h, mount, fmtDate, fmtAgo } from '../dom.js';
import { post } from '../api.js';
import { t, getLang } from '../i18n.js';
import { state, fail } from '../app.js';
import { btn } from './common.js';

const fmtNum = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString(getLang() === 'en' ? 'en-GB' : 'de-DE'));

/** Label of a supply: name from the printer, plus a translated kind if the printer gives none */
export function supplyName(s) {
  return s.description && s.description !== s.type ? s.description : t(`sup.${s.type}`) !== `sup.${s.type}` ? t(`sup.${s.type}`) : s.type;
}

/** One supply as a bar. Waste toner: the bar shows how full it is. */
export function supplyBar(s, threshold = 15) {
  const known = s.pct !== null && s.pct !== undefined;
  const fill = known ? (s.receptacle ? 100 - s.pct : s.pct) : s.state === 'some' ? 50 : 0;
  const low = s.state === 'empty' || (known && s.pct <= threshold);
  const value = s.state === 'empty' ? (s.receptacle ? t('sup.full') : t('sup.empty'))
    : known ? (s.receptacle ? t('sup.freePct', { pct: s.pct }) : `${s.pct} %`)
      : s.state === 'some' ? t('sup.some') : t('sup.unknown');
  return h('div', { class: `supply${low ? ' low' : ''}`, 'data-color': s.color || (s.receptacle ? 'waste' : 'other') },
    h('div', { class: 'supply-head' }, h('span', { class: 'supply-name' }, supplyName(s)), h('span', { class: 'supply-val mono' }, value)),
    h('div', { class: 'supply-track', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': known ? fill : null, 'aria-label': supplyName(s) },
      h('i', { style: { width: `${Math.max(0, Math.min(100, fill))}%` }, class: known ? '' : 'unknown' })));
}

export function printerPanel(device, onChange) {
  const box = h('section', { class: 'panel panel-pad printer-panel' });
  const threshold = state.meta?.printerThreshold || 15;

  async function refresh(button) {
    button.disabled = true;
    try { const p = await post(`/devices/${device.id}/printer`, {}); draw(p); } catch (e) { fail(e); button.disabled = false; }
  }

  function draw(p) {
    const head = h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '10px' } },
      h('h2', { class: 'section-title', style: { margin: 0 } }, t('prn.panel')),
      state.user.canEdit && device.ip ? btn(t('prn.refresh'), { class: 'btn btn-sm', onclick: (e) => refresh(e.currentTarget) }, 'refresh') : null);
    if (!p) {
      mount(box, head, h('p', { class: 'muted', style: { margin: 0 } }, t('prn.none')));
      return;
    }
    const errors = (p.errors || []).filter((e) => e !== 'lowToner' || !(p.supplies || []).length);
    mount(box, head,
      !p.ok ? h('div', { class: 'note warn', style: { marginBottom: '10px' } }, t(`prn.err.${p.error || 'snmp'}`)) : null,
      errors.length ? h('div', { class: 'chips', style: { marginBottom: '10px' } }, errors.map((e) => h('span', { class: `badge ${['jammed', 'noPaper', 'noToner', 'doorOpen', 'offline', 'serviceRequested', 'outputFull'].includes(e) ? 'badge-bad' : 'badge-new'}` }, t(`prn.e.${e}`)))) : null,
      p.display?.length ? h('div', { class: 'printer-display mono' }, p.display.map((l) => h('div', {}, l))) : null,
      (p.supplies || []).length ? h('div', { class: 'supplies' }, p.supplies.map((s) => supplyBar(s, threshold))) : null,
      h('dl', { class: 'kv', style: { marginTop: '12px' } },
        p.status ? [h('dt', {}, t('prn.status')), h('dd', {}, t(`prn.s.${p.status}`))] : null,
        h('dt', {}, t('prn.pages')), h('dd', { class: 'mono' }, fmtNum(p.pages)),
        p.pages30 !== null && p.pages30 !== undefined ? [h('dt', {}, t('prn.pages30')), h('dd', { class: 'mono' }, fmtNum(p.pages30))] : null,
        p.serial ? [h('dt', {}, t('f.serial')), h('dd', { class: 'mono' }, p.serial)] : null,
        h('dt', {}, t('prn.checked')), h('dd', {}, `${fmtDate(p.at, getLang())} (${fmtAgo(p.at, t)})`)));
    onChange?.(p);
  }

  draw(device.printer);
  return box;
}

/** Dashboard: supplies at or below the threshold (same look as the other dashboard lists) */
export function lowSuppliesPanel(list) {
  if (!list?.length) return null;
  return h('section', { class: 'panel' },
    h('h2', {}, t('prn.low')),
    h('ul', { class: 'feed' }, list.map((s) => h('li', {},
      h('a', { href: `/devices/${s.deviceId}`, 'data-link': true }, s.device),
      h('span', { class: `badge ${s.state === 'empty' ? 'badge-bad' : 'badge-new'}`, style: { justifySelf: 'end' } },
        s.state === 'empty' ? (s.receptacle ? t('sup.full') : t('sup.empty')) : s.receptacle ? t('sup.freePct', { pct: s.pct }) : `${s.pct} %`),
      h('span', { class: 'what' }, supplyName(s))))));
}
