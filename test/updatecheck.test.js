// Update check: off by default, asks only GitHub's releases/latest of the own project (nothing sent along), shows a
// newer version to administrators, reports it once to the channels, keeps the last known version when offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { parseVersion, isNewer, releaseApi, releaseNotes, setUpdateTransport, createUpdateCheck } from '../src/updatecheck.js';
import { eventText } from '../src/monitor/notify.js';
import { config } from '../src/config.js';

const app = await startApp();
const { call, ctx } = app;
test.after(() => { setUpdateTransport(null); app.close(); });

const asked = [];
let answer = null;
setUpdateTransport(async (url) => { asked.push(url); if (answer instanceof Error) throw answer; return answer; });
const release = (tag, body = '') => ({ status: 200, text: JSON.stringify({ tag_name: tag, html_url: 'https://evil.example/x', published_at: '2026-11-25T10:00:00Z', body }) });
const bump = (v, i) => { const p = parseVersion(v); p[i] += 1; for (let j = i + 1; j < 3; j++) p[j] = 0; return p.join('.'); };

test('versions: parsed and compared; a security update -sN is not a newer program', () => {
  assert.deepEqual(parseVersion('v0.52.1'), [0, 52, 1]);
  assert.deepEqual(parseVersion('1.2.3-s2'), [1, 2, 3]);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('0.52'), null);
  assert.equal(isNewer('0.52.0', '0.51.9'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.51.0-s1', '0.51.0'), false);
  assert.equal(isNewer('0.51.0', '0.51.0'), false);
  assert.equal(isNewer('0.50.9', '0.51.0'), false);
  assert.equal(isNewer('kaputt', '0.51.0'), false);
});

test('only a project on github.com is asked, and only at api.github.com', () => {
  assert.equal(releaseApi('https://github.com/soleil0815/whatsonmynet'), 'https://api.github.com/repos/soleil0815/whatsonmynet/releases/latest');
  assert.equal(releaseApi('https://github.com/firma/womn.git/'), 'https://api.github.com/repos/firma/womn/releases/latest');
  assert.equal(releaseApi('https://git.firma.local/firma/womn'), null);
  assert.equal(releaseApi('http://github.com/a/b'), null);
  assert.equal(releaseApi('https://github.com/a'), null);
  assert.equal(releaseApi('https://github.com/../b'), null);
  assert.equal(releaseApi('kein link'), null);
});

test('release notes: the own lists per language as plain text - not the list of pull requests GitHub adds; no links, tags or images', () => {
  const body = '### Neu in dieser Version\n\n- **Fett** und [Link](https://x.example) <img src=x onerror=alert(1)>\n- `code`\nText\n* ![bild](a.png)Rest\n\n'
    + '### New in this version\n\n- Bold\n\n## What\'s Changed\n* PR by @x in https://github.com/a/b/pull/1\n\n**Full Changelog**: x';
  assert.deepEqual(releaseNotes(body), { de: ['Fett und Link', 'code', 'Rest'], en: ['Bold'] });
  assert.deepEqual(releaseNotes('- a\n- b\n## Other\n- c'), { de: ['a', 'b'], en: ['a', 'b'] }, 'another project: the first list');
  assert.deepEqual(releaseNotes('### Neu in dieser Version\n- nur deutsch'), { de: ['nur deutsch'], en: ['nur deutsch'] });
  assert.equal(releaseNotes(Array.from({ length: 30 }, (_, i) => `- Punkt ${i}`).join('\n')).de.length, 15);
  assert.ok(releaseNotes(`- ${'x'.repeat(500)}`).de[0].length <= 300);
  assert.deepEqual(releaseNotes(null), { de: [], en: [] });
});

test('off by default: nothing asked, no hint; only administrators may look', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'testadmin', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);
  const s = (await call('GET', '/api/update')).data;
  assert.equal(s.auto, false);
  assert.equal(s.notify, false);
  assert.equal(s.supported, true);
  assert.equal(s.checkedAt, null);
  ctx.updateCheck.tick();
  assert.equal(asked.length, 0, 'the daily check is off');
  assert.equal((await call('GET', '/api/bootstrap')).data.update, null);
  assert.equal((await call('POST', '/api/users', { username: 'max', password: 'Sicher-Passwort-2', role: 'editor' })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'max', password: 'Sicher-Passwort-2' }, { who: 'editor' })).status, 200);
  assert.equal((await call('GET', '/api/update', undefined, { who: 'editor' })).status, 403);
  assert.equal((await call('POST', '/api/update/check', {}, { who: 'editor' })).status, 403);
  assert.equal((await call('PUT', '/api/settings/update', { auto: true }, { who: 'editor' })).status, 403);
});

test('the button: a newer version with its notes; the link only to the own release page; hint for administrators only', async () => {
  const next = bump(config.version, 1);
  answer = release(`v${next}`, '### Neu in dieser Version\n\n- Updates: WhatsOnMyNet sagt, wenn es eine neue Version gibt\n\n### New in this version\n\n- Updates: WhatsOnMyNet tells you about a new version\n');
  const s = (await call('POST', '/api/update/check', {})).data;
  assert.deepEqual(asked, ['https://api.github.com/repos/soleil0815/whatsonmynet/releases/latest']);
  assert.equal(s.available, true);
  assert.equal(s.latest, next);
  assert.equal(s.url, `https://github.com/soleil0815/whatsonmynet/releases/tag/v${next}`);
  assert.deepEqual(s.notes, { de: ['Updates: WhatsOnMyNet sagt, wenn es eine neue Version gibt'], en: ['Updates: WhatsOnMyNet tells you about a new version'] });
  assert.equal(s.error, null);
  assert.deepEqual((await call('GET', '/api/bootstrap')).data.update, { version: next, url: s.url });
  assert.equal((await call('GET', '/api/bootstrap', undefined, { who: 'editor' })).data.update, null);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='update.check'").get().n, 1);
});

test('the same version or an older one: up to date, no hint', async () => {
  answer = release(`v${config.version}-s1`);
  const s = (await call('POST', '/api/update/check', {})).data;
  assert.equal(s.available, false);
  assert.equal((await call('GET', '/api/bootstrap')).data.update, null);
});

test('offline, refused, unexpected answer: a reason, and the last known version stays', async () => {
  answer = release(`v${bump(config.version, 0)}`);
  await call('POST', '/api/update/check', {});
  for (const [a, why] of [[Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }), 'noInternet'],
    [Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }), 'certificate'],
    [{ status: 403, headers: { 'x-ratelimit-remaining': '0' }, text: '{"message":"API rate limit exceeded"}' }, 'limit'], [{ status: 403, text: 'Forbidden by proxy' }, 'blocked'], [{ status: 404, text: '{}' }, 'noRelease'],
    [{ status: 200, text: '<html>' }, 'failed'], [{ status: 200, text: '{"tag_name":"nightly"}' }, 'failed']]) {
    answer = a;
    const s = (await call('POST', '/api/update/check', {})).data;
    assert.equal(s.error, why);
    assert.equal(s.available, true, 'the version found before is still shown');
  }
});

test('reported once per new version to the chosen channels; the text names both versions', async () => {
  const sent = [];
  const at = { t: Date.parse('2026-11-25T08:00:00Z') };
  const store = new Map();
  const settings = { get: (k) => store.get(k) ?? ({ 'update.auto': true, 'update.notify': true, 'update.channels': [3] })[k], set: (k, v) => store.set(k, v) };
  const u = createUpdateCheck({ settings, version: '0.51.0', sourceUrl: 'https://github.com/soleil0815/whatsonmynet', now: () => at.t,
    notify: async (ids, ev) => { sent.push([ids, ev]); } });
  answer = release('v0.52.0');
  await u.check();
  await u.check();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][0], [3]);
  assert.equal(sent[0][1].kind, 'update');
  assert.match(eventText(sent[0][1], 'de'), /0\.52\.0 ist erschienen \(hier läuft 0\.51\.0\)/);
  assert.match(eventText(sent[0][1], 'en'), /0\.52\.0 is out \(this is 0\.51\.0\)/);
  answer = release('v0.53.0');
  await u.check();
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1].version, '0.53.0');
});

test('daily: at most once in 24 hours (a failed attempt counts), never without the switch', async () => {
  const at = { t: Date.parse('2026-11-25T08:00:00Z') };
  const store = new Map([['update.auto', true]]);
  const settings = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  const u = createUpdateCheck({ settings, version: '0.51.0', sourceUrl: 'https://github.com/soleil0815/whatsonmynet', now: () => at.t });
  const before = asked.length;
  answer = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  u.tick(); await new Promise((r) => { setTimeout(r, 30); });
  assert.equal(asked.length, before + 1);
  at.t += 23 * 3600 * 1000;
  u.tick();
  assert.equal(asked.length, before + 1, 'not again within the day');
  at.t += 2 * 3600 * 1000;
  store.set('update.auto', false);
  u.tick();
  assert.equal(asked.length, before + 1, 'switched off');
  store.set('update.auto', true);
  u.tick();
  assert.equal(asked.length, before + 2);
});

test('a source code not on GitHub: nothing is asked', async () => {
  const store = new Map([['update.auto', true]]);
  const u = createUpdateCheck({ settings: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }, version: '0.51.0', sourceUrl: 'https://git.firma.local/womn' });
  const before = asked.length;
  u.tick();
  const s = await u.check();
  assert.equal(asked.length, before);
  assert.equal(s.supported, false);
  assert.equal(s.error, 'unsupported');
});

test('settings: switches and channels saved, unknown or invalid channels dropped', async () => {
  const s = (await call('PUT', '/api/settings/update', { auto: true, notify: 1, channels: ['2', 'x', -1] })).data;
  assert.equal(s.auto, true);
  assert.equal(s.notify, true);
  assert.deepEqual(s.channels, [], 'there is no channel 2');
  await call('PUT', '/api/settings/update', { auto: false, notify: false, channels: [] });
});
