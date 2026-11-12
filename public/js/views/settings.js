// Administration: general, scan, email, HTTPS certificate, users, ignored devices, log, about.
import { h, mount, toast, modal, confirmDialog, fmtDate } from '../dom.js';
import { get, put, post, patch, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { pageHead, field, input, select, formData, btn, channelPicker } from './common.js';

const SECTIONS = [
  ['general', 'settings'], ['scan', 'radar'], ['printers', 'printer'], ['snmpdev', 'switch'], ['docker', 'server'], ['smtp', 'mail'], ['notify', 'bell'], ['https', 'lock'], ['users', 'users'], ['ad', 'user'],
  ['ignored', 'eyeoff'], ['audit', 'history'], ['about', 'shield'],
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
  const view = { general, scan, printers, snmpdev, docker, ad, smtp, notify, https, users, ignored, audit, about }[section];
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
      state.boot.title = d.title;
      toast(t('saved'));
    } catch (ex) { fail(ex); }
  } },
  field(t('set.instance'), input('title', s.general.title, { maxlength: 60 })),
  field(t('set.backupKeep'), input('keep', s.backup.keep, { type: 'number', min: 1, max: 90 }), t('set.backupHint')),
  saveBtn());
  mount(body, panel(t('set.general'), form));
}

async function scan(body, s) {
  const sc = s.scan;
  const comm = h('textarea', { name: 'snmpCommunities', rows: 3, class: 'mono', placeholder: sc.snmpCommunities.set ? '••••••' : 'public', autocomplete: 'off', spellcheck: 'false' });
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(form);
    const payload = { ping: d.ping, snmp: d.snmp, httpTitles: d.httpTitles, rate: d.rate, keepScans: d.keepScans };
    if (d.snmpCommunities.trim() || d.clearCommunities) payload.snmpCommunities = d.clearCommunities ? '' : d.snmpCommunities;
    try { await put('/settings/scan', payload); toast(t('saved')); } catch (ex) { fail(ex); }
  } },
  field(t('set.ping'), h('input', { type: 'checkbox', name: 'ping', checked: sc.ping })),
  field(t('set.snmp'), h('input', { type: 'checkbox', name: 'snmp', checked: sc.snmp })),
  field(t('set.httpTitles'), h('input', { type: 'checkbox', name: 'httpTitles', checked: sc.httpTitles })),
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
  const list = await get('/users');
  const roleSel = (v) => select('role', ['admin', 'editor', 'viewer'].map((r) => [r, `${t(`role.${r}`)} – ${t(`role.${r}.hint`)}`]), v);
  const edit = (u) => {
    const fromAd = u?.source === 'ldap';
    const form = h('form', { class: 'form' },
      u ? null : field(t('user.username'), input('username', '', { required: true, autocomplete: 'off' })),
      fromAd ? h('p', { class: 'note' }, t('users.adManaged')) : null,
      fromAd ? null : field(t('user.display'), input('display_name', u?.display_name || '')),
      fromAd ? null : field(t('user.email'), input('email', u?.email || '', { type: 'email' })),
      fromAd ? null : field(t('user.role'), roleSel(u?.role || 'editor')),
      u ? field(t('user.active'), h('input', { type: 'checkbox', name: 'active', checked: !!u.active })) : field(t('user.password'), input('password', '', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), t('user.passwordHint')),
      field(t('language'), select('language', [['de', 'Deutsch'], ['en', 'English']], u?.language || getLang())));
    const m = modal(u ? u.username : t('users.add'), form, { actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        if (!form.reportValidity()) return;
        try { if (u) await patch(`/users/${u.id}`, formData(form)); else await post('/users', formData(form)); m.close(); toast(t('saved')); reload(); } catch (ex) { fail(ex); }
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
          u.display_name ? h('div', { class: 'sub' }, u.display_name) : null),
        h('td', {}, t(`role.${u.role}`), u.active ? null : h('span', { class: 'badge badge-bad', style: { marginLeft: '6px' } }, t('user.inactive'))),
        h('td', { class: 'hide-sm' }, u.email || '–'),
        h('td', { class: 'hide-sm' }, fmtDate(u.last_login, getLang())),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          btn(t('edit'), { class: 'btn btn-sm', onclick: () => edit(u) }),
          u.source === 'ldap' ? null : btn(t('users.resetPassword'), { class: 'btn btn-sm btn-ghost', onclick: () => setPw(u) }),
          u.id !== state.user.id ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${u.username}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('users.deleteConfirm', { name: u.username }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/users/${u.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
          } }) : null))))))),
    h('p', { class: 'panel-pad muted small', style: { margin: 0 } }, t('users.adHint'), ' ', h('a', { href: '/settings/ad', 'data-link': true }, t('set.ad')))));
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
