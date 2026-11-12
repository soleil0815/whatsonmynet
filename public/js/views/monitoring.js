// Monitoring: list of monitors with heartbeat bar, detail with response time chart and events,
// form to add or edit a monitor, maintenance windows.
import { h, mount, modal, toast, confirmDialog, fmtDate, fmtAgo } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail } from '../app.js';
import { pageHead, field, input, select, btn, formData } from './common.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

export function statusPill(status) {
  return h('span', { class: `pill pill-${status}` }, h('i'), t(`mon.status.${status}`));
}

export function monitorDot(status) {
  return h('span', { class: `dot mon-${status}`, title: t(`mon.status.${status}`), role: 'img', 'aria-label': t(`mon.status.${status}`) });
}

export function targetText(m) {
  if (m.type === 'docker') return m.docker_host ? `${m.target} @ ${m.docker_host.name}` : m.target;
  return ['tcp', 'mysql', 'postgres', 'redis'].includes(m.type) ? `${m.target}:${m.port}` : m.target;
}

function beatsBar(beats, slots = 40) {
  const pad = Math.max(0, slots - beats.length);
  return h('span', { class: 'beats', 'aria-hidden': 'true' },
    Array.from({ length: pad }, () => h('i', { class: 'none' })),
    beats.slice(-slots).map((b) => h('i', { class: b.ok ? 'ok' : 'bad', title: `${fmtDate(b.at, getLang())} · ${b.ok ? `${b.ms ?? '–'} ms` : b.message}` })));
}

const pct = (v) => (v === null || v === undefined ? '–' : `${v.toLocaleString(getLang() === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: 2 })} %`);

export async function renderMonitoring(main, id, sub) {
  if (id) return renderDetail(main, Number(id));
  if (sub === 'maintenance') return renderMaintenance(main);
  const edit = state.user.canEdit;
  const tabs = tabBar('monitors');
  const body = h('section', { class: 'panel' });
  let timer = null;
  let alive = true;

  async function load() {
    let list;
    try { list = await get('/monitors'); } catch (e) { if (alive) fail(e); return; }
    if (!alive) return;
    if (!list.length) {
      mount(body, h('div', { class: 'empty' }, h('h2', {}, t('mon.emptyTitle')), h('p', {}, t('mon.emptyText')),
        edit ? btn(t('mon.add'), { class: 'btn btn-primary', onclick: () => openMonitorForm(null, load) }, 'plus') : null));
    } else {
      const down = list.filter((m) => m.status === 'down').length;
      mount(body,
        h('div', { class: 'toolbar' }, h('span', { class: 'count', style: { marginLeft: 0 } },
          t('mon.count', { n: list.length, up: list.filter((m) => m.status === 'up').length, down }))),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, t('mon.col.name')), h('th', { class: 'hide-sm' }, t('mon.col.beats')),
            h('th', {}, t('mon.col.uptime')), h('th', { class: 'hide-sm' }, t('mon.col.ms')), h('th', { class: 'hide-sm' }, t('mon.col.cert')))),
          h('tbody', {}, list.map((m) => h('tr', { class: 'click', onclick: (e) => { if (!e.target.closest('a,button')) navigate(`/monitoring/${m.id}`); } },
            h('td', {}, h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, monitorDot(m.status),
              h('div', {}, h('a', { href: `/monitoring/${m.id}`, 'data-link': true, class: 'name' }, m.name),
                h('div', { class: 'sub mono' }, `${t(`mon.type.${m.type}`)} · ${targetText(m)}`)))),
            h('td', { class: 'hide-sm' }, beatsBar(m.beats)),
            h('td', {}, pct(m.uptime24)),
            h('td', { class: 'hide-sm' }, m.last_ms !== null && m.status === 'up' ? `${m.last_ms} ms` : '–'),
            h('td', { class: 'hide-sm' }, certBadge(m))))))));
    }
    timer = setTimeout(load, 15000);
  }

  mount(main, h('div', { class: 'page' },
    pageHead(t('mon.title'), t('mon.lead'), edit ? btn(t('mon.add'), { class: 'btn btn-primary', onclick: () => openMonitorForm(null, load) }, 'plus') : null),
    tabs, body));
  mount(body, h('div', { class: 'empty' }, t('loading')));
  await load();
  return () => { alive = false; clearTimeout(timer); };
}

function tabBar(active) {
  return h('div', { class: 'tabs page-tabs', role: 'tablist' },
    [['monitors', '/monitoring'], ['maintenance', '/monitoring/maintenance']].map(([k, href]) => h('a', { href, 'data-link': true, role: 'tab',
      class: active === k ? 'on' : '', 'aria-selected': String(active === k) }, t(`mon.tab.${k}`))));
}

function certBadge(m) {
  if (m.cert_days_left === null || m.cert_days_left === undefined) return '–';
  const d = m.cert_days_left;
  return h('span', { class: `badge${d < 0 ? ' badge-bad' : d <= 14 ? ' badge-new' : ''}`, title: fmtDate(m.cert_valid_to, getLang(), false) },
    d < 0 ? t('mon.certExpired') : t('mon.certDays', { n: d }));
}

/** Response time chart: line for answers, red marks for failed checks */
function chart(checks, hours) {
  const W = 720; const H = 160; const P = 6;
  const svg = svgEl('svg', { class: 'mon-chart', viewBox: `0 0 ${W} ${H + 18}`, role: 'img', 'aria-label': t('mon.chart') });
  if (!checks.length) {
    const tx = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'muted-text' });
    tx.textContent = t('mon.noChecks');
    svg.append(tx);
    return svg;
  }
  const end = Date.now();
  // Young monitors: start at the first check instead of showing an empty day
  const first = Date.parse(checks[0].at);
  const start = Math.max(end - hours * 3600 * 1000, Math.min(first - 60000, end - 10 * 60000));
  const x = (at) => P + ((Date.parse(at) - start) / (end - start)) * (W - 2 * P);
  const max = Math.max(10, ...checks.filter((c) => c.ok && c.ms !== null).map((c) => c.ms));
  const y = (ms) => H - P - (ms / max) * (H - 2 * P - 10);
  for (const f of [0.5, 1]) {
    svg.append(svgEl('line', { x1: 0, x2: W, y1: y(max * f), y2: y(max * f), class: 'grid' }));
    const lab = svgEl('text', { x: 2, y: y(max * f) - 3, class: 'axis' });
    lab.textContent = `${Math.round(max * f)} ms`;
    svg.append(lab);
  }
  let d = ''; let pen = false;
  for (const c of checks) {
    if (!c.ok || c.ms === null) { pen = false; svg.append(svgEl('rect', { x: x(c.at) - 1, y: H - 14, width: 2.5, height: 12, class: 'fail' })); continue; }
    d += `${pen ? 'L' : 'M'}${x(c.at).toFixed(1)},${y(c.ms).toFixed(1)}`;
    pen = true;
  }
  svg.append(svgEl('path', { d, class: 'line' }));
  for (const [pos, at] of [[0, start], [W, end]]) {
    const lab = svgEl('text', { x: pos ? W - 2 : 2, y: H + 14, class: 'axis', 'text-anchor': pos ? 'end' : 'start' });
    lab.textContent = fmtDate(new Date(at).toISOString(), getLang());
    svg.append(lab);
  }
  return svg;
}

async function renderDetail(main, id) {
  const edit = state.user.canEdit;
  let hours = 24;
  let timer = null;
  let alive = true;
  const head = h('div'); const body = h('div', { class: 'stack' });
  mount(main, h('div', { class: 'page' }, head, body));

  async function load() {
    let m;
    try { m = await get(`/monitors/${id}?hours=${hours}`); } catch (e) { if (alive) fail(e); return; }
    if (!alive) return;
    const reload = () => { clearTimeout(timer); load(); };
    mount(head, h('div', { class: 'device-head' },
      h('div', { class: `device-icon mon-icon mon-${m.status}`, html: icon('pulse') }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('h1', {}, m.name, statusPill(m.status)),
        h('div', { class: 'meta' }, h('span', { class: 'mono' }, `${t(`mon.type.${m.type}`)} · ${targetText(m)}`),
          h('span', {}, t('mon.every', { n: m.interval_s })),
          m.device ? h('a', { href: `/devices/${m.device.id}`, 'data-link': true }, m.device.name) : null)),
      edit ? h('div', { class: 'actions' },
        btn(t('mon.checkNow'), { onclick: async (e) => { e.currentTarget.disabled = true; try { await post(`/monitors/${id}/check`); reload(); } catch (ex) { fail(ex); } } }, 'radar'),
        btn(m.enabled ? t('mon.pause') : t('mon.resume'), { onclick: async () => { try { await post(`/monitors/${id}/${m.enabled ? 'pause' : 'resume'}`); reload(); } catch (ex) { fail(ex); } } }),
        btn(t('edit'), { onclick: () => openMonitorForm(m, reload) }, 'edit'),
        btn(t('delete'), { class: 'btn btn-danger', onclick: async () => {
          if (!await confirmDialog(t('delete'), t('mon.deleteConfirm', { name: m.name }), t('delete'), t('cancel'), { danger: true })) return;
          try { await del(`/monitors/${id}`); toast(t('deleted')); navigate('/monitoring'); } catch (ex) { fail(ex); }
        } }, 'trash')) : null));

    const span = h('div', { class: 'seg' }, [[24, '24 h'], [72, '3 d'], [168, '7 d']].map(([v, l]) => h('button', { type: 'button', class: v === hours ? 'on' : '',
      onclick: () => { hours = v; reload(); } }, l)));
    mount(body,
      m.status === 'down' ? h('div', { class: 'note bad' }, t('mon.downSince', { when: fmtAgo(m.status_since, t), message: m.last_message })) : null,
      m.maintenance ? h('div', { class: 'note ti' }, t('mon.inMaintenance')) : null,
      h('div', { class: 'figures' },
        h('div', { class: 'figure' }, h('b', {}, pct(m.uptime.h24.pct)), h('span', {}, t('mon.uptime24'))),
        h('div', { class: 'figure' }, h('b', {}, pct(m.uptime.d7.pct)), h('span', {}, t('mon.uptime7'))),
        h('div', { class: 'figure' }, h('b', {}, pct(m.uptime.d30.pct)), h('span', {}, t('mon.uptime30'))),
        h('div', { class: 'figure' }, h('b', {}, m.uptime.h24.avgMs !== null ? `${m.uptime.h24.avgMs} ms` : '–'), h('span', {}, t('mon.avgMs'))),
        m.cert_valid_to ? h('div', { class: `figure${m.cert_days_left <= 14 ? ' alert' : ''}` }, h('b', {}, m.cert_days_left < 0 ? t('mon.certExpired') : m.cert_days_left),
          h('span', {}, t('mon.certLeft', { date: fmtDate(m.cert_valid_to, getLang(), false) }))) : null),
      h('section', { class: 'panel panel-pad' },
        h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '10px' } }, h('h2', { class: 'section-title', style: { margin: 0 } }, t('mon.chart')), span),
        chart(m.checks, hours)),
      h('section', { class: 'panel panel-pad' },
        h('h2', { class: 'section-title' }, t('mon.events')),
        m.events.length ? h('ul', { class: 'timeline' }, m.events.map((e) => h('li', { class: `ev-${e.kind}` },
          h('span', { class: 'when' }, fmtDate(e.at, getLang()), e.notified ? ` · ${t('mon.notified', { to: e.notified })}` : ''),
          eventLine(e))))
          : h('p', { class: 'muted' }, t('mon.noEvents'))));
    timer = setTimeout(load, 30000);
  }
  await load();
  return () => { alive = false; clearTimeout(timer); };
}

function eventLine(e) {
  if (e.kind === 'cert') return t('mon.ev.cert', { n: e.message });
  return `${t(`mon.ev.${e.kind}`)}${e.message && e.kind === 'down' ? ` – ${e.message}` : ''}`;
}

/** Form to add or edit a monitor. `preset` fills a new one (e.g. from a device). */
export async function openMonitorForm(m, done, preset = null) {
  let chans = [];
  try { chans = await get('/channels'); } catch { /* list stays empty */ }
  const v = m || { type: 'http', interval_s: 60, timeout_s: 10, fail_threshold: 3, resend_min: 0, http_status: '200-399', http_keyword: '',
    tls_verify: false, cert_check: true, cert_days: '30,14,7', channels: [], ...(preset || {}) };
  let dockerHosts = [];
  try { dockerHosts = await get('/docker/hosts'); } catch { /* none or no right */ }
  const TYPES = ['http', 'tcp', 'ping', 'docker', 'mysql', 'postgres', 'redis'];
  const DBT = ['mysql', 'postgres', 'redis'];
  const DEF_PORT = { mysql: 3306, postgres: 5432, redis: 6379 };
  const typeSel = select('type', TYPES.map((x) => [x, t(`mon.type.${x}`)]), v.type);
  const target = input('target', v.target || '', { required: true, class: 'mono', placeholder: 'https://intranet.firma.local/', list: 'dl-containers' });
  const targetLabel = h('span', {}, t('mon.f.target'));
  const port = input('port', v.port || '', { type: 'number', min: 1, max: 65535, class: 'mono' });
  const portBox = h('div', {}, field(t('mon.f.port'), port));
  // Docker: host + container (names offered from the host)
  const containers = h('datalist', { id: 'dl-containers' });
  const hostSel = select('docker_host_id', [['', t('mon.f.chooseHost')], ...dockerHosts.map((x) => [String(x.id), x.name])], v.docker_host_id ? String(v.docker_host_id) : (dockerHosts.length === 1 ? String(dockerHosts[0].id) : ''));
  const containerHint = h('span', { class: 'hint' });
  async function loadContainers() {
    mount(containers);
    containerHint.textContent = '';
    if (!hostSel.value || typeSel.value !== 'docker') return;
    try {
      const r = await get(`/docker/hosts/${hostSel.value}/containers`);
      mount(containers, r.containers.map((c) => h('option', { value: c.name }, `${c.state} · ${c.image}`)));
      containerHint.textContent = t('mon.f.containersFound', { n: r.containers.length, version: r.version });
    } catch (e) { containerHint.textContent = e.message; }
  }
  hostSel.addEventListener('change', loadContainers);
  const dockerBox = h('div', { class: 'form-grid full' },
    dockerHosts.length ? field(t('mon.f.dockerHost'), hostSel, containerHint)
      : h('p', { class: 'full muted small' }, state.user.isAdmin ? t('mon.f.noDockerAdmin') : t('mon.f.noDocker')));
  // Databases: login (password is never shown again)
  const o = v.options || {};
  const pw = input('password', '', { type: 'password', autocomplete: 'new-password', placeholder: v.has_password ? '••••••' : '' });
  const dbName = field(t('mon.f.database'), input('database', o.database || '', { maxlength: 120, class: 'mono' }), t('mon.f.databaseHint'));
  const dbBox = h('div', { class: 'form-grid full' },
    field(t('mon.f.dbUser'), input('db_user', o.user || '', { maxlength: 120, autocomplete: 'off', class: 'mono' }), t('mon.f.dbUserHint')),
    field(t('mon.f.dbPassword'), pw, v.has_password ? t('mon.f.dbPasswordSet') : null),
    dbName,
    field(t('mon.f.dbTls'), h('input', { type: 'checkbox', name: 'db_tls', checked: !!o.tls })),
    h('p', { class: 'full muted small', style: { margin: 0 } }, t('mon.f.dbHint')));
  const httpBox = h('div', { class: 'form-grid full' },
    field(t('mon.f.status'), input('http_status', v.http_status, { class: 'mono' }), t('mon.f.statusHint')),
    field(t('mon.f.keyword'), input('http_keyword', v.http_keyword, { maxlength: 200 }), t('mon.f.keywordHint')),
    h('div', { class: 'full' }, field(t('mon.f.tlsVerify'), h('input', { type: 'checkbox', name: 'tls_verify', checked: !!v.tls_verify }), t('mon.f.tlsVerifyHint'))),
    field(t('mon.f.certCheck'), h('input', { type: 'checkbox', name: 'cert_check', checked: v.cert_check !== false })),
    field(t('mon.f.certDays'), input('cert_days', v.cert_days, { class: 'mono' }), t('mon.f.certDaysHint')));
  const sync = () => {
    const ty = typeSel.value;
    const isDb = DBT.includes(ty);
    portBox.hidden = ty !== 'tcp' && !isDb;
    httpBox.hidden = ty !== 'http';
    dockerBox.hidden = ty !== 'docker';
    dbBox.hidden = !isDb;
    dbName.hidden = ty === 'redis';
    port.required = ty === 'tcp';
    port.placeholder = isDb ? String(DEF_PORT[ty]) : '';
    hostSel.required = ty === 'docker';
    targetLabel.textContent = ty === 'docker' ? t('mon.f.container') : t('mon.f.target');
    target.placeholder = ty === 'http' ? 'https://intranet.firma.local/' : ty === 'docker' ? 'nextcloud' : '192.168.1.10';
    if (ty === 'docker' && !containers.children.length) loadContainers();
  };
  typeSel.addEventListener('change', sync);
  const selected = new Set(v.channels || []);
  const chanBox = chans.length ? h('div', { class: 'full field' }, t('mon.f.channels'),
    h('div', { class: 'chips' }, chans.map((c) => h('label', { class: 'check', style: { marginRight: '14px' } },
      h('input', { type: 'checkbox', name: `ch_${c.id}`, checked: selected.size ? selected.has(c.id) : false }), `${c.name}${c.is_default ? ` (${t('mon.f.default')})` : ''}`))),
    h('span', { class: 'hint' }, t('mon.f.channelsHint')))
    : h('p', { class: 'full muted small' }, state.user.isAdmin ? t('mon.f.noChannelsAdmin') : t('mon.f.noChannels'));
  const form = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('div', { class: 'full' }, field(t('mon.f.name'), input('name', v.name || '', { required: true, maxlength: 120 }))),
    field(t('mon.f.type'), typeSel),
    h('div', {}, h('label', { class: 'field' }, targetLabel, target), containers),
    portBox,
    dockerBox,
    dbBox,
    field(t('mon.f.interval'), input('interval_s', v.interval_s, { type: 'number', min: 20, max: 86400 }), t('mon.f.intervalHint')),
    field(t('mon.f.retries'), input('fail_threshold', v.fail_threshold, { type: 'number', min: 1, max: 10 }), t('mon.f.retriesHint')),
    field(t('mon.f.timeout'), input('timeout_s', v.timeout_s, { type: 'number', min: 1, max: 60 })),
    field(t('mon.f.resend'), input('resend_min', v.resend_min, { type: 'number', min: 0, max: 1440 }), t('mon.f.resendHint')),
    httpBox,
    chanBox);
  sync();
  const dlg = modal(m ? m.name : t('mon.add'), form, { wide: true, actions: [
    btn(t('cancel'), { onclick: () => dlg.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => save() }, t('save')),
  ] });
  async function save() {
    if (!form.reportValidity()) return;
    const d = formData(form);
    const body = { name: d.name, type: d.type, target: d.target.trim(), port: d.port, interval_s: d.interval_s, timeout_s: d.timeout_s,
      fail_threshold: d.fail_threshold, resend_min: d.resend_min, http_status: d.http_status, http_keyword: d.http_keyword,
      tls_verify: d.tls_verify, cert_check: d.cert_check, cert_days: d.cert_days,
      channels: chans.filter((c) => d[`ch_${c.id}`]).map((c) => c.id) };
    if (d.type === 'docker') body.docker_host_id = d.docker_host_id;
    if (DBT.includes(d.type)) {
      body.options = { user: d.db_user, database: d.database, tls: d.db_tls };
      if (d.password) body.password = d.password;
    }
    if (!m && preset?.device_id) body.device_id = preset.device_id;
    try {
      const r = m ? await put(`/monitors/${m.id}`, body) : await post('/monitors', body);
      dlg.close();
      toast(t('saved'));
      if (done) done(r); else navigate(`/monitoring/${r.id}`);
    } catch (e) { fail(e); }
  }
}

// ------------------------------------------------------------------------------------------- maintenance windows
const DAYS = [1, 2, 3, 4, 5, 6, 0];

async function renderMaintenance(main) {
  const edit = state.user.canEdit;
  const [list, monitors] = await Promise.all([get('/maintenance'), get('/monitors')]);
  const reload = () => renderMaintenance(main);
  const names = Object.fromEntries(monitors.map((m) => [m.id, m.name]));
  const when = (w) => (w.kind === 'once'
    ? `${fmtDate(w.starts_at, getLang())} – ${fmtDate(w.ends_at, getLang())}`
    : `${w.weekdays.slice().sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).map((d) => t(`day.${d}`)).join(', ')} · ${w.time_from}–${w.time_to}`);
  mount(main, h('div', { class: 'page' },
    pageHead(t('mon.title'), t('maint.lead'), edit ? btn(t('maint.add'), { class: 'btn btn-primary', onclick: () => maintenanceForm(null, monitors, reload) }, 'plus') : null),
    tabBar('maintenance'),
    h('section', { class: 'panel' }, list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('maint.name')), h('th', {}, t('maint.when')), h('th', {}, t('maint.scope')), h('th', {}))),
      h('tbody', {}, list.map((w) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, w.name), w.enabled ? null : h('span', { class: 'badge', style: { marginLeft: '6px' } }, t('mon.status.paused'))),
        h('td', {}, when(w)),
        h('td', {}, w.monitor_ids.length ? w.monitor_ids.map((i) => names[i] || `#${i}`).join(', ') : t('maint.all')),
        h('td', { class: 'min' }, edit ? h('div', { class: 'actions' },
          btn(t('edit'), { class: 'btn btn-sm', onclick: () => maintenanceForm(w, monitors, reload) }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${w.name}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('maint.deleteConfirm', { name: w.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/maintenance/${w.id}`); reload(); } catch (e) { fail(e); }
          } })) : null))))))
      : h('div', { class: 'empty' }, h('p', {}, t('maint.empty'))))));
}

const localInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function maintenanceForm(w, monitors, done) {
  const v = w || { kind: 'weekly', weekdays: [0], time_from: '22:00', time_to: '02:00', monitor_ids: [], enabled: true };
  const kind = select('kind', [['weekly', t('maint.weekly')], ['once', t('maint.once')]], v.kind);
  const onceBox = h('div', { class: 'form-grid full' },
    field(t('maint.from'), input('starts_at', localInput(v.starts_at), { type: 'datetime-local' })),
    field(t('maint.to'), input('ends_at', localInput(v.ends_at), { type: 'datetime-local' })));
  const weeklyBox = h('div', { class: 'form-grid full' },
    h('div', { class: 'full field' }, t('maint.days'), h('div', { class: 'chips' }, DAYS.map((d) => h('label', { class: 'check', style: { marginRight: '12px' } },
      h('input', { type: 'checkbox', name: `d_${d}`, checked: v.weekdays.includes(d) }), t(`day.${d}`))))),
    field(t('maint.timeFrom'), input('time_from', v.time_from || '', { type: 'time' })),
    field(t('maint.timeTo'), input('time_to', v.time_to || '', { type: 'time' }), t('maint.midnight')));
  const sync = () => { onceBox.hidden = kind.value !== 'once'; weeklyBox.hidden = kind.value !== 'weekly'; };
  kind.addEventListener('change', sync);
  const form = h('form', { class: 'form-grid' },
    h('div', { class: 'full' }, field(t('maint.name'), input('name', v.name || '', { required: true, maxlength: 80, placeholder: t('maint.namePh') }))),
    field(t('maint.kind'), kind),
    field(t('user.active'), h('input', { type: 'checkbox', name: 'enabled', checked: v.enabled !== false })),
    onceBox, weeklyBox,
    monitors.length ? h('div', { class: 'full field' }, t('maint.scope'),
      h('div', { class: 'chips' }, monitors.map((m) => h('label', { class: 'check', style: { marginRight: '12px' } },
        h('input', { type: 'checkbox', name: `m_${m.id}`, checked: v.monitor_ids.includes(m.id) }), m.name))),
      h('span', { class: 'hint' }, t('maint.scopeHint'))) : null);
  sync();
  const dlg = modal(w ? w.name : t('maint.add'), form, { wide: true, actions: [
    btn(t('cancel'), { onclick: () => dlg.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
      if (!form.reportValidity()) return;
      const d = formData(form);
      const body = { name: d.name, kind: d.kind, enabled: d.enabled,
        starts_at: d.starts_at ? new Date(d.starts_at).toISOString() : null, ends_at: d.ends_at ? new Date(d.ends_at).toISOString() : null,
        weekdays: DAYS.filter((x) => d[`d_${x}`]), time_from: d.time_from, time_to: d.time_to,
        monitor_ids: monitors.filter((m) => d[`m_${m.id}`]).map((m) => m.id) };
      try { if (w) await put(`/maintenance/${w.id}`, body); else await post('/maintenance', body); dlg.close(); toast(t('saved')); done(); } catch (e) { fail(e); }
    } }, t('save')),
  ] });
}
