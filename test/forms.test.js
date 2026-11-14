// Dialogs as forms, validation errors at the field, settings navigation on phones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './helpers.js';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ------------------------------------------------------------------------------------------------ server: field
const app = await startApp();
const { call } = app;
test.after(() => app.close());

test('server: validation errors name the input they belong to (field), the rest of the format stays', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'admin1', password: 'Sicher-Passwort-1', code: 'setup-123' })).status, 200);

  const ip = await call('POST', '/api/devices', { name: 'Printer', ip: '300.1.1.1' });
  assert.equal(ip.status, 400);
  assert.equal(ip.data.error.code, 'err.ip');
  assert.equal(typeof ip.data.error.message, 'string');
  assert.equal(ip.data.error.field, 'ip');

  const url = await call('POST', '/api/devices', { name: 'Printer', web_url: 'javascript:alert(1)' });
  assert.equal(url.data.error.code, 'err.url');
  assert.equal(url.data.error.field, 'web_url');

  const dev = await call('POST', '/api/devices', { name: 'Printer' });
  assert.equal(dev.status, 201);
  const mac = await call('PATCH', `/api/devices/${dev.data.id}`, { mac: 'not-a-mac' });
  assert.equal(mac.data.error.field, 'mac');
  const date = await call('PATCH', `/api/devices/${dev.data.id}`, { warranty_until: '2027-02-30' });
  assert.equal(date.data.error.field, 'warranty_until');

  const loc = await call('POST', '/api/locations', { name: '', subnets: [] });
  assert.equal(loc.data.error.field, 'name');
  const cidr = await call('POST', '/api/locations', { name: 'Site A', subnets: ['10.0.0.0/33'] });
  assert.equal(cidr.data.error.code, 'err.cidr');
  assert.equal(cidr.data.error.field, 'cidr');
  assert.equal(cidr.data.error.detail, '10.0.0.0/33');

  const mon = await call('POST', '/api/monitors', { type: 'tcp', name: 'Port', target: 'bad host!', port: 80 });
  assert.equal(mon.data.error.field, 'target');
  const port = await call('POST', '/api/monitors', { type: 'tcp', name: 'Port', target: '192.0.2.10', port: 70000 });
  assert.equal(port.data.error.field, 'port');
  const st = await call('POST', '/api/monitors', { type: 'http', name: 'Web', target: 'http://192.0.2.10/', http_status: 'abc' });
  assert.equal(st.data.error.field, 'http_status');

  const user = await call('POST', '/api/users', { username: 'x y', password: 'Sicher-Passwort-2' });
  assert.equal(user.data.error.field, 'username');
  const mail = await call('POST', '/api/users', { username: 'someone', email: 'nope', password: 'Sicher-Passwort-2' });
  assert.equal(mail.data.error.field, 'email');
  const pw = await call('POST', '/api/users', { username: 'someone', password: 'short' });
  assert.equal(pw.data.error.field, 'password');

  // errors without an input have no field
  const nf = await call('GET', '/api/devices/99999');
  assert.equal(nf.status, 404);
  assert.equal('field' in nf.data.error, false);
});

// ------------------------------------------------------------------------------------- minimal DOM for dom.js
/** Just enough of the DOM for modal(), busy() and the field errors - no browser, no dependency */
function fakeDom() {
  class Node {
    constructor() { this.children = []; this.parentNode = null; this.listeners = {}; }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    append(...nodes) { for (const n of nodes) { n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n); } }
    removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    after(n) { const p = this.parentNode; n.parentNode?.removeChild(n); const i = p.children.indexOf(this); p.children.splice(i + 1, 0, n); n.parentNode = p; }
    addEventListener(type, fn, opts) { (this.listeners[type] ||= []).push({ fn, once: opts?.once }); }
    dispatchEvent(ev) {
      ev.target ||= this;
      for (let el = this; el; el = el.parentNode) {
        for (const l of [...(el.listeners[ev.type] || [])]) { if (l.once) el.listeners[ev.type] = el.listeners[ev.type].filter((x) => x !== l); l.fn(ev); }
        if (ev.bubbles === false) break;
      }
      return !ev.defaultPrevented;
    }
  }
  class Text extends Node { constructor(s) { super(); this.textContent = s; } }
  class Element extends Node {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.attrs = {}; this.dataset = {}; this.style = {}; this.className = ''; this.disabled = false; this.open = false; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'name') this.name = String(v); if (k === 'type') this.type = String(v); if (k === 'disabled') this.disabled = true; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return k in this.attrs; }
    get textContent() { return this.children.map((c) => c.textContent).join(''); }
    set textContent(s) { this.children = [new Text(s)]; }
    get classList() { const el = this; return { add: (c) => { el.className = `${el.className} ${c}`.trim(); }, contains: (c) => el.className.split(' ').includes(c) }; }
    *walk() { for (const c of this.children) if (c instanceof Element) { yield c; yield* c.walk(); } }
    matchesSimple(sel) {
      // supports: tag, [attr], [attr=value], tag[attr=value], combinations thereof, :not([attr])
      const m = sel.match(/^([a-z]*)((?:\[[^\]]+\])*)((?::not\(\[[^\]]+\]\))*)$/i);
      if (!m) throw new Error(`selector not supported by the fake DOM: ${sel}`);
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      const attrOk = (a) => { const [k, v] = a.split('='); const val = k === 'type' ? (this.type ?? this.getAttribute('type')) : k === 'name' ? this.name : this.getAttribute(k); return v === undefined ? val !== null && val !== undefined : val === v.replace(/"/g, ''); };
      for (const [, a] of m[2].matchAll(/\[([^\]]+)\]/g)) if (!attrOk(a)) return false;
      for (const [, a] of m[3].matchAll(/\[([^\]]+)\]/g)) if (this.hasAttribute(a)) return false;
      return true;
    }
    matches(sel) { return sel.split(',').some((s) => this.matchesSimple(s.trim())); }
    querySelectorAll(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { for (let el = this; el instanceof Element; el = el.parentNode) if (el.matches(sel)) return el; return null; }
    focus() { doc.activeElement = this; }
    get form() { for (let el = this.parentNode; el; el = el.parentNode) if (el.tagName === 'FORM') return el; return null; }
  }
  class Dialog extends Element { showModal() { this.open = true; this.attrs.open = ''; } close() { this.open = false; delete this.attrs.open; this.dispatchEvent(new Event('close')); } }
  class Form extends Element {
    requestSubmit(submitter) { this.dispatchEvent(Object.assign(new Event('submit'), { submitter, bubbles: false })); }
    reportValidity() { return true; }
  }
  class Event {
    constructor(type) { this.type = type; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  const body = new Element('body');
  const doc = {
    body,
    activeElement: null,
    createElement: (tag) => (tag === 'dialog' ? new Dialog(tag) : tag === 'form' ? new Form(tag) : new Element(tag)),
    createTextNode: (s) => new Text(s),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
    documentElement: {},
  };
  return { doc, Node, Element, Event };
}

const dom = fakeDom();
globalThis.document = dom.doc;
globalThis.Node = dom.Node;
globalThis.Event = dom.Event;
globalThis.navigator ??= { language: 'en' };
const { modal, h, busy, showFieldError, clearFieldErrors } = await import('../public/js/dom.js');
const tick = () => new Promise((r) => setTimeout(r, 0));

test('modal: the body sits in a <form>, the primary button submits it, other buttons are type=button', async () => {
  let saved = 0;
  const name = h('input', { type: 'text', name: 'name' });
  const notes = h('textarea', { name: 'notes' });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');
  const cancel = h('button', { class: 'btn' }, 'Cancel'); // no type: must not become a submit button
  const m = modal('Edit', h('div', {}, name, notes), { actions: [cancel, save], onSubmit: () => { saved++; } });
  assert.ok(m.form, 'modal returns its form');
  assert.equal(m.form.tagName, 'FORM');
  assert.ok(m.el.querySelectorAll('form').includes(m.form));
  assert.equal(save.getAttribute('form'), m.form.id, 'the submit button in the footer belongs to the form');
  assert.equal(cancel.type, 'button');
  // Enter in a text field = implicit submission through the default (submit) button
  m.form.requestSubmit(save);
  await tick();
  assert.equal(saved, 1);
  m.close();
});

test('modal: a <form> passed as body becomes the dialog form (no nested forms)', () => {
  const f = h('form', { class: 'form' }, h('input', { name: 'x' }));
  const ok = h('button', { type: 'submit' }, 'OK');
  const m = modal('T', f, { actions: [ok], onSubmit: () => {} });
  assert.equal(m.form, f);
  assert.equal(m.el.querySelectorAll('form').length, 1);
  assert.equal(ok.getAttribute('form'), f.id);
  m.close();
});

test('modal: submitting twice while the first request runs sends it once (central busy)', async () => {
  let calls = 0;
  let release;
  const save = h('button', { type: 'submit' }, 'Save');
  const m = modal('T', h('div', {}, h('input', { name: 'a' })), { actions: [save], onSubmit: () => { calls++; return new Promise((r) => { release = r; }); } });
  m.form.requestSubmit(save);
  m.form.requestSubmit(save);
  m.form.requestSubmit(save);
  await tick();
  assert.equal(calls, 1);
  assert.equal(save.disabled, true);
  release();
  await tick();
  assert.equal(save.disabled, false, 'enabled again afterwards');
  m.form.requestSubmit(save);
  await tick();
  assert.equal(calls, 2);
  m.close();
});

test('modal: submit always prevents navigation, also without onSubmit; Enter in a search field does not submit', () => {
  const search = h('input', { type: 'search' });
  const m = modal('T', h('div', {}, search), { actions: [h('button', { type: 'button' }, 'Close')] });
  const ev = new Event('submit');
  m.form.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  // a dialog without buttons has no footer (and no stray text)
  const bare = modal('Info', h('p', {}, 'x'));
  assert.equal(bare.el.children.length, 2);
  assert.ok(bare.el.children.every((c) => c.tagName));
  bare.close();
  const key = Object.assign(new Event('keydown'), { key: 'Enter', target: search });
  search.dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  m.close();
});

test('field errors: message next to the input with aria-invalid/aria-describedby and focus, cleared again', async () => {
  const ip = h('input', { name: 'ip', 'aria-describedby': 'hint-1' });
  const label = h('label', { class: 'field' }, 'IP', ip);
  const form = h('form', {}, label, h('input', { name: 'other' }));
  document.body.append(form);
  assert.equal(showFieldError(form, 'ip', 'Invalid IP address'), true);
  assert.equal(ip.getAttribute('aria-invalid'), 'true');
  const msg = label.children[label.children.indexOf(ip) + 1];
  assert.equal(msg.textContent, 'Invalid IP address');
  assert.ok(ip.getAttribute('aria-describedby').split(' ').includes(msg.id));
  assert.ok(ip.getAttribute('aria-describedby').split(' ').includes('hint-1'), 'keeps the existing description');
  assert.equal(document.activeElement, ip);
  // unknown field: nothing shown (caller falls back to the toast)
  assert.equal(showFieldError(form, 'nothere', 'x'), false);
  assert.equal(showFieldError(form, undefined, 'x'), false);
  clearFieldErrors(form);
  assert.equal(ip.getAttribute('aria-invalid'), null);
  assert.equal(ip.getAttribute('aria-describedby'), 'hint-1');
  assert.equal(label.children.includes(msg), false);
  // with several inputs of the same name the one whose value the server names is marked
  const a = h('input', { name: 'cidr' }); a.value = '10.0.0.0/24';
  const b = h('input', { name: 'cidr' }); b.value = '10.0.0.0/33';
  const f2 = h('form', {}, h('label', {}, a), h('label', {}, b));
  assert.equal(showFieldError(f2, 'cidr', 'bad', '10.0.0.0/33'), true);
  assert.equal(b.getAttribute('aria-invalid'), 'true');
  assert.equal(a.getAttribute('aria-invalid'), null);
  // typing in the field removes the message
  b.dispatchEvent(new Event('input'));
  assert.equal(b.getAttribute('aria-invalid'), null);
  form.remove();
});

test('busy still guards a plain button', async () => {
  const b = h('button', { type: 'button' });
  let n = 0;
  await Promise.all([busy(b, async () => { n++; await tick(); }), busy(b, async () => { n++; })]);
  assert.equal(n, 1);
});

// ------------------------------------------------------------------------------------------------- static checks
test('every dialog submits its primary action through onSubmit (no primary type=button, no per-dialog busy)', () => {
  const files = ['public/js/views/settings.js', 'public/js/views/monitoring.js', 'public/js/views/inventory.js', 'public/js/views/locations.js',
    'public/js/views/account.js', 'public/js/views/hostscripts.js', 'public/js/dom.js'];
  let dialogs = 0; let submits = 0;
  for (const f of files) {
    const src = read(f);
    assert.ok(!src.includes("btn-primary', type: 'button'") && !src.includes('btn-primary`, type: \'button\''), `${f}: primary button of type=button`);
    // the only busy() left in the views guards a page button (create backup), not a dialog
    const busyCalls = [...src.matchAll(/busy\(e\.currentTarget/g)].length;
    assert.ok(busyCalls <= (f.endsWith('settings.js') ? 1 : 0), `${f}: ${busyCalls} busy() calls`);
    dialogs += [...src.matchAll(/onSubmit: /g)].length;
    submits += [...src.matchAll(/type: 'submit' \}/g)].length;
  }
  assert.ok(dialogs >= 20, `dialogs with onSubmit: ${dialogs}`);
  assert.ok(submits >= dialogs, 'each of them has a submit button');
});

test('settings: on phones a <select> with one <optgroup> per settings group replaces the strip', async () => {
  const src = read('public/js/views/settingsnav.js');
  assert.match(src, /'subnav-select'/);
  assert.match(src, /h\('optgroup', \{ label: t\(`set\.group\.\$\{g\}`\) \}/);
  assert.match(src, /'aria-label': t\('set\.navSelect'\)/);
  const { KEYS_DE, KEYS_EN } = await import('../public/js/i18n.js');
  assert.ok(KEYS_DE.includes('set.navSelect') && KEYS_EN.includes('set.navSelect'));
  const css = read('public/css/app.css');
  assert.match(css, /\.subnav-select \{ display: none; \}/);
  const phone = css.slice(css.indexOf('@media (max-width: 820px)'));
  assert.match(phone.slice(0, phone.indexOf('\n}\n')), /\.subnav-select \{ display: block;/);
  assert.match(phone.slice(0, phone.indexOf('\n}\n')), /\.subnav a \{ display: none; \}/);
  // the CSS for the field errors exists
  assert.match(css, /\.field-error \{/);
});

test('settings select: one option per settings section, grouped like the desktop navigation', async () => {
  const { settingsSelect } = await import('../public/js/views/settingsnav.js').catch(() => ({}));
  assert.equal(typeof settingsSelect, 'function', 'settingsSelect is exported');
  assert.match(read('public/js/views/settings.js'), /settingsNav\(section, \(s\) => navigate\(`\/settings\/\$\{s\}`\)\)/);
  const src = read('public/js/views/settingsnav.js');
  const groups = src.slice(src.indexOf('const GROUPS = ['), src.indexOf('const SECTIONS'));
  const sections = [...groups.matchAll(/\['([a-z]+)', '[a-z]+'\]/g)].map((m) => m[1]);
  const sel = settingsSelect('users');
  const opts = sel.querySelectorAll('option');
  assert.deepEqual(opts.map((o) => o.getAttribute('value')), sections);
  assert.equal(sel.querySelectorAll('optgroup').length, 4);
  assert.equal(sel.value, 'users');
});
