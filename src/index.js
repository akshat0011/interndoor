#!/usr/bin/env node
/**
 * One scan of LinkedIn for new internships at the watchlist companies.
 * Invoked by launchd every 30 minutes, or by hand via `npm run`.
 */
import { loadConfig, matchCompany, matchTitle, resolveWindowHours, isSearchDue, isBlockedCompany } from './config.js';
import { join } from 'node:path';
import { ensureDirs, PATHS, ROOT } from './paths.js';
import { log } from './logger.js';
import { Store } from './store.js';
import { launchBrave, closeBrave, releaseProfileLock } from './browser.js';
import { ensureHealthy, assertSignedIn, assertListRendered, RunAborted, State } from './guard.js';
import * as li from './linkedin.js';
import { resolveSearches } from './searches.js';
import { classifyRoles, classifyFromDescriptions, enrichJobs } from './ollama.js';
import { postNewJobs } from './telegram.js';
import { publishedRegions, resolveRowRegion } from './regions.js';
import { classifyRole, needsDescription, builtInPolarity } from './roles.js';
import { loadLearned, learnedVocabulary, learn, learnedPath } from './learned.js';
import { pause, sleep, idleFidget, humanDelay, pageAlive } from './human.js';
import { summarize } from './summarize.js';
import { extractStipend, extractDuration, extractSkills, extractWorkplaceType, parseRelativeTime } from './extract.js';
import { buildReport, writeReport } from './report.js';
import { publish } from './publish.js';
import { notify, open as openFile, pushToPhone } from './notify.js';
import { reportTarget } from './postqueue.js';

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');
const NO_OPEN = ARGS.has('--no-open');
/** Set by bin/run.sh so scheduled runs can behave slightly differently. */
const SCHEDULED = ARGS.has('--scheduled');

/**
 * One-off numeric overrides, so a deep backfill does not require editing
 * config.json — which is the kind of change that gets left in by accident and
 * quietly triples every future run.
 *
 *   --window-days=30   look back 30 days instead of the adaptive window
 *   --window-hours=72  same, in hours
 *   --max-pages=40     pages per search
 *   --max-details=200  jobs opened this run
 *   --max-minutes=100  wall-clock budget
 *   --sort=relevance   order by LinkedIn's relevance instead of newest-first
 *   --start-page=15    begin pagination at page 15 (start=350), to resume a
 *                      backfill that stopped partway rather than re-walking
 *                      the pages already covered
 */
function numArg(name) {
  for (const a of ARGS) {
    const m = a.match(new RegExp(`^--${name}=(\\d+(?:\\.\\d+)?)$`));
    if (m) return Number(m[1]);
  }
  return null;
}

/** Non-numeric one-off overrides. */
function strArg(name) {
  for (const a of ARGS) {
    const m = a.match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1];
  }
  return null;
}

const OVERRIDES = {
  sortBy: strArg('sort'),
  startPage: numArg('start-page'),
  windowHours: numArg('window-hours') ?? (numArg('window-days') != null ? numArg('window-days') * 24 : null),
  maxPages: numArg('max-pages'),
  maxDetails: numArg('max-details'),
  maxMinutes: numArg('max-minutes'),
};

function makeRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * How much newer a card must look before it is treated as a relisting rather
 * than the posting we already hold under the same company and title.
 *
 * Generous on purpose. `parseRelativeTime` works from text like "19 hours ago",
 * so the same posting drifts by up to an hour between runs simply from
 * rounding; anything tighter than that would reopen every known card. A genuine
 * repost resets to minutes old, so it clears this by a wide margin.
 */
const REPOST_GAP_MS = 6 * 3_600_000;

/**
 * How far back past the last sweep a page may reach before it counts as ground
 * already covered.
 *
 * LinkedIn's date ordering is only approximately honest — promoted cards are
 * interleaved, and `parseRelativeTime` works from text like "2 hours ago", so a
 * card's computed age can be most of an hour out. This margin absorbs both.
 */
const COVERED_MARGIN_MS = 45 * 60_000;

/** Consecutive fully-covered pages before pagination gives up on a search. */
const COVERED_PAGES_BEFORE_STOP = 2;

/**
 * Fewest cards a page may average before the sweep is treated as not having
 * rendered at all.
 *
 * A rendered page of results is 20-25 cards; a session LinkedIn has stopped
 * serving draws the list as the single job in the detail pane and nothing else,
 * measuring exactly 1.0. The two states do not overlap, checked against 40 runs.
 *
 * Module scope because it is now applied twice: once per search, to decide
 * whether that region's baseline may move, and once per run for the status.
 */
const CARDS_PER_PAGE_FLOOR = 5;

/** Tracks the wall-clock ceiling so a run can never sprawl unattended. */
function budget(maxMinutes) {
  const start = Date.now();
  const deadline = start + maxMinutes * 60_000;
  return {
    exceeded: () => Date.now() > deadline,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    remainingMinutes: () => Math.max(0, Math.round((deadline - Date.now()) / 60_000)),
    elapsedSeconds: () => Math.round((Date.now() - start) / 1000),
  };
}

/**
 * Load a .env file if one exists, so GEMINI_API_KEY can live in the project
 * rather than in a shell profile. launchd gives the job almost no environment,
 * so a key exported in .zshrc would never reach a scheduled run — this is the
 * only way it works both from a terminal and from the schedule.
 */
function loadEnv() {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    // No .env, or unreadable. Not an error: the classifier falls back offline.
  }
}

/**
 * Open jobs that were stored from card data alone and fetch what we skipped.
 *
 * A confidently non-tech title does not get its page opened during the scan —
 * that is a deliberate trade to keep the run's page budget on roles that need a
 * verdict. The side effect is a row with description NULL, and since
 * `needingEnrichment` requires a description, and a later scan skips the job as
 * already known, those rows never improve. They sit on the site as a bare title
 * with no stipend and no duration even though the posting plainly states both.
 *
 * This is the pass that closes that loop. It is deliberately small and last:
 * capped per run, and it stops the moment the run is out of time, so it can
 * only ever use the slack left over after the actual scan.
 */
async function backfillDescriptions(page, store, cfg, clock, counters) {
  const limit = cfg.enrich?.backfillPerRun ?? 6;
  if (limit <= 0) return;

  const pending = store.needingDescription(limit, cfg.publish?.maxAgeDays ?? 14);
  if (!pending.length) return;

  log.info(`Backfilling ${pending.length} posting${pending.length === 1 ? '' : 's'} that were listed without being opened…`);

  for (const row of pending) {
    if (clock.exceeded()) {
      log.info('Out of time — the rest keep their card data and are picked up next run.');
      break;
    }
    if (!(await pageAlive(page))) break;

    await pause(cfg.pacing.betweenCards);

    let detail;
    try {
      detail = await li.openAndExtract(page, { jobId: row.job_id }, cfg);
    } catch (err) {
      counters.failedDetails++;
      log.warn(`Could not backfill "${row.title}" — ${err.message.split('\n')[0]}`);
      await ensureHealthy(page, cfg, { context: `backfill ${row.job_id}`, remainingMs: clock.remainingMs() });
      continue;
    }

    await ensureHealthy(page, cfg, { context: `backfill ${row.job_id}`, remainingMs: clock.remainingMs() });

    const description = detail.description || '';
    if (description.length <= 200) {
      // Nothing worth storing. Leave description NULL so the row stays in the
      // queue rather than being marked done with an empty string.
      log.debug(`Backfill found no usable description for ${row.job_id}.`);
      continue;
    }

    const job = {
      description,
      salaryText: detail.salaryText ?? null,
      stipend: extractStipend(detail.salaryText, description),
      duration: extractDuration(description, detail.title || row.title),
      skills: extractSkills(description),
      applicants: detail.applicants ?? null,
      applyUrl: detail.applyUrl ?? null,
      workplaceType: detail.workplaceType || extractWorkplaceType(detail.location, description),
      logoUrl: detail.logoUrl ?? null,
      title: detail.title || row.title,
      company: detail.company || row.company,
    };
    job.summary = await summarize(job, description, cfg.summarizer);

    store.saveDescription(row.job_id, job);
    counters.descriptionsBackfilled++;
    log.ok(`  → backfilled ${row.company ?? ''} ${row.title}`.replace(/\s+/g, ' '));
  }
}

/**
 * Turn freshly scraped descriptions into card content: bullets, eligibility, key
 * skills, a stipend state, and a tech verdict judged on the description rather than
 * the title.
 *
 * Capped per run. This is the only step here that costs API quota, and a free tier
 * is a shared, exhaustible resource — spending it all on one unusually large run
 * would leave the next few runs with nothing. Anything skipped is picked up next
 * time, because needingEnrichment only ever returns rows that have no bullets yet.
 */
async function enrichNewJobs(store, cfg) {
  const limit = cfg.enrich?.perRunLimit ?? 24;
  const pending = store.needingEnrichment(limit, publishedRegions(cfg).map((r) => r.code));
  if (!pending.length) return;

  log.info(`Enriching ${pending.length} new posting${pending.length === 1 ? '' : 's'}\u2026`);
  const results = await enrichJobs(pending, cfg);
  if (!results.size) {
    log.info('Nothing enriched this run \u2014 those postings keep their plain summary.');
    return;
  }

  let flipped = 0;
  for (const [i, e] of results) {
    const row = pending[i];
    if (!row) continue;
    const before = store.db.prepare('SELECT is_tech FROM jobs WHERE job_id = ?').get(row.job_id)?.is_tech;
    store.saveEnrichment(row.job_id, e);
    if (typeof e.isTech === 'boolean' && before != null && !!before !== e.isTech) flipped++;
  }
  log.ok(`Enriched ${results.size}/${pending.length}${flipped ? ` \u00b7 ${flipped} changed tech verdict` : ''}.`);
}

async function main() {
  loadEnv();
  ensureDirs();
  const cfg = loadConfig();

  // Everything Gemini has taught us so far joins the offline vocabulary, so a
  // term learned once is answered instantly and for free from then on.
  const learnedStore = loadLearned();
  const learnedVocab = learnedVocabulary(learnedStore);
  cfg.matching.extraTechTerms = [...(cfg.matching.extraTechTerms ?? []), ...learnedVocab.positive];
  cfg.matching.extraNonTechTerms = [...(cfg.matching.extraNonTechTerms ?? []), ...learnedVocab.negative];
  if (learnedVocab.positive.length || learnedVocab.negative.length) {
    log.info(`Learned vocabulary: ${learnedVocab.positive.length} tech, ${learnedVocab.negative.length} non-tech terms in play.`);
  }

  if (OVERRIDES.maxPages) cfg.limits.maxPagesPerSearch = OVERRIDES.maxPages;
  if (OVERRIDES.maxDetails) cfg.limits.maxDetailsPerRun = OVERRIDES.maxDetails;
  if (OVERRIDES.maxMinutes) cfg.limits.maxRuntimeMinutes = OVERRIDES.maxMinutes;
  if (OVERRIDES.sortBy) {
    // Relevance matters for a deep backfill: LinkedIn caps a search at ~1000
    // results, so newest-first would return only the last couple of days of a
    // 30-day window. Relevance spreads the sample across the whole period.
    cfg.filters.sortBy = OVERRIDES.sortBy;
  }
  if (OVERRIDES.windowHours) {
    // An explicit window beats the adaptive calculation entirely.
    cfg.filters.adaptiveWindow = false;
    cfg.filters.postedWithinHours = OVERRIDES.windowHours;
  }
  if (Object.values(OVERRIDES).some((v) => v != null)) {
    log.warn(`One-off overrides active: ${Object.entries(OVERRIDES).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }

  // Company batches or role keywords, per config.searchMode.
  const allSearches = resolveSearches(cfg);

  if (DRY_RUN) {
    log.warn('DRY RUN — one search, one page, at most 3 job details.');
    allSearches.splice(1);
    cfg.limits = { ...cfg.limits, maxPagesPerSearch: 1, maxDetailsPerRun: 3, maxRuntimeMinutes: Math.min(cfg.limits.maxRuntimeMinutes, 15) };
  }

  const runId = makeRunId();
  const store = new Store();

  // Refuse to start while another run holds the lock. Hourly slots plus a
  // 45-minute budget leave little headroom, and two runs would fight over the
  // Brave profile lock and double the request rate. The lock self-expires after
  // the runtime budget so a crashed run cannot wedge the schedule forever.
  const LOCK_KEY = 'run_started_at';
  // The lock has to outlive the SCAN budget, not equal it.
  //
  // maxRuntimeMinutes bounds the scan loop only — classification, enrichment,
  // the report and the publish all happen after the clock is spent, so an
  // entirely healthy run finishes somewhat later than its budget. Expiring the
  // lock at exactly the budget therefore declared live runs dead: the next slot
  // cleared the lock, started while the previous Brave still owned the profile,
  // and died on a launch timeout. That is the failure that filled the runs table
  // with "launchPersistentContext: Timeout" errors.
  const LOCK_GRACE_MIN = 8;
  const lockExpiryMin = cfg.limits.maxRuntimeMinutes + LOCK_GRACE_MIN;
  const heldSince = Number(store.getSetting(LOCK_KEY) ?? 0);
  const lockAgeMin = heldSince ? (Date.now() - heldSince) / 60_000 : Infinity;
  if (heldSince && lockAgeMin < lockExpiryMin && !ARGS.has('--force')) {
    log.warn(`Another run started ${lockAgeMin.toFixed(0)} min ago and is still going. Skipping this slot.`);
    store.close();
    return;
  }
  if (heldSince && lockAgeMin >= lockExpiryMin) {
    log.warn(`Clearing a stale run lock (${lockAgeMin.toFixed(0)} min old — the previous run probably crashed).`);
    // A run that overran its lock may still have a Brave alive on the profile.
    // Ending it here is what stops this run inheriting the same launch timeout.
    releaseProfileLock();
  }

  // Refuse to run while a cooldown from a previous rate limit is in force.
  const cooldown = store.activeCooldown();
  if (cooldown && !ARGS.has('--force')) {
    const hours = ((cooldown.until - Date.now()) / 3_600_000).toFixed(1);
    log.warn(`Skipping this run: cooling down for another ${hours}h after ${cooldown.reason}.`);
    log.info('Override with `node src/index.js --force` if you are sure.');
    store.close();
    return;
  }

  // Claim the lock BEFORE the jitter sleep, not after.
  //
  // The sleep below is up to a minute long, and it used to sit between the
  // "is anyone else running?" check above and this line. Two runs starting
  // inside that minute therefore both saw an unheld lock, both slept, and both
  // carried on — then fought over the same Brave profile, and one killed the
  // other's browser mid-page. That is the "Target page, context or browser has
  // been closed" followed by a soft_block abort 37 seconds into a run. launchd
  // makes it easy to hit: after the machine wakes it fires the slots it missed,
  // which can be two starts ten seconds apart.
  //
  // Writing the timestamp first makes the window as small as SQLite's own
  // write, so the second run reads a held lock and stands down properly.
  store.setSetting(LOCK_KEY, Date.now());

  // Land at a slightly different minute each day rather than exactly 12:00:00.
  if (SCHEDULED && !DRY_RUN && cfg.pacing.startupJitter) {
    const jitter = humanDelay(cfg.pacing.startupJitter);
    if (jitter > 1000) {
      log.info(`Waiting ${Math.round(jitter / 60_000)} min before starting (schedule jitter).`);
      await sleep(jitter);
      // Re-stamp so the lock's age is measured from real work starting, not
      // from a run that has spent its first minute asleep.
      store.setSetting(LOCK_KEY, Date.now());
    }
  }

  store.startRun(runId);

  // Size the lookback from the gap since that REGION last finished a sweep. A
  // fixed wide window would make every hourly run re-paginate a day of postings
  // to find the newest hour; a fixed narrow one would lose everything posted
  // while the lid was shut. This does both jobs.
  //
  // Measured per region, not per run. Two searches now cover different
  // countries, and a run that swept India and marked itself `ok` says nothing
  // about when the US was last walked — see Store.lastRegionSweep.
  //
  // A region with no baseline of its own falls back to the RUN-level one, and
  // that fallback does two jobs. It leaves India unchanged on the first run
  // after this ships, rather than reading as never-swept and jumping to the 36h
  // maximum. And it gives a newly added region a soft start instead of the most
  // expensive request burst the account would ever make: with no baseline at
  // all a cold region takes maxWindowHours, and against US supply — 24
  // intern-titled cards per 12 minutes, measured — 36 hours is several thousand
  // results, so the walk would hit the 40-page cap, never reach a real end,
  // never record a baseline, and do the same thing again on every run forever.
  // Starting from the last run instead means a cold region collects the most
  // recent slice, completes, records its baseline, and is in steady state from
  // its second sweep.
  //
  // The cost is that a new region does NOT backfill its history. That is
  // deliberate: `--window-hours` exists for exactly that, and already disables
  // the early stop so a deep walk is not cut short.
  const lastRun = store.lastFullSweep();

  /**
   * The lookback window and covered-ground horizon for one search.
   *
   * coveredHorizon is the load-bearing half. Results are date-descending, so
   * once two consecutive pages carry nothing newer than the last sweep covered,
   * everything past them is older still. Measured over the scheduled runs: 873
   * page loads produced 16 opens, and every one but a single card sat on pages
   * 1-3. The rest was the same junk re-read, and page loads are the request
   * budget that a rate limit is eventually spent on.
   *
   * Both are deliberately disabled when --window-hours was passed: that
   * override exists to walk deliberately deep after an outage, and stopping
   * early would defeat the one job it has.
   */
  const planSweep = (region, search = {}) => {
    const baseline = store.lastRegionSweep(region) ?? lastRun?.started_at ?? null;
    // A search may narrow its own window. The defaults were tuned for one India
    // search on a 30-minute loop, and they are far too wide for a dense region
    // swept hourly: the US sweep was walking its whole 3h result set to
    // exhaustion — 21 pages, ~480 cards — to collect one hour of new postings,
    // because two thirds of what LinkedIn returned was newer than the
    // covered-ground horizon and kept resetting the early stop.
    //
    // Adaptive behaviour is preserved: these change the FLOOR and the SLACK,
    // not the rule, so a region that was missed for six hours still stretches
    // its window to cover the gap.
    const base = {
      ...cfg.filters,
      ...(search.minWindowHours != null ? { minWindowHours: search.minWindowHours } : {}),
      ...(search.windowMarginHours != null ? { windowMarginHours: search.windowMarginHours } : {}),
      ...(search.maxWindowHours != null ? { maxWindowHours: search.maxWindowHours } : {}),
    };
    const hours = resolveWindowHours(baseline, base);
    return {
      filters: { ...base, postedWithinHours: hours },
      coveredHorizon: (!OVERRIDES.windowHours && baseline) ? baseline - COVERED_MARGIN_MS : null,
      baseline,
    };
  };

  const clock = budget(cfg.limits.maxRuntimeMinutes);
  const notes = [];
  // The lookback each search actually used. Regions are swept on their own
  // baselines, so there is no longer a single run-wide window to quote in the
  // summary — India can be on its 3h floor while a region that has just been
  // switched on is still walking its first 36h.
  const windowsUsed = new Set();
  const counters = { pagesScanned: 0, cardsSeen: 0, detailsExtracted: 0, newJobs: 0, skippedStale: 0, skippedCompany: 0, skippedTitle: 0, techRoles: 0, nonTechRoles: 0, geminiJudged: 0, termsLearned: 0, nearMisses: 0, skippedViewed: 0, listedWithoutOpening: 0, logosBackfilled: 0, skippedKnown: 0, failedDetails: 0, descriptionsBackfilled: 0, cardsWithoutId: 0, cardKeysMigrated: 0 };

  log.section(`Run ${runId}`);
  log.info(`${cfg.watchlist.length} watchlist terms across ${cfg.uniqueCompanyCount} companies · mode "${cfg.searchMode ?? 'companies'}" · ${allSearches.length} searches · budget ${cfg.limits.maxRuntimeMinutes}m`);

  let session;
  let status = 'ok';
  let fatalError = null;
  // Set when a page load failed before it ever reached LinkedIn, and when
  // LinkedIn answered with a rate limit. They decide the exit code — see the
  // EXIT_RETRY_SOON block at the end of the run.
  let sawNetworkFailure = false;
  let sawBlocked = false;
  let braveLaunchFailed = false;
  let searchesDone = 0;
  let searchStart = 0;

  try {
    session = await launchBrave(cfg);
    const { page, context } = session;

    await li.warmUp(page, cfg);
    await ensureHealthy(page, cfg, { context: 'warm-up', remainingMs: clock.remainingMs() });
    await assertSignedIn(page, context, cfg);
    log.ok('Signed in.');

    // Rotate the starting point. With a long keyword list one run cannot
    // always reach the end, and starting from index 0 every time would mean
    // the tail never runs at all. Picking up where the last run stopped gives
    // every keyword its turn across consecutive runs.
    const cursor = DRY_RUN ? 0 : Number(store.getSetting('search_cursor') ?? 0) % allSearches.length;
    // Recorded here rather than after the loop. A run that aborts mid-walk
    // never reaches the far side of the loop, and leaving this at 0 made the
    // next cursor `0 + searchesDone` — rewinding the rotation to searches that
    // had just been covered and skipping the ones still waiting for their turn.
    searchStart = cursor;
    const rotation = [...allSearches.slice(cursor), ...allSearches.slice(0, cursor)];
    if (cursor > 0) {
      log.info(`Resuming the rotation at position ${cursor + 1} of ${allSearches.length}.`);
    }

    // How many searches one run may walk. 0 (the default) means all of them.
    //
    // This is the request-budget dial, and it exists because a second LinkedIn
    // region doubles the page loads made against the one account the whole
    // board depends on — the account LinkedIn dropped twice in August, without
    // ever answering 429. Setting it to 1 makes the regions take turns instead:
    // each is swept half as often, and total request volume stays exactly where
    // it was on a single region. The cursor above already rotates the starting
    // point, so capping the queue is the whole change — no region is skipped,
    // it just waits its turn.
    const perRun = Number(cfg.limits.searchesPerRun ?? 0);
    const ordered = perRun > 0 ? rotation.slice(0, perRun) : rotation;
    if (perRun > 0 && allSearches.length > perRun) {
      log.info(`Walking ${ordered.length} of ${allSearches.length} searches this run — the rest take their turn next.`);
    }

    searchLoop:
    for (const [searchIndex, search] of ordered.entries()) {
      const label = search.label
        ? `${search.label} (${search.companyCount} companies)`
        : `${search.keywords}${search.location ? ` @ ${search.location}` : ''}`;
      log.section(`Search: ${label} — ${searchIndex + 1}/${ordered.length}`);

      // This search's own region baseline, resolved here rather than once for
      // the run: two searches can be walking different countries with different
      // last-swept times.
      const region = search.region ?? 'IN';
      const { filters, coveredHorizon, baseline } = planSweep(region, search);

      // A search may run less often than the loop ticks.
      //
      // This is per SEARCH, which is what makes it different from
      // limits.searchesPerRun: that dial makes every region take turns at the
      // same rate, whereas this lets India keep its 30-minute freshness while a
      // denser, less time-critical region is walked hourly. Freshness is the
      // whole promise on the India board; the US board is fed by an employer
      // pool that posts steadily all day.
      //
      // Skipping is NOT the same as failing. The baseline is left exactly where
      // it was, so when the search does run its window has stretched to cover
      // the gap and nothing is missed — the adaptive window already does this
      // for an outage, and an intentional skip is the same shape.
      const intervalMin = Number(search.intervalMinutes ?? 0);
      if (!OVERRIDES.windowHours && !isSearchDue(baseline, intervalMin)) {
        const elapsedMin = (Date.now() - baseline) / 60_000;
        log.info(`${region}: last swept ${elapsedMin.toFixed(0)}m ago, runs every ${intervalMin}m — skipping this run.`);
        searchesDone++;
        continue;
      }

      windowsUsed.add(filters.postedWithinHours);
      const searchStartedAt = Date.now();
      // Cards seen by THIS search, for the per-search render floor below. A
      // run-wide average blurs the moment two searches return different
      // volumes: a thin region could drag a healthy run's mean under the floor
      // and have it recorded `partial`, which stretches the next window and
      // walks MORE pages — the opposite of what the floor is for.
      const before = { pages: counters.pagesScanned, cards: counters.cardsSeen };
      log.info(baseline
        ? `${region}: ${filters.postedWithinHours}h window (last swept ${((Date.now() - baseline) / 3_600_000).toFixed(1)}h ago).`
        : `${region}: ${filters.postedWithinHours}h window — never swept, so no early stop this run.`);

      // Resuming a partial backfill starts deeper into the result set. The page
      // budget counts from there, and LinkedIn's own Next control still decides
      // where the results actually end.
      const firstPage = OVERRIDES.startPage ? OVERRIDES.startPage - 1 : 0;
      const lastPage = firstPage + cfg.limits.maxPagesPerSearch;
      let coveredPages = 0;
      // Whether pagination reached a real end — LinkedIn said there was no
      // next page, the results ran out, or the walk caught up with ground an
      // earlier sweep already covered. Only then may this region's baseline
      // move forward. A walk cut short by a failed navigation or by the page
      // cap has NOT covered its window, and recording it as swept would put
      // everything it never paginated to behind the next run's horizon, where
      // nothing would ever look at it again. Same reasoning as lastFullSweep
      // restricting itself to 'ok'.
      let walkComplete = false;
      // Whether any page of THIS search has rendered cards. Once one has, an
      // empty page is the end of the results rather than a selector break —
      // see assertListRendered.
      let renderedEarlierPage = false;

      for (let pageIndex = firstPage; pageIndex < lastPage; pageIndex++) {
        // Checked here, before navigating, not only inside the card loop below.
        // A run overran its 12-minute budget by five minutes because both the
        // slow goto and the stall that followed happened before execution ever
        // reached a card, so nothing ever asked whether there was time left.
        if (clock.exceeded()) {
          notes.push('Ran out of time partway through, so this scan stopped early. The next run resumes from here.');
          log.warn(`Out of time after ${clock.elapsedSeconds()}s — stopping the scan.`);
          status = 'partial';
          break searchLoop;
        }

        if (counters.detailsExtracted >= cfg.limits.maxDetailsPerRun) {
          notes.push(`Hit the ${cfg.limits.maxDetailsPerRun}-job limit for one run. Any further matches were left for the next run.`);
          status = 'partial';
          break searchLoop;
        }

        const url = li.buildSearchUrl(search, filters, { start: pageIndex * li.RESULTS_PER_PAGE });
        log.info(`Page ${pageIndex + 1} — ${url}`);

        const nav = {};
        const navigated = await li.gotoSearch(page, url, cfg, nav);
        // Remembered across the whole run so the exit code can tell the
        // scheduler whether retrying in two minutes is safe.
        if (nav.networkError) sawNetworkFailure = true;
        if (nav.blocked) sawBlocked = true;
        await ensureHealthy(page, cfg, { context: `search "${label}" page ${pageIndex + 1}`, remainingMs: clock.remainingMs() });
        if (!navigated) {
          notes.push(`The job list never finished loading for "${label}" page ${pageIndex + 1}; skipped it.`);
          break;
        }

        const { cards, unidentified } = await li.enumerateCards(page, cfg);
        if (unidentified?.length) {
          counters.cardsWithoutId += unidentified.length;
          log.warn(`${unidentified.length} card(s) on this page had no readable company or title and could not be processed: ${unidentified.filter(Boolean).slice(0, 3).join(' | ')}`);
        }
        await assertListRendered(page, cards.length, { pageIndex: pageIndex + 1, searchLabel: label, renderedEarlierPage });
        if (cards.length) renderedEarlierPage = true;
        counters.pagesScanned++;
        counters.cardsSeen += cards.length;
        log.info(`Found ${cards.length} job cards.`);

        if (cards.length === 0) { walkComplete = true; break; }

        const cutoff = Date.now() - filters.postedWithinHours * 3_600_000;
        let openedOnThisPage = 0;

        for (const card of cards) {
          if (clock.exceeded() || counters.detailsExtracted >= cfg.limits.maxDetailsPerRun) break;
          if (!card.key) continue;

          // --- cheap local filters, in priority order ----------------------
          // Skip records key on card.identity, NOT card.key. The key carries the
          // posted text, which changes every time LinkedIn's relative clock ticks
          // over, so a card refused once produced a fresh seen_cards row roughly
          // every quarter of an hour it stayed on the page — 3997 rows for 1154
          // distinct postings in one afternoon. That inflates topSkippedCompanies
          // by ~3.5x and turns it from "how many postings did this employer make"
          // into "how long were they on screen", which is the wrong question to
          // tune a watchlist against. Nothing reads these before gating, so
          // dropping the timestamp costs nothing.
          //
          // Everything in this block runs BEFORE the card is clicked, and since
          // the redesign that means it runs before LinkedIn has told us the job
          // id. It works off the card's own text instead, which is what keeps
          // the click budget on watchlist matches rather than spending it
          // discovering the ids of postings we would have thrown away.
          //
          // "Do we already hold this?" is the one gate that genuinely needs the
          // real id, so it is answered from what an earlier click recorded.
          // Location became part of the identity on 16 Aug 2026, so a row
          // written before that is found under the old two-part key and moved
          // across the first time it is hit. Migrating lazily, one card at a
          // time, is what keeps this from re-opening the whole board in a
          // single sweep — the old keys cannot be rewritten in bulk because
          // they hold the card's location text and the jobs table holds the
          // detail pane's.
          let known = store.jobIdForCard(card.identity);
          if (!known) {
            const legacy = store.jobIdForCard(li.legacyCardIdentity(card));
            if (legacy) {
              store.migrateCardKey(li.legacyCardIdentity(card), card.identity, legacy.job_id, legacy.posted_at);
              known = legacy;
              counters.cardKeysMigrated++;
            }
          }
          if (known && store.hasJob(known.job_id)) {
            const cardPostedAt = parseRelativeTime(card.postedText);
            // Same company, same title — but LinkedIn relists roles under a
            // fresh id constantly, and a relisted posting reads as hours newer
            // than the one this maps to. Treating that as already-seen is how a
            // stale copy stays on the board while the live one is never opened.
            const isRepost = cardPostedAt && known.posted_at
              && cardPostedAt - known.posted_at > REPOST_GAP_MS;
            if (!isRepost) {
              counters.skippedKnown++;
              store.touchJob(known.job_id);
              if (store.backfillLogo(known.job_id, card.logoUrl)) counters.logosBackfilled++;
              continue;
            }
            log.debug(`"${card.title}" at ${card.company} looks relisted (${card.postedText}) — opening it rather than trusting the old id.`);
          }

          // A blocked employer is unreachable by any route. This is checked on
          // its own rather than relying on matchCompany returning null, because
          // that returns null for "unknown" and "banned" alike — and once the
          // watchlist stopped being a hard gate, unknown became publishable.
          // MedTourEasy, on the blocklist for being a reported scam, turned up
          // 304 times in one week as a card the old gate happened to drop.
          if (isBlockedCompany(card.company)) {
            counters.skippedCompany++;
            store.noteSkippedCard(card.identity, 'blocked employer', card.company, card.title);
            continue;
          }

          // COMPANY IS THE FIRST GATE. If the employer is not one we care
          // about, nothing else about the posting matters — no title parsing,
          // no role classification, and above all no Gemini call. This is what
          // keeps the classifier budget spent only on jobs that could actually
          // be published, and it is the only thing standing between the site
          // and the unpaid "training & internship" listings that fill a broad
          // search. New employers are added to companies.json by hand, on
          // purpose: a name on the list is a name somebody vouched for.
          const matched = matchCompany(card.company, cfg.watchlist);
          if (cfg.matching.requireCompanyMatch && !matched) {
            counters.skippedCompany++;
            store.noteSkippedCard(card.identity, 'company not on watchlist', card.company, card.title);
            continue;
          }

          const postedAt = parseRelativeTime(card.postedText);
          // Only reject on a *confidently* old timestamp; unparseable text is
          // given the benefit of the doubt rather than silently dropped.
          if (postedAt && postedAt < cutoff) {
            counters.skippedStale++;
            store.noteSkippedCard(card.identity, 'older than window', card.company, card.title);
            continue;
          }

          // The title is the only internship signal left, since LinkedIn's
          // employment-type tag proved unreliable. A watchlist company whose
          // title lacks an internship word is a near miss worth reporting.
          if (!matchTitle(card.title, cfg.titleTerms)) {
            counters.skippedTitle++;
            counters.nearMisses++;
            store.noteSkippedCard(
              card.identity,
              'title lacks intern (watchlist tech role)',
              card.company,
              card.title,
            );
            continue;
          }

          if (cfg.matching.skipViewedCards && card.viewed) {
            counters.skippedViewed++;
            store.noteSkippedCard(card.identity, 'already viewed on LinkedIn', card.company, card.title);
            continue;
          }

          // Decide tech vs non-tech from the title BEFORE deciding whether to
          // open the job. A real backfill came back 11 tech / 46 non-tech, so
          // opening everything spent ~80% of the run's page loads on roles that
          // only need to appear in a list. Non-tech gets stored from card data.
          const titleVerdict = classifyRole(card.title, {
            extraPositive: cfg.matching.extraTechTerms ?? [],
            extraNegative: cfg.matching.extraNonTechTerms ?? [],
          });
          // Only a CONFIDENT non-tech verdict skips the page open. An
          // ambiguous title ("Intern (Bachelor's)", "Intern-Product Analyst")
          // is exactly the case where the description decides, so it is still
          // opened. On the observed backfill that is 4 opens out of 12 rather
          // than 12, while keeping recall on the ones that matter.
          const confidentlyNonTech = titleVerdict.verdict === 'non-tech';

          // The site is engineering-only, so a confidently non-technical title
          // is dropped here rather than stored. It is still recorded in
          // seen_cards, which is what stops the next run re-deciding the same
          // card and gives an honest count of what the sweep discarded.
          if (confidentlyNonTech && cfg.matching.storeNonTechRoles === false) {
            counters.nonTechRoles++;
            store.noteSkippedCard(card.identity, 'non-engineering role', card.company, card.title);
            continue;
          }

          // Listing a role from card data alone needs a job id, and since the
          // redesign there is none until the card is opened. A row stored under
          // a synthetic key could never be linked to, applied to, or matched
          // against LinkedIn again, so the optimisation is simply unavailable
          // here — the card is opened instead. Unreachable under the shipped
          // config, where storeNonTechRoles false has already skipped it above.
          if (confidentlyNonTech && cfg.matching.openNonTechRoles === false && card.jobId) {
            const stipend = extractStipend(card.salaryText);
            const isNew = store.upsertJob({
              jobId: card.jobId,
              title: card.title,
              company: card.company,
              companyMatched: matched,
              location: card.location,
              workplaceType: extractWorkplaceType(card.location),
              postedText: card.postedText,
              postedAt: parseRelativeTime(card.postedText),
              salaryText: card.salaryText,
              stipend,
              easyApply: card.easyApply,
              jobUrl: li.jobUrl(card.jobId),
              logoUrl: card.logoUrl || null,
              searchKeywords: search.label ?? search.keywords,
              // The search's own region, used only when LinkedIn renders no
              // location at all — which it does often. A card with no location
              // text is still known to be inside the search that returned it,
              // unlike an ATS row, which can fall back to nothing.
              regionFallback: search.region ?? null,
              // Already decided; the batch pass will leave it alone.
              isTech: false,
              roleSource: 'offline-card',
            }, runId);
            if (isNew) {
              counters.newJobs++;
              counters.listedWithoutOpening++;
            }
            continue;
          }

          // --- worth opening ------------------------------------------------
          log.ok(`Opening: ${card.title} — ${card.company}${matched ? ` [${matched}]` : ''} (${card.postedText || 'no date'})`);

          await pause(cfg.pacing.betweenCards);
          await idleFidget(page);

          // Brave can die mid-run (it crashed once under memory pressure). Say
          // so plainly and stop, rather than failing on whatever call happened
          // to touch the dead page next.
          if (!(await pageAlive(page))) {
            notes.push('Brave closed unexpectedly partway through the run. Everything captured before that point was kept and published.');
            log.error('Brave is no longer responding — ending the run and keeping what was collected.');
            status = 'partial';
            break searchLoop;
          }

          let detail;
          try {
            detail = await li.openAndExtract(page, card, cfg);
          } catch (err) {
            counters.failedDetails++;
            log.warn(`Could not read "${card.title}" — ${err.message.split('\n')[0]}`);
            await ensureHealthy(page, cfg, { context: `card ${card.key}`, remainingMs: clock.remainingMs() });
            continue;
          }

          // The click is what makes LinkedIn name the posting, so this is the
          // point where the synthetic key is exchanged for the real job id.
          const jobId = detail.jobId;
          if (!jobId) {
            counters.failedDetails++;
            if (!detail.unopenable) {
              log.warn(`Opened "${card.title}" at ${card.company} but no job id appeared — skipping it this run.`);
            }
            await ensureHealthy(page, cfg, { context: `card ${card.key}`, remainingMs: clock.remainingMs() });
            continue;
          }

          await ensureHealthy(page, cfg, { context: `job ${jobId}`, remainingMs: clock.remainingMs() });
          counters.detailsExtracted++;
          openedOnThisPage++;

          const description = detail.description || '';
          const detailPostedAt = parseRelativeTime(detail.postedText || card.postedText);

          // Remember what this card turned out to be, so the next run answers
          // "do we already hold it?" without opening the page again. Written
          // before the store decision below, because it is just as useful for a
          // posting we already have as for a new one.
          store.mapCard(card.identity, jobId, detailPostedAt);

          // Known after all — the id could not be checked before the click.
          if (store.hasJob(jobId)) {
            counters.skippedKnown++;
            store.touchJob(jobId);
            if (store.backfillLogo(jobId, detail.logoUrl || card.logoUrl)) counters.logosBackfilled++;
            continue;
          }

          const job = {
            jobId,
            title: detail.title || card.title,
            company: detail.company || card.company,
            companyMatched: matched,
            location: detail.location || card.location,
            workplaceType: detail.workplaceType || extractWorkplaceType(detail.location, card.location, description),
            postedText: detail.postedText || card.postedText,
            postedAt: detailPostedAt,
            salaryText: detail.salaryText || card.salaryText,
            stipend: extractStipend(detail.salaryText, card.salaryText, description),
            applicants: detail.applicants,
            easyApply: detail.easyApply ?? card.easyApply,
            applyUrl: detail.applyUrl,
            jobUrl: li.jobUrl(jobId),
            duration: extractDuration(description, detail.title || card.title),
            skills: extractSkills(description),
            description,
            searchKeywords: search.label ?? search.keywords,
            // See the note on the other upsertJob call: this is the fallback for
            // a card LinkedIn rendered with no location, not an override.
            regionFallback: search.region ?? null,
            // Detail-pane logo is higher resolution; fall back to the card's.
            logoUrl: detail.logoUrl || card.logoUrl || null,
          };
          job.summary = await summarize(job, description, cfg.summarizer);
          // Verdict is filled in by one batched classifier pass after the walk.
          job.isTech = null;
          job.roleSource = null;

          if (store.upsertJob(job, runId)) {
            counters.newJobs++;
            log.ok(`  → saved (${counters.newJobs} new so far)`);
          }

          if (counters.detailsExtracted > 0 && counters.detailsExtracted % cfg.pacing.longBreakEvery === 0) {
            log.info('Taking a longer break to keep the request rate low…');
            await pause(cfg.pacing.longBreak);
          }
        }

        log.info(`Page ${pageIndex + 1} done — opened ${openedOnThisPage} of ${cards.length} cards.`);

        // Results are date-descending, so once a whole page carries nothing
        // newer than the last sweep covered, everything past it is older still.
        // A card whose posted text will not parse counts as fresh — the same
        // benefit of the doubt the staleness gate gives it.
        if (coveredHorizon && cards.length) {
          const anyFresh = cards.some((c) => {
            const at = parseRelativeTime(c.postedText);
            return !at || at >= coveredHorizon;
          });
          if (anyFresh) {
            coveredPages = 0;
          } else if (++coveredPages >= COVERED_PAGES_BEFORE_STOP) {
            log.ok(`Page ${pageIndex + 1} and the one before it were entirely older than the last sweep — stopping "${label}" here.`);
            walkComplete = true;
            break;
          }
        }

        // Keep paging until LinkedIn's own "Next" control says there is no
        // more, which is the only reliable signal that the result set is
        // exhausted. Fall back to the short-page heuristic only when no
        // pagination bar could be found.
        const more = await li.hasNextPage(page);
        if (more === false) {
          log.ok(`No Next button — all ${pageIndex + 1} pages of "${label}" have been searched.`);
          walkComplete = true;
          break;
        }
        if (more === null && cards.length < li.RESULTS_PER_PAGE) {
          log.info(`No pagination control and a short page — treating page ${pageIndex + 1} as the last.`);
          walkComplete = true;
          break;
        }
        if (pageIndex === lastPage - 1) {
          notes.push(`Stopped at the ${cfg.limits.maxPagesPerSearch}-page safety cap for "${label}", and LinkedIn still had a Next page. Raise limits.maxPagesPerSearch in config.json to go deeper.`);
          log.warn(`Hit the ${cfg.limits.maxPagesPerSearch}-page cap for "${label}" with more pages still available.`);
        }
        await pause(cfg.pacing.betweenPages);
      }

      searchesDone++;

      // Move this region's baseline forward, but only on a walk that both
      // reached a real end AND actually rendered results.
      //
      // The render check is the important half, and it is the per-search
      // equivalent of the run-level floor further down. A degraded session
      // returns one card a page while still serving a result count and a
      // working Next button, so pagination ends "cleanly" having collected
      // almost nothing. Recording that as a completed sweep would advance the
      // baseline over a window that was never really read, and the covered
      // horizon would then skip that ground on every later run — the exact
      // silent hole that keeping lastFullSweep to 'ok' exists to prevent.
      const pagesHere = counters.pagesScanned - before.pages;
      const cardsHere = counters.cardsSeen - before.cards;
      const rendered = pagesHere > 0 && cardsHere / pagesHere >= CARDS_PER_PAGE_FLOOR;

      if (!DRY_RUN && walkComplete && rendered) {
        store.markRegionSweep(region, searchStartedAt);
        log.ok(`${region} swept — ${cardsHere} cards across ${pagesHere} page(s).`);
      } else if (!DRY_RUN && pagesHere > 0 && !rendered) {
        status = 'partial';
        notes.push(
          `The ${region} search averaged ${(cardsHere / pagesHere).toFixed(1)} cards across ${pagesHere} page(s) — ` +
          'the results list did not render, so that region\'s baseline was left where it was. ' +
          'The LinkedIn session is the usual cause; check it with `npm run login`.',
        );
        log.warn(`${region} did not render (${cardsHere} cards / ${pagesHere} pages) — baseline unchanged.`);
      } else if (!DRY_RUN && !walkComplete) {
        log.info(`${region} did not finish its walk — baseline unchanged, next run re-covers the window.`);
      }

      if (searchIndex < ordered.length - 1) {
        log.info('Pausing between searches…');
        await pause(cfg.pacing.betweenSearches);
      }
    }

    // ---- backfill descriptions we never fetched ----------------------------
    // Must happen here, inside the browser session: the `finally` below closes
    // Brave, and enrichment further down has no page to work with.
    await backfillDescriptions(page, store, cfg, clock, counters);
  } catch (err) {
    if (err instanceof RunAborted) {
      status = counters.newJobs > 0 ? 'partial' : 'aborted';
      fatalError = err.message;

      // A rate limit means back off hard rather than trying again in six hours.
      if (err.state === State.RATE_LIMITED && cfg.safety.cooldownHoursAfterRateLimit > 0) {
        const until = Date.now() + cfg.safety.cooldownHoursAfterRateLimit * 3_600_000;
        store.setCooldown(until, 'a LinkedIn rate limit');
        notes.push(`Runs are paused for ${cfg.safety.cooldownHoursAfterRateLimit}h after that rate limit. Override with \`node src/index.js --force\`.`);
        log.warn(`Cooling down until ${new Date(until).toLocaleString('en-IN')}.`);
      }

      notes.push(
        err.state === State.CHALLENGE ? 'A LinkedIn security check went unsolved, so the scan stopped early. Whatever was found before that is below.'
        : err.state === State.LOGGED_OUT ? 'The LinkedIn session expired mid-run. Run `npm run login` to sign in again.'
        : err.state === State.BROWSER_GONE ? 'The browser closed part way through, so the scan stopped there. Nothing to do with LinkedIn — usually the window was closed by hand, or a second run started and took the profile. Whatever was collected first was kept.'
        : 'LinkedIn started rate limiting, so the scan stopped early to protect the account.',
      );
      log.error(err.message);
    } else {
      status = 'error';
      fatalError = err.message;
      // Brave failing to start is a LOCAL fault — a leftover process holding the
      // tool profile, almost always left by the run before it. Nothing reached
      // LinkedIn, launchBrave has already cleared the profile on its way out,
      // and the next attempt usually succeeds immediately. Waiting out the full
      // interval throws away a slot for a condition that fixed itself seconds
      // ago, so this joins the network case in asking for a fast retry.
      if (/would not launch/i.test(err.message)) braveLaunchFailed = true;
      log.error(`Run failed: ${err.stack ?? err.message}`);
      notes.push(`The run failed: ${err.message}`);
      if (cfg.notifications.onError) {
        await notify('Internship watcher failed', err.message.slice(0, 180), { sound: 'Basso' });
      }
    }
  } finally {
    if (session) await closeBrave(session);
  }

  // ---- report ---------------------------------------------------------------

  // ---- classify the roles we captured, in one batch ------------------------
  // Deliberately after the walk rather than during it: on a free tier the
  // request count is the scarce resource, so forty candidates should cost one
  // call rather than forty. Nothing here gates publication — a non-tech role
  // still reaches the site, just in the other section.
  // Everything still lacking a verdict, not merely this run's catch. A row
  // stored before the verdict column existed would otherwise sit in the wrong
  // tab forever — which is exactly what happened on the first run after this
  // shipped: five real jobs, all filed as "other", tech tab empty.
  const publishWindowMs = (cfg.publish?.maxAgeDays ?? 14) * 86_400_000;
  const unclassified = store.jobsNeedingRoleVerdict(Date.now() - publishWindowMs);

  if (unclassified.length) {
    const roleOpts = {
      extraPositive: cfg.matching.extraTechTerms,
      extraNegative: cfg.matching.extraNonTechTerms,
    };

    // Only titles the vocabulary cannot settle — generic ones like "Trainee",
    // or ones resting on nothing but the word "Engineer" — are worth an API
    // call. Everything else is decided offline for free.
    const ambiguous = [];
    const clear = [];
    for (const job of unclassified) {
      (needsDescription(job.title, roleOpts) ? ambiguous : clear).push(job);
    }

    for (const job of clear) {
      const r = classifyRole(job.title, roleOpts);
      const isTech = r.verdict === 'tech';
      store.setRoleVerdict(job.job_id, isTech, 'offline');
      if (isTech) counters.techRoles++; else counters.nonTechRoles++;
    }

    if (ambiguous.length) {
      log.info(`${ambiguous.length} title(s) too generic to judge — reading their descriptions.`);
      const withDesc = ambiguous.map((j) => ({
        title: j.title,
        company: j.company,
        description: store.descriptionFor(j.job_id),
      }));
      const answers = await classifyFromDescriptions(withDesc, cfg);
      const polarity = builtInPolarity();

      ambiguous.forEach((job, i) => {
        const a = answers?.get(i);
        if (a) {
          store.setRoleVerdict(job.job_id, a.isTech, 'model-description');
          if (a.isTech) counters.techRoles++; else counters.nonTechRoles++;
          counters.geminiJudged++;

          if (a.keyTerm) {
            const { result, why } = learn(learnedStore, {
              term: a.keyTerm,
              isTech: a.isTech,
              title: job.title,
              description: withDesc[i].description,
              company: job.company,
            }, polarity, cfg.matching.titleMustMatch ?? []);
            if (result === 'added') {
              counters.termsLearned++;
              log.ok(`  learned "${a.keyTerm.toLowerCase()}" -> ${a.isTech ? 'tech' : 'other'}`);
            } else if (result === 'rejected') {
              log.debug(`  did not learn "${a.keyTerm}" (${why})`);
            }
          }
        } else {
          // Gemini unavailable — decide offline and publish anyway.
          //
          // A posting must never sit unpublished waiting for a quota to reset.
          // Being early is the entire product, and an internship held back for
          // six hours pending a classifier is as good as missed.
          //
          // So an UNCERTAIN title counts as technical rather than being held or
          // buried. That is deliberately the generous direction: showing one
          // borderline role costs a student a moment's reading, while hiding a
          // real engineering internship costs them the application. The company
          // watchlist and the title filter have already run, so what reaches
          // here is an internship at a company we track.
          //
          // The verdict is marked 'offline-uncertain' rather than 'offline', and
          // store.jobsNeedingRoleVerdict re-queries exactly that source, so once
          // quota returns Gemini reads the description and upgrades the guess.
          // It publishes now and gets more accurate later.
          //
          // Safe to be generous because the company gate has already run: every
          // row reaching here is an internship at an employer on the watchlist.
          const r = classifyRole(job.title, roleOpts);
          const isTech = r.verdict !== 'non-tech';
          store.setRoleVerdict(job.job_id, isTech, r.verdict === 'uncertain' ? 'offline-uncertain' : 'offline-fallback');
          if (isTech) counters.techRoles++; else counters.nonTechRoles++;
        }
      });
    }

    log.info(`Classified ${unclassified.length} role(s): ${counters.techRoles} tech, ${counters.nonTechRoles} other · ${clear.length} offline, ${counters.geminiJudged} from descriptions`);
    if (counters.termsLearned) {
      log.ok(`Learned ${counters.termsLearned} new term(s) — future runs decide these offline. ${learnedPath().replace(process.env.HOME ?? '', '~')}`);
    }
  }

  const summaryLine =
    `${counters.cardsSeen} cards scanned · ${counters.detailsExtracted} opened · ${counters.newJobs} new · ` +
    `skipped ${counters.skippedCompany} off-watchlist, ${counters.skippedTitle} title not an internship, ` +
    `${counters.skippedStale} older than ${[...windowsUsed].sort((a, b) => a - b).join('/') || cfg.filters.postedWithinHours}h, ${counters.skippedKnown} already known, ` +
    `${counters.skippedViewed} already viewed · ${counters.listedWithoutOpening} listed without opening` +
    (counters.descriptionsBackfilled ? ` · ${counters.descriptionsBackfilled} descriptions backfilled` : '') +
    (counters.failedDetails ? ` · ${counters.failedDetails} failed to read` : '') +
    (counters.cardsWithoutId ? ` · ${counters.cardsWithoutId} cards could not be read` : '') +
    // Only while the pre-location card keys are still being moved across. Once
    // this stops appearing the migration is done and it can be dropped.
    (counters.cardKeysMigrated ? ` · ${counters.cardKeysMigrated} card keys migrated` : '');

  log.section('Summary');
  log.info(summaryLine);
  log.info(`Took ${clock.elapsedSeconds()}s`);

  // Persist the rotation cursor on every path, including an aborted run —
  // searches that did complete should not be repeated at the expense of ones
  // that never got their turn.
  if (!DRY_RUN && allSearches.length > 0) {
    const next = searchesDone >= allSearches.length
      ? 0
      : (searchStart + searchesDone) % allSearches.length;
    store.setSetting('search_cursor', next);

    if (searchesDone >= allSearches.length) {
      log.ok(`Covered all ${allSearches.length} searches — every watchlist company was queried.`);
    } else {
      const remaining = allSearches.length - searchesDone;
      notes.push(`Covered ${searchesDone} of ${allSearches.length} searches this run. The other ${remaining} are first in the queue next time, so no company batch is permanently skipped.`);
      log.info(`Covered ${searchesDone}/${allSearches.length} searches — next run resumes at position ${next + 1}.`);
    }
  }

  // "0 new jobs, 97 off-watchlist" invites the question "which 97?". Answer it
  // here, so the watchlist can be tuned from evidence rather than guesswork.
  if (counters.nearMisses > 0) {
    log.warn(`${counters.nearMisses} tech role(s) at watchlist companies were skipped only because the title lacks an internship word.`);
    log.info('Review them with `node bin/show-report.js --roles` — they may be internships titled unconventionally.');
  }

  if (counters.newJobs === 0 && counters.skippedCompany > 0) {
    const top = store.topSkippedCompanies(8, Date.now() - 7 * 86_400_000);
    if (top.length) {
      log.info('Most frequent companies skipped as off-watchlist (last 7 days):');
      for (const { company, n } of top) log.info(`    ${String(n).padStart(3)}×  ${company}`);
      log.info('Add any of these to config.json, or see the full list with `node bin/show-report.js --skipped`.');
    }
  }

  // A run that navigated nowhere and saw nothing did not succeed, whatever the
  // absence of an exception suggests. Reporting it as ok made the runs table
  // useless for spotting trouble: three of the worst runs today were logged
  // green while scanning zero pages.
  if (status === 'ok' && counters.pagesScanned === 0 && !DRY_RUN) {
    status = 'partial';
    notes.push('This run reached LinkedIn but never scanned a results page.');
  }

  // A rendered page of results is 20-25 cards. A sweep averaging a handful per
  // page has not found a quiet search — it has found a session LinkedIn has
  // stopped serving results to, which draws the list as the single job in the
  // detail pane and nothing else.
  //
  // assertListRendered cannot see this: it only fires on a count of exactly 0,
  // so one card per page walks straight past it. Five runs on 12 Aug reported
  // ok at 1 card a page, collecting 3 cards where the same search had been
  // returning 250. Nothing in the runs table looked wrong.
  //
  // Marking it partial is what makes it recoverable, not just visible:
  // lastFullSweep() reads 'ok' only, so an ok here becomes the new baseline and
  // pins the next lookback to its 3h minimum, leaving the missed postings
  // behind for good. As partial, the baseline stays put and the window stretches
  // over the gap (to maxWindowHours) on the next healthy run.
  if (
    status === 'ok' && !DRY_RUN &&
    counters.pagesScanned > 0 &&
    counters.cardsSeen / counters.pagesScanned < CARDS_PER_PAGE_FLOOR
  ) {
    status = 'partial';
    notes.push(
      `Only ${counters.cardsSeen} card(s) across ${counters.pagesScanned} page(s) — the results list did not ` +
      'render. The LinkedIn session is the usual cause; check it with `npm run login`.',
    );
  }

  store.finishRun(runId, {
    status,
    pagesScanned: counters.pagesScanned,
    cardsSeen: counters.cardsSeen,
    detailsExtracted: counters.detailsExtracted,
    newJobs: counters.newJobs,
    skippedNote: summaryLine,
    error: fatalError,
  });

  // Enrich before the report and the publish, so a job reaches the site with its
  // bullets, eligibility and skills already attached. Doing this only in bin/enrich.js
  // meant every freshly scraped job appeared as a boilerplate paragraph until the next
  // manual run — the newest listings, which are the ones anyone actually looks at.
  if (!DRY_RUN) await enrichNewJobs(store, cfg);

  const newJobs = store.jobsForRun(runId);
  const html = buildReport({
    jobs: newJobs,
    run: { runId, startedAt: Date.now() - clock.elapsedSeconds() * 1000, finishedAt: Date.now(), ...counters },
    notes,
    stats: store.stats(),
  });
  const file = writeReport(html, runId);
  log.ok(`Report: ${file}`);

  // Everything that interrupts HIM is scoped to the region he actually applies
  // in; everything that serves READERS stays per-region.
  //
  // He applies to internships in India. A US listing is worth collecting,
  // publishing and posting to @interndoorusa, and worth nothing at all as a
  // banner on his Mac at 2am — it is not an opportunity he will act on. Left
  // unscoped this got noticeably worse the moment US collection went live: one
  // run alone produced 86 new listings, 76 of them American, so the alert that
  // exists to say "apply in the first hour" would mostly be announcing roles he
  // will never open.
  //
  // The region is re-derived from the location rather than read off the stored
  // column, for the same reason publish does it: a row captured before a
  // gazetteer fix carries the old answer, and this gazetteer keeps improving.
  //
  // The REPORT ITSELF still contains every region and is still written every
  // run — it is the record of what happened, and its "Add to post queue"
  // buttons are useful for a US role he might post about even though he would
  // not apply to it. Only the decision to OPEN it is scoped.
  const homeRegion = cfg.notifications.homeRegion ?? 'IN';
  const homeJobs = homeRegion === 'all'
    ? newJobs
    : newJobs.filter((j) => resolveRowRegion(j) === homeRegion);
  const elsewhere = newJobs.length - homeJobs.length;

  if (newJobs.length) store.markReported(newJobs.map((j) => j.job_id));

  if (homeJobs.length) {
    if (cfg.notifications.onNewJobs) {
      const top = homeJobs.slice(0, 3).map((j) => `${j.company}: ${j.title}`).join('\n');
      await notify(
        `${homeJobs.length} new internship${homeJobs.length === 1 ? '' : 's'}`,
        top + (homeJobs.length > 3 ? `\n…and ${homeJobs.length - 3} more` : ''),
        { sound: 'Ping', subtitle: 'Click to open the report' },
      );
    }
    if (cfg.notifications.openReportWhenDone && !NO_OPEN) {
      // Over http when bin/queue-server.js is listening, so the "Add to post
      // queue" buttons in the report have a same-origin API to talk to; the
      // file otherwise. Same bytes either way — the report is never withheld
      // because a convenience is down.
      await openFile(await reportTarget(runId, file, cfg));
    }

    // The phone is the point: a banner on a sleeping Mac is a notification nobody
    // sees, and this whole project is about applying in the first hour.
    const tech = homeJobs.filter((j) => j.is_tech);
    const lead = (tech.length ? tech : homeJobs).slice(0, 4);
    await pushToPhone(
      `${homeJobs.length} new internship${homeJobs.length === 1 ? '' : 's'}`,
      lead.map((j) => `${j.company} — ${j.title}`).join('\n')
        + (homeJobs.length > lead.length ? `\n…and ${homeJobs.length - lead.length} more` : ''),
      { url: 'https://interndoor.com/', tags: ['satellite'], priority: 4 },
    );
  } else if (elsewhere) {
    // Said out loud rather than passed over in silence: the run DID find
    // listings, they went to the site and the channel, and the only thing that
    // did not happen is the part aimed at him.
    log.info(`${elsewhere} new listing${elsewhere === 1 ? '' : 's'} outside ${homeRegion} — published, not alerted. Report: ${file}`);
  } else {
    log.info('No new matching internships this run.');
  }

  // Push the public job list. Runs even with 0 new jobs so the site drops
  // listings that have aged out of the window.
  if (!DRY_RUN) await publish(store, cfg, newJobs.length);

  // The channel post goes AFTER publish, deliberately. Every listing in it
  // links to that job's page on the site, and those pages are written by
  // publish — posting first would send the channel a burst of links that 404
  // for however long the deploy takes.
  if (!DRY_RUN && newJobs.length) await postNewJobs(newJobs, cfg);

  store.setSetting(LOCK_KEY, 0);
  store.close();
  // A run that reached no page because the machine had no working network is
  // NOT a reason to sit out the rest of the interval. On 19 Aug eight runs died
  // this way — each burned its whole 30-minute slot on a 41-second failure, and
  // one of them was the slot that should have caught an American Express
  // posting. It surfaced 55 minutes late, by which point 100+ people had
  // applied. That is the entire promise of the site, lost to a wifi blip.
  //
  // Exit 75 (EX_TEMPFAIL) tells bin/loop.sh to come back in two minutes instead
  // of thirty. Scoped hard: only when nothing was scanned, only when the failure
  // was network-level, and NEVER when LinkedIn answered with a rate limit —
  // retrying into a 429 is how a session gets restricted.
  const EXIT_RETRY_SOON = 75;
  const retrySoon = !DRY_RUN && counters.pagesScanned === 0
    && (sawNetworkFailure || braveLaunchFailed) && !sawBlocked;
  if (retrySoon) {
    log.warn('This run reached no page because the network was down — asking the scheduler to retry shortly rather than wait out the interval.');
  }
  // retrySoon is checked FIRST. A Brave launch failure sets status='error', and
  // testing that first would return 1 and put the scheduler back to sleep for
  // the full interval — which is the exact slot this is meant to save.
  process.exitCode = retrySoon ? EXIT_RETRY_SOON : status === 'error' ? 1 : 0;
}

// Make sure an unexpected crash still leaves a trace in the log file.
main().catch((err) => {
  log.error(`Unhandled: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
