// Audit 2026-11 (part b), group tls: certificate files, HSTS host check, candidate image cleanup
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';
import { createTls } from '../src/tls.js';
import { directHstsMiddleware } from '../src/https.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(tmp, 'tls-b-work');
fs.mkdirSync(work, { recursive: true });

function makeCert(name, { caSigned = false } = {}) {
  const key = path.join(work, `${name}.key`);
  const crt = path.join(work, `${name}.crt`);
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  if (!caSigned) {
    execFileSync('openssl', ['req', '-x509', ...ec, '-keyout', key, '-out', crt, '-days', '90',
      '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`], { stdio: 'ignore' });
  } else {
    const caKey = path.join(work, 'ca.key'); const caCrt = path.join(work, 'ca.crt');
    const csr = path.join(work, `${name}.csr`); const ext = path.join(work, `${name}.ext`);
    if (!fs.existsSync(caCrt)) {
      execFileSync('openssl', ['req', '-x509', ...ec, '-keyout', caKey, '-out', caCrt, '-days', '90', '-subj', '/CN=Firma Test CA'], { stdio: 'ignore' });
    }
    execFileSync('openssl', ['req', '-new', ...ec, '-keyout', key, '-out', csr, '-subj', `/CN=${name}`], { stdio: 'ignore' });
    fs.writeFileSync(ext, `subjectAltName=DNS:${name}\n`);
    execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-out', crt, '-days', '90', '-extfile', ext], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(crt, 'utf8') };
}

const baks = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).sort();
const readBak = (dir, prefix) => fs.readFileSync(path.join(dir, baks(dir).find((f) => f.startsWith(prefix))), 'utf8').trim();
const readPem = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').trim();
let n = 0;
const freshDir = () => path.join(tmp, `tls-b-${++n}`);

// --- 1. Missing or unreadable key/certificate ---------------------------------------------------------------

test('tls: an uploaded certificate whose key.pem is missing is backed up before a self-signed one replaces it', async () => {
  const dir = freshDir();
  const up = makeCert('womn.firma.local');
  await createTls(dir).installCustom({ certPem: up.cert, keyPem: up.key });
  fs.rmSync(path.join(dir, 'key.pem'));
  assert.equal(await createTls(dir).ensure(), true);
  assert.equal(createTls(dir).describe().source, 'self-signed');
  assert.ok(baks(dir).some((f) => f.startsWith('cert.pem.')), `cert.pem backed up: ${baks(dir)}`);
  assert.equal(readBak(dir, 'cert.pem.'), up.cert.trim());
});

test('tls: a key.pem without cert.pem is backed up before it is replaced', async () => {
  const dir = freshDir();
  const up = makeCert('womn.firma.local');
  await createTls(dir).installCustom({ certPem: up.cert, keyPem: up.key });
  fs.rmSync(path.join(dir, 'cert.pem'));
  assert.equal(await createTls(dir).ensure(), true);
  assert.equal(readBak(dir, 'key.pem.'), up.key.trim());
});

test('tls: a certificate file that exists but cannot be read is never replaced - the start fails', async () => {
  const dir = freshDir();
  const up = makeCert('womn.firma.local');
  await createTls(dir).installCustom({ certPem: up.cert, keyPem: up.key });
  // A file that exists but cannot be read (EACCES as non-root; a directory gives EISDIR even as root)
  fs.rmSync(path.join(dir, 'key.pem'));
  fs.mkdirSync(path.join(dir, 'key.pem'));
  await assert.rejects(createTls(dir).ensure(), /cannot be read|Cannot read/i);
  assert.equal(readPem(dir, 'cert.pem'), up.cert.trim());
});

// --- 2. Upload over an uploaded certificate ---------------------------------------------------------------------

test('tls: uploading a new certificate keeps the previous uploaded one as *.bak', async () => {
  const dir = freshDir();
  const a = makeCert('womn.firma.local');
  const b = makeCert('womn2.firma.local');
  const tls = createTls(dir);
  await tls.ensure();
  await tls.installCustom({ certPem: a.cert, keyPem: a.key });
  assert.deepEqual(baks(dir), [], 'replacing the self-signed certificate needs no backup');
  await tls.installCustom({ certPem: b.cert, keyPem: b.key });
  assert.equal(readBak(dir, 'cert.pem.'), a.cert.trim());
  assert.equal(readBak(dir, 'key.pem.'), a.key.trim());
  assert.equal(readPem(dir, 'cert.pem'), b.cert.trim());
});

// --- 3. Crash between the renames, mismatching pair, fsync ------------------------------------------------------

test('tls: an upload interrupted between the renames is finished at the next start, not overwritten', async () => {
  const dir = freshDir();
  await createTls(dir).ensure();
  const up = makeCert('womn.firma.local');
  // State after key.pem.tmp was renamed and the process died before cert.pem.tmp / meta.json.tmp
  fs.writeFileSync(path.join(dir, 'key.pem'), up.key, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'cert.pem.tmp'), up.cert);
  fs.writeFileSync(path.join(dir, 'meta.json.tmp'), JSON.stringify({ source: 'custom', installedAt: '2026-11-01T00:00:00.000Z' }));
  const tls = createTls(dir);
  assert.equal(await tls.ensure(), false);
  assert.equal(fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), up.key);
  assert.equal(readPem(dir, 'cert.pem'), up.cert.trim());
  assert.ok(!fs.existsSync(path.join(dir, 'cert.pem.tmp')));
  assert.equal(tls.describe().source, 'custom');
  assert.equal(tls.describe().installedAt, '2026-11-01T00:00:00.000Z');
});

test('tls: certificate and key that do not fit together are backed up before they are replaced', async () => {
  const dir = freshDir();
  await createTls(dir).ensure();
  const foreign = makeCert('womn.firma.local');
  fs.writeFileSync(path.join(dir, 'key.pem'), foreign.key, { mode: 0o600 });
  assert.equal(await createTls(dir).ensure(), true);
  assert.equal(readBak(dir, 'key.pem.'), foreign.key.trim());
});

test('tls: the new files are flushed to disk before they are renamed', async () => {
  const dir = freshDir();
  const up = makeCert('womn.firma.local');
  const orig = fs.fsyncSync;
  let syncs = 0;
  fs.fsyncSync = (fd) => { syncs++; return orig(fd); };
  try { await createTls(dir).installCustom({ certPem: up.cert, keyPem: up.key }); } finally { fs.fsyncSync = orig; }
  assert.ok(syncs >= 2, `fsync calls: ${syncs}`);
});

// --- 4. HSTS only for names the certificate covers --------------------------------------------------------------

test('hsts: sent on direct access only for a host name the uploaded certificate covers', async () => {
  const dir = freshDir();
  const tls = createTls(dir);
  const up = makeCert('womn.firma.local', { caSigned: true });
  await tls.installCustom({ certPem: up.cert, keyPem: up.key });
  assert.equal(tls.describe().selfSigned, false);
  assert.equal(JSON.parse(JSON.stringify(tls.describe())).x509, undefined, 'the certificate object is not sent to the browser');
  const mw = directHstsMiddleware({ hsts: 'on', cert: () => tls.describe() });
  const hsts = (host) => {
    const headers = {};
    mw({ socket: { encrypted: true }, headers: { host } }, { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } }, () => {});
    return headers['strict-transport-security'];
  };
  assert.equal(hsts('other-name.firma.local:8743'), undefined);
  assert.equal(hsts('womn.firma.local:8743'), 'max-age=31536000');
});

// --- 5. Candidate cleanup: published tags resolved from the registry itself -----------------------------------------

const hasDash = spawnSync('sh', ['-c', 'command -v dash && command -v jq']).status === 0;

function cleanup(runId, { versions, registry, published = '', inspectError = '' }) {
  const dir = fs.mkdtempSync(path.join(tmp, 'cand-b-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'versions.json'), JSON.stringify(versions));
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
case " $* " in *" -X DELETE "*) exit 0 ;; esac
expr=''
while [ $# -gt 0 ]; do [ "$1" = --jq ] && expr="$2"; shift; done
exec jq -r "$expr" "$DIR/versions.json"
`, { mode: 0o755 });
  // docker buildx imagetools inspect [--raw | --format '{{json .Manifest.Digest}}'] <image:tag | image@digest>
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
[ -z "$INSPECT_ERROR" ] || { echo "ERROR: $INSPECT_ERROR" >&2; exit 1; }
raw=0
for a; do [ "$a" = --raw ] && raw=1; ref="$a"; done
case "$ref" in
  *@*) d="\${ref#*@}" ;;
  *) d="$(jq -r --arg t "\${ref##*:}" '.tags[$t] // empty' "$DIR/registry.json")" ;;
esac
[ -n "$d" ] || { echo "ERROR: $ref: not found" >&2; exit 1; }
if [ "$raw" = 1 ]; then jq -c --arg d "$d" '.manifests[$d] // {}' "$DIR/registry.json"; else printf '"%s"\\n' "$d"; fi
`, { mode: 0o755 });
  const r = spawnSync('dash', [path.join(root, '.github', 'scripts', 'delete-candidates.sh'), 'ghcr.io/example/netapp', String(runId)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: calls, DIR: dir, GH_TOKEN: 'x', PUBLISHED: published, INSPECT_ERROR: inspectError },
  });
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
  return { ...r, deleted: log.filter((c) => c.includes('-X DELETE')).map((c) => Number(c.split('/').pop())) };
}

const v = (id, digest, tags) => ({ id, name: digest, metadata: { package_type: 'container', container: { tags } } });
// The package API still lists only the candidate tags of run 999, the registry already has 1.4.0 and latest
const lagging = [v(20, 'sha256:a1', ['1.4.0-kandidat-999']), v(21, 'sha256:a2', ['1.4.0-kandidat-999-amd64']),
  v(22, 'sha256:a3', ['1.4.0-kandidat-999-arm64']), v(23, 'sha256:a4', ['1.4.0-kandidat-999-riscv64'])];
const index = { manifests: [{ digest: 'sha256:a2' }, { digest: 'sha256:a3' }] };

test('candidate cleanup: published tags are read from the registry - a lagging package API deletes nothing published', { skip: !hasDash && 'dash or jq missing' }, () => {
  const r = cleanup(999, { versions: lagging, registry: { tags: { '1.4.0': 'sha256:a1', latest: 'sha256:a1' }, manifests: { 'sha256:a1': index } }, published: 'true' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.deleted, [23]);
  assert.match(r.stdout, /Kept 20 .*published/);
});

test('candidate cleanup: nothing is deleted when a published tag cannot be resolved', { skip: !hasDash && 'dash or jq missing' }, () => {
  const missing = cleanup(999, { versions: lagging, registry: { tags: {}, manifests: {} }, published: 'true' });
  assert.equal(missing.status, 1, missing.stdout);
  assert.deepEqual(missing.deleted, []);
  assert.match(missing.stderr, /::error::.*1\.4\.0/);
  const broken = cleanup(999, { versions: lagging, registry: { tags: {}, manifests: {} }, inspectError: 'unexpected status: 500' });
  assert.equal(broken.status, 1);
  assert.deepEqual(broken.deleted, []);
});

test('candidate cleanup: a run that published nothing still removes its candidates under dash', { skip: !hasDash && 'dash or jq missing' }, () => {
  const r = cleanup(999, { versions: lagging, registry: { tags: { latest: 'sha256:0f' }, manifests: { 'sha256:0f': { manifests: [{ digest: 'sha256:0e' }] } } } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.deleted, [20, 21, 22, 23]);
});

test('candidate cleanup: the script is valid POSIX sh and the workflows tell it whether publishing succeeded', () => {
  const script = path.join(root, '.github', 'scripts', 'delete-candidates.sh');
  if (hasDash) assert.equal(spawnSync('dash', ['-n', script]).status, 0);
  for (const f of ['ci.yml', 'security-update.yml']) {
    const wf = fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8');
    const job = wf.slice(wf.indexOf('\n  cleanup-candidates:'));
    assert.match(job, /PUBLISHED: \$\{\{ needs\.publish\.result == 'success'( && needs\.publish\.outputs\.changed == 'true')? \}\}/, f);
    const comment = wf.slice(0, wf.indexOf('\n  cleanup-candidates:')).split('\n').slice(-8).join('\n');
    assert.doesNotMatch(comment, /after a failed build or check/, `${f}: comment matches the job conditions`);
  }
});
