// Windows/Linux machines (and Hyper-V/KVM hosts) that report by a small script: the script dialog with download,
// how to run it and how to remove it again; the "System" panel of a device; the settings page for shared scripts.
import { h, mount, toast, modal, confirmDialog, fmtDate, fmtAgo } from '../dom.js';
import { get, post, del } from '../api.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { fail } from '../app.js';
import { field, input, select, btn } from './common.js';

// Text with `code` and **bold** → nodes (no HTML from translations)
const rich = (text) => String(text).split('`').flatMap((part, i) => (i % 2 ? [h('code', {}, part)]
  : part.split('**').map((x, j) => (j % 2 ? h('strong', {}, x) : x))));
const isPs = (file) => /\.ps1$/.test(file);

/** Offers a text file for download (Windows scripts with CRLF, so Notepad and PowerShell 5 read them well) */
export function download(file, text) {
  const body = isPs(file) ? text.replace(/\r?\n/g, '\r\n') : text;
  const a = h('a', { href: URL.createObjectURL(new Blob([isPs(file) ? '﻿' : '', body], { type: 'text/plain' })), download: file });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const copyBtn = (text) => btn(t('agent.copy'), { class: 'btn btn-sm', onclick: async () => {
  try { await navigator.clipboard.writeText(text); toast(t('agent.copied')); } catch { /* not allowed */ }
} });
const cmd = (line) => h('div', { class: 'cmd-box' }, h('pre', { class: 'mono' }, line), copyBtn(line));
/** How to start a script once: the first call sets it up, then it runs on its own */
export const runLine = (file) => (isPs(file) ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\${file}` : `sh ${file}`);

/**
 * Script with key, shown once: download, run it once (it sets itself up), how to remove it again.
 * r: { script: { file, text }, uninstall: { file, text } }; where: 'host' | 'hyperv' | 'libvirt'.
 */
export function scriptDialog(title, r, { where = 'host', onClose } = {}) {
  const s = r.script; const u = r.uninstall;
  const ps = isPs(s.file);
  const m = modal(title, h('div', { class: 'form' },
    h('p', { class: 'note warn', style: { margin: 0 } }, t('hs.once')),
    h('ol', { class: 'px-steps' },
      h('li', {}, rich(t(ps ? 'hs.get.win' : 'hs.get.lnx', { file: s.file })),
        h('div', { class: 'actions', style: { marginTop: '6px' } }, btn(t('virt.download'), { class: 'btn btn-sm btn-primary', onclick: () => download(s.file, s.text) }, 'download'))),
      h('li', {}, rich(t(ps ? 'hs.run.win' : 'hs.run.lnx')), cmd(runLine(s.file)), h('p', { class: 'muted small', style: { margin: '6px 0 0' } }, rich(t(ps ? 'hs.dist.win' : 'hs.dist.lnx')))),
      h('li', {}, rich(t(where === 'host' ? 'hs.then.host' : 'virt.run3')))),
    h('details', { class: 'cert-manual' }, h('summary', {}, t('hs.remove')),
      h('p', { class: 'small' }, rich(t('hs.removeText', { file: u.file }))),
      h('div', { class: 'actions' }, btn(t('hs.downloadUninstall'), { class: 'btn btn-sm', onclick: () => download(u.file, u.text) }, 'download')),
      cmd(runLine(u.file))),
    h('details', { class: 'cert-manual' }, h('summary', {}, t('virt.showScript')), h('pre', { class: 'code wrap', style: { maxHeight: '260px', overflow: 'auto' } }, s.text))),
  { wide: true, onClose, actions: [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => m.close() }, t('virt.done'))] });
}

/** Device page: "Monitor with script" - choose Windows/Linux, get the script with the key of this device */
export async function openHostScript(d, reload) {
  const guess = /linux|ubuntu|debian|centos|rhel|red hat|suse|alma|rocky|alpine/i.test(d.os || '') ? 'linux' : 'windows';
  const os = select('os', [['windows', 'Windows'], ['linux', 'Linux']], d.hostScript?.os || guess);
  const form = h('form', { class: 'form' },
    h('p', { style: { margin: 0 } }, t('hs.lead')),
    field(t('hs.os'), os),
    d.hostScript ? h('p', { class: 'note warn', style: { margin: 0 } }, t('hs.replace')) : null);
  const m = modal(`${t('hs.title')}: ${d.name}`, form, { actions: [
    btn(t('cancel'), { onclick: () => m.close() }),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await post('/hosts', { os: os.value, device_id: d.id, server: location.origin });
        m.close();
        scriptDialog(`${t('hs.title')}: ${d.name}`, r, { onClose: reload });
      } catch (ex) { fail(ex); e.currentTarget.disabled = false; }
    } }, t('hs.create'))] });
}

const bytes = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; let v = Number(n) || 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`; };
const meter = (label, p, sub) => h('div', { class: `supply${p >= 90 ? ' low' : ''}`, 'data-color': 'other' },
  h('div', { class: 'supply-head' }, h('span', { class: 'supply-name mono' }, label), h('span', { class: 'supply-val mono' }, `${sub ? `${sub} · ` : ''}${p ?? '–'} %`)),
  h('div', { class: 'supply-track' }, h('i', { style: { width: `${p || 0}%` } })));
const uptime = (s) => { const hrs = Math.floor((s || 0) / 3600); return hrs >= 48 ? t('val.days', { n: Math.floor(hrs / 24) }) : t('val.hours', { n: hrs }); };

/** "System" panel of a device whose script reports: load, drives, services */
export function systemPanel(x) {
  const failed = (x.services || []).filter((s) => s.failed);
  const running = (x.services || []).filter((s) => s.state === 'running').length;
  return h('section', { class: 'panel panel-pad' },
    h('div', { class: 'panel-head', style: { padding: 0, marginBottom: '8px' } }, h('h2', { class: 'section-title', style: { margin: 0 } }, t('hs.system')),
      x.stale ? h('span', { class: 'badge badge-bad' }, t('hs.silent', { when: fmtAgo(x.at, t) })) : h('span', { class: 'muted small', title: fmtDate(x.at, getLang()) }, t('hs.reported', { when: fmtAgo(x.at, t) }))),
    h('dl', { class: 'kv', style: { marginBottom: '12px' } },
      x.os ? [h('dt', {}, t('f.os')), h('dd', {}, x.os)] : null,
      h('dt', {}, t('hs.uptime')), h('dd', {}, uptime(x.uptime))),
    h('div', { class: 'supplies' },
      meter('CPU', x.cpu),
      meter('RAM', x.mem, x.memTotal ? `${bytes(x.memUsed)} / ${bytes(x.memTotal)}` : ''),
      (x.disks || []).map((dk) => meter(dk.label ? `${dk.name} ${dk.label}` : dk.name, dk.pct, `${bytes(dk.used)} / ${bytes(dk.total)}`))),
    (x.services || []).length ? [h('h3', { class: 'sub-title' }, t('hs.services')),
      failed.length ? h('ul', { class: 'port-macs' }, failed.map((s) => h('li', {}, h('span', { class: 'badge badge-bad' }, t('val.state.failed')), h('span', {}, s.display || s.name), h('span', { class: 'muted small mono' }, s.name))))
        : h('p', { class: 'muted small', style: { margin: 0 } }, t('hs.servicesOk', { n: running }))] : null);
}

/** Settings → Host scripts: shared scripts for many machines, scripts of single devices, unknown machines */
export async function hostScriptsSettings(body, reload) {
  const { tokens, unmatched } = await get('/hosts');
  const addShared = () => {
    const name = input('name', '', { required: true, maxlength: 80, placeholder: t('hs.sharedPh') });
    const os = select('os', [['windows', 'Windows'], ['linux', 'Linux']], 'windows');
    const form = h('form', { class: 'form' }, h('p', { style: { margin: 0 } }, t('hs.sharedLead')), field(t('px.name'), name), field(t('hs.os'), os));
    const m = modal(t('hs.addShared'), form, { actions: [
      btn(t('cancel'), { onclick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: async (e) => {
        if (!form.reportValidity()) return;
        e.currentTarget.disabled = true;
        try { const r = await post('/hosts', { name: name.value, os: os.value, server: location.origin }); m.close(); scriptDialog(r.name, r, { onClose: reload }); } catch (ex) { fail(ex); e.currentTarget.disabled = false; }
      } }, t('hs.create'))] });
  };
  const uninstall = async (kind) => { try { const u = await get(`/hosts/uninstall/${kind}`); download(u.file, u.text); } catch (ex) { fail(ex); } };
  mount(body, h('section', { class: 'panel' },
    h('div', { class: 'panel-head', style: { paddingBottom: '12px', flexWrap: 'wrap' } }, h('h2', {}, t('set.hostscripts')), btn(t('hs.addShared'), { class: 'btn btn-primary', onclick: addShared }, 'plus')),
    h('p', { class: 'muted', style: { padding: '0 20px' } }, t('hs.settingsLead')),
    tokens.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, t('px.name')), h('th', {}, t('hs.os')), h('th', {}, t('hs.for')), h('th', { class: 'hide-sm' }, t('hs.last')), h('th', {}))),
      h('tbody', {}, tokens.map((x) => h('tr', {},
        h('td', {}, h('span', { class: 'name' }, x.name)),
        h('td', {}, x.os === 'linux' ? 'Linux' : 'Windows'),
        h('td', {}, x.device_id ? h('a', { href: `/devices/${x.device_id}`, 'data-link': true }, x.device_name) : t('hs.shared')),
        h('td', { class: 'hide-sm' }, x.last_used ? `${fmtAgo(x.last_used, t)} · ${t('hs.count', { n: x.reports })}` : t('hs.never')),
        h('td', { class: 'min' }, h('div', { class: 'actions' },
          btn(t('virt.newScript'), { class: 'btn btn-sm btn-ghost', onclick: async () => {
            if (!await confirmDialog(t('virt.newScript'), t('virt.newScriptConfirm'), t('virt.newScript'), t('cancel'))) return;
            try { const r = await post(`/hosts/${x.id}/renew`, { server: location.origin }); scriptDialog(r.name, r, { onClose: reload }); } catch (ex) { fail(ex); }
          } }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${t('delete')}: ${x.name}`, html: icon('trash'), onclick: async () => {
            if (!await confirmDialog(t('delete'), t('hs.deleteConfirm', { name: x.name }), t('delete'), t('cancel'), { danger: true })) return;
            try { await del(`/hosts/${x.id}`); toast(t('deleted')); reload(); } catch (ex) { fail(ex); }
          } }))))))))
      : h('p', { class: 'panel-pad muted', style: { margin: 0 } }, t('hs.none'))),
  unmatched.length ? h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('hs.unknown')),
    h('p', { class: 'muted small', style: { marginTop: 0 } }, t('hs.unknownLead')),
    h('ul', { class: 'port-macs' }, unmatched.map((u) => h('li', {}, h('strong', {}, u.hostname), h('span', { class: 'mono small' }, u.ip || ''),
      h('span', { class: 'muted small' }, [u.os, fmtAgo(u.at, t)].filter(Boolean).join(' · ')),
      btn(t('hs.forget'), { class: 'btn btn-sm btn-ghost', onclick: async () => { try { await del(`/hosts/unmatched/${encodeURIComponent(u.hostname)}`); reload(); } catch (ex) { fail(ex); } } }))))) : null,
  h('section', { class: 'panel panel-pad' },
    h('h2', { class: 'section-title' }, t('hs.remove')),
    h('p', { class: 'muted small', style: { marginTop: 0 } }, t('hs.removeLead')),
    h('div', { class: 'actions' }, [['windows', 'Windows'], ['linux', 'Linux'], ['hyperv', 'Hyper-V'], ['libvirt', 'KVM']].map(([k, label]) =>
      btn(label, { class: 'btn btn-sm', onclick: () => uninstall(k) }, 'download')))));
}
