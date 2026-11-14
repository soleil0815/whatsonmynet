// CHANGELOG.md / CHANGELOG.en.md and the text of a GitHub release - made from public/js/changelog.js, the same texts
// the program shows under "About WhatsOnMyNet" (one place to write them).
//
//   node tools/changelog.mjs                 writes CHANGELOG.md (German) and CHANGELOG.en.md (English)
//   node tools/changelog.mjs --notes 0.21.0  prints the release text of this version (German and English)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANGELOG } from '../public/js/changelog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = {
  de: { title: '# Neuigkeiten', lead: 'Was sich in WhatsOnMyNet geändert hat - dieselben Texte wie im Programm unter *Über WhatsOnMyNet* (Klick auf die Versionsnummer unten links). English: [CHANGELOG.en.md](CHANGELOG.en.md)', next: 'Nächste Version (noch nicht veröffentlicht)' },
  en: { title: '# Changelog', lead: 'What changed in WhatsOnMyNet - the same texts the program shows under *About WhatsOnMyNet* (click on the version number at the bottom left). Deutsch: [CHANGELOG.md](CHANGELOG.md)', next: 'Next version (not released yet)' },
};
export const FILES = { de: 'CHANGELOG.md', en: 'CHANGELOG.en.md' };
// a line starts with "-": escape what Markdown would take as markup at the start of a list item only
const item = (s) => `- ${String(s).replace(/\s+/g, ' ').trim()}`;

/** The whole changelog in one language */
export function markdown(lang, list = CHANGELOG) {
  const t = T[lang];
  const out = [t.title, '', t.lead, '', '<!-- generated from public/js/changelog.js by tools/changelog.mjs - do not edit here -->', ''];
  for (const c of list) {
    out.push(c.version === 'next' ? `## ${t.next}` : `## ${c.version} - ${c.date}`, '');
    for (const line of c[lang]) out.push(item(line));
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** Text of the GitHub release of `version`: its entry, or the entries of 'next' (they become this version) */
export function releaseNotes(version, list = CHANGELOG) {
  const c = list.find((x) => x.version === version) || list.find((x) => x.version === 'next');
  if (!c) return '';
  return ['### Neu in dieser Version', '', ...c.de.map(item), '', '### New in this version', '', ...c.en.map(item), ''].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--notes');
  if (i > 0) {
    const v = String(process.argv[i + 1] || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(v)) { console.error('usage: node tools/changelog.mjs --notes 1.2.3'); process.exit(2); }
    process.stdout.write(releaseNotes(v));
  } else {
    for (const [lang, f] of Object.entries(FILES)) { fs.writeFileSync(path.join(root, f), markdown(lang)); console.log(`${f} written`); }
  }
}
