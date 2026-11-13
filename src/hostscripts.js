// Scripts that a host runs itself (no agent, no open port): Windows and Linux machines, Hyper-V and KVM hosts.
// Every script sets itself up on its first call (scheduled task / cron) and has an uninstall script that removes
// exactly that again. Address, key and - for the self-signed certificate of WhatsOnMyNet - its fingerprint are
// written in, so nothing has to be typed in on the host.
import fs from 'node:fs';

const KINDS = {
  windows: { file: 'womn-host.ps1', ps: true, task: 'WhatsOnMyNet-Host', old: [], extra: ['womn-updates.json'] },
  linux: { file: 'womn-host.sh', ps: false, cron: 'whatsonmynet-host', old: [] },
  hyperv: { file: 'womn-hyperv.ps1', ps: true, task: 'WhatsOnMyNet-HyperV', old: ['WhatsOnMyNet'] },
  libvirt: { file: 'womn-libvirt.sh', ps: false, cron: 'whatsonmynet-kvm', old: ['whatsonmynet'] },
};
export const SCRIPT_KINDS = Object.keys(KINDS);

const read = (file) => fs.readFileSync(new URL(`./hostscripts/${file}`, import.meta.url), 'utf8');
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const psList = (a) => (a.length ? `@(${a.map(psQuote).join(', ')})` : '@()');
const shList = (a) => (a.length ? a.map(shQuote).join(' ') : "''");
const uninstallName = (file) => file.replace(/\.(ps1|sh)$/, '-uninstall.$1');

/**
 * The script for a host. url: where it sends to; token: its key; pin: { sha1, spki } of a self-signed certificate
 * of WhatsOnMyNet (empty when a public CA vouches for it).
 */
export function hostScript(kind, { url, token, pin = {} }) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown script kind ${kind}`);
  const setup = k.ps
    ? read('setup.ps1.part').replace('@TASK@', psQuote(k.task)).replace('@FILE@', psQuote(k.file)).replace('@OLD@', psList(k.old))
    : read('setup.sh.part').replace('@FILE@', shQuote(k.file)).replace('@CRON@', shQuote(k.cron)).replace('@OLD@', shList(k.old));
  let text = read(k.file).replace('@SETUP@', setup.trimEnd());
  text = k.ps
    ? text.replace('@URL@', psQuote(url)).replace('@TOKEN@', psQuote(token)).replace('@THUMB@', psQuote(pin.sha1 || ''))
    : text.replace('@URL@', shQuote(url)).replace('@TOKEN@', shQuote(token)).replace('@PIN@', shQuote(pin.spki ? `sha256//${pin.spki}` : ''));
  return { file: k.file, text, uninstall: uninstallScript(kind) };
}

/** Removes the scheduled task / cron entry and the script file again (also the setup of version 0.6.0) */
export function uninstallScript(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown script kind ${kind}`);
  const text = k.ps
    ? read('uninstall.ps1').replace('@TASKS@', psList([k.task, ...k.old])).replace('@FILES@', psList([k.file, ...(k.extra || [])]))
    : read('uninstall.sh').replace('@FILES@', shList([k.file])).replace('@CRONS@', shList([k.cron, ...k.old]));
  return { file: uninstallName(k.file), text };
}
