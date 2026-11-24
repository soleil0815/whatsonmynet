// Small Markdown renderer for the manual (our own text): headings, paragraphs, lists, images, **bold**, `code`,
// ``` code blocks ``` and simple | pipe | tables |.
// Everything is escaped first; only these few constructs become HTML. Used by the help page and the PDF build.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

/** The bold lead of a paragraph without its colon: "**Wartungsfenster:** …" → "Wartungsfenster" */
export const leadOf = (line) => { const m = /^\*\*([^*]{2,90})\*\*/.exec(String(line).trim()); return m ? m[1].replace(/[:.]\s*$/, '').trim() : ''; };
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '');

// Anchors (headings and bold paragraph leads) get unique ids: the same words twice ("Security" in several chapters)
// become security, security-2, … Headings are numbered first, so a chapter keeps its plain slug (links from the
// settings), paragraphs take what is left, the level-1 title comes last (the help page leaves it out).
const MARK = '\u0001';
function assignIds(list) {
  const used = new Set();
  const order = (a) => (a.level === 1 ? 2 : a.level ? 0 : 1);
  for (const a of [...list].sort((x, y) => order(x) - order(y) || x.n - y.n)) {
    let id = a.base; let k = 1;
    while (used.has(id)) id = `${a.base}-${++k}`;
    used.add(id); a.id = id;
  }
}

function render(text, { imgBase = '' } = {}) {
  const out = [];
  const marks = [];
  let chapter = '';
  // placeholder for the id, filled in once all anchors of the text are known
  const anchor = (base, txt, level) => { const a = { n: marks.length, base, text: txt, level, sub: level ? '' : chapter }; marks.push(a); return `${MARK}${a.n}${MARK}`; };
  let list = null;
  let para = [];
  // a paragraph that starts with a bold lead ("**Maintenance windows:** …") can be linked to (search over everything)
  const flushPara = () => {
    if (!para.length) return;
    const lead = leadOf(para[0]);
    out.push(`<p${lead ? ` id="${anchor(slug(lead), lead.replace(/[*_`]/g, ''), 0)}"` : ''}>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  let code = null;
  let table = null;
  const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
      + `<tbody>${rows.map((r) => `<tr>${head.map((_, i) => `<td>${inline(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    table = null;
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    let m;
    // ``` … ```: shown as is (escaped), e.g. commands to copy; a numbered list after it keeps counting
    if (/^\s*```/.test(line)) {
      if (code) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else { flushPara(); flushList(); code = []; }
      continue;
    }
    if (code) { code.push(raw.replace(/^ {0,3}/, '')); continue; }
    // | a | b | with a |---|---| line under the head
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (table) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) table.push(cells(line)); continue; }
      flushPara(); flushList(); table = [cells(line)]; continue;
    }
    flushTable();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flushPara(); flushList();
      const n = m[1].length;
      if (n > 1) chapter = m[2].replace(/[*_`]/g, '');
      out.push(`<h${n} id="${anchor(slug(m[2]), n > 1 ? chapter : m[2], n)}">${inline(m[2])}</h${n}>`);
    } else if ((m = /^!\[([^\]]*)\]\(([\w./-]+)\)$/.exec(line))) {
      flushPara(); flushList();
      out.push(`<figure><img src="${esc(imgBase + m[2])}" alt="${esc(m[1])}" loading="lazy"><figcaption>${esc(m[1])}</figcaption></figure>`);
    } else if ((m = /^(\d+)\.\s+(.*)$/.exec(line)) || (m = /^-\s+(.*)$/.exec(line))) {
      flushPara();
      const tag = /^\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [], start: tag === 'ol' ? Number(m[1]) : 1 }; }
      list.items.push(m[m.length - 1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList(); flushTable();
  assignIds(marks);
  const html = out.join('\n').replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, n) => marks[n].id);
  return { html, marks };
}

/** Markdown → HTML string. imgBase is put in front of relative image paths. */
export function mdToHtml(text, opts = {}) { return render(text, opts).html; }

/**
 * Everything of the text that can be linked to, with the id it has on the rendered page: chapters (## / ###) and
 * bold paragraph leads, in order. [{ id, text, level (2, 3; 0 = paragraph), sub (chapter of a paragraph) }]
 */
export function anchors(text) {
  return render(text).marks.filter((a) => a.level !== 1).map(({ id, text: x, level, sub }) => ({ id, text: x, level, sub }));
}

/** Table of contents: [{ id, text }] of the level-2 headings */
export function toc(text) {
  return render(text).marks.filter((a) => a.level === 2).map((a) => ({ id: a.id, text: a.text }));
}
