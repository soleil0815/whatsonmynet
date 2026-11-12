import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmp } from './helpers.js';
import { createTls, describePem } from '../src/tls.js';

const dir = path.join(tmp, 'tls-test');
const work = path.join(tmp, 'tls-work');
fs.mkdirSync(work, { recursive: true });

function makeCert(name, days = 30) {
  const key = path.join(work, `${name}.key`);
  const crt = path.join(work, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', String(days),
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(crt, 'utf8'), keyFile: key, certFile: crt };
}

test('first start creates a self-signed certificate with key mode 600', async () => {
  const tls = createTls(dir);
  assert.equal(await tls.ensure(), true);
  const info = tls.describe();
  assert.equal(info.source, 'self-signed');
  assert.ok(info.names.includes('localhost'));
  assert.ok(info.names.includes('127.0.0.1'));
  assert.equal(fs.statSync(path.join(dir, 'key.pem')).mode & 0o777, 0o600);
  // second start: nothing to do
  assert.equal(await tls.ensure(), false);
});

test('own PEM certificate: checked and installed; wrong key refused', async () => {
  const tls = createTls(dir);
  const a = makeCert('womn.firma.local');
  const b = makeCert('other.local');
  await assert.rejects(tls.installCustom({ certPem: a.cert, keyPem: b.key }), /err.tlsKeyMismatch/);
  await assert.rejects(tls.installCustom({ certPem: 'nonsense', keyPem: a.key }), /err.tlsNoCert/);
  await assert.rejects(tls.installCustom({ certPem: a.cert, keyPem: 'nonsense' }), /err.tlsBadKey/);
  const info = await tls.installCustom({ certPem: a.cert, keyPem: a.key });
  assert.equal(info.source, 'custom');
  assert.equal(info.subject, 'womn.firma.local');
  // a restart keeps the own certificate
  assert.equal(await tls.ensure(), false);
  assert.equal(createTls(dir).describe().source, 'custom');
});

test('own certificate as PKCS#12 (.pfx) with password, chain order fixed', async () => {
  const tls = createTls(dir);
  const c = makeCert('pfx.firma.local');
  const ca = makeCert('Some CA');
  const pfx = path.join(work, 'c.pfx');
  // CA first on purpose: the leaf must still end up first
  fs.writeFileSync(path.join(work, 'chain.pem'), ca.cert + c.cert);
  execFileSync('openssl', ['pkcs12', '-export', '-out', pfx, '-inkey', c.keyFile, '-in', path.join(work, 'chain.pem'), '-passout', 'pass:geheim'], { stdio: 'ignore' });
  await assert.rejects(tls.installCustom({ pfx: fs.readFileSync(pfx), passphrase: 'falsch' }), /err.tlsBadPfx/);
  const info = await tls.installCustom({ pfx: fs.readFileSync(pfx), passphrase: 'geheim' });
  assert.equal(info.subject, 'pfx.firma.local');
  assert.equal(info.chain, 2);
  assert.equal(describePem(fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8')).subject, 'pfx.firma.local');
});

test('back to self-signed', async () => {
  const tls = createTls(dir);
  assert.equal((await tls.resetToSelfSigned()).source, 'self-signed');
});
