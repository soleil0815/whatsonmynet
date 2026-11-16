// Regular expressions typed by users (event rules) run against every message that comes in. JavaScript cannot stop a
// running expression, so a badly written one ("(a+)+$") could hang the whole server on one unlucky message. Three
// guards, in this order:
//   1. at saving: no backreferences, no quantified group that itself repeats or alternates (the classic catastrophic
//      backtracking), at most 300 characters;
//   2. at saving: tried in a separate thread on hostile texts and on real messages - with a hard time limit (the thread
//      is stopped when it does not answer);
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
    const after = s.slice(g.end + 1, g.end + 2);
    const repeated = after === '+' || after === '*' || (after === '{' && /^\{\d*,\d*\}/.test(s.slice(g.end + 1)) && !/^\{\d+\}/.test(s.slice(g.end + 1)));
    if (!repeated) continue;
    const inner = s.slice(g.start + 1, g.end).replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
    if (/[+*]|\{\d*,/.test(inner) || inner.includes('|')) throw new HttpError(400, 'err.regexUnsafe', undefined, field);
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

/** Hostile texts: long runs of what an expression typically repeats, each with a spoiler at the end */
function hostile() {
  const out = [];
  for (const ch of ['a', ' ', '0', 'a ', '-', '.', 'aA0 ', 'x=1,', '\\']) {
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
    const w = new Worker(WORKER, { eval: true, workerData: { src, samples: [...hostile(), ...samples.map((x) => String(x).slice(0, 4000))].slice(0, 400) },
      resourceLimits: { maxOldGenerationSizeMb: 64 } });
    let done = false;
    const end = (fn) => { if (done) return; done = true; clearTimeout(timer); w.terminate().catch(() => {}); fn(); };
    const timer = setTimeout(() => end(() => reject(new HttpError(400, 'err.regexSlow', undefined, field))), limitMs);
    w.once('message', (worst) => end(() => (worst > slowMs ? reject(new HttpError(400, 'err.regexSlow', undefined, field)) : resolve(worst))));
    w.once('error', () => end(() => reject(new HttpError(400, 'err.regexInvalid', undefined, field))));
  });
}
