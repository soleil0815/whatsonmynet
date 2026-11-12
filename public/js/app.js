// App shell: sign-in state, navigation, layout.
import { h, mount, toast } from './dom.js';
import { get, post, setUnauthorizedHandler, ApiError } from './api.js';
import { t, setLang } from './i18n.js';
import { icon, LOGO_MARK } from './icons.js';
import { renderSetup, renderLogin } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderInventory } from './views/inventory.js';
import { renderDevice } from './views/device.js';
import { renderScan } from './views/scan.js';
import { renderLocations } from './views/locations.js';
import { renderSettings } from './views/settings.js';
import { renderAccount } from './views/account.js';

export const state = { user: null, boot: null, meta: null, waiting: 0 };
const root = document.getElementById('app');
let cleanup = null;

export function applyTheme(pref) {
  try { localStorage.setItem('womn-theme', pref || 'system'); } catch { /* storage blocked */ }
  const dark = pref === 'dark' || ((!pref || pref === 'system') && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.user?.theme || 'system'));

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  render();
}

/** Error from the API as a toast in the user's language */
export function fail(e) {
  if (e instanceof ApiError && e.code === 'network') toast(t('err.network'), 'error');
  else toast(e?.message || String(e), 'error');
}

export function wordmark() {
  return h('span', { class: 'wordmark' }, 'Whats', h('span', {}, 'OnMyNet'));
}

const ROUTES = [
  [/^\/$/, renderDashboard, 'dashboard'],
  [/^\/inventory$/, renderInventory, 'inventory'],
  [/^\/devices\/(\d+)$/, renderDevice, 'inventory'],
  [/^\/scan(?:\/(\d+))?$/, renderScan, 'scan'],
  [/^\/locations$/, renderLocations, 'locations'],
  [/^\/settings(?:\/([a-z]+))?$/, renderSettings, 'settings'],
  [/^\/account$/, renderAccount, 'account'],
];

function sidebar(active) {
  const u = state.user;
  const link = (path, key, ico, extra) => h('a', { href: path, class: active === key ? 'active' : '', 'data-link': true,
    'aria-current': active === key ? 'page' : null }, h('span', { html: icon(ico) }), t(`nav.${key}`), extra);
  return h('aside', { class: 'side', id: 'side' },
    h('a', { class: 'brand', href: '/', 'data-link': true, 'aria-label': 'WhatsOnMyNet' }, h('span', { html: LOGO_MARK }), wordmark()),
    h('nav', { class: 'nav', 'aria-label': t('nav.menu') },
      link('/', 'dashboard', 'dashboard'),
      link('/inventory', 'inventory', 'inventory'),
      link('/scan', 'scan', 'radar', state.waiting ? h('span', { class: 'badge badge-new', title: t('dash.waiting') }, state.waiting) : null),
      link('/locations', 'locations', 'location'),
      u.isAdmin ? link('/settings', 'settings', 'settings') : null,
    ),
    h('div', { class: 'side-foot' },
      h('div', { class: 'who' }, h('strong', {}, u.display_name || u.username), t(`role.${u.role}`)),
      h('nav', { class: 'nav' },
        link('/account', 'account', 'user'),
        h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await post('/logout').catch(() => {}); state.user = null; navigate('/login'); } },
          h('span', { html: icon('logout') }), t('nav.logout'))),
      h('div', { class: 'version' }, `WhatsOnMyNet ${state.boot.version}`)),
  );
}

async function refreshBadge() {
  try {
    const d = await get('/dashboard');
    state.waiting = d.waiting;
  } catch { /* shown elsewhere */ }
}

export async function render() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const path = location.pathname;
  if (state.boot.setupRequired) {
    if (path !== '/setup') history.replaceState({}, '', '/setup');
    return renderSetup(root);
  }
  if (!state.user) {
    if (path !== '/login') history.replaceState({}, '', '/login');
    return renderLogin(root);
  }
  if (path === '/login' || path === '/setup') { history.replaceState({}, '', '/'); return render(); }
  const route = ROUTES.find(([re]) => re.test(path));
  if (!route) { history.replaceState({}, '', '/'); return render(); }
  const [re, view, key] = route;
  const params = path.match(re).slice(1);
  const main = h('main', { class: 'main', id: 'main' });
  const side = sidebar(key);
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('nav.menu'), onclick: () => side.classList.toggle('open'), html: icon('menu') }),
    h('span', { html: LOGO_MARK }), wordmark());
  mount(root, h('div', { class: 'shell' }, side, h('div', {}, topbar, main)));
  side.addEventListener('click', (e) => { if (e.target.closest('a')) side.classList.remove('open'); });
  document.title = `${t(`nav.${key}`)} · ${state.boot.title || 'WhatsOnMyNet'}`;
  try {
    cleanup = await view(main, ...params) || null;
  } catch (e) {
    fail(e);
  }
}

/** Updates the "new devices" badge in the sidebar without redrawing the page */
export async function updateBadge() {
  await refreshBadge();
  const a = document.querySelector('.nav a[href="/scan"]');
  if (!a) return;
  a.querySelector('.badge')?.remove();
  if (state.waiting) a.append(h('span', { class: 'badge badge-new', title: t('dash.waiting') }, state.waiting));
}

export function setUser(u) {
  state.user = u;
  if (u) { setLang(u.language); applyTheme(u.theme); }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

setUnauthorizedHandler(() => {
  if (!state.user) return;
  state.user = null;
  navigate('/login', { replace: true });
});

async function start() {
  setLang(navigator.language?.startsWith('en') ? 'en' : 'de');
  try {
    state.boot = await get('/bootstrap');
  } catch {
    mount(root, h('div', { class: 'empty' }, t('err.network')));
    return;
  }
  if (state.boot.user) {
    setUser(state.boot.user);
    try { state.meta = await get('/meta'); } catch { /* later */ }
    await refreshBadge();
  }
  render();
}

export async function afterLogin(user) {
  setUser(user);
  state.boot.setupRequired = false;
  state.meta = await get('/meta');
  await refreshBadge();
  navigate('/', { replace: true });
}

start();
