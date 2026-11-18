// A text key given twice in one language: the later one silently wins and the first place shows the wrong text
// (it happened: "hs.forget" was "Hide" for unknown machines and "Remove script data" on the device page).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const lines = fs.readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8').split('\n');

for (const lang of ['de', 'en']) {
  test(`no text key twice (${lang})`, () => {
    const start = lines.indexOf(`const ${lang} = {`);
    assert.ok(start >= 0);
    const end = lines.indexOf('};', start);
    const seen = new Map(); const twice = [];
    for (let i = start + 1; i < end; i++) {
      for (const m of lines[i].matchAll(/(?:^\s*|[{,]\s*)'([A-Za-z0-9_.-]+)':/g)) {
        if (seen.has(m[1])) twice.push(`${m[1]} (lines ${seen.get(m[1])} and ${i + 1})`); else seen.set(m[1], i + 1);
      }
    }
    assert.ok(seen.size > 500);
    assert.deepEqual(twice, []);
  });
}
