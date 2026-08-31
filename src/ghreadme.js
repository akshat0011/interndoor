/**
 * The README for the public GitHub internship list.
 *
 * WHY THIS EXISTS. Engineering students live on GitHub, and a repo of live
 * internships is how a large share of American CS students actually find one —
 * SimplifyJobs/Summer2026-Internships has tens of thousands of stars. There is
 * no Indian equivalent, and we already hold the data and the pipeline. The repo
 * earns a real dofollow backlink, reaches exactly the audience the board is
 * for, and compounds through stars rather than through spend.
 *
 * IT TAKES PUBLISHED ROWS, NOT STORE ROWS. Same rule as the reel pipeline, the
 * Telegram channel and the OG cards: the published projection has already been
 * through every cleaning rule the site uses, so this cannot state something the
 * job page does not. It is also the shape that carries `id` — a store row has
 * `job_id` and would have produced the `.../jobs/harman-india-intern-role` 404s
 * the WhatsApp channel sent for a day.
 *
 * THE OUTPUT IS DETERMINISTIC, and that is the design constraint, not a nicety.
 * No relative ages and no clock: dates are day-granular in the region's own
 * zone. This repo's history is public, and a README regenerated on every
 * publish would be 48 commits a day of noise — the churn that put ~9,900
 * pointless page rewrites and ~13,000 spurious IndexNow submissions through
 * this project on 30 Aug. Rendered twice from unchanged data this is
 * byte-identical, so a commit means the board actually changed.
 */
import { SITE, jobSlug, companySlug, stipendText, modeText } from './pages.js';
import { cityOf } from './postgen.js';
import { regionOf, regionPath } from './regions.js';

/** A markdown table cell cannot carry a raw pipe or a newline. */
export const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/** Our own links carry the tag; nobody else's ever does. */
const tag = (url) => `${url}${url.includes('?') ? '&' : '?'}utm_source=github&utm_medium=readme`;

export function renderReadme(jobs, code = 'IN') {
  const region = regionOf(code);
  if (!region) throw new Error(`renderReadme: unknown region ${code}`);
  const prefix = regionPath(region.code);

  /** "31 Aug 2026" — day granularity, in the region's zone, so it is stable. */
  const day = (ms) => (ms
    ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: region.timeZone })
    : '');

  // Newest first, then by id — equal timestamps must not reorder between runs.
  const rows = jobs.slice().sort((a, b) =>
    (b.postedAt ?? b.firstSeenAt ?? 0) - (a.postedAt ?? a.firstSeenAt ?? 0)
    || String(a.id).localeCompare(String(b.id)));

  const companies = new Set(rows.map((j) => j.company).filter(Boolean));
  const withPay = rows.filter((j) => stipendText(j)).length;
  const board = tag(`${SITE}${prefix}/`);

  const line = (j) => {
    const hub = tag(`${SITE}${prefix}/companies/${companySlug(j.company)}`);
    const page = tag(`${SITE}${prefix}/jobs/${jobSlug(j)}`);
    const apply = j.applyUrl || j.url || page;
    /* cardFacts is a DISPLAY list and its first entry is not reliably the city:
       on a row that states pay it is the stipend, which rendered
       "₹8,000 / total · On-site" into the location column. cityOf reads the
       location itself. */
    const where = [cityOf(j.location), modeText(j)].filter(Boolean).join(' · ');
    /* THE STIPEND IS INLINE, NOT A COLUMN. Only 21 of 250 India postings state
       one, so a column would be 229 em-dashes — and this project's own board
       redesign found that a mostly-empty column teaches the eye to skip the
       row. As a suffix it reads as a highlight on the few that disclose. */
    const pay = stipendText(j);
    const role = `[${cell(j.title)}](${page})${pay ? ` — **${cell(pay)}**` : ''}`;
    return `| [${cell(j.company)}](${hub}) | ${role} | ${cell(where)} | ${day(j.postedAt ?? j.firstSeenAt)} | [Apply](${apply}) |`;
  };

  return `# ${region.name} — Engineering Internships, Updated Daily

**${rows.length} live internships** from **${companies.size} companies**, collected automatically
and checked every 30 minutes. Every listing links back to the original posting.

> ⭐ **Star this repo** to keep it in your GitHub feed — new roles land at the top of the table.

### Why this list is different

Most internship lists are either stale or unfiltered. This one is neither:

- **Fast.** A role usually appears here within an hour of going live.
- **Filtered.** A posting is only kept if the employer is on a manually maintained
  list of real companies. Roughly **60 listings are turned away for every one
  published** — this market is full of unpaid "certificate" schemes, and keeping
  them out is most of the work.
- **Engineering only.** Software, data, hardware, security. No sales roles dressed
  up as tech.

**Only ${withPay} of these ${rows.length} postings say what they pay.** That is not an omission here —
it is what the employers wrote. Where a stipend was stated, it is on the row.

## Live roles

| Company | Role | Location | Posted | |
| --- | --- | --- | --- | --- |
${rows.map(line).join('\n')}

## How this is built

A scraper reads public job boards and companies' own careers pages every 30
minutes, classifies each posting, and drops anything from an employer not on the
vetted list. What survives is published to [interndoor.com](${board}) and mirrored
here.

Roles are removed once they are 30 days old, so this is what is currently open
rather than an archive.

## Get new roles as they land

- 🌐 **Full board, with search and filters:** [interndoor.com](${board})
- 📬 **Email alerts:** [interndoor.com/alerts](${tag(`${SITE}${prefix}/alerts`)})

## Contributing

Spotted a role that should be here, or one that should not? Open an issue. If an
employer on this list is not paying its interns, please say so — that is exactly
what the vetted list is meant to catch, and it is easier to catch with help.

## Disclaimer

Listings link to the employer's own posting, which is the source of truth. Confirm
the details there before applying. Provided as-is.
`;
}
