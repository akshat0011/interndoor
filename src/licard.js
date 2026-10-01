/**
 * The LinkedIn post image — one per queued posting.
 *
 * A JOB CHEAT SHEET since 1 Oct 2026 (web/li-card.html), after his brief: "not
 * a interndoor product but something genuinely useful for which the user will
 * stop scrolling … dont use interndoor theme or elements". Light, in the
 * employer's own colour (read off its logo here), carrying the facts, the
 * skills to put on a resume as a checklist, what the work is and one way to
 * stand out — everything from the posting and its post, nothing invented.
 *
 * NOT web/og-card.html's job. That is the LINK PREVIEW a crawler fetches; this
 * is an image he ATTACHES, which replaces that preview.
 *
 * Output goes to PATHS.liCards in the state directory, never the repo.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, PATHS } from './paths.js';
import { chromiumPath } from './ogcard.js';
import { log } from './logger.js';
import { tidyTech, cityOf as postCity } from './postgen.js';
import { canonicalCity } from './facets.js';

const TEMPLATE = join(ROOT, 'web', 'li-card.html');
export const CARD_W = 1080;
export const CARD_H = 1350;

const SKILL_UPPER = new Set(['sql', 'aws', 'gcp', 'api', 'apis', 'css', 'html', 'ml', 'ai', 'nlp', 'ui', 'ux', 'etl', 'llm', 'llms', 'ci/cd', 'qa', 'os', 'iot', 'rtl', 'fpga', 'vlsi', 'oops', 'dsa', 'rest', 'sap', 'gpu']);
/* What the post's tidyTech table does not cover, cased the way the projects themselves write it. */
const SKILL_CASE = new Map(Object.entries({
  html5: 'HTML5', css3: 'CSS3', nodejs: 'Node.js', reactjs: 'React', 'react.js': 'React', nextjs: 'Next.js', 'next.js': 'Next.js',
  vuejs: 'Vue.js', 'vue.js': 'Vue.js', expressjs: 'Express.js', 'express.js': 'Express.js', '.net': '.NET', 'c#': 'C#', 'c++': 'C++',
  ios: 'iOS', devops: 'DevOps', mlops: 'MLOps', pytorch: 'PyTorch', tensorflow: 'TensorFlow', numpy: 'NumPy', 'scikit-learn': 'scikit-learn',
  fastapi: 'FastAPI', jquery: 'jQuery', powerbi: 'Power BI', 'power bi': 'Power BI', jira: 'Jira', gitlab: 'GitLab', kotlin: 'Kotlin',
  awslambda: 'AWS Lambda', awslambdas: 'AWS Lambda', typescript: 'TypeScript', javascript: 'JavaScript', mongodb: 'MongoDB', postgresql: 'PostgreSQL',
}));
function skillName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  /* "React js", "Next Js", "Node.JS" are one name each: look it up with the
     spaces and dots squeezed out too. */
  const key = s.toLowerCase();
  const cased = SKILL_CASE.get(key) ?? SKILL_CASE.get(key.replace(/[\s.]+/g, ''));
  if (cased) return cased;
  if (SKILL_UPPER.has(s.toLowerCase())) return s.toUpperCase();
  if (/[A-Z]/.test(s.slice(1))) return s;           // already cased: "PyTorch", "C++"
  /* The post's own casing table first (JavaScript, HTML5, Node.js, MongoDB…),
     then plain title case: "Html5" and "Javascript" read as typos on a card
     whose whole point is a list of skills. */
  const tidied = tidyTech(s);
  if (tidied !== s) return tidied.replace(/^./, (c) => c.toUpperCase());
  return s.replace(/(^|[\s/-])([a-z])/g, (m, sep, c) => sep + c.toUpperCase());
}
const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v ?? '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
};

/** "Bengaluru East, Karnataka, India" -> "Bengaluru": the city pages' own
 *  folding; "India, Pune" -> "Pune" through the post's country-first rule. */
const cityOf = (loc) => canonicalCity(loc) || postCity(String(loc ?? '').split(';')[0]);
/** "Thu, 1 Oct, 8:36 am" -> "1 Oct": the day is what a reader weighs. */
/* "0–6 months" is the posting saying "up to six months"; on a card it reads as
   a typo. Only a range that starts at zero changes. */
const durationText = (d) => String(d ?? '').replace(/^0\s*[–-]\s*/, 'Up to ');
/* ATS titles join their parts with underscores ("DX S2R_Full Stack Developer_
   FY27Q2"). The words stay; only the joins become spaces. */
const cardTitle = (t) => String(t ?? '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
const dayOf = (label) => (String(label ?? '').match(/\b(\d{1,2} [A-Z][a-z]{2})\b/) ?? [])[1] ?? '';

/**
 * What the card says. `job.facts` is postgen's jobFacts for the posting;
 * `job.tip` the post's own tip; `job.skills` the posting's skills; `job.snapshot`
 * the employer's record (src/companysnapshot.js) for the roles-open line and
 * the pay its other postings state.
 */
export function liCardModel(job) {
  const f = job.facts ?? {};
  const snap = job.snapshot ?? null;
  const company = f.company ?? job.company ?? '';
  const fullTime = f.fullTime ?? (job.employment_type === 'fulltime');
  const facts = [];
  const city = cityOf(f.location ?? job.location);
  if (city) facts.push({ label: 'Location', value: city, small: f.workplaceType ?? '' });
  facts.push({ label: 'Type', value: fullTime ? 'Full-time' : 'Internship', small: fullTime ? 'Freshers' : durationText(f.duration) });
  if (f.stipend) facts.push({ label: fullTime ? 'Salary' : 'Stipend', value: f.stipend, pay: true });
  else if (snap?.payRange) facts.push({ label: fullTime ? 'Salary' : 'Stipend', value: 'Not stated', small: `Other ${company} roles state ${snap.payRange.text}` });
  else facts.push({ label: fullTime ? 'Salary' : 'Stipend', value: 'Not disclosed' });
  if (job.experience) facts.push({ label: 'Experience', value: job.experience });
  if (f.batch) facts.push({ label: 'Batch', value: f.batch });
  if (dayOf(f.postedLabel)) facts.push({ label: 'Posted', value: dayOf(f.postedLabel) });

  /* The posting's own skills, the model's pick first, then the extractor's —
     the same words a recruiter's search will look for on a resume. */
  const seen = new Set();
  const named = [...(f.keySkills ?? []), ...parseList(job.skills)]
    .map(skillName).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  /* "Linux" beside "Unix/Linux" is one skill twice: drop a skill that another
     one already names as a whole word. */
  const words = (s) => s.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean);
  const skills = named.filter((s) => !named.some((o) => o !== s && o.length > s.length && words(o).includes(s.toLowerCase()))).slice(0, 8);

  const open = Number(snap?.openNow ?? 0);
  return {
    company,
    pill: fullTime ? 'Hiring freshers' : 'Hiring interns',
    /* The caller's title is the site's own (publishedTitle: an owner edit, else
       the clean title); the post's facts carry the stored original. */
    title: cardTitle(job.title || f.title || ''),
    facts: facts.slice(0, 6),
    skillsHeading: 'Skills to have on your resume',
    skills,
    does: (f.bullets ?? []).slice(0, 3),
    tip: job.tip || f.tipFallback || '',
    more: open > 1 ? `${open - 1} more open at ${company}` : '',
  };
}

/**
 * Fill the template with a model, colour it from the logo and fit it — the
 * whole drawing, shared by the renderer and test/licard.test.mjs so the test
 * measures the real thing.
 */
export async function drawCard(page, html, m, logoSrc = '') {
  await page.setContent(html, { waitUntil: 'networkidle' });
  /* Everything goes in through textContent: employer names, titles and skills
     are scraped text, and this page is rendered by a real browser. */
  await page.evaluate(({ m, logoSrc }) => {
    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    $('co').textContent = m.company;
    $('pill').textContent = m.pill;
    $('ttl').textContent = m.title;
    for (const f of m.facts) {
      const d = el('div', f.pay ? 'fact is-pay' : 'fact');
      d.append(el('span', '', f.label), el('b', '', f.value));
      if (f.small) d.append(el('small', '', f.small));
      $('facts').append(d);
    }
    if (m.skills.length) {
      $('skills-h').textContent = m.skillsHeading;
      for (const s of m.skills) { const c = el('div', 'check'); c.append(el('i'), el('em', '', s)); $('checks').append(c); }
    } else $('skills-sec').remove();
    if (m.does.length) for (const d of m.does) $('does').append(el('div', 'do', d));
    else $('does-sec').remove();
    if (m.tip) $('tip').textContent = m.tip; else $('tip-sec').remove();
    $('more').textContent = m.more;
    if (logoSrc) $('logo').src = logoSrc; else $('plate').remove();
  }, { m, logoSrc });

  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    /* THE EMPLOYER'S COLOUR, read off its own logo: the most common saturated
       hue, averaged. A monochrome logo keeps the default blue. Darkened until
       it holds 4.5:1 as text on the paper, so a yellow logo cannot produce an
       unreadable heading. */
    const img = document.getElementById('logo');
    let rgb = null;
    if (img && img.src) {
      await img.decode().catch(() => {});
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 64, 64);
      const d = x.getImageData(0, 0, 64, 64).data;
      const buckets = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        if (a < 200) continue;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 510, s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
        if (s < 0.35 || l < 0.12 || l > 0.88) continue;
        let h = 0;
        if (max === r) h = ((g - b) / (max - min)) % 6; else if (max === g) h = (b - r) / (max - min) + 2; else h = (r - g) / (max - min) + 4;
        const key = Math.round(((h * 60 + 360) % 360) / 24);
        const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        e.n++; e.r += r; e.g += g; e.b += b; buckets.set(key, e);
      }
      const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
      if (best && best.n > 20) rgb = [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round);
    }
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const paper = [251, 250, 247];
    if (rgb) {
      let text = rgb.slice();
      while (contrast(text, paper) < 4.5 && text.some((v) => v > 0)) text = text.map((v) => Math.max(0, Math.round(v * 0.9)));
      const css = (a) => `rgb(${a.join(',')})`;
      const root = document.documentElement.style;
      root.setProperty('--accent', css(rgb));
      root.setProperty('--accent-text', css(text));
      root.setProperty('--accent-ink', contrast(rgb, [255, 255, 255]) >= 3 ? '#ffffff' : '#111318');
      root.setProperty('--accent-soft', css(rgb.map((v) => Math.round(v * 0.1 + 255 * 0.9))));
    }

    /* FIT. The name to its line, the title to its box, each fact to two lines;
       then, while the page still overflows, drop whole sections in order of
       least use — never clip one. */
    const shrink = (el, fits, floor) => {
      let size = parseFloat(getComputedStyle(el).fontSize);
      while (size > floor && !fits()) { size -= 2; el.style.fontSize = `${size}px`; }
    };
    const co = document.getElementById('co');
    shrink(co, () => co.scrollWidth <= co.clientWidth + 0.5, 26);
    /* AGAINST THE BOX'S CAP, NOT THE BOX. The box is as tall as the title up to
       its max-height, so measuring the title against the box compared it with
       itself, and a few pixels of glyph overhang shrank every multi-line
       title to the floor — this repo's fit-loop tautology, a fourth time. */
    const ttl = document.getElementById('ttl');
    const cap = parseFloat(getComputedStyle(ttl.parentElement).maxHeight);
    shrink(ttl, () => ttl.getBoundingClientRect().height <= cap + 0.5, 40);
    for (const b of document.querySelectorAll('.fact b')) shrink(b, () => b.scrollHeight <= parseFloat(getComputedStyle(b).lineHeight) * 2 + 1, 22);
    const main = document.getElementById('main');
    const over = () => main.scrollHeight > main.clientHeight + 0.5;
    const does = [...document.querySelectorAll('.do')];
    while (over() && does.length > 1) does.pop().remove();
    for (const id of ['does-sec', 'tip-sec']) if (over()) document.getElementById(id)?.remove();
    /* No third step: with the duties and the tip gone, even a 120-character
       title, six two-line facts and eight skills fit (measured), so trimming
       the checklist could never run and no test could see it. */
  });
}

export async function renderLiCards(jobs, outDir = PATHS.liCards, { force = false } = {}) {
  const out = new Map();
  if (!jobs.length) return out;
  mkdirSync(outDir, { recursive: true });

  const todo = jobs.filter((j) => force || !existsSync(join(outDir, `${j.id}.png`)));
  for (const j of jobs) {
    const p = join(outDir, `${j.id}.png`);
    if (existsSync(p)) out.set(String(j.id), p);
  }
  if (!todo.length) return out;

  const exe = chromiumPath();
  if (!exe) { log.warn('No Playwright Chromium — skipping LinkedIn card images.'); return out; }

  const html = readFileSync(TEMPLATE, 'utf8');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: CARD_W, height: CARD_H }, deviceScaleFactor: 2 });
    for (const job of todo) {
      const m = liCardModel(job);
      let logoSrc = '';
      if (job.logo) {
        const f = join(ROOT, 'web', 'public', job.logo.replace(/^\//, ''));
        if (existsSync(f)) {
          const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
          logoSrc = `data:image/${ext};base64,${readFileSync(f).toString('base64')}`;
        }
      }
      await drawCard(page, html, m, logoSrc);
      await page.waitForTimeout(60);

      const file = join(outDir, `${job.id}.png`);
      writeFileSync(file, await page.locator('#card').screenshot({ type: 'png' }));
      out.set(String(job.id), file);
    }
  } finally {
    await browser.close();
  }
  log.info(`LinkedIn card image${todo.length === 1 ? '' : 's'}: ${todo.length} rendered.`);
  return out;
}
