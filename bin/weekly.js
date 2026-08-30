#!/usr/bin/env node
/**
 * The Sunday roundup: one post for everything the board picked up this week.
 *
 * Called by bin/run.sh after every scan, which is what makes it need no
 * scheduler of its own. `roundupDue` answers yes exactly once a week — on or
 * after the configured hour on the configured weekday, and only if that
 * calendar week has not already been written — so asking 48 times a day is
 * free and the answer is recorded in `settings`.
 *
 * "On or after", not "at", is the whole reason this is not a cron entry. This
 * Mac is asleep for large parts of the day; a job that fires only at 10:00
 * exactly would simply be missed. Asking on every scan means the roundup
 * arrives on the first run after the machine wakes.
 *
 *   node bin/weekly.js            # write it only if it is due
 *   node bin/weekly.js --force    # write it now, whatever day it is
 *   node bin/weekly.js --dry-run  # print it, write nothing, mark nothing
 */
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';
import { weeklyRoundup, roundupDue, weekKey } from '../src/weekly.js';
import { buildWeeklyPage, writeWeeklyPage } from '../src/postpage.js';
import { notify, open as openFile } from '../src/notify.js';
import { queueBase, queueServerUp } from '../src/postqueue.js';
import { regionOf, regionPath } from '../src/regions.js';
import { PATHS } from '../src/paths.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const NO_OPEN = process.argv.includes('--no-open');

const SETTING = 'weeklyRoundupWeek';

const cfg = loadConfig();
const store = new Store();

const zone = regionOf(cfg.postQueue?.weekly?.region || 'IN')?.timeZone ?? 'Asia/Kolkata';
const key = weekKey(Date.now(), zone);
const last = store.getSetting(SETTING);

if (!FORCE && !DRY_RUN && !roundupDue(cfg, last)) {
  store.close();
  process.exit(0);
}

/**
 * The ids the SITE actually publishes for this region.
 *
 * The roundup links to /jobs/<slug> for every role it features, so a role the
 * board does not carry is a 404 sent to everyone who reads the post. The store
 * holds plenty that publish holds back — an employer since dropped from the
 * watchlist, the losing half of a cross-collector duplicate, anything past the
 * retention window. Reading the published projection is the same rule the reel
 * pipeline follows, and for the same reason: a post must not state something
 * the site does not have.
 *
 * A missing file means the region has never published; nothing is filtered
 * rather than everything, so a first run cannot silently produce an empty week.
 */
function publishedIdsFor(code) {
  const prefix = regionPath(code);
  const file = join(PATHS.root, 'web', 'public', ...(prefix ? [prefix.slice(1)] : []), 'data', 'jobs.json');
  if (!existsSync(file)) {
    log.warn(`Weekly roundup: ${file} is missing — not filtering to published roles.`);
    return null;
  }
  try {
    return new Set((JSON.parse(readFileSync(file, 'utf8')).jobs ?? []).map((j) => String(j.id)));
  } catch (e) {
    log.warn(`Weekly roundup: could not read the published jobs file (${e.message}) — not filtering.`);
    return null;
  }
}

const roundup = weeklyRoundup(store, cfg, {
  publishedIds: publishedIdsFor(cfg.postQueue?.weekly?.region || 'IN'),
});

if (!roundup.stats.roles) {
  log.info('Weekly roundup: nothing collected this week — not writing a post about an empty week.');
  // A scheduled run still marks the week done. A week with no listings is a
  // fact about the week, not a failure to retry every thirty minutes until
  // Monday. A forced one does not, for the reason given further down.
  if (!DRY_RUN && !FORCE) store.setSetting(SETTING, key);
  store.close();
  process.exit(0);
}

if (DRY_RUN) {
  console.log(JSON.stringify(roundup.stats, null, 2));
  console.log(`\n${'='.repeat(70)}\nPOST\n${'='.repeat(70)}\n${roundup.post}`);
  roundup.comments.forEach((c, i) => console.log(`\n${'='.repeat(70)}\nCOMMENT ${i + 1}\n${'='.repeat(70)}\n${c}`));
  store.close();
  process.exit(0);
}

const file = writeWeeklyPage(buildWeeklyPage(roundup, { generatedAt: Date.now() }), key);

// A FORCED run does not consume the week's slot.
//
// ISO weeks end on Sunday, so a Sunday roundup and the six days before it share
// one key. Marking the week done on a Wednesday --force would therefore make
// the following Sunday's scheduled run skip itself — silently, and only
// noticed by the roundup not arriving. --force means "give me one now", not
// "consider this week handled".
if (!FORCE) store.setSetting(SETTING, key);

const { roles, companies, span } = roundup.stats;
log.ok(`Weekly roundup for ${span}: ${roles} roles from ${companies} employers → ${file}`);

await notify(
  'This week on the board',
  `${roles} roles from ${companies} employers, ${span}`,
  { sound: 'Glass', subtitle: 'One post ready to paste' },
);

if (!NO_OPEN) {
  // Through the helper when it is up, so the page is same-origin with the rest
  // of the tooling and its links work; off disk otherwise, which renders the
  // same bytes and still copies fine.
  const url = (await queueServerUp(cfg)) ? `${queueBase(cfg)}/weekly/latest` : file;
  await openFile(url);
}

store.close();
