/**
 * Web search, as a discovery layer for postings their own employer does not index.
 *
 * The problem this solves, measured 24 Aug: Amazon's India board on
 * `search.json` lists 2,538 postings, of which four have an internship-shaped
 * title and none is engineering — while its SDE internship sits at a live URL
 * Amazon's own search will not return. The page is public, server-rendered and
 * allowed by robots.txt, so GOOGLE HAS IT even though Amazon's search does not.
 * Asking Google is the cheapest honest way to find a page an employer has
 * buried on its own site.
 *
 * Google Programmable Search, not a scraper. Scraping a results page is against
 * Google's terms, breaks whenever the markup moves, and would be the one part
 * of this project that could not be defended. The JSON API is documented, keyed
 * and free to 100 queries a day — far more than this needs, because the sweep
 * runs once a day and asks a handful of questions.
 *
 * Everything here fails soft and returns an empty list. A discovery pass is the
 * least important thing the scheduler does; it must never be why a scan fails.
 *
 * Setup, once:
 *   1. Make a Programmable Search Engine at programmablesearchengine.google.com
 *      set to search the ENTIRE WEB — the sites are chosen per query below, not
 *      in the engine, so adding one is a config edit rather than a visit to
 *      Google.
 *   2. Put its id in .env as GOOGLE_CSE_CX.
 *   3. Enable the Custom Search API in a Google Cloud project and put the key
 *      in .env as GOOGLE_CSE_KEY.
 */
import { log } from './logger.js';

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

/** Google returns at most this many results per request, whatever `num` says. */
export const MAX_PER_QUERY = 10;

export function searchConfigured() {
  return !!(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX);
}

/**
 * Build the query string for one search.
 *
 * Split out and exported so the shape can be pinned by a test without a key or
 * a network call — the only part of this module that has real logic in it.
 *
 * `siteSearch` restricts to one domain, which is what makes a general-purpose
 * engine usable here: the engine searches the whole web and each query narrows
 * it, so the list of careers sites lives in config.json rather than in a
 * Google console nobody will remember to check.
 *
 * `dateRestrict` is the freshness control. An internship posting is worth
 * finding in its first week and not much after, and without a limit every
 * sweep returns the same aged pages and spends its budget re-checking them.
 */
export function buildQuery({ q, site, dateRestrict, num = MAX_PER_QUERY, key, cx }) {
  const params = new URLSearchParams({ key, cx, q, num: String(Math.min(num, MAX_PER_QUERY)) });
  if (site) {
    params.set('siteSearch', site);
    params.set('siteSearchFilter', 'i'); // include, not exclude
  }
  if (dateRestrict) params.set('dateRestrict', dateRestrict);
  return `${ENDPOINT}?${params}`;
}

/**
 * One search. Returns `[{link, title, snippet}]`, or `[]` on any failure.
 *
 * @param {{q: string, site?: string, dateRestrict?: string, num?: number}} spec
 */
export async function search(spec, { timeoutMs = 15_000 } = {}) {
  if (!searchConfigured()) {
    log.warn('GOOGLE_CSE_KEY / GOOGLE_CSE_CX are not set — skipping web discovery.');
    return [];
  }

  const url = buildQuery({ ...spec, key: process.env.GOOGLE_CSE_KEY, cx: process.env.GOOGLE_CSE_CX });

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      // 429 is the daily quota, and it is the one worth naming: it means the
      // sweep is asking more often than the free tier allows, not that
      // anything is broken.
      const why = res.status === 429 ? 'daily quota spent' : `HTTP ${res.status}`;
      log.warn(`Web search failed (${why}) — this pass finds nothing, the next one is unaffected.`);
      return [];
    }
    const body = await res.json();
    if (body.error) {
      log.warn(`Web search refused: ${body.error.message ?? 'no detail'}`);
      return [];
    }
    return (body.items ?? []).map((i) => ({
      link: i.link,
      title: i.title,
      snippet: i.snippet ?? '',
    })).filter((i) => i.link);
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'timed out' : String(err.message).split('\n')[0];
    log.warn(`Web search failed (${why}).`);
    return [];
  }
}
