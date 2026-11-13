// Line icons (24×24, stroke = currentColor). Fixed markup - never built from data.
const svg = (body, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const P = {
  // device types
  router: '<rect x="3" y="13" width="18" height="6" rx="1.5"/><path d="M7 16h.01M10.5 16h.01M8 13l-2-5M16 13l2-5"/><path d="M5 5.5a8 8 0 0 1 3-1.8M19 5.5a8 8 0 0 0-3-1.8"/>',
  firewall: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M8.5 11h7M8.5 14.5h7M12 7.5v3.5M10 11v3.5M14 11v3.5"/>',
  switch: '<rect x="2.5" y="8" width="19" height="8" rx="1.5"/><path d="M6 12h1M9 12h1M12 12h1M15 12h1M18 12h1"/>',
  accesspoint: '<circle cx="12" cy="16" r="1.4"/><path d="M8.5 12.5a5 5 0 0 1 7 0M5.8 9.8a9 9 0 0 1 12.4 0M3 7a13 13 0 0 1 18 0"/>',
  hypervisor: '<rect x="3" y="3.5" width="18" height="7" rx="1.5"/><rect x="3" y="13.5" width="18" height="7" rx="1.5"/><path d="M6.5 7h3M6.5 17h3M14 7h.01M17 7h.01M14 17h.01M17 17h.01"/>',
  server: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M7.5 6h.01M7.5 12h.01M7.5 18h.01M11 6h5"/>',
  nas: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 7h7M8.5 10.5h7M8.5 14h7"/><circle cx="12" cy="18" r=".6"/>',
  printer: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="7.5" rx="1.5"/><path d="M7 14h10v6.5H7z"/><path d="M17 12h.01"/>',
  computer: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  vm: '<rect x="3" y="4" width="18" height="12" rx="1.5" stroke-dasharray="2.5 2"/><path d="M9 20h6M12 16v4M9 10l2 2 4-4"/>',
  mobile: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  phone: '<path d="M6 4.5h3l1.5 4-2 1.3a10 10 0 0 0 5.7 5.7l1.3-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 4.5 6.1 1.5 1.5 0 0 1 6 4.5z"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="1.5"/><path d="M16 10.5l5-3v9l-5-3"/><circle cx="9.5" cy="12" r="2.2"/>',
  ups: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12.8 7l-3 5h4.4l-3 5"/>',
  iot: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  media: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8M10.5 9v4l3.5-2z"/>',
  ti_connector: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M12 9v6M9 12h6"/><path d="M6.5 6V4M17.5 6V4"/>',
  ti_terminal: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><rect x="8" y="5.5" width="8" height="5" rx=".8"/><path d="M8.5 14h.01M12 14h.01M15.5 14h.01M8.5 17.5h.01M12 17.5h.01M15.5 17.5h.01"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6M12 17h.01"/>',
  // interface
  dashboard: '<rect x="3.5" y="3.5" width="7" height="8" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.2"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.2"/><rect x="3.5" y="14.5" width="7" height="6" rx="1.2"/>',
  inventory: '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18.5" cy="18" r="1.5"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6.4-6.4"/><circle cx="15.5" cy="14.5" r="1" fill="currentColor"/>',
  location: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  eye: '<path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-2.6 3.2M6.5 7.6A16 16 0 0 0 3 12s4 6 9 6a8.6 8.6 0 0 0 3.7-.8M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 3.5V8h4.5M12 7.5V12l3 2"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3.5 6l8.5 7 8.5-7"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 16.8h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 3.5V8h4.5"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20.5V16h-4.5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1.2"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  coffee: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3"/>',
};

export function icon(name, cls) {
  return svg(P[name] || P.unknown, cls);
}

export const TYPE_ICONS = ['router', 'firewall', 'switch', 'accesspoint', 'hypervisor', 'server', 'nas', 'printer', 'computer', 'vm',
  'mobile', 'phone', 'camera', 'ups', 'iot', 'media', 'ti_connector', 'ti_terminal', 'unknown'];

/** The WhatsOnMyNet mark: radar with three found devices, one of them online (green). */
export const LOGO_MARK = `<svg class="logo-mark" viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="2"/>
  <circle cx="32" cy="32" r="19" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="2"/>
  <circle cx="32" cy="32" r="9" fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="2"/>
  <path d="M32 32 L52.5 11.5 A29 29 0 0 1 61 32 Z" fill="currentColor" fill-opacity=".22"/>
  <path d="M32 32 L52.5 11.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="32" cy="32" r="3" fill="currentColor"/>
  <circle cx="47" cy="25" r="3.4" fill="var(--ok, #3FBF83)"/>
  <circle cx="19" cy="20" r="2.6" fill="currentColor" fill-opacity=".85"/>
  <circle cx="22" cy="46" r="2.6" fill="currentColor" fill-opacity=".85"/>
</svg>`;
