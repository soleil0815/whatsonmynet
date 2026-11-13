// "About WhatsOnMyNet": version, licence, source code (the AGPL wants it reachable for every user, not only admins),
// website, a way to say thanks, and what changed. Shown under Settings → About and, for everyone, behind the version
// number at the bottom of the menu.
import { h, modal, fmtDate } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state } from '../app.js';
import { CHANGELOG } from '../changelog.js';

export const WEBSITE = 'https://helfi.space';
export const COFFEE = 'https://buymeacoffee.com/soleil0815';

const ext = (href, text, cls = '') => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
const parts = (v) => String(v || '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
const newer = (a, b) => { const x = parts(a); const y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** The versions to show: 'next' under the running version when that is newer than the last listed one */
export function versions(running = state.boot?.version) {
  const listed = CHANGELOG.filter((c) => c.version !== 'next');
  const next = CHANGELOG.find((c) => c.version === 'next');
  const out = [];
  if (next?.de?.length) out.push({ ...next, version: listed[0] && newer(running, listed[0].version) ? String(running).replace(/-.*$/, '') : null });
  return [...out, ...listed];
}

function whatsNew() {
  const lang = getLang() === 'en' ? 'en' : 'de';
  const entry = (c) => [
    h('h3', { class: 'sub-title', style: { marginTop: 0 } }, c.version ? `${t('about.versionN', { v: c.version })}` : t('about.upcoming'),
      c.date ? h('span', { class: 'muted small', style: { fontWeight: 400, marginLeft: '8px' } }, fmtDate(c.date, getLang(), false)) : null),
    h('ul', { class: 'changes' }, (c[lang] || c.de).map((x) => h('li', {}, x)))];
  const list = versions();
  return h('div', { class: 'whats-new' },
    list.slice(0, 2).map(entry),
    list.length > 2 ? h('details', { class: 'inline-more' }, h('summary', {}, t('about.older')), list.slice(2).map(entry)) : null);
}

/** The content, for the settings page and the dialog */
export function aboutContent() {
  return h('div', { class: 'about' },
    h('img', { src: document.documentElement.dataset.theme === 'dark' ? '/logo-dark.svg' : '/logo.svg', alt: 'WhatsOnMyNet', style: { height: '48px', marginBottom: '14px' } }),
    h('p', {}, t('about.text')),
    h('dl', { class: 'kv' },
      h('dt', {}, t('about.version')), h('dd', {}, state.boot.version),
      h('dt', {}, t('about.license')), h('dd', {}, 'AGPL-3.0-or-later'),
      h('dt', {}, t('about.source')), h('dd', {}, ext(state.boot.sourceUrl, state.boot.sourceUrl)),
      h('dt', {}, t('about.website')), h('dd', {}, ext(WEBSITE, 'helfi.space'))),
    h('div', { class: 'coffee' },
      h('p', { style: { margin: 0 } }, t('about.thanks')),
      ext(COFFEE, [h('span', { html: icon('coffee') }), t('about.coffee')], 'btn btn-coffee')),
    h('h2', { class: 'section-title', style: { marginTop: '22px' } }, t('about.whatsNew')),
    whatsNew());
}

/** For everyone: behind the version number in the menu */
export function openAbout() {
  const dlg = modal(t('about.title'), aboutContent(), { wide: true, actions: [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('close'))] });
}
