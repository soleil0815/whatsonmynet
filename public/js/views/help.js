// Help: the manual in the language of the interface, with contents and the PDF to download.
import { h, mount } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { mdToHtml, toc } from '../md.js';

export async function renderHelp(main) {
  const lang = getLang() === 'en' ? 'en' : 'de';
  const text = await (await fetch(`/help/manual.${lang}.md`, { cache: 'no-cache' })).text();
  const body = h('article', { class: 'manual' });
  // Our own static manual, rendered by md.js (all text escaped)
  body.innerHTML = mdToHtml(text.replace(/^# .*\n/, ''), { imgBase: '/help/' });
  const pdf = lang === 'en' ? 'WhatsOnMyNet-Manual.pdf' : 'WhatsOnMyNet-Handbuch.pdf';
  mount(main, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, t('help.title')), h('p', {}, t('help.lead'))),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: `/help/${pdf}`, download: '' }, h('span', { html: icon('download') }), t('help.pdf')))),
    h('div', { class: 'help-layout' },
      h('nav', { class: 'help-toc', 'aria-label': t('help.contents') }, h('strong', {}, t('help.contents')),
        h('ol', {}, toc(text).map((x) => h('li', {}, h('a', { href: `#${x.id}`, onclick: (e) => { e.preventDefault(); document.getElementById(x.id)?.scrollIntoView({ behavior: 'smooth' }); } }, x.text))))),
      body)));
  // Opened at a section (/help#…, e.g. "What does the script bring?" in a dialog): go there
  const id = decodeURIComponent(location.hash.slice(1));
  if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
}
