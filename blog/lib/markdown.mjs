/* A small Markdown renderer for the blog's own posts, not a general one.

   It reads the subset the posts are written in and REFUSES everything else,
   so a typo surfaces at build time instead of shipping as literal asterisks:

     ## and ### headings          paragraphs          - and 1. lists (one level)
     > quotes                     | pipe | tables |    ``` fenced code
     ---  rules                   **bold** *italic* `code` [text](href) [^source]
     ::: chart <dataset>.<chart>  (one line)
     ::: findings / ::: note / ::: method  ...  :::   (containers)

   There is no raw HTML. Every character of text is escaped, and a link may
   only point at http(s), mailto, a root-relative path or a #fragment. The
   em dash and en dash are refused outright: the house style uses a colon, a
   comma or a full stop, and a plain hyphen for ranges. */

export class MarkdownError extends Error {}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/* Straight quotes to typographic ones, in text only (never code or a URL). An
   apostrophe inside a word, a quote after a space or bracket, and the rest. */
export function smartQuotes(s) {
  return String(s)
    .replace(/(^|[\s(\[{"“‘-])"/g, '$1“').replace(/"/g, '”')
    .replace(/(\w)'(\w)/g, '$1’$2')
    .replace(/(^|[\s(\[{"“-])'/g, '$1‘').replace(/'/g, '’');
}

const text = (s) => esc(smartQuotes(s));

export function slugify(s) {
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 72).replace(/-+$/, '') || 'section';
}

/* A root-relative path, never a protocol-relative one: //evil.example starts
   with a slash too. */
const SAFE_HREF = /^(https?:\/\/[^\s<>"]+|mailto:[^\s<>"]+|\/(?!\/)[^\s<>"]*|#[A-Za-z0-9_-]+)$/;

/** Inline formatting inside one block of text. */
export function inline(src, ctx = {}) {
  const s = String(src);
  let out = '';
  let buf = '';
  const flush = () => { out += text(buf); buf = ''; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*_[\]()#!>|.-]/.test(s[i + 1])) {
      buf += s[i + 1]; i += 2; continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { flush(); out += `<code>${esc(s.slice(i + 1, j))}</code>`; i = j + 1; continue; }
      throw new MarkdownError(`An unclosed \` in: ${s}`);
    }
    if (c === '[' && s[i + 1] === '^') {
      const j = s.indexOf(']', i);
      const id = j > 0 ? s.slice(i + 2, j) : '';
      if (!/^[a-z0-9-]+$/.test(id)) throw new MarkdownError(`A citation needs [^id] with a lowercase id, in: ${s}`);
      if (!ctx.cite) throw new MarkdownError(`A citation [^${id}] where none are allowed.`);
      flush(); out += ctx.cite(id); i = j + 1; continue;
    }
    if (c === '[') {
      const close = matchBracket(s, i);
      if (close > 0 && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2);
        if (end < 0) throw new MarkdownError(`An unclosed link in: ${s}`);
        const label = s.slice(i + 1, close);
        const href = s.slice(close + 2, end).trim();
        if (!SAFE_HREF.test(href)) throw new MarkdownError(`Refused link target "${href}"`);
        if (ctx.checkLink) ctx.checkLink(href);
        flush();
        out += `<a href="${esc(href)}">${inline(label, { ...ctx, cite: null })}</a>`;
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('**', i)) {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) { flush(); out += `<strong>${inline(s.slice(i + 2, j), ctx)}</strong>`; i = j + 2; continue; }
      throw new MarkdownError(`An unclosed ** in: ${s}`);
    }
    if ((c === '*' || c === '_') && /\S/.test(s[i + 1] ?? '') && (c === '*' || !/\w/.test(s[i - 1] ?? ''))) {
      const j = closeEmphasis(s, i + 1, c);
      if (j > 0) { flush(); out += `<em>${inline(s.slice(i + 1, j), ctx)}</em>`; i = j + 1; continue; }
    }
    buf += c; i += 1;
  }
  flush();
  return out;
}

function matchBracket(s, open) {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '[') depth++;
    else if (s[k] === ']') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

function closeEmphasis(s, from, ch) {
  for (let k = from; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === ch && /\S/.test(s[k - 1]) && (ch === '*' ? s[k + 1] !== '*' : !/\w/.test(s[k + 1] ?? ''))) return k;
  }
  return -1;
}

/** Plain text of an inline source string: for headings ids, word counts, search. */
export function plain(src) {
  return smartQuotes(String(src)
    .replace(/\[\^[a-z0-9-]+\]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\\(.)/g, '$1'));
}

const BLOCK_START = /^(#{1,6}\s|```|>|[-*]\s|\d+\.\s|\||:::|---\s*$|Table:\s)/;

/**
 * Render a post body. Returns the HTML plus what the page around it needs:
 * the h2/h3 outline for the contents, the citation order, and a word count.
 */
export function renderMarkdown(src, ctx = {}) {
  if (/[\u2014\u2013]/.test(src)) {
    const line = src.split('\n').findIndex((l) => /[\u2014\u2013]/.test(l)) + 1;
    throw new MarkdownError(`An em or en dash on line ${line}. Use a colon, a comma, a full stop, or a hyphen for a range.`);
  }
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const headings = [];
  const ids = new Set(ctx.reservedIds ?? []);
  const words = { n: 0 };
  const count = (s) => { words.n += (plain(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’.,%₹-]*/gu) ?? []).length; };
  const html = blocks(lines, 0, lines.length, { ...ctx, headings, ids, count });
  return { html, headings, words: words.n };
}

function uniqueId(base, ids) {
  let id = base; let n = 2;
  while (ids.has(id)) id = `${base}-${n++}`;
  ids.add(id);
  return id;
}

function blocks(lines, from, to, ctx) {
  const out = [];
  let i = from;
  let caption = null;
  while (i < to) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^Table:\s/.test(line)) { caption = line.replace(/^Table:\s*/, ''); i++; continue; }

    if (line.startsWith(':::')) {
      const m = line.match(/^:::\s*(\w+)(?:\s+(\S+))?\s*$/);
      if (!m) throw new MarkdownError(`A directive line needs "::: name": ${line}`);
      const [, name, arg] = m;
      if (name === 'chart') {
        if (!arg || !ctx.chart) throw new MarkdownError(`::: chart needs a dataset.chart name: ${line}`);
        out.push(ctx.chart(arg));
        i++;
        continue;
      }
      let end = i + 1;
      while (end < to && lines[end].trim() !== ':::') end++;
      if (end >= to) throw new MarkdownError(`::: ${name} is never closed with a ::: line.`);
      const inner = blocks(lines, i + 1, end, ctx);
      if (name === 'findings') {
        if (!/^<ol>/.test(inner) && !/^<ul>/.test(inner)) throw new MarkdownError('::: findings must hold a single list.');
        const id = uniqueId('key-findings', ctx.ids);
        ctx.headings.push({ level: 2, id, text: 'Key findings' });
        out.push(`<section class="findings" aria-labelledby="${id}">\n<h2 id="${id}">Key findings</h2>\n${inner.replace(/^<(o|u)l>/, '<ol class="findings-list">').replace(/<\/(o|u)l>$/, '</ol>')}\n</section>`);
      } else if (name === 'note') {
        out.push(`<aside class="callout callout-note">\n<p class="callout-k">Note</p>\n${inner}\n</aside>`);
      } else if (name === 'method') {
        /* The method is a section of the post, with its own heading in the
           outline, set apart in a box so it reads as the small print it is. */
        const id = uniqueId('how-this-was-counted', ctx.ids);
        ctx.headings.push({ level: 2, id, text: 'How this was counted' });
        out.push(`<section class="callout callout-method" aria-labelledby="${id}">\n<h2 id="${id}">How this was counted</h2>\n${inner}\n</section>`);
      } else {
        throw new MarkdownError(`Unknown directive ::: ${name}`);
      }
      i = end + 1;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      const level = h[1].length;
      if (level < 2 || level > 3) throw new MarkdownError(`Only ## and ### headings belong in a post body (the title is the h1): ${line}`);
      const id = uniqueId(slugify(plain(h[2])), ctx.ids);
      ctx.headings.push({ level, id, text: plain(h[2]) });
      ctx.count(h[2]);
      out.push(`<h${level} id="${id}">${inline(h[2], ctx)}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      let end = i + 1;
      while (end < to && !lines[end].startsWith('```')) end++;
      if (end >= to) throw new MarkdownError('A ``` fence is never closed.');
      const code = lines.slice(i + 1, end).join('\n');
      out.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(code)}</code></pre>`);
      i = end + 1;
      continue;
    }

    if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (line.startsWith('>')) {
      const body = [];
      while (i < to && lines[i].startsWith('>')) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>\n${blocks(body, 0, body.length, ctx)}\n</blockquote>`);
      continue;
    }

    if (line.startsWith('|')) {
      const rows = [];
      while (i < to && lines[i].startsWith('|')) { rows.push(lines[i]); i++; }
      out.push(table(rows, caption, ctx));
      caption = null;
      continue;
    }

    const li = line.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < to) {
        const m = lines[i].match(/^([-*]|\d+\.)\s+(.*)$/);
        if (m && /\d/.test(m[1]) === ordered) { items.push([m[2]]); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i])) {
          if (/^\s+([-*]|\d+\.)\s/.test(lines[i])) throw new MarkdownError(`Nested lists are not supported: ${lines[i]}`);
          items[items.length - 1].push(lines[i].trim()); i++; continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>\n${items.map((parts) => { const s = parts.join(' '); ctx.count(s); return `<li>${inline(s, ctx)}</li>`; }).join('\n')}\n</${tag}>`);
      continue;
    }

    if (/^\s+\S/.test(line) && /^\s+([-*]|\d+\.)\s/.test(line)) throw new MarkdownError(`Nested lists are not supported: ${line}`);

    const para = [];
    while (i < to && lines[i].trim() && !(para.length && BLOCK_START.test(lines[i]))) {
      if (!para.length && BLOCK_START.test(lines[i])) break;
      para.push(lines[i].trim());
      i++;
    }
    if (!para.length) throw new MarkdownError(`Could not read the line: ${line}`);
    const s = para.join(' ');
    ctx.count(s);
    out.push(`<p>${inline(s, ctx)}</p>`);
  }
  if (caption != null) throw new MarkdownError(`"Table: ${caption}" is not followed by a table.`);
  return out.join('\n');
}

function cells(row) {
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const parts = [];
  let cur = '';
  for (let k = 0; k < inner.length; k++) {
    if (inner[k] === '\\' && inner[k + 1] === '|') { cur += '|'; k++; continue; }
    if (inner[k] === '|') { parts.push(cur.trim()); cur = ''; continue; }
    cur += inner[k];
  }
  parts.push(cur.trim());
  return parts;
}

function table(rows, caption, ctx) {
  if (rows.length < 3) throw new MarkdownError('A table needs a header, a |---| line and at least one row.');
  const head = cells(rows[0]);
  const sep = cells(rows[1]);
  if (sep.length !== head.length || !sep.every((c) => /^:?-{3,}:?$/.test(c))) {
    throw new MarkdownError(`The second table line must be |---| separators, one per column: ${rows[1]}`);
  }
  const align = sep.map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : null));
  const cls = (k) => (align[k] ? ` class="a-${align[k]}"` : '');
  const body = rows.slice(2).map((r, n) => {
    const c = cells(r);
    if (c.length !== head.length) throw new MarkdownError(`Table row ${n + 1} has ${c.length} cells, the header has ${head.length}: ${r}`);
    c.forEach((x) => ctx.count(x));
    return `<tr>${c.map((x, k) => (k === 0 ? `<th scope="row"${cls(k)}>${inline(x, ctx)}</th>` : `<td${cls(k)}>${inline(x, ctx)}</td>`)).join('')}</tr>`;
  });
  const label = caption ? ` aria-label="${esc(plain(caption))}"` : ' aria-label="Table"';
  return `<div class="table-wrap" role="region" tabindex="0"${label}>\n<table>\n${caption ? `<caption>${inline(caption, ctx)}</caption>\n` : ''}<thead><tr>${head.map((x, k) => `<th scope="col"${cls(k)}>${inline(x, ctx)}</th>`).join('')}</tr></thead>\n<tbody>\n${body.join('\n')}\n</tbody>\n</table>\n</div>`;
}
