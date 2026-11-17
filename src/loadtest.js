// Load test: how many messages a second this server takes - on its own disk and CPU, next to the running program.
//   docker compose exec whatsonmynet womn-admin loadtest
// A receiver of its own (syslog over TCP on 127.0.0.1, a free port) writes into a file of its own in a folder next to
// the data (data/loadtest-…, removed at the end - the real messages are never touched). A second thread sends Windows
// events as NXLog does, faster step by step; each step counts what was stored, how far the search index and the counts
// lag behind and how long the program had to wait to get its turn (the web pages wait as long). The test stops at the
// first step the server no longer keeps up with and says what that means in computers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const STEPS = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000];
const STEP_MS = 6000;
const CONNECTIONS = 40;
// what an unfiltered Windows computer sends a day (measured on real clients: some 8 000)
const PER_PC_DAY = 8000;
const NEED_FREE = 3 * 1024 ** 3;

// ---------------------------------------------------------------------------------------------- the sender (thread)
function sender({ port, connections }) {
  const texts = [
    [4624, 'Microsoft-Windows-Security-Auditing', 'Security', 'Ein Konto wurde erfolgreich angemeldet. Antragsteller: Sicherheits-ID: S-1-5-18 Kontoname: PC-0001$ Kontodomäne: FIRMA Anmelde-ID: 0x3E7 Anmeldeinformationen: Anmeldetyp: 3 Eingeschränkter Administratormodus: - Virtuelles Konto: Nein Erhöhte Token: Ja Neues Anmelden: Sicherheits-ID: S-1-5-21-1000-2000-3000-1104 Kontoname: m.muster Kontodomäne: FIRMA Anmelde-ID: 0x1A2B3C Prozessinformationen: Prozess-ID: 0x0 Prozessname: - Netzwerkinformationen: Arbeitsstationsname: PC-0002 Quellnetzwerkadresse: 10.0.10.12 Quellport: 51234 Detaillierte Authentifizierungsinformationen: Anmeldeprozess: Kerberos Authentifizierungspaket: Kerberos'],
    [4634, 'Microsoft-Windows-Security-Auditing', 'Security', 'Ein Konto wurde abgemeldet. Antragsteller: Sicherheits-ID: S-1-5-21-1000-2000-3000-1104 Kontoname: m.muster Kontodomäne: FIRMA Anmelde-ID: 0x1A2B3C Anmeldetyp: 3'],
    [7036, 'Service Control Manager', 'System', 'Dienst "Windows Update" befindet sich jetzt im Status "Wird ausgeführt".'],
    [10016, 'Microsoft-Windows-DistributedCOM', 'System', 'Die anwendungsspezifischen Berechtigungseinstellungen gewähren dem Benutzer FIRMA\\m.muster (SID: S-1-5-21-1000-2000-3000-1104) unter der Adresse LocalHost (unter Verwendung von LRPC) keine Lokal Aktivierung-Berechtigung für die COM-Serveranwendung mit der CLSID {2593F8B9-4EAF-457C-B68A-50F6B8EA6B54}.'],
    [4625, 'Microsoft-Windows-Security-Auditing', 'Security', 'Fehler beim Anmelden eines Kontos. Antragsteller: Sicherheits-ID: S-1-0-0 Kontoname: - Kontodomäne: - Anmelde-ID: 0x0 Anmeldetyp: 3 Konto, für das die Anmeldung fehlgeschlagen ist: Sicherheits-ID: S-1-0-0 Kontoname: testadmin Kontodomäne: FIRMA Fehlerinformationen: Fehlerursache: Unbekannter Benutzername oder ungültiges Kennwort. Status: 0xC000006D Unterstatus: 0xC000006A Prozessinformationen: Aufrufprozess-ID: 0x0 Aufrufprozessname: - Netzwerkinformationen: Arbeitsstationsname: PC-0003 Quellnetzwerkadresse: 10.0.10.13 Quellport: 0'],
    [1014, 'Microsoft-Windows-DNS-Client', 'System', 'Timeout bei der Namensauflösung für den Namen wpad.firma.local, nachdem keiner der konfigurierten DNS-Server geantwortet hat.'],
  ];
  const lines = [];
  for (let i = 0; i < 4000; i++) {
    const [id, src, ch, text] = texts[i % texts.length];
    const pri = id === 4625 ? 12 : 14;
    lines.push(`<${pri}>Nov 17 10:00:${String(i % 60).padStart(2, '0')} PC-${String(1 + (i % 1000)).padStart(4, '0')} ${src}[${600 + (i % 90)}]: [${id}] [${ch}] ${text} #${i}\n`);
  }
  const socks = Array.from({ length: connections }, () => net.connect(port, '127.0.0.1'));
  for (const s of socks) s.on('error', () => {});
  let rate = 0; let sent = 0; let next = 0; let tick = null;
  // every 20 ms its share of the rate, round-robin over the connections; a connection that is full (the receiver
  // pauses it or is too slow) is skipped - what was not sent is not sent later
  const send = () => {
    const n = Math.round(rate / 50);
    for (let k = 0; k < n; k++) {
      const s = socks[(sent + k) % socks.length];
      if (s.writableNeedDrain || s.destroyed) continue;
      s.write(lines[next++ % lines.length]);
      sent++;
    }
  };
  parentPort.on('message', (m) => {
    if (m.rate !== undefined) { rate = m.rate; if (!tick) tick = setInterval(send, 20); }
    if (m.report) parentPort.postMessage({ sent });
    if (m.stop) { clearInterval(tick); for (const s of socks) s.destroy(); parentPort.postMessage({ sent, done: true }); }
  });
}

if (!isMainThread && workerData?.loadtest) sender(workerData);

// ---------------------------------------------------------------------------------------------- the test
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export async function loadTest({ dataDir, out = (s) => process.stdout.write(`${s}\n`), steps = STEPS, stepMs = STEP_MS } = {}) {
  const { openDatabase } = await import('./db.js');
  const { createSettings } = await import('./settings.js');
  const { createEvents, FLOOD } = await import('./events.js');
  // the log lines of the receiver (listening, search index …) would break up the table
  (await import('./lib/log.js')).setPrintLevel('warn');
  try {
    const st = fs.statfsSync(dataDir);
    if (st.bavail * st.bsize < NEED_FREE) { out(`Not enough free space in ${dataDir} (needs 3 GB for the test file) - no test.`); return null; }
  } catch { /* not known - go on */ }
  const dir = path.join(dataDir, `loadtest-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let db = null; let ev = null; let worker = null;
  const clean = () => { try { worker?.terminate(); } catch { /* gone */ } try { ev?.stop(); } catch { /* stopped */ } try { db?.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); };
  const onSignal = () => { clean(); process.exit(130); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    db = openDatabase(path.join(dir, 'loadtest.sqlite'));
    const settings = createSettings(db);
    settings.set('events.syslogTcp', true);
    // every message is kept (the default list of Windows noise would leave most of the test messages out)
    settings.set('events.winDeny', ''); settings.set('events.winAllow', ''); settings.set('events.minSeverity', 7);
    // no flood limits: the test wants to know what the disk and the CPU take
    ev = createEvents({ db, settings, limits: { perSender: 1e9, perSenderStream: 1e9, perSecond: 1e9, connectionsPerSender: CONNECTIONS }, ports: { syslogTcp: 0 }, bind: '127.0.0.1' });
    ev.start();
    for (let i = 0; i < 100 && !ev.status().syslogTcp.on; i++) await new Promise((r) => setTimeout(r, 20));
    const port = ev.status().syslogTcp.port;
    worker = new Worker(new URL(import.meta.url), { workerData: { loadtest: true, port, connections: CONNECTIONS } });
    const ask = (m) => new Promise((r) => { worker.once('message', r); worker.postMessage(m); });
    const top = () => db.prepare('SELECT MAX(id) FROM events_in').pluck().get() || 0;
    out(`Load test: ${os.cpus().length} CPU(s), file in ${dataDir}. Windows events over TCP, as NXLog sends them.`);
    out('');
    out(`${'asked/s'.padStart(9)} ${'stored/s'.padStart(9)} ${'index behind'.padStart(13)} ${'waits (p99)'.padStart(12)}`);
    const rows = []; let best = 0;
    for (const rate of steps) {
      const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
      const a = top(); const t0 = performance.now();
      const sent0 = (await ask({ report: true })).sent;
      worker.postMessage({ rate });
      const lag = () => Math.max(ev.status().searchIndex.behind, ev.status().counts.behind);
      await new Promise((r) => setTimeout(r, stepMs / 2));
      const mid = lag();
      await new Promise((r) => setTimeout(r, stepMs / 2));
      const secs = (performance.now() - t0) / 1000;
      const sent = (await ask({ report: true })).sent - sent0;
      const stored = (top() - a) / secs;
      delay.disable();
      const behind = lag();
      const p99 = delay.percentile(99) / 1e6;
      // kept up: (almost) all of what was asked is stored, the search index and the counts are a few seconds behind at
      // most and not falling further back, the program got its turn within a quarter of a second
      const ok = stored >= rate * 0.9 && behind <= Math.max(rate * 5, 20000) && behind <= mid + rate && p99 < 250;
      rows.push({ rate, sent: sent / secs, stored, behind, p99, ok });
      out(`${fmt(rate).padStart(9)} ${fmt(stored).padStart(9)} ${fmt(behind).padStart(13)} ${`${Math.round(p99)} ms`.padStart(12)}${ok ? '' : '   ← no longer keeps up'}`);
      if (!ok) break;
      best = rate;
    }
    worker.postMessage({ rate: 0 });
    await ask({ stop: true });
    // what a message takes on disk, with its share of the search index and the counts (once both have caught up)
    for (let i = 0; i < 1000 && (ev.indexBatch() > 0 || ev.countBatch() > 0); i++) { /* catching up */ }
    const total = top();
    const used = (db.pragma('ev.page_count', { simple: true }) - db.pragma('ev.freelist_count', { simple: true })) * db.pragma('ev.page_size', { simple: true });
    const perMsg = total ? used / total : 0;
    out('');
    if (!best) {
      out('This server does not keep up with even 250 messages a second - a slow disk (network share, SD card)?');
    } else {
      // half of it for every day: logon peaks in the morning, the cleanup and the web pages need their share too
      const daily = best / 2;
      const pcs = (perSec) => fmt((perSec * 86400) / PER_PC_DAY);
      out(`Kept up with ${fmt(best)} messages a second.`);
      out(`For every day count half of it (logon peaks, cleanup, the web pages): ${fmt(daily)} a second, ${fmt((daily * 86400) / 1e6)} million a day -`);
      out(`  about ${pcs(daily)} Windows computers sending everything (some ${fmt(PER_PC_DAY)} messages a day each).`);
      if (daily > FLOOD.perSecond) out(`  WhatsOnMyNet takes at most ${fmt(FLOOD.perSecond)} a second (${pcs(FLOOD.perSecond)} such computers) - more with WOMN_MESSAGES_PER_SECOND in .env.`);
      if (perMsg) {
        const pcDay = PER_PC_DAY * perMsg;
        out('');
        out(`Usually the space limits, not the speed: a message takes about ${fmt(perMsg)} bytes (with the search index).`);
        out(`  One Windows computer sending everything: some ${(pcDay / 1024 ** 2).toFixed(1)} MB a day - 100 computers for 30 days: ${((pcDay * 100 * 30) / 1024 ** 3).toFixed(0)} GB.`);
        out('  Leaving out the noise (Messages → What takes the space?) makes that a fraction.');
      }
    }
    return { best, rows };
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    clean();
  }
}
