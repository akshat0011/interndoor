/**
 * Static HTML pages, one per job and one per company, generated at publish time.
 *
 * Why this exists: the main page is an empty <ol> that JavaScript fills from
 * jobs.json, so a crawler that does not run JavaScript sees zero listings. The
 * site is therefore invisible to search — the only traffic it can ever get is
 * links someone shares by hand. These pages are the fix: real HTML, present in
 * the response body, one URL per posting.
 *
 * Two rules shape everything here, and both are about not getting the site
 * penalised rather than about ranking:
 *
 * 1. NEVER republish the employer's description. It is their copyrighted text,
 *    and a page whose body is someone else's posting is precisely what Google's
 *    scraped-content policy is written to demote. Every page is built from our
 *    own material: the bullets, the eligibility read, the skills, the freshness.
 *
 * 2. A page with nothing to say is not published as indexable. A posting whose
 *    employer used a template, or whose description was never captured, has no
 *    bullets and gets noindex — a site carrying dozens of near-empty pages looks
 *    like a content farm, and that judgement is applied site-wide, not page by
 *    page.
 */
import { writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { regionOf, regionPath, ALL_REGIONS } from './regions.js';
import { schemaEmploymentType } from './employment.js';
import { facetGroups, facetSlug } from './facets.js';

export const SITE = 'https://interndoor.com';

/**
 * Every page is rendered FOR a region, and India is the default.
 *
 * India is served at the site root and every other region under `/<slug>/`.
 * That asymmetry is deliberate and permanent: ~130 job pages and 125 company
 * hubs are already indexed at `/jobs/…` and `/companies/…`, and moving them
 * under `/in/` to make the scheme symmetrical would 404 every one at once.
 * `regionPath` returns '' for India, so every link below concatenates safely.
 */
export const DEFAULT_REGION = regionOf('IN');

/**
 * `web/vercel.json` sets `trailingSlash: false` and `cleanUrls: true`, so the
 * form Vercel actually SERVES never carries a trailing slash: `/companies/`
 * 308s to `/companies` and `/us/` 308s to `/us`. Emitting the slashed form put
 * a redirect in the sitemap, in the canonical, in the breadcrumb JSON-LD and in
 * every hreflang alternate at once — and Google files a redirecting sitemap URL
 * as "Page with redirect", which it does not index. That cost the three company
 * directories and the US and UK board homepages, and the directory is the only
 * crawl path to the hubs (the homepage list is built by JavaScript).
 *
 * Normalised in the two builders every URL goes through, not at each call site:
 * a call site that forgets is a redirect nobody notices. The length guard is
 * what keeps India correct — `regionPath('IN')` is '', so its root is a bare
 * '/' and must stay one.
 */
function trimSlash(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Absolute URL for a path within a region: base('/jobs/x', US) -> '/us/jobs/x'. */
function regionUrl(path, region) {
  return `${SITE}${trimSlash(`${regionPath(region.code)}${path}`)}`;
}

/** Root-relative href within a region, for links inside a page. */
function regionHref(path, region) {
  return trimSlash(`${regionPath(region.code)}${path}`) || '/';
}

/** HTML-escape. Company names and titles come from LinkedIn and are not trusted. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * An href we are willing to put in front of a reader.
 *
 * Escaping alone is not enough here: `javascript:` survives HTML-escaping intact,
 * and the apply URL is whatever the posting carried. Only http(s) links out.
 */
function safeUrl(url) {
  const raw = String(url ?? '').trim();
  return /^https?:\/\//i.test(raw) ? esc(raw) : '';
}

/**
 * Where the Apply button actually goes.
 *
 * The label used to say "Apply on LinkedIn" unconditionally, which was already
 * wrong for every ATS listing — those carry a real Greenhouse or Lever URL — and
 * became wrong for LinkedIn listings too once the redesign started exposing the
 * employer's own application page behind its /safety/go/ interstitial. Telling
 * somebody they are going to LinkedIn and then sending them to Workday is a
 * small lie that costs trust on the one click that matters.
 */
function applyTarget(url) {
  const host = (String(url ?? '').match(/^https?:\/\/([^/?#]+)/i) || [])[1] ?? '';
  return /(^|\.)linkedin\.com$/i.test(host) ? 'LinkedIn' : "the company's site";
}

/** Escape for embedding inside a <script type="application/ld+json"> block. */
function jsonLd(obj) {
  // </script> inside a JSON string would close the tag early; U+2028/9 break older parsers.
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function slugify(s, max = 70) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'role';
}

/**
 * A URL a human can read and a search engine can parse: company, role, then id.
 *
 * The id is slugified too. An ATS id is `ats:greenhouse:token:12345`, and the
 * colons went straight into the filename — which git cannot check out on
 * Windows at all, so cloning this public repo failed there. A LinkedIn id is
 * digits only, so its URLs are unchanged by this.
 *
 * The id is NOT length-capped, though the company and title are. The longest id
 * in the database is a 66-character Workday one — four short of the cap — and
 * two requisitions from a single tenant differ only in their last few
 * characters, so capping the id would eventually collide two live postings onto
 * one page and silently drop one of them.
 */
export function jobSlug(job) {
  /* THE ID IS REQUIRED, AND A MISSING ONE THROWS RATHER THAN DEGRADING.
     slugify falls back to 'role' on empty input — right for a company or a
     title, catastrophic for the id, because it turns a missing field into a
     URL that LOOKS correct and 404s. That is exactly what happened: the
     WhatsApp broadcaster passed store rows, where the column is `job_id` and
     `id` is undefined, so every link it sent read
     `.../jobs/harman-india-intern-role` instead of `...-4458884978`. Both the
     preview card and the link were dead, and nothing anywhere said so — the
     message composed fine, sent fine, and looked right.
     A caller with no id has nothing to link to, so there is no sensible URL to
     return and refusing is the only honest answer. */
  const id = job?.id ?? job?.job_id;
  if (id === undefined || id === null || String(id).trim() === '') {
    throw new Error(`jobSlug: no id for ${JSON.stringify(job?.company ?? '')} — ${JSON.stringify(job?.title ?? '')}`);
  }
  return `${slugify(job.company)}-${slugify(job.title)}-${slugify(id, Infinity)}`;
}

export function companySlug(company) {
  return slugify(company);
}

/**
 * "Aug 2026" — the granularity a closed listing deserves.
 *
 * Deliberately not a day or a relative age: a past role is context about what an
 * employer hires for, not a live signal, and printing "2 days ago" beside a
 * posting nobody can apply to reads as though it were still open.
 */
export function monthLabel(ms, region = DEFAULT_REGION) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: region.timeZone });
}

/**
 * When Google should consider this posting closed.
 *
 * Getting this wrong is the expensive kind of wrong: serving a JobPosting whose
 * validThrough has passed, or keeping a closed role live, is what earns a
 * structured-data manual action across the whole domain.
 *
 * THE WINDOW IS THE PUBLISH WINDOW AND IS PASSED IN, never a constant of its
 * own. A LinkedIn row ages out `validDays` after we first saw it, which is
 * exactly when publish stops writing its page — so the page and the date it
 * claims to expire on disappear together.
 *
 * That invariant was hardcoded as 14 in BOTH places until 24 Aug, when
 * `publish.maxAgeDays` was raised 14 -> 30 and this was left behind. For the
 * following sixteen days of its life every LinkedIn page then served markup
 * saying it had already expired, while staying indexable and in the sitemap;
 * 99 pages were in that state when it was found. Taking the window from the
 * caller is what stops the two drifting again.
 *
 * An ATS row is different — it stays on the site while it is still ON the
 * employer's board, so its validThrough has to move with it. Anchoring to
 * `lastSeenAt` does that: every poll that still finds the role pushes the date
 * out, and the moment the company removes it the date stops moving and expires
 * on its own, a couple of days after the row leaves the site.
 */
const DEFAULT_VALID_DAYS = 30;

/* ROUNDED TO THE END OF ITS DAY, AND UP RATHER THAN DOWN.
 *
 * An ATS row is anchored to `lastSeenAt`, which the poller refreshes every 30
 * minutes, so at millisecond precision this date moved on EVERY publish — and
 * with it the JSON-LD of every ATS job page. Measured on a real publish commit:
 * 206 of 217 changed job pages differed by nothing except this timestamp and
 * the "checked" line below, 48 times a day, into a public repo and out to
 * IndexNow as ~13,000 daily announcements of pages that had not changed.
 *
 * CEIL, NEVER FLOOR. Flooring would pull the date up to 24h EARLIER than the
 * moment the page actually stops being served, which is the 27 Aug bug exactly:
 * a served page whose validThrough has passed is what earns a structured-data
 * manual action across the whole domain. Rounding up can only ever extend the
 * claim, and a page that 404s before its stated expiry costs nothing — Google
 * penalises serving past validThrough, not removing a page early. */
function endOfUtcDay(ms) {
  const d = new Date(ms);
  d.setUTCHours(23, 59, 59, 0);
  return d.toISOString();
}

function validThrough(job, validDays = DEFAULT_VALID_DAYS) {
  const firstSeenBasis = (job.postedAt ?? job.firstSeenAt ?? Date.now()) + validDays * 86_400_000;
  const stillListed = job.lastSeenAt ? job.lastSeenAt + validDays * 86_400_000 : 0;
  return endOfUtcDay(Math.max(firstSeenBasis, stillListed));
}

/**
 * The three facts an Open Graph card carries, in priority order.
 *
 * HERE, AND NOWHERE ELSE. The card is now rendered on request by an edge
 * function in web/api/og.js, which cannot import this module — and the filters
 * it needs are not one-liners: stipendText alone refuses a figure with no
 * currency or period, refuses a zero bound anywhere ("$0 – $1,000 / hour" is a
 * real row), and regroups Indian digit grouping. Restating them over there
 * would drift on the first correction to either. So publish bakes the ANSWER
 * into jobs.json and the function reads it.
 */
export function cardFacts(job) {
  const city = String(job.location ?? '').split(',')[0].trim();
  return [stipendText(job), city, modeText(job), durationText(job)]
    .filter(Boolean).slice(0, 3);
}

/**
 * The file a posting's own Open Graph card is written to.
 *
 * Used by src/ogcard.js, which draws Telegram's copies. A job id can contain a
 * colon (`ats:greenhouse:x:1`), which is illegal in a Windows checkout and ugly
 * in a filename. The WEBSITE no longer writes these files at all — its cards
 * are generated on request by web/api/og.js.
 */
export function ogCardName(id) {
  return `${String(id).replace(/[^A-Za-z0-9_-]/g, '-')}.jpg`;
}

/** Enough substance to deserve a place in the index. */
export function isIndexable(job) {
  return (job.bullets ?? []).length >= 2;
}

/**
 * Google's JobPosting schema. Getting this wrong is worse than omitting it — a
 * structured-data manual action affects the whole domain — so every field here is
 * one we actually hold, and nothing is invented to fill a slot.
 */
function jobPostingLd(job, url, region = DEFAULT_REGION, validDays = DEFAULT_VALID_DAYS) {
  const description = `<p>${esc(job.roleLabel || job.title)}</p><ul>${
    (job.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join('')
  }</ul>`;

  const ld = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: job.title,
    description,
    identifier: { '@type': 'PropertyValue', name: job.company, value: String(job.id) },
    datePosted: new Date(job.postedAt ?? job.firstSeenAt ?? Date.now()).toISOString(),
    validThrough: validThrough(job, validDays),
    // Read by Google. A full-time graduate role marked INTERN is not a
    // cosmetic error — wrong structured data risks a manual action across the
    // whole domain, which is the risk this function is written around.
    employmentType: schemaEmploymentType(job.employmentType),
    hiringOrganization: { '@type': 'Organization', name: job.company },
    // We are not the apply destination — LinkedIn is. Saying otherwise is the
    // single most common way sites earn a JobPosting penalty.
    directApply: false,
    url,
  };

  if (job.location) {
    ld.jobLocation = {
      '@type': 'Place',
      // The region's ISO code, never a constant. Emitting addressCountry: 'IN'
      // for a role in Chicago is not a cosmetic error — Google Jobs reads this
      // field, and wrong structured data risks a manual action across the whole
      // domain, which is the single risk this function is written around.
      address: { '@type': 'PostalAddress', addressLocality: job.location, addressCountry: region.code },
    };
  }
  if (job.workplaceType === 'Remote') {
    ld.jobLocationType = 'TELECOMMUTE';
    // Required alongside TELECOMMUTE. Without it Google cannot tell who may
    // apply, and every remote page was flagged incomplete — six of them.
    ld.applicantLocationRequirements = { '@type': 'Country', name: region.name };
  }
  if (job.logo) ld.hiringOrganization.logo = `${SITE}${job.logo}`;

  // jobLocation is required unless the role is remote. A posting that has
  // neither cannot make a valid JobPosting, and an invalid one is worse than
  // none — the risk this whole function is written around is a structured-data
  // manual action, which lands on the entire domain rather than one page. Two
  // listings were in that state, both with no location text to work from.
  if (!ld.jobLocation && ld.jobLocationType !== 'TELECOMMUTE') return null;

  return ld;
}

/**
 * Presentation helpers.
 *
 * Everything below is display-only. None of it touches extraction, the store or
 * the JSON the app reads — a value we decline to print is still in the data.
 */

/** Two letters when there is no logo file, so a crest is never an empty box. */
function initials(name) {
  const words = String(name ?? '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}

/**
 * The logo, with the initials underneath rather than instead.
 *
 * Same reasoning as the card list: if the image 404s the alt text would leave a
 * blank square, so the initials are painted first and the image covers them.
 * 130 of 131 live postings carry a logo, and a page of pure type is the single
 * strongest signal that nobody designed it.
 */
function crest(name, logo, { cls = 'jp-crest', href = '' } = {}) {
  const inner = `${esc(initials(name))}${logo ? `<img src="${esc(logo)}" alt="" loading="lazy" decoding="async" width="80" height="80">` : ''}`;
  return href
    ? `<a class="${cls}" href="${esc(href)}" aria-hidden="true" tabindex="-1">${inner}</a>`
    : `<span class="${cls}" aria-hidden="true">${inner}</span>`;
}

const DAY = 86_400_000;

/**
 * "11 Aug 2026", stamped in the READER'S region rather than in IST.
 *
 * This used to be hardcoded to Asia/Kolkata on the reasoning that every reader
 * was in India. With a US board that reasoning inverts: a role posted at
 * 21:00 in New York is already tomorrow in Kolkata, so an IST stamp would date
 * half the US listings a day into the future. The date is the region's own.
 */
function dayLabel(ms, region = DEFAULT_REGION) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: region.timeZone });
}
function isoDay(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : '';
}

/**
 * How old the posting is, as a badge.
 *
 * The label rendered here is the ABSOLUTE date, and page.js rewrites it to
 * "3h ago" on load. That split is deliberate on both sides:
 *
 * - Never `postedText`. It is the string LinkedIn showed at scrape time and it
 *   never ages, so a day-old posting kept reading "4 minutes ago".
 * - Never a relative label baked into the file either. These pages are
 *   regenerated every 30 minutes, so a server-rendered "3h ago" would rewrite
 *   every job page on nearly every run and commit the churn to a public repo.
 *   An absolute date is stable, and the freshness class is applied by script.
 */
function agePill(ms) {
  if (!ms) return '';
  const age = Date.now() - ms;
  const cls = age < DAY ? ' is-hot' : age < 3 * DAY ? ' is-fresh' : '';
  return `<span class="pill${cls}" data-ago="${ms}"><i aria-hidden="true"></i>`
    + `Posted <time datetime="${isoDay(ms)}">${esc(dayLabel(ms))}</time></span>`;
}

/**
 * A stipend we are willing to print.
 *
 * The field is dirty: alongside "₹25,000 / month" it holds bare numbers lifted
 * out of the description — "2,026" is a year that reached the money slot. A
 * figure with no currency and no period is not a stipend, and printing one on a
 * student-facing page is worse than printing nothing.
 */
export function stipendText(job) {
  const raw = String(job.stipend ?? '').trim();
  if (!raw) return '';
  if (!/[₹$]|\brs\b|\blpa\b|\bper\b|\/\s*(month|year|week|total)|\b(month|year|week)ly\b/i.test(raw)) return '';
  // ZERO IS NOT AN AMOUNT. 68 live rows hold "₹0" — 30 of them on the US board,
  // where the currency is wrong as well as the figure. It is missing data, not
  // a wage: an employer that genuinely pays nothing is recorded in
  // `stipendStatus` — which is NOT trustworthy and is no longer rendered
  // anywhere; see statusPills. Printing
  // it was survivable while a stipend was one line in a fact table; it is not
  // now that pay is the headline fact on a card and reads as a claim about what
  // somebody pays.
  // A zero ANYWHERE a currency introduces an amount, not merely an all-zero
  // figure: the live board also holds "$0 – $1,000 / hour", a range running
  // from nothing to an impossible wage. A bound of zero tells a reader nothing
  // and still renders as a confident green figure.
  if (/[₹$£€]\s*0(?![\d.])/.test(raw)) return '';
  if (!/[1-9]/.test(raw.replace(/[^\d]/g, ''))) return '';
  return regroupWestern(raw);
}

/**
 * "$1,75,000" -> "$175,000".
 *
 * The extractor groups digits the Indian way — lakh-first, 1,75,000 — because
 * that is right for the board it was written for. On a US salary it is not a
 * cosmetic slip: "$1,75,000" reads as either a typo or $1.75, and this figure
 * is the most persuasive fact on the page. Measured on the live US board, 103
 * of 272 printable stipends carried it.
 *
 * Rupee amounts are LEFT ALONE — lakh grouping is correct there, and so is the
 * "12,00,000" an Indian posting writes on purpose. The test is the currency,
 * not the shape.
 */
function regroupWestern(raw) {
  if (/₹|\brs\.?\b|\blpa\b|\blakh|\bcrore?\b/i.test(raw)) return raw;
  return raw.replace(/\d[\d,]*\d/g, (num) => {
    // Lakh grouping is a 2-digit group sitting between two commas. Western
    // thousands never produce one, so this cannot fire on "1,000,000".
    if (!/\d,\d{2},/.test(num)) return num;
    const n = Number(num.replace(/,/g, ''));
    return Number.isFinite(n) ? n.toLocaleString('en-US') : num;
  });
}

/**
 * A duration we are willing to print.
 *
 * Same problem: "0 to 3 years" and "0-11 months" are experience requirements
 * that landed in the duration slot. Anything opening with a zero, or reading as
 * a range of years, is not how long an internship lasts.
 */
export function durationText(job) {
  const raw = String(job.duration ?? '').trim();
  if (!raw) return '';
  if (/^0\b/.test(raw)) return '';
  if (/\d\s*(?:to|[-–—])\s*\d+\s*(?:\+\s*)?(?:years?|yrs?)\b/i.test(raw)) return '';
  return raw;
}

/** "On-site" and "onsite" both occur. One spelling reaches the page. */
export function modeText(job) {
  const raw = String(job.workplaceType ?? '').trim();
  if (!raw) return '';
  if (/^on-?site$/i.test(raw)) return 'On-site';
  return raw[0].toUpperCase() + raw.slice(1);
}

/**
 * Competition, in the posting's own terms.
 *
 * LinkedIn phrases this two ways — "42 applicants" and "42 people clicked
 * apply" — and they mean different things, so neither is rewritten into the
 * other. Only the count is lifted out; the rest is dropped rather than guessed.
 */
function applicantsText(job) {
  const raw = String(job.applicants ?? '').trim();
  const n = (raw.match(/([\d,]+)/) || [])[1];
  if (!n) return '';
  if (/clicked/i.test(raw)) return `${n} clicked apply`;
  return `${n} applicant${n === '1' ? '' : 's'}`;
}

/**
 * How long ago we last CONFIRMED this posting was still on the employer's
 * board — and null whenever we cannot honestly say.
 *
 * THE COLLECTOR DECIDES THIS, and the difference between the two is not small.
 * `bin/poll-ats.js` re-reads every ATS board every 30 minutes, so board
 * presence is ground truth and `lastSeenAt` genuinely means "seen there, then".
 * A LinkedIn card falls out of the time-windowed search in about ninety
 * minutes and is almost never re-encountered: measured across the live boards,
 * the median LinkedIn row has `lastSeenAt === firstSeenAt` and is 21h stale in
 * the US and 293h — twelve days — in India.
 *
 * So a "verified" badge on a LinkedIn row would be the `posted_text` bug with
 * higher stakes: not a stale number, a false claim about a check we never made.
 * ATS only, and only while the reading is fresh — the same shape as the
 * Format D freshness gate, and for the same reason.
 */
const VERIFY_MAX_AGE_MS = 6 * 3_600_000;
export function verifiedAt(job) {
  if (!String(job?.id ?? '').startsWith('ats:')) return null;
  const seen = Number(job.lastSeenAt);
  if (!Number.isFinite(seen) || seen <= 0) return null;
  return Date.now() - seen <= VERIFY_MAX_AGE_MS ? seen : null;
}

/**
 * "Software Engineer – 2027 Internship Program (June Start)" -> "Jun 2027".
 *
 * A start date is one of the two facts a student weighs hardest and it is not
 * a stored column — but employers running graduate tracks put it in the title,
 * because that is what distinguishes their three otherwise identical postings.
 * Read from the title or not at all: nothing here is inferred from the season.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
export function startDate(job) {
  const t = String(job?.title ?? '');
  const m = t.match(/\(([A-Za-z]+)\s+start\)/i) || t.match(/\b(starts?|starting)\s+([A-Za-z]+)\b/i);
  const word = String((m && (m[2] || m[1])) ?? '').toLowerCase();
  const idx = MONTHS.indexOf(word);
  if (idx < 0) return '';
  const year = (t.match(/\b(20\d{2})\b/) || [])[1];
  const mon = word[0].toUpperCase() + word.slice(1, 3);
  return year ? `${mon} ${year}` : mon;
}

/** "Jun 2027" -> a sortable number. Month order, then year. */
function startKey(label) {
  const [mon, year] = String(label ?? '').split(' ');
  const m = MONTHS.findIndex((x) => x.startsWith(String(mon ?? '').toLowerCase()));
  return (Number(year) || 0) * 12 + (m < 0 ? 0 : m);
}

/**
 * The degree a posting asks for, in words a student uses.
 *
 * `degreeText` is the posting's own phrasing and is far better when it exists
 * ("Ph.D./Masters", "Computer Science/Computer Engineering") — but it is
 * present on only about 30% of rows, and it is not always a LEVEL: sometimes it
 * names a field of study. `degreeLevel` is on 68-83% and is always a level. So
 * the text is preferred when it is short enough to read as a chip, and the
 * level is the fallback rather than the other way round.
 */
export function degreeLabel(job) {
  const text = String(job?.degreeText ?? '').trim();
  const lvl = String(job?.degreeLevel ?? '').trim().toUpperCase();
  // `degreeText` is used ONLY when it names a level. It is free text and it
  // mixes two axes: "Ph.D./Masters" is a level, "Computer Science/Computer
  // Engineering" is a field of study — and the second, sitting in the slot
  // where the card promises a degree requirement, reads as though a bachelor's
  // were not enough. When it names a field, the level is the honest answer and
  // the field is already in the skills.
  const namesLevel = /bachelor|master|ph\.?\s?d|doctora|undergrad|postgrad|b\.?tech|m\.?tech|b\.?e\b|m\.?s\b/i;
  if (text && text.length <= 34 && namesLevel.test(text)) return text;
  if (lvl === 'UG') return 'Bachelor’s';
  if (lvl === 'PG') return 'Master’s / PhD';
  if (lvl === 'UG/PG' || lvl === 'PG/UG') return 'Bachelor’s / Master’s';
  return text || '';
}

/**
 * Every city a posting names, not just the first.
 *
 * `cityOf` takes the first comma-segment and that is right for a tile and for
 * the title builder, which deliberately spends its characters on the role. It
 * is wrong for a card: "Chicago, IL or New York, NY" is two real offices and
 * rendering it as "Chicago" hides one from somebody who can only take the
 * other. Split on the connectives an employer actually writes, never on the
 * comma — the comma separates a city from its state.
 */
export function placesOf(location, region = DEFAULT_REGION) {
  const raw = String(location ?? '').trim();
  if (!raw) return [];
  const parts = raw.split(/\s+or\s+|\s*[;/]\s*|\s*\|\s*/i)
    .map((p) => cityOf(p, region)).filter(Boolean);
  return [...new Set(parts)];
}

/** The badges under the headline: freshness, pay, competition. */
/**
 * IS THIS ROLE STILL OPEN? — the question every one of these pages exists to
 * answer, and the one it was answering only by implication.
 *
 * A page that leads with "POSTED 44D AGO" and says nothing else reads as an
 * archive. It is not: the site publishes a role only while it believes the
 * role is open, and removes it when that stops being true. That belief is
 * already asserted to Google in every page's `validThrough`, so stating it to
 * a human is not a new claim — it is the same claim, said out loud.
 *
 * TWO TIERS, because the evidence genuinely differs and flattening them would
 * be dishonest in one direction or useless in the other:
 *
 *  - `verified` — an ATS row re-read within the last six hours. ATS boards are
 *    polled every 30 minutes, so the posting being there IS ground truth and
 *    we can name when we looked. 27% of pages.
 *  - `likely` — everything else, which is mostly LinkedIn. A LinkedIn card
 *    falls out of the time-windowed search in about ninety minutes and is
 *    almost never re-encountered, so we cannot say we checked. What we CAN say
 *    is the rule the board runs on, which is true of every row on it.
 *
 * The hedge in "Likely open" is doing real work and must not be dropped. It is
 * the difference between a fact we verified and a policy we follow.
 */
function openState(job) {
  const at = verifiedAt(job);
  return at
    ? { tier: 'verified', label: 'Open now', at }
    : { tier: 'likely', label: 'Likely open', at: null };
}

/**
 * "Posted 44d ago" is a trust problem on a board whose whole promise is
 * freshness — it reads as stale even when the role is wide open, and on ATS
 * rows, which persist for months, it is the common case rather than the edge.
 *
 * verifiedAt() already encodes exactly when we may say otherwise, and why:
 * ATS boards are re-read every 30 minutes so board presence is ground truth,
 * while a LinkedIn card is almost never re-encountered and claiming it is
 * still open would invent the one fact a reader would most rely on. It was
 * written, tested and never rendered. This renders it.
 *
 * Measured across the three live boards: 213 of 786 rows (27%) can be
 * confirmed right now — and they are disproportionately the ones whose posted
 * date looks worst.
 */
function stillListed(job, company, region = DEFAULT_REGION) {
  const st = openState(job);
  /* THE DATE IS ABSOLUTE AND DAY-GRANULAR, and carries no data-ago.
     This shipped a millisecond `datetime` AND a baked relative label
     ("checked 3 minutes ago"), so it rewrote itself on every 30-minute
     publish — the one thing the rest of this file is careful never to do,
     and half of the 206-page-per-run churn measured on 30 Aug.
     Unlike a posted date, which is immutable and so can be shipped exact and
     hydrated by page.js, "last checked" moves on every poll: there is no
     precision that is also stable. The day is the honest stable unit. It is
     deliberately NOT given a data-ago either — page.js would then render a
     relative label counted from midnight ("checked 23 hours ago" on a role
     confirmed four minutes earlier), which understates the very freshness
     this line exists to prove. The hub does the same, for the same reason. */
  const detail = st.tier === 'verified'
    ? `Confirmed on ${esc(company)}&rsquo;s own careers page &middot; checked `
      + `<time datetime="${isoDay(st.at)}">${esc(dayLabel(st.at, region))}</time>`
    : 'We list a role only while we believe it is still open. Confirm on the posting before you apply.';
  return `<p class="jp-open is-${st.tier}">`
    + `<span class="jp-open-b"><i aria-hidden="true"></i>${st.label}</span>`
    + `<span class="jp-open-d">${detail}</span></p>`;
}

/**
 * What is unusual about THIS posting, rather than what it says.
 *
 * Students do not only want facts, they want to know which of them matter —
 * and every line here is a stored fact the page already carries, restated as
 * the reason it is worth noticing. Nothing is generated or inferred: no "great
 * company", no "strong fit", no compensation band we were not told. Those
 * would be the stipendStatus mistake with better prose.
 *
 * When a posting has none of these the block does not render at all, which is
 * the point — most postings are ordinary, and a "what stands out" section that
 * always finds something stands for nothing.
 */
function standouts(job, locations = 1) {
  const out = [];
  const money = stipendText(job);
  if (money) out.push(`Pay is stated up front &mdash; <strong>${esc(money)}</strong>. Most postings never say.`);
  if (/^remote$/i.test(String(job.workplaceType ?? '').trim())) out.push('<strong>Fully remote</strong>, so where you live is not a constraint.');
  const q = (String(job.applicants ?? '').match(/([\d,]+)/) || [])[1];
  const n = /over/i.test(String(job.applicants ?? '')) ? null : (q ? Number(q.replace(/,/g, '')) : null);
  if (n === 0) out.push('<strong>Nobody had applied</strong> when this was listed &mdash; you would be near the front of the queue.');
  else if (n != null && n < 10) out.push(`Only <strong>${n}</strong> ${n === 1 ? 'person had' : 'people had'} applied when this was listed.`);
  const posted = job.postedAt ?? job.firstSeenAt;
  if (posted && Date.now() - posted < DAY) out.push('<strong>Posted in the last 24 hours.</strong>');
  if (locations > 1) out.push(`The same role is open in <strong>${locations} locations</strong>.`);
  if (!out.length) return '';
  return `<section class="jp-why">
          <h2>What stands out</h2>
          <ul class="why-list">${out.map((t) => `<li>${t}</li>`).join('')}</ul>
        </section>`;
}

function statusPills(job) {
  const money = stipendText(job);
  return [
    agePill(job.postedAt ?? job.firstSeenAt),
    // ONLY A REAL AMOUNT. `stipendStatus` used to supply a "Paid" or "Unpaid"
    // pill when no figure parsed, and it must not: the field is written by the
    // local model from the prompt "unpaid only if it explicitly says unpaid",
    // and it does not hold. Checked against the live boards — of 47 India rows
    // and 63 US rows marked `unpaid`, ZERO contain any unpaid phrasing in their
    // own description. The pill was therefore telling readers that NatWest,
    // Seclore, Zycus and ThoughtSpot do not pay their interns. That is a false
    // claim about a named employer on a public page, which is the one thing
    // this file is most careful about everywhere else. `paid` is no better
    // sourced; it is merely harmless-looking. A stipend is stated when there is
    // a figure to state, and otherwise nothing is said.
    money ? `<span class="pill is-paid"><i aria-hidden="true"></i>${esc(money)}</span>` : '',
    applicantsText(job) ? `<span class="pill">${esc(applicantsText(job))}</span>` : '',
    modeText(job) ? `<span class="pill">${esc(modeText(job))}</span>` : '',
  ].filter(Boolean).join('');
}

/**
 * One role, as a card.
 *
 * The same object serves the "more at this employer" strip, the "just landed"
 * strip page.js builds from jobs.json, and the company hub's live list — so a
 * reader meets one shape everywhere and page.js has one markup to mirror.
 */
function tile(job, { showCompany = true, region = DEFAULT_REGION, locations = 1 } = {}) {
  const posted = job.postedAt ?? job.firstSeenAt;
  const age = posted ? Date.now() - posted : Infinity;
  const cls = age < DAY ? ' is-hot' : '';
  const meta = [
    // The inner <time> is not decoration: page.js finds the text to rewrite by
    // looking for it, and without one the tile kept its absolute date while the
    // pill above went relative.
    posted ? `<span class="tile-age${age < DAY ? ' is-hot' : age < 3 * DAY ? ' is-fresh' : ''}" data-ago="${posted}"><time datetime="${isoDay(posted)}">${esc(dayLabel(posted, region))}</time></span>` : '',
    // A collapsed role says how many cities it covers rather than naming the
    // one posting that happened to be newest — which would be a tile claiming
    // an opening is in Mason when it is open in twenty-two places.
    locations > 1 ? `${locations} locations` : esc(cityOf(job.location, region)),
    modeText(job) ? esc(modeText(job)) : '',
  ].filter(Boolean).join('<span aria-hidden="true">·</span>');

  return `<a class="tile${cls}" href="${regionHref(`/jobs/${jobSlug(job)}`, region)}">
        ${showCompany ? `<span class="tile-top">${crest(job.company, job.logo, { cls: 'tile-crest' })}<span class="tile-co">${esc(job.company)}</span></span>` : ''}
        <span class="tile-role">${esc(job.title)}</span>
        ${job.roleLabel && !showCompany ? `<span class="tile-co">${esc(job.roleLabel)}</span>` : ''}
        <span class="tile-meta">${meta}</span>
      </a>`;
}

/**
 * "Bengaluru, Karnataka, India" -> "Bengaluru".
 *
 * Tiles only. The full string stays on the job page, where there is room for
 * it; in a tile it pushed the workplace mode onto its own line and stranded the
 * separator dot at the end of the one above. Every listing here is in India, so
 * the state and the country are the two least useful words on the card.
 */
function cityOf(location, region = DEFAULT_REGION) {
  const first = String(location ?? '').split(',')[0].trim();
  return first || region.name;
}

/** Newest first, and only ones worth opening. */
function newestFirst(jobs) {
  return [...jobs].sort((a, b) => (b.postedAt ?? b.firstSeenAt ?? 0) - (a.postedAt ?? a.firstSeenAt ?? 0));
}

/**
 * hreflang links between the same page in different regions.
 *
 * Only ever passed for pages that genuinely HAVE an equivalent elsewhere: the
 * board itself and the company directory. A job page does not — a Stripe
 * internship in Dublin is not a translation or a regional variant of one in
 * Bengaluru, it is a different vacancy — and claiming otherwise tells Google two
 * unrelated URLs are the same page. Company hubs are excluded for the same
 * reason: an employer hiring in both places has two hubs with different roles on
 * them, not one page served two ways.
 *
 * `x-default` points at India, which is where an unmatched visitor lands.
 */
function alternateLinks(path, regions) {
  // `path === null` is how a caller says THIS PAGE HAS NO EQUIVALENT — job
  // pages and company hubs pass it deliberately. Without this guard the null
  // fell through into regionUrl and every job page shipped three alternates
  // pointing at "https://interndoor.comnull", which is a 404 advertised to
  // Google as the same page in another language.
  if (!regions || regions.length < 2 || path == null) return '';
  const links = regions.map((r) =>
    `<link rel="alternate" hreflang="${r.hreflang}" href="${esc(regionUrl(path, r))}">`);
  const fallback = regions.find((r) => r.code === 'IN') ?? regions[0];
  links.push(`<link rel="alternate" hreflang="x-default" href="${esc(regionUrl(path, fallback))}">`);
  return `${links.join('\n')}\n`;
}

/**
 * The region switch.
 *
 * A NAVIGATION control, not a filter. Each region is a separate URL with its own
 * title, its own listings and its own JSON-LD country, because a client-side
 * toggle would leave Google one page whose <title> says India for every region
 * on the site — and the site's entire traffic model is Google.
 *
 * Built on <details>/<summary> so it needs NO JavaScript at all. That matters
 * more than it looks: the switch appears in the shared chrome, which is loaded
 * by app.js on the board and by page.js on generated pages, and a scripted
 * dropdown would have to exist in both and stay in sync. It is also keyboard
 * accessible and open to a crawler by default, so every region's board is
 * reachable by following an ordinary anchor from any page on the site.
 *
 * Deliberately absent when only one region is published: a switch with one
 * option is furniture.
 */
function regionSwitch(current, regions) {
  if (!regions || regions.length < 2) return '';
  const opts = regions.map((r) => {
    const here = r.code === current.code;
    return `<a class="rg-opt${here ? ' is-on' : ''}" href="${esc(regionUrl('/', r))}"`
      + `${here ? ' aria-current="page"' : ''} data-region="${r.code}">`
      + `<span class="rg-name">${esc(r.name)}</span></a>`;
  }).join('\n          ');
  return `      <details class="rg" id="region-switch" data-current="${current.code}">
        <summary aria-label="Change region — currently ${esc(current.name)}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>
          <span class="rg-cur">${esc(current.name)}</span>
          <svg class="rg-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </summary>
        <div class="rg-menu">
          ${opts}
        </div>
      </details>
`;
}

/** Shared <head> and page chrome, so every generated page carries the same rules. */
/**
 * `scripts` is for behaviour ONE page needs and the other ~950 do not.
 *
 * /applications carries a whole table; a job page carries none of it. Putting
 * it in page.js would ship it to every generated page on the site to be parsed
 * and thrown away. Anything added here must be a `'self'` src — vercel.json
 * ships `script-src 'self'` plus a hash allowlist and no 'unsafe-inline', so an
 * inline script whose sha256 is absent is silently blocked in production and
 * works perfectly on every local server. That is exactly how the no-flash theme
 * script shipped broken on 21 Aug.
 */
function head({ title, description, canonical, indexable, extraLd = '', region = DEFAULT_REGION, alternates = null, alternatePath = '/', image = `${SITE}/og.jpg?v=5`, scripts = '' }) {
  return `<!doctype html>
<html lang="${region.hreflang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="interndoor-region" content="${region.code}">
${alternateLinks(alternatePath, alternates)}${indexable ? '' : '<meta name="robots" content="noindex,follow">\n'}<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0a0a0b" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f4f3ee" media="(prefers-color-scheme: light)">
<meta property="og:type" content="article">
<meta property="og:site_name" content="InternDoor">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(image)}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="InternDoor — new internships" href="${regionHref('/feed.xml', region)}">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800;900&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/page.css">
${extraLd}<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<script defer src="/track.js"></script>
<script defer src="/page.js"></script>
${scripts}<script defer src="/subscribe.js"></script>
<script defer src="/gtag.js"></script>
<script defer src="/_vercel/insights/script.js"></script>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<header class="bar">
  <div class="wrap bar-in">
    <a class="brand" href="${regionHref('/', region)}" aria-label="InternDoor">
      <span class="scope" aria-hidden="true">
        <svg viewBox="0 0 44 44">
          <circle class="s-ring" cx="22" cy="22" r="20"/>
          <circle class="s-ring" cx="22" cy="22" r="13"/>
          <circle class="s-ring" cx="22" cy="22" r="6"/>
          <g class="s-sweep"><path d="M22 22 L22 1 A21 21 0 0 1 40 12 Z"/></g>
          <circle class="s-dot" cx="22" cy="22" r="2.8"/>
        </svg>
      </span>
      <span class="word">INTERN<em>DOOR</em></span>
    </a>

    <div class="bar-right">
${regionSwitch(region, alternates)}      <a class="alerts" aria-label="Get alerts" href="${regionHref('/alerts', region)}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        <span>Get alerts</span>
      </a>
      <button class="ghost-btn" id="theme-toggle" type="button" aria-label="Switch theme">
        <svg class="i-sun" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>
        <svg class="i-moon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/></svg>
      </button>
    </div>
  </div>
</header>
`;
}

/**
 * The closing invitation, then the disclaimer.
 *
 * A visitor who arrived from a search for one job and has now read it is at the
 * only moment they will ever consider subscribing. The old foot spent that
 * moment on a sentence about sources of truth. That sentence is still here —
 * underneath, in the footer, where a disclaimer belongs.
 */
/**
 * The email signup, on every generated page.
 *
 * IT IS HERE AND NOT ONLY ON THE HOMEPAGE because this is where the traffic
 * actually lands. Somebody arriving from Google arrives on a JOB page — that is
 * the whole point of 944 indexed pages — reads one posting and leaves, and the
 * homepage is a page they may never see. Putting the only capture on the
 * homepage would be putting it where the readers are not.
 *
 * It sits BELOW the Telegram and browse buttons deliberately. Telegram is
 * instant and already works; email is the one that survives someone changing
 * messaging app, and is worth offering second rather than instead.
 *
 * `data-region` is rendered in rather than read from the meta tag: this page
 * already knows which board it belongs to at build time, and a value baked into
 * the markup cannot be wrong the way one inferred at runtime can.
 *
 * NO-JS BEHAVIOUR IS A REAL POST, NOT A DEAD BUTTON. The action and method are
 * set, so a reader whose JavaScript never arrives still lands on the list — they
 * see the endpoint's JSON, which is ugly, but they ARE subscribed. web/api's
 * `form-action 'self'` in vercel.json already permits it. page.js intercepts
 * for everyone else and keeps them on the page.
 */
function signupForm(region, { heading = true } = {}) {
  /* On /alerts the form sits under an "By email" heading, so repeating "Or get
     them by email" above the box says the same thing twice. The label is still
     rendered for screen readers, just visually hidden. */
  const labelText = heading
    ? 'Or get them by email — one message, no spam.'
    : 'Your email address';
  return `<form class="sub" method="post" action="/api/subscribe" data-region="${esc(region.code)}">
      <label class="sub-l${heading ? '' : ' vh'}">${labelText}</label>
      <div class="sub-row">
        <input class="sub-i" aria-label="${esc(labelText)}" type="email" name="email" required
               autocomplete="email" inputmode="email" spellcheck="false"
               placeholder="you@college.edu">
        <button class="sub-b" type="submit">Subscribe</button>
      </div>
      <div class="sub-hp" aria-hidden="true"><label>Company<input type="text" name="company" tabindex="-1" autocomplete="off"></label></div>
      <p class="sub-msg" role="status" aria-live="polite"></p>
    </form>`;
}

function foot({ headline, sub, region = DEFAULT_REGION, signup = true }) {
  return `
<section class="outro">
  <div class="wrap">
    <b>${headline}</b>
    <p>${sub}</p>
    <div class="outro-acts">
      <a class="a-1" href="${regionHref('/alerts', region)}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        Get every new role
      </a>
      <a class="a-2" href="${regionHref('/', region)}">Browse all live internships</a>
    </div>
    ${signup ? signupForm(region) : ''}
  </div>
</section>
<footer class="foot">
  <div class="wrap">
    <p>Every listing links back to its original posting — always apply there. Summaries are written by InternDoor; the linked posting is the source of truth.</p>
    <p class="dim"><a href="${regionHref('/', region)}">Home</a> · <a href="${regionHref('/companies/', region)}">All companies</a> · <a href="${regionHref('/skills/', region)}">By skill</a> · <a href="${regionHref('/locations/', region)}">By city</a> · <a href="${regionHref('/report', region)}">The numbers</a> · <a href="${regionHref('/applications', region)}">My applications</a> · <a href="${regionHref('/feed.xml', region)}">RSS</a></p>
  </div>
</footer>
</body>
</html>
`;
}

/**
 * A single job page.
 *
 * `siblings` is the employer's other live roles. It is the whole reason this
 * page has a second click in it: somebody who landed here from Google has
 * either applied or decided not to, and in both cases the next useful thing is
 * another role — not the back button. The "just landed" strip below it is
 * filled by page.js from jobs.json rather than baked in, because a baked list
 * of the newest roles would rewrite all ~130 job pages every time one arrived.
 */
/**
 * Build a <title> that survives Google's ~60-character truncation.
 *
 * The old format was `${company} ${title} Internship ${year} — ${region} | InternDoor`
 * and it produced "Airmeet Outreach Campaign Intern Internship 2026 — India |
 * InternDoor" (71 chars) and "AppVersal Golang Developer Internship in Noida
 * Internship 2026 — India | InternDoor" (85). Two faults: the word Internship
 * was appended even when the role title already said it, and the tail
 * "— India | InternDoor" spent 20 characters on the two least useful words in
 * the string. Measured across the rendered pages, titles ran 60-85 characters
 * against a limit near 60, so the year and the brand were being cut off in the
 * SERP anyway.
 *
 * Parts are dropped from the END as needed, so the part that matches what
 * people actually search — "<company> <role> intern" — is never the part that
 * gets truncated. The region left the title entirely; it is in the URL for
 * US/UK and in the meta description everywhere.
 */
const TITLE_MAX = 60;

/**
 * One role at one employer, however many cities it is advertised in.
 *
 * Mirrors `roleKey` in web/public/app.js — see the long note there. The
 * fingerprint is a hash of the posting's own description, written by
 * publish.js, and it is the only field that separates "one role in 22 cities"
 * from "22 different jobs an employer filed under one title". A row without one
 * falls back to its own id so it stands alone rather than being merged on a
 * guess.
 */
export function roleKey(job) {
  return [
    String(job.company ?? '').toLowerCase().trim(),
    String(job.title ?? '').toLowerCase().trim(),
    job.roleFingerprint || `id:${job.id}`,
  ].join('|');
}
export function buildTitle(parts, brand = 'InternDoor') {
  const kept = parts.filter(Boolean).map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
  // Longest prefix of the optional parts that still leaves room for the brand.
  for (let n = kept.length; n >= 1; n--) {
    const head = kept.slice(0, n).join(' ');
    if (`${head} | ${brand}`.length <= TITLE_MAX) return `${head} | ${brand}`;
  }
  // Nothing fits even with everything optional dropped, because some employers
  // write titles like "Intern Software development engineering (AI/ML/NLP &
  // Cybersecurity), Graduation Year (2026)" — 112 characters before the company
  // name is added. Trim at a word boundary and drop the brand rather than
  // spending 13 of the remaining characters on a name nobody is searching for
  // yet; Google appends the site name itself, so it is not actually lost. The
  // company and the start of the role survive, which is the part that matches
  // "<company> <role> intern".
  const head = kept[0];
  if (head.length <= TITLE_MAX) return head;
  const cut = head.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > TITLE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * A title that keeps BOTH ENDS: the employer and the start of the role, and the
 * tail that actually tells it apart.
 *
 * Every other trim here drops from the end, which is right when the end is the
 * least useful part. It is exactly wrong when the end is the ONLY useful part.
 * Booz Allen files "University, 2027 Summer Games - Cyber Security Intern",
 * "- Data Scientist Intern" and "- Software Developer Intern"; the first 48
 * characters are identical, so all three clamped to one string and three
 * genuinely different jobs rendered the same <title>.
 *
 * ONLY REACHED WHEN THE ORDINARY CANDIDATES COLLIDE, which is what makes it
 * safe. As a general rule it would be wrong — STEMpedia writes fifteen city
 * names at the end of a title, and preserving that tail is the worst thing to
 * keep — but a posting with no rival never gets here.
 */
export function elideMiddle(text, max = TITLE_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;

  // The distinguishing part is nearly always the last segment after a
  // separator: "<programme> - Cyber Security Intern".
  const maxTail = Math.floor(max * 0.55);
  const seg = t.match(/[-–—:,]\s*([^-–—:,]{3,})$/);
  let tail = seg && seg[1].trim().length <= maxTail ? seg[1].trim() : '';
  if (!tail) {
    // No clean separator, so take as many whole trailing words as fit.
    const words = t.split(' ');
    for (let i = words.length - 1; i >= 0; i--) {
      const next = words[i] + (tail ? ` ${tail}` : '');
      if (next.length > maxTail) break;
      tail = next;
    }
  }
  const room = max - tail.length - 2;
  // Below this the head is too short to name the employer, which is the half
  // that matches what people search. A plain clamp is the better answer then.
  if (!tail || room < 14) return clampWords(t, max);
  const head = clampWords(t, room);
  // Nothing is gained by eliding a middle that is already empty, and a head
  // that already contains the tail would just repeat it.
  if (!head || head.length + tail.length + 2 > max) return clampWords(t, max);
  if (head.toLowerCase().includes(tail.toLowerCase())) return clampWords(t, max);
  return `${head}\u2026 ${tail}`;
}

/**
 * The tail that tells THIS title apart from the ones it collides with.
 *
 * elideMiddle keeps the last few words, which is right when the end happens to
 * be distinctive and useless when it is not: AbbVie's three roles all end
 * "(Undergraduate)", so keeping the tail kept the one part they share and threw
 * away Cybersecurity / Cloud Engineering / Data & Software. The tail has to be
 * chosen against the RIVALS, not from the string alone.
 *
 * So: find how far this title still agrees with each one it must be
 * distinguished from, take the furthest of those, and start the tail at the
 * next word boundary. Anything before that point is shared and cannot
 * disambiguate; anything after it is exactly what does.
 */
export function distinguishingTail(base, rivals = [], max = TITLE_MAX) {
  const t = String(base || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;

  /* EVERY divergence point is a candidate, and the one that separates the most
     rivals wins.
     ------------------------------------------------------------------------
     This used to take the LATEST agreement across all rivals and nothing else,
     on the measurement that latest left 8 duplicate pages against earliest's
     48. Both are the same mistake at opposite ends: ONE cut cannot serve a
     posting whose rivals diverge in different places.

     Booz Allen is the shape that breaks it. "...2027 Summer Games Cyber
     Security Intern - Atlanta, GA" has a rival agreeing to character 74 (the
     same role in McLean) and another agreeing only to 50 (Software Developer,
     same city). The latest cut yields the tail "Atlanta, GA", and making room
     for it clamps the head to "Booz Allen Hamilton University - 2027 Summer" --
     which throws away the word "Cyber", the only thing separating it from the
     Software row. So the tail collided, every other candidate collided too, and
     renderJobPage fell all the way back to the plain clamp: NINE pages sharing
     three titles. Cutting at 50 instead gives "Booz Allen Hamilton... Cyber
     Security Intern - Atlanta, GA", which separates from both.

     Scored rather than ruled, for the same reason the caller picks a title by
     collision check rather than by rule: which cut is right is a property of
     this posting's particular rivals, not of titles in general. Ties keep the
     LATEST cut, so a posting whose rivals all diverge in one place renders
     exactly the string it rendered before. */
  const others = [];
  const cuts = new Set();
  for (const r of rivals) {
    const o = String(r || '').replace(/\s+/g, ' ').trim();
    if (!o || o === t) continue;
    others.push(o);
    let i = 0;
    while (i < t.length && i < o.length && t[i] === o[i]) i += 1;
    cuts.add(i);
  }
  // No rivals to aim at, so fall back to the generic version.
  if (!others.length) return elideMiddle(t, max);

  /* One candidate, rendered. Returns '' when this cut cannot produce a usable
     title, which is how the loop below skips it. Applied to a RIVAL's string as
     well as to our own -- that is what makes the score a like-for-like
     comparison rather than a guess about what the rival will choose. */
  const render = (s, cut) => {
    if (!(cut > 0) || cut >= s.length) return '';
    const sp = s.lastIndexOf(' ', cut);
    if (!(sp > 0)) return '';
    let tail = s.slice(sp + 1).trim();
    const maxTail = Math.floor(max * 0.62);
    if (tail.length > maxTail) tail = clampWords(tail, maxTail);
    if (!tail) return '';
    const room = max - tail.length - 2;
    if (room < 14) return '';
    const head = clampWords(s, room);
    if (!head || head.length + tail.length + 2 > max) return '';
    if (head.toLowerCase().includes(tail.toLowerCase())) return '';
    return `${head}… ${tail}`;
  };

  let best = '';
  let bestScore = -1;
  for (const cut of [...cuts].sort((a, b) => b - a)) {
    const mine = render(t, cut);
    if (!mine) continue;
    let score = 0;
    for (const o of others) if (render(o, cut) !== mine) score += 1;
    if (score > bestScore) { bestScore = score; best = mine; }
    if (score === others.length) break;
  }
  return best || elideMiddle(t, max);
}

/**
 * Trim to a length at a WORD boundary. Slicing mid-word left descriptions
 * ending "...and internal" / "...then contribute", which is what the SERP then
 * shows before its own ellipsis.
 */
export function clampWords(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.\-–—]+$/, '').trim();
}

/** True when the role title already contains an internship word. */
export function saysIntern(title) {
  return /\b(intern|interns|internship|internships|trainee|apprentice|apprenticeship|co-?op)\b/i.test(title || '');
}

/**
 * @param {object[]} siblings this employer's other live roles IN THIS REGION.
 * @param {{job: object, region: object}[]} opts.foreign the same employer's live
 *   roles on the OTHER published boards, each tagged with the region that
 *   renders it. Used only to keep <title> unique site-wide — the visible "more
 *   at this employer" strip stays regional, because a role in another country
 *   is not a second click a reader of this board wants.
 */
export function renderJobPage(job, siblings = [], { region = DEFAULT_REGION, alternates = null, foreign = [], validDays = DEFAULT_VALID_DAYS, skillPages = new Set() } = {}) {
  const url = regionUrl(`/jobs/${jobSlug(job)}`, region);
  const apply = safeUrl(job.applyUrl);
  const indexable = isIndexable(job);
  const posted = job.postedAt ?? job.firstSeenAt ?? Date.now();
  const year = new Date(posted).getFullYear();
  const hub = regionHref(`/companies/${companySlug(job.company)}`, region);

  // Title shaped the way people actually search: company, role, the word
  // internship, then the country and the year.
  // "Intern Internship" was a real rendered title. Only add the word when the
  // role title has not already said it.
  const roleHead = `${job.company} ${job.title}`.replace(/\s+/g, ' ').trim();

  // The city goes in the title ONLY when another live posting would otherwise
  // carry the same one.
  //
  // Measured before this: 109 of 445 job pages shared a <title> with another
  // page across 37 distinct titles — Procter & Gamble had TWENTY-TWO pages
  // reading "Procter & Gamble Engineering Internship, Summer 2027", IBM seven.
  // Search Console reports that directly, and Google's own response to a set of
  // near-identical pages is to pick one and treat the rest as duplicates, which
  // is the whole set of city pages thrown away.
  //
  // Only when needed, because the alternative — a city on every title — trims
  // the role text on the 336 pages that were already unique, and `<company>
  // <role>` is the part that matches what people search. This also keeps the
  // change off those pages entirely: a title rewrite on a page Google has
  // already settled on is churn for nothing.
  // A twin is a sibling with the SAME title in a DIFFERENT city — that is the
  // only shape the city actually fixes, and the distinction matters because
  // making room for it costs title text.
  //
  // AbbVie files "…Intern - Cloud Engineering" and "…Intern - Data & Software
  // Engineering" both in South San Francisco. Their titles already differ, but
  // they are long: clamping the head to fit " in South San Francisco" cut it to
  // "AbbVie 2027 Business Technology" and destroyed the very words that told
  // them apart, turning two distinct titles into four identical ones. A city
  // cannot disambiguate postings that share one.
  //
  // A rival can also sit on ANOTHER BOARD. A <title> has to be unique across
  // the whole site, not within one region, and Jump Trading runs the same six
  // campus roles in Chicago and in London — so /us/jobs/… and /uk/jobs/…
  // rendered byte-identical titles while each page's collision check saw only
  // its own region's siblings. Seven pairs were colliding that way. Each rival
  // is judged in ITS OWN region, because the city suffix is dropped when it
  // equals the region's name and "London" means something different on the UK
  // board than on the US one.
  const rivalry = [
    ...siblings.map((s) => ({ job: s, region })),
    ...foreign,
  ].filter((s) => String(s.job.id) !== String(job.id));

  const sameTitle = rivalry.filter((s) => String(s.job.title ?? '').trim().toLowerCase()
    === String(job.title ?? '').trim().toLowerCase());
  const myCity = cityOf(job.location, region);
  const twin = sameTitle.some((s) => cityOf(s.job.location, s.region).toLowerCase() !== myCity.toLowerCase());

  /**
   * The two titles this posting could carry: with its city, and without.
   *
   * Adding the city is not free — the head has to be clamped to make room, and
   * on a long title the clamp can cut the very words that told two postings
   * apart. AbbVie files "…Intern - Cloud Engineering (Undergraduate)" and
   * "…Intern - Data & Software Engineering (Undergraduate)"; both clamp to
   * "AbbVie 2027 Business Technology", so adding the city turned two distinct
   * titles into two identical ones. IBM has the opposite problem — one title in
   * seven cities, where the city is the ONLY thing that can distinguish them.
   *
   * Neither case can be settled by a rule about length, so the choice is made
   * by actually checking for a collision against the siblings below.
   */
  const candidates = (j, r = region) => {
    const rh = `${j.company} ${j.title}`.replace(/\s+/g, ' ').trim();
    const base = saysIntern(j.title) ? rh : `${rh} Internship`;
    // The FIRST city only. A board that advertises one role in two offices
    // writes them into one string — "Chicago; New York", "London; Amsterdam" —
    // and 19 characters of second city is room the role text needs more:
    // "Jump Trading Campus Quantitative in Chicago; New York" is what that
    // costs, against "Jump Trading Campus Quantitative Trader in Chicago".
    // Narrowed here rather than in cityOf, which also feeds the tiles and the
    // hub, where dropping the second office would hide a real location.
    const c = cityOf(j.location, r).split(';')[0].trim();
    // A posting whose location is only the country resolves to the country, and
    // "Microsoft Research Sciences INTERN in India" on the India board neither
    // disambiguates anything nor tells a reader something they did not know
    // from the URL. Same rule placeSuffix already applies to the description.
    const suf = c && c.toLowerCase() !== r.name.toLowerCase() ? ` in ${c}` : '';
    // Reserve the room rather than letting buildTitle drop the city: it keeps
    // the longest prefix that still fits the BRAND, so a part appended after a
    // long head is exactly what it discards — and here that part is the only
    // thing making the title unique. The brand is the right thing to lose;
    // Google appends the site name itself.
    const clamped = suf && base.length + suf.length > TITLE_MAX
      ? clampWords(base, TITLE_MAX - suf.length)
      : base;
    const y = new Date(j.postedAt ?? j.firstSeenAt ?? Date.now()).getFullYear();
    // base and suf are returned too: the tail variants below cannot be built
    // here, because choosing a tail needs the RIVALS' titles and this function
    // only ever sees one posting.
    return {
      base,
      suf,
      withCity: buildTitle([`${clamped}${suf}`, y]),
      plain: buildTitle([base, y]),
    };
  };

  const mine = candidates(job);
  // Only the postings that could actually collide — the same employer's, on
  // every board.
  const rivals = rivalry.map((s) => candidates(s.job, s.region));
  const collides = (t, pick) => rivals.some((r) => pick(r) === t);

  /* The two tail variants, added in a second pass because each one is chosen
     against the OTHER postings' titles.
     BOTH are needed, and they answer different collisions: `tail` separates
     different roles advertised in the same city, `tailCity` separates them when
     the same role also runs in several cities — which is Booz Allen exactly,
     four cities x three roles, where neither the city nor the role alone is
     enough. */
  const bases = [mine, ...rivals].map((c) => c.base);
  const withTails = (c, i) => {
    const others = bases.filter((_, j) => j !== i);
    c.tail = distinguishingTail(c.base, others);
    c.tailCity = c.suf
      ? `${distinguishingTail(c.base, others, TITLE_MAX - c.suf.length)}${c.suf}`
      : c.tail;
  };
  withTails(mine, 0);
  rivals.forEach((r, i) => withTails(r, i + 1));

  /* ORDERED BY PREFERENCE, AND THE FIRST ONE THAT IS ACTUALLY UNIQUE WINS.
     The city goes first when a sibling shares this exact title, because then it
     is the only discriminator there is; otherwise the untrimmed title leads.
     The previous expression fell back to `withCity` whenever `plain` collided
     WITHOUT checking that the city helped — and for Booz Allen it does not,
     because the colliding roles are all in one city, so it was choosing a
     variant already known to collide. 95 pages shared 43 titles that way. */
  const order = twin
    ? ['withCity', 'tailCity', 'tail', 'plain']
    : ['plain', 'tail', 'withCity', 'tailCity'];
  let pageTitle = null;
  for (const k of order) {
    if (!collides(mine[k], (r) => r[k])) { pageTitle = mine[k]; break; }
  }
  /* Nothing distinguishes it. Prefer the more informative of the two rather
     than the shorter: two long titles at one employer in the SAME city whose
     first 60 characters agree are genuinely irreducible without inventing
     something, and a job id in a title would be worse than the duplicate. */
  if (!pageTitle) pageTitle = twin ? mine.withCity : mine.plain;

  // Lead with the facts a student scans for — where, how, how much — rather
  // than a generic "is hiring" opener. The first bullet is kept as the tail
  // because it is the only sentence that says what the work actually is.
  const descFacts = [
    job.location || null,
    modeText(job) || null,
    stipendText(job) ? `stipend ${stipendText(job)}` : null,
    durationText(job) || null,
  ].filter(Boolean).join(' · ');
  // "Accenture in India" is a real employer name, so appending the region gave
  // "at Accenture in India in India". Skip the suffix when the name already
  // ends with it.
  const descLead = `${job.title} at ${job.company}${placeSuffix(job.company, region)}.`;
  const description = clampWords([descLead, descFacts, (job.bullets ?? [])[0]]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(), 155);

  const facts = [
    job.location ? ['Location', esc(job.location)] : null,
    modeText(job) ? ['Mode', esc(modeText(job))] : null,
    job.roleLabel ? ['Focus', esc(job.roleLabel)] : null,
    job.degreeLevel ? ['Eligibility', esc([job.degreeLevel, job.degreeText].filter(Boolean).join(' · '))] : null,
    durationText(job) ? ['Duration', esc(durationText(job))] : null,
    // A stipend the posting never stated is NOT DISCLOSED, never "Unpaid".
    // Saying nothing at all left a reader unable to tell "this employer pays
    // nothing" from "we do not know" — and the field that used to answer that,
    // `stipendStatus`, is a local-model guess measured wrong on every one of
    // the 110 rows it marked unpaid. This says exactly what is true: the
    // posting did not say, and the linked original is where to look.
    stipendText(job)
      ? ['Stipend', `<span class="cash">${esc(stipendText(job))}</span>`]
      : ['Stipend', '<span class="unk">Not disclosed</span>'],
    // Same fallback as validThrough and the JSON-LD above. It was the one date
    // here without it, and toISOString on an Invalid Date throws — which would
    // not lose one page, it would abort writePages and with it the whole publish.
    ['Posted', `<time datetime="${isoDay(posted)}">${esc(dayLabel(posted, region))}</time>`],
  ].filter(Boolean);

  const postingLd = jobPostingLd(job, url, region, validDays);
  const where = apply ? applyTarget(apply) : '';
  // ONE apply button on the page, in the rail. It is sticky on a desktop and
  // sits under the headline on a phone, and the dock catches a reader who has
  // scrolled past it — so a second copy lower down was never reachable at a
  // moment the first one was not. Two identical primary buttons also cost the
  // first one its weight: whichever the eye lands on reads as one of a pair.
  // The label is just "Apply". It used to name the destination — "Apply on
  // LinkedIn" / "on the company's site" — which was there so nobody was told
  // one thing and sent somewhere else. That obligation has not gone away, it
  // has moved one line down into .jp-card-note, which still says exactly where
  // the button lands. It reads better there and it stops the same seven words
  // appearing three times in one column.
  const applyBtn = apply
    ? `<a class="btn-apply" href="${apply}" target="_blank" rel="nofollow noopener"><span>Apply</span><em aria-hidden="true"></em></a>`
    : '';

  // One tile per ROLE, not per posting.
  //
  // This strip is the page's only second click, and for an employer that files
  // one opening in every city it was six links to the same job — six internal
  // links all pointing at near-identical pages, which is both useless to a
  // reader and a poor internal-linking signal. Collapsed, the six become six
  // genuinely different roles. The role a reader is already on is excluded
  // whole, so its other cities are not offered back as "more".
  const here = roleKey(job);
  /* How many postings this same opening has — one per city when an employer
     advertises a role in several. It is the count the board's cards already
     collapse on, so the page and the card agree. */
  const locations = siblings.filter((j) => roleKey(j) === here).length || 1;
  const seenRoles = new Set([here]);
  const others = newestFirst(siblings.filter((j) => String(j.id) !== String(job.id)))
    .filter((j) => {
      const k = roleKey(j);
      if (seenRoles.has(k)) return false;
      seenRoles.add(k);
      return true;
    })
    .slice(0, 6);

  return `${head({
    title: pageTitle,
    description,
    canonical: url,
    indexable,
    region,
    /* THIS POSTING'S OWN preview image, drawn on request by web/api/og.js.
       Every job page served the same generic picture, so every share of every
       role looked identical — on the one element a reader sees before any text.
       IT IS A URL, NOT A FILE, and that is a storage decision: a committed card
       is ~46KB and will not compress further (measured at four quality levels
       and with the film grain removed), which is +44MB for today's board and
       ~1.7GB a YEAR of git history that cannot be pruned without rewriting a
       public repo. Generated on request it costs nothing per job and covers
       postings that do not exist yet. The function caches for a year, and
       redirects to the generic card rather than erroring on an unknown id. */
    image: `${SITE}/api/og?id=${encodeURIComponent(job.id)}&r=${region.code}`,
    // No hreflang on a job page. A Stripe internship in Dublin is not a
    // regional variant of one in Bengaluru, it is a different vacancy, and
    // telling Google two unrelated URLs are the same page is a real error.
    // The switch is still rendered from `alternates` in the chrome.
    alternates,
    alternatePath: null,
    extraLd: postingLd ? `<script type="application/ld+json">${jsonLd(postingLd)}</script>\n` : '',
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${regionHref('/', region)}">Home</a> <i aria-hidden="true">›</i>
      <a href="${hub}">${esc(job.company)}</a> <i aria-hidden="true">›</i>
      <span>${esc(job.title)}</span>
    </nav>

    <div class="jp-grid">
      <div class="jp-main">
        <header class="jp-hero">
          <!-- ONE LINK, NOT THREE. The crest, the name and the roles count all
               pointed at the same hub, stacked on top of each other — three
               targets for one destination, and the crest was already
               aria-hidden because it was a duplicate. The whole block is a
               single anchor now: one target, and a bigger one. -->
          <a class="jp-id" href="${hub}">
            ${crest(job.company, job.logo)}
            <span class="jp-id-t">
              <span class="jp-co">${esc(job.company)}</span>
              <!-- A REASON TO FOLLOW THE LINK, not just a name that happens to
                   be one. The count is this employer's other live roles in this
                   region, which is the only company fact this page holds that a
                   reader can act on; with no others it says so plainly rather
                   than offering a hub that will look empty. -->
              <span class="jp-co-more">${others.length
                ? `${others.length} other open role${others.length === 1 ? '' : 's'} here`
                : 'See this employer&rsquo;s page'} <i aria-hidden="true">&rarr;</i></span>
            </span>
          </a>

          <!-- The size step is chosen from the TITLE'S OWN LENGTH, not from the
               viewport. Employers write 30-character titles and 112-character
               ones, and one clamp cannot serve both: at the size that makes a
               short title land, a long one takes four or five lines and pushes
               everything a reader came for below the fold. -->
          <h1${job.title.length > 64 ? ' class="is-long"' : job.title.length > 40 ? ' class="is-mid"' : ''}>${esc(job.title)}</h1>
          ${job.roleLabel ? `<p class="jp-focus">${esc(job.roleLabel)}</p>` : ''}

          <div class="pills">${statusPills(job)}</div>
          ${stillListed(job, job.company, region)}
        </header>

        ${standouts(job, locations)}

        ${job.summary ? `<section>
          <h2>The gist</h2>
          <p class="summary">${esc(job.summary)}</p>
        </section>` : ''}

        ${(job.bullets ?? []).length ? `<section>
          <h2>What you would actually do</h2>
          <ul class="do-list">${(job.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        </section>` : ''}

        ${(job.keySkills ?? []).length ? `<section>
          <h2>Skills mentioned</h2>
          <!-- A CHIP THAT DOES SOMETHING. These were five grey words that
               ended the reader's journey; each is now either a real /skills/
               page or, for a skill too thin to have one, a search of this
               board. The facet page is preferred BECAUSE IT IS A PAGE: ?q= is
               a query string, which Google will not index as its own URL, so a
               chip pointing there passes nothing on. With ~700 job pages each
               linking to up to five skill pages, this is the largest internal
               linking signal the site has. -->
          <div class="chips">${(job.keySkills ?? []).map((sk) => {
            const slug = facetSlug(sk);
            const href = skillPages.has(slug)
              ? regionHref(`/skills/${slug}`, region)
              : regionHref(`/?q=${encodeURIComponent(sk)}`, region);
            return `<a class="chip" href="${href}">${esc(sk)}</a>`;
          }).join('')}</div>
        </section>` : ''}

        <section>
          <h2>How to apply</h2>
          <div class="apply-band">
            <p>${apply ? '' : 'Apply through the original posting. '}Internships ${esc(region.inName)} often collect hundreds of applicants within a day, so <strong>applying early matters more than applying perfectly</strong>. A half-finished application sent on the first morning beats a polished one sent on the third.</p>
          </div>
          <p class="note">This summary was written by InternDoor from the public posting, and is not the employer's own wording. The linked posting is the source of truth — check it before you apply.</p>
        </section>
      </div>

      <aside class="jp-side">
        <div class="jp-card">
          ${apply ? `<div class="jp-card-top">
            <span class="apply-glow">${applyBtn}</span>
            <p class="jp-card-note">Opens ${where} in a new tab. Free — we never ask for a fee.</p>
          </div>` : ''}
          <!-- The tracker mount. EMPTY IN THE HTML and filled by page.js from
               these attributes, because what belongs here depends entirely on
               what is in the reader's own browser: a page that shipped a
               "Track" button would show it to somebody who tracked this role
               last week. The data is carried on the element rather than read
               back out of the JSON-LD, which is written for a search engine and
               is not a place to keep an application's own fields.

               THE TWO URLs GO THROUGH safeUrl, exactly like the Apply button
               above. It rejects anything that is not http(s), so a javascript:
               URL on a posting cannot reach this attribute — from which page.js
               would copy it into the store and the tracker would later render
               it as an href on a page the reader trusts. safeUrl escapes as
               well as filters, so these are not wrapped in esc() a second
               time. test/pages.test.mjs catches a regression here. -->
          <div class="trk-mount" data-id="${esc(job.id)}" data-company="${esc(job.company)}"
               data-title="${esc(job.title)}" data-location="${esc(job.location ?? '')}"
               data-url="${safeUrl(job.url)}" data-applyurl="${safeUrl(job.applyUrl)}"
               data-slug="${esc(jobSlug(job))}" data-region="${esc(region.code)}"
               data-path="${esc(regionPath(region.code))}"
               data-apps="${esc(regionHref('/applications', region))}"></div>
          <dl class="facts">
            ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('\n            ')}
          </dl>
          <!-- The one conversion point on the page, and it used to be a single
               grey-green line that read as a footnote to the facts above it.
               It is the only thing here that survives the role closing, so it
               gets a heading, a sentence and a real target. -->
          <a class="jp-sub" href="${regionHref('/alerts', region)}">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>
            <span class="jp-sub-t">
              <strong>Get internships like this first</strong>
              <!-- inName carries its own preposition ("in the US"), so it goes
                   AFTER the noun. Stripping the "in " to put it before gave
                   "New the US roles". -->
              <em>New engineering internships ${esc(region.inName)}, the minute they are posted.</em>
            </span>
            <i class="jp-sub-go" aria-hidden="true">&rarr;</i>
          </a>
        </div>
      </aside>
    </div>

    ${others.length ? `<section class="strip">
      <div class="strip-head">
        <h2>More at ${esc(job.company)}</h2>
        <a class="strip-more" href="${hub}">All ${esc(job.company)} roles →</a>
      </div>
      <div class="tiles">${others.map((j) => tile(j, { showCompany: false, region })).join('')}</div>
    </section>` : ''}

    <section class="strip" id="fresh" hidden data-feed="${regionHref('/data/jobs.json', region)}">
      <div class="strip-head">
        <h2>Just landed on InternDoor</h2>
        <a class="strip-more" href="${regionHref('/', region)}">See all live roles →</a>
      </div>
      <div class="tiles" id="fresh-list"></div>
    </section>
  </div>
</main>

${apply ? `<div class="dock" id="dock" aria-hidden="true">
  <div class="dock-t"><b>${esc(job.title)}</b><span>${esc(job.company)}</span></div>
  <a class="btn-apply" href="${apply}" target="_blank" rel="nofollow noopener" tabindex="-1"><span>Apply</span><em aria-hidden="true"></em></a>
</div>` : ''}
${foot({
    headline: 'Do not let the next one pass you by',
    sub: `Every engineering internship ${region.inName}, on the board within minutes of going live.`,
    region,
  })}`;
}

/**
 * A company hub — the page with a real chance of ranking for "<company>
 * internship".
 *
 * PERMANENT. This page outlives the postings on it. It used to be built only
 * from live jobs and deleted the moment an employer's last one aged out, which
 * 404'd a URL Google had indexed and threw away months of accumulated ranking;
 * some flapped in and out four times. Job pages still expire — Google's
 * JobPosting rules require that — but the hub stays.
 *
 * `past` is what keeps an empty hub from being thin content: a page saying only
 * "no live openings" is a page Google is right to ignore. Past roles are
 * plain text with NO markup and NO links, deliberately — describing an expired
 * posting as a live one is the thing that earns a structured-data manual
 * action, and the whole domain pays for that.
 */
/**
 * Aggregate everything we know about one employer, across their LIVE and their
 * closed postings.
 *
 * This exists because a company hub had 122 visible words, of which about 25
 * were unique to the company — the rest was nav, footer and the Telegram CTA.
 * That is the page Google shows for "<company> internships", and it was losing
 * to Glassdoor and the employer's own careers site because there was nothing on
 * it. The aggregate is the only content here nobody else has: we watched these
 * postings go up and recorded what they asked for.
 *
 * SAMPLE SIZE IS THE WHOLE PROBLEM. Of 242 tracked employers, 123 have exactly
 * ONE posting and only 73 have three or more. So this returns counts and lets
 * the caller choose its wording — "typically" is a lie at n=1, and inventing
 * confident statistics for a single data point is worse than saying nothing.
 */
/** How many employers a hub links sideways to, and how deep the skill
 *  comparison goes. The long tail of a skill tally is noise — past a dozen,
 *  every employer overlaps every other on "communication" and "teamwork". */
const RELATED_MAX = 8;
const RELATED_SKILLS = 12;
/* Cosine similarity below this is not a similarity. Tuned against the live
   boards: it keeps Qualcomm-Infineon and drops Infineon-Eli Lilly. */
const RELATED_FLOOR = 0.12;

/**
 * The live roles a hub actually shows: indexable, one card per distinct role.
 * Extracted so `employerIndex` and `renderCompanyPage` cannot drift on what
 * "this hub has a live role" means — the same reason jobPageSlug is pinned
 * across its three copies.
 */
function hubLive(jobs) {
  const seen = new Set();
  return newestFirst((jobs ?? []).filter(isIndexable)).filter((j) => {
    const k = roleKey(j);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Is a company hub worth indexing?
 *
 * THE ONE PLACE THAT DECIDES. `renderCompanyPage` writes the `noindex` from it
 * and `writeSitemap` lists the URL from it, so the two cannot disagree — they
 * did, and the sitemap was asking Google to crawl four pages the markup told it
 * to ignore. Counted off the SHAPED lists (`hubLive`/`hubHistory`), never the
 * raw rows: what makes a hub thin is how many distinct roles it can show, not
 * how many times the employer reposted one title.
 */
function hubIndexable(jobs, past) {
  const live = hubLive(jobs);
  return live.length > 0 || hubHistory(live, past).length >= 2;
}

/** The past roles a hub actually shows: newest first, one per title, capped. */
function hubHistory(live, past) {
  const seen = new Set(live.map((j) => String(j.title ?? '').toLowerCase()));
  const out = [];
  for (const p of [...(past ?? [])].sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0))) {
    const k = String(p.title ?? '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length === 12) break;
  }
  return out;
}

/**
 * One pass over every employer on a board, so the hubs can link to each other.
 *
 * WHY THIS EXISTS. A company hub linked to no other hub, and the homepage links
 * to none at all — its list is built by JavaScript — so every one of ~340 hubs
 * sat at crawl depth 2, reachable only through /companies/, which divides what
 * it has 340 ways and is itself one link from home. Hubs are the pages that can
 * realistically rank for "<company> internship" and the only asset here that
 * accumulates authority over years, because job pages expire by design. Leaving
 * them as crawl dead ends was the largest on-site thing still unfixed.
 *
 * The skill set is taken from the employer's WHOLE TRACKED HISTORY, not their
 * live roles, and that is a churn decision rather than a quality one. History
 * only grows, so a related list moves rarely; derived from live roles it would
 * rewrite the block on every publish, across every hub that lists that
 * employer — the same amplified churn that made `validThrough` and the
 * directory's title expensive.
 */
export function employerIndex(byCompany, pastByCompany = new Map()) {
  const index = new Map();
  for (const company of new Set([...byCompany.keys(), ...pastByCompany.keys()])) {
    const jobs = byCompany.get(company) ?? [];
    const past = pastByCompany.get(company) ?? [];
    const live = hubLive(jobs);
    // Raw and lowercase on purpose: this is for MATCHING, not display, so the
    // title-casing and phrase-dedup companyProfile does for chips is wasted
    // work here and would only make two spellings of one skill miss.
    const tally = new Map();
    for (const j of [...jobs, ...past]) {
      for (const raw of [].concat((j.keySkills?.length ? j.keySkills : j.skills) ?? [])) {
        const v = String(raw ?? '').trim().toLowerCase();
        if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
      }
    }
    const skills = new Set([...tally.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, RELATED_SKILLS).map(([v]) => v));
    index.set(company, {
      skills,
      // MUST match renderCompanyPage's own rule, which is why all three
      // callers go through `hubIndexable`. Linking to a noindex hub spends a
      // link on a page that cannot rank and drops the reader on an empty one.
      indexable: hubIndexable(jobs, past),
      live: live.length,
    });
  }

  /* WEIGHT EACH SKILL BY HOW RARE IT IS, or the matching is worthless — this
     was measured, not assumed. Counting shared skills flat, Infineon came back
     related to Tower Research Capital and Amazon to a four-person label shop,
     because nearly every employer here names python, c++, sql and git, so the
     overlap was reporting "both are software companies" rather than anything
     about either of them. Inverse document frequency reduces those to almost
     nothing and lets verilog, vhdl and rtl carry the comparison, which is what
     actually makes two employers alternatives for the same student.

     A skill EVERY employer names scores exactly zero (log 1). Dropping it is an
     optimisation, not a behaviour change — a zero weight contributes nothing to
     either the dot product or the norm — and a mutation run confirms removing
     the line changes no result. It is kept because it says what is meant. */
  const df = new Map();
  for (const e of index.values()) for (const sk of e.skills) df.set(sk, (df.get(sk) ?? 0) + 1);
  const n = index.size || 1;
  for (const e of index.values()) {
    e.w = new Map();
    let sq = 0;
    for (const sk of e.skills) {
      const idf = Math.log(n / (df.get(sk) ?? 1));
      if (idf <= 0) continue;
      e.w.set(sk, idf);
      sq += idf * idf;
    }
    /* Cosine, so the score is an ANGLE between two employers rather than a
       count. Plain overlap rewarded whoever named the most skills, and Jaccard
       over-rewarded whoever named the fewest — a firm with three skills scored
       higher on one shared word than a genuine match did on four. */
    e.norm = Math.sqrt(sq);
  }
  return index;
}

/**
 * The employers whose internships ask for the most of the same skills.
 *
 * Scored by Jaccard rather than raw overlap so a broad employer naming twelve
 * skills does not turn up on every list purely for naming more of them. Ties
 * break on the shared count and then on the name, so the output is
 * deterministic — a list that reshuffled between two identical publishes would
 * be churn dressed up as content.
 */
export function relatedEmployers(company, index, limit = RELATED_MAX) {
  const me = index.get(company);
  if (!me?.norm) return [];
  const scored = [];
  for (const [other, o] of index) {
    if (other === company || !o.indexable || !o.norm) continue;
    let dot = 0;
    let shared = 0;
    for (const [sk, wi] of me.w) {
      const wj = o.w.get(sk);
      if (wj) { dot += wi * wj; shared += 1; }
    }
    const score = dot / (me.norm * o.norm);
    /* A floor, because a weak match is worse than none here. The block is
       headed "similar employers" and a reader who clicks through to something
       unrelated learns the label cannot be trusted — on a page whose whole job
       is to be worth trusting. Below this, the hub simply shows no block. */
    if (score < RELATED_FLOOR) continue;
    scored.push({ company: other, shared, score });
  }
  scored.sort((a, b) => b.score - a.score || b.shared - a.shared || a.company.localeCompare(b.company));
  return scored.slice(0, limit).map(({ company: c, shared }) => ({ company: c, shared }));
}

export function companyProfile(all, region = DEFAULT_REGION) {
  const rows = (all ?? []).filter(Boolean);
  const tally = (pick) => {
    const m = new Map();
    for (const j of rows) {
      for (const raw of [].concat(pick(j) ?? [])) {
        const v = String(raw ?? '').trim();
        if (v) m.set(v, (m.get(v) ?? 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }));
  };

  // keySkills is the model's short list; skills is the raw extraction. Prefer
  // the short list where it exists, or one verbose posting swamps the tally.
  //
  // The raw values arrive lowercase and overlapping — a real Infineon tally read
  // "python 4 ... python programming 2", which is one skill printed twice. Drop
  // any phrase that already contains a more-common one as a whole word, and
  // title-case what survives so the chips do not read like log output.
  const rawSkills = tally((j) => (j.keySkills?.length ? j.keySkills : j.skills));
  const skills = [];
  for (const cand of rawSkills) {
    const covered = skills.some((kept) => {
      const re = new RegExp(`\\b${kept.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return re.test(cand.value);
    });
    if (!covered) skills.push({ ...cand, value: titleCaseSkill(cand.value) });
  }
  const dates = rows.map((j) => j.postedAt).filter(Boolean).sort((a, b) => a - b);
  const applicants = rows.map((j) => Number(j.applicants))
    .filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);

  return {
    n: rows.length,
    skills,
    // EVERY office, not the first comma-segment. With `cityOf` here the hub
    // contradicted itself on the first real render: the questions block read
    // "Chicago and New York" off the live roles while "Where they hire" read
    // "was based in Chicago", because one counted both offices and the other
    // silently dropped the second.
    cities: tally((j) => placesOf(j.location, region)),
    degrees: tally((j) => j.degreeLevel),
    modes: tally((j) => modeText(j)),
    durations: tally((j) => durationText(j)),
    roleKinds: tally((j) => j.roleLabel),
    stipends: rows.map((j) => stipendText(j)).filter(Boolean),
    medianApplicants: applicants.length ? applicants[Math.floor(applicants.length / 2)] : null,
    firstPostedAt: dates[0] ?? null,
    lastPostedAt: dates[dates.length - 1] ?? null,
  };
}

/**
 * Skills are stored lowercase. Title-case for display, but leave anything
 * already carrying capitals or digits alone — "SQL", "C++", "AWS" and "Node.js"
 * are all wrong after a naive capitalise, and so is "OOPS" if it is lowercased.
 */
const SKILL_UPPER = new Set(['sql', 'aws', 'gcp', 'api', 'apis', 'css', 'html', 'ml', 'ai', 'nlp', 'ui', 'ux', 'oops', 'orm', 'jvm', 'cad', 'iot', 'rtl', 'fpga', 'vlsi', 'etl', 'llm', 'llms', 'ci/cd', 'saas', 'rest', 'crm', 'erp', 'qa', 'os', 'db', 'ds']);
function titleCaseSkill(raw) {
  return String(raw ?? '').trim().split(/\s+/).map((w) => {
    const low = w.toLowerCase();
    if (SKILL_UPPER.has(low)) return low.toUpperCase();
    // Anything carrying capitals, digits or punctuation after the first letter
    // keeps its own shape — Node.js, PyTorch, S3, C++ — but the FIRST letter is
    // still raised, because the store holds them lowercase and "c++" rendered
    // as a chip reading "c++".
    const tail = /[A-Z0-9+#.]/.test(w.slice(1)) ? w.slice(1) : low.slice(1);
    return w.charAt(0).toUpperCase() + tail;
  }).join(' ');
}

/**
 * " in India" unless the employer is already called that. "HARMAN India" and
 * "Accenture in India" are real names on real postings, and appending the
 * region to them rendered "at HARMAN India in India".
 */
export function placeSuffix(company, region) {
  const place = String(region?.inName ?? '').replace(/^in /, '').trim();
  if (!place) return '';
  const name = String(company ?? '').toLowerCase().trim();
  return name.endsWith(place.toLowerCase()) ? '' : ` ${esc(region.inName)}`;
}

/** A plain-English list: "a, b and c". */
function andList(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a[0] ?? '';
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

/**
 * The evergreen half of a company hub.
 *
 * Everything here survives a posting closing, which is the point: job pages
 * expire and this does not, so it is the only part of the site that can
 * accumulate authority for "<company> internships" over years.
 */
function profileSections(company, prof, region, { skipDegrees = false, lede = '' } = {}) {
  if (!prof.n) return '';
  const co = esc(company);
  const many = prof.n >= 3;
  const out = [];

  // --- what they ask for. Works at n=1 and is the single most useful block:
  // "what skills do I need" is the question behind the query.
  if (prof.skills.length >= 3) {
    out.push(`<section class="strip">
      <div class="strip-head"><h2>Skills ${co} asks for</h2></div>
      <p class="cp-note">Taken from ${many ? `the ${prof.n} ${co} internships we have tracked` : `the ${co} ${prof.n === 1 ? 'internship' : 'internships'} we have tracked`} ${esc(region.inName)} &mdash; these are the skills named in the postings themselves, not a generic list.</p>
      <ul class="cp-chips">${prof.skills.slice(0, 14).map((s) =>
        `<li>${esc(s.value)}${many && s.count > 1 ? `<b>${s.count}</b>` : ''}</li>`).join('')}</ul>
    </section>`);
  }

  // --- who can apply. Students filter on this harder than on anything else.
  // Skipped on the company hub, where `eligibilityBlock` answers the same
  // question from the LIVE roles as three counts rather than as the run-on
  // "Eligibility stated on X postings: UG/PG, PG and UG." that this produced.
  if (prof.degrees.length && !skipDegrees) {
    out.push(`<section class="strip">
      <div class="strip-head"><h2>Who ${co} accepts</h2></div>
      <p class="cp-note">Eligibility stated on ${co} postings: ${esc(andList(prof.degrees.map((d) => d.value)))}.</p>
    </section>`);
  }

  // --- where. One city is still a fact worth stating; several is a real answer.
  if (prof.cities.length) {
    out.push(`<section class="strip">
      <div class="strip-head"><h2>Where ${co} hires interns</h2></div>
      <p class="cp-note">${prof.cities.length === 1
        ? `Every ${co} internship we have seen ${esc(region.inName)} was based in ${esc(prof.cities[0].value)}.`
        : `${co} has posted internships in ${esc(andList(prof.cities.slice(0, 6).map((c) => c.value)))}${prof.cities.length > 6 ? ` and ${prof.cities.length - 6} more` : ''}.`}</p>
      ${many && prof.cities.length > 1 ? `<ul class="cp-chips">${prof.cities.slice(0, 10).map((c) =>
        `<li>${esc(c.value)}${c.count > 1 ? `<b>${c.count}</b>` : ''}</li>`).join('')}</ul>` : ''}
    </section>`);
  }

  // --- the numbers. Held back below three postings, where an "average" is a
  // single observation wearing a hat.
  if (many) {
    // A rate needs a span. Six postings inside one fortnight is not "6 a month",
    // it is six postings inside one fortnight — the tracked window is younger
    // than the claim. Only quote a rate over 60 days or more.
    const spanMs = prof.firstPostedAt && prof.lastPostedAt ? prof.lastPostedAt - prof.firstPostedAt : 0;
    const months = spanMs >= 60 * 86400000 ? spanMs / (30 * 86400000) : null;
    const facts = [
      ['Roles tracked', String(prof.n)],
      ['Since', prof.firstPostedAt ? esc(monthLabel(prof.firstPostedAt, region)) : null],
      months ? ['Posting rate', `about ${(prof.n / months).toFixed(1)} a month`] : null,
      prof.cities.length > 1 ? ['Locations', String(prof.cities.length)] : null,
      prof.modes.length ? ['Usual mode', esc(prof.modes[0].value)] : null,
      prof.durations.length ? ['Usual length', esc(prof.durations[0].value)] : null,
      prof.stipends.length ? ['Stipend seen', esc(prof.stipends[0])] : null,
      prof.medianApplicants ? ['Typical applicants', `${prof.medianApplicants}`] : null,
    ].filter((f) => f && f[1]);
    out.push(`<section class="strip">
      <div class="strip-head"><h2>${co} internships at a glance</h2></div>
      ${lede ? `<p class="hub-lede">${lede}</p>` : ''}
      <dl class="cp-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
    </section>`);
  }

  // A hub below three postings has no at-a-glance panel to carry the tracking
  // sentence, and that is exactly the hub with the least on it — so it lands
  // on its own rather than being dropped with the panel. It keeps a heading:
  // 143 of 255 hubs have a single live role, so this is the COMMON layout, and
  // a paragraph floating under a rule with no label reads as leftover text.
  if (lede && !many) {
    out.push(`<section class="strip">
      <div class="strip-head"><h2>How this page stays current</h2></div>
      <p class="hub-lede">${lede}</p>
    </section>`);
  }

  return out.join('\n    ');
}

/**
 * The pay range across a set of postings, or null when a single range would be
 * a lie.
 *
 * Two things make it a lie, and both occur in the live data. MIXED CURRENCIES
 * are obvious. MIXED PERIODS are not: an India posting states ₹25,000 a month
 * and a US one $150,000 a year, and "₹25,000 – $150,000" is arithmetic
 * performed on two different questions. A range is only offered when every
 * contributing figure agrees on both.
 */
export function payRange(jobs) {
  const nums = [];
  let cur = null;
  let period = null;
  for (const j of jobs ?? []) {
    const s = stipendText(j);
    if (!s) continue;
    const sym = (s.match(/[₹$£€]/) || [])[0] ?? null;
    if (!sym) continue;
    const per = (s.match(/month|year|annual|week/i) || [null])[0]?.toLowerCase() ?? null;
    if (cur && sym !== cur) return null;
    if (period && per && per !== period) return null;
    cur = sym; period = period ?? per;
    for (const m of s.matchAll(/[\d,]+/g)) {
      const n = Number(String(m[0]).replace(/,/g, ''));
      if (Number.isFinite(n) && n >= 1000) nums.push(n);
    }
  }
  if (!nums.length) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const fmt = (n) => cur === '₹'
    ? (n >= 100000 ? `₹${(n / 100000).toFixed(n % 100000 ? 1 : 0)}L` : `₹${n.toLocaleString('en-IN')}`)
    : `${cur}${n >= 1000 ? `${Math.round(n / 1000)}k` : n}`;
  // lo and hi are handed back separately as well as joined. A caller that
  // wants to emphasise the two ends has to be able to wrap each one — splitting
  // the joined string and injecting tags into it means escaping markup you just
  // wrote, which rendered "$150k</b> to <b>$250k" as visible text on the first
  // real page this produced.
  return { text: lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`, lo: fmt(lo), hi: fmt(hi), count: nums.length };
}

/**
 * How many live roles each degree level can apply to.
 *
 * A level nobody stated renders as "not stated", NEVER as a cross. The
 * postings did not say undergraduates are excluded — they said nothing, and
 * turning silence into a refusal would talk a student out of an application
 * they were entitled to make. PhD is counted only from `degreeText` saying so
 * outright, because "PG" covers a master's and a doctorate together and
 * splitting it would be inventing the distinction.
 */
export function eligibilityCounts(live) {
  const rows = (live ?? []).filter(Boolean);
  const lvl = (j) => String(j.degreeLevel ?? '').toUpperCase();
  const txt = (j) => String(j.degreeText ?? '');
  return {
    total: rows.length,
    ug: rows.filter((j) => /\bUG\b/.test(lvl(j)) || /bachelor|undergrad|b\.?tech|b\.?e\b/i.test(txt(j))).length,
    pg: rows.filter((j) => /\bPG\b/.test(lvl(j)) || /master|m\.?tech|m\.?s\b|postgrad/i.test(txt(j))).length,
    phd: rows.filter((j) => /ph\.?\s?d|doctora/i.test(txt(j)) || /ph\.?\s?d/i.test(String(j.title ?? ''))).length,
  };
}

/**
 * One live role, as a card that can be acted on.
 *
 * Deliberately NOT `tile()`. That shape is mirrored byte for byte by
 * `tileHtml` in page.js for the "just landed" strip and is reused on job
 * pages, so widening it would change three surfaces to fix one. This card
 * exists because the hub is the only one of the three where the reader has
 * already chosen the employer and is now choosing a ROLE — so it carries the
 * facts that decide that (pay, place, start, degree) and an explicit CTA,
 * where a tile carries only enough to be worth a click.
 */
function roleCard(job, { region = DEFAULT_REGION, locations = 1 } = {}) {
  const posted = job.postedAt ?? job.firstSeenAt;
  const verified = verifiedAt(job);
  const money = stipendText(job);
  const places = placesOf(job.location, region);
  const start = startDate(job);
  const degree = degreeLabel(job);

  const facts = [
    money ? `<span class="f-item is-cash">${esc(money)}</span>` : '',
    locations > 1
      ? `<span class="f-item">${locations} locations</span>`
      : places.length ? `<span class="f-item">${esc(places.join(' · '))}</span>` : '',
    start ? `<span class="f-item">Starts ${esc(start)}</span>` : '',
    degree ? `<span class="f-item">${esc(degree)}</span>` : '',
    modeText(job) ? `<span class="f-item">${esc(modeText(job))}</span>` : '',
  ].filter(Boolean).join('');

  // Absolute date in the file, rewritten to "27d ago" by page.js — a relative
  // label baked in here would rewrite every hub on nearly every 30-minute run.
  const age = posted
    ? `<span class="rc-age" data-ago="${posted}">Posted <time datetime="${isoDay(posted)}">${esc(dayLabel(posted, region))}</time></span>`
    : '';
  /* EVERY CARD SAYS WHETHER THE ROLE IS OPEN, not just the 27% we can confirm.
     This used to render only for ATS rows, so on the India hubs — which are
     almost entirely LinkedIn — a list of roles carried no open/closed signal at
     all and read as an archive of past postings. The unverified tier is the
     board's own rule rather than a check we did, and it says so. */
  const st = openState(job);
  const vfy = st.tier === 'verified'
    /* No data-ago: `verified` is lastSeenAt, which moves every poll, so shipping
       it exact rewrote every hub on every publish. The <time> beside it was
       already day-granular and stable — this attribute was the whole churn. */
    ? `<span class="vfy is-verified"><i aria-hidden="true"></i>Open &middot; confirmed <time datetime="${isoDay(verified)}">${esc(dayLabel(verified, region))}</time></span>`
    : `<span class="vfy is-likely" title="We list a role only while we believe it is still open."><i aria-hidden="true"></i>Likely open</span>`;

  return `<a class="role-card" href="${regionHref(`/jobs/${jobSlug(job)}`, region)}">
        <span class="rc-t">${esc(job.title)}</span>
        ${job.roleLabel ? `<span class="rc-sub">${esc(job.roleLabel)}</span>` : ''}
        ${facts ? `<span class="rc-facts">${facts}</span>` : ''}
        <span class="rc-foot">
          <span class="rc-when">${age}${vfy}</span>
          <span class="rc-go">View role <em aria-hidden="true">→</em></span>
        </span>
      </a>`;
}

/**
 * The four questions a searcher arrived with, answered before the list.
 *
 * This is the block that earns the compression: the hero it replaces spent the
 * same vertical space on a headline the reader had already read in the search
 * result. Every cell is withheld rather than guessed — a hub with no stated pay
 * simply has three cells.
 */
function answerBar(live, prof, region) {
  const pay = payRange(live);
  const paid = (live ?? []).filter((j) => stipendText(j)).length;
  const eg = eligibilityCounts(live);
  const levels = [eg.ug ? 'Bachelor’s' : '', eg.pg ? 'Master’s' : '', eg.phd ? 'PhD' : ''].filter(Boolean);
  const places = [...new Set((live ?? []).flatMap((j) => placesOf(j.location, region)))];
  const modes = [...new Set((live ?? []).map((j) => modeText(j)).filter(Boolean))];

  // The freshest confirmation across the live roles. One badge for the page is
  // right because they come off ONE board read in one pass.
  const verified = (live ?? []).map(verifiedAt).filter(Boolean).sort((a, b) => b - a)[0] ?? null;

  /* THE SUB-LINE GOES INSIDE THE <dd>, NOT BESIDE IT.
     A <div> inside a <dl> may contain only <dt> and <dd> — that is the whole
     reason the wrapper is allowed there at all — so a sibling <p> makes the
     list malformed on every hub that renders one. axe reports it as
     `definition-list`, serious, and it was on all ~170 of them. A <dd> is flow
     content, so the paragraph is valid once it is inside; and it belongs to
     that answer anyway ("varies by role" describes the answer above it, not
     the grid cell). `.ans p` in page.css resets the weight and tracking the
     <dd> now passes down to it. */
  const cell = (k, v, sub, cls = '') => `<div class="ans${cls}">
        <dt>${esc(k)}</dt><dd>${v}${sub ? `<p>${sub}</p>` : ''}</dd></div>`;

  const cells = [
    pay ? cell('They pay', esc(pay.text),
      paid === live.length ? `on all ${live.length} open role${live.length === 1 ? '' : 's'}`
        : `stated on ${paid} of ${live.length} roles`, ' is-cash') : '',
    levels.length ? cell('Who they take', esc(levels.join(' · ')),
      levels.length > 1 ? 'varies by role' : '') : '',
    places.length ? cell('Where', esc(places.slice(0, 3).join(' · ')),
      modes.length === 1 ? esc(modes[0].toLowerCase()) : '') : '',
    verified ? cell('Last verified',
      `<span><time datetime="${isoDay(verified)}">${esc(dayLabel(verified, region))}</time></span>`,
      'on the employer’s own careers page', ' is-live') : '',
  ].filter(Boolean);

  // Two cells is a fact list; one is an orphan sitting where a grid should be.
  return cells.length >= 2 ? `<dl class="hub-answer">${cells.join('')}</dl>` : '';
}

/**
 * The questions block.
 *
 * Real headings with real answers, and NO FAQPage markup — Google restricted
 * those rich results to government and health sites in 2023, so the schema buys
 * nothing while inviting a structured-data problem on a domain whose whole
 * risk model is the JobPosting manual action. What earns the featured snippet
 * and the AI Overview citation is the visible structure, which is free.
 *
 * Every answer is assembled from stored facts. A question we cannot answer
 * from the data is dropped, and below two survivors the block is dropped
 * whole — the same thin-content rule the at-a-glance panel follows.
 */
function qaBlock(company, live, prof, region) {
  const co = esc(company);
  const pay = payRange(live);
  const paid = (live ?? []).filter((j) => stipendText(j)).length;
  const eg = eligibilityCounts(live);
  // Sorted by the date they name, not by which posting happened to be newest —
  // the first render read "Aug 2027, Jun 2027 and Feb 2027", which looks like a
  // list that lost its sort.
  const starts = [...new Set((live ?? []).map(startDate).filter(Boolean))]
    .sort((a, b) => startKey(a) - startKey(b));
  const places = [...new Set((live ?? []).flatMap((j) => placesOf(j.location, region)))];
  const modes = [...new Set((live ?? []).map((j) => modeText(j)).filter(Boolean))];

  const qa = [
    pay ? [`Does ${co} pay its interns?`,
      `${paid === live.length ? 'Yes — every one of the' : `${paid} of the`} ${live.length} open role${live.length === 1 ? '' : 's'} state${paid === 1 && paid === live.length ? 's' : ''} pay, ${pay.lo === pay.hi ? `at <b>${esc(pay.lo)}</b>` : `ranging from <b>${esc(pay.lo)}</b> to <b>${esc(pay.hi)}</b>`}.`] : null,
    // "for a Old Mission Capital internship" — an employer name is as likely to
    // start with a vowel as not, and the article is wrong half the time. Naming
    // the employer with "at" sidesteps it and reads better anyway.
    (eg.ug || eg.pg || eg.phd) ? [`What degree do you need at ${co}?`,
      [eg.ug ? `<b>${eg.ug} of ${eg.total}</b> open role${eg.ug === 1 ? '' : 's'} accept undergraduates` : '',
        eg.pg ? `<b>${eg.pg}</b> accept a master’s` : '',
        eg.phd ? `<b>${eg.phd}</b> ask for a PhD` : ''].filter(Boolean).join(', ')
      + '. The exact requirement is on each posting.'] : null,
    places.length ? [`Where are ${co} internships based?`,
      `${places.length === 1 ? `Every open role is in <b>${esc(places[0])}</b>` : `<b>${esc(andList(places.slice(0, 4).map(esc)))}</b>`}.${modes.length === 1 ? ` All are ${esc(modes[0].toLowerCase())}.` : ''}`] : null,
    starts.length ? [`When do ${co} internships start?`,
      `${starts.length === 1 ? `The open role starts <b>${esc(starts[0])}</b>` : `Start dates on the open roles are <b>${esc(andList(starts.map(esc)))}</b>`}.`] : null,
  ].filter(Boolean);

  if (qa.length < 2) return '';
  return `<section class="strip">
      <div class="strip-head"><h2>Questions students ask</h2></div>
      <div class="qa">${qa.map(([q, a]) =>
        `<div><h3>${q}</h3><p>${a}</p></div>`).join('')}</div>
    </section>`;
}

/** Who can apply, as three counts rather than a run-on sentence. */
function eligibilityBlock(company, live) {
  const eg = eligibilityCounts(live);
  if (!eg.total || !(eg.ug || eg.pg || eg.phd)) return '';
  const cell = (k, n) => `<div${n ? '' : ' class="is-quiet"'}>
        <dt>${esc(k)}</dt>
        <dd>${n ? `<b aria-hidden="true">✓</b> ${n} of ${eg.total} role${eg.total === 1 ? '' : 's'}` : 'Not stated'}</dd></div>`;
  return `<section class="strip">
      <div class="strip-head"><h2>Who ${esc(company)} accepts</h2></div>
      <dl class="eg">${cell('Undergraduate', eg.ug)}${cell('Master’s', eg.pg)}${cell('PhD', eg.phd)}</dl>
      <p class="cp-note">Taken from each posting’s own wording. A level reading &ldquo;not stated&rdquo; was not ruled out &mdash; those postings simply did not say. Check the individual role for graduation-year requirements.</p>
    </section>`;
}

export function renderCompanyPage(company, jobs, past = [], logo = '', { region = DEFAULT_REGION, alsoIn = [], related = [] } = {}) {
  const url = regionUrl(`/companies/${companySlug(company)}`, region);

  /**
   * A hub DOES have a regional equivalent, and it is the page that decides
   * whether an American searching "<company> internships" is shown the American
   * board or India's.
   *
   * This is deliberately narrower than the rule for job pages, which carry no
   * hreflang and must not: a specific vacancy in Dublin is not a regional
   * variant of a different vacancy in Bengaluru, and saying so tells Google two
   * unrelated URLs are the same page. A HUB is the opposite case — same
   * employer, same question ("does this company take interns"), scoped to the
   * reader's market. That is exactly what hreflang is for.
   *
   * Emitted ONLY for regions where this employer is actually live, because
   * hreflang has to be reciprocal: pointing at a hub that does not exist, or
   * that does not point back, is ignored at best. `alsoIn` comes from the same
   * cross-region index `foreign` is built from, so both sides compute the same
   * set and the links agree in both directions.
   *
   * The limit of this, worth knowing before expecting too much: it can only
   * route to a page that EXISTS. eBay has two India postings and none in the
   * US, so there is no /us/companies/ebay for Google to prefer and no amount of
   * markup creates one. That is a supply problem, not a routing one.
   */
  const alternates = alsoIn.length ? [region, ...alsoIn] : null;

  // One tile per ROLE. An employer that files one opening in every city was
  // rendering a tile each: Procter & Gamble's hub repeated
  // "Engineering Internship, Summer 2027" twenty-two times, IBM's seven.
  //
  // This is the page Google serves for "<company> internships", and it is the
  // only asset on this site that accumulates authority over years — job pages
  // expire by design. Twenty-two identical rows is thin, repetitive content on
  // exactly the page that can least afford it. Collapsed, the same hub reads as
  // the handful of distinct openings the employer actually has, and each tile
  // says how many cities it covers.
  //
  // The newest posting of each role represents it, so the hub still leads with
  // the freshest thing the employer has done.
  const liveAll = newestFirst(jobs.filter(isIndexable));
  const roleCount = new Map();
  for (const j of liveAll) roleCount.set(roleKey(j), (roleCount.get(roleKey(j)) ?? 0) + 1);
  // Both through the shared helpers, so `employerIndex` decides a hub is
  // indexable on exactly the rows this page decides to render. History is
  // newest first, one per title, and capped — a hub is a landing page, not an
  // archive, and an employer reposting the same role monthly would otherwise
  // fill it with one title twelve times over.
  const live = hubLive(jobs);
  const history = hubHistory(live, past);

  // The profile spans every posting we hold for this employer — the unfiltered
  // `jobs`, not `live`, because a role dropped by isIndexable for having one
  // bullet still told us a city, a skill list and an eligibility line.
  const profile = companyProfile([...(jobs ?? []), ...(past ?? [])], region);

  // Indexable when there is something worth indexing. A hub with no live roles
  // and nothing to show behind them is exactly the thin page to keep out.
  // Through `hubIndexable` so the sitemap and `employerIndex` cannot disagree
  // with this page about its own robots tag; it reshapes `live`/`history`
  // rather than reusing the two above, which is a few hundred rows per publish
  // and the price of there being exactly one copy of the rule.
  const indexable = hubIndexable(jobs, past);

  const where = region.inName.replace(/^in /, '');
  // The live-role COUNT left the title on purpose. It changed on almost every
  // publish, which rewrote the <title> of 150 pages and churned both the commit
  // and the thing Google re-evaluates. It still appears in the description,
  // where freshness belongs and where a rewrite costs nothing.
  const pageTitle = buildTitle([
    `${company} Internships`,
    where ? `in ${where}` : null,
    new Date().getFullYear(),
  ]);
  // Lead with the live count when there is one, then the two facts a searcher
  // is actually weighing: what it asks for and where it is.
  const descTail = [
    profile.skills.length >= 3 ? `Skills asked for: ${profile.skills.slice(0, 4).map((x) => x.value).join(', ')}.` : null,
    profile.cities.length ? `Locations: ${profile.cities.slice(0, 3).map((c) => c.value).join(', ')}.` : null,
  ].filter(Boolean).join(' ');
  const descHead = live.length
    ? `${live.length} live ${company} internship${live.length === 1 ? '' : 's'} ${region.inName}, updated every 30 minutes.`
    : profile.n
      ? `${company} internships ${region.inName}. No live openings today; ${profile.n} tracked so far, updated every 30 minutes.`
      : `${company} internships ${region.inName}, tracked by InternDoor and updated every 30 minutes.`;
  const description = clampWords(`${descHead} ${descTail}`.replace(/\s+/g, ' ').trim(), 155);

  const listLd = {
    '@context': 'https://schema.org/',
    '@type': 'ItemList',
    itemListElement: live.map((j, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: regionUrl(`/jobs/${jobSlug(j)}`, region),
      name: `${j.company} — ${j.title}`,
    })),
  };

  // The trail is already on the page and already crawlable; this is the same
  // three links in the form Google draws a breadcrumb SERP from. It describes
  // navigation, not a vacancy, so it carries none of the JobPosting risk that
  // governs everything else marked up on this site.
  const crumbLd = {
    '@context': 'https://schema.org/',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: regionUrl('/', region) },
      { '@type': 'ListItem', position: 2, name: 'Companies', item: regionUrl('/companies/', region) },
      { '@type': 'ListItem', position: 3, name: company },
    ],
  };

  // CollectionPage ABOUT an Organization, never a bare Organization node. The
  // distinction matters: a bare one asserts this page IS the employer's, which
  // it is not, and that is the kind of claim that gets a domain re-evaluated.
  // "A page about them" is exactly what a hub is.
  const aboutLd = {
    '@context': 'https://schema.org/',
    '@type': 'CollectionPage',
    url,
    name: `${company} internships ${region.inName}`,
    about: {
      '@type': 'Organization',
      name: company,
      ...(logo ? { logo: `${SITE}${logo}` } : {}),
    },
  };

  // Every city on the live roles, not the first comma-segment of each. The old
  // expression read "Chicago, IL or New York, NY" as "Chicago", so a hub
  // claimed one office while a role was open in two.
  const cities = [...new Set(live.flatMap((j) => placesOf(j.location, region)))];

  // The tracking sentence. It used to sit in the hero, above the openings,
  // where it pushed the thing the reader came for below the fold — but the
  // words are the authority this page accumulates, so it MOVES rather than
  // going. Its home is with the at-a-glance panel, which is about the same
  // thing: what we have watched this employer do over time.
  const lede = profile.n >= 3
    ? `We have tracked <b>${profile.n} engineering internships</b> at ${esc(company)}${placeSuffix(company, region)}${profile.firstPostedAt ? ` since ${esc(monthLabel(profile.firstPostedAt, region))}` : ''}. Every new one appears here within minutes of going live.`
    : `Every engineering internship ${esc(company)} posts${placeSuffix(company, region)} appears here within minutes of going live &mdash; this page is checked every 30 minutes.`;

  return `${head({
    title: pageTitle,
    description,
    canonical: url,
    indexable,
    region,
    // No hreflang: an employer hiring in two regions has two hubs carrying
    // different roles, not one page served two ways.
    alternates,
    alternatePath: alternates ? `/companies/${companySlug(company)}` : null,
    extraLd: `<script type="application/ld+json">${jsonLd(crumbLd)}</script>\n`
      + `<script type="application/ld+json">${jsonLd(aboutLd)}</script>\n`
      + (live.length ? `<script type="application/ld+json">${jsonLd(listLd)}</script>\n` : ''),
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${regionHref('/', region)}">Home</a> <i aria-hidden="true">›</i>
      <a href="${regionHref('/companies/', region)}">Companies</a> <i aria-hidden="true">›</i>
      <span>${esc(company)}</span>
    </nav>

    <header class="hub-hero">
      ${crest(company, logo)}
      <h1>${esc(company)} internships ${esc(region.inName)}</h1>
      <span class="pill ${live.length ? 'is-fresh' : ''} hub-live"><i aria-hidden="true"></i>${live.length} open now</span>
    </header>

    ${answerBar(live, profile, region)}

    <section class="strip">
      <!-- The one heading on this page that is not a label but the main event:
           it is the count of roles a reader can apply to right now. The number
           is a lime chip rather than a middot and a digit, so it reads as the
           answer to "is there anything here" from across the page. -->
      <div class="strip-head"><h2 class="h2-lead">Open internships${live.length ? ` <b>${live.length}</b>` : ''}</h2></div>
      ${live.length
        ? `<div class="roles">${live.map((j) => roleCard(j, { region, locations: roleCount.get(roleKey(j)) ?? 1 })).join('')}</div>`
        : `<div class="empty">
             <b>Nothing open today</b>
             <p>${esc(company)} is on our watchlist, so a new posting appears here within minutes of going live. The Telegram channel will tell you the moment it does.</p>
           </div>`}
    </section>

    ${qaBlock(company, live, profile, region)}

    ${eligibilityBlock(company, live)}

    ${profileSections(company, profile, region, { skipDegrees: true, lede })}

    ${history.length ? `<section class="strip">
      <div class="strip-head"><h2>Previously posted</h2></div>
      <p class="past-note">Roles ${esc(company)} has advertised since we started tracking them. These listings have closed &mdash; they are here so you can see what this employer hires for, and how often.</p>
      <ul class="past">${history.map((p) => `
        <li>
          <b>${esc(p.title)}</b>
          ${p.roleLabel ? `<span class="qual">${esc(p.roleLabel)}</span>` : ''}
          ${p.postedAt ? `<time datetime="${isoDay(p.postedAt)}">${esc(monthLabel(p.postedAt, region))}</time>` : ''}
        </li>`).join('')}</ul>
    </section>` : ''}

    ${related.length ? `<section class="strip">
      <div class="strip-head">
        <h2>Similar employers</h2>
        <a class="strip-more" href="${regionHref('/companies/', region)}">All companies &rarr;</a>
      </div>
      <p class="past-note">Companies whose internships ask for the same skills as ${esc(company)}&rsquo;s.</p>
      <!-- NO ROLE COUNT ON THESE CARDS, and that is what makes the block cheap.
           A count would move whenever THAT employer's board moved, rewriting
           every hub that lists them - one employer's ordinary day churning a
           dozen other pages. Without it the block changes only when the related
           SET changes, which tracks slowly-growing history.
           The .dir and .dir-card classes are the directory's own styles and
           are already in page.css, so this adds no stylesheet change and
           nothing new to the PUBLISHED allowlist.
           NO BACKTICKS IN THIS COMMENT: it sits inside a template literal, so
           one would end the literal and the failure is a runtime TypeError
           that node --check cannot see. -->
      <div class="dir">${related.map((r) => `<a class="dir-card" href="${regionHref(`/companies/${companySlug(r.company)}`, region)}">
          ${crest(r.company, r.logo, { cls: 'tile-crest' })}
          <span class="dir-t"><span class="dir-name">${esc(r.company)}</span></span>
        </a>`).join('')}</div>
    </section>` : ''}

    <section class="strip" id="fresh" hidden data-feed="${regionHref('/data/jobs.json', region)}">
      <div class="strip-head">
        <h2>Just landed on InternDoor</h2>
        <a class="strip-more" href="${regionHref('/', region)}">See all live roles →</a>
      </div>
      <div class="tiles" id="fresh-list"></div>
    </section>
  </div>
</main>
${foot({
    headline: `Know before anyone else applies to ${esc(company)}`,
    sub: `One message the minute a new engineering internship goes live ${region.inName}. No email, no account.`,
    region,
  })}`;
}

/**
 * The directory of every company hub.
 *
 * The sitemap tells Google these URLs exist, but a sitemap is a hint, not a crawl
 * path — and the homepage is an empty list filled by JavaScript, so a crawler
 * arriving there finds no links to follow at all. This page is the bridge: one
 * static link from the homepage reaches it, and from here every company hub and
 * then every job page is reachable by following ordinary anchors.
 */
export function renderCompanyIndex(byCompany, pastByCompany = new Map(), logos = new Map(), { region = DEFAULT_REGION, alternates = null } = {}) {
  const url = regionUrl('/companies/', region);
  // Employers with no live role are still listed, below the ones hiring. This
  // page is the only crawl path to the hubs — the homepage list is built by
  // JavaScript — so a hub missing from here is a hub Google reaches through the
  // sitemap alone, which is a hint rather than a link.
  const rows = [...new Set([...byCompany.keys(), ...pastByCompany.keys()])]
    .map((company) => ({
      company,
      live: (byCompany.get(company) ?? []).filter(isIndexable).length,
      past: (pastByCompany.get(company) ?? []).length,
    }))
    .filter((r) => r.live > 0 || r.past >= 2)
    .sort((a, b) => b.live - a.live || a.company.localeCompare(b.company));

  const hiring = rows.filter((r) => r.live > 0).length;
  const total = rows.reduce((n, r) => n + r.live, 0);

  const card = (r) => `<a class="dir-card${r.live ? '' : ' is-quiet'}" href="${regionHref(`/companies/${companySlug(r.company)}`, region)}" data-name="${esc(r.company.toLowerCase())}">
        ${crest(r.company, logos.get(r.company), { cls: 'tile-crest' })}
        <span class="dir-t">
          <span class="dir-name">${esc(r.company)}</span>
          <span class="dir-n">${r.live ? `${r.live} open role${r.live === 1 ? '' : 's'}` : `no live roles · ${r.past} tracked`}</span>
        </span>
      </a>`;

  const open = rows.filter((r) => r.live > 0);
  const quiet = rows.filter((r) => r.live === 0);

  const where = region.inName.replace(/^in /, '');
  return `${head({
    // NO LIVE COUNT IN THE TITLE, for the same reason a company hub carries
    // none: it moved on almost every publish, rewriting the <title> of the one
    // page that is the ONLY crawl path to the hubs — 22 commits in three days.
    // It also pushed the title to 67-68 rendered characters against a ~60
    // budget. Freshness belongs in the description, where a rewrite is free,
    // and both counts are already stated there.
    title: `Internships in ${where} by company | InternDoor`,
    description: `Browse ${total} live internships across ${hiring} companies ${region.inName}, plus every employer we track. Updated every 30 minutes.`,
    canonical: url,
    indexable: rows.length > 0,
    region,
    // The directory DOES have a true equivalent in every region — same page,
    // same purpose, different employers — so this one carries hreflang.
    alternates,
    alternatePath: '/companies/',
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${regionHref('/', region)}">Home</a> <i aria-hidden="true">›</i>
      <span>Companies</span>
    </nav>

    <header class="dir-hero">
      <h1>Internships by company ${esc(region.inName)}</h1>
      <div class="stats">
        <div class="stat"><b>${total}</b><span>Live openings</span></div>
        <div class="stat"><b>${hiring}</b><span>Hiring right now</span></div>
        <div class="stat"><b>${rows.length}</b><span>Employers tracked</span></div>
      </div>
      <div class="filter" id="filter">
        <label>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>
          <input type="search" id="filter-input" placeholder="Filter ${rows.length} employers — try “Qualcomm”" aria-label="Filter companies">
        </label>
      </div>
    </header>

    <p class="dir-none" id="dir-none">No employer matches that. Try a shorter word.</p>

    <section class="strip" data-group>
      <div class="strip-head"><h2>Hiring right now</h2></div>
      <div class="dir">${open.map(card).join('')}</div>
    </section>

    ${quiet.length ? `<section class="strip" data-group>
      <div class="strip-head"><h2>Tracked, nothing open today</h2></div>
      <div class="dir">${quiet.map(card).join('')}</div>
    </section>` : ''}
  </div>
</main>
${foot({
    headline: 'Never refresh this page again',
    sub: `Every new engineering internship ${region.inName}, pushed to Telegram within minutes of going live.`,
    region,
  })}`;
}

/**
 * /alerts — every way to follow this board, in one place.
 *
 * IT IS A PAGE, NOT A LINK. The header used to send readers straight to
 * Telegram, which quietly decided for them that Telegram was the channel they
 * wanted — and offered nothing at all to somebody who does not use it. Email is
 * the only channel the site OWNS rather than rents, so it leads here, and the
 * rest are alternatives rather than the default.
 *
 * `channels` is passed in rather than read from config, because this module
 * takes no config — src/channels.js decides, and its rule is that a region with
 * NO channel gets no link rather than another region's. GB has neither a
 * Telegram channel nor an Instagram account, so its page honestly offers email
 * alone. Adding WhatsApp later is a config entry and nothing here.
 */
/**
 * The board, measured — a permanent, citable page of its own statistics.
 *
 * Every other page here expires. A job page is deleted at 30 days by design and
 * a company hub lives or dies with its employer, so neither can accumulate the
 * one thing this domain has none of: links. THIS page is the asset that can.
 * The numbers behind it are the only thing on the site a competitor cannot
 * copy, because they are not facts about internships — they are facts about a
 * corpus, and nobody else has the denominator.
 *
 * THE FACTS ARE MINED ONCE A DAY AND PASSED IN, never mined here. Two reasons
 * and both are load-bearing:
 *  - `publish` runs 48 times a day and this file writes into a PUBLIC git repo.
 *    A page whose numbers move every half hour is 48 commits of churn a day on
 *    the one URL that is supposed to look stable to Google.
 *  - A citation has to survive being followed. "36 of 403" quoted by somebody
 *    else has to still be on the page when a reader clicks through, and a
 *    figure that changes hourly makes the page unquotable. Once a day, stamped
 *    with the date it was measured, is what makes it safe to cite.
 *
 * THE METHODOLOGY DELIBERATELY DOES NOT NAME THE SOURCES. The site stopped
 * describing where listings come from on 10 Aug — the README note, the
 * homepage, the footers and the hub lede were all changed at once — and a
 * methodology section is exactly where that would creep back in. "Public job
 * boards and companies' own careers pages" is true and is as far as it goes.
 *
 * The limitations are not a disclaimer, they are the reason this is citable at
 * all. A journalist checks them; a page that omits them reads as marketing.
 */
/**
 * How many facts a report needs before it is worth indexing.
 *
 * Below this the page is still WRITTEN — so the footer link on ~950 generated
 * pages resolves rather than 404ing — but it is noindex and absent from the
 * sitemap. Exactly the bar company hubs already apply, and for the same reason:
 * a URL that exists is cheap, a thin page competing for the domain's crawl
 * budget is not. A thin region (GB holds a fraction of India's volume) clears
 * this on its own as it fills.
 */
export const REPORT_MIN_FACTS = 4;

export function renderReportPage(facts, { region = DEFAULT_REGION, alternates = null, asOf = Date.now(), days = 30 } = {}) {
  const url = regionUrl('/report', region);
  const where = region.inName.replace(/^in /, '');
  const measured = new Date(asOf).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: region.timeZone,
  });

  const sample = facts.find((f) => f.sample)?.sample ?? 0;
  const gate = facts.find((f) => f.id === 'the-gate');
  const pay = facts.find((f) => f.id === 'pay-transparency');

  /* The lede leads with the strongest fact rather than a summary of the page.
     It is also the meta description, which is the sentence that decides whether
     anybody clicks through from a search result at all. */
  const lede = pay
    ? `Of ${pay.of} engineering internships ${region.inName} in the last ${days} days, only ${pay.value} said what they pay.`
    : `What ${sample} engineering internships ${region.inName} actually looked like over ${days} days.`;

  /* `rp-` prefixed, and NOT `.stat`: page.css already uses that for the company
     hub's at-a-glance tile, whose `.stat span` rule would silently shrink these
     numbers to a 9.5px uppercase label. Same collision class as `.gist`. */
  /* Grouped, because the detail lines beneath already read "26,308 refused of
     28,312" and a bare "26308" directly under one looks like a different
     number. en-IN is the wrong grouping for the US and UK boards, so the
     region's own locale decides. */
  const num = (n) => Number(n).toLocaleString(region.hreflang ?? 'en');
  const stat = (f) => `<li class="rp-stat">
        <p class="rp-stat-h">${esc(f.headline)}</p>
        <p class="rp-stat-d">${esc(f.detail)}</p>
        <p class="rp-stat-n"><b>${num(f.value)}</b> of <b>${num(f.of)}</b></p>
      </li>`;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `Engineering internship statistics ${region.inName}`,
    description: lede,
    datePublished: new Date(asOf).toISOString(),
    dateModified: new Date(asOf).toISOString(),
    isAccessibleForFree: true,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    publisher: { '@type': 'Organization', name: 'InternDoor', url: regionUrl('/', region) },
  };

  return `${head({
    title: buildTitle([`Engineering internship statistics ${region.inName}`]),
    /* Clamped, and the boilerplate shortened to fit. It ran 188-190 characters
       against a SERP that shows about 155, so "Free to read and cite" — the one
       line aimed at the journalists this page exists for — was the part Google
       was cutting off. The lede leads because it carries the actual statistic. */
    description: clampWords(`${lede} Measured across ${sample} postings from vetted employers, updated daily.`, 158),
    canonical: url,
    indexable: facts.length >= REPORT_MIN_FACTS,
    region,
    // Every region has this page: same purpose, its own board's numbers.
    alternates,
    alternatePath: '/report',
    extraLd: `<script type="application/ld+json">${jsonLd(ld)}</script>\n`,
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${regionHref('/', region)}">Home</a> <i aria-hidden="true">›</i>
      <span>The numbers</span>
    </nav>

    <header class="dir-hero">
      <h1>Engineering internships ${esc(region.inName)}, by the numbers</h1>
      <p class="hub-lede">${esc(lede)}</p>
      <p class="rp-stamp">Measured over the ${days} days to <strong>${esc(measured)}</strong>${sample ? ` · <strong>${sample}</strong> postings` : ''}. Updated daily.</p>
    </header>

    <ol class="rp-stats">
      ${facts.map(stat).join('\n      ')}
    </ol>

    <section class="rp-note">
      <h2>How this was measured</h2>
      <p>We track engineering and software internships as they are published on public job boards and on companies' own careers pages, and record each one the first time we see it. These figures cover every posting we recorded ${esc(region.inName)} in the ${days} days to ${esc(measured)}.</p>
      <p>A posting only reaches the board if its employer is on a list we keep of companies we believe are real and actually pay interns.${gate ? ` Most are not: we turned away about <strong>${gate.ratio}</strong> listings for every one we published.` : ''} That gate is the point of the site, and it is also the biggest thing to hold in mind when reading these numbers.</p>

      <h2>What these numbers are not</h2>
      <ul>
        <li><strong>This is not a census of every internship ${esc(region.inName)}.</strong> It is a census of the ones that got past the gate above, so it describes the market a student would actually want to apply to rather than the whole of it.</li>
        <li><strong>&ldquo;Said nothing about pay&rdquo; does not mean unpaid.</strong> It means the posting did not state a figure we could read. A genuinely unpaid role and one that simply never mentioned money are indistinguishable here, and we do not guess between them.</li>
        <li><strong>Applicant counts are frozen at the moment we found the posting.</strong> They are what the listing reported then, not now, which is the whole reason a low one is worth acting on quickly.</li>
        <li><strong>Only what employers state is counted.</strong> Skills, duration and working arrangements are read from the posting text, so a requirement that goes unmentioned is missing rather than absent.</li>
      </ul>

      <h2>Using these figures</h2>
      <p>They are free to quote with a link to this page. Cite them as measured on ${esc(measured)} &mdash; the page is regenerated daily, so the numbers move.</p>
    </section>
  </div>
</main>
${foot({
    headline: `See the roles behind the numbers`,
    sub: `Every posting counted above is on the board, newest first.`,
    region,
  })}`;
}

export function renderAlertsPage(channels = [], { region = DEFAULT_REGION, alternates = null } = {}) {
  const url = regionUrl('/alerts', region);
  const where = region.inName.replace(/^in /, '');
  const others = channels.filter((c) => c.kind !== 'email');

  const icon = {
    telegram: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
    instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="3.8"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none"/>',
    whatsapp: '<path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.7-5.2A8.5 8.5 0 1 1 21 11.5z"/>',
  };

  const card = (c) => `<a class="chan" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">
        <span class="chan-i" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon[c.kind] ?? ''}</svg></span>
        <span class="chan-t">
          <span class="chan-n">${esc(c.name)}${c.handle ? ` <i>${esc(c.handle)}</i>` : ''}</span>
          <span class="chan-b">${esc(c.blurb)}</span>
        </span>
        <span class="chan-go" aria-hidden="true">↗</span>
      </a>`;

  return `${head({
    title: buildTitle([`Get internship alerts ${where}`]),
    description: `Get new engineering internships ${region.inName} by email, or follow along on ${others.map((c) => c.name).join(' and ') || 'email'}. Free, and you can leave any time.`,
    canonical: url,
    indexable: true,
    region,
    // Every region has this page, with the same purpose and different channels.
    alternates,
    alternatePath: '/alerts',
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${regionHref('/', region)}">Home</a> <i aria-hidden="true">›</i>
      <span>Alerts</span>
    </nav>

    <header class="dir-hero">
      <h1>Get internship alerts ${esc(region.inName)}</h1>
      <p class="hub-lede">New engineering internships, within minutes of going live. Pick whichever you actually read — you can take more than one, and leave any time.</p>
    </header>

    <section class="strip">
      <div class="strip-head"><h2>By email</h2></div>
      ${signupForm(region, { heading: false })}
    </section>

    ${others.length ? `<section class="strip">
      <div class="strip-head"><h2>Or follow along</h2></div>
      <div class="chans">${others.map(card).join('')}</div>
    </section>` : `<p class="cp-note">Email is the only alert channel for this board today. More are coming.</p>`}
  </div>
</main>
${foot({
    headline: 'Be early, every time',
    sub: `Every new engineering internship ${region.inName}, the moment we find it.`,
    region,
    signup: false,
  })}`;
}

/**
 * /applications — the reader's own application tracker.
 *
 * WHAT THIS PAGE SHIPS IS THE EMPTY STATE, and that is the whole design. Every
 * row is built by applications.js out of localStorage, so this file is
 * identical for every reader and every crawler: the explanation of what the
 * page is, the status ladder it offers, and how to put something in it.
 *
 * IT IS noindex AND IS ABSENT FROM THE SITEMAP, deliberately and permanently.
 * There is no content here that is the same for two people, so what a crawler
 * would index is a page with a heading and no listings — thin content, on a
 * domain that already carries a previous owner's history and is mid-Change-of-
 * Address on two properties. It is also left out of the Google Indexing API
 * queue for a harder reason: that API accepts JobPosting and BroadcastEvent
 * pages and NOTHING else, and Google warns that submitting an unsupported page
 * type can cost the project its API access.
 *
 * The tracker holds applications from EVERY board, not just this one.
 * localStorage is per-origin, so a student who applied to a role in India and
 * one in the US has a single list; showing them separately per region would be
 * an artifact of how the site is routed rather than anything true about them.
 * Each region still gets its own copy of this page so the masthead, the footer
 * and the region switch resolve to the board the reader came from.
 */
export function renderApplicationsPage({ region = DEFAULT_REGION } = {}) {
  const url = regionUrl('/applications', region);

  /* The ladder, rendered server-side so the page explains the feature before
     anybody has used it. It MUST stay in step with STATUSES in
     web/public/track.js — test/tracker.test.mjs pins the two against each
     other, because a status offered here that the store does not know is a
     promise the dropdown cannot keep. */
  const LADDER = [
    ['Applied', 'the day you send it'],
    ['Application under review', 'the employer has opened it'],
    ['Shortlisted', 'you are through the first cut'],
    ['OA received', 'an online assessment has landed'],
    ['Interview scheduled', 'a date is in the diary'],
    ['Selected', 'an offer'],
    ['Rejected', 'a close, and worth recording'],
  ];

  return `${head({
    title: buildTitle(['My applications']),
    description: `Track every internship you have applied to ${region.inName} — status, dates and what is still outstanding, kept on your own device.`,
    canonical: url,
    indexable: false,
    region,
    scripts: '<script defer src="/applications.js"></script>\n',
  })}
<main class="page" id="trk-root" data-feed="${esc(regionHref('/data/jobs.json', region))}">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${regionHref('/', region)}">Home</a> <i aria-hidden="true">&rsaquo;</i>
      <span>My applications</span>
    </nav>

    <header class="dir-hero">
      <h1>My applications</h1>
      <p class="hub-lede">Every internship you have applied to, and where each one has got to. Mark a role <strong>Applied</strong> from any listing on the board and it appears here.</p>
    </header>

    <div class="trk-sum" id="trk-sum" hidden></div>
    <div class="trk-tabs" id="trk-tabs" role="group" aria-label="Filter by status" hidden></div>

    <div class="trk-scroll">
      <table class="trk" id="trk-table" role="table" hidden>
        <thead>
          <tr role="row">
            <th scope="col" role="columnheader">Role</th>
            <th scope="col" role="columnheader">Status</th>
            <th scope="col" role="columnheader" class="trk-c-date">Applied</th>
            <th scope="col" role="columnheader"><span class="vh">Actions</span></th>
          </tr>
        </thead>
        <tbody id="trk-body"></tbody>
      </table>
    </div>
    <p class="trk-none" id="trk-none" hidden>Nothing at that status yet.</p>

    <!-- THE DEFAULT, AND THE ONLY THING A CRAWLER EVER SEES. applications.js
         hides it the moment there is a row to show. -->
    <section class="trk-void" id="trk-void">
      <h2>Nothing tracked yet</h2>
      <p>Open any role on the board and press <strong>Track</strong>, or use the button on a job page. Nothing is sent anywhere &mdash; see below.</p>
      <p class="trk-void-go"><a class="a-1" href="${regionHref('/', region)}">Browse live internships</a></p>

      <h3>The stages you can move a role through</h3>
      <ol class="trk-ladder">
        ${LADDER.map(([name, when]) => `<li><b>${esc(name)}</b><span>${esc(when)}</span></li>`).join('\n        ')}
      </ol>
    </section>

    <section class="trk-priv">
      <h2>Where this is kept</h2>
      <p><strong>On this device, in this browser, and nowhere else.</strong> Your application list is never sent to InternDoor and we cannot see it. There is no account and nothing to sign up for.</p>
      <p>That has a real cost, and it is worth knowing before you rely on it: the list <strong>will not follow you to another browser or another phone</strong>, and clearing your browsing data will delete it. Take a backup file if the list matters to you.</p>
      <details class="trk-data" id="trk-data">
        <summary>Backup and restore</summary>
        <div class="trk-data-in">
          <p>The backup is a plain JSON file. Restoring merges it with whatever is already here and keeps the newer copy of any role that is in both, so restoring an old backup never throws away newer applications.</p>
          <div class="trk-data-acts">
            <button class="alt" id="trk-export" type="button">Download backup</button>
            <button class="alt" id="trk-import" type="button">Restore from file</button>
            <input type="file" id="trk-file" accept="application/json,.json" hidden>
          </div>
          <p class="trk-msg" id="trk-msg" role="status" aria-live="polite"></p>
        </div>
      </details>
    </section>
  </div>
</main>
${foot({
    headline: 'Be early on the next one',
    sub: `Every new engineering internship ${region.inName}, within minutes of going live.`,
    region,
  })}`;
}

/**
 * Write only when the bytes actually differ, and SAY whether they did.
 *
 * The name was aspirational: it wrote unconditionally. That was survivable —
 * git commits content, not mtimes, so the churn this guards against never
 * reached the repo — but it rewrote ~1000 files 48 times a day for nothing, and
 * it threw away the one signal IndexNow needs.
 *
 * The return value IS that signal. Bing's IndexNow wants the URLs that changed,
 * not the whole sitemap on a timer, and this is the only place that knows.
 * Existing callers ignore it, so this stays backwards compatible.
 */
function writeIfChanged(path, contents) {
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === contents) return false;
  } catch { /* unreadable — fall through and write */ }
  writeFileSync(path, contents);
  return true;
}

/**
 * The region-varying half of the homepage's <head>.
 *
 * Everything here differs per region and nothing else in index.html does, which
 * is what makes one hand-authored file serve every board. Generated rather than
 * hand-maintained per region because there is no version of "keep eleven copies
 * of a <head> in sync" that survives contact with a copy-edit.
 */
function homeHead(region, alternates, channels = []) {
  const url = regionUrl('/', region);
  const where = region.inName.replace(/^in /, '');
  const title = `InternDoor — Engineering Internships in ${where}`;
  const description = `Engineering internships ${region.inName}, listed minutes after they go live. `
    + 'Fresh openings refreshed every 30 minutes — apply while the queue is still short.';
  const social = `Software internships ${region.inName}, listed minutes after they go live. Apply while the queue is still short.`;
  const imageAlt = `InternDoor — be early. Software internships ${region.inName}, listed minutes after they go live.`;

  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE}/#organization`,
        name: 'InternDoor',
        url: `${SITE}/`,
        logo: `${SITE}/favicon-96.png`,
        description: `InternDoor lists engineering internships ${region.inName} within minutes of them going live.`,
        areaServed: { '@type': 'Country', name: region.name },
        sameAs: channels.filter((c) => c.url).map((c) => c.url),
      },
      {
        '@type': 'WebSite',
        '@id': `${url}#website`,
        url,
        name: 'InternDoor',
        description: `Engineering internships ${region.inName}, listed within minutes of going live.`,
        inLanguage: region.hreflang,
        publisher: { '@id': `${SITE}/#organization` },
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${url}?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
    ],
  };

  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${alternateLinks('/', alternates)}<!-- Read by app.js to pick the board it loads. The region is in the URL, but
     a rewrite can serve this file from more than one path, so the page states
     which region it IS rather than inferring it.

     NO legacy alias pair here, unlike the GradKite rebrand which carried the
     internzo- names for a day. That existed because app.js is cached for 10
     minutes with a 24h stale-while-revalidate, so a returning reader could be
     served new HTML with an old cached script that queried the previous names,
     miss the read, and silently get India's listings on the US or UK board.
     It cannot happen here: interndoor.com is a NEW ORIGIN, and the HTTP cache
     is keyed per origin. Nobody holds a script cached under interndoor.com, so
     every reader gets this HTML and its matching app.js together. Readers
     arriving on internzo.in or internradar.info are 308'd here before any
     document is served, so their old cached scripts are never executed against
     this page either. app.js still falls back tolerantly, which costs two ||
     branches and covers the case where this ever gets served from an origin
     that previously ran an older build.
     (No backticks in this comment: it sits inside a template literal.) -->
<meta name="interndoor-region" content="${region.code}">
<meta name="interndoor-data" content="${regionHref('/data/jobs.json', region)}">
<link rel="alternate" type="application/rss+xml" title="InternDoor — new engineering internships" href="${esc(regionUrl('/feed.xml', region))}">
<link rel="alternate" type="application/feed+json" title="InternDoor — new engineering internships" href="${esc(regionUrl('/feed.json', region))}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:description" content="${esc(social)}">
<meta property="og:image:alt" content="${esc(imageAlt)}">
<meta property="og:locale" content="${region.hreflang.replace('-', '_')}">
<meta name="twitter:description" content="${esc(social)}">
<meta name="twitter:image:alt" content="${esc(imageAlt)}">
<script type="application/ld+json">${jsonLd(ld)}</script>`;
}

/** Replace everything between a marker pair. Returns null if the pair is absent. */
function fillMarker(html, name, contents) {
  const open = `<!--${name}-->`;
  const close = `<!--/${name}-->`;
  const from = html.indexOf(open);
  const to = html.indexOf(close);
  if (from === -1 || to === -1 || to < from) return null;
  return `${html.slice(0, from + open.length)}\n${contents}\n${html.slice(to)}`;
}

/**
 * Root-relative links that belong to a region, and the complete list of them.
 *
 * An allowlist rather than a blanket rewrite of every `href="/…"`, because the
 * same document also links to `/styles.css`, `/favicon.ico`, `/og.jpg` and
 * `/_vercel/…`, none of which are per-region and all of which would 404 under a
 * prefix. Job links are generated below and already carry theirs.
 */
const REGION_LINKS = ['/companies', '/alerts', '/applications', '/feed.xml', '/feed.json', '/data/jobs.json'];

function localiseLinks(html, region) {
  const prefix = regionPath(region.code);
  if (!prefix) return html;
  let out = html.replace(/href="\/"/g, `href="${prefix}"`);
  for (const path of REGION_LINKS) {
    out = out.split(`"${path}"`).join(`"${prefix}${path}"`);
  }
  return out;
}

/**
 * Write one region's homepage.
 *
 * `web/public/index.html` is hand-authored and is the TEMPLATE for every region,
 * India's included. India writes back over itself in place, so its file is
 * unchanged except inside the markers; every other region is written to
 * `<slug>/index.html`.
 *
 * One template rather than a generated page per region because the board is a
 * designed thing — a two-pane layout, a filter rail, a resume tailor — and the
 * moment each region owns a copy they drift, so switching region would change
 * the design as well as the listings.
 *
 * The listings inside <!--LISTINGS--> are the fix for the thing Search Console
 * actually reported: every job page came back "URL is unknown to Google" with
 * both discovery routes empty, because the homepage shipped an empty <ol> that
 * JavaScript filled afterwards. Crawl depth to a job page was three on a domain
 * with no authority; now it is one. app.js calls replaceChildren() on this list,
 * so these rows are gone the moment the script runs — nothing is hidden from
 * users to feed a crawler something different.
 *
 * If the markers are missing the file is left completely alone: silently
 * rewriting a hand-maintained page is a far worse failure than not adding links.
 */
function writeHomePage(jobs, publicDir, region = DEFAULT_REGION, alternates = null, channels = []) {
  const templatePath = join(publicDir, 'index.html');
  if (!existsSync(templatePath)) return 0;
  const template = readFileSync(templatePath, 'utf8');

  const rows = jobs.map((j) => {
    const facts = [j.location, j.workplaceType].filter(Boolean).map((s) => esc(s)).join(' · ');
    return `<li><a href="${regionHref(`/jobs/${jobSlug(j)}`, region)}">${esc(j.company)} — ${esc(j.title)}</a>`
      + (facts ? `<span class="tiny"> ${facts}</span>` : '')
      + '</li>';
  }).join('\n');

  let html = fillMarker(template, 'LISTINGS', rows);
  if (html === null) {
    console.warn('  index.html has no <!--LISTINGS--> markers — homepage links not written.');
    return 0;
  }
  // The region markers are optional so a half-migrated index.html still
  // publishes India correctly rather than failing the whole run.
  html = fillMarker(html, 'REGION:HEAD', homeHead(region, alternates, channels)) ?? html;
  // No region in the lede, on purpose (24 Aug). The header's own region switch
  // already names the board, so repeating it here said the same thing twice.
  // The paragraph still NAMES THE SUBJECT, which is the whole reason it exists:
  // when it did not, Google discarded the meta description and wrote the search
  // snippet out of a job blurb, describing the site as an AI video company.
  // "Engineering internships" keeps that fixed. The place is still carried by
  // <title>, the meta description, hreflang and the JSON-LD areaServed.
  // The comma rides INSIDE the fill. fillMarker always writes a newline before
  // the closing marker, and that newline renders as a space — so a comma left in
  // the template sat one space away from the word: "internships , listed". That
  // was live and visible on the homepage until 24 Aug. Punctuation belongs with
  // the phrase it punctuates anyway.
  html = fillMarker(html, 'REGION:LEDE',
    '<strong>Engineering internships</strong>,') ?? html;
  html = fillMarker(html, 'REGION:SWITCH', regionSwitch(region, alternates)) ?? html;
  // A regex, not a literal swap: the template's own lang is en-IN (it IS the
  // India board), so matching `lang="en"` silently did nothing and every region
  // shipped en-IN. Caught in the browser, not by a test — the tests render
  // pages, and only this path rewrites an existing document.
  html = html.replace(/<html lang="[^"]*">/, `<html lang="${region.hreflang}">`);
  html = localiseLinks(html, region);

  const outDir = join(publicDir, ...(region.slug ? [region.slug] : []));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'index.html');
  if (html !== template || outPath !== templatePath) writeFileSync(outPath, html);
  return jobs.length;
}

/**
 * Regenerate every page. Stale files are removed rather than left to rot: a
 * posting that aged out of jobs.json must not keep a live URL, or the site
 * accumulates pages for jobs nobody can apply to any more.
 *
 * @returns {{jobPages: number, companyPages: number, indexable: number, removed: number}}
 */
/**
 * company name -> logo path, for the pages that have no job object to read it
 * from.
 *
 * A live posting carries its own `logo`, so that is preferred. A hub whose
 * employer is not hiring today has no posting at all, and a hub is permanent —
 * so the logos directory is scanned by slug as a fallback and the crest
 * survives the last opening ageing out. Extensions vary (.jpg and .png both
 * occur), which is why this reads the directory rather than guessing a name.
 *
 * Returns a Map-shaped object so callers can treat it as one.
 */
function companyLogos(jobs, publicDir) {
  const live = new Map();
  for (const job of jobs) if (job.company && job.logo) live.set(job.company, job.logo);

  const bySlug = new Map();
  const dir = join(publicDir, 'logos');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (/\.(jpe?g|png|webp|svg)$/i.test(f)) bySlug.set(f.replace(/\.[a-z0-9]+$/i, ''), f);
    }
  }

  return {
    get(company) {
      const known = live.get(company);
      if (known) return known;
      const file = bySlug.get(companySlug(company));
      return file ? `/logos/${file}` : '';
    },
  };
}

/* Facet pages — /skills/<slug> and /locations/<slug>.
   ---------------------------------------------------------------------------
   The queries people actually type are "python internships" and "internships in
   bangalore", and the board has always held the data for both while having no
   page for either: skill chips link to the board's `?q=` filter, and a query
   string is not a page Google will index.

   AT MOST FACET_TILES ROLES ARE SHOWN. Python carries 415 on the US board and
   rendering all of them is a ~100KB page of near-identical tiles, which is
   worse for a reader and no better for a crawler than the newest fifty plus an
   honest count of the rest. */
const FACET_TILES = 50;

const FACET_KINDS = {
  skill: {
    dir: 'skills',
    heading: (label, region) => `${titleCaseSkill(label)} internships ${region.inName}`,
    title: (label, region) => [`${titleCaseSkill(label)} Internships`, region.inName],
    lede: (label, n, c, region) => `${n} live internship${n === 1 ? '' : 's'} ${region.inName} that ask for ${titleCaseSkill(label)}, from ${c} compan${c === 1 ? 'y' : 'ies'}.`,
    siblings: 'Other skills',
  },
  city: {
    dir: 'locations',
    heading: (label) => `Internships in ${label}`,
    title: (label) => [`Internships in ${label}`],
    lede: (label, n, c) => `${n} live engineering internship${n === 1 ? '' : 's'} in ${label}, from ${c} compan${c === 1 ? 'y' : 'ies'}.`,
    siblings: 'Other cities',
  },
};

/**
 * One facet page.
 *
 * `siblings` is every other facet of the same kind, and passing it is the point
 * rather than a nicety: without it each of these is a crawl dead end reachable
 * only from its index, which is exactly the problem the company hubs had until
 * they were taught to link sideways.
 */
export function renderFacetPage(kind, facet, siblings = [], { region = DEFAULT_REGION } = {}) {
  const k = FACET_KINDS[kind];
  if (!k) throw new Error(`renderFacetPage: unknown kind ${kind}`);
  const path = `/${k.dir}/${facet.slug}`;
  const rows = facet.jobs.slice()
    .sort((a, b) => (b.postedAt ?? b.firstSeenAt ?? 0) - (a.postedAt ?? a.firstSeenAt ?? 0));
  const shown = rows.slice(0, FACET_TILES);
  const companies = new Set(rows.map((j) => j.company)).size;
  const lede = k.lede(facet.label, rows.length, companies, region);

  const also = siblings.filter((s) => s.slug !== facet.slug).slice(0, 14);

  return `${head({
    title: buildTitle(k.title(facet.label, region)),
    description: clampWords(`${lede} Updated every 30 minutes, from a vetted list of employers.`, 155),
    canonical: regionUrl(path, region),
    indexable: true,
    region,
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${regionHref('/', region)}">Internships</a> <span aria-hidden="true">/</span>
      <a href="${regionHref(`/${k.dir}/`, region)}">${kind === 'skill' ? 'Skills' : 'Locations'}</a> <span aria-hidden="true">/</span>
      <span>${esc(kind === 'skill' ? titleCaseSkill(facet.label) : facet.label)}</span>
    </nav>
    <h1>${esc(k.heading(facet.label, region))}</h1>
    <p class="summary">${esc(lede)} Every listing links to the employer's own posting.</p>

    <ul class="feed">
      ${shown.map((j) => `<li>${tile(j, { region })}</li>`).join('\n      ')}
    </ul>
    ${rows.length > shown.length
      ? `<p class="dim">Showing the ${shown.length} most recent of ${rows.length}. <a href="${regionHref('/', region)}">See them all on the board</a>.</p>`
      : ''}

    ${also.length ? `<section class="strip">
      <div class="strip-head"><h2>${esc(k.siblings)}</h2></div>
      <ul class="cp-chips">
        ${also.map((sib) => `<li><a href="${regionHref(`/${k.dir}/${sib.slug}`, region)}">${esc(kind === 'skill' ? titleCaseSkill(sib.label) : sib.label)}</a></li>`).join('\n        ')}
      </ul>
    </section>` : ''}
  </div>
</main>
${foot({ headline: 'Get these as they open', sub: `New ${kind === 'skill' ? titleCaseSkill(facet.label) : facet.label} internships, the day they are listed.`, region })}`;
}

/** The index at /skills/ or /locations/ — the crawl path to every facet page. */
export function renderFacetIndex(kind, facets = [], { region = DEFAULT_REGION } = {}) {
  const k = FACET_KINDS[kind];
  if (!k) throw new Error(`renderFacetIndex: unknown kind ${kind}`);
  const noun = kind === 'skill' ? 'Skills' : 'Locations';
  const total = facets.reduce((n, f) => n + f.jobs.length, 0);
  const lede = kind === 'skill'
    ? `Browse live internships ${region.inName} by the skill they ask for.`
    : `Browse live engineering internships ${region.inName} by city.`;

  return `${head({
    title: buildTitle([`Internships by ${kind === 'skill' ? 'Skill' : 'City'}`, region.inName]),
    description: clampWords(`${lede} ${facets.length} ${noun.toLowerCase()} across ${total} listings, updated every 30 minutes.`, 155),
    canonical: regionUrl(`/${k.dir}/`, region),
    /* Thin until there is something to browse. One or two facets is a page
       that adds nothing the board does not already show. */
    indexable: facets.length >= 3,
    region,
  })}
<main class="page">
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${regionHref('/', region)}">Internships</a> <span aria-hidden="true">/</span> <span>${esc(noun)}</span>
    </nav>
    <h1>Internships ${esc(region.inName)} by ${kind === 'skill' ? 'skill' : 'city'}</h1>
    <p class="summary">${esc(lede)}</p>
    <div class="dir">
      ${facets.map((f) => `<a class="dir-card" href="${regionHref(`/${k.dir}/${f.slug}`, region)}">
        <span class="dir-t">
          <span class="dir-name">${esc(kind === 'skill' ? titleCaseSkill(f.label) : f.label)}</span>
          <span class="dir-n">${f.jobs.length} open role${f.jobs.length === 1 ? '' : 's'}</span>
        </span>
      </a>`).join('\n      ')}
    </div>
  </div>
</main>
${foot({ headline: 'Get new roles as they open', sub: 'One email when something matching lands.', region })}`;
}

/* A REPOSTED ROLE'S OLD URL, POINTED AT THE ONE THAT REPLACED IT.

   When an employer reposts a role under a new id, dedupePostings keeps the
   newest and the older row's page is deleted — so a URL Google has indexed
   starts 404ing while a near-identical page appears elsewhere. Measured over 30
   days: 123 orphaned URLs. This file already learned that lesson once with the
   company hubs, which were made permanent on 18 Aug for exactly this reason.

   WHY A PAGE AND NOT A REAL 301. A 301 needs web/vercel.json, and that file is
   NOT in the PUBLISHED allowlist — the scheduler would generate redirects every
   30 minutes and never deploy one. Worse, vercel.json is schema-validated and a
   bad write fails EVERY deploy silently while the live site serves the previous
   build, which this project has already paid for once. Letting an unattended
   loop rewrite it is a bad trade against the 404s it fixes.
   web/public/<region>/jobs IS allowlisted, so a stub deploys on the next scan
   with no infrastructure change and no chance of freezing the site.

   An instant meta refresh plus rel=canonical is how Google is told these are
   the same page; it consolidates on that pair. Deliberately NO robots noindex —
   it would suppress the very consolidation the stub exists to cause.

   These are self-cleaning. They are regenerated from each run's dedupe result,
   so a stub exists only while its winner is published, and both disappear when
   the role ages out. Nothing accumulates. */
function renderJobRedirect(target, region) {
  const url = regionUrl(`/jobs/${target}`, region);
  return `<!doctype html>
<html lang="${esc(region.lang ?? 'en')}">
<head>
<meta charset="utf-8">
<title>This role moved — InternDoor</title>
<link rel="canonical" href="${esc(url)}">
<meta http-equiv="refresh" content="0; url=${esc(url)}">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
<p>This posting was relisted by the employer. <a href="${esc(url)}">Continue to the current listing</a>.</p>
</body>
</html>
`;
}

/**
 * One hub per SLUG, not per spelling.
 *
 * `NVIDIA` and `Nvidia` both slug to `nvidia`, so `writePages` rendered
 * `companies/nvidia.html` twice and the second write won — the surviving hub
 * showed 10 of the employer's 13 roles, or 3, depending on Set iteration
 * order. It also produced the one contradiction the sitemap fix could not
 * reach: `writeSitemap` asks `hubIndexable` once per NAME, so if either
 * spelling qualified the URL was listed, while the FILE on disk was whichever
 * spelling rendered last. NVIDIA's hub went out `noindex` and sat in the
 * sitemap anyway.
 *
 * THE DISPLAY NAME IS DECIDED ACROSS LIVE AND PAST ROWS TOGETHER. Resolving
 * the two maps independently is the obvious version and it is wrong: live rows
 * would pick `Nvidia` (10 of them) while past rows picked `NVIDIA`, the union
 * in `allCompanies` would carry both again, and the collision would survive
 * the fix. Most-frequent spelling wins, ties broken by name so a rebuild is
 * deterministic.
 *
 * Names whose slug is empty are left alone rather than merged into one bucket —
 * this is a de-duplicator, not a place to invent a grouping.
 */
function canonicalCompanyNames(rowSets) {
  const counts = new Map();                       // slug -> Map<name, n>
  for (const rows of rowSets) {
    for (const r of rows ?? []) {
      const name = r?.company;
      if (!name) continue;
      const slug = companySlug(name);
      if (!slug) continue;
      if (!counts.has(slug)) counts.set(slug, new Map());
      const seen = counts.get(slug);
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
  }
  const display = new Map();                      // slug -> chosen name
  for (const [slug, seen] of counts) {
    display.set(slug, [...seen.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  }
  return display;
}

/** Group rows under the canonical name for their slug, keeping prior keys otherwise. */
function groupByCanonicalCompany(rows, display) {
  const out = new Map();
  for (const r of rows ?? []) {
    const name = r?.company;
    const slug = name ? companySlug(name) : '';
    const key = (slug && display.get(slug)) || name;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

export function writePages(jobs, publicDir, history = [], { region = DEFAULT_REGION, alternates = null, foreign = new Map(), validDays = DEFAULT_VALID_DAYS, channels = [], stats = {}, redirects = [] } = {}) {
  // India is at the root and every other region under its slug. `regionPath`
  // returns '' for India, so this resolves to exactly the paths that already
  // exist and nothing indexed moves.
  const root = join(publicDir, ...(region.slug ? [region.slug] : []));
  const jobsDir = join(root, 'jobs');
  const compDir = join(root, 'companies');
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(compDir, { recursive: true });

  // Decided once, over live AND past rows, so the two maps below cannot key one
  // employer under two spellings and write its hub twice. See
  // `canonicalCompanyNames`.
  const companyNames = canonicalCompanyNames([jobs, history]);
  const byCompany = groupByCanonicalCompany(jobs, companyNames);

  // Grouped BEFORE the job pages are written, not after, because each job page
  // now carries its employer's other live roles — the only second click a
  // visitor who arrived from a search has.
  const wanted = new Set();
  /* Facet directories, collected so the sweep below prunes them too. */
  const facetDirs = [];

  /* Pages whose BYTES actually changed this run — the set IndexNow wants.
     Bing's guidance is to announce what changed, not to re-submit a sitemap on
     a timer, and writeIfChanged is the only place that knows. Unlike Google's
     Indexing API this accepts any page type, so hubs, the directory, /alerts
     and /report all belong here; Google's queue takes job pages alone. */
  const changedUrls = [];
  const track = (changed, path) => { if (changed) changedUrls.push(regionUrl(path, region)); };

  /* Computed BEFORE the job pages, because each job page's skill chips link to
     a /skills/ page when one exists and fall back to the board's ?q= filter
     when it does not. */
  const facets = facetGroups(jobs.filter(isIndexable));
  const skillPages = new Set(facets.skills.map((f) => f.slug));

  /* Written BEFORE the real pages so a live page always wins the name: if a
     slug is somehow both a redirect source and a real posting, the loop below
     overwrites the stub rather than the stub replacing a listing. */
  /* Reported back to the caller so the indexing queue can forget them — a
     stub carries no JobPosting markup, so an UPDATE owed from when the slug
     was a real page becomes an unsupported page type the moment it is written
     here. src/indexing.js clears them; nothing else knows a stub exists. */
  const redirectUrls = [];
  const liveSlugs = new Set(jobs.map((j) => jobSlug(j)));
  for (const { slug, target } of redirects) {
    if (liveSlugs.has(slug) || !liveSlugs.has(target)) continue;
    const name = `${slug}.html`;
    wanted.add(join(jobsDir, name));
    redirectUrls.push(regionUrl(`/jobs/${slug}`, region));
    track(writeIfChanged(join(jobsDir, name), renderJobRedirect(target, region)), `/jobs/${slug}`);
  }

  for (const job of jobs) {
    const name = `${jobSlug(job)}.html`;
    wanted.add(join(jobsDir, name));
    track(writeIfChanged(join(jobsDir, name),
      renderJobPage(job, byCompany.get(job.company) ?? [],
        { region, alternates, foreign: foreign.get(job.company) ?? [], validDays, skillPages })),
      `/jobs/${jobSlug(job)}`);
  }

  const logos = companyLogos(jobs, publicDir);

  // Every employer we have ever published, not just the ones hiring today. This
  // union is what makes a hub permanent: a company drops out of `byCompany` the
  // moment its last posting ages out, and before this the file was then deleted.
  const pastByCompany = groupByCanonicalCompany(
    (history ?? []).filter((p) => p.company), companyNames);

  // Built ONCE for the whole board, not per hub: it is the same comparison
  // ~340 times over, and it is what lets the hubs link sideways to each other
  // instead of every one of them being a crawl dead end.
  const employers = employerIndex(byCompany, pastByCompany);

  const allCompanies = new Set([...byCompany.keys(), ...pastByCompany.keys()]);
  for (const company of allCompanies) {
    const name = `${companySlug(company)}.html`;
    wanted.add(join(compDir, name));
    track(writeIfChanged(join(compDir, name),
      renderCompanyPage(company, byCompany.get(company) ?? [], pastByCompany.get(company) ?? [],
        logos.get(company) ?? '', {
          region,
          /* The regions where this employer is ALSO live. Deduplicated because
             `foreign` carries one entry per posting, not per region. */
          alsoIn: [...new Map((foreign.get(company) ?? []).map((e) => [e.region.code, e.region])).values()],
          related: relatedEmployers(company, employers)
            .map((r) => ({ ...r, logo: logos.get(r.company) ?? '' })),
        })),
      `/companies/${companySlug(company)}`);
  }

  // The directory, at /companies/. index.html rather than a slug so the bare
  // directory URL resolves on Vercel and on the dev server alike.
  wanted.add(join(compDir, 'index.html'));
  track(writeIfChanged(join(compDir, 'index.html'),
    renderCompanyIndex(byCompany, pastByCompany, logos, { region, alternates })), '/companies');

  /* Skill and location pages — the queries people actually type.
     ------------------------------------------------------------------------
     "python internships", "internships in bangalore". The board has always had
     the data and never had a page: the skill chips point at the board's `?q=`
     filter, and a query string is not a page Google indexes.

     THE THRESHOLD IS WHAT KEEPS THIS FROM BEING A DOORWAY FARM. A facet is
     written only once it carries enough roles to be worth reading; everything
     below is not written at all. Unlike a company hub there is nothing to
     protect by writing-then-noindexing, because nothing links to a facet page
     that does not exist. */
  for (const [kind, list] of [['skill', facets.skills], ['city', facets.cities]]) {
    const dir = join(root, kind === 'skill' ? 'skills' : 'locations');
    const seg = kind === 'skill' ? 'skills' : 'locations';
    mkdirSync(dir, { recursive: true });
    facetDirs.push([dir, seg]);
    for (const f of list) {
      const name = `${f.slug}.html`;
      wanted.add(join(dir, name));
      track(writeIfChanged(join(dir, name), renderFacetPage(kind, f, list, { region })),
        `/${seg}/${f.slug}`);
    }
    // The index is the crawl path to every facet page, exactly as /companies/
    // is to the hubs. Written even when the list is short so the breadcrumb on
    // each facet page resolves; renderFacetIndex noindexes a thin one itself.
    wanted.add(join(dir, 'index.html'));
    track(writeIfChanged(join(dir, 'index.html'), renderFacetIndex(kind, list, { region })), `/${seg}`);
  }

  /* /alerts — every way to follow this board. A flat file rather than a
     directory because vercel.json sets cleanUrls, so alerts.html serves at
     /alerts, and the dev server resolves it the same way. */
  track(writeIfChanged(join(root, 'alerts.html'), renderAlertsPage(channels, { region, alternates })), '/alerts');

  /* /report — the board's own statistics. Written for every published region
     even when thin, because foot() links it from every generated page and a
     link that 404s is worse than a page that says little; the noindex inside
     renderReportPage is what keeps a thin one out of the index. `stats` is
     mined once a day by publish.js and passed in, never mined here — see the
     comment on renderReportPage for why that matters to churn and to citation. */
  track(writeIfChanged(join(root, 'report.html'),
    renderReportPage(stats.facts ?? [], { region, alternates, asOf: stats.asOf ?? Date.now(), days: stats.days ?? 30 })),
    '/report');

  /* /applications — the reader's own tracker. Written for every published
     region so the masthead and footer resolve to the board they came from,
     though the list itself spans every board.
     NOT PASSED THROUGH track(): that collects the URLs handed to IndexNow, and
     this page is noindex by design, so announcing it to Bing asks a crawler to
     fetch a page we have already told it not to index. It is out of the
     sitemap for the same reason, and out of Google's Indexing API queue for a
     harder one — that queue takes JobPosting pages only. */
  writeIfChanged(join(root, 'applications.html'), renderApplicationsPage({ region }));

  let removed = 0;
  /* Job pages that just stopped existing, as URLs. Only job pages: the Google
     Indexing API accepts JobPosting pages and nothing else, and a hub carries
     no JobPosting markup on purpose. See src/indexing.js. */
  const removedUrls = [];
  for (const dir of [jobsDir, compDir, ...facetDirs.map(([d]) => d)]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (f.endsWith('.html') && !wanted.has(full)) {
        rmSync(full);
        removed++;
        if (dir === jobsDir) removedUrls.push(regionUrl(`/jobs/${f.slice(0, -'.html'.length)}`, region));
      }
    }
  }

  const indexable = jobs.filter(isIndexable).length;
  /* The same two rules the sitemap applies — isIndexable, then jobSlug — so a
     page cannot be announced to Google that the sitemap does not also list.
     Kept beside the count above rather than recomputed by the caller. */
  const indexUrls = jobs.filter(isIndexable).map((j) => regionUrl(`/jobs/${jobSlug(j)}`, region));
  writeSitemap(jobs, byCompany, root, pastByCompany, region, { report: (stats.facts ?? []).length >= REPORT_MIN_FACTS, facets });
  const feedItems = writeFeeds(jobs, root, region);
  const homeLinks = writeHomePage(jobs, publicDir, region, alternates, channels);

  return {
    jobPages: jobs.length, companyPages: allCompanies.size, indexable, removed, feedItems, homeLinks,
    indexUrls, removedUrls, changedUrls, redirectUrls,
  };
}

/**
 * Render every published region, then the one file they share.
 *
 * robots.txt is written once from the full set rather than per region, because
 * it lives at the root and names every region's sitemap. Writing it inside
 * writePages would mean the last region rendered silently won.
 *
 * Regions are rendered in the order given, which is the order the switch lists
 * them and the order `regions.publish` is written in config.json.
 *
 * @param {Map<string, object[]>} jobsByRegion    region code -> live jobs
 * @param {Map<string, object[]>} historyByRegion region code -> past postings
 * @param {object[]} regions                      published regions, in order
 */
export function writeSite(jobsByRegion, publicDir, historyByRegion, regions, { validDays = DEFAULT_VALID_DAYS, channelsByRegion = new Map(), statsByRegion = new Map(), redirectsByRegion = new Map() } = {}) {
  const alternates = regions.length > 1 ? regions : null;
  const totals = { jobPages: 0, companyPages: 0, indexable: 0, removed: 0, feedItems: 0, homeLinks: 0 };
  const perRegion = [];
  /* Accumulated separately from `totals`, which is summed by key and would turn
     an array into a string. These are every published board's job pages, which
     is the set src/indexing.js announces to Google. */
  const indexUrls = [];
  const removedUrls = [];
  const redirectUrls = [];
  const changedUrls = [];

  // Every live posting, by employer, across every board — the input a job page
  // needs to keep its <title> unique SITE-wide rather than region-wide. Built
  // here because this is the only place that holds all the regions at once;
  // writePages sees one board and cannot know another exists.
  const byCompanyEverywhere = new Map();
  for (const region of regions) {
    for (const job of jobsByRegion.get(region.code) ?? []) {
      if (!byCompanyEverywhere.has(job.company)) byCompanyEverywhere.set(job.company, []);
      byCompanyEverywhere.get(job.company).push({ job, region });
    }
  }

  for (const region of regions) {
    const foreign = new Map();
    for (const [company, entries] of byCompanyEverywhere) {
      const elsewhere = entries.filter((e) => e.region.code !== region.code);
      if (elsewhere.length) foreign.set(company, elsewhere);
    }

    const result = writePages(
      jobsByRegion.get(region.code) ?? [],
      publicDir,
      historyByRegion.get(region.code) ?? [],
      { region, alternates, foreign, validDays, channels: channelsByRegion.get(region.code) ?? [],
        stats: statsByRegion.get(region.code) ?? {},
        redirects: redirectsByRegion.get(region.code) ?? [] },
    );
    for (const k of Object.keys(totals)) totals[k] += result[k];
    indexUrls.push(...result.indexUrls);
    removedUrls.push(...result.removedUrls);
    changedUrls.push(...result.changedUrls);
    redirectUrls.push(...result.redirectUrls);
    perRegion.push({ region, ...result });
  }

  writeRobots(publicDir, regions);
  totals.removed += removeUnpublishedRegions(publicDir, regions);
  return { ...totals, perRegion, indexUrls, removedUrls, changedUrls, redirectUrls };
}

/**
 * Delete the tree of a region that is no longer published.
 *
 * Without this, switching a region off in config.json leaves its board frozen on
 * disk and still served — a page of listings that stopped being updated, which
 * is worse than no page at all, and every one of them stays in Google's index
 * advertising stale vacancies.
 *
 * Scoped to slugs that belong to a REGION and nothing else. `web/public` also
 * holds `jobs`, `companies`, `logos`, `data` and `vendor`, and a rule that
 * removed any directory not named by the current config would delete India's
 * entire board the first time it ran. India is never a candidate: its slug is
 * empty, so it is not in this list at all.
 */
function removeUnpublishedRegions(publicDir, regions) {
  const live = new Set(regions.map((r) => r.slug).filter(Boolean));
  let removed = 0;
  for (const r of ALL_REGIONS) {
    if (!r.slug || live.has(r.slug)) continue;
    const dir = join(publicDir, r.slug);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed++;
    console.warn(`  removed /${r.slug}/ — ${r.name} is no longer in regions.publish.`);
  }
  return removed;
}

/** Only indexable URLs go in the sitemap — submitting pages you tell Google to ignore is noise. */
function writeSitemap(jobs, byCompany, publicDir, pastByCompany = new Map(), region = DEFAULT_REGION, { report = false, facets = { skills: [], cities: [] } } = {}) {
  /* LASTMOD IS A CONTENT DATE, NEVER THE CLOCK, and it is day-granular.
   *
   * It was `new Date().toISOString()` for the board, /companies, /alerts,
   * /report and EVERY company hub — about 159 URLs a region — so all of them
   * claimed to have changed at the moment of writing, on all 48 publishes a
   * day. Two costs, and the second is the real one:
   *
   *   - three sitemaps rewritten in full every run, 163 lines apiece, into a
   *     public repo. That is the timestamp churn fixed on the job pages this
   *     morning, surviving in the one file nobody diffed.
   *   - GOOGLE ACTS ON LASTMOD, and only while it is accurate. A site whose
   *     every URL claims it changed thirty minutes ago, always, teaches
   *     crawlers to ignore the field site-wide — including on the job pages
   *     where it IS true and where freshness is the entire product.
   *
   * So each URL now carries the date of the newest posting BEHIND it: the
   * board and the directories take the freshest role on the board, a hub takes
   * that employer's freshest. Day granularity because a sitemap does not need
   * the minute and because that is what makes it stop moving. */
  const day = (ms) => new Date(ms || Date.now()).toISOString().slice(0, 10);
  const newest = (rows) => (rows ?? []).reduce(
    (max, j) => Math.max(max, j.postedAt ?? j.firstSeenAt ?? 0), 0);
  const boardDay = day(newest(jobs));
  const urls = [
    { loc: regionUrl('/', region), priority: '1.0', lastmod: boardDay },
    { loc: regionUrl('/companies/', region), priority: '0.7', lastmod: boardDay },
    /* /alerts is thin by design — it is a set of links — but it is a real
       destination people search for ("interndoor telegram"), and it is the only
       page that names every channel. Low priority, not omitted. */
    { loc: regionUrl('/alerts', region), priority: '0.4', lastmod: boardDay },
    /* /report is the only page here that does not expire, so it is the only one
       that can accumulate links over years. Listed above the hubs for that
       reason — and omitted entirely when it is noindex, because submitting a
       page you have told Google to ignore is noise. */
    ...(report ? [{ loc: regionUrl('/report', region), priority: '0.7', lastmod: boardDay }] : []),
    /* Facet indexes and pages. Listed above the job pages because they do not
       expire: a job page is deleted at 30 days, while /skills/python is a URL
       that can accumulate authority for as long as the board keeps running. */
    ...(facets.skills.length >= 3 ? [{ loc: regionUrl('/skills/', region), priority: '0.7', lastmod: boardDay }] : []),
    ...(facets.cities.length >= 3 ? [{ loc: regionUrl('/locations/', region), priority: '0.7', lastmod: boardDay }] : []),
    ...facets.skills.map((f) => ({
      loc: regionUrl(`/skills/${f.slug}`, region), priority: '0.6', lastmod: day(newest(f.jobs)),
    })),
    ...facets.cities.map((f) => ({
      loc: regionUrl(`/locations/${f.slug}`, region), priority: '0.6', lastmod: day(newest(f.jobs)),
    })),
    ...jobs.filter(isIndexable).map((j) => ({
      loc: regionUrl(`/jobs/${jobSlug(j)}`, region),
      priority: '0.8',
      lastmod: day(j.postedAt ?? j.firstSeenAt),
    })),
    // Hubs stay in the sitemap whether or not the employer is hiring today.
    // Dropping a URL from the sitemap the week it has no live roles, then
    // re-adding it, tells Google the page is unstable — which is most of the
    // damage the old delete-and-recreate cycle did. Listed once per company.
    //
    // THE BAR IS `hubIndexable`, THE SAME FUNCTION THE PAGE ITSELF CALLS, and
    // it is shared rather than restated because the restatement drifted. This
    // filter used to read `(pastByCompany.get(company) ?? []).length >= 2`
    // against a page that asks `hubHistory(live, past).length >= 2`, and
    // `hubHistory` drops a past posting whose title is already live and then
    // keeps ONE PER TITLE. So an employer who posted the same title twice
    // counted 2 here and rendered 1 there: the page went out `noindex` and the
    // sitemap asked Google to crawl it anyway. Four hubs were in that state on
    // the India board — NVIDIA, Barclays, Salesforce, Accenture in India, each
    // listing exactly one past role. The comment above this one claimed the
    // bars already matched, which is why it went unnoticed for so long.
    ...[...new Set([...byCompany.keys(), ...pastByCompany.keys()])]
      .filter((company) => hubIndexable(byCompany.get(company), pastByCompany.get(company)))
      .map((company) => ({
        loc: regionUrl(`/companies/${companySlug(company)}`, region),
        priority: '0.6',
        // The employer's own freshest role, live or past — the hub genuinely
        // changes when they post, and not otherwise.
        lastmod: day(Math.max(newest(byCompany.get(company)), newest(pastByCompany.get(company)))),
      })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`;
  writeFileSync(join(publicDir, 'sitemap.xml'), xml);
}

/**
 * robots.txt, listing one sitemap per published region.
 *
 * Deliberately NOT a sitemap index. India's sitemap is already submitted in
 * Search Console at /sitemap.xml, and turning that URL into an index — or
 * moving it to make room for one — churns the single entry point Google has for
 * the whole site. Multiple `Sitemap:` lines are standard, cost nothing, and
 * leave the existing URL exactly where it is.
 *
 * Written once at the root, from the full published set, rather than per region
 * — so it is the caller's job to pass every region, not just the one being
 * rendered.
 */
function writeRobots(publicDir, regions = [DEFAULT_REGION]) {
  const sitemaps = regions.map((r) => `Sitemap: ${regionUrl('/sitemap.xml', r)}`).join('\n');
  writeFileSync(join(publicDir, 'robots.txt'), `User-agent: *
Allow: /

${sitemaps}
`);
}

/**
 * RSS and JSON Feed.
 *
 * The site's whole promise is being early, and that only pays off if someone
 * looks. A visitor who checks twice a week gets nothing from a 15-minute
 * refresh. A feed inverts that — new roles arrive wherever they already read
 * things — and it costs nothing to run: two more static files written by the
 * same publish step, with no accounts, no email service and no backend, so the
 * two-process design is untouched.
 *
 * Newest 50 only. A feed reader wants what is new, not a catalogue, and every
 * item here is also a page a crawler can reach through the sitemap.
 */
function writeFeeds(jobs, publicDir, region = DEFAULT_REGION) {
  const recent = [...jobs]
    .sort((a, b) => (b.postedAt ?? b.firstSeenAt ?? 0) - (a.postedAt ?? a.firstSeenAt ?? 0))
    .slice(0, 50);

  /* THE NEWEST ITEM'S OWN DATE, NEVER THE CLOCK.
     lastBuildDate means "the last time the content of the channel changed",
     and the channel IS the 50 items below — so the newest one's pubDate is
     both the honest answer and a stable one. `new Date()` was neither: the
     feed is rebuilt every 30 minutes whether or not a posting arrived, so the
     file was rewritten and committed to a public repo 48 times a day per
     board. Measured over the last 40 commits that touched it: it changed in
     all 40, and in 20 of them this line was the ONLY difference.
     Exactly the rule the sitemap already follows — lastmod carries the date of
     the newest posting behind the URL, not the clock — and for the same
     reason: a feed that claims to have changed every half hour teaches a
     reader to stop believing the field. Omitted entirely when there is nothing
     to date, because it is optional and a guess is worse than silence. */
  const newestAt = recent.length
    ? (recent[0].postedAt ?? recent[0].firstSeenAt ?? 0)
    : 0;
  const built = newestAt
    ? `  <lastBuildDate>${new Date(newestAt).toUTCString()}</lastBuildDate>\n`
    : '';
  const facts = (j) => [
    j.company && `Company: ${j.company}`,
    j.location && `Location: ${j.location}`,
    j.duration && `Duration: ${j.duration}`,
  ].filter(Boolean).join(' · ');

  // Our own summary only — never the employer's description. Same rule as the
  // job pages: republishing their copyrighted text is the one thing that would
  // turn a useful feed into a liability.
  const body = (j) => [facts(j), ...(j.bullets ?? []).map((b) => `• ${b}`)].filter(Boolean).join('\n');

  const items = recent.map((j) => {
    const url = regionUrl(`/jobs/${jobSlug(j)}`, region);
    const date = new Date(j.postedAt ?? j.firstSeenAt ?? Date.now());
    return `  <item>
    <title>${esc(`${j.title} — ${j.company ?? ''}`.trim())}</title>
    <link>${esc(url)}</link>
    <guid isPermaLink="true">${esc(url)}</guid>
    <pubDate>${date.toUTCString()}</pubDate>
    <description>${esc(body(j))}</description>
  </item>`;
  }).join('\n');

  writeFileSync(join(publicDir, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>InternDoor — engineering internships ${esc(region.inName)}</title>
  <link>${regionUrl('/', region)}</link>
  <atom:link href="${regionUrl('/feed.xml', region)}" rel="self" type="application/rss+xml"/>
  <description>New engineering internships ${esc(region.inName)}, listed within minutes of going live.</description>
  <language>${region.hreflang.toLowerCase()}</language>
${built}${items}
</channel>
</rss>
`);

  writeFileSync(join(publicDir, 'feed.json'), `${JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: `InternDoor — engineering internships ${region.inName}`,
    home_page_url: regionUrl('/', region),
    feed_url: regionUrl('/feed.json', region),
    description: `New engineering internships ${region.inName}, listed within minutes of going live.`,
    items: recent.map((j) => ({
      id: regionUrl(`/jobs/${jobSlug(j)}`, region),
      url: regionUrl(`/jobs/${jobSlug(j)}`, region),
      title: `${j.title} — ${j.company ?? ''}`.trim(),
      content_text: body(j),
      date_published: new Date(j.postedAt ?? j.firstSeenAt ?? Date.now()).toISOString(),
      ...(j.company ? { authors: [{ name: j.company }] } : {}),
    })),
  }, null, 2)}\n`);

  return recent.length;
}
