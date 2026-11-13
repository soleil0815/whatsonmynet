// More notification services, each with its own small setup: chat (Discord, Slack, Teams, Google Chat, Mattermost,
// Rocket.Chat, Matrix, Signal, WhatsApp via CallMeBot), push to the phone (ntfy, Gotify, Pushover, Pushbullet,
// Home Assistant) and Apprise (a bridge to more than 100 services).
//
// Every provider names its fields. Secret fields (tokens, keys and webhook addresses that work like a password) are
// stored encrypted with the channel, never sent back to the browser and blanked out of error messages.
import http from 'node:http';
import https from 'node:https';
import { config } from '../config.js';

const HTTP_URL = /^https?:\/\/[^\s"'<>]+$/i;
const HTTPS_ON = (host) => new RegExp(`^https://([a-z0-9-]+\\.)*${host.replace(/\./g, '\\.')}/[^\\s"'<>]+$`, 'i');

/** Fixed addresses of the cloud services; tests point them at a local server */
const API = {
  pushover: 'https://api.pushover.net',
  pushbullet: 'https://api.pushbullet.com',
  callmebot: 'https://api.callmebot.com',
};
export function setProviderApiForTests(name, url) { API[name] = url; }

/** One HTTP request with a small, bounded answer; rejects on a status outside 2xx */
export function request(method, url, { body = null, headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('invalid address')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request(u, { method, timeout: timeoutMs, agent: false,
      headers: { 'User-Agent': `WhatsOnMyNet/${config.version}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (d) => { if (size < 16384) { chunks.push(d); size += d.length; } });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
        else reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { body: text.slice(0, 300) }));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(e));
    req.end(data || undefined);
  });
}

const base = (u) => String(u).replace(/\/+$/, '');
/** The reason a service gives in its answer, if it gives one */
function reason(e) {
  try {
    const j = JSON.parse(e.body || '{}');
    const why = j.error?.message || j.errors?.[0] || j.message || j.error || j.description;
    if (why && typeof why === 'string') return `${e.message} - ${why.slice(0, 160)}`;
  } catch { /* not JSON */ }
  return e.message;
}

/**
 * Field kinds: url (http/https address), secret (stored encrypted, never shown again), text.
 * re = allowed form, def = default value, optional = may stay empty.
 */
export const PROVIDERS = {
  // ---------------------------------------------------------------- chat
  discord: {
    fields: { url: { kind: 'secret', re: HTTPS_ON('discord.com'), alt: HTTPS_ON('discordapp.com') } },
    send: (c, m) => request('POST', c.url, { body: { content: m.full.slice(0, 1990), username: 'WhatsOnMyNet' } }),
  },
  slack: {
    fields: { url: { kind: 'secret', re: HTTPS_ON('hooks.slack.com') } },
    send: (c, m) => request('POST', c.url, { body: { text: m.full } }),
  },
  teams: {
    // Microsoft Teams: "Workflows" webhook (the old Office 365 connectors are switched off by Microsoft)
    fields: { url: { kind: 'secret', re: /^https:\/\/[^\s"'<>]+$/i } },
    send: (c, m) => request('POST', c.url, { body: { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
      content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [{ type: 'TextBlock', text: m.text, weight: 'Bolder', wrap: true }, ...(m.more ? [{ type: 'TextBlock', text: m.more.replace(/\n/g, '\n\n'), wrap: true, isSubtle: true }] : [])] } }] } }),
  },
  googlechat: {
    fields: { url: { kind: 'secret', re: HTTPS_ON('chat.googleapis.com') } },
    send: (c, m) => request('POST', c.url, { body: { text: m.full } }),
  },
  mattermost: {
    fields: { url: { kind: 'secret', re: HTTP_URL } },
    send: (c, m) => request('POST', c.url, { body: { text: m.full, username: 'WhatsOnMyNet' } }),
  },
  rocketchat: {
    fields: { url: { kind: 'secret', re: HTTP_URL } },
    send: (c, m) => request('POST', c.url, { body: { text: m.full } }),
  },
  matrix: {
    fields: {
      server: { kind: 'url', def: 'https://matrix.org' },
      room: { kind: 'text', re: /^![A-Za-z0-9._=+/-]{3,200}:[A-Za-z0-9.-]{1,200}(:\d{1,5})?$/ },
      token: { kind: 'secret', re: /^[A-Za-z0-9._~+/=-]{10,500}$/ },
    },
    send: (c, m) => request('PUT', `${base(c.server)}/_matrix/client/v3/rooms/${encodeURIComponent(c.room)}/send/m.room.message/womn${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      { body: { msgtype: 'm.text', body: m.full }, headers: { Authorization: `Bearer ${c.token}` } }),
  },
  signal: {
    // signal-cli-rest-api (Docker image bbernhard/signal-cli-rest-api) with a registered number
    fields: {
      server: { kind: 'url', def: 'http://signal-api:8080' },
      number: { kind: 'text', re: /^\+\d{6,15}$/ },
      recipients: { kind: 'text', re: /^(\+\d{6,15}|group\.[A-Za-z0-9+/=]{10,200})([\s,;]+(\+\d{6,15}|group\.[A-Za-z0-9+/=]{10,200})){0,19}$/ },
    },
    send: (c, m) => request('POST', `${base(c.server)}/v2/send`, { body: { message: m.full, number: c.number, recipients: c.recipients.split(/[\s,;]+/).filter(Boolean) } }),
  },
  whatsapp: {
    // CallMeBot: free gateway for messages to your own WhatsApp number
    fields: { phone: { kind: 'text', re: /^\+?\d{6,15}$/ }, apikey: { kind: 'secret', re: /^[A-Za-z0-9_-]{3,64}$/ } },
    send: (c, m) => request('GET', `${API.callmebot}/whatsapp.php?${new URLSearchParams({ phone: c.phone, text: m.full.slice(0, 1500), apikey: c.apikey })}`),
  },
  // ---------------------------------------------------------------- push to the phone
  ntfy: {
    fields: {
      server: { kind: 'url', def: 'https://ntfy.sh' },
      topic: { kind: 'text', re: /^[A-Za-z0-9_-]{1,64}$/ },
      token: { kind: 'secret', optional: true, re: /^[A-Za-z0-9_.-]{6,200}$/ },
    },
    send: (c, m) => request('POST', base(c.server), { body: { topic: c.topic, title: m.title, message: m.textPlain + (m.more ? `\n${m.more}` : ''),
      priority: m.urgent ? 4 : 3, tags: [m.urgent ? 'rotating_light' : m.good ? 'white_check_mark' : 'information_source'] },
    headers: c.token ? { Authorization: `Bearer ${c.token}` } : {} }),
  },
  gotify: {
    fields: { server: { kind: 'url' }, token: { kind: 'secret', re: /^[A-Za-z0-9_.-]{6,200}$/ } },
    send: (c, m) => request('POST', `${base(c.server)}/message`, { body: { title: m.title, message: m.textPlain + (m.more ? `\n${m.more}` : ''), priority: m.urgent ? 8 : 5 },
      headers: { 'X-Gotify-Key': c.token } }),
  },
  pushover: {
    fields: { user: { kind: 'text', re: /^[A-Za-z0-9]{20,40}$/ }, token: { kind: 'secret', re: /^[A-Za-z0-9]{20,40}$/ } },
    send: (c, m) => request('POST', `${API.pushover}/1/messages.json`, { body: { token: c.token, user: c.user, title: m.title, message: m.textPlain + (m.more ? `\n${m.more}` : ''), priority: m.urgent ? 1 : 0 } }),
  },
  pushbullet: {
    fields: { token: { kind: 'secret', re: /^[A-Za-z0-9._-]{10,200}$/ } },
    send: (c, m) => request('POST', `${API.pushbullet}/v2/pushes`, { body: { type: 'note', title: m.title, body: m.textPlain + (m.more ? `\n${m.more}` : '') }, headers: { 'Access-Token': c.token } }),
  },
  homeassistant: {
    // Calls notify.<service>, e.g. mobile_app_michaels_iphone (Companion app) or a group
    fields: {
      server: { kind: 'url', def: 'http://homeassistant.local:8123' },
      service: { kind: 'text', re: /^[a-z0-9_]{1,100}$/ },
      token: { kind: 'secret', re: /^[A-Za-z0-9._-]{20,500}$/ },
    },
    send: (c, m) => request('POST', `${base(c.server)}/api/services/notify/${c.service}`, { body: { title: m.title, message: m.textPlain + (m.more ? `\n${m.more}` : '') },
      headers: { Authorization: `Bearer ${c.token}` } }),
  },
  // ---------------------------------------------------------------- bridge
  apprise: {
    // Apprise API (Docker image caronc/apprise): either a stored configuration (…/notify/<key>) or service URLs here
    fields: {
      url: { kind: 'url', def: 'http://apprise:8000/notify/womn' },
      urls: { kind: 'secret', optional: true, re: /^[^\s,]+:\/\/\S+([\s,]+[^\s,]+:\/\/\S+){0,19}$/ },
    },
    send: (c, m) => request('POST', c.url, { body: { title: m.title, body: m.textPlain + (m.more ? `\n${m.more}` : ''), type: m.urgent ? 'failure' : m.good ? 'success' : 'info',
      ...(c.urls ? { urls: c.urls.split(/[\s,]+/).filter(Boolean).join(',') } : {}) } }),
  },
};

export const PROVIDER_TYPES = Object.keys(PROVIDERS);

/** For the browser: plain fields as they are, secret fields only as "set" */
export function publicConfig(type, c) {
  const out = {};
  for (const [k, f] of Object.entries(PROVIDERS[type].fields)) out[k] = f.kind === 'secret' ? { set: !!c[k] } : (c[k] ?? '');
  return out;
}

/** Checks the input; a secret field left empty keeps the stored value. Returns the config or the name of the bad field. */
export function cleanProviderConfig(type, input, old = {}) {
  const out = {};
  for (const [k, f] of Object.entries(PROVIDERS[type].fields)) {
    const raw = typeof input?.[k] === 'string' ? input[k].trim().slice(0, 2000) : '';
    let v = raw;
    if (f.kind === 'secret' && !raw) v = input?.[`clear_${k}`] ? '' : (old[k] || '');
    if (!v && f.def && f.kind !== 'secret') v = f.def;
    if (/[\r\n]/.test(v)) return { bad: k };
    if (!v) { if (f.optional) { out[k] = ''; continue; } return { bad: k }; }
    if (f.kind === 'url' && !HTTP_URL.test(v)) return { bad: k };
    if (f.re && !f.re.test(v) && !(f.alt && f.alt.test(v))) return { bad: k };
    out[k] = f.kind === 'url' ? base(v) : v;
  }
  return { config: out };
}

/** Sends one message; errors never contain a secret of the channel */
export async function sendProvider(type, c, m) {
  try {
    await PROVIDERS[type].send(c, m);
  } catch (e) {
    let why = reason(e);
    for (const [k, f] of Object.entries(PROVIDERS[type].fields)) if (f.kind === 'secret' && c[k]) why = why.split(c[k]).join('***');
    throw new Error(why);
  }
}
