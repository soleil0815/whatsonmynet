// Notification channels: email (SMTP from the settings), Telegram bot, webhook (any URL, optional body template) and the
// services in providers.js (Discord, Slack, Teams, ntfy, Pushover, Signal, Apprise …).
// The configuration of a channel is stored encrypted; tokens and header values never go back to the browser.
import http from 'node:http';
import https from 'node:https';
import { encrypt, decrypt } from '../lib/crypto.js';
import { HttpError, line, str, oneOf } from '../lib/http.js';
import { log } from '../lib/log.js';
import { config } from '../config.js';
import { PROVIDERS, PROVIDER_TYPES, publicConfig, cleanProviderConfig, sendProvider } from './providers.js';
import { forgetChannel } from '../lib/idlists.js';
import { checkText } from '../../public/js/checktext.js';

export const CHANNEL_TYPES = ['email', 'telegram', 'webhook', ...PROVIDER_TYPES];
let telegramApi = 'https://api.telegram.org';
export function setTelegramApiForTests(url) { telegramApi = url; }

const TEXT = {
  de: {
    down: '🔴 {name} ist nicht erreichbar - {message}',
    escalate: '🚨 Eskalation: {name} ist seit {min} Min. nicht erreichbar - {message}',
    up: '🟢 {name} ist wieder erreichbar{downtime}',
    // Measured values (temperature, fill level …): a limit, not a connection
    'down.value': '🔴 {name}: Grenzwert überschritten - {message}',
    'up.value': '🟢 {name}: wieder im normalen Bereich - {message}{downtime}',
    'escalate.value': '🚨 Eskalation: {name} seit {min} Min. über dem Grenzwert - {message}',
    // States (service, VM, disk, container, database …)
    'down.state': '🔴 {name}: Störung - {message}',
    'up.state': '🟢 {name}: wieder in Ordnung{downtime}',
    'escalate.state': '🚨 Eskalation: {name} seit {min} Min. gestört - {message}',
    // A sensor without current values (device, script or hypervisor does not report)
    'down.nodata': '🔴 {name}: keine aktuellen Werte - {message}',
    'up.nodata': '🟢 {name}: liefert wieder Werte{downtime}',
    'escalate.nodata': '🚨 Eskalation: {name} seit {min} Min. ohne aktuelle Werte - {message}',
    downtime: ' (Ausfall {min} Min.)',
    cert: '🟠 Das Zertifikat von {name} läuft in {days} Tagen ab ({date}).',
    certExpired: '🔴 Das Zertifikat von {name} ist abgelaufen ({date}).',
    ipMoved: '🟠 {name} pausiert: Das Gerät hat eine neue IP ({from} → {to}) - bitte das Passwort neu eingeben.',
    test: '✅ Testnachricht von WhatsOnMyNet - dieser Kanal funktioniert.',
    newDevice: '🆕 Neues Gerät im Netz: {list}',
    newDevices: '🆕 {n} neue Geräte im Netz: {list}',
    supplyLow: '🟠 {name}: {supply} nur noch {pct} %',
    supplyWasteLow: '🟠 {name}: {supply} fast voll (noch {pct} % frei)',
    supplyEmpty: '🔴 {name}: {supply} ist leer',
    supplyWasteFull: '🔴 {name}: {supply} ist voll',
    nasBad: '🔴 {name}: {what}',
    nasOk: '🟢 {name}: wieder in Ordnung - {what}',
    'nas.system': 'Systemstatus gestört', 'nas.power': 'Netzteil gestört', 'nas.fan': 'Lüfter gestört',
    'nas.raid': 'Speicherpool {item}: {status}', 'nas.disk': 'Festplatte {item}: {status}', 'nas.volume': 'Volume {item} zu {pct} % voll',
    subject: 'WhatsOnMyNet: {text}',
    target: 'Ziel',
    time: 'Zeit',
    inbox: 'Übernehmen oder ignorieren: Scan → letzter Leicht-Scan',
  },
  en: {
    down: '🔴 {name} is down - {message}',
    escalate: '🚨 Escalation: {name} has been down for {min} min - {message}',
    up: '🟢 {name} is up again{downtime}',
    'down.value': '🔴 {name}: limit exceeded - {message}',
    'up.value': '🟢 {name}: back in the normal range - {message}{downtime}',
    'escalate.value': '🚨 Escalation: {name} over the limit for {min} min - {message}',
    'down.state': '🔴 {name}: fault - {message}',
    'up.state': '🟢 {name}: fine again{downtime}',
    'escalate.state': '🚨 Escalation: {name} failing for {min} min - {message}',
    'down.nodata': '🔴 {name}: no current values - {message}',
    'up.nodata': '🟢 {name}: delivers values again{downtime}',
    'escalate.nodata': '🚨 Escalation: {name} without current values for {min} min - {message}',
    downtime: ' (down for {min} min)',
    cert: '🟠 The certificate of {name} expires in {days} days ({date}).',
    certExpired: '🔴 The certificate of {name} has expired ({date}).',
    ipMoved: '🟠 {name} paused: the device has a new IP ({from} → {to}) - please enter the password again.',
    test: '✅ Test message from WhatsOnMyNet - this channel works.',
    newDevice: '🆕 New device on the network: {list}',
    newDevices: '🆕 {n} new devices on the network: {list}',
    supplyLow: '🟠 {name}: {supply} down to {pct} %',
    supplyWasteLow: '🟠 {name}: {supply} almost full ({pct} % space left)',
    supplyEmpty: '🔴 {name}: {supply} is empty',
    supplyWasteFull: '🔴 {name}: {supply} is full',
    nasBad: '🔴 {name}: {what}',
    nasOk: '🟢 {name}: fine again - {what}',
    'nas.system': 'system status failed', 'nas.power': 'power supply failed', 'nas.fan': 'fan failed',
    'nas.raid': 'storage pool {item}: {status}', 'nas.disk': 'disk {item}: {status}', 'nas.volume': 'volume {item} is {pct} % full',
    subject: 'WhatsOnMyNet: {text}',
    target: 'Target',
    time: 'Time',
    inbox: 'Adopt or ignore: Scan → latest light scan',
  },
};

/** "Temperatur pve2: 83.9 °C (≥ 80)" → "83.9 °C (≥ 80)" when the alarm names the monitor anyway */
const stripLabel = (msg, label) => (label && msg.startsWith(`${label}: `) ? msg.slice(label.length + 2) : msg);

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

/** One-line text of an event in the channel's language */
export function eventText(ev, lang = 'de') {
  const L = lang === 'en' ? 'en' : 'de';
  const T = TEXT[L];
  const name = ev.monitor?.name || '';
  const date = ev.certValidTo ? new Date(ev.certValidTo).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { timeZone: process.env.TZ || undefined }) : '';
  // What failed decides the words: a connection is "down", a value is over its limit, a state is faulty
  const fam = ['value', 'state', 'nodata'].includes(ev.family) ? `.${ev.family}` : '';
  const message = checkText(stripLabel(ev.message || '', ev.monitor?.label), L);
  switch (ev.kind) {
    case 'down': return fill(T[`down${fam}`], { name, message });
    case 'escalate': return fill(T[`escalate${fam}`], { name, min: ev.downMin ?? '', message });
    case 'up': return fill(T[`up${fam}`], { name, message, downtime: ev.downtimeMin ? fill(T.downtime, { min: ev.downtimeMin }) : '' });
    case 'cert': return ev.certDays < 0 ? fill(T.certExpired, { name, date }) : fill(T.cert, { name, days: ev.certDays, date });
    case 'ipMoved': return fill(T.ipMoved, { name, from: ev.from || '', to: ev.to || '' });
    case 'newDevices': {
      const list = (ev.devices || []).slice(0, 5).map(deviceLabel).join(', ') + ((ev.devices || []).length > 5 ? ', …' : '');
      return ev.devices?.length === 1 ? fill(T.newDevice, { list }) : fill(T.newDevices, { n: ev.devices?.length || 0, list });
    }
    case 'supply': {
      const vars = { name: ev.device?.name || '', supply: ev.supply?.description || '', pct: ev.supply?.pct ?? '' };
      if (ev.empty) return fill(ev.supply?.receptacle ? T.supplyWasteFull : T.supplyEmpty, vars);
      return fill(ev.supply?.receptacle ? T.supplyWasteLow : T.supplyLow, vars);
    }
    case 'nas': {
      const p = ev.problem || {};
      const what = fill(T[`nas.${p.kind}`] || p.kind || '', { item: p.name || '', status: p.status || '', pct: p.pct ?? '' });
      return fill(p.solved ? T.nasOk : T.nasBad, { name: ev.device?.name || '', what });
    }
    default: return T.test;
  }
}

const deviceLabel = (d) => [d.ip, d.vendor || d.hostname].filter(Boolean).join(' ');

function details(ev, lang) {
  const T = TEXT[lang === 'en' ? 'en' : 'de'];
  if (ev.kind === 'newDevices') {
    return [...(ev.devices || []).slice(0, 30).map((d) => `• ${d.ip}  ${d.mac || ''}  ${d.vendor || ''}  ${d.hostname || ''}`.replace(/\s+$/, '')), '', T.inbox].join('\n');
  }
  if ((ev.kind === 'supply' || ev.kind === 'nas') && ev.device) return `${T.target}: ${ev.device.name} (${ev.device.ip || ''})`;
  if (!ev.monitor) return '';
  const time = new Date(ev.at || Date.now()).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { timeZone: process.env.TZ || undefined });
  return `${T.target}: ${ev.monitor.target}\n${T.time}: ${time}`;
}

/** Placeholders in a webhook template are inserted JSON-escaped (without quotes), so "{{text}}" works inside a string */
export function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in vars ? JSON.stringify(String(vars[k] ?? '')).slice(1, -1) : ''));
}

function postJson(url, body, { headers = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('invalid address')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request(u, { method: 'POST', timeout: timeoutMs, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': `WhatsOnMyNet/${config.version}`, ...headers } }, (res) => {
      const chunks = []; let size = 0;
      const settle = () => {
        clearTimeout(deadline);
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
        else reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { body: text.slice(0, 300) }));
      };
      // At most 16 KB are read; a longer answer is cut, never read on for ever
      res.on('data', (d) => { chunks.push(d); size += d.length; if (size >= 16384) { settle(); res.destroy(); } });
      res.on('end', settle);
      res.on('error', () => settle());
    });
    // timeout = silence on the socket; a deadline for the whole request too (a trickling answer would hold the
    // monitor that wants to send this alarm)
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs + 2000);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.end(data);
  });
}

const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const EMAILS_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function createChannels(db, mailer, settings = null) {
  const now = () => new Date().toISOString();
  const readConfig = (row) => { try { return JSON.parse(decrypt(row.config) || '{}'); } catch { return {}; } };

  /** For the browser: secrets only as "set" */
  function publicRow(row) {
    const c = readConfig(row);
    const out = { id: row.id, name: row.name, type: row.type, language: row.language, is_default: !!row.is_default, enabled: !!row.enabled, created_at: row.created_at };
    if (row.type === 'email') out.config = { to: c.to || '' };
    if (row.type === 'telegram') out.config = { chatId: c.chatId || '', threadId: c.threadId || '', token: { set: !!c.token } };
    if (row.type === 'webhook') out.config = { url: c.url || '', template: c.template || '', headerName: c.headerName || '', headerValue: { set: !!c.headerValue } };
    if (PROVIDERS[row.type]) out.config = publicConfig(row.type, c);
    return out;
  }

  function cleanConfig(type, input, old = {}) {
    const c = input && typeof input === 'object' ? input : {};
    if (PROVIDERS[type]) {
      const r = cleanProviderConfig(type, c, old);
      if (r.bad) throw new HttpError(400, `err.chField.${r.bad}`);
      return r.config;
    }
    if (type === 'email') {
      const to = line(c.to, 1000).split(/[,;\s]+/).filter(Boolean);
      if (to.some((a) => !EMAILS_RE.test(a))) throw new HttpError(400, 'err.email');
      return { to: to.slice(0, 20).join(', ') };
    }
    if (type === 'telegram') {
      const token = typeof c.token === 'string' && c.token.trim() ? c.token.trim() : old.token;
      if (!token || !/^\d{3,15}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(400, 'err.telegramToken');
      const chatId = line(c.chatId, 40);
      if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(chatId)) throw new HttpError(400, 'err.telegramChat');
      const threadId = line(c.threadId, 12);
      if (threadId && !/^\d{1,12}$/.test(threadId)) throw new HttpError(400, 'err.telegramChat');
      return { token, chatId, threadId };
    }
    const url = line(c.url, 1000);
    if (!URL_RE.test(url)) throw new HttpError(400, 'err.url');
    const template = str(c.template, 5000).trim();
    if (template) {
      try { JSON.parse(renderTemplate(template, { name: 'x', status: 'down', event: 'down', message: 'x', target: 'x', time: 'x', text: 'x', url: 'x' })); }
      catch { throw new HttpError(400, 'err.webhookTemplate'); }
    }
    const headerName = line(c.headerName, 100);
    if (headerName && !/^[A-Za-z0-9-]+$/.test(headerName)) throw new HttpError(400, 'err.webhookHeader');
    const headerValue = typeof c.headerValue === 'string' && c.headerValue !== '' ? c.headerValue.slice(0, 2000) : (c.clearHeaderValue ? '' : old.headerValue || '');
    if (/[\r\n]/.test(headerValue)) throw new HttpError(400, 'err.webhookHeader');
    return { url, template, headerName, headerValue };
  }

  function save(id, input) {
    const old = id ? db.prepare('SELECT * FROM channels WHERE id=?').get(id) : null;
    if (id && !old) throw new HttpError(404, 'err.notFound');
    const type = old ? old.type : oneOf(input.type, CHANNEL_TYPES, null);
    if (!type) throw new HttpError(400, 'err.badRequest');
    const name = line(input.name, 80);
    if (!name) throw new HttpError(400, 'err.nameRequired');
    const cfg = cleanConfig(type, input.config, old ? readConfig(old) : {});
    const language = oneOf(input.language, ['de', 'en'], 'de');
    const isDefault = input.is_default === undefined ? 1 : (input.is_default ? 1 : 0);
    const enabled = input.enabled === undefined ? 1 : (input.enabled ? 1 : 0);
    if (old) {
      db.prepare('UPDATE channels SET name=?, config=?, language=?, is_default=?, enabled=? WHERE id=?').run(name, encrypt(JSON.stringify(cfg)), language, isDefault, enabled, id);
      return get(id);
    }
    const r = db.prepare('INSERT INTO channels(name,type,config,language,is_default,enabled,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(name, type, encrypt(JSON.stringify(cfg)), language, isDefault, enabled, now());
    return get(r.lastInsertRowid);
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
    return row ? publicRow(row) : null;
  }

  async function sendTo(row, ev) {
    const c = readConfig(row);
    const lang = row.language;
    const text = eventText(ev, lang);
    const more = details(ev, lang);
    if (PROVIDERS[row.type]) {
      const textPlain = text.replace(/^\S+\s/, '');
      const urgent = ev.kind === 'down' || ev.kind === 'escalate' || (ev.kind === 'cert' && ev.certDays < 0) || (ev.kind === 'supply' && ev.empty) || (ev.kind === 'nas' && !ev.problem?.solved);
      const good = ev.kind === 'up' || ev.kind === 'test' || (ev.kind === 'nas' && !!ev.problem?.solved);
      try {
        await sendProvider(row.type, c, { title: 'WhatsOnMyNet', text, textPlain, more, full: `${text}${more ? `\n${more}` : ''}`, urgent, good });
      } catch (e) { throw new Error(`${row.type}: ${e.message}`); }
    } else if (row.type === 'email') {
      await mailer.send({ to: c.to, subject: fill(TEXT[lang === 'en' ? 'en' : 'de'].subject, { text: text.replace(/^\S+\s/, '') }), text: `${text}\n\n${more}`.trim() });
    } else if (row.type === 'telegram') {
      try {
        await postJson(`${telegramApi}/bot${c.token}/sendMessage`, { chat_id: c.chatId, text: `${text}${more ? `\n${more}` : ''}`, disable_web_page_preview: true,
          ...(c.threadId ? { message_thread_id: Number(c.threadId) } : {}) });
      } catch (e) {
        // Never put the token (part of the URL) into an error message
        let why = e.message;
        try { why = JSON.parse(e.body || '{}').description || why; } catch { /* not JSON */ }
        throw new Error(`Telegram: ${String(why).replace(c.token, '***')}`);
      }
    } else {
      const vars = { event: ev.kind, status: ev.kind === 'up' ? 'up' : ev.kind === 'down' || ev.kind === 'escalate' ? 'down' : ev.kind, name: ev.monitor?.name || ev.device?.name || '', target: ev.monitor?.target || ev.device?.ip || '',
        message: ev.message || '', text, time: new Date(ev.at || Date.now()).toISOString(), url: ev.monitor?.target || '' };
      const body = c.template ? renderTemplate(c.template, vars)
        : { event: ev.kind, text, monitor: ev.monitor ? { id: ev.monitor.id, name: ev.monitor.name, target: ev.monitor.target } : null,
          message: ev.message || '', time: vars.time, certValidTo: ev.certValidTo || null,
          ...(ev.devices ? { devices: ev.devices.slice(0, 100) } : {}),
          ...(ev.device ? { device: ev.device, supply: ev.supply || null, problem: ev.problem || null } : {}) };
      const headers = c.headerName && c.headerValue ? { [c.headerName]: c.headerValue } : {};
      try { await postJson(c.url, body, { headers }); } catch (e) { throw new Error(`Webhook: ${e.message}`); }
    }
  }

  return {
    list: () => db.prepare('SELECT * FROM channels ORDER BY name').all().map(publicRow),
    get,
    create: (input) => save(null, input),
    update: (id, input) => save(id, input),
    remove(id) {
      db.transaction(() => {
        if (!db.prepare('DELETE FROM channels WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound');
        forgetChannel(db, settings, id);
      })();
    },
    async test(id) {
      const row = db.prepare('SELECT * FROM channels WHERE id=?').get(id);
      if (!row) throw new HttpError(404, 'err.notFound');
      try { await sendTo(row, { kind: 'test' }); } catch (e) { throw new HttpError(502, 'err.channelFailed', e.detail || (e.code === 'err.smtpNotConfigured' ? 'SMTP' : e.message)); }
    },
    /** Sends an event to the monitor's channels (empty list = all default channels). Returns the names reached. */
    notify(monitor, ev) {
      let ids = [];
      try { ids = JSON.parse(monitor.channels || '[]'); } catch { ids = []; }
      return this.notifyIds(ids, ev);
    },
    /** Sends an event to the given channels (empty list = all default channels). Returns the names reached. */
    async notifyIds(ids, ev) {
      ids = (Array.isArray(ids) ? ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
      const rows = ids.length
        ? db.prepare(`SELECT * FROM channels WHERE enabled=1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids)
        : db.prepare('SELECT * FROM channels WHERE enabled=1 AND is_default=1').all();
      const reached = [];
      await Promise.all(rows.map(async (row) => {
        // A hard limit per channel: the monitor that raises this alarm waits for it and is not checked meanwhile
        let timer;
        const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('no answer within 60 s')), 60_000); timer.unref?.(); });
        try { await Promise.race([sendTo(row, ev), limit]); reached.push(row.name); } catch (e) { log.warn(`Notification via "${row.name}" failed: ${e.detail || e.message}`); } finally { clearTimeout(timer); }
      }));
      return reached;
    },
  };
}
