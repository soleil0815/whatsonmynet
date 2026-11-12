// Administration: general, scan, email, HTTPS certificate, users, ignored devices, log, about.
import { h, mount, toast, modal, confirmDialog, fmtDate } from '../dom.js';
import { get, put, post, patch, del, api } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { pageHead, field, input, select, formData, btn, channelPicker } from './common.js';
import { openMonitorForm } from './monitoring.js';

const SECTIONS = [
  ['general', 'settings'], ['scan', 'radar'], ['printers', 'printer'], ['snmpdev', 'switch'], ['docker', 'server'], ['proxmox', 'hypervisor'], ['reports', 'inventory'], ['smtp', 'mail'], ['notify', 'bell'], ['https', 'lock'], ['users', 'users'], ['ad', 'user'], ['agents', 'location'],
  ['backup', 'download'], ['ignored', 'eyeoff'], ['audit', 'history'], ['about', 'shield'],
];

export async function renderSettings(main, section = 'general') {
  if (!state.user.isAdmin) { navigate('/', { replace: true }); return; }
  if (!SECTIONS.some(([s]) => s === section)) section = 'general';
  const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' },
    pageHead(t('set.title'), null),
    h('div', { class: 'settings' },
      h('nav', { class: 'subnav', 'aria-label': t('set.title') }, SECTIONS.map(([s, ico]) => h('a', { href: `/settings/${s}`, 'data-link': true,
        class: s === section ? 'active' : '', 'aria-current': s === section ? 'page' : null }, h('span', { html: icon(ico) }), t(`set.${s}`)))),
      body)));
  const all = ['general', 'scan', 'smtp', 'printers', 'snmpdev'].includes(section) ? await get('/settings') : null;
  const view = { general, scan, printers, snmpdev, docker, ad, agents, reports, proxmox, backup, smtp, notify, https, users, ignored, audit, about }[section];
  await view(body, all, () => renderSettings(main, section));
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
      e.currentTarget.disabled = true;
      try { const r = await post('/lightscan/run', {}); navigate(`/scan/${r.id}`); } catch (ex) { fail(ex); e.currentTarget.disabled = false; }
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
      - "2375:2375"   # only reachable from your LAN – better bind it to one address`;

async function docker(body, _s, reload) {
  const list = await get('/docker/hosts');
  const edit = (x) => {
    const form = h('form', { class: 'form' },
      field(t('dock.name'), input('name', x?.name || '', { required: true, maxlength: 80, placeholder: 'docker01' })),
      field(t('dock.url'), input('url', x?.url || '', { required: true, class: 'mono', placeholder: 'http://10.0.0.5:2375' }), t('dock.urlHint')));
    const dlg = modal(x ? x.name : t('dock.add'), form, { wide: true, actions: [
      btn(t('cancel'), { onclick: () => dlg.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        if (!form.reportValidity()) return;
        try {
          if (x) await put(`/docker/hosts/${x.id}`, formData(form)); else await post('/docker/hosts', formData(form));
          dlg.close(); toast(t('saved')); reload();
        } catch (ex) { fail(ex); }
      } }, t('save'))] });
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
    field(t('set.smtpHost'), input('host', m.host, { placeholder: 'mail.firma.de' })),
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
  const roleSel = (v) => select('role', ['admin', 'editor', 'viewer'].map((r) => [r, `${t(`role.${r}`)} – ${t(`role.${r}.hint`)}`]), v);
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
    const m = modal(u ? u.username : t('users.add'), form, { actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        if (!form.reportValidity()) return;
        const d = formData(form);
        for (const k of Object.keys(d)) if (k.startsWith('loc_')) delete d[k];
        d.locations = locs.filter((l) => form.querySelector(`[name=loc_${l.id}]`)?.checked).map((l) => l.id);
        try { if (u) await patch(`/users/${u.id}`, d); else await post('/users', d); m.close(); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
      } }, t('save'))] });
  };
  const setPw = (u) => {
    const pw = input('password', '', { type: 'password', minlength: 10, required: true, autocomplete: 'new-password' });
    const m = modal(`${t('users.resetPassword')}: ${u.username}`, h('form', { class: 'form' }, field(t('users.newPassword'), pw, t('user.passwordHint'))), { actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        try { await post(`/users/${u.id}/password`, { password: pw.value }); m.close(); toast(t('saved')); } catch (ex) { fail(ex); }
      } }, t('save'))] });
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

function proxmoxDetail(x) {
  const d = x.data || {};
  if (!x.last_at) return h('p', { class: 'muted' }, t('prn.none'));
  const sensor = () => openMonitorForm(null, () => {}, { type: 'proxmox', name: `${x.name} – Sensor`, interval_s: 300, fail_threshold: 1, options: { host: x.id } });
  const head = h('div', { class: 'actions', style: { marginBottom: '10px' } },
    !x.last_ok ? h('span', { class: 'note warn', style: { margin: 0 } }, x.last_error) : h('span', { class: 'muted small' }, `${t('prn.checked')}: ${fmtDate(x.last_at, getLang())}`),
    btn(t('sens.add'), { class: 'btn btn-sm', onclick: sensor }, 'plus'));
  if (d.kind === 'pve') {
    const running = (d.guests || []).filter((g) => g.status === 'running').length;
    return h('div', {}, head,
      h('h3', { class: 'sub-title' }, t('px.nodes')),
      h('ul', { class: 'port-macs' }, (d.nodes || []).map((n) => h('li', {}, h('strong', {}, n.name),
        h('span', { class: `badge ${n.online ? 'badge-ok' : 'badge-bad'}` }, n.online ? 'online' : 'offline'),
        n.online ? h('span', { class: 'muted small mono' }, `CPU ${n.cpu} % · RAM ${n.mem} %`) : null))),
      h('h3', { class: 'sub-title' }, t('px.storages')),
      h('div', { class: 'supplies' }, (d.storages || []).filter((s) => s.total).map((s) => meter(`${s.name} · ${s.node}`, s.pct, `${bytes(s.used)} / ${bytes(s.total)} · `))),
      h('h3', { class: 'sub-title' }, t('px.guests', { running, n: (d.guests || []).length })),
      h('div', { class: 'chips' }, (d.guests || []).map((g) => h('span', { class: `badge ${g.status === 'running' ? 'badge-ok' : ''}`, title: `${g.kind} · ${g.node} · ${g.status}` }, `${g.vmid} ${g.name}`))),
      h('h3', { class: 'sub-title' }, t('px.backups')),
      (d.backups || []).length ? h('ul', { class: 'port-macs' }, d.backups.slice(0, 8).map((b) => h('li', {},
        h('span', { class: `badge ${b.ok ? 'badge-ok' : b.end ? 'badge-bad' : ''}` }, b.ok ? 'OK' : b.status), h('span', { class: 'mono small' }, b.vmid ? `VM ${b.vmid}` : t('px.allGuests')),
        h('span', { class: 'muted small' }, `${b.node} · ${fmtDate(new Date(b.start * 1000).toISOString(), getLang())}`)))) : h('p', { class: 'muted small' }, t('px.noBackups')));
  }
  return h('div', {}, head,
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

async function proxmox(body, _s, reload) {
  const list = await get('/proxmox');
  const edit = (x) => {
    const kind = select('kind', [['pve', 'Proxmox VE'], ['pbs', 'Proxmox Backup Server']], x?.kind || 'pve');
    const url = input('url', x?.url || '', { required: true, class: 'mono', placeholder: 'https://pve01.firma.local:8006' });
    kind.addEventListener('change', () => { url.placeholder = kind.value === 'pbs' ? 'https://pbs01.firma.local:8007' : 'https://pve01.firma.local:8006'; });
    const form = h('form', { class: 'form' },
      h('div', { class: 'form-grid' },
        field(t('px.name'), input('name', x?.name || '', { required: true, maxlength: 80, placeholder: 'pve01' })),
        field(t('px.kind'), kind)),
      field(t('px.url'), url),
      h('div', { class: 'form-grid' },
        field(t('px.tokenId'), input('token_id', x?.token_id || '', { required: true, class: 'mono', autocomplete: 'off', placeholder: 'monitor@pve!womn' })),
        field(t('px.secret'), input('secret', '', { type: 'password', autocomplete: 'new-password', required: !x?.has_secret, placeholder: x?.has_secret ? '••••••' : '' }), x?.has_secret ? t('set.smtpPasswordSet') : null)),
      h('p', { class: 'muted small', style: { margin: 0 } }, t('px.tokenHint')),
      field(t('px.ca'), h('textarea', { name: 'ca', rows: 3, class: 'mono', placeholder: '-----BEGIN CERTIFICATE-----', spellcheck: 'false' }, x?.ca || ''), t('px.caHint')),
      field(t('px.verify'), h('input', { type: 'checkbox', name: 'verify', checked: x ? x.verify : true }), t('px.verifyHint')));
    const m = modal(x ? x.name : t('px.add'), form, { wide: true, actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async (e) => {
        if (!form.reportValidity()) return;
        e.currentTarget.disabled = true;
        const d = formData(form);
        if (!d.secret) delete d.secret;
        try { const r = x ? await put(`/proxmox/${x.id}`, d) : await post('/proxmox', d); m.close(); toast(r.last_ok ? t('px.connected') : r.last_error, r.last_ok ? undefined : 'error'); reload(); } catch (ex) { fail(ex); e.currentTarget.disabled = false; }
      } }, t('save'))] });
  };
  mount(body, h('section', { class: 'panel' },
    h('div', { class: 'panel-head', style: { paddingBottom: '12px', flexWrap: 'wrap' } }, h('h2', {}, 'Proxmox'), btn(t('px.add'), { class: 'btn btn-sm', onclick: () => edit(null) }, 'plus')),
    h('p', { class: 'muted', style: { padding: '0 20px' } }, t('px.lead')),
    !list.length ? h('p', { class: 'panel-pad muted', style: { margin: 0 } }, t('px.none')) : null),
  list.map((x) => h('section', { class: 'panel panel-pad' },
    h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '6px' } },
      h('div', {}, h('h2', { class: 'section-title', style: { margin: 0 } }, x.name), h('div', { class: 'muted small mono' }, `${x.kind === 'pbs' ? 'Backup Server' : 'VE'} · ${x.url}`)),
      h('div', { class: 'actions' },
        btn(t('prn.refresh'), { class: 'btn btn-sm', onclick: async (e) => { e.currentTarget.disabled = true; try { await post(`/proxmox/${x.id}/poll`, {}); reload(); } catch (ex) { fail(ex); } } }, 'refresh'),
        btn(t('edit'), { class: 'btn btn-sm btn-ghost', onclick: () => edit(x) }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${x.name}`, html: icon('trash'), onclick: async () => {
          if (!await confirmDialog(t('delete'), t('px.deleteConfirm', { name: x.name }), t('delete'), t('cancel'), { danger: true })) return;
          try { await del(`/proxmox/${x.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
        } }))),
    proxmoxDetail(x))));
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
    const f = file.files[0];
    if (!f) { toast(t('bk.chooseFile'), 'error'); return; }
    if (!await confirmRestore(f.name)) return;
    const b = e.currentTarget; b.disabled = true;
    try { await api('/backups/restore', { method: 'POST', raw: f, headers: { 'X-WOMN-Confirm': 'restore' } }); waitForRestart(); } catch (ex) { fail(ex); b.disabled = false; }
  } }, 'history');
  mount(body,
    panel(t('bk.title'),
      h('p', { class: 'muted', style: { marginTop: 0 } }, t('bk.lead', { keep })),
      h('div', { class: 'actions' },
        h('a', { class: 'btn btn-primary', href: '/api/backups/download', download: '' }, h('span', { html: icon('download') }), t('bk.download')),
        btn(t('bk.createNow'), { onclick: async (e) => { e.currentTarget.disabled = true; try { await post('/backups'); toast(t('saved')); reload(); } catch (ex) { fail(ex); } } }, 'plus')),
      h('p', { class: 'note warn', style: { marginBottom: 0 } }, t('bk.keyHint'))),
    panel(t('bk.stored'), list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('bk.file')), h('th', {}, t('bk.when')), h('th', { class: 'hide-sm' }, t('bk.size')), h('th', {}))),
      h('tbody', {}, list.map((x) => h('tr', {},
        h('td', { class: 'mono small', style: { wordBreak: 'break-all' } }, x.name, x.kind !== 'daily' ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, t(`bk.kind.${x.kind}`)) : null),
        h('td', { style: { whiteSpace: 'nowrap' } }, fmtDate(x.at, getLang())),
        h('td', { class: 'hide-sm mono small', style: { whiteSpace: 'nowrap' } }, size(x.size)),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          h('a', { class: 'btn btn-sm', href: `/api/backups/file/${encodeURIComponent(x.name)}`, download: '' }, t('bk.downloadShort')),
          btn(t('bk.restore'), { class: 'btn btn-sm btn-ghost', onclick: async () => {
            if (!await confirmRestore(x.name)) return;
            try { await api(`/backups/file/${encodeURIComponent(x.name)}/restore`, { method: 'POST', body: {}, headers: { 'X-WOMN-Confirm': 'restore' } }); waitForRestart(); } catch (ex) { fail(ex); }
          } })))))))) : h('p', { class: 'muted' }, t('bk.none'))),
    panel(t('bk.restoreUpload'), h('p', { class: 'muted', style: { marginTop: 0 } }, t('bk.restoreLead')), field(t('bk.file'), file), h('div', { class: 'actions' }, upload)));
}

async function reports(body, _s, reload) {
  const [list, locs] = await Promise.all([get('/reports'), get('/locations')]);
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
    const form = h('form', { class: 'form-grid' },
      h('div', { class: 'full' }, field(t('rep.name'), input('name', v.name, { required: true, maxlength: 100, placeholder: t('rep.namePh') }))),
      h('div', { class: 'full field' }, t('rep.sections'), h('div', { class: 'chips' }, SECS.map((x) => h('label', { class: 'check', style: { marginRight: '14px' } },
        h('input', { type: 'checkbox', name: `sec_${x}`, checked: v.sections.includes(x) }), t(`rep.sec.${x}`))))),
      h('div', { class: 'full' }, field(t('rep.recipients'), h('textarea', { name: 'recipients', rows: 2, required: true, placeholder: 'buero@firma.de, einkauf@firma.de' }, v.recipients.join(', ')), t('rep.recipientsHint'))),
      field(t('rep.freq'), freq), wd, md,
      field(t('rep.time'), input('time', v.schedule.time, { type: 'time', required: true })),
      locs.length > 1 ? h('div', { class: 'full field' }, t('rep.locations'), h('div', { class: 'chips' }, locs.map((l) => h('label', { class: 'check', style: { marginRight: '14px' } },
        h('input', { type: 'checkbox', name: `loc_${l.id}`, checked: v.location_ids.includes(l.id) }), l.name))), h('span', { class: 'hint' }, t('rep.locationsHint'))) : null,
      h('div', { class: 'full' }, h('h3', { class: 'sub-title' }, t('rep.mail')), h('p', { class: 'muted small', style: { margin: 0 } }, t('rep.neutral'))),
      field(t('rep.fromName'), input('from_name', v.from_name, { maxlength: 100, placeholder: t('rep.fromNamePh') }), t('rep.fromNameHint')),
      field(t('rep.subject'), input('subject', v.subject, { maxlength: 200, placeholder: t('rep.subjectPh') }), t('rep.subjectHint')),
      h('div', { class: 'full' }, field(t('rep.intro'), h('textarea', { name: 'intro', rows: 3 }, v.intro))),
      h('div', { class: 'full' }, field(t('rep.signature'), h('textarea', { name: 'signature', rows: 3 }, v.signature))),
      field(t('ch.language'), select('language', [['de', 'Deutsch'], ['en', 'English']], v.language)),
      h('div', {}, field(t('rep.onlyAttention'), h('input', { type: 'checkbox', name: 'only_attention', checked: v.only_attention }), t('rep.onlyAttentionHint'))),
      r ? field(t('user.active'), h('input', { type: 'checkbox', name: 'enabled', checked: v.enabled })) : null);
    syncFreq();
    const m = modal(r ? r.name : t('rep.add'), form, { wide: true, actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        if (!form.reportValidity()) return;
        const d = formData(form);
        const payload = { name: d.name, sections: SECS.filter((x) => d[`sec_${x}`]), recipients: d.recipients,
          schedule: { freq: d.freq, weekday: Number(d.weekday), day: Number(d.day), time: d.time }, location_ids: locs.filter((l) => d[`loc_${l.id}`]).map((l) => l.id),
          subject: d.subject, intro: d.intro, signature: d.signature, from_name: d.from_name, language: d.language, only_attention: d.only_attention, enabled: r ? d.enabled : true };
        try { if (r) await put(`/reports/${r.id}`, payload); else await post('/reports', payload); m.close(); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
      } }, t('save'))] });
  };
  const preview = (r) => {
    const frame = h('iframe', { src: `/api/reports/${r.id}/preview`, title: t('rep.preview'), class: 'report-frame', sandbox: '' });
    const m = modal(`${t('rep.preview')}: ${r.name}`, frame, { wide: true, actions: [btn(t('agent.done'), { class: 'btn btn-primary', onclick: () => m.close() })] });
  };
  const sendNow = async (r, test, b) => {
    b.disabled = true;
    try { const x = await post(`/reports/${r.id}/send`, { test }); toast(test ? t('rep.testSent', { email: state.user.email }) : t('rep.sent', { n: x.count })); reload(); } catch (ex) { fail(ex); }
    b.disabled = false;
  };
  mount(body, h('section', { class: 'panel' },
    h('div', { class: 'panel-head', style: { paddingBottom: '12px', flexWrap: 'wrap' } }, h('h2', {}, t('set.reports')), btn(t('rep.add'), { class: 'btn btn-sm', onclick: () => edit(null) }, 'plus')),
    h('p', { class: 'muted', style: { padding: '0 20px' } }, t('rep.lead')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('rep.name')), h('th', {}, t('rep.when')), h('th', { class: 'hide-sm' }, t('rep.recipients')), h('th', {}))),
      h('tbody', {}, list.map((r) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, r.name), r.enabled ? null : h('span', { class: 'badge', style: { marginLeft: '6px' } }, t('user.inactive')),
          h('div', { class: 'sub' }, r.sections.map((x) => t(`rep.sec.${x}`)).join(', '))),
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
      h('p', { class: 'muted small', style: { margin: 0 } }, t('agent.composeHint'))), { wide: true, actions: [
      btn(t('agent.copy'), { onclick: async () => { try { await navigator.clipboard.writeText(env); toast(t('agent.copied')); } catch { /* not allowed */ } } }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { m.close(); reload(); } }, t('agent.done'))] });
  };
  const edit = (a) => {
    const form = h('form', { class: 'form' },
      field(t('agent.name'), input('name', a?.name || '', { required: true, maxlength: 80, placeholder: 'Außenstelle Nord' })),
      field(t('agent.location'), select('location_id', locs.map((l) => [String(l.id), l.name]), a ? String(a.location_id) : String(locs[0]?.id || '')), t('agent.locationHint')),
      a ? field(t('user.active'), h('input', { type: 'checkbox', name: 'enabled', checked: !!a.enabled })) : null);
    const m = modal(a ? a.name : t('agent.add'), form, { actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        if (!form.reportValidity()) return;
        try {
          if (a) { await put(`/agents/${a.id}`, formData(form)); m.close(); toast(t('saved')); reload(); }
          else { const r = await post('/agents', formData(form)); m.close(); showToken(r); }
        } catch (ex) { fail(ex); }
      } }, t('save'))] });
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
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(form);
    const payload = { ...d, verify: d.verify, nested: d.nested };
    if (!d.bindPassword) delete payload.bindPassword;
    try { await put('/settings/ad', payload); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
  } },
  h('p', { class: 'muted' }, t('ad.lead')),
  field(t('ad.enabled'), h('input', { type: 'checkbox', name: 'enabled', checked: c.enabled })),
  h('div', { class: 'form-grid' },
    field(t('ad.url'), input('url', c.url, { class: 'mono', placeholder: 'ldaps://dc01.firma.local' }), t('ad.urlHint')),
    field(t('ad.baseDn'), input('baseDn', c.baseDn, { class: 'mono', placeholder: 'DC=firma,DC=local' })),
    field(t('ad.bindDn'), input('bindDn', c.bindDn, { class: 'mono', autocomplete: 'off', placeholder: 'svc-womn@firma.local' }), t('ad.bindDnHint')),
    field(t('ad.bindPassword'), input('bindPassword', '', { type: 'password', autocomplete: 'new-password', placeholder: c.bindPassword.set ? '••••••' : '' }), c.bindPassword.set ? t('set.smtpPasswordSet') : null)),
  field(t('ad.startTls'), h('input', { type: 'checkbox', name: 'startTls', checked: c.startTls }), t('ad.startTlsHint')),
  field(t('ad.verify'), h('input', { type: 'checkbox', name: 'verify', checked: c.verify }), t('ad.verifyHint')),
  field(t('ad.ca'), h('textarea', { name: 'ca', rows: 4, class: 'mono', placeholder: '-----BEGIN CERTIFICATE-----', spellcheck: 'false' }, c.ca || ''), t('ad.caHint')),
  h('h3', { class: 'sub-title' }, t('ad.groups')),
  h('p', { class: 'muted small', style: { marginTop: 0 } }, t('ad.groupsHint')),
  field(t('role.admin'), input('groupAdmin', c.groupAdmin, { class: 'mono', placeholder: 'CN=WOMN-Admins,OU=Gruppen,DC=firma,DC=local' })),
  field(t('role.editor'), input('groupEditor', c.groupEditor, { class: 'mono', placeholder: 'CN=WOMN-Bearbeiter,OU=Gruppen,DC=firma,DC=local' })),
  field(t('role.viewer'), input('groupViewer', c.groupViewer, { class: 'mono', placeholder: 'CN=WOMN-Lesen,OU=Gruppen,DC=firma,DC=local' })),
  field(t('ad.nested'), h('input', { type: 'checkbox', name: 'nested', checked: c.nested })),
  field(t('ad.filter'), input('userFilter', c.userFilter, { class: 'mono', placeholder: c.defaultFilter }), t('ad.filterHint')),
  saveBtn());

  const out = h('div');
  const tu = input('username', '', { autocomplete: 'off', placeholder: 'max.mustermann' });
  const tp = input('password', '', { type: 'password', autocomplete: 'off' });
  const test = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const b = test.querySelector('button[type=submit]'); b.disabled = true;
    try {
      const r = await post('/settings/ad/test', { username: tu.value, password: tp.value });
      mount(out, h('dl', { class: 'kv' },
        h('dt', {}, 'DN'), h('dd', { class: 'mono small' }, r.dn),
        h('dt', {}, t('user.display')), h('dd', {}, r.display_name || '–'),
        h('dt', {}, t('user.email')), h('dd', {}, r.email || '–'),
        h('dt', {}, t('user.role')), h('dd', {}, r.role ? h('span', { class: 'badge badge-ok' }, t(`role.${r.role}`)) : h('span', { class: 'badge badge-bad' }, t('ad.noRole'))),
        h('dt', {}, t('ad.password')), h('dd', {}, r.passwordChecked ? t('ad.passwordOk') : t('ad.passwordSkipped')),
        h('dt', {}, t('ad.foundGroups')), h('dd', { class: 'mono small' }, r.groups.length ? r.groups.map((g) => h('div', {}, g)) : '–')));
    } catch (ex) { mount(out); fail(ex); }
    b.disabled = false;
  } },
  h('p', { class: 'muted', style: { marginTop: 0 } }, t('ad.testLead')),
  h('div', { class: 'form-grid' }, field(t('user.username'), tu), field(t('ad.testPassword'), tp, t('ad.testPasswordHint'))),
  h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, t('ad.test'))), out);
  mount(body, panel(t('set.ad'), form), panel(t('ad.test'), test));
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
  mount(body, panel(t('set.about'),
    h('img', { src: document.documentElement.dataset.theme === 'dark' ? '/logo-dark.svg' : '/logo.svg', alt: 'WhatsOnMyNet', style: { height: '48px', marginBottom: '14px' } }),
    h('p', {}, t('about.text')),
    h('dl', { class: 'kv' },
      h('dt', {}, t('about.version')), h('dd', {}, state.boot.version),
      h('dt', {}, t('about.license')), h('dd', {}, 'AGPL-3.0-or-later'),
      h('dt', {}, t('about.source')), h('dd', {}, h('a', { href: state.boot.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, state.boot.sourceUrl)))));
}

async function notify(body, _s, reload) {
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
    }[ty];
    const form = h('form', { class: 'form' },
      field(t('ch.name'), input('name', c?.name || t(`ch.type.${ty}`), { required: true, maxlength: 80 })),
      fields,
      field(t('ch.language'), select('language', [['de', 'Deutsch'], ['en', 'English']], c?.language || getLang())),
      field(t('ch.default'), h('input', { type: 'checkbox', name: 'is_default', checked: c ? c.is_default : true }), t('ch.defaultHint')),
      field(t('user.active'), h('input', { type: 'checkbox', name: 'enabled', checked: c ? c.enabled : true })));
    const dlg = modal(c ? c.name : `${t('ch.add')}: ${t(`ch.type.${ty}`)}`, form, { wide: true, actions: [
      btn(t('cancel'), { onclick: () => dlg.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        if (!form.reportValidity()) return;
        const d = formData(form);
        const { name, language, is_default: isDefault, enabled, ...config } = d;
        try {
          const payload = { name, language, is_default: isDefault, enabled, type: ty, config };
          if (c) await put(`/channels/${c.id}`, payload); else await post('/channels', payload);
          dlg.close(); toast(t('saved')); reload();
        } catch (ex) { fail(ex); }
      } }, t('save'))] });
  };
  const chooser = h('div', { class: 'actions' }, ['email', 'telegram', 'webhook'].map((ty) =>
    btn(t(`ch.type.${ty}`), { class: 'btn btn-sm', onclick: () => edit(null, ty) }, 'plus')));
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
      : h('p', { class: 'panel-pad muted', style: { margin: 0 } }, t('ch.empty'))));
}
