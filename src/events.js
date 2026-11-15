// Messages devices send by themselves: SNMP traps (v1, v2c, informs) and syslog (UDP, TCP and TLS; RFC 3164 and 5424). Switches,
// UPSs, firewalls and NAS report a problem the moment it happens - instead of waiting for the next poll.
//
// Off until switched on (Monitoring → Messages). The ports come from .env: WOMN_TRAP_PORT (default 1162),
// WOMN_SYSLOG_PORT (UDP, default 1514), WOMN_SYSLOG_TCP_PORT (default 1514) and WOMN_SYSLOG_TLS_PORT (default 6514,
// with the certificate of this server) - not 162/514, because WhatsOnMyNet runs without root rights; a port redirect on the
// host or the port set on the device does the rest (see the manual).
//
// Each installation keeps what it received itself (failover: send to both). Kept 30 days, at most 200 000 messages.
// A flood (a device in a loop, or someone sending on purpose) is cut: at most 20 messages per second per sender and
// 300 in all; text is cut to 1000 characters. UDP has no sender check - traps at least need a known community.
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import snmp from 'net-snmp';
import { log } from './lib/log.js';
import { config } from './config.js';

export const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const MAX_ROWS = 200000;
const PER_SENDER = 20;
const PER_SECOND = 300;
const clip = (s, n) => String(s ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------------------------------------- syslog
/** One syslog datagram → { severity, facility, host, app, text } */
export function parseSyslog(raw) {
  let s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  s = s.replace(/^\uFEFF/, '').slice(0, 8192);
  const m = /^<(\d{1,3})>([\s\S]*)$/.exec(s.trimStart());
  if (!m || Number(m[1]) > 191) return { severity: 5, facility: 1, host: '', app: '', text: clip(s, 1000) };
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
    out.text = clip(rest, 1000);
    return out;
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
  out.text = clip(rest, 1000);
  return out;
}

// ---------------------------------------------------------------------------------------------- syslog over a stream
// TCP (RFC 6587) and TLS (RFC 5425) carry several messages on one connection. Two kinds of framing:
//   octet counting  "123 <34>1 2026-…"   (length first - RFC 5425 requires it)
//   line by line    "<34>Oct 11 …\n"     (most devices over plain TCP)
// The first byte of each message decides. Too long, nonsense lengths or a full buffer end the connection.
export const MAX_FRAME = 8192;
export function syslogFramer(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
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
          const len = Number(m[1]);
          if (m[1].length > 6 || len > MAX_FRAME) return false;
          const sp = m[1].length;
          if (buf.length < sp + 1 + len) return true;
          onMessage(buf.subarray(sp + 1, sp + 1 + len));
          buf = buf.subarray(sp + 1 + len);
          continue;
        }
        if (/^\d{1,12}$/.test(head) && buf.length < 16) return true; // only digits so far - wait for more
      }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return buf.length <= MAX_FRAME;
      if (nl > MAX_FRAME) return false;
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
  const insert = db.prepare('INSERT INTO events_in(at, kind, source_ip, device_id, severity, facility, host, app, oid, text) VALUES(?,?,?,?,?,?,?,?,?,?)');
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
    const row = { at: at.toISOString(), kind, source_ip: addr, device_id: device, severity: Math.max(0, Math.min(7, Number(ev.severity) || 0)), facility: ev.facility ?? null,
      host: clip(ev.host, 120), app: clip(ev.app, 60), oid: clip(ev.oid, 200), text: clip(ev.text, 1000) || '(empty)' };
    row.id = insert.run(row.at, row.kind, row.source_ip, row.device_id, row.severity, row.facility, row.host, row.app, row.oid, row.text).lastInsertRowid;
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
      const feed = syslogFramer((frame) => receive('syslog', ip, parseSyslog(frame)));
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
    stopAll();
    if (settings.get('events.traps')) startTraps();
    if (settings.get('events.syslog')) startSyslog();
    startStreams();
  }

  function list({ q = '', kind = '', maxSeverity = 7, device = null, limit = 200, before = null } = {}) {
    const where = ['severity <= ?']; const args = [Math.max(0, Math.min(7, Number(maxSeverity)))];
    if (kind === 'trap' || kind === 'syslog') { where.push('kind = ?'); args.push(kind); }
    if (device) { where.push('e.device_id = ?'); args.push(Number(device)); }
    if (before) { where.push('e.id < ?'); args.push(Number(before)); }
    if (q) { where.push("(text LIKE ? ESCAPE '\\' OR app LIKE ? ESCAPE '\\' OR source_ip LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR e.host LIKE ? ESCAPE '\\')"); const like = `%${String(q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`; args.push(like, like, like, like, like); }
    return db.prepare(`SELECT e.*, d.name device_name FROM events_in e LEFT JOIN devices d ON d.id=e.device_id WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`)
      .all(...args, Math.max(1, Math.min(1000, Number(limit) || 200)));
  }

  function prune() {
    const days = Math.max(1, Math.min(365, Number(settings.get('events.keepDays')) || 30));
    db.prepare('DELETE FROM events_in WHERE at < ?').run(new Date(Date.now() - days * 86400000).toISOString());
    const n = db.prepare('SELECT COUNT(*) n FROM events_in').get().n;
    if (n > MAX_ROWS) db.prepare('DELETE FROM events_in WHERE id <= (SELECT id FROM events_in ORDER BY id DESC LIMIT 1 OFFSET ?)').run(MAX_ROWS);
  }

  return {
    receive, list, prune, apply, communities,
    reloadTls,
    status: () => ({ traps: { ...status.traps }, syslog: { ...status.syslog }, syslogTcp: { ...status.syslogTcp }, syslogTls: { ...status.syslogTls }, total: db.prepare('SELECT COUNT(*) n FROM events_in').get().n,
      last: db.prepare('SELECT at FROM events_in ORDER BY id DESC LIMIT 1').get()?.at || null }),
    start: apply,
    stop: stopAll,
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
