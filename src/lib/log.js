// Simple logging to stdout (ends up in the Docker log).
// Passwords, tokens and community strings are never logged - redact() removes them from objects.
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const current = levels[process.env.WOMN_LOG_LEVEL || 'info'] ?? 20;

const SECRET_KEYS = /pass|secret|token|cookie|authorization|credential|community|key$/i;

export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (value instanceof Error) return value.message;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, depth + 1);
  }
  return out;
}

// Besides stdout the lines also go to the program's own log (table server_log - for the diagnostic package).
// Lines written before it is attached (start, migrations) wait in a small buffer.
let sink = null;
let inSink = false;
const early = [];
const EARLY_MAX = 500;
/** fn({ at, level, message }) or null; never throws into the caller and never logs about itself */
export function setLogSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
  if (sink) for (const e of early.splice(0)) toSink(e);
}
function toSink(e) {
  if (inSink) return;
  inSink = true;
  try { sink(e); } catch { /* the log never stops the program */ } finally { inSink = false; }
}

// The program's log keeps info and above even when less is printed (WOMN_LOG_LEVEL=warn); debug only when printed
const stored = Math.min(current, levels.info);

function write(level, msg, extra) {
  if (levels[level] < current && levels[level] < stored) return;
  const at = new Date().toISOString();
  const tail = extra === undefined ? '' : ' ' + JSON.stringify(redact(extra));
  if (levels[level] >= current) (level === 'error' || level === 'warn' ? console.error : console.log)(`${at} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`);
  const e = { at, level, message: `${msg}${tail}` };
  if (sink) toSink(e);
  else if (early.length < EARLY_MAX) early.push(e);
}

export const log = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
