// Windows check (CI, .github/workflows/windows.yml): a stand-in for WhatsOnMyNet that the real Windows script talks
// to on a real Windows - with a self-signed certificate made the way the program makes it, and the script as the
// program hands it out (pinned key, UTF-8 with BOM, CRLF). Every report is written to reports.jsonl.
//   node tools/wincheck/serve.mjs <work dir>      → <work dir>/womn-host.ps1, then serves on 127.0.0.1:18443
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { createTls, keyPin } from '../../src/tls.js';
import { hostScript } from '../../src/hostscripts.js';

const dir = path.resolve(process.argv[2] || 'wincheck');
fs.mkdirSync(dir, { recursive: true });
const t = createTls(path.join(dir, 'tls'));
await t.ensure();
const { cert, key } = t.current();
const c = new crypto.X509Certificate(cert.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]);
const pin = { sha1: c.fingerprint.replace(/:/g, ''), spki: crypto.createHash('sha256').update(c.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'), key: keyPin(c.publicKey) };
const port = 18443;
const s = hostScript('windows', { url: `https://127.0.0.1:${port}/api/hosts/push`, token: 'ci-token', pin });
// as the browser saves it (views/hostscripts.js): BOM and CRLF
fs.writeFileSync(path.join(dir, s.file), `﻿${s.text.replace(/\r?\n/g, '\r\n')}`);
fs.writeFileSync(path.join(dir, s.uninstall.file), `﻿${s.uninstall.text.replace(/\r?\n/g, '\r\n')}`);
const out = path.join(dir, 'reports.jsonl');
// <work dir>/reject: answer as WhatsOnMyNet does to a key no longer valid; <work dir>/down: drop the connection
https.createServer({ cert, key }, (req, res) => {
  if (fs.existsSync(path.join(dir, 'down'))) { console.log('dropped a connection (down)'); req.socket.destroy(); return; }
  if (fs.existsSync(path.join(dir, 'reject'))) {
    req.resume();
    req.on('end', () => { console.log('refused a report (reject)'); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'err.unauthorized', message: 'Bitte melde dich an.' } })); });
    return;
  }
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 5e6) req.destroy(); });
  req.on('end', () => {
    const ok = req.method === 'POST' && req.url === '/api/hosts/push' && req.headers.authorization === 'Bearer ci-token';
    if (ok) { fs.appendFileSync(out, `${body.replace(/\r?\n/g, ' ')}\n`); console.log(`report ${new Date().toISOString()} ${body.length} bytes`); }
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  });
}).listen(port, '127.0.0.1', () => console.log(`listening on ${port}, script in ${dir}`));
