// API for monitors, notification channels and maintenance windows.
import crypto from 'node:crypto';
import express from 'express';
import { HttpError, int, str, ids } from '../lib/http.js';
import { BULK_MAX } from '../monitor/index.js';
import { requireRole } from '../auth/session.js';
import { inScope } from '../auth/scope.js';

export function createMonitoringApi(ctx) {
  const { db, monitoring, channels, maintenance, dockerHosts } = ctx;
  const r = express.Router();
  const choices = ctx.sensorChoices;
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

  const unscoped = (req, _res, next) => next(req.scope ? new HttpError(403, 'err.scope') : undefined);
  // Location limit: a limited user only sees and changes monitors of devices in his locations
  const deviceOk = (req, deviceId) => !req.scope || (deviceId && inScope(req.scope, db.prepare('SELECT location_id FROM devices WHERE id=?').get(deviceId)?.location_id));
  const monitorOk = (req, id) => {
    const m = db.prepare('SELECT device_id FROM monitors WHERE id=?').get(id);
    if (!m || !deviceOk(req, m.device_id)) throw new HttpError(404, 'err.notFound');
  };

  // Monitors (reading for everyone signed in, changing for editors)
  r.get('/monitors', (req, res) => res.json(monitoring.list().filter((m) => deviceOk(req, m.device_id))));
  r.get('/monitors/summary', (req, res) => res.json(monitoring.summary(req.scope ? (m) => deviceOk(req, m.device_id) : null)));
  r.get('/monitors/suggest/:id', editor, async (req, res) => {
    if (!deviceOk(req, idParam(req))) throw new HttpError(404, 'err.notFound');
    res.json(await monitoring.suggestionFor(idParam(req)));
  });
  r.get('/monitors/:id', (req, res) => { monitorOk(req, idParam(req)); res.json(monitoring.detail(idParam(req), int(str(req.query.hours, 4)) || 24)); });
  // A limited user may only put a monitor behind one he can see
  const parentOk = (req) => {
    const pid = int(String(req.body?.parent_id ?? ''));
    if (pid) monitorOk(req, pid);
  };
  // Docker hosts and hypervisors belong to no location: a user limited to locations cannot read them elsewhere either
  const typeOk = (req, type) => { if (req.scope && ['docker', 'proxmox'].includes(type)) throw new HttpError(403, 'err.scope'); };
  r.post('/monitors', editor, async (req, res) => {
    if (!deviceOk(req, req.body.device_id ? Number(req.body.device_id) : null)) throw new HttpError(403, 'err.scope');
    parentOk(req);
    typeOk(req, req.body.type);
    const m = await monitoring.create(req.body);
    audit(req, 'monitor.create', `${m.name} (${m.type} ${m.target})`);
    res.status(201).json(m);
  });
  r.put('/monitors/:id', editor, async (req, res) => {
    monitorOk(req, idParam(req));
    // a sensor moved to another device: that one must be his as well
    if (req.body?.device_id !== undefined && req.body.device_id !== null && !deviceOk(req, Number(req.body.device_id))) throw new HttpError(403, 'err.scope');
    parentOk(req);
    typeOk(req, req.body.type ?? monitoring.get(idParam(req))?.type);
    const m = await monitoring.update(idParam(req), req.body);
    audit(req, 'monitor.update', m.name);
    res.json(m);
  });
  // Several at once: change how often / when to alarm, pause, resume, delete. A limited user gets 403 as soon as one
  // of the monitors is not his (then nothing changes at all).
  r.post('/monitors/bulk', editor, async (req, res) => {
    const raw = req.body?.ids;
    const list = ids(raw, BULK_MAX + 1);
    if (!Array.isArray(raw) || !list.length || raw.length > BULK_MAX || list.length > BULK_MAX) throw new HttpError(400, 'err.bulkIds', String(BULK_MAX));
    const action = str(req.body.action, 20);
    if (!['edit', 'pause', 'resume', 'delete'].includes(action)) throw new HttpError(400, 'err.badRequest', action);
    if (req.scope) {
      for (const id of list) {
        const m = db.prepare('SELECT device_id FROM monitors WHERE id=?').get(id);
        if (m && !deviceOk(req, m.device_id)) throw new HttpError(403, 'err.scope');
      }
    }
    const out = await monitoring.bulk(list, action, req.body.changes);
    if (out.changed) audit(req, 'monitor.bulk', `${action} ${out.changed} monitor(s)${action === 'edit' ? `: ${Object.keys(req.body.changes || {}).join(', ')}` : ''}`);
    res.json(out);
  });
  r.post('/monitors/:id/pause', editor, (req, res) => { monitorOk(req, idParam(req)); const m = monitoring.pause(idParam(req)); audit(req, 'monitor.pause', m.name); res.json(m); });
  r.post('/monitors/:id/resume', editor, (req, res) => { monitorOk(req, idParam(req)); const m = monitoring.resume(idParam(req)); audit(req, 'monitor.resume', m.name); res.json(m); });
  // Everything plugged in at the switch of this monitor: put it behind this monitor (no alarm flood when the switch fails)
  r.post('/monitors/:id/children', editor, (req, res) => {
    const id = idParam(req);
    monitorOk(req, id);
    const n = monitoring.adoptChildren(id, (c) => deviceOk(req, c.device_id));
    audit(req, 'monitor.children', `${monitoring.get(id)?.name} (${n})`);
    res.json({ count: n });
  });
  r.post('/monitors/:id/check', editor, async (req, res) => { monitorOk(req, idParam(req)); res.json(await monitoring.checkNow(idParam(req))); });
  r.delete('/monitors/:id', editor, (req, res) => {
    const id = idParam(req);
    monitorOk(req, id);
    const m = monitoring.get(id);
    monitoring.remove(id);
    audit(req, 'monitor.delete', m?.name);
    res.json({ ok: true });
  });

  // Sensors: what can be watched - one list per device or per host under Virtualization (the same values both ways)
  r.get('/sensors/sources', editor, (req, res) => {
    const ids = choices.deviceIds();
    const devices = db.prepare('SELECT id, name, ip, location_id FROM devices ORDER BY name COLLATE NOCASE').all()
      .filter((d) => ids.has(d.id) && (!req.scope || inScope(req.scope, d.location_id))).map(({ id, name, ip }) => ({ id, name, ip }));
    const hosts = req.scope ? [] : db.prepare('SELECT id, name, kind FROM proxmox_hosts ORDER BY name COLLATE NOCASE').all();
    res.json({ devices, hosts });
  });
  r.get('/sensors/choices', editor, (req, res) => {
    const device = int(str(req.query.device, 12));
    const host = int(str(req.query.host, 12));
    if (device) {
      if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(device) || !deviceOk(req, device)) throw new HttpError(404, 'err.notFound');
      return res.json(choices.forDevice(device, { withHosts: !req.scope }));
    }
    if (host) {
      if (req.scope) throw new HttpError(403, 'err.scope');
      return res.json(choices.forHost(host));
    }
    throw new HttpError(400, 'err.notFound');
  });

  // Docker hosts: names for editors (monitor form), addresses and changes for admins
  r.get('/docker/hosts', editor, (req, res) => {
    const list = dockerHosts.list();
    res.json(req.user.role === 'admin' ? list : list.map((h) => ({ id: h.id, name: h.name })));
  });
  r.post('/docker/hosts', admin, (req, res) => { const h = dockerHosts.create(req.body); audit(req, 'docker.create', `${h.name} (${h.url})`); res.status(201).json(h); });
  r.put('/docker/hosts/:id', admin, (req, res) => { const h = dockerHosts.update(idParam(req), req.body); audit(req, 'docker.update', h.name); res.json(h); });
  r.delete('/docker/hosts/:id', admin, (req, res) => { dockerHosts.remove(idParam(req)); audit(req, 'docker.delete', req.params.id); res.json({ ok: true }); });
  r.get('/docker/hosts/:id/containers', editor, unscoped, async (req, res) => res.json(await dockerHosts.info(idParam(req))));
  // One monitor for every container that has none yet
  r.post('/docker/hosts/:id/monitor-all', editor, unscoped, async (req, res) => {
    const id = idParam(req);
    const info = await dockerHosts.info(id);
    const have = new Set(db.prepare("SELECT target FROM monitors WHERE type='docker' AND docker_host_id=?").all(id).map((m) => m.target));
    const host = dockerHosts.get(id);
    const created = [];
    for (const c of info.containers) {
      if (have.has(c.name) || (req.body.runningOnly !== false && c.state !== 'running')) continue;
      created.push((await monitoring.create({ name: `${c.name} (${host.name})`, type: 'docker', target: c.name, docker_host_id: id, interval_s: 60 })).id);
    }
    if (created.length) audit(req, 'docker.monitorAll', `${created.length} monitor(s) on ${host.name}`);
    res.json({ created: created.length });
  });

  // Proxmox hosts: names and values for editors (monitor form), everything else for admins
  r.get('/proxmox', editor, (req, res) => {
    const list = ctx.proxmox.list();
    res.json(req.user.role === 'admin' ? list : list.map((h) => ({ id: h.id, name: h.name, kind: h.kind })));
  });
  r.post('/proxmox', admin, async (req, res) => { const h = ctx.proxmox.create(req.body); audit(req, 'proxmox.create', `${h.name} (${h.url})`); res.status(201).json(await ctx.proxmox.poll(h.id)); });
  r.put('/proxmox/:id', admin, async (req, res) => { const h = ctx.proxmox.update(idParam(req), req.body); audit(req, 'proxmox.update', h.name); res.json(await ctx.proxmox.poll(h.id)); });
  r.delete('/proxmox/:id', admin, (req, res) => { ctx.proxmox.remove(idParam(req)); audit(req, 'proxmox.delete', req.params.id); res.json({ ok: true }); });
  r.post('/proxmox/cert', admin, async (req, res) => res.json(await ctx.proxmox.fetchCert(req.body?.url)));
  r.post('/proxmox/:id/poll', admin, async (req, res) => res.json(await ctx.proxmox.poll(idParam(req))));
  r.get('/proxmox/:id/metrics', editor, unscoped, (req, res) => res.json(ctx.proxmox.metrics(idParam(req))));
  // New token + script for such a host; a self-signed certificate of this server is pinned in the script
  r.post('/proxmox/:id/token', admin, (req, res) => {
    const pin = {};
    const pem = String(ctx.tls?.current()?.cert || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (pem && ctx.tls?.describe()?.source !== 'custom') {
      const c = new crypto.X509Certificate(pem);
      pin.sha1 = c.fingerprint.replace(/:/g, '');
      pin.spki = crypto.createHash('sha256').update(c.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    }
    const out = ctx.proxmox.newToken(idParam(req), { server: str(req.body?.server, 300), pin });
    audit(req, 'proxmox.token', req.params.id);
    res.json(out);
  });

  // Maintenance windows (editors)
  r.get('/maintenance', (_req, res) => res.json(maintenance.list()));
  r.post('/maintenance', editor, unscoped, (req, res) => { const w = maintenance.create(req.body); audit(req, 'maintenance.create', w.name); res.status(201).json(w); });
  r.put('/maintenance/:id', editor, unscoped, (req, res) => { const w = maintenance.update(idParam(req), req.body); audit(req, 'maintenance.update', w.name); res.json(w); });
  r.delete('/maintenance/:id', editor, unscoped, (req, res) => { maintenance.remove(idParam(req)); audit(req, 'maintenance.delete', req.params.id); res.json({ ok: true }); });

  // Notification channels: names for everyone (to choose them on a monitor), settings for admins only
  r.get('/channels', (req, res) => {
    const list = channels.list();
    res.json(req.user.role === 'admin' ? list : list.map((c) => ({ id: c.id, name: c.name, type: c.type, is_default: c.is_default, enabled: c.enabled })));
  });
  r.post('/channels', admin, (req, res) => { const c = channels.create(req.body); audit(req, 'channel.create', `${c.name} (${c.type})`); res.status(201).json(c); });
  r.put('/channels/:id', admin, (req, res) => { const c = channels.update(idParam(req), req.body); audit(req, 'channel.update', c.name); res.json(c); });
  r.delete('/channels/:id', admin, (req, res) => { channels.remove(idParam(req)); audit(req, 'channel.delete', req.params.id); res.json({ ok: true }); });
  r.post('/channels/:id/test', admin, async (req, res) => { await channels.test(idParam(req)); audit(req, 'channel.test', req.params.id); res.json({ ok: true }); });

  return r;
}
