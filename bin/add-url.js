#!/usr/bin/env node
/**
 * Add a posting by its careers-site URL. No browser, no search, no waiting.
 *
 *   node bin/add-url.js https://www.amazon.jobs/en-gb/jobs/10506481/sde-i-intern-...
 *   node bin/add-url.js <url> <url> --company "Stripe"
 *   node bin/add-url.js <url> --dry-run
 *   node bin/add-url.js <url> --force --no-publish
 *
 * The companion to bin/add-job.js, which does the same for LinkedIn but has to
 * drive a signed-in Brave. Everything here is one HTTPS request.
 *
 * It exists because a collector cannot find what its source does not index.
 * Amazon's India board lists 2,538 postings and four internships, none of them
 * engineering, while its SDE internship sits at a live URL that Amazon's own
 * search cannot return — see the header of src/joburl.js for the measurements.
 * When that happens the only thing that recovers the posting is somebody
 * pasting the address.
 *
 * The gates are the same ones bin/poll-ats.js applies, and they REPORT rather
 * than skip silently. A URL typed by hand is a deliberate choice, so the tool's
 * job is to say what it thinks and let him overrule it with --force.
 */
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig, matchCompany, matchTitle } from '../src/config.js';
import { resolveJobUrl } from '../src/joburl.js';
import { classifyRole } from '../src/roles.js';
import { employmentType, INTERN } from '../src/employment.js';
import { resolveRegion, UNKNOWN, publishedRegions } from '../src/regions.js';
import { extractStipend, extractDuration, extractSkills, extractWorkplaceType } from '../src/extract.js';
import { summarize } from '../src/summarize.js';
import { enrichJobs } from '../src/ollama.js';
import { writeJobsFile } from '../src/publish.js';
import { log } from '../src/logger.js';

const ROOT = join(import.meta.dirname, '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* optional */ }

const ARGS = process.argv.slice(2);
const flag = (n) => ARGS.includes(n);
const opt = (n) => { const i = ARGS.indexOf(n); return i === -1 ? null : ARGS[i + 1] ?? null; };

const DRY_RUN = flag('--dry-run');
const FORCE = flag('--force');
const NO_PUBLISH = flag('--no-publish');
const NO_ENRICH = flag('--no-enrich');
const COMPANY = opt('--company');

const urls = ARGS.filter((a) => /^https?:\/\//i.test(a));
if (!urls.length) {
  console.error(`
Add a posting by its careers-site URL.

  node bin/add-url.js <url> [<url>…] [options]

  --company "Name"  the employer, when the board token is not it
  --force           store even if the role or employment gates say no
  --dry-run         say what would happen, write nothing
  --no-enrich       skip the local model (the page will have no bullets)
  --no-publish      do not rewrite the public job list
`);
  process.exit(1);
}

const cfg = loadConfig();
const store = new Store();
const added = [];
// Rows he has judged himself. Kept separately because enrichment gets a vote
// too, and his has to outrank it — see below.
const forced = [];

for (const url of urls) {
  log.info(`\n${url}`);
  const found = await resolveJobUrl(url, { company: COMPANY });

  if (found?.error) {
    log.warn(`  ${found.error}`);
    if (found.hint) log.info(`  ${found.hint}`);
    continue;
  }

  const { provider, token, job } = found;
  // A URL carries the board TOKEN, which is the company name lower-cased and
  // mangled. Prefer the real name the discovery pass already recorded against
  // that token, then the watchlist's spelling, and only then the token itself.
  const company = COMPANY
    || store.companyForBoard(provider, token)
    || matchCompany(found.company, cfg.watchlist)
    || found.company;
  const jobId = `ats:${provider}:${token}:${job.id}`;

  log.ok(`  ${company} — ${job.title}`);
  if (job.location) log.info(`  ${[job.location, ...job.locationAlt].join(' · ')}`);

  if (store.hasJob(jobId)) {
    if (FORCE) {
      store.setRoleVerdict(jobId, true, 'manual-url');
      log.ok('  already stored — re-asserted the engineering verdict.');
      forced.push(jobId);
    } else {
      log.info('  already stored — nothing to do.');
    }
    continue;
  }

  // Internship, or a full-time role aimed at the same people. Both are kept and
  // LABELLED; neither is guessed at.
  const kind = employmentType(job.title, (t) => matchTitle(t, cfg.titleTerms));
  if (!kind && !FORCE) {
    log.warn('  the title names neither an internship nor an early-career role — pass --force to store it anyway.');
    continue;
  }

  // Same order as the poller: the primary location decides, and an alternate is
  // consulted only when the primary places nowhere. Where an alternate does
  // place it, it REPLACES the location, because a slot that resolved nowhere
  // was never much of a location.
  let region = resolveRegion(job.location, {});
  if (region === UNKNOWN) {
    for (const alt of job.locationAlt ?? []) {
      const better = resolveRegion(alt, {});
      if (better !== UNKNOWN) { region = better; job.location = alt; break; }
    }
  }

  const verdict = classifyRole(job.title, {
    extraPositive: cfg.matching.extraTechTerms ?? [],
    extraNegative: cfg.matching.extraNonTechTerms ?? [],
  });
  if (verdict.verdict === 'non-tech' && !FORCE) {
    log.warn(`  classified non-engineering (${verdict.matched ?? 'no positive term'}) — pass --force to store it anyway.`);
    continue;
  }
  const isTech = verdict.verdict === 'tech' ? true : FORCE ? true : null;

  // Say plainly whether this will actually appear, rather than storing it and
  // leaving him to wonder why the site never shows it.
  const live = publishedRegions(cfg).map((r) => r.code);
  if (region === UNKNOWN) {
    log.warn('  the location could not be placed — this will be stored and never published. Add it to src/regions.js.');
  } else if (!live.includes(region)) {
    log.warn(`  ${region} is collected but not published — stored, and it will appear if ${region} is switched on.`);
  }

  if (DRY_RUN) {
    log.info(`  would store as ${jobId} · region ${region} · ${kind === INTERN ? 'internship' : kind || 'forced'} · tech ${isTech}`);
    continue;
  }

  const description = job.description ?? '';
  store.upsertJob({
    jobId,
    title: job.title,
    company,
    companyMatched: matchCompany(company, cfg.watchlist) ?? company,
    location: job.location,
    workplaceType: job.remote || extractWorkplaceType(job.location),
    postedAt: job.postedAt,
    postedText: null,
    salaryText: null,
    stipend: extractStipend(description, job.title),
    duration: extractDuration(description, job.title),
    skills: extractSkills(description),
    description: description || null,
    summary: description ? await summarize({ title: job.title, company }, description, cfg.summarizer) : null,
    jobUrl: job.url ?? url,
    applyUrl: job.url ?? url,
    searchKeywords: 'added-by-url',
    isTech,
    roleSource: `url-${provider}`,
    region,
    employmentType: kind ?? INTERN,
  }, `url-${new Date().toISOString().slice(0, 10)}`);

  log.ok(`  stored as ${jobId}`);
  added.push(jobId);
  if (FORCE) forced.push(jobId);
}

// Enrich straight away rather than leaving it for the next scheduled pass. A
// posting with no bullets renders a noindex page, and the whole point of adding
// one by hand is that it should be on the site now.
if (added.length && !NO_ENRICH && !DRY_RUN) {
  const rows = added.map((id) => store.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(id)).filter(Boolean);
  const withText = rows.filter((r) => r.description);
  if (withText.length) {
    log.info(`\nEnriching ${withText.length} posting(s) with ${cfg.enrich?.model || cfg.ollama?.model}…`);
    const results = await enrichJobs(withText, cfg);
    for (const [i, e] of results) store.saveEnrichment(withText[i].job_id, e);
    log.ok(`Enriched ${results.size}/${withText.length}.`);
  }
}

// --force outranks the enricher, and this is the line that makes that true.
//
// Without it the flag did nothing on exactly the postings it exists for. A real
// case: Amazon titles every posting "<Role>, <Team>", and
// "SDE I Intern , Amazon University Talent Acquisition" classifies non-tech
// because `talent acquisition` is a negative term and `sde` is a single word,
// which roles.js will not let outrank one. --force set is_tech to 1, then
// vetoNonTech inside the enricher read the same title and set it straight back
// to 0 — so the posting was stored, enriched, and still invisible.
if (forced.length && !DRY_RUN) {
  for (const id of forced) store.setRoleVerdict(id, true, 'manual-url');
  log.ok(`Held the engineering verdict on ${forced.length} forced posting(s).`);
}

if ((added.length || forced.length) && !NO_PUBLISH && !DRY_RUN) {
  const { count, path, changed } = await writeJobsFile(store, cfg);
  log.ok(`Published ${count} job(s) → ${path}${changed ? '' : ' (unchanged)'}`);
  log.info('Run a scan, or npm run enrich, to commit and push it to the live site.');
}

if (!added.length && !forced.length && !DRY_RUN) log.info('\nNothing new stored.');
store.close();
