// Docker health check: asks the built-in HTTPS server for /healthz (its certificate may be self-signed).
// Scan agent (WOMN_AGENT_SERVER set): healthy when it reached the central server in the last 5 minutes.
import https from 'node:https';
import fs from 'node:fs';

if (process.env.WOMN_AGENT_SERVER) {
  try { process.exit(Date.now() - fs.statSync('/tmp/womn-agent.ok').mtimeMs < 5 * 60 * 1000 ? 0 : 1); } catch { process.exit(1); }
}

const port = Number(process.env.WOMN_HTTPS_PORT) || 8743;
const bind = String(process.env.WOMN_BIND || '').trim();
const host = !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind.replace(/^\[|\]$/g, '');
const req = https.get({ host, port, path: '/healthz', rejectUnauthorized: false, timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
