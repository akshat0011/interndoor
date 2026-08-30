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

/* ONE ROUNDUP PER BOARD, and they are due independently.
   `regions` is the list; `region` stays as the single-board fallback so an
   older config keeps working unchanged. */
const REGIONS = cfg.postQueue?.weekly?.regions?.length
  ? cfg.postQueue.weekly.regions
  : [cfg.postQueue?.weekly?.region || 'IN'];

const zoneFor = (code) => regionOf(code)?.timeZone ?? 'Asia/Kolkata';
const keyFor = (code) => weekKey(Date.now(), zoneFor(code));
const settingFor = (code) => `${SETTING}:${code}`;

/* A ONE-TIME MIGRATION, and it is what stops a duplicate post this week.
   Before the roundup ran per board the key was bare, and it belonged to
   whichever single region was configured — so without carrying it across, the
   first run after this change would see no key for that region and post a
   second roundup for a week already covered. */
const legacy = store.getSetting(SETTING);
if (legacy && !store.getSetting(settingFor(REGIONS[0]))) {
  store.setSetting(settingFor(REGIONS[0]), legacy);
}

/* Each board is checked in its OWN zone, so 10:00 on Sunday means 10:00 where
   its readers are rather than 23:30 on Saturday in New York. */
const due = REGIONS.filter((code) => FORCE || DRY_RUN
  || roundupDue(cfg, store.getSetting(settingFor(code)), Date.now(), code));

if (!due.length) {
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

const built = [];
for (const code of due) {
  const roundup = weeklyRoundup(store, cfg, { region: code, publishedIds: publishedIdsFor(code) });
  if (!roundup.stats.roles) {
    log.info(`Weekly roundup: nothing collected this week for ${code} — not writing a post about an empty week.`);
    // A scheduled run still marks the week done. A week with no listings is a
    // fact about the week, not a failure to retry every thirty minutes until
    // Monday. A forced one does not, for the reason given further down.
    if (!DRY_RUN && !FORCE) store.setSetting(settingFor(code), keyFor(code));
    continue;
  }
  built.push({ code, roundup });
}

if (!built.length) {
  store.close();
  process.exit(0);
}

if (DRY_RUN) {
  for (const { code, roundup } of built) {
    console.log(`\n${'#'.repeat(70)}\n${code}\n${'#'.repeat(70)}`);
    console.log(JSON.stringify(roundup.stats, null, 2));
    console.log(`\n${'='.repeat(70)}\nPOST\n${'='.repeat(70)}\n${roundup.post}`);
    roundup.comments.forEach((c, i) => console.log(`\n${'='.repeat(70)}\nCOMMENT ${i + 1}\n${'='.repeat(70)}\n${c}`));
  }
  store.close();
  process.exit(0);
}

/* ONE PAGE FOR EVERY BOARD. /weekly/latest serves the most recently written
   file, so a page per region would mean the second silently replaced the
   first and only one board's post would ever be seen. */
const file = writeWeeklyPage(
  buildWeeklyPage(built.map((b) => b.roundup), { generatedAt: Date.now() }),
  keyFor(built[0].code),
);

// A FORCED run does not consume the week's slot.
//
// ISO weeks end on Sunday, so a Sunday roundup and the six days before it share
// one key. Marking the week done on a Wednesday --force would therefore make
// the following Sunday's scheduled run skip itself — silently, and only
// noticed by the roundup not arriving. --force means "give me one now", not
// "consider this week handled".
if (!FORCE) for (const { code } of built) store.setSetting(settingFor(code), keyFor(code));

const totals = built.reduce((a, b) => ({
  roles: a.roles + b.roundup.stats.roles,
  companies: a.companies + b.roundup.stats.companies,
}), { roles: 0, companies: 0 });
const span = built[0].roundup.stats.span;
const boards = built.map((b) => b.code).join(' + ');
log.ok(`Weekly roundup for ${span} (${boards}): ${totals.roles} roles from ${totals.companies} employers → ${file}`);

await notify(
  'This week on the board',
  `${totals.roles} roles from ${totals.companies} employers, ${span} · ${boards}`,
  { sound: 'Glass', subtitle: `${built.length} post${built.length === 1 ? '' : 's'} ready to paste` },
);

if (!NO_OPEN) {
  // Through the helper when it is up, so the page is same-origin with the rest
  // of the tooling and its links work; off disk otherwise, which renders the
  // same bytes and still copies fine.
  const url = (await queueServerUp(cfg)) ? `${queueBase(cfg)}/weekly/latest` : file;
  await openFile(url);
}

store.close();
