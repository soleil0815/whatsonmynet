// App shell: sign-in state, navigation, layout.
import { h, mount, toast, showFieldError } from './dom.js';
import { get, post, setUnauthorizedHandler, ApiError } from './api.js';
import { t, setLang } from './i18n.js';
import { icon, LOGO_MARK } from './icons.js';
import { renderSetup, renderLogin } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderInventory } from './views/inventory.js';
import { renderDevice } from './views/device.js';
import { renderScan } from './views/scan.js';
import { renderLocations } from './views/locations.js';
import { renderTopology } from './views/topology.js';
import { renderHelp } from './views/help.js';
import { renderSettings, renderProxmox, renderControllers, renderHardware, renderReports } from './views/settings.js';
import { renderAccount } from './views/account.js';
import { renderMonitoring } from './views/monitoring.js';
import { openAbout, COFFEE } from './views/about.js';

export const state = { user: null, boot: null, meta: null, waiting: 0, down: 0 };
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

/**
 * Error from the API in the user's language: next to the input it belongs to when the server names one and that input
 * is in `root` (default: the open dialog), otherwise as a toast
 */
export function fail(e, root) {
  if (e instanceof ApiError && e.code === 'err.totpRequiredByAdmin') { toast(e.message, 'error'); navigate('/account'); return; }
  if (e instanceof ApiError && e.field && showFieldError(root || [...document.querySelectorAll('dialog[open]')].pop(), e.field, e.message, e.detail)) return;
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
  [/^\/monitoring(?:\/(\d+))?$/, renderMonitoring, 'monitoring'],
  [/^\/monitoring\/(maintenance)$/, (main, sub) => renderMonitoring(main, null, sub), 'monitoring'],
  [/^\/monitoring\/(sensors)$/, (main, sub) => renderMonitoring(main, null, sub), 'sensors'],
  [/^\/locations$/, renderLocations, 'locations'],
  [/^\/(virtualization|proxmox)$/, renderProxmox, 'proxmox'],
  [/^\/controllers$/, renderControllers, 'controllers'],
  [/^\/hardware$/, renderHardware, 'hardware'],
  [/^\/reports$/, renderReports, 'reports'],
  [/^\/topology$/, renderTopology, 'topology'],
  [/^\/help$/, renderHelp, 'help'],
  [/^\/settings(?:\/([a-z]+))?$/, renderSettings, 'settings'],
  [/^\/account$/, renderAccount, 'account'],
];

function sidebar(active) {
  const u = state.user;
  const link = (path, key, ico, extra) => h('a', { href: path, class: active === key ? 'active' : '', 'data-link': true,
    'aria-current': active === key ? 'page' : null }, h('span', { html: icon(ico) }), t(`nav.${key}`), extra);
  return h('aside', { class: 'side', id: 'side' },
    h('a', { class: 'brand', href: '/', 'data-link': true, 'aria-label': 'WhatsOnMyNet' }, h('span', { html: LOGO_MARK }), wordmark()),
    // Grouped: what you look at (network) and what watches for you (monitoring); settings and help at the bottom
    h('nav', { class: 'nav', 'aria-label': t('nav.menu') },
      link('/', 'dashboard', 'dashboard'),
      h('div', { class: 'nav-group' }, t('nav.groupNetwork')),
      link('/inventory', 'inventory', 'inventory'),
      link('/scan', 'scan', 'radar', state.waiting ? h('span', { class: 'badge badge-new', title: t('dash.waiting') }, state.waiting) : null),
      link('/topology', 'topology', 'switch'),
      link('/locations', 'locations', 'location'),
      h('div', { class: 'nav-group' }, t('nav.groupWatch')),
      link('/monitoring', 'monitoring', 'pulse', state.down ? h('span', { class: 'badge badge-bad', title: t('mon.status.down') }, state.down) : null),
      link('/monitoring/sensors', 'sensors', 'gauge', state.sensorsDown ? h('span', { class: 'badge badge-bad', title: t('mon.status.down') }, state.sensorsDown) : null),
      u.canEdit ? link('/virtualization', 'proxmox', 'hypervisor') : null,
      u.canEdit ? link('/controllers', 'controllers', 'accesspoint') : null,
      u.canEdit ? link('/hardware', 'hardware', 'server') : null,
      u.isAdmin ? link('/reports', 'reports', 'mail') : null,
    ),
    h('div', { class: 'side-foot' },
      h('nav', { class: 'nav' },
        u.isAdmin ? link('/settings', 'settings', 'settings') : null,
        link('/help', 'help', 'help')),
      h('div', { class: 'who' }, h('strong', {}, u.display_name || u.username), t(`role.${u.role}`)),
      h('nav', { class: 'nav' },
        link('/account', 'account', 'user'),
        h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await post('/logout').catch(() => {}); state.user = null; navigate('/login'); } },
          h('span', { html: icon('logout') }), t('nav.logout'))),
      // For everyone: version, source code (AGPL), what is new
      h('div', { class: 'foot-links' },
        h('button', { type: 'button', class: 'version', title: t('about.title'), onclick: openAbout }, `WhatsOnMyNet ${state.boot.version}`),
        h('a', { class: 'coffee-link', href: COFFEE, target: '_blank', rel: 'noopener noreferrer', title: t('about.coffee') }, h('span', { html: icon('coffee') }), t('about.coffeeShort')))),
  );
}

/** Opens or closes the menu on narrow screens (on wide screens the sidebar is always shown) */
function setMenu(open, { restoreFocus = false } = {}) {
  const side = document.getElementById('side');
  const button = document.querySelector('.menu-btn');
  if (!side) return;
  side.classList.toggle('open', open);
  button?.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) side.querySelector('a')?.focus();
  else if (restoreFocus) button?.focus();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('side')?.classList.contains('open') && !document.querySelector('dialog[open]')) setMenu(false, { restoreFocus: true });
});

async function refreshBadge() {
  try {
    const d = await get('/dashboard');
    state.waiting = d.waiting;
    // Sensors (values of devices, hypervisors) have their own entry in the menu
    const down = d.monitoring?.down || [];
    state.sensorsDown = down.filter((m) => ['sensor', 'snmp', 'proxmox'].includes(m.type)).length;
    state.down = down.length - state.sensorsDown;
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
  main.tabIndex = -1;
  const menuBtn = h('button', { class: 'icon-btn menu-btn', type: 'button', 'aria-label': t('nav.menu'), 'aria-controls': 'side', 'aria-expanded': 'false',
    onclick: () => setMenu(!side.classList.contains('open')), html: icon('menu') });
  const topbar = h('div', { class: 'topbar' }, menuBtn, h('span', { html: LOGO_MARK }), wordmark());
  const skip = h('a', { class: 'skip-link', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, t('nav.skip'));
  mount(root, h('div', { class: 'shell' }, skip, side, h('div', {}, topbar, main)));
  side.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  document.title = `${t(`nav.${key}`)} · ${state.boot.title || 'WhatsOnMyNet'}`;
  // Screen readers and keyboard users start on the new page, not on the (redrawn) sidebar; views may focus a field afterwards
  main.focus({ preventScroll: true });
  try {
    cleanup = await view(main, ...params) || null;
  } catch (e) {
    // A page that could not be built: a plain note with a way to try again instead of an empty page,
    // and a program error (TypeError …) to the console instead of a cryptic toast
    if (e instanceof ApiError) fail(e); else console.error(e);
    mount(main, h('div', { class: 'empty' }, h('p', {}, t(e instanceof ApiError ? 'err.pageLoad' : 'err.pageBroken')),
      h('button', { class: 'btn', type: 'button', onclick: () => render() }, t('retry'))));
  }
}

/** Updates the "new devices" badge in the sidebar without redrawing the page */
export async function updateBadge() {
  await refreshBadge();
  const a = document.querySelector('.nav a[href="/scan"]');
  if (a) {
    a.querySelector('.badge')?.remove();
    if (state.waiting) a.append(h('span', { class: 'badge badge-new', title: t('dash.waiting') }, state.waiting));
  }
  for (const [href, n] of [['/monitoring', state.down], ['/monitoring/sensors', state.sensorsDown]]) {
    const m = document.querySelector(`.nav a[href="${href}"]`);
    if (!m) continue;
    m.querySelector('.badge')?.remove();
    if (n) m.append(h('span', { class: 'badge badge-bad', title: t('mon.status.down') }, n));
  }
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

setInterval(() => { if (state.user && document.visibilityState === 'visible') updateBadge(); }, 60000);

start();
