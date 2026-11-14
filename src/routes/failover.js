// Failover: settings for the admin, and the three endpoints a paired standby calls on its master (with its secret,
// no session).
import express from 'express';
import { requireRole, requireAuth } from '../auth/session.js';

export function createFailoverApi(ctx) {
  const { failover, db } = ctx;
  const r = express.Router();
  const admin = requireRole('admin');
  const audit = (req, action, detail = '') => {
    try { db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), req.user?.username || '', action, String(detail ?? '').slice(0, 500)); } catch { /* the log never stops an action */ }
  };

  // ---- called by the standby
  r.get('/failover/hello', (req, res) => res.json(failover.hello(req)));
  r.get('/failover/snapshot', async (req, res) => { await failover.sendSnapshot(req, res); });
  r.post('/failover/yield', (req, res) => res.json(failover.yieldTo(req)));

  // ---- for every signed-in user: the bar at the top while this is a standby (or has taken over)
  r.get('/failover/banner', requireAuth, (_req, res) => res.json(failover.banner()));

  // ---- settings (admins; also on a standby - that is where it is decided)
  r.get('/failover', admin, (_req, res) => res.json(failover.status()));
  r.post('/failover/master', admin, (req, res) => { const out = failover.makeMaster(); audit(req, 'failover.master'); res.json({ ...failover.status(), code: out.code }); });
  r.post('/failover/pair', admin, async (req, res) => {
    const out = await failover.pair({ address: req.body.address, code: req.body.code, delayMin: req.body.delayMin });
    audit(req, 'failover.pair', out.standby?.address);
    res.json(out);
  });
  r.put('/failover/delay', admin, (req, res) => { const out = failover.setDelay(req.body.delayMin); audit(req, 'failover.delay', String(out.standby?.delayMin)); res.json(out); });
  r.post('/failover/promote', admin, (req, res) => { const out = failover.promote(); audit(req, 'failover.promote'); res.json({ ...failover.status(), code: out.code }); });
  r.post('/failover/unpair', admin, (req, res) => { const out = failover.unpair(); audit(req, 'failover.unpair', out.was); res.json(failover.status()); });
  r.post('/failover/check', admin, async (_req, res) => { await failover.tick(); res.json(failover.status()); });
  return r;
}
