/**
 * LinkedIn's PUBLIC job search — discovery without the signed-in account.
 *
 * WHY THIS EXISTS. On 25 Sep 2026 LinkedIn moved both scraper accounts to the
 * AI-powered search (`/jobs/search-results/`), and it does not answer the
 * question the site asks. Our classic URL was rewritten into a sentence —
 * "(intern OR …) posted in the past 24 hours" — `location=India` became the
 * account's own "Greater Delhi Area", `sortBy=DD` was dropped for relevance,
 * and the US account got the empty onboarding page instead of results. India
 * collected 12-18-hour-old Delhi postings and nothing else; the US search
 * aborted every run.
 *
 * The public endpoint below is what LinkedIn's own signed-out job search pages
 * call. Measured the same day, it still honours `keywords` (boolean),
 * `location`, `geoId`, `f_E` and `f_TPR` exactly — every card on every page of
 * a 3h window was under 3h old — and every card carries its real job id,
 * which the AI search's list does not.
 *
 * WHAT IT DOES NOT DO, AND WHAT THAT COSTS:
 *  - It IGNORES `sortBy=DD`. Ages are mixed on every page at every depth, so
 *    a walk must read its window to the END — the covered-ground and all-old
 *    page stops in index.js assume date order and are switched off for it.
 *  - It returns 10 cards a request, not 25, and stops at offset 1000.
 *  - It is unauthenticated: requests cost the SCRAPER ACCOUNTS nothing, which
 *    is the budget LinkedIn has already warned about ("requesting too much
 *    data"), but it is rate-limited per IP instead. A 429 is waited out a few
 *    minutes at a time (fetchGuestPageRetrying); one that outlasts the waits
 *    stops discovery for the rest of the run.
 *  - The employer's apply URL is behind a sign-in wall on the public job page,
 *    so OPENS stay on the signed-in account (openAndExtract, by job id).
 *
 * Parsing is pure and lives here so it is tested against captured markup
 * rather than verified by eye; the fetch takes its `fetch` as an argument for
 * the same reason.
 */
import { searchParams, cardIdentity } from './linkedin.js';

export const GUEST_SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

/** Cards per request. Measured: `start` counts CARDS, and 25 overlaps 20-29. */
export const GUEST_PAGE_SIZE = 10;

/** No offset at or past this returns anything (990 does; 1000 is empty). */
export const GUEST_RESULT_CEILING = 1000;

/** Page caps in config are written in LinkedIn's classic 25-card pages. */
const CLASSIC_PAGE_SIZE = 25;

/**
 * Which collector finds a search's cards: 'guest' (this module) or 'browser'
 * (the signed-in search page). A search may override the config-wide setting.
 * Absent means 'browser', so a config written before this existed — every
 * test fixture — keeps the behaviour it was written against.
 */
export function searchSourceFor(search = {}, cfg = {}) {
  const v = String(search.searchSource ?? cfg.searchSource ?? 'browser').toLowerCase();
  return v === 'guest' ? 'guest' : 'browser';
}

/**
 * A search's page cap, converted into guest requests.
 *
 * `maxPages` and `limits.maxPagesPerSearch` mean 25-card pages; the same cap
 * here is 2.5x as many requests, and never more than the endpoint will serve.
 */
export function guestRequestCap(pageCap) {
  const cap = Number(pageCap);
  const ceiling = GUEST_RESULT_CEILING / GUEST_PAGE_SIZE;
  if (!(cap > 0)) return ceiling;
  return Math.min(ceiling, Math.ceil((cap * CLASSIC_PAGE_SIZE) / GUEST_PAGE_SIZE));
}

export function buildGuestSearchUrl(search, filters, opts) {
  return `${GUEST_SEARCH_URL}?${searchParams(search, filters, opts).toString()}`;
}

/** The handful of entities LinkedIn's server markup actually uses. */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Visible text of a markup fragment: comments and tags out, whitespace folded. */
function textOf(fragment) {
  return decodeEntities(String(fragment ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The inner markup of the first element carrying `cls`, up to its close tag. */
function inner(block, cls, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</${tag}>`);
  return (block.match(re) || [])[1] ?? null;
}

/**
 * Every card in one response, as plain fields.
 *
 * A card is the markup from one `urn:li:jobPosting:<id>` to the next — the id
 * is the one thing every card has, so it is the boundary rather than `<li>`,
 * which LinkedIn is free to restyle. `listed` counts those boundaries whether
 * or not the fields beside them could be read, so the caller can tell "the
 * endpoint returned nothing" (end of results) from "it returned cards we can
 * no longer read" (a markup change, which must be loud).
 */
export function parseGuestCards(html) {
  const s = String(html ?? '');
  const marks = [...s.matchAll(/data-entity-urn="urn:li:jobPosting:(\d+)"/g)];
  const rows = [];
  for (let i = 0; i < marks.length; i++) {
    const block = s.slice(marks[i].index, marks[i + 1]?.index ?? s.length);
    const jobId = marks[i][1];
    const title = textOf(inner(block, 'base-search-card__title', 'h3'));
    // The subtitle holds a link for an employer with a LinkedIn page and bare
    // text for one without, so it is read as text either way.
    const company = textOf(inner(block, 'base-search-card__subtitle', 'h4'));
    const location = textOf(inner(block, 'job-search-card__location', 'span'));
    const timeTag = block.match(/<time\b([^>]*)>([\s\S]*?)<\/time>/);
    const time = timeTag ? [null, (timeTag[1].match(/datetime="([^"]*)"/) || [])[1], timeTag[2]] : null;
    const salary = inner(block, 'job-search-card__salary-info', 'span');
    const benefits = inner(block, 'job-posting-benefits__text', 'span');
    const logo = block.match(/<img\b[^>]*data-delayed-url="(https:\/\/media\.licdn\.com\/[^"]+)"/);
    const link = block.match(/class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/)
      || block.match(/href="([^"]*\/jobs\/view\/[^"]+)"/);
    rows.push({
      jobId,
      title,
      company,
      location,
      postedText: time ? textOf(time[2]) : '',
      postedDate: time?.[1] || null,
      salaryText: salary ? textOf(salary) || null : null,
      benefits: benefits ? textOf(benefits) || null : null,
      logoUrl: logo ? decodeEntities(logo[1]) : '',
      // Tracking parameters out: refId/trackingId change on every request.
      href: link ? decodeEntities(link[1]).split('?')[0] : '',
    });
  }
  return { rows, listed: marks.length };
}

/**
 * Rows into the card shape the gates in index.js read — the same fields
 * enumerateCards produces, so nothing downstream needs to know which
 * collector found a card. `key` is the real id: there is no synthetic key to
 * fall back to here, and none is needed.
 */
export function guestCards(rows) {
  const counts = new Map();
  const seen = new Set();
  const cards = [];
  rows.forEach((row, index) => {
    if (!row.jobId || !row.title || seen.has(row.jobId)) return;
    seen.add(row.jobId);
    const parsed = {
      title: row.title,
      company: row.company,
      location: row.location,
      workplaceType: null,
      postedText: row.postedText,
      salaryText: row.salaryText,
      easyApply: false,
      promoted: false,
      viewed: false,
    };
    const identity = cardIdentity(parsed);
    const nth = counts.get(identity) ?? 0;
    counts.set(identity, nth + 1);
    cards.push({ ...parsed, key: row.jobId, identity, jobId: row.jobId, index, nth, logoUrl: row.logoUrl, href: row.href });
  });
  return cards;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Fetch one page of results and say plainly which of five things happened.
 *
 *   { cards }                  — a page of cards
 *   { end: true }              — past the last result: HTTP 200, no cards
 *   { blocked: true, status }  — 429, or LinkedIn's non-standard 999
 *   { networkError: true }     — the request never completed
 *   { failed: true, status }   — any other status
 *   { markupChanged: true }    — cards were listed and none could be read
 *
 * No cookies are sent — this must never be tied to a scraper account — and
 * nothing here retries: an immediate retry into a 429 is how a limit becomes a
 * block. fetchGuestPageRetrying waits minutes, not seconds, before asking again.
 */
export async function fetchGuestPage(url, { fetchImpl = globalThis.fetch, timeoutMs = 25_000, parse = 'cards' } = {}) {
  let res;
  let body;
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await res.text();
  } catch (err) {
    return { networkError: true, error: String(err?.message ?? err).split('\n')[0] };
  }
  const status = res.status;
  if (status === 429 || status === 999) {
    const retryAfterMs = retryAfterMsOf(res.headers?.get?.('retry-after'));
    return retryAfterMs == null ? { blocked: true, status } : { blocked: true, status, retryAfterMs };
  }
  if (status !== 200) return { failed: true, status };
  // A posting page is parsed by its caller (fetchPublicPosting).
  if (parse === 'posting') return { status, body };

  const { rows, listed } = parseGuestCards(body);
  if (!listed) {
    // A card-shaped fragment with no id in it is a markup change, not an end.
    if (/base-card|job-search-card/.test(body)) return { markupChanged: true, status, body };
    return { end: true, status };
  }
  const cards = guestCards(rows);
  if (!cards.length) return { markupChanged: true, status, body };
  return { cards, listed, status };
}

/** A Retry-After header in milliseconds — seconds or an HTTP date — or null. */
export function retryAfterMsOf(value, now = Date.now()) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * How long to wait out a 429 before asking again: 2, then 5, then 10 minutes.
 *
 * MEASURED 25 SEP 2026, the first day on this endpoint: three 429s, each after
 * a modest 27-52 requests in 15 minutes (other quarters carried 90 in ten
 * minutes and drew nothing), and every one had cleared by the next run 22-27
 * minutes later. Abandoning the run cost more than waiting would have: the
 * India full-time walk after each block found 7 and 12 roles posted before the
 * blocked walk — an hour late — and the stretched window behind one of them
 * reached the 1,000-result limit. So a block is waited out here, gently and
 * never more than 17 minutes in all; one that outlasts that still stops
 * discovery for the run.
 */
export const GUEST_BLOCK_WAITS_MS = [120_000, 300_000, 600_000];

/** A Retry-After longer than this is not waited out inside a run. */
const MAX_BLOCK_WAIT_MS = 15 * 60_000;

/**
 * fetchGuestPage, waiting out a 429 (GUEST_BLOCK_WAITS_MS) and asking for the
 * SAME page again, so a walk resumes where it was refused instead of being
 * abandoned.
 *
 *  - ONLY a 429. LinkedIn's 999 is its "you look like a bot" answer, and asking
 *    again is how that becomes a longer ban; it is returned at once.
 *  - A wait the run cannot afford (`budgetMs`) is not started: the block is
 *    returned and the caller stops discovery, exactly as before.
 *  - A Retry-After longer than the planned wait is honoured, up to 15 minutes.
 *
 * Returns fetchGuestPage's answer plus `retries` and `waitedMs`.
 */
export async function fetchGuestPageRetrying(url, {
  fetchImpl = globalThis.fetch,
  waits = GUEST_BLOCK_WAITS_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  budgetMs = Infinity,
  onWait = () => {},
  parse = 'cards',
} = {}) {
  let res = await fetchGuestPage(url, { fetchImpl, parse });
  let retries = 0;
  let waitedMs = 0;
  while (res.blocked && res.status === 429 && retries < waits.length) {
    const ms = Math.min(MAX_BLOCK_WAIT_MS, Math.max(waits[retries], res.retryAfterMs ?? 0));
    if (waitedMs + ms > budgetMs) break;
    onWait({ attempt: retries + 1, of: waits.length, waitMs: ms });
    await sleep(ms);
    waitedMs += ms;
    retries++;
    res = await fetchGuestPage(url, { fetchImpl, parse });
  }
  return { ...res, retries, waitedMs };
}

/**
 * A search's keywords split into two smaller searches whose union asks the same
 * question — or null when they cannot be.
 *
 * Only a flat OR-list splits: "(a OR b OR c)" becomes "(a OR b)" and "(c)", and
 * a posting matching any term is still asked for by exactly the half holding
 * that term. Anything with nested brackets or an AND/NOT is left alone: halving
 * it would change what it means. A quoted phrase is one term, whatever is in it.
 */
export function splitKeywords(keywords) {
  const s = String(keywords ?? '').trim();
  const body = /^\(.*\)$/s.test(s) ? s.slice(1, -1) : s;
  const terms = [];
  let term = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '(' || ch === ')')) return null;
    if (!quoted && body.startsWith(' OR ', i)) { terms.push(term.trim()); term = ''; i += 3; continue; }
    term += ch;
  }
  if (quoted) return null;
  terms.push(term.trim());
  if (terms.length < 2 || terms.some((t) => !t)) return null;
  // An AND or NOT outside quotes binds tighter than OR; splitting would regroup it.
  if (terms.some((t) => /(^|\s)(AND|NOT)(\s|$)/.test(t.replace(/"[^"]*"/g, '')))) return null;
  const half = Math.ceil(terms.length / 2);
  return [terms.slice(0, half), terms.slice(half)].map((g) => `(${g.join(' OR ')})`);
}

/** Pages read just before the limit that decide whether a re-read is worth it. */
export const REREAD_TAIL_PAGES = 10;

/** Most requests a walk may spend re-reading, in passes: the first read plus five. */
export const MAX_WALK_PASSES = 6;

/**
 * Whether a walk that reached the 1,000-result limit is re-read as two smaller
 * searches, and which.
 *
 * MEASURED 25 SEP 2026 over every public-search walk that day: the
 * internship walks opened 3 cards on pages 81-90, 1 on 91-100 and saved none
 * there — and none of 2,894 US internships stored in 14 days had a title
 * without an intern word, the words that rank a card near the top. The India
 * full-time walk saved as many on pages 71-80 (17) as on 1-10 (25), and 5 on
 * 91-100. So the part past the limit is filler for one search and real roles
 * for the other, and the pages just before the limit say which: a re-read
 * happens only when the last REREAD_TAIL_PAGES pages still held a card worth
 * opening (`tailHits`, cards per page that were held already, opened before or
 * opened now). Re-reading filler would spend ~200 requests against the IP
 * limit for nothing.
 */
export function rereadPlan({ tailHits = [], keywords, passes = 1, maxPasses = MAX_WALK_PASSES } = {}) {
  const hits = tailHits.slice(-REREAD_TAIL_PAGES).reduce((a, b) => a + b, 0);
  if (!hits) return { reason: `the last ${REREAD_TAIL_PAGES} pages held nothing worth opening, so the rest is filler` };
  const parts = splitKeywords(keywords);
  if (!parts) return { reason: 'its keywords are not a plain OR-list, so they cannot be split' };
  if (passes + parts.length > maxPasses) return { reason: `the walk has already been split into ${passes} parts` };
  return { parts, hits };
}

/* ------------------------------------------------------------------------
 * THE POSTING'S PUBLIC PAGE — read before the account opens anything.
 *
 * WHY (26 Sep 2026). LinkedIn signed the India account out with "your account
 * has accessed a high volume of LinkedIn profile data" after a day of 1,054
 * page loads on it, 766 of them postings opened one by one. 343 of those opens
 * were thrown away the moment they were read — 314 asked for 2+ years, 29 were
 * tagged Full-time — and every fact those refusals rested on is on this page,
 * which LinkedIn serves signed out: the full description, the seniority level,
 * the employment type, the company. So the refusals run here, at no cost to
 * the account, and the account opens a posting only when it is being KEPT and
 * only for the one thing this page hides behind a sign-in: the employer's own
 * apply link.
 * ---------------------------------------------------------------------- */

export const publicPostingUrl = (jobId) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(jobId)}`;

/** A block of posting markup as text with its line structure kept, the way
 *  the account page's innerText reads — the stipend and experience readers are
 *  line-based. */
function blockText(fragment) {
  return decodeEntities(String(fragment ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6])>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** The seniority values the account page's chip reader accepts (linkedin.js). */
const SENIORITY_LEVEL = /^(Internship|Entry level|Associate|Mid-Senior level|Director|Executive)$/i;

/**
 * One public posting page, as the fields `openAndExtract` returns — minus the
 * employer apply link, which this page does not carry. Null when the page holds
 * no description block at all (a markup change, or not a posting).
 *
 * THE EMPLOYMENT TAG IS AN INTERNSHIP IF EITHER FIELD SAYS SO. The account
 * page reads one chip out of a header string; this page states the employment
 * type ("Full-time") and the seniority level ("Internship") separately, and
 * Snowflake's Core Infrastructure intern is exactly that pair. Reading only the
 * employment type would refuse internships the account page admitted — and a
 * refusal here is never re-checked on the account.
 */
export function parsePublicPosting(html, jobId) {
  const s = String(html ?? '');
  const desc = inner(s, 'show-more-less-html__markup', 'div');
  if (desc == null) return null;
  const criteria = {};
  for (const m of s.matchAll(/job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)) {
    criteria[textOf(m[1]).toLowerCase()] = textOf(m[2]);
  }
  const employment = criteria['employment type'] || null;
  const seniority = criteria['seniority level'] || null;
  const internship = /^internship$/i.test(employment ?? '') || /^internship$/i.test(seniority ?? '');
  const logo = s.match(/<img\b[^>]*class="[^"]*artdeco-entity-image[^"]*"[^>]*data-delayed-url="(https:\/\/media\.licdn\.com\/[^"]+)"/)
    || s.match(/<img\b[^>]*data-delayed-url="(https:\/\/media\.licdn\.com\/dms\/image\/[^"]+company-logo[^"]+)"/);
  return {
    jobId: String(jobId),
    title: textOf(inner(s, 'topcard__title', 'h2')),
    company: textOf(inner(s, 'topcard__org-name-link', 'a')) || textOf(inner(s, 'topcard__flavor', 'span')),
    location: textOf(inner(s, 'topcard__flavor--bullet', 'span')),
    description: blockText(desc),
    employmentTag: internship ? 'Internship' : employment,
    seniorityTag: seniority && SENIORITY_LEVEL.test(seniority) ? seniority : null,
    jobFunction: criteria['job function'] || null,
    applicants: textOf(inner(s, 'num-applicants__caption', 'span') ?? inner(s, 'num-applicants__caption', 'figcaption')) || null,
    postedText: textOf(inner(s, 'posted-time-ago__text', 'span')) || '',
    salaryText: textOf(inner(s, 'salary', 'div')) || null,
    /* WHERE THE APPLY BUTTON GOES, off the page's own tracking names (read off
       three real pages, 26 Sep 2026): `apply-link-offsite` is the employer's
       own site — the one thing an account open is still worth doing for —
       and `apply-link-onsite` is LinkedIn's own form, where an open could only
       return LinkedIn's form. NEITHER is null, and null is treated as offsite
       by the caller: a renamed marker must cost an account open, never an
       employer link. */
    applyKind: /apply-link-offsite/.test(s) ? 'offsite' : /apply-link-onsite/.test(s) ? 'onsite' : null,
    // A closed posting's page has no apply button at all (YASH, 26 Sep 2026).
    closed: /closed-job|No longer accepting applications/i.test(s),
    logoUrl: logo ? decodeEntities(logo[1]) : '',
    workplaceType: null,
    applyUrl: null,
    viaPublicPage: true,
  };
}

/**
 * Fetch and parse one public posting page. The same five answers as a search
 * page, plus `gone` (404/410 — the posting was taken down). A 429 is waited out
 * exactly as discovery waits it out (fetchGuestPageRetrying's schedule).
 */
export async function fetchPublicPosting(jobId, opts = {}) {
  const res = await fetchGuestPageRetrying(publicPostingUrl(jobId), { ...opts, parse: 'posting' });
  if (res.blocked || res.networkError) return res;
  if (res.status === 404 || res.status === 410) return { gone: true, status: res.status, retries: res.retries, waitedMs: res.waitedMs };
  if (res.failed) return res;
  const detail = parsePublicPosting(res.body, jobId);
  if (!detail) return { markupChanged: true, status: res.status, body: res.body, retries: res.retries, waitedMs: res.waitedMs };
  // No longer accepting applications: as good as taken down for a job board.
  if (detail.closed) return { gone: true, closed: true, status: res.status, retries: res.retries, waitedMs: res.waitedMs };
  return { detail, retries: res.retries, waitedMs: res.waitedMs };
}
