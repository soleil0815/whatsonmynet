// Audit 2026-11 (second round, UI group): help rendering, usability and documentation, checked without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const md = await import('../public/js/md.js');
const { TEXTS } = await import('../public/js/i18n.js');
const server = await import('../src/i18n.js');
const { HELP_HEADINGS } = await import('../public/js/views/settingshelp.js');

// the source of one function or arrow body (from a marker to the next marker)
const between = (src, from, to) => { const a = src.indexOf(from); assert.ok(a >= 0, `marker ${from}`); const b = src.indexOf(to, a + from.length); return src.slice(a, b < 0 ? undefined : b); };

// ------------------------------------------------------------------------------------------------ 1, 2: manual
for (const lang of ['de', 'en']) {
  const text = read(`public/help/manual.${lang}.md`);
  const html = md.mdToHtml(text.replace(/^# .*\n/, ''), { imgBase: '/help/' });
  const ids = [...html.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);

  test(`manual ${lang}: every anchor id of the rendered help is unique`, () => {
    const seen = new Set(); const twice = new Set();
    for (const id of ids) (seen.has(id) ? twice : seen).add(id);
    assert.deepEqual([...twice], []);
  });

  test(`manual ${lang}: search, contents and settings links use the very ids of the rendered page`, () => {
    assert.equal(typeof md.anchors, 'function', 'md.js exports anchors()');
    const have = new Set(ids);
    const list = md.anchors(text);
    assert.ok(list.length > 50);
    for (const a of list) assert.ok(have.has(a.id), `search hit ${a.text} → #${a.id} exists`);
    assert.equal(new Set(list.map((a) => a.id)).size, list.length, 'search hits link to different places');
    for (const x of md.toc(text)) assert.ok(new RegExp(`<h2 id="${x.id}">`).test(html), `contents → #${x.id} is a chapter`);
    for (const head of Object.values(HELP_HEADINGS).filter(Boolean)) {
      const id = md.slug(head[lang === 'en' ? 1 : 0]);
      assert.ok(new RegExp(`<h[23] id="${id}">`).test(html), `settings help → #${id} is a heading`);
    }
    // the search builds its hits from the same function (no slugs of its own)
    assert.match(read('public/js/search.js'), /anchors\(/);
  });

  test(`manual ${lang}: several paragraphs with the same lead each get their own search hit`, () => {
    const word = lang === 'de' ? 'Sicherheit' : 'Security';
    const hits = md.anchors(text).filter((a) => a.text === word);
    assert.ok(hits.length >= 2);
    assert.equal(new Set(hits.map((a) => a.id)).size, hits.length);
  });

  test(`manual ${lang}: no raw Markdown link syntax in the rendered help page`, () => {
    assert.ok(!/\]\(https?:/.test(html));
  });
}

// ------------------------------------------------------------------------------------------------ 3: failover lead
test('failover page lead says the measurements are handed back, settings go only master → standby', () => {
  assert.doesNotMatch(TEXTS.de['fo.lead'], /zurück zum Master geht nichts/);
  assert.doesNotMatch(TEXTS.en['fo.lead'], /nothing goes back to the master/);
  assert.match(TEXTS.de['fo.lead'], /Messwerte/);
  assert.match(TEXTS.en['fo.lead'], /measured/);
});

// ------------------------------------------------------------------------------------------------ 4, 5: narrow screens
test('dialog footers wrap their buttons on a phone', () => {
  assert.match(read('public/css/app.css'), /dialog\.modal footer \{[^}]*flex-wrap: wrap/);
});

test('key/value lists let long badges wrap instead of overflowing', () => {
  const css = read('public/css/app.css');
  assert.match(css, /dl\.kv \{[^}]*grid-template-columns: max-content minmax\(0, 1fr\)/);
  assert.match(css, /dl\.kv dd \.badge \{[^}]*white-space: normal/);
});

// ------------------------------------------------------------------------------------------------ 6, 7: dashboard
test('dashboard: monitors not checked yet are not counted as fine', () => {
  const src = read('public/js/views/dashboard.js');
  assert.match(src, /mon\.pending/);
  assert.match(src, /dash\.pendingN/);
  assert.match(src, /dash\.leadPending/);
  for (const l of ['de', 'en']) { assert.ok(TEXTS[l]['dash.pendingN']?.includes('{n}')); assert.ok(TEXTS[l]['dash.leadPending']); }
});

test('dashboard: hiding the first steps can be undone and a failed save is shown', () => {
  const src = read('public/js/views/dashboard.js');
  const hide = between(src, "put('/settings/start', { hidden: true })", 'const attention');
  assert.doesNotMatch(hide, /catch \{[^}]*\}/, 'no swallowed error');
  assert.match(hide, /fail\(/);
  assert.match(hide, /start\.undo/);
  assert.match(hide, /hidden: false/);
  for (const l of ['de', 'en']) { assert.ok(TEXTS[l]['start.hidden']); assert.ok(TEXTS[l]['start.undo']); }
});

// ------------------------------------------------------------------------------------------------ 8: confirmations
test('deleting asks first and says when it is done', () => {
  const ev = read('public/js/views/events.js');
  const saved = between(ev, "del(`/events/searches/${x.id}`)", '\n');
  assert.ok(ev.slice(ev.indexOf('ev.savedDelete'), ev.indexOf("del(`/events/searches/")).includes('confirmDialog('), 'saved search: confirmDialog before deleting');
  assert.match(saved, /toast\(/);
  assert.doesNotMatch(ev, /[^\w.]confirm\(/, 'no browser confirm()');
  const hs = read('public/js/views/hostscripts.js');
  const forget = between(hs, "btn(t('hs.forget')", 'catch (ex)');
  assert.match(forget, /confirmDialog\(/);
  assert.match(forget, /toast\(/);
  assert.match(between(read('public/js/views/statuspages.js'), 'del(`/status-pages/${p.id}`)', '\n'), /toast\(/);
  assert.match(between(read('public/js/views/monitoring.js'), 'del(`/maintenance/${w.id}`)', '\n'), /toast\(/);
});

// ------------------------------------------------------------------------------------------------ 9, 10: wording
test('ping error points to the manual, not the README', () => {
  for (const l of ['de', 'en']) assert.doesNotMatch(server.t(l, 'err.pingUnavailable'), /README/);
});

test('severity names are capitalised alike in German, sender hint names the real settings section', () => {
  const sev = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'].map((s) => TEXTS.de[`ev.sev.${s}`]);
  assert.deepEqual(sev.filter((s) => s[0] !== s[0].toUpperCase()), []);
  for (const l of ['de', 'en']) assert.ok(TEXTS[l]['rep.fromNameHint'].includes(TEXTS[l]['set.smtp']), l);
});

// ------------------------------------------------------------------------------------------------ 11, 12: views
test('device and monitor pages say "not found or not in your locations" with a way back', () => {
  const common = read('public/js/views/common.js');
  assert.match(common, /export function notFoundPage/);
  assert.match(read('public/js/views/device.js'), /notFoundPage\(/);
  assert.match(read('public/js/views/monitoring.js'), /notFoundPage\(/);
  for (const l of ['de', 'en']) assert.ok(TEXTS[l]['err.notVisible'] && TEXTS[l]['err.backToList'], l);
});

test('status page form: the monitor picker is a labelled group', () => {
  const src = read('public/js/views/statuspages.js');
  assert.match(src, /role: 'group', 'aria-labelledby': 'sp-items-label'/);
  assert.match(src, /id: 'sp-items-label'/);
});

// ------------------------------------------------------------------------------------------------ 13: docs
test('README: fonts, SNMPv3, HSTS behind the proxy and the host script are described as they are', () => {
  const fonts = fs.readdirSync(path.join(root, 'public/fonts'));
  assert.ok(fonts.some((f) => f.startsWith('inter')) && fonts.some((f) => f.startsWith('ibm-plex-mono')));
  for (const [f, v3] of [['README.md', 'SNMPv3-Zugänge'], ['README.en.md', 'SNMPv3 accesses']]) {
    const r = read(f);
    assert.match(r, /Inter (und|and) IBM Plex Mono/, f);
    assert.doesNotMatch(r, /Barlow/, f);
    assert.doesNotMatch(r, /SNMP \(v1 (oder|or) v2c\)|SNMP v1\/v2c (lesend|has to)/, f);
    assert.ok(r.includes(v3), `${f}: SNMPv3 users`);
    assert.match(r, /WOMN_HSTS/, f);
    assert.doesNotMatch(r, /kein Konto, nichts installiert|no account, nothing installed/, f);
  }
  assert.doesNotMatch(read('public/help/manual.de.md'), /Skript installiert nichts/);
  assert.doesNotMatch(read('public/help/manual.en.md'), /script installs nothing/);
});

test('receiving settings name the configured TLS port instead of a fixed 6514', () => {
  for (const l of ['de', 'en']) { assert.doesNotMatch(TEXTS[l]['ev.s.ports'], /6514/); assert.match(TEXTS[l]['ev.s.ports'], /\{tls\}/); }
  assert.match(read('public/js/views/events.js'), /t\('ev\.s\.ports', \{[^}]*tls: cfg\.syslogTlsPort/);
});
