// Builds the PDF manuals from public/help/manual.<lang>.md (same text as the help page in the app).
//   node tools/build-manual.mjs        (needs Playwright with Chromium; ImageMagick makes the PDFs smaller)
// Output: public/help/WhatsOnMyNet-Handbuch.pdf and WhatsOnMyNet-Manual.pdf – shipped in the image and the release.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mdToHtml, toc } from '../public/js/md.js';
import { LOGO_MARK } from '../public/js/icons.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = path.join(root, 'public', 'help');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// Smaller images for the PDF (JPEG, 1600 px) – the app keeps the sharp PNGs
const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'womn-manual-'));
let hasConvert = true;
for (const f of fs.readdirSync(path.join(help, 'img'))) {
  const src = path.join(help, 'img', f);
  try { execFileSync('convert', [src, '-resize', '1600x', '-quality', '86', path.join(imgDir, f.replace(/\.png$/, '.jpg'))]); } catch { hasConvert = false; break; }
}

const T = {
  de: { file: 'WhatsOnMyNet-Handbuch.pdf', title: 'Handbuch', sub: 'Netzwerk-Inventar und Monitoring', contents: 'Inhalt', version: 'Version' },
  en: { file: 'WhatsOnMyNet-Manual.pdf', title: 'Manual', sub: 'Network inventory and monitoring', contents: 'Contents', version: 'Version' },
};

const css = `
@page { size: A4; margin: 18mm 17mm 20mm; }
* { box-sizing: border-box; }
body { font-family: "IBM Plex Sans", "Segoe UI", Helvetica, Arial, sans-serif; color: #1c2430; font-size: 10.5pt; line-height: 1.55; margin: 0; }
.cover { height: 255mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
.cover svg { width: 46mm; height: 46mm; color: #12a39a; }
.cover h1 { font-size: 34pt; margin: 10mm 0 2mm; letter-spacing: -0.5pt; }
.cover h1 span { color: #12a39a; }
.cover .sub { font-size: 15pt; color: #4a5768; margin: 0; }
.cover .meta { margin-top: 18mm; color: #6b7684; font-size: 10pt; }
.toc { page-break-after: always; }
.toc h2 { font-size: 16pt; margin: 0 0 6mm; }
.toc ol { margin: 0; padding-left: 6mm; columns: 1; }
.toc li { margin: 1.6mm 0; font-size: 11pt; }
.toc a { color: #1c2430; text-decoration: none; }
h2 { font-size: 16pt; margin: 9mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 0.6pt solid #cfd6de; page-break-after: avoid; color: #0f2a33; }
h3 { font-size: 12pt; margin: 6mm 0 2mm; page-break-after: avoid; }
p, ul, ol { margin: 0 0 3mm; }
li { margin: 0.8mm 0; }
code { font-family: "IBM Plex Mono", Consolas, monospace; font-size: 9pt; background: #eef3f5; padding: 0.3mm 1.2mm; border-radius: 1mm; }
figure { margin: 4mm 0 6mm; page-break-inside: avoid; }
img { width: 100%; border: 0.5pt solid #cfd6de; border-radius: 2mm; display: block; }
figcaption { font-size: 8.5pt; color: #6b7684; margin-top: 1.5mm; }
`;

const browser = await chromium.launch();
for (const lang of ['de', 'en']) {
  const L = T[lang];
  let md = fs.readFileSync(path.join(help, `manual.${lang}.md`), 'utf8').replace(/^# .*\n/, '');
  if (hasConvert) md = md.replace(/\(img\/([\w.-]+)\.png\)/g, '(img/$1.jpg)');
  const base = `${pathToFileURL(hasConvert ? imgDir : path.join(help, 'img')).href}/`;
  const body = mdToHtml(md, { imgBase: '' }).replace(/src="img\//g, `src="${base}`);
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${css}</style></head><body>
<section class="cover">${LOGO_MARK}<h1>Whats<span>OnMyNet</span></h1><p class="sub">${L.title} – ${L.sub}</p>
<p class="meta">${new Date().toISOString().slice(0, 10)}</p></section>
<section class="toc"><h2>${L.contents}</h2><ol>${toc(md).map((x) => `<li><a href="#${x.id}">${x.text.replace(/[<>&]/g, '')}</a></li>`).join('')}</ol></section>
${body}</body></html>`;
  // Loaded as a file next to the images (a page set from a string may not read local files)
  const htmlFile = path.join(imgDir, `manual-${lang}.html`);
  fs.writeFileSync(htmlFile, html);
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
  await page.pdf({ path: path.join(help, L.file), format: 'A4', printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font-size:8px;color:#8a94a0;padding:0 17mm;display:flex;justify-content:space-between"><span>WhatsOnMyNet – ${L.title}</span><span class="pageNumber"></span></div>`,
    margin: { top: '18mm', bottom: '20mm', left: '17mm', right: '17mm' } });
  await page.close();
  console.log(`${L.file}: ${(fs.statSync(path.join(help, L.file)).size / 1024 / 1024).toFixed(1)} MB`);
}
await browser.close();
fs.rmSync(imgDir, { recursive: true, force: true });
