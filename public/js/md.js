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

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '');

/** Markdown → HTML string. imgBase is put in front of relative image paths. */
export function mdToHtml(text, { imgBase = '' } = {}) {
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
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
      out.push(`<h${n} id="${slug(m[2])}">${inline(m[2])}</h${n}>`);
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
  return out.join('\n');
}

/** Table of contents: [{ id, text }] of the level-2 headings */
export function toc(text) {
  return String(text).split('\n').map((l) => /^##\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ id: slug(m[1]), text: m[1] }));
}
