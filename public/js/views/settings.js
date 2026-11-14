// Administration: general, scan, email, HTTPS certificate, users, ignored devices, log, about.
import { h, mount, toast, modal, confirmDialog, fmtDate, busy } from '../dom.js';
import { get, put, post, patch, del, api } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { pageHead, field, input, select, formData, btn, channelPicker } from './common.js';
import { openMonitorForm } from './monitoring.js';
import { scriptDialog, hostScriptsSettings, helpLink } from './hostscripts.js';
import { aboutContent } from './about.js';
import { hardwareDetail } from './hardware.js';
import { SECTIONS, settingsNav } from './settingsnav.js';
import { failoverSettings } from './failover.js';
import { diagnosticsSettings } from './diagnostics.js';

export async function renderSettings(main, section = 'general') {
  if (!state.user.isAdmin) { navigate('/', { replace: true }); return; }
  // moved to their own pages
  if (section === 'proxmox' || section === 'reports') { navigate(`/${section}`, { replace: true }); return; }
  if (!SECTIONS.some(([s]) => s === section)) section = 'general';
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' },
    pageHead(t('set.title'), null),
    h('div', { class: 'settings' },
      // links on wide screens, a <select> on phones (≤ 820 px)
      settingsNav(section, (s) => navigate(`/settings/${s}`)),
      body)));
  const all = ['general', 'scan', 'smtp', 'printers', 'snmpdev', 'notify'].includes(section) ? await get('/settings') : null;
  const view = { general, scan, printers, snmpdev, docker, hostscripts: (b, _s, reload) => hostScriptsSettings(b, reload), ad, agents, backup, failover: failoverSettings, diag: diagnosticsSettings, smtp, notify, https, users, ignored, audit, about }[section];
  await view(body, all, () => renderSettings(main, section));
}

/** Proxmox VE / Backup Server: own page under "Monitoring" (editors see it, admins change it) */
export async function renderProxmox(main) {
  if (!(state.user.canEditServer ?? state.user.canEdit)) { navigate('/', { replace: true }); return; }
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, body));
  await proxmox(body, null, () => renderProxmox(main), 'virt');
}

/** UniFi, Omada, MikroTik: own page under "Monitoring" (same building blocks as the hypervisors) */
export async function renderControllers(main) {
  if (!(state.user.canEditServer ?? state.user.canEdit)) { navigate('/', { replace: true }); return; }
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, body));
  await proxmox(body, null, () => renderControllers(main), 'net');
}

/** Server hardware through the management chip (Redfish): own page under "Monitoring" */
export async function renderHardware(main) {
  if (!(state.user.canEditServer ?? state.user.canEdit)) { navigate('/', { replace: true }); return; }
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, body));
  await proxmox(body, null, () => renderHardware(main), 'hw');
}

/** Planned reports: own page under "Monitoring" */
export async function renderReports(main) {
  if (!state.user.isAdmin) { navigate('/', { replace: true }); return; }
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, body));
  await reports(body, null, () => renderReports(main));
}

const panel = (title, ...content) => h('section', { class: 'panel panel-pad' }, title ? h('h2', { class: 'section-title' }, title) : null, content);
const saveBtn = () => h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, t('save')));

async function general(body, s) {
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const d = formData(form);
      await put('/settings/general', { title: d.title });
      await put('/settings/backup', { keep: d.keep });
      await put('/settings/security', { require2faAdmins: d.require2faAdmins });
      state.boot.title = d.title;
      toast(t('saved'));
    } catch (ex) { fail(ex); }
  } },
  field(t('set.instance'), input('title', s.general.title, { maxlength: 60 })),
  field(t('set.backupKeep'), input('keep', s.backup.keep, { type: 'number', min: 1, max: 90 }), t('set.backupHint')),
  field(t('tf.requireAdmins'), h('input', { type: 'checkbox', name: 'require2faAdmins', checked: !!s.security?.require2faAdmins }), t('tf.requireAdminsHint')),
  saveBtn());
  mount(body, panel(t('set.general'), form));
}

async function scan(body, s) {
  const sc = s.scan;
  const comm = h('textarea', { name: 'snmpCommunities', rows: 3, class: 'mono', placeholder: sc.snmpCommunities.set ? '••••••' : 'public', autocomplete: 'off', spellcheck: 'false' });
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(form);
    const payload = { ping: d.ping, snmp: d.snmp, httpTitles: d.httpTitles, routerArp: d.routerArp, rate: d.rate, keepScans: d.keepScans };
    if (d.snmpCommunities.trim() || d.clearCommunities) payload.snmpCommunities = d.clearCommunities ? '' : d.snmpCommunities;
    try { await put('/settings/scan', payload); toast(t('saved')); } catch (ex) { fail(ex); }
  } },
  field(t('set.ping'), h('input', { type: 'checkbox', name: 'ping', checked: sc.ping })),
  field(t('set.snmp'), h('input', { type: 'checkbox', name: 'snmp', checked: sc.snmp })),
  field(t('set.httpTitles'), h('input', { type: 'checkbox', name: 'httpTitles', checked: sc.httpTitles })),
  field(t('set.routerArp'), h('input', { type: 'checkbox', name: 'routerArp', checked: sc.routerArp !== false }), t('set.routerArpHint')),
  field(t('set.communities'), comm, sc.snmpCommunities.set ? t('set.communitiesSet') : t('set.communitiesHint')),
  sc.snmpCommunities.set ? field('public', h('input', { type: 'checkbox', name: 'clearCommunities' })) : null,
  h('div', { class: 'form-grid' },
    field(t('set.rate'), input('rate', sc.rate, { type: 'number', min: 5, max: 200 }), t('set.rateHint')),
    field(t('set.keepScans'), input('keepScans', sc.keepScans, { type: 'number', min: 3, max: 500 }))),
  saveBtn());
  const ports = state.meta?.gentlePorts || [];
  mount(body, panel(t('set.scan'), form), await lightPanel(s.lightscan),
    panel(t('set.ports'), h('div', { class: 'ports' }, ports.map((p) => h('span', { class: 'port', title: state.meta.services[p] || '' }, `${p} ${state.meta.services[p] ? `· ${state.meta.services[p]}` : ''}`)))));
}

async function loadChannels() {
  try { return await get('/channels'); } catch { return []; }
}

/** Nightly light scan: time, notice about unknown devices, start now */
async function lightPanel(ls) {
  const chans = await loadChannels();
  const picker = channelPicker(chans, ls.channels);
  const last = ls.last;
  const lastLine = last
    ? h('p', { class: 'muted small' }, t('light.last', { when: fmtDate(last.finished_at || last.started_at, getLang()), status: t(`scan.phase.${last.status === 'running' ? 'discover' : last.status}`) }), ' ',
      h('a', { href: `/scan/${last.id}`, 'data-link': true }, t('light.open')))
    : h('p', { class: 'muted small' }, t('light.never'));
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(form);
    try { await put('/settings/lightscan', { enabled: d.enabled, time: d.time, notify: d.notify, channels: picker.value() }); toast(t('saved')); } catch (ex) { fail(ex); }
  } },
  h('p', { class: 'muted' }, t('light.lead')),
  field(t('light.enabled'), h('input', { type: 'checkbox', name: 'enabled', checked: ls.enabled })),
  h('div', { class: 'form-grid' }, field(t('light.time'), input('time', ls.time, { type: 'time', required: true }), t('light.timeHint'))),
  field(t('light.notify'), h('input', { type: 'checkbox', name: 'notify', checked: ls.notify }), t('light.notifyHint')),
  picker.el,
  lastLine,
  h('div', { class: 'actions' },
    h('button', { class: 'btn', type: 'button', onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { const r = await post('/lightscan/run', {}); navigate(`/scan/${r.id}`); } catch (ex) { fail(ex); b.disabled = false; }
    } }, h('span', { html: icon('radar') }), t('light.runNow')),
    h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))));
  return panel(t('light.title'), form);
}

async function printers(body, s) {
  const p = s.printer;
  const chans = await loadChannels();
  const picker = channelPicker(chans, p.channels);
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(form);
    try { await put('/settings/printer', { enabled: d.enabled, interval: d.interval, threshold: d.threshold, notify: d.notify, channels: picker.value() }); toast(t('saved')); } catch (ex) { fail(ex); }
  } },
  h('p', { class: 'muted' }, t('prn.lead')),
  field(t('prn.enabled'), h('input', { type: 'checkbox', name: 'enabled', checked: p.enabled })),
  h('div', { class: 'form-grid' },
    field(t('prn.interval'), input('interval', p.interval, { type: 'number', min: 5, max: 1440 }), t('prn.intervalHint')),
    field(t('prn.threshold'), input('threshold', p.threshold, { type: 'number', min: 1, max: 50 }), t('prn.thresholdHint'))),
  field(t('prn.notify'), h('input', { type: 'checkbox', name: 'notify', checked: p.notify })),
  picker.el,
  h('p', { class: 'muted small' }, t('prn.community')),
  saveBtn());
  mount(body, panel(t('set.printers'), form));
}

async function snmpdev(body, s) {
  const p = s.snmpdev;
  const n = s.nas;
  const chans = await loadChannels();
  const picker = channelPicker(chans, n.channels);
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(form);
    try { await put('/settings/snmpdev', { enabled: d.enabled, interval: d.interval, threshold: d.threshold, notify: d.notify, channels: picker.value() }); toast(t('saved')); } catch (ex) { fail(ex); }
  } },
  h('p', { class: 'muted' }, t('snmpd.lead')),
  field(t('snmpd.enabled'), h('input', { type: 'checkbox', name: 'enabled', checked: p.enabled })),
  h('div', { class: 'form-grid' },
    field(t('snmpd.interval'), input('interval', p.interval, { type: 'number', min: 5, max: 1440 }), t('prn.intervalHint')),
    field(t('snmpd.threshold'), input('threshold', n.threshold, { type: 'number', min: 50, max: 99 }))),
  field(t('snmpd.notify'), h('input', { type: 'checkbox', name: 'notify', checked: n.notify }), t('snmpd.notifyHint')),
  picker.el,
  h('p', { class: 'muted small' }, t('prn.community')),
  saveBtn());
  mount(body, panel(t('set.snmpdev'), form));
}

const PROXY_COMPOSE = `services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    restart: unless-stopped
    environment:
      CONTAINERS: 1
      POST: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    ports:
      - "2375:2375"   # only reachable from your LAN - better bind it to one address`;

async function docker(body, _s, reload) {
  const list = await get('/docker/hosts');
  const edit = (x) => {
    const form = h('form', { class: 'form' },
      field(t('dock.name'), input('name', x?.name || '', { required: true, maxlength: 80, placeholder: 'docker01' })),
      field(t('dock.url'), input('url', x?.url || '', { required: true, class: 'mono', placeholder: 'http://10.0.0.5:2375' }), t('dock.urlHint')));
    const dlg = modal(x ? x.name : t('dock.add'), form, { wide: true, onSubmit: async () => {
      try {
        if (x) await put(`/docker/hosts/${x.id}`, formData(form)); else await post('/docker/hosts', formData(form));
        dlg.close(); toast(t('saved')); reload();
      } catch (ex) { fail(ex); }
    }, actions: [
      btn(t('cancel'), { onclick: () => dlg.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  };
  const result = h('div');
  async function test(x, button) {
    button.disabled = true;
    try {
      const r = await get(`/docker/hosts/${x.id}/containers`);
      toast(t('dock.ok', { version: r.version, n: r.containers.length }));
      mount(result, h('section', { class: 'panel' },
        h('h2', {}, `${t('dock.containers')} · ${x.name}`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, t('dock.name')), h('th', {}, t('dock.state')), h('th', { class: 'hide-sm' }, t('dock.image')))),
          h('tbody', {}, r.containers.map((c) => h('tr', {},
            h('td', { class: 'mono' }, c.name),
            h('td', {}, h('span', { class: `badge ${c.state === 'running' ? 'badge-ok' : c.state === 'exited' || c.state === 'dead' ? 'badge-bad' : ''}` }, c.state), ' ', h('span', { class: 'muted small' }, c.status)),
            h('td', { class: 'hide-sm mono small' }, c.image))))))));
    } catch (ex) { fail(ex); }
    button.disabled = false;
  }
  mount(body, h('section', { class: 'panel' },
    h('div', { class: 'panel-head', style: { paddingBottom: '12px', flexWrap: 'wrap' } }, h('h2', {}, t('set.docker')),
      btn(t('dock.add'), { class: 'btn btn-sm', onclick: () => edit(null) }, 'plus')),
    h('p', { class: 'muted', style: { padding: '0 20px' } }, t('dock.lead')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('dock.name')), h('th', { class: 'hide-sm' }, t('dock.url')), h('th', {}))),
      h('tbody', {}, list.map((x) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, x.name), x.monitors ? h('span', { class: 'muted small', style: { display: 'block' } }, t('dock.monitors', { n: x.monitors })) : null),
        h('td', { class: 'hide-sm mono small' }, x.url),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          btn(t('dock.test'), { class: 'btn btn-sm', onclick: (e) => test(x, e.currentTarget) }),
          btn(t('dock.monitorAll'), { class: 'btn btn-sm', onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true;
            try { const r = await post(`/docker/hosts/${x.id}/monitor-all`, {}); toast(t('dock.monitorAllDone', { n: r.created })); reload(); } catch (ex) { fail(ex); b.disabled = false; }
          } }, 'pulse'),
          btn(t('edit'), { class: 'btn btn-sm btn-ghost', onclick: () => edit(x) }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${x.name}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('dock.deleteConfirm', { name: x.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/docker/hosts/${x.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
          } }))))))))
      : h('p', { class: 'panel-pad muted', style: { margin: 0 } }, t('dock.none'))),
  result,
  panel(null, h('p', { class: 'muted', style: { marginTop: 0 } }, t('dock.proxy')), h('pre', { class: 'code' }, PROXY_COMPOSE)));
}

async function smtp(body, s) {
  const m = s.smtp;
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    try { await put('/settings/smtp', formData(form)); toast(t('saved')); } catch (ex) { fail(ex); }
  } },
  h('div', { class: 'form-grid' },
    field(t('set.smtpHost'), input('host', m.host, { placeholder: t('ph.smtpHost') })),
    field(t('set.smtpPort'), input('port', m.port, { type: 'number', min: 1, max: 65535 })),
    field(t('set.smtpSecurity'), select('security', [['starttls', t('sec.starttls')], ['tls', t('sec.tls')], ['none', t('sec.none')]], m.security)),
    field(t('set.smtpFrom'), input('from', m.from), t('set.smtpFromHint')),
    field(t('set.smtpUser'), input('user', m.user, { autocomplete: 'off' })),
    field(t('set.smtpPassword'), input('password', '', { type: 'password', autocomplete: 'new-password', placeholder: m.password.set ? '••••••' : '' }), m.password.set ? t('set.smtpPasswordSet') : null)),
  field(t('set.smtpSelfSigned'), h('input', { type: 'checkbox', name: 'allowSelfSigned', checked: m.allowSelfSigned })),
  saveBtn());
  const to = input('to', state.user.email, { type: 'email', 'aria-label': t('set.smtpTestTo') });
  const test = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const b = test.querySelector('button'); b.disabled = true;
    try { await post('/settings/smtp/test', { to: to.value }); toast(t('set.smtpTestSent')); } catch (ex) { fail(ex); }
    b.disabled = false;
  } }, field(t('set.smtpTestTo'), to), h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, h('span', { html: icon('mail') }), t('set.smtpTest'))));
  mount(body, panel(t('set.smtp'), h('p', { class: 'muted' }, t('set.smtpLater')), form), panel(t('set.smtpTest'), test));
}

const readFile = (file, asText) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(asText ? r.result : String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  if (asText) r.readAsText(file); else r.readAsDataURL(file);
});

async function https(body, _s, reload) {
  const c = await get('/tls');
  const info = c ? h('dl', { class: 'kv' },
    h('dt', {}, t('tls.current')), h('dd', {}, h('span', { class: `badge${c.source === 'custom' ? ' badge-ok' : ' badge-new'}` }, t(`tls.source.${c.source}`))),
    h('dt', {}, t('tls.subject')), h('dd', {}, c.subject),
    h('dt', {}, t('tls.issuer')), h('dd', {}, c.issuer, c.chain > 1 ? h('span', { class: 'muted small' }, ` · ${t('tls.chain', { n: c.chain })}`) : null),
    h('dt', {}, t('tls.names')), h('dd', { class: 'mono' }, (c.names || []).join(', ')),
    h('dt', {}, t('tls.validTo')), h('dd', {}, fmtDate(c.validTo, getLang())),
    h('dt', {}, t('tls.fingerprint')), h('dd', { class: 'mono small' }, c.fingerprint)) : null;

  let mode = 'pem';
  const certFile = h('input', { type: 'file', accept: '.pem,.crt,.cer,.txt' });
  const keyFile = h('input', { type: 'file', accept: '.pem,.key,.txt' });
  const pfxFile = h('input', { type: 'file', accept: '.pfx,.p12' });
  const pass = input('passphrase', '', { type: 'password', autocomplete: 'off' });
  const pemBox = h('div', { class: 'form' }, field(t('tls.certFile'), certFile), field(t('tls.keyFile'), keyFile));
  const pfxBox = h('div', { class: 'form', hidden: true }, field(t('tls.pfxFile'), pfxFile));
  const seg = h('div', { class: 'seg' }, [['pem', t('tls.pem')], ['pfx', t('tls.pfx')]].map(([k, l]) => h('button', { type: 'button', class: k === mode ? 'on' : '',
    onclick: (e) => { mode = k; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); pemBox.hidden = k !== 'pem'; pfxBox.hidden = k !== 'pfx'; } }, l)));
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const b = form.querySelector('button[type=submit]');
    b.disabled = true;
    try {
      const payload = { passphrase: pass.value };
      if (mode === 'pem') {
        if (!certFile.files[0] || !keyFile.files[0]) throw new Error(t('tls.certFile'));
        payload.cert = await readFile(certFile.files[0], true);
        payload.key = await readFile(keyFile.files[0], true);
      } else {
        if (!pfxFile.files[0]) throw new Error(t('tls.pfxFile'));
        payload.pfx = await readFile(pfxFile.files[0], false);
      }
      await post('/tls', payload);
      toast(t('tls.installed'));
      reload();
    } catch (ex) { fail(ex); b.disabled = false; }
  } }, seg, pemBox, pfxBox, field(t('tls.passphrase'), pass, t('tls.passphraseHint')),
  h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, h('span', { html: icon('lock') }), t('tls.install'))));

  mount(body,
    panel(t('set.https'), c?.source !== 'custom' ? h('div', { class: 'note warn' }, t('tls.selfHint')) : null, info,
      c?.source === 'custom' ? h('div', { class: 'actions', style: { marginTop: '14px' } }, btn(t('tls.reset'), { onclick: async () => {
        if (!await confirmDialog(t('tls.reset'), t('tls.resetConfirm'), t('tls.reset'), t('cancel'))) return;
        try { await post('/tls/self-signed'); toast(t('tls.installed')); reload(); } catch (ex) { fail(ex); }
      } })) : null),
    panel(t('tls.upload'), form));
}

async function users(body, _s, reload) {
  const [list, locs] = await Promise.all([get('/users'), get('/locations')]);
  const locName = Object.fromEntries(locs.map((l) => [l.id, l.name]));
  const roleSel = (v) => select('role', ['admin', 'editor', 'viewer'].map((r) => [r, `${t(`role.${r}`)} - ${t(`role.${r}.hint`)}`]), v);
  const edit = (u) => {
    const fromAd = u?.source === 'ldap';
    const mine = new Set(u?.locations || []);
    const locBox = h('div', { class: 'field' }, t('users.locations'),
      h('div', { class: 'chips' }, locs.map((l) => h('label', { class: 'check', style: { marginRight: '14px' } },
        h('input', { type: 'checkbox', name: `loc_${l.id}`, checked: mine.has(l.id) }), l.name))),
      h('span', { class: 'hint' }, t('users.locationsHint')));
    const form = h('form', { class: 'form' },
      u ? null : field(t('user.username'), input('username', '', { required: true, autocomplete: 'off' })),
      fromAd ? h('p', { class: 'note' }, t('users.adManaged')) : null,
      fromAd ? null : field(t('user.display'), input('display_name', u?.display_name || '')),
      fromAd ? null : field(t('user.email'), input('email', u?.email || '', { type: 'email' })),
      fromAd ? null : field(t('user.role'), roleSel(u?.role || 'editor')),
      u ? field(t('user.active'), h('input', { type: 'checkbox', name: 'active', checked: !!u.active })) : field(t('user.password'), input('password', '', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), t('user.passwordHint')),
      field(t('language'), select('language', [['de', 'Deutsch'], ['en', 'English']], u?.language || getLang())),
      locBox);
    // Location limit (editors and viewers): nothing ticked = all locations
    function syncLoc() { const r = form.querySelector('[name=role]')?.value || u?.role; locBox.hidden = r === 'admin' || !locs.length; }
    form.querySelector('[name=role]')?.addEventListener('change', syncLoc);
    syncLoc();
    const m = modal(u ? u.username : t('users.add'), form, { onSubmit: async () => {
      const d = formData(form);
      for (const k of Object.keys(d)) if (k.startsWith('loc_')) delete d[k];
      d.locations = locs.filter((l) => form.querySelector(`[name=loc_${l.id}]`)?.checked).map((l) => l.id);
      try { if (u) await patch(`/users/${u.id}`, d); else await post('/users', d); m.close(); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
    }, actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  };
  const setPw = (u) => {
    const pw = input('password', '', { type: 'password', minlength: 10, required: true, autocomplete: 'new-password' });
    const m = modal(`${t('users.resetPassword')}: ${u.username}`, h('form', { class: 'form' }, field(t('users.newPassword'), pw, t('user.passwordHint'))), { onSubmit: async () => {
      try { await post(`/users/${u.id}/password`, { password: pw.value }); m.close(); toast(t('saved')); } catch (ex) { fail(ex); }
    }, actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  };
  mount(body, h('section', { class: 'panel' },
    h('div', { class: 'panel-head', style: { paddingBottom: '12px' } }, h('h2', {}, t('set.users')), btn(t('users.add'), { class: 'btn btn-primary btn-sm', onclick: () => edit(null) }, 'plus')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('user.username')), h('th', {}, t('user.role')), h('th', { class: 'hide-sm' }, t('user.email')), h('th', { class: 'hide-sm' }, t('user.lastLogin')), h('th', {}))),
      h('tbody', {}, list.map((u) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, u.username), u.id === state.user.id ? h('span', { class: 'muted small' }, ` (${t('users.you')})`) : null,
          u.source === 'ldap' ? h('span', { class: 'badge', style: { marginLeft: '6px' }, title: t('users.adManaged') }, 'AD') : null,
          u.totp_enabled ? h('span', { class: 'badge badge-ok', style: { marginLeft: '6px' }, title: t('tf.on') }, '2FA') : null,
          u.display_name ? h('div', { class: 'sub' }, u.display_name) : null),
        h('td', {}, t(`role.${u.role}`), u.active ? null : h('span', { class: 'badge badge-bad', style: { marginLeft: '6px' } }, t('user.inactive')),
          u.role !== 'admin' && u.locations?.length ? h('div', { class: 'sub' }, u.locations.map((l) => locName[l]).filter(Boolean).join(', ')) : null),
        h('td', { class: 'hide-sm' }, u.email || '–'),
        h('td', { class: 'hide-sm' }, fmtDate(u.last_login, getLang())),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          btn(t('edit'), { class: 'btn btn-sm', onclick: () => edit(u) }),
          u.source === 'ldap' ? null : btn(t('users.resetPassword'), { class: 'btn btn-sm btn-ghost', onclick: () => setPw(u) }),
          u.totp_enabled && u.id !== state.user.id ? btn(t('tf.reset'), { class: 'btn btn-sm btn-ghost', onclick: async () => {
            if (!await confirmDialog(t('tf.reset'), t('tf.resetConfirm', { name: u.username }), t('tf.reset'), t('cancel'), { danger: true })) return;
            try { await del(`/users/${u.id}/2fa`); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
          } }) : null,
          u.id !== state.user.id ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${u.username}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('users.deleteConfirm', { name: u.username }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/users/${u.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
          } }) : null))))))),
    h('p', { class: 'panel-pad muted small', style: { margin: 0 } }, t('users.adHint'), ' ', h('a', { href: '/settings/ad', 'data-link': true }, t('set.ad')))));
}

const bytes = (n) => { if (!n) return '0'; const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; let v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`; };
const meter = (label, pct, sub = '') => h('div', { class: `supply${pct >= 85 ? ' low' : ''}`, 'data-color': 'other' },
  h('div', { class: 'supply-head' }, h('span', { class: 'supply-name mono' }, label), h('span', { class: 'supply-val mono' }, `${sub}${pct === null || pct === undefined ? '–' : `${pct} %`}`)),
  h('div', { class: 'supply-track' }, h('i', { style: { width: `${pct || 0}%` } })));
const ago = (sec) => { if (!sec) return '–'; const hrs = Math.round((Date.now() / 1000 - sec) / 3600); return hrs < 48 ? t('px.hoursAgo', { n: hrs }) : t('px.daysAgo', { n: Math.round(hrs / 24) }); };

/**
 * Nodes of a Proxmox VE / KVM host without the Linux script: with it they deliver more about the system (temperatures,
 * disks, services, updates). Gone by itself once every node reports, or for good with "do not show again".
 */
function nodeScriptTip(x, d) {
  if (!['pve', 'libvirt'].includes(x.kind) || x.script_tip_hidden || !state.user.isAdmin) return null;
  const without = (d.nodes || []).filter((n) => !n.script);
  if (!without.length) return null;
  return h('div', { class: 'note tip-script', style: { marginTop: '10px' } }, h('div', {},
    h('strong', {}, t('hs.nodeTipTitle')),
    h('p', { style: { margin: '4px 0 8px' } }, t('hs.nodeTip', { nodes: without.map((n) => n.name).join(', ') })),
    h('div', { class: 'actions', style: { justifyContent: 'flex-start' } },
      h('a', { class: 'btn btn-sm btn-primary', href: '/settings/hostscripts', 'data-link': true }, h('span', { html: icon('computer') }), t('set.hostscripts')),
      helpLink(),
      btn(t('hs.tipHide'), { class: 'btn btn-sm btn-ghost', onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try { await put(`/proxmox/${x.id}/script-tip`, { hidden: true }); x.script_tip_hidden = true; b.closest('.tip-script')?.remove(); toast(t('hs.tipHidden')); } catch (ex) { fail(ex); b.disabled = false; }
      } }))));
}

function proxmoxDetail(x) {
  const d = x.data || {};
  if (!x.last_at) return h('p', { class: 'muted' }, PUSH.includes(x.kind) ? t('virt.waiting') : t('prn.none'));
  // never reached yet: only the error and what to do, no empty sections
  const sensor = () => openMonitorForm(null, () => {}, { type: 'sensor', name: `${x.name} - Sensor`, interval_s: 300, fail_threshold: 1, options: { host: x.id } });
  const head = h('div', { class: 'actions', style: { marginBottom: '10px' } },
    !x.last_ok ? h('span', { class: 'note warn', style: { margin: 0 } }, x.last_error) : h('span', { class: 'muted small' }, `${PUSH.includes(x.kind) ? t('virt.lastPush') : t('prn.checked')}: ${fmtDate(x.last_at, getLang())}`),
    btn(t('sens.add'), { class: 'btn btn-sm', onclick: sensor }, 'plus'));
  // Token without read rights: Proxmox shows almost nothing instead of refusing - say what is missing and how to fix it
  const user = String(x.token_id || '').split('!')[0];
  const rights = x.last_ok && (d.missing || []).length ? h('div', { class: 'note warn' }, h('div', { style: { minWidth: 0, flex: 1 } },
    h('strong', {}, t('px.missing', { privs: d.missing.join(', ') })),
    h('p', { style: { margin: '4px 0 6px' } }, rich(t(d.kind === 'pbs' ? 'px.missingPbs' : 'px.missingPve'))),
    cmdBox(PX_FIX[d.kind === 'pbs' ? 'pbs' : 'pve'](user, x.token_id)),
    h('p', { class: 'small', style: { margin: '6px 0 0' } }, t('px.missingThen')))) : null;
  if (!d.kind) return head;
  if (d.netdevices) return netDetail(d, head);
  // Cluster: which node answered, and which nodes can stand in
  const via = x.last_ok && d.via ? h('div', { class: 'note warn' }, t('px.via', { node: d.via.node, url: x.url, error: d.via.error || '' })) : null;
  const others = Array.isArray(d.cluster) && d.cluster.length ? h('p', { class: 'muted small', style: { margin: '0 0 10px' } },
    t('px.cluster', { list: d.cluster.map((c) => `${c.name} (${c.ip})`).join(' · ') })) : null;
  if (d.kind === 'redfish') return h('div', {}, head, hardwareDetail(d, { inventory: true }));
  if (d.kind !== 'pbs') {
    const running = (d.guests || []).filter((g) => g.status === 'running').length;
    const pve = d.kind === 'pve';
    return h('div', {}, head, via, rights,
      h('h3', { class: 'sub-title' }, pve ? t('px.nodes') : t('virt.hosts')), pve ? others : null,
      h('ul', { class: 'port-macs' }, (d.nodes || []).map((n) => h('li', {}, h('strong', {}, n.name),
        h('span', { class: `badge ${n.online ? 'badge-ok' : 'badge-bad'}` }, n.stale ? t('virt.silent') : n.online ? 'online' : 'offline'),
        n.online && (n.cpu !== null || n.mem !== null) ? h('span', { class: 'muted small mono' }, `CPU ${n.cpu ?? '–'} % · RAM ${n.mem ?? '–'} %`) : null,
        n.temp ? h('span', { class: `badge ${n.temp.c >= n.temp.warn ? 'badge-new' : ''}`, title: t('vo.tempTitle', { name: n.temp.name, warn: n.temp.warn }) }, `${n.temp.c} °C`) : null,
        n.seen ? h('span', { class: 'muted small' }, t('virt.seen', { when: fmtDate(n.seen, getLang()) })) : null))),
      nodeScriptTip(x, d),
      h('h3', { class: 'sub-title' }, t('px.storages')),
      h('div', { class: 'supplies' }, (d.storages || []).filter((s) => s.total).map((s) => meter(s.node ? `${s.name} · ${s.node}` : s.name, s.pct, `${bytes(s.used)} / ${bytes(s.total)} · `))),
      h('h3', { class: 'sub-title' }, pve ? t('px.guests', { running, n: (d.guests || []).length }) : t('virt.guests', { running, n: (d.guests || []).length })),
      h('div', { class: 'chips' }, (d.guests || []).map((g) => h('span', { class: `badge ${g.status === 'running' ? 'badge-ok' : ''}`, title: [g.node, t(`val.state.${g.status}`), g.cpu !== null && g.cpu !== undefined ? `CPU ${g.cpu} %` : ''].filter(Boolean).join(' · ') }, pve ? `${g.vmid} ${g.name}` : g.name))),
      !pve ? null : h('h3', { class: 'sub-title' }, t('px.backups')),
      !pve ? null : (d.backups || []).length ? h('ul', { class: 'port-macs' }, d.backups.slice(0, 8).map((b) => h('li', {},
        h('span', { class: `badge ${b.ok ? 'badge-ok' : b.end ? 'badge-bad' : ''}` }, b.ok ? 'OK' : b.status), h('span', { class: 'mono small' }, b.vmid ? `VM ${b.vmid}` : t('px.allGuests')),
        h('span', { class: 'muted small' }, `${b.node} · ${fmtDate(new Date(b.start * 1000).toISOString(), getLang())}`)))) : h('p', { class: 'muted small' }, t('px.noBackups')));
  }
  return h('div', {}, head, rights,
    h('h3', { class: 'sub-title' }, t('px.datastores')),
    h('div', { class: 'supplies' }, (d.datastores || []).map((s) => meter(s.name, s.pct, `${bytes(s.used)} / ${bytes(s.total)} · `))),
    h('h3', { class: 'sub-title' }, t('px.groups', { n: (d.groups || []).length })),
    h('ul', { class: 'port-macs' }, (d.groups || []).slice(0, 40).map((g) => {
      const old = g.last && Date.now() / 1000 - g.last > 26 * 3600;
      return h('li', {}, h('span', { class: `badge ${old ? 'badge-bad' : 'badge-ok'}` }, ago(g.last)), h('span', { class: 'mono small' }, `${g.type}/${g.id}`),
        h('span', { class: 'muted small' }, [g.comment, g.store, t('px.count', { n: g.count })].filter(Boolean).join(' · ')));
    })),
    (d.failed || []).length ? [h('h3', { class: 'sub-title' }, t('px.failed')), h('ul', { class: 'port-macs' }, d.failed.slice(0, 10).map((f) => h('li', {},
      h('span', { class: 'badge badge-bad' }, f.type), h('span', { class: 'small' }, f.status), h('span', { class: 'muted small' }, fmtDate(new Date(f.start * 1000).toISOString(), getLang())))))] : null);
}

/** Devices of a network controller: state, model, firmware (update), clients - and whether it is in the inventory */
function netDetail(d, head) {
  const online = d.netdevices.filter((x) => x.online).length;
  return h('div', {}, head,
    h('p', { class: 'muted small', style: { margin: '0 0 10px' } }, t('net.summary', { n: d.netdevices.length, online, clients: d.clients ?? 0 })),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('net.device')), h('th', { class: 'hide-sm' }, 'IP'), h('th', { class: 'hide-sm' }, t('net.firmware')), h('th', {}, t('net.clients')), h('th', {}, t('net.state')))),
      h('tbody', {}, d.netdevices.map((x) => h('tr', {},
        h('td', {}, h('div', { class: 'inv-dev' }, h('span', { class: 'inv-ico', html: icon(x.type) }),
          h('div', {}, x.deviceId ? h('a', { class: 'name', href: `/devices/${x.deviceId}`, 'data-link': true }, x.name) : h('span', { class: 'name' }, x.name),
            h('div', { class: 'sub' }, [x.model, x.serial].filter(Boolean).join(' · '), x.deviceId ? null : h('span', { class: 'badge', style: { marginLeft: '6px' }, title: t('net.notInInventoryHint') }, t('net.notInInventory')))))),
        h('td', { class: 'hide-sm mono' }, x.ip || '–'),
        h('td', { class: 'hide-sm' }, h('span', { class: 'mono small' }, x.firmware || '–'), x.update ? h('span', { class: 'badge badge-new', style: { marginLeft: '6px' } }, t('net.update')) : null),
        h('td', {}, x.clients ?? '–'),
        h('td', {}, h('span', { class: `badge ${x.online ? 'badge-ok' : 'badge-bad'}` }, x.online ? 'online' : 'offline'))))))),
    (d.ports || []).length ? [h('h3', { class: 'sub-title' }, t('net.ports')), h('div', { class: 'chips' }, d.ports.map((p) => h('span', { class: `badge ${p.up ? 'badge-ok' : ''}` }, p.name)))] : null);
}

// Text with `code` parts → nodes (no HTML from translations)
const rich = (text) => String(text).split('`').flatMap((part, i) => (i % 2 ? [h('code', {}, part)]
  : part.split('**').map((x, j) => (j % 2 ? h('strong', {}, x) : x))));
const copyBtn = (getText) => btn(t('agent.copy'), { class: 'btn btn-sm', onclick: async () => {
  try { await navigator.clipboard.writeText(getText()); toast(t('agent.copied')); } catch { /* not allowed */ }
} });

// Commands that prepare Proxmox: a user with read rights only and a token that inherits exactly these rights
const PX_CMDS = {
  pve: ['pveum user add whatsonmynet@pve --comment "WhatsOnMyNet (read only)"',
    'pveum acl modify / --users whatsonmynet@pve --roles PVEAuditor',
    'pveum user token add whatsonmynet@pve womn --privsep 0'],
  pbs: ['proxmox-backup-manager user create whatsonmynet@pbs --comment "WhatsOnMyNet (read only)"',
    'proxmox-backup-manager acl update / Audit --auth-id whatsonmynet@pbs',
    'proxmox-backup-manager user generate-token whatsonmynet@pbs womn',
    "proxmox-backup-manager acl update / Audit --auth-id 'whatsonmynet@pbs!womn'"],
};
const PX_FIX = {
  pve: (user, token) => [`pveum acl modify / --users ${user} --roles PVEAuditor`, `pveum acl modify / --tokens '${token}' --roles PVEAuditor`],
  pbs: (user, token) => [`proxmox-backup-manager acl update / Audit --auth-id ${user}`, `proxmox-backup-manager acl update / Audit --auth-id '${token}'`],
};
const cmdBox = (lines) => h('div', { class: 'cmd-box' }, h('pre', { class: 'mono' }, lines.join('\n')), copyBtn(() => lines.join('\n')));

/** Step 1 of the dialog: prepare Proxmox - with commands (recommended) or by clicking through the interface */
function proxmoxSetup(kindSel) {
  const box = h('div', { class: 'px-setup' });
  let mode = 'cmd';
  const render = () => {
    const k = kindSel.value === 'pbs' ? 'pbs' : 'pve';
    const tabs = h('div', { class: 'seg' }, [['cmd', t('pxs.tabCmd')], ['gui', t('pxs.tabGui')]].map(([m, label]) => h('button', {
      type: 'button', class: mode === m ? 'on' : '', onclick: () => { mode = m; render(); } }, label)));
    const steps = mode === 'cmd'
      ? [rich(t(`pxs.${k}.cmd1`)), [rich(t('pxs.cmd2')), cmdBox(PX_CMDS[k])], rich(t(`pxs.${k}.cmd3`))]
      : [1, 2, 3, 4].map((n) => rich(t(`pxs.${k}.gui${n}`)));
    mount(box, h('h3', { class: 'px-step' }, t('pxs.step1')), h('p', { class: 'muted small', style: { margin: '0 0 8px' } }, t('pxs.why')), tabs,
      h('ol', { class: 'px-steps' }, steps.map((x) => h('li', {}, x))));
  };
  kindSel.addEventListener('change', render);
  render();
  return box;
}

/** Shows the server certificate for confirming (fingerprint), returns the chosen PEM ('' = public CA) or null */
function confirmServerCert(r, kind) {
  return new Promise((resolve) => {
    let result = null;
    const ok = h('button', { class: 'btn btn-primary', type: 'submit' }, t('adc.trust'));
    const m = modal(t('adc.checkTitle'), h('div', {},
      h('p', { style: { marginTop: 0 } }, rich(t(kind === 'pbs' ? 'pxs.compare.pbs' : kind === 'pve' ? 'pxs.compare.pve' : 'virt.compare'))),
      h('div', { class: 'cert-list' }, r.certs.map((c) => certRow(c, { full: true }))),
      h('div', { class: 'note', style: { marginTop: '14px', marginBottom: 0 } }, r.publicTrust ? t('pxs.public') : t('pxs.pinned'))),
    { wide: true, onClose: () => resolve(result), onSubmit: () => { result = r.pem; m.close(); }, actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('cancel')), ok] });
  });
}

// Hypervisors beside Proxmox: asked through their API (account with read rights) or sending on their own (script)
const VIRT = ['pve', 'pbs', 'vmware', 'xcpng', 'hyperv', 'nutanix', 'ovirt', 'libvirt'];
const PUSH = ['hyperv', 'libvirt'];
const NET = ['unifi', 'omada', 'mikrotik'];
const HW = ['redfish'];
const VIRT_URL = { redfish: 'https://idrac-srv01.firma.local', unifi: 'https://unifi.firma.local', omada: 'https://omada.firma.local:8043', mikrotik: 'https://router.firma.local', vmware: 'https://vcenter.firma.local', xcpng: 'https://xcp-master.firma.local', nutanix: 'https://prism.firma.local:9440', ovirt: 'https://engine.firma.local' };
const VIRT_USER = { redfish: 'whatsonmynet', unifi: 'whatsonmynet', omada: 'whatsonmynet', mikrotik: 'whatsonmynet', vmware: 'whatsonmynet@vsphere.local', xcpng: 'root', nutanix: 'whatsonmynet', ovirt: 'whatsonmynet@internal' };

/** Step 1: what kind of host */
function pickVirt(then, kinds = VIRT) {
  if (kinds.length === 1) { then(kinds[0]); return; }
  const dlg = modal(t(kinds === NET ? 'net.add' : 'virt.add'), h('div', { class: 'pick-grid' }, kinds.map((k) => h('button', { type: 'button', class: 'pick', onclick: () => { dlg.close(); then(k); } },
    h('span', { class: 'pick-ico', html: icon(k === 'pbs' ? 'download' : NET.includes(k) ? 'accesspoint' : 'hypervisor') }),
    h('span', { class: 'pick-title' }, t(`virt.k.${k}`)),
    h('span', { class: 'pick-text' }, t(`virt.what.${k}`))))), { wide: true });
}

/** VMware, XCP-ng, Nutanix, oVirt: address, certificate, read-only account. Hyper-V, KVM: only a name, then the script. */
function editVirt(x, kind, reload) {
  const push = PUSH.includes(kind);
  const guide = h('div', { class: 'px-setup' }, h('h3', { class: 'px-step' }, t('virt.step1', { kind: t(`virt.k.${kind}`) })),
    h('ol', { class: 'px-steps' }, [1, 2, 3].map((n) => t(`virt.${kind}.s${n}`)).filter((s) => !/^virt\./.test(s)).map((s) => h('li', {}, rich(s)))));
  const name = input('name', x?.name || '', { required: true, maxlength: 80, placeholder: push ? (kind === 'hyperv' ? 'Hyper-V Cluster' : 'kvm01') : t(`virt.k.${kind}`) });
  let form;
  if (push) {
    form = h('form', { class: 'form' }, x ? null : guide, field(t('px.name'), name, t('virt.pushName')));
  } else {
    const url = input('url', x?.url || '', { required: true, class: 'mono', placeholder: VIRT_URL[kind] });
    const ca = h('textarea', { name: 'ca', rows: 3, class: 'mono', placeholder: '-----BEGIN CERTIFICATE-----', spellcheck: 'false' }, x?.ca || '');
    const verify = h('input', { type: 'checkbox', name: 'verify', checked: x ? x.verify : true });
    const certState = h('div', { class: 'px-cert-state' });
    const showCert = (info, publicTrust = false) => mount(certState, publicTrust ? h('span', { class: 'badge badge-ok' }, t('pxs.publicShort'))
      : info ? h('div', { class: 'cert-list', style: { margin: 0 } }, certRow(info)) : h('span', { class: 'muted small' }, t('pxs.noCert')));
    showCert(x?.ca_info || null);
    const fetchBtn = h('button', { class: 'btn', type: 'button', html: `${icon('download')}<span>${t('pxs.fetch')}</span>`, onclick: async () => {
      if (!url.value.trim()) { url.reportValidity(); return; }
      fetchBtn.disabled = true;
      try {
        const r = await post('/proxmox/cert', { url: url.value });
        const pem = await confirmServerCert(r, kind);
        if (pem !== null) { ca.value = pem; verify.checked = true; showCert(r.certs[r.certs.length - 1], r.publicTrust); }
      } catch (ex) { fail(ex); }
      fetchBtn.disabled = false;
    } });
    form = h('form', { class: 'form' },
      x ? null : guide,
      h('h3', { class: 'px-step' }, x ? t('pxs.connection') : t('pxs.step2')),
      field(t('px.name'), name),
      field(t('px.url'), url, t(`virt.${kind}.url`)),
      h('div', { class: 'field' }, h('span', {}, t('px.ca')), h('div', { class: 'actions' }, fetchBtn), certState, h('span', { class: 'hint' }, t('virt.certHint'))),
      h('div', { class: 'form-grid' },
        field(t('virt.user'), input('token_id', x?.token_id || '', { required: true, class: 'mono', autocomplete: 'off', placeholder: VIRT_USER[kind] })),
        field(t('virt.password'), input('secret', '', { type: 'password', autocomplete: 'new-password', required: !x?.has_secret, placeholder: x?.has_secret ? '••••••' : '' }), x?.has_secret ? t('set.smtpPasswordSet') : t('virt.passwordHint'))),
      h('details', { class: 'cert-manual' }, h('summary', {}, t('pxs.expert')),
        field(t('px.ca'), ca, t('virt.caHint')),
        field(t('px.verify'), verify, t('px.verifyHint'))));
  }
  const m = modal(x ? x.name : HW.includes(kind) ? t('hw.add') : `${t(NET.includes(kind) ? 'net.add' : 'virt.add')}: ${t(`virt.k.${kind}`)}`, form, { wide: true, onSubmit: async () => {
    const d = { ...formData(form), kind };
    if (!d.secret) delete d.secret;
    try {
      const r = x ? await put(`/proxmox/${x.id}`, d) : await post('/proxmox', d);
      m.close();
      if (push && !x) { showScript(r, reload); return; }
      toast(push || r.last_ok ? t('saved') : r.last_error, push || r.last_ok ? undefined : 'error');
      reload();
    } catch (ex) { fail(ex); }
  }, actions: [
    btn(t('cancel'), { onclick: () => m.close() }),
    h('button', { class: 'btn btn-primary', type: 'submit' }, push ? t('save') : t('pxs.save'))] });
}

/** Hyper-V / KVM: token + script for the host, shown once, with the steps to run it every 5 minutes */
async function showScript(x, reload) {
  if (x.has_secret && !await confirmDialog(t('virt.newScript'), t('virt.newScriptConfirm'), t('virt.newScript'), t('cancel'))) return;
  let r;
  try { r = await post(`/proxmox/${x.id}/token`, { server: location.origin }); } catch (ex) { fail(ex); return; }
  scriptDialog(`${t('virt.scriptTitle')}: ${x.name}`, { script: { file: r.file, text: r.text }, uninstall: r.uninstall }, { where: x.kind, onClose: reload });
}

async function proxmox(body, _s, reload, scope = 'virt') {
  const kinds = scope === 'net' ? NET : scope === 'hw' ? HW : VIRT;
  const list = (await get('/proxmox')).filter((x) => kinds.includes(x.kind));
  const edit = (x, preset = 'pve') => {
    // Backup Server: port 8007 and realm pbs - also when it was chosen in the step before (not only by the select)
    const start = x?.kind || preset;
    const kind = select('kind', [['pve', 'Proxmox VE'], ['pbs', 'Proxmox Backup Server']], start);
    const defUrl = (k) => (k === 'pbs' ? 'https://192.168.1.20:8007' : 'https://192.168.1.10:8006');
    const url = input('url', x?.url || '', { required: true, class: 'mono', placeholder: defUrl(start) });
    const defToken = (k) => (k === 'pbs' ? 'whatsonmynet@pbs!womn' : 'whatsonmynet@pve!womn');
    const tokenId = input('token_id', x?.token_id || defToken(start), { required: true, class: 'mono', autocomplete: 'off', placeholder: defToken(start) });
    const ca = h('textarea', { name: 'ca', rows: 3, class: 'mono', placeholder: '-----BEGIN CERTIFICATE-----', spellcheck: 'false' }, x?.ca || '');
    const verify = h('input', { type: 'checkbox', name: 'verify', checked: x ? x.verify : true });
    kind.addEventListener('change', () => {
      url.placeholder = defUrl(kind.value);
      if (!x && /^whatsonmynet@pb?v?e?s?!womn$/.test(tokenId.value)) tokenId.value = defToken(kind.value);
      tokenId.placeholder = defToken(kind.value);
    });
    // Certificate: fetch from the server and confirm the fingerprint - no file to look for
    const certState = h('div', { class: 'px-cert-state' });
    const showCert = (info, publicTrust = false) => mount(certState, publicTrust ? h('span', { class: 'badge badge-ok' }, t('pxs.publicShort'))
      : info ? h('div', { class: 'cert-list', style: { margin: 0 } }, certRow(info)) : h('span', { class: 'muted small' }, t('pxs.noCert')));
    showCert(x?.ca_info || null);
    const fetchBtn = h('button', { class: 'btn', type: 'button', html: `${icon('download')}<span>${t('pxs.fetch')}</span>`, onclick: async () => {
      if (!url.value.trim()) { url.reportValidity(); return; }
      fetchBtn.disabled = true;
      // (same steps in editVirt for the other hypervisors)
      try {
        const r = await post('/proxmox/cert', { url: url.value });
        const pem = await confirmServerCert(r, kind.value);
        if (pem !== null) { ca.value = pem; verify.checked = true; showCert(r.certs[r.certs.length - 1], r.publicTrust); }
      } catch (ex) { fail(ex); }
      fetchBtn.disabled = false;
    } });
    const form = h('form', { class: 'form' },
      x ? null : proxmoxSetup(kind),
      h('h3', { class: 'px-step' }, x ? t('pxs.connection') : t('pxs.step2')),
      h('div', { class: 'form-grid' },
        field(t('px.name'), input('name', x?.name || '', { required: true, maxlength: 80, placeholder: start === 'pbs' ? 'pbs01' : 'pve01' })),
        field(t('px.kind'), kind)),
      field(t('px.url'), url, t('pxs.urlHint')),
      h('div', { class: 'field' }, h('span', {}, t('px.ca')), h('div', { class: 'actions' }, fetchBtn), certState, h('span', { class: 'hint' }, t('pxs.certHint'))),
      h('div', { class: 'form-grid' },
        field(t('px.tokenId'), tokenId, t('pxs.tokenIdHint')),
        field(t('px.secret'), input('secret', '', { type: 'password', autocomplete: 'new-password', required: !x?.has_secret, placeholder: x?.has_secret ? '••••••' : '' }), x?.has_secret ? t('set.smtpPasswordSet') : t('pxs.secretHint'))),
      h('details', { class: 'cert-manual' }, h('summary', {}, t('pxs.expert')),
        field(t('px.ca'), ca, t('px.caHint')),
        field(t('px.verify'), verify, t('px.verifyHint'))));
    const m = modal(x ? x.name : t('px.add'), form, { wide: true, onSubmit: async () => {
      const d = formData(form);
      if (!d.secret) delete d.secret;
      try { const r = x ? await put(`/proxmox/${x.id}`, d) : await post('/proxmox', d); m.close(); toast(r.last_ok ? t('px.connected') : r.last_error, r.last_ok ? undefined : 'error'); reload(); } catch (ex) { fail(ex); }
    }, actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, t('pxs.save'))] });
  };
  const admin = state.user.isAdmin;
  const add = () => pickVirt((kind) => (kind === 'pve' || kind === 'pbs' ? edit(null, kind) : editVirt(null, kind, reload)), kinds);
  const p = { net: 'net', hw: 'hw' }[scope] || 'virt';
  const actions = (x) => (!admin ? null : h('div', { class: 'actions' },
    PUSH.includes(x.kind) ? null : btn(t('prn.refresh'), { class: 'btn btn-sm', onclick: async (e) => { e.currentTarget.disabled = true; try { await post(`/proxmox/${x.id}/poll`, {}); reload(); } catch (ex) { fail(ex); } } }, 'refresh'),
    PUSH.includes(x.kind) ? btn(t('virt.newScript'), { class: 'btn btn-sm btn-ghost', onclick: () => showScript(x, reload) }) : null,
    btn(t('edit'), { class: 'btn btn-sm btn-ghost', onclick: () => (x.kind === 'pve' || x.kind === 'pbs' ? edit(x) : editVirt(x, x.kind, reload)) }),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${x.name}`, html: icon('trash'), onclick: async () => {
      if (!await confirmDialog(t('delete'), t('px.deleteConfirm', { name: x.name }), t('delete'), t('cancel'), { danger: true })) return;
      try { await del(`/proxmox/${x.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
    } })));
  const head = pageHead(t(`${p}.title`), t(`${p}.lead`), admin ? btn(t(`${p}.add`), { class: 'btn btn-primary', onclick: add }, 'plus') : null);
  if (!list.length) {
    mount(body, head, h('section', { class: 'panel panel-pad' }, h('p', { class: 'muted', style: { margin: 0 } }, admin ? t(p === 'virt' ? 'px.none' : `${p}.none`) : t('px.noHosts'))));
    return;
  }
  // Few hosts: as before, everything open. Many: one line each, problems first, details on click
  const rows = list.map((x) => ({ x, s: hostSummary(x) }));
  const ORDER = { bad: 0, warn: 1, wait: 2, ok: 3 };
  rows.sort((a, b) => ORDER[a.s.state] - ORDER[b.s.state] || a.x.name.localeCompare(b.x.name, undefined, { numeric: true }));
  const KEY = `womn.virt.open.${scope}`;
  let open;
  try { open = new Set(JSON.parse(sessionStorage.getItem(KEY) || '[]')); } catch { open = new Set(); }
  const remember = () => { try { sessionStorage.setItem(KEY, JSON.stringify([...open])); } catch { /* not allowed */ } };
  // From two hosts on: one line each with the figures; a single host stays open as before
  const compact = list.length > 1;
  let filter = 'all';
  const q = h('input', { type: 'search', placeholder: t('vo.search'), 'aria-label': t('vo.search') });
  const qBox = h('label', { class: 'search' }, h('span', { class: 'ico', html: icon('search') }), q);
  const kindsHere = [...new Set(list.map((x) => x.kind))];
  const problems = rows.filter((r) => r.s.state === 'bad' || r.s.state === 'warn').length;
  const chip = (key, label, n) => h('button', { type: 'button', class: `fchip${filter === key ? ' on' : ''}`, 'aria-pressed': String(filter === key), onclick: () => { filter = key; draw(); } }, label, h('span', { class: 'chip-n' }, n));
  const chips = h('div', { class: 'inv-chips', role: 'group' });
  const listBox = h('div', { class: 'host-list' });
  const matches = (r, needle) => !needle || r.s.text.includes(needle);
  function draw() {
    const needle = q.value.trim().toLowerCase();
    mount(chips, chip('all', t('all'), rows.length), problems ? chip('problems', t('vo.problems'), problems) : null,
      kindsHere.length > 1 ? kindsHere.map((k) => chip(k, t(`vo.k.${k}`) === `vo.k.${k}` ? t(`virt.k.${k}`) : t(`vo.k.${k}`), list.filter((x) => x.kind === k).length)) : null);
    const shown = rows.filter((r) => (filter === 'all' || (filter === 'problems' ? r.s.state === 'bad' || r.s.state === 'warn' : r.x.kind === filter)) && matches(r, needle));
    mount(listBox, shown.length ? shown.map((r) => hostRow(r, compact ? open.has(r.x.id) || (needle && r.s.deep.includes(needle) && shown.length <= 3) : true)) : h('p', { class: 'muted panel panel-pad', style: { margin: 0 } }, t('vo.noMatch')));
  }
  function hostRow({ x, s }, isOpen) {
    const det = h('details', { class: `host-row panel hs-${s.state}` });
    det.open = !!isOpen;
    det.addEventListener('toggle', () => {
      if (det.open) open.add(x.id); else open.delete(x.id);
      remember();
      if (det.open && !det.dataset.filled) { det.dataset.filled = '1'; det.append(h('div', { class: 'host-body' }, actions(x), proxmoxDetail(x))); }
    });
    det.append(h('summary', {},
      h('span', { class: `dot ${s.state === 'bad' ? 'dot-bad' : s.state === 'warn' ? 'dot-new' : s.state === 'wait' ? '' : 'dot-ok'}`, 'aria-hidden': 'true' }),
      h('span', { class: 'host-name' }, h('strong', {}, x.name), h('span', { class: 'muted small mono' }, [t(`virt.k.${x.kind}`), x.url.replace(/^https:\/\//, '')].filter(Boolean).join(' · '))),
      h('span', { class: 'host-figs' }, s.figures.map((f) => h('span', { class: 'fig' }, f))),
      h('span', { class: 'host-issues' }, s.issues.slice(0, 2).map((i) => h('span', { class: `badge ${i.tone === 'bad' ? 'badge-bad' : 'badge-new'}`, title: i.text }, i.text.length > 48 ? `${i.text.slice(0, 46)}…` : i.text)),
        s.issues.length > 2 ? h('span', { class: 'muted small' }, t('vo.more', { n: s.issues.length - 2 })) : null)));
    if (isOpen) { det.dataset.filled = '1'; det.append(h('div', { class: 'host-body' }, actions(x), proxmoxDetail(x))); }
    return det;
  }
  q.addEventListener('input', draw);
  // The whole picture in four numbers (only where it means something)
  const all = rows.map((r) => r.s);
  const sum = (k) => all.reduce((a, b) => a + (b.n[k] || 0), 0);
  const tiles = [
    [t('vo.hosts'), rows.length, problems ? t('vo.withProblems', { n: problems }) : t('vo.allFine'), problems ? 'bad' : 'ok'],
    sum('nodes') ? [t('vo.nodes'), `${sum('nodesOn')}/${sum('nodes')}`, t('vo.online'), sum('nodesOn') < sum('nodes') ? 'bad' : 'ok'] : null,
    sum('guests') ? [t('vo.guests'), `${sum('guestsOn')}/${sum('guests')}`, t('vo.running'), ''] : null,
    sum('stores') ? [t('vo.storage'), sum('storesFull'), t('vo.over85'), sum('storesFull') ? 'warn' : 'ok'] : null,
    sum('backupIssues') || sum('backupHosts') ? [t('vo.backups'), sum('backupIssues'), t('vo.backupIssues'), sum('backupIssues') ? 'bad' : 'ok'] : null,
  ].filter(Boolean);
  mount(body, head,
    compact ? h('div', { class: 'vo-tiles' }, tiles.map(([label, big, small, tone]) => h('div', { class: `vo-tile vt-${tone}` }, h('span', { class: 'muted small' }, label), h('b', {}, big), h('span', { class: 'small' }, small)))) : null,
    compact ? h('div', { class: 'vo-toolbar' }, qBox, chips) : null,
    listBox);
  draw();
}

/** One line per host: state (bad / warn / ok / wait), the key figures and what is wrong - also the text to search in */
function hostSummary(x) {
  const d = x.data || {};
  // "1 Sicherung" instead of "1 Sicherungen": a key with 1 at the end for exactly one
  const tn = (key, vars) => (vars.n === 1 && t(`${key}1`) !== `${key}1` ? t(`${key}1`, vars) : t(key, vars));
  const issues = []; const figures = []; const n = {};
  const bad = (text) => issues.push({ tone: 'bad', text });
  const warn = (text) => issues.push({ tone: 'warn', text });
  const deep = [];
  if (!x.last_at) figures.push(PUSH.includes(x.kind) ? t('virt.waiting') : t('prn.none'));
  else if (!x.last_ok) bad(x.last_error || t('vo.error'));
  if (x.last_ok && (d.missing || []).length) warn(t('vo.rights'));
  // Cluster: the entered node does not answer, another one did
  if (x.last_ok && d.via) warn(t('vo.via', { node: d.via.node }));
  if (d.netdevices) {
    const off = d.netdevices.filter((y) => !y.online).length;
    if (off) bad(t('vo.devOffline', { n: off }));
    const upd = d.netdevices.filter((y) => y.update).length;
    if (upd) warn(tn('vo.updates', { n: upd }));
    figures.push(t('vo.fig.devices', { on: d.netdevices.length - off, n: d.netdevices.length }));
    if (d.clients !== undefined && d.kind !== 'mikrotik') figures.push(t('vo.fig.clients', { n: d.clients ?? 0 }));
    deep.push(...d.netdevices.map((y) => `${y.name} ${y.ip || ''} ${y.model || ''}`));
  } else if (d.kind === 'redfish') {
    if (d.health === 'critical') bad(t('vo.hwCritical')); else if (d.health === 'warning') warn(t('vo.hwWarning'));
    if (d.power === 'off') bad(t('hw.powerOff'));
    figures.push([d.vendor, d.model].filter(Boolean).join(' '));
    if (d.watts) figures.push(`${d.watts} W`);
    deep.push(d.serial || '', d.sku || '');
  } else if (d.kind === 'pbs') {
    const full = (d.datastores || []).filter((y) => y.pct >= 85);
    if (full.length) (full.some((y) => y.pct >= 95) ? bad : warn)(tn('vo.storeFull', { n: full.length }));
    const old = (d.groups || []).filter((g) => !g.last || Date.now() / 1000 - g.last > 26 * 3600).length;
    if (old) warn(tn('vo.groupsOld', { n: old }));
    if ((d.failed || []).length) bad(tn('vo.tasksFailed', { n: d.failed.length }));
    const maxPct = Math.max(0, ...(d.datastores || []).map((y) => y.pct || 0));
    figures.push(t('vo.fig.stores', { n: (d.datastores || []).length, pct: maxPct }), t('vo.fig.groups', { n: (d.groups || []).length }));
    n.stores = (d.datastores || []).length; n.storesFull = full.length; n.backupHosts = 1; n.backupIssues = old + (d.failed || []).length;
    deep.push(...(d.datastores || []).map((y) => y.name), ...(d.groups || []).map((g) => `${g.type}/${g.id} ${g.comment || ''}`));
  } else if (d.kind) {
    const nodes = d.nodes || []; const guests = d.guests || []; const stores = (d.storages || []).filter((y) => y.total);
    const offN = nodes.filter((y) => !y.online).length;
    if (offN) bad(tn('vo.nodesOff', { n: offN }));
    const full = stores.filter((y) => y.pct >= 85);
    if (full.length) (full.some((y) => y.pct >= 95) ? bad : warn)(tn('vo.storeFull', { n: full.length }));
    let backupIssues = 0;
    if (d.kind === 'pve') {
      const failed = (d.backups || []).filter((b) => !b.ok && b.end && Date.now() / 1000 - b.start < 86400).length;
      if (failed) bad(tn('vo.backupsFailed', { n: failed }));
      backupIssues = failed;
      n.backupHosts = 1;
    }
    const on = guests.filter((g) => g.status === 'running').length;
    figures.push(t('vo.fig.nodes', { on: nodes.length - offN, n: nodes.length }), t('vo.fig.guests', { on, n: guests.length }));
    // Temperatures of nodes that also run the Linux script
    const hot = nodes.filter((y) => y.temp).map((y) => y.temp);
    if (hot.length) {
      const top = hot.reduce((a, b) => (b.c > a.c ? b : a));
      figures.push(t('vo.fig.temp', { c: top.c }));
      if (hot.some((y) => y.c >= y.warn)) warn(tn('vo.tempHigh', { n: hot.filter((y) => y.c >= y.warn).length }));
    }
    if (stores.length) figures.push(t('vo.fig.storage', { pct: Math.max(...stores.map((y) => y.pct || 0)) }));
    Object.assign(n, { nodes: nodes.length, nodesOn: nodes.length - offN, guests: guests.length, guestsOn: on, stores: stores.length, storesFull: full.length, backupIssues });
    deep.push(...nodes.map((y) => y.name), ...guests.map((g) => `${g.vmid ?? ''} ${g.name}`), ...stores.map((y) => y.name));
  }
  const state = !x.last_at ? 'wait' : issues.some((i) => i.tone === 'bad') ? 'bad' : issues.length ? 'warn' : 'ok';
  const deepText = deep.join(' ').toLowerCase();
  return { state, issues, figures: figures.filter(Boolean), n, deep: deepText, text: `${x.name} ${x.url} ${t(`virt.k.${x.kind}`)} ${deepText}`.toLowerCase() };
}

/** After a restore the server restarts: wait until it answers again, then load the page anew */
function waitForRestart() {
  modal(t('bk.restarting'), h('p', {}, t('bk.restartingText')), { actions: [] });
  let tries = 0;
  const poll = async () => {
    tries++;
    try { const r = await fetch('/healthz', { cache: 'no-store' }); if (r.ok && tries > 2) { location.reload(); return; } } catch { /* still down */ }
    if (tries < 120) setTimeout(poll, 2000);
  };
  setTimeout(poll, 2500);
}

async function backup(body, _s, reload) {
  const { list, keep } = await get('/backups');
  const size = (n) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  const confirmRestore = (what) => confirmDialog(t('bk.restore'), t('bk.restoreConfirm', { what }), t('bk.restore'), t('cancel'), { danger: true });
  const file = h('input', { type: 'file', accept: '.sqlite,.db,application/octet-stream' });
  const upload = btn(t('bk.restoreUpload'), { class: 'btn btn-danger', onclick: async (e) => {
    const b = e.currentTarget;
    const f = file.files[0];
    if (!f) { toast(t('bk.chooseFile'), 'error'); return; }
    if (!await confirmRestore(f.name)) return;
    b.disabled = true;
    try { await api('/backups/restore', { method: 'POST', raw: f, headers: { 'X-WOMN-Confirm': 'restore' } }); waitForRestart(); } catch (ex) { fail(ex); b.disabled = false; }
  } }, 'history');
  mount(body,
    panel(t('bk.title'),
      h('p', { class: 'muted', style: { marginTop: 0 } }, t('bk.lead', { keep })),
      h('div', { class: 'actions' },
        h('a', { class: 'btn btn-primary', href: '/api/backups/download', download: '' }, h('span', { html: icon('download') }), t('bk.download')),
        btn(t('bk.createNow'), { onclick: (e) => busy(e.currentTarget, async () => { try { await post('/backups'); toast(t('saved')); reload(); } catch (ex) { fail(ex); } }) }, 'plus')),
      h('p', { class: 'note warn', style: { marginBottom: 0 } }, t('bk.keyHint'))),
    panel(t('bk.stored'), list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('bk.file')), h('th', {}, t('bk.when')), h('th', { class: 'hide-sm' }, t('bk.size')), h('th', {}))),
      h('tbody', {}, list.map((x) => h('tr', {},
        h('td', { class: 'mono small', style: { wordBreak: 'break-all' } }, x.name, x.kind !== 'daily' ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, t(`bk.kind.${x.kind}`)) : null),
        h('td', { style: { whiteSpace: 'nowrap' } }, fmtDate(x.at, getLang())),
        h('td', { class: 'hide-sm mono small', style: { whiteSpace: 'nowrap' } }, size(x.size)),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          h('a', { class: 'btn btn-sm', href: `/api/backups/file/${encodeURIComponent(x.name)}`, download: '' }, t('bk.downloadShort')),
          btn(t('bk.restore'), { class: 'btn btn-sm btn-ghost', onclick: async (e) => {
            const b = e.currentTarget;
            if (!await confirmRestore(x.name)) return;
            if (b.disabled) return;
            b.disabled = true; // stays disabled on success: the server restarts
            try { await api(`/backups/file/${encodeURIComponent(x.name)}/restore`, { method: 'POST', body: {}, headers: { 'X-WOMN-Confirm': 'restore' } }); waitForRestart(); } catch (ex) { fail(ex); b.disabled = false; }
          } })))))))) : h('p', { class: 'muted' }, t('bk.none'))),
    panel(t('bk.restoreUpload'), h('p', { class: 'muted', style: { marginTop: 0 } }, t('bk.restoreLead')), field(t('bk.file'), file), h('div', { class: 'actions' }, upload)));
}

async function reports(body, _s, reload) {
  const [list, locs, cand] = await Promise.all([get('/reports'), get('/locations'), get('/reports/candidates')]);
  const SECS = ['printers', 'nas', 'switches', 'shares'];
  const DAYS = [1, 2, 3, 4, 5, 6, 7];
  const when = (s) => {
    const day = s.freq === 'weekly' ? t(`day.${s.weekday % 7}`) : s.freq === 'monthly' ? t('rep.monthDay', { d: s.day }) : t('rep.daily');
    return `${day}, ${s.time}`;
  };
  const edit = (r) => {
    const v = r || { name: '', sections: ['printers'], recipients: [], schedule: { freq: 'weekly', weekday: 1, day: 1, time: '08:00' }, location_ids: [],
      subject: '', intro: t('rep.introDefault'), signature: t('rep.signatureDefault'), from_name: '', language: getLang(), only_attention: false, enabled: true };
    const freq = select('freq', [['daily', t('rep.freq.daily')], ['weekly', t('rep.freq.weekly')], ['monthly', t('rep.freq.monthly')]], v.schedule.freq);
    const wd = h('div', {}, field(t('rep.weekday'), select('weekday', DAYS.map((d) => [String(d), t(`day.${d % 7}`)]), String(v.schedule.weekday || 1))));
    const md = h('div', {}, field(t('rep.day'), input('day', v.schedule.day || 1, { type: 'number', min: 1, max: 28 })));
    const syncFreq = () => { wd.hidden = freq.value !== 'weekly'; md.hidden = freq.value !== 'monthly'; };
    freq.addEventListener('change', syncFreq);
    // Devices: all of the chosen kinds, or only the ticked ones (e.g. one report per printer)
    const chosen = new Set([...(v.device_ids || []).map((x) => `d${x}`), ...(v.monitor_ids || []).map((x) => `m${x}`)]);
    const pickSel = select('pick', [['all', t('rep.pickAll')], ['some', t('rep.pickSome')]], chosen.size ? 'some' : 'all');
    const devList = h('div', { class: 'rep-devices' });
    let form = null;
    const renderDevices = () => {
      devList.hidden = pickSel.value !== 'some';
      if (devList.hidden || !form) return;
      const secs = SECS.filter((x) => form.querySelector(`[name=sec_${x}]`)?.checked);
      const locSel = locs.filter((l) => form.querySelector(`[name=loc_${l.id}]`)?.checked).map((l) => l.id);
      const groups = secs.map((sec) => {
        const items = (cand[sec] || []).filter((x) => !locSel.length || locSel.includes(x.location_id));
        const key = (x) => `${sec === 'shares' ? 'm' : 'd'}${x.id}`;
        return h('div', { class: 'rep-dev-group' }, h('div', { class: 'rep-dev-head' }, t(`rep.sec.${sec}`)),
          items.length ? items.map((x) => h('label', { class: 'check rep-dev' },
            h('input', { type: 'checkbox', checked: chosen.has(key(x)), onchange: (e) => { if (e.target.checked) chosen.add(key(x)); else chosen.delete(key(x)); } }),
            h('span', {}, x.name), h('span', { class: 'muted small' }, [x.ip, x.location].filter(Boolean).join(' · '))))
            : h('div', { class: 'muted small' }, t('rep.noDevices')));
      });
      mount(devList, secs.length ? groups : h('div', { class: 'muted small' }, t('rep.pickSections')));
    };
    pickSel.addEventListener('change', renderDevices);
    form = h('form', { class: 'form-grid' },
      h('div', { class: 'full' }, field(t('rep.name'), input('name', v.name, { required: true, maxlength: 100, placeholder: t('rep.namePh') }))),
      h('div', { class: 'full field' }, t('rep.sections'), h('div', { class: 'chips' }, SECS.map((x) => h('label', { class: 'check', style: { marginRight: '14px' } },
        h('input', { type: 'checkbox', name: `sec_${x}`, checked: v.sections.includes(x) }), t(`rep.sec.${x}`))))),
      h('div', { class: 'full' }, field(t('rep.recipients'), h('textarea', { name: 'recipients', rows: 2, required: true, placeholder: t('ph.recipients') }, v.recipients.join(', ')), t('rep.recipientsHint'))),
      field(t('rep.freq'), freq), wd, md,
      field(t('rep.time'), input('time', v.schedule.time, { type: 'time', required: true })),
      locs.length > 1 ? h('div', { class: 'full field' }, t('rep.locations'), h('div', { class: 'chips' }, locs.map((l) => h('label', { class: 'check', style: { marginRight: '14px' } },
        h('input', { type: 'checkbox', name: `loc_${l.id}`, checked: v.location_ids.includes(l.id) }), l.name))), h('span', { class: 'hint' }, t('rep.locationsHint'))) : null,
      h('div', { class: 'full' }, field(t('rep.devices'), pickSel, t('rep.devicesHint')), devList),
      h('div', { class: 'full' }, h('h3', { class: 'sub-title' }, t('rep.mail')), h('p', { class: 'muted small', style: { margin: 0 } }, t('rep.neutral'))),
      field(t('rep.fromName'), input('from_name', v.from_name, { maxlength: 100, placeholder: t('rep.fromNamePh') }), t('rep.fromNameHint')),
      field(t('rep.subject'), input('subject', v.subject, { maxlength: 200, placeholder: t('rep.subjectPh') }), t('rep.subjectHint')),
      h('div', { class: 'full' }, field(t('rep.intro'), h('textarea', { name: 'intro', rows: 3 }, v.intro))),
      h('div', { class: 'full' }, field(t('rep.signature'), h('textarea', { name: 'signature', rows: 3 }, v.signature))),
      field(t('ch.language'), select('language', [['de', 'Deutsch'], ['en', 'English']], v.language)),
      h('div', {}, field(t('rep.onlyAttention'), h('input', { type: 'checkbox', name: 'only_attention', checked: v.only_attention }), t('rep.onlyAttentionHint'))),
      r ? field(t('user.active'), h('input', { type: 'checkbox', name: 'enabled', checked: v.enabled })) : null);
    syncFreq();
    form.addEventListener('change', (e) => { if (/^(sec|loc)_/.test(e.target.name || '')) renderDevices(); });
    renderDevices();
    const m = modal(r ? r.name : t('rep.add'), form, { wide: true, onSubmit: async () => {
      const d = formData(form);
      const payload = { name: d.name, sections: SECS.filter((x) => d[`sec_${x}`]), recipients: d.recipients,
        schedule: { freq: d.freq, weekday: Number(d.weekday), day: Number(d.day), time: d.time }, location_ids: locs.filter((l) => d[`loc_${l.id}`]).map((l) => l.id),
        subject: d.subject, intro: d.intro, signature: d.signature, from_name: d.from_name, language: d.language, only_attention: d.only_attention, enabled: r ? d.enabled : true,
        pick: pickSel.value, device_ids: [...chosen].filter((x) => x[0] === 'd').map((x) => Number(x.slice(1))), monitor_ids: [...chosen].filter((x) => x[0] === 'm').map((x) => Number(x.slice(1))) };
      try { if (r) await put(`/reports/${r.id}`, payload); else await post('/reports', payload); m.close(); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
    }, actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  };
  const preview = (r) => {
    const frame = h('iframe', { src: `/api/reports/${r.id}/preview`, title: t('rep.preview'), class: 'report-frame', sandbox: '' });
    const m = modal(`${t('rep.preview')}: ${r.name}`, frame, { wide: true, onSubmit: () => m.close(), actions: [h('button', { class: 'btn btn-primary', type: 'submit' }, t('agent.done'))] });
  };
  const sendNow = async (r, test, b) => {
    b.disabled = true;
    try { const x = await post(`/reports/${r.id}/send`, { test }); toast(test ? t('rep.testSent', { email: state.user.email }) : t('rep.sent', { n: x.count })); reload(); } catch (ex) { fail(ex); }
    b.disabled = false;
  };
  mount(body, pageHead(t('set.reports'), t('rep.lead'), btn(t('rep.add'), { class: 'btn btn-primary', onclick: () => edit(null) }, 'plus')), h('section', { class: 'panel' },
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('rep.name')), h('th', {}, t('rep.when')), h('th', { class: 'hide-sm' }, t('rep.recipients')), h('th', {}))),
      h('tbody', {}, list.map((r) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, r.name), r.enabled ? null : h('span', { class: 'badge', style: { marginLeft: '6px' } }, t('user.inactive')),
          h('div', { class: 'sub' }, r.sections.map((x) => t(`rep.sec.${x}`)).join(', '),
            r.device_ids.length + r.monitor_ids.length ? ` · ${t('rep.pickedN', { n: r.device_ids.length + r.monitor_ids.length })}` : '')),
        h('td', {}, when(r.schedule), r.last_run ? h('div', { class: 'sub' }, `${t('rep.last')}: ${fmtDate(r.last_run, getLang())}`,
          r.last_status && r.last_status !== 'ok' ? h('span', { class: 'badge badge-bad', style: { marginLeft: '6px' }, title: r.last_status }, t('rep.failed')) : null) : null),
        h('td', { class: 'hide-sm small' }, r.recipients.join(', ')),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          btn(t('rep.preview'), { class: 'btn btn-sm', onclick: () => preview(r) }),
          btn(t('rep.test'), { class: 'btn btn-sm btn-ghost', title: t('rep.testHint'), onclick: (e) => sendNow(r, true, e.currentTarget) }),
          btn(t('rep.sendNow'), { class: 'btn btn-sm btn-ghost', onclick: (e) => sendNow(r, false, e.currentTarget) }),
          btn(t('edit'), { class: 'btn btn-sm btn-ghost', onclick: () => edit(r) }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${r.name}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('rep.deleteConfirm', { name: r.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/reports/${r.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
          } }))))))))
      : h('p', { class: 'panel-pad muted', style: { margin: 0 } }, t('rep.none'))));
}

async function agents(body, _s, reload) {
  const [list, locs, cert] = await Promise.all([get('/agents'), get('/locations'), get('/tls/agent-ca').catch(() => ({ ca: '' }))]);
  const server = location.origin;
  const showToken = (a) => {
    // Self-signed certificate: the agent trusts exactly this one (pinned); an uploaded one from a real CA needs nothing
    const env = [`WOMN_AGENT_SERVER=${server}`, `WOMN_AGENT_TOKEN=${a.token}`, cert.ca && cert.source !== 'custom' ? `WOMN_AGENT_CA=${cert.ca}` : null, 'TZ=Europe/Berlin', 'PUID=1000', 'PGID=1000']
      .filter(Boolean).join('\n');
    const m = modal(`${t('agent.tokenTitle')}: ${a.name}`, h('div', { class: 'form' },
      h('p', { class: 'note warn', style: { margin: 0 } }, t('agent.tokenOnce')),
      h('p', { class: 'muted', style: { margin: 0 } }, t('agent.envLead')),
      h('pre', { class: 'code wrap' }, env),
      cert.source === 'custom' ? h('p', { class: 'muted small', style: { margin: 0 } }, t('agent.customCaHint')) : null,
      h('p', { class: 'muted small', style: { margin: 0 } }, t('agent.composeHint'))), { wide: true, onSubmit: () => { m.close(); reload(); }, actions: [
      btn(t('agent.copy'), { onclick: async () => { try { await navigator.clipboard.writeText(env); toast(t('agent.copied')); } catch { /* not allowed */ } } }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, t('agent.done'))] });
  };
  const edit = (a) => {
    const form = h('form', { class: 'form' },
      field(t('agent.name'), input('name', a?.name || '', { required: true, maxlength: 80, placeholder: t('ph.agentName') })),
      field(t('agent.location'), select('location_id', locs.map((l) => [String(l.id), l.name]), a ? String(a.location_id) : String(locs[0]?.id || '')), t('agent.locationHint')),
      a ? field(t('user.active'), h('input', { type: 'checkbox', name: 'enabled', checked: !!a.enabled })) : null);
    const m = modal(a ? a.name : t('agent.add'), form, { onSubmit: async () => {
      try {
        if (a) { await put(`/agents/${a.id}`, formData(form)); m.close(); toast(t('saved')); reload(); }
        else { const r = await post('/agents', formData(form)); m.close(); showToken(r); }
      } catch (ex) { fail(ex); }
    }, actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  };
  const seen = (a) => {
    if (!a.last_seen) return h('span', { class: 'badge' }, t('agent.never'));
    const fresh = Date.now() - Date.parse(a.last_seen) < 5 * 60 * 1000;
    return h('span', { class: `badge ${fresh ? 'badge-ok' : 'badge-bad'}`, title: fmtDate(a.last_seen, getLang()) }, fresh ? t('agent.online') : t('agent.offline'));
  };
  mount(body, h('section', { class: 'panel' },
    h('div', { class: 'panel-head', style: { paddingBottom: '12px', flexWrap: 'wrap' } }, h('h2', {}, t('set.agents')),
      locs.length ? btn(t('agent.add'), { class: 'btn btn-sm', onclick: () => edit(null) }, 'plus') : null),
    h('p', { class: 'muted', style: { padding: '0 20px' } }, t('agent.lead')),
    !locs.length ? h('p', { class: 'panel-pad muted', style: { margin: 0 } }, t('agent.noLocations')) : null,
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('agent.name')), h('th', {}, t('agent.location')), h('th', {}, t('agent.state')), h('th', { class: 'hide-sm' }, t('agent.version')), h('th', {}))),
      h('tbody', {}, list.map((a) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, a.name), a.enabled ? null : h('span', { class: 'badge', style: { marginLeft: '6px' } }, t('user.inactive')),
          a.last_ip ? h('div', { class: 'sub mono' }, a.last_ip) : null),
        h('td', {}, a.location_name),
        h('td', {}, seen(a), a.open_jobs ? h('span', { class: 'muted small', style: { marginLeft: '6px' } }, t('agent.openJobs', { n: a.open_jobs })) : null),
        h('td', { class: 'hide-sm mono small' }, a.version || '–'),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          btn(t('agent.scan'), { class: 'btn btn-sm', onclick: async () => { try { await post(`/agents/${a.id}/scan`, { kind: 'network' }); toast(t('agent.jobSent', { names: a.name })); reload(); } catch (ex) { fail(ex); } } }, 'radar'),
          btn(t('edit'), { class: 'btn btn-sm btn-ghost', onclick: () => edit(a) }),
          btn(t('agent.newToken'), { class: 'btn btn-sm btn-ghost', onclick: async () => {
            if (!await confirmDialog(t('agent.newToken'), t('agent.newTokenConfirm', { name: a.name }), t('agent.newToken'), t('cancel'))) return;
            try { showToken(await post(`/agents/${a.id}/token`, {})); } catch (ex) { fail(ex); }
          } }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${a.name}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('agent.deleteConfirm', { name: a.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/agents/${a.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
          } }))))))))
      : h('p', { class: 'panel-pad muted', style: { margin: 0 } }, t('agent.none'))));
}

async function ad(body, _s, reload) {
  const c = await get('/settings/ad');
  // Server: domain controller, encryption and port (like Helfi.Space) - the port follows the encryption
  const port = input('port', c.host ? c.port : '', { type: 'number', min: 1, max: 65535, placeholder: c.security === 'starttls' ? '389' : '636' });
  const security = select('security', [['ldaps', t('ad.sec.ldaps')], ['starttls', t('ad.sec.starttls')]], c.security);
  security.addEventListener('change', () => {
    const def = security.value === 'starttls' ? '389' : '636';
    if (!port.value || ['389', '636'].includes(port.value)) port.value = def;
    port.placeholder = def;
  });
  const trust = select('trust', [['pinned', t('ad.trust.pinned')], ['system', t('ad.trust.system')], ['insecure', t('ad.trust.insecure')]], c.trust);
  const baseDn = input('baseDn', c.baseDn, { class: 'mono', placeholder: t('ad.baseDnPh') });
  const values = () => {
    const d = formData(form);
    const v = { ...d, trust: trust.value, verifyHostname: !!d.verifyHostname, nested: !!d.nested, enabled: !!d.enabled };
    if (!d.bindPassword) delete v.bindPassword;
    return v;
  };
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    try { await put('/settings/ad', values()); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
  } },
  h('p', { class: 'muted' }, t('ad.lead')),
  field(t('ad.enabled'), h('input', { type: 'checkbox', name: 'enabled', checked: c.enabled })),

  h('h3', { class: 'ad-sec' }, t('ad.server')),
  h('div', { class: 'ad-grid-3' },
    field(t('ad.host'), input('host', c.host, { class: 'mono', placeholder: 'dc01.firma.local' }), t('ad.hostHint')),
    field(t('ad.security'), security),
    field(t('ad.port'), port)),

  h('h3', { class: 'ad-sec' }, t('ad.certificate')),
  h('div', { class: 'form-grid' },
    field(t('ad.trust'), trust, t('ad.trustHint')),
    field(t('ad.verifyHostname'), h('input', { type: 'checkbox', name: 'verifyHostname', checked: c.verifyHostname }), t('ad.verifyHostnameHint'))),
  adCertBlock(c.cert, values, reload),

  h('h3', { class: 'ad-sec' }, t('ad.directory')),
  field(t('ad.baseDn'), baseDn, t('ad.baseDnHint')),
  h('div', { class: 'form-grid' },
    field(t('ad.bindDn'), input('bindDn', c.bindDn, { class: 'mono', autocomplete: 'off', placeholder: 'svc-womn@firma.local' }), t('ad.bindDnHint')),
    field(t('ad.bindPassword'), input('bindPassword', '', { type: 'password', autocomplete: 'new-password', placeholder: c.bindPassword.set ? '••••••' : '' }), c.bindPassword.set ? t('set.smtpPasswordSet') : null)),

  h('h3', { class: 'ad-sec' }, t('ad.groups')),
  h('p', { class: 'muted small', style: { marginTop: 0 } }, t('ad.groupsHint')),
  h('div', { class: 'ad-grid-3' },
    field(t('role.admin'), input('groupAdmin', c.groupAdmin, { class: 'mono', placeholder: 'WOMN-Admins' })),
    field(t('role.editor'), input('groupEditor', c.groupEditor, { class: 'mono', placeholder: 'WOMN-Bearbeiter' })),
    field(t('role.viewer'), input('groupViewer', c.groupViewer, { class: 'mono', placeholder: 'WOMN-Lesen' }))),
  field(t('ad.nested'), h('input', { type: 'checkbox', name: 'nested', checked: c.nested })),
  h('details', { class: 'cert-manual' }, h('summary', {}, t('ad.advanced')),
    field(t('ad.filter'), input('userFilter', c.userFilter, { class: 'mono', placeholder: c.defaultFilter }), t('ad.filterHint'))),
  saveBtn());

  // Test with the values in the form (also before saving): every step with ✓ or ✗ and what to do
  const out = h('div', { class: 'ad-steps' });
  const tu = input('username', '', { autocomplete: 'off', placeholder: 'max.mustermann' });
  const tp = input('password', '', { type: 'password', autocomplete: 'off' });
  const stepText = (st) => {
    if (st.key === 'connect') return st.ok ? t('adt.connect', { security: st.security }) : t('adt.connectFail');
    if (st.key === 'bind') return st.ok ? t('adt.bind', { value: st.value }) : st.error === 'noBind' ? t('adt.noBind') : t('adt.bindFail');
    if (st.key === 'baseDn') return st.ok ? t(st.auto ? 'adt.baseDnAuto' : 'adt.baseDn', { value: st.value }) : t('adt.noBase');
    if (st.key === 'group') return st.error === 'noGroups' ? t('adt.noGroups') : st.ok ? t('adt.group', { role: t(`role.${st.role}`), value: st.value }) : t('adt.groupNotFound', { role: t(`role.${st.role}`), value: st.value });
    if (st.key === 'user') return st.ok ? t('adt.user', { value: st.value, name: st.display_name || st.value }) : t(`adt.${st.error === 'disabled' ? 'userDisabled' : st.error === 'ambiguous' ? 'userAmbiguous' : 'userNotFound'}`, { value: st.value });
    if (st.key === 'role') return st.ok ? t('adt.role', { role: t(`role.${st.role}`) }) : t('adt.noRole');
    if (st.key === 'password') return st.ok ? t('adt.password') : t('adt.passwordFail');
    return st.key;
  };
  const test = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const b = test.querySelector('button[type=submit]'); b.disabled = true;
    try {
      const r = await post('/settings/ad/test', { settings: values(), username: tu.value, password: tp.value });
      if (r.baseDn && !baseDn.value) { baseDn.value = r.baseDn; }
      mount(out, h('ul', {}, r.steps.map((st) => h('li', { class: st.ok ? 'ok' : st.error === 'noBind' ? 'warn' : 'bad' },
        h('span', { class: 'ad-mark', 'aria-hidden': 'true' }, st.ok ? '✓' : st.error === 'noBind' ? '!' : '✗'),
        h('div', {}, h('div', {}, stepText(st)),
          !st.ok && st.error && !['noBind', 'noGroups', 'noRole', 'groupNotFound', 'userNotFound', 'disabled', 'ambiguous', 'noBase'].includes(st.error)
            ? h('div', { class: 'muted small' }, t(`adt.err.${st.error}`), st.detail ? h('span', { class: 'mono' }, ` (${st.detail})`) : null) : null,
          st.key === 'group' && st.dn ? h('div', { class: 'muted small mono' }, st.dn) : null,
          st.key === 'user' && st.ok ? h('div', { class: 'muted small' }, [st.email, st.dn].filter(Boolean).join(' · ')) : null,
          st.key === 'baseDn' && st.auto && r.baseDn ? h('div', { class: 'muted small' }, t('adt.baseDnSave')) : null)))),
      r.ok ? h('p', { class: 'ad-result ok' }, t('adt.allOk')) : null);
    } catch (ex) { mount(out); fail(ex); }
    b.disabled = false;
  } },
  h('p', { class: 'muted', style: { marginTop: 0 } }, t('ad.testLead')),
  h('div', { class: 'form-grid' }, field(t('ad.testUser'), tu, t('ad.testUserHint')), field(t('ad.testPassword'), tp, t('ad.testPasswordHint'))),
  h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, t('ad.test'))), out);
  mount(body, panel(t('set.ad'), form), panel(t('ad.test'), test));
}

// ---------- TLS certificate of the domain controller ----------
const shortFp = (fp) => `${String(fp).split(':').slice(0, 8).join(':')}…`;
// 32 bytes in two lines of 16 - easier to compare than one wrapped line
const fpLines = (fp) => { const p = String(fp).split(':'); return [p.slice(0, 16).join(':'), p.slice(16).join(':')].filter(Boolean).map((x) => h('div', {}, x)); };
const certDate = (iso) => fmtDate(iso, getLang(), false);

function certRow(c, { full = false } = {}) {
  return h('div', { class: 'cert-row' },
    h('span', { class: 'cert-role' }, t(`adc.role.${c.role}`)),
    h('div', { class: 'cert-main' },
      h('div', { class: 'cert-cn', title: c.subject }, h('span', { class: 'mono' }, c.cn), c.org ? h('span', { class: 'muted' }, ` · ${c.org}`) : null,
        c.source === 'aia' ? h('span', { class: 'badge badge-ti' }, t('adc.fromAia')) : null,
        c.expired ? h('span', { class: 'badge badge-bad' }, t('adc.expired')) : null),
      h('div', { class: 'muted small' }, t('adc.validTo', { date: certDate(c.validTo) }), c.role !== 'root' ? ` · ${t('adc.issuer', { name: c.issuer })}` : ''),
      full ? null : h('div', { class: 'muted small mono cert-fp-short', title: c.fingerprint256 }, `SHA-256 ${shortFp(c.fingerprint256)}`),
      full ? h('dl', { class: 'kv cert-fp' },
        h('dt', {}, 'SHA-256'), h('dd', { class: 'mono' }, fpLines(c.fingerprint256)),
        h('dt', {}, 'SHA-1'), h('dd', { class: 'mono' }, c.fingerprint),
        c.names.length ? [h('dt', {}, t('adc.names')), h('dd', { class: 'mono' }, c.names.join(', '))] : null) : null));
}

function adCertBlock(cert, formValues, reload) {
  const n = cert.certs.length;
  const out = h('div', { class: 'cert-block' });
  const form = () => {
    const d = formValues();
    const v = { host: d.host, security: d.security, port: d.port, bindDn: d.bindDn, trust: d.trust, verifyHostname: d.verifyHostname };
    if (d.bindPassword) v.bindPassword = d.bindPassword;
    return v;
  };
  const afterSave = (r) => {
    if (r.added) toast(t('adc.savedAd', { n: r.added }));
    else if (!r.complete) toast(t('adc.savedNoRoot'));
    else toast(t('adc.saved'));
    reload();
  };
  const confirmFetched = (r) => {
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, t('adc.trust'));
    const m = modal(t('adc.checkTitle'), h('div', {},
      h('p', { style: { marginTop: 0 } }, t('adc.checkLead')),
      r.nameOk ? null : h('div', { class: 'note warn' }, t('adc.nameMismatch', { host: r.host, names: r.certs[0].names.join(', ') || r.certs[0].cn })),
      h('div', { class: 'cert-list' }, r.certs.map((c) => certRow(c, { full: true }))),
      h('div', { class: `note${r.complete ? '' : ' warn'}`, style: { marginTop: '14px', marginBottom: 0 } }, r.complete ? t('adc.complete') : t('adc.incomplete')),
      r.aiaTried.some((x) => x.error) ? h('p', { class: 'muted small' }, t('adc.aiaFailed'), ' ', r.aiaTried.filter((x) => x.error).map((x) => h('span', { class: 'mono' }, `${x.url} (${x.error}) `))) : null),
    { wide: true, onSubmit: async () => {
      try { const res = await put('/settings/ad/cert', { ...form(), pem: r.pem }); m.close(); afterSave(res); } catch (ex) { fail(ex); }
    }, actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('cancel')), save] });
  };
  const fetchBtn = h('button', { class: 'btn', type: 'button', html: `${icon('download')}<span>${t('adc.fetch')}</span>`, onclick: async () => {
    fetchBtn.disabled = true;
    try { confirmFetched(await post('/settings/ad/cert/fetch', form())); } catch (ex) { fail(ex); }
    fetchBtn.disabled = false;
  } });
  const removeBtn = n ? h('button', { class: 'btn btn-danger', type: 'button', html: `${icon('trash')}<span>${t('adc.remove')}</span>`, onclick: async () => {
    if (!await confirmDialog(t('adc.remove'), t('adc.removeConfirm'), t('adc.remove'), t('cancel'), { danger: true })) return;
    try { await del('/settings/ad/cert'); toast(t('adc.removed')); reload(); } catch (ex) { fail(ex); }
  } }) : null;
  const pem = h('textarea', { rows: 5, class: 'mono', placeholder: '-----BEGIN CERTIFICATE-----', spellcheck: 'false', 'aria-label': t('adc.manual') });
  const manual = h('details', { class: 'cert-manual' }, h('summary', {}, t('adc.manual')),
    h('p', { class: 'muted small' }, t('adc.manualHint')), pem,
    h('div', { class: 'actions', style: { marginTop: '8px' } }, h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
      try { afterSave(await put('/settings/ad/cert', { ...form(), pem: pem.value })); } catch (ex) { fail(ex); }
    } }, t('adc.manualSave'))));
  mount(out,
    h('div', { class: 'cert-head' }, h('h3', {}, t('adc.title')),
      n ? h('span', { class: 'badge badge-ok', html: `${icon('lock')}<span>${t(n === 1 ? 'adc.count1' : 'adc.countN', { n })}</span>` })
        : h('span', { class: 'badge badge-new' }, t('adc.none'))),
    h('p', { class: 'muted small', style: { marginTop: 0 } }, t('adc.lead')),
    n ? h('div', { class: 'cert-list' }, cert.certs.map((c) => certRow(c))) : null,
    n && !cert.complete ? h('p', { class: 'muted small' }, t('adc.noRoot')) : null,
    h('div', { class: 'actions' }, fetchBtn, removeBtn),
    manual);
  return out;
}

async function ignored(body, _s, reload) {
  const list = await get('/ignored');
  mount(body, panel(t('set.ignored'), h('p', { class: 'muted' }, t('ign.lead')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('col.mac')), h('th', {}, t('col.ip')), h('th', {}, t('col.name')), h('th', {}))),
      h('tbody', {}, list.map((x) => h('tr', {},
        h('td', { class: 'mono' }, x.mac || '–'), h('td', { class: 'mono' }, x.ip || '–'), h('td', {}, x.label || '–'),
        h('td', { class: 'min' }, btn(t('ign.remove'), { class: 'btn btn-sm', onclick: async () => {
          try { await del(`/ignored/${x.id}`); reload(); } catch (ex) { fail(ex); }
        } }))))))) : h('p', { class: 'muted' }, t('ign.empty'))));
}

async function audit(body) {
  const list = await get('/audit');
  mount(body, panel(t('set.audit'), list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('tbody', {}, list.map((a) => h('tr', {},
      h('td', { class: 'min muted small' }, fmtDate(a.at, getLang())), h('td', { class: 'min' }, a.user || '–'),
      h('td', { class: 'mono small' }, a.action), h('td', { class: 'small' }, a.detail)))))) : h('p', { class: 'muted' }, t('audit.empty'))));
}

async function about(body) {
  mount(body, panel(t('set.about'), aboutContent()));
}

// Notification services: grouped for the picker, with the fields each one needs
const CH_GROUPS = [
  ['common', 'mail', ['email', 'telegram', 'webhook']],
  ['chat', 'chat', ['discord', 'slack', 'teams', 'googlechat', 'mattermost', 'rocketchat', 'matrix', 'signal', 'whatsapp']],
  ['push', 'mobile', ['ntfy', 'gotify', 'pushover', 'pushbullet', 'homeassistant']],
  ['bridge', 'link', ['apprise']],
];
const CH_FIELDS = {
  discord: [['url', { secret: true, ph: 'https://discord.com/api/webhooks/…' }]],
  slack: [['url', { secret: true, ph: 'https://hooks.slack.com/services/…' }]],
  teams: [['url', { secret: true, ph: 'https://…/workflows/…' }]],
  googlechat: [['url', { secret: true, ph: 'https://chat.googleapis.com/v1/spaces/…' }]],
  mattermost: [['url', { secret: true, ph: 'https://chat.firma.local/hooks/…' }]],
  rocketchat: [['url', { secret: true, ph: 'https://chat.firma.local/hooks/…' }]],
  matrix: [['server', { ph: 'https://matrix.org' }], ['room', { ph: '!abc123:matrix.org' }], ['token', { secret: true }]],
  signal: [['server', { ph: 'http://signal-api:8080' }], ['number', { ph: '+4917612345678' }], ['recipients', { ph: '+4915112345678, group.…' }]],
  whatsapp: [['phone', { ph: '+4917612345678' }], ['apikey', { secret: true }]],
  ntfy: [['server', { ph: 'https://ntfy.sh' }], ['topic', { ph: 'womn-buero-7f3k' }], ['token', { secret: true, optional: true }]],
  gotify: [['server', { ph: 'https://gotify.firma.local' }], ['token', { secret: true }]],
  pushover: [['user', {}], ['token', { secret: true }]],
  pushbullet: [['token', { secret: true }]],
  homeassistant: [['server', { ph: 'http://homeassistant.local:8123' }], ['service', { ph: 'mobile_app_michaels_iphone' }], ['token', { secret: true }]],
  apprise: [['url', { ph: 'http://apprise:8000/notify/womn' }], ['urls', { secret: true, optional: true, ph: 'tgram://…, mailto://…' }]],
};
/** Label of a field: a service-specific one if there is one ("App-Token" for Gotify), otherwise the general one */
const chLabel = (type, k) => { const key = `ch.f.${type}.${k}`; const s = t(key); return s === key ? t(`ch.f.${k}`) : s; };

/** Step 1 of a new channel: choose the service */
function pickChannel(edit) {
  const dlg = modal(t('ch.add'), h('div', {},
    CH_GROUPS.map(([g, ico, types]) => h('div', { class: 'ch-group' },
      h('h3', { class: 'sub-title' }, t(`ch.group.${g}`)),
      h('div', { class: 'pick-grid' }, types.map((ty) => h('button', { type: 'button', class: 'pick', onclick: () => { dlg.close(); edit(null, ty); } },
        h('span', { class: 'pick-ico', html: icon(ty === 'email' ? 'mail' : ty === 'webhook' ? 'link' : ico) }),
        h('span', { class: 'pick-title' }, t(`ch.type.${ty}`)),
        h('span', { class: 'pick-text' }, t(`ch.what.${ty}`)))))))), { wide: true });
}

async function notify(body, s, reload) {
  const list = await get('/channels');
  const edit = (c, type) => {
    const ty = c ? c.type : type;
    const cfg = c?.config || {};
    const fields = {
      email: [field(t('ch.to'), input('to', cfg.to || '', { required: true, placeholder: 'it@firma.local' }), t('ch.toHint'))],
      telegram: [
        field(t('ch.token'), input('token', '', { type: 'password', autocomplete: 'off', required: !cfg.token?.set, placeholder: cfg.token?.set ? '••••••' : '123456789:ABC…' }), cfg.token?.set ? t('ch.tokenSet') : t('ch.tokenHint')),
        field(t('ch.chatId'), input('chatId', cfg.chatId || '', { required: true, class: 'mono' }), t('ch.chatIdHint')),
        field(t('ch.threadId'), input('threadId', cfg.threadId || '', { class: 'mono' })),
      ],
      webhook: [
        field(t('ch.url'), input('url', cfg.url || '', { required: true, class: 'mono', placeholder: 'https://…' })),
        field(t('ch.template'), h('textarea', { name: 'template', class: 'mono', rows: 4, placeholder: '{"text": "{{text}}"}' }, cfg.template || ''), t('ch.templateHint')),
        h('div', { class: 'form-grid' },
          field(t('ch.headerName'), input('headerName', cfg.headerName || '', { class: 'mono', placeholder: 'Authorization' })),
          field(t('ch.headerValue'), input('headerValue', '', { type: 'password', autocomplete: 'off', placeholder: cfg.headerValue?.set ? '••••••' : '' }), cfg.headerValue?.set ? t('ch.headerSet') : null)),
      ],
    }[ty] || (CH_FIELDS[ty] || []).map(([k, f]) => {
      const set = f.secret && cfg[k]?.set;
      const el = input(k, f.secret ? '' : (cfg[k] || ''), { class: 'mono', autocomplete: 'off', placeholder: set ? '••••••' : (f.ph || ''),
        ...(f.secret ? { type: 'password' } : {}), required: !f.optional && !set });
      return field(chLabel(ty, k), el, set ? t('ch.secretSet') : f.secret ? t('ch.secretHint') : null);
    });
    const help = t(`ch.help.${ty}`) !== `ch.help.${ty}` ? h('div', { class: 'note' }, h('div', {}, rich(t(`ch.help.${ty}`)))) : null;
    const form = h('form', { class: 'form' },
      help,
      field(t('ch.name'), input('name', c?.name || t(`ch.type.${ty}`), { required: true, maxlength: 80 })),
      fields,
      field(t('ch.language'), select('language', [['de', 'Deutsch'], ['en', 'English']], c?.language || getLang())),
      field(t('ch.default'), h('input', { type: 'checkbox', name: 'is_default', checked: c ? c.is_default : true }), t('ch.defaultHint')),
      field(t('user.active'), h('input', { type: 'checkbox', name: 'enabled', checked: c ? c.enabled : true })));
    const dlg = modal(c ? c.name : `${t('ch.add')}: ${t(`ch.type.${ty}`)}`, form, { wide: true, onSubmit: async () => {
      const d = formData(form);
      const { name, language, is_default: isDefault, enabled, ...config } = d;
      try {
        const payload = { name, language, is_default: isDefault, enabled, type: ty, config };
        if (c) await put(`/channels/${c.id}`, payload); else await post('/channels', payload);
        dlg.close(); toast(t('saved')); reload();
      } catch (ex) { fail(ex); }
    }, actions: [
      btn(t('cancel'), { onclick: () => dlg.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))] });
  };
  const chooser = h('div', { class: 'actions' }, btn(t('ch.add'), { class: 'btn btn-primary', onclick: () => pickChannel(edit) }, 'plus'));
  mount(body, h('section', { class: 'panel' },
    h('div', { class: 'panel-head', style: { paddingBottom: '12px', flexWrap: 'wrap' } }, h('h2', {}, t('set.notify')), chooser),
    h('p', { class: 'muted', style: { padding: '0 20px' } }, t('ch.lead')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('ch.name')), h('th', {}, t('ch.type')), h('th', { class: 'hide-sm' }, ''), h('th', {}))),
      h('tbody', {}, list.map((c) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, c.name), c.enabled ? null : h('span', { class: 'badge', style: { marginLeft: '6px' } }, t('user.inactive'))),
        h('td', {}, t(`ch.type.${c.type}`)),
        h('td', { class: 'hide-sm' }, c.is_default ? h('span', { class: 'badge badge-ok' }, t('ch.default')) : null),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          btn(t('ch.test'), { class: 'btn btn-sm', onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true;
            try { await post(`/channels/${c.id}/test`); toast(t('ch.testSent')); } catch (ex) { fail(ex); }
            b.disabled = false;
          } }, 'mail'),
          btn(t('edit'), { class: 'btn btn-sm btn-ghost', onclick: () => edit(c) }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${c.name}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('ch.deleteConfirm', { name: c.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/channels/${c.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
          } }))))))))
      : h('p', { class: 'panel-pad muted', style: { margin: 0 } }, t('ch.empty'))),
    list.length ? escalationPanel(list, s?.escalate || { min: 0, channels: [] }) : null,
    autoWatchPanel(s?.autowatch || { enabled: true }));
}

/** New devices and hosts: a first monitor and a few sensors by themselves (on by default) */
function autoWatchPanel(a) {
  const box = h('input', { type: 'checkbox', name: 'enabled', checked: a.enabled !== false, onchange: async (e) => {
    try { await put('/settings/autowatch', { enabled: e.target.checked }); toast(t('saved')); } catch (ex) { e.target.checked = !e.target.checked; fail(ex); }
  } });
  return h('section', { class: 'panel panel-pad', style: { marginTop: '16px' } }, h('h2', { class: 'section-title' }, t('aw.title')),
    h('p', { class: 'muted', style: { marginTop: 0 } }, t('aw.lead')),
    field(t('aw.enabled'), box, t('aw.hint')));
}

/** Escalation for all monitors: an outage not solved after X minutes also goes to these channels */
function escalationPanel(chans, e) {
  const picker = channelPicker(chans, e.channels, { hint: 'esc.channelsHint' });
  const steps = [15, 30, 60, 120, 240, 480];
  const minSel = select('min', [['0', t('mon.f.escOff')], ...[...new Set([...steps, ...(e.min ? [e.min] : [])])].sort((a, b) => a - b).map((n) => [String(n), t('mon.f.escAfter', { n })])], String(e.min || 0));
  const form = h('form', { class: 'form', onsubmit: async (ev) => {
    ev.preventDefault();
    const ids = picker.value();
    if (Number(minSel.value) > 0 && !ids.length) { toast(t('esc.needChannel'), 'error'); return; }
    try { await put('/settings/escalate', { min: minSel.value, channels: ids }); state.meta.escalateMin = Number(minSel.value); toast(t('saved')); } catch (ex) { fail(ex); }
  } },
  h('p', { class: 'muted', style: { margin: 0 } }, t('esc.lead')),
  field(t('esc.when'), minSel),
  picker.el,
  h('p', { class: 'muted small', style: { margin: 0 } }, t('esc.perMonitor')),
  saveBtn());
  return h('section', { class: 'panel panel-pad', style: { marginTop: '16px' } }, h('h2', { class: 'section-title' }, t('esc.title')), form);
}
