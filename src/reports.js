// Planned reports by e-mail: e.g. every Monday 8:00 the office gets the toner levels of all printers.
// The mail is neutral on purpose: no link and no hint where it comes from – only the devices, their state and the
// own text (subject, introduction, signature such as "Your IT team").
import { HttpError, line, str } from './lib/http.js';
import { log } from './lib/log.js';
import { nasProblems } from './scan/nas.js';
import { localDay } from './scan/nightly.js';

export const SECTIONS = ['printers', 'nas', 'switches', 'shares'];
const EMAIL = /^[^\s@,;<>]{1,64}@[^\s@,;<>]{1,253}\.[^\s@,;<>]{2,}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WINDOW_MIN = 4 * 60;
const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const T = {
  de: {
    subject: 'Gerätestatus – KW {week}', printers: 'Drucker', nas: 'Speichersysteme (NAS)', switches: 'Switches', shares: 'Netzlaufwerke',
    freeOf: '{free} frei von {total}',
    order: 'bitte nachbestellen', nearlyFull: 'fast voll', empty: 'leer', full: 'voll', free: '{pct} % frei', some: 'vorhanden', unknown: 'unbekannt',
    unreachable: 'zurzeit nicht erreichbar', pages: 'Seiten gesamt', state: 'Zustand', ok: 'in Ordnung', attention: 'Handlungsbedarf',
    volume: 'Speicher', disks: 'Festplatten', temp: 'Temperatur', portsUp: '{up} von {n} Anschlüssen verbunden', none: 'Keine Geräte in diesem Bericht.',
    allGood: 'Alles in Ordnung – nichts zu tun.', location: 'Standort', disk: 'Festplatte {name}: {status}', raid: '{name}: {status}',
    sys: 'Systemstatus gestört', power: 'Netzteil gestört', fan: 'Lüfter gestört', full90: '{name} zu {pct} % belegt', jam: 'Papierstau', noPaper: 'kein Papier',
    doorOpen: 'Klappe offen', service: 'Wartung nötig', offline: 'offline',
    st: { systemPartitionFailed: 'Systempartition defekt', crashed: 'ausgefallen', degrade: 'eingeschränkt', rwError: 'Lese-/Schreibfehler', invalid: 'ungültig', raidUnknownStatus: 'unbekannter Zustand' },
  },
  en: {
    subject: 'Device status – week {week}', printers: 'Printers', nas: 'Storage (NAS)', switches: 'Switches', shares: 'Network drives',
    freeOf: '{free} free of {total}',
    order: 'please order', nearlyFull: 'almost full', empty: 'empty', full: 'full', free: '{pct} % free', some: 'available', unknown: 'unknown',
    unreachable: 'currently not reachable', pages: 'Pages in total', state: 'State', ok: 'fine', attention: 'Action needed',
    volume: 'Storage', disks: 'Disks', temp: 'Temperature', portsUp: '{up} of {n} ports connected', none: 'No devices in this report.',
    allGood: 'All fine – nothing to do.', location: 'Location', disk: 'Disk {name}: {status}', raid: '{name}: {status}',
    sys: 'System status failed', power: 'Power supply failed', fan: 'Fan failed', full90: '{name} is {pct} % full', jam: 'Paper jam', noPaper: 'No paper',
    doorOpen: 'Door open', service: 'Service needed', offline: 'offline',
  },
};
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (k in v ? String(v[k]) : `{${k}}`));
const SUPPLY_DE = { toner: 'Toner', wasteToner: 'Resttonerbehälter', ink: 'Tinte', inkCartridge: 'Tintenpatrone', drum: 'Trommel', fuser: 'Fixiereinheit', transferUnit: 'Transfereinheit', tonerCartridge: 'Tonerkartusche', wasteInk: 'Resttintenbehälter' };
const COLOR = { black: '#2b2f36', cyan: '#12a7d8', magenta: '#d4237a', yellow: '#e0b400' };

export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}

/** Is the report due at `now` (local time)? schedule: { freq: daily|weekly|monthly, time, weekday 1–7, day 1–28 } */
export function reportDue(schedule, lastDay, now = new Date()) {
  const m = TIME.exec(schedule?.time || '');
  if (!m || lastDay === localDay(now)) return false;
  const wd = now.getDay() || 7;
  if (schedule.freq === 'weekly' && wd !== Number(schedule.weekday)) return false;
  if (schedule.freq === 'monthly' && now.getDate() !== Number(schedule.day)) return false;
  const diff = now.getHours() * 60 + now.getMinutes() - (Number(m[1]) * 60 + Number(m[2]));
  return diff >= 0 && diff < WINDOW_MIN;
}

export function createReports({ db, settings, mailer }) {
  let timer = null;

  function shape(r) {
    if (!r) return null;
    return { ...r, sections: parse(r.sections, []), schedule: parse(r.schedule, {}), location_ids: parse(r.location_ids, []),
      recipients: r.recipients ? r.recipients.split(',') : [], only_attention: !!r.only_attention, enabled: !!r.enabled };
  }
  const get = (id) => shape(db.prepare('SELECT * FROM reports WHERE id=?').get(id));

  function clean(input) {
    const name = line(input.name, 100);
    if (!name) throw new HttpError(400, 'err.nameRequired');
    const sections = (Array.isArray(input.sections) ? input.sections : []).filter((x) => SECTIONS.includes(x));
    if (!sections.length) throw new HttpError(400, 'err.reportSections');
    const recipients = [...new Set((Array.isArray(input.recipients) ? input.recipients : String(input.recipients || '').split(/[\s,;]+/))
      .map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 50);
    if (!recipients.length || recipients.some((x) => !EMAIL.test(x))) throw new HttpError(400, 'err.reportRecipients');
    const s = input.schedule || {};
    const schedule = { freq: ['daily', 'weekly', 'monthly'].includes(s.freq) ? s.freq : 'weekly', time: TIME.test(s.time || '') ? s.time : '',
      weekday: Math.min(7, Math.max(1, Number(s.weekday) || 1)), day: Math.min(28, Math.max(1, Number(s.day) || 1)) };
    if (!schedule.time) throw new HttpError(400, 'err.time');
    const locs = (Array.isArray(input.location_ids) ? input.location_ids : []).map(Number).filter((x) => x > 0 && db.prepare('SELECT 1 FROM locations WHERE id=?').get(x));
    return {
      name, sections: JSON.stringify(sections), recipients: recipients.join(','), schedule: JSON.stringify(schedule), location_ids: JSON.stringify(locs),
      subject: line(input.subject, 200), intro: str(input.intro, 4000).trim(), signature: str(input.signature, 2000).trim(), from_name: line(input.from_name, 100).replace(/["<>]/g, ''),
      language: input.language === 'en' ? 'en' : 'de', only_attention: input.only_attention ? 1 : 0, enabled: input.enabled === false ? 0 : 1,
    };
  }

  // ------------------------------------------------------------------------------------------------ content

  function devicesOf(type, locs) {
    return db.prepare(`SELECT d.id, d.name, d.model, d.vendor, d.ip, d.location_id, l.name location FROM devices d LEFT JOIN locations l ON l.id=d.location_id
      WHERE d.type=? ORDER BY l.name, d.name`).all(type).filter((d) => !locs.length || locs.includes(d.location_id));
  }

  function printerItems(locs, L) {
    const threshold = Number(settings.get('printer.threshold')) || 15;
    return devicesOf('printer', locs).map((d) => {
      const row = db.prepare('SELECT * FROM printer_status WHERE device_id=?').get(d.id);
      const data = parse(row?.data, {});
      const supplies = (data.supplies || []).map((s) => {
        const low = s.state === 'empty' || (s.pct !== null && s.pct !== undefined && s.pct <= threshold);
        const label = s.description && s.description !== s.type ? s.description : (L === T.de ? SUPPLY_DE[s.type] : null) || s.type;
        const value = s.state === 'empty' ? (s.receptacle ? L.full : L.empty) : s.pct !== null && s.pct !== undefined ? (s.receptacle ? fill(L.free, { pct: s.pct }) : `${s.pct} %`) : s.state === 'some' ? L.some : L.unknown;
        return { label, value, pct: s.pct, fill: s.pct === null || s.pct === undefined ? null : (s.receptacle ? 100 - s.pct : s.pct), color: COLOR[s.color] || '#5b6b7a', low, lowText: L.order };
      });
      const errs = (data.errors || []).map((e) => ({ jammed: L.jam, noPaper: L.noPaper, doorOpen: L.doorOpen, serviceRequested: L.service, offline: L.offline }[e])).filter(Boolean);
      const unreachable = !row || !row.ok;
      return { name: d.name, sub: [d.model || d.vendor, d.location].filter(Boolean).join(' · '), supplies, notes: errs, pages: data.pages ?? null,
        unreachable, attention: unreachable || errs.length > 0 || supplies.some((s) => s.low) };
    });
  }

  function nasItems(locs, L) {
    const threshold = Number(settings.get('nas.threshold')) || 90;
    return devicesOf('nas', locs).map((d) => {
      const row = db.prepare("SELECT * FROM snmp_status WHERE device_id=? AND kind='nas'").get(d.id);
      const data = parse(row?.data, {});
      const st = (x) => (L.st?.[x] || x);
      const all = nasProblems(data, threshold);
      // Full volumes are shown by their bar; the other problems as text
      const problems = all.filter((p) => p.kind !== 'volume').map((p) => (p.kind === 'disk' ? fill(L.disk, { name: p.name, status: st(p.status) })
        : p.kind === 'raid' ? fill(L.raid, { name: p.name, status: st(p.status) }) : { system: L.sys, power: L.power, fan: L.fan }[p.kind]));
      const unreachable = !row || !row.ok;
      const bars = (data.volumes || []).map((v) => ({ label: v.name, value: `${v.pct} %`, fill: v.pct, color: '#3f7f8c', low: v.pct >= threshold, lowText: L.nearlyFull }));
      const notes = [...problems];
      if (data.temp) notes.unshift(`${L.temp}: ${data.temp} °C`);
      if ((data.disks || []).length) notes.push(`${L.disks}: ${data.disks.filter((x) => !x.bad).length}/${data.disks.length} ${L.ok}`);
      return { name: d.name, sub: [data.model || d.model, d.location].filter(Boolean).join(' · '), supplies: bars, notes, unreachable, attention: unreachable || all.length > 0 };
    });
  }

  function switchItems(locs, L) {
    return devicesOf('switch', locs).map((d) => {
      const row = db.prepare("SELECT * FROM snmp_status WHERE device_id=? AND kind='switch'").get(d.id);
      const data = parse(row?.data, {});
      const ports = (data.ports || []).filter((p) => !p.lag);
      const unreachable = !row || !row.ok;
      return { name: d.name, sub: [data.model || d.model, d.location].filter(Boolean).join(' · '), supplies: [],
        notes: ports.length ? [fill(L.portsUp, { up: ports.filter((p) => p.status === 'up').length, n: ports.length })] : [], unreachable, attention: unreachable };
    });
  }

  /** Network drives: the SMB monitors with their last measured free space */
  function shareItems(locs, L) {
    const lang = L === T.en ? 'en-GB' : 'de-DE';
    const size = (n) => {
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      let v = Number(n) || 0; let i = 0;
      while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
      return `${v.toLocaleString(lang, { maximumFractionDigits: v >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
    };
    return db.prepare(`SELECT m.*, d.location_id, l.name location FROM monitors m LEFT JOIN devices d ON d.id=m.device_id
      LEFT JOIN locations l ON l.id=d.location_id WHERE m.type='smb' AND m.enabled=1 ORDER BY m.name`).all()
      .filter((m) => !locs.length || locs.includes(m.location_id))
      .map((m) => {
        const o = parse(m.options, {});
        const data = parse(m.data, {});
        const unc = `\\\\${m.target}\\${o.share || ''}${o.path ? `\\${o.path}` : ''}`;
        const low = !!data.low;
        const unreachable = m.status === 'down' && !low;
        const bars = data.total ? [{ label: L.volume,
          value: `${fill(L.freeOf, { free: size(data.free), total: size(data.total) })} (${Number(data.pct).toLocaleString(lang)} %)`,
          fill: Math.max(0, Math.min(100, 100 - data.pct)), color: '#3f7f8c', low, lowText: L.nearlyFull }] : [];
        return { name: m.name, sub: [unc, m.location].filter(Boolean).join(' · '), supplies: bars, notes: [], unreachable, attention: unreachable || low };
      });
  }

  /** { subject, html, text, count, attention } */
  function render(r, now = new Date()) {
    const L = T[r.language] || T.de;
    const vars = { week: isoWeek(now), kw: isoWeek(now), date: now.toLocaleDateString(r.language === 'en' ? 'en-GB' : 'de-DE'), datum: now.toLocaleDateString('de-DE') };
    const subject = fill(r.subject || L.subject, vars);
    const builders = { printers: printerItems, nas: nasItems, switches: switchItems, shares: shareItems };
    const groups = r.sections.map((sec) => {
      let items = builders[sec](r.location_ids, L);
      if (r.only_attention) items = items.filter((i) => i.attention);
      return { title: L[sec], items };
    }).filter((g) => g.items.length || !r.only_attention);
    const count = groups.reduce((n, g) => n + g.items.length, 0);
    const attention = groups.reduce((n, g) => n + g.items.filter((i) => i.attention).length, 0);

    // Plain text
    const t = [];
    if (r.intro) t.push(fill(r.intro, vars), '');
    for (const g of groups) {
      t.push(g.title.toUpperCase(), '');
      for (const i of g.items) {
        t.push(`${i.name}${i.sub ? ` (${i.sub})` : ''}${i.attention ? `  – ${L.attention}` : ''}`);
        if (i.unreachable) t.push(`  ${L.unreachable}`);
        for (const s of i.supplies) t.push(`  ${s.label}: ${s.value}${s.low ? `  ← ${s.lowText || L.order}` : ''}`);
        for (const n of i.notes) t.push(`  ${n}`);
        if (i.pages !== null && i.pages !== undefined) t.push(`  ${L.pages}: ${Number(i.pages).toLocaleString(r.language === 'en' ? 'en-GB' : 'de-DE')}`);
        t.push('');
      }
    }
    if (!count) t.push(r.only_attention ? L.allGood : L.none, '');
    if (r.signature) t.push('', fill(r.signature, vars));
    const text = t.join('\n');

    // HTML (inline styles – mail programs ignore style sheets)
    const para = (s) => esc(s).replace(/\n/g, '<br>');
    const bar = (s) => `<tr><td style="padding:3px 12px 3px 0;font-size:13px;color:#30363d;white-space:nowrap">${esc(s.label)}</td>
      <td style="padding:3px 0;width:100%"><div style="background:#e6e9ee;border-radius:4px;height:10px;overflow:hidden">${s.fill === null || s.fill === undefined ? '' : `<div style="background:${s.color};width:${Math.max(0, Math.min(100, s.fill))}%;height:10px"></div>`}</div></td>
      <td style="padding:3px 0 3px 12px;font-size:13px;white-space:nowrap;${s.low ? 'color:#c0392b;font-weight:bold' : 'color:#57606a'}">${esc(s.value)}${s.low ? ` – ${esc(s.lowText || L.order)}` : ''}</td></tr>`;
    const card = (i) => `<div style="border:1px solid ${i.attention ? '#e8b4ad' : '#d8dee4'};border-radius:8px;padding:12px 14px;margin:0 0 10px;background:${i.attention ? '#fff8f6' : '#ffffff'}">
      <div style="font-size:15px;font-weight:bold;color:#1f2328">${esc(i.name)}${i.attention ? ` <span style="font-size:12px;font-weight:normal;color:#c0392b">· ${esc(L.attention)}</span>` : ''}</div>
      ${i.sub ? `<div style="font-size:12px;color:#6e7781;margin:2px 0 6px">${esc(i.sub)}</div>` : ''}
      ${i.unreachable ? `<div style="font-size:13px;color:#9a6700;margin:4px 0">${esc(L.unreachable)}</div>` : ''}
      ${i.supplies.length ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin-top:4px">${i.supplies.map(bar).join('')}</table>` : ''}
      ${i.notes.map((n) => `<div style="font-size:13px;color:#30363d;margin-top:4px">${esc(n)}</div>`).join('')}
      ${i.pages !== null && i.pages !== undefined ? `<div style="font-size:12px;color:#6e7781;margin-top:6px">${esc(L.pages)}: ${esc(Number(i.pages).toLocaleString(r.language === 'en' ? 'en-GB' : 'de-DE'))}</div>` : ''}
    </div>`;
    const html = `<!doctype html><html lang="${r.language === 'en' ? 'en' : 'de'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8"><div style="max-width:640px;margin:0 auto;padding:24px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328">
${r.intro ? `<p style="font-size:14px;line-height:1.5;margin:0 0 18px">${para(fill(r.intro, vars))}</p>` : ''}
${groups.map((g) => `<h2 style="font-size:16px;margin:20px 0 10px;color:#1f2328">${esc(g.title)}</h2>${g.items.map(card).join('') || `<p style="font-size:13px;color:#6e7781">${esc(L.none)}</p>`}`).join('')}
${!count ? `<p style="font-size:14px;color:#1a7f37">${esc(r.only_attention ? L.allGood : L.none)}</p>` : ''}
${r.signature ? `<p style="font-size:14px;line-height:1.5;margin:24px 0 0">${para(fill(r.signature, vars))}</p>` : ''}
</div></body></html>`;
    return { subject, html, text, count, attention };
  }

  async function send(id, { to = null, now = new Date() } = {}) {
    const r = get(id);
    if (!r) throw new HttpError(404, 'err.notFound');
    const m = render(r, now);
    await mailer.send({ to: (to ? [to] : r.recipients).join(', '), subject: m.subject, text: m.text, html: m.html, fromName: r.from_name || undefined });
    return m;
  }

  async function tick(now = new Date()) {
    for (const r of db.prepare('SELECT * FROM reports WHERE enabled=1').all().map(shape)) {
      if (!reportDue(r.schedule, r.last_day, now)) continue;
      db.prepare('UPDATE reports SET last_day=? WHERE id=?').run(localDay(now), r.id);
      try {
        const m = await send(r.id, { now });
        db.prepare("UPDATE reports SET last_run=?, last_status='ok' WHERE id=?").run(now.toISOString(), r.id);
        log.info(`Report "${r.name}" sent to ${r.recipients.length} recipient(s) (${m.count} device(s))`);
      } catch (e) {
        db.prepare('UPDATE reports SET last_run=?, last_status=? WHERE id=?').run(now.toISOString(), String(e.detail || e.message).slice(0, 200), r.id);
        log.warn(`Report "${r.name}" failed: ${e.detail || e.message}`);
      }
    }
  }

  return {
    list: () => db.prepare('SELECT * FROM reports ORDER BY name').all().map(shape),
    get,
    create(input) {
      const v = clean(input);
      const keys = Object.keys(v);
      const id = db.prepare(`INSERT INTO reports(${keys.join(',')},created_at) VALUES(${keys.map(() => '?').join(',')},?)`).run(...keys.map((k) => v[k]), new Date().toISOString()).lastInsertRowid;
      return get(id);
    },
    update(id, input) {
      if (!get(id)) throw new HttpError(404, 'err.notFound');
      const v = clean(input);
      const keys = Object.keys(v);
      db.prepare(`UPDATE reports SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => v[k]), id);
      return get(id);
    },
    remove(id) { if (!db.prepare('DELETE FROM reports WHERE id=?').run(id).changes) throw new HttpError(404, 'err.notFound'); },
    render,
    send,
    tick,
    start() { if (!timer) { timer = setInterval(() => tick().catch((e) => log.warn(`Reports: ${e.message}`)), 60 * 1000); timer.unref(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
