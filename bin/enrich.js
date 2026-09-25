#!/usr/bin/env node
/**
 * Backfill Gemini enrichment over postings already in the store, then republish.
 *
 * Split out from the scrape run on purpose. The scraper is the fragile part —
 * it drives a real browser against LinkedIn — and enrichment is a pure
 * description-in, JSON-out pass over rows that are already captured. Keeping
 * them apart means a spent Gemini quota never costs a scrape, and re-running
 * this after a prompt change costs nothing but API calls.
 *
 * Only rows with bullets IS NULL are sent, so repeated runs are cheap and
 * resumable: interrupt it, run it again, and it picks up where it stopped.
 *
 *   node bin/enrich.js [--limit N] [--dry-run] [--all] [--facts] [--minutes N]
 *
 * --facts reads the application deadline and the experience requirement
 * (extractFacts) for live enriched rows that have not had them read — the
 * backfill; a scan does the same for new rows at its end. Leaves bullets and
 * summary alone. Resumable the same way: a row it has looked at is marked
 * (facts_checked_at) whether or not it found anything.
 * --minutes overrides enrich.budgetMinutes for this run.
 */
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { enrichJobs, extractFacts } from '../src/ollama.js';
import { writeJobsFile } from '../src/publish.js';
import { log } from '../src/logger.js';
import { publishedRegions } from '../src/regions.js';

const ROOT = join(import.meta.dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
}

async function main() {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    // No .env is fine as long as GEMINI_API_KEY is already exported.
  }

  const cfg = loadConfig();
  const store = new Store();
  const limit = Number(arg('--limit', 500));
  const dryRun = process.argv.includes('--dry-run');
  const all = process.argv.includes('--all');
  if (arg('--minutes')) cfg.enrich = { ...cfg.enrich, budgetMinutes: Number(arg('--minutes')) };

  if (process.argv.includes('--facts')) {
    await backfillFacts(store, cfg, { limit, dryRun });
    store.close();
    return;
  }

  if (all) {
    const n = store.db.prepare('UPDATE jobs SET bullets = NULL').run().changes;
    log.info(`--all: cleared enrichment on ${n} row(s); every posting will be re-sent.`);
  }

  const pending = store.needingEnrichment(limit, publishedRegions(cfg).map((r) => r.code));
  if (!pending.length) {
    log.ok('Nothing to enrich — every posting with a description already has bullets.');
    store.close();
    return;
  }

  // Report the model actually used. This line had its own hardcoded fallback,
  // so it kept printing gemini-2.5-flash after the config moved off it — which
  // sent the whole investigation after the wrong model.
  log.info(`Enriching ${pending.length} posting(s) with ${process.env.GEMINI_MODEL || cfg.enrich?.model || 'gemini-2.5-flash'}…`);

  const results = await enrichJobs(pending, cfg);
  if (!results.size) {
    log.warn('Gemini returned nothing usable — the store is unchanged.');
    store.close();
    return;
  }

  let flipped = 0;
  for (const [i, e] of results) {
    const row = pending[i];
    if (!row) continue;
    if (dryRun) {
      console.log(`\n${row.title} — ${row.company}`);
      console.log(`  degree: ${e.degreeLevel || '—'} ${e.degreeText || ''}`.trimEnd());
      console.log(`  skills: ${e.keySkills.join(', ') || '—'}`);
      console.log(`  stipend: ${e.stipendStatus}`);
      console.log(`  isTech: ${e.isTech}`);
      e.bullets.forEach((b) => console.log(`   • ${b}`));
      continue;
    }
    const before = store.db.prepare('SELECT is_tech FROM jobs WHERE job_id = ?').get(row.job_id)?.is_tech;
    store.saveEnrichment(row.job_id, e);
    if (typeof e.isTech === 'boolean' && before != null && !!before !== e.isTech) flipped++;
  }

  log.ok(`Enriched ${results.size}/${pending.length} posting(s)${flipped ? ` · ${flipped} changed tech verdict` : ''}.`);

  if (!dryRun) {
    const { count, path, changed } = await writeJobsFile(store, cfg);
    log.ok(`Published ${count} job(s) → ${path}${changed ? '' : ' (unchanged)'}`);
  }

  store.close();
}

async function backfillFacts(store, cfg, { limit, dryRun }) {
  const maxAgeDays = cfg.publish?.maxAgeDays ?? 14;
  const pendingFacts = (n) => store.needingFacts(n, publishedRegions(cfg).map((r) => r.code), Date.now() - maxAgeDays * 86_400_000);
  const budgetMs = (cfg.enrich?.budgetMinutes ?? 9) * 60_000;
  const started = Date.now();
  let checked = 0;
  let deadlines = 0;
  let experience = 0;

  /* In batches, each saved before the next is read, so a backfill that is
     interrupted — it runs for hours — keeps everything it has already read.
     A dry run saves nothing, so it would re-read one batch forever: one pass. */
  while (checked < limit && Date.now() - started < budgetMs) {
    const pending = pendingFacts(dryRun ? limit : Math.min(40, limit - checked));
    if (!pending.length) break;
    const minutesLeft = (budgetMs - (Date.now() - started)) / 60_000;
    const results = await extractFacts(pending, { ...cfg, enrich: { ...cfg.enrich, budgetMinutes: minutesLeft } });
    for (const [i, f] of results) {
      const row = pending[i];
      if (f.deadline) deadlines++;
      if (f.experience) experience++;
      if (dryRun) {
        if (f.deadline || f.experience) console.log(`${row.title} — ${row.company}\n  apply by: ${f.deadline || '—'} · experience: ${f.experience || '—'}`);
      } else store.saveFacts(row.job_id, f);
    }
    checked += results.size;
    if (dryRun || !results.size) break;
    log.info(`  ${checked} checked · ${deadlines} deadline(s) · ${experience} experience requirement(s) so far`);
  }

  if (!checked) {
    log.ok('Nothing to read — every live posting has had its deadline and experience checked.');
    return;
  }
  log.ok(`Checked ${checked}: ${deadlines} stated a deadline, ${experience} an experience requirement.`);
  if (!dryRun) {
    const { count, path, changed } = await writeJobsFile(store, cfg);
    log.ok(`Published ${count} job(s) → ${path}${changed ? '' : ' (unchanged)'}`);
  }
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
});
