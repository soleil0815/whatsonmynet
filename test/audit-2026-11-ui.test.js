// Audit 2026-11: checks for the web interface, port names and the CI workflows that work without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { KEYS_DE, KEYS_EN } = await import('../public/js/i18n.js');

test('AD test: every step error code of the server is either handled by name or has an adt.err.* text', () => {
  const dir = read('src/auth/directory.js');
  // codes from adErrorKey() and literal error codes of the test steps
  const fn = dir.slice(dir.indexOf('export function adErrorKey'), dir.indexOf('\n}\n', dir.indexOf('export function adErrorKey')));
  const codes = new Set([...fn.matchAll(/return '([a-zA-Z]+)'/g)].map((m) => m[1]));
  for (const m of dir.matchAll(/error: (?:[^,}'?]*\? )?'([a-zA-Z]+)'(?: : '([a-zA-Z]+)')?/g)) { codes.add(m[1]); if (m[2]) codes.add(m[2]); }
  assert.ok(codes.has('disabled') && codes.has('cert'), `codes found: ${[...codes]}`);
  const ui = read('public/js/views/settings.js');
  const list = ui.match(/!\[([^\]]*)\]\.includes\(st\.error\)/);
  assert.ok(list, 'exclusion list in settings.js');
  const handled = new Set([...list[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]));
  const de = new Set(KEYS_DE); const en = new Set(KEYS_EN);
  const raw = [...codes].filter((c) => !handled.has(c) && !(de.has(`adt.err.${c}`) && en.has(`adt.err.${c}`)));
  assert.deepEqual(raw, [], 'these codes would show the raw key adt.err.<code>');
});

test('port names shown in the interface are language-neutral (no English words)', async () => {
  const { SERVICE_NAMES } = await import('../src/scan/ports.js');
  const english = /\b(alt|agent|Raw|printing|card|terminal|data)\b/; // lower case: "FTP-Data" is the protocol name
  const bad = Object.entries(SERVICE_NAMES).filter(([, n]) => english.test(n));
  assert.deepEqual(bad, []);
  assert.equal(SERVICE_NAMES[4742], 'SICCT');
  assert.equal(SERVICE_NAMES[9100], 'JetDirect');
  assert.equal(SERVICE_NAMES[8080], 'HTTP');
  assert.equal(SERVICE_NAMES[8443], 'HTTPS');
  assert.equal(SERVICE_NAMES[20], 'FTP-Data');
  assert.equal(SERVICE_NAMES[10050], 'Zabbix');
});

test('no German example texts as fixed placeholders in the interface', () => {
  const ui = read('public/js/views/settings.js');
  for (const s of ['Außenstelle Nord', 'buero@firma.de', 'mail.firma.de']) assert.ok(!ui.includes(`'${s}`), s);
});

/** run: blocks of a workflow file (block scalars and one-liners) */
function runBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    if (!/^[|>]/.test(m[2])) { out.push(m[2]); continue; }
    const indent = m[1].length;
    const body = [];
    const deeper = (l) => l.trim() === '' || l.match(/^\s*/)[0].length > indent;
    while (i + 1 < lines.length && deeper(lines[i + 1])) body.push(lines[++i]);
    out.push(body.join('\n'));
  }
  return out;
}

test('workflows: run: blocks never interpolate job outputs, step outputs or matrix values directly', () => {
  const dir = path.join(root, '.github', 'workflows');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    for (const r of runBlocks(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      for (const m of r.matchAll(/\$\{\{\s*(needs\.[^}]*|matrix\.[^}]*|steps\.[^}]*|inputs\.[^}]*)\}\}/g)) bad.push(`${f}: ${m[1].trim()}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('ci.yml: all shell scripts (also .github/scripts) are syntax-checked with dash', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /for f in [^\n]*\.github\/scripts\/\*\.sh[^\n]*;\s*do\s+dash -n/);
});

test('ci.yml: only real releases join the "release" concurrency group of the security update', () => {
  const ci = read('.github/workflows/ci.yml');
  const group = ci.match(/concurrency:\n\s+group: (.*)/)[1];
  assert.match(group, /inputs\.release != 'nein'/);
  assert.match(read('.github/workflows/security-update.yml'), /concurrency:[\s\S]*?group: release\n/);
});

test('busy(): a second click while the request runs sends nothing, the button is usable again afterwards (also after an error)', async () => {
  const { busy } = await import('../public/js/dom.js');
  assert.equal(typeof busy, 'function');
  const b = { disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  let calls = 0; let release;
  const first = busy(b, () => { calls++; return new Promise((r) => { release = r; }); });
  assert.equal(b.disabled, true);
  await busy(b, () => { calls++; });
  await busy(b, () => { calls++; });
  release('done');
  assert.equal(await first, 'done');
  assert.equal(calls, 1);
  assert.equal(b.disabled, false);
  await assert.rejects(busy(b, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(b.disabled, false);
});
