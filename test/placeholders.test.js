// Example values in input fields are text the user reads: in the English interface they must be English too
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const GERMAN = /[äöüÄÖÜß]|\b(?:Bearbeiter|Lesen|GERAET|Geraet|dateiserver|Benutzer|Drucker|Rechner)\b/;

test('placeholders written into the views are language-neutral (German examples come from i18n)', () => {
  const dir = 'public/js/views';
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/placeholder: '([^']*)'/g)) if (GERMAN.test(m[1])) bad.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('Active Directory group and test-user examples are translated', async () => {
  globalThis.document ??= { documentElement: {} };
  const { TEXTS } = await import('../public/js/i18n.js');
  for (const k of ['ad.groupEditorPh', 'ad.groupViewerPh', 'ad.testUserPh', 'diag.lookupPh', 'plg.tagsPh']) {
    assert.ok(TEXTS.de[k] && TEXTS.en[k], k);
    assert.notEqual(TEXTS.en[k], TEXTS.de[k], k);
    assert.doesNotMatch(TEXTS.en[k], GERMAN, k);
  }
});
