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
 *    data"), but it is rate-limited per IP instead. A 429 stops discovery for
 *    the rest of the run; nothing is fast-retried into it.
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
 * nothing here retries: a retry into a 429 is how a limit becomes a block.
 */
export async function fetchGuestPage(url, { fetchImpl = globalThis.fetch, timeoutMs = 25_000 } = {}) {
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
  if (status === 429 || status === 999) return { blocked: true, status };
  if (status !== 200) return { failed: true, status };

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
