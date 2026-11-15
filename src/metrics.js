// Prometheus and Grafana: GET /metrics gives the state of every monitor and sensor in the text format of Prometheus,
// for a scrape with a key ("Authorization: Bearer womn_…"). Keys are made by administrators (Settings → Interface),
// shown once and kept only as a SHA-256 hash; they only read the metrics, nothing else of the API. Without a key the
// endpoint does not exist (404). A ready dashboard for Grafana comes with it.
import crypto from 'node:crypto';
import { HttpError, line } from './lib/http.js';

const KEY = 'api.tokens';
const MAX_TOKENS = 20;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function createApiTokens({ settings }) {
  const lastUsed = new Map();   // in memory only: a scrape every 15 s must not write the database
  const all = () => { const v = settings.get(KEY); return Array.isArray(v) ? v : []; };
  return {
    list: () => all().map(({ id, name, created_at: at, prefix }) => ({ id, name, created_at: at, prefix, last_used: lastUsed.get(id) || null })),
    create(name, user) {
      const n = line(name, 60);
      if (!n) throw new HttpError(400, 'err.nameRequired', undefined, 'name');
      const list = all();
      if (list.length >= MAX_TOKENS) throw new HttpError(400, 'err.tooManyTokens');
      const token = `womn_${crypto.randomBytes(32).toString('base64url')}`;
      const entry = { id: crypto.randomUUID(), name: n, hash: hash(token), prefix: token.slice(0, 9), created_at: new Date().toISOString(), created_by: line(user, 80) };
      settings.set(KEY, [...list, entry]);
      return { id: entry.id, name: n, token };
    },
    remove(id) {
      const list = all();
      if (!list.some((x) => x.id === id)) throw new HttpError(404, 'err.notFound');
      settings.set(KEY, list.filter((x) => x.id !== id));
      lastUsed.delete(id);
    },
    /** The key of a request (Bearer) → its entry, or null */
    check(header) {
      const m = /^Bearer\s+(womn_[A-Za-z0-9_-]{20,100})\s*$/.exec(String(header || ''));
      if (!m) return null;
      const h = Buffer.from(hash(m[1]), 'hex');
      for (const x of all()) {
        const k = Buffer.from(String(x.hash || ''), 'hex');
        if (k.length === h.length && crypto.timingSafeEqual(k, h)) { lastUsed.set(x.id, new Date().toISOString()); return x; }
      }
      return null;
    },
    any: () => all().length > 0,
  };
}

// ---------------------------------------------------------------------------------------------- text format
const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labels = (o) => `{${Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`;
const fmt = (n) => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : null);
const DAYS_LEFT = '(womn_cert_expiry_timestamp_seconds - time()) / 86400';
const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
// Monitors that measure a value (the value is the thing to graph, not a response time)
const VALUE_TYPES = new Set(['sensor', 'snmp', 'proxmox']);

/** All metrics as Prometheus text (exposition format 0.0.4) */
export function renderMetrics(db, { version, role = 'master', now = Date.now() } = {}) {
  const out = [];
  const family = (name, type, help, rows) => {
    if (!rows.length) return;
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [l, v] of rows) { const s = fmt(v); if (s !== null) out.push(`${name}${labels(l)} ${s}`); }
  };
  const mons = db.prepare(`SELECT m.id, m.name, m.type, m.target, m.port, m.status, m.status_since, m.enabled, m.last_ms, m.data, m.options, m.cert_valid_to, d.name device
    FROM monitors m LEFT JOIN devices d ON d.id = m.device_id ORDER BY m.id`).all();
  const base = (m) => ({ id: m.id, name: m.name, type: m.type, target: m.type === 'tcp' || (m.port && !VALUE_TYPES.has(m.type)) ? `${m.target}:${m.port}` : m.target, device: m.device || undefined });
  family('womn_info', 'gauge', 'WhatsOnMyNet version and role of this installation.', [[{ version, role }, 1]]);
  const active = mons.filter((m) => m.enabled && (m.status === 'up' || m.status === 'down'));
  family('womn_monitor_up', 'gauge', 'Monitor or sensor fine (1) or down (0); paused and new ones are left out.', active.map((m) => [base(m), m.status === 'up' ? 1 : 0]));
  family('womn_monitor_state', 'gauge', 'State of every monitor and sensor as a label (up, down, pending, paused).',
    mons.map((m) => [{ ...base(m), state: m.enabled ? m.status || 'pending' : 'paused' }, 1]));
  family('womn_monitor_down_seconds', 'gauge', 'Seconds since a monitor went down.',
    active.filter((m) => m.status === 'down' && m.status_since).map((m) => [base(m), Math.max(0, (now - Date.parse(m.status_since)) / 1000)]));
  family('womn_monitor_response_seconds', 'gauge', 'Last response time in seconds (web, port, ping, databases …).',
    active.filter((m) => !VALUE_TYPES.has(m.type) && m.type !== 'event' && m.status === 'up' && m.last_ms !== null).map((m) => [base(m), m.last_ms / 1000]));
  family('womn_sensor_value', 'gauge', 'Last value of a sensor (with its unit and alarm limit as labels).',
    active.filter((m) => VALUE_TYPES.has(m.type)).map((m) => {
      const d = parse(m.data);
      const v = typeof d.v === 'number' ? d.v : m.last_ms;
      return [{ ...base(m), metric: parse(m.options).metric || '', unit: d.unit || '', limit: d.threshold === '' ? undefined : d.threshold }, v];
    }).filter(([, v]) => typeof v === 'number'));
  family('womn_cert_expiry_timestamp_seconds', 'gauge', 'When the certificate a monitor sees expires (Unix time).',
    mons.filter((m) => m.enabled && m.cert_valid_to).map((m) => [base(m), Date.parse(m.cert_valid_to) / 1000]));
  const count = (sql) => db.prepare(sql).get().n;
  family('womn_devices', 'gauge', 'Devices in the inventory.', [[{}, count('SELECT COUNT(*) n FROM devices')]]);
  try {
    family('womn_events_stored', 'gauge', 'Messages (SNMP traps, syslog) kept, by kind.',
      db.prepare('SELECT kind, COUNT(*) n FROM events_in GROUP BY kind').all().map((r) => [{ kind: r.kind }, r.n]));
  } catch { /* older database without messages */ }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------- Grafana dashboard
/** A dashboard for Grafana (import → choose the Prometheus data source). Titles in the language asked for. */
export function grafanaDashboard(lang = 'de') {
  const de = lang !== 'en';
  const T = (d, e) => (de ? d : e);
  const ds = { type: 'prometheus', uid: '${DS_PROMETHEUS}' };
  const target = (expr, legend = '', extra = {}) => ({ datasource: ds, expr, legendFormat: legend, refId: 'A', ...extra });
  let id = 0;
  const panel = (type, title, gridPos, targets, extra = {}) => ({ id: ++id, type, title, gridPos, datasource: ds, targets, ...extra });
  const typeFilter = 'type=~"$type"';
  return {
    __inputs: [{ name: 'DS_PROMETHEUS', label: 'Prometheus', type: 'datasource', pluginId: 'prometheus', pluginName: 'Prometheus' }],
    __requires: [{ type: 'grafana', id: 'grafana', name: 'Grafana', version: '10.0.0' }, { type: 'datasource', id: 'prometheus', name: 'Prometheus', version: '1.0.0' }],
    title: 'WhatsOnMyNet', uid: 'whatsonmynet', schemaVersion: 39, version: 1, editable: true, refresh: '1m', time: { from: 'now-24h', to: 'now' }, tags: ['whatsonmynet'],
    templating: { list: [
      { name: 'DS_PROMETHEUS', type: 'datasource', query: 'prometheus', label: T('Datenquelle', 'Data source'), hide: 0 },
      { name: 'type', type: 'query', datasource: ds, query: 'label_values(womn_monitor_state, type)', refresh: 2, includeAll: true, multi: true, current: { text: 'All', value: '$__all' },
        label: T('Art', 'Kind'), allValue: '.*' },
    ] },
    panels: [
      panel('stat', T('Gestört', 'Down'), { x: 0, y: 0, w: 6, h: 5 }, [target(`count(womn_monitor_up{${typeFilter}} == 0) or vector(0)`)],
        { fieldConfig: { defaults: { thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'red', value: 1 }] } }, overrides: [] }, options: { colorMode: 'background', graphMode: 'none', reduceOptions: { calcs: ['lastNotNull'] } } }),
      panel('stat', T('In Ordnung', 'Fine'), { x: 6, y: 0, w: 6, h: 5 }, [target(`count(womn_monitor_up{${typeFilter}} == 1) or vector(0)`)],
        { fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: 'green' } }, overrides: [] }, options: { colorMode: 'value', graphMode: 'none', reduceOptions: { calcs: ['lastNotNull'] } } }),
      panel('stat', T('Pausiert', 'Paused'), { x: 12, y: 0, w: 6, h: 5 }, [target(`count(womn_monitor_state{state="paused",${typeFilter}}) or vector(0)`)],
        { options: { colorMode: 'value', graphMode: 'none', reduceOptions: { calcs: ['lastNotNull'] } } }),
      panel('stat', T('Zertifikat läuft in < 14 Tagen ab', 'Certificate expires in < 14 days'), { x: 18, y: 0, w: 6, h: 5 }, [target(`count(${DAYS_LEFT} < 14) or vector(0)`)],
        { fieldConfig: { defaults: { thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: 1 }] } }, overrides: [] }, options: { colorMode: 'background', graphMode: 'none', reduceOptions: { calcs: ['lastNotNull'] } } }),
      panel('table', T('Gerade gestört', 'Down right now'), { x: 0, y: 5, w: 24, h: 7 }, [target(`womn_monitor_down_seconds{${typeFilter}}`, '', { format: 'table', instant: true })],
        { transformations: [{ id: 'organize', options: { excludeByName: { Time: true, __name__: true, instance: true, job: true, id: true }, renameByName: { name: T('Name', 'Name'), type: T('Art', 'Kind'), target: T('Ziel', 'Target'), device: T('Gerät', 'Device'), Value: T('Gestört seit (s)', 'Down for (s)') } } }],
          fieldConfig: { defaults: { unit: 's' }, overrides: [] } }),
      panel('state-timeline', T('Verfügbarkeit', 'Availability'), { x: 0, y: 12, w: 24, h: 10 }, [target(`womn_monitor_up{${typeFilter}}`, '{{name}}')],
        { fieldConfig: { defaults: { mappings: [{ type: 'value', options: { 0: { text: T('gestört', 'down'), color: 'red' }, 1: { text: 'OK', color: 'green' } } }], color: { mode: 'thresholds' },
          thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'green', value: 1 }] } }, overrides: [] }, options: { showValue: 'never', mergeValues: true } }),
      panel('timeseries', T('Antwortzeit', 'Response time'), { x: 0, y: 22, w: 12, h: 9 }, [target(`womn_monitor_response_seconds{${typeFilter}}`, '{{name}}')],
        { fieldConfig: { defaults: { unit: 's' }, overrides: [] } }),
      panel('timeseries', T('Sensorwerte', 'Sensor values'), { x: 12, y: 22, w: 12, h: 9 }, [target('womn_sensor_value', '{{name}} ({{unit}})')]),
      panel('bargauge', T('Zertifikate: Tage bis Ablauf', 'Certificates: days left'), { x: 0, y: 31, w: 24, h: 8 }, [target(`sort(${DAYS_LEFT})`, '{{name}}', { instant: true })],
        { fieldConfig: { defaults: { unit: 'd', min: 0, max: 90, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 14 }, { color: 'green', value: 30 }] } }, overrides: [] },
          options: { orientation: 'horizontal', displayMode: 'gradient' } }),
    ],
  };
}
