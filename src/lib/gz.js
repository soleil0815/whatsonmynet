// Compressed backups: gzip with the rights of the database (0600) from the first byte on, streamed where possible.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
export const isGzip = (buf) => Buffer.isBuffer(buf) && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

/** A name not taken yet: "x.sqlite.gz", else "x-2.sqlite.gz" … (two copies in the same second) */
export function freeName(file) {
  if (!fs.existsSync(file)) return file;
  const m = /^(.*?)(\.sqlite(?:\.gz)?)$/.exec(file) || [file, file, ''];
  for (let i = 2; i < 1000; i++) { const f = `${m[1]}-${i}${m[2]}`; if (!fs.existsSync(f)) return f; }
  return file;
}

/** A new file only this program may read - never an existing one, never with wider rights for a moment */
const createPrivate = (file) => fs.closeSync(fs.openSync(file, 'wx', 0o600));

/** src → src.gz-like target, streamed (the daily backup) */
export async function gzipFile(src, dest) {
  createPrivate(dest);
  try {
    await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(dest, { flags: 'r+' }));
  } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
}

/** The same at startup, where nothing may wait (the copy before a schema update or a restore) */
export function gzipFileSync(src, dest) {
  createPrivate(dest);
  try { fs.writeFileSync(dest, zlib.gzipSync(fs.readFileSync(src), { level: 6 })); } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
}

/** gz → file, at most maxBytes unpacked (a "zip bomb" is stopped, not unpacked to the end) */
export async function gunzipFile(src, dest, maxBytes = 4 * 1024 ** 3) {
  let n = 0;
  const limit = new Transform({ transform(chunk, _enc, cb) { n += chunk.length; cb(n > maxBytes ? new Error('too big') : null, chunk); } });
  createPrivate(dest);
  try { await pipeline(fs.createReadStream(src), zlib.createGunzip(), limit, fs.createWriteStream(dest, { flags: 'r+' })); } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
}
