// Diagnostic package (administrators): download, and look up what a placeholder stands for.
import express from 'express';
import { requireRole } from '../auth/session.js';
import { HttpError } from '../lib/http.js';

export function createDiagnosticsApi(ctx) {
  const { diagnostics, db } = ctx;
  const r = express.Router();
  const admin = requireRole('admin');
  const audit = (req, action, detail = '') => {
    try { db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), req.user?.username || '', action, String(detail ?? '').slice(0, 500)); } catch { /* never stops */ }
  };

  r.get('/diagnostics', admin, (_req, res) => res.json({ aliases: diagnostics.aliasCount(), keepDays: 30 }));
  // days: 1-30, 0 = since the last update; anon=0 only when asked for (the default is anonymised)
  r.get('/diagnostics/package', admin, (req, res) => {
    const days = Number.parseInt(String(req.query.days ?? '7'), 10);
    const anonymize = String(req.query.anon ?? '1') !== '0';
    let out;
    try { out = diagnostics.build({ days: Number.isFinite(days) ? days : 7, anonymize }); } catch (e) {
      if (e.busy) throw new HttpError(409, 'err.diagBusy');
      throw e;
    }
    audit(req, 'diagnostics.download', `${out.label}, ${anonymize ? 'anonymised' : 'NOT anonymised'}`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  });
  r.get('/diagnostics/lookup', admin, (req, res) => res.json({ list: diagnostics.lookup(String(req.query.q ?? '').slice(0, 200)) }));
  r.get('/diagnostics/aliases.csv', admin, (req, res) => {
    audit(req, 'diagnostics.aliases');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="whatsonmynet-platzhalter.csv"');
    res.send(diagnostics.mappingCsv());
  });
  return r;
}
