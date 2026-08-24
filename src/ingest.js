/**
 * One posting, from a URL into the store, through the same gates the pollers use.
 *
 * Extracted from bin/add-url.js when a second caller appeared —
 * bin/discover-urls.js, which finds URLs with a search API instead of being
 * handed them. The gauntlet has to be identical for both: a posting found by a
 * search and the same posting pasted by hand must be judged the same way, or
 * the site's contents depend on how a row happened to arrive.
 *
 * It REPORTS rather than skips silently. A URL that reached here was chosen —
 * by him, or by a query he wrote — so the caller is told which gate refused it
 * and why, and can overrule with `force`.
 */
import { matchCompany, matchTitle } from './config.js';
import { resolveJobUrl } from './joburl.js';
import { classifyRole } from './roles.js';
import { employmentType, INTERN } from './employment.js';
import { resolveRegion, UNKNOWN, publishedRegions } from './regions.js';
import { extractStipend, extractDuration, extractSkills, extractWorkplaceType } from './extract.js';
import { summarize } from './summarize.js';

/**
 * @returns {Promise<{status: 'error'|'exists'|'skipped'|'stored'|'would-store',
 *                    reason?: string, hint?: string, jobId?: string,
 *                    title?: string, company?: string, region?: string,
 *                    locations?: string[], forced?: boolean}>}
 */
export async function ingestUrl(store, cfg, url, { company: override = null, force = false, dryRun = false, source = 'url' } = {}) {
  const found = await resolveJobUrl(url, { company: override });
  if (found?.error) return { status: 'error', reason: found.error, hint: found.hint };

  const { provider, token, job } = found;
  // A URL carries the board TOKEN, which is the company name lower-cased and
  // mangled. Prefer the real name the discovery pass already recorded against
  // that token, then the watchlist's spelling, and only then the token itself.
  const company = override
    || store.companyForBoard(provider, token)
    || matchCompany(found.company, cfg.watchlist)
    || found.company;

  const jobId = `ats:${provider}:${token}:${job.id}`;
  const locations = [job.location, ...(job.locationAlt ?? [])].filter(Boolean);
  const base = { jobId, title: job.title, company, locations };

  if (store.hasJob(jobId)) {
    if (force) {
      if (!dryRun) store.setRoleVerdict(jobId, true, 'manual-url');
      return { ...base, status: 'exists', forced: true, reason: 're-asserted the engineering verdict' };
    }
    return { ...base, status: 'exists' };
  }

  // Internship, or a full-time role aimed at the same people. Both are kept and
  // LABELLED; neither is guessed at.
  const kind = employmentType(job.title, (t) => matchTitle(t, cfg.titleTerms));
  if (!kind && !force) {
    return { ...base, status: 'skipped', reason: 'the title names neither an internship nor an early-career role' };
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
  if (verdict.verdict === 'non-tech' && !force) {
    return { ...base, region, status: 'skipped', reason: `classified non-engineering (${verdict.matched ?? 'no positive term'})` };
  }
  const isTech = verdict.verdict === 'tech' ? true : force ? true : null;

  // Say plainly whether this will actually appear, rather than storing it and
  // leaving the caller to wonder why the site never shows it.
  const live = publishedRegions(cfg).map((r) => r.code);
  const note = region === UNKNOWN
    ? 'the location could not be placed — stored and never published; add it to src/regions.js'
    : !live.includes(region)
      ? `${region} is collected but not published — it will appear if ${region} is switched on`
      : null;

  if (dryRun) return { ...base, region, status: 'would-store', reason: note ?? undefined, forced: force };

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
    searchKeywords: `added-by-${source}`,
    isTech,
    roleSource: `${source}-${provider}`,
    region,
    employmentType: kind ?? INTERN,
  }, `${source}-${new Date().toISOString().slice(0, 10)}`);

  return { ...base, region, status: 'stored', reason: note ?? undefined, forced: force };
}
