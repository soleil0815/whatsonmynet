// A button handler that waits (a question, a request) must take e.currentTarget first: once the event is over it is
// null, and "e.currentTarget.disabled = …" after the wait stops the handler with an error - so nothing happens
// (deleting several sensors/monitors at once did nothing after "Delete" was confirmed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = new URL('../public/js/', import.meta.url).pathname;
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? files(path.join(d, f.name)) : f.name.endsWith('.js') ? [path.join(d, f.name)] : []));

test('no e.currentTarget after an await in the same handler', () => {
  const bad = [];
  for (const f of files(dir)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\be\.currentTarget\b/.test(line)) return;
      // an await before it on the same line (except inside busy(e.currentTarget, async () => { await … }))
      const before = line.slice(0, line.indexOf('e.currentTarget'));
      if (/\bawait\b/.test(before)) bad.push(`${path.relative(dir, f)}:${i + 1}`);
      // or an awaited question on one of the lines just before, within the same function
      for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
        if (/=>\s*\{\s*$|function\s*\w*\s*\(|^\s*\}/.test(lines[k])) break;
        if (/\bawait\b/.test(lines[k])) { bad.push(`${path.relative(dir, f)}:${i + 1}`); break; }
      }
    });
  }
  assert.deepEqual(bad, []);
});
