// The coffee button looks like the official Buy Me a Coffee button and loads nothing from the internet
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('coffee: the Buy Me a Coffee logo is shipped with the program and used in About and in the menu', () => {
  const svg = read('public/img/bmc-logo.svg');
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(svg, /href=|<script|url\(/i, 'the logo refers to nothing else');
  assert.match(read('public/js/views/about.js'), /src: '\/img\/bmc-logo\.svg'[\s\S]*'Buy me a coffee'/);
  assert.match(read('public/js/app.js'), /src: '\/img\/bmc-logo\.svg'/);
  assert.match(read('public/css/app.css'), /\.btn\.btn-coffee \{[^}]*background: #ffdd00/);
});
