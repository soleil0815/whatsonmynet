// Is there a newer version? For installations whose container is not updated by itself (no Dockhand, no Watchtower).
// Off by default - WhatsOnMyNet asks nobody unless an administrator wants it:
//   - the button "Check for updates now" (Settings → About) asks once, also with the daily check off,
//   - "check once a day" asks at most once in 24 hours (only on the installation that is active, never on a standby).
// Asked is only the public address of the newest release of the project the source code comes from (GitHub,
// releases/latest of WOMN_SOURCE_URL) - no id, no version, no statistics are sent; the answer is read for its version
// number, address and change list. Nothing is downloaded or installed: the administrator updates the container.
import https from 'node:https';
import { log } from './lib/log.js';

const DAY_MS = 24 * 3600 * 1000;
const MAX_NOTES = 15;

/** "v0.52.1" / "0.52.1-s2" → [0, 52, 1]; anything else null */
export function parseVersion(v) {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a newer than b (major, minor, patch; a security update "-sN" of the same version is not a newer program) */
export function isNewer(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The API address of the newest release, only for a project on github.com; else null (nothing is asked) */
export function releaseApi(sourceUrl) {
  let u;
  try { u = new URL(String(sourceUrl || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') return null;
  const [owner, repo] = u.pathname.split('/').filter(Boolean);
  const ok = (s) => /^[A-Za-z0-9_.-]{1,100}$/.test(s || '') && s !== '.' && s !== '..';
  if (!ok(owner) || !ok(repo)) return null;
  return `https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, '')}/releases/latest`;
}

const clean = (t) => t
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // links: the text only
  .replace(/[*_`]+/g, '')                          // emphasis, code
  .replace(/<[^>]*>/g, '')                         // any tag
  .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The change list of a release (Markdown) as plain lines, per language: the bullet points under "Neu in dieser Version"
 * and "New in this version" (the release text of WhatsOnMyNet); without these headings the bullet points before the
 * first other heading. Not the list of pull requests GitHub adds ("What's Changed"). At most 15, each 300 characters.
 */
export function releaseNotes(body) {
  const out = { de: [], en: [] };
  let into = 'any'; let seen = false;
  const any = [];
  for (const raw of String(body || '').slice(0, 100000).split(/\r?\n/)) {
    const head = /^\s*#{1,6}\s+(.*)$/.exec(raw);
    if (head) {
      into = /^neu in dieser version/i.test(head[1]) ? 'de' : /^new in this version/i.test(head[1]) ? 'en' : null;
      if (into) seen = true;
      continue;
    }
    const m = /^\s*[-*]\s+(.+)$/.exec(raw);
    if (!m || !into) continue;
    const list = into === 'any' ? any : out[into];
    const text = clean(m[1]);
    if (text && list.length < MAX_NOTES) list.push(text.length > 300 ? `${text.slice(0, 299)}…` : text);
  }
  if (!seen) { out.de = any; out.en = any; }
  if (!out.en.length) out.en = out.de;
  if (!out.de.length) out.de = out.en;
  return out;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      // the normal certificate check against the public CAs; no cookie, no id - only what GitHub needs (a User-Agent)
      req = https.request(url, { method: 'GET', timeout: 15000, agent: false, rejectUnauthorized: true,
        headers: { 'User-Agent': 'WhatsOnMyNet', Accept: 'application/vnd.github+json' } }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (d) => { size += d.length; if (size <= 2 * 1024 * 1024) chunks.push(d); else res.destroy(new Error('answer too large')); });
        res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); });
        res.on('error', (e) => { clearTimeout(deadline); reject(e); });
      });
    } catch (e) { reject(e); return; }
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), 30000);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.end();
  });
}

let current = httpsGet;
/** Tests answer in place of GitHub (null = the real request again) */
export function setUpdateTransport(fn) { current = fn || httpsGet; }

const NET = { ENOTFOUND: 'noInternet', EAI_AGAIN: 'noInternet', ETIMEDOUT: 'noInternet', ECONNREFUSED: 'noInternet', ECONNRESET: 'noInternet', ENETUNREACH: 'noInternet', EHOSTUNREACH: 'noInternet' };

/**
 * @param version   the running version
 * @param notify    (ids, ev) → sends to the channels (empty = default channels)
 */
export function createUpdateCheck({ settings, version, sourceUrl, notify = async () => {}, now = () => Date.now() }) {
  const api = releaseApi(sourceUrl);
  let timer = null;
  let busy = null;

  const last = () => settings.get('update.last') || {};

  /** What the interface shows */
  function status() {
    const l = last();
    return {
      supported: !!api,
      auto: !!settings.get('update.auto'),
      notify: !!settings.get('update.notify'),
      channels: settings.get('update.channels') || [],
      running: version,
      checkedAt: l.checkedAt || null,
      latest: l.latest || null,
      url: l.url || null,
      published: l.published || null,
      notes: l.notes && typeof l.notes === 'object' && !Array.isArray(l.notes) ? { de: l.notes.de || [], en: l.notes.en || [] } : { de: [], en: [] },
      error: l.error || null,
      available: !!l.latest && isNewer(l.latest, version),
    };
  }

  /** For the hint at the version number: only when a newer version is known */
  function hint() {
    const s = status();
    return s.available ? { version: s.latest, url: s.url } : null;
  }

  async function ask() {
    if (!api) return { error: 'unsupported' };
    let res;
    try { res = await current(api); } catch (e) {
      return { error: NET[e.code] || (/certificate|self.signed|CERT_/i.test(`${e.code} ${e.message}`) ? 'certificate' : /timeout/i.test(e.message) ? 'noInternet' : 'failed') };
    }
    if (res.status === 404) return { error: 'noRelease' };
    // GitHub's limit for addresses without an account (60 an hour - one a day is far below it); any other refusal
    // comes from a proxy or firewall on the way
    if (res.status === 429 || (res.status === 403 && (String(res.headers?.['x-ratelimit-remaining']) === '0' || /rate limit/i.test(res.text || '')))) return { error: 'limit' };
    if (res.status === 403 || res.status === 407) return { error: 'blocked' };
    if (res.status !== 200) return { error: 'failed' };
    let j;
    try { j = JSON.parse(res.text); } catch { return { error: 'failed' }; }
    const tag = String(j?.tag_name || '');
    if (!parseVersion(tag)) return { error: 'failed' };
    // the link only to the release page of this very project (never an address the answer brings along)
    const page = api.replace('https://api.github.com/repos/', 'https://github.com/').replace(/\/releases\/latest$/, `/releases/tag/${encodeURIComponent(tag)}`);
    return { latest: tag.replace(/^v/, ''), url: page, published: typeof j.published_at === 'string' ? j.published_at.slice(0, 40) : null, notes: releaseNotes(j.body) };
  }

  /** Asks GitHub (one request at a time); keeps the answer, reports a new version once to the channels */
  function check() {
    if (busy) return busy;
    busy = (async () => {
      const before = last();
      const r = await ask();
      const at = new Date(now()).toISOString();
      // a failed attempt keeps the last known version (the hint does not vanish because the internet was gone)
      const next = r.error ? { ...before, checkedAt: at, error: r.error } : { ...r, checkedAt: at, error: null, notified: before.notified || null };
      if (!r.error && isNewer(r.latest, version) && settings.get('update.notify') && next.notified !== r.latest) {
        next.notified = r.latest;
        notify(settings.get('update.channels') || [], { kind: 'update', version: r.latest, here: version, url: r.url })
          .catch((e) => log.warn(`Update check: message not sent: ${e.message}`));
      }
      settings.set('update.last', next);
      if (r.error) log.info(`Update check: ${r.error}`);
      else if (isNewer(r.latest, version)) log.info(`Update check: version ${r.latest} is available (running ${version})`);
      return status();
    })().finally(() => { busy = null; });
    return busy;
  }

  // once an hour: has the day passed since the last attempt? (a failed one counts too - no retry storm)
  function tick() {
    if (!settings.get('update.auto') || !api) return;
    const at = Date.parse(last().checkedAt || '') || 0;
    if (now() - at < DAY_MS) return;
    check().catch((e) => log.warn(`Update check: ${e.message}`));
  }

  return {
    status, hint, check, tick,
    start() {
      if (timer) return;
      // the first look a few minutes after the start (not during it), then every hour
      const first = setTimeout(() => { tick(); }, 5 * 60 * 1000); first.unref();
      timer = setInterval(tick, 3600 * 1000); timer.unref();
      timer.first = first;
    },
    stop() { if (timer) { clearTimeout(timer.first); clearInterval(timer); } timer = null; },
  };
}
