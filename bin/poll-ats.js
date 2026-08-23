#!/usr/bin/env node
/**
 * Read every discovered ATS board and store the internships found.
 *
 *   node bin/poll-ats.js              poll all boards, store, publish
 *   node bin/poll-ats.js --dry-run    show what would be stored, write nothing
 *   node bin/poll-ats.js --no-publish store, but do not regenerate the site
 *   node bin/poll-ats.js --company "Meesho"
 *
 * This is the cheap half. No browser, no login, no pacing, no rate-limit guard —
 * just JSON over HTTPS from endpoints that exist to be read. That is why it can
 * run far more often than the LinkedIn scan, and why being early here is a
 * property of the source rather than of how hard we push.
 *
 * Postings land in the same `jobs` table as the scraper's, so the site does not
 * know or care which collector found a role. `source` records which one did,
 * because when two collectors disagree you want to know who said what.
 */
import { loadConfig, matchCompany, matchTitle } from '../src/config.js';
import { Store } from '../src/store.js';
import { fetchBoard, fetchDetail, FIRST_PARTY_BOARDS } from '../src/ats.js';
import { classifyRole } from '../src/roles.js';
import { extractStipend, extractDuration, extractSkills, extractWorkplaceType } from '../src/extract.js';
import { resolveRegion, collectsRegion, UNKNOWN } from '../src/regions.js';
import { employmentType, INTERN } from '../src/employment.js';
import { summarize } from '../src/summarize.js';
import { publish } from '../src/publish.js';
import { log } from '../src/logger.js';

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const valueOf = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : null; };

const DRY_RUN = has('--dry-run');
const NO_PUBLISH = has('--no-publish');
const ONLY = valueOf('--company');
const CONCURRENCY = Number(valueOf('--concurrency') ?? 8);

const cfg = loadConfig();
const store = new Store();
store.ensureAtsTable();

/**
 * Assert the boards that cannot be discovered.
 *
 * Amazon and Microsoft run their own careers systems, so there is no token for
 * discovery to guess — probing Greenhouse and Lever slugs will never find a
 * board that was never there. Without this they exist only as a row somebody
 * inserted by hand once, and a fresh database loses them silently.
 *
 * Idempotent, and deliberately a repair rather than an insert: it also corrects
 * a company whose board was mis-identified by an earlier discovery run. Amazon
 * was filed under an unrelated Personio tenant that way, which would have
 * published a stranger's jobs under Amazon's name.
 */
for (const [company, [provider, token]] of Object.entries(FIRST_PARTY_BOARDS)) {
  const row = store.getAts(company);
  if (row?.provider === provider && row?.token === token) continue;
  store.saveAts(company, provider, token, row?.job_count ?? 0);
  log.info(`Seeded first-party board: ${company} → ${provider}:${token}${row?.provider ? ` (was ${row.provider}:${row.token})` : ''}`);
}

let boards = store.atsBoards();
if (ONLY) boards = boards.filter((b) => b.company.toLowerCase() === ONLY.toLowerCase());

/**
 * Workday is polled on rotation, not all at once.
 *
 * Every other provider here publishes its job-board API and is happy to be read.
 * Workday publishes nothing — the endpoint is the one its own careers pages
 * call — and reading 38 tenants every 15 minutes came to roughly 3,650 requests
 * a day, at which point it started answering every tenant with the careers-page
 * HTML instead of data. That is the same volume mistake the LinkedIn scraper is
 * built to avoid, arrived at from the other direction.
 *
 * So: a handful of the least-recently-read boards per run, in sequence rather
 * than in parallel. Each board still gets read several times a day, which is
 * ample for enterprise postings that stay open for weeks, at about a tenth of
 * the traffic.
 */
/**
 * Workday tenants read per run, and why it is so small.
 *
 * Every other provider here publishes its board API and is happy to be read.
 * Workday publishes nothing — the endpoint is the one its own careers pages
 * call — and reading 38 tenants every 15 minutes came to ~3,650 requests a day,
 * at which point it began answering every tenant with careers-page HTML instead
 * of data. Four a run keeps each board read several times a day at about a
 * tenth of that traffic, which is ample for enterprise postings that stay open
 * for weeks.
 *
 * `--workday-limit N` overrides it for a ONE-OFF seed. Discovery can add
 * tenants faster than the rotation surfaces them — the Workday fix on 23 Aug
 * added 21 at once, which is seven hours at four a run — and a single pass over
 * all of them is 59 requests, not 3,650. Do not put this in the scheduler.
 */
const WORKDAY_PER_RUN = Number(valueOf('--workday-limit') ?? 4);
const workdayAll = boards.filter((b) => b.provider === 'workday');
const others = boards.filter((b) => b.provider !== 'workday');
const workdayNow = ONLY ? workdayAll : [...workdayAll]
  .sort((a, b) => (a.last_polled ?? 0) - (b.last_polled ?? 0))
  .slice(0, WORKDAY_PER_RUN);
boards = others;

// Both lists, not just `boards`. Checking only the non-Workday half meant a
// database holding nothing but Workday tenants reported "no boards known" and
// exited without polling any of them.
if (!boards.length && !workdayNow.length) {
  console.log('No ATS boards known yet. Run `node bin/discover-ats.js` first.');
  store.close();
  process.exit(0);
}

/**
 * Which regions this poller keeps.
 *
 * These boards have no country. One Greenhouse board carries every office a
 * company has — Stripe's returns Dublin, San Francisco, Bengaluru and Singapore
 * in a single response — so geography is a property of the ROWS, never of the
 * request. That is the whole reason a worldwide board is affordable: collecting
 * every region costs exactly the same number of requests as collecting one.
 *
 * It used to keep India alone, and a census on 23 Aug of the 170 non-Workday
 * boards already discovered found 189 live engineering internships, of which
 * 13 were in India. The other 176 were fetched, classified and thrown away on
 * every single run.
 *
 * `unknown` is collected and never published. A location the gazetteer cannot
 * read yet is still a real posting, and storing it means a better gazetteer
 * picks it up later without re-reading a single board.
 */
const collected = (region) => collectsRegion(cfg, region);

/**
 * How old a posting may be and still count as news.
 *
 * The scraper never needed this: LinkedIn is searched with a time window, so
 * stale roles are filtered at the source. An ATS board has no such window — it
 * lists whatever is still open, and companies leave roles open for months. The
 * first real poll surfaced postings 159 and 214 days old, which would have gone
 * onto a site whose entire promise is being early. Being first to a
 * seven-month-old listing is not a feature.
 */
const MAX_POSTING_AGE_DAYS = Number(valueOf('--max-age-days') ?? cfg.ats?.maxPostingAgeDays ?? 30);
const OLDEST_ACCEPTABLE = Date.now() - MAX_POSTING_AGE_DAYS * 86_400_000;

let checked = 0;
let stored = 0;
let skippedNonIntern = 0;
let skippedRegion = 0;
const keptByRegion = {};
let skippedNonTech = 0;
let skippedStale = 0;
let failed = 0;
const preview = [];

async function pollOne(board) {
  let jobs;
  try {
    jobs = await fetchBoard(board.provider, board.token);
  } catch (err) {
    failed++;
    log.debug(`${board.company}: ${err.message}`);
    return;
  }
  checked++;
  // Name the board here too. A provider that answers with no usable payload
  // counts as failed but threw nothing, so this branch was the one failure in
  // "174/174 boards read, 1 failed" that left no way to tell which board it was.
  if (!jobs) { failed++; log.debug(`${board.company}: the board returned no jobs payload.`); return; }

  for (const j of jobs) {
    // Internship, or a full-time role aimed at the same people? US campus
    // hiring writes "New Grad" and "Early Career" where India writes "Intern",
    // and refusing those threw away 139 US/UK roles a student would want. They
    // are collected and LABELLED, never filed as internships — employmentType
    // is a field Google reads.
    const kind = employmentType(j.title, (t) => matchTitle(t, cfg.titleTerms));
    if (!kind) { skippedNonIntern++; continue; }
    // No fallback: a board that lists every office says nothing about which one
    // a blank location means, so a blank is honestly unknown. The LinkedIn
    // collector passes its search's region here instead, because a card with no
    // location text is still known to be inside the search that returned it.
    let region = resolveRegion(j.location, {});
    // Only when the primary said nowhere. Where an office does place the role,
    // its text also REPLACES the location, because a slot holding "In-Office"
    // was never a location and "Austin, TX, United States" is what the reader
    // should see on the card.
    if (region === UNKNOWN) {
      for (const alt of j.locationAlt ?? []) {
        const better = resolveRegion(alt, {});
        if (better !== UNKNOWN) { region = better; j.location = alt; break; }
      }
    }
    if (!collected(region)) { skippedRegion++; continue; }
    // A posting with no date is kept — some providers omit it — but a known-old
    // one is not, however open it still is.
    if (j.postedAt && j.postedAt < OLDEST_ACCEPTABLE) { skippedStale++; continue; }

    const verdict = classifyRole(j.title, {
      extraPositive: cfg.matching.extraTechTerms ?? [],
      extraNegative: cfg.matching.extraNonTechTerms ?? [],
    });
    // Same rule as the scraper: engineering only, but an ambiguous title is not
    // thrown away on the title alone.
    if (verdict.verdict === 'non-tech') { skippedNonTech++; continue; }
    const isTech = verdict.verdict === 'tech' ? true : null;

    // Some providers only expose the description and the real posting date on a
    // per-job endpoint. Fetch it now, after the filters, so the cost is one
    // request per internship kept rather than one per posting seen.
    const extra = await fetchDetail(board.provider, board.token, j);
    if (extra?.description) j.description = extra.description;
    if (extra?.postedAt) j.postedAt = extra.postedAt;

    // Re-apply staleness with the real date, which we may only now have. A
    // Workday listing shows "Posted 2 Days Ago" in the list and its true
    // startDate only here, so this is the first honest chance to judge it.
    if (j.postedAt && j.postedAt < OLDEST_ACCEPTABLE) { skippedStale++; continue; }

    // Prefixed so an ATS id can never collide with a LinkedIn numeric job id.
    const jobId = `ats:${board.provider}:${board.token}:${j.id}`;

    if (DRY_RUN) {
      preview.push(`[${region}${kind === INTERN ? '' : '/FT'}] ${board.company} — ${j.title}${j.location ? ` (${j.location})` : ''}`);
      stored++;
      keptByRegion[region] = (keptByRegion[region] ?? 0) + 1;
      continue;
    }

    const isNew = store.upsertJob({
      jobId,
      title: j.title,
      company: board.company,
      companyMatched: matchCompany(board.company, cfg.watchlist) ?? board.company,
      location: j.location,
      workplaceType: j.remote || extractWorkplaceType(j.location),
      postedAt: j.postedAt,
      postedText: null,
      salaryText: null,
      stipend: extractStipend(j.description ?? '', j.title),
      duration: extractDuration(j.description ?? '', j.title),
      skills: extractSkills(j.description ?? ''),
      description: j.description ?? null,
      summary: j.description ? await summarize({ title: j.title, company: board.company }, j.description, cfg.summarizer) : null,
      jobUrl: j.url,
      applyUrl: j.url,
      searchKeywords: `ats:${board.provider}`,
      isTech,
      roleSource: `ats-${board.provider}`,
      region,
      employmentType: kind,
    }, `ats-${new Date().toISOString().slice(0, 10)}`);

    if (isNew) {
      stored++;
      keptByRegion[region] = (keptByRegion[region] ?? 0) + 1;
      log.ok(`  + ${board.company} — ${j.title}${j.location ? ` (${j.location})` : ''}`);
    }
  }

  if (!DRY_RUN) store.markAtsPolled(board.company);
}

console.log(`Polling ${boards.length} ATS board${boards.length === 1 ? '' : 's'}…\n`);

const queue = [...boards];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const b = queue.shift();
    if (b) await pollOne(b);
  }
}));

// Sequential, with a gap. Concurrent bursts are what drew the block.
if (workdayNow.length) {
  console.log(`\nWorkday: ${workdayNow.length} of ${workdayAll.length} boards this run (least recently read)…`);
  for (const b of workdayNow) {
    await pollOne(b);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.log(`\n=== ${checked}/${boards.length + workdayNow.length} boards read${failed ? `, ${failed} failed` : ''} ===`);
console.log(`  ${stored} new internship${stored === 1 ? '' : 's'} stored`);
console.log(`  skipped: ${skippedNonIntern} not an internship · ${skippedRegion} outside the collected regions · ${skippedStale} older than ${MAX_POSTING_AGE_DAYS}d · ${skippedNonTech} non-engineering`);
// By region, because a single total hides the thing worth watching: whether a
// region has enough inventory to be worth publishing, and how much of the
// intake the gazetteer is still failing to place.
const byRegion = Object.entries(keptByRegion).sort((a, b) => b[1] - a[1]);
if (byRegion.length) {
  console.log(`  by region: ${byRegion.map(([r, n]) => `${r} ${n}`).join(' · ')}`);
  const unplaced = keptByRegion[UNKNOWN] ?? 0;
  if (unplaced) console.log(`  ${unplaced} could not be placed — stored, never published. Add their locations to src/regions.js.`);
}

if (DRY_RUN) {
  console.log('\n--dry-run, nothing written. Would have stored:');
  for (const p of preview.slice(0, 40)) console.log('   ' + p);
  if (preview.length > 40) console.log(`   …and ${preview.length - 40} more`);
} else if (stored && !NO_PUBLISH) {
  console.log('\nPublishing…');
  await publish(store, cfg, stored);
}

store.close();
