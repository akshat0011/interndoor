/* Posts that arrive as HTML (Distribb's webhook, via bin/distribb-import.js).

   The Markdown posts are written by hand in a subset the renderer controls.
   These are written somewhere else, so the body is CLEANED, not trusted: an
   allow-list of tags and attributes, everything else unwrapped or dropped. The
   same function runs twice, once when the importer writes the post (with the
   images it downloaded) and again on every build, so a hand edit to the file
   cannot slip anything past it.

   What it guarantees, because the verifier and the CSP would refuse the page
   otherwise: no script, style, frame or form; no style= or on*= attribute; no
   em or en dash; one <h1> per page (the template's, so the body has none);
   unique heading ids that do not collide with the template's own; every
   #anchor pointing at something on the page; every image local (/media/...),
   because img-src is 'self'. */

const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'noscript', 'svg', 'math', 'template', 'object', 'embed',
  'form', 'button', 'select', 'textarea', 'canvas', 'video', 'audio', 'head', 'title', 'nav'];

const RENAME = { b: 'strong', i: 'em', h1: 'h2', h5: 'h4', h6: 'h4' };
const ALLOWED = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'blockquote', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'img', 'figure', 'figcaption', 'br', 'hr', 'code', 'pre', 'sup', 'sub']);
const VOID = new Set(['img', 'br', 'hr']);
const REL_OK = new Set(['nofollow', 'sponsored', 'ugc', 'noopener', 'noreferrer']);
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function slugify(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '');
}

/** Em and en dashes out: a range keeps a hyphen, anything else becomes a comma. */
export function undash(s) {
  return String(s)
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1-$2')
    .replace(/^\s*[\u2013\u2014]\s*/, '')
    .replace(/\s*[\u2013\u2014]\s*/g, ', ');
}

const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});/y;
/** Text between tags: keep real entities, escape everything that could be markup. */
function escText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(s);
      if (m) { out += m[0]; i += m[0].length - 1; } else out += '&amp;';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else out += c;
  }
  return out;
}
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const decode = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');
export const plainText = (html) => decode(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseAttrs(src) {
  const out = {};
  for (const m of String(src).matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** An https link (http is upgraded), a mailto, or a #fragment. Anything else is not a link. */
export function cleanHref(href) {
  const h = String(href ?? '').trim();
  if (/^#[A-Za-z0-9_-]+$/.test(h)) return h;
  if (/^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(h)) return h;
  let u;
  try { u = new URL(h.replace(/^http:\/\//i, 'https://')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u.href;
}

const intAttr = (v, max) => (/^\d{1,5}$/.test(String(v)) && Number(v) > 0 && Number(v) <= max ? String(Number(v)) : null);

/**
 * Clean one article body.
 *
 *   images(src) -> { src, width?, height? } | null   where an image goes; null drops it.
 *                  Default: keep only images already under /media/.
 *   deadLinks   -> a Set of hrefs to unwrap (the importer's live check of interndoor.com links).
 *
 * Returns { html, headings, words, images: [original srcs seen], links: [hrefs kept] }.
 */
export function cleanArticleHtml(src, { images = null, deadLinks = new Set(), reservedIds = [] } = {}) {
  let s = String(src ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<![^>]*>/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  for (const tag of DROP_WITH_CONTENT) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    s = s.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
  }

  const seenImages = [];
  const keptLinks = [];
  const imageFor = images ?? ((u) => (/^\/media\/[a-z0-9/_.-]+$/i.test(u) && !u.includes('..') ? { src: u } : null));
  const out = [];
  const stack = [];
  const headings = [];
  let skipAnchorText = 0;

  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  const text = (t) => { if (t) out.push(escText(undash(t))); };
  const close = (name) => {
    const k = stack.lastIndexOf(name);
    if (k < 0) return;
    while (stack.length > k) {
      const top = stack.pop();
      if (top.startsWith('h') && /^h[2-4]$/.test(top)) finishHeading();
      out.push(`</${top}>`);
      if (top === 'table') out.push('</div>');
    }
  };
  let headingStart = null;
  function finishHeading() {
    if (!headingStart) return;
    const { index, level, wantId } = headingStart;
    headings.push({ level, index, wantId, text: plainText(out.slice(index + 1).join('')) });
    headingStart = null;
  }

  let m;
  while ((m = TAG.exec(s))) {
    text(s.slice(last, m.index));
    last = TAG.lastIndex;
    const closing = m[1] === '/';
    let name = m[2].toLowerCase();
    name = RENAME[name] ?? name;
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      if (name === 'a' && skipAnchorText > 0 && !stack.includes('a')) { skipAnchorText--; continue; }
      close(name);
      continue;
    }
    const a = parseAttrs(m[3]);
    if (name === 'img') {
      if (a.src) seenImages.push(a.src);
      const img = a.src ? imageFor(a.src) : null;
      if (!img) continue;
      const w = intAttr(img.width ?? a.width, 6000);
      const h = intAttr(img.height ?? a.height, 6000);
      out.push(`<img src="${escAttr(img.src)}" alt="${escAttr(undash(a.alt ?? ''))}"${w && h ? ` width="${w}" height="${h}"` : ''} loading="lazy" decoding="async">`);
      continue;
    }
    if (VOID.has(name)) { out.push(`<${name}>`); continue; }
    if (name === 'a') {
      const href = cleanHref(a.href);
      if (!href || deadLinks.has(href) || stack.includes('a')) { skipAnchorText++; continue; }
      const rel = String(a.rel ?? '').toLowerCase().split(/\s+/).filter((r) => REL_OK.has(r));
      if (!href.startsWith('#')) keptLinks.push(href);
      out.push(`<a href="${escAttr(href)}"${rel.length ? ` rel="${rel.join(' ')}"` : ''}>`);
      stack.push('a');
      continue;
    }
    if (/^h[2-4]$/.test(name)) {
      if (headingStart) close(stack.find((x) => /^h[2-4]$/.test(x)));
      headingStart = { index: out.length, level: Number(name[1]), wantId: a.id };
      out.push(null);
      stack.push(name);
      continue;
    }
    let attrs = '';
    if (name === 'ol' && intAttr(a.start, 9999)) attrs = ` start="${intAttr(a.start, 9999)}"`;
    if (name === 'td' || name === 'th') {
      for (const k of ['colspan', 'rowspan']) if (intAttr(a[k], 50)) attrs += ` ${k}="${intAttr(a[k], 50)}"`;
      if (name === 'th' && ['col', 'row'].includes(a.scope)) attrs += ` scope="${a.scope}"`;
    }
    if (name === 'table') out.push('<div class="table-wrap" role="region" tabindex="0" aria-label="Table">');
    out.push(`<${name}${attrs}>`);
    stack.push(name);
  }
  text(s.slice(last));
  while (stack.length) close(stack[stack.length - 1]);

  /* Heading ids: the article's own when it is a clean slug, else one from the
     text; never one the template already uses, never twice. */
  const used = new Set(reservedIds);
  const idMap = new Map();
  for (const h of headings) {
    const want = ID.test(String(h.wantId ?? '')) ? h.wantId : '';
    const base = (want && !used.has(want) ? want : slugify(h.text)) || 'section';
    let id = base; let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    if (want) idMap.set(want, id);
    h.id = id;
    out[h.index] = `<h${h.level} id="${id}">`;
  }
  let html = out.join('');

  /* The article's own table of contents goes: the template draws one from the
     headings, and two lists of the same links is noise. */
  html = html.replace(/(?:<(h[2-4]) id="([^"]+)">[^<]*?(?:table of contents|contents|in this (?:article|guide|post))[^<]*<\/\1>\s*)?<(ul|ol)>(?:\s*<li>\s*<a href="#[^"]*">(?:(?!<\/?(?:ul|ol|li)\b)[\s\S])*?<\/a>\s*(?:<(?:ul|ol)>[\s\S]*?<\/(?:ul|ol)>\s*)?<\/li>){2,}\s*<\/\3>/gi,
    (all, _h, hid) => { if (hid) dropHeading(hid); return ''; });
  function dropHeading(id) {
    const k = headings.findIndex((h) => h.id === id);
    if (k >= 0) headings.splice(k, 1);
  }

  /* An anchor must land on the page: retarget renamed ids, unwrap the rest. */
  const finalIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]));
  html = html.replace(/<a href="#([^"]+)">([\s\S]*?)<\/a>/g, (all, frag, inner) => {
    const to = finalIds.has(frag) ? frag : idMap.get(frag);
    return to && finalIds.has(to) ? `<a href="#${to}">${inner}</a>` : inner;
  });

  html = html.replace(/<(p|li|strong|em|figcaption|blockquote)>\s*<\/\1>/g, '');
  html = html.replace(/<\/(p|h2|h3|h4|ul|ol|table|div|figure|blockquote|pre)>(?!\n)/g, '</$1>\n').replace(/\n\s*\n/g, '\n').trim();
  const words = (plainText(html).match(/[\p{L}\p{N}][\p{L}\p{N}'\u2019.,%\u20b9-]*/gu) ?? []).length;
  return {
    html,
    headings: headings.filter((h) => h.level <= 3).map(({ level, id, text: t }) => ({ level, id, text: t })),
    words,
    images: seenImages,
    links: keptLinks,
  };
}
