// The errors of the connections under Virtualization, Server hardware, Network controllers and Cloud are stored in
// English (logs, diagnostics); the German interface shows them in German. Every fixed text of the readers is known,
// texts with an address or a code too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkText } from '../public/js/checktext.js';

const FILES = ['proxmox.js', 'virt.js', 'cloud.js', 'redfish.js', 'truenas.js', 'veeam.js', 'ceph.js', 'netctl.js'];
// internal, never shown as the error of a host
const INTERNAL = new Set(['closed', 'invalid key', 'Unknown secret format']);

test('every fixed error text of the readers has a German version', () => {
  const missing = [];
  for (const f of FILES) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/new Error\('([^']+)'\)/g)) {
      const s = m[1];
      if (INTERNAL.has(s)) continue;
      if (checkText(s, 'de') === s) missing.push(`${f}: ${s}`);
    }
    // the network and TLS words of a host (netError, NET_TEXT)
    for (const w of src.matchAll(/\b(?:E(?:CONN[A-Z]+|NOTFOUND|HOSTUNREACH|NETUNREACH|TIMEDOUT|AI_AGAIN)|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE): '([^']+)'/g)) {
      if (checkText(w[1], 'de') === w[1]) missing.push(`${f}: ${w[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('texts with an address, a code or a name', () => {
  const cases = [
    ['no data from the host script for more than 15 minutes - is the scheduled task running?', 'seit über 15 Minuten keine Daten vom Host-Skript - läuft die geplante Aufgabe?'],
    ['not found (404): /api2/json/nodes - right address?', 'nicht gefunden (404): /api2/json/nodes - stimmt die Adresse?'],
    ['this host is not the pool master - enter the master: 10.0.10.5', 'dieser Host ist nicht der Pool-Master - den Master eintragen: 10.0.10.5'],
    ['certificate of login.microsoftonline.com not trusted - is a proxy breaking up TLS?', 'Zertifikat von login.microsoftonline.com wird nicht anerkannt - bricht ein Proxy TLS auf?'],
    ['no UniFi controller at this address (HTTP 404)', 'kein UniFi-Controller unter dieser Adresse (HTTP 404)'],
    ['sign-in refused (invalid_grant)', 'Anmeldung abgelehnt (invalid_grant)'],
    ['region eu-north-1 is not enabled for this account', 'Region eu-north-1 ist für dieses Konto nicht freigeschaltet'],
    ['Session.login: timeout', 'Session.login: Zeitüberschreitung'],
    ['connection refused', 'Verbindung abgelehnt'],
  ];
  for (const [en, de] of cases) assert.equal(checkText(en, 'de'), de);
  assert.equal(checkText('no data from the host script for more than 15 minutes - is the scheduled task running?', 'en'), 'no data from the host script for more than 15 minutes - is the scheduled task running?');
  assert.equal(checkText('HTTP 500', 'de'), 'HTTP 500', 'unknown stays as it is');
});
