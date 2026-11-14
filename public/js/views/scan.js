// Scan: choose targets, watch the radar, adopt or ignore what was found.
import { h, mount, fmtDate, toast } from '../dom.js';
import { get, post } from '../api.js';
import { t, getLang, reasonText } from '../i18n.js';
import { icon } from '../icons.js';
import { state, navigate, fail, updateBadge } from '../app.js';
import { pageHead, typeChip, select, typeOptions, confidenceBar, portList, btn, TI } from './common.js';
import { selectableRow, canAdopt } from '../scanpick.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const RING = { router: 0, firewall: 0, switch: 0, accesspoint: 0, hypervisor: 1, server: 1, nas: 1, vm: 1, ups: 1, ti_connector: 1, ti_terminal: 2 };

/** Radar with one blip per device: angle from the address, ring from the kind of device. */
function createRadar() {
  const svg = s('svg', { class: 'radar idle', viewBox: '0 0 400 400', role: 'img', 'aria-label': t('scan.radarEmpty') });
  const defs = s('defs');
  const grad = s('linearGradient', { id: 'sweepGrad', x1: '0', y1: '0', x2: '1', y2: '0' });
  grad.append(s('stop', { offset: '0', 'stop-color': '#7DB3EC', 'stop-opacity': '0' }), s('stop', { offset: '1', 'stop-color': '#7DB3EC', 'stop-opacity': '.35' }));
  defs.append(grad);
  svg.append(defs);
  for (const r of [62, 124, 186]) svg.append(s('circle', { class: 'ring', cx: 200, cy: 200, r }));
  svg.append(s('line', { class: 'axis', x1: 200, y1: 10, x2: 200, y2: 390 }), s('line', { class: 'axis', x1: 10, y1: 200, x2: 390, y2: 200 }));
  const sweep = s('g', { class: 'sweep' });
  sweep.append(s('path', { class: 'sweep-wedge', d: 'M200 200 L200 14 A186 186 0 0 1 331.5 68.5 Z' }), s('line', { class: 'sweep-line', x1: 200, y1: 200, x2: 331.5, y2: 68.5 }));
  svg.append(sweep);
  const blips = s('g');
  svg.append(blips, s('circle', { class: 'center', cx: 200, cy: 200, r: 4 }));
  const shown = new Map();
  return {
    el: svg,
    running(on) { svg.classList.toggle('idle', !on); },
    update(results) {
      for (const r of results) {
        const key = r.id;
        const isNew = r.status === 'new' || r.status === 'pending';
        if (shown.has(key)) { shown.get(key).classList.toggle('new', isNew); continue; }
        const cls = `blip${isNew ? ' new' : ''}${TI.has(r.detected_type) ? ' ti' : ''}`;
        const oct = r.ip.split('.').map(Number);
        // Golden angle: neighbouring addresses land far apart, the same address always at the same place
        const angle = (((oct[2] * 256 + oct[3]) * 137.508) % 360) * Math.PI / 180;
        const ring = RING[r.detected_type] ?? 2;
        const radius = 34 + ring * 62 + ((oct[3] * 37) % 46);
        const x = 200 + Math.sin(angle) * radius;
        const y = 200 - Math.cos(angle) * radius;
        const c = s('circle', { class: `${cls} blip-in`, cx: x.toFixed(1), cy: y.toFixed(1), r: 5 });
        const title = s('title');
        title.textContent = `${r.ip} · ${t(`type.${r.detected_type}`)}${r.vendor ? ` · ${r.vendor}` : ''}`;
        c.append(title);
        blips.append(c);
        shown.set(key, c);
      }
      svg.setAttribute('aria-label', `${results.length} · ${t('scan.radarEmpty')}`);
    },
  };
}

function radarPanel(radar) {
  const status = h('div', { class: 'radar-status' }, h('span', {}, t('scan.radarEmpty')), h('b', {}, ''));
  const bar = h('div', { class: 'progress' }, h('div', { style: { width: '0%' } }));
  const panel = h('aside', { class: 'radar-panel' }, radar.el, status, bar,
    h('div', { class: 'radar-legend' },
      h('span', {}, h('i', { style: { background: '#F2B544' } }), t('scan.tab.new')),
      h('span', {}, h('i', { style: { background: '#7DB3EC' } }), t('scan.tab.known')),
      h('span', {}, h('i', { style: { background: '#A99BF5' } }), t('telematik'))));
  return {
    el: panel,
    set(text, count, pct) {
      status.firstChild.textContent = text;
      status.lastChild.textContent = count;
      bar.firstChild.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    },
  };
}

export async function renderScan(main, scanId) {
  if (scanId) return renderResult(main, Number(scanId));
  const [locations, net, scans] = await Promise.all([get('/locations'), get('/network'), get('/scans')]);
  const running = scans.find((x) => x.status === 'running');
  if (running) { navigate(`/scan/${running.id}`, { replace: true }); return null; }
  const edit = state.user.canEdit;
  const cidrs = h('input', { type: 'text', name: 'cidrs', class: 'mono', placeholder: '192.168.1.0/24', 'aria-label': t('scan.adhoc') });
  const usable = locations.filter((l) => l.subnets.length);
  const targets = h('div', { class: 'targets' },
    usable.length ? usable.map((l, i) => h('label', { class: 'target' },
      h('input', { type: 'checkbox', name: 'loc', value: l.id, checked: i === 0 && usable.length === 1 }),
      h('div', {}, h('strong', {}, l.name), h('div', { class: 'cidrs' }, l.subnets.map((x) => x.cidr).join(', ')))))
      : h('p', { class: 'muted' }, t(locations.length ? 'scan.noSubnets' : 'scan.noLocations')));
  if (!usable.length && net.suggestions[0] && !state.user.locations) cidrs.value = net.suggestions[0];

  const radar = createRadar();
  const rp = radarPanel(radar);

  async function start(button) {
    const locationIds = [...targets.querySelectorAll('input[name=loc]:checked')].map((x) => Number(x.value));
    const list = cidrs.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    button.disabled = true;
    try {
      const r = await post('/scans', { locationIds, cidrs: list });
      if (r.agentJobs?.length) toast(t('agent.jobSent', { names: r.agentJobs.join(', ') }));
      if (r.id) navigate(`/scan/${r.id}`); else button.disabled = false;
    } catch (e) { fail(e); button.disabled = false; }
  }

  const history = scans.length ? h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('scan.history')),
    h('div', { class: 'history-list' }, scans.slice(0, 12).map((x) => {
      const n = Object.fromEntries((x.counts || []).map((c) => [c.status, c.n]));
      return h('button', { type: 'button', onclick: () => navigate(`/scan/${x.id}`) },
        h('span', {}, h('strong', {}, x.kind === 'deep' ? t('scan.kind.deep') : x.kind === 'light' ? `${t('scan.kind.light')} · ${x.targets.map((c) => c.cidr).join(', ')}` : x.targets.map((c) => c.cidr).join(', ')),
          h('span', { class: 'muted small', style: { display: 'block' } }, `${fmtDate(x.started_at, getLang())} · ${t(`scan.phase.${x.status === 'running' ? 'discover' : x.status}`)}`)),
        n.new ? h('span', { class: 'badge badge-new' }, `${n.new} ${t('scan.statusNew')}`) : h('span', { class: 'badge' }, x.stats?.probed ?? 0));
    }))) : null;

  mount(main, h('div', { class: 'page' },
    pageHead(t('scan.title'), t('scan.lead')),
    h('div', { class: 'scan-layout' },
      h('div', { class: 'stack' },
        !net.hostNetwork ? h('div', { class: 'note warn' }, t('scan.noHostNet')) : null,
        // Viewers cannot start scans: explain that instead of showing a form they cannot use
        !edit ? h('section', { class: 'panel panel-pad' }, h('p', { class: 'muted', style: { margin: 0 } }, t('scan.viewOnly'))) : h('section', { class: 'panel panel-pad' },
          h('h2', { class: 'section-title' }, t('scan.locations')), targets,
          // Users limited to locations scan only the subnets of their locations
          state.user.locations ? null : [
            h('h2', { class: 'section-title' }, t('scan.adhoc')),
            h('label', { class: 'field' }, cidrs, h('span', { class: 'hint' }, t('scan.adhocHint'))),
            net.suggestions.length ? h('div', { class: 'chips' }, h('span', { class: 'muted small' }, t('scan.suggest')),
              net.suggestions.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => {
                const cur = cidrs.value.split(/[\s,;]+/).filter(Boolean);
                if (!cur.includes(c)) cidrs.value = [...cur, c].join(', ');
              } }, c))) : null],
          h('div', { class: 'actions', style: { marginTop: '18px' } },
            h('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: (e) => start(e.currentTarget) }, h('span', { html: icon('radar') }), t('scan.start')))),
        history),
      rp.el)));
  return null;
}

async function renderResult(main, id) {
  const radar = createRadar();
  const rp = radarPanel(radar);
  const edit = state.user.canEdit;
  let tab = null;
  let tabChosen = false;
  let timer = null;
  let alive = true;
  let data = null;
  const selected = new Set();
  const overrides = {};
  const content = h('section', { class: 'panel' });
  const head = h('div');
  const types = state.meta?.types || [];
  const services = state.meta?.services || {};

  mount(main, h('div', { class: 'page' }, head, h('div', { class: 'scan-layout' }, h('div', { class: 'stack' }, content), rp.el)));
  mount(content, h('div', { class: 'empty' }, t('loading')));

  const suggest = (r) => {
    const host = String(r.hostname || '').split('.')[0];
    if (host) return host;
    if (r.facts?.netbios?.name) return r.facts.netbios.name;
    if (r.facts?.snmp?.name) return r.facts.snmp.name;
    if (r.facts?.classification?.model) return String(r.facts.classification.model).slice(0, 80);
    return `${r.vendor || t(`type.${r.detected_type}`)} .${r.ip.split('.').pop()}`;
  };

  async function load() {
    try { data = await get(`/scans/${id}`); } catch (e) { if (alive) fail(e); return; }
    if (!alive) return;
    const p = data.progress;
    const runningNow = data.status === 'running';
    radar.running(runningNow);
    radar.update(data.results);
    const pct = runningNow ? (p?.phase === 'probe' ? 70 + (p.hosts ? (p.probed / p.hosts) * 30 : 0) : p?.total ? (p.done / p.total) * 70 : 2) : 100;
    rp.set(runningNow ? `${t(`scan.phase.${p?.phase || 'start'}`)} · ${p?.phase === 'probe' ? t('scan.probed', { n: p.probed }) : t('scan.progress', { done: p?.done || 0, total: p?.total || 0 })}`
      : t(`scan.phase.${data.status}`), data.results.length, pct);
    renderHead(runningNow);
    if (!runningNow) {
      clearTimeout(timer);
      timer = null;
      updateBadge();
    }
    renderTabs();
    if (runningNow) timer = setTimeout(load, 1200);
  }

  function renderHead(runningNow) {
    const title = data.kind === 'deep' ? t('scan.kind.deep') : data.kind === 'light' ? t('scan.kind.light') : t('scan.title');
    const lead = `${data.targets.map((x) => x.cidr).join(', ')} · ${fmtDate(data.started_at, getLang())}${data.user ? ` · ${t('scan.by', { user: data.user })}` : ''}`;
    mount(head, pageHead(title, lead,
      runningNow && edit ? btn(t('scan.cancel'), { onclick: async (e) => { e.currentTarget.disabled = true; await post(`/scans/${id}/cancel`).catch(fail); } }, 'stop') : null,
      !runningNow && edit && data.kind !== 'deep' ? h('a', { class: 'btn', href: '/scan', 'data-link': true }, h('span', { html: icon('radar') }), t('scan.title')) : null),
    data.progress && data.progress.pingAvailable === false && runningNow ? h('div', { class: 'note' }, t('scan.noPing')) : null,
    data.error ? h('div', { class: 'note warn' }, data.error) : null);
  }

  function renderTabs() {
    const by = { new: [], changed: [], known: [], ignored: [] };
    for (const r of data.results) (by[r.status] || by.new).push(r);
    for (const k of Object.keys(by)) by[k].sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
    // Until the user picks a tab, show the most useful one (new devices first)
    if (!tabChosen) tab = by.new.some((r) => !r.handled) || data.status === 'running' ? 'new' : by.changed.length ? 'changed' : by.known.length ? 'known' : 'new';
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, ['new', 'changed', 'known', 'ignored'].map((k) => h('button', {
      type: 'button', role: 'tab', class: tab === k ? 'on' : '', 'aria-selected': String(tab === k),
      onclick: () => { tab = k; tabChosen = true; renderTabs(); },
    }, t(`scan.tab.${k}`), h('span', { class: `badge${k === 'new' && by.new.length ? ' badge-new' : ''}` }, by[k].length))));
    const list = by[tab];
    // Only rows of the open tab that can still be acted on stay selected
    const selectable = new Set(tab === 'new' || tab === 'ignored' ? openRows(list, tab).filter((r) => selectableRow(r, tab)).map((r) => r.id) : []);
    for (const rid of [...selected]) if (!selectable.has(rid)) selected.delete(rid);
    mount(content, tabs, tab === 'new' || tab === 'ignored' ? pickTable(list, tab) : otherTable(list));
  }

  /** New: not yet adopted or ignored. Ignored: everything not in the inventory (also what was ignored in this scan). */
  const openRows = (list, mode) => list.filter((r) => (mode === 'ignored' ? !r.device_id : !r.handled));

  /** Table with check boxes - "new" to adopt or ignore, "ignored" to stop ignoring or adopt right away. */
  function pickTable(list, mode) {
    const open = openRows(list, mode);
    if (!open.length) {
      return h('div', { class: 'empty' }, mode === 'ignored' ? t('scan.noIgnored') : data.status === 'running' ? t('scan.radarEmpty') : t('scan.noNew'));
    }
    // Results a newer scan of the subnet has covered can be looked at, but not adopted or ignored - stopping to
    // ignore them still works
    const usable = open.filter((r) => selectableRow(r, mode));
    const count = h('span', { class: 'count' }, t('scan.selected', { n: selected.size }));
    const all = h('input', { type: 'checkbox', 'aria-label': t('scan.selectAll'), checked: selected.size === usable.length && usable.length > 0, disabled: !usable.length,
      onchange: (e) => { usable.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); renderTabs(); } });
    const act = async (what, only = null) => {
      if (!only && !selected.size) return;
      try {
        const body = { ids: only || [...selected], overrides };
        const r = await post(`/scans/${id}/${what}`, body);
        toast(what === 'adopt' ? [`${t('scan.adopted', { n: r.created.length })}${r.watched && r.created.length ? ` - ${t('aw.adopted')}` : ''}`,
          r.skipped?.length ? t('scan.skippedKnown', { n: r.skipped.length }) : '', r.hosts ? t('scan.hostsScriptTip', { n: r.hosts }) : ''].filter(Boolean).join(' · ')
          : what === 'link' ? t('scan.linkedN', { n: r.linked })
          : what === 'unignore' ? t('scan.unignoredN', { n: r.unignored }) : t('scan.ignoredN', { n: r.ignored }));
        if (!only) selected.clear();
        await load();
        updateBadge();
      } catch (e) { fail(e); }
    };
    /** Tip under a row that is probably in the inventory already: assign to it, or add as a new device anyway */
    const maybeTip = (r, o) => {
      if (!r.maybe) return null;
      const link = h('a', { href: `/devices/${r.maybe.id}`, 'data-link': true }, r.maybe.name);
      if (o.force) {
        return h('div', { class: 'scan-tip' }, t('scan.maybeForced'), ' ',
          edit ? h('button', { type: 'button', class: 'link-btn', onclick: () => { o.force = false; renderTabs(); } }, t('scan.maybeUndo')) : null);
      }
      return h('div', { class: 'scan-tip' }, h('span', { html: icon('help') }),
        h('span', {}, t(r.maybe.why === 'ip' ? 'scan.maybeIp' : 'scan.maybeHost', { name: '\u0000' }).split('\u0000').flatMap((x, i) => (i ? [link, x] : [x]))),
        edit && !r.outdated ? h('span', { class: 'scan-tip-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => act('link', [r.id]) }, t('scan.maybeLink')),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { o.force = true; renderTabs(); } }, t('scan.maybeNew'))) : null);
    };
    const adoptBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: !canAdopt(open.filter((r) => selected.has(r.id))), onclick: () => act('adopt') }, h('span', { html: icon('check') }), t('scan.adopt'));
    const outdatedNote = edit && open.some((r) => r.outdated) ? h('div', { class: 'note' }, t(mode === 'ignored' ? 'scan.outdatedHintIgnored' : 'scan.outdatedHint')) : null;
    const bulk = !edit || !usable.length ? null : mode === 'ignored'
      ? h('div', { class: 'bulk' }, count,
        h('span', { class: 'muted small bulk-hint' }, t('scan.unignoreHint')),
        btn(t('scan.unignore'), { onclick: () => act('unignore'), disabled: !selected.size }, 'eye'),
        adoptBtn)
      : h('div', { class: 'bulk' }, count,
        h('span', { class: 'muted small bulk-hint' }, t('scan.adoptHint')),
        btn(t('scan.ignore'), { onclick: () => act('ignore'), disabled: !selected.size }, 'eyeoff'),
        adoptBtn);
    return h('div', {}, outdatedNote, bulk, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, edit ? h('th', { class: 'min' }, all) : null, h('th', {}, t('col.name')), h('th', {}, t('col.type')), h('th', {}, `${t('col.ip')} / ${t('col.mac')}`),
        h('th', { class: 'hide-sm' }, t('col.vendor')), h('th', { class: 'hide-sm hide-md' }, t('col.ports')))),
      h('tbody', {}, open.map((r) => {
        const o = overrides[r.id] || (overrides[r.id] = {});
        // The name shown is the name used - also when the user does not touch it
        if (o.name === undefined) o.name = suggest(r);
        const cb = h('input', { type: 'checkbox', checked: selected.has(r.id), disabled: !selectableRow(r, mode), 'aria-label': r.ip, onchange: (e) => { if (e.target.checked) selected.add(r.id); else selected.delete(r.id); renderTabs(); } });
        const typeSel = select('type', typeOptions(types), o.type || r.detected_type, { class: 'inline', 'aria-label': t('col.type'), onchange: (e) => { o.type = e.target.value; } });
        const name = h('input', { type: 'text', class: 'inline', value: o.name, maxlength: 120, 'aria-label': t('col.name'), oninput: (e) => { o.name = e.target.value; } });
        return h('tr', {},
          edit ? h('td', { class: 'min' }, cb) : null,
          h('td', {}, edit ? name : h('span', { class: 'name' }, suggest(r)), r.hostname ? h('div', { class: 'sub' }, r.hostname) : null, maybeTip(r, o)),
          h('td', {}, edit ? h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, typeSel, r.confidence < 0.45 ? h('span', { class: 'badge badge-new', title: (Array.isArray(r.facts.classification?.reasons) ? r.facts.classification.reasons : []).map(reasonText).join(', ') }, t('unsure')) : confidenceBar(r.confidence))
            : typeChip(r.detected_type)),
          h('td', { class: 'mono' }, r.ip, h('div', { class: 'sub' }, r.mac || '–')),
          h('td', { class: 'hide-sm' }, r.vendor || (r.facts.randomMac ? h('span', { class: 'muted small', title: t('dev.randomMac') }, t('scan.privateMac')) : '–'),
            r.facts.classification?.model ? h('div', { class: 'sub' }, r.facts.classification.model) : null),
          h('td', { class: 'hide-sm hide-md' }, portList(r.facts.ports, services)));
      })))));
  }

  function otherTable(list) {
    if (!list.length) return h('div', { class: 'empty' }, t('scan.noResults'));
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('col.name')), h('th', {}, t('col.type')), h('th', {}, t('col.ip')), h('th', { class: 'hide-sm' }, t('col.mac')),
        h('th', { class: 'hide-sm' }, t('col.vendor')), h('th', {}, t('col.result')))),
      h('tbody', {}, list.map((r) => h('tr', r.device_id ? { class: 'click', onclick: () => navigate(`/devices/${r.device_id}`) } : {},
        h('td', {}, r.device_id ? h('a', { href: `/devices/${r.device_id}`, 'data-link': true, class: 'name' }, r.device_name) : (r.hostname || '–')),
        h('td', {}, typeChip(r.device_type || r.detected_type)),
        h('td', { class: 'mono' }, r.ip),
        h('td', { class: 'mono hide-sm' }, r.mac || '–'),
        h('td', { class: 'hide-sm' }, r.vendor || '–'),
        h('td', {}, h('span', { class: `badge${r.status === 'changed' ? ' badge-new' : r.status === 'known' ? ' badge-ok' : ''}` },
          t(`scan.status${r.status[0].toUpperCase()}${r.status.slice(1)}`))))))));
  }

  await load();
  return () => { alive = false; clearTimeout(timer); timer = null; };
}

function ipNum(ip) {
  return String(ip).split('.').reduce((a, b) => a * 256 + Number(b), 0);
}

