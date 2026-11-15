// Diagnostic package (administrators): download, and look up what a placeholder stands for.
import express from 'express';
import { requireRole } from '../auth/session.js';
import { HttpError } from '../lib/http.js';
import { grafanaDashboard } from '../metrics.js';

export function createDiagnosticsApi(ctx) {
  const { diagnostics, db } = ctx;
  const r = express.Router();
  const admin = requireRole('admin');
  const audit = (req, action, detail = '') => {
    try { db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), req.user?.username || '', action, String(detail ?? '').slice(0, 500)); } catch { /* never stops */ }
  };

  // Prometheus keys (only shown once) and the Grafana dashboard
  r.get('/apitokens', admin, (_req, res) => res.json({ list: ctx.apiTokens.list() }));
  r.post('/apitokens', admin, (req, res) => {
    const t = ctx.apiTokens.create(req.body?.name, req.user.username);
    audit(req, 'apitoken.create', t.name);
    res.status(201).json(t);
  });
  r.delete('/apitokens/:id', admin, (req, res) => {
    ctx.apiTokens.remove(String(req.params.id).slice(0, 64));
    audit(req, 'apitoken.delete', req.params.id);
    res.json({ ok: true });
  });
  // the certificate of this server (public part only) - for Prometheus' ca_file instead of switching the check off
  r.get('/server-certificate.crt', admin, (_req, res) => {
    const pem = String(ctx.tls?.current()?.cert || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!pem) throw new HttpError(404, 'err.notFound');
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="whatsonmynet.crt"');
    res.send(`${pem.join('\n')}\n`);
  });
  r.get('/grafana-dashboard.json', admin, (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="whatsonmynet-grafana.json"');
    res.json(grafanaDashboard(req.user.language === 'en' ? 'en' : 'de'));
  });
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
