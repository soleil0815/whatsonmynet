// Docker health check: asks the built-in HTTPS server for /healthz (its certificate may be self-signed).
// Scan agent (WOMN_AGENT_SERVER set): healthy when it reached the central server in the last 5 minutes.
import https from 'node:https';
import fs from 'node:fs';

if (process.env.WOMN_AGENT_SERVER) {
  // The agent asks every WOMN_AGENT_INTERVAL seconds (up to an hour): healthy while the last contact is not older
  // than two of its intervals (at least 5 minutes)
  const every = Math.min(3600, Math.max(15, Number(process.env.WOMN_AGENT_INTERVAL) || 60));
  try { process.exit(Date.now() - fs.statSync('/tmp/womn-agent.ok').mtimeMs < Math.max(5 * 60, 2 * every + 60) * 1000 ? 0 : 1); } catch { process.exit(1); }
}

// The same rule as the server (src/config.js): an invalid port means the default
const raw = String(process.env.WOMN_HTTPS_PORT ?? '').trim();
const port = /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535 ? Number(raw) : 8743;
const bind = String(process.env.WOMN_BIND || '').trim();
const host = !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind.replace(/^\[|\]$/g, '');
const req = https.get({ host, port, path: '/healthz', rejectUnauthorized: false, timeout: 4000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
