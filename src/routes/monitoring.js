// API for monitors, notification channels and maintenance windows.
import express from 'express';
import { HttpError, int, str } from '../lib/http.js';
import { requireRole } from '../auth/session.js';

export function createMonitoringApi(ctx) {
  const { db, monitoring, channels, maintenance } = ctx;
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

  // Monitors (reading for everyone signed in, changing for editors)
  r.get('/monitors', (_req, res) => res.json(monitoring.list()));
  r.get('/monitors/summary', (_req, res) => res.json(monitoring.summary()));
  r.get('/monitors/suggest/:id', editor, async (req, res) => res.json(await monitoring.suggestionFor(idParam(req))));
  r.get('/monitors/:id', (req, res) => res.json(monitoring.detail(idParam(req), int(str(req.query.hours, 4)) || 24)));
  r.post('/monitors', editor, async (req, res) => {
    const m = await monitoring.create(req.body);
    audit(req, 'monitor.create', `${m.name} (${m.type} ${m.target})`);
    res.status(201).json(m);
  });
  r.put('/monitors/:id', editor, async (req, res) => {
    const m = await monitoring.update(idParam(req), req.body);
    audit(req, 'monitor.update', m.name);
    res.json(m);
  });
  r.post('/monitors/:id/pause', editor, (req, res) => { const m = monitoring.pause(idParam(req)); audit(req, 'monitor.pause', m.name); res.json(m); });
  r.post('/monitors/:id/resume', editor, (req, res) => { const m = monitoring.resume(idParam(req)); audit(req, 'monitor.resume', m.name); res.json(m); });
  r.post('/monitors/:id/check', editor, async (req, res) => res.json(await monitoring.checkNow(idParam(req))));
  r.delete('/monitors/:id', editor, (req, res) => {
    const id = idParam(req);
    const m = monitoring.get(id);
    monitoring.remove(id);
    audit(req, 'monitor.delete', m?.name);
    res.json({ ok: true });
  });

  // Maintenance windows (editors)
  r.get('/maintenance', (_req, res) => res.json(maintenance.list()));
  r.post('/maintenance', editor, (req, res) => { const w = maintenance.create(req.body); audit(req, 'maintenance.create', w.name); res.status(201).json(w); });
  r.put('/maintenance/:id', editor, (req, res) => { const w = maintenance.update(idParam(req), req.body); audit(req, 'maintenance.update', w.name); res.json(w); });
  r.delete('/maintenance/:id', editor, (req, res) => { maintenance.remove(idParam(req)); audit(req, 'maintenance.delete', req.params.id); res.json({ ok: true }); });

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
