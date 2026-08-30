/**
 * One Open Graph card per posting, drawn from web/og-card.html.
 *
 * TWO CONSUMERS, ONE RENDERER, TWO DESTINATIONS — which is the whole reason
 * this is a module rather than living in the CLI:
 *
 *   - the WEBSITE, for postings we share on LinkedIn. Those go to
 *     web/public/og and are committed, because a preview image has to be
 *     fetchable by LinkedIn's crawler.
 *   - TELEGRAM, for every new listing. Telegram uploads the file itself, so
 *     the image never has to be served — and that is what keeps ~110 cards a
 *     day out of a public repo that Vercel clones on all 48 deploys a day.
 *     Those go to the state directory, beside the reels, for the same reason
 *     the reels are there.
 *
 * PLAYWRIGHT'S OWN CHROMIUM, NEVER BRAVE. launchBrave clears and claims the
 * shared profile on its way in and would kill a scrape mid-flight.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PATHS } from './paths.js';
import { stipendText, durationText, modeText, ogCardName } from './pages.js';
import { log } from './logger.js';

const TEMPLATE = join(PATHS.root, 'web', 'og-card.html');

/** The newest Chromium Playwright has installed, or null if it has none. */
export function chromiumPath() {
  const base = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const p = join(base, d, 'chrome-mac-arm64',
      'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * What the card says about a posting.
 *
 * The display filters are IMPORTED from pages.js rather than re-derived: the
 * stipend column holds "2,026" (a year that reached the money slot) and 41
 * published rows hold a zero stipend. A card must not state something the job
 * page would not — the same correction the reel caption needed on its first
 * live reel.
 */
export function cardModel(job) {
  const city = String(job.location ?? '').split(',')[0].trim();
  const facts = [stipendText(job), city, modeText(job), durationText(job)]
    .filter(Boolean).slice(0, 3);
  return { company: job.company ?? '', title: job.title ?? '', facts };
}

/**
 * Draw a card for each posting that has none, into `outDir`.
 *
 * WRITTEN ONCE PER JOB AND NEVER REWRITTEN unless `force`. That is not an
 * optimisation for the website copies: publish runs 48 times a day into a
 * public repo, and a card that redrew itself every run would be the timestamp
 * churn of 30 Aug again, in 50KB binaries instead of two lines of markup.
 *
 * Returns a Map of job id -> file path for everything now on disk, drawn or
 * already there, so a caller can upload it without checking again.
 *
 * FAILS SOFT AND RETURNS WHAT IT HAS. A preview image is a nicety; no caller
 * of this may be able to fail a run because Chromium is missing.
 */
export async function renderCards(jobs, outDir, { force = false, quality = 82 } = {}) {
  const made = new Map();
  if (!jobs.length) return made;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const todo = [];
  for (const job of jobs) {
    const out = join(outDir, ogCardName(job.id ?? job.job_id));
    if (!force && existsSync(out)) { made.set(String(job.id ?? job.job_id), out); continue; }
    todo.push({ job, out });
  }
  if (!todo.length) return made;

  const exe = chromiumPath();
  if (!exe) {
    log.warn('Playwright Chromium is not installed — no Open Graph cards drawn.');
    return made;
  }

  let browser;
  try {
    browser = await chromium.launch({ executablePath: exe, headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.goto(pathToFileURL(TEMPLATE).href, { waitUntil: 'load' });
    // BEFORE any measuring. Fitting text before the webfonts land measures
    // Helvetica and then Archivo overflows — the bug that shipped three times
    // in the reel card.
    await page.evaluate(() => document.fonts.ready);

    for (const { job, out } of todo) {
      try {
        const model = cardModel(job);
        // Read off disk so the card never waits on the network.
        const logo = job.logo ? join(PATHS.root, 'web', 'public', String(job.logo).replace(/^\//, '')) : '';
        model.logo = logo && existsSync(logo) ? pathToFileURL(logo).href : '';

        await page.evaluate((m) => window.renderJob(m), model);
        await page.evaluate(() => document.fonts.ready);
        writeFileSync(out, await page.locator('#card').screenshot({ type: 'jpeg', quality }));
        made.set(String(job.id ?? job.job_id), out);
      } catch (err) {
        // One bad posting must not cost the rest of the batch its cards.
        log.debug(`og card failed for ${job.id ?? job.job_id}: ${String(err?.message ?? err).split('\n')[0]}`);
      }
    }
  } catch (err) {
    log.warn(`Open Graph cards skipped — ${String(err?.message ?? err).split('\n')[0]}`);
  } finally {
    await browser?.close().catch(() => {});
  }
  return made;
}
