/**
 * Render the data-post image — web/data-card.html filled from a post's `card`
 * model (src/datapost.js) and screenshotted with Playwright's own Chromium.
 *
 * Output goes to PATHS.liCards in the state directory, never the repo, and is
 * served by the queue server's existing /li/ route. Same mechanism as the
 * weekly card (src/weeklycard.js); a different subject.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, PATHS } from './paths.js';
import { chromiumPath } from './ogcard.js';
import { log } from './logger.js';

const TEMPLATE = join(ROOT, 'web', 'data-card.html');
export const MAX_ROWS = 10;

/** The card's file name for a post: `data-<key>-<REGION>` under /li/. */
export function cardId(key, region) {
  return `data-${String(key).replace(/[^a-z0-9-]/gi, '')}-${String(region).toUpperCase()}`;
}

/**
 * Pure: the model the template is filled from. Shares are clamped to [0, 1]
 * and a value that is empty stays empty (a newcomer with one posting shows
 * no "1"). Exported so the fill is pinned without a browser.
 */
export function cardModel(card) {
  const rows = (card?.rows ?? []).slice(0, MAX_ROWS).map((r) => ({
    label: String(r.label ?? ''),
    value: String(r.value ?? ''),
    share: Math.max(0, Math.min(1, Number(r.share) || 0)),
  }));
  return {
    eyebrow: String(card?.eyebrow ?? ''),
    headline: String(card?.headline ?? ''),
    band: String(card?.band ?? 'BE EARLY.'),
    rows,
  };
}

export async function renderDataCard(card, outFile) {
  const model = cardModel(card);
  if (!model.rows.length) throw new Error('renderDataCard needs at least one row.');
  const exe = chromiumPath();
  if (!exe) { log.warn('No Playwright Chromium — skipping the data card image.'); return null; }

  mkdirSync(PATHS.liCards, { recursive: true });
  const file = outFile ?? join(PATHS.liCards, 'data-latest.png');
  const html = readFileSync(TEMPLATE, 'utf8');

  /* PLAYWRIGHT'S OWN CHROMIUM, NEVER BRAVE (§2). */
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 627 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate((m) => {
      document.getElementById('eyebrow').textContent = m.eyebrow;
      document.getElementById('headline').textContent = m.headline;
      document.getElementById('say').textContent = m.band;
      const rows = document.getElementById('rows');
      rows.innerHTML = m.rows.map((r, i) => `
        <div class="row${i === 0 ? ' is-first' : ''}">
          <div class="label"></div>
          <div class="track"><div class="bar" style="width:${Math.round(r.share * 100)}%"></div></div>
          <div class="value"></div>
        </div>`).join('');
      [...rows.querySelectorAll('.row')].forEach((el, i) => {
        el.querySelector('.label').textContent = m.rows[i].label;
        el.querySelector('.value').textContent = m.rows[i].value;
      });
      /* Row height from the count, so four bands and ten employers both fill
         the same box rather than four thin lines floating in it. */
      const h = Math.min(56, Math.floor((627 - 178 - 112) / m.rows.length));
      rows.style.gap = `${Math.max(2, Math.floor(h * 0.18))}px`;
      const bar = Math.max(14, Math.min(26, Math.floor(h * 0.42)));
      [...rows.querySelectorAll('.row')].forEach((el) => { el.style.height = `${h}px`; });
      [...rows.querySelectorAll('.track')].forEach((el) => { el.style.height = `${bar}px`; el.style.borderRadius = `${bar / 2}px`; });
      [...rows.querySelectorAll('.bar')].forEach((el) => { el.style.borderRadius = `${bar / 2}px`; });
    }, model);
    /* FONTS BEFORE MEASURING — measuring in Helvetica and reflowing in Archivo
       has shipped three times on the other cards. */
    await page.evaluate(() => document.fonts.ready);
    /* The headline is the one thing that can overflow: two lines at most. */
    await page.evaluate(() => {
      const el = document.getElementById('headline');
      let size = parseFloat(getComputedStyle(el).fontSize);
      const max = parseFloat(getComputedStyle(el).maxHeight);
      while (size > 30 && el.scrollHeight > max + 1) {
        size -= 2;
        el.style.fontSize = `${size}px`;
      }
    });
    writeFileSync(file, await page.locator('#card').screenshot({ type: 'png' }));
    return file;
  } finally {
    await browser.close();
  }
}
