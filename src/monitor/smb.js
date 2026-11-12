// Network drive (SMB share, e.g. \\fs01\Abteilung on Windows or a NAS): signs in with a read-only account, lists the
// share (or one folder/file in it) and reads the free space. Uses smbclient (Samba) – read-only commands only.
//
// Security: the password goes to smbclient through the environment (PASSWD), never on the command line (visible in
// the process list). The command string only ever contains "ls" or "du" with a strictly checked path, so no other
// smbclient command (put, rm, "!" shell escape …) can be smuggled in.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

export const SHARE = /^[^\\/:*?"<>|;!\x00-\x1f]{1,80}$/;
const PATH_PART = /^[^\\/:*?"<>|;!`$\x00-\x1f]{1,255}$/;
export const SMB_USER = /^[^\\/:*?"<>|;%@\x00-\x1f]{1,104}$/;
export const SMB_DOMAIN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;

/** "Projekte/2026", "\Projekte\2026\" → "Projekte\2026"; null if not allowed ('' = the share itself) */
export function smbPath(p) {
  const parts = String(p ?? '').split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 32) return null;
  if (parts.some((s) => s === '.' || s === '..' || !PATH_PART.test(s))) return null;
  return parts.join('\\');
}

/** Free space line of smbclient: "264212084 blocks of size 1024. 31007172 blocks available" → bytes */
export function parseSpace(out) {
  const m = /(\d+) blocks of size (\d+)\. (\d+) blocks available/.exec(out);
  if (!m) return null;
  const size = Number(m[2]);
  const total = Number(m[1]) * size;
  const free = Number(m[3]) * size;
  if (!total) return null;
  return { total, free, pct: Math.round((free / total) * 1000) / 10 };
}

const STATUS = {
  NT_STATUS_LOGON_FAILURE: 'sign-in failed (user or password wrong)',
  NT_STATUS_ACCOUNT_LOCKED_OUT: 'account locked',
  NT_STATUS_ACCOUNT_DISABLED: 'account disabled',
  NT_STATUS_PASSWORD_EXPIRED: 'password expired',
  NT_STATUS_PASSWORD_MUST_CHANGE: 'password must be changed',
  NT_STATUS_ACCOUNT_EXPIRED: 'account expired',
  NT_STATUS_BAD_NETWORK_NAME: 'share not found',
  NT_STATUS_ACCESS_DENIED: 'access denied',
  NT_STATUS_NO_SUCH_FILE: 'folder or file not found',
  NT_STATUS_OBJECT_NAME_NOT_FOUND: 'folder or file not found',
  NT_STATUS_OBJECT_PATH_NOT_FOUND: 'folder or file not found',
  NT_STATUS_CONNECTION_REFUSED: 'connection refused',
  NT_STATUS_HOST_UNREACHABLE: 'host unreachable',
  NT_STATUS_NETWORK_UNREACHABLE: 'network unreachable',
  NT_STATUS_IO_TIMEOUT: 'timeout',
  NT_STATUS_NOT_SUPPORTED: 'protocol not supported (SMB1 only?)',
  NT_STATUS_INVALID_NETWORK_RESPONSE: 'protocol not supported (SMB1 only?)',
  NT_STATUS_CONNECTION_RESET: 'connection reset',
  NT_STATUS_CONNECTION_DISCONNECTED: 'connection reset',
  NT_STATUS_UNSUCCESSFUL: 'name not found or not reachable',
};
export function smbError(out) {
  const m = /NT_STATUS_[A-Z_]+/.exec(out);
  if (m) return STATUS[m[0]] || m[0];
  return null;
}

const unit = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function bytes(n) {
  let v = Number(n) || 0; let i = 0;
  while (v >= 1000 && i < unit.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${unit[i]}`;
}

let available = null;
/** Is smbclient installed? (part of the container image) */
export function smbclientAvailable() {
  if (available !== null) return Promise.resolve(available);
  return new Promise((resolve) => {
    execFile(process.env.WOMN_SMBCLIENT || 'smbclient', ['--version'], { timeout: 5000 }, (err) => { available = !err; resolve(available); });
  });
}

/**
 * Arguments and environment for smbclient. Throws on anything not allowed (checked again here, not only when saving).
 */
export function smbCommand(host, port, o, password, timeoutS = 10) {
  const share = String(o.share || '');
  const path = smbPath(o.path);
  if (!SHARE.test(share) || path === null || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(String(host))) throw new Error('invalid share or path');
  const user = String(o.user || '');
  const domain = String(o.domain || '');
  if (user && !SMB_USER.test(user)) throw new Error('invalid user');
  if (domain && !SMB_DOMAIN.test(domain)) throw new Error('invalid domain');
  // The container runs with a read-only file system: smbclient keeps its small cache files in /tmp
  const work = nodePath.join(os.tmpdir(), 'womn-smb');
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const args = ['-s', '/dev/null', `//${host}/${share}`, '-p', String(port || 445), '-t', String(Math.max(1, timeoutS)),
    '--option=client min protocol=SMB2', '--option=client signing=desired',
    ...['lock directory', 'state directory', 'cache directory', 'private dir'].map((k) => `--option=${k}=${work}`)];
  const env = { PATH: process.env.PATH, HOME: work, LANG: 'C' };
  if (user) {
    args.push('-U', domain ? `${domain}\\${user}` : user);
    if (password) env.PASSWD = password; else args.push('-N');
  } else {
    args.push('-N');
  }
  args.push('-c', path ? `ls "${path}"` : 'du');
  return { args, env, path };
}

/**
 * Signs in to //host/share and lists `path` (or reads the free space of the share).
 * o: { share, path, user, domain, minFreePct, minFreeGb }; password separately.
 * Returns { ok, ms, message, data: { total, free, pct } }.
 */
export async function smbCheck(host, port, o, password, timeoutS = 10) {
  if (!(await smbclientAvailable())) return { ok: false, ms: null, message: 'smbclient missing on this host', unsupported: true };
  let cmd;
  try { cmd = smbCommand(host, port, o, password, timeoutS); } catch (e) { return { ok: false, ms: null, message: e.message }; }
  const { args, env, path } = cmd;

  const t0 = Date.now();
  const out = await new Promise((resolve) => {
    execFile(process.env.WOMN_SMBCLIENT || 'smbclient', args, { env, timeout: (timeoutS + 2) * 1000, maxBuffer: 2 * 1024 * 1024, killSignal: 'SIGKILL', windowsHide: true },
      (err, stdout, stderr) => resolve({ err, text: `${stdout || ''}\n${stderr || ''}` }));
  });
  const ms = Date.now() - t0;
  if (out.err && out.err.killed) return { ok: false, ms: null, message: `timeout (${timeoutS} s)` };
  const failed = smbError(out.text);
  if (failed) return { ok: false, ms: null, message: failed };
  if (out.err) return { ok: false, ms: null, message: (out.text.trim().split('\n').pop() || 'smbclient failed').slice(0, 200) };
  const space = parseSpace(out.text);
  if (!space) return { ok: true, ms, message: path ? `${path} found` : 'share readable', data: {} };
  const minPct = Number(o.minFreePct) || 0;
  const minGb = Number(o.minFreeGb) || 0;
  const info = `${bytes(space.free)} free of ${bytes(space.total)} (${space.pct} %)`;
  const low = (minPct && space.pct < minPct) || (minGb && space.free < minGb * 1e9);
  return { ok: !low, ms: low ? null : ms, message: low ? `only ${info}` : info, data: { ...space, low: !!low } };
}
