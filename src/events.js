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
// A flood (a device in a loop, or someone sending on purpose) is cut: at most 100 messages per second per sender over
// UDP (and traps) and 3000 in all (WOMN_MESSAGES_PER_SECOND) - what goes beyond is dropped. Over TCP and TLS nothing is dropped: up to 500 a second
// per sender are taken, the rest is held back - the connection pauses until the next second, the agent (NXLog, Fluent
// Bit) keeps the messages meanwhile. Messages are written in batches (all that came in during one turn of the event
// loop, in one transaction): a busy network costs a fraction of writing each message on its own. Text is cut to 4000 characters (a German failed sign-in 4625 is some 2000 - the reason is in its middle). UDP has no sender check - traps at least need a known community.
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import snmp from 'net-snmp';
import { log } from './lib/log.js';
import { config } from './config.js';
import { parseEventIds, parseDenyList, denies } from './eventrules.js';

export const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const GB = 1024 ** 3;
export const MAX_GB_DEFAULT = 2;
const PRUNE_MS = 10 * 60 * 1000;
// messages removed at a time (each also leaves the search index and the counts)
const PRUNE_PIECE = 10000;
// later than any message (for an open end)
const FAR = '9999-12-31T23:59:59.999Z';
const STATS_MS = 60 * 1000;
const STATS_FRESH_MS = 15 * 1000;
// (in all: WOMN_MESSAGES_PER_SECOND, default 3000)
export const FLOOD = { perSender: 100, perSenderStream: 500, perSecond: config.messagesPerSecond, connectionsPerSender: 10 };
// written at once at most (more waiting: written right away, not at the end of the turn)
const BATCH_MAX = 2000;
export const TEXT_MAX = 4000;
const clip = (s, n) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------------------------------------- syslog
// Windows events (NXLog, im_msvistalog; Fluent Bit, winevtlog): the event id, log (channel), source and account are
// kept in fields of their own, so a rule can ask for "Defender, event 1116" instead of searching text. Understood:
//   JSON   - NXLog "Exec $Message = to_json(); to_syslog_ietf();" (or to_json() alone), Fluent Bit "Format json_lines":
//            all fields of the event
//   a line - NXLog without Exec: "2026-11-15 10:00:00 PC-01 WARNING 1116 Microsoft Defender Antivirus has detected …"
//   readable - the config of the manual: to_syslog_bsd() with the message "[1116] [Microsoft-Windows-Windows Defender/
//            Operational] Microsoft Defender Antivirus has detected …" (the source is the syslog tag)
const WIN_SEVERITY = { CRITICAL: 2, ERROR: 3, WARNING: 4, AUDIT_FAILURE: 4, INFO: 6, AUDIT_SUCCESS: 6, DEBUG: 7 };
// the level of an event as a number (Fluent Bit): 1 critical, 2 error, 3 warning, 4 information, 5 verbose (0 = always)
const WIN_LEVEL = { 0: 6, 1: 2, 2: 3, 3: 4, 4: 6, 5: 7 };
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
    // Fluent Bit (winevtlog) sends the level as a number and the audit result only in the keywords (bit 52 = failure)
    let failed = type === 'AUDIT_FAILURE';
    if (!failed && /^0x[0-9a-f]{1,16}$/i.test(String(j.Keywords || ''))) failed = (BigInt(j.Keywords) & 0x10000000000000n) !== 0n;
    const level = Number.isInteger(j.Level) ? WIN_LEVEL[j.Level] : undefined;
    const sev = failed ? 4 : WIN_SEVERITY[String(j.Severity || '').toUpperCase()] ?? WIN_SEVERITY[type] ?? level;
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
  // (NXLog adds the process id: "Microsoft-Windows-Windows Defender[3120]: [1116] [...]")
  const tag = !out.app && /^([^:[\]\r\n]{1,80})(\[\d+\])?: (?=\[\d{1,6}\] \[)/.exec(rest);
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
  // RFC 3164 allows 32 characters for the tag; Windows sources are longer
  // ("Microsoft-Windows-TerminalServices-LocalSessionManager" has 54)
  const tag = /^([^\s:[\]]{1,80})(\[\d+\])?: ?/.exec(rest);
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
const IDLE_MS = 60 * 60 * 1000;   // a device keeps its connection open; one silent for an hour is closed

export function createEvents({ db, settings, tls: tlsSource = null, onEvent = () => {}, limits: floodOwn = {}, ports = {}, bind = config.bind }) {
  // limits and ports of their own: only for the tests and the load test (womn-admin loadtest)
  const flood = { ...FLOOD, ...floodOwn };
  const port = { traps: ports.traps ?? config.trapPort, syslog: ports.syslog ?? config.syslogPort, syslogTcp: ports.syslogTcp ?? config.syslogTcpPort, syslogTls: ports.syslogTls ?? config.syslogTlsPort };
  const status = { traps: { on: false, port: port.traps, error: '' }, syslog: { on: false, port: port.syslog, error: '' },
    syslogTcp: { on: false, port: port.syslogTcp, error: '', connections: 0 }, syslogTls: { on: false, port: port.syslogTls, error: '', connections: 0 } };
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
  function idWanted(id, app) {
    if (!Number.isInteger(id)) return true;
    if (!idFilter) idFilter = { allow: ranges('events.winAllow'), deny: parseDenyList(String(settings.get('events.winDeny') || '')) || { ranges: [], pairs: [] } };
    if (idFilter.allow.length && !inRanges(idFilter.allow, id)) return false;
    return !denies(idFilter.deny, id, app);
  }
  let stats = null; let statsAt = 0; let receivedSince = 0; // the space figures for the page (see storage)
  // one row per sender: the newest message, the computer name it gave (a name only fills in, never empties it)
  // and how it sends: the way of the newest message, when it last came over UDP
  const senderUp = db.prepare(`INSERT INTO event_senders(source_ip, device_id, host, first_at, last_at, last_id, transport, udp_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(source_ip) DO UPDATE SET device_id=excluded.device_id, host=CASE WHEN excluded.host <> '' THEN excluded.host ELSE event_senders.host END,
    last_at=excluded.last_at, last_id=excluded.last_id, transport=CASE WHEN excluded.transport <> '' THEN excluded.transport ELSE event_senders.transport END,
    udp_at=COALESCE(excluded.udp_at, event_senders.udp_at)`);
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
  // since the start: dropped by the flood protection (UDP, traps) / held back a moment (TCP, TLS - none lost)
  let flooded = 0; let heldBack = 0; let lastFloodLog = 0;
  /** May a message of this sender go in this second? stream: a TCP/TLS connection - it waits instead of being dropped */
  const allowed = (ip, stream = false) => {
    const s = Math.floor(Date.now() / 1000);
    if (s !== second) {
      // said at most once a minute (a flood would fill the log too)
      if (dropped && Date.now() - lastFloodLog > 60000) { log.warn(`Messages: ${dropped} dropped in one second (flood protection)`); lastFloodLog = Date.now(); }
      second = s; inSecond = 0; dropped = 0; counts.clear();
    }
    const n = counts.get(ip) || 0;
    if (n >= (stream ? flood.perSenderStream : flood.perSender) || inSecond >= flood.perSecond) {
      if (stream) heldBack++; else { dropped++; flooded++; }
      return false;
    }
    counts.set(ip, n + 1); inSecond++;
    return true;
  };

  /** The checks of one message → the row to write, or null (not taken). rated: the flood check was done already */
  function accept(kind, ip, ev, at, rated = false, transport = '') {
    const addr = String(ip || '').replace(/^::ffff:/, '');
    if (!rated && !allowed(addr)) return null;
    const device = deviceOf(addr);
    if (settings.get('events.onlyKnown') && !device) return null;
    if (!idWanted(ev.eventId, ev.app)) { filtered++; return null; }
    const sev = Math.max(0, Math.min(7, Number(ev.severity) || 0));
    if (!sevWanted(addr, sev)) { filtered++; droppedBy.set(addr, (droppedBy.get(addr) || 0) + 1); return null; }
    const row = { at: at.toISOString(), kind, source_ip: addr, device_id: device, severity: Math.max(0, Math.min(7, Number(ev.severity) || 0)), facility: ev.facility ?? null,
      host: clip(ev.host, 120), app: clip(ev.app, 60), oid: clip(ev.oid, 200), text: clip(ev.text, TEXT_MAX) || '(empty)',
      event_id: Number.isInteger(ev.eventId) ? ev.eventId : null, channel: clip(ev.channel, 120), account: clip(ev.account, 120),
      transport: ['udp', 'tcp', 'tls', 'trap'].includes(transport) ? transport : '' };
    return row;
  }
  /** Rows into the file in one transaction (one row per sender in the overview), then the rules and monitors */
  const writeRows = db.transaction((rows) => {
    const last = new Map();
    for (const r of rows) {
      r.id = insert.run(r.at, r.kind, r.source_ip, r.device_id, r.severity, r.facility, r.host, r.app, r.oid, r.text, r.event_id, r.channel, r.account).lastInsertRowid;
      const l = last.get(r.source_ip);
      // the first message of the batch for a new sender, the newest one for the rest; a name only fills in
      last.set(r.source_ip, { first: l?.first ?? r.at, row: r, host: r.host || l?.host || '', transport: r.transport || l?.transport || '',
        udpAt: r.transport === 'udp' ? r.at : l?.udpAt ?? null });
    }
    for (const [ip, l] of last) senderUp.run(ip, l.row.device_id, l.host, l.first, l.row.at, l.row.id, l.transport, l.udpAt);
  });
  function write(rows) {
    writeRows(rows);
    receivedSince += rows.length;
    for (const r of rows) { try { onEvent(r); } catch (e) { log.warn(`Messages: ${e.message}`); } }
  }
  // Waiting to be written: what came in during this turn of the event loop
  let pending = []; let flushing = null; let writeFailedAt = 0;
  function flush() {
    if (flushing) { clearImmediate(flushing); flushing = null; }
    if (!pending.length) return;
    const rows = pending; pending = [];
    try { write(rows); } catch (e) {
      // the disk is full or the file is locked: these are lost - said once a minute, the receivers go on
      if (Date.now() - writeFailedAt > 60000) { log.warn(`Messages: ${rows.length} could not be stored: ${e.message}`); writeFailedAt = Date.now(); }
    }
  }
  /** A message of a receiver: checked now, written with the others of this turn */
  function queue(kind, ip, ev, rated = false, transport = '') {
    const row = accept(kind, ip, ev, new Date(), rated, transport);
    if (!row) return;
    pending.push(row);
    if (pending.length >= BATCH_MAX) flush();
    else if (!flushing) flushing = setImmediate(flush);
  }

  /** Stores one message right away (also used by the tests) → the stored row or null (dropped) */
  function receive(kind, ip, ev, at = new Date(), transport = '') {
    flush();
    const row = accept(kind, ip, ev, at, false, transport);
    if (!row) return null;
    write([row]);
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
      trapRx = snmp.createReceiver({ port: port.traps, address: bind || null, transport: 'udp4', includeAuthentication: true }, (err, n) => {
        if (err) {
          // a port that cannot be opened, or a trap with an unknown community (ignored)
          if (/EACCES|EADDRINUSE|EADDRNOTAVAIL/.test(`${err.code} ${err.message}`)) {
            status.traps.on = false;
            status.traps.error = err.code === 'EADDRINUSE' ? `port ${port.traps} is in use` : err.code === 'EACCES' ? `port ${port.traps} not allowed without root - use 1162 and a redirect` : err.message;
            log.warn(`SNMP traps: ${status.traps.error}`);
          } else log.debug(`SNMP trap refused: ${err.message}`);
          return;
        }
        const d = describeTrap(n.pdu);
        queue('trap', n.rinfo?.address, { severity: d.severity, oid: d.oid, app: d.name, text: d.text }, false, 'trap');
      });
      for (const c of communities()) trapRx.getAuthorizer().addCommunity(c);
      status.traps.on = true;
      log.info(`SNMP traps: listening on UDP ${port.traps}`);
    } catch (e) { status.traps.error = e.message; log.warn(`SNMP traps: ${e.message}`); }
  }
  function startSyslog() {
    status.syslog.error = '';
    sysSock = dgram.createSocket('udp4');
    sysSock.on('error', (e) => {
      status.syslog.on = false;
      status.syslog.error = e.code === 'EADDRINUSE' ? `port ${port.syslog} is in use` : e.code === 'EACCES' ? `port ${port.syslog} not allowed without root - use 1514 and a redirect` : e.message;
      log.warn(`Syslog: ${status.syslog.error}`);
      try { sysSock.close(); } catch { /* closed */ }
      sysSock = null;
    });
    sysSock.on('message', (buf, rinfo) => {
      // the flood check first: a flood is not even parsed
      if (!allowed(String(rinfo.address || '').replace(/^::ffff:/, ''))) return;
      queue('syslog', rinfo.address, parseSyslog(buf), true, 'udp');
    });
    sysSock.bind(port.syslog, bind || undefined, () => { status.syslog.on = true; status.syslog.port = sysSock.address().port; log.info(`Syslog: listening on UDP ${status.syslog.port}`); });
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
      if (same >= flood.connectionsPerSender) { sock.destroy(); return; }
      const c = { ip, sock, kind };
      conns.add(c); st.connections++;
      sock.setTimeout(IDLE_MS, () => sock.destroy());
      // Above the limit a message waits (in order) and the connection pauses until the next second: the agent keeps
      // the rest meanwhile - TCP loses nothing, it only comes a little later
      const held = []; let waiting = null;
      const take = (frame) => queue('syslog', ip, parseSyslog(frame), true, kind === 'syslogTls' ? 'tls' : 'tcp');
      const pass = (frame) => { if (held.length || !allowed(ip, true)) held.push(frame); else take(frame); };
      const wait = () => { if (!waiting && !sock.destroyed) { sock.pause(); waiting = setTimeout(drain, 1005 - (Date.now() % 1000)); } };
      const drain = () => {
        waiting = null;
        while (held.length && allowed(ip, true)) take(held.shift());
        if (held.length) wait(); else if (!sock.destroyed) sock.resume();
      };
      const feed = syslogFramer(pass, () => { skipped++; log.debug(`Syslog: a message from ${ip} longer than ${MAX_FRAME} bytes was skipped`); });
      sock.on('data', (d) => {
        if (!feed(d)) { sock.destroy(); return; }
        if (held.length) wait();
      });
      sock.on('error', () => {});
      sock.on('close', () => { clearTimeout(waiting); held.length = 0; conns.delete(c); st.connections--; });
    };
    server.on(kind === 'syslogTls' ? 'secureConnection' : 'connection', accept);
    server.listen(st.port, bind || undefined, () => { st.on = true; st.port = server.address().port; log.info(`Syslog ${kind === 'syslogTls' ? 'TLS' : 'TCP'}: listening on ${st.port}`); });
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
    flush();
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
  // ---------------------------------------------------------------------------------------- full-text index
  // Search over many gigabytes (see db.js, schema 4): the index knows words and beginnings of words. New messages are
  // written without waiting for it and go into it in batches, every few seconds; a file from before the update is
  // indexed bit by bit in the background (a few seconds per million messages), the search works all the time.
  const FTS_BATCH = 5000;
  const FTS_MS = 3000;
  const ftsDoneQ = db.prepare("SELECT v FROM events_fts_state WHERE k = 'done'").pluck();
  const ftsDone = () => ftsDoneQ.get() ?? 0;
  const ftsTop = db.prepare('SELECT MAX(id) FROM events_in').pluck();
  const ftsHas = db.prepare('SELECT 1 FROM events_fts WHERE events_fts MATCH ? LIMIT 1').pluck();
  const ftsAdd = db.prepare(`INSERT INTO events_fts(rowid, text, app, host, channel, account, source_ip)
    SELECT id, text, app, host, channel, account, source_ip FROM events_in WHERE id > ? AND id <= ? ORDER BY id`);
  const ftsSet = db.prepare("UPDATE events_fts_state SET v = ? WHERE k = 'done'");
  /** One batch into the index; how many ids are left above it */
  function indexBatch(max = FTS_BATCH) {
    const done = ftsDone(); const top = ftsTop.get() || 0;
    if (top <= done) return 0;
    const to = Math.min(top, done + max);
    db.transaction(() => { ftsAdd.run(done, to); ftsSet.run(to); })();
    return top - to;
  }
  // Counts per minute (sender, kind, severity) and per hour (Windows event id): see db.js, schema 5. Filled like the
  // index; whatever is above "counted" is counted from the messages themselves.
  const COUNT_BATCH = 20000;
  const countedQ = db.prepare("SELECT v FROM events_fts_state WHERE k = 'counted'").pluck();
  const counted = () => countedQ.get() ?? 0;
  const countAddMin = db.prepare(`INSERT INTO events_minute(minute, source_ip, kind, severity, n)
    SELECT CAST(strftime('%s', at) AS INTEGER) / 60, source_ip, kind, severity, COUNT(*) FROM events_in WHERE id > ? AND id <= ? GROUP BY 1, 2, 3, 4
    ON CONFLICT(minute, source_ip, kind, severity) DO UPDATE SET n = n + excluded.n`);
  const countAddHours = db.prepare(`INSERT INTO events_hour(hour, source_ip, kind, severity, n)
    SELECT CAST(strftime('%s', at) AS INTEGER) / 3600, source_ip, kind, severity, COUNT(*) FROM events_in WHERE id > ? AND id <= ? GROUP BY 1, 2, 3, 4
    ON CONFLICT(hour, source_ip, kind, severity) DO UPDATE SET n = n + excluded.n`);
  const countAddHour = db.prepare(`INSERT INTO events_hour_id(hour, event_id, n)
    SELECT CAST(strftime('%s', at) AS INTEGER) / 3600, event_id, COUNT(*) FROM events_in WHERE id > ? AND id <= ? AND event_id IS NOT NULL GROUP BY 1, 2
    ON CONFLICT(hour, event_id) DO UPDATE SET n = n + excluded.n`);
  const countAddDay = db.prepare(`INSERT OR IGNORE INTO events_day_src(event_id, app, day, source_ip)
    SELECT DISTINCT event_id, app, CAST(strftime('%s', at) AS INTEGER) / 86400, source_ip FROM events_in WHERE id > ? AND id <= ? AND event_id IS NOT NULL`);
  const countSet = db.prepare("UPDATE events_fts_state SET v = ? WHERE k = 'counted'");
  /** One batch into the counts; how many ids are left above them */
  function countBatch(max = COUNT_BATCH) {
    const done = counted(); const top = ftsTop.get() || 0;
    if (top <= done) return 0;
    const to = Math.min(top, done + max);
    db.transaction(() => { countAddMin.run(done, to); countAddHours.run(done, to); countAddHour.run(done, to); countAddDay.run(done, to); countSet.run(to); })();
    return top - to;
  }
  let ftsTimer = null; let ftsRunning = false; let ftsStart = null;
  /** Batches until the index has caught up - between them the receivers get their turn */
  function indexPump() {
    if (ftsRunning) return;
    ftsRunning = true;
    const step = () => {
      let left = 0; let counts = 0;
      try { left = indexBatch(); } catch (e) { log.warn(`Messages: search index: ${e.message}`); left = 0; }
      try { counts = countBatch(); } catch (e) { log.warn(`Messages: counts: ${e.message}`); }
      if (left > 0 || counts > 0) { if (left > 50000 && !ftsStart) { ftsStart = { at: Date.now(), done: ftsDone() }; log.info('Messages: building the search index in the background'); } setImmediate(step); return; }
      if (ftsStart) { log.info(`Messages: search index ready (${Math.round((Date.now() - ftsStart.at) / 1000)} s)`); ftsStart = null; }
      ftsRunning = false;
    };
    step();
  }
  /** How far the counts are: messages not in them yet (normally a few seconds' worth) */
  const countStatus = () => ({ behind: Math.max(0, (ftsTop.get() || 0) - counted()) });
  /** How far the index is: share of the messages in it (by id) */
  function indexStatus() {
    const done = ftsDone(); const top = ftsTop.get() || 0;
    const low = db.prepare('SELECT MIN(id) FROM events_in').pluck().get() || 0;
    const behind = Math.max(0, top - done);
    // a few seconds behind is normal (batches); "building" is the first round after an update
    return { building: behind > 50000, share: top > low ? Math.max(0, Math.min(1, (done - low + 1) / (top - low + 1))) : 1, behind };
  }
  /**
   * A search as typed: words separated by spaces must all be there, in any order and any field ("pc001 4104
   * svc-pocketknife"); "in quotes" is one phrase - these words one after the other; -word leaves out what has it.
   * Each term: { raw, not, match } - match is the term for the index ('"svc pocketknife"*': these words in this
   * order, the last one may go on), '' when it has no word in it.
   */
  function searchTerms(text) {
    const out = [];
    for (const m of String(text).matchAll(/(-?)"([^"]*)"?|(-?)(\S+)/g)) {
      const not = (m[1] || m[3]) === '-';
      const raw = (m[2] ?? m[4] ?? '').trim();
      if (!raw) continue;
      const words = raw.match(/[\p{L}\p{N}]+/gu);
      out.push({ raw: raw.slice(0, 100), not, match: words ? `"${words.slice(0, 16).join(' ')}"*` : '' });
      if (out.length >= 10) break;
    }
    return out;
  }

  // The first message at or after a time (ids grow with the time of arrival)
  const firstIdAt = db.prepare('SELECT id FROM events_in WHERE at >= ? ORDER BY at LIMIT 1').pluck();
  const NONE = Number.MAX_SAFE_INTEGER;
  const MANY = 20000;
  const ftsCount = db.prepare(`SELECT COUNT(*) FROM (SELECT 1 FROM events_fts WHERE events_fts MATCH ? AND rowid >= ? AND rowid < ? LIMIT ${MANY + 1})`).pluck();
  const eventCount = db.prepare(`SELECT COUNT(*) FROM (SELECT 1 FROM events_in WHERE event_id = ? AND id >= ? AND id < ? LIMIT ${MANY + 1})`).pluck();
  /**
   * The same filters for the list and for the timeline above it. A search goes by words (the index: whole words and
   * beginnings of words, in this order); part = true searches parts of words too - every message in the range is read.
   * With words the time range is turned into a range of ids for the index and checked exactly on what it finds, so
   * SQLite starts from the few messages with the words - not from the millions in the time range.
   */
  function filterSql({ q = '', kind = '', maxSeverity = 7, device = null, source = '', from = null, to = null, part = false } = {}) {
    const where = ['severity <= ?']; const args = [Math.max(0, Math.min(7, Number(maxSeverity)))];
    if (kind === 'trap' || kind === 'syslog') { where.push('kind = ?'); args.push(kind); }
    if (device) { where.push('e.device_id = ?'); args.push(Number(device)); }
    if (source) { where.push('e.source_ip = ?'); args.push(String(source).slice(0, 64)); }
    const terms = searchTerms(String(q || '').trim().slice(0, 200));
    // the index leads when at least one term is wanted (not only left out) and has a word in it
    const words = !part && terms.some((t) => !t.not && t.match);
    // from is inclusive, to is not: two ranges side by side never count a message twice ("+": no index for the time
    // when the words lead)
    const at = words ? '+e.at' : 'e.at';
    let lo = 0; let hi = NONE; let many = false;
    if (iso(from)) { where.push(`${at} >= ?`); args.push(iso(from)); if (words) lo = firstIdAt.get(iso(from)) ?? NONE; }
    if (iso(to)) { where.push(`${at} < ?`); args.push(iso(to)); if (words) hi = firstIdAt.get(iso(to)) ?? NONE; }
    const likeCols = "(e.text LIKE ? ESCAPE '\\' OR e.app LIKE ? ESCAPE '\\' OR e.source_ip LIKE ? ESCAPE '\\' OR e.host LIKE ? ESCAPE '\\' OR e.channel LIKE ? ESCAPE '\\' OR e.account LIKE ? ESCAPE '\\')";
    const devName = "e.device_id IN (SELECT id FROM devices WHERE name LIKE ? ESCAPE '\\')";
    const tail = Math.max(ftsDone(), lo - 1);
    let fewest = Infinity;
    for (const t of terms) {
      // a number also finds the Windows event with that id; a device by its name in the inventory
      const n = /^\d{1,6}$/.test(t.raw) ? Number(t.raw) : -1;
      const like = `%${t.raw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      let cond; let a;
      if (!part && t.match) {
        // the index up to "done"; what came in since its last round (a few seconds) the slow way
        cond = `(e.id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ? AND rowid >= ? AND rowid < ?) OR (e.id > ? AND ${likeCols}) OR ${devName} OR (e.event_id = ? AND e.id >= ? AND e.id < ?))`;
        a = [t.match, lo, hi, tail, like, like, like, like, like, like, like, n, lo, hi];
        if (!t.not) fewest = Math.min(fewest, (ftsCount.get(t.match, lo, hi) || 0) + (n >= 0 ? eventCount.get(n, lo, hi) || 0 : 0));
      } else {
        // parts of words (asked for), or a term without a word in it ("::1"): every message is read
        cond = `(${likeCols} OR ${devName} OR e.event_id = ?)`;
        a = [like, like, like, like, like, like, like, n];
      }
      // (a message without a device or event id makes parts of it NULL - left out means: not there)
      where.push(t.not ? `NOT COALESCE(${cond}, 0)` : cond);
      args.push(...a);
    }
    // many hits (common words): the newest come quickly when walking back from the newest message
    many = words && fewest > MANY;
    return { where: where.join(' AND '), args, words, many };
  }

  function list({ limit = 200, before = null, ...filter } = {}) {
    const { where, args, words, many } = filterSql(filter);
    const w = before ? `${where} AND e.id < ?` : where;
    if (before) args.push(Number(before));
    // with a rare word: what the index found, newest first ("+": not by walking through all messages until 200 match)
    return db.prepare(`SELECT e.*, d.name device_name FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE ${w} ORDER BY ${words && !many ? '+e.id' : 'e.id'} DESC LIMIT ?`)
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
      const { where, args, words } = filterSql({ ...filter, from: null });
      const first = words
        ? db.prepare(`SELECT e.at a FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE ${where} ORDER BY +e.id LIMIT 1`).get(...args)?.a
        : db.prepare(`SELECT MIN(e.at) a FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE ${where}`).get(...args)?.a;
      start = first ? new Date(first).getTime() : end - 3600000;
    }
    if (!(end > start)) return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), step: 60, total: 0, buckets: [] };
    const span = (end - start) / 1000;
    const step = STEPS.find((s) => span / s <= 60) || Math.ceil(span / 60 / 86400) * 86400;
    // bars start on a round time (local midnight does not matter here: the browser labels them in its own time)
    const t0 = Math.floor(start / 1000 / step) * step;
    const n = Math.ceil((end / 1000 - t0) / step);
    const range = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
    let rows;
    if (!String(filter.q || '').trim() && !filter.device) {
      // without a search: the minutes from the counts, only the cut minutes at both ends and what is newer than the
      // counts from the messages - the same numbers, without reading millions of them
      const lo = Math.ceil(start / 60000); const hi = Math.floor(end / 60000);
      const w = ['severity <= ?']; const a = [Math.max(0, Math.min(7, Number(filter.maxSeverity ?? 7)))];
      if (filter.kind === 'trap' || filter.kind === 'syslog') { w.push('kind = ?'); a.push(filter.kind); }
      if (filter.source) { w.push('source_ip = ?'); a.push(String(filter.source).slice(0, 64)); }
      const counts = (table, col, secs, from, to) => (to > from ? db.prepare(`SELECT CAST((${col} * ${secs} - ?) / ? AS INTEGER) b,
        SUM(CASE WHEN severity <= 3 THEN n ELSE 0 END) err, SUM(CASE WHEN severity = 4 THEN n ELSE 0 END) warn, SUM(n) n
        FROM ${table} WHERE ${col} >= ? AND ${col} < ? AND ${w.join(' AND ')} GROUP BY b`).all(t0, step, from, to, ...a) : []);
      // bars of whole hours (or days, weeks): whole hours from the hour counts, the minutes around them
      const loH = Math.ceil(lo / 60); const hiH = Math.floor(hi / 60);
      if (step % 3600 === 0 && hiH > loH) rows = [...counts('events_hour', 'hour', 3600, loH, hiH), ...counts('events_minute', 'minute', 60, lo, loH * 60), ...counts('events_minute', 'minute', 60, hiH * 60, hi)];
      else rows = counts('events_minute', 'minute', 60, lo, hi);
      // each part below has its own time range (a second one would keep the time index from using the narrow one)
      const { where, args } = filterSql({ ...filter, from: null, to: null });
      if (hi > lo) {
        for (const p of notCounted(range.from, new Date(lo * 60000).toISOString(), new Date(hi * 60000).toISOString(), range.to)) {
          rows.push(...db.prepare(`SELECT CAST((CAST(strftime('%s', e.at) AS INTEGER) - ?) / ? AS INTEGER) b, SUM(e.severity <= 3) err, SUM(e.severity = 4) warn, COUNT(*) n
            FROM ${p.src} WHERE ${where} AND ${p.sql} GROUP BY b`).all(t0, step, ...args, ...p.args));
        }
      } else {
        // all within one minute: from the messages
        rows.push(...db.prepare(`SELECT CAST((CAST(strftime('%s', e.at) AS INTEGER) - ?) / ? AS INTEGER) b, SUM(e.severity <= 3) err, SUM(e.severity = 4) warn, COUNT(*) n
          FROM events_in e WHERE ${where} AND e.at >= ? AND e.at < ? GROUP BY b`).all(t0, step, ...args, range.from, range.to));
      }
    } else {
      const { where, args } = filterSql({ ...filter, ...range });
      rows = db.prepare(`SELECT CAST((CAST(strftime('%s', e.at) AS INTEGER) - ?) / ? AS INTEGER) b, SUM(e.severity <= 3) err, SUM(e.severity = 4) warn, COUNT(*) n
        FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE ${where} GROUP BY b`).all(t0, step, ...args);
    }
    const buckets = Array.from({ length: n }, (_, i) => ({ at: new Date((t0 + i * step) * 1000).toISOString(), err: 0, warn: 0, other: 0 }));
    let total = 0;
    for (const r of rows) {
      const b = buckets[r.b]; if (!b) continue;
      b.err += r.err; b.warn += r.warn; b.other += r.n - r.err - r.warn; total += r.n;
    }
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), step, total, buckets };
  }

  /**
   * The overview by sender: one row per address with its device or computer name, the newest message and what came in
   * the last 24 hours (how many, how many warnings and errors). The newest first; q filters names and addresses.
   */
  /** The messages the counts do not cover yet within [from, to), plus the cut pieces [from, lo) and [hi, to) at the
   * edges: one condition each, so that each part is found through its own index (id or time), never by reading a day */
  function notCounted(fromIso, loIso, hiIso, toIso) {
    // the newest by their id (no index: the time index would read the whole range), the edges by their time
    const parts = [{ src: 'events_in e NOT INDEXED', sql: 'e.id > ? AND e.at >= ? AND e.at < ?', args: [counted(), loIso, hiIso] }];
    if (fromIso < loIso) parts.push({ src: 'events_in e INDEXED BY events_in_at', sql: 'e.at >= ? AND e.at < ?', args: [fromIso, loIso] });
    if (hiIso < toIso) parts.push({ src: 'events_in e INDEXED BY events_in_at', sql: 'e.at >= ? AND e.at < ?', args: [hiIso, toIso] });
    return parts;
  }
  /** Messages since a time per sender (n, warnings, errors) - whole hours from the hour counts (a minute row per sender
   * and minute would be millions with thousands of senders), the minutes up to the first whole hour, the cut minute
   * and the newest from the messages */
  function countSince(sinceMs) {
    const m = Math.ceil(sinceMs / 60000);
    const h = Math.ceil(m / 60);
    const out = new Map();
    const add = (r) => { const x = out.get(r.source_ip) || { source_ip: r.source_ip, n: 0, warn: 0, err: 0 }; x.n += r.n; x.warn += r.warn; x.err += r.err; out.set(r.source_ip, x); };
    const sums = 'source_ip, SUM(n) n, SUM(CASE WHEN severity <= 4 THEN n ELSE 0 END) warn, SUM(CASE WHEN severity <= 3 THEN n ELSE 0 END) err';
    db.prepare(`SELECT ${sums} FROM events_hour WHERE hour >= ? GROUP BY source_ip`).all(h).forEach(add);
    db.prepare(`SELECT ${sums} FROM events_minute WHERE minute >= ? AND minute < ? GROUP BY source_ip`).all(m, h * 60).forEach(add);
    for (const p of notCounted(new Date(sinceMs).toISOString(), new Date(m * 60000).toISOString(), FAR, FAR)) {
      db.prepare(`SELECT source_ip, COUNT(*) n, SUM(severity <= 4) warn, SUM(severity <= 3) err FROM ${p.src} WHERE ${p.sql} GROUP BY source_ip`).all(...p.args).forEach(add);
    }
    return out;
  }
  // One row per sender - without the text of its newest message (thousands of senders: only the page shown gets it)
  let sendersCache = null; let sendersAt = 0;
  function senderRows(fresh = false) {
    // counted again at most every 5 seconds while messages come in (the 24 hours are not free on a busy network)
    if (fresh || !sendersCache || Date.now() - sendersAt > (receivedSince ? 5000 : STATS_MS)) {
      const day = countSince(Date.now() - 86400000);
      const list = db.prepare(`SELECT s.source_ip, s.device_id, s.host, s.first_at, s.last_at, s.last_id, s.transport, s.udp_at, d.name device_name, d.type device_type
        FROM event_senders s LEFT JOIN devices d ON d.id = s.device_id ORDER BY s.last_at DESC`).all()
        .map((r) => { const x = day.get(r.source_ip) || {}; return { ...r, day: x.n || 0, warn: x.warn || 0, err: x.err || 0 }; });
      // a muted sender has nothing stored - it stays in the list all the same, or it could never be unmuted
      const have = new Set(list.map((r) => r.source_ip));
      for (const f of db.prepare('SELECT f.source_ip, d.id device_id, d.name device_name, d.type device_type FROM event_source_filters f LEFT JOIN devices d ON d.ip = f.source_ip').all()) {
        if (!have.has(f.source_ip)) list.push({ source_ip: f.source_ip, device_id: f.device_id, host: '', first_at: null, last_at: null, last_id: null, transport: '', udp_at: null, device_name: f.device_name, device_type: f.device_type, day: 0, warn: 0, err: 0 });
      }
      sendersCache = list; sendersAt = Date.now();
    }
    const filters = new Map(db.prepare('SELECT source_ip, min_severity FROM event_source_filters').all().map((r) => [r.source_ip, r.min_severity]));
    return sendersCache.map((r) => ({ ...r, filter: filters.has(r.source_ip) ? filters.get(r.source_ip) : null, dropped: droppedBy.get(r.source_ip) || 0 }));
  }
  /** The newest message of each of these senders (severity, source, id, text) */
  function withLast(rows) {
    const ids = rows.map((r) => r.last_id).filter((x) => x !== null && x !== undefined);
    const last = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const e of db.prepare(`SELECT id, severity, app, event_id, text FROM events_in WHERE id IN (${part.map(() => '?').join(',')})`).all(...part)) last.set(e.id, e);
    }
    return rows.map((r) => { const e = last.get(r.last_id) || {}; return { ...r, last_severity: e.severity ?? null, last_app: e.app ?? null, last_event_id: e.event_id ?? null, last_text: e.text ?? null }; });
  }
  const matchesQ = (r, n) => !n || [r.source_ip, r.host, r.device_name].some((v) => String(v || '').toLowerCase().includes(n));
  // quick filters of the overview: errors / warnings in the last 24 hours, silent for 24 hours, with a filter of its own
  const SHOW = {
    err: (r) => r.err > 0,
    warn: (r) => r.warn - r.err > 0,
    silent: (r) => r.day === 0,
    // still sends over UDP (in the last 24 hours): a device that could go over to TCP
    udp: (r) => !!r.udp_at && Date.parse(r.udp_at) > Date.now() - 86400000,
    filter: (r) => r.filter !== null && r.filter !== undefined,
  };
  const SORT = {
    last: (a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')),
    day: (a, b) => b.day - a.day || String(b.last_at || '').localeCompare(String(a.last_at || '')),
    name: (a, b) => String(a.device_name || a.host || a.source_ip).localeCompare(String(b.device_name || b.host || b.source_ip), undefined, { numeric: true, sensitivity: 'base' }),
  };
  /** All senders (q filters names and addresses), each with its newest message - for few senders and the tests */
  function senders({ q = '', fresh = false } = {}) {
    const n = String(q || '').trim().toLowerCase().slice(0, 100);
    return withLast(senderRows(fresh).filter((r) => matchesQ(r, n)));
  }
  /**
   * The overview by sender, a page at a time (10 000 computers are no list to scroll through): q, a quick filter
   * (show), the type of device ('-' = not in the inventory), the order; how many there are for each quick filter and type.
   */
  function senderPage({ q = '', show = '', type = '', sort = 'last', offset = 0, limit = 100, fresh = false } = {}) {
    const n = String(q || '').trim().toLowerCase().slice(0, 100);
    const all = senderRows(fresh);
    const found = all.filter((r) => matchesQ(r, n));
    const counts = { all: found.length };
    for (const [k, f] of Object.entries(SHOW)) counts[k] = found.filter(f).length;
    const byType = new Map();
    for (const r of found) { const k = r.device_type || '-'; byType.set(k, (byType.get(k) || 0) + 1); }
    let list = SHOW[show] ? found.filter(SHOW[show]) : found;
    if (type) list = list.filter((r) => (r.device_type || '-') === String(type));
    list = [...list].sort(SORT[sort] || SORT.last);
    const from = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    return { senders: withLast(list.slice(from, from + size)), total: list.length, all: all.length, offset: from, counts,
      types: [...byType].map(([k, c]) => ({ type: k, n: c })).sort((a, b) => b.n - a.n) };
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
    let deleted = 0; let more = false;
    const days = Math.max(1, Math.min(365, Number(settings.get('events.keepDays')) || 30));
    // in pieces: a whole busy day at once would hold up the receiving for long (every message also leaves the index and
    // the counts); what is left goes in the next round, a few seconds later
    const old = new Date(Date.now() - days * 86400000).toISOString();
    const gone = db.prepare('DELETE FROM events_in WHERE id IN (SELECT id FROM events_in WHERE at < ? ORDER BY id LIMIT ?)');
    for (let round = 0; round < 10; round++) {
      const c = gone.run(old, PRUNE_PIECE).changes; deleted += c;
      if (c < PRUNE_PIECE) break;
      if (round === 9) { more = true; }
    }
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
      // counts that went down to nothing (before the oldest message left)
      const first = db.prepare('SELECT at FROM events_in ORDER BY id LIMIT 1').pluck().get();
      const firstMs = first ? Date.parse(first) : Date.now();
      db.prepare('DELETE FROM events_minute WHERE minute < ? AND n <= 0').run(Math.floor(firstMs / 60000) + 1);
      db.prepare('DELETE FROM events_hour WHERE hour < ? AND n <= 0').run(Math.floor(firstMs / 3600000) + 1);
      db.prepare('DELETE FROM events_hour_id WHERE hour < ? AND n <= 0').run(Math.floor(firstMs / 3600000) + 1);
      // who sent what: the days before the oldest message
      db.prepare('DELETE FROM events_day_src WHERE day < ?').run(Math.floor(firstMs / 86400000));
      // a sender whose messages are all gone leaves the overview too
      db.prepare('DELETE FROM event_senders WHERE last_id < COALESCE((SELECT MIN(id) FROM events_in), 9e18)').run();
      try { db.pragma('ev.incremental_vacuum'); } catch { /* an older file without auto-vacuum keeps its pages for reuse */ }
      stats = null;
      log.info(`Messages: ${deleted} old message(s) removed`);
    }
    if (more && !pruneSoon) { pruneSoon = setTimeout(() => { pruneSoon = null; try { prune(); } catch (e) { log.warn(`Messages cleanup failed: ${e.message}`); } }, 2000); pruneSoon.unref?.(); }
    return deleted;
  }

  /**
   * What fills the file (Messages → What takes the space?): Windows event ids and senders over the last days, each with
   * its share, how much a day and roughly how much space over the days kept - to find what need not be collected at all.
   * From the counts; an example and the senders of an event from its newest messages (through the event index).
   */
  function noise({ days = 7, top = 30, denied = () => false } = {}) {
    const d = [1, 7, 30].includes(Number(days)) ? Number(days) : 7;
    const sinceMs = Date.now() - d * 86400000;
    const perSender = [...countSince(sinceMs).values()];
    const total = perSender.reduce((a, r) => a + r.n, 0);
    const hour = Math.ceil(sinceMs / 3600000);
    const ids = new Map(db.prepare('SELECT event_id, SUM(n) n FROM events_hour_id WHERE hour >= ? GROUP BY event_id').all(hour).map((r) => [r.event_id, r.n]));
    for (const p of notCounted(new Date(sinceMs).toISOString(), new Date(hour * 3600000).toISOString(), FAR, FAR)) {
      for (const r of db.prepare(`SELECT event_id, COUNT(*) n FROM ${p.src} WHERE ${p.sql} AND event_id IS NOT NULL GROUP BY event_id`).all(...p.args)) ids.set(r.event_id, (ids.get(r.event_id) || 0) + r.n);
    }
    // space: what a message takes on average, weighted by how long its text is (a 4625 is ten times a switch line)
    const st = storage();
    const perRow = st.total ? st.used / st.total : 0;
    const LEN = "length(COALESCE(text,'')) + length(COALESCE(app,'')) + length(COALESCE(channel,'')) + length(COALESCE(account,'')) + 200";
    const avgAll = db.prepare(`SELECT AVG(${LEN}) FROM (SELECT * FROM events_in ORDER BY id DESC LIMIT 2000)`).pluck().get() || 1;
    const keepDays = st.keepDays;
    const names = new Map(db.prepare('SELECT source_ip, host FROM event_senders').all().map((r) => [r.source_ip, r.host]));
    const newest = db.prepare(`SELECT at, source_ip, host, app, channel, severity, text, ${LEN} len FROM events_in WHERE event_id = ? ORDER BY id DESC LIMIT 500`);
    // One number can come from several sources (1 of Ntfs, 1 of Sysmon): such a number is split by source - counted
    // exactly when it is not too many messages, else in the share of its newest 500 (marked as estimated)
    const bySource = db.prepare('SELECT COALESCE(app, \'\') app, COUNT(*) n FROM events_in WHERE event_id = ? AND at >= ? GROUP BY 1');
    const entries = [];
    // (more than "top": events left out already go to a list of their own and must not crowd out the others)
    for (const [id, n] of [...ids].filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]).slice(0, top + 15)) {
      const rows = newest.all(id);
      const apps = new Map();
      for (const r of rows) { const k = r.app || ''; if (!apps.has(k)) apps.set(k, []); apps.get(k).push(r); }
      if (apps.size <= 1) { entries.push({ id, app: rows[0]?.app || '', n, rows, estimated: false }); continue; }
      let split; let estimated = false;
      if (n <= 300000) split = new Map(bySource.all(id, new Date(sinceMs).toISOString()).map((r) => [r.app, r.n]));
      else { estimated = true; split = new Map([...apps].map(([k, list]) => [k, Math.round((n * list.length) / rows.length)])); }
      // a source of the period that is not among the newest 500 has no example: it goes with the rest
      for (const [app, m] of split) if (m > 0) entries.push({ id, app, n: m, rows: apps.get(app) || [], estimated });
    }
    // how many computers sent it in the period: exact, from the day table (whole days - the first day of the period
    // counts whole) and what is newer than the counts
    const day0 = Math.floor(sinceMs / 86400000);
    const fromCounts = db.prepare(`SELECT COUNT(*) FROM (SELECT source_ip FROM events_day_src WHERE event_id = ? AND day >= ?
      UNION SELECT source_ip FROM events_in NOT INDEXED WHERE id > ? AND event_id = ?)`).pluck();
    const fromCountsApp = db.prepare(`SELECT COUNT(*) FROM (SELECT source_ip FROM events_day_src WHERE event_id = ? AND app = ? AND day >= ?
      UNION SELECT source_ip FROM events_in NOT INDEXED WHERE id > ? AND event_id = ? AND COALESCE(app, '') = ?)`).pluck();
    const splitIds = new Set(entries.map((e) => e.id).filter((id, i, all) => all.indexOf(id) !== i));
    // Left out already (the list "never take"): only older messages, gone after the days kept - at the end, apart
    for (const e of entries) e.denied = !!denied(e.id, e.app);
    const chosen = [...entries.filter((e) => !e.denied).sort((a, b) => b.n - a.n).slice(0, top), ...entries.filter((e) => e.denied).sort((a, b) => b.n - a.n).slice(0, 10)];
    const events = chosen.map(({ id, app, n, rows, estimated, denied: off }) => {
      const ex = rows[0] || {};
      const who = new Map();
      for (const r of rows) { const k = r.host || names.get(r.source_ip) || r.source_ip; who.set(k, (who.get(k) || 0) + 1); }
      const done = counted();
      const computers = Math.max(who.size, splitIds.has(id) ? fromCountsApp.get(id, app, day0, done, id, app) : fromCounts.get(id, day0, done, id));
      const avg = rows.length ? rows.reduce((a, r) => a + r.len, 0) / rows.length : avgAll;
      const perDay = n / d;
      return { id, app, n, estimated, perDay: Math.round(perDay), share: total ? Math.round((n / total) * 1000) / 10 : 0,
        bytes: Math.round(perDay * keepDays * perRow * (avg / avgAll)),
        worst: rows.length ? Math.min(...rows.map((r) => r.severity)) : null,
        senders: [...who].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name), moreSenders: Math.max(0, computers - Math.min(3, who.size)), computers,
        example: { host: ex.host || names.get(ex.source_ip) || ex.source_ip || '', app: ex.app || app || '', channel: ex.channel || '', text: String(ex.text || '').slice(0, 300) },
        // left out: the newest stored one leaves after the days kept (or earlier, when the space runs short)
        denied: off, goneBy: off && rows.length ? new Date(Math.max(...rows.map((r) => Date.parse(r.at))) + keepDays * 86400000).toISOString() : null };
    });
    const filters = new Map(db.prepare('SELECT source_ip, min_severity FROM event_source_filters').all().map((r) => [r.source_ip, r.min_severity]));
    const busy = perSender.filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
    const senders = busy.slice(0, 15).map((r) => ({
      source_ip: r.source_ip, name: names.get(r.source_ip) || '', filter: filters.has(r.source_ip) ? filters.get(r.source_ip) : null, n: r.n, perDay: Math.round(r.n / d),
      share: total ? Math.round((r.n / total) * 1000) / 10 : 0, info: r.n ? Math.round(((r.n - r.warn) / r.n) * 100) : 0,
      bytes: Math.round((r.n / d) * keepDays * perRow) }));
    // the senders below the 15 together - with thousands of computers most of the space can be there
    const restList = busy.slice(15); const restN = restList.reduce((a, r) => a + r.n, 0);
    const rest = restList.length ? { senders: restList.length, n: restN, perDay: Math.round(restN / d), share: total ? Math.round((restN / total) * 1000) / 10 : 0,
      bytes: Math.round((restN / d) * keepDays * perRow) } : null;
    // by type of device (from the inventory): are it the clients, the servers or a NAS?
    const typeOf = new Map(db.prepare('SELECT s.source_ip, d.type FROM event_senders s LEFT JOIN devices d ON d.id = s.device_id').all().map((r) => [r.source_ip, r.type || '']));
    const g = new Map();
    for (const r of busy) { const k = typeOf.get(r.source_ip) || '-'; const x = g.get(k) || { type: k, senders: 0, n: 0 }; x.senders++; x.n += r.n; g.set(k, x); }
    const groups = [...g.values()].sort((a, b) => b.n - a.n).map((x) => ({ ...x, perDay: Math.round(x.n / d), share: total ? Math.round((x.n / total) * 1000) / 10 : 0,
      bytes: Math.round((x.n / d) * keepDays * perRow) }));
    // what of the period comes from events left out already (stored before they were): goes by itself
    const deniedN = entries.filter((e) => e.denied).reduce((x, e) => x + e.n, 0);
    return { days: d, total, perDay: Math.round(total / d), deniedPerDay: Math.round(deniedN / d), keepDays, used: st.used, events, senders, senderCount: busy.length, rest, groups };
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
    const done = counted();
    const total = (db.prepare('SELECT SUM(n) FROM events_hour').pluck().get() || 0) + db.prepare('SELECT COUNT(*) FROM events_in WHERE id > ?').pluck().get(done);
    const sinceMs = Date.now() - 86400000;
    const perSender = [...countSince(sinceMs).values()];
    const day = perSender.reduce((a, r) => a + r.n, 0);
    const oldest = db.prepare('SELECT at FROM events_in ORDER BY id LIMIT 1').get()?.at || null;
    const perRow = total ? used / total : 900;
    const perDay = day * perRow;
    const keepDays = Math.max(1, Math.min(365, Number(settings.get('events.keepDays')) || 30));
    const daysFit = perDay > 0 ? Math.floor(lim.cap / perDay) : null;
    // who fills it: the biggest senders and Windows events of the last day (with their share)
    const share = (list) => (day ? list.sort((a, b) => b.n - a.n).slice(0, 3).map((r) => ({ name: String(r.name ?? ''), share: Math.round((r.n / day) * 100) })).filter((r) => r.share >= 10) : []);
    // senders by their computer name (as the messages give it); event ids by the hour, the cut hour from the messages
    const names = new Map(db.prepare("SELECT source_ip, host FROM event_senders").all().map((r) => [r.source_ip, r.host]));
    const bySender = new Map();
    for (const r of perSender) { const name = names.get(r.source_ip) || r.source_ip; bySender.set(name, (bySender.get(name) || 0) + r.n); }
    const hour = Math.ceil(sinceMs / 3600000);
    const ids = new Map(db.prepare('SELECT event_id, SUM(n) n FROM events_hour_id WHERE hour >= ? GROUP BY event_id').all(hour).map((r) => [r.event_id, r.n]));
    for (const p of notCounted(new Date(sinceMs).toISOString(), new Date(hour * 3600000).toISOString(), FAR, FAR)) {
      for (const r of db.prepare(`SELECT event_id, COUNT(*) n FROM ${p.src} WHERE ${p.sql} AND event_id IS NOT NULL GROUP BY event_id`).all(...p.args)) ids.set(r.event_id, (ids.get(r.event_id) || 0) + r.n);
    }
    stats = { used, limit: lim.want, cap: lim.cap, diskShort: lim.diskShort, total, perDay: day, oldest, keepDays, daysFit, short: daysFit !== null && daysFit < keepDays,
      topSenders: share([...bySender].map(([name, n]) => ({ name, n }))),
      topEvents: share([...ids].map(([name, n]) => ({ name, n }))) };
    statsAt = Date.now();
    return stats;
  }
  let pruneTimer = null; let pruneSoon = null;

  return {
    receive, queue, flush, list, histogram, senders, senderPage, prune, apply, communities,
    /** What is kept of one sender: min severity 0-7, -1 muted, null = as for all */
    setSenderFilter(ip, min, by = '') {
      const a = String(ip || '').trim().slice(0, 64);
      if (!a) return;
      if (min === null || min === undefined || min === '') db.prepare('DELETE FROM event_source_filters WHERE source_ip=?').run(a);
      else db.prepare('INSERT INTO event_source_filters(source_ip, min_severity, updated_at, updated_by) VALUES(?,?,?,?) ON CONFLICT(source_ip) DO UPDATE SET min_severity=excluded.min_severity, updated_at=excluded.updated_at, updated_by=excluded.updated_by')
        .run(a, Math.max(-1, Math.min(7, Number(min))), new Date().toISOString(), String(by).slice(0, 120));
      sevFilter = null; sendersCache = null;
    },
    reloadTls, indexBatch, countBatch, indexPump, indexStatus, noise,
    status: () => ({ searchIndex: indexStatus(), counts: countStatus(), traps: { ...status.traps }, syslog: { ...status.syslog }, syslogTcp: { ...status.syslogTcp }, syslogTls: { ...status.syslogTls }, skipped, filtered, flooded, heldBack, perSecond: flood.perSecond, total: storage().total,
      last: db.prepare('SELECT at FROM events_in ORDER BY id DESC LIMIT 1').get()?.at || null, storage: storage() }),
    storage,
    /** Receivers as set, and the cleanup every 10 minutes (the limit holds between the daily rounds too) */
    start() {
      apply();
      if (!pruneTimer) { pruneTimer = setInterval(() => { try { prune(); } catch (e) { log.warn(`Messages cleanup failed: ${e.message}`); } }, PRUNE_MS); pruneTimer.unref(); }
      if (!ftsTimer) { ftsTimer = setInterval(indexPump, FTS_MS); ftsTimer.unref(); setImmediate(indexPump); }
    },
    stop() { clearInterval(pruneTimer); pruneTimer = null; clearTimeout(pruneSoon); pruneSoon = null; clearInterval(ftsTimer); ftsTimer = null; stopAll(); },
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
