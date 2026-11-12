// Sign-in with Active Directory / LDAP (LDAPS or StartTLS).
//
// 1. A service account searches the user (filter with {username}).
// 2. WhatsOnMyNet binds as that user with the password typed in – the password is never stored.
// 3. The role comes from group membership (nested groups in AD): admin group → admin, editor group → editor,
//    viewer group → viewer. Without one of these groups the sign-in is refused.
import fs from 'node:fs';
import { Client } from 'ldapts';
import { HttpError, line, str } from '../lib/http.js';
import { log } from '../lib/log.js';

export const DEFAULT_FILTER = '(&(objectClass=user)(|(sAMAccountName={username})(userPrincipalName={username})))';
const AD_IN_CHAIN = '1.2.840.113556.1.4.1941';

/** RFC 4515: escape a value for an LDAP filter */
export function escapeFilter(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** "FIRMA\\michael" → "michael"; anything else unchanged */
export function plainName(name) {
  const s = String(name || '').trim();
  const i = s.indexOf('\\');
  return i >= 0 ? s.slice(i + 1) : s;
}

const norm = (dn) => String(dn || '').replace(/\s*,\s*/g, ',').trim().toLowerCase();

/** Role from the user's groups: the highest one wins */
export function roleFromGroups(groups, cfg) {
  const set = new Set(groups.map(norm));
  if (cfg.groupAdmin && set.has(norm(cfg.groupAdmin))) return 'admin';
  if (cfg.groupEditor && set.has(norm(cfg.groupEditor))) return 'editor';
  if (cfg.groupViewer && set.has(norm(cfg.groupViewer))) return 'viewer';
  return null;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const asText = (v) => { const x = first(v); return Buffer.isBuffer(x) ? x.toString('utf8') : String(x ?? ''); };
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x)));

export function createDirectory(settings, { clientFactory = null } = {}) {
  function config() {
    return {
      enabled: !!settings.get('ad.enabled'),
      url: String(settings.get('ad.url') || ''),
      startTls: !!settings.get('ad.startTls'),
      verify: settings.get('ad.verify') !== false,
      ca: String(settings.get('ad.ca') || ''),
      bindDn: String(settings.get('ad.bindDn') || ''),
      bindPassword: String(settings.get('ad.bindPassword') || ''),
      baseDn: String(settings.get('ad.baseDn') || ''),
      userFilter: String(settings.get('ad.userFilter') || DEFAULT_FILTER),
      groupAdmin: String(settings.get('ad.groupAdmin') || ''),
      groupEditor: String(settings.get('ad.groupEditor') || ''),
      groupViewer: String(settings.get('ad.groupViewer') || ''),
      nested: settings.get('ad.nested') !== false,
    };
  }

  function tlsOptions(cfg) {
    const o = { rejectUnauthorized: cfg.verify, minVersion: 'TLSv1.2' };
    if (cfg.ca) o.ca = [cfg.ca];
    else if (process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)) o.ca = [fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS)];
    return o;
  }

  async function connect(cfg) {
    const ldaps = cfg.url.toLowerCase().startsWith('ldaps://');
    const opts = { url: cfg.url, timeout: 8000, connectTimeout: 8000, strictDN: false };
    if (ldaps) opts.tlsOptions = tlsOptions(cfg);
    const client = clientFactory ? clientFactory(opts) : new Client(opts);
    if (!ldaps && cfg.startTls) await client.startTLS(tlsOptions(cfg));
    return client;
  }

  async function groupsOf(client, cfg, userDn, memberOf) {
    const groups = new Set(asList(memberOf));
    const extra = [];
    if (cfg.nested) extra.push(`(member:${AD_IN_CHAIN}:=${escapeFilter(userDn)})`);
    extra.push(`(|(member=${escapeFilter(userDn)})(uniqueMember=${escapeFilter(userDn)}))`);
    for (const filter of extra) {
      try {
        const { searchEntries } = await client.search(cfg.baseDn, { scope: 'sub', filter, attributes: ['dn'], sizeLimit: 1000 });
        for (const e of searchEntries) groups.add(e.dn);
      } catch (e) {
        log.debug(`LDAP group search (${filter.slice(0, 40)}…): ${e.message}`);
      }
    }
    return [...groups];
  }

  /** Finds and checks a user. Returns { dn, username, display_name, email, role, groups } or throws HttpError. */
  async function verify(username, password, { checkPassword = true } = {}) {
    const cfg = config();
    if (!cfg.url || !cfg.baseDn) throw new HttpError(400, 'err.adConfig');
    const name = plainName(username);
    if (!name || (checkPassword && !password)) throw new HttpError(401, 'err.login');
    let client;
    try {
      client = await connect(cfg);
      if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword);
      const filter = cfg.userFilter.split('{username}').join(escapeFilter(name));
      const { searchEntries } = await client.search(cfg.baseDn, { scope: 'sub', filter, sizeLimit: 2,
        attributes: ['dn', 'sAMAccountName', 'uid', 'userPrincipalName', 'displayName', 'cn', 'mail', 'memberOf', 'userAccountControl'] });
      if (searchEntries.length !== 1) throw new HttpError(401, 'err.login', searchEntries.length > 1 ? 'ambiguous' : 'not found');
      const u = searchEntries[0];
      // AD: account disabled (bit 2 of userAccountControl)
      if (u.userAccountControl && (Number(asText(u.userAccountControl)) & 2)) throw new HttpError(401, 'err.login', 'disabled');
      if (checkPassword) {
        const userClient = await connect(cfg);
        try { await userClient.bind(u.dn, String(password)); } finally { await userClient.unbind().catch(() => {}); }
      }
      const groups = await groupsOf(client, cfg, u.dn, u.memberOf);
      const role = roleFromGroups(groups, cfg);
      return {
        dn: u.dn,
        username: (asText(u.sAMAccountName) || asText(u.uid) || name).toLowerCase().slice(0, 64),
        display_name: (asText(u.displayName) || asText(u.cn)).slice(0, 120),
        email: asText(u.mail).slice(0, 254),
        role,
        groups,
      };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // Wrong password (49 = invalidCredentials) is a normal failed sign-in, everything else is a connection problem
      if (e.code === 49 || /invalid credentials/i.test(e.message)) throw new HttpError(401, 'err.login');
      throw new HttpError(502, 'err.adFailed', e.message.slice(0, 200));
    } finally {
      if (client) await client.unbind().catch(() => {});
    }
  }

  return {
    config,
    enabled: () => config().enabled,
    verify,
    /** Values from the settings form (admin) */
    save(input) {
      const b = input || {};
      const url = line(b.url, 300);
      if (url && !/^ldaps?:\/\/[^\s/]+(:\d{1,5})?\/?$/i.test(url)) throw new HttpError(400, 'err.adUrl');
      if (b.enabled && (!url || !line(b.baseDn, 500))) throw new HttpError(400, 'err.adConfig');
      // Passwords never go over the network unencrypted: ldap:// only with StartTLS
      if (url && /^ldap:\/\//i.test(url) && !b.startTls) throw new HttpError(400, 'err.adPlain');
      const ca = str(b.ca, 20000).trim();
      if (ca && !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(ca)) throw new HttpError(400, 'err.adCa');
      const filter = line(b.userFilter, 500) || DEFAULT_FILTER;
      if (!filter.includes('{username}') || !/^\(.*\)$/.test(filter)) throw new HttpError(400, 'err.adFilter');
      settings.set('ad.enabled', !!b.enabled);
      settings.set('ad.url', url.replace(/\/$/, ''));
      settings.set('ad.startTls', !!b.startTls);
      settings.set('ad.verify', b.verify !== false);
      settings.set('ad.ca', ca);
      settings.set('ad.bindDn', line(b.bindDn, 500));
      if (typeof b.bindPassword === 'string' && b.bindPassword) settings.set('ad.bindPassword', b.bindPassword.slice(0, 512));
      if (b.clearBindPassword) settings.set('ad.bindPassword', '');
      settings.set('ad.baseDn', line(b.baseDn, 500));
      settings.set('ad.userFilter', filter);
      for (const k of ['groupAdmin', 'groupEditor', 'groupViewer']) settings.set(`ad.${k}`, line(b[k], 500));
      settings.set('ad.nested', b.nested !== false);
    },
  };
}
