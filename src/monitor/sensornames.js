// Names of sensors after the value they watch ("pve2: Temperatur: NVMe nvme0 Sensor 2") - the same rule as the
// sensor dialog uses. Run once after the update that brought it, so sensors whose value was changed later
// (and kept the old name, e.g. "Temperatur pve2") say again what they watch.
import { TEXTS } from '../../public/js/i18n.js';
import { metricsFor } from './sensors.js';
import { proxmoxMetrics } from '../proxmox.js';
import { nodeTempsInto } from '../hosts.js';

const parse = (s, def) => { try { return JSON.parse(s); } catch { return def; } };
const DONE = 'sensors.namedByValue';
/** "pve2: Temperatur: CPU Core 0"; no prefix when the value already names it ("CPU pve01", not "pve01: CPU pve01") */
export const sensorName = (owner, label) => (owner && !String(label).toLowerCase().includes(String(owner).toLowerCase()) ? `${owner}: ${label}` : label);

/** A text of the interface in a language (German by default, like most stored labels) */
const t = (key, vars = {}, lang = 'de') => String((lang === 'en' ? TEXTS.en : TEXTS.de)[key] ?? TEXTS.de[key] ?? key)
  .replace(/(?<!\{)\{(\w+)\}(?!\})/g, (all, k) => (k in vars ? String(vars[k] ?? '') : all));

/** Label of a device value: "Temperatur: CPU Core 0", "Toner Schwarz (frei)" */
export function deviceValueLabel(x, lang = 'de') {
  const base = t(`sens.m.${x.metric}`, { name: x.name || '' }, lang);
  return x.receptacle ? `${base} (${t('sens.free', {}, lang)})` : base;
}
/** Label of a hypervisor value: "Knoten pve2 online", "CPU pve2" */
export const hostValueLabel = (x, lang = 'de') => t(`px.m.${x.metric}`, { name: x.name || '' }, lang);

/** Renames every sensor (device and hypervisor values) after its value. Returns how many were renamed. */
export function nameSensorsByValue(db) {
  const hosts = new Map(db.prepare('SELECT id, name, data FROM proxmox_hosts').all().map((h) => [h.id, h]));
  const devValues = new Map();
  const hostValues = new Map();
  const update = db.prepare('UPDATE monitors SET name=?, target=?, options=?, updated_at=? WHERE id=?');
  let n = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const m of db.prepare("SELECT m.id, m.name, m.type, m.target, m.options, m.device_id, d.name device_name FROM monitors m LEFT JOIN devices d ON d.id=m.device_id WHERE m.type IN ('sensor','proxmox')").all()) {
      const o = parse(m.options, {});
      let label = ''; let owner = '';
      if (m.type === 'sensor') {
        if (!m.device_name) continue;
        if (!devValues.has(m.device_id)) devValues.set(m.device_id, metricsFor(db, m.device_id));
        const x = devValues.get(m.device_id).find((y) => y.metric === o.metric && String(y.key ?? '') === String(o.key ?? ''));
        label = x ? deviceValueLabel(x) : o.label;
        owner = m.device_name;
      } else {
        const h = hosts.get(Number(o.host));
        if (!h) continue;
        if (!hostValues.has(h.id)) hostValues.set(h.id, proxmoxMetrics(nodeTempsInto(db, parse(h.data, {}))));
        const x = hostValues.get(h.id).find((y) => y.metric === o.metric && String(y.key ?? '') === String(o.key ?? ''));
        label = x ? hostValueLabel(x) : o.label;
        // node values name their node themselves ("RAM pve02"); other values get the host when there are several
        owner = hosts.size > 1 && !/^node/.test(o.metric) && o.metric !== 'storage' ? h.name : '';
      }
      // without a label (value gone, nothing stored) the name stays as it is
      if (!label) continue;
      const name = sensorName(owner, label).slice(0, 120);
      const target = label.slice(0, 200);
      const options = JSON.stringify({ ...o, label: label.slice(0, 120) });
      if (name === m.name && target === m.target && options === m.options) continue;
      n += update.run(name, target, options, now, m.id).changes;
    }
  })();
  return n;
}

/** Once per database (a restored older backup gets it again) */
export function nameSensorsOnce(db, settings) {
  if (settings.get(DONE)) return 0;
  const n = nameSensorsByValue(db);
  settings.set(DONE, true);
  return n;
}
