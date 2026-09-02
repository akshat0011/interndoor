#!/usr/bin/env node
/**
 * Re-judge listings the enricher called non-tech, safely.
 *
 *   npm run recheck-tech                 # report only, changes nothing
 *   npm run recheck-tech -- --apply      # promote what passes both gates
 *   npm run recheck-tech -- --region=IN --apply
 *
 * WHY THIS COULD NOT SIMPLY BE A SQL SWEEP. `is_tech = 0` used to mean two
 * different things — "the classifier said no" and "a human pulled this" — and
 * nothing distinguished them. The HARMAN row demoted because HARMAN's own apply
 * page 404s reads `role_label "Software Testing", is_tech 0, role_source
 * model-enrich`, byte-for-byte the shape of a model mistake. A label-based
 * sweep would have put listings back that point at dead application pages.
 * `suppressed_reason` exists for that, and this only ever considers rows where
 * it is NULL.
 *
 * TWO GATES, because one is not enough:
 *
 *  1. `classifyOne` — the dedicated tech classifier, one posting per call, at
 *     temperature 0, so its answer is reproducible. Measured on the eight
 *     contested rows it was right on all eight.
 *  2. THE APPLY LINK MUST NOT BE DEAD. The label test alone was measured wrong
 *     on 6 of 10 India rows, and the rows it was wrong about are exactly the
 *     ones a human had pulled.
 *
 * A 403 IS NEVER EVIDENCE A POSTING IS GONE. Checked on 2 Sep, 22 of 30 apply
 * links that a bulk fetch reported as failures were WAF bot-blocks and several
 * returned 200 in a real browser — acting on the status alone would have
 * deleted seven live Epic Games internships. So only a hard 404/410 blocks a
 * promotion; anything else is promoted and flagged as unverified.
 */
import { DatabaseSync } from 'node:sqlite';
import { PATHS } from '../src/paths.js';
import { loadConfig } from '../src/config.js';
import { classifyRole, vetoNonTech, GENERIC_POSITIVE } from '../src/roles.js';
import { classifyFromDescriptions } from '../src/ollama.js';
import { log } from '../src/logger.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const regionArg = (args.find((a) => a.startsWith('--region=')) ?? '').split('=')[1];
const DAYS = Number((args.find((a) => a.startsWith('--days=')) ?? '').split('=')[1] || 30);

const cfg = loadConfig();
const regions = regionArg ? [regionArg] : (cfg.regions?.publish ?? ['IN']);
const db = new DatabaseSync(PATHS.db);

const rows = db.prepare(`
  SELECT job_id, company, title, description, role_label, region, apply_url, job_url
  FROM jobs
  WHERE is_tech = 0
    AND suppressed_reason IS NULL
    AND role_label IS NOT NULL AND role_label <> ''
    AND first_seen_at > (strftime('%s','now','-${DAYS} days') * 1000)
`).all().filter((r) => regions.includes(r.region));

/* The same trigger enrichJobs uses: the model's own label disagrees with its
   verdict. Noisy on purpose — it only decides who gets ASKED. */
const candidates = rows.filter((r) => {
  const c = classifyRole(r.role_label, cfg);
  return c.verdict === 'tech' && !GENERIC_POSITIVE.has(c.matched)
    && vetoNonTech(r.title, r.role_label, true, cfg) !== false;
});

log.info(`${candidates.length} contested row(s) in ${regions.join('/')} over ${DAYS} days${APPLY ? '' : ' — reporting only, pass --apply to promote'}.`);
if (!candidates.length) process.exit(0);

const verdicts = await classifyFromDescriptions(
  candidates.map((r) => ({ title: r.title, company: r.company, description: r.description })), cfg);
if (!verdicts) { log.warn('No model available — nothing judged.'); process.exit(1); }

/** A hard 404/410 is the only status that blocks a promotion. */
async function linkIsDead(url) {
  if (!url) return { dead: false, note: 'no link to check' };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' },
    });
    if (res.status === 404 || res.status === 410) return { dead: true, note: `HTTP ${res.status}` };
    return { dead: false, note: res.ok ? 'HTTP 200' : `HTTP ${res.status} — not verified, a 403 is usually a bot block` };
  } catch (e) {
    return { dead: false, note: `unreachable (${e.name}) — not verified` };
  }
}

const promote = db.prepare('UPDATE jobs SET is_tech = 1 WHERE job_id = ?');
const bury = db.prepare('UPDATE jobs SET suppressed_reason = ? WHERE job_id = ?');
let promoted = 0, kept = 0, blocked = 0;

for (const [i, r] of candidates.entries()) {
  const v = verdicts.get(i);
  if (!v) { log.warn(`  no verdict for "${r.title}" (${r.company}) — left alone.`); continue; }
  if (!v.isTech) {
    kept++;
    log.info(`  non-tech confirmed · ${r.company} — ${r.title} (label "${r.role_label}", hinged on "${v.keyTerm}")`);
    continue;
  }
  const link = await linkIsDead(r.apply_url || r.job_url);
  if (link.dead) {
    blocked++;
    log.warn(`  TECH but the apply page is gone · ${r.company} — ${r.title} (${link.note})`);
    if (APPLY) bury.run(`apply page ${link.note} when re-checked`, r.job_id);
    continue;
  }
  promoted++;
  log.ok(`  PROMOTE · ${r.company} — ${r.title} (label "${r.role_label}", ${link.note})`);
  if (APPLY) promote.run(r.job_id);
}

log.info(`${promoted} to promote · ${kept} confirmed non-tech · ${blocked} tech but dead.`);
if (APPLY && promoted) log.ok('Run a publish to put them on the site.');
