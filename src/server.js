// Entry point: database, certificate, HTTPS server (+ HTTP port that redirects), daily housekeeping.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { config, paths, COMPOSE_VERSION } from './config.js';
import { openDatabase, verifyKey, backupDatabase, DatabaseTooNewError, WrongKeyError } from './db.js';
import { applyPendingRestore } from './backup.js';
import { initMasterKey } from './lib/crypto.js';
import { createApp } from './app.js';
import { createTls } from './tls.js';
import { log } from './lib/log.js';

const TLS_OPTIONS = { minVersion: 'TLSv1.2' };

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(`${label} port ${port}: ${e.code === 'EADDRINUSE' ? 'already in use - choose another port in .env' : e.message}`)));
    server.listen(port, config.bind, () => resolve());
  });
}

async function main() {
  log.info(`WhatsOnMyNet ${config.version} starting (data: ${config.dataDir})`);
  if (config.baseUrlInvalid) log.warn('WOMN_BASE_URL is ignored: it has to start with https:// (e.g. https://womn.firma.local:8743).');
  if (config.composeVersion && config.composeVersion < COMPOSE_VERSION) {
    log.warn('docker-compose.yml is outdated - take the current one from the release (or from /app/deploy in the image).');
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  initMasterKey();

  let db;
  try {
    applyPendingRestore(paths.db, paths.backups);
    db = openDatabase(paths.db);
    verifyKey(db);
  } catch (e) {
    if (e instanceof WrongKeyError) { log.error(e.message); process.exit(4); }
    if (e instanceof DatabaseTooNewError) { log.error(e.message); process.exit(3); }
    throw e;
  }

  const tls = createTls();
  await tls.ensure();
  const { app, ctx } = createApp(db, { tls });

  const cur = tls.current();
  const httpsServer = https.createServer({ ...TLS_OPTIONS, cert: cur.cert, key: cur.key }, app);
  ctx.applyTls = () => {
    const c = tls.current();
    httpsServer.setSecureContext({ ...TLS_OPTIONS, cert: c.cert, key: c.key });
    log.info('New certificate is active');
  };
  await listen(httpsServer, config.httpsPort, 'HTTPS');
  log.info(`HTTPS on port ${config.httpsPort}${config.baseUrl ? ` - ${config.baseUrl}` : ''}`);

  let httpServer = null;
  if (config.httpPort) {
    httpServer = http.createServer(app);
    await listen(httpServer, config.httpPort, 'HTTP');
    log.info(`HTTP on port ${config.httpPort} (redirects to HTTPS${ctx.trustProxy ? `; serves the reverse proxy ${ctx.trustProxy}` : ''})`);
  }

  ctx.monitoring.start();
  ctx.nightly.start();
  ctx.printers.start();
  ctx.snmpDevices.start();
  ctx.reports.start();
  ctx.proxmox.start();

  // Daily: sessions, old check results, backup, renew the self-signed certificate if needed
  const daily = async () => {
    try { ctx.sessions.purgeExpired(); } catch (e) { log.warn(`Session cleanup failed: ${e.message}`); }
    try { ctx.monitoring.cleanup(); } catch (e) { log.warn(`Monitoring cleanup failed: ${e.message}`); }
    try { ctx.nightly.cleanup(); } catch (e) { log.warn(`Sightings cleanup failed: ${e.message}`); }
    try { await backupDatabase(db, ctx.settings.get('backup.keep')); } catch (e) { log.error(`Daily backup failed: ${e.message}`); }
    try { if (await tls.ensure()) ctx.applyTls(); } catch (e) { log.error(`Certificate check failed: ${e.message}`); }
  };
  setInterval(daily, 24 * 3600 * 1000).unref();
  setTimeout(daily, 60 * 60 * 1000).unref();

  const shutdown = (sig) => {
    log.info(`${sig} received, shutting down ...`);
    ctx.monitoring.stop();
    ctx.nightly.stop();
    ctx.printers.stop();
    ctx.snmpDevices.stop();
    ctx.reports.stop();
    ctx.proxmox.stop();
    httpServer?.close();
    httpsServer.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error(`Startup failed: ${e.stack || e.message}`);
  process.exit(1);
});
