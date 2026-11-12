// Password hashes (scrypt) and encryption of stored secrets (AES-256-GCM).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths } from '../config.js';

let masterKey = null;

/** Loads the key from WOMN_SECRET or <data>/secret.key (created on first start). */
export function initMasterKey() {
  const env = process.env.WOMN_SECRET;
  if (env) {
    // Never ignore a value that is too short (the key would change unnoticed)
    if (env.length < 16) throw new Error('WOMN_SECRET is too short (at least 16 characters) – change it or leave it empty.');
    masterKey = crypto.createHash('sha256').update(env).digest();
    return;
  }
  if (!fs.existsSync(paths.secretKey)) {
    fs.writeFileSync(paths.secretKey, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  masterKey = Buffer.from(fs.readFileSync(paths.secretKey, 'utf8').trim(), 'base64');
  if (masterKey.length !== 32) throw new Error(`Key file ${paths.secretKey} is damaged.`);
}

export function setMasterKeyForTests(buf) { masterKey = buf; }

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decrypt(blob) {
  if (!blob) return '';
  if (!String(blob).startsWith('v1:')) throw new Error('Unknown secret format');
  const raw = Buffer.from(String(blob).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Compared against when the user does not exist, so the answer takes the same time
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export function verifyPassword(pw, stored) {
  const target = stored && String(stored).startsWith('scrypt$') ? String(stored) : DUMMY_HASH;
  const [, n, salt, hash] = target.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
  return crypto.timingSafeEqual(expected, actual) && target === stored;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
