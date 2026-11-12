// Sending email (SMTP). In version 1: test mail; alarms follow with the monitoring.
import nodemailer from 'nodemailer';
import { HttpError } from '../lib/http.js';
import { log } from '../lib/log.js';

export function transportOptions(s) {
  const security = s.security || 'starttls';
  return {
    host: s.host,
    port: Number(s.port) || (security === 'tls' ? 465 : 587),
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    auth: s.user ? { user: s.user, pass: s.password || '' } : undefined,
    tls: { rejectUnauthorized: !s.allowSelfSigned, minVersion: 'TLSv1.2' },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

export function createMailer(settings) {
  const cfg = () => ({
    host: settings.get('smtp.host'), port: settings.get('smtp.port'), security: settings.get('smtp.security'),
    user: settings.get('smtp.user'), password: settings.get('smtp.password'), from: settings.get('smtp.from'),
    allowSelfSigned: settings.get('smtp.allowSelfSigned'),
  });
  return {
    configured: () => !!cfg().host && !!cfg().from,
    async send({ to, subject, text }) {
      const s = cfg();
      if (!s.host || !s.from) throw new HttpError(400, 'err.smtpNotConfigured');
      try {
        const t = nodemailer.createTransport(transportOptions(s));
        await t.sendMail({ from: s.from, to, subject, text });
      } catch (e) {
        log.warn(`Sending mail failed: ${e.message}`);
        throw new HttpError(502, 'err.smtpFailed', String(e.message).slice(0, 300));
      }
    },
  };
}
