// REST API of the web interface.
import express from 'express';
import os from 'node:os';
import { config } from '../config.js';
import { HttpError, line, str, int, ids, oneOf } from '../lib/http.js';
import { safeEqual } from '../lib/crypto.js';
import { requireAuth, requireRole, can } from '../auth/session.js';
import { localInterfaces, defaultGateways, parseCidr } from '../lib/net.js';
import { pingAvailable } from '../scan/probes.js';
import { TYPES } from '../scan/classify.js';
import { validTime } from '../scan/nightly.js';
import { SERVICE_NAMES, GENTLE_PORTS } from '../scan/ports.js';
import { toCsv } from '../inventory.js';
import { t } from '../i18n.js';
import { log } from '../lib/log.js';

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
      user: req.user ? publicUser(req.user) : null,
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
    log.info(`Initial setup completed – administrator "${u.username}" created`);
    res.json({ user: publicUser(u) });
  });

  r.post('/login', (req, res) => {
    const name = line(req.body.username, 64);
    limiter.check(req.ip, name);
    const u = users.authenticate(name, str(req.body.password, 1024));
    if (!u) {
      limiter.fail(req.ip, name);
      log.warn(`Failed sign-in for "${name}" from ${req.ip}`);
      throw new HttpError(401, 'err.login');
    }
    limiter.success(req.ip, name);
    sessions.create(req, res, u.id);
    res.json({ user: publicUser(u) });
  });

  r.post('/logout', (req, res) => {
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  // --- Signed in ------------------------------------------------------------------------------------------
  r.use(requireAuth);

  r.get('/me', (req, res) => res.json(publicUser(req.user)));
  r.patch('/me', (req, res) => {
    const u = users.update(req.user.id, req.body, { self: true });
    res.json(publicUser(u));
  });
  r.post('/me/password', (req, res) => {
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
    res.json({ types: TYPES, services: SERVICE_NAMES, gentlePorts: GENTLE_PORTS, printerThreshold: Number(settings.get('printer.threshold')) || 15 });
  });

  r.get('/dashboard', (_req, res) => {
    res.json({ ...inventory.stats(), monitoring: ctx.monitoring.summary(), printersLow: ctx.printers.low() });
  });

  r.get('/network', async (_req, res) => {
    const ifaces = localInterfaces();
    res.json({
      hostname: os.hostname(),
      interfaces: ifaces,
      gateways: defaultGateways(),
      pingAvailable: await pingAvailable(),
      // Without host networking Docker only shows its own bridge – then MAC addresses cannot be seen
      hostNetwork: ifaces.some((i) => !i.virtual),
      suggestions: [...new Set(ifaces.filter((i) => !i.virtual && i.prefix >= 20).map((i) => i.cidr))],
    });
  });

  // Devices
  r.get('/devices', (req, res) => {
    const mon = ctx.monitoring.deviceStatus();
    res.json(inventory.list({ q: str(req.query.q, 100), type: str(req.query.type, 30), location: str(req.query.location, 12), tag: str(req.query.tag, 60) })
      .map((d) => ({ ...d, monitor: mon[d.id] || null })));
  });
  r.get('/devices/suggestions', (_req, res) => res.json(inventory.suggestions()));
  r.post('/devices/bulk', editor, (req, res) => {
    const list = ids(req.body.ids, 2000);
    const n = inventory.bulkUpdate(list, { set: req.body.set, tagsAdd: req.body.tagsAdd, tagsRemove: req.body.tagsRemove }, who(req));
    if (n) audit(req, 'device.bulkUpdate', `${n} device(s): ${Object.keys(req.body.set || {}).join(', ')}`);
    res.json({ updated: n });
  });
  r.post('/devices/bulk-delete', editor, (req, res) => {
    const n = inventory.bulkRemove(ids(req.body.ids, 2000));
    if (n) audit(req, 'device.bulkDelete', `${n} device(s)`);
    res.json({ deleted: n });
  });
  r.get('/devices/export.csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="whatsonmynet-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(inventory.list({ q: str(req.query.q, 100), type: str(req.query.type, 30), location: str(req.query.location, 12) })));
  });
  r.get('/devices/export.json', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="whatsonmynet-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exported: new Date().toISOString(), version: config.version,
      devices: inventory.list({}).map((d) => ({ ...d, facts: inventory.get(d.id)?.facts })) });
  });
  r.get('/devices/:id', (req, res) => {
    const d = inventory.get(idParam(req));
    if (!d) throw new HttpError(404, 'err.notFound');
    const presence = inventory.list({}).find((x) => x.id === d.id)?.presence || 'unknown';
    const monitors = db.prepare('SELECT id FROM monitors WHERE device_id=? ORDER BY name').all(d.id).map((m) => ctx.monitoring.get(m.id));
    res.json({ ...d, presence, monitors, printer: d.type === 'printer' ? ctx.printers.status(d.id) : null, history: inventory.historyOf(d.id) });
  });
  r.post('/devices', editor, (req, res) => {
    const d = inventory.create(req.body, who(req));
    audit(req, 'device.create', d.name);
    res.status(201).json(d);
  });
  r.patch('/devices/:id', editor, (req, res) => {
    res.json(inventory.update(idParam(req), req.body, who(req)));
  });
  r.delete('/devices/:id', editor, (req, res) => {
    const id = idParam(req);
    const d = inventory.get(id);
    inventory.remove(id);
    audit(req, 'device.delete', d?.name);
    res.json({ ok: true });
  });
  r.post('/devices/:id/deep', editor, (req, res) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(idParam(req));
    if (!d) throw new HttpError(404, 'err.notFound');
    const id = scanner.startDeep(d, who(req));
    audit(req, 'scan.deep', `${d.name} (${d.ip})`);
    res.status(202).json({ id });
  });

  r.post('/devices/:id/printer', editor, async (req, res) => {
    const id = idParam(req);
    if (!db.prepare("SELECT 1 FROM devices WHERE id=? AND type='printer'").get(id)) throw new HttpError(404, 'err.notFound');
    res.json(await ctx.printers.poll(id));
  });

  // Nightly light scan: start now (same as at night, all subnets of all locations)
  r.post('/lightscan/run', editor, (req, res) => {
    const id = ctx.nightly.run(who(req));
    if (!id) throw new HttpError(400, 'err.noSubnets');
    audit(req, 'scan.light');
    res.status(202).json({ id });
  });

  // Scans
  r.get('/scans', (_req, res) => {
    res.json(db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 30').all().map((s) => ({ ...s, targets: parse(s.targets, []), stats: parse(s.stats),
      counts: db.prepare('SELECT status, COUNT(*) n FROM scan_results WHERE scan_id=? GROUP BY status').all(s.id) })));
  });
  r.get('/scans/:id', (req, res) => {
    const id = idParam(req);
    const s = db.prepare('SELECT * FROM scans WHERE id=?').get(id);
    if (!s) throw new HttpError(404, 'err.notFound');
    const results = db.prepare(`SELECT r.*, d.name device_name, d.type device_type, l.name location_name FROM scan_results r
      LEFT JOIN devices d ON d.id=r.device_id LEFT JOIN locations l ON l.id=r.location_id WHERE r.scan_id=?`).all(id)
      .map((x) => ({ ...x, facts: parse(x.facts) }));
    res.json({ ...s, targets: parse(s.targets, []), stats: parse(s.stats), progress: scanner.progress(id), results });
  });
  r.post('/scans', editor, (req, res) => {
    const locIds = ids(req.body.locationIds, 100);
    const cidrs = Array.isArray(req.body.cidrs) ? req.body.cidrs.slice(0, 32).map((c) => line(c, 40)).filter(Boolean) : [];
    const targets = [
      ...locations.targets(locIds),
      ...cidrs.map((c) => ({ cidr: c, locationId: (parseCidr(c) && locations.locationForCidr(parseCidr(c).cidr)) || null })),
    ];
    const id = scanner.startNetwork(targets, who(req));
    audit(req, 'scan.start', targets.map((x) => x.cidr).join(', '));
    res.status(202).json({ id });
  });
  r.post('/scans/:id/cancel', editor, (req, res) => {
    res.json({ ok: scanner.cancel(idParam(req)) });
  });
  r.post('/scans/:id/adopt', editor, (req, res) => {
    const scanId = idParam(req);
    const resultIds = ids(req.body.ids).filter((x) => db.prepare('SELECT 1 FROM scan_results WHERE id=? AND scan_id=?').get(x, scanId));
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
    const resultIds = ids(req.body.ids).filter((x) => db.prepare('SELECT 1 FROM scan_results WHERE id=? AND scan_id=?').get(x, scanId));
    const n = inventory.ignore(resultIds, who(req));
    if (n) audit(req, 'inventory.ignore', `${n} device(s) from scan ${scanId}`);
    res.json({ ignored: n });
  });

  r.get('/ignored', (_req, res) => res.json(db.prepare('SELECT * FROM ignored ORDER BY created_at DESC').all()));
  r.delete('/ignored/:id', editor, (req, res) => {
    if (!db.prepare('DELETE FROM ignored WHERE id=?').run(idParam(req)).changes) throw new HttpError(404, 'err.notFound');
    res.json({ ok: true });
  });

  // Locations
  r.get('/locations', (_req, res) => res.json(locations.list()));
  r.post('/locations', admin, (req, res) => { const l = locations.create(req.body); audit(req, 'location.create', l.name); res.status(201).json(l); });
  r.put('/locations/:id', admin, (req, res) => { const l = locations.update(idParam(req), req.body); audit(req, 'location.update', l.name); res.json(l); });
  r.delete('/locations/:id', admin, (req, res) => { locations.remove(idParam(req)); audit(req, 'location.delete', req.params.id); res.json({ ok: true }); });

  // --- Administration ---------------------------------------------------------------------------------------
  r.get('/settings', admin, (_req, res) => {
    res.json({ general: settings.publicGroup('general'), scan: settings.publicGroup('scan'), smtp: settings.publicGroup('smtp'), backup: settings.publicGroup('backup'),
      lightscan: { ...settings.publicGroup('lightscan'), last: ctx.nightly.lastLight() }, printer: settings.publicGroup('printer') });
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
    theme: u.theme, canEdit: can(u, 'editor'), isAdmin: can(u, 'admin') };
}
