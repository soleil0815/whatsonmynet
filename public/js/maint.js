// "In maintenance until 10:00": a calm mark for monitors and devices in a maintenance window - so a backup system
// that is switched off at night by plan does not look like an outage.
import { h } from './dom.js';
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';

/** 10:00 today, "Fri 10:00" within a week, else the date */
export function untilText(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const lang = getLang() === 'en' ? 'en-GB' : 'de-DE';
  const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86400000);
  if (days === 0) return time;
  if (days === 1) return `${t('maint.tomorrow')} ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(lang, { weekday: 'short' })} ${time}`;
  return d.toLocaleString(lang, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** The mark: wrench, "Maintenance until 10:00", the window's name as title */
export function maintBadge(m, { long = false } = {}) {
  if (!m) return null;
  const until = m.until ? untilText(m.until) : '';
  const text = until ? t('maint.until', { time: until }) : t('mon.status.maintenance');
  return h('span', { class: 'badge-maint', title: m.name ? t('maint.window', { name: m.name }) : null },
    h('span', { class: 'ico', 'aria-hidden': 'true', html: icon('wrench') }), long && m.name ? `${text} · ${m.name}` : text);
}
