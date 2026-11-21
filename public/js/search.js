// Search over everything: Ctrl+K (⌘K on a Mac), "/" or the search field at the top of the menu. Finds devices,
// monitors, sensors, locations, hypervisors and users (from the server, only what the user may see), and pages,
// settings and chapters of the manual (here in the browser). Arrow keys choose, Enter opens, Esc closes.
import { h, mount } from './dom.js';
import { get } from './api.js';
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';
import { slug, leadOf } from './md.js';
import { GROUPS as SETTING_GROUPS } from './views/settingsnav.js';

const KIND_PAGE = { unifi: '/controllers', omada: '/controllers', mikrotik: '/controllers', redfish: '/hardware', aws: '/cloud', azure: '/cloud', gcp: '/cloud', m365: '/cloud' };
export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const shortcutLabel = () => (isMac() ? '⌘K' : t('gs.ctrlK'));

let manual = null; // [{ id, text }] of the manual in the current language, loaded once
async function manualHeadings() {
  const lang = getLang() === 'en' ? 'en' : 'de';
  if (manual?.lang === lang) return manual.list;
  try {
    const text = await (await fetch(`/help/manual.${lang}.md`)).text();
    // chapters (## / ###) and the bold leads of paragraphs, each with the chapter it is in
    const list = [];
    let chapter = '';
    for (const l of text.split('\n')) {
      const hd = /^#{2,3}\s+(.*)$/.exec(l);
      if (hd) { chapter = hd[1].replace(/[*_`]/g, ''); list.push({ id: slug(hd[1]), text: chapter, sub: '' }); continue; }
      const lead = leadOf(l);
      if (lead) list.push({ id: slug(lead), text: lead.replace(/[*_`]/g, ''), sub: chapter });
    }
    manual = { lang, list };
    return list;
  } catch { return []; }
}

/** Pages of the menu this user may open */
function pages(user) {
  const server = user.canEditServer ?? user.canEdit;
  return [
    ['/', 'dashboard', 'dashboard'], ['/inventory', 'inventory', 'inventory'], ['/scan', 'scan', 'radar'], ['/topology', 'topology', 'switch'],
    ['/locations', 'locations', 'location'], ['/monitoring', 'monitoring', 'pulse'], ['/monitoring/sensors', 'sensors', 'gauge'],
    server && ['/events', 'events', 'bell'], server && ['/virtualization', 'proxmox', 'hypervisor'], server && ['/controllers', 'controllers', 'accesspoint'],
    server && ['/hardware', 'hardware', 'server'], server && ['/cloud', 'cloud', 'cloud'], user.isAdmin && ['/reports', 'reports', 'mail'],
    ['/monitoring/maintenance', 'mon.tab.maintenance', 'history'], user.isAdmin && ['/monitoring/status', 'mon.tab.status', 'dashboard'],
    ['/account', 'account', 'user'], ['/help', 'help', 'help'],
  ].filter(Boolean).map(([href, key, ico]) => ({ href, ico, label: t(key.includes('.') ? key : `nav.${key}`), words: '' }));
}

/** Sections of the settings (administrators), found by their name and by what they are for */
function settings(user) {
  if (!user.isAdmin) return [];
  return SETTING_GROUPS.flatMap(([, list]) => list).map(([s, ico]) => ({ href: `/settings/${s}`, ico, label: `${t('set.title')}: ${t(`set.${s}`)}`, words: t(`set.help.${s}`) }));
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const local = (list, q) => {
  const n = norm(q);
  const hit = list.map((x) => [norm(x.label).startsWith(n) ? 0 : norm(x.label).includes(n) ? 1 : norm(x.words).includes(n) ? 2 : 9, x]).filter(([s]) => s < 9);
  return hit.sort((a, b) => a[0] - b[0]).map(([, x]) => x);
};

let open = null;

/** Opens the search (only one at a time); user = state.user, go = navigate */
export function openSearch(user, go) {
  if (open) { open.querySelector('input')?.focus(); return; }
  const input = h('input', { type: 'search', class: 'gs-input', placeholder: t('gs.placeholder'), 'aria-label': t('gs.placeholder'), autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'gs-list', 'aria-autocomplete': 'list' });
  const list = h('div', { class: 'gs-list', id: 'gs-list', role: 'listbox', 'aria-label': t('gs.results') });
  const dlg = h('dialog', { class: 'gs', 'aria-label': t('gs.title') },
    h('div', { class: 'gs-head' }, h('span', { class: 'gs-ico', html: icon('search') }), input, h('kbd', { class: 'gs-esc' }, 'Esc')),
    list,
    h('div', { class: 'gs-foot muted small' }, h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ` ${t('gs.choose')}`), h('span', {}, h('kbd', {}, '↵'), ` ${t('gs.open')}`),
      h('span', {}, h('kbd', {}, shortcutLabel()), ` ${t('gs.anywhere')}`)));
  document.body.append(dlg);
  open = dlg;
  let items = []; let sel = 0; let seq = 0; let timer = null;

  const close = () => { clearTimeout(timer); dlg.close(); dlg.remove(); open = null; };
  const choose = (x) => { if (!x) return; close(); if (x.external) location.assign(x.href); else go(x.href); };
  const mark = () => {
    [...list.querySelectorAll('.gs-item')].forEach((el, i) => { el.classList.toggle('sel', i === sel); el.setAttribute('aria-selected', i === sel ? 'true' : 'false'); });
    const cur = list.querySelector('.gs-item.sel');
    cur?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', cur?.id || '');
  };
  const draw = (groups, note) => {
    items = [];
    const nodes = [];
    for (const [title, rows] of groups) {
      if (!rows.length) continue;
      nodes.push(h('div', { class: 'gs-group', role: 'presentation' }, title));
      for (const x of rows) {
        const i = items.length;
        items.push(x);
        nodes.push(h('a', { class: 'gs-item', id: `gs-${i}`, role: 'option', href: x.href, onclick: (e) => { e.preventDefault(); choose(x); }, onmousemove: () => { if (sel !== i) { sel = i; mark(); } } },
          h('span', { class: 'gs-item-ico', html: icon(x.ico || 'search') }),
          h('span', { class: 'gs-item-text' }, h('span', { class: 'gs-item-label' }, x.label), x.sub ? h('span', { class: 'gs-item-sub' }, x.sub) : null),
          x.status ? h('span', { class: `dot dot-${x.status}`, title: x.statusText || '' }) : null));
      }
    }
    sel = Math.min(sel, Math.max(0, items.length - 1));
    mount(list, nodes.length ? nodes : h('p', { class: 'gs-empty muted' }, note));
    mark();
  };

  const tone = (s) => ({ up: 'ok', down: 'bad', unreachable: 'bad', pending: 'new', maintenance: 'muted', paused: 'muted' }[s] || 'muted');
  async function run() {
    const q = input.value.trim();
    const my = ++seq;
    if (!q) {
      // nothing typed yet: where people most often go
      draw([[t('gs.g.pages'), pages(user).slice(0, 7)]], '');
      return;
    }
    const help = (await manualHeadings()).filter((x) => norm(x.text).includes(norm(q)))
      .sort((a, b) => (norm(a.text).startsWith(norm(q)) ? 0 : 1) - (norm(b.text).startsWith(norm(q)) ? 0 : 1)).slice(0, 6)
      .map((x) => ({ href: `/help#${x.id}`, ico: 'help', label: x.text, sub: x.sub }));
    const quick = [[t('gs.g.pages'), local(pages(user), q).slice(0, 5)], [t('gs.g.settings'), local(settings(user), q).slice(0, 5)]];
    if (q.length < 2) { draw([...quick, [t('gs.g.help'), help]], t('gs.none', { q })); return; }
    draw([...quick, [t('gs.g.help'), help]], t('gs.searching'));
    let r;
    try { r = await get(`/search?q=${encodeURIComponent(q)}`); } catch { r = null; }
    if (my !== seq || !open) return; // a newer search is running, or closed
    const groups = r ? [
      [t('gs.g.devices'), r.devices.map((d) => ({ href: `/devices/${d.id}`, ico: 'inventory', label: d.name, sub: [d.ip, d.location, t(`type.${d.type}`)].filter(Boolean).join(' · ') }))],
      [t('gs.g.hosts'), r.hosts.map((x) => ({ href: `${KIND_PAGE[x.kind] || '/virtualization'}?q=${encodeURIComponent(x.name)}`, ico: 'hypervisor', label: x.name, sub: t(`gs.kind.${KIND_PAGE[x.kind] ? KIND_PAGE[x.kind].slice(1) : 'virtualization'}`) }))],
      [t('gs.g.monitors'), r.monitors.map((m) => ({ href: `/monitoring/${m.id}`, ico: 'pulse', label: m.name, sub: [t(`mon.type.${m.type}`), m.device, m.group].filter(Boolean).join(' · '), status: tone(m.status), statusText: t(`mon.status.${m.status}`) }))],
      [t('gs.g.sensors'), r.sensors.map((m) => ({ href: `/monitoring/${m.id}`, ico: 'gauge', label: m.name, sub: m.device, status: tone(m.status), statusText: t(`mon.status.${m.status}`) }))],
      [t('gs.g.locations'), r.locations.map((l) => ({ href: `/locations#loc-${l.id}`, ico: 'location', label: l.name }))],
      [t('gs.g.users'), r.users.map((u) => ({ href: '/settings/users', ico: 'user', label: u.name, sub: u.username !== u.name ? u.username : '' }))],
    ] : [];
    // what the server found first (that is what people look for), then pages, settings, manual
    draw([...groups, ...quick, [t('gs.g.help'), help]], r ? t('gs.none', { q }) : t('err.network'));
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; mark(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; mark(); } }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); if (items[sel]) choose(items[sel]); else run(); }
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.showModal();
  input.focus();
  run();
}
