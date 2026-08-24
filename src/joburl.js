/**
 * Turn one careers URL into a posting, so anything spotted by hand can reach
 * the site without waiting for a collector to find it.
 *
 * WHY THIS EXISTS. Amazon's SDE internship for India, job 10506481, is live on
 * amazon.jobs and cannot be found from Amazon. Measured 24 Aug: the whole India
 * board on `search.json` is 2,538 postings and exactly FOUR have an
 * internship-shaped title, all of them Financial Analyst; the id is absent
 * under every query, both locales, with and without a country filter; Amazon's
 * own search UI answers "there are no jobs that meet your criteria" for
 * `SDE Intern` in India; and of the 29 Amazon cards this project has ever seen
 * on LinkedIn, none is an SDE internship. The posting exists only as a page
 * somebody has to already know the address of.
 *
 * So the gap is DISCOVERY, not extraction — the page is server-rendered, the
 * whole description is in the HTML, and robots.txt blocks only `/internal`.
 * This module closes the extraction half and leaves discovery to a human, or
 * later to a search-API sweep.
 *
 * It reuses the board collectors wherever it can: for anything ats.js already
 * knows, the posting is taken off that company's own board rather than parsed
 * out of a page, which costs one request and inherits every fix those
 * collectors have had. Only amazon.jobs needs its own page parser, because its
 * board genuinely does not contain the posting.
 */
import {
  PROVIDERS, parseAtsLink, fetchBoard, fetchDetail, normalisePosting,
} from './ats.js';

/** amazon.jobs/<locale>/jobs/<id>[/slug] — the locale segment is optional. */
const AMAZON_JOB = /amazon\.jobs\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/(\d{5,12})/i;

/** The trailing id in an ATS posting URL, whatever the provider's path shape. */
const TRAILING_ID = /\/(?:jobs?|postings?|p)\/(?:[^/?#]*?-)?([A-Za-z0-9][A-Za-z0-9._-]{3,})\/?(?:[?#]|$)/;

const LINKEDIN_JOB = /linkedin\.com\/jobs\/view\/(\d{6,})/i;

const UA = {
  // Named honestly. A careers page is public and this is one request for one
  // posting somebody already has the address of; pretending to be a browser we
  // are not is the part that would make it sharp practice.
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) InternDoor/1.0 (+https://interndoor.com)',
  accept: 'text/html,application/xhtml+xml',
};

async function fetchText(url, timeoutMs = 20_000) {
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ---------------------------------------------------------------- amazon */

/** Everything between an <h2> heading and the next one, for the headings we want. */
function amazonSections(html) {
  const wanted = /^(description|basic qualifications|preferred qualifications)$/i;
  const out = [];
  // The sidebar is a sibling column; without cutting there the last section
  // swallows the whole "Job details" block and the page footer.
  const body = html.split(/<div class="col-12 col-md-5/i)[0];
  for (const chunk of body.split(/<h2[^>]*>/i).slice(1)) {
    const [heading, ...rest] = chunk.split(/<\/h2>/i);
    if (!wanted.test(heading.replace(/<[^>]+>/g, '').trim())) continue;
    out.push(rest.join('</h2>'));
  }
  return out;
}

function attr(html, re) {
  const m = html.match(re);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim() : null;
}

/**
 * Amazon writes the country as an ISO-3 code the reader has to decode.
 *
 * "Bengaluru, KA, IND" is a location a machine wrote. It ends up on the card,
 * the job page, the JSON-LD and the LinkedIn post, so the country at least gets
 * its name back. The state code is left alone — expanding it would need a
 * table per country, and "KA" beside "Bengaluru" costs a reader nothing.
 */
const ISO3 = {
  IND: 'India', USA: 'United States', GBR: 'United Kingdom', CAN: 'Canada',
  DEU: 'Germany', IRL: 'Ireland', SGP: 'Singapore', AUS: 'Australia',
  POL: 'Poland', NLD: 'Netherlands', FRA: 'France', ESP: 'Spain', JPN: 'Japan',
};

/**
 * Read one amazon.jobs posting out of its own page.
 *
 * Split from the fetch so the parse can be pinned by a test against HTML
 * captured from the live page, the way test/cards.test.mjs does for LinkedIn —
 * a layout change should fail the suite, not a scheduled run.
 *
 * There is NO posted date anywhere on the page — checked, and the reason the
 * row comes through with `postedAt` null. The ATS poller already keeps a
 * posting with no date ("some providers omit it"), so nothing downstream has to
 * change; the row simply sorts by when we first saw it.
 */
export function parseAmazonPage(html, url) {
  const id = String(url ?? '').match(AMAZON_JOB)?.[1];
  if (!id) return null;

  // The title attribute carries the untruncated form; the element text can be
  // clipped with an ellipsis on long titles.
  const title = attr(html, /<h1[^>]*\btitle="([^"]+)"/i)
    ?? attr(html, /<h1[^>]*>([^<]+)<\/h1>/i);
  if (!title) throw new Error('could not read a title — the page layout has changed');

  // "IND, KA, Bengaluru" — country first, which is the reverse of everywhere
  // else. Reversed to city-first so the gazetteer resolves it the same way it
  // resolves every other location, and so the card reads like a place.
  const block = html.match(/class="association location-icon"[\s\S]*?<ul class="association-content">([\s\S]*?)<\/ul>/i)?.[1] ?? '';
  const places = [...block.matchAll(/<li[^>]*>([^<]+)<\/li>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .map((p) => {
      const parts = p.split(',').map((x) => x.trim()).reverse();
      if (parts.length) parts[parts.length - 1] = ISO3[parts[parts.length - 1]] ?? parts[parts.length - 1];
      return parts.join(', ');
    });

  const sections = amazonSections(html);
  if (!sections.length) throw new Error('could not read the description — the page layout has changed');

  return {
    provider: 'amazon',
    // The board token is the country the poller reads. Kept identical so a page
    // fetched by hand and the same posting off the board share one job_id and
    // can never be stored twice.
    token: 'IND',
    company: 'Amazon',
    job: normalisePosting({
      id,
      title,
      location: places[0] ?? null,
      locationAlt: places.slice(1),
      url,
      postedAt: null,
      description: sections.join('<br/><br/>'),
    }),
  };
}

export async function fetchAmazonJob(url) {
  return parseAmazonPage(await fetchText(url), url);
}

/* ------------------------------------------------------------------- ats */

/**
 * Find a posting on the board its URL belongs to.
 *
 * Deliberately not a per-provider single-posting fetcher. Every board here is
 * one request that returns all of its postings, `fetchDetail` already knows
 * which providers hide the description behind a second call, and matching by id
 * inherits whatever those collectors learn later. Writing six new endpoints
 * would be six new things to keep working for no extra coverage.
 */
export async function fetchFromBoard(provider, token, wantedId, url) {
  const jobs = await fetchBoard(provider, token);
  if (!jobs?.length) return null;

  const id = String(wantedId ?? '').toLowerCase();
  const hit = jobs.find((j) => String(j.id).toLowerCase() === id)
    // Lever and Ashby put a UUID in the path; Greenhouse a numeric id. When the
    // path segment is not the id itself, fall back to the posting whose own URL
    // matches the one pasted.
    ?? jobs.find((j) => j.url && url && String(j.url).replace(/\/$/, '') === String(url).split(/[?#]/)[0].replace(/\/$/, ''));
  if (!hit) return null;

  const extra = await fetchDetail(provider, token, hit);
  if (extra?.description) hit.description = extra.description;
  if (extra?.postedAt) hit.postedAt = extra.postedAt;
  return hit;
}

/* ------------------------------------------------------------- dispatch */

/**
 * @returns {Promise<{provider,token,company,job} | {error:string, hint?:string}>}
 */
export async function resolveJobUrl(url, { company = null } = {}) {
  const href = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(href)) return { error: 'not a URL' };

  if (LINKEDIN_JOB.test(href)) {
    return {
      error: 'this is a LinkedIn posting',
      hint: `LinkedIn needs a signed-in browser, which this tool does not open. Use: npm run add-job -- ${href}`,
    };
  }

  if (AMAZON_JOB.test(href)) {
    try {
      return await fetchAmazonJob(href);
    } catch (err) {
      return { error: `could not read the Amazon page (${err.message})` };
    }
  }

  const board = parseAtsLink(href);
  if (!board) {
    return {
      error: 'unrecognised careers site',
      hint: `Known: amazon.jobs and ${Object.keys(PROVIDERS).filter((p) => p !== 'amazon' && p !== 'microsoft').join(', ')}.`,
    };
  }

  const id = href.match(TRAILING_ID)?.[1] ?? null;
  let hit;
  try {
    hit = await fetchFromBoard(board.provider, board.token, id, href);
  } catch (err) {
    return { error: `could not read the ${board.provider} board (${err.message})` };
  }
  if (!hit) {
    return {
      error: `not on ${company || board.token}'s ${board.provider} board`,
      hint: 'The board reads fine, so the posting has most likely closed. Nothing to add.',
    };
  }

  return {
    provider: board.provider,
    token: board.token,
    // A board carries postings, not its own name. Greenhouse and Lever tokens
    // are usually the company in lower case, which is a decent default and
    // wrong often enough that --company exists.
    company: company || board.token,
    job: hit,
  };
}
