// Navigation of the settings: the groups and their sections, as a list of links (desktop) and as a <select> (phones).
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';

// Grouped so that related settings stand together; Proxmox and reports have their own pages under "Monitoring"
export const GROUPS = [
  ['access', [['general', 'settings'], ['users', 'users'], ['ad', 'user']]],
  ['scan', [['scan', 'radar'], ['printers', 'printer'], ['snmpdev', 'switch'], ['agents', 'location'], ['ignored', 'eyeoff']]],
  ['connect', [['docker', 'server'], ['hostscripts', 'computer'], ['notify', 'bell'], ['smtp', 'mail']]],
  ['system', [['https', 'lock'], ['backup', 'download'], ['failover', 'shield'], ['audit', 'history'], ['about', 'shield']]],
];
export const SECTIONS = GROUPS.flatMap(([, list]) => list);

/** Phones: one <select> instead of a long strip of links, grouped like the desktop navigation; choosing opens the section */
export function settingsSelect(section, onPick = () => {}) {
  const sel = h('select', { class: 'subnav-select', 'aria-label': t('set.navSelect'), onchange: (e) => onPick(e.target.value) },
    GROUPS.map(([g, list]) => h('optgroup', { label: t(`set.group.${g}`) },
      list.map(([s]) => h('option', { value: s, selected: s === section }, t(`set.${s}`))))));
  sel.value = section;
  return sel;
}

/** The whole sub navigation: links for wide screens and the <select> for phones (CSS shows one of them) */
export function settingsNav(section, onPick) {
  return h('nav', { class: 'subnav', 'aria-label': t('set.title') },
    settingsSelect(section, onPick),
    GROUPS.map(([g, list]) => [h('div', { class: 'subnav-group' }, t(`set.group.${g}`)),
      list.map(([s, ico]) => h('a', { href: `/settings/${s}`, 'data-link': true,
        class: s === section ? 'active' : '', 'aria-current': s === section ? 'page' : null }, h('span', { html: icon(ico) }), t(`set.${s}`)))]));
}
