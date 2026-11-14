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
    if (env.length < 16) throw new Error('WOMN_SECRET is too short (at least 16 characters) - change it or leave it empty.');
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

/** Failover: the key in use (sent to a paired standby, so it can read the stored passwords of the master) */
export function currentKey() { return Buffer.from(masterKey); }
/** Is WOMN_SECRET set? Then the key cannot be replaced by the one of a master */
export const keyFromEnvironment = () => !!process.env.WOMN_SECRET;
/**
 * Failover: a standby takes over the key of its master. Step 1 writes it to a new file (never a half-written key
 * file); step 2 (commit) puts it in place with rename, keeps the previous key next to it and uses it from then on.
 * Returns null when the key is the one in use already.
 */
export function prepareKey(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 32) throw new Error('invalid key');
  if (masterKey && Buffer.compare(buf, masterKey) === 0) return null;
  if (process.env.WOMN_SECRET) throw new Error('WOMN_SECRET is set and differs from the key of the master');
  const tmp = `${paths.secretKey}.new`;
  fs.writeFileSync(tmp, buf.toString('base64'), { mode: 0o600 });
  return {
    commit() {
      if (fs.existsSync(paths.secretKey)) fs.copyFileSync(paths.secretKey, `${paths.secretKey}.before-standby`);
      fs.renameSync(tmp, paths.secretKey);
      masterKey = Buffer.from(buf);
    },
    discard() { fs.rmSync(tmp, { force: true }); },
  };
}
/** Decrypts with a given key (to check a database of a master before its key is taken over) */
export function decryptWith(key, blob) {
  const raw = Buffer.from(String(blob).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** Scan agent: a key that lives only in memory (the agent stores nothing secret on disk) */
export function useEphemeralKey() { masterKey = crypto.randomBytes(32); }

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
