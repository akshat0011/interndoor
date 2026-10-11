/**
 * The tailored resume as a real, one-page PDF file.
 *
 * Download PDF used to call window.print(), which prints the WHOLE page: the
 * board behind the dialog, the follow band, the browser's own date, title and
 * address in the margins, three sheets of paper. This builds the file itself
 * instead, from the resume on screen (edits included), and hands it over as a
 * download. Nothing leaves the browser.
 *
 * THE LOOK IS THE CLASSIC LaTeX RESUME (his ask, 11 Oct 2026: "similar looking
 * layout and fonts" to his own): name, headline and contact centred; section
 * titles in bold with a rule under them; each entry a bold title with its dates
 * on the right, then the organisation in italics with its location or link on
 * the right; bullets under it. Set in Times, the built-in PDF face closest to
 * LaTeX's Computer Modern, so nothing has to be embedded.
 *
 * What makes it ATS-friendly: one column, real text in reading order, standard
 * fonts every PDF reader and parser knows (nothing embedded or drawn as
 * shapes), plain section headings, bullets as text.
 *
 * One page: the layout is measured with the font's own letter widths and the
 * type is stepped down until everything fits on one A4 sheet. Nothing is ever
 * cut to make it fit. Only a resume that will not fit even at the smallest
 * size runs onto a second page, and the caller says so.
 *
 * Pure apart from sheetModel(), which reads the sheet's DOM, so the file can
 * be built and checked in Node.
 */

// Page size: A4, in points.
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
const SIZES = [];
for (let s = 11; s >= 7.5; s -= 0.25) SIZES.push(Math.round(s * 100) / 100);
export const MAX_SIZE = SIZES[0];
export const MIN_SIZE = SIZES[SIZES.length - 1];
// 0.55in, the LaTeX template's margin, then a tighter one before the type shrinks.
const MARGINS = [39.6, 32];
const TOP = 39.6;
const BOTTOM = 39.6;

// Times-Roman, Times-Bold and Times-Italic widths (1/1000 em) for WinAnsi
// codes 32..255, taken from the standard font metrics.
const ROMAN = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541, 350,
  500, 350, 333, 500, 444, 1000, 500, 500, 333, 1000, 556, 333, 889, 350, 611, 350,
  350, 333, 333, 444, 444, 350, 500, 1000, 333, 980, 389, 333, 722, 350, 444, 722,
  250, 333, 500, 500, 500, 500, 200, 500, 333, 760, 276, 500, 564, 333, 760, 333,
  400, 564, 300, 300, 333, 500, 453, 250, 333, 300, 310, 500, 750, 750, 750, 444,
  722, 722, 722, 722, 722, 722, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333,
  722, 722, 722, 722, 722, 722, 722, 564, 722, 722, 722, 722, 722, 722, 556, 500,
  444, 444, 444, 444, 444, 444, 667, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  500, 500, 500, 500, 500, 500, 500, 564, 500, 500, 500, 500, 500, 500, 500, 500,
];
const BOLD = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
  333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
  556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520, 350,
  500, 350, 333, 500, 500, 1000, 500, 500, 333, 1000, 556, 333, 1000, 350, 667, 350,
  350, 333, 333, 500, 500, 350, 500, 1000, 333, 1000, 389, 333, 722, 350, 444, 722,
  250, 333, 500, 500, 500, 500, 220, 500, 333, 747, 300, 500, 570, 333, 747, 333,
  400, 570, 300, 300, 333, 556, 540, 250, 333, 300, 330, 500, 750, 750, 750, 500,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 389, 389, 389, 389,
  722, 722, 778, 778, 778, 778, 778, 570, 778, 722, 722, 722, 722, 722, 611, 556,
  500, 500, 500, 500, 500, 500, 722, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  500, 556, 500, 500, 500, 500, 500, 570, 500, 556, 556, 556, 556, 500, 556, 500,
];
const ITALIC = [
  250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 675, 675, 675, 500,
  920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833, 667, 722,
  611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389, 278, 389, 422, 500,
  333, 500, 500, 444, 500, 444, 278, 500, 500, 278, 278, 444, 278, 722, 500, 500,
  500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400, 275, 400, 541, 350,
  500, 350, 333, 500, 556, 889, 500, 500, 333, 1000, 500, 333, 944, 350, 556, 350,
  350, 333, 333, 556, 556, 350, 500, 889, 333, 980, 389, 333, 667, 350, 389, 556,
  250, 389, 500, 500, 500, 500, 275, 500, 333, 760, 276, 500, 675, 333, 760, 333,
  400, 675, 300, 300, 333, 500, 523, 250, 333, 300, 310, 500, 750, 750, 750, 500,
  611, 611, 611, 611, 611, 611, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333,
  722, 667, 722, 722, 722, 722, 722, 675, 722, 722, 722, 722, 722, 556, 611, 500,
  500, 500, 500, 500, 500, 500, 667, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  500, 500, 500, 500, 500, 500, 500, 675, 500, 500, 500, 500, 500, 444, 500, 444,
];
const FACES = { r: ROMAN, b: BOLD, i: ITALIC };
const faceOf = (font) => (font === true || font === 'b' ? 'b' : font === 'i' ? 'i' : 'r');

const WIN_HIGH = {
  0x20ac: 128, 0x201a: 130, 0x0192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135,
  0x02c6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140, 0x017d: 142, 0x2018: 145,
  0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x02dc: 152,
  0x2122: 153, 0x0161: 154, 0x203a: 155, 0x0153: 156, 0x017e: 158, 0x0178: 159,
};
// Characters the standard font has no glyph for, said in ones it has.
const STAND_IN = {
  '\u20b9': 'Rs. ', '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u21d2': '=>',
  '\u2212': '-', '\u2010': '-', '\u2011': '-', '\u2043': '-', '\u2264': '<=', '\u2265': '>=',
  '\u2032': "'", '\u2033': '"', '\u2248': '~', '\u2260': '!=',
  '\u25cf': '\u2022', '\u25aa': '\u2022', '\u25e6': '\u2022', '\u2023': '\u2022', '\u27a2': '\u2022',
  '\u2794': '\u2022', '\u25a0': '\u2022', '\u25b8': '\u2022', '\u25ba': '\u2022', '\u2219': '\u2022',
  '\u2713': '', '\u2714': '', '\u2705': '',
};
// Already a WinAnsi code (text that has been through winAnsi() once): kept,
// so converting twice never loses a curly quote or a dash. A real C1 control
// character never occurs in a resume.
const WIN_SET = new Set(Object.values(WIN_HIGH));
const BLANKS = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\t\r\n\f\v]/g;
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;

/** Text as WinAnsi codes. A character with no glyph in the standard font is
 *  said another way where one exists (an accent dropped, a ligature spelled
 *  out, a rupee sign as "Rs."), and left out where none does. */
export function winAnsi(text) {
  const out = [];
  const s = String(text ?? '').replace(INVISIBLE, '').replace(BLANKS, ' ');
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) { out.push(c); continue; }
    if (WIN_HIGH[c]) { out.push(WIN_HIGH[c]); continue; }
    if (WIN_SET.has(c)) { out.push(c); continue; }
    const alt = STAND_IN[ch] ?? ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (alt === ch) continue;
    for (const a of alt) {
      const d = a.codePointAt(0);
      if ((d >= 32 && d <= 126) || (d >= 160 && d <= 255)) out.push(d);
      else if (WIN_HIGH[d]) out.push(WIN_HIGH[d]);
    }
  }
  return out;
}

const tidy = (t) => winAnsi(t).map((c) => String.fromCharCode(c)).join('').replace(/ {2,}/g, ' ').trim();

/** Width of WinAnsi-safe text, in points. `font` is 'r', 'b' or 'i' (true
 *  means bold). */
export function textWidth(text, font, size) {
  const table = FACES[faceOf(font)];
  let w = 0;
  for (let i = 0; i < text.length; i++) w += table[text.charCodeAt(i) - 32] ?? 0;
  return (w * size) / 1000;
}

const runFont = (r) => (r.italic ? 'i' : r.bold ? 'b' : 'r');

/**
 * Runs of text into lines no wider than `width`. A run is { text, bold } or
 * { text, italic }. Breaks at spaces; a word longer than a whole line (a long
 * link) is broken between letters. Each line is a list of segments
 * { x, text, font, bold }, and the space before a word travels with that word,
 * so a parser reading the file sees the words apart.
 */
export function wrapRuns(runs, width, size) {
  const words = [];
  let gap = false;
  for (const r of runs) {
    for (const piece of tidyKeep(r.text).split(/( +)/)) {
      if (!piece) continue;
      if (piece.startsWith(' ')) { gap = true; continue; }
      const last = words[words.length - 1];
      if (last && !gap) last.parts.push({ text: piece, font: runFont(r) });
      else words.push({ gap: words.length > 0 && gap, parts: [{ text: piece, font: runFont(r) }] });
      gap = false;
    }
  }
  const lines = [];
  let line = [];
  let x = 0;
  const wordW = (w) => w.parts.reduce((n, p) => n + textWidth(p.text, p.font, size), 0);
  const put = (w, withGap) => {
    for (const [i, p] of w.parts.entries()) {
      const text = i === 0 && withGap ? ` ${p.text}` : p.text;
      line.push({ x, text, font: p.font });
      x += textWidth(text, p.font, size);
    }
  };
  for (const w of words) {
    const lead = w.gap && line.length ? textWidth(' ', w.parts[0].font, size) : 0;
    const ww = wordW(w);
    if (line.length && x + lead + ww <= width + 0.01) { put(w, lead > 0); continue; }
    if (line.length) { lines.push(merge(line)); line = []; x = 0; }
    if (ww <= width + 0.01) { put(w, false); continue; }
    // Longer than a line on its own: break it between letters.
    for (const p of w.parts) {
      let chunk = '';
      for (const ch of p.text) {
        if (x + textWidth(chunk + ch, p.font, size) > width && (chunk || line.length)) {
          if (chunk) line.push({ x, text: chunk, font: p.font });
          lines.push(merge(line));
          line = []; x = 0; chunk = '';
        }
        chunk += ch;
      }
      if (chunk) { line.push({ x, text: chunk, font: p.font }); x += textWidth(chunk, p.font, size); }
    }
  }
  if (line.length) lines.push(merge(line));
  return lines;
}

// tidy() without the trim, so the space between two runs survives.
const tidyKeep = (t) => winAnsi(t).map((c) => String.fromCharCode(c)).join('');

// Neighbouring segments in the same face become one.
function merge(line) {
  const out = [];
  for (const seg of line) {
    const last = out[out.length - 1];
    if (last && last.font === seg.font) last.text += seg.text;
    else out.push({ ...seg, bold: seg.font === 'b' });
  }
  return out;
}

const lineWidth = (segs, size) => {
  const last = segs[segs.length - 1];
  return last ? last.x + textWidth(last.text, last.font, size) : 0;
};

/**
 * The resume on screen as a plain model:
 *   { name, headline, contact, sections: [{ heading, blocks: [
 *       { kind: 'para', runs } |
 *       { kind: 'item', title, org, dates, where, bullets: [text] } ] }] }
 * Read from the DOM renderSheet() builds, so whatever the reader edited or
 * removed is what goes into the file.
 */
export function sheetModel(box) {
  const text = (n) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const model = { name: '', headline: '', contact: '', sections: [] };
  let loose = null;
  const looseSection = () => {
    if (!loose) { loose = { heading: '', blocks: [] }; model.sections.push(loose); }
    return loose;
  };
  for (const node of box.childNodes) {
    if (node.nodeType === 3) {
      if (text(node)) looseSection().blocks.push({ kind: 'para', runs: [{ text: text(node) }] });
      continue;
    }
    if (node.nodeType !== 1) continue;
    if (node.matches('.r-name')) { model.name = text(node); continue; }
    if (node.matches('.r-headline')) { model.headline = text(node); continue; }
    if (node.matches('.r-contact')) { model.contact = text(node); continue; }
    if (!node.matches('.r-sec')) {
      if (text(node)) looseSection().blocks.push({ kind: 'para', runs: [{ text: text(node) }] });
      continue;
    }
    loose = null;
    const sec = { heading: '', blocks: [] };
    for (const part of node.childNodes) {
      if (part.nodeType === 3) {
        if (text(part)) sec.blocks.push({ kind: 'para', runs: [{ text: text(part) }] });
        continue;
      }
      if (part.nodeType !== 1) continue;
      if (part.tagName === 'H5') { sec.heading = text(part); continue; }
      if (part.matches('.r-item')) {
        const head = part.querySelector('.r-item-head');
        const sub = part.querySelector('.r-item-sub');
        const bullets = [...part.querySelectorAll('li')].map(text).filter(Boolean);
        // Anything typed into the item outside its two lines and its list.
        const extra = [...part.childNodes]
          .filter((n) => n !== head && n !== sub && !(n.nodeType === 1 && n.matches('ul')))
          .map(text).filter(Boolean);
        sec.blocks.push({
          kind: 'item',
          title: text(part.querySelector('.r-role')),
          org: text(part.querySelector('.r-org')),
          dates: text(part.querySelector('.r-dates')),
          where: text(part.querySelector('.r-where')),
          bullets: [...extra, ...bullets],
        });
        continue;
      }
      if (part.matches('.r-skills')) {
        const runs = [];
        for (const n of part.childNodes) {
          const t = (n.textContent ?? '').replace(/\s+/g, ' ');
          if (t) runs.push({ text: t, bold: n.nodeType === 1 && n.tagName === 'B' });
        }
        if (runs.some((r) => r.text.trim())) sec.blocks.push({ kind: 'para', runs });
        continue;
      }
      if (text(part)) sec.blocks.push({ kind: 'para', runs: [{ text: text(part) }] });
    }
    if (sec.heading || sec.blocks.length) model.sections.push(sec);
  }
  return model;
}

/**
 * The model as rows on a page at body size `size` with side margins `margin`.
 * A row is { gap, h, base, ops, keep }: space above it, its height, the type
 * size its baseline is set for, what to draw (relative to the row's top-left)
 * and whether it must stay with the row after it. Pure arithmetic; drawing
 * happens in drawPage(). Proportions follow the LaTeX template at 10pt: name
 * \LARGE, headline and section titles \large, 0.7pt rules.
 */
export function layout(model, size, margin) {
  const s = size;
  const width = PAGE_W - margin * 2;
  const lh = s * 1.22;
  const rows = [];
  const textRows = (runs, { x = 0, w = width, sz = s, gap = 0, keepFirst = false, center = false } = {}) => {
    const lines = wrapRuns(runs, w, sz);
    lines.forEach((segs, i) => {
      const shift = center ? (w - lineWidth(segs, sz)) / 2 : 0;
      rows.push({
        gap: i === 0 ? gap : 0, h: sz * 1.22, base: sz, keep: keepFirst && i === 0,
        ops: segs.map((g) => ({ type: 'text', x: x + shift + g.x, text: g.text, font: g.font, size: sz })),
      });
    });
    return lines.length;
  };
  // A line with text on the left and, optionally, on the right (dates, a
  // place, a link), the way \hfill sets it. The left side wraps short of the
  // right side; the right side sits on the first line.
  const pair = (left, right, font, gap) => {
    const r = tidy(right);
    const rw = r ? textWidth(r, font === 'i' ? 'i' : 'r', s) : 0;
    const start = rows.length;
    if (left.length) textRows(left, { w: width - (rw ? rw + s : 0), gap, keepFirst: true });
    else if (r) rows.push({ gap, h: lh, base: s, keep: true, ops: [] });
    if (r && rows[start]) rows[start].ops.push({ type: 'text', x: width - rw, text: r, font: font === 'i' ? 'i' : 'r', size: s });
    for (let i = start; i < rows.length; i++) rows[i].keep = true;
  };

  if (tidy(model.name)) textRows([{ text: model.name, bold: true }], { sz: s * 1.73, center: true });
  if (tidy(model.headline)) textRows([{ text: model.headline }], { sz: s * 1.2, center: true, gap: s * 0.15 });
  if (tidy(model.contact)) textRows([{ text: model.contact }], { center: true, gap: s * 0.2 });

  model.sections.forEach((sec) => {
    const head = tidy(sec.heading);
    const before = rows.length ? s * 0.95 : 0;
    if (head) {
      const hs = s * 1.2;
      rows.push({
        gap: before, h: hs * 1.2, base: hs, keep: true,
        ops: [
          { type: 'text', x: 0, text: head, font: 'b', size: hs },
          { type: 'rule', x: 0, w: width, dy: hs * 1.2 + s * 0.05 },
        ],
      });
      rows.push({ gap: 0, h: s * 0.45, base: s, keep: true, ops: [] });
    }
    sec.blocks.forEach((b, bi) => {
      const lead = bi === 0 ? (head ? 0 : before) : s * (b.kind === 'item' ? 0.7 : 0.3);
      if (b.kind === 'para') { textRows(b.runs, { gap: lead }); return; }
      const start = rows.length;
      pair(tidy(b.title) ? [{ text: b.title, bold: true }] : [], b.dates, 'r', lead);
      if (tidy(b.org) || tidy(b.where)) pair(tidy(b.org) ? [{ text: b.org, italic: true }] : [], b.where, 'i', rows.length > start ? 0 : lead);
      const ind = s * 1.4;
      b.bullets.forEach((t, i) => {
        const first = rows.length;
        const n = textRows([{ text: t }], { x: ind, w: width - ind, gap: i === 0 ? s * 0.4 : s * 0.3 });
        if (n) rows[first].ops.unshift({ type: 'text', x: s * 0.5, text: '\u0095', font: 'r', size: s });
      });
      if (!b.bullets.length && rows.length > start) rows[rows.length - 1].keep = false;
    });
  });
  if (rows.length) rows[rows.length - 1].keep = false;
  return rows;
}

const heightOf = (rows) => rows.reduce((n, r) => n + r.gap + r.h, 0);

/** The largest type that puts the whole resume on one page, or the smallest
 *  size when nothing fits. */
export function fitResume(model) {
  for (const size of SIZES) {
    for (const margin of MARGINS) {
      const rows = layout(model, size, margin);
      if (heightOf(rows) <= PAGE_H - TOP - BOTTOM) return { size, margin, rows, onePage: true };
    }
  }
  const margin = MARGINS[MARGINS.length - 1];
  return { size: MIN_SIZE, margin, rows: layout(model, MIN_SIZE, margin), onePage: false };
}

// Rows onto pages. Only reached when the resume does not fit one page.
function paginate(rows) {
  const room = PAGE_H - TOP - BOTTOM;
  const pages = [[]];
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const page = pages[pages.length - 1];
    const need = (page.length ? r.gap : 0) + r.h;
    // Keep a heading or an item's first lines with what follows them.
    let chain = need;
    for (let j = i; rows[j]?.keep && rows[j + 1] && j < i + 6; j++) chain += rows[j + 1].gap + rows[j + 1].h;
    if (page.length && (used + need > room || (r.keep && used + chain > room && chain <= room))) {
      pages.push([r]);
      used = r.h;
      continue;
    }
    page.push(r);
    used += need;
  }
  return pages;
}

// --- writing the file ---

// A link is a URL with its scheme or www, an email, or an address on a site
// students list (a profile, a deployed project). Not any word with a dot in
// it: "Node.js" and "B.Tech" are not links.
const HOSTS = 'linkedin\\.com|github\\.com|gitlab\\.com|kaggle\\.com|leetcode\\.com|medium\\.com|behance\\.net|dribbble\\.com|codeforces\\.com|codechef\\.com|hackerrank\\.com|vercel\\.app|netlify\\.app|github\\.io|pages\\.dev';
const LINK = new RegExp(
  '\\b(?:https?:\\/\\/|www\\.)[^\\s,;|()<>]+'
  + `|\\b(?:[a-z0-9-]+\\.)*(?:${HOSTS})(?:\\/[^\\s,;|()<>]*)?`
  + '|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+',
  'gi',
);

function linkTarget(raw) {
  const t = raw.replace(/[.,;:!?]+$/, '');
  if (t.includes('@') && !/^https?:/i.test(t) && !t.includes('/')) return { text: t, uri: `mailto:${t}` };
  return { text: t, uri: /^https?:\/\//i.test(t) ? t : `https://${t}` };
}

const num = (n) => (Math.round(n * 100) / 100).toString();

function pdfString(text) {
  let out = '(';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += `\\${text[i]}`;
    else if (c < 32 || c > 126) out += `\\${c.toString(8).padStart(3, '0')}`;
    else out += text[i];
  }
  return `${out})`;
}

// A PDF text string for the document's info: UTF-16, so any name survives.
function infoString(text) {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function asciiOnly(s) {
  return s.replace(/[^\x20-\x7e]/g, (ch) => encodeURI(ch));
}

const FONT_NAME = { r: 'F1', b: 'F2', i: 'F3' };

function drawPage(rows, margin, size) {
  const ops = [];
  const links = [];
  let top = PAGE_H - TOP;
  rows.forEach((r, i) => {
    if (i) top -= r.gap;
    for (const op of r.ops) {
      if (op.type === 'rule') {
        const y = top - op.dy;
        ops.push(`0 G 0.7 w ${num(margin + op.x)} ${num(y)} m ${num(margin + op.x + op.w)} ${num(y)} l S`);
        continue;
      }
      // One baseline per row, centred on the row's own type size, so a date
      // in another face sits on the same line as the title beside it.
      const y = top - r.h / 2 - 0.2555 * (r.base ?? size);
      const x = margin + op.x;
      ops.push(`BT /${FONT_NAME[faceOf(op.font)]} ${num(op.size)} Tf 0 g ${num(x)} ${num(y)} Td ${pdfString(op.text)} Tj ET`);
      for (const m of op.text.matchAll(LINK)) {
        const { text, uri } = linkTarget(m[0]);
        const lx = x + textWidth(op.text.slice(0, m.index), op.font, op.size);
        const lw = textWidth(text, op.font, op.size);
        links.push({ rect: [lx, y - op.size * 0.22, lx + lw, y + op.size * 0.75], uri });
      }
    }
    top -= r.h;
  });
  return { content: ops.join('\n'), links };
}

/**
 * The whole file. Returns { bytes, pages, size, onePage }: `bytes` is the PDF
 * as a Uint8Array, `size` the body type size it settled on.
 */
export function resumePdf(model, { date = new Date() } = {}) {
  const fit = fitResume(model);
  const pageRows = fit.onePage ? [fit.rows] : paginate(fit.rows);
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = (base) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
  const f1 = font('Times-Roman');
  const f2 = font('Times-Bold');
  const f3 = font('Times-Italic');
  const kids = [];
  for (const rows of pageRows) {
    const { content, links } = drawPage(rows, fit.margin, fit.size);
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const annots = links.map((l) => add(
      `<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(asciiOnly(l.uri))} >> >>`,
    ));
    kids.push(add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(PAGE_W)} ${num(PAGE_H)}] `
      + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${stream} 0 R`
      + `${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`,
    ));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /Lang (en) >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const name = String(model.name ?? '').replace(/\s+/g, ' ').trim();
  const stamp = `D:${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  const info = add(`<< /Title ${infoString(name ? `${name} - Resume` : 'Resume')}${name ? ` /Author ${infoString(name)}` : ''} /Creator (InternDoor) /Producer (InternDoor) /CreationDate (${stamp}) >>`);

  // Every character written is one byte (WinAnsi or ASCII), so string length
  // is byte length and the offsets in the table below are exact.
  let out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return { bytes, pages: pageRows.length, size: fit.size, onePage: fit.onePage };
}

/** "Riya Mehta" -> "Riya-Mehta-Resume.pdf". */
export function pdfFileName(name) {
  const base = tidy(name).normalize('NFKD').replace(/[^A-Za-z0-9 .-]/g, '').trim().replace(/\s+/g, '-');
  return `${base ? `${base}-` : ''}Resume.pdf`;
}
