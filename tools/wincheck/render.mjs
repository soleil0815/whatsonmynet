// All PowerShell scripts as the program hands them out (address, key and pin filled in with example values), for the
// compatibility check of older Windows versions (compat.ps1).   node tools/wincheck/render.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import { hostScript } from '../../src/hostscripts.js';

const dir = path.resolve(process.argv[2] || 'wincheck-compat');
fs.mkdirSync(dir, { recursive: true });
const pin = { sha1: 'AB'.repeat(20), spki: 'x', key: '04' + 'AB'.repeat(64) };
for (const kind of ['windows', 'hyperv']) {
  const s = hostScript(kind, { url: 'https://womn.firma.local:8443/api/hosts/push', token: 'example-token', pin });
  fs.writeFileSync(path.join(dir, s.file), s.text);
  fs.writeFileSync(path.join(dir, s.uninstall.file), s.uninstall.text);
  console.log(s.file, s.uninstall.file);
}
