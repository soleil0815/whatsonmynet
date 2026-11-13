// Proxmox VE cluster: one node entered, the others found by the cluster itself and asked when the entered one is down.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryDb, tmp } from './helpers.js';
import { createSettings } from '../src/settings.js';
import { createProxmox, fallbackHosts } from '../src/proxmox.js';

const AUTH = 'PVEAPIToken=monitor@pve!womn=secret-1';

/** Three nodes on 127.0.0.2-4, all on the same port, each with its own self-signed certificate */
function cert(dir, name, ip) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${name}`,
    '-addext', `subjectAltName=IP:${ip}`, '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.pem`)], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, `${name}.key`)), pem: fs.readFileSync(path.join(dir, `${name}.pem`), 'utf8') };
}

async function cluster() {
  const dir = fs.mkdtempSync(path.join(tmp, 'pvec-'));
  const nodes = [['pve1', '127.0.0.2'], ['pve2', '127.0.0.3'], ['pve3', '127.0.0.4']].map(([name, ip]) => ({ name, ip, ...cert(dir, name, ip) }));
  const asked = [];
  const status = nodes.map((n, i) => ({ type: 'node', name: n.name, ip: n.ip, online: 1, nodeid: i + 1 })).concat([{ type: 'cluster', name: 'firma', nodes: 3, quorate: 1 }]);
  const handler = (me) => (req, res) => {
    if (req.headers.authorization !== AUTH) { res.statusCode = 401; return res.end('{}'); }
    asked.push(me.name);
    const p = req.url.split('?')[0];
    const send = (data) => res.end(JSON.stringify({ data }));
    if (p === '/api2/json/cluster/resources') return send(nodes.map((n) => ({ type: 'node', node: n.name, status: 'online', cpu: 0.1, mem: 1, maxmem: 2 })));
    if (p === '/api2/json/cluster/status') return send(status);
    const c = /^\/api2\/json\/nodes\/([^/]+)\/certificates\/info$/.exec(p);
    if (c) { const n = nodes.find((x) => x.name === c[1]); return send([{ filename: 'pve-root-ca.pem', pem: 'x' }, { filename: 'pve-ssl.pem', pem: n.pem }]); }
    if (p === '/api2/json/access/permissions') return send({ '/': { 'Sys.Audit': 1, 'VM.Audit': 1, 'Datastore.Audit': 1 } });
    if (/\/tasks$/.test(p)) return send([]);
    res.statusCode = 404; res.end('{}');
  };
  for (const n of nodes) n.srv = https.createServer({ key: n.key, cert: n.pem }, handler(n));
  await new Promise((r) => nodes[0].srv.listen(0, nodes[0].ip, r));
  const port = nodes[0].srv.address().port;
  for (const n of nodes.slice(1)) await new Promise((r) => n.srv.listen(port, n.ip, r));
  return { nodes, asked, port, close: () => nodes.forEach((n) => n.srv.listening && n.srv.close()) };
}

test('cluster: the other nodes are found and asked when the entered one is down', async () => {
  const c = await cluster();
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  try {
    // pve1 entered with its own (pinned) certificate
    const h = px.create({ name: 'Cluster', kind: 'pve', url: `https://${c.nodes[0].ip}:${c.port}`, token_id: 'monitor@pve!womn', secret: 'secret-1', ca: c.nodes[0].pem });
    let r = await px.poll(h.id);
    assert.equal(r.last_ok, true, r.last_error);
    assert.equal(r.data.via, null);
    assert.deepEqual(r.data.cluster.map((n) => [n.name, n.ip, !!n.pem]), [['pve1', '127.0.0.2', true], ['pve2', '127.0.0.3', true], ['pve3', '127.0.0.4', true]]);
    // pve1 down: pve2 answers - with its own certificate, the token only after TLS checked it
    c.nodes[0].srv.close();
    c.asked.length = 0;
    r = await px.poll(h.id);
    assert.equal(r.last_ok, true, r.last_error);
    assert.equal(r.data.via.node, 'pve2');
    assert.match(r.data.via.error, /refused/);
    assert.ok(c.asked.every((n) => n === 'pve2'));
    // pve2 down too: pve3
    c.nodes[1].srv.close();
    r = await px.poll(h.id);
    assert.equal(r.data.via.node, 'pve3');
  } finally { c.close(); }
});

test('cluster: a node whose certificate does not fit never gets the token', async () => {
  const c = await cluster();
  const db = memoryDb();
  const px = createProxmox({ db, settings: createSettings(db) });
  try {
    const h = px.create({ name: 'Cluster', kind: 'pve', url: `https://${c.nodes[0].ip}:${c.port}`, token_id: 'monitor@pve!womn', secret: 'secret-1', ca: c.nodes[0].pem });
    await px.poll(h.id);
    // someone else answers at the addresses of pve2 and pve3 (another certificate)
    const dir = fs.mkdtempSync(path.join(tmp, 'evil-'));
    const evil = cert(dir, 'evil', '127.0.0.3');
    const seen = [];
    for (const n of c.nodes) n.srv.close();
    const fakes = await Promise.all(c.nodes.slice(1).map((n) => new Promise((r) => { const s = https.createServer({ key: evil.key, cert: evil.pem }, (q, res) => { seen.push(q.headers.authorization); res.end('{}'); }); s.listen(c.port, n.ip, () => r(s)); })));
    const r = await px.poll(h.id);
    assert.equal(r.last_ok, false);
    assert.deepEqual(seen, [], 'token never sent');
    fakes.forEach((s) => s.close());
  } finally { c.close(); }
});

test('cluster: fallback addresses - pinned company CA stays, a single node has none, unknown certificate → left out', () => {
  const cl = [{ name: 'pve1', ip: '10.0.0.1', pem: 'P1' }, { name: 'pve2', ip: '10.0.0.2', pem: '' }, { name: 'pve3', ip: 'fd00::3', pem: 'P3' }];
  const leaf = cert(fs.mkdtempSync(path.join(tmp, 'l-')), 'pve1', '10.0.0.1').pem;
  cl[0].pem = leaf;
  const alts = fallbackHosts({ url: 'https://10.0.0.1:8006', ca: leaf, verify: 1 }, cl);
  assert.deepEqual(alts.map((a) => [a.viaNode, a.url, a.ca]), [['pve3', 'https://[fd00::3]:8006', 'P3']]);
  const open = fallbackHosts({ url: 'https://pve1.firma.local:8006', ca: '', verify: 1 }, cl);
  assert.deepEqual(open.map((a) => a.url), ['https://10.0.0.2:8006', 'https://[fd00::3]:8006']);
  // a company CA (not the certificate of a node) stays for all nodes
  const caPem = cert(fs.mkdtempSync(path.join(tmp, 'ca-')), 'Firmen-CA', '10.9.9.9').pem;
  assert.deepEqual(fallbackHosts({ url: 'https://10.0.0.1:8006', ca: caPem }, cl).map((a) => a.ca === caPem), [true, true]);
  assert.deepEqual(fallbackHosts({ url: 'https://10.0.0.1:8006' }, null), []);
});
