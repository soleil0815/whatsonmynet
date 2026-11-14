// Own account: profile, language, theme, password.
import { h, mount, toast, modal } from '../dom.js';
import { patch, post, get } from '../api.js';
import { t } from '../i18n.js';
import { state, setUser, render, fail } from '../app.js';
import { pageHead, field, input, select, formData, btn } from './common.js';

export async function renderAccount(main) {
  const u = state.user;
  const profile = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await patch('/me', formData(profile));
      setUser({ ...state.user, ...r });
      toast(t('saved'));
      render();
    } catch (ex) { fail(ex, profile); }
  } },
  field(t('user.username'), input('username_ro', u.username, { disabled: true })),
  field(t('user.display'), input('display_name', u.display_name, { maxlength: 120 })),
  field(t('user.email'), input('email', u.email, { type: 'email' })),
  field(t('language'), select('language', [['de', 'Deutsch'], ['en', 'English']], u.language)),
  field(t('theme'), select('theme', [['system', t('theme.system')], ['light', t('theme.light')], ['dark', t('theme.dark')]], u.theme)),
  h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, t('save'))));

  const pw = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(pw);
    if (d.password !== d.password2) { toast(t('user.passwordMismatch'), 'error'); return; }
    try {
      await post('/me/password', { current: d.current, password: d.password });
      pw.reset();
      toast(t('acc.changed'));
    } catch (ex) { fail(ex, pw); }
  } },
  field(t('acc.current'), input('current', '', { type: 'password', autocomplete: 'current-password', required: true })),
  field(t('acc.new'), input('password', '', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }), t('user.passwordHint')),
  field(t('user.passwordRepeat'), input('password2', '', { type: 'password', autocomplete: 'new-password', required: true })),
  h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, t('acc.password'))));

  const tf = await get('/me/2fa').catch(() => null);
  mount(main, h('div', { class: 'page' },
    pageHead(t('acc.title'), `${t(`role.${u.role}`)} - ${t(`role.${u.role}.hint`)}`),
    tf?.required && !tf.enabled ? h('div', { class: 'note warn' }, t('tf.requiredNote')) : null,
    h('div', { class: 'device-grid' },
      h('section', { class: 'panel panel-pad' }, h('h2', { class: 'section-title' }, t('acc.profile')), profile),
      h('div', { class: 'stack' },
        h('section', { class: 'panel panel-pad' }, h('h2', { class: 'section-title' }, t('acc.password')),
          u.source === 'ldap' ? h('p', { class: 'muted', style: { margin: 0 } }, t('acc.adPassword')) : pw),
        tf?.available ? twoFactorPanel(tf, () => renderAccount(main)) : null))));
}

/** Recovery codes: shown once, to copy or save as a text file */
function showCodes(codes) {
  const text = codes.join('\n');
  const m = modal(t('tf.codesTitle'), h('div', { class: 'form' },
    h('p', { class: 'note warn', style: { margin: 0 } }, t('tf.codesLead')),
    h('pre', { class: 'code' }, text)), { onSubmit: () => m.close(), actions: [
    btn(t('agent.copy'), { onclick: async () => { try { await navigator.clipboard.writeText(text); toast(t('agent.copied')); } catch { /* not allowed */ } } }),
    h('a', { class: 'btn', href: `data:text/plain;charset=utf-8,${encodeURIComponent(`${t('tf.codesTitle')}\n\n${text}\n`)}`, download: 'recovery-codes.txt' }, t('tf.save')),
    h('button', { class: 'btn btn-primary', type: 'submit' }, t('agent.done'))] });
}

function twoFactorPanel(tf, reload) {
  const box = h('section', { class: 'panel panel-pad' }, h('h2', { class: 'section-title' }, t('tf.title')));
  const recheckForm = (label, onDone, path) => {
    const f = h('form', { class: 'form' },
      field(t('acc.current'), input('password', '', { type: 'password', autocomplete: 'current-password', required: true })),
      field(t('login.code'), input('code', '', { inputmode: 'numeric', autocomplete: 'one-time-code', class: 'mono', required: true })));
    const m = modal(label, f, { onSubmit: async () => {
      try { const r = await post(path, formData(f)); m.close(); onDone(r); } catch (ex) { fail(ex); }
    }, actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit' }, label)] });
  };
  if (tf.enabled) {
    box.append(
      h('p', {}, h('span', { class: 'badge badge-ok' }, t('tf.on')), ' ', t('tf.left', { n: tf.recoveryLeft })),
      h('div', { class: 'actions' },
        btn(t('tf.newCodes'), { class: 'btn btn-sm', onclick: () => recheckForm(t('tf.newCodes'), (r) => { showCodes(r.recoveryCodes); reload(); }, '/me/2fa/recovery') }),
        tf.required ? null : btn(t('tf.disable'), { class: 'btn btn-sm btn-danger', onclick: () => recheckForm(t('tf.disable'), () => { toast(t('tf.disabled')); reload(); }, '/me/2fa/disable') })));
    return box;
  }
  const area = h('div');
  box.append(h('p', { class: 'muted', style: { marginTop: 0 } }, t('tf.lead')), area);
  mount(area, btn(t('tf.setup'), { class: 'btn btn-primary', onclick: async () => {
    try {
      const s = await post('/me/2fa/setup');
      const code = input('code', '', { inputmode: 'numeric', autocomplete: 'one-time-code', class: 'mono', required: true, maxlength: 6 });
      const f = h('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        try { const r = await post('/me/2fa/enable', { code: code.value }); showCodes(r.recoveryCodes); toast(t('tf.enabled')); reload(); } catch (ex) { fail(ex); code.select(); }
      } },
      h('ol', { class: 'tf-steps' }, h('li', {}, t('tf.step1')), h('li', {}, t('tf.step2')), h('li', {}, t('tf.step3'))),
      h('div', { class: 'tf-qr', html: s.svg, role: 'img', 'aria-label': t('tf.qr') }),
      h('p', { class: 'muted small' }, t('tf.manual'), ' ', h('code', { class: 'mono' }, s.secret.replace(/(.{4})/g, '$1 ').trim())),
      field(t('login.code'), code),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, t('tf.confirm'))));
      mount(area, f);
      code.focus();
    } catch (ex) { fail(ex); }
  } }, 'lock'));
  return box;
}
