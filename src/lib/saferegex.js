// Regular expressions typed by users (event rules) run against every message that comes in. JavaScript cannot stop a
// running expression, so a badly written one ("(a+)+$") could hang the whole server on one unlucky message. Three
// guards, in this order:
//   1. at saving: no backreferences, no quantified group that itself repeats or alternates (the classic catastrophic
//      backtracking) - a fixed count like {8} counts as well, unless every repeated atom inside must stop at a required
//      separator it cannot match ((\d+\.){3} is fine, (?:\*+ ?){8} is not) -, at most 300 characters;
//   2. at saving: tried in a separate thread on hostile texts (also runs of its own characters) and on real messages -
//      with a hard time limit (the thread is stopped when it does not answer);
//   3. while running: every expression runs in a thread of its own (regexRun) with a hard time limit - a run that does
//      not finish in time is stopped by stopping the thread, so no expression can hold the server, whatever slipped
//      through 1. and 2. A rule whose expression ever takes longer than 20 ms on a message is switched off (eventrules.js).
// Texts are cut to 4000 characters before they get here (events.js), which keeps every run short as well.
import { Worker } from 'node:worker_threads';
import { HttpError } from './http.js';

export const MAX_REGEX = 300;
export const SLOW_MS = 20;
/** A run in the thread that takes longer is stopped (and its rule switched off) */
export const HARD_MS = 200;
const BOOT_MS = 5000;

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
    if (counted && innerRepeats && countedGroupSafe(s.slice(g.start + 1, g.end))) continue;
    if (innerRepeats || (unbounded && (/\{\d*,/.test(inner) || inner.includes('|')))) throw new HttpError(400, 'err.regexUnsafe', undefined, field);
  }
  return s;
}

// ------------------------------------------------------------------------------------------- counted groups
// A group repeated a fixed number of times, e.g. (\d+\.){3}, with an unbounded atom inside is harmless when every such
// atom has to stop at a required element it cannot match itself: \d+ cannot eat the '.', so there is one way only to
// split the text. Read as the group twice in a row (the end of one round meets the start of the next), between any
// unbounded atom and the next one there must be a required atom (at least once) whose characters the first cannot match.
// Only simple atoms are understood (characters, escapes, \d \w \s and their negations, [...] classes, .); anything else -
// alternation, nested groups, lookarounds, \u{…} - counts as unsafe.

/** The atoms of a group's content: [{ src, min, max }] (max Infinity for + * {n,}), or null if not simple */
function atomsOf(inner) {
  let s = inner;
  if (s.startsWith('?:')) s = s.slice(2);
  else if (/^\?<[A-Za-z_$][\w$]*>/.test(s)) s = s.slice(s.indexOf('>') + 1);
  else if (s.startsWith('?')) return null;
  const out = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    let src;
    if (c === '(' || c === ')' || c === '|') return null;
    if (c === '^' || c === '$') { i++; continue; }
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) return null;
      if (n === 'b' || n === 'B') { i += 2; continue; }
      if (n === 'x') { if (!/^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) return null; src = s.slice(i, i + 4); }
      else if (n === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) return null; src = s.slice(i, i + 6); }
      else if (/[cpPk0-9]/.test(n)) return null;
      else src = s.slice(i, i + 2);
    } else if (c === '[') {
      let j = i + 1;
      if (s[j] === '^') j++;
      if (s[j] === ']') j++;
      for (; j < s.length && s[j] !== ']'; j++) if (s[j] === '\\') j++;
      if (j >= s.length) return null;
      src = s.slice(i, j + 1);
    } else if ('+*?{}'.includes(c)) return null;
    else src = c;
    i += src.length;
    let min = 1; let max = 1;
    const q = /^(?:([+*?])|\{(\d+)(?:(,)(\d*))?\})/.exec(s.slice(i));
    if (q) {
      if (q[1]) { min = q[1] === '+' ? 1 : 0; max = q[1] === '?' ? 1 : Infinity; }
      else { min = Number(q[2]); max = q[3] ? (q[4] === '' ? Infinity : Number(q[4])) : min; }
      i += q[0].length;
      if (s[i] === '?') i++;
    }
    out.push({ src, min, max });
  }
  return out;
}

/** The characters (of the basic plane, case-insensitive as the rules run) an atom can match, or null */
function charsOf(atom) {
  let re;
  try { re = new RegExp(`^(?:${atom.src})$`, 'i'); } catch { return null; }
  const set = new Set();
  for (let k = 0; k < 0x10000; k++) { const ch = String.fromCharCode(k); if (re.test(ch)) set.add(ch); }
  return set;
}

/** Is a counted group with this content free of ambiguous splits (see above)? */
export function countedGroupSafe(inner) {
  const atoms = atomsOf(inner);
  if (!atoms || !atoms.length) return false;
  const sets = new Map();
  const set = (a) => { if (!sets.has(a)) sets.set(a, charsOf(a)); return sets.get(a); };
  const twice = [...atoms, ...atoms];
  for (let i = 0; i < atoms.length; i++) {
    if (atoms[i].max !== Infinity) continue;
    const mine = set(atoms[i]);
    if (!mine) return false;
    let stopped = false;
    for (let j = i + 1; j < twice.length; j++) {
      const b = twice[j];
      if (b.min >= 1) {
        const other = set(b);
        if (!other) return false;
        if (![...other].some((ch) => mine.has(ch))) { stopped = true; break; }
      }
      if (b.max === Infinity) break; // the next unbounded atom came first
    }
    if (!stopped) return false;
  }
  return true;
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

// ------------------------------------------------------------------------------------------------ the running thread
// One thread for all expressions of the rules. The caller waits for the answer (Atomics.wait, the matching of a message
// is synchronous); when the answer does not come in time the thread is stopped and a new one starts with the next run.
// State in ctrl[0]: 0 waiting, 1 match, 2 no match, 3 invalid; ctrl[1] = 1 once the thread is ready; ctrl[2] = 1 once
// the thread took the text (a thread that never took it was gone - the run is tried once more on a new one).
const RUNNER = `
const { parentPort, workerData } = require('node:worker_threads');
const ctrl = new Int32Array(workerData.ctrl);
const num = new Float64Array(workerData.num);
const out = new Uint16Array(workerData.out);
const cache = new Map();
parentPort.on('message', ({ src, text, group }) => {
  Atomics.store(ctrl, 2, 1);
  let re = cache.get(src);
  if (re === undefined) {
    try { re = new RegExp(src, 'i'); } catch { re = null; }
    if (cache.size >= 500) cache.clear();
    cache.set(src, re);
  }
  let state = 3; let key = '';
  const a = performance.now();
  if (re) {
    const m = re.exec(text);
    state = m ? 1 : 2;
    if (m && group && m[1] !== undefined) key = String(m[1]).slice(0, 120);
  }
  num[0] = performance.now() - a;
  out[0] = key.length;
  for (let i = 0; i < key.length; i++) out[i + 1] = key.charCodeAt(i);
  Atomics.store(ctrl, 0, state);
  Atomics.notify(ctrl, 0);
});
Atomics.store(ctrl, 1, 1);
Atomics.notify(ctrl, 1);
`;
let runner = null;

function startRunner() {
  const buf = { ctrl: new SharedArrayBuffer(12), num: new SharedArrayBuffer(8), out: new SharedArrayBuffer(2 * 121) };
  const w = new Worker(RUNNER, { eval: true, workerData: buf, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  w.unref();
  const r = { w, ctrl: new Int32Array(buf.ctrl), num: new Float64Array(buf.num), out: new Uint16Array(buf.out) };
  const gone = () => { if (runner === r) runner = null; };
  w.on('error', gone);
  w.on('exit', gone);
  Atomics.wait(r.ctrl, 1, 0, BOOT_MS);
  if (Atomics.load(r.ctrl, 1) !== 1) { w.terminate().catch(() => {}); throw Object.assign(new Error('regex thread did not start'), { code: 'REGEX_TIMEOUT', ms: 0 }); }
  return r;
}

/**
 * Runs a (checked) expression on a text in the thread, case-insensitive like compileRegex. → { match, key, ms }:
 * key = the first group (group: true), ms = the time of the expression itself. Throws { code: 'REGEX_TIMEOUT', ms }
 * when it did not finish within limitMs (the thread is stopped), HttpError(err.regexInvalid) for an invalid one.
 */
export function regexRun(src, text, { group = false, limitMs = HARD_MS } = {}, retried = false) {
  if (!runner) runner = startRunner();
  const r = runner;
  Atomics.store(r.ctrl, 0, 0);
  Atomics.store(r.ctrl, 2, 0);
  r.w.postMessage({ src: String(src), text: String(text ?? '').slice(0, 4000), group: !!group });
  Atomics.wait(r.ctrl, 0, 0, limitMs);
  const state = Atomics.load(r.ctrl, 0);
  if (state === 0) {
    runner = null;
    r.w.terminate().catch(() => {});
    // the thread never took the text (it had ended, e.g. at its memory limit): not the expression's fault - once more
    if (!Atomics.load(r.ctrl, 2) && !retried) return regexRun(src, text, { group, limitMs }, true);
    throw Object.assign(new Error(`regular expression stopped after ${limitMs} ms`), { code: 'REGEX_TIMEOUT', ms: limitMs });
  }
  if (state === 3) throw new HttpError(400, 'err.regexInvalid', undefined, 'regex');
  const len = Math.min(120, r.out[0]);
  const key = state === 1 && len ? String.fromCharCode(...r.out.subarray(1, 1 + len)) : '';
  return { match: state === 1, key, ms: r.num[0] };
}
