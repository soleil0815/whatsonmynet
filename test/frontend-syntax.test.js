// Every script of the interface parses: a syntax error in one view would leave the whole page empty (the browser loads
// them as one module graph), and no other test loads the views.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));

test('all scripts of the interface parse', () => {
  const list = files('public/js');
  assert.ok(list.length > 20);
  const bad = list.map((f) => [f, spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })]).filter(([, r]) => r.status !== 0).map(([f, r]) => `${f}: ${r.stderr.split('\n').slice(0, 4).join(' ')}`);
  assert.deepEqual(bad, []);
});
