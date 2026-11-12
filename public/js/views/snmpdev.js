// Switch and NAS panels on the device page, "plugged in at" line, NAS problems on the dashboard.
import { h, mount, fmtDate, fmtAgo } from '../dom.js';
import { post } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { state, fail } from '../app.js';
import { btn } from './common.js';

const fmtBytes = (n) => {
  if (!n && n !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString(getLang() === 'en' ? 'en-GB' : 'de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
};
const stText = (v) => (t(`nas.st.${v}`) !== `nas.st.${v}` ? t(`nas.st.${v}`) : v);
const portLabel = (name) => (/^\d/.test(name) ? `${t('sw.port')} ${name}` : name);
const fmtSpeed = (mbit) => (!mbit ? '' : mbit >= 1000 ? `${mbit / 1000} G` : `${mbit} M`);

function head(title, device, onData) {
  return h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '10px' } },
    h('h2', { class: 'section-title', style: { margin: 0 } }, title),
    state.user.canEdit && device.ip ? btn(t('prn.refresh'), { class: 'btn btn-sm', onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { onData(await post(`/devices/${device.id}/snmp`, {})); } catch (ex) { fail(ex); b.disabled = false; }
    } }, 'refresh') : null);
}

const checked = (s) => h('p', { class: 'muted small', style: { margin: '12px 0 0' } }, `${t('prn.checked')}: ${fmtDate(s.at, getLang())} (${fmtAgo(s.at, t)})`);
const errNote = (s) => (!s.ok ? h('div', { class: 'note warn', style: { marginBottom: '10px' } }, t(`snmp.err.${s.error || 'snmp'}`)) : null);

// ------------------------------------------------------------------------------------------------- switch

export function switchPanel(device) {
  const box = h('section', { class: 'panel panel-pad switch-panel' });
  const detail = h('div', { class: 'port-detail' });

  function showPort(p) {
    mount(detail, h('div', { class: 'port-card' },
      h('div', { class: 'port-card-head' }, h('strong', {}, p.name), p.alias ? h('span', { class: 'muted' }, ` · ${p.alias}`) : null,
        h('span', { class: `badge ${p.status === 'up' ? 'badge-ok' : ''}`, style: { marginLeft: 'auto' } }, `${t(`port.${p.status}`) || p.status}${p.status === 'up' && p.speed ? ` · ${fmtSpeed(p.speed)}bit/s` : ''}`)),
      p.admin === 'down' ? h('p', { class: 'muted small' }, t('port.adminDown')) : null,
      p.inErrors ? h('p', { class: 'small', style: { color: 'var(--bad)' } }, t('port.errors', { n: p.inErrors.toLocaleString() })) : null,
      p.macs.length ? h('ul', { class: 'port-macs' }, p.macs.slice(0, 40).map((m) => h('li', {},
        m.device ? h('a', { href: `/devices/${m.device.id}`, 'data-link': true }, h('span', { html: icon(m.device.type) }), m.device.name) : h('span', { class: 'muted' }, t('port.unknownDevice')),
        h('span', { class: 'mono small muted' }, m.mac), m.vlan ? h('span', { class: 'badge' }, `VLAN ${m.vlan}`) : null)),
      p.macs.length > 40 ? h('li', { class: 'muted small' }, `+ ${p.macs.length - 40}`) : null)
        : h('p', { class: 'muted small', style: { margin: '6px 0 0' } }, t('port.noMacs'))));
  }

  function draw(s) {
    if (!s) { mount(box, head(t('sw.panel'), device, draw), h('p', { class: 'muted', style: { margin: 0 } }, t('prn.none'))); return; }
    const ports = s.ports || [];
    const up = ports.filter((p) => p.status === 'up').length;
    const grid = h('div', { class: 'ports-grid', role: 'list' }, ports.filter((p) => !p.lag).map((p) => h('button', {
      type: 'button', role: 'listitem', class: `port-sq ${p.status === 'up' ? 'up' : p.admin === 'down' ? 'off' : 'down'}${p.macs.length ? ' has' : ''}`,
      title: `${p.name}${p.alias ? ` – ${p.alias}` : ''}: ${p.status}${p.macs.length ? ` · ${p.macs.length} MAC` : ''}`,
      'aria-label': `${p.name}: ${p.status}`,
      onclick: (e) => { box.querySelectorAll('.port-sq.sel').forEach((x) => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); showPort(p); },
    }, h('span', { class: 'num' }, p.name.replace(/^.*?(\d+(?:\/\d+)*)$/, '$1').slice(-5)), p.macs.length ? h('i', {}, p.macs.length) : null)));
    mount(box, head(t('sw.panel'), device, draw), errNote(s),
      h('p', { class: 'muted small', style: { margin: '0 0 10px' } }, t('sw.summary', { up, n: ports.length })),
      grid, detail,
      (s.neighbours || []).length ? [h('h3', { class: 'sub-title' }, t('sw.neighbours')), h('ul', { class: 'port-macs' }, s.neighbours.map((n) => h('li', {},
        h('strong', {}, n.localPort), h('span', {}, `→ ${n.name || '?'}`), n.port ? h('span', { class: 'muted small' }, n.port) : null)))] : null,
      h('dl', { class: 'kv', style: { marginTop: '12px' } },
        s.model ? [h('dt', {}, t('f.model')), h('dd', {}, s.model)] : null,
        s.firmware ? [h('dt', {}, t('sw.firmware')), h('dd', { class: 'mono' }, s.firmware)] : null,
        s.serial ? [h('dt', {}, t('f.serial')), h('dd', { class: 'mono' }, s.serial)] : null,
        s.descr ? [h('dt', {}, t('sw.descr')), h('dd', { class: 'small' }, s.descr)] : null),
      checked(s));
  }
  draw(device.snmp);
  return box;
}

// ---------------------------------------------------------------------------------------------------- NAS

export function nasPanel(device) {
  const box = h('section', { class: 'panel panel-pad nas-panel' });
  const threshold = state.meta?.nasThreshold || 90;
  const okBadge = (v) => (v ? h('span', { class: `badge ${v === 'normal' ? 'badge-ok' : 'badge-bad'}` }, stText(v)) : null);

  function draw(s) {
    if (!s) { mount(box, head(t('nas.panel'), device, draw), h('p', { class: 'muted', style: { margin: 0 } }, t('prn.none'))); return; }
    mount(box, head(t('nas.panel'), device, draw), errNote(s),
      (s.volumes || []).length ? h('div', { class: 'supplies' }, s.volumes.map((v) => h('div', { class: `supply${v.pct >= threshold ? ' low' : ''}`, 'data-color': 'other' },
        h('div', { class: 'supply-head' }, h('span', { class: 'supply-name mono' }, v.name), h('span', { class: 'supply-val mono' }, `${fmtBytes(v.used)} / ${fmtBytes(v.size)} · ${v.pct} %`)),
        h('div', { class: 'supply-track', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': v.pct, 'aria-label': v.name },
          h('i', { style: { width: `${v.pct}%` } }))))) : null,
      (s.raids || []).length ? [h('h3', { class: 'sub-title' }, t('nas.raids')), h('ul', { class: 'port-macs' }, s.raids.map((r) => h('li', {},
        h('strong', {}, r.name), okBadge(r.status === 'normal' ? 'normal' : r.status),
        r.total ? h('span', { class: 'muted small' }, t('nas.free', { free: fmtBytes(r.free), total: fmtBytes(r.total) })) : null)))] : null,
      (s.disks || []).length ? [h('h3', { class: 'sub-title' }, t('nas.disks')), h('ul', { class: 'port-macs' }, s.disks.map((d) => h('li', {},
        h('strong', {}, d.name), okBadge(d.bad ? d.status : 'normal'), h('span', { class: 'muted small' }, [d.model, d.temp ? `${d.temp} °C` : ''].filter(Boolean).join(' · ')))))] : null,
      h('dl', { class: 'kv', style: { marginTop: '12px' } },
        s.model ? [h('dt', {}, t('f.model')), h('dd', {}, s.model)] : null,
        s.version ? [h('dt', {}, t('nas.version')), h('dd', {}, s.version, s.upgrade ? h('span', { class: 'badge badge-new', style: { marginLeft: '8px' } }, t('nas.upgrade')) : null)] : null,
        s.temp ? [h('dt', {}, t('nas.temp')), h('dd', {}, `${s.temp} °C`)] : null,
        s.system ? [h('dt', {}, t('nas.system')), h('dd', {}, okBadge(s.system))] : null,
        s.power ? [h('dt', {}, t('nas.power')), h('dd', {}, okBadge(s.power))] : null,
        s.fan ? [h('dt', {}, t('nas.fan')), h('dd', {}, okBadge(s.fan))] : null,
        s.serial ? [h('dt', {}, t('f.serial')), h('dd', { class: 'mono' }, s.serial)] : null),
      checked(s));
  }
  draw(device.snmp);
  return box;
}

/** "Plugged in at switch X, port Y" for the detection panel */
export function pluggedLine(p) {
  if (!p) return null;
  return [h('dt', {}, t('sw.plugged')), h('dd', {},
    h('a', { href: `/devices/${p.switchId}`, 'data-link': true }, p.switchName), ` · ${portLabel(p.port)}`, p.vlan && p.vlan !== 1 ? ` · VLAN ${p.vlan}` : '',
    p.macsOnPort > 3 ? h('span', { class: 'muted small', style: { display: 'block' } }, t('sw.pluggedUplink', { n: p.macsOnPort })) : null)];
}

export function nasProblemsPanel(list) {
  if (!list?.length) return null;
  return h('section', { class: 'panel' },
    h('h2', {}, t('nas.problems')),
    h('ul', { class: 'feed' }, list.map((p) => h('li', {},
      h('a', { href: `/devices/${p.deviceId}`, 'data-link': true }, p.device),
      h('span', { class: 'badge badge-bad', style: { justifySelf: 'end' } }, t(`nas.k.${p.kind}`)),
      h('span', { class: 'what' }, p.kind === 'volume' ? t('nas.volumeFull', { name: p.name, pct: p.pct }) : [p.name, p.status ? stText(p.status) : ''].filter(Boolean).join(': '))))));
}
