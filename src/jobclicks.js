/**
 * Apply clicks per job and per employer — the number an employer is told.
 *
 * web/api/count.js keeps one hash a day (`applyjobs:<day>`), a field per job
 * page slug. This folds a run of those days into totals and names each slug
 * from the published board, so `npm run counts -- --jobs` can say "your three
 * roles drew 140 Apply clicks this week". Pure; the reader does the fetching.
 *
 * A slug the board no longer carries (the role closed or aged out) is still
 * counted, under its slug — the clicks happened, and the employer asking is
 * usually asking about exactly those roles.
 */

/** Upstash answers HGETALL as a flat [field, value, field, value…] list. */
export function hashPairs(flat) {
  const out = new Map();
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const n = Number(flat[i + 1]);
    if (Number.isFinite(n) && n > 0) out.set(String(flat[i]), n);
  }
  return out;
}

/**
 * @param {Map<string, number>[]} days  one map per day, slug → clicks
 * @param {Map<string, {company: string, title: string}>} bySlug  the live board
 * @returns {{ jobs: {slug, company, title, clicks}[], companies: {company, clicks, roles}[], total: number }}
 */
export function foldJobClicks(days, bySlug = new Map()) {
  const perJob = new Map();
  for (const day of days) {
    for (const [slug, n] of day) perJob.set(slug, (perJob.get(slug) ?? 0) + n);
  }
  const jobs = [...perJob].map(([slug, clicks]) => {
    const known = bySlug.get(slug);
    return { slug, company: known?.company ?? null, title: known?.title ?? null, clicks };
  }).sort((a, b) => b.clicks - a.clicks || a.slug.localeCompare(b.slug));

  const perCompany = new Map();
  for (const j of jobs) {
    if (!j.company) continue;
    const c = perCompany.get(j.company) ?? { company: j.company, clicks: 0, roles: 0 };
    c.clicks += j.clicks;
    c.roles += 1;
    perCompany.set(j.company, c);
  }
  const companies = [...perCompany.values()].sort((a, b) => b.clicks - a.clicks || a.company.localeCompare(b.company));
  const total = jobs.reduce((s, j) => s + j.clicks, 0);
  return { jobs, companies, total };
}
