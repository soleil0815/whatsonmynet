// Light is the default look: new accounts are light, accounts on the old default "like the system" became light,
// dark stays dark; the page starts light before the account is known.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { memoryDb } from './helpers.js';
import { createUsers } from '../src/auth/users.js';

test('new accounts are light, a chosen theme stays', () => {
  const db = memoryDb();
  const users = createUsers(db);
  const a = users.create({ username: 'anna', password: 'Sicher-Passwort-1', role: 'viewer' });
  assert.equal(db.prepare('SELECT theme FROM users WHERE id=?').get(a.id).theme, 'light');
  const b = users.create({ username: 'ben', password: 'Sicher-Passwort-1', role: 'viewer', theme: 'dark' });
  assert.equal(db.prepare('SELECT theme FROM users WHERE id=?').get(b.id).theme, 'dark');
});

test('migration 26: "like the system" became light, dark stayed dark', () => {
  const src = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(src, /UPDATE users SET theme='light' WHERE theme='system'/);
});

test('before signing in the page is light unless dark was chosen', () => {
  const js = fs.readFileSync(new URL('../public/js/theme.js', import.meta.url), 'utf8');
  assert.match(js, /localStorage\.getItem\('womn-theme'\) \|\| 'light'/);
  assert.match(js, /pref === 'system' && window\.matchMedia/);
});
