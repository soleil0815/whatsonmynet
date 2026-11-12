// Helpers for errors and input validation in the API.
export class HttpError extends Error {
  /** @param {number} status @param {string} code i18n key, e.g. 'err.notFound' */
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const notFound = () => new HttpError(404, 'err.notFound');
export const forbidden = () => new HttpError(403, 'err.forbidden');
export const badRequest = (detail) => new HttpError(400, 'err.badRequest', detail);

/** Text from input: only strings and numbers, anything else (objects, arrays) becomes '' */
export function str(v, max = 10000) {
  if (typeof v === 'string') return v.slice(0, max);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max);
  if (typeof v === 'boolean') return String(v);
  return '';
}

/** Trimmed single-line text (no control characters) */
export function line(v, max = 200) {
  // eslint-disable-next-line no-control-regex
  return str(v, max * 2).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** YYYY-MM-DD or null */
export function isoDate(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Real calendar day only (no 2027-02-30)
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

export function oneOf(v, allowed, def) {
  return allowed.includes(v) ? v : def;
}

export function int(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v !== 'string' || !/^-?\d{1,15}$/.test(v.trim())) return null;
  return Number.parseInt(v, 10);
}

/** Array of positive integer ids (max. n) */
export function ids(v, max = 5000) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(int).filter((n) => n !== null && n > 0))].slice(0, max);
}
