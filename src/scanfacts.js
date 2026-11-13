// What a scan agent reports about a device ("facts") - brought into the shape a local scan makes. An agent is a second
// machine in a branch office: like a host script it is never trusted more than a form, so every field is checked and cut
// to size and anything unknown is dropped. Otherwise a wrong type (ports: "x") would break the scan and device pages,
// and a crafted value (proto: "javascript:") would end up in a link.
const clip = (s, n = 120) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const num = (v, min, max) => { const n = Number(v); return v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n) || n < min || n > max ? null : n; };
const port = (v) => { const n = num(v, 1, 65535); return n === null || !Number.isInteger(n) ? null : n; };
const strs = (v, n, len) => (Array.isArray(v) ? v.slice(0, n).map((x) => clip(x, len)).filter(Boolean) : []);
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

function cert(raw) {
  const c = obj(raw);
  if (!c) return null;
  return { subject: clip(c.subject, 200), org: clip(c.org, 200), issuer: clip(c.issuer, 200), validTo: iso(c.validTo), names: strs(c.names, 10, 200) };
}

function http(raw) {
  return (Array.isArray(raw) ? raw.slice(0, 16) : []).map((h) => {
    const x = obj(h);
    if (!x || !['http', 'https'].includes(x.proto) || port(x.port) === null) return null;
    return { port: port(x.port), proto: x.proto, status: num(x.status, 100, 599), title: clip(x.title, 160), server: clip(x.server, 120),
      location: clip(x.location, 300), cert: x.proto === 'https' ? cert(x.cert) : null };
  }).filter(Boolean);
}

function snmp(raw) {
  const s = obj(raw);
  if (!s) return null;
  const out = { descr: clip(s.descr, 400), objectId: /^[0-9.]{1,200}$/.test(String(s.objectId || '')) ? String(s.objectId) : '', name: clip(s.name, 120),
    location: clip(s.location, 200), contact: clip(s.contact, 200), uptime: clip(s.uptime, 20), version: ['1', '2c'].includes(s.version) ? s.version : '' };
  return out.descr || out.objectId || out.name ? out : null;
}

function classification(raw) {
  const c = obj(raw);
  if (!c) return null;
  return { type: clip(c.type, 30), confidence: num(c.confidence, 0, 1) ?? 0, reasons: strs(c.reasons, 20, 160), os: clip(c.os, 60), model: clip(c.model, 120) };
}

export function cleanScanFacts(raw) {
  const f = obj(raw) || {};
  const nb = obj(f.netbios);
  const out = {
    ports: [...new Set((Array.isArray(f.ports) ? f.ports.slice(0, 1024) : []).map(port).filter((p) => p !== null))],
    ttl: num(f.ttl, 1, 255),
    netbios: nb && (nb.name || nb.domain) ? { name: clip(nb.name, 64), domain: clip(nb.domain, 64) } : null,
    rdns: clip(f.rdns, 253),
    snmp: snmp(f.snmp),
    http: http(f.http),
    vendorFull: clip(f.vendorFull, 200),
    randomMac: f.randomMac === true,
    isGateway: f.isGateway === true,
    isSelf: f.isSelf === true,
    macSource: ['arp', 'netbios', 'router'].includes(f.macSource) ? f.macSource : '',
    classification: classification(f.classification),
  };
  if (f.light === true) out.light = true;
  return out;
}
