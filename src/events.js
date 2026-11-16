// Messages devices send by themselves: SNMP traps (v1, v2c, informs) and syslog (UDP, TCP and TLS; RFC 3164 and 5424). Switches,
// UPSs, firewalls and NAS report a problem the moment it happens - instead of waiting for the next poll.
//
// Off until switched on (Monitoring → Messages). The ports come from .env: WOMN_TRAP_PORT (default 1162),
// WOMN_SYSLOG_PORT (UDP, default 1514), WOMN_SYSLOG_TCP_PORT (default 1514) and WOMN_SYSLOG_TLS_PORT (default 6514,
// with the certificate of this server) - not 162/514, because WhatsOnMyNet runs without root rights; a port redirect on the
// host or the port set on the device does the rest (see the manual).
//
// Each installation keeps what it received itself (failover: send to both), in a file of its own (data/events.sqlite,
// see db.js): kept 30 days, in at most 2 GB - and never so much that less than 10 % of the disk (at least 1 GB) is left.
// Whatever comes first: the oldest messages go.
// A flood (a device in a loop, or someone sending on purpose) is cut: at most 20 messages per second per sender and
// 300 in all; text is cut to 4000 characters (a German failed sign-in 4625 is some 2000 - the reason is in its middle). UDP has no sender check - traps at least need a known community.
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import snmp from 'net-snmp';
import { log } from './lib/log.js';
import { config } from './config.js';
import { parseEventIds } from './eventrules.js';

export const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const GB = 1024 ** 3;
export const MAX_GB_DEFAULT = 2;
const PRUNE_MS = 10 * 60 * 1000;
const STATS_MS = 60 * 1000;
const STATS_FRESH_MS = 15 * 1000;
const PER_SENDER = 20;
const PER_SECOND = 300;
export const TEXT_MAX = 4000;
const clip = (s, n) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------------------------------------- syslog
// Windows events (NXLog, im_msvistalog): the event id, log (channel), source and account are kept in fields of their
// own, so a rule can ask for "Defender, event 1116" instead of searching text. Two shapes are understood:
//   JSON   - "Exec $Message = to_json(); to_syslog_ietf();" (or to_json() alone): all fields of the event
//   a line - NXLog without Exec: "2026-11-15 10:00:00 PC-01 WARNING 1116 Microsoft Defender Antivirus has detected …"
//   readable - the config of the manual: to_syslog_bsd() with the message "[1116] [Microsoft-Windows-Windows Defender/
//            Operational] Microsoft Defender Antivirus has detected …" (the source is the syslog tag)
const WIN_SEVERITY = { CRITICAL: 2, ERROR: 3, WARNING: 4, AUDIT_FAILURE: 4, INFO: 6, AUDIT_SUCCESS: 6, DEBUG: 7 };
const NX_LINE = /^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d)\s+(\S+)\s+(INFO|WARNING|ERROR|CRITICAL|DEBUG|AUDIT_SUCCESS|AUDIT_FAILURE)\s+(\d{1,6})\s+([\s\S]*)$/;

/** Windows fields of a message text, or null → { eventId, channel, account, app, host, severity, text } */
export function windowsFields(raw) {
  const s = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (s.startsWith('{')) {
    let j;
    try { j = JSON.parse(s); } catch { return null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const id = Number(j.EventID ?? j.EventId ?? j.event_id);
    if (!Number.isInteger(id) || id < 0 || id > 999999) return null;
    // a failed audit (wrong password, access denied) is a warning even where the log calls it "INFO"
    const type = String(j.EventType || '').toUpperCase();
    const sev = type === 'AUDIT_FAILURE' ? 4 : WIN_SEVERITY[String(j.Severity || '').toUpperCase()] ?? WIN_SEVERITY[type];
    const user = j.TargetUserName && /^(4740|4767|4625|4720|4722|4725|4726|4728|4732|4756)$/.test(String(id)) ? j.TargetUserName : j.AccountName;
    const dom = j.TargetUserName && user === j.TargetUserName ? j.TargetDomainName : j.Domain;
    return { eventId: id, channel: clip(j.Channel, 120), account: clip(user ? `${dom ? `${dom}\\` : ''}${user}` : '', 120),
      app: clip(j.SourceName || j.ProviderName, 60), host: clip(j.Hostname || j.Computer, 120), severity: sev ?? null,
      text: String(j.Message ?? '') || `event ${id}` };
  }
  const b = /^\[(\d{1,6})\] \[([^\]\r\n]{0,200})\] ?([\s\S]*)$/.exec(s);
  if (b) return { eventId: Number(b[1]), channel: clip(b[2], 120), account: '', app: '', host: '', severity: null, text: b[3] || `event ${b[1]}` };
  const m = NX_LINE.exec(s);
  if (m) return { eventId: Number(m[4]), channel: '', account: '', app: '', host: clip(m[2], 120), severity: WIN_SEVERITY[m[3]], text: m[5] };
  return null;
}

/** The message part of a syslog message → the fields; a Windows event fills its own fields */
function finish(out, rest) {
  // a source with a space ("Microsoft-Windows-Windows Defender") is no syslog tag to the parser above - in front of
  // "[id] [log]" it still is the source
  const tag = !out.app && /^([^:[\]\r\n]{1,80}): (?=\[\d{1,6}\] \[)/.exec(rest);
  if (tag) { out.app = clip(tag[1], 60); rest = rest.slice(tag[0].length); }
  const w = windowsFields(rest);
  if (w) {
    out.eventId = w.eventId; out.channel = w.channel; out.account = w.account;
    if (w.app) out.app = w.app;
    if (w.host) out.host = w.host;
    if (w.severity !== null && w.severity !== undefined) out.severity = w.severity;
    rest = w.text;
  }
  out.text = clip(rest, TEXT_MAX);
  return out;
}

// Text of a message: UTF-8 - and where a byte is no UTF-8, Windows-1252. NXLog and older devices send umlauts in the code
// page of Windows, sometimes mixed with UTF-8 in the same line ("NT-AUTORITÄT" from the account, "für" from the text):
// each valid UTF-8 sequence is read as UTF-8, every other byte as Windows-1252.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
// 0x80-0x9F of Windows-1252 (the rest of 0xA0-0xFF is Latin-1)
const CP1252_HIGH = '\u20ac\ufffd\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\ufffd\u017d\ufffd\ufffd\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\ufffd\u017e\u0178';
const cp1252 = (b) => (b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b));
/** Length of a valid UTF-8 sequence starting at i (2-4), or 0 */
function utf8Seq(buf, i) {
  const b = buf[i];
  const cont = (j) => j < buf.length && (buf[j] & 0xc0) === 0x80;
  if (b >= 0xc2 && b <= 0xdf) return cont(i + 1) ? 2 : 0;
  if (b >= 0xe0 && b <= 0xef) {
    if (!cont(i + 1) || !cont(i + 2)) return 0;
    if (b === 0xe0 && buf[i + 1] < 0xa0) return 0;           // overlong
    if (b === 0xed && buf[i + 1] >= 0xa0) return 0;          // surrogates
    return 3;
  }
  if (b >= 0xf0 && b <= 0xf4) {
    if (!cont(i + 1) || !cont(i + 2) || !cont(i + 3)) return 0;
    if (b === 0xf0 && buf[i + 1] < 0x90) return 0;
    if (b === 0xf4 && buf[i + 1] >= 0x90) return 0;
    return 4;
  }
  return 0;
}
export function decodeText(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf ?? '');
  try { return UTF8.decode(buf); } catch { /* not all UTF-8: byte by byte below */ }
  let out = ''; let start = 0;
  for (let i = 0; i < buf.length;) {
    if (buf[i] < 0x80) { i++; continue; }
    const n = utf8Seq(buf, i);
    if (n) { i += n; continue; }
    out += buf.toString('utf8', start, i) + cp1252(buf[i]);
    i++; start = i;
  }
  return out + buf.toString('utf8', start);
}

/** One syslog datagram → { severity, facility, host, app, text, eventId?, channel?, account? } */
export function parseSyslog(raw) {
  let s = decodeText(raw);
  s = s.replace(/^\uFEFF/, '').slice(0, 8192);
  const m = /^<(\d{1,3})>([\s\S]*)$/.exec(s.trimStart());
  if (!m || Number(m[1]) > 191) return finish({ severity: 5, facility: 1, host: '', app: '', text: '' }, s);
  const pri = Number(m[1]);
  const out = { severity: pri % 8, facility: pri >> 3, host: '', app: '', text: '' };
  let rest = m[2];
  // RFC 5424: <PRI>1 TIMESTAMP HOST APP PROCID MSGID [SD] MSG
  const r5 = /^1 (\S+) (\S+) (\S+) (\S+) (\S+) /.exec(rest);
  if (r5) {
    out.host = r5[2] === '-' ? '' : clip(r5[2], 120);
    out.app = r5[3] === '-' ? '' : clip(r5[3], 60);
    rest = rest.slice(r5[0].length);
    if (rest.startsWith('-')) rest = rest.slice(1);
    else while (rest.startsWith('[')) { const end = /^\[(?:[^\]\\]|\\.)*\]/.exec(rest); if (!end) break; rest = rest.slice(end[0].length); }
    return finish(out, rest.replace(/^ ?\uFEFF?/, ''));
  }
  // RFC 3164: <PRI>Mmm dd hh:mm:ss HOST TAG[pid]: MSG (many devices leave out the time or the host)
  const ts = /^([A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d|\d{4}-\d\d-\d\dT\S+) /.exec(rest);
  if (ts) {
    rest = rest.slice(ts[0].length);
    const host = /^([\w.:-]+) (?=\S)/.exec(rest);
    if (host && !/:$/.test(host[1])) { out.host = clip(host[1], 120); rest = rest.slice(host[0].length); }
  }
  // no time, but a host in front of the tag: "fs01 smartd[512]: …"
  if (!ts) {
    const hostTag = /^([\w.-]{1,120}) (?=[^\s:[\]]{1,48}(\[\d+\])?: )/.exec(rest);
    if (hostTag) { out.host = clip(hostTag[1], 120); rest = rest.slice(hostTag[0].length); }
  }
  const tag = /^([^\s:[\]]{1,48})(\[\d+\])?: ?/.exec(rest);
  if (tag) { out.app = clip(tag[1], 60); rest = rest.slice(tag[0].length); }
  return finish(out, rest);
}

// ---------------------------------------------------------------------------------------------- syslog over a stream
// TCP (RFC 6587) and TLS (RFC 5425) carry several messages on one connection. Two kinds of framing:
//   octet counting  "123 <34>1 2026-…"   (length first - RFC 5425 requires it)
//   line by line    "<34>Oct 11 …\n"     (most devices over plain TCP)
// The first byte of each message decides. A message longer than MAX_FRAME is skipped (that one only - the connection
// stays: NXLog sends a long Windows event now and then); nonsense lengths or a line without end beyond 1 MB end it.
export const MAX_FRAME = 8192;
const MAX_SKIP_LINE = 1024 * 1024;
export function syslogFramer(onMessage, onSkipped = () => {}) {
  let buf = Buffer.alloc(0);
  let skipBytes = 0;     // octet counting: what is left of a message that is too long
  let skipLine = -1;     // line by line: bytes skipped of a line that is too long (-1: not skipping)
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (skipBytes) {
        const n = Math.min(skipBytes, buf.length);
        skipBytes -= n; buf = buf.subarray(n);
        if (skipBytes) return true;
        onSkipped();
      }
      if (skipLine >= 0) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) { skipLine += buf.length; buf = Buffer.alloc(0); return skipLine <= MAX_SKIP_LINE; }
        buf = buf.subarray(nl + 1); skipLine = -1;
        onSkipped();
      }
      // skip line ends between messages
      let i = 0;
      while (i < buf.length && (buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x00)) i++;
      if (i) buf = buf.subarray(i);
      if (!buf.length) return true;
      // Octet counting only for "LENGTH <PRI>…" (RFC 5425/6587); a line that merely starts with a digit - NXLog's own
      // format "2026-11-15 10:00:00 PC-01 INFO 4624 …", a device without <PRI> - is a line, not a length.
      if (buf[0] >= 0x31 && buf[0] <= 0x39) {
        const head = buf.subarray(0, 16).toString('latin1');
        const m = /^(\d{1,12}) (<|$)/.exec(head);
        if (m && !m[2] && buf.length < 16) return true; // "16 " - the rest is still on the way
        if (m && m[2]) {
          if (m[1].length > 6) return false;
          const len = Number(m[1]);
          const sp = m[1].length;
          if (len > MAX_FRAME) { skipBytes = len; buf = buf.subarray(sp + 1); continue; }
          if (buf.length < sp + 1 + len) return true;
          onMessage(buf.subarray(sp + 1, sp + 1 + len));
          buf = buf.subarray(sp + 1 + len);
          continue;
        }
        if (/^\d{1,12}$/.test(head) && buf.length < 16) return true; // only digits so far - wait for more
      }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length <= MAX_FRAME) return true;
        skipLine = buf.length; buf = Buffer.alloc(0); return true;
      }
      if (nl > MAX_FRAME) { buf = buf.subarray(nl + 1); onSkipped(); continue; }
      onMessage(buf.subarray(0, nl));
      buf = buf.subarray(nl + 1);
    }
  };
}

// ---------------------------------------------------------------------------------------------- traps
const TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0';
const UPTIME_OID = '1.3.6.1.2.1.1.3.0';
// Well-known traps: [name, severity, words]
export const KNOWN_TRAPS = {
  '1.3.6.1.6.3.1.1.5.1': ['coldStart', 5, 'device started'],
  '1.3.6.1.6.3.1.1.5.2': ['warmStart', 5, 'device restarted'],
  '1.3.6.1.6.3.1.1.5.3': ['linkDown', 4, 'port down'],
  '1.3.6.1.6.3.1.1.5.4': ['linkUp', 6, 'port up'],
  '1.3.6.1.6.3.1.1.5.5': ['authenticationFailure', 4, 'SNMP request with a wrong community'],
  '1.3.6.1.2.1.33.2.0.1': ['upsTrapOnBattery', 2, 'UPS on battery'],
  '1.3.6.1.2.1.33.2.0.2': ['upsTrapTestCompleted', 6, 'UPS self-test completed'],
  '1.3.6.1.2.1.33.2.0.3': ['upsTrapAlarmEntryAdded', 3, 'UPS alarm'],
  '1.3.6.1.2.1.33.2.0.4': ['upsTrapAlarmEntryRemoved', 6, 'UPS alarm cleared'],
  '1.3.6.1.4.1.318.0.5': ['apcOnBattery', 2, 'APC UPS on battery'],
  '1.3.6.1.4.1.318.0.9': ['apcReturnFromBattery', 6, 'APC UPS back on mains'],
  '1.3.6.1.4.1.318.0.7': ['apcLowBattery', 1, 'APC UPS battery low'],
  '1.3.6.1.4.1.318.0.3': ['apcCommunicationLost', 3, 'APC: communication with the UPS lost'],
};
// Port name of linkDown/linkUp: ifDescr, ifName, ifAlias
const PORT_NAME = [/^1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.1\.\d+$/, /^1\.3\.6\.1\.2\.1\.2\.2\.1\.2\.\d+$/, /^1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.18\.\d+$/];

function vbText(vb) {
  const v = vb.value;
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) {
    if (vb.type === snmp.ObjectType.Counter64) return String(BigInt(`0x${v.toString('hex') || '0'}`));
    const printable = v.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc0 || (b >= 0x80 && b < 0xc0));
    return printable ? clip(v.toString('utf8'), 200) : v.toString('hex').slice(0, 64);
  }
  return clip(v, 200);
}

/** A notification of net-snmp → { oid, severity, text } */
export function describeTrap(pdu) {
  const vbs = (pdu.varbinds || []).filter((vb) => vb && typeof vb.oid === 'string');
  let oid;
  if (pdu.type === snmp.PduType.Trap) {
    const g = Number(pdu.generic);
    oid = g >= 0 && g < 6 ? `1.3.6.1.6.3.1.1.5.${g + 1}` : `${String(pdu.enterprise || '').replace(/^\./, '')}.0.${Number(pdu.specific) || 0}`;
  } else {
    oid = vbText(vbs.find((vb) => vb.oid === TRAP_OID) || {}) || 'unknown';
  }
  const known = KNOWN_TRAPS[oid];
  const rest = vbs.filter((vb) => vb.oid !== TRAP_OID && vb.oid !== UPTIME_OID);
  let text;
  if (known && /^link(Up|Down)$/.test(known[0])) {
    const name = PORT_NAME.map((re) => rest.find((vb) => re.test(vb.oid))).find(Boolean);
    const idx = rest.find((vb) => /^1\.3\.6\.1\.2\.1\.2\.2\.1\.1\.\d+$/.test(vb.oid));
    text = `${known[2]}: ${name ? vbText(name) : idx ? `ifIndex ${vbText(idx)}` : '?'}`;
  } else {
    const values = rest.slice(0, 6).map((vb) => `${vb.oid}=${vbText(vb)}`).join(' · ');
    text = known ? `${known[2]}${values ? ` (${values})` : ''}` : `trap ${oid}${values ? `: ${values}` : ''}`;
  }
  return { oid, severity: known ? known[1] : 5, name: known ? known[0] : '', text: clip(text, 1000) };
}

// ---------------------------------------------------------------------------------------------- the service
const MAX_CONNECTIONS = 200;
const MAX_PER_SENDER = 10;
const IDLE_MS = 60 * 60 * 1000;   // a device keeps its connection open; one silent for an hour is closed

export function createEvents({ db, settings, tls: tlsSource = null, onEvent = () => {} }) {
  const status = { traps: { on: false, port: config.trapPort, error: '' }, syslog: { on: false, port: config.syslogPort, error: '' },
    syslogTcp: { on: false, port: config.syslogTcpPort, error: '', connections: 0 }, syslogTls: { on: false, port: config.syslogTlsPort, error: '', connections: 0 } };
  let trapRx = null; let sysSock = null; let tcpServer = null; let tlsServer = null;
  const conns = new Set();
  let skipped = 0;
  // Windows events by number: only these are taken (empty = all) / these never - against the flood of a busy network
  // (group policy every 90 minutes, logons …). Other messages (switches, NAS, traps) are not touched.
  let idFilter = null; let filtered = 0;
  const ranges = (k) => parseEventIds(String(settings.get(k) || '')) || [];
  const inRanges = (list, id) => list.some(([a, b]) => id >= a && id <= b);
  // Severity: per sender (Messages → by sender → Filter), else for all (Receiving settings). -1 = muted.
  let sevFilter = null; let sevAt = 0;
  const droppedBy = new Map(); // address → messages not kept since the start (the page shows it at the sender)
  function sevWanted(ip, severity) {
    if (!sevFilter || Date.now() - sevAt > 60000) {
      sevFilter = new Map(db.prepare('SELECT source_ip, min_severity FROM event_source_filters').all().map((r) => [r.source_ip, r.min_severity]));
      sevAt = Date.now();
    }
    const own = sevFilter.get(ip);
    const min = own ?? Math.max(0, Math.min(7, Number(settings.get('events.minSeverity') ?? 7)));
    return severity <= min;
  }
  function idWanted(id) {
    if (!Number.isInteger(id)) return true;
    if (!idFilter) idFilter = { allow: ranges('events.winAllow'), deny: ranges('events.winDeny') };
    if (idFilter.allow.length && !inRanges(idFilter.allow, id)) return false;
    return !inRanges(idFilter.deny, id);
  }
  let stats = null; let statsAt = 0; let receivedSince = 0; // the space figures for the page (see storage)
  // one row per sender: the newest message, the computer name it gave (a name only fills in, never empties it)
  const senderUp = db.prepare(`INSERT INTO event_senders(source_ip, device_id, host, first_at, last_at, last_id) VALUES(?,?,?,?,?,?)
    ON CONFLICT(source_ip) DO UPDATE SET device_id=excluded.device_id, host=CASE WHEN excluded.host <> '' THEN excluded.host ELSE event_senders.host END,
    last_at=excluded.last_at, last_id=excluded.last_id`);
  const insert = db.prepare('INSERT INTO events_in(at, kind, source_ip, device_id, severity, facility, host, app, oid, text, event_id, channel, account) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let index = null; let indexAt = 0;
  // ip → inventory device (refreshed every minute; a new device is matched soon after the scan took it)
  const deviceOf = (ip) => {
    if (!index || Date.now() - indexAt > 60000) {
      index = new Map(db.prepare("SELECT id, ip FROM devices WHERE ip IS NOT NULL AND ip<>''").all().map((d) => [d.ip, d.id]));
      indexAt = Date.now();
    }
    return index.get(ip) ?? null;
  };
  const counts = new Map(); let second = 0; let inSecond = 0; let dropped = 0;
  const allowed = (ip) => {
    const s = Math.floor(Date.now() / 1000);
    if (s !== second) {
      if (dropped) log.warn(`Messages: ${dropped} dropped in one second (flood protection)`);
      second = s; inSecond = 0; dropped = 0; counts.clear();
    }
    const n = (counts.get(ip) || 0) + 1;
    counts.set(ip, n);
    if (n > PER_SENDER || ++inSecond > PER_SECOND) { dropped++; return false; }
    return true;
  };

  /** Stores one message (also used by the tests) → the stored row or null (dropped) */
  function receive(kind, ip, ev, at = new Date()) {
    const addr = String(ip || '').replace(/^::ffff:/, '');
    if (!allowed(addr)) return null;
    const device = deviceOf(addr);
    if (settings.get('events.onlyKnown') && !device) return null;
    if (!idWanted(ev.eventId)) { filtered++; return null; }
    const sev = Math.max(0, Math.min(7, Number(ev.severity) || 0));
    if (!sevWanted(addr, sev)) { filtered++; droppedBy.set(addr, (droppedBy.get(addr) || 0) + 1); return null; }
    const row = { at: at.toISOString(), kind, source_ip: addr, device_id: device, severity: Math.max(0, Math.min(7, Number(ev.severity) || 0)), facility: ev.facility ?? null,
      host: clip(ev.host, 120), app: clip(ev.app, 60), oid: clip(ev.oid, 200), text: clip(ev.text, TEXT_MAX) || '(empty)',
      event_id: Number.isInteger(ev.eventId) ? ev.eventId : null, channel: clip(ev.channel, 120), account: clip(ev.account, 120) };
    row.id = insert.run(row.at, row.kind, row.source_ip, row.device_id, row.severity, row.facility, row.host, row.app, row.oid, row.text, row.event_id, row.channel, row.account).lastInsertRowid;
    senderUp.run(row.source_ip, row.device_id, row.host, row.at, row.at, row.id);
    receivedSince++;
    try { onEvent(row); } catch (e) { log.warn(`Messages: ${e.message}`); }
    return row;
  }

  function communities() {
    const own = String(settings.get('events.communities') || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
    if (own.length) return own;
    const scan = String(settings.get('scan.snmpCommunities') || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
    return scan.length ? scan : ['public'];
  }

  function startTraps() {
    status.traps.error = '';
    try {
      trapRx = snmp.createReceiver({ port: config.trapPort, address: config.bind || null, transport: 'udp4', includeAuthentication: true }, (err, n) => {
        if (err) {
          // a port that cannot be opened, or a trap with an unknown community (ignored)
          if (/EACCES|EADDRINUSE|EADDRNOTAVAIL/.test(`${err.code} ${err.message}`)) {
            status.traps.on = false;
            status.traps.error = err.code === 'EADDRINUSE' ? `port ${config.trapPort} is in use` : err.code === 'EACCES' ? `port ${config.trapPort} not allowed without root - use 1162 and a redirect` : err.message;
            log.warn(`SNMP traps: ${status.traps.error}`);
          } else log.debug(`SNMP trap refused: ${err.message}`);
          return;
        }
        const d = describeTrap(n.pdu);
        receive('trap', n.rinfo?.address, { severity: d.severity, oid: d.oid, app: d.name, text: d.text });
      });
      for (const c of communities()) trapRx.getAuthorizer().addCommunity(c);
      status.traps.on = true;
      log.info(`SNMP traps: listening on UDP ${config.trapPort}`);
    } catch (e) { status.traps.error = e.message; log.warn(`SNMP traps: ${e.message}`); }
  }
  function startSyslog() {
    status.syslog.error = '';
    sysSock = dgram.createSocket('udp4');
    sysSock.on('error', (e) => {
      status.syslog.on = false;
      status.syslog.error = e.code === 'EADDRINUSE' ? `port ${config.syslogPort} is in use` : e.code === 'EACCES' ? `port ${config.syslogPort} not allowed without root - use 1514 and a redirect` : e.message;
      log.warn(`Syslog: ${status.syslog.error}`);
      try { sysSock.close(); } catch { /* closed */ }
      sysSock = null;
    });
    sysSock.on('message', (buf, rinfo) => {
      const ev = parseSyslog(buf);
      receive('syslog', rinfo.address, ev);
    });
    sysSock.bind(config.syslogPort, config.bind || undefined, () => { status.syslog.on = true; log.info(`Syslog: listening on UDP ${config.syslogPort}`); });
  }
  /** One TCP or TLS listener for syslog: framing, limits per sender and in all, idle timeout */
  function streamServer(kind, server) {
    const st = status[kind];
    server.maxConnections = MAX_CONNECTIONS;
    server.on('error', (e) => {
      st.on = false;
      st.error = e.code === 'EADDRINUSE' ? `port ${st.port} is in use` : e.code === 'EACCES' ? `port ${st.port} not allowed without root` : e.message;
      log.warn(`Syslog ${kind === 'syslogTls' ? 'TLS' : 'TCP'}: ${st.error}`);
    });
    // TLS: a failed handshake (wrong version, client gave up) is not an error of the server
    server.on('tlsClientError', (e, s) => { log.debug(`Syslog TLS: handshake ${e.code || e.message}`); s?.destroy(); });
    const accept = (sock) => {
      const ip = String(sock.remoteAddress || '').replace(/^::ffff:/, '');
      const same = [...conns].filter((c) => c.ip === ip).length;
      if (same >= MAX_PER_SENDER) { sock.destroy(); return; }
      const c = { ip, sock, kind };
      conns.add(c); st.connections++;
      sock.setTimeout(IDLE_MS, () => sock.destroy());
      const feed = syslogFramer((frame) => receive('syslog', ip, parseSyslog(frame)), () => { skipped++; log.debug(`Syslog: a message from ${ip} longer than ${MAX_FRAME} bytes was skipped`); });
      sock.on('data', (d) => { if (!feed(d)) sock.destroy(); });
      sock.on('error', () => {});
      sock.on('close', () => { conns.delete(c); st.connections--; });
    };
    server.on(kind === 'syslogTls' ? 'secureConnection' : 'connection', accept);
    server.listen(st.port, config.bind || undefined, () => { st.on = true; log.info(`Syslog ${kind === 'syslogTls' ? 'TLS' : 'TCP'}: listening on ${st.port}`); });
    return server;
  }
  function tlsOptions() {
    const cur = tlsSource?.current?.();
    if (!cur?.cert || !cur?.key) return null;
    return { cert: cur.cert, key: cur.key, minVersion: 'TLSv1.2' };
  }
  function startStreams() {
    status.syslogTcp.error = ''; status.syslogTls.error = '';
    if (settings.get('events.syslogTcp')) tcpServer = streamServer('syslogTcp', net.createServer());
    if (settings.get('events.syslogTls')) {
      const o = tlsOptions();
      if (!o) { status.syslogTls.error = 'no certificate of this server yet'; log.warn('Syslog TLS: no certificate'); }
      else tlsServer = streamServer('syslogTls', tls.createServer(o));
    }
  }
  /** The certificate of the server changed (renewed, uploaded): new connections get the new one */
  function reloadTls() {
    const o = tlsOptions();
    if (tlsServer && o) { try { tlsServer.setSecureContext(o); } catch (e) { log.warn(`Syslog TLS: ${e.message}`); } }
  }

  function stopAll() {
    if (trapRx) { try { trapRx.close(); } catch { /* closed */ } trapRx = null; }
    if (sysSock) { try { sysSock.close(); } catch { /* closed */ } sysSock = null; }
    for (const srv of [tcpServer, tlsServer]) if (srv) { try { srv.close(); } catch { /* closed */ } }
    for (const c of conns) c.sock.destroy();
    tcpServer = null; tlsServer = null;
    status.traps.on = false; status.syslog.on = false; status.syslogTcp.on = false; status.syslogTls.on = false;
  }
  /** (Re)opens the receivers as the settings say */
  function apply() {
    idFilter = null; sevFilter = null;
    stopAll();
    if (settings.get('events.traps')) startTraps();
    if (settings.get('events.syslog')) startSyslog();
    startStreams();
  }

  // A time as the database keeps it (ISO in UTC), or null; anything that is not a date is refused by the route first
  const iso = (v) => { if (v === null || v === undefined || v === '') return null; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };

  // The same filters for the list and for the timeline above it
  function filterSql({ q = '', kind = '', maxSeverity = 7, device = null, source = '', from = null, to = null } = {}) {
    const where = ['severity <= ?']; const args = [Math.max(0, Math.min(7, Number(maxSeverity)))];
    if (kind === 'trap' || kind === 'syslog') { where.push('kind = ?'); args.push(kind); }
    if (device) { where.push('e.device_id = ?'); args.push(Number(device)); }
    if (source) { where.push('e.source_ip = ?'); args.push(String(source).slice(0, 64)); }
    // from is inclusive, to is not: two ranges side by side never count a message twice
    if (iso(from)) { where.push('e.at >= ?'); args.push(iso(from)); }
    if (iso(to)) { where.push('e.at < ?'); args.push(iso(to)); }
    if (q) {
      // a number also finds the Windows event with that id
      const n = /^\d{1,6}$/.test(String(q).trim()) ? Number(String(q).trim()) : -1;
      where.push("(text LIKE ? ESCAPE '\\' OR app LIKE ? ESCAPE '\\' OR source_ip LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR e.host LIKE ? ESCAPE '\\' OR e.channel LIKE ? ESCAPE '\\' OR e.account LIKE ? ESCAPE '\\' OR e.event_id = ?)");
      const like = `%${String(q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`; args.push(like, like, like, like, like, like, like, n);
    }
    return { where: where.join(' AND '), args };
  }

  function list({ limit = 200, before = null, ...filter } = {}) {
    const { where, args } = filterSql(filter);
    const w = before ? `${where} AND e.id < ?` : where;
    if (before) args.push(Number(before));
    return db.prepare(`SELECT e.*, d.name device_name FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE ${w} ORDER BY e.id DESC LIMIT ?`)
      .all(...args, Math.max(1, Math.min(1000, Number(limit) || 200)));
  }

  /**
   * The timeline above the list (as in Splunk or Wazuh): how many messages with the same filters came in per step of
   * time, split into errors (0-3), warnings (4) and the rest. The step follows the span (a minute for the last hour, a
   * day for a month), at most about 60 bars. Without a start the span begins with the oldest message that matches.
   */
  const STEPS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400];
  function histogram(filter = {}) {
    const end = iso(filter.to) ? new Date(iso(filter.to)).getTime() : Date.now();
    let start = iso(filter.from) ? new Date(iso(filter.from)).getTime() : null;
    if (start === null) {
      const { where, args } = filterSql({ ...filter, from: null });
      const first = db.prepare(`SELECT MIN(e.at) a FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE ${where}`).get(...args)?.a;
      start = first ? new Date(first).getTime() : end - 3600000;
    }
    if (!(end > start)) return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), step: 60, total: 0, buckets: [] };
    const span = (end - start) / 1000;
    const step = STEPS.find((s) => span / s <= 60) || Math.ceil(span / 60 / 86400) * 86400;
    // bars start on a round time (local midnight does not matter here: the browser labels them in its own time)
    const t0 = Math.floor(start / 1000 / step) * step;
    const n = Math.ceil((end / 1000 - t0) / step);
    const { where, args } = filterSql({ ...filter, from: new Date(start).toISOString(), to: new Date(end).toISOString() });
    const rows = db.prepare(`SELECT CAST((CAST(strftime('%s', e.at) AS INTEGER) - ?) / ? AS INTEGER) b, SUM(e.severity <= 3) err, SUM(e.severity = 4) warn, COUNT(*) n
      FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE ${where} GROUP BY b`).all(t0, step, ...args);
    const buckets = Array.from({ length: n }, (_, i) => ({ at: new Date((t0 + i * step) * 1000).toISOString(), err: 0, warn: 0, other: 0 }));
    let total = 0;
    for (const r of rows) {
      const b = buckets[r.b]; if (!b) continue;
      b.err = r.err; b.warn = r.warn; b.other = r.n - r.err - r.warn; total += r.n;
    }
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), step, total, buckets };
  }

  /**
   * The overview by sender: one row per address with its device or computer name, the newest message and what came in
   * the last 24 hours (how many, how many warnings and errors). The newest first; q filters names and addresses.
   */
  let sendersCache = null; let sendersAt = 0;
  function senders({ q = '', fresh = false } = {}) {
    // counted again at most every 5 seconds while messages come in (the 24 hours are not free on a busy network)
    if (fresh || !sendersCache || Date.now() - sendersAt > (receivedSince ? 5000 : STATS_MS)) {
      const since = new Date(Date.now() - 86400000).toISOString();
      const day = new Map(db.prepare('SELECT source_ip, COUNT(*) n, SUM(severity <= 4) warn, SUM(severity <= 3) err FROM events_in WHERE at >= ? GROUP BY source_ip').all(since).map((r) => [r.source_ip, r]));
      sendersCache = db.prepare(`SELECT s.source_ip, s.device_id, s.host, s.first_at, s.last_at, d.name device_name, d.type device_type,
          e.severity last_severity, e.app last_app, e.event_id last_event_id, e.text last_text
        FROM event_senders s LEFT JOIN devices d ON d.id = s.device_id LEFT JOIN events_in e ON e.id = s.last_id ORDER BY s.last_at DESC`).all()
        .map((r) => { const x = day.get(r.source_ip) || {}; return { ...r, day: x.n || 0, warn: x.warn || 0, err: x.err || 0 }; });
      // a muted sender has nothing stored - it stays in the list all the same, or it could never be unmuted
      const have = new Set(sendersCache.map((r) => r.source_ip));
      for (const f of db.prepare('SELECT f.source_ip, d.id device_id, d.name device_name FROM event_source_filters f LEFT JOIN devices d ON d.ip = f.source_ip').all()) {
        if (!have.has(f.source_ip)) sendersCache.push({ source_ip: f.source_ip, device_id: f.device_id, host: '', first_at: null, last_at: null, device_name: f.device_name, day: 0, warn: 0, err: 0 });
      }
      sendersAt = Date.now();
    }
    const filters = new Map(db.prepare('SELECT source_ip, min_severity FROM event_source_filters').all().map((r) => [r.source_ip, r.min_severity]));
    sendersCache = sendersCache.map((r) => ({ ...r, filter: filters.has(r.source_ip) ? filters.get(r.source_ip) : null, dropped: droppedBy.get(r.source_ip) || 0 }));
    const n = String(q || '').trim().toLowerCase().slice(0, 100);
    return n ? sendersCache.filter((r) => [r.source_ip, r.host, r.device_name].some((v) => String(v || '').toLowerCase().includes(n))) : sendersCache;
  }

  // ------------------------------------------------------------------------------------------- space and age
  const evFile = () => db.pragma('database_list').find((d) => d.name === 'ev')?.file || '';
  /** Bytes the messages take in their file (without the free pages SQLite keeps for reuse) */
  const usedBytes = () => (db.pragma('ev.page_count', { simple: true }) - db.pragma('ev.freelist_count', { simple: true })) * db.pragma('ev.page_size', { simple: true });
  /** The limit: as set (GB) - lower when the disk gets short (at least 10 % of it, and 1 GB, stay free) */
  function limits(used = usedBytes()) {
    const want = Math.round(Math.max(0.001, Math.min(1000, Number(settings.get('events.maxGb')) || MAX_GB_DEFAULT)) * GB);
    let cap = want; let diskFree = null;
    const file = evFile();
    if (file) {
      try {
        const st = fs.statfsSync(path.dirname(file));
        diskFree = st.bavail * st.bsize;
        const reserve = Math.max(GB, st.blocks * st.bsize * 0.1);
        cap = Math.min(want, Math.max(50 * 1024 * 1024, used + diskFree - reserve));
      } catch { /* not known - the setting alone */ }
    }
    return { want, cap, diskShort: cap < want, diskFree };
  }

  /** Old messages out: older than the days set, then the oldest until the file fits its limit. Returns rows deleted. */
  function prune() {
    let deleted = 0;
    const days = Math.max(1, Math.min(365, Number(settings.get('events.keepDays')) || 30));
    deleted += db.prepare('DELETE FROM events_in WHERE at < ?').run(new Date(Date.now() - days * 86400000).toISOString()).changes;
    for (let round = 0; round < 20; round++) {
      const used = usedBytes();
      const { cap } = limits(used);
      if (used <= cap) break;
      const n = db.prepare('SELECT COUNT(*) n FROM events_in').get().n;
      if (!n) break;
      // down to 95 % of the limit, so that it does not run for every new message; at most 20 000 at a time
      const rows = Math.min(20000, Math.max(100, Math.ceil(((used - cap * 0.95) / used) * n)));
      deleted += db.prepare('DELETE FROM events_in WHERE id IN (SELECT id FROM events_in ORDER BY id LIMIT ?)').run(rows).changes;
    }
    if (deleted) {
      // a sender whose messages are all gone leaves the overview too
      db.prepare('DELETE FROM event_senders WHERE last_id < COALESCE((SELECT MIN(id) FROM events_in), 9e18)').run();
      try { db.pragma('ev.incremental_vacuum'); } catch { /* an older file without auto-vacuum keeps its pages for reuse */ }
      stats = null;
      log.info(`Messages: ${deleted} old message(s) removed`);
    }
    return deleted;
  }

  // How the space goes: for the page (cached a minute - counting a few million rows is not free; once new messages
  // came in, after 15 seconds - the page must not say "0 stored" next to a list of them)
  function storage() {
    // the very first messages show at once
    const maxAge = receivedSince ? (stats?.total === 0 ? 0 : STATS_FRESH_MS) : STATS_MS;
    if (stats && Date.now() - statsAt < maxAge) return stats;
    receivedSince = 0;
    const used = usedBytes();
    const lim = limits(used);
    const total = db.prepare('SELECT COUNT(*) n FROM events_in').get().n;
    const since = new Date(Date.now() - 86400000).toISOString();
    const day = db.prepare('SELECT COUNT(*) n FROM events_in WHERE at >= ?').get(since).n;
    const oldest = db.prepare('SELECT at FROM events_in ORDER BY id LIMIT 1').get()?.at || null;
    const perRow = total ? used / total : 900;
    const perDay = day * perRow;
    const keepDays = Math.max(1, Math.min(365, Number(settings.get('events.keepDays')) || 30));
    const daysFit = perDay > 0 ? Math.floor(lim.cap / perDay) : null;
    // who fills it: the biggest senders and Windows events of the last day (with their share)
    const top = (sql) => (day ? db.prepare(sql).all(since).map((r) => ({ name: String(r.name ?? ''), share: Math.round((r.n / day) * 100) })).filter((r) => r.share >= 10) : []);
    stats = { used, limit: lim.want, cap: lim.cap, diskShort: lim.diskShort, total, perDay: day, oldest, keepDays, daysFit, short: daysFit !== null && daysFit < keepDays,
      topSenders: top("SELECT COALESCE(NULLIF(host,''), source_ip) name, COUNT(*) n FROM events_in WHERE at >= ? GROUP BY name ORDER BY n DESC LIMIT 3"),
      topEvents: top('SELECT event_id name, COUNT(*) n FROM events_in WHERE at >= ? AND event_id IS NOT NULL GROUP BY event_id ORDER BY n DESC LIMIT 3') };
    statsAt = Date.now();
    return stats;
  }
  let pruneTimer = null;

  return {
    receive, list, histogram, senders, prune, apply, communities,
    /** What is kept of one sender: min severity 0-7, -1 muted, null = as for all */
    setSenderFilter(ip, min, by = '') {
      const a = String(ip || '').trim().slice(0, 64);
      if (!a) return;
      if (min === null || min === undefined || min === '') db.prepare('DELETE FROM event_source_filters WHERE source_ip=?').run(a);
      else db.prepare('INSERT INTO event_source_filters(source_ip, min_severity, updated_at, updated_by) VALUES(?,?,?,?) ON CONFLICT(source_ip) DO UPDATE SET min_severity=excluded.min_severity, updated_at=excluded.updated_at, updated_by=excluded.updated_by')
        .run(a, Math.max(-1, Math.min(7, Number(min))), new Date().toISOString(), String(by).slice(0, 120));
      sevFilter = null; sendersCache = null;
    },
    reloadTls,
    status: () => ({ traps: { ...status.traps }, syslog: { ...status.syslog }, syslogTcp: { ...status.syslogTcp }, syslogTls: { ...status.syslogTls }, skipped, filtered, total: storage().total,
      last: db.prepare('SELECT at FROM events_in ORDER BY id DESC LIMIT 1').get()?.at || null, storage: storage() }),
    storage,
    /** Receivers as set, and the cleanup every 10 minutes (the limit holds between the daily rounds too) */
    start() {
      apply();
      if (!pruneTimer) { pruneTimer = setInterval(() => { try { prune(); } catch (e) { log.warn(`Messages cleanup failed: ${e.message}`); } }, PRUNE_MS); pruneTimer.unref(); }
    },
    stop() { clearInterval(pruneTimer); pruneTimer = null; stopAll(); },
  };
}

/** Does a message match the filter of an event monitor? options: { source, maxSeverity, match }, deviceId */
export function eventMatches(row, o, deviceId) {
  if (o.source && o.source !== 'any' && row.kind !== o.source) return false;
  if (deviceId && row.device_id !== deviceId) return false;
  if (row.severity > (Number.isInteger(o.maxSeverity) ? o.maxSeverity : 4)) return false;
  if (o.match && !`${row.app} ${row.text}`.toLowerCase().includes(String(o.match).toLowerCase())) return false;
  return true;
}

/** The check of an event monitor: down while a matching message is younger than `holdMin` minutes */
export function eventCheck(db, m) {
  let o = {};
  try { o = JSON.parse(m.options || '{}'); } catch { o = {}; }
  const hold = Math.max(1, Math.min(1440, Number(o.holdMin) || 15));
  const since = new Date(Date.now() - hold * 60000).toISOString();
  const where = ['at >= ?', 'severity <= ?']; const args = [since, Number.isInteger(o.maxSeverity) ? o.maxSeverity : 4];
  if (o.source === 'trap' || o.source === 'syslog') { where.push('kind = ?'); args.push(o.source); }
  if (m.device_id) { where.push('device_id = ?'); args.push(m.device_id); }
  if (o.match) { where.push("lower(app || ' ' || text) LIKE ? ESCAPE '\\'"); args.push(`%${String(o.match).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  const rows = db.prepare(`SELECT * FROM events_in WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 50`).all(...args);
  if (!rows.length) return { ok: true, ms: null, message: `no matching message in the last ${hold} min` };
  const r = rows[0];
  const more = rows.length > 1 ? ` (+${rows.length - 1} more)` : '';
  return { ok: false, ms: null, message: `${r.kind === 'trap' ? 'trap' : 'syslog'} ${SEVERITIES[r.severity]} from ${r.source_ip}: ${r.app ? `${r.app}: ` : ''}${r.text}`.slice(0, 480) + more,
    data: { eventId: r.id, count: rows.length } };
}
