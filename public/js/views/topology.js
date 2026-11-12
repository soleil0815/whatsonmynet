// Network map: switches as a tree (uplinks from LLDP or the MAC tables), the devices at their ports,
// and the devices that could not be placed yet.
import { h, mount, fmtAgo } from '../dom.js';
import { get } from '../api.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { pageHead } from './common.js';

const portLabel = (name) => (/^\d/.test(String(name)) ? `${t('sw.port')} ${name}` : String(name || '?'));

function deviceChip(d) {
  return h('a', { class: 'topo-dev', href: `/devices/${d.id}`, 'data-link': true, title: d.ip || '' },
    h('span', { html: icon(d.type) }), h('span', { class: 'n' }, d.name));
}

function switchNode(n) {
  return h('li', { class: 'topo-node' },
    n.via ? h('div', { class: 'topo-via' }, h('span', { class: 'mono' }, portLabel(n.via.port)), n.via.remote ? h('span', { class: 'mono' }, ` ↔ ${portLabel(n.via.remote)}`) : null,
      h('span', { class: 'badge', title: t(`topo.kind.${n.via.kind}`) }, n.via.kind === 'lldp' ? 'LLDP' : 'MAC')) : null,
    h('div', { class: 'topo-card' },
      h('div', { class: 'topo-head' },
        h('span', { class: 'topo-ico', html: icon('switch') }),
        h('div', {}, h('a', { href: `/devices/${n.id}`, 'data-link': true, class: 'topo-name' }, n.name),
          h('div', { class: 'muted small mono' }, [n.ip, n.snmp ? t('topo.portsUp', { up: n.snmp.portsUp, n: n.snmp.ports }) : t('topo.noSnmp')].filter(Boolean).join(' · '))),
        n.snmp?.at ? h('span', { class: 'muted small', style: { marginLeft: 'auto' } }, fmtAgo(n.snmp.at, t)) : null),
      n.ports.length ? h('ul', { class: 'topo-ports' }, n.ports.map((p) => h('li', {},
        h('span', { class: 'topo-port mono' }, portLabel(p.port)),
        h('span', { class: 'topo-devs' }, p.devices.map(deviceChip))))) : h('p', { class: 'muted small', style: { margin: '8px 0 0' } }, t('topo.noDevices'))),
    n.children.length ? h('ul', { class: 'topo-children' }, n.children.map(switchNode)) : null);
}

export async function renderTopology(main) {
  const d = await get('/topology');
  mount(main, h('div', { class: 'page' },
    pageHead(t('topo.title'), t('topo.lead')),
    !d.stats.switches ? h('div', { class: 'note' }, t('topo.noSwitches'))
      : d.stats.withData === 0 ? h('div', { class: 'note warn' }, t('topo.noData')) : null,
    d.roots.length ? h('section', { class: 'panel panel-pad topo' }, h('ul', { class: 'topo-tree' }, d.roots.map(switchNode))) : null,
    d.unplaced.length ? h('section', { class: 'panel panel-pad' },
      h('h2', { class: 'section-title' }, t('topo.unplaced', { n: d.unplaced.length })),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, t('topo.unplacedHint')),
      h('div', { class: 'topo-devs' }, d.unplaced.map(deviceChip))) : null));
}
