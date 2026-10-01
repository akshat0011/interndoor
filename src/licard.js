/**
 * The LinkedIn post image — one per queued posting, a COMPANY SNAPSHOT since
 * 1 Oct 2026 (web/li-card.html, src/companysnapshot.js).
 *
 * NOT web/og-card.html's job. That renders the LINK PREVIEW a crawler fetches
 * when the post carries a URL. This is an image he ATTACHES, and attaching one
 * REPLACES that preview card — trading a large clickable target for a picture
 * that is not a link at all. Both exist because he wants the choice per post;
 * neither is a copy of the other and they are not kept in step.
 *
 * Output goes to PATHS.liCards in the state directory, never the repo: one file
 * per queued posting and `app/` is public.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, PATHS } from './paths.js';
import { chromiumPath } from './ogcard.js';
import { companySnapshot } from './companysnapshot.js';
import { log } from './logger.js';

const TEMPLATE = join(ROOT, 'web', 'li-card.html');
export const CARD_W = 1080;
export const CARD_H = 1350;

/**
 * What the card says. `job.snapshot` is the caller's companySnapshot (the
 * employer's rows); without one the card still draws, from the posting alone.
 */
export function liCardModel(job) {
  const snap = job.snapshot ?? companySnapshot({
    company: job.company, title: job.title, location: job.location,
    employment_type: job.employment_type ?? job.employmentType,
  }, [], []);
  const kind = snap.kind === 'fulltime' ? 'IS HIRING FRESHERS' : 'IS HIRING INTERNS';
  const where = [snap.city, snap.mode].filter(Boolean).join(' · ');
  /* The first tile is the most useful fact the data has: this role's pay; else
     the pay range the employer's postings state (the "salary breakdown"); else
     where most of its roles are. Never "0 of 108 state pay" — true, and not a
     reason to stop scrolling. */
  const topCity = snap.cities[0];
  const first = snap.pay
    ? { value: snap.pay, label: snap.kind === 'fulltime' ? 'Salary, as stated' : 'Stipend, as stated', pay: true }
    : snap.payRange
      ? { value: snap.payRange.text, label: `Pay stated in ${snap.payRange.n} of its postings`, pay: true }
      : topCity
        ? { value: topCity.name, label: snap.tracked === 1 ? 'Where this role is' : `${topCity.n} of its ${snap.tracked} roles are here` }
        : { value: '—', label: 'Location not stated' };
  const stats = [
    first,
    { value: String(snap.openNow), label: snap.openNow === 1 ? 'Role open now' : 'Roles open now' },
    { value: String(snap.tracked), label: snap.since ? `Posted since ${snap.since}` : 'Postings tracked' },
  ];
  return {
    company: snap.company,
    kicker: where ? `${kind} · ${where}` : kind,
    title: snap.title,
    stats,
    chartTitle: `${snap.company} postings we tracked, by month`,
    months: snap.tracked >= 3 ? snap.months : [],
    first: snap.tracked >= 3 ? '' : snap.tracked <= 1
      ? `The first ${snap.company} role we have tracked.`
      : `${snap.tracked} ${snap.company} roles tracked so far.`,
    skills: snap.skills,
  };
}

/**
 * Fill the template with a model and fit its type — the whole drawing, in one
 * function the renderer AND test/licard.test.mjs call, so the test measures
 * the real fit rather than a copy of it.
 */
export async function drawCard(page, html, m, logoSrc = '') {
  await page.setContent(html, { waitUntil: 'networkidle' });
  /* Everything goes in through textContent. Employer names and titles are
     scraped text, and this page is rendered by a real browser. */
  await page.evaluate(({ m, logoSrc }) => {
    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    $('co').textContent = m.company;
    $('kicker').textContent = m.kicker;
    $('ttl').textContent = m.title;
    for (const s of m.stats) {
      const d = el('div', s.pay ? 'stat is-pay' : 'stat');
      d.append(el('b', '', s.value), el('span', '', s.label));
      $('stats').append(d);
    }
    if (m.months.length) {
      $('chart-h').textContent = m.chartTitle;
      const max = Math.max(1, ...m.months.map((x) => x.n));
      for (const mo of m.months) {
        const b = el('div', `bar${mo.n ? '' : ' is-zero'}${mo.current ? ' is-now' : ''}`);
        const bar = el('i');
        bar.dataset.h = String(Math.round((mo.n / max) * 100));
        b.append(el('em', '', String(mo.n)), bar, el('small', '', mo.current ? `${mo.label} so far` : mo.label));
        $('bars').append(b);
      }
    } else {
      $('chart-h').remove();
      $('bars').replaceWith(el('div', 'first', m.first));
      $('chart').classList.add('is-short');
      document.querySelector('.main').classList.add('is-spread');
    }
    if (m.skills.length) {
      $('skills').append(el('div', 'lab', 'What they ask for'));
      for (const s of m.skills) $('skills').append(el('div', 'chip', s));
    } else {
      $('skills').remove();
    }
    const img = $('logo');
    if (logoSrc) img.src = logoSrc; else $('plate').remove();
  }, { m, logoSrc });

  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    /* Bars in PIXELS of the space left once the count and month label are
       laid out; a percentage of an auto-height flex child resolves to 0. */
    for (const b of document.querySelectorAll('.bar')) {
      const i = b.querySelector('i');
      const room = b.clientHeight - b.querySelector('em').offsetHeight - b.querySelector('small').offsetHeight - 16;
      i.style.height = `${Math.max(6, Math.round((Number(i.dataset.h) / 100) * room))}px`;
    }
    /* Shrink the employer name to its line and the title to its box. Each
       is measured against ITS OWN box — the third way this repo has got a
       fit loop wrong was measuring against the card. */
    const shrink = (el, fits, floor) => {
      let size = parseFloat(getComputedStyle(el).fontSize);
      while (size > floor && !fits()) { size -= 2; el.style.fontSize = `${size}px`; }
    };
    /* One row of skill chips: anything that wrapped is dropped, never clipped. */
    const chips = [...document.querySelectorAll('.skills .chip')];
    if (chips.length) {
      const row = chips[0].offsetTop;
      for (const c of chips) if (c.offsetTop > row + 2) c.remove();
    }
    /* A tile's figure shrinks to its tile — a city or a pay range is far
       wider than a count — and wraps only once it reaches the floor. */
    for (const b of document.querySelectorAll('.stat b')) {
      shrink(b, () => b.scrollWidth <= b.clientWidth + 0.5, 26);
      if (b.scrollWidth > b.clientWidth + 0.5) b.style.whiteSpace = 'normal';
    }
    const co = document.getElementById('co');
    shrink(co, () => co.scrollWidth <= co.clientWidth + 0.5, 34);
    const ttl = document.getElementById('ttl');
    const box = ttl.parentElement;
    shrink(ttl, () => ttl.scrollHeight <= box.clientHeight + 0.5 && ttl.scrollWidth <= box.clientWidth + 0.5, 30);
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
