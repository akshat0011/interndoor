#!/usr/bin/env node
/**
 * Draw the website's Open Graph cards — the ones LinkedIn's crawler fetches.
 *
 *   node bin/render-og.js --queued              # every posting we have SHARED
 *   node bin/render-og.js --job=4459729777      # one, by id
 *   node bin/render-og.js --limit=20            # the newest that have none yet
 *   node bin/render-og.js --job=X --force       # redraw one that already exists
 *
 * WHY. Every job page served the same generic og.jpg, so the preview on every
 * post was the same picture — on the one element a reader sees before any text.
 *
 * ONLY WHAT GETS SHARED, and that is a storage decision. A card here is
 * committed, because LinkedIn has to be able to fetch it. Drawing one per
 * published posting is ~50KB x 991 now and ~5.5MB a DAY forever, in a public
 * repo Vercel clones on all 48 deploys a day. The postings that reach a
 * LinkedIn post or a reel are a few a day and are exactly the ones whose
 * preview anybody looks at.
 *
 * TELEGRAM DOES NOT COME THROUGH HERE. It draws every new listing into the
 * state directory and uploads the file itself, so those never touch the repo.
 * See src/ogcard.js and src/telegram.js.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../src/paths.js';
import { loadConfig } from '../src/config.js';
import { publishedRegions, regionPath } from '../src/regions.js';
import { ogCardName } from '../src/pages.js';
import { renderCards } from '../src/ogcard.js';
import { Store } from '../src/store.js';
import { log } from '../src/logger.js';

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));

const OUT_DIR = join(PATHS.root, 'web', 'public', 'og');

/** Every published board's jobs — a job id is unique across all of them. */
function publishedJobs(cfg) {
  const out = [];
  for (const region of publishedRegions(cfg)) {
    const prefix = regionPath(region.code);
    const file = join(PATHS.root, 'web', 'public', ...(prefix ? [prefix.slice(1)] : []), 'data', 'jobs.json');
    if (!existsSync(file)) continue;
    for (const j of JSON.parse(readFileSync(file, 'utf8')).jobs ?? []) out.push(j);
  }
  return out;
}

const cfg = loadConfig();
const all = publishedJobs(cfg);
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

if (!wanted.length) {
  log.info('Every posting that needs a card already has one.');
  process.exit(0);
}

const made = await renderCards(wanted, OUT_DIR, { force: Boolean(args.force) });
log.ok(`Drew ${made.size} Open Graph card${made.size === 1 ? '' : 's'} into web/public/og/.`);
