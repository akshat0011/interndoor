#!/usr/bin/env node
/**
 * One Open Graph card per posting, so a shared job link does not look like
 * every other shared job link.
 *
 *   node bin/render-og.js --queued              # every posting we have SHARED
 *   node bin/render-og.js --job=4459729777      # one, by id
 *   node bin/render-og.js --limit=20            # the newest that have none yet
 *   node bin/render-og.js --job=X --force       # redraw one that already exists
 *
 * WHY. Every job page serves the same generic og.jpg, so the LinkedIn preview
 * on every post is the same picture — which reads as repetitive after a week of
 * posting, on the one element of the post a reader sees before any text.
 *
 * WRITTEN ONCE PER JOB AND NEVER REWRITTEN. An existing file is skipped unless
 * --force. That is not an optimisation: publish runs 48 times a day into a
 * public repo, and a card that redrew itself each run would be the timestamp
 * churn of 30 Aug again, in 40KB binaries instead of two lines of markup.
 *
 * ONLY WHAT GETS SHARED, which is what --queued means and what bin/run.sh
 * calls. A card is only ever seen when a link is posted, and drawing one per
 * published posting would be ~50KB x 991 now and ~5.5MB a DAY forever, in a
 * public repo that Vercel clones on all 48 deploys a day. The postings that
 * reach a LinkedIn post or a reel are a few a day, and they are exactly the
 * ones whose preview anybody looks at.
 *
 * PLAYWRIGHT'S OWN CHROMIUM, NEVER BRAVE. launchBrave clears and claims the
 * shared profile on its way in and would kill a scrape mid-flight. Everything
 * in this project that drives a browser for rendering follows the same rule.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PATHS } from '../src/paths.js';
import { loadConfig } from '../src/config.js';
import { publishedRegions, regionPath } from '../src/regions.js';
import { stipendText, durationText, modeText, ogCardName } from '../src/pages.js';
import { Store } from '../src/store.js';
import { log } from '../src/logger.js';

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));

const ROOT = PATHS.root;
const OUT_DIR = join(ROOT, 'web', 'public', 'og');
const TEMPLATE = join(ROOT, 'web', 'og-card.html');

/** Same resolver the reel renderer uses. */
function chromiumPath() {
  const base = join(process.env.HOME, 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const p = join(base, d, 'chrome-mac-arm64',
      'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  return null;
}

/** Every published board's jobs — a job id is unique across all of them. */
export function publishedJobs(cfg) {
  const out = [];
  for (const region of publishedRegions(cfg)) {
    const prefix = regionPath(region.code);
    const file = join(ROOT, 'web', 'public', ...(prefix ? [prefix.slice(1)] : []), 'data', 'jobs.json');
    if (!existsSync(file)) continue;
    for (const j of JSON.parse(readFileSync(file, 'utf8')).jobs ?? []) out.push(j);
  }
  return out;
}

/**
 * What the card says about a posting.
 *
 * The display filters are IMPORTED from pages.js rather than re-derived: the
 * stipend column holds "2,026" (a year that reached the money slot) and the
 * duration column holds "0 to 3 years" (an experience requirement), and a card
 * must not state something the job page would not. Same rule the reel caption
 * had to be corrected to follow.
 */
export function cardModel(job) {
  const city = String(job.location ?? '').split(',')[0].trim();
  const facts = [stipendText(job), city, modeText(job), durationText(job)]
    .filter(Boolean).slice(0, 3);
  return { company: job.company ?? '', title: job.title ?? '', facts };
}

async function main() {
  const exe = chromiumPath();
  if (!exe) { log.warn('Playwright Chromium is not installed — no cards drawn.'); process.exit(0); }

  const cfg = loadConfig();
  const all = publishedJobs(cfg);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const missing = (j) => args.force || !existsSync(join(OUT_DIR, ogCardName(j.id)));

  let wanted;
  if (args.job) {
    wanted = all.filter((j) => String(j.id) === String(args.job));
    if (!wanted.length) {
      log.warn(`${args.job} is not on any published board — nothing to draw.`);
      process.exit(1);
    }
  } else if (args.queued) {
    const store = new Store();
    const shared = new Set(store.sharedJobIds());
    store.close();
    wanted = all.filter((j) => shared.has(String(j.id))).filter(missing);
  } else {
    wanted = all.filter(missing).slice(0, Number(args.limit ?? 25));
  }
  if (!wanted.length) { log.info('Every published posting already has a card.'); process.exit(0); }

  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto(pathToFileURL(TEMPLATE).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  let drawn = 0;
  try {
    for (const job of wanted) {
      const out = join(OUT_DIR, ogCardName(job.id));
      if (existsSync(out) && !args.force) continue;

      const model = cardModel(job);
      // The logo is read off disk so the card never waits on the network.
      const logo = job.logo ? join(ROOT, 'web', 'public', String(job.logo).replace(/^\//, '')) : '';
      model.logo = logo && existsSync(logo) ? pathToFileURL(logo).href : '';

      await page.evaluate((m) => window.renderJob(m), model);
      await page.evaluate(() => document.fonts.ready);
      const buf = await page.locator('#card').screenshot({ type: 'jpeg', quality: 82 });
      writeFileSync(out, buf);
      drawn++;
      log.debug(`og card: ${model.company} — ${model.title}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  log.ok(`Drew ${drawn} Open Graph card${drawn === 1 ? '' : 's'} into web/public/og/.`);
}

await main();
