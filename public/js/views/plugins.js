// Settings → Plugins: own small scripts for the host script, written here (PowerShell for Windows, sh for Linux), for
// all machines of a system or for tags, locations and single devices. Downloaded as a file and put into the plugins
// folder of the machines; the host script runs exactly that file (WhatsOnMyNet names its fingerprint) - a changed one
// or an old version does not run. The page shows how far each plugin is rolled out.
import { h, mount, toast, confirmDialog, fmtAgo } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { checkText } from '../checktext.js';
import { fail } from '../app.js';
import { field, input, select, btn } from './common.js';

const EXAMPLES = {
  windows: `# Beispiel: Alter der neuesten Sicherung in Stunden
$ordner = 'D:\\Backup'
$neueste = Get-ChildItem -LiteralPath $ordner -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($neueste) {
  $stunden = [math]::Round(((Get-Date) - $neueste.LastWriteTime).TotalHours, 1)
  "Backup-Alter: $stunden h"
} else {
  "2 Backup - keine Sicherung in $ordner gefunden"
}`,
  linux: `#!/bin/sh
# Beispiel: Alter der neuesten Sicherung in Stunden
ordner=/srv/backup
neueste=$(ls -t "$ordner" 2>/dev/null | head -n 1)
if [ -n "$neueste" ]; then
  alter=$(( ( $(date +%s) - $(stat -c %Y "$ordner/$neueste") ) / 3600 ))
  echo "Backup-Alter: $alter h"
else
  echo "2 Backup - keine Sicherung in $ordner gefunden"
fi`,
};

const osName = (os) => (os === 'windows' ? 'Windows (PowerShell)' : 'Linux (sh)');

/** "All Windows machines" / "Tag dateiserver, Hauptgebäude, 2 devices" */
function targetText(tg, choices) {
  if (tg.all) return t('plg.forAll');
  const parts = [];
  for (const x of tg.tags || []) parts.push(`#${x}`);
  for (const id of tg.locations || []) parts.push(choices?.locations.find((l) => l.id === id)?.name || `#${id}`);
  const devs = (tg.devices || []).map((id) => choices?.devices.find((d) => d.id === id)?.name).filter(Boolean);
  if (devs.length) parts.push(devs.length > 3 ? t('plg.nDevices', { n: devs.length }) : devs.join(', '));
  return parts.join(' · ');
}

/** The file exactly as WhatsOnMyNet made it (its fingerprint is what the machines check) */
function downloadPlugin(p) {
  const a = h('a', { href: `/api/plugins/${p.id}/download`, download: p.file });
  document.body.append(a); a.click(); a.remove();
}

export async function pluginsSettings(body, reload) {
  const [list, choices] = await Promise.all([get('/plugins'), get('/plugins/choices')]);
  // the list has no code: the editor gets the whole plugin
  const edit = async (p) => {
    try { editor(body, p ? { ...await get(`/plugins/${p.id}`), rollout: p.rollout } : null, choices, reload); } catch (ex) { fail(ex); }
  };
  const state = (p) => {
    const r = p.rollout;
    if (!p.enabled) return h('span', { class: 'badge' }, t('plg.off'));
    if (!r.expected) return h('span', { class: 'muted small' }, t('plg.noMachine'));
    const bad = r.expected - r.ok;
    return h('span', { title: r.problems.map((x) => `${x.name}: ${t(`plg.st.${x.state}`)}`).join('\n') },
      h('span', { class: `badge badge-${bad ? 'new' : 'ok'}` }, t('plg.running', { ok: r.ok, n: r.expected })));
  };
  mount(body,
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head', style: { paddingBottom: '12px', flexWrap: 'wrap' } }, h('h2', {}, t('set.plugins')),
        btn(t('plg.new'), { class: 'btn btn-primary', onclick: () => edit(null) }, 'plus')),
      h('p', { class: 'muted', style: { padding: '0 20px' } }, t('plg.lead')),
      list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, t('px.name')), h('th', {}, t('hs.os')), h('th', { class: 'hide-sm' }, t('plg.for')), h('th', {}, t('plg.rollout')), h('th', {}))),
        h('tbody', {}, list.map((p) => h('tr', {},
          h('td', {}, h('a', { href: '#', class: 'name', onclick: (e) => { e.preventDefault(); edit(p); } }, p.name), h('span', { class: 'muted small' }, ` v${p.version}`),
            p.description ? h('div', { class: 'muted small' }, p.description) : null),
          h('td', {}, p.os === 'windows' ? 'Windows' : 'Linux', p.interval > 5 ? h('div', { class: 'muted small' }, t('plg.every', { n: everyText(p.interval) })) : null),
          h('td', { class: 'hide-sm' }, targetText(p.targets, choices)),
          h('td', {}, state(p)),
          h('td', { class: 'min' }, h('div', { class: 'actions' },
            btn(t('plg.download'), { class: 'btn btn-sm', onclick: () => downloadPlugin(p) }, 'download'),
            btn(t('edit'), { class: 'btn btn-sm btn-ghost', onclick: () => edit(p) }, 'edit'))))))))
        : h('div', { class: 'panel-pad' }, h('p', { class: 'muted', style: { margin: 0 } }, t('plg.none')))),
    formatHelp(choices));
}

/** The two output formats a plugin may print, with an example each */
function formatHelp(choices) {
  return h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('plg.formatTitle')),
    h('p', { class: 'muted small', style: { marginTop: 0 } }, t('plg.formatLead')),
    h('div', { class: 'plg-formats' },
      h('div', {}, h('b', { class: 'small' }, t('plg.formatValue')), h('pre', { class: 'code' }, 'Backup-Alter: 26 h\nOffene Tickets: 12\nFreier Speicher: 1,5 GB'), h('p', { class: 'muted small' }, t('plg.formatValueHint'))),
      h('div', {}, h('b', { class: 'small' }, t('plg.formatCheck')), h('pre', { class: 'code' }, '0 Backup count=12 letzte Sicherung vor 2 h\n2 Lizenzserver - lic01 nicht erreichbar'), h('p', { class: 'muted small' }, t('plg.formatCheckHint')))),
    h('p', { class: 'muted small', style: { margin: '8px 0 0' } }, t('plg.where', { win: choices.dirs.windows, linux: choices.dirs.linux })));
}

// how often a plugin runs (minutes) - the same steps the server accepts
const INTERVALS = [5, 10, 15, 30, 60, 120, 360, 720, 1440];
const everyText = (n) => (n < 60 ? `${n} min` : `${n / 60} h`);

/** Writing or changing a plugin: name, system, for whom, time limit, code */
function editor(body, p, choices, reload) {
  const v = p || { name: '', description: '', os: 'windows', targets: { all: true }, timeout: 30, interval: 5, enabled: true, code: '' };
  const name = input('name', v.name, { required: true, maxlength: 80, placeholder: t('plg.namePh') });
  const desc = input('description', v.description, { maxlength: 300, placeholder: t('plg.descPh') });
  const os = select('os', [['windows', osName('windows')], ['linux', osName('linux')]], v.os);
  const timeout = input('timeout', v.timeout, { type: 'number', min: 5, max: 120 });
  const interval = select('interval', INTERVALS.map((n) => [String(n), n === 5 ? t('plg.everyRun') : t('plg.every', { n: everyText(n) })]), String(v.interval || 5));
  const enabled = h('input', { type: 'checkbox', name: 'enabled', checked: v.enabled });
  const code = h('textarea', { name: 'code', class: 'mono plg-code', rows: 18, spellcheck: 'false', autocomplete: 'off', wrap: 'off', 'aria-label': t('plg.code') });
  code.value = p ? p.code || '' : EXAMPLES.windows;
  // Tab writes two spaces (Esc then Tab leaves the field, as everywhere)
  let escaped = false;
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { escaped = true; return; }
    if (e.key === 'Tab' && !e.shiftKey && !escaped) { e.preventDefault(); code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end'); }
    escaped = false;
  });
  os.addEventListener('change', () => {
    // an untouched example follows the system
    if (Object.values(EXAMPLES).includes(code.value)) code.value = EXAMPLES[os.value];
    devList();
  });
  // for whom: all machines of the system, or tags / locations / devices
  const all = h('input', { type: 'radio', name: 'scope', value: 'all', checked: !!v.targets.all });
  const some = h('input', { type: 'radio', name: 'scope', value: 'some', checked: !v.targets.all });
  const tags = input('tags', (v.targets.tags || []).join(', '), { placeholder: t('plg.tagsPh'), list: 'plg-tags', autocomplete: 'off' });
  const tagList = h('datalist', { id: 'plg-tags' }, choices.tags.map((x) => h('option', { value: x })));
  const locs = h('div', { class: 'plg-checks' }, choices.locations.map((l) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: l.id, checked: (v.targets.locations || []).includes(l.id) }), h('span', {}, l.name))));
  const devBox = h('div', { class: 'plg-checks plg-devs' });
  const chosen = new Set(v.targets.devices || []);
  function devList() {
    const mine = choices.devices.filter((d) => d.os === os.value);
    mount(devBox, mine.length ? mine.map((d) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', value: d.id, checked: chosen.has(d.id), onchange: (e) => { if (e.target.checked) chosen.add(d.id); else chosen.delete(d.id); } }), h('span', {}, d.name)))
      : h('p', { class: 'muted small', style: { margin: 0 } }, t('plg.noDevices')));
  }
  devList();
  const someBox = h('div', { class: 'plg-some' },
    field(t('plg.tags'), tags, t('plg.tagsHint')), tagList,
    choices.locations.length ? h('div', { class: 'field' }, h('span', {}, t('plg.locations')), locs) : null,
    h('div', { class: 'field' }, h('span', {}, t('plg.devices')), devBox));
  const showSome = () => { someBox.hidden = !some.checked; };
  all.addEventListener('change', showSome); some.addEventListener('change', showSome); showSome();

  const targets = () => (all.checked ? { all: true } : {
    tags: tags.value.split(',').map((x) => x.trim()).filter(Boolean),
    locations: [...locs.querySelectorAll('input:checked')].map((x) => Number(x.value)),
    devices: [...chosen],
  });
  const result = h('div', { role: 'status' });
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const payload = { name: name.value, description: desc.value, os: os.value, timeout: Number(timeout.value), interval: Number(interval.value), enabled: enabled.checked, code: code.value, targets: targets() };
    try {
      const r = p ? await put(`/plugins/${p.id}`, payload) : await post('/plugins', payload);
      toast(t('saved'));
      p = r;
      mount(result, h('div', { class: 'note ok' },
        h('div', {}, h('b', {}, (!r.newVersion && p && r.version > 1) ? t('plg.savedSame') : t('plg.savedNew', { v: r.version })),
          h('p', { class: 'small', style: { margin: '4px 0 8px' } }, t('plg.savedHint', { file: r.file, dir: choices.dirs[r.os] })),
          btn(t('plg.download'), { class: 'btn btn-sm btn-primary', onclick: () => downloadPlugin(r) }, 'download'))));
    } catch (ex) { fail(ex); }
  } },
  h('div', { class: 'form-grid' }, field(t('px.name'), name), field(t('hs.os'), os)),
  field(t('plg.desc'), desc),
  h('div', { class: 'field' }, h('span', {}, t('plg.for')),
    h('label', { class: 'check' }, all, h('span', {}, t('plg.forAllOs'))),
    h('label', { class: 'check' }, some, h('span', {}, t('plg.forSome'))), someBox),
  h('div', { class: 'field' }, h('span', { class: 'plg-code-head' }, t('plg.code'),
    btn(t('plg.example'), { class: 'btn btn-sm btn-ghost', onclick: async () => {
      if (code.value.trim() && !Object.values(EXAMPLES).includes(code.value) && !await confirmDialog(t('plg.example'), t('plg.exampleConfirm'), t('plg.example'), t('cancel'))) return;
      code.value = EXAMPLES[os.value];
    } })), code, h('span', { class: 'hint' }, t('plg.codeHint'))),
  h('div', { class: 'form-grid' }, field(t('plg.interval'), interval, t('plg.intervalHint')), field(t('plg.timeout'), timeout, t('plg.timeoutHint'))),
  h('div', { class: 'form-grid' }, field(t('plg.enabled'), enabled, t('plg.enabledHint'))),
  result,
  h('div', { class: 'actions', style: { justifyContent: 'space-between' } },
    p ? btn(t('delete'), { class: 'btn btn-ghost danger', onclick: async () => {
      if (!await confirmDialog(t('delete'), t('plg.deleteConfirm', { name: p.name }), t('delete'), t('cancel'), { danger: true })) return;
      try { await del(`/plugins/${p.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
    } }, 'trash') : h('span'),
    h('div', { class: 'actions' }, btn(t('cancel'), { class: 'btn', onclick: () => reload() }), h('button', { class: 'btn btn-primary', type: 'submit' }, t('save')))));
  const rollout = p?.rollout?.problems?.length ? h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('plg.problems')),
    h('ul', { class: 'port-macs' }, p.rollout.problems.map((x) => h('li', {}, h('a', { href: `/devices/${x.device}`, 'data-link': true }, x.name),
      h('span', { class: `badge badge-${x.state === 'missing' || x.state === 'scriptOld' ? 'new' : 'bad'}` }, t(`plg.st.${x.state}`)))))) : null;
  mount(body, h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title', style: { marginTop: 0 } }, p ? `${p.name} · v${p.version}` : t('plg.new')),
    p ? h('p', { class: 'muted small', style: { marginTop: 0 } }, t('plg.changed', { when: fmtAgo(p.updated_at, t), who: p.updated_by || '–' })) : null,
    form), rollout, formatHelp(choices));
  name.focus();
}

/** Device page: the plugins meant for this machine and what its host script says about them */
export function pluginsBlock(pl, isAdmin) {
  if (!pl?.items?.length) return null;
  const tone = { ok: 'ok', missing: 'new', outdated: 'new', notAssigned: '', changed: 'bad', error: 'bad', timeout: 'bad', deferred: 'new', unsafe: 'bad', noHeader: '', oldFile: '' };
  return [h('h3', { class: 'sub-title' }, t('plg.onDevice', { n: pl.items.length })),
    !pl.scriptKnows ? h('p', { class: 'note warn small', style: { margin: '0 0 6px' } }, t('plg.scriptOld')) : null,
    h('ul', { class: 'ev-list' }, pl.items.map((x) => h('li', {},
      h('span', { class: `badge ${tone[x.state] ? `badge-${tone[x.state]}` : ''}` }, t(`plg.st.${x.state}`)),
      h('b', { class: 'small' }, x.name || x.file),
      x.version ? h('span', { class: 'muted small' }, `v${x.version}${x.reportedVersion && x.reportedVersion !== x.version ? ` (${t('plg.here', { v: x.reportedVersion })})` : ''}`) : null,
      x.state === 'ok' ? (x.text ? h('span', { class: 'muted small' }, checkText(x.text, getLang())) : null)
        : h('span', { class: 'small' }, t(`plg.do.${x.state}`, { text: checkText(x.text, getLang()) })),
      isAdmin && x.id ? h('a', { class: 'small', href: '/settings/plugins', 'data-link': true }, t('plg.manage')) : null)))];
}
