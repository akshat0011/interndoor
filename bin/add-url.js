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
import { loadConfig } from '../src/config.js';
import { ingestUrl } from '../src/ingest.js';
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
  const r = await ingestUrl(store, cfg, url, { company: COMPANY, force: FORCE, dryRun: DRY_RUN });

  if (r.status === 'error') {
    log.warn(`  ${r.reason}`);
    if (r.hint) log.info(`  ${r.hint}`);
    continue;
  }

  log.ok(`  ${r.company} — ${r.title}`);
  if (r.locations?.length) log.info(`  ${r.locations.join(' · ')}`);

  if (r.status === 'exists') {
    if (r.forced) { log.ok(`  already stored — ${r.reason}.`); forced.push(r.jobId); }
    else log.info('  already stored — nothing to do.');
    continue;
  }

  if (r.status === 'skipped') {
    log.warn(`  ${r.reason} — pass --force to store it anyway.`);
    continue;
  }

  if (r.reason) log.warn(`  ${r.reason}.`);

  if (r.status === 'would-store') {
    log.info(`  would store as ${r.jobId} · region ${r.region}`);
    continue;
  }

  log.ok(`  stored as ${r.jobId}`);
  added.push(r.jobId);
  if (r.forced) forced.push(r.jobId);
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
