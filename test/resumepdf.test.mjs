/**
 * Download PDF (web/public/resumepdf.js).
 *
 * THE THINGS THAT MUST NOT BREAK, in order:
 *
 *   1. The file is the resume and nothing else. It used to be window.print(),
 *      which printed the board behind the dialog, the follow band and the
 *      browser's own date, title and address over three sheets. So the text
 *      read back out of the file must be EXACTLY the resume's text, in reading
 *      order: nothing missing, nothing added.
 *
 *   2. One page. A resume that fits at any size from MAX_SIZE down to
 *      MIN_SIZE lands on one A4 page with nothing cut, and only one that will
 *      not fit even at the smallest size spills over, saying so.
 *
 *   3. An applicant tracking system can read it: real text in the standard
 *      Times faces (nothing embedded, no images), so the parser below, the one
 *      the site already ships, gets every word back.
 *
 * The file is read back with the vendored pdf.js, the same way a recruiter's
 * software would, never by grepping the bytes for a word.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  winAnsi, textWidth, wrapRuns, layout, fitResume, resumePdf, sheetModel, pdfFileName,
  PAGE_W, PAGE_H, MAX_SIZE, MIN_SIZE,
} from '../web/public/resumepdf.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
async function returns(label, fn, fallback) {
  try { return await fn(); } catch (err) { check(`${label} (threw ${err.message})`, false, true); return fallback; }
}

const pdfjs = await import('../web/public/vendor/pdfjs/pdf.min.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = fileURLToPath(new URL('../web/public/vendor/pdfjs/pdf.worker.min.mjs', import.meta.url));

/** Everything a reader of the file gets: pages, the text of each page in
 *  drawing order, its links, its info, and where every piece of text sits. */
async function read(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const ann = await page.getAnnotations();
    pages.push({
      text: tc.items.map((it) => it.str).join(''),
      items: tc.items.filter((it) => it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })),
      links: ann.filter((a) => a.subtype === 'Link').map((a) => a.url ?? a.unsafeUrl),
    });
  }
  const meta = await doc.getMetadata();
  await doc.destroy();
  return { numPages: doc.numPages, pages, info: meta.info };
}

const squash = (s) => s.replace(/\s+/g, '');
const app = readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');

// A real-shaped student resume (the one used to test the tailor).
const MODEL = {
  name: 'Riya Mehta',
  headline: 'Software Engineering Intern',
  contact: 'Delhi, India · +91 90000 00000 · riya.mehta@example.com · linkedin.com/in/riyamehta · github.com/riyam',
  sections: [
    { heading: 'Summary', blocks: [{ kind: 'para', runs: [{ text: 'B.Tech CSE student (2027) who builds full-stack apps and small AI tools, with “real” users.' }] }] },
    { heading: 'Projects', blocks: [
      { kind: 'item', title: 'JobBoard', org: 'Internship aggregator', dates: 'Jan 2026 – Present', where: 'github.com/riyam/jobboard', bullets: [
        'Developed a Node.js scraper (B.Tech project) with Playwright to collect 1,000+ postings daily into SQLite.',
        'Used Ollama to run local LLMs for summarising and classifying postings (C++ \\ Python).',
        'Built a static site with search and filters, refreshed every 30 minutes.',
        // Unbalanced on purpose: balanced parentheses are legal unescaped in a
        // PDF string, so only a lone one shows the escaping is real.
        'Wrote a parser for a) lists and b) tables, and one stray (.',
      ] },
      { kind: 'item', title: 'StudyPortal', org: 'Study portal with AI tutor (studyportal.vercel.app)', dates: 'Mar 2026 – Present', bullets: [
        'Built a study portal for 300+ students with a React/Vite front end and an Express/PostgreSQL back end.',
        'Grounded the AI tutor’s answers in the semester syllabus stored in PostgreSQL.',
      ] },
    ] },
    { heading: 'Education', blocks: [
      { kind: 'item', title: 'B.Tech, Computer Science and Engineering', org: 'GGSIPU', dates: '2023 – 2027', where: 'Delhi, India', bullets: ['CGPA 8.4'] },
    ] },
    { heading: 'Skills', blocks: [
      { kind: 'para', runs: [{ text: 'Languages: ', bold: true }, { text: 'Python, JavaScript, C++, SQL' }] },
      { kind: 'para', runs: [{ text: 'Tools: ', bold: true }, { text: 'Git, Docker, Linux, Playwright, PostgreSQL' }] },
    ] },
  ],
};

/** The model's text in the order a reader meets it. */
function expectedText(m) {
  const out = [m.name, m.headline ?? '', m.contact];
  for (const s of m.sections) {
    out.push(s.heading);
    for (const b of s.blocks) {
      if (b.kind === 'para') { out.push(b.runs.map((r) => r.text).join('')); continue; }
      out.push(b.title, b.dates, b.org, b.where ?? '');
      for (const t of b.bullets) out.push('•', t);
    }
  }
  return out.join('');
}
// The same text as the file can hold it (curly quotes and dashes survive;
// nothing here needs a stand-in).
const asFile = (s) => winAnsi(s).map((c) => String.fromCharCode(c)).join('')
  .replace(/[\u0080-\u009f]/g, (c) => ({ 0x93: '“', 0x94: '”', 0x92: '’', 0x96: '–', 0x95: '•' })[c.charCodeAt(0)] ?? c);

/* ---------------- 1. the resume and nothing else ---------------- */

console.log('\n== THE FILE IS THE RESUME AND NOTHING ELSE ==');
const one = resumePdf(MODEL, { date: new Date('2026-10-11T12:00:00Z') });
const got = await returns('the file parses', () => read(one.bytes), { numPages: 0, pages: [{ text: '', items: [], links: [] }], info: {} });
check('one page', got.numPages, 1);
check('and it says so', [one.pages, one.onePage], [1, true]);
check('at the largest size, because it fits', one.size, MAX_SIZE);
check('every word of the resume, in reading order, and nothing else', squash(got.pages[0].text), squash(asFile(expectedText(MODEL))));
check('no browser furniture: no address, no date, no page number',
  /interndoor\.com|https?:|\d+\/\d+\/\d+|\b1\/1\b|Page 1/.test(got.pages[0].text), false);
check('the name is the first thing on the page', got.pages[0].items[0]?.str.trim(), 'Riya Mehta');
check('a parenthesis and a backslash survive the file format', got.pages[0].text.includes('(C++ \\ Python)'), true);
check('curly quotes and dashes survive', /“real”/.test(got.pages[0].text) && /Jan 2026 – Present/.test(got.pages[0].text), true);
check('the title is the resume, for the PDF viewer and the saved file', got.info.Title, 'Riya Mehta - Resume');
check('and the author is the person', got.info.Author, 'Riya Mehta');
check('nobody else is named as the author', /InternDoor/.test(got.info.Author ?? ''), false);

console.log('\n== READABLE BY AN APPLICANT TRACKING SYSTEM ==');
const raw = Buffer.from(one.bytes).toString('latin1');
check('the three standard Times faces, nothing embedded',
  [...raw.matchAll(/\/BaseFont \/([\w-]+)/g)].map((m) => m[1]), ['Times-Roman', 'Times-Bold', 'Times-Italic']);
check('no font file, no image', /\/FontFile|\/Image|\/XObject/.test(raw), false);
check('WinAnsi, so every reader maps the letters back', (raw.match(/\/Encoding \/WinAnsiEncoding/g) || []).length, 3);
check('A4', [PAGE_W, PAGE_H], [595.28, 841.89]);
check('the page is A4 in the file', /\/MediaBox \[0 0 595\.28 841\.89\]/.test(raw), true);
check('the email is a link', got.pages[0].links.includes('mailto:riya.mehta@example.com'), true);
check('LinkedIn and GitHub are links', ['https://linkedin.com/in/riyamehta', 'https://github.com/riyam'].every((u) => got.pages[0].links.includes(u)), true);
check('a project URL in the text is a link too, and Node.js and B.Tech are not', got.pages[0].links.map((u) => u.replace(/\/$/, '')).filter((u) => !/mailto|linkedin|github\.com/.test(u)), ['https://studyportal.vercel.app']);

// The cross-reference table a strict reader trusts (pdf.js would quietly
// repair a broken one, so read it directly).
const xrefAt = Number(raw.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
check('startxref points at the table', raw.slice(xrefAt, xrefAt + 4), 'xref');
const offsets = [...raw.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
check('every object is where the table says', offsets.length > 6 && offsets.every((o, i) => raw.startsWith(`${i + 1} 0 obj\n`, o)), true);
check('the table counts them all', Number(raw.match(/\/Size (\d+)/)?.[1]), offsets.length + 1);
check('each stream is as long as it says', [...raw.matchAll(/<< \/Length (\d+) >>\nstream\n/g)].every((m) => raw.startsWith('\nendstream', m.index + m[0].length + Number(m[1]))), true);

console.log('\n== EVERYTHING INSIDE THE PAGE ==');
const xs = got.pages[0].items;
check('nothing past the left edge', xs.every((i) => i.x >= 31.9), true);
check('nothing past the right edge', xs.every((i) => i.x + i.w <= PAGE_W - 31.9), true);
check('nothing off the top or the bottom', xs.every((i) => i.y > 36 && i.y < PAGE_H - 36), true);
const dates = xs.find((i) => i.str.includes('Jan 2026'));
check('dates sit at the right margin', Math.round(dates.x + dates.w), Math.round(PAGE_W - 39.6));
const title = xs.find((i) => i.str.startsWith('JobBoard'));
check('on the same line as the role', Math.abs(dates.y - title.y) < 0.01, true);
// The LaTeX layout: the organisation on its own line under the title, with
// its place or link on the right of that line.
const org = xs.find((i) => i.str.trim() === 'Internship aggregator');
const where = xs.find((i) => i.str.includes('github.com/riyam/jobboard'));
check('the organisation sits on the line under the title', org && org.y < title.y && Math.abs(org.x - title.x) < 0.01, true);
check('with its link on the right of that line', where && Math.abs(where.y - org.y) < 0.01 && Math.round(where.x + where.w) === Math.round(PAGE_W - 39.6), true);
const nameItem = xs.find((i) => i.str.trim() === 'Riya Mehta');
check('the name is centred', Math.abs(nameItem.x + nameItem.w / 2 - PAGE_W / 2) < 0.5, true);
const head = xs.find((i) => i.str.trim() === 'Software Engineering Intern');
check('the headline sits under the name, centred', head && head.y < nameItem.y && Math.abs(head.x + head.w / 2 - PAGE_W / 2) < 0.5, true);
check('the organisation line is italic and the title bold', [/\/F3 [\d.]+ Tf 0 g [\d.]+ [\d.]+ Td \(Internship aggregator\) Tj/.test(raw), /\/F2 [\d.]+ Tf 0 g [\d.]+ [\d.]+ Td \(JobBoard\) Tj/.test(raw)], [true, true]);

/* ---------------- 2. one page ---------------- */

console.log('\n== ONE PAGE, BY SHRINKING, NEVER BY CUTTING ==');
const bullets = (n, w) => Array.from({ length: n }, (_, i) => `Bullet ${w}-${i}: shipped a feature that moved a measurable number for real users, and wrote it up.`);
const long = {
  ...MODEL,
  sections: [
    ...MODEL.sections,
    { heading: 'Experience', blocks: Array.from({ length: 5 }, (_, k) => ({ kind: 'item', title: `Software Intern ${k}`, org: 'Acme', dates: '2025', bullets: bullets(5, k) })) },
  ],
};
const lf = resumePdf(long);
const lr = await returns('the long file parses', () => read(lf.bytes), { numPages: 0, pages: [{ text: '' }] });
check('a long resume still lands on one page', [lr.numPages, lf.onePage], [1, true]);
check('in smaller type than the short one', lf.size < one.size && lf.size >= MIN_SIZE, true);
check('with every word of it', squash(lr.pages[0].text), squash(asFile(expectedText(long))));
// The fit is the LARGEST that works: one step up must not fit.
const fit = fitResume(long);
const up = Math.round((fit.size + 0.25) * 100) / 100;
const heightOf = (rows) => rows.reduce((n, r) => n + r.gap + r.h, 0);
check('and the largest type that fits', heightOf(layout(long, up, 34)) > PAGE_H - 80, true);

const huge = { ...long, sections: [...long.sections, ...Array.from({ length: 5 }, (_, k) => ({ heading: `More ${k}`, blocks: [{ kind: 'item', title: 'Role', org: 'Org', dates: '2024', bullets: bullets(8, `m${k}`) }] }))] };
const hf = resumePdf(huge);
const hr = await returns('the huge file parses', () => read(hf.bytes), { numPages: 0, pages: [] });
check('one that cannot fit spills over, and says so', [hf.onePage, hf.pages > 1, hr.numPages === hf.pages], [false, true, true]);
check('at the smallest size', hf.size, MIN_SIZE);
check('still with every word, nothing dropped', squash(hr.pages.map((p) => p.text).join('')), squash(asFile(expectedText(huge))));
// Slide a heading down the page one bullet at a time, so that somewhere it
// lands at the foot: it must always move over with what follows it.
let orphans = 0, swept = 0;
for (let n = 70; n <= 130; n++) {
  const m = { name: 'A', contact: '', sections: [
    { heading: 'Filler', blocks: [{ kind: 'item', title: 'Role', org: '', dates: '', bullets: bullets(n, 'f') }] },
    { heading: 'Next Section', blocks: [{ kind: 'item', title: 'Second role', org: '', dates: '', bullets: ['One.', 'Two.'] }] },
  ] };
  const f = resumePdf(m);
  if (f.onePage) continue;
  swept++;
  const r = await returns('a swept file parses', () => read(f.bytes), { pages: [] });
  if (r.pages.slice(0, -1).some((p) => p.items[p.items.length - 1]?.str.trim() === 'Next Section')) orphans++;
}
check('the sweep really spilled onto a second page', swept > 20, true);
check('a section heading never sits alone at the foot of a page', orphans, 0);

/* ---------------- 3. letters and widths ---------------- */

console.log('\n== LETTERS THE STANDARD FONT HAS, AND THOSE IT DOES NOT ==');
check('plain text is its own codes', winAnsi('Ab 9'), [65, 98, 32, 57]);
check('curly quotes, dashes, bullet, euro', winAnsi('‘’“”–—•€'), [145, 146, 147, 148, 150, 151, 149, 128]);
check('Latin-1 letters stay', winAnsi('José Müller'), [74, 111, 115, 233, 32, 77, 252, 108, 108, 101, 114]);
check('a rupee sign is spelled out', String.fromCharCode(...winAnsi('₹50,000')), 'Rs. 50,000');
check('an accent the font lacks is dropped, the letter kept', String.fromCharCode(...winAnsi('Ākash')), 'Akash');
check('a ligature is spelled out', String.fromCharCode(...winAnsi('ﬁnance')), 'finance');
check('an arrow becomes ->', String.fromCharCode(...winAnsi('A → B')), 'A -> B');
check('an emoji is left out', String.fromCharCode(...winAnsi('ok 🚀 done')), 'ok  done');
check('invisible characters go', String.fromCharCode(...winAnsi('a\u200bb\u00adc\ufeff')), 'abc');
check('odd spaces are spaces', String.fromCharCode(...winAnsi('a\u00a0b\u2009c\td')), 'a b c d');
const twice = (s) => winAnsi(String.fromCharCode(...winAnsi(s)));
check('converting twice changes nothing (a dash is never lost)', twice('“x” – y • z ₹'), winAnsi('“x” – y • z ₹'));

console.log('\n== WIDTHS ARE TIMES ==');
check('Hello at 10pt', Math.round(textWidth('Hello', 'r', 10) * 100) / 100, 22.22);
check('and in bold', Math.round(textWidth('Hello', 'b', 10) * 100) / 100, 22.78);
check('and in italic', Math.round(textWidth('Hello', 'i', 10) * 100) / 100, 22.22);
check('true still means bold', textWidth('Hello', true, 10), textWidth('Hello', 'b', 10));
check('W is wider than i', textWidth('W', false, 10) > textWidth('i', false, 10), true);

console.log('\n== LINES ==');
const sample = 'Developed a Node.js scraper (B.Tech project) with Playwright to collect postings daily into SQLite and built a static site with filters.';
let fits = true, rebuilt = true, unsplit = true;
for (const w of [60, 90, 140, 220, 300, 507]) {
  const lines = wrapRuns([{ text: sample }], w, 10);
  for (const segs of lines) {
    const last = segs[segs.length - 1];
    if (last.x + textWidth(last.text, last.bold, 10) > w + 0.01) fits = false;
  }
  if (lines.map((l) => l.map((g) => g.text).join('')).join(' ') !== sample) rebuilt = false;
  const words = sample.split(' ');
  for (const segs of lines) for (const word of segs.map((g) => g.text).join('').trim().split(' ')) if (!words.includes(word) && textWidth(word, false, 10) < w) unsplit = false;
}
check('no line is wider than its column', fits, true);
check('the lines put back together are the text, spaces and all', rebuilt, true);
check('a word is never split unless it is wider than the line', unsplit, true);
const longUrl = wrapRuns([{ text: 'see https://example.com/a/very/long/path/that/cannot/fit/on/one/line/at/all' }], 120, 10);
check('a link too long for a line is broken, not left hanging off the page',
  longUrl.every((segs) => segs.every((g) => g.x + textWidth(g.text, g.bold, 10) <= 120.01)), true);
const mixed = wrapRuns([{ text: 'Languages: ', bold: true }, { text: 'Python, C++' }], 500, 10);
check('a bold label and its list share a line, each in its own face',
  mixed[0].map((g) => [g.text, g.bold]), [['Languages:', true], [' Python, C++', false]]);

/* ---------------- 4. from the sheet on screen ---------------- */

// A small stand-in for the DOM renderSheet() builds: enough of childNodes,
// matches, querySelector(All) and textContent to read it.
class Text { constructor(t) { this.nodeType = 3; this.textContent = t; } }
class El {
  constructor(tag, cls, kids = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.classList = cls ? cls.split(' ') : [];
    this.childNodes = kids.map((k) => (typeof k === 'string' ? new Text(k) : k));
  }
  get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
  matches(sel) { return sel.split(',').some((s) => { s = s.trim(); return s.startsWith('.') ? this.classList.includes(s.slice(1)) : this.tagName === s.toUpperCase(); }); }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const k of n.childNodes) if (k.nodeType === 1) { if (k.matches(sel)) out.push(k); walk(k); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
const h = (tag, cls, ...kids) => new El(tag, cls, kids);
const sheet = h('div', 'sheet',
  h('div', 'r-name', 'Riya  Mehta'),
  h('div', 'r-headline r-add', 'Software Engineering Intern'),
  h('div', 'r-contact', 'riya@example.com'),
  h('section', 'r-sec', h('h5', null, 'Summary'), h('p', 'r-summary', 'Builds things. ', h('span', 'r-add', 'Added line.'))),
  h('section', 'r-sec', h('h5', null, 'Projects'),
    h('div', 'r-item',
      h('div', 'r-item-head', h('span', 'r-role', 'JobBoard'), h('span', 'r-dates', '2026')),
      h('div', 'r-item-sub', h('span', 'r-org', 'Aggregator'), h('span', 'r-where', 'Pune, India')),
      h('ul', null, h('li', null, 'Scraped postings.'), h('li', null, h('span', 'r-add', 'Edited by the reader.')), h('li', null, '  ')),
      'Typed after the list.')),
  h('section', 'r-sec', h('h5', null, 'Skills'),
    h('p', 'r-skills', h('b', null, 'Languages: '), h('span', null, 'Python'), ', ', h('span', 'r-add', 'Go'))),
  h('div', null, 'A line typed outside every section.'),
);
const sm = sheetModel(sheet);
check('name, headline and contact', [sm.name, sm.headline, sm.contact], ['Riya Mehta', 'Software Engineering Intern', 'riya@example.com']);
check('the sections, in order', sm.sections.map((s) => s.heading), ['Summary', 'Projects', 'Skills', '']);
check('a paragraph, highlight and all, as text', sm.sections[0].blocks, [{ kind: 'para', runs: [{ text: 'Builds things. Added line.' }] }]);
check('an item: role, dates, org, where', [sm.sections[1].blocks[0].title, sm.sections[1].blocks[0].dates, sm.sections[1].blocks[0].org, sm.sections[1].blocks[0].where], ['JobBoard', '2026', 'Aggregator', 'Pune, India']);
check('its bullets, an edited one included, an emptied one left out, typed text kept',
  sm.sections[1].blocks[0].bullets, ['Typed after the list.', 'Scraped postings.', 'Edited by the reader.']);
check('a skills line keeps its bold label', sm.sections[2].blocks[0].runs, [{ text: 'Languages: ', bold: true }, { text: 'Python', bold: false }, { text: ', ', bold: false }, { text: 'Go', bold: false }]);
check('text outside every section is not lost', sm.sections[3].blocks, [{ kind: 'para', runs: [{ text: 'A line typed outside every section.' }] }]);

console.log('\n== THE SHEET THE PAGE DRAWS, INTO THE FILE ==');
{
  // The real renderSheet() and sheetText() from app.js, run on a small fake
  // DOM, so the order and the two-line entries are pinned on the code that
  // ships, not on a copy of it.
  class Node2 {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = []; this.className = ''; this.dataset = {}; this.title = ''; }
    get classList() { const n = this; return { add(c) { n.className = `${n.className} ${c}`.trim(); }, contains: (c) => n.className.split(' ').includes(c) }; }
    get children() { return this.childNodes.filter((k) => k.nodeType === 1); }
    get textContent() { return this.childNodes.map((k) => k.textContent).join(''); }
    set textContent(t) { this.childNodes = [{ nodeType: 3, textContent: String(t) }]; }
    get innerText() { return this.textContent; }
    append(...kids) { this.childNodes.push(...kids); }
    replaceChildren() { this.childNodes = []; }
    matches(sel) { return sel.split(',').some((x) => { x = x.trim(); return x.startsWith('.') ? this.className.split(' ').includes(x.slice(1)) : this.tagName === x.toUpperCase(); }); }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const k of n.childNodes) if (k.nodeType === 1) { if (k.matches(sel)) out.push(k); walk(k); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  }
  const fakeDoc = { createElement: (t) => new Node2(t), createTextNode: (t) => ({ nodeType: 3, textContent: t }) };
  const grab = (name) => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
  const make = new Function('document', `const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };\n${grab('renderSheet')}\n${grab('sheetText')}\nreturn { renderSheet, sheetText };`);
  const { renderSheet, sheetText } = make(fakeDoc);
  const R = {
    name: 'Kabir Sharma', headline: 'Software Engineering Intern', contact: 'Pune, India | kabir@example.com',
    summary: 'Software Engineering Intern candidate with Node.js and MongoDB.',
    sections: [
      { heading: 'Education', items: [{ title: 'B.E. Computer Engineering', org: 'Pune Institute of Engineering and Technology', dates: '2022 - 2026', where: 'Pune, India', bullets: [] }] },
      { heading: 'Projects', items: [{ title: 'SplitSmart', org: 'MongoDB, Express, React, Node', dates: '', where: 'github.com/kabir/splitsmart', bullets: [{ text: 'Built a MERN app used by 150 people.', added: false }] }] },
    ],
    skills: [{ group: 'Web', items: [{ text: 'Node.js', added: false }, { text: 'MERN Stack', added: true, key: 'a1' }] }],
  };
  const box = new Node2('div');
  renderSheet(box, R);
  check('the headline is drawn, marked as an addition', [box.querySelector('.r-headline')?.textContent, box.querySelector('.r-headline')?.dataset.add], ['Software Engineering Intern', 'headline']);
  check('its highlight is on the words, not the whole line', [box.querySelector('.r-headline')?.className, box.querySelector('.r-headline')?.childNodes[0]?.className], ['r-headline', 'r-add']);
  const R3 = { name: 'K', sections: [{ heading: 'Achievements', items: [{ title: 'Achievements', org: '', dates: '', where: '', bullets: [{ text: '400+ LeetCode problems.' }] }] }], skills: [] };
  const box3 = new Node2('div');
  renderSheet(box3, R3);
  check('an item named after its own section is not printed twice', [box3.querySelectorAll('.r-role').length, box3.querySelectorAll('li').length], [0, 1]);
  check('Education leads, so Skills come right after it',
    box.querySelectorAll('h5').map((x) => x.textContent), ['Summary', 'Education', 'Skills', 'Projects']);
  const R2 = { ...R, sections: [R.sections[1], R.sections[0]] };
  const box2 = new Node2('div');
  renderSheet(box2, R2);
  check('otherwise Skills come right after the summary', box2.querySelectorAll('h5').map((x) => x.textContent), ['Summary', 'Skills', 'Projects', 'Education']);
  check('the organisation and its place share the second line', [box.querySelector('.r-item-sub')?.querySelector('.r-org')?.textContent, box.querySelector('.r-item-sub')?.querySelector('.r-where')?.textContent], ['Pune Institute of Engineering and Technology', 'Pune, India']);
  check('copied text keeps both lines of an entry', sheetText(box).includes('B.E. Computer Engineering | 2022 - 2026\nPune Institute of Engineering and Technology | Pune, India'), true);
  check('and the headline', sheetText(box).split('\n').slice(0, 3), ['Kabir Sharma', 'Software Engineering Intern', 'Pune, India | kabir@example.com']);
  const pdf = resumePdf(sheetModel(box));
  const back = await returns('the drawn sheet becomes a file', () => read(pdf.bytes), { pages: [{ text: '' }] });
  check('and the file reads in the same order', squash(back.pages[0].text), squash('Kabir SharmaSoftware Engineering InternPune, India | kabir@example.comSummarySoftware Engineering Intern candidate with Node.js and MongoDB.EducationB.E. Computer Engineering2022 - 2026Pune Institute of Engineering and TechnologyPune, IndiaSkillsWeb: Node.js, MERN StackProjectsSplitSmartMongoDB, Express, React, Nodegithub.com/kabir/splitsmart•Built a MERN app used by 150 people.'));
}

console.log('\n== FILE NAME ==');
check('name-Resume.pdf', pdfFileName('Riya Mehta'), 'Riya-Mehta-Resume.pdf');
check('no name, still a name', pdfFileName(''), 'Resume.pdf');
check('accents folded, slashes gone', pdfFileName('José / Ñúñez'), 'Jose-Nunez-Resume.pdf');

/* ---------------- 5. the button ---------------- */

console.log('\n== THE BUTTON BUILDS THE FILE, IT DOES NOT PRINT THE PAGE ==');
const handler = app.slice(app.indexOf("$('download-pdf').addEventListener"), app.indexOf("$('copy-text').addEventListener"));
check('the handler is found', handler.length > 200, true);
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('it never calls window.print', /\bprint\(\)/.test(code), false);
check('it reads the sheet on screen, edits included', /sheetModel\(visibleSheet\(\)\)/.test(handler), true);
check('and downloads a PDF file under the person\'s name',
  /type: 'application\/pdf'/.test(handler) && /a\.download = pdfFileName\(model\.name\)/.test(handler), true);
check('and says when it could not fit one page', /pdf\.onePage \?/.test(handler), true);
check('the module is versioned with app.js', /from '\.\/resumepdf\.js\?v=\d+'/.test(app), true);
const index = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
check('the board loads the new app.js', /\/app\.js\?v=1[4-9]|\/app\.js\?v=[2-9]\d/.test(index), true);

const css = readFileSync(new URL('../web/public/styles.css', import.meta.url), 'utf8');
const print = css.slice(css.lastIndexOf('@media print'));
check('Cmd+P on the result prints only the dialog, not the page behind it',
  /body:has\(> #tailor\[data-step="result"\]:not\(\[hidden\]\)\) > :not\(#tailor\) \{ display: none !important; \}/.test(print), true);
check('the sheet on screen is set in the PDF\'s face', /\.sheet \{ --sheet-font: "Times New Roman", Times,/.test(css), true);
check('and laid out like it: centred header, italic organisation line',
  /\.sheet \.r-name \{[^}]*text-align: center/.test(css) && /\.sheet \.r-org, \.sheet \.r-where \{ font-style: italic; \}/.test(css), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
