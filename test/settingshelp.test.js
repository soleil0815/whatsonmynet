// Every settings section has a short "what is this for?" in both languages, and its link goes to a heading that
// exists in the manual (a renamed heading would leave a dead link).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { slug, toc } from '../public/js/md.js';

const src = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const sections = [...src('js/views/settingsnav.js').matchAll(/\['([a-z]+)', '[a-z]+'\]/g)].map((m) => m[1]);
const helpSrc = src('js/views/settingshelp.js');
const i18n = src('js/i18n.js');

test('every section of the settings has its text in German and English', () => {
  assert.ok(sections.length > 15);
  for (const s of sections) {
    assert.match(helpSrc, new RegExp(`\\n  ${s}: `), `HELP_HEADINGS.${s}`);
    assert.equal(i18n.split(`'set.help.${s}':`).length - 1, 2, `set.help.${s} in de and en`);
  }
});

test('the links go to headings of the manual that exist', async () => {
  const { HELP_HEADINGS } = await import('../public/js/views/settingshelp.js').catch(() => ({ HELP_HEADINGS: null })) || {};
  const map = HELP_HEADINGS || Object.fromEntries([...helpSrc.matchAll(/\n {2}([a-z]+): \['([^']+)', '([^']+)'\]/g)].map((m) => [m[1], [m[2], m[3]]]));
  // chapters (##) and their sections (###) - every heading has an anchor
  const heads = (md) => new Set([...toc(md).map((x) => x.id), ...md.split('\n').map((l) => /^###\s+(.*)$/.exec(l)).filter(Boolean).map((m) => slug(m[1]))]);
  const ids = { de: heads(src('help/manual.de.md')), en: heads(src('help/manual.en.md')) };
  let n = 0;
  for (const [s, head] of Object.entries(map)) {
    if (!head) continue;
    assert.ok(ids.de.has(slug(head[0])), `${s}: "${head[0]}" in the German manual`);
    assert.ok(ids.en.has(slug(head[1])), `${s}: "${head[1]}" in the English manual`);
    n++;
  }
  assert.ok(n > 10);
});
