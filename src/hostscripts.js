// Scripts that a host runs itself (no agent, no open port): Windows and Linux machines, Hyper-V and KVM hosts.
// Every script sets itself up on its first call (scheduled task / cron) and has an uninstall script that removes
// exactly that again. Address, key and - for the self-signed certificate of WhatsOnMyNet - its fingerprint are
// written in, so nothing has to be typed in on the host.
import fs from 'node:fs';
import crypto from 'node:crypto';

const KINDS = {
  windows: { file: 'womn-host.ps1', ps: true, task: 'WhatsOnMyNet-Host', old: [], extra: ['womn-updates.json', 'womn-plugins.txt', 'womn-plugin-*.out', 'womn-nics.txt', 'womn-host-update.json', 'womn-host.ps1.download', 'womn-host.ps1.new'] },
  linux: { file: 'womn-host.sh', ps: false, cron: 'whatsonmynet-host', old: [] },
  hyperv: { file: 'womn-hyperv.ps1', ps: true, task: 'WhatsOnMyNet-HyperV', old: ['WhatsOnMyNet'] },
  libvirt: { file: 'womn-libvirt.sh', ps: false, cron: 'whatsonmynet-kvm', old: ['whatsonmynet'] },
};
export const SCRIPT_KINDS = Object.keys(KINDS);
// The version of each Windows script: the WhatsOnMyNet version in which it last changed - not the running version, so
// that an update of WhatsOnMyNet does not make every machine "outdated". Written into the script (first line, registry
// HKLM\SOFTWARE\WhatsOnMyNet) and sent with every report. test/hostscriptversion.test.js fails when a script changes
// and its number stays.
export const SCRIPT_VERSIONS = { windows: '0.59.0', hyperv: '0.59.0', linux: '0.59.0' };
// the value under HKLM\SOFTWARE\WhatsOnMyNet (software distribution and inventory tools filter on it)
const REG_NAMES = { windows: 'HostScript', hyperv: 'HyperVScript' };

const read = (file) => fs.readFileSync(new URL(`./hostscripts/${file}`, import.meta.url), 'utf8');
// PowerShell also takes the typographic quotes ‘ ’ ‚ ‛ as a single quote: they are doubled too
const psQuote = (s) => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const psList = (a) => (a.length ? `@(${a.map(psQuote).join(', ')})` : '@()');
const shList = (a) => (a.length ? a.map(shQuote).join(' ') : "''");
const uninstallName = (file) => file.replace(/\.(ps1|sh)$/, '-uninstall.$1');

/**
 * The script for a host. url: where it sends to; token: its key; pin: { sha1, spki, key } of a self-signed
 * certificate of WhatsOnMyNet (empty when a public CA vouches for it) - key is its public key as Windows reads it.
 */
export function hostScript(kind, { url, token, pin = {}, template = false }) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown script kind ${kind}`);
  const setup = k.ps
    ? read('setup.ps1.part').replace('@TASK@', () => psQuote(k.task)).replace('@FILE@', () => psQuote(k.file)).replace('@OLD@', () => psList(k.old))
    : read('setup.sh.part').replace('@FILE@', () => shQuote(k.file)).replace('@CRON@', () => shQuote(k.cron)).replace('@OLD@', () => shList(k.old));
  let text = read(k.file).replace('@SETUP@', () => setup.trimEnd());
  // the Linux script carries its version too (first lines, report) - WhatsOnMyNet shows machines with an older one
  if (!k.ps && SCRIPT_VERSIONS[kind]) text = text.replace(/@VERSIONTEXT@/g, () => SCRIPT_VERSIONS[kind]);
  if (k.ps) {
    text = text.replace('@PINCHECK@', () => read('pin.ps1.part').trimEnd()).replace('@SEND@', () => read('send.ps1.part').trimEnd())
      .replace(/@VERSION@/g, () => psQuote(SCRIPT_VERSIONS[kind])).replace(/@VERSIONTEXT@/g, () => SCRIPT_VERSIONS[kind]).replace(/@REGNAME@/g, () => psQuote(REG_NAMES[kind]));
  }
  // template (self-update): the values of the machine stay out - the running script puts its own in (TEMPLATE_MARKS)
  if (template) {
    text = text.replace('@URL@', () => TEMPLATE_MARKS.url).replace('@TOKEN@', () => TEMPLATE_MARKS.token)
      .replace('@THUMB@', () => TEMPLATE_MARKS.thumb).replace('@PUBKEY@', () => TEMPLATE_MARKS.pubkey).replace('@PIN@', () => TEMPLATE_MARKS.pin);
    return { file: k.file, text };
  }
  text = k.ps
    ? text.replace('@URL@', () => psQuote(url)).replace('@TOKEN@', () => psQuote(token)).replace('@THUMB@', () => psQuote(pin.sha1 || '')).replace('@PUBKEY@', () => psQuote(pin.key || ''))
    : text.replace('@URL@', () => shQuote(url)).replace('@TOKEN@', () => shQuote(token)).replace('@PIN@', () => shQuote(pin.spki ? `sha256//${pin.spki}` : ''));
  // where software inventories find the version (Windows scripts): the page shows it next to the download
  const registry = k.ps ? { key: 'HKLM\\SOFTWARE\\WhatsOnMyNet', value: REG_NAMES[kind], version: SCRIPT_VERSIONS[kind] } : null;
  return { file: k.file, text, registry, uninstall: uninstallScript(kind) };
}

// Self-update of the machine scripts (Windows, Linux): WhatsOnMyNet names a newer version in its answer to a report
// ("update": "<version>:<sha256>"); the script fetches the template over the same connection (its key, the pinned
// certificate), checks the fingerprint and the version, puts its own address, key and certificate pin in where the
// marks are, and replaces itself. Only these scripts - not the Hyper-V and KVM ones.
export const SELF_UPDATE_KINDS = ['windows', 'linux'];
export const TEMPLATE_MARKS = { url: '@@WOMN_URL@@', token: '@@WOMN_TOKEN@@', thumb: '@@WOMN_THUMB@@', pubkey: '@@WOMN_PUBKEY@@', pin: '@@WOMN_PIN@@' };
const templates = new Map();
/** The template of a self-updating script and its SHA-256 (of the UTF-8 bytes as sent) */
export function scriptTemplate(kind) {
  if (!SELF_UPDATE_KINDS.includes(kind)) throw new Error(`no self-update for ${kind}`);
  if (!templates.has(kind)) {
    const text = hostScript(kind, { template: true }).text;
    const bytes = Buffer.from(text, 'utf8');
    templates.set(kind, { text, bytes, version: SCRIPT_VERSIONS[kind], sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  return templates.get(kind);
}

/** Removes the scheduled task / cron entry and the script file again (also the setup of version 0.6.0) */
export function uninstallScript(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown script kind ${kind}`);
  const text = k.ps
    ? read('uninstall.ps1').replace('@TASKS@', () => psList([k.task, ...k.old])).replace('@FILES@', () => psList([k.file, k.file.replace(/\.ps1$/, '-send.json'), ...(k.extra || [])]))
      .replace(/@REGNAME@/g, () => psQuote(REG_NAMES[kind]))
    : read('uninstall.sh').replace('@FILES@', () => shList([k.file])).replace('@CRONS@', () => shList([k.cron, ...k.old]));
  return { file: uninstallName(k.file), text };
}

/** What a Windows script is made of (its file and the shared parts) - for the check that its version follows changes */
export function scriptSource(kind) {
  const k = KINDS[kind];
  return k.ps ? [read(k.file), read('setup.ps1.part'), read('pin.ps1.part'), read('send.ps1.part')].join('\n') : read(k.file);
}
