// Two-factor sign-in with an authenticator app (TOTP, RFC 6238: SHA-1, 6 digits, 30 seconds) plus one-time
// recovery codes. Only for local accounts - Active Directory accounts use the protection of the directory.
import crypto from 'node:crypto';
import QRCode from 'qrcode';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

/** Code of one 30-second step */
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = hmac[hmac.length - 1] & 15;
  const n = (hmac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/**
 * Checks a code (the step before and after count too - clocks drift). Returns the step that matched, or null.
 * lastStep: steps up to this one were already used (a code works only once).
 */
export function verifyTotp(secret, code, { now = Date.now(), lastStep = 0 } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    const expected = totpAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

export function otpauthUri(secret, account, issuer = 'WhatsOnMyNet') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

/** 10 recovery codes like "k7m2-9qxp-c4tn": plain for the user (shown once), hashes for the database */
export function newRecoveryCodes(n = 10) {
  const alpha = 'abcdefghjkmnpqrstuvwxyz23456789';
  const plain = Array.from({ length: n }, () => Array.from({ length: 3 }, () => Array.from(crypto.randomBytes(4), (b) => alpha[b % alpha.length]).join('')).join('-'));
  return { plain, hashes: plain.map(hashCode) };
}

/** Uses up a recovery code: returns the remaining hashes, or null if the code is unknown */
export function useRecoveryCode(hashes, code) {
  const h = hashCode(code);
  const i = (hashes || []).indexOf(h);
  if (i < 0) return null;
  return hashes.filter((_, j) => j !== i);
}
