// Assembles the Express application (without listening - so it can be tested).
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { config, paths } from './config.js';
import { createSettings } from './settings.js';
import { createSessions, parseCookies, createLoginLimiter } from './auth/session.js';
import { createUsers } from './auth/users.js';
import { createInventory } from './inventory.js';
import { createLocations } from './locations.js';
import { createScanner } from './scan/engine.js';
import { createMailer } from './mail/smtp.js';
import { createApi } from './routes/api.js';
import { createMonitoringApi } from './routes/monitoring.js';
import { createChannels } from './monitor/notify.js';
import { createMaintenance } from './monitor/maintenance.js';
import { createMonitoring } from './monitor/index.js';
import { createNightly } from './scan/nightly.js';
import { createPrinters } from './printers.js';
import { createDockerHosts } from './monitor/docker.js';
import { createSnmpDevices } from './snmpdevices.js';
import { createHosts } from './hosts.js';
import { syncStoredFacts } from './devicefill.js';
import { createDirectory } from './auth/directory.js';
import { createAgents } from './agents.js';
import { createReports } from './reports.js';
import { createProxmox } from './proxmox.js';
import { createBackups } from './backup.js';
import { HttpError } from './lib/http.js';
import { randomToken } from './lib/crypto.js';
import { t, langFromHeader, normalizeLang, hasKey } from './i18n.js';
import { log } from './lib/log.js';
import { httpPortMiddleware, proxyHttpsMiddleware, directHstsMiddleware, createHttpsHosts } from './https.js';
import { createSensorChoices } from './monitor/choices.js';

/**
 * WOMN_TRUST_PROXY: addresses/networks of the reverse proxy. Empty = no proxy (nothing is trusted).
 * "true"/numbers are rejected - they would trust every X-Forwarded-For header.
 */
export function applyTrustProxy(app, raw) {
  const value = String(raw ?? '').trim();
  if (!value) { app.set('trust proxy', false); return ''; }
  if (/^(true|false|yes|no|ja|nein|on|off|\d+)$/i.test(value)) {
    log.warn(`WOMN_TRUST_PROXY="${value}" is not valid - enter the address of the reverse proxy, e.g. 10.0.10.5. No proxy is trusted.`);
    app.set('trust proxy', false);
    return '';
  }
  try { app.set('trust proxy', value); } catch (e) {
    log.warn(`WOMN_TRUST_PROXY="${value}" is invalid (${e.message}) - no proxy is trusted.`);
    app.set('trust proxy', false);
    return '';
  }
  return value;
}

/**
 * @param db open database
 * @param opts.tls certificate store (src/tls.js) - optional in tests
 * @param opts.plainHttp tests only: serve the app on plain HTTP instead of redirecting
 */
export function createApp(db, { tls = null, plainHttp = false } = {}) {
  const settings = createSettings(db);
  const sessions = createSessions(db);
  const users = createUsers(db);
  const inventory = createInventory(db);
  const locations = createLocations(db);
  const scanner = createScanner({ db, settings, inventory });
  scanner.recover();
  const mailer = createMailer(settings);
  const limiter = createLoginLimiter();
  const channels = createChannels(db, mailer, settings);
  const maintenance = createMaintenance(db);
  const monitoring = createMonitoring({ db, channels, maintenance, settings });
  const nightly = createNightly({ db, settings, scanner, channels });
  const printers = createPrinters({ db, settings, channels });
  const dockerHosts = createDockerHosts(db);
  const snmpDevices = createSnmpDevices({ db, settings, channels });
  const hosts = createHosts({ db });
  // Serial numbers etc. already polled before this version knew how to take them over
  try { const n = syncStoredFacts(db); if (n) log.info(`Device details taken over from earlier polls: ${n} device(s)`); } catch (e) { log.warn(`Device details: ${e.message}`); }
  const directory = createDirectory(settings);
  const agents = createAgents({ db, settings, inventory, scanner });
  const reports = createReports({ db, settings, mailer });
  const proxmox = createProxmox({ db, settings });
  // Restart after a restore: the normal shutdown (Docker starts the container again)
  const backups = createBackups({ db, settings, dbFile: paths.db, backupsDir: paths.backups, restart: () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 800).unref() });

  // Initial setup: one-time code from the log, only as long as there is no user
  const setup = { token: null };
  if (users.count() === 0) {
    setup.token = process.env.WOMN_SETUP_TOKEN || randomToken(9);
    const bar = '='.repeat(64);
    const where = config.baseUrl || `https://<address of this server>:${config.httpsPort}`;
    console.log(`\n${bar}\n  WhatsOnMyNet - Ersteinrichtung / initial setup\n  Einrichtungscode / setup code:  ${setup.token}\n  ${where}/setup\n${bar}\n`);
  }

  const sensorChoices = createSensorChoices({ db, settings });
  const ctx = { db, settings, sensorChoices, sessions, users, inventory, locations, scanner, mailer, limiter, setup, tls, channels, maintenance, monitoring, nightly, printers, dockerHosts, snmpDevices, hosts, directory, agents, reports, proxmox, backups,
    // replaced by server.js: loads a new certificate into the running HTTPS server
    applyTls: () => {} };

  const app = express();
  app.disable('x-powered-by');
  ctx.trustProxy = applyTrustProxy(app, config.trustProxy);

  // Plain HTTP port: only redirects to HTTPS (a trusted reverse proxy is served)
  if (!plainHttp) {
    const httpPort = httpPortMiddleware(app, { baseUrl: config.baseUrl, httpsPort: config.httpsPort });
    app.use((req, res, next) => (req.socket.encrypted ? next() : httpPort(req, res, next)));
  }

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // HSTS: see https.js (never with a self-signed certificate)
    strictTransportSecurity: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use(directHstsMiddleware({ hsts: config.hsts, certSource: () => tls?.describe()?.source }));
  const proxy = proxyHttpsMiddleware(app, { baseUrl: config.baseUrl, hsts: config.hsts, hosts: createHttpsHosts(paths.httpsHosts) });
  if (proxy) app.use(proxy);

  app.get('/healthz', (_req, res) => {
    try { db.prepare('SELECT 1').get(); res.json({ ok: true, version: config.version }); }
    catch { res.status(503).json({ ok: false }); }
  });

  app.use(parseCookies);
  app.use(sessions.middleware);
  // Scan agents send larger result lists (own limit on that route)
  const jsonBody = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path === '/api/agent/results' ? next() : jsonBody(req, res, next)));
  app.use((req, _res, next) => { if (!req.body || typeof req.body !== 'object') req.body = {}; next(); });

  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Upper limit per address: generous for the interface (it polls every few seconds), stops scripted floods
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler: (_req, _res, next) => next(new HttpError(429, 'err.rateLimit')),
  }));
  // CSRF protection: writing API calls need a custom header (only sent cross-site after a CORS grant - none exists)
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-WOMN-Request') !== '1') return next(new HttpError(403, 'err.csrf'));
    next();
  });
  app.use('/api', createApi(ctx));
  app.use('/api', createMonitoringApi(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'err.notFound')));

  // Static files + single-page app (always revalidated: after an update the new interface arrives at once)
  app.use(express.static(config.publicDir, { index: false, redirect: false, maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  const indexHtml = path.join(config.publicDir, 'index.html');
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const lang = normalizeLang(req.user?.language || langFromHeader(req.get('accept-language')));
    let status = err.status || err.statusCode || 500;
    let code = err instanceof HttpError ? err.code : (status === 400 ? 'err.badRequest' : 'err.internal');
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') { status = err.type === 'entity.too.large' ? 413 : 400; code = 'err.badRequest'; }
    if (status >= 500 && !(err instanceof HttpError)) log.error(`${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    res.status(status).json({ error: { code, message: hasKey(code) ? t(lang, code, { detail: err.detail ?? '' }) : code, detail: err.detail } });
  });

  return { app, ctx };
}
