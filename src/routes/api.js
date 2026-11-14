// REST API of the web interface.
import crypto from 'node:crypto';
import express from 'express';
import { SCRIPT_KINDS, uninstallScript } from '../hostscripts.js';
import os from 'node:os';
import { config } from '../config.js';
import { HttpError, line, str, int, ids, oneOf } from '../lib/http.js';
import { safeEqual } from '../lib/crypto.js';
import { requireAuth, requireRole, can } from '../auth/session.js';
import { localInterfaces, defaultGateways, parseCidr, cidrContains, scanTargetAllowed } from '../lib/net.js';
import { pingAvailable } from '../scan/probes.js';
import { TYPES } from '../scan/classify.js';
import { validTime } from '../scan/nightly.js';
import { plainName, DEFAULT_FILTER } from '../auth/directory.js';
import { otpauthUri, qrSvg } from '../auth/totp.js';
import { scopeOf, inScope, deviceInScope, requireUnscoped } from '../auth/scope.js';
import { buildTopology } from '../topology.js';
import { metricsFor } from '../monitor/sensors.js';
import { SERVICE_NAMES, GENTLE_PORTS } from '../scan/ports.js';
import { toCsv } from '../inventory.js';
import { t } from '../i18n.js';
import { log } from '../lib/log.js';
import { keyPin } from '../tls.js';

const parse = (s, def = {}) => { try { return JSON.parse(s); } catch { return def; } };

export function createApi(ctx) {
  const { db, users, sessions, limiter, settings, inventory, locations, scanner, mailer, tls, setup } = ctx;
  const r = express.Router();
  const editor = requireRole('editor');
  const admin = requireRole('admin');
  const who = (req) => req.user?.username || '';
  const audit = (req, action, detail = '') => {
    db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), who(req), action, String(detail).slice(0, 500));
  };
  // The user for the browser, with the location limit (null = all locations)
  const userOut = (u) => { const sc = scopeOf(db, u); return { ...publicUser(u), locations: sc ? [...sc] : null }; };
  const idParam = (req) => {
    const n = int(req.params.id);
    if (!n || n < 1) throw new HttpError(404, 'err.notFound');
    return n;
  };

  // --- Public ---------------------------------------------------------------------------------------------

  r.get('/bootstrap', (req, res) => {
    res.json({
      setupRequired: users.count() === 0,
      version: config.version,
      title: settings.get('general.title'),
      sourceUrl: config.sourceUrl,
      user: req.user ? userOut(req.user) : null,
    });
  });

  r.post('/setup', (req, res) => {
    if (users.count() > 0 || !setup.token) throw new HttpError(409, 'err.setupDone');
    limiter.check(req.ip, '_setup');
    if (!safeEqual(String(req.body.code || '').trim(), setup.token)) {
      limiter.fail(req.ip, '_setup');
      throw new HttpError(403, 'err.setupCode');
    }
    const u = users.create({ ...req.body, role: 'admin' });
    setup.token = null;
    if (req.body.title) settings.set('general.title', line(req.body.title, 60) || 'WhatsOnMyNet');
    sessions.create(req, res, u.id);
    req.user = u;
    audit(req, 'setup', `admin ${u.username}`);
    log.info(`Initial setup completed - administrator "${u.username}" created`);
    res.json({ user: publicUser(u) });
  });

  r.post('/login', async (req, res) => {
    const name = line(req.body.username, 64);
    const password = str(req.body.password, 1024);
    // One counter per account, whatever way the name is written (FIRMA\carol, OTHER\carol, carol@firma.de, Carol)
    const key = plainName(name).toLowerCase().replace(/@.*$/, '');
    limiter.check(req.ip, key);
    let u = users.authenticate(name, password);
    let counted = false;
    // Active Directory: only for names that are not a local account (a local admin can never be taken over)
    if (!u && ctx.directory.enabled() && users.sourceOf(plainName(name)) !== 'local' && users.sourceOf(name) !== 'local') {
      // Counted before asking the directory: many requests at the same time must not all get past the limit
      // while the domain controller is still answering the first one
      limiter.fail(req.ip, key);
      counted = true;
      try {
        const info = await ctx.directory.verify(name, password);
        if (!info.role) {
          // To the outside like a wrong password: otherwise the sign-in page would tell whether an AD password is right
          log.warn(`Directory sign-in of "${name}" refused: in none of the WhatsOnMyNet groups`);
          throw new HttpError(401, 'err.login');
        }
        u = users.upsertDirectory(info);
        if (u) db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), u.username, 'login.ad', `role ${u.role}`);
      } catch (e) {
        // 401 = unknown user or wrong password → normal failed sign-in below; other errors without details
        // (addresses, certificate texts of the domain controller are for the log, not for whoever opens the page)
        if (e.status !== 401) {
          log.warn(`Directory sign-in failed: ${e.detail || e.message}`);
          throw new HttpError(e.status || 502, e.status ? e.code : 'err.internal');
        }
      }
    }
    if (!u) {
      if (!counted) limiter.fail(req.ip, key);
      log.warn(`Failed sign-in for "${name}" from ${req.ip}`);
      throw new HttpError(401, 'err.login');
    }
    if (counted) limiter.undo(req.ip);
    // Second factor: the browser sends name + password again together with the code
    if (u.source === 'local' && u.totp_enabled) {
      const code = str(req.body.code, 40).trim();
      if (!code) throw new HttpError(401, 'err.totpRequired');
      if (!users.checkSecondFactor(u.id, code)) {
        limiter.fail(req.ip, key);
        log.warn(`Wrong second factor for "${name}" from ${req.ip}`);
        throw new HttpError(401, 'err.totpWrong');
      }
    }
    limiter.success(req.ip, key);
    sessions.create(req, res, u.id);
    res.json({ user: userOut(u) });
  });

  // --- Scan agents (own token, no session) -----------------------------------------------------------------
  // Windows/Linux machines with the host script (key of the device or the shared key, no session)
  r.post('/hosts/push', (req, res) => {
    const m = /^Bearer\s+(\S{20,200})$/.exec(String(req.get('authorization') || ''));
    if (!m) throw new HttpError(401, 'err.unauthorized');
    res.json(ctx.hosts.push(m[1], req.body, req.ip));
  });
  // Hyper-V / KVM hosts send their data themselves (token of the host, no session)
  r.post('/proxmox/:id/push', (req, res) => {
    const m = /^Bearer\s+(\S{20,200})$/.exec(String(req.get('authorization') || ''));
    if (!m) throw new HttpError(401, 'err.unauthorized');
    const id = int(req.params.id);
    if (!id || id < 1) throw new HttpError(401, 'err.unauthorized');
    res.json(ctx.proxmox.push(id, m[1], req.body));
  });
  r.get('/agent/poll', (req, res) => res.json(ctx.agents.poll(ctx.agents.authenticate(req))));
  r.post('/agent/results', express.json({ limit: '16mb' }), async (req, res) => {
    const agent = ctx.agents.authenticate(req);
    const out = ctx.agents.report(agent, req.body || {});
    log.info(`Scan agent ${agent.name}: ${out.accepted} device(s)${out.rejected ? `, ${out.rejected} outside its subnets refused` : ''}`);
    await scanner.runFinishedHooks({ id: out.scanId, kind: req.body?.kind === 'light' ? 'light' : 'network', status: 'done' });
    res.json(out);
  });

  r.post('/logout', (req, res) => {
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  // --- Signed in ------------------------------------------------------------------------------------------
  r.use(requireAuth);
  // Admin setting: local administrators must use two-factor sign-in - until set up only the own account works
  const twoFactorRequired = (u) => !!settings.get('security.require2faAdmins') && u.role === 'admin' && u.source === 'local';
  r.use((req, _res, next) => {
    if (!twoFactorRequired(req.user) || req.user.totp_enabled) return next();
    if (/^\/(me(\/|$)|bootstrap$|meta$|logout$)/.test(req.path)) return next();
    next(new HttpError(403, 'err.totpRequiredByAdmin'));
  });
  // Location limit of the user (null = everything); also used by the monitoring routes
  r.use((req, _res, next) => { req.scope = scopeOf(db, req.user); next(); });
  const visible = (req, deviceId) => deviceInScope(db, req.scope, deviceId);
  const seeDeviceId = (req, deviceId) => !req.scope || (deviceId && inScope(req.scope, db.prepare('SELECT location_id FROM devices WHERE id=?').get(deviceId)?.location_id));

  r.get('/me', (req, res) => res.json(userOut(req.user)));

  // Two-factor sign-in of the own account (local accounts)
  r.get('/me/2fa', (req, res) => res.json({ enabled: !!req.user.totp_enabled, available: req.user.source === 'local', recoveryLeft: users.recoveryLeft(req.user.id),
    required: twoFactorRequired(req.user) }));
  r.post('/me/2fa/setup', async (req, res) => {
    const secret = users.startTotp(req.user.id);
    const uri = otpauthUri(secret, req.user.username, settings.get('general.title') || 'WhatsOnMyNet');
    res.json({ secret, uri, svg: await qrSvg(uri) });
  });
  r.post('/me/2fa/enable', (req, res) => {
    limiter.check(req.ip, `2fa:${req.user.username}`);
    try {
      const codes = users.enableTotp(req.user.id, str(req.body.code, 20));
      audit(req, '2fa.enable');
      res.json({ recoveryCodes: codes });
    } catch (e) { limiter.fail(req.ip, `2fa:${req.user.username}`); throw e; }
  });
  // Switching off or new recovery codes: password (and, if on, a code) again
  const recheck = (req) => {
    limiter.check(req.ip, req.user.username);
    if (!users.authenticate(req.user.username, str(req.body.password, 1024))) { limiter.fail(req.ip, req.user.username); throw new HttpError(400, 'err.passwordWrong'); }
    if (req.user.totp_enabled && !users.checkSecondFactor(req.user.id, str(req.body.code, 40))) { limiter.fail(req.ip, req.user.username); throw new HttpError(400, 'err.totpWrong'); }
  };
  r.post('/me/2fa/disable', (req, res) => {
    recheck(req);
    if (twoFactorRequired(req.user)) throw new HttpError(400, 'err.totpRequiredByAdmin');
    users.disableTotp(req.user.id);
    audit(req, '2fa.disable');
    res.json({ ok: true });
  });
  r.post('/me/2fa/recovery', (req, res) => {
    recheck(req);
    audit(req, '2fa.recovery');
    res.json({ recoveryCodes: users.newRecoveryCodes(req.user.id) });
  });
  r.patch('/me', (req, res) => {
    const u = users.update(req.user.id, req.body, { self: true });
    res.json(userOut(u));
  });
  r.post('/me/password', (req, res) => {
    if (req.user.source && req.user.source !== 'local') throw new HttpError(400, 'err.adPassword');
    limiter.check(req.ip, req.user.username);
    if (!users.authenticate(req.user.username, str(req.body.current, 1024))) {
      limiter.fail(req.ip, req.user.username);
      throw new HttpError(400, 'err.passwordWrong');
    }
    users.setPassword(req.user.id, req.body.password);
    sessions.destroyAllForUser(req.user.id, req.sessionId);
    audit(req, 'password.own');
    res.json({ ok: true });
  });

  r.get('/meta', (_req, res) => {
    res.json({ types: TYPES, services: SERVICE_NAMES, gentlePorts: GENTLE_PORTS, printerThreshold: Number(settings.get('printer.threshold')) || 15,
      nasThreshold: Number(settings.get('nas.threshold')) || 90, escalateMin: Number(settings.get('escalate.min')) || 0, escalateChannels: (settings.get('escalate.channels') || []).length });
  });

  r.get('/dashboard', (req, res) => {
    // Limited users: only monitors of their devices
    const mon = ctx.monitoring.summary(req.scope ? (m) => seeDeviceId(req, m.device_id) : null);
    res.json({ ...inventory.stats({ allowed: req.scope }), monitoring: mon,
      printersLow: ctx.printers.low().filter((x) => seeDeviceId(req, x.deviceId)),
      nasProblems: ctx.snmpDevices.problems().filter((x) => seeDeviceId(req, x.deviceId)) });
  });

  r.get('/network', async (_req, res) => {
    const ifaces = localInterfaces();
    res.json({
      hostname: os.hostname(),
      interfaces: ifaces,
      gateways: defaultGateways(),
      pingAvailable: await pingAvailable(),
      // Without host networking Docker only shows its own bridge - then MAC addresses cannot be seen
      hostNetwork: ifaces.some((i) => !i.virtual),
      suggestions: [...new Set(ifaces.filter((i) => !i.virtual && i.prefix >= 20).map((i) => i.cidr))],
    });
  });

  // Devices
  r.get('/devices', (req, res) => {
    const mon = ctx.monitoring.deviceStatus();
    res.json(inventory.list({ q: str(req.query.q, 100), type: str(req.query.type, 30), location: str(req.query.location, 12), tag: str(req.query.tag, 60), allowed: req.scope })
      .map((d) => ({ ...d, monitor: mon[d.id] || null })));
  });
  r.get('/devices/suggestions', (req, res) => res.json(inventory.suggestions(req.scope)));
  r.post('/devices/bulk', editor, (req, res) => {
    const list = ids(req.body.ids, 2000).filter((id) => seeDeviceId(req, id));
    if (req.body.set !== undefined && (!req.body.set || typeof req.body.set !== 'object' || Array.isArray(req.body.set))) throw new HttpError(400, 'err.badRequest');
    if (req.scope && req.body.set && 'location_id' in req.body.set && !inScope(req.scope, req.body.set.location_id)) throw new HttpError(403, 'err.scope');
    const n = inventory.bulkUpdate(list, { set: req.body.set, tagsAdd: req.body.tagsAdd, tagsRemove: req.body.tagsRemove }, who(req));
    if (n) audit(req, 'device.bulkUpdate', `${n} device(s): ${Object.keys(req.body.set || {}).join(', ')}`);
    res.json({ updated: n });
  });
  r.post('/devices/bulk-delete', editor, (req, res) => {
    const n = inventory.bulkRemove(ids(req.body.ids, 2000).filter((id) => seeDeviceId(req, id)));
    if (n) audit(req, 'device.bulkDelete', `${n} device(s)`);
    res.json({ deleted: n });
  });
  r.get('/devices/export.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="whatsonmynet-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(inventory.list({ q: str(req.query.q, 100), type: str(req.query.type, 30), location: str(req.query.location, 12), allowed: req.scope })));
  });
  r.get('/devices/export.json', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="whatsonmynet-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exported: new Date().toISOString(), version: config.version,
      devices: inventory.list({ allowed: req.scope }).map((d) => ({ ...d, facts: inventory.get(d.id)?.facts })) });
  });
  r.get('/devices/:id', (req, res) => {
    visible(req, idParam(req));
    const d = inventory.get(idParam(req));
    if (!d) throw new HttpError(404, 'err.notFound');
    const presence = inventory.list({}).find((x) => x.id === d.id)?.presence || 'unknown';
    const monitors = db.prepare('SELECT id FROM monitors WHERE device_id=? ORDER BY name').all(d.id).map((m) => ctx.monitoring.get(m.id));
    res.json({ ...d, presence, monitors, printer: d.type === 'printer' ? ctx.printers.status(d.id) : null, host: ctx.hosts.report(d.id), hardware: ctx.proxmox.hardwareOf(d.id), hasSensors: ctx.sensorChoices.hasValues(d.id, { withHosts: !req.scope }),
      hostScript: req.user.role === 'admin' ? ctx.hosts.list().find((t) => t.device_id === d.id) || null : undefined,
      snmp: ['switch', 'nas', 'ups'].includes(d.type) ? ctx.snmpDevices.status(d.id) : null, plugged: d.mac ? ctx.snmpDevices.locate(d.mac) : null, history: inventory.historyOf(d.id) });
  });
  r.post('/devices', editor, (req, res) => {
    if (req.scope && !inScope(req.scope, req.body.location_id)) throw new HttpError(403, 'err.scope');
    const d = inventory.create(req.body, who(req));
    audit(req, 'device.create', d.name);
    res.status(201).json(d);
  });
  r.patch('/devices/:id', editor, (req, res) => {
    visible(req, idParam(req));
    if (req.scope && 'location_id' in req.body && !inScope(req.scope, req.body.location_id)) throw new HttpError(403, 'err.scope');
    res.json(inventory.update(idParam(req), req.body, who(req)));
  });
  r.delete('/devices/:id', editor, (req, res) => {
    const id = idParam(req);
    visible(req, id);
    const d = inventory.get(id);
    inventory.remove(id);
    audit(req, 'device.delete', d?.name);
    res.json({ ok: true });
  });
  // Editors scan only private ranges and the subnets of the locations; public addresses only administrators
  const checkScanTargets = (req, cidrs) => {
    if (req.user.role === 'admin') return;
    const subnets = db.prepare('SELECT cidr FROM subnets').all().map((x) => x.cidr);
    const bad = cidrs.find((c) => parseCidr(c) && !scanTargetAllowed(c, subnets));
    if (bad) throw new HttpError(403, 'err.publicScan', String(bad).slice(0, 40));
  };
  r.post('/devices/:id/deep', editor, (req, res) => {
    visible(req, idParam(req));
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(idParam(req));
    if (!d) throw new HttpError(404, 'err.notFound');
    if (d.ip) checkScanTargets(req, [d.ip]);
    const id = scanner.startDeep(d, who(req));
    audit(req, 'scan.deep', `${d.name} (${d.ip})`);
    res.status(202).json({ id });
  });

  r.post('/devices/:id/printer', editor, async (req, res) => {
    const id = idParam(req);
    visible(req, id);
    if (!db.prepare("SELECT 1 FROM devices WHERE id=? AND type='printer'").get(id)) throw new HttpError(404, 'err.notFound');
    res.json(await ctx.printers.poll(id));
  });

  // Values of a device that a sensor can watch (from the latest printer/switch/NAS query)
  r.get('/devices/:id/sensors', (req, res) => {
    visible(req, idParam(req));
    res.json(metricsFor(db, idParam(req), { printerThreshold: Number(settings.get('printer.threshold')) || 15, nasThreshold: Number(settings.get('nas.threshold')) || 90 }));
  });
  r.post('/devices/:id/snmp', editor, async (req, res) => { visible(req, idParam(req)); res.json(await ctx.snmpDevices.poll(idParam(req))); });

  r.get('/topology', (req, res) => res.json(buildTopology(db, { allowed: req.scope })));

  // Nightly light scan: start now (same as at night, all subnets of all locations)
  r.post('/lightscan/run', editor, (req, res) => {
    requireUnscoped(req);
    const id = ctx.nightly.run(who(req));
    if (!id) throw new HttpError(400, 'err.noSubnets');
    audit(req, 'scan.light');
    res.status(202).json({ id });
  });

  // Scans
  // A limited user sees scans that only touched his locations (deep checks: of his devices)
  const scanVisible = (req, s) => {
    if (!req.scope) return true;
    const t = parse(s.targets, []);
    if (s.kind === 'deep') return t.every((x) => seeDeviceId(req, x.deviceId));
    return t.length > 0 && t.every((x) => inScope(req.scope, x.locationId));
  };
  r.get('/scans', (req, res) => {
    res.json(db.prepare(`SELECT * FROM scans ORDER BY id DESC LIMIT ${req.scope ? 500 : 30}`).all().filter((s) => scanVisible(req, s)).slice(0, 30).map((s) => ({ ...s, targets: parse(s.targets, []), stats: parse(s.stats),
      counts: db.prepare('SELECT status, COUNT(*) n FROM scan_results WHERE scan_id=? GROUP BY status').all(s.id) })));
  });
  r.get('/scans/:id', (req, res) => {
    const id = idParam(req);
    const s = db.prepare('SELECT * FROM scans WHERE id=?').get(id);
    if (!s || !scanVisible(req, s)) throw new HttpError(404, 'err.notFound');
    // outdated: a newer scan covered the address - the result can be looked at, but not adopted or ignored
    const outdated = inventory.outdatedResults(id);
    const results = db.prepare(`SELECT r.*, d.name device_name, d.type device_type, l.name location_name FROM scan_results r
      LEFT JOIN devices d ON d.id=r.device_id LEFT JOIN locations l ON l.id=r.location_id WHERE r.scan_id=?`).all(id)
      .filter((x) => inScope(req.scope, x.location_id))
      .map((x) => ({ ...x, facts: parse(x.facts), outdated: outdated.has(x.id) }));
    res.json({ ...s, targets: parse(s.targets, []), stats: parse(s.stats), progress: scanner.progress(id), results });
  });
  r.post('/scans', editor, (req, res) => {
    const locIds = ids(req.body.locationIds, 100);
    const cidrs = Array.isArray(req.body.cidrs) ? req.body.cidrs.slice(0, 32).map((c) => line(c, 40)).filter(Boolean) : [];
    // Limited users scan only the subnets of their locations
    if (req.scope && (cidrs.length || locIds.some((l) => !req.scope.has(l)))) throw new HttpError(403, 'err.scope');
    checkScanTargets(req, cidrs);
    const targets = [
      ...locations.targets(locIds),
      ...cidrs.map((c) => ({ cidr: c, locationId: (parseCidr(c) && locations.locationForCidr(parseCidr(c).cidr)) || null })),
    ];
    // Locations with a scan agent: the agent scans there (ARP only works inside the network)
    const agentJobs = [];
    for (const l of locIds) {
      const name = ctx.agents.jobForLocation(l, 'network', who(req));
      if (name) agentJobs.push(name);
    }
    const local = targets.filter((x) => !(x.locationId && locIds.includes(x.locationId) && ctx.agents.hasAgent(x.locationId)));
    if (agentJobs.length) audit(req, 'scan.agent', agentJobs.join(', '));
    if (!local.length && agentJobs.length) return res.status(202).json({ id: null, agentJobs });
    const id = scanner.startNetwork(local, who(req));
    audit(req, 'scan.start', local.map((x) => x.cidr).join(', '));
    res.status(202).json({ id, agentJobs });
  });
  r.post('/scans/:id/cancel', editor, (req, res) => {
    const s = db.prepare('SELECT * FROM scans WHERE id=?').get(idParam(req));
    if (!s || !scanVisible(req, s)) throw new HttpError(404, 'err.notFound');
    res.json({ ok: scanner.cancel(idParam(req)) });
  });
  r.post('/scans/:id/adopt', editor, (req, res) => {
    const scanId = idParam(req);
    const resultIds = ids(req.body.ids).filter((x) => { const r0 = db.prepare('SELECT location_id FROM scan_results WHERE id=? AND scan_id=?').get(x, scanId); return r0 && inScope(req.scope, r0.location_id); });
    const overrides = {};
    const raw = req.body.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {};
    for (const rid of resultIds) {
      const o = raw[rid];
      if (o && typeof o === 'object') overrides[rid] = { type: oneOf(o.type, TYPES, undefined), name: line(o.name, 120) };
    }
    const created = inventory.adopt(resultIds, overrides, who(req));
    if (created.length) audit(req, 'inventory.adopt', `${created.length} device(s) from scan ${scanId}`);
    res.json({ created });
  });
  r.post('/scans/:id/ignore', editor, (req, res) => {
    const scanId = idParam(req);
    const resultIds = ids(req.body.ids).filter((x) => { const r0 = db.prepare('SELECT location_id FROM scan_results WHERE id=? AND scan_id=?').get(x, scanId); return r0 && inScope(req.scope, r0.location_id); });
    const n = inventory.ignore(resultIds, who(req));
    if (n) audit(req, 'inventory.ignore', `${n} device(s) from scan ${scanId}`);
    res.json({ ignored: n });
  });
  r.post('/scans/:id/unignore', editor, (req, res) => {
    const scanId = idParam(req);
    const resultIds = ids(req.body.ids).filter((x) => { const r0 = db.prepare('SELECT location_id FROM scan_results WHERE id=? AND scan_id=?').get(x, scanId); return r0 && inScope(req.scope, r0.location_id); });
    const n = inventory.unignore(resultIds);
    if (n) audit(req, 'inventory.unignore', `${n} device(s) from scan ${scanId}`);
    res.json({ unignored: n });
  });

  // A user limited to locations only sees entries in the subnets of his locations (the list carries addresses and
  // names of devices of every location)
  r.get('/ignored', (req, res) => {
    const rows = db.prepare('SELECT * FROM ignored ORDER BY created_at DESC').all();
    if (!req.scope) return res.json(rows);
    const nets = db.prepare('SELECT cidr, location_id FROM subnets').all().filter((s) => inScope(req.scope, s.location_id)).map((s) => parseCidr(s.cidr)).filter(Boolean);
    res.json(rows.filter((x) => x.ip && nets.some((c) => cidrContains(c, x.ip))));
  });
  r.delete('/ignored/:id', editor, (req, res) => {
    requireUnscoped(req);
    if (!db.prepare('DELETE FROM ignored WHERE id=?').run(idParam(req)).changes) throw new HttpError(404, 'err.notFound');
    res.json({ ok: true });
  });

  // Locations
  r.get('/locations', (req, res) => res.json(locations.list().filter((l) => inScope(req.scope, l.id))));
  r.post('/locations', admin, (req, res) => { const l = locations.create(req.body); audit(req, 'location.create', l.name); res.status(201).json(l); });
  r.put('/locations/:id', admin, (req, res) => { const l = locations.update(idParam(req), req.body); audit(req, 'location.update', l.name); res.json(l); });
  r.delete('/locations/:id', admin, (req, res) => { locations.remove(idParam(req)); audit(req, 'location.delete', req.params.id); res.json({ ok: true }); });

  // Planned reports (admin): neutral mails, e.g. printer supplies for the office
  r.get('/reports', admin, (_req, res) => res.json(ctx.reports.list()));
  r.get('/reports/candidates', admin, (_req, res) => res.json(ctx.reports.candidates()));
  r.post('/reports', admin, (req, res) => { const x = ctx.reports.create(req.body); audit(req, 'report.create', x.name); res.status(201).json(x); });
  r.put('/reports/:id', admin, (req, res) => { const x = ctx.reports.update(idParam(req), req.body); audit(req, 'report.update', x.name); res.json(x); });
  r.delete('/reports/:id', admin, (req, res) => { ctx.reports.remove(idParam(req)); audit(req, 'report.delete', req.params.id); res.json({ ok: true }); });
  // Preview as the recipients see it (own CSP: the mail has inline styles, nothing else is allowed)
  r.get('/reports/:id/preview', admin, (req, res) => {
    const x = ctx.reports.get(idParam(req));
    if (!x) throw new HttpError(404, 'err.notFound');
    const m = ctx.reports.render(x);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.type('html').send(m.html);
  });
  r.post('/reports/:id/send', admin, async (req, res) => {
    const to = req.body.test ? line(req.user.email, 254) : null;
    if (req.body.test && !to) throw new HttpError(400, 'err.email');
    const m = await ctx.reports.send(idParam(req), { to });
    audit(req, 'report.send', `${req.params.id}${to ? ` (test to ${to})` : ''}`);
    res.json({ ok: true, count: m.count, attention: m.attention });
  });

  // Backup and restore (admin)
  r.get('/backups', admin, (_req, res) => res.json({ list: ctx.backups.list(), keep: settings.get('backup.keep') }));
  r.post('/backups', admin, async (req, res) => { const name = await ctx.backups.create(); audit(req, 'backup.create', name); res.json({ name }); });
  r.get('/backups/download', admin, async (req, res) => {
    const f = await ctx.backups.snapshot();
    audit(req, 'backup.download');
    // Removed after sending, on an error and when the browser aborts (close fires in every case)
    let gone = false;
    const drop = () => { if (!gone) { gone = true; ctx.backups.discard(f); } };
    res.once('close', drop);
    // dotfiles: the data directory may lie below a folder whose name starts with a dot (the path is our own)
    res.download(f, `whatsonmynet-${new Date().toISOString().slice(0, 10)}.sqlite`, { dotfiles: 'allow' }, (err) => {
      drop();
      if (err && !res.headersSent) res.status(500).json({ error: { code: 'err.internal', message: t(req.user?.language, 'err.internal') } });
    });
  });
  r.get('/backups/file/:name', admin, (req, res) => { audit(req, 'backup.download', req.params.name); res.download(ctx.backups.file(req.params.name), req.params.name, { dotfiles: 'allow' }); });
  // Restore: the confirmation header protects against a click by mistake (and the CSRF header against other sites)
  const confirmRestore = (req) => { if (req.get('X-WOMN-Confirm') !== 'restore') throw new HttpError(400, 'err.backupConfirm'); };
  r.post('/backups/restore', admin, express.raw({ type: 'application/octet-stream', limit: '2gb' }), async (req, res) => {
    confirmRestore(req);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'err.backupFile');
    const info = await ctx.backups.restore({ buffer: req.body });
    audit(req, 'backup.restore', `upload (${info.devices} devices)`);
    res.json({ ok: true, ...info });
  });
  r.post('/backups/file/:name/restore', admin, async (req, res) => {
    confirmRestore(req);
    const info = await ctx.backups.restore({ name: req.params.name });
    audit(req, 'backup.restore', req.params.name);
    res.json({ ok: true, ...info });
  });

  // Scan agents (admin)
  r.get('/agents', admin, (_req, res) => res.json(ctx.agents.list()));
  r.post('/agents', admin, (req, res) => { const a = ctx.agents.create(req.body); audit(req, 'agent.create', `${a.name} (${a.location_name})`); res.status(201).json(a); });
  r.put('/agents/:id', admin, (req, res) => { const a = ctx.agents.update(idParam(req), req.body); audit(req, 'agent.update', a.name); res.json(a); });
  r.post('/agents/:id/token', admin, (req, res) => { const a = ctx.agents.newToken(idParam(req)); audit(req, 'agent.token', a.name); res.json(a); });
  r.delete('/agents/:id', admin, (req, res) => { ctx.agents.remove(idParam(req)); audit(req, 'agent.delete', req.params.id); res.json({ ok: true }); });
  r.post('/agents/:id/scan', admin, (req, res) => {
    const a = ctx.agents.get(idParam(req));
    if (!a) throw new HttpError(404, 'err.notFound');
    ctx.agents.jobForLocation(a.location_id, req.body.kind === 'light' ? 'light' : 'network', who(req));
    audit(req, 'scan.agent', a.name);
    res.status(202).json({ ok: true });
  });
  // Host scripts (Windows/Linux): keys and scripts for admins; the uninstall scripts hold no secret
  const pinOf = () => {
    const pin = {};
    const pem = String(tls?.current()?.cert || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (pem && tls?.describe()?.source !== 'custom') {
      const c = new crypto.X509Certificate(pem);
      pin.sha1 = c.fingerprint.replace(/:/g, '');
      pin.spki = crypto.createHash('sha256').update(c.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
      pin.key = keyPin(c.publicKey);
    }
    return pin;
  };
  r.get('/hosts/devices', editor, (_req, res) => res.json(ctx.hosts.deviceIds()));
  r.get('/hosts', admin, (_req, res) => res.json({ tokens: ctx.hosts.list(), unmatched: ctx.hosts.unmatched() }));
  r.post('/hosts', admin, (req, res) => {
    const out = ctx.hosts.create(req.body, { server: str(req.body?.server, 300), pin: pinOf() });
    audit(req, 'host.script', `${out.name} (${out.os})`);
    res.status(201).json(out);
  });
  r.post('/hosts/:id/renew', admin, (req, res) => { const out = ctx.hosts.renew(idParam(req), { server: str(req.body?.server, 300), pin: pinOf() }); audit(req, 'host.renew', out.name); res.json(out); });
  r.delete('/hosts/:id', admin, (req, res) => { ctx.hosts.remove(idParam(req)); audit(req, 'host.delete', req.params.id); res.json({ ok: true }); });
  r.delete('/hosts/unmatched/:name', admin, (req, res) => { ctx.hosts.forgetUnmatched(req.params.name); res.json({ ok: true }); });
  r.get('/hosts/uninstall/:kind', editor, (req, res) => {
    if (!SCRIPT_KINDS.includes(req.params.kind)) throw new HttpError(404, 'err.notFound');
    res.json(uninstallScript(req.params.kind));
  });
  // Certificate of this server for the scan agents (public anyway: every browser gets it)
  r.get('/tls/agent-ca', admin, (_req, res) => {
    const pem = String(tls?.current()?.cert || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0] || '';
    res.json({ ca: pem ? Buffer.from(`${pem}\n`).toString('base64') : '', source: tls?.describe()?.source || '' });
  });

  // --- Administration ---------------------------------------------------------------------------------------
  r.get('/settings', admin, (_req, res) => {
    res.json({ security: { require2faAdmins: !!settings.get('security.require2faAdmins') }, general: settings.publicGroup('general'), scan: settings.publicGroup('scan'), smtp: settings.publicGroup('smtp'), backup: settings.publicGroup('backup'),
      lightscan: { ...settings.publicGroup('lightscan'), last: ctx.nightly.lastLight() }, printer: settings.publicGroup('printer'),
      snmpdev: settings.publicGroup('snmpdev'), nas: settings.publicGroup('nas'), escalate: settings.publicGroup('escalate') });
  });
  r.put('/settings/escalate', admin, (req, res) => {
    const b = req.body;
    if ('min' in b) settings.set('escalate.min', Math.min(1440, Math.max(0, int(String(b.min)) || 0)));
    if ('channels' in b) settings.set('escalate.channels', channelIds(b.channels));
    audit(req, 'settings.escalate');
    res.json(settings.publicGroup('escalate'));
  });
  r.put('/settings/general', admin, (req, res) => {
    settings.set('general.title', line(req.body.title, 60) || 'WhatsOnMyNet');
    audit(req, 'settings.general');
    res.json(settings.publicGroup('general'));
  });
  r.put('/settings/scan', admin, (req, res) => {
    const b = req.body;
    if ('ping' in b) settings.set('scan.ping', !!b.ping);
    if ('snmp' in b) settings.set('scan.snmp', !!b.snmp);
    if ('httpTitles' in b) settings.set('scan.httpTitles', !!b.httpTitles);
    if ('routerArp' in b) settings.set('scan.routerArp', !!b.routerArp);
    if ('rate' in b) settings.set('scan.rate', Math.min(200, Math.max(5, int(String(b.rate)) || 40)));
    if ('keepScans' in b) settings.set('scan.keepScans', Math.min(500, Math.max(3, int(String(b.keepScans)) || 20)));
    // Communities: only replaced when a new value is sent (empty string = back to "public")
    if (typeof b.snmpCommunities === 'string') {
      const list = b.snmpCommunities.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 5).map((s) => s.slice(0, 64));
      settings.set('scan.snmpCommunities', list.join('\n'));
    }
    audit(req, 'settings.scan');
    res.json(settings.publicGroup('scan'));
  });
  const channelIds = (v) => (Array.isArray(v) ? v : []).map((x) => int(String(x))).filter((x) => x > 0)
    .filter((x) => db.prepare('SELECT 1 FROM channels WHERE id=?').get(x)).slice(0, 20);
  r.put('/settings/lightscan', admin, (req, res) => {
    const b = req.body;
    if ('enabled' in b) settings.set('lightscan.enabled', !!b.enabled);
    if ('time' in b) {
      if (!validTime(b.time)) throw new HttpError(400, 'err.time');
      settings.set('lightscan.time', b.time);
    }
    if ('notify' in b) settings.set('lightscan.notify', !!b.notify);
    if ('channels' in b) settings.set('lightscan.channels', channelIds(b.channels));
    audit(req, 'settings.lightscan');
    res.json({ ...settings.publicGroup('lightscan'), last: ctx.nightly.lastLight() });
  });
  r.put('/settings/printer', admin, (req, res) => {
    const b = req.body;
    if ('enabled' in b) settings.set('printer.enabled', !!b.enabled);
    if ('interval' in b) settings.set('printer.interval', Math.min(1440, Math.max(5, int(String(b.interval)) || 60)));
    if ('threshold' in b) settings.set('printer.threshold', Math.min(50, Math.max(1, int(String(b.threshold)) || 15)));
    if ('notify' in b) settings.set('printer.notify', !!b.notify);
    if ('channels' in b) settings.set('printer.channels', channelIds(b.channels));
    audit(req, 'settings.printer');
    res.json(settings.publicGroup('printer'));
  });
  r.put('/settings/snmpdev', admin, (req, res) => {
    const b = req.body;
    if ('enabled' in b) settings.set('snmpdev.enabled', !!b.enabled);
    if ('interval' in b) settings.set('snmpdev.interval', Math.min(1440, Math.max(5, int(String(b.interval)) || 15)));
    if ('threshold' in b) settings.set('nas.threshold', Math.min(99, Math.max(50, int(String(b.threshold)) || 90)));
    if ('notify' in b) settings.set('nas.notify', !!b.notify);
    if ('channels' in b) settings.set('nas.channels', channelIds(b.channels));
    audit(req, 'settings.snmpdev');
    res.json({ ...settings.publicGroup('snmpdev'), nas: settings.publicGroup('nas') });
  });
  // Active Directory / LDAP
  r.get('/settings/ad', admin, (_req, res) => res.json(adPublic()));
  r.put('/settings/ad', admin, (req, res) => {
    ctx.directory.save(req.body);
    audit(req, 'settings.ad', ctx.directory.config().enabled ? 'on' : 'off');
    res.json(adPublic());
  });
  // Test: service account + search; with a password also the user's own sign-in. Shows groups and the resulting role.
  // Test with the values of the form (also unsaved): every step with its result
  r.post('/settings/ad/test', admin, async (req, res) => {
    const username = line(req.body.username, 120);
    const out = await ctx.directory.test(req.body.settings || {}, username, str(req.body.password, 1024));
    audit(req, 'settings.ad.test', username || '-');
    res.json(out);
  });
  const adPublic = () => {
    const { bindPassword, ca, ...cfg } = ctx.directory.config();
    return { ...cfg, bindPassword: { set: !!bindPassword }, cert: ctx.directory.certInfo(ca), defaultFilter: DEFAULT_FILTER, userFilter: settings.get('ad.userFilter') || '' };
  };
  // TLS certificate of the domain controller: fetch (not trusted yet), confirm (store; root CA from AD), remove
  r.post('/settings/ad/cert/fetch', admin, async (req, res) => {
    res.json(await ctx.directory.fetchCert(req.body || {}));
  });
  r.put('/settings/ad/cert', admin, async (req, res) => {
    const out = await ctx.directory.confirmCert(req.body || {});
    audit(req, 'settings.ad.cert', out.certs.map((c) => `${c.cn} ${c.fingerprint256.slice(0, 23)}`).join('; ').slice(0, 400));
    res.json(out);
  });
  r.delete('/settings/ad/cert', admin, (req, res) => {
    const out = ctx.directory.removeCert();
    audit(req, 'settings.ad.cert', 'removed');
    res.json(out);
  });
  r.put('/settings/smtp', admin, (req, res) => {
    const b = req.body;
    settings.set('smtp.host', line(b.host, 253));
    settings.set('smtp.port', Math.min(65535, Math.max(1, int(String(b.port)) || 587)));
    settings.set('smtp.security', oneOf(b.security, ['starttls', 'tls', 'none'], 'starttls'));
    settings.set('smtp.user', line(b.user, 254));
    if (typeof b.password === 'string' && b.password !== '') settings.set('smtp.password', b.password.slice(0, 512));
    if (b.clearPassword) settings.set('smtp.password', '');
    const from = line(b.from, 254);
    if (from && !/^([^<>]*<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(from)) throw new HttpError(400, 'err.email');
    settings.set('smtp.from', from);
    settings.set('smtp.allowSelfSigned', !!b.allowSelfSigned);
    audit(req, 'settings.smtp');
    res.json(settings.publicGroup('smtp'));
  });
  r.post('/settings/smtp/test', admin, async (req, res) => {
    const to = line(req.body.to, 254) || req.user.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'err.email');
    const lang = req.user.language;
    await mailer.send({ to, subject: t(lang, 'mail.testSubject'), text: t(lang, 'mail.testBody', { detail: `${os.hostname()} (${config.version})` }) });
    audit(req, 'settings.smtp.test', to);
    res.json({ ok: true });
  });
  r.put('/settings/backup', admin, (req, res) => {
    settings.set('backup.keep', Math.min(90, Math.max(1, int(String(req.body.keep)) || 7)));
    res.json(settings.publicGroup('backup'));
  });

  // HTTPS certificate
  r.get('/tls', admin, (_req, res) => res.json(tls.describe()));
  r.post('/tls', admin, express.json({ limit: '1mb' }), async (req, res) => {
    const b = req.body || {};
    let pfx = null;
    if (typeof b.pfx === 'string' && b.pfx) {
      pfx = Buffer.from(b.pfx, 'base64');
      if (!pfx.length || pfx.length > 512 * 1024) throw new HttpError(400, 'err.tlsBadPfx');
    }
    const info = await tls.installCustom({ certPem: str(b.cert, 200000), keyPem: str(b.key, 100000), pfx, passphrase: str(b.passphrase, 512) });
    ctx.applyTls();
    audit(req, 'tls.upload', info.subject);
    res.json(info);
  });
  r.post('/tls/self-signed', admin, async (req, res) => {
    const info = await tls.resetToSelfSigned();
    ctx.applyTls();
    audit(req, 'tls.selfsigned');
    res.json(info);
  });

  // Users
  r.get('/users', admin, (_req, res) => res.json(users.list()));
  r.post('/users', admin, (req, res) => {
    const u = users.create(req.body);
    audit(req, 'user.create', `${u.username} (${u.role})`);
    res.status(201).json(u);
  });
  r.patch('/users/:id', admin, (req, res) => {
    const id = idParam(req);
    const u = users.update(id, req.body);
    if (!u.active) sessions.destroyAllForUser(id);
    audit(req, 'user.update', `${u.username} (${u.role}${u.active ? '' : ', inactive'})`);
    res.json(u);
  });
  // Admin: switch off the two-factor sign-in of an account (lost phone and codes)
  r.delete('/users/:id/2fa', admin, (req, res) => {
    const id = idParam(req);
    users.disableTotp(id);
    sessions.destroyAllForUser(id);
    audit(req, '2fa.reset', String(id));
    res.json({ ok: true });
  });
  r.put('/settings/security', admin, (req, res) => {
    if (req.body.require2faAdmins && !req.user.totp_enabled && req.user.source === 'local') throw new HttpError(400, 'err.totpOwnFirst');
    settings.set('security.require2faAdmins', !!req.body.require2faAdmins);
    audit(req, 'settings.security');
    res.json({ require2faAdmins: !!settings.get('security.require2faAdmins') });
  });
  r.post('/users/:id/password', admin, (req, res) => {
    const id = idParam(req);
    users.setPassword(id, req.body.password);
    sessions.destroyAllForUser(id, id === req.user.id ? req.sessionId : null);
    audit(req, 'user.password', String(id));
    res.json({ ok: true });
  });
  r.delete('/users/:id', admin, (req, res) => {
    const id = idParam(req);
    if (id === req.user.id) throw new HttpError(400, 'err.deleteSelf');
    users.remove(id);
    audit(req, 'user.delete', String(id));
    res.json({ ok: true });
  });

  r.get('/audit', admin, (_req, res) => res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all()));

  return r;
}

export function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, email: u.email, role: u.role, language: u.language,
    theme: u.theme, source: u.source || 'local', totp: !!u.totp_enabled, canEdit: can(u, 'editor'), isAdmin: can(u, 'admin') };
}
