// Small Markdown renderer for the manual (our own text): headings, paragraphs, lists, images, **bold**, `code`.
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
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    let m;
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
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[m.length - 1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}

/** Table of contents: [{ id, text }] of the level-2 headings */
export function toc(text) {
  return String(text).split('\n').map((l) => /^##\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ id: slug(m[1]), text: m[1] }));
}
