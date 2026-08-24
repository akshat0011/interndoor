#!/usr/bin/env node
/**
 * Find postings their own employer does not index, by asking a search engine.
 *
 *   node bin/discover-urls.js              # only if today's sweep is not done
 *   node bin/discover-urls.js --force      # sweep now
 *   node bin/discover-urls.js --dry-run    # print the queries and what they find
 *
 * Amazon's SDE internship for India is live at a URL Amazon's own search will
 * not return — see src/joburl.js for the measurements. The page is public and
 * allowed by robots.txt, so a search engine has it even though the employer's
 * board does not. This asks a handful of questions a day and hands whatever
 * looks like a posting to the same gates bin/poll-ats.js uses.
 *
 * ONCE A DAY, not once a scan. Google's free tier is 100 queries a day and
 * bin/run.sh fires 48 times; a per-scan sweep would spend the quota by lunch
 * for no extra freshness, because the searches are date-restricted anyway.
 */
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/logger.js';
import { search, searchConfigured, MAX_PER_QUERY } from '../src/websearch.js';
import { ingestUrl } from '../src/ingest.js';
import { enrichJobs } from '../src/ollama.js';
import { writeJobsFile } from '../src/publish.js';

const ROOT = join(import.meta.dirname, '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* optional */ }

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const NO_PUBLISH = process.argv.includes('--no-publish');

const SETTING = 'discoverySweepDay';

const cfg = loadConfig();
const conf = cfg.discovery ?? {};
const store = new Store();

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

if (conf.enabled === false) { store.close(); process.exit(0); }
if (!FORCE && !DRY_RUN && store.getSetting(SETTING) === today) { store.close(); process.exit(0); }
if (!searchConfigured() && !DRY_RUN) {
  // The NOTICE is throttled to once a day; the SWEEP is not marked done.
  //
  // Those have to be separate settings. Marking the sweep done here would mean
  // adding the key at noon buys nothing until tomorrow — the day is already
  // recorded as swept, and nothing swept. Same trap as --force consuming the
  // weekly roundup's slot. Throttling only the log keeps the scheduler quiet
  // (48 identical warnings a day is a log nobody reads) while leaving the real
  // sweep outstanding, so the first scan after a key is added does the work.
  if (store.getSetting('discoveryNoKeyNoticeDay') !== today) {
    log.info('Web discovery is on but GOOGLE_CSE_KEY / GOOGLE_CSE_CX are not set — skipping. See the header of src/websearch.js for the one-time setup.');
    store.setSetting('discoveryNoKeyNoticeDay', today);
  }
  store.close();
  process.exit(0);
}

/**
 * The searches. Each is one API call, so the list IS the daily budget.
 *
 * Deliberately narrow: a site plus a phrase a real posting would contain. A
 * broad query returns careers landing pages, "life at" articles and PDFs, and
 * every one of those costs a fetch to find out it is not a posting.
 */
const queries = [];
for (const site of conf.sites ?? []) {
  for (const q of conf.queries ?? []) queries.push({ site, q });
}

if (!queries.length) {
  log.warn('Nothing to search — set discovery.sites and discovery.queries in config.json.');
  store.close();
  process.exit(0);
}

log.info(`Web discovery: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}, ${conf.dateRestrict ?? 'd7'} window.`);

const links = new Map();
for (const spec of queries) {
  if (DRY_RUN && !searchConfigured()) {
    log.info(`  would ask: site:${spec.site} ${spec.q}`);
    continue;
  }
  const hits = await search({ ...spec, dateRestrict: conf.dateRestrict ?? 'd7', num: MAX_PER_QUERY });
  log.info(`  site:${spec.site} ${spec.q} → ${hits.length} result(s)`);
  for (const h of hits) if (!links.has(h.link)) links.set(h.link, h);
}

// Never re-fetch a URL we have already judged. The searches are date-restricted
// so the same pages come back for days, and each one costs a request to
// somebody else's careers site to learn what we already decided.
const fresh = [...links.keys()].filter((u) => !store.seenDiscovered(u));
log.info(`${links.size} distinct link(s), ${fresh.length} not seen before.`);

const cap = conf.maxPerRun ?? 20;
if (fresh.length > cap) log.warn(`Only the first ${cap} will be resolved this run; the rest are left for tomorrow.`);

const stored = [];
for (const url of fresh.slice(0, cap)) {
  const r = await ingestUrl(store, cfg, url, { dryRun: DRY_RUN, source: 'search' });

  if (r.status === 'stored') {
    log.ok(`  + ${r.company} — ${r.title}${r.reason ? ` (${r.reason})` : ''}`);
    stored.push(r.jobId);
  } else if (r.status === 'would-store') {
    log.ok(`  would store: ${r.company} — ${r.title}`);
  } else {
    log.debug(`  − ${r.reason ?? r.status}: ${url}`);
  }

  if (!DRY_RUN) store.noteDiscovered(url, r.status, r.jobId ?? null);
}

// Enrich immediately: a posting with no bullets renders a noindex page, and one
// found today is worth having on the site today.
if (stored.length && !DRY_RUN) {
  const rows = stored.map((id) => store.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(id))
    .filter((r) => r?.description);
  if (rows.length) {
    const results = await enrichJobs(rows, cfg);
    for (const [i, e] of results) store.saveEnrichment(rows[i].job_id, e);
    log.ok(`Enriched ${results.size}/${rows.length}.`);
  }
  if (!NO_PUBLISH) {
    const { count, path } = await writeJobsFile(store, cfg);
    log.ok(`Published ${count} job(s) → ${path}`);
  }
}

if (!DRY_RUN) store.setSetting(SETTING, today);
log.ok(`Web discovery done: ${stored.length} new posting(s). Lifetime: ${JSON.stringify(store.discoveryStats())}`);
store.close();
