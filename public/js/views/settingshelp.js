// A short "what is this for?" at the top of every settings section, in plain words, with a link to the part of the
// manual that explains it in full. Easy to start with - the details are there when wanted.
import { h } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { slug } from '../md.js';

// The headings of the manual each section points to (checked by a test: they must exist in both manuals)
export const HELP_HEADINGS = {
  general: ['Erste Schritte', 'First steps'],
  users: ['Benutzer und Rechte', 'Users and rights'],
  ad: ['Anmeldung mit Active Directory', 'Sign-in with Active Directory'],
  scan: ['Erste Schritte', 'First steps'],
  printers: ['Drucker, Switches und NAS', 'Printers, switches and NAS'],
  snmpdev: ['Drucker, Switches und NAS', 'Printers, switches and NAS'],
  agents: ['Scan-Agent für Außenstellen', 'Scan agent for branch offices'],
  ignored: ['Erste Schritte', 'First steps'],
  docker: ['Monitoring', 'Monitoring'],
  hostscripts: ['Windows- und Linux-Rechner per Skript (ohne Agent)', 'Windows and Linux machines by script (without agent)'],
  plugins: ['Plugins für das Rechner-Skript', 'Plugins for the host script'],
  notify: ['Monitoring', 'Monitoring'],
  smtp: ['Monitoring', 'Monitoring'],
  api: ['Prometheus und Grafana', 'Prometheus and Grafana'],
  https: ['Installation', 'Installation'],
  backup: ['Sicherung und Updates', 'Backup and updates'],
  failover: ['Ausfallsicherung: Master und Standby', 'Failover: master and standby'],
  diag: ['Fehlerbehebung', 'Troubleshooting'],
  audit: null,
  about: ['Sicherung und Updates', 'Backup and updates'],
};

/** The box for a section: what it is for, and where to read more (opens the help beside, so the settings stay open) */
export function sectionHelp(section) {
  if (!(section in HELP_HEADINGS)) return null;
  const head = HELP_HEADINGS[section];
  const en = getLang() === 'en';
  return h('div', { class: 'set-help', role: 'note' },
    h('span', { class: 'set-help-ico', 'aria-hidden': 'true', html: icon('help') }),
    h('div', {},
      h('p', {}, t(`set.help.${section}`)),
      head ? h('a', { href: `/help#${slug(head[en ? 1 : 0])}`, target: '_blank', rel: 'noopener', class: 'small' }, t('set.help.more')) : null));
}
