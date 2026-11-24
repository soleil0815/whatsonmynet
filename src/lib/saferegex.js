// Regular expressions typed by users (event rules) run against every message that comes in. JavaScript cannot stop a
// running expression, so a badly written one ("(a+)+$") could hang the whole server on one unlucky message. Three
// guards, in this order:
//   1. at saving: no backreferences, no quantified group that itself repeats or alternates (the classic catastrophic
//      backtracking) - a fixed count like {8} counts as well -, at most 300 characters;
//   2. at saving: tried in a separate thread on hostile texts (also runs of its own characters) and on real messages -
//      with a hard time limit (the thread is stopped when it does not answer);
//   3. while running: a rule whose expression ever takes longer than 20 ms on a message is switched off (eventrules.js).
// Texts are cut to 4000 characters before they get here (events.js), which keeps every run short as well.
import { Worker } from 'node:worker_threads';
import { HttpError } from './http.js';

export const MAX_REGEX = 300;
export const SLOW_MS = 20;

/** Compiles (case-insensitive) or throws HttpError(err.regexInvalid) */
export function compileRegex(src, field = 'regex') {
  try { return new RegExp(src, 'i'); } catch { throw new HttpError(400, 'err.regexInvalid', undefined, field); }
}

/** The quick check while saving: valid, short, none of the shapes known to backtrack without end */
export function checkRegexStatic(src, field = 'regex') {
  const s = String(src ?? '');
  if (!s) return null;
  if (s.length > MAX_REGEX) throw new HttpError(400, 'err.regexLong', String(MAX_REGEX), field);
  compileRegex(s, field);
  // backreferences: \1 … \9, \k<name>
  if (/\\[1-9]|\\k</.test(s)) throw new HttpError(400, 'err.regexUnsafe', undefined, field);
  // a group that is repeated (+, *, {n,}) and inside repeats or alternates: (a+)+ (a*)* (a|aa)+ (\s*\w+)*
  const groups = [];
  let depth = 0; let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { groups.push({ start: i, depth: ++depth }); continue; }
    if (c === ')') {
      const g = [...groups].reverse().find((x) => x.depth === depth && x.end === undefined);
      if (g) g.end = i;
      depth--;
    }
  }
  for (const g of groups) {
    if (g.end === undefined) continue;
    const rest = s.slice(g.end + 1);
    const after = rest[0];
    const range = /^\{(\d*)(,?)(\d*)\}/.exec(rest);
    // without end: + * {n,}; a fixed or bounded count that still repeats: {8} {2,40} - the classic (a+)+ again, only
    // with a number: (?:\*+ ?){8} tries every way to split a run of '*' into 8 pieces before it gives up
    const unbounded = after === '+' || after === '*' || (range && range[2] === ',' && range[3] === '');
    const counted = !unbounded && range && Math.max(Number(range[1]) || 0, Number(range[3]) || 0) > 1;
    if (!unbounded && !counted) continue;
    const inner = s.slice(g.start + 1, g.end).replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
    const innerRepeats = /[+*]|\{\d*,\}/.test(inner);
    if (innerRepeats || (unbounded && (/\{\d*,/.test(inner) || inner.includes('|')))) throw new HttpError(400, 'err.regexUnsafe', undefined, field);
  }
  return s;
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.src, 'i');
let worst = 0;
for (const t of workerData.samples) { const a = performance.now(); re.test(t); worst = Math.max(worst, performance.now() - a); }
parentPort.postMessage(worst);
`;

/** The characters an expression names itself ("\\*+ALERT" → '*', 'A', 'L' …): what a hostile text repeats as well */
function literals(src) {
  const out = new Set();
  const s = String(src || '');
  for (let i = 0; i < s.length && out.size < 24; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[++i];
      if (n === undefined) break;
      const cls = { d: '0', w: 'a', s: ' ', t: '\t', n: '\n', r: '\r' }[n];
      if (cls) out.add(cls);
      else if (!/[a-zA-Z0-9]/.test(n)) out.add(n); // an escaped sign: \* \. \[
      continue;
    }
    if (/[\p{L}\p{N}\p{P}\p{S} ]/u.test(c) && !'()[]{}|?+*^$.'.includes(c)) out.add(c);
  }
  return [...out];
}

/** Hostile texts: long runs of what an expression typically repeats - and of its own characters -, each with a spoiler at the end */
function hostile(src = '') {
  const out = [];
  const own = literals(src);
  const runs = ['a', ' ', '0', 'a ', '-', '.', 'aA0 ', 'x=1,', '\\', ...own, ...own.map((c) => `${c} `)];
  if (own.length > 1) runs.push(own.join(''));
  for (const ch of [...new Set(runs)]) {
    const r = ch.repeat(Math.ceil(4000 / ch.length)).slice(0, 3999);
    out.push(`${r}!`, `${r}\n`, r);
  }
  return out;
}

/**
 * The slow check while saving: in a separate thread on hostile texts and the given real messages. Throws
 * HttpError(err.regexSlow) when it takes longer than allowed - or does not finish at all (the thread is stopped).
 */
export function checkRegexTime(src, samples = [], { limitMs = 2000, slowMs = SLOW_MS, field = 'regex' } = {}) {
  if (!src) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { src, samples: [...hostile(src), ...samples.map((x) => String(x).slice(0, 4000))].slice(0, 400) },
      resourceLimits: { maxOldGenerationSizeMb: 64 } });
    let done = false;
    const end = (fn) => { if (done) return; done = true; clearTimeout(timer); w.terminate().catch(() => {}); fn(); };
    const timer = setTimeout(() => end(() => reject(new HttpError(400, 'err.regexSlow', undefined, field))), limitMs);
    w.once('message', (worst) => end(() => (worst > slowMs ? reject(new HttpError(400, 'err.regexSlow', undefined, field)) : resolve(worst))));
    w.once('error', () => end(() => reject(new HttpError(400, 'err.regexInvalid', undefined, field))));
  });
}
