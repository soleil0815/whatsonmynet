// Own account: profile, language, theme, password.
import { h, mount, toast } from '../dom.js';
import { patch, post } from '../api.js';
import { t } from '../i18n.js';
import { state, setUser, render, fail } from '../app.js';
import { pageHead, field, input, select, formData } from './common.js';

export async function renderAccount(main) {
  const u = state.user;
  const profile = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await patch('/me', formData(profile));
      setUser({ ...state.user, ...r });
      toast(t('saved'));
      render();
    } catch (ex) { fail(ex); }
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
    } catch (ex) { fail(ex); }
  } },
  field(t('acc.current'), input('current', '', { type: 'password', autocomplete: 'current-password', required: true })),
  field(t('acc.new'), input('password', '', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }), t('user.passwordHint')),
  field(t('user.passwordRepeat'), input('password2', '', { type: 'password', autocomplete: 'new-password', required: true })),
  h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, t('acc.password'))));

  mount(main, h('div', { class: 'page' },
    pageHead(t('acc.title'), `${t(`role.${u.role}`)} – ${t(`role.${u.role}.hint`)}`),
    h('div', { class: 'device-grid' },
      h('section', { class: 'panel panel-pad' }, h('h2', { class: 'section-title' }, t('acc.profile')), profile),
      h('section', { class: 'panel panel-pad' }, h('h2', { class: 'section-title' }, t('acc.password')),
        u.source === 'ldap' ? h('p', { class: 'muted', style: { margin: 0 } }, t('acc.adPassword')) : pw))));
}
