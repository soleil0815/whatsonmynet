// Failover: settings page (master / standby / pairing) and the bar at the top while this server is a standby.
import { h, mount, toast, modal, confirmDialog, fmtDate, fmtAgo, busy } from '../dom.js';
import { get, put, post } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, fail } from '../app.js';
import { field, input, btn, formData } from './common.js';
import { checkText } from '../checktext.js';

const why = (msg) => checkText(msg || '', getLang());

const panel = (title, ...content) => h('section', { class: 'panel panel-pad' }, title ? h('h2', { class: 'section-title' }, title) : null, content);
const when = (iso) => (iso ? `${fmtDate(iso, getLang())} (${fmtAgo(iso, t)})` : '–');
const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const minutes = (a, b) => Math.max(1, Math.round((Date.parse(b || new Date().toISOString()) - Date.parse(a)) / 60000));
const dur = (min) => (min < 60 ? t('fo.min', { n: min }) : t('fo.hm', { h: Math.floor(min / 60), m: min % 60 }));

/** The pairing code, shown once, with copy button */
function showCode(code, after = () => {}) {
  const m = modal(t('fo.codeTitle'), h('div', { class: 'form' },
    h('p', { class: 'note warn', style: { margin: 0 } }, t('fo.codeOnce')),
    h('p', { class: 'muted', style: { margin: 0 } }, t('fo.codeLead', { address: location.host })),
    h('pre', { class: 'code wrap fo-code' }, code)), { wide: true, onSubmit: () => m.close(), onClose: after, actions: [
    btn(t('agent.copy'), { onclick: async () => { try { await navigator.clipboard.writeText(code); toast(t('agent.copied')); } catch { /* not allowed */ } } }),
    h('button', { class: 'btn btn-primary', type: 'submit' }, t('agent.done'))] });
}

/** The form for pairing as standby (alone, or replaced master) */
function pairForm(reload, s) {
  const form = h('form', { class: 'form-grid', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(form);
    const b = form.querySelector('button[type=submit]');
    await busy(b, async () => {
      try { await post('/failover/pair', { address: d.address, code: d.code, delayMin: Number(d.delayMin) }); toast(t('fo.paired')); location.reload(); } catch (ex) { fail(ex); }
    });
  } },
  field(t('fo.address'), input('address', '', { required: true, maxlength: 300, placeholder: t('fo.addressPh'), autocomplete: 'off', spellcheck: 'false' }), t('fo.addressHint')),
  field(t('fo.delay'), input('delayMin', 10, { type: 'number', min: 3, max: 240, required: true }), t('fo.delayHint')),
  h('div', { class: 'full' }, field(t('fo.code'), h('textarea', { name: 'code', required: true, rows: 2, class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: 'WOMN1-…' }), t('fo.codeHint'))),
  s.envKey ? h('p', { class: 'note full', style: { margin: 0 } }, t('fo.envKey')) : null,
  h('p', { class: 'note warn full', style: { margin: 0 } }, t('fo.pairWarn')),
  h('div', { class: 'actions full' }, h('button', { class: 'btn btn-primary', type: 'submit' }, h('span', { html: icon('link') }), t('fo.pair'))));
  return form;
}

function takeovers(list) {
  if (!list?.length) return null;
  return panel(t('fo.takeovers'),
    h('p', { class: 'muted', style: { marginTop: 0 } }, t('fo.takeoversLead')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('chart.from')), h('th', {}, t('chart.to')), h('th', {}, t('chart.length')), h('th', {}, t('fo.what')))),
      h('tbody', {}, list.map((x) => h('tr', {},
        h('td', { class: 'nowrap' }, fmtDate(x.from, getLang())),
        h('td', { class: 'nowrap' }, x.to ? fmtDate(x.to, getLang()) : h('span', { class: 'badge badge-bad' }, t('fo.stillActive'))),
        h('td', { class: 'nowrap' }, dur(minutes(x.from, x.to))),
        h('td', {},
          h('div', {}, x.end ? t(`fo.end.${x.end}`) : t('fo.why', { why: why(x.why) || '–' })),
          x.events?.length ? h('details', { class: 'fo-events' }, h('summary', {}, t('fo.events', { n: x.events.length })),
            h('ul', {}, x.events.map((e) => h('li', {}, h('span', { class: 'mono small' }, fmtDate(e.at, getLang())), ' ',
              h('b', {}, e.name), ` - ${t(`fo.ev.${e.kind}`)}`, e.notified ? h('span', { class: 'muted' }, ` → ${e.notified}`) : null))))
            : x.to ? h('div', { class: 'muted small' }, t('fo.noEvents')) : null)))))));
}

export async function failoverSettings(body, _s, reload) {
  const s = await get('/failover');
  const confirmUnpair = (text) => confirmDialog(t('fo.unpair'), text, t('fo.unpair'), t('cancel'), { danger: true });
  const unpairBtn = (text) => btn(t('fo.unpair'), { class: 'btn btn-ghost', onclick: async () => {
    if (!await confirmUnpair(text)) return;
    try { await post('/failover/unpair', {}); location.reload(); } catch (ex) { fail(ex); }
  } });
  const lead = panel(t('set.failover'), h('p', { class: 'muted', style: { margin: 0 } }, t('fo.lead')));

  if (s.role === 'alone') {
    mount(body, lead,
      panel(t('fo.beMaster'), h('p', { class: 'muted', style: { marginTop: 0 } }, t('fo.beMasterLead')),
        h('div', { class: 'actions' }, btn(t('fo.makeMaster'), { class: 'btn btn-primary', onclick: async (e) => busy(e.currentTarget, async () => {
          try { const r = await post('/failover/master', {}); showCode(r.code); reload(); } catch (ex) { fail(ex); }
        }) }, 'shield'))),
      panel(t('fo.beStandby'), h('p', { class: 'muted', style: { marginTop: 0 } }, t('fo.beStandbyLead')), pairForm(reload, s)),
      takeovers(s.takeovers));
    return;
  }

  if (s.role === 'master') {
    const p = s.master?.peer;
    const fresh = p && Date.now() - Date.parse(p.at) < 3 * 60 * 1000;
    mount(body, lead,
      panel(t('fo.thisMaster'),
        kv([
          [t('fo.role'), h('span', { class: 'badge badge-ok' }, t('fo.roleMaster'))],
          [t('fo.codeMade'), when(s.master?.createdAt)],
          [t('fo.standby'), p ? h('span', {}, h('span', { class: `badge ${fresh ? 'badge-ok' : 'badge-bad'}` }, fresh ? t('fo.peerOk') : t('fo.peerLost')), ' ',
            h('span', { class: 'mono' }, p.ip), p.version ? h('span', { class: 'muted' }, ` · ${p.version}`) : null) : h('span', { class: 'muted' }, t('fo.noPeer'))],
          p ? [t('fo.lastAsked'), when(p.at)] : null,
          s.former ? [t('fo.former'), h('span', {}, h('span', { class: 'mono' }, s.former.address), h('span', { class: 'muted' }, ` - ${t('fo.formerWaiting')}`))] : null,
        ]),
        h('p', { class: 'muted small' }, t('fo.masterHint')),
        h('div', { class: 'actions' },
          btn(t('fo.newCode'), { class: 'btn', onclick: async () => {
            if (p && !await confirmDialog(t('fo.newCode'), t('fo.newCodeConfirm'), t('fo.newCode'), t('cancel'))) return;
            try { const r = await post('/failover/master', {}); showCode(r.code); reload(); } catch (ex) { fail(ex); }
          } }, 'refresh'),
          unpairBtn(t('fo.unpairMaster')))),
      takeovers(s.takeovers));
    return;
  }

  if (s.role === 'standby') {
    const sb = s.standby;
    const badge = { listening: ['badge-ok', t('fo.stListening')], active: ['badge-bad', t('fo.stActive')], detached: ['badge-bad', t('fo.stDetached')] }[sb.state] || ['', sb.state];
    const delay = input('delayMin', sb.delayMin, { type: 'number', min: 3, max: 240, required: true, style: { maxWidth: '110px' } });
    mount(body, lead,
      sb.state === 'active' ? h('p', { class: 'note bad' }, t('fo.activeNote', { since: when(sb.activeSince) })) : null,
      sb.state === 'detached' ? h('p', { class: 'note warn' }, t('fo.detachedNote', { why: why(sb.lastError) })) : null,
      panel(t('fo.thisStandby'),
        kv([
          [t('fo.role'), h('span', { class: `badge ${badge[0]}` }, badge[1])],
          [t('fo.master'), h('span', { class: 'mono' }, sb.address)],
          [t('fo.lastContact'), h('span', {}, when(sb.lastContact), sb.lastError ? h('span', { class: 'tone-bad' }, ` · ${why(sb.lastError)}`) : null)],
          [t('fo.lastSync'), h('span', {}, when(sb.lastSync), sb.syncError ? h('span', { class: 'tone-bad' }, ` · ${why(sb.syncError)}`) : null)],
          sb.masterVersion ? [t('fo.masterVersion'), h('span', { class: 'mono' }, `${sb.masterVersion}${sb.masterVersion !== s.version ? ` (${t('fo.here')} ${s.version})` : ''}`)] : null,
          [t('fo.pairedAt'), when(sb.pairedAt)],
        ]),
        h('form', { class: 'fo-delay', onsubmit: async (e) => {
          e.preventDefault();
          try { await put('/failover/delay', { delayMin: Number(delay.value) }); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
        } }, field(t('fo.delay'), delay, t('fo.delayHint')), h('button', { class: 'btn', type: 'submit' }, t('save'))),
        h('div', { class: 'actions' },
          btn(t('fo.checkNow'), { onclick: async (e) => busy(e.currentTarget, async () => { try { await post('/failover/check', {}); if (await loadFailoverState()) location.reload(); else reload(); } catch (ex) { fail(ex); } }) }, 'refresh'),
          btn(t('fo.promote'), { class: 'btn btn-danger', onclick: async () => {
            if (!await confirmDialog(t('fo.promote'), t('fo.promoteConfirm', { master: sb.address }), t('fo.promote'), t('cancel'), { danger: true })) return;
            try { const r = await post('/failover/promote', {}); showCode(r.code, () => location.reload()); } catch (ex) { fail(ex); }
          } }, 'shield'),
          unpairBtn(t('fo.unpairStandby')))),
      takeovers(s.takeovers));
    return;
  }

  // replaced: another server was made the master
  mount(body, lead,
    h('p', { class: 'note warn' }, t('fo.yieldedNote', { since: when(s.yielded?.at), ip: s.yielded?.ip || '–' })),
    panel(t('fo.beStandby'), h('p', { class: 'muted', style: { marginTop: 0 } }, t('fo.yieldedStandby')), pairForm(reload, s)),
    panel(t('fo.alone'), h('p', { class: 'muted', style: { marginTop: 0 } }, t('fo.yieldedAlone')), h('div', { class: 'actions' }, unpairBtn(t('fo.unpairYielded')))),
    takeovers(s.takeovers));
}

const READ_ONLY = ['standby', 'detached', 'yielded'];

/**
 * Asks the server whether this is a standby. While it only reads, nobody may edit here (buttons for creating and
 * editing disappear - the server refuses anyway). Returns true when the mode changed.
 */
export async function loadFailoverState() {
  if (!state.user) return false;
  let b;
  try { b = await get('/failover/banner'); } catch { return false; }
  const before = state.failover?.mode ?? null;
  state.failover = b || { mode: null };
  if (state.user.canEditServer === undefined) state.user.canEditServer = state.user.canEdit;
  state.user.canEdit = READ_ONLY.includes(state.failover.mode) ? false : state.user.canEditServer;
  return before !== (state.failover.mode ?? null);
}

/** Bar at the top of every page while this server is a standby, has taken over, or was replaced */
export function failoverBar() {
  const b = state.failover;
  if (!b?.mode) return h('div', { id: 'fo-bar', hidden: true });
  const tone = b.mode === 'standby' ? 'info' : 'bad';
  const text = {
    standby: t('fo.bar.standby', { at: b.lastSync ? fmtDate(b.lastSync, getLang()) : '–' }),
    active: t('fo.bar.active', { since: fmtDate(b.since, getLang()) }),
    detached: t('fo.bar.detached'),
    yielded: t('fo.bar.yielded'),
  }[b.mode];
  return h('div', { id: 'fo-bar', class: `fo-bar ${tone}`, role: 'status' },
    h('span', { html: icon(b.mode === 'standby' ? 'shield' : 'bell') }),
    h('span', {}, text, b.mode === 'standby' && b.syncError ? h('span', {}, ` · ${why(b.syncError)}`) : null),
    state.user?.isAdmin ? h('a', { href: '/settings/failover', 'data-link': true }, t('fo.bar.open')) : null);
}
