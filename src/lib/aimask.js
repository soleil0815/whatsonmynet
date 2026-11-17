// Text that leaves the house (e.g. pasted into an AI chat): names, addresses, accounts and domains of one's own network
// replaced by placeholders. What stays is what explains a message: event source, numbers, the wording of Windows.

const FILE_EXT = /\.(exe|dll|sys|ps1|psm1|psd1|bat|cmd|msi|msp|vbs|js|log|evtx|xml|json|txt|ini|inf|cab|tmp|dat|com|ocx|cpl|drv)$/i;
// names Windows itself uses that look like a domain (kept: they say what it is about)
const KEEP_DOMAINS = /(^|\.)(microsoft\.com|windows\.com|windowsupdate\.com|office\.com|office365\.com|live\.com|msftncsi\.com|msftconnecttest\.com|digicert\.com|verisign\.com)$/i;

/**
 * A masker that gives every distinct value its own placeholder ("Rechner 1", "Konto 2" …), so the text still shows
 * which messages come from the same machine or account.
 * @param {{ names?: string[], lang?: string }} opts names known to be local (computer names, devices, addresses)
 */
export function createMasker({ names = [], lang = 'de' } = {}) {
  const de = lang !== 'en';
  const label = { host: de ? 'Rechner' : 'Computer', ip: de ? 'Adresse' : 'Address', user: de ? 'Konto' : 'Account', domain: de ? 'Domäne' : 'Domain',
    mail: de ? 'E-Mail' : 'Email', sid: 'SID', mac: 'MAC' };
  const seen = new Map();
  const ph = (kind, value) => {
    const key = `${kind}:${String(value).toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, `<${label[kind]} ${[...seen.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1}>`);
    return seen.get(key);
  };
  // longest first, so that "pc-0001.firma.local" goes before "pc-0001"
  const known = [...new Set(names.map((n) => String(n || '').trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const knownRe = known.length ? new RegExp(`(?<![\\w-])(${known.map(esc).join('|')})(?![\\w-])`, 'gi') : null;
  return function mask(text) {
    let s = String(text ?? '');
    s = s.replace(/\bS-1-5-21(-\d+){3,}\b/g, (m) => ph('sid', m));
    s = s.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => ph('mail', m));
    s = s.replace(/\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, (m) => ph('mac', m));
    s = s.replace(/\b(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, (m) => (/^(0\.0\.0\.0|127\.0\.0\.1)$/.test(m) ? m : ph('ip', m)));
    s = s.replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}(?![\w:])/gi, (m) => (/^(::1|fe80:.*)$/i.test(m) ? m : ph('ip', m)));
    s = s.replace(/(\\Users\\|\\Benutzer\\)([^\\\s"']+)/gi, (m, pre, user) => (/^(Public|Default|All Users|Öffentlich)$/i.test(user) ? m : `${pre}${ph('user', user)}`));
    // DOMAIN\user (also in "Kontoname: FIRMA\m.muster") and user folders
    // (not in paths like C:\Windows\system32, not Windows' own: NT AUTHORITY\SYSTEM, BUILTIN\…)
    s = s.replace(/(?<![\\:.\w-])([A-Za-z][\w-]{1,30})\\([\w.$-]{1,64})/g, (m, dom, user) => (/^(AUTHORITY|AUTORIT|BUILTIN|VORDEFINIERT|SERVICE|Manager|Host|APPPOOL|Driver)$/i.test(dom)
      ? m : `${ph('domain', dom)}\\${ph('user', user)}`));
    // account fields in the text of Windows events
    s = s.replace(/((?:Kontoname|Account Name|Benutzername|User Name|Benutzer|User|Kontodomäne|Account Domain|Arbeitsstationsname|Workstation Name|Computername|Computer)\s*:\s*)([^\s\r\n\t,;]+)/gi,
      (m, pre, v) => (/^(-|SYSTEM|LOKALER DIENST|NETZWERKDIENST|LOCAL SERVICE|NETWORK SERVICE|ANONYMOUS LOGON|ANONYMOUS-ANMELDUNG|NT AUTHORITY|NT-AUTORITÄT|<.*)$/i.test(v)
        ? m : `${pre}${ph(/dom/i.test(pre) ? 'domain' : /station|computer/i.test(pre) ? 'host' : 'user', v)}`));
    if (knownRe) s = s.replace(knownRe, (m) => ph('host', m));
    // names with dots that end like a domain - also a short one like firma.local (not file names, not Windows' own)
    s = s.replace(/\b[a-z0-9][\w-]*(\.[a-z0-9][\w-]*)*\.[a-z]{2,24}\b/gi, (m) => (FILE_EXT.test(m) || KEEP_DOMAINS.test(m) || /^(microsoft|windows|system)\./i.test(m) || /^\d+(\.\d+)+$/.test(m) ? m : ph('domain', m)));
    return s;
  };
}
