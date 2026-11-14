// Failover: the standby takes over the key of its master - written beside first, put in place only with the data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tmp } from './helpers.js';
import { prepareKey, encrypt, decrypt, setMasterKeyForTests, currentKey } from '../src/lib/crypto.js';

test('key of the master: prepared beside, in use only after commit, the old one kept; never with WOMN_SECRET', () => {
  const own = crypto.randomBytes(32); const theirs = crypto.randomBytes(32);
  const file = path.join(tmp, 'secret.key');
  setMasterKeyForTests(own);
  fs.writeFileSync(file, own.toString('base64'));
  assert.equal(prepareKey(Buffer.from(own)), null);
  const p = prepareKey(theirs);
  assert.ok(fs.existsSync(`${file}.new`));
  assert.deepEqual(currentKey(), own);
  // discarded (the copy could not be taken): nothing changed
  p.discard();
  assert.ok(!fs.existsSync(`${file}.new`));
  assert.equal(fs.readFileSync(file, 'utf8'), own.toString('base64'));
  const q = prepareKey(theirs);
  q.commit();
  assert.deepEqual(currentKey(), theirs);
  assert.equal(fs.readFileSync(file, 'utf8'), theirs.toString('base64'));
  assert.equal(fs.readFileSync(`${file}.before-standby`, 'utf8'), own.toString('base64'));
  assert.equal(decrypt(encrypt('x')), 'x');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  process.env.WOMN_SECRET = 'ein-langes-geheimnis-1234';
  try { assert.throws(() => prepareKey(crypto.randomBytes(32)), /WOMN_SECRET/); } finally { delete process.env.WOMN_SECRET; }
});
