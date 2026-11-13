// Sign-in with Active Directory / LDAP (LDAPS or StartTLS).
//
// 1. A service account searches the user (filter with {username}).
// 2. WhatsOnMyNet binds as that user with the password typed in - the password is never stored.
// 3. The role comes from group membership (nested groups in AD): admin group → admin, editor group → editor,
//    viewer group → viewer. Without one of these groups the sign-in is refused.
import fs from 'node:fs';
import tls from 'node:tls';
import { Client } from 'ldapts';
import { HttpError, line, str } from '../lib/http.js';
import { log } from '../lib/log.js';
import { parsePem, toPem, orderChain, complete, describe, fetchChain, completeViaAia, domainCAs, completeFrom, parseLdapUrl } from './dccert.js';

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

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*\.?|[0-9a-fA-F:]+)$/;
const isDn = (v) => /^\s*(cn|ou|dc|o|uid)\s*=/i.test(v);

/** TLS / connection errors → a short key the interface explains (what to do), plus the original text */
export function adErrorKey(e) {
  const code = e?.code || e?.cause?.code || '';
  const msg = String(e?.message || '');
  if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED'].includes(code)
    || /self[- ]signed|unable to (verify|get local issuer)/i.test(msg)) return 'cert';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /altnames|Hostname\/IP does not match/i.test(msg)) return 'name';
  if (code === 'CERT_HAS_EXPIRED' || /expired/i.test(msg)) return 'expired';
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND|getaddrinfo/.test(msg)) return 'dns';
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) return 'timeout';
  if (code === 49 || /invalid credentials|data 52e/i.test(msg)) return 'credentials';
  if (/data 775|locked/i.test(msg)) return 'locked';
  if (/data 532|data 773/i.test(msg)) return 'expiredPassword';
  if (/operationsError|000004DC|successful bind must be completed/i.test(msg)) return 'needBind';
  return 'other';
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const asText = (v) => { const x = first(v); return Buffer.isBuffer(x) ? x.toString('utf8') : String(x ?? ''); };
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x)));

export function createDirectory(settings, { clientFactory = null } = {}) {
  function config() {
    const url = String(settings.get('ad.url') || '');
    const u = parseLdapUrl(url);
    const ca = String(settings.get('ad.ca') || '');
    const verify = settings.get('ad.verify') !== false;
    const startTls = !!settings.get('ad.startTls');
    // Trust: the certificate fetched from the DC (pinned), the system's CAs, or no check (testing only)
    const stored = String(settings.get('ad.trust') || '');
    const trust = !verify ? 'insecure' : ['pinned', 'system'].includes(stored) ? stored : ca ? 'pinned' : 'system';
    return {
      enabled: !!settings.get('ad.enabled'),
      url,
      host: u?.host || '',
      port: u?.port || 636,
      security: u && !u.ldaps ? 'starttls' : 'ldaps',
      startTls,
      verify,
      trust,
      verifyHostname: settings.get('ad.verifyHostname') !== false,
      ca,
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
    const trust = cfg.trust || (cfg.verify === false ? 'insecure' : cfg.ca ? 'pinned' : 'system');
    const o = { rejectUnauthorized: trust !== 'insecure', minVersion: 'TLSv1.2' };
    // allowPartialTrustChain: a confirmed server or intermediate certificate is enough as trust anchor
    // (the root CA is added when it can be found - then a renewed DC certificate keeps working)
    if (trust === 'pinned' && cfg.ca) Object.assign(o, { ca: [cfg.ca], allowPartialTrustChain: true });
    else if (process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)) o.ca = [fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS)];
    // Name check: off only on request (e.g. the DC is reached by its IP address); the chain is still checked
    if (cfg.verifyHostname === false) o.checkServerIdentity = (host, cert) => (cfg.verifyHostname === false ? undefined : tls.checkServerIdentity(host, cert));
    return o;
  }

  /** RootDSE: naming contexts of the domain (readable without signing in on AD) */
  async function rootDse(client) {
    try {
      const { searchEntries } = await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['defaultNamingContext', 'namingContexts'] });
      const e = searchEntries[0] || {};
      return { defaultNamingContext: asText(e.defaultNamingContext) || asList(e.namingContexts)[0] || '' };
    } catch {
      return { defaultNamingContext: '' };
    }
  }

  /** Where to search: the configured base DN (users) and the whole domain (groups) */
  async function bases(client, cfg) {
    const dse = cfg.baseDn ? null : await rootDse(client);
    const baseDn = cfg.baseDn || dse?.defaultNamingContext || '';
    const domain = (await rootDse(client)).defaultNamingContext || baseDn;
    return { baseDn, domain, auto: !cfg.baseDn && !!baseDn };
  }

  /** Group from the settings: a name (e.g. WOMN-Admins) or a full DN → its DN in the directory, or null */
  async function resolveGroup(client, domain, value) {
    const v = String(value || '').trim();
    if (!v) return null;
    try {
      if (isDn(v)) return v; // a full DN is used as it is (the test checks that it exists)
      const name = escapeFilter(v);
      const { searchEntries } = await client.search(domain, { scope: 'sub', sizeLimit: 2, attributes: ['dn'],
        filter: `(&(|(objectClass=group)(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))(|(cn=${name})(sAMAccountName=${name})))` });
      return searchEntries.length === 1 ? searchEntries[0].dn : null;
    } catch {
      return null;
    }
  }

  async function resolvedGroups(client, cfg, domain) {
    const out = {};
    for (const k of ['groupAdmin', 'groupEditor', 'groupViewer']) out[k] = await resolveGroup(client, domain, cfg[k]);
    return out;
  }

  async function connect(cfg) {
    const ldaps = cfg.url.toLowerCase().startsWith('ldaps://');
    if (!ldaps && !cfg.startTls) throw new HttpError(400, 'err.adPlain');
    const opts = { url: cfg.url, timeout: 8000, connectTimeout: 8000, strictDN: false };
    if (ldaps) opts.tlsOptions = tlsOptions(cfg);
    const client = clientFactory ? clientFactory(opts) : new Client(opts);
    if (!ldaps && cfg.startTls) await client.startTLS(tlsOptions(cfg));
    return client;
  }

  async function groupsOf(client, cfg, userDn, memberOf, domain = cfg.baseDn) {
    const groups = new Set(asList(memberOf));
    const extra = [];
    if (cfg.nested) extra.push(`(member:${AD_IN_CHAIN}:=${escapeFilter(userDn)})`);
    extra.push(`(|(member=${escapeFilter(userDn)})(uniqueMember=${escapeFilter(userDn)}))`);
    for (const filter of extra) {
      try {
        const { searchEntries } = await client.search(domain, { scope: 'sub', filter, attributes: ['dn'], sizeLimit: 1000 });
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
    if (!cfg.url) throw new HttpError(400, 'err.adConfig');
    const name = plainName(username);
    if (!name || (checkPassword && !password)) throw new HttpError(401, 'err.login');
    let client;
    try {
      client = await connect(cfg);
      if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword);
      const where = await bases(client, cfg);
      if (!where.baseDn) throw new HttpError(400, 'err.adConfig');
      const filter = cfg.userFilter.split('{username}').join(escapeFilter(name));
      const { searchEntries } = await client.search(where.baseDn, { scope: 'sub', filter, sizeLimit: 2,
        attributes: ['dn', 'sAMAccountName', 'uid', 'userPrincipalName', 'displayName', 'cn', 'mail', 'memberOf', 'userAccountControl'] });
      if (searchEntries.length !== 1) throw new HttpError(401, 'err.login', searchEntries.length > 1 ? 'ambiguous' : 'not found');
      const u = searchEntries[0];
      // AD: account disabled (bit 2 of userAccountControl)
      if (u.userAccountControl && (Number(asText(u.userAccountControl)) & 2)) throw new HttpError(401, 'err.login', 'disabled');
      if (checkPassword) {
        const userClient = await connect(cfg);
        try { await userClient.bind(u.dn, String(password)); } finally { await userClient.unbind().catch(() => {}); }
      }
      const groups = await groupsOf(client, cfg, u.dn, u.memberOf, where.domain);
      const role = roleFromGroups(groups, { ...cfg, ...(await resolvedGroups(client, cfg, where.domain)) });
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

  /** PEM from outside: only certificates, at most 10; returned as a clean, ordered bundle ('' = none) */
  function checkedPem(input) {
    const text = str(input, 60000).trim();
    if (!text) return '';
    let certs;
    try { certs = parsePem(text); } catch { throw new HttpError(400, 'err.adCa'); }
    if (!certs.length || certs.length > 10 || text.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) throw new HttpError(400, 'err.adCa');
    return toPem(ordered(certs));
  }

  /** Chain first (server → root), then any further CAs that were pasted */
  function ordered(certs) {
    const chain = orderChain(certs);
    return chain.concat(certs.filter((c) => !chain.includes(c)));
  }

  function certInfo(pem = config().ca) {
    let certs = [];
    try { certs = parsePem(pem); } catch { certs = []; }
    const all = certs.length ? ordered(certs) : [];
    return { certs: all.map((c, i) => describe(c, { role: i === 0 && !c.ca ? 'server' : null })), complete: certs.length > 0 && complete(orderChain(certs)) };
  }

  /** Form values for the certificate steps (the stored ones where the form has none) */
  /** Server fields of the form (host, security, port - or an ldap(s):// address) → { url, startTls } */
  function serverOf(b, cfg = config()) {
    if (b.host === undefined && b.url === undefined) return { url: cfg.url, startTls: cfg.startTls };
    let host = line(b.host ?? '', 253);
    let security = b.security === 'starttls' ? 'starttls' : b.security === 'ldaps' ? 'ldaps' : null;
    let port = Number(b.port) || 0;
    if (b.host === undefined || /^ldaps?:\/\//i.test(host)) {
      // an address like ldaps://dc01.firma.local:636 (older settings, or pasted into the server field)
      const raw = b.host === undefined ? line(b.url, 300) : host;
      if (!raw) return { url: '', startTls: false };
      const u = parseLdapUrl(raw);
      if (!u) throw new HttpError(400, 'err.adUrl');
      host = u.host;
      port = u.port;
      if (b.host === undefined) security = u.ldaps ? 'ldaps' : b.startTls ? 'starttls' : 'plain';
      else security = u.ldaps ? 'ldaps' : 'starttls';
    }
    if (!host) return { url: '', startTls: false };
    if (!HOST_RE.test(host)) throw new HttpError(400, 'err.adUrl');
    security = security || 'ldaps';
    if (security === 'plain') throw new HttpError(400, 'err.adPlain');
    port = port || (security === 'ldaps' ? 636 : 389);
    if (port < 1 || port > 65535) throw new HttpError(400, 'err.adUrl');
    const h = host.includes(':') ? `[${host}]` : host;
    return { url: `${security === 'ldaps' ? 'ldaps' : 'ldap'}://${h}:${port}`, startTls: security === 'starttls' };
  }

  /** Form values for test and certificate steps (the stored ones where the form has none) */
  function formCfg(form = {}) {
    const cfg = config();
    const srv = serverOf(form, cfg);
    if (!srv.url) throw new HttpError(400, 'err.adUrl');
    const out = { ...cfg, ...srv,
      bindDn: 'bindDn' in form ? line(form.bindDn, 500) : cfg.bindDn,
      bindPassword: typeof form.bindPassword === 'string' && form.bindPassword ? form.bindPassword.slice(0, 512) : cfg.bindPassword };
    if ('baseDn' in form) out.baseDn = line(form.baseDn, 500);
    if ('userFilter' in form) out.userFilter = line(form.userFilter, 500) || DEFAULT_FILTER;
    if (['pinned', 'system', 'insecure'].includes(form.trust)) { out.trust = form.trust; out.verify = form.trust !== 'insecure'; }
    if ('verifyHostname' in form) out.verifyHostname = form.verifyHostname !== false;
    if ('nested' in form) out.nested = form.nested !== false;
    for (const k of ['groupAdmin', 'groupEditor', 'groupViewer']) if (k in form) out[k] = line(form[k], 500);
    return out;
  }

  /**
   * Test with the form values (also unsaved): connection, service account, base DN, groups, optionally a user and
   * the password. Returns { ok, steps: [{ key, ok, … }], baseDn } - every step says what went wrong.
   */
  async function test(form = {}, username = '', password = '') {
    const cfg = formCfg(form);
    const steps = [];
    const fail = (key, e) => steps.push({ key, ok: false, error: adErrorKey(e), detail: String(e?.message || e).slice(0, 200) });
    let client;
    let result = { ok: false, steps };
    try {
      try { client = await connect(cfg); await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['defaultNamingContext'] }); }
      catch (e) { fail('connect', e); return result; }
      steps.push({ key: 'connect', ok: true, security: cfg.url.startsWith('ldaps') ? 'LDAPS' : 'StartTLS', trust: cfg.trust });
      if (cfg.bindDn) {
        try { await client.bind(cfg.bindDn, cfg.bindPassword); steps.push({ key: 'bind', ok: true, value: cfg.bindDn }); }
        catch (e) { fail('bind', e); return result; }
      } else {
        steps.push({ key: 'bind', ok: false, error: 'noBind' });
      }
      const where = await bases(client, cfg);
      steps.push(where.baseDn ? { key: 'baseDn', ok: true, value: where.baseDn, auto: where.auto } : { key: 'baseDn', ok: false, error: 'noBase' });
      if (!where.baseDn) return result;
      result.baseDn = where.auto ? where.baseDn : undefined;
      const groups = await resolvedGroups(client, cfg, where.domain);
      for (const [k, role] of [['groupAdmin', 'admin'], ['groupEditor', 'editor'], ['groupViewer', 'viewer']]) {
        if (!cfg[k]) continue;
        let dn = groups[k];
        if (dn && isDn(cfg[k])) {
          // a DN typed in: does it exist?
          dn = await client.search(dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] }).then((r) => r.searchEntries[0]?.dn || null).catch(() => null);
        }
        steps.push({ key: 'group', role, value: cfg[k], ok: !!dn, dn: dn || null, error: dn ? undefined : 'groupNotFound' });
      }
      if (!cfg.groupAdmin && !cfg.groupEditor && !cfg.groupViewer) steps.push({ key: 'group', ok: false, error: 'noGroups' });
      const name = plainName(username);
      if (name) {
        const filter = cfg.userFilter.split('{username}').join(escapeFilter(name));
        let u;
        try {
          const { searchEntries } = await client.search(where.baseDn, { scope: 'sub', filter, sizeLimit: 2,
            attributes: ['dn', 'sAMAccountName', 'uid', 'displayName', 'cn', 'mail', 'memberOf', 'userAccountControl'] });
          if (searchEntries.length !== 1) { steps.push({ key: 'user', ok: false, value: name, error: searchEntries.length ? 'ambiguous' : 'userNotFound' }); return result; }
          u = searchEntries[0];
        } catch (e) { fail('user', e); return result; }
        const memberOf = await groupsOf(client, cfg, u.dn, u.memberOf, where.domain);
        const role = roleFromGroups(memberOf, { ...cfg, ...groups });
        const disabled = !!(u.userAccountControl && (Number(asText(u.userAccountControl)) & 2));
        steps.push({ key: 'user', ok: !disabled, value: name, dn: u.dn, display_name: asText(u.displayName) || asText(u.cn), email: asText(u.mail),
          role, groups: memberOf.slice(0, 200), error: disabled ? 'disabled' : undefined });
        steps.push({ key: 'role', ok: !!role, role, error: role ? undefined : 'noRole' });
        if (password) {
          const userClient = await connect(cfg).catch((e) => { fail('password', e); return null; });
          if (userClient) {
            try { await userClient.bind(u.dn, String(password)); steps.push({ key: 'password', ok: true }); }
            catch (e) { fail('password', e); }
            finally { await userClient.unbind().catch(() => {}); }
          }
        }
      }
      result = { ...result, ok: steps.every((x) => x.ok || x.error === 'noBind') };
      return result;
    } finally {
      if (client) await client.unbind().catch(() => {});
    }
  }

  return {
    config,
    enabled: () => config().enabled,
    certInfo,
    test,
    /** Step 1: what does the DC present? (not trusted yet; completed via AIA) */
    async fetchCert(form) {
      const cfg = formCfg(form);
      let got;
      try {
        got = await fetchChain({ url: cfg.url, startTls: cfg.startTls });
      } catch (e) {
        if (e.code) throw new HttpError(400, e.code);
        throw new HttpError(502, 'err.adFailed', e.message.slice(0, 200));
      }
      const fromServer = new Set(got.certs.map((c) => c.fingerprint256));
      const aia = complete(got.certs) ? { chain: got.certs, tried: [] } : await completeViaAia(got.certs);
      return {
        certs: aia.chain.map((c, i) => describe(c, { role: i === 0 && !c.ca ? 'server' : null, source: fromServer.has(c.fingerprint256) ? 'server' : 'aia' })),
        complete: complete(aia.chain),
        nameOk: got.nameOk,
        host: got.host,
        aiaTried: aia.tried,
        pem: toPem(aia.chain),
      };
    },
    /** Step 2: the admin confirmed - store; a missing root CA is then looked up in AD (over the now trusted connection) */
    async confirmCert(form) {
      const pem = checkedPem(form?.pem);
      if (!pem) throw new HttpError(400, 'err.adCa');
      settings.set('ad.ca', pem);
      settings.set('ad.verify', true);
      settings.set('ad.trust', 'pinned');
      const result = { added: 0, adError: null };
      let chain = orderChain(parsePem(pem));
      if (!complete(chain)) {
        let client;
        try {
          const cfg = { ...formCfg(form), ca: pem, verify: true };
          client = await connect(cfg);
          if (cfg.bindDn) await client.bind(cfg.bindDn, cfg.bindPassword);
          const r = completeFrom(chain, await domainCAs(client));
          if (r.added.length) {
            chain = r.chain;
            settings.set('ad.ca', toPem(chain));
            result.added = r.added.length;
          } else {
            result.adError = 'none';
          }
        } catch (e) {
          result.adError = String(e.message || e).slice(0, 200);
          log.debug(`AD certificate authorities: ${result.adError}`);
        } finally {
          if (client) await client.unbind().catch(() => {});
        }
      }
      return { ...certInfo(), ...result };
    },
    removeCert() { settings.set('ad.ca', ''); return certInfo(''); },
    verify,
    /** Values from the settings form (admin) */
    save(input) {
      const b = input || {};
      // Passwords never go over the network unencrypted: ldap:// only with StartTLS (serverOf refuses plain LDAP)
      const srv = serverOf(b);
      const url = srv.url;
      if (b.enabled && !url) throw new HttpError(400, 'err.adConfig');
      const filter = line(b.userFilter, 500) || DEFAULT_FILTER;
      if (!filter.includes('{username}') || !/^\(.*\)$/.test(filter)) throw new HttpError(400, 'err.adFilter');
      settings.set('ad.enabled', !!b.enabled);
      settings.set('ad.url', url);
      settings.set('ad.startTls', srv.startTls);
      if (['pinned', 'system', 'insecure'].includes(b.trust)) {
        settings.set('ad.trust', b.trust === 'insecure' ? '' : b.trust);
        settings.set('ad.verify', b.trust !== 'insecure');
      } else {
        settings.set('ad.verify', b.verify !== false);
      }
      if ('verifyHostname' in b) settings.set('ad.verifyHostname', b.verifyHostname !== false);
      if ('ca' in b) settings.set('ad.ca', checkedPem(b.ca));
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
