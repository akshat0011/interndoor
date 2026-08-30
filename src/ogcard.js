/**
 * Open Graph cards for TELEGRAM, drawn locally with Playwright.
 *
 * THE WEBSITE DOES NOT COME THROUGH HERE ANY MORE. Its cards are generated on
 * request by web/api/og.js, so nothing is committed and every posting is
 * covered — see the note there for the storage arithmetic that decided it.
 *
 * TELEGRAM STILL RENDERS LOCALLY, and the reason is a race rather than
 * taste: a listing is posted to the channel seconds after the push, and Vercel
 * needs about a minute to deploy, so the generator would not yet be able to
 * see the very posting being announced. It would answer with the generic card
 * for exactly the freshest roles — the ones this channel exists for. Drawing
 * locally has no deploy to wait for.
 *
 * The cost of that decision is TWO renderers for one design — this one in HTML
 * and the generator in satori — which can drift. They are close but not
 * identical by construction (satori is flexbox-only and cannot fit text to a
 * box, so it sizes the role from its length). Keep the two in step by eye when
 * either changes, or fold Telegram onto the URL and accept a generic card on
 * the first minute of a listing's life.
 *
 * Cards go to the state directory, beside the reels, for the reason the reels
 * are there: generated artefacts, and `app/` is a PUBLIC git repo.
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
