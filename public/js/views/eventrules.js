// Event rules: chosen messages (Windows events through NXLog, syslog, traps) to chosen recipients - a mailbox, a ticket
// system, a webhook - apart from the monitors. Ready-made rules for the usual Windows events; "Test" shows which of the
// stored messages a rule would have matched before it is saved.
import { h, mount, modal, toast, fmtDate, confirmDialog } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { state, fail, navigate } from '../app.js';
import { pageHead, field, input, select, btn, formData, onOffSwitch } from './common.js';
import { lockForEditing, isReadOnly } from './failover.js';
import { sevLabel } from './events.js';

// Ready-made rules. Source and log decide together with the id - an id alone is used by many sources.
export const RULE_PRESETS = [
  ['virus', { eventIds: '1116, 1117', source: 'Defender' }],
  ['srp', { eventIds: '865-868', source: 'SoftwareRestriction' }],
  ['applocker', { eventIds: '8004, 8007', source: 'AppLocker' }],
  ['lockout', { eventIds: '4740', source: 'Security-Auditing' }],
  ['group', { eventIds: '4728, 4732, 4756', source: 'Security-Auditing' }],
  ['logCleared', { eventIds: '1102, 104', source: 'Eventlog' }],
  ['service', { eventIds: '7045', source: 'Service Control Manager' }],
  ['schedTask', { eventIds: '4698', source: 'Security-Auditing' }],
  ['userCreated', { eventIds: '4720', source: 'Security-Auditing' }],
  ['defenderOff', { eventIds: '5001', source: 'Defender' }],
  // PowerShell: scripts Windows rates as suspicious, and errors of commands - warnings only (the verbose 4104 of
  // every script stays out); with tools that are quiet themselves, what is left means something
  ['psSuspicious', { eventIds: '4104', source: 'PowerShell', maxSeverity: 4 }],
  ['psErrors', { eventIds: '4100', source: 'PowerShell', maxSeverity: 4 }],
  ['deviceErrors', { kind: 'syslog', maxSeverity: 3 }],
  // counting and open events
  ['sshFail', { source: 'sshd', regex: 'Failed password|Invalid user' }, { count: { n: 5, minutes: 10, perSender: true } }],
  ['logonFail', { eventIds: '4625', source: 'Security-Auditing' }, { count: { n: 10, minutes: 10, perSender: true } }],
  ['portDown', { regex: 'port\\s*(\\d+)\\D*down' }, { state: { open: true, closeRegex: 'port\\s*(\\d+)\\D*up', notifyClose: true } }],
  ['upsBattery', { words: ['on battery', 'auf Batterie'] }, { state: { open: true, closeWords: ['on line', 'online', 'on mains', 'Netzbetrieb'], notifyClose: true } }],
];

const list = (a) => (Array.isArray(a) ? a.join(', ') : a || '');

/** A rule in one line: what it picks */
function summary(m) {
  const parts = [];
  if (m.eventIds) parts.push(t('er.sum.ids', { ids: m.eventIds }));
  if (m.source) parts.push(t('er.sum.source', { v: m.source }));
  if (m.channel) parts.push(t('er.sum.log', { v: m.channel }));
  if (m.from?.length) parts.push(t('er.sum.from', { v: list(m.from) }));
  if (m.words?.length) parts.push(t('er.sum.words', { v: list(m.words) }));
  if (m.notWords?.length) parts.push(t('er.sum.not', { v: list(m.notWords) }));
  if (m.kind) parts.push(m.kind === 'trap' ? 'Traps' : 'Syslog');
  if ((m.maxSeverity ?? 7) < 7) parts.push(t('er.sum.sev', { v: sevLabel(m.maxSeverity) }));
  if (m.regex) parts.push(t('er.sum.regex', { v: m.regex }));
  return parts.join(' · ');
}
/** Counting and open events in one line */
function extras(r) {
  const parts = [];
  if (r.count?.n > 1) parts.push(t(r.count.perSender ? 'er.sum.countSender' : 'er.sum.count', { n: r.count.n, min: r.count.minutes }));
  if (r.state?.open) parts.push(t('er.sum.open'));
  return parts.join(' · ');
}

export async function renderEventRules(main) {
  if (!(state.user.canEditServer ?? state.user.canEdit)) { navigate('/', { replace: true }); return; }
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, body));
  const box = h('div');
  let chans = [];
  async function load() {
    let rules = [];
    try { [rules, chans] = await Promise.all([get('/event-rules'), get('/channels').catch(() => [])]); } catch (e) { fail(e); return; }
    if (!body.isConnected) return;
    const chanName = (id) => chans.find((c) => c.id === id)?.name || '?';
    mount(box, rules.length ? h('div', { class: 'panel' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', { class: 'min' }, t('switch.head')), h('th', {}, t('er.name')), h('th', {}, t('er.to')), h('th', {}, t('er.sending')), h('th', {}, t('er.hits')), h('th', {}))),
      h('tbody', {}, rules.map((r) => h('tr', { class: r.enabled ? '' : 'muted' },
        h('td', { class: 'min nowrap' }, onOffSwitch({ on: r.enabled, label: r.name, disabled: isReadOnly(), onChange: async (on) => {
          await post(`/event-rules/${r.id}/enabled`, { enabled: on });
          toast(t(on ? 'switch.onDone' : 'switch.offDone', { name: r.name })); load();
        } })),
        h('td', {}, h('span', { class: 'name' }, r.name),
          h('div', { class: 'sub' }, summary(r.match)),
          extras(r) ? h('div', { class: 'sub' }, extras(r)) : null,
          r.disabled_reason ? h('div', { class: 'sub bad-text' }, t('er.slowOff')) : null,
          r.blocked?.length ? h('div', { class: 'sub bad-text' }, t('er.blocked', { ids: r.blocked.join(', ') })) : null),
        h('td', { class: 'small' }, r.channels.map(chanName).join(', ')),
        h('td', { class: 'small' }, r.mode === 'digest' ? t('er.digestEvery', { n: r.digest_min }) : t('er.eachMax', { n: r.max_per_hour })),
        h('td', { class: 'small' }, t('er.hits24', { n: r.hits24h }),
          r.lastHit ? h('div', { class: 'sub' }, t('er.last', { at: fmtDate(r.lastHit, getLang()) })) : null,
          r.open ? h('div', { class: 'sub' }, t(r.open === 1 ? 'er.open1' : 'er.open', { n: r.open })) : null,
          r.counting ? h('div', { class: 'sub' }, t(r.counting === 1 ? 'er.counting1' : 'er.counting', { n: r.counting })) : null,
          r.openEvents ? h('div', {}, h('a', { class: 'badge badge-warn', href: '/events?view=open', 'data-link': true }, t('er.openEvents', { n: r.openEvents }))) : null,
          r.failed24h ? h('div', { class: 'sub bad-text' }, t('er.failed', { n: r.failed24h })) : null),
        h('td', { class: 'min nowrap' }, isReadOnly() ? null : [
          btn(t('edit'), { class: 'btn btn-sm btn-ghost', onclick: () => openRuleForm(r, load) }, 'edit'),
          btn(t('delete'), { class: 'btn btn-sm btn-ghost', onclick: async () => {
            if (!await confirmDialog(t('delete'), t('er.deleteConfirm', { name: r.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/event-rules/${r.id}`); toast(t('deleted')); load(); } catch (e) { fail(e); }
          } }, 'trash')])))))))
      : h('div', { class: 'panel panel-pad' }, h('p', { class: 'muted', style: { margin: '0 0 10px' } }, t('er.none')),
        isReadOnly() ? null : btn(t('er.new'), { class: 'btn btn-primary btn-sm', onclick: () => openRuleForm(null, load) }, 'plus')));
    lockForEditing(body);
  }
  mount(body, pageHead(t('er.title'), t('er.lead'),
    btn(t('er.back'), { class: 'btn', onclick: () => navigate('/events') }, 'bell'),
    isReadOnly() ? null : btn(t('er.new'), { class: 'btn btn-primary', onclick: () => openRuleForm(null, load) }, 'plus')), box);
  await load();
}

/** The form of a rule (new, edit, or from a message: preset = { name, match }) */
export async function openRuleForm(rule, done, preset = null) {
  let chans = [];
  try { chans = await get('/channels'); } catch { /* list stays empty */ }
  const v = rule || { name: preset?.name || '', enabled: true, match: { maxSeverity: 7, ...(preset?.match || {}) }, channels: [], mode: 'each', digest_min: 15, max_per_hour: 20,
    count: { n: 1, minutes: 10, perSender: false }, state: { open: false, closeWords: [], closeIds: '', closeRegex: '', expireHours: 0, notifyClose: false } };
  const m0 = v.match || {};
  const c0 = v.count || {}; const s0 = v.state || {};
  const f = {
    eventIds: input('eventIds', m0.eventIds || '', { placeholder: '1116, 1117, 865-868', autocomplete: 'off', class: 'mono' }),
    source: input('source', m0.source || '', { placeholder: 'Defender', autocomplete: 'off' }),
    channel: input('channel', m0.channel || '', { placeholder: 'Security', autocomplete: 'off' }),
    from: input('from', list(m0.from), { placeholder: t('er.f.fromPh'), autocomplete: 'off' }),
    words: input('words', list(m0.words), { autocomplete: 'off' }),
    notWords: input('notWords', list(m0.notWords), { autocomplete: 'off' }),
    kind: select('kind', [['', t('er.f.kindAll')], ['syslog', 'Syslog'], ['trap', 'SNMP-Traps']], m0.kind || ''),
    maxSeverity: select('maxSeverity', [['7', t('ev.f.all')], ['4', t('ev.f.warning')], ['3', t('ev.f.err')], ['2', t('ev.f.crit')]], String(m0.maxSeverity ?? 7)),
    regex: input('regex', m0.regex || '', { placeholder: 'Port (\\d+) link down', autocomplete: 'off', spellcheck: 'false', class: 'mono', maxlength: 300 }),
  };
  // counting and open events
  const o = {
    count_n: input('count_n', c0.n ?? 1, { type: 'number', min: 1, max: 1000 }),
    count_minutes: input('count_minutes', c0.minutes ?? 10, { type: 'number', min: 1, max: 1440 }),
    perSender: h('input', { type: 'checkbox', name: 'perSender', checked: !!c0.perSender }),
    open: h('input', { type: 'checkbox', name: 'open', checked: !!s0.open }),
    closeWords: input('closeWords', list(s0.closeWords), { autocomplete: 'off' }),
    closeIds: input('closeIds', s0.closeIds || '', { autocomplete: 'off', class: 'mono' }),
    closeRegex: input('closeRegex', s0.closeRegex || '', { placeholder: 'Port (\\d+) link up', autocomplete: 'off', spellcheck: 'false', class: 'mono', maxlength: 300 }),
    expireHours: input('expireHours', s0.expireHours ?? 0, { type: 'number', min: 0, max: 720 }),
    notifyClose: h('input', { type: 'checkbox', name: 'notifyClose', checked: !!s0.notifyClose }),
  };
  const stateBox = h('div', { class: 'full form-grid' },
    field(t('er.f.closeWords'), o.closeWords, t('er.f.closeWordsHint')),
    field(t('er.f.closeIds'), o.closeIds),
    field(t('er.f.closeRegex'), o.closeRegex, t('er.f.closeRegexHint')),
    field(t('er.f.expireHours'), o.expireHours, t('er.f.expireHoursHint')),
    h('div', { class: 'full' }, field(t('er.f.notifyClose'), o.notifyClose)));
  const syncState = () => { stateBox.hidden = !o.open.checked; };
  o.open.addEventListener('change', syncState); syncState();
  const name = input('name', v.name, { required: true, maxlength: 120 });
  const presetSel = rule ? null : select('preset', [['', t('er.f.presetNone')], ...RULE_PRESETS.map(([k]) => [k, t(`er.p.${k}`)])], '');
  presetSel?.addEventListener('change', () => {
    const p = RULE_PRESETS.find(([k]) => k === presetSel.value);
    if (!p) return;
    const m = { eventIds: '', source: '', channel: '', from: '', words: '', notWords: '', kind: '', maxSeverity: '7', regex: '', ...p[1] };
    for (const [k, el] of Object.entries(f)) el.value = list(m[k] ?? '');
    const x = p[2] || {};
    o.count_n.value = String(x.count?.n ?? 1); o.count_minutes.value = String(x.count?.minutes ?? 10); o.perSender.checked = !!x.count?.perSender;
    o.open.checked = !!x.state?.open; o.closeWords.value = list(x.state?.closeWords); o.closeIds.value = x.state?.closeIds || '';
    o.closeRegex.value = x.state?.closeRegex || ''; o.expireHours.value = String(x.state?.expireHours ?? 0); o.notifyClose.checked = !!x.state?.notifyClose;
    syncState();
    if (!name.value.trim() || RULE_PRESETS.some(([k]) => name.value === t(`er.p.${k}`))) name.value = t(`er.p.${p[0]}`);
  });
  const selected = new Set(v.channels || []);
  const chanBox = chans.length ? h('div', { class: 'full field' }, t('er.f.to'),
    h('div', { class: 'chips' }, chans.map((c) => h('label', { class: 'check', style: { marginRight: '14px' } },
      h('input', { type: 'checkbox', name: `ch_${c.id}`, checked: selected.has(c.id) }), `${c.name}${c.enabled ? '' : ` (${t('er.off')})`}`))),
    h('span', { class: 'hint' }, t('er.f.toHint')))
    : h('p', { class: 'full muted small' }, state.user.isAdmin ? t('mon.f.noChannelsAdmin') : t('mon.f.noChannels'));
  const mode = select('mode', [['each', t('er.f.each')], ['digest', t('er.f.digest')]], v.mode);
  const maxBox = field(t('er.f.perHour'), input('max_per_hour', v.max_per_hour, { type: 'number', min: 1, max: 500 }), t('er.f.perHourHint'));
  const digestBox = field(t('er.f.digestMin'), input('digest_min', v.digest_min, { type: 'number', min: 1, max: 1440 }), t('er.f.digestHint'));
  const sync = () => { maxBox.hidden = mode.value !== 'each'; };
  mode.addEventListener('change', sync); sync();
  const testOut = h('div', { class: 'full', 'aria-live': 'polite' });
  const readMatch = () => {
    const d = formData(form);
    return { eventIds: d.eventIds, source: d.source, channel: d.channel, from: d.from, words: d.words, notWords: d.notWords, kind: d.kind, maxSeverity: Number(d.maxSeverity), regex: d.regex };
  };
  async function runTest() {
    try {
      const r = await post('/event-rules/test', { match: readMatch() });
      mount(testOut, h('div', { class: 'note', style: { margin: 0 } }, h('div', { style: { minWidth: 0 } },
        h('strong', {}, r.count ? t('er.test.found', { n: r.count }) : t('er.test.none')), h('span', { class: 'muted small' }, ` ${t('er.test.of', { n: r.checked })}`),
        r.list.length ? h('ul', { class: 'small', style: { margin: '6px 0 0', paddingLeft: '18px' } }, r.list.slice(0, 5).map((e) => h('li', {},
          `${fmtDate(e.at, getLang())} · ${e.device_name || e.host || e.source_ip} · ${e.event_id !== null ? `${e.event_id} · ` : ''}${String(e.text).slice(0, 140)}`))) : null)));
    } catch (e) { fail(e); }
  }
  const form = h('form', { class: 'form-grid' },
    presetSel ? h('div', { class: 'full' }, field(t('er.f.preset'), presetSel, t('er.f.presetHint'))) : null,
    h('div', { class: 'full' }, field(t('er.name'), name)),
    h('h3', { class: 'full section-title', style: { margin: '6px 0 0' } }, t('er.f.which')),
    field(t('er.f.eventIds'), f.eventIds, t('er.f.eventIdsHint')),
    field(t('er.f.source'), f.source, t('er.f.sourceHint')),
    field(t('er.f.channel'), f.channel, t('er.f.channelHint')),
    field(t('er.f.from'), f.from, t('er.f.fromHint')),
    field(t('er.f.words'), f.words, t('er.f.wordsHint')),
    field(t('er.f.notWords'), f.notWords, t('er.f.notWordsHint')),
    field(t('er.f.kind'), f.kind),
    field(t('ev.severity'), f.maxSeverity),
    h('div', { class: 'full' }, field(t('er.f.regex'), f.regex, t('er.f.regexHint'))),
    h('div', { class: 'full actions', style: { justifyContent: 'flex-start' } }, btn(t('er.test'), { class: 'btn btn-sm', onclick: runTest }, 'search')),
    testOut,
    h('h3', { class: 'full section-title', style: { margin: '6px 0 0' } }, t('er.f.when')),
    field(t('er.f.countN'), o.count_n, t('er.f.countNHint')),
    field(t('er.f.countMinutes'), o.count_minutes),
    h('div', { class: 'full' }, field(t('er.f.perSender'), o.perSender, t('er.f.perSenderHint'))),
    h('div', { class: 'full' }, field(t('er.f.open'), o.open, t('er.f.openHint'))),
    stateBox,
    h('h3', { class: 'full section-title', style: { margin: '6px 0 0' } }, t('er.f.where')),
    chanBox,
    field(t('er.f.mode'), mode),
    maxBox,
    digestBox,
    h('div', { class: 'full' }, field(t('er.f.enabled'), h('input', { type: 'checkbox', name: 'enabled', checked: v.enabled }))));
  const m = modal(rule ? t('er.edit') : t('er.new'), form, { wide: true, onSubmit: async () => {
    const d = formData(form);
    const payload = { name: d.name, enabled: d.enabled, match: readMatch(), channels: chans.filter((c) => d[`ch_${c.id}`]).map((c) => c.id),
      mode: d.mode, digest_min: Number(d.digest_min), max_per_hour: Number(d.max_per_hour),
      count: { n: Number(d.count_n), minutes: Number(d.count_minutes), perSender: d.perSender },
      state: { open: d.open, closeWords: d.closeWords, closeIds: d.closeIds, closeRegex: d.closeRegex, expireHours: Number(d.expireHours), notifyClose: d.notifyClose } };
    try {
      if (rule) await put(`/event-rules/${rule.id}`, payload); else await post('/event-rules', payload);
      m.close(); toast(t('saved')); done?.();
    } catch (ex) { fail(ex); }
  }, actions: [btn(t('cancel'), { onclick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
}
