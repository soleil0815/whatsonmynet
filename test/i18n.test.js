import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', 'public', 'js');
const { KEYS_DE, KEYS_EN } = await import('../public/js/i18n.js').catch(() => ({}));

function files(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
}

test('every text used in the interface exists in German and English', () => {
  const de = new Set(KEYS_DE); const en = new Set(KEYS_EN);
  const missing = [];
  for (const f of files(dir)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/g)) {
      if (!de.has(m[1])) missing.push(`de:${m[1]}`);
      if (!en.has(m[1]) && m[1] !== 'app.name') missing.push(`en:${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
  // English has no key German lacks
  assert.deepEqual(KEYS_EN.filter((k) => !de.has(k)), []);
});

test('every device type and role has a label', () => {
  const de = new Set(KEYS_DE); const en = new Set(KEYS_EN);
  const types = ['router', 'firewall', 'switch', 'accesspoint', 'hypervisor', 'server', 'nas', 'printer', 'computer', 'vm', 'mobile', 'phone', 'camera', 'ups', 'iot', 'media', 'ti_connector', 'ti_terminal', 'unknown'];
  for (const k of [...types.map((x) => `type.${x}`), 'role.admin', 'role.editor', 'role.viewer', 'scan.phase.done', 'scan.phase.failed', 'scan.phase.cancelled', 'scan.phase.discover', 'scan.phase.probe', 'scan.phase.start',
    'scan.statusNew', 'scan.statusChanged', 'scan.statusKnown', 'scan.statusIgnored', 'presence.online', 'presence.missing', 'presence.unknown', 'tls.source.custom', 'tls.source.self-signed']) {
    assert.ok(de.has(k) && en.has(k), k);
  }
});

test('server error codes exist in both languages', async () => {
  const { t } = await import('../src/i18n.js');
  const src = fs.readdirSync(path.join(import.meta.dirname, '..', 'src'), { recursive: true }).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', f), 'utf8')).join('\n');
  const codes = new Set([...src.matchAll(/'(err\.[a-zA-Z]+)'/g)].map((m) => m[1]));
  for (const c of codes) {
    assert.notEqual(t('de', c), c, `de ${c}`);
    assert.notEqual(t('en', c), c, `en ${c}`);
  }
});
