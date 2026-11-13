// What the management chip (iDRAC, iLO, XClarity …) says about its server: overall health, power, fans, temperatures,
// power supplies, RAID controller, volumes and drives. Shown on the page "Server hardware" and on the device page.
import { h, fmtDate } from '../dom.js';
import { t, getLang } from '../i18n.js';

const TONE = { ok: 'ok', warning: 'new', critical: 'bad', unknown: '' };
const badge = (health) => h('span', { class: `badge ${TONE[health] ? `badge-${TONE[health]}` : ''}` }, t(`hw.h.${health || 'unknown'}`));
const bytes = (n) => { if (!n) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; let v = n; while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; } return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`; };
const table = (head, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
  h('thead', {}, h('tr', {}, head.map(([text, cls]) => h('th', { class: cls || '' }, text)))), h('tbody', {}, rows)));

/** Problems first: what is not OK, in one line each */
function problems(d) {
  const out = [];
  const add = (what, x) => { if (x.health === 'warning' || x.health === 'critical') out.push([x.health, `${what}: ${x.name}`]); };
  for (const f of d.fans || []) add(t('hw.fan'), f);
  for (const p of d.psus || []) add(t('hw.psu'), p);
  for (const s of d.temps || []) if (s.health === 'warning' || s.health === 'critical' || (s.warn && s.c >= s.warn)) out.push([s.crit && s.c >= s.crit ? 'critical' : 'warning', `${t('hw.temp')}: ${s.name} ${s.c} °C`]);
  for (const x of d.drives || []) { add(t('hw.drive'), { ...x, health: x.failurePredicted && x.health === 'ok' ? 'warning' : x.health }); }
  for (const v of d.volumes || []) add(t('hw.volume'), v);
  return out;
}

export function hardwareDetail(d, { inventory = false } = {}) {
  if (!d || d.kind !== 'redfish') return null;
  const issues = problems(d);
  const sub = (text) => h('h3', { class: 'sub-title' }, text);
  return h('div', { class: 'hw' },
    h('div', { class: 'ups-state' }, h('span', { class: 'muted small' }, t('hw.overall')), badge(d.health), h('span', { class: `badge ${d.power === 'on' ? 'badge-ok' : 'badge-bad'}` }, d.power === 'on' ? t('hw.powerOn') : d.power === 'off' ? t('hw.powerOff') : d.power),
      d.watts !== null && d.watts !== undefined ? h('span', { class: 'muted small' }, t('hw.watts', { n: d.watts })) : null,
      // On the hardware page: which inventory entry this server is (found by MAC addresses or serial number)
      inventory ? (d.deviceId ? h('a', { href: `/devices/${d.deviceId}`, 'data-link': true, class: 'small' }, t('hw.toDevice'))
        : h('span', { class: 'badge', title: t('hw.notInInventoryHint') }, t('net.notInInventory'))) : null),
    issues.length ? h('ul', { class: 'ev-list', style: { marginBottom: '10px' } }, issues.map(([hl, text]) => h('li', {}, badge(hl), h('span', {}, text)))) : null,
    h('dl', { class: 'kv' },
      [h('dt', {}, t('host.model')), h('dd', {}, [d.vendor, d.model].filter(Boolean).join(' ') || '–')],
      d.sku || d.serial ? [h('dt', {}, t('f.serial')), h('dd', { class: 'mono' }, [d.sku, d.serial].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · '))] : null,
      d.bios ? [h('dt', {}, t('host.bios')), h('dd', {}, d.bios)] : null,
      d.cpuModel ? [h('dt', {}, t('host.cpu')), h('dd', {}, `${d.cpus > 1 ? `${d.cpus} × ` : ''}${d.cpuModel}`)] : null,
      d.memGiB ? [h('dt', {}, t('host.ram')), h('dd', {}, `${d.memGiB} GiB`)] : null,
      d.bmc ? [h('dt', {}, t('hw.bmc')), h('dd', {}, [d.bmc.model, d.bmc.firmware].filter(Boolean).join(' · '))] : null),
    (d.fans || []).length ? [sub(t('hw.fans')), h('ul', { class: 'ev-list' }, d.fans.map((f) => h('li', {}, badge(f.health), h('span', {}, f.name),
      h('span', { class: 'muted small mono' }, f.rpm ? `${f.rpm} RPM` : f.pct !== null && f.pct !== undefined ? `${f.pct} %` : ''))))] : null,
    (d.temps || []).length ? [sub(t('hw.temps')), table([[t('hw.sensor')], [t('host.temp'), 'num'], [t('hw.limit'), 'num hide-sm']], d.temps.map((s) => h('tr', {},
      h('td', {}, s.name), h('td', { class: `num${s.warn && s.c >= s.warn ? ' tone-bad' : ''}` }, `${s.c} °C`), h('td', { class: 'num hide-sm muted' }, s.warn ? `${s.warn} °C` : '–'))))] : null,
    (d.psus || []).length ? [sub(t('hw.psus')), h('ul', { class: 'ev-list' }, d.psus.map((p) => h('li', {}, badge(p.health), h('span', {}, p.name),
      h('span', { class: 'muted small' }, [p.model, p.capacity ? `${p.capacity} W` : '', p.output ? t('hw.output', { n: p.output }) : ''].filter(Boolean).join(' · ')))))] : null,
    (d.controllers || []).length || (d.volumes || []).length ? [sub(t('hw.storage')),
      h('ul', { class: 'ev-list' }, (d.controllers || []).map((c) => h('li', {}, badge(c.health), h('span', {}, c.model || c.name), h('span', { class: 'muted small' }, c.firmware ? `Firmware ${c.firmware}` : ''))),
        (d.volumes || []).map((v) => h('li', {}, badge(v.health), h('span', {}, v.name), h('span', { class: 'muted small' }, [v.raid, bytes(v.size)].filter(Boolean).join(' · ')))))] : null,
    (d.drives || []).length ? [sub(t('hw.drives')), table([[t('host.disk')], [t('host.state')], [t('host.size'), 'num'], [t('hw.life'), 'num hide-sm']], d.drives.map((x) => h('tr', {},
      h('td', {}, h('span', { class: 'name' }, x.model || x.name), h('span', { class: 'muted small mono', style: { display: 'block' } }, [x.name, x.media, x.protocol, x.serial].filter(Boolean).join(' · '))),
      h('td', {}, badge(x.failurePredicted && x.health === 'ok' ? 'warning' : x.health), x.failurePredicted ? h('span', { class: 'muted small', style: { display: 'block' } }, t('hw.predicted')) : null),
      h('td', { class: 'num' }, bytes(x.size)), h('td', { class: 'num hide-sm' }, x.life !== null && x.life !== undefined ? `${x.life} %` : '–'))))] : null);
}

/** Device page: the hardware of this server, when a management chip is connected */
export function hardwarePanel(hw) {
  if (!hw) return null;
  return h('section', { class: 'panel panel-pad' },
    h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '8px' } },
      h('h2', { class: 'section-title', style: { margin: 0 } }, t('hw.panel')),
      h('a', { href: '/hardware', 'data-link': true, class: 'muted small' }, hw.last_at ? `${hw.name} · ${fmtDate(hw.last_at, getLang())}` : hw.name)),
    hw.last_ok ? null : h('div', { class: 'note warn' }, hw.last_error),
    hardwareDetail(hw.data));
}
