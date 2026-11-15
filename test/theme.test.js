// The look follows the system by default (light or dark as the computer or phone is set): new accounts and the page
// before signing in; a chosen light or dark stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { memoryDb } from './helpers.js';
import { createUsers } from '../src/auth/users.js';

test('new accounts follow the system, a chosen theme stays', () => {
  const db = memoryDb();
  const users = createUsers(db);
  const a = users.create({ username: 'anna', password: 'Sicher-Passwort-1', role: 'viewer' });
  assert.equal(db.prepare('SELECT theme FROM users WHERE id=?').get(a.id).theme, 'system');
  const b = users.create({ username: 'ben', password: 'Sicher-Passwort-1', role: 'viewer', theme: 'dark' });
  assert.equal(db.prepare('SELECT theme FROM users WHERE id=?').get(b.id).theme, 'dark');
  const c = users.create({ username: 'cem', password: 'Sicher-Passwort-1', role: 'viewer', theme: 'light' });
  assert.equal(db.prepare('SELECT theme FROM users WHERE id=?').get(c.id).theme, 'light');
});

test('migration 33: accounts made light by migration 26 follow the system again, dark stays dark', () => {
  const src = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(src, /UPDATE users SET theme='system' WHERE theme='light'/);
  assert.ok(src.indexOf("UPDATE users SET theme='system' WHERE theme='light'") > src.indexOf("UPDATE users SET theme='light' WHERE theme='system'"), 'after migration 26');
});

test('before signing in the page follows the system unless light or dark was chosen', () => {
  const js = fs.readFileSync(new URL('../public/js/theme.js', import.meta.url), 'utf8');
  assert.match(js, /localStorage\.getItem\('womn-theme'\) \|\| 'system'/);
  assert.match(js, /pref === 'system' && window\.matchMedia/);
});
