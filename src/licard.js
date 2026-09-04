/**
 * The LinkedIn post image — one per queued posting.
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
import { chromiumPath, cardModel } from './ogcard.js';
import { log } from './logger.js';

const TEMPLATE = join(ROOT, 'web', 'li-card.html');

/** The card's own view of a posting. Same shape the OG card takes, on purpose. */
export function liCardModel(job) {
  return cardModel(job);
}

/**
 * Shrink `.fit` text until its COLUMN fits.
 *
 * Measured against the container, never the card: the left column is 531px tall
 * because the lime band owns the last 96, so a card-bounds test reports "fits"
 * while the employer name is clipped by the band. Width is checked separately —
 * one unbreakable token runs off the side without ever growing the column.
 */
/**
 * Render one image per job. Returns a Map of job id -> file path.
 * `logo` is a site-relative path as it appears in jobs.json; a job without one
 * still renders, with an empty plate, rather than failing the batch.
 */
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
    const page = await browser.newPage({ viewport: { width: 1200, height: 627 }, deviceScaleFactor: 2 });
    for (const job of todo) {
      const m = liCardModel(job);
      await page.setContent(html, { waitUntil: 'networkidle' });

      // Inline the logo as a data URI: the card is rendered from a file:// page
      // with no server, so a site-relative /logos/x.jpg would never resolve.
      let logoSrc = '';
      if (job.logo) {
        const f = join(ROOT, 'web', 'public', job.logo.replace(/^\//, ''));
        if (existsSync(f)) {
          const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
          logoSrc = `data:image/${ext};base64,${readFileSync(f).toString('base64')}`;
        }
      }
      await page.evaluate(({ co, ttl, facts, logoSrc }) => {
        document.getElementById('co').textContent = co;
        document.getElementById('ttl').textContent = ttl;
        document.getElementById('facts').innerHTML =
          facts.map((f) => `<div class="chip"></div>`).join('');
        [...document.querySelectorAll('.chip')].forEach((c, i) => { c.textContent = facts[i]; });
        const img = document.getElementById('logo');
        if (logoSrc) img.src = logoSrc; else img.remove();
      }, { co: m.company, ttl: m.title, facts: m.facts, logoSrc });

      // Fonts BEFORE fitting. Measuring in Helvetica and reflowing in Archivo
      // has shipped three times on the other card.
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate((() => {
        for (const el of document.querySelectorAll('.fit')) {
          const box = el.parentElement;
          const room = () => {
            if (el.scrollWidth > el.clientWidth + 0.5) return false;
            const bs = getComputedStyle(box);
            const cap = box.clientHeight - parseFloat(bs.paddingTop) - parseFloat(bs.paddingBottom);
            if (!(cap > 0)) return true;
            const gap = parseFloat(bs.rowGap) || 0;
            let used = -gap;
            for (const sib of box.children) used += sib.getBoundingClientRect().height + gap;
            return used <= cap + 0.5;
          };
          let size = parseFloat(getComputedStyle(el).fontSize);
          while (size > 22 && !room()) { size -= 2; el.style.fontSize = `${size}px`; }
        }
      }));
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
