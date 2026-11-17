// Stand-in for the syslog receiver of WhatsOnMyNet over TCP: the same framing and parser (src/events.js), every
// message read written as one JSON line to <out>. For the check of Fluent Bit on a real Windows (fluentbit.ps1).
//   node tools/wincheck/listen.mjs <port> <out file>
import net from 'node:net';
import fs from 'node:fs';
import { syslogFramer, parseSyslog } from '../../src/events.js';

const [port, out] = [Number(process.argv[2]), process.argv[3]];
fs.writeFileSync(out, '');
net.createServer((sock) => {
  const feed = syslogFramer((frame) => {
    const m = parseSyslog(frame);
    fs.appendFileSync(out, `${JSON.stringify({ host: m.host, app: m.app, eventId: m.eventId ?? null, channel: m.channel ?? '', severity: m.severity, text: m.text })}\n`);
  }, () => fs.appendFileSync(out, `${JSON.stringify({ skipped: true })}\n`));
  sock.on('data', (d) => { if (!feed(d)) sock.destroy(); });
  sock.on('error', () => {});
}).listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));
