import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, totpAt, verifyTotp, newRecoveryCodes, useRecoveryCode } from '../src/auth/totp.js';
import { startApp } from './helpers.js';

const rfc = base32Encode(Buffer.from('12345678901234567890'));

test('TOTP: RFC 6238 test values, window, each code once', () => {
  assert.equal(base32Decode(rfc).toString(), '12345678901234567890');
  assert.equal(totpAt(rfc, 1), '287082');
  assert.equal(totpAt(rfc, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpAt(rfc, Math.floor(1234567890 / 30)), '005924');
  const now = 1234567890 * 1000;
  assert.equal(verifyTotp(rfc, '005924', { now }), Math.floor(1234567890 / 30));
  assert.equal(verifyTotp(rfc, totpAt(rfc, Math.floor(1234567890 / 30) - 1), { now }) !== null, true, 'previous step still accepted');
  assert.equal(verifyTotp(rfc, totpAt(rfc, Math.floor(1234567890 / 30) - 2), { now }), null, 'older ones not');
  assert.equal(verifyTotp(rfc, '005924', { now, lastStep: Math.floor(1234567890 / 30) }), null, 'replay refused');
  assert.equal(verifyTotp(rfc, 'abc', { now }), null);
});

test('recovery codes are used up', () => {
  const rc = newRecoveryCodes();
  assert.equal(rc.plain.length, 10);
  assert.match(rc.plain[0], /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  const left = useRecoveryCode(rc.hashes, rc.plain[3].toUpperCase().replace(/-/g, ' '));
  assert.equal(left.length, 9);
  assert.equal(useRecoveryCode(left, rc.plain[3]), null);
});

test('two-factor sign-in end to end', async () => {
  const app = await startApp({ setupToken: 'tf-setup' });
  const { call } = app;
  try {
    await call('POST', '/api/setup', { code: 'tf-setup', username: 'admin', password: 'Admin-Passwort-1', email: 'a@x.de' });
    // requiring 2FA for admins needs it on the own account first
    assert.equal((await call('PUT', '/api/settings/security', { require2faAdmins: true })).status, 400);
    const s = (await call('POST', '/api/me/2fa/setup')).data;
    assert.match(s.uri, /^otpauth:\/\/totp\//);
    assert.match(s.svg, /^<svg/);
    assert.equal((await call('POST', '/api/me/2fa/enable', { code: '000000' })).status, 400);
    const step = Math.floor(Date.now() / 30000);
    const en = await call('POST', '/api/me/2fa/enable', { code: totpAt(s.secret, step) });
    assert.equal(en.data.recoveryCodes.length, 10);
    // sign-in now needs the code
    const login = (body) => call('POST', '/api/login', { username: 'admin', password: 'Admin-Passwort-1', ...body }, { who: 'second' });
    const r1 = await login({});
    assert.equal(r1.status, 401);
    assert.equal(r1.data.error.code, 'err.totpRequired');
    assert.equal((await login({ code: totpAt(s.secret, step) })).status, 401, 'the code used for enabling does not work again');
    assert.equal((await login({ code: totpAt(s.secret, step + 1) })).status, 200);
    assert.equal((await login({ code: en.data.recoveryCodes[0] })).status, 200, 'recovery code');
    assert.equal((await login({ code: en.data.recoveryCodes[0] })).status, 401, 'only once');
    assert.equal((await call('GET', '/api/me/2fa')).data.recoveryLeft, 9);
    // admin requirement: a second admin without 2FA can only reach his own account
    assert.equal((await call('PUT', '/api/settings/security', { require2faAdmins: true })).status, 200);
    await call('POST', '/api/users', { username: 'admin2', password: 'Admin-Passwort-2', role: 'admin' });
    assert.equal((await call('POST', '/api/login', { username: 'admin2', password: 'Admin-Passwort-2' }, { who: 'a2' })).status, 200);
    assert.equal((await call('GET', '/api/devices', undefined, { who: 'a2' })).status, 403);
    assert.equal((await call('GET', '/api/me/2fa', undefined, { who: 'a2' })).data.required, true);
    // admin resets the 2FA of another account
    const users = (await call('GET', '/api/users')).data;
    assert.equal((await call('DELETE', `/api/users/${users.find((u) => u.username === 'admin').id}/2fa`)).status, 200);
  } finally { await app.close(); }
});
