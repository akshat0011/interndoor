/**
 * Approving an employer's submission from /post-a-job — what it actually does.
 *
 * web/api/post-job.js only STORES a request; nothing reaches the board until
 * this runs, by hand, from `npm run submissions -- --approve <id>`. Approval is
 * the vetting, so it is allowed to do the three things the scan would never
 * do for a stranger:
 *
 *   1. put the company on the watchlist (companies.json, group
 *      `employer-submitted`), which is what lets its rows publish at all;
 *   2. if the link names a job board we read, seed that board, so every later
 *      role is collected with no further request;
 *   3. store the role itself now — a role posted days ago is outside every
 *      search window and would otherwise never be found.
 *
 * A LinkedIn link is read off LinkedIn's PUBLIC posting page, signed out —
 * never through the scraper's Brave, which a running scan owns (§2). Its Apply
 * goes to the LinkedIn posting, as it does for every row the scan stores from
 * the public page. Any other link goes through ingestUrl, the same gauntlet
 * `npm run add-url` uses, with `force` — he has read it.
 *
 * The employer's own stated pay is written onto the row, because it is the
 * one fact the form insisted on and the posting may not repeat.
 *
 * Every dependency is injected, so the test drives it with fakes; nothing here
 * touches the network or a file on its own.
 */
import { matchCompany, normaliseCompany } from './config.js';
import { parseAtsLink } from './ats.js';
import { resolveRegion } from './regions.js';
import { INTERN, FULL_TIME } from './employment.js';
import { extractDuration, extractSkills, extractWorkplaceType, parseRelativeTime } from './extract.js';

export const GROUP = 'employer-submitted';

/** The LinkedIn job id a link names, or null. */
export function linkedinJobId(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  const path = u.pathname.match(/^\/jobs\/view\/(?:[^/]*?-)?(\d{6,})\/?$/);
  if (path) return path[1];
  const q = u.searchParams.get('currentJobId');
  return q && /^\d{6,}$/.test(q) ? q : null;
}

/** "₹25,000/month" — the same shape the store's other INR rows carry. */
export function payText(pay, period) {
  return `₹${Number(pay).toLocaleString('en-IN')}/${period}`;
}

/**
 * Add a company to the parsed companies.json, in place. Returns whether it was
 * added. Already matched by any watchlist term → untouched, so approving a
 * second role from the same employer never adds a duplicate entry.
 */
export function addToWatchlist(companiesFile, company, watchlist) {
  if (matchCompany(company, watchlist)) return false;
  if (!Array.isArray(companiesFile[GROUP])) companiesFile[GROUP] = [];
  companiesFile[GROUP].push(company);
  return true;
}

/**
 * @returns {Promise<{watchlist: 'added'|'already', board: string|null,
 *   role: {status: string, jobId?: string, reason?: string}}>}
 */
export async function approveSubmission(entry, {
  store, cfg, companiesFile, fetchPosting, ingest, now = Date.now(),
}) {
  const company = entry.company;
  const added = addToWatchlist(companiesFile, company, cfg.watchlist);

  let board = null;
  const ats = parseAtsLink(entry.link);
  if (ats) {
    const existing = store.getAts(company);
    if (!existing?.provider) {
      store.saveAts(company, ats.provider, ats.token, 0);
      board = `${ats.provider}/${ats.token}`;
    } else {
      board = `${existing.provider}/${existing.token} (already known)`;
    }
  }

  const pay = { min: entry.pay, max: entry.pay, currency: 'INR', period: entry.period };
  const salaryText = payText(entry.pay, entry.period);
  const kind = entry.kind === FULL_TIME ? FULL_TIME : INTERN;

  let role;
  const liId = linkedinJobId(entry.link);
  if (liId) {
    if (store.hasJob(liId)) {
      role = { status: 'exists', jobId: liId };
    } else {
      const got = await fetchPosting(liId);
      if (got?.gone) role = { status: 'error', reason: 'that LinkedIn posting is closed or taken down' };
      else if (!got?.detail) role = { status: 'error', reason: 'could not read the LinkedIn posting just now — approve again later' };
      else {
        const d = got.detail;
        store.upsertJob({
          jobId: liId,
          title: d.title,
          company,
          /* The list's own display name where the employer was already on it;
             a newly added one is filed under the name just added. */
          companyMatched: matchCompany(company, cfg.watchlist) ?? company,
          location: d.location,
          workplaceType: extractWorkplaceType(d.location),
          postedAt: parseRelativeTime(d.postedText, now) ?? now,
          postedText: null,
          salaryText,
          stipend: pay,
          duration: extractDuration(d.description, d.title),
          skills: extractSkills(d.description),
          description: d.description || null,
          summary: null,
          applicants: d.applicants ?? null,
          jobUrl: `https://www.linkedin.com/jobs/view/${liId}/`,
          applyUrl: `https://www.linkedin.com/jobs/view/${liId}/`,
          logoUrl: d.logoUrl || null,
          searchKeywords: 'employer-submitted',
          isTech: true,
          roleSource: 'employer-submitted',
          region: resolveRegion(d.location, {}),
          employmentType: kind,
        }, `employer-${new Date(now).toISOString().slice(0, 10)}`);
        role = { status: 'stored', jobId: liId, title: d.title };
      }
    }
  } else {
    const r = await ingest(entry.link, { company, force: true, source: 'employer' });
    role = { status: r.status, jobId: r.jobId, title: r.title, reason: r.reason };
    /* The form's pay is the employer's own statement; the posting text may
       not carry it, and extractStipend would then leave the row unpaid. Only
       on a row this approval just stored — never over an existing row. */
    if (r.status === 'stored' && r.jobId) {
      store.db.prepare(`UPDATE jobs SET salary_text = ?, stipend_min = ?, stipend_max = ?,
        stipend_currency = 'INR', stipend_period = ?, employment_type = ? WHERE job_id = ?`)
        .run(salaryText, entry.pay, entry.pay, entry.period, kind, r.jobId);
    }
  }

  return { watchlist: added ? 'added' : 'already', board, role, normalised: normaliseCompany(company) };
}
