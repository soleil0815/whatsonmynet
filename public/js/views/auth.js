// Initial setup and sign-in.
import { h, mount } from '../dom.js';
import { post } from '../api.js';
import { t, setLang, getLang } from '../i18n.js';
import { LOGO_MARK } from '../icons.js';
import { afterLogin, wordmark } from '../app.js';
import { field, input, formData } from './common.js';

function art() {
  return h('div', { class: 'auth-art' },
    wordmark(),
    h('span', { html: LOGO_MARK }),
    h('p', {}, getLang() === 'en'
      ? 'Find what is on your network, keep what matters.'
      : 'Finde, was in deinem Netz läuft. Behalte, was wichtig ist.'));
}

function langSwitch(rerender) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': t('language') },
    ['de', 'en'].map((l) => h('button', { type: 'button', class: getLang() === l ? 'on' : '', 'aria-pressed': getLang() === l ? 'true' : 'false', onclick: (e) => {
      // Switching the language draws the form again: keep what was already typed
      const old = e.currentTarget.closest('form');
      const kept = old ? [...old.querySelectorAll('input[name]')].map((x) => [x.name, x.value]) : [];
      setLang(l);
      rerender();
      const now = document.querySelector('.auth-form form');
      for (const [name, value] of kept) { const x = now?.querySelector(`input[name="${name}"]`); if (x) x.value = value; }
    } }, l.toUpperCase())));
}

export function renderSetup(root) {
  document.title = `${t('setup.title')} · WhatsOnMyNet`;
  const err = h('div', { class: 'error-box', hidden: true, role: 'alert' });
  const pw = input('password', '', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const pw2 = input('password2', '', { type: 'password', autocomplete: 'new-password', required: true });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      const d = formData(form);
      if (d.password !== d.password2) { err.textContent = t('user.passwordMismatch'); err.hidden = false; return; }
      const b = form.querySelector('button[type=submit]');
      b.disabled = true;
      try {
        const r = await post('/setup', { code: d.code, username: d.username, password: d.password, email: d.email, display_name: d.display_name, language: getLang(), title: d.title });
        await afterLogin(r.user);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; b.disabled = false; }
    },
  },
  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('h1', {}, t('setup.title')), langSwitch(() => renderSetup(root))),
  h('p', { class: 'muted' }, t('setup.lead'), ' ', h('code', {}, t('setup.codeHint'))),
  err,
  field(t('setup.code'), input('code', '', { required: true, autocomplete: 'off', class: 'mono', spellcheck: 'false' })),
  field(t('user.username'), input('username', 'admin', { required: true, autocomplete: 'username' })),
  field(t('user.display'), input('display_name', '', { autocomplete: 'name' })),
  field(t('user.email'), input('email', '', { type: 'email', autocomplete: 'email' })),
  field(t('user.password'), pw, t('user.passwordHint')),
  field(t('user.passwordRepeat'), pw2),
  field(t('setup.instance'), input('title', 'WhatsOnMyNet', { maxlength: 60 })),
  h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, t('setup.submit')));
  mount(root, h('div', { class: 'auth' }, art(), h('div', { class: 'auth-form' }, form)));
  form.querySelector('[name=code]').focus();
}

export function renderLogin(root) {
  document.title = `${t('login.title')} · WhatsOnMyNet`;
  const err = h('div', { class: 'error-box', hidden: true, role: 'alert' });
  // Second step (two-factor sign-in): appears when the server asks for the code
  const code = input('code', '', { inputmode: 'numeric', autocomplete: 'one-time-code', class: 'mono', maxlength: 20, spellcheck: 'false' });
  const codeBox = h('div', { hidden: true }, field(t('login.code'), code, t('login.codeHint')));
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      const d = formData(form);
      const b = form.querySelector('button[type=submit]');
      b.disabled = true;
      try {
        const r = await post('/login', { username: d.username, password: d.password, ...(codeBox.hidden ? {} : { code: d.code }) });
        await afterLogin(r.user);
      } catch (ex) {
        b.disabled = false;
        if (ex.code === 'err.totpRequired') { codeBox.hidden = false; code.required = true; code.focus(); return; }
        err.textContent = ex.message; err.hidden = false;
        if (codeBox.hidden) form.querySelector('[name=password]').select(); else { code.value = ''; code.focus(); }
      }
    },
  },
  h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('h1', {}, t('login.title')), langSwitch(() => renderLogin(root))),
  err,
  field(t('login.user'), input('username', '', { required: true, autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' })),
  field(t('login.password'), input('password', '', { type: 'password', required: true, autocomplete: 'current-password' })),
  codeBox,
  h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, t('login.submit')));
  mount(root, h('div', { class: 'auth' }, art(), h('div', { class: 'auth-form' }, form)));
  form.querySelector('[name=username]').focus();
}

