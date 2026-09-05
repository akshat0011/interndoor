/**
 * The LinkedIn-specific layer: URL construction, list enumeration, detail
 * extraction.
 *
 * LinkedIn rotates its CSS class names, so nothing here trusts a single
 * selector. Every field is read through a ladder of strategies — stable data
 * attributes first, then ARIA and semantic structure, then text heuristics —
 * and anything that still comes up empty is reported rather than guessed at.
 * `assertListRendered` in guard.js turns a total miss into a loud error instead
 * of a quiet "no jobs today".
 */
import { log } from './logger.js';
import { pause, sleep, humanClick, humanScrollContainer, rand } from './human.js';
import { jobIdFromUrl } from './extract.js';
import { probeVariant } from './searchvariant.js';
import { normaliseCompany } from './config.js';

export const RESULTS_PER_PAGE = 25;

/** Candidate selectors for the scrollable results column, best first. */
const LIST_CONTAINERS = [
  '.jobs-search-results-list',
  '.scaffold-layout__list > div',
  '.scaffold-layout__list',
  'div[data-results-list-top-scroll-sentinel] + div',
  '.jobs-search__results-list',
];

/**
 * Candidate selectors for the detail pane's description body.
 *
 * The first entry is the redesigned surface (`/jobs/search-results/`), and it is
 * the only id on the page that means anything: `JobDetails_AboutTheJob_<jobId>`
 * carries the posting's real id, which is otherwise absent from the DOM until
 * the URL updates. Everything after it is the previous layout, kept because the
 * standalone `/jobs/view/` page and the older search still serve it.
 */
const DESCRIPTION_SELECTORS = [
  '[id^="JobDetails_AboutTheJob_"]',
  '#job-details',
  '.jobs-description__content',
  '.jobs-description-content__text',
  '.jobs-box__html-content',
  'article.jobs-description__container',
  '[class*="jobs-description"]',
];

/**
 * Build a job-search URL.
 *
 * Verified parameters: f_TPR=r86400 is "posted within the last 86400 seconds",
 * sortBy=DD is date-descending (R would be relevance), f_JT=I is internship,
 * and `start` pages in increments of 25. Combining a tight keyword with
 * f_TPR + sortBy=DD is the cheapest way to keep the page count — and therefore
 * the request count — low.
 */
export function buildSearchUrl(search, filters, { start = 0 } = {}) {
  const params = new URLSearchParams();

  // A company-id search carries no keywords at all: f_C already restricts the
  // results to those exact employers, and adding a keyword could only narrow
  // it further and drop postings that do not happen to contain the word.
  if (search.companyIds?.length) {
    params.set('f_C', search.companyIds.join(','));
    if (search.keywords) params.set('keywords', search.keywords);
  } else {
    params.set('keywords', search.keywords ?? '');
  }

  if (search.location) params.set('location', search.location);
  if (search.geoId) params.set('geoId', String(search.geoId));

  const seconds = Math.round((filters.postedWithinHours ?? 24) * 3600);
  params.set('f_TPR', `r${seconds}`);
  params.set('sortBy', filters.sortBy === 'relevance' ? 'R' : 'DD');

  if (filters.jobTypes?.length) {
    // LinkedIn codes: F full-time, P part-time, C contract, T temporary,
    // I internship, V volunteer, O other.
    const codes = filters.jobTypes.map((t) => (t.length === 1 ? t : t.toUpperCase()[0] === 'I' ? 'I' : t[0].toUpperCase()));
    params.set('f_JT', [...new Set(codes)].join(','));
  }
  if (search.workplaceTypes?.length) params.set('f_WT', search.workplaceTypes.join(','));
  if (search.distance) params.set('distance', String(search.distance));
  if (start > 0) params.set('start', String(start));

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

export function jobUrl(jobId) {
  return `https://www.linkedin.com/jobs/view/${jobId}/`;
}

/**
 * The same posting, but rendered inside the search results' detail pane.
 *
 * `/jobs/view/<id>` is the right URL to *publish* — it is what a human should
 * be sent to. It is the wrong URL to *read*, because the standalone page uses a
 * different layout from the pane, and every selector in DESCRIPTION_SELECTORS
 * is tuned for the pane. Navigating to the standalone page returns a
 * description of zero characters: the extraction silently produces nothing, and
 * the posting ends up on the site as a bare title.
 *
 * `?currentJobId=` asks the search page to open with that job already selected,
 * which puts the description back in the markup the extractor knows how to read.
 */
export function jobPaneUrl(jobId) {
  return `https://www.linkedin.com/jobs/search/?currentJobId=${jobId}`;
}

/**
 * Navigate, retrying the failures that are about the network rather than the
 * page.
 *
 * A laptop changes networks, sleeps, and reconnects constantly, and Chromium
 * surfaces that as ERR_NETWORK_CHANGED / ERR_INTERNET_DISCONNECTED / a
 * navigation timeout. These used to end the whole run: one recorded failure was
 * ERR_NETWORK_CHANGED on the very first page, which threw away a 15-minute slot
 * over a wifi handover that had already recovered by the time it was logged.
 *
 * Deliberately narrow. A 4xx/5xx from LinkedIn, a challenge, or a rate-limit
 * banner is NOT retried here — those are answered by guard.js, and retrying
 * into them is exactly the behaviour that turns a rate limit into a ban.
 */
// net::ERR_ABORTED is in here on purpose and is NOT the same as
// ERR_CONNECTION_ABORTED above. It is what Chromium reports when a second
// navigation supersedes the one we asked for — LinkedIn's own SPA redirect
// racing our goto — so it means "that load was replaced", not "the network
// failed". It was ending runs on the very first page load of the feed.
const TRANSIENT_NAV = /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(RESET|CLOSED|TIMED_OUT|REFUSED|ABORTED)|ERR_ABORTED|ERR_ADDRESS_UNREACHABLE|ERR_QUIC_PROTOCOL_ERROR|ERR_HTTP2_PROTOCOL_ERROR|ERR_SOCKET_NOT_CONNECTED|ERR_EMPTY_RESPONSE|Timeout .* exceeded/i;

export async function gotoResilient(page, url, opts = {}, { attempts = 3, label = 'page' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', ...opts });
    } catch (err) {
      lastErr = err;
      const first = err.message.split('\n')[0];
      if (!TRANSIENT_NAV.test(first) || attempt === attempts) throw err;
      log.warn(`Network hiccup loading ${label} (attempt ${attempt}/${attempts}): ${first}`);
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

/**
 * Start the session the way a person would: land on the feed, sit for a
 * moment, then move to jobs — rather than deep-linking straight into a
 * filtered search URL from a cold session.
 */
export async function warmUp(page, cfg) {
  log.info('Warming up on the feed…');
  // Non-fatal. The warm-up exists to look like a person arriving, not to
  // collect anything, so a feed that will not load is a reason to go straight
  // to the search — not to throw away the whole run before it has looked at a
  // single posting. This threw on ERR_ABORTED and killed runs outright.
  try {
    await gotoResilient(page, 'https://www.linkedin.com/feed/', {}, { label: 'the feed' });
    await pause(cfg.pacing.warmupOnFeed);
    await page.mouse.wheel(0, rand(300, 900));
    await pause(cfg.pacing.afterNavigation);
  } catch (err) {
    log.warn(`Warm-up skipped — ${err.message.split('\n')[0]}`);
  }
}

/**
 * Is a recency marker on the page yet?
 *
 * Module scope so the two waiters in gotoSearch cannot drift, and deliberately
 * self-contained: it is handed to `page.waitForFunction`, which serialises it
 * and runs it in the browser, so it may reference nothing from this file. The
 * same expression is inlined as `MARK` inside scanCardsInPage for that reason —
 * keep the three in step.
 */
export function hasRecencyMarker() {
  return /Be an early applicant|Actively reviewing applicants|\d+\s+(minute|hour|day|week)s?\s+ago/i
    .test(document.body?.innerText ?? '');
}

/** How long to wait for a recency marker before falling back to the race. */
const MARKER_TIMEOUT_MS = 12_000;

/** Navigate to a search URL and wait for the results column to exist. */
export async function gotoSearch(page, url, cfg, outcome = {}) {
  const response = await gotoResilient(page, url, {}, { label: 'the results page' }).catch((err) => {
    const first = err.message.split('\n')[0];
    // Why this failed decides whether the scheduler may retry in two minutes or
    // must wait out its full interval. A request that never left this machine
    // costs LinkedIn nothing and can be repeated immediately; anything that
    // reached them and came back unhappy must not be.
    outcome.networkError = TRANSIENT_NAV.test(first);
    log.warn(`Navigation problem: ${first}`);
    return null;
  });

  // LinkedIn uses 999 as a non-standard "request denied"; 429 is the standard
  // rate limit. Either means stop, and guard.js will classify it next.
  const status = response?.status();
  if (status === 429 || status === 999) {
    log.error(`LinkedIn returned HTTP ${status} — backing off.`);
    // Never fast-retry into a rate limit. This is the one flag that outranks
    // networkError, because walking straight back into a 429 is how a session
    // gets restricted.
    outcome.blocked = true;
    return false;
  }

  await pause(cfg.pacing.afterNavigation);

  // THE RECENCY MARKER FIRST, ON ITS OWN. Only then the race below.
  //
  // A recency marker is the one signal that means the results are actually
  // painted, because it is card text. The other two do not: none of the named
  // containers exists on the redesigned page at all, and the single
  // /jobs/view/ link that does render belongs to the DETAIL PANE, which paints
  // before the list.
  //
  // That was already the reasoning for adding the marker waiter — but it was
  // added as a third racer, and Promise.race settles on whichever fires FIRST.
  // So the /jobs/view/ link went on winning, and the 0.8-2s sleep below was the
  // only thing between it and scanCardsInPage. scanCardsInPage finds cards BY
  // the marker, so a list still showing skeleton placeholders reads as zero
  // cards — and zero cards on page 1 is what assertListRendered is built to
  // treat as a markup break, so it aborted the whole run and screenshotted a
  // perfectly healthy page. Six runs died this way between 13 and 26 Aug 2026;
  // screenshots/empty-list-2026-08-26T11-23-14-171Z.png shows it exactly, the
  // detail pane fully painted beside a column of grey placeholder bars, while
  // the run 35 minutes earlier had read 421 cards on the same selectors.
  //
  // The race is KEPT as the fallback, for the pages that genuinely never get a
  // marker: an empty result set, and the tail page where the only card left is
  // stamped "Viewed". Those are the cases the containers and the link are still
  // good evidence for. On a healthy page this costs nothing, because the marker
  // is what appears first anyway.
  const marked = await page
    .waitForFunction(hasRecencyMarker, null, { timeout: MARKER_TIMEOUT_MS })
    .then(() => true).catch(() => false);

  const appeared = marked || await Promise.race([
    page.waitForSelector(LIST_CONTAINERS.join(', '), { timeout: 25_000 }).then(() => true).catch(() => false),
    page.waitForSelector('a[href*="/jobs/view/"]', { timeout: 25_000 }).then(() => true).catch(() => false),
    page.waitForFunction(hasRecencyMarker, null, { timeout: 25_000 }).then(() => true).catch(() => false),
  ]);

  if (!appeared) {
    log.warn('No results container appeared within 37s.');
    return false;
  }

  await sleep(rand(800, 2000));
  return true;
}

/**
 * Find the job cards on the redesigned results page, in the page's own context.
 *
 * Deliberately self-contained — it is handed to `page.evaluate`, which
 * serialises the function and runs it in the browser, so it can reference
 * nothing from module scope. Both the list read and the click that follows go
 * through it, because two definitions of "a card" would drift apart.
 *
 * Anchoring on card TEXT rather than on classes is not a stylistic choice. The
 * August 2026 redesign of `/jobs/search-results/` removed every hook the old
 * code relied on: `data-job-id`, `data-occludable-job-id`,
 * `.jobs-search-results-list` and `.scaffold-layout__list` all return nothing,
 * cards are nested `<div>`s with hashed class names, and the page holds 16
 * `<li>` in total. What every card does still have is a logo, three or more
 * lines of text, and a recency marker.
 *
 * Every card is tagged `data-watcher-card="<index>"` on the way out, which is
 * how a card found here is clicked later. Matching is deliberately NOT done in
 * this function: `innerText` returns only what is currently laid out, so the
 * accessible label ("Intern - AI (Verified job)") is present on one scan and
 * absent on the next, and any comparison of raw lines between two scans fails.
 * The caller parses the rows instead, which folds both shapes to the same
 * company and title, and clicks the index it picks.
 */
function scanCardsInPage() {
  const MARK = /Be an early applicant|Actively reviewing applicants|\d+\s+(minute|hour|day|week)s?\s+ago/i;
  const linesOf = (el) => (el.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

  // The innermost elements carrying a recency marker; each sits inside exactly
  // one card.
  //
  // This deliberately does NOT require a leaf. On 12 Aug LinkedIn started
  // rendering the stamp as `<time>2 minutes ago<span>Within the past 24
  // hours</span></time>`, so the element holding the marker gained a child and
  // every card in the results column stopped matching. The only leaf left was
  // the detail pane's own "· 2 minutes ago ·", which is exactly why discovery
  // collapsed to one card a page again.
  //
  // Innermost-match subsumes the old leaf rule — a matching leaf has no
  // matching descendant — so both shapes are covered and an A/B rollback needs
  // no further change here.
  const matching = [...document.querySelectorAll('*')].filter((e) => MARK.test(e.textContent ?? ''));
  const marks = matching.filter((e) => !matching.some((o) => o !== e && e.contains(o)));

  const found = new Set();
  for (const m of marks) {
    for (let e = m.parentElement; e; e = e.parentElement) {
      // The smallest ancestor that looks like a whole card: a logo, at least a
      // title/company/location, and not so much text that it is the list itself.
      if (e.querySelector('img') && linesOf(e).length >= 3 && (e.innerText ?? '').length < 420) {
        found.add(e);
        break;
      }
    }
  }
  // Drop any match that merely contains another — keep the innermost.
  let cards = [...found].filter((c) => ![...found].some((o) => o !== c && o.contains(c)));

  // The scrollable ancestor holding the most cards is the results column.
  const counts = new Map();
  for (const c of cards) {
    for (let e = c.parentElement; e && e !== document.body; e = e.parentElement) {
      if (e.scrollHeight > e.clientHeight + 50) {
        counts.set(e, (counts.get(e) ?? 0) + 1);
        break;
      }
    }
  }
  let container = null;
  let best = 0;
  for (const [el, n] of counts) if (n > best) { container = el; best = n; }

  // The detail pane's own header is a logo plus three short lines, so it passes
  // the card test — and its shape is company/title/"place · time · applicants",
  // which parses into nonsense. Restricting to the results column removes it,
  // and nothing else, so it never reaches the watchlist gate.
  if (container) {
    document.querySelectorAll('[data-watcher-list]').forEach((e) => e.removeAttribute('data-watcher-list'));
    container.setAttribute('data-watcher-list', '1');
    cards = cards.filter((c) => container.contains(c));
  }

  document.querySelectorAll('[data-watcher-card]').forEach((e) => e.removeAttribute('data-watcher-card'));

  const rows = cards.map((card, i) => {
    card.setAttribute('data-watcher-card', String(i));
    const logoEl = card.querySelector('img[src*="licdn.com"], img[alt*="logo" i], img');
    const logoUrl = logoEl?.getAttribute('src') || logoEl?.getAttribute('data-delayed-url') || '';
    // Still read, so a rolled-back or A/B-served layout that does carry an id
    // is used directly rather than being given a synthetic key it does not need.
    // EVERY id in this element, not the first one.
    //
    // The element is chosen by walking up from a recency marker to the first
    // ancestor carrying a logo, 3+ lines and under 420 characters. When a
    // card's own logo has not lazy-loaded yet that walk steps straight past it
    // and stops on a wrapper holding TWO short cards — 116 + 107 characters is
    // comfortably under the cap — and the wrapper then reports the first card's
    // TEXT with whichever job link comes first. That files one employer's
    // posting under another's identity, and it is silent: the id is real, the
    // pane really shows it, and only the company disagrees.
    //
    // So an element carrying more than one distinct id is not a card, and the
    // honest answer is no id rather than a coin flip. idCount is returned so
    // the caller can COUNT the loss instead of swallowing it.
    const hrefs = [...card.querySelectorAll('a[href*="/jobs/view/"], a[href*="currentJobId="]')]
      .map((a) => a.getAttribute('href') ?? '');
    const idOf = (h) => (h.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)/) || [])[1]
      || (h.match(/currentJobId=(\d+)/) || [])[1] || null;
    const linkIds = [...new Set(hrefs.map(idOf).filter(Boolean))];
    const href = hrefs[0] ?? '';
    const idHolder = card.matches?.('[data-occludable-job-id], [data-job-id]')
      ? card
      : card.querySelector('[data-occludable-job-id], [data-job-id]');
    const attrIds = [...new Set([...card.querySelectorAll('[data-occludable-job-id], [data-job-id]')]
      .map((e) => e.getAttribute('data-occludable-job-id') || e.getAttribute('data-job-id'))
      .filter(Boolean))];
    const idCount = Math.max(linkIds.length, attrIds.length);
    const jobId = idCount > 1 ? null : (
      idHolder?.getAttribute('data-occludable-job-id') ||
      idHolder?.getAttribute('data-job-id') ||
      linkIds[0] ||
      null);

    return {
      idCount,
      lines: linesOf(card),
      logoUrl: /^https?:\/\//.test(logoUrl) ? logoUrl : '',
      jobId,
      href: href.startsWith('http') ? href : href ? `https://www.linkedin.com${href}` : '',
    };
  });

  return { rows, hasContainer: !!container };
}

/**
 * Strip the decorations LinkedIn adds to a card's accessible label.
 *
 * "(Verified job)" was re-worded to "<title> with verification" on 4 Sep 2026
 * AND moved: it no longer decorates the label at clean[0], it is a line of its
 * own immediately AFTER the title. That put it in the COMPANY slot, pushed the
 * real company into the location slot and dropped the location entirely — so
 * every verified employer's card read as an unknown company and was refused by
 * the watchlist gate. Measured: 1,004 cards in the first twelve hours, and
 * because LinkedIn verifies exactly the large employers this board is built
 * from, US intake fell 313 -> 44 in a day while every health signal (runs ok,
 * 22 cards a page, baselines moving) stayed green.
 *
 * Stripping it HERE rather than in the fact filter is what makes the fix
 * order-agnostic: the same rule removes the suffix whether LinkedIn puts the
 * decoration on the label (the old shape) or on a line of its own (the new
 * one), so a revert costs nothing.
 */
function undecorate(line) {
  return String(line ?? '')
    .replace(/^Selected,\s*/i, '')
    .replace(/\s*\((?:Verified job|Promoted)\)\s*$/i, '')
    .replace(/\s+with verification\s*$/i, '')
    .trim();
}

/** Lines that are card furniture rather than facts about the job. */
function isMetaLine(line) {
  const l = String(line ?? '').trim();
  if (!l || l === '·') return true;
  if (/^(viewed|easy apply|promoted|saved?|applied|new|actively reviewing applicants|be an early applicant|responses managed off linkedin|promoted by hirer|no response insights available yet)$/i.test(l)) return true;
  // "Posted 19 hours ago", "19 hours ago", "0 applicants", "Over 100 people clicked apply".
  if (/\b(ago|applicants?)\b/i.test(l) || /people clicked apply/i.test(l)) return true;
  if (/^company review time/i.test(l)) return true;
  return false;
}

/**
 * Turn one card's visible text into fields.
 *
 * A card reads: accessible label / title / company / location, then metadata.
 * The label repeats the title with "Selected, " and "(Verified job)" bolted on
 * — since 4 Sep 2026 the verified mark is instead a line of its OWN reading
 * "<title> with verification", which is why `undecorate` runs over every line
 * and not just the first — and it is absent on some cards, so the title is
 * taken from the first line with those decorations removed, the repeat is
 * dropped wherever it lands, and company and location are the first two lines
 * left that are not furniture.
 * Reading by fixed line NUMBER looks like it works on the first few cards and
 * then silently files "Be an early applicant" as the location.
 *
 * Exported and pure so it can be tested against captured cards without a
 * browser — this parser is now the only thing standing between the redesign and
 * an empty board, and it is not something to verify by eye.
 */
/**
 * The employer's own apply URL, out of LinkedIn's bootstrap JSON.
 *
 * WHY THIS EXISTS. `openAndExtract` used to read the destination off the Apply
 * control's href, and LinkedIn stopped rendering it as an anchor: it is a
 * <button> that navigates in JavaScript. Measured the week this was written —
 * **0 of 443** LinkedIn rows carried an off-site URL, against **672 of 722**
 * postings that are not Easy Apply and therefore have an employer page to point
 * at. Every one of those readers was being sent to LinkedIn to click Apply a
 * second time.
 *
 * The destination never left the page. LinkedIn bootstraps the pane from JSON
 * in `<code style="display:none">` blocks, and the JobPosting object carries
 * `companyApplyUrl` beside its own `entityUrn`.
 *
 * NOTHING IS CLICKED, and that is the point. Clicking Apply is the obvious way
 * to get this URL and it is the wrong one: LinkedIn registers intent on the
 * account, and automated Apply clicks at ~670 a month is precisely what gets
 * the single account this entire board depends on restricted. This is a passive
 * read of a response the page already fetched.
 *
 * Takes the WHOLE bootstrap block and the job id, and does its own scoping.
 * The page hands the block over rather than narrowing it first, deliberately:
 * the scoping is the dangerous half — a block holds several postings — and
 * logic inside `page.evaluate` cannot be tested at all. Pure and in Node for
 * exactly the reason `parseCardLines` is. The block is ~185KB at worst, which
 * is a few milliseconds to serialise and is paid only on postings that reach
 * the open.
 */
export function applyUrlFrom(blob, jobId) {
  if (typeof blob !== 'string' || !blob || !jobId) return null;

  /* SCOPE FIRST. One bootstrap block carries several postings — 3 and 5 in the
     two blocks measured on a real page — so the first `companyApplyUrl` in it
     is very often somebody else's. Narrow to the region between THIS posting's
     urn and the next posting's before reading anything. Getting this wrong does
     not produce a missing field, it sends a student to a different employer's
     application form, which is the same class of failure the pane/card employer
     check exists to prevent. */
  const marker = `"entityUrn":"urn:li:fsd_jobPosting:${jobId}"`;
  const at = blob.indexOf(marker);
  if (at === -1) return null;
  const next = blob.indexOf('"entityUrn":"urn:li:fsd_jobPosting:', at + marker.length);
  const scope = next === -1 ? blob.slice(at) : blob.slice(at, next);

  const found = scope.match(/"companyApplyUrl":"([^"]+)"/);
  if (!found) return null;
  let url = found[1];

  /* The blob may arrive decoded (textContent) or encoded (innerHTML, the
     fallback for a search variant we have not captured), and LinkedIn's own
     JSON escapes ampersands as \u0026. A query string is a working URL with
     `&` and a broken one with `&amp;`, so normalise all three here rather than
     making the caller care which source it came from. Harmless when already
     decoded: no real apply URL contains the literal text "&amp;". */
  url = url
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

  // The redesign wraps off-site applies in an interstitial: /safety/go/?url=.
  // Storing the wrapper publishes a LinkedIn redirect where the employer's own
  // application page belongs.
  const wrapped = url.match(/\/safety\/go\/?\?(?:.*&)?url=([^&]+)/);
  if (wrapped) {
    try { url = decodeURIComponent(wrapped[1]); } catch { /* keep the wrapper */ }
  }

  if (!/^https?:\/\//i.test(url)) return null;
  /* `companyApplyUrl` is populated for ONSITE applies too, as
     linkedin.com/job-apply/<id>. That is LinkedIn's own form, not an employer
     page — publishing it would put "Apply on the company's site" on a link that
     goes to LinkedIn, which is the exact mislabelling applyTarget() exists to
     prevent. Drop it and let the posting URL stand. */
  if (/^https?:\/\/[^/]*\blinkedin\.com\/job-apply\//i.test(url)) return null;
  return url;
}

/**
 * The same URL, recovered from the response the PANE ALREADY FETCHED.
 *
 * WHY THIS IS NEEDED AS WELL AS applyUrlFrom. That function reads the DOM, and
 * the DOM only carries this data for the posting LinkedIn server-rendered on
 * arrival. `openAndExtract` does not navigate — it CLICKS a card in a page that
 * is already loaded — and the SPA answers a click over graphql and renders from
 * the response WITHOUT ever writing it into a <code> block. So for every card
 * except the one that happened to be showing when the page loaded, the value
 * was simply not in the document to be found.
 *
 * That is why the recovery measured 8 of 8 when it was built and then returned
 * NOTHING in production: it was verified by navigating to postings one at a
 * time, which server-renders the bootstrap, and the scan clicks. Measured 30
 * Aug: 34 consecutive runs at `apply links 0/N`, 0 of 563 non-Easy-Apply rows
 * with a URL — while the value sat in the graphql response the whole time
 * (EY's `careers.ey.com/ey/job/Gurugram-Industrial-Trainee-…` among them).
 *
 * STILL NOTHING EXTRA IS REQUESTED. This is a passive read of a response the
 * page made on its own to render the pane we are already looking at — the same
 * standing rule as before, and the reason Apply is never clicked: automated
 * apply clicks at ~670 a month is what gets the one account this board depends
 * on restricted.
 *
 * ATTRIBUTION IS THE DANGEROUS HALF, exactly as it is for the DOM blob, and it
 * is guarded twice over. The request URL must name EXACTLY ONE posting — a
 * payload about several (the search list, 1.7MB of it) is refused outright
 * rather than guessed at — and the body is then handed to applyUrlFrom, which
 * scopes to that posting's own entityUrn before reading anything. Measured on
 * the live response: the request names one id, the body carries exactly one
 * `"entityUrn":"urn:li:fsd_jobPosting:<id>"`, and one companyApplyUrl. Getting
 * this wrong does not produce a missing field, it sends a student to a
 * different employer's application form.
 */
export function applyUrlFromResponse(requestUrl, body) {
  if (typeof body !== 'string' || !body.includes('companyApplyUrl')) return null;
  if (typeof requestUrl !== 'string' || !requestUrl) return null;

  let decoded = requestUrl;
  try { decoded = decodeURIComponent(requestUrl); } catch { /* keep it raw */ }

  const ids = [...new Set([...decoded.matchAll(/fsd_jobPosting:(\d{6,})/g)].map((m) => m[1]))];
  if (ids.length !== 1) return null;   // ambiguous payload — never guess

  const url = applyUrlFrom(body, ids[0]);
  return url ? { jobId: ids[0], url } : null;
}

/* page -> Map<jobId, employer apply URL>, filled by the listener below.
   A WeakMap so a closed page does not pin its captures in memory. */
const APPLY_SEEN = new WeakMap();

/**
 * Start listening. Idempotent — attaching twice would read every body twice.
 *
 * Only responses whose URL names exactly one posting are read at all, which
 * keeps the big multi-job search payload out of the body reads as well as out
 * of the attribution.
 */
export function watchApplyUrls(page) {
  let seen = APPLY_SEEN.get(page);
  if (seen) return seen;
  seen = new Map();
  APPLY_SEEN.set(page, seen);

  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!url.includes('/voyager/api/')) return;
      if (!/json/i.test(String(res.headers()['content-type'] ?? ''))) return;
      let decoded = url;
      try { decoded = decodeURIComponent(url); } catch { /* raw */ }
      if ([...new Set([...decoded.matchAll(/fsd_jobPosting:(\d{6,})/g)].map((m) => m[1]))].length !== 1) return;
      const found = applyUrlFromResponse(url, await res.text());
      if (found) seen.set(found.jobId, found.url);
    } catch { /* body already consumed, or a navigation raced it — never fatal */ }
  });
  return seen;
}

/**
 * What was captured for this posting, waiting briefly if it has not landed.
 *
 * The response that carries this is the one that RENDERS the top card, and the
 * caller has already waited for the pane, so in practice it is there before we
 * ask. The grace period covers only the gap between the response arriving and
 * its body resolving, and expiring costs nothing: the button falls back to
 * saying "Apply on LinkedIn", which is what it said before any of this existed.
 */
async function applyUrlSeen(page, jobId, { graceMs = 2500, stepMs = 150 } = {}) {
  const seen = APPLY_SEEN.get(page);
  if (!seen) return null;
  const key = String(jobId);
  for (let waited = 0; waited <= graceMs; waited += stepMs) {
    const hit = seen.get(key);
    if (hit) return hit;
    await sleep(stepMs);
  }
  return null;
}

export function parseCardLines(lines) {
  const clean = (lines ?? []).map((l) => String(l ?? '').trim()).filter(Boolean);
  const empty = { title: '', company: '', location: '', workplaceType: null, postedText: '', salaryText: null, easyApply: false, promoted: false, viewed: false };
  if (!clean.length) return empty;

  const title = undecorate(clean[0]);
  const key = title.toLowerCase();
  const facts = clean.slice(1)
    .filter((l) => undecorate(l).toLowerCase() !== key)
    .filter((l) => !isMetaLine(l));

  const rawLocation = facts[1] ?? '';
  const workplaceType = (rawLocation.match(/\((Remote|Hybrid|On-?site)\)\s*$/i) || [])[1] ?? null;

  const blob = clean.join(' | ');
  return {
    title,
    company: facts[0] ?? '',
    location: rawLocation.replace(/\s*\((?:Remote|Hybrid|On-?site)\)\s*$/i, '').trim(),
    workplaceType,
    postedText: (blob.match(/(just now|\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s*ago)/i) || [])[1] || '',
    salaryText: (blob.match(/([₹$€£¥]\s?[\d,][\d,.\s]*(?:k|K|lakhs?|LPA)?(?:\s*(?:-|–|to)\s*[₹$€£¥]?\s?[\d,][\d,.\s]*(?:k|K|lakhs?|LPA)?)?(?:\s*(?:\/|per\s)\s*\w+)?)/) || [])[1] || null,
    easyApply: /easy apply/i.test(blob),
    promoted: /promoted/i.test(blob),
    // LinkedIn marks cards you have already opened.
    viewed: clean.some((l) => /^viewed$/i.test(l)),
  };
}

/**
 * Refuse a pane that is showing a different employer than the card we clicked.
 *
 * Clicking is the only way to learn which posting a card is, so reading the
 * wrong pane does not produce a missing field — it files one employer's
 * internship under another's id. The normalised names must agree, allowing for
 * the pane saying "HARMAN" where the card said "HARMAN India".
 *
 * **IT USED TO BE GATED ON `!card.jobId` AND HAD THEREFORE NEVER RUN.** That
 * condition was written for the redesign, where a card carries no id until it
 * is clicked — but we are on CLASSIC, whose cards DO carry `/jobs/view/`
 * anchors and `data-occludable-job-id`, so `card.jobId` is always set and the
 * check was skipped on every open the scraper has ever done. It had not fired
 * once in the whole of run.log.
 *
 * Measured cost of that, 4 Sep 2026: three cards clicked during a catch-up
 * sweep took 24-25s to open instead of the usual 5-6s and each stored a
 * completely unrelated posting — State Street's "Apprentice" filed R360 Group's
 * "Java Intern", and two Infineon "Young Graduate Trainee" cards filed Joveo's
 * "Operations Intern" and Internz Learn's "Business Growth Intern". All three
 * are off-watchlist or non-tech employers that reached the store through a
 * watchlist card's identity, and all three real postings were lost.
 *
 * Pure and exported so the DECISION is testable without a browser — the bug was
 * never in the comparison, it was in when the comparison ran, and a test that
 * only feeds it two names passes against the broken code just as loudly. Pass a
 * card that HAS a `jobId`: that is the case the old gate silently skipped.
 *
 * Returns the warning to log, or null to proceed.
 */
export function paneMismatch(card, detail) {
  const cardCo = normaliseCompany(card?.company ?? '');
  const paneCo = normaliseCompany(detail?.company ?? '');
  /* Nothing to compare is not a mismatch — a pane whose header had not painted
     yet must not cost us the open — and no separate blank check is needed to
     get that: `x.includes('')` is true, so an empty side agrees with anything.
     An explicit `if (!cardCo || !paneCo) return null` above this line is dead
     code, and its test passes against its own removal. */
  if (paneCo.includes(cardCo) || cardCo.includes(paneCo)) return null;
  return `Opened "${card.title}" at ${card.company} but the pane is showing ${detail.company} — skipping rather than filing it under the wrong employer.`;
}

/**
 * A stand-in identity for a card that has no job id yet.
 *
 * The redesigned list carries no job id anywhere — every attribute on every
 * element was searched for an 8+ digit value and there were none — and the id
 * only appears once a card has been clicked. But the company gate, the title
 * gate and the staleness gate all run BEFORE the click, on purpose: they are
 * what keeps clicking down to watchlist matches. They need something to key
 * their skip records on, and this is it.
 *
 * `ats:` already marks a job id that did not come from LinkedIn; `card:` marks
 * one that is not a job id at all, so neither can be mistaken for the other or
 * for a real posting id in `seen_cards`.
 *
 * The posted text is part of the key on purpose. Without it a repost — the same
 * role relisted under a fresh id, which LinkedIn does constantly — would key
 * identically to the original and be skipped as already seen.
 */
export function cardKey({ company, title, postedText }) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `card:${norm(company)}|${norm(title)}|${norm(postedText)}`;
}

/**
 * The same card, identified without its posted time.
 *
 * `cardKey` deliberately includes the posted text so two listings of one role
 * never collapse into each other. That is right for a skip record, and wrong
 * for remembering what a card turned out to be: the text ages from "5 minutes
 * ago" to "2 hours ago" between runs, so a key containing it never matches
 * twice and the memory never pays off.
 *
 * This is the stable half, used only as the `card_keys` lookup. Reposts are
 * kept apart by comparing posted times at the point of use, not by the key.
 *
 * LOCATION IS PART OF IT. One employer routinely advertises one role in
 * several cities as separate postings with separate ids, and on company and
 * title alone they all collapse into whichever was opened first — the rest are
 * refused as "already known" for as long as they stay up, and unlike a repost
 * no amount of waiting frees them, because the identity never changes. Two
 * Qualcomm "Interim Engineering Intern_Systems-2027" postings went up minutes
 * apart on 12 Aug, Hyderabad and Bengaluru; only Hyderabad was ever opened.
 * Crisil advertises "Intern" in ten cities and Siemens "Graduate Trainee
 * Engineer" in four.
 *
 * Safe to key on because the card's location is essentially always present —
 * empty in 2 of 968 stored postings — unlike the accessible label, which
 * innerText renders only sometimes.
 */
export function cardIdentity({ company, title, location }) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `card:${norm(company)}|${norm(title)}|${norm(location)}`;
}

/**
 * The inverse of cardIdentity, for reading a stored key back apart.
 *
 * Fields are taken from the END, not by splitting into three: an employer name
 * can itself contain a pipe ("Foo | Bar Labs" is a real shape on LinkedIn), and
 * splitting left-to-right would file the title as the company and lose the row.
 * Location and title are always the last two.
 */
export function parseCardIdentity(cardKey) {
  const parts = String(cardKey ?? '').replace(/^card:/, '').split('|');
  if (parts.length < 3) return null;
  const location = parts.pop();
  const title = parts.pop();
  return { company: parts.join('|'), title, location };
}

/**
 * The pre-16-Aug-2026 two-part identity, for reading rows written before
 * location was part of the key.
 *
 * Rewriting every stored key in one migration is not possible: `card_keys`
 * holds the CARD's location text ("Bengaluru") while the jobs table holds the
 * detail pane's ("Bengaluru, Karnataka, India"), so the old rows cannot be
 * reconstructed into new ones. Instead the gate falls back to this, and
 * migrates each row the first time it is hit — see the lookup in index.js.
 * Dropping the old rows outright would have re-opened every card on the board
 * in a single sweep, which is the one thing the request budget cannot afford.
 */
export function legacyCardIdentity({ company, title }) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `card:${norm(company)}|${norm(title)}`;
}

/**
 * Read every job card on the current page without clicking any of them.
 *
 * LinkedIn virtualises the list — only the rows near the viewport are
 * populated — so the container has to be scrolled through before the cards can
 * all be read.
 */
export async function enumerateCards(page, cfg) {
  // Locate and tag the scrollable results column. The named containers are all
  // gone from the redesigned page, so the real work is done by scanCardsInPage,
  // which finds the column by asking which scrollable ancestor holds the cards.
  // They stay first because the standalone and older surfaces still serve them.
  const container = await page.evaluate((candidates) => {
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 50) return sel;
    }
    return null;
  }, LIST_CONTAINERS);

  // A first pass purely to locate and tag the scrollable column.
  const located = await page.evaluate(scanCardsInPage);
  const listSelector = container ?? (located.hasContainer ? '[data-watcher-list="1"]' : null);

  if (listSelector) {
    await humanScrollContainer(page, listSelector, { steps: 14, stepPause: cfg.pacing.scrollStep });
    // Return to the top so the first card is the one nearest the pointer.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }, listSelector).catch(() => {});
    await sleep(rand(600, 1400));
  } else {
    log.debug('No scrollable list container found; reading whatever is rendered.');
  }

  // Read AFTER the scroll, not before. The list is virtualised, so the pass
  // above sees only the rows that happened to be rendered on arrival, and the
  // scroll is what materialises the rest — reading first threw away everything
  // the scrolling was done to reveal.
  const scanned = await page.evaluate(scanCardsInPage);

  // The rows come back as raw text; the parsing happens here in Node so that
  // parseCardLines is an ordinary, testable function rather than a lambda
  // trapped inside page.evaluate.
  const seen = new Set();
  const identityCounts = new Map();
  const unidentified = [];
  /* Elements that turned out to hold more than one posting — see the idCount
     comment in scanCardsInPage. The row is KEPT, because its text belongs to
     the first card and the identity path can re-find that card on a fresh scan
     where the logo has loaded and the boundary is right; what it must not keep
     is the id, which may be the neighbour's. Counted so a silent
     mis-attribution becomes a number somebody can watch. */
  let spanned = 0;
  const cards = [];

  scanned.rows.forEach((row, index) => {
    const parsed = parseCardLines(row.lines);

    // A card we cannot name is a card we cannot key, gate or record. Count and
    // report it rather than dropping it in silence — an invisible loss here is
    // indistinguishable from a posting that was never advertised, which is
    // exactly how an upGrad listing went missing without leaving a trace.
    if (!parsed.title || !parsed.company) {
      unidentified.push(String(parsed.title || parsed.company || row.lines[0] || '').slice(0, 60));
      return;
    }

    if ((row.idCount ?? 0) > 1) spanned++;

    // A real id if the page happened to carry one, a synthetic key otherwise.
    const key = row.jobId ?? cardKey(parsed);

    // LinkedIn re-renders rows while the virtualised list scrolls, so the same
    // job can be captured twice in one pass.
    if (seen.has(key)) return;
    seen.add(key);

    // How to find this card again at click time: its company and title, plus
    // which occurrence it is when one company posts the same title twice.
    const identity = cardIdentity(parsed);
    const nth = identityCounts.get(identity) ?? 0;
    identityCounts.set(identity, nth + 1);

    cards.push({
      ...parsed,
      key,
      identity,
      jobId: row.jobId,
      index,
      nth,
      logoUrl: row.logoUrl,
      href: row.href,
    });
  });

  return { cards, unidentified, spanned };
}

/**
 * Is there another page of results?
 *
 * Returns true when LinkedIn's "Next" control is present and enabled, false
 * when it is absent or disabled (the last page), and null when no pagination
 * bar could be found at all — in which case the caller falls back to judging by
 * how many cards the page returned.
 *
 * The bar only renders once the results column is scrolled to the bottom, so
 * this scrolls there first.
 */
/**
 * Fingerprint the search surface we are actually on.
 *
 * LinkedIn is retiring classic job search and moves accounts between the two
 * experiences unannounced, so every run records which one it saw — see
 * `src/searchvariant.js` for why this is structural and never a text match.
 *
 * The description selector is resolved HERE rather than inside the probe, so
 * DESCRIPTION_SELECTORS stays the one place that order is written down. It is
 * the field that says whether extraction is on its preferred path or a
 * fallback, which is the difference between "a flip happened" and "a flip
 * happened and it cost us something".
 *
 * Never throws: this is a diagnostic, and a diagnostic must not be able to end
 * a sweep. A page that will not answer reports as unknown, which is also the
 * one value `noteVariant` refuses to store.
 */
export async function readVariant(page) {
  return page
    .evaluate(
      ({ probeSrc, selectors }) => {
        // eslint-disable-next-line no-new-func
        const fp = new Function(`return (${probeSrc})()`)();
        fp.description = selectors.find((sel) => {
          try { return !!document.querySelector(sel); } catch { return false; }
        }) ?? null;
        return fp;
      },
      { probeSrc: probeVariant.toString(), selectors: DESCRIPTION_SELECTORS },
    )
    .catch(() => null);
}

export async function hasNextPage(page) {
  await page.evaluate(() => {
    const list = document.querySelector('[data-watcher-list="1"], .jobs-search-results-list, .scaffold-layout__list');
    if (list) list.scrollTop = list.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => {});
  await sleep(rand(900, 1800));

  return page.evaluate(() => {
    const isNext = (b) =>
      /view next page/i.test(b.getAttribute('aria-label') ?? '') ||
      (b.innerText ?? '').trim().toLowerCase() === 'next';

    const button =
      document.querySelector('.jobs-search-pagination__button--next, button[aria-label="View next page"]') ||
      [...document.querySelectorAll('button')].find(isNext);

    if (button) {
      return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    }
    // A pagination bar with no Next control means we are on the final page.
    if (document.querySelector('.jobs-search-pagination, .artdeco-pagination')) return false;
    return null;
  }).catch(() => null);
}

/** Expand a truncated description if a "see more" control is present. */
async function expandDescription(page) {
  const selectors = [
    'button[aria-label*="see more" i]',
    'button[aria-label*="Click to see more" i]',
    '.jobs-description__footer-button',
    'button.show-more-less-html__button--more',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.count().catch(() => 0)) {
      if (await btn.isVisible().catch(() => false)) {
        await humanClick(page, btn, { timeout: 4000 });
        await sleep(rand(500, 1200));
        return true;
      }
    }
  }
  return false;
}

/**
 * Click a card and read the detail pane.
 *
 * Clicking the card (rather than navigating to the job URL) is both closer to
 * what a person does and cheaper — it updates the right-hand pane in place
 * instead of loading a whole new page.
 *
 * This is also where a card stops being anonymous. The redesigned list holds no
 * job id at all, so a card arrives here identified only by `card.key`, the
 * synthetic company|title|posted string built in enumerateCards. The click is
 * what makes LinkedIn reveal the real id — in `location.href` and in the
 * description block's own `JobDetails_AboutTheJob_<id>` — and the caller swaps
 * one for the other on the strength of the `jobId` returned here.
 *
 * The id is read from the description block first and the URL second. Both
 * carry it, but the URL can still show the previous job for a moment after the
 * pane has already repainted, and a posting stored under its predecessor's id
 * is worse than one not stored at all.
 */
export async function openAndExtract(page, card, cfg) {
  const before = page.url();

  /* Before the click, or its response is missed. Idempotent, so the cost of
     calling it on every open is one WeakMap lookup. */
  watchApplyUrls(page);

  // Whatever the pane was showing before the click, so the wait below can tell
  // "the new job has rendered" from "the old one is still on screen".
  const previousAboutId = await page
    .evaluate(() => document.querySelector('[id^="JobDetails_AboutTheJob_"]')?.id ?? null)
    .catch(() => null);

  let clicked = false;

  if (card.jobId) {
    // A real id: either a surface that still publishes one, or a description
    // backfill working from a stored row. Both can be addressed directly.
    const locator = page
      .locator(`li[data-occludable-job-id="${card.jobId}"], li[data-job-id="${card.jobId}"], [data-job-id="${card.jobId}"]`)
      .first();
    if (await locator.count().catch(() => 0)) {
      const link = locator.locator('a[href*="/jobs/view/"]').first();
      const target = (await link.count().catch(() => 0)) ? link : locator;
      clicked = await humanClick(page, target);
    }
  } else if (card.identity) {
    // Re-find the card by its parsed identity rather than trusting a handle
    // taken earlier. Without an id there is no URL that reaches this posting,
    // so if the element cannot be found the card cannot be opened at all.
    //
    // The scan and the match are split across the process boundary on purpose:
    // parsing in Node means the same parseCardLines folds "Intern - AI
    // (Verified job)" and "Intern - AI" to one title, which raw line matching
    // could not — innerText renders that label only sometimes, and comparing
    // lines between two scans failed for 17 of 23 cards.
    const look = async () => {
      const { rows } = await page.evaluate(scanCardsInPage).catch(() => ({ rows: [] }));
      let seen = 0;
      for (let i = 0; i < rows.length; i++) {
        if (cardIdentity(parseCardLines(rows[i].lines)) !== card.identity) continue;
        if (seen++ === (card.nth ?? 0)) return i;
      }
      return -1;
    };

    let tagged = await look();

    // The list is virtualised: it only keeps the rows near the scroll position
    // in the DOM. enumerateCards materialises all of them by scrolling through,
    // but opening a card re-renders the list, and every row below the fold is
    // recycled — which silently lost four of five watchlist matches on a page,
    // each reported only as "could not be found to click". So walk the list
    // down the way somebody scrolling to a posting would, checking as we go.
    if (tagged < 0) {
      await page.evaluate(() => document.querySelector('[data-watcher-list="1"]')?.scrollTo({ top: 0 })).catch(() => {});
      await sleep(rand(300, 700));
      for (let step = 0; step < 24 && tagged < 0; step++) {
        const moved = await page.evaluate(() => {
          const el = document.querySelector('[data-watcher-list="1"]');
          if (!el) return false;
          const before = el.scrollTop;
          el.scrollBy(0, Math.max(280, el.clientHeight * 0.7));
          return el.scrollTop !== before;
        }).catch(() => false);
        await sleep(rand(300, 700));
        tagged = await look();
        if (!moved) break;
      }
    }

    if (tagged >= 0) {
      clicked = await humanClick(page, page.locator(`[data-watcher-card="${tagged}"]`).first());
    }
  }

  if (!clicked) {
    if (!card.jobId) {
      // Nothing else to try. Without an id there is no URL that reaches this
      // posting, so it cannot be opened by any other route this run. Say so and
      // let the caller count it — the card will be on the list again next run.
      log.warn(`Card "${card.title}" (${card.company}) could not be found to click; it will be picked up next run.`);
      return { jobId: null, description: '', unopenable: true };
    }
    log.debug(`Card ${card.jobId} was not clickable; navigating directly.`);
    // The pane URL, not the standalone view — see jobPaneUrl. This path is
    // taken both when a card scrolls out from under us mid-scan and for every
    // description backfill, so getting it wrong costs a silent empty read
    // rather than a visible error.
    await gotoResilient(page, jobPaneUrl(card.jobId), {}, { label: `job ${card.jobId}` });
  }

  // Wait for the pane to actually change, and take no answer for an answer.
  //
  // This used to race the wait against a flat six-second sleep, so a pane that
  // had not finished loading was read anyway — and on the redesign that means
  // reading the PREVIOUS posting, whose description block is still on screen
  // under its own id. It attributed a HARMAN internship to Valeo's job id:
  // clicking is now the only way to learn which posting a card is, so a stale
  // read does not produce a missing field, it produces a confident wrong
  // answer. Better to skip the card and pick it up next run.
  const paneChanged = await page.waitForFunction(
    ({ id, prevAbout }) => {
      const about = document.querySelector('[id^="JobDetails_AboutTheJob_"]');
      if (about) return about.id !== prevAbout;
      if (id) return location.href.includes(id);
      return !!document.querySelector('#job-details, .jobs-description__content');
    },
    { id: card.jobId ?? null, prevAbout: previousAboutId },
    { timeout: 15_000 },
  ).then(() => true).catch(() => false);

  // A pane that has not repainted within the timeout is not proof of a wrong
  // read — five of eighteen opens on a catch-up sweep were simply slow, and
  // discarding them threw away real postings. What actually matters is checked
  // after extraction: that the pane is showing the employer we clicked.
  if (!paneChanged) await sleep(rand(1500, 2500));

  await sleep(rand(700, 1600));

  await expandDescription(page);

  const detail = await page.evaluate((descSelectors) => {
    const text = (el) => (el?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // innerText respects rendered line breaks; textContent runs every bullet
    // together into one unreadable string, which then wrecks the summary.
    const blockText = (el) => (el?.innerText ?? el?.textContent ?? '')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    const about = document.querySelector('[id^="JobDetails_AboutTheJob_"]');
    // The description block is named after the posting it belongs to, which
    // makes it the most trustworthy id on the page — it cannot lag the render
    // the way the URL can.
    const jobId = (about?.id.match(/_(\d+)$/) || [])[1]
      || (location.href.match(/currentJobId=(\d+)/) || [])[1]
      || null;

    // The detail pane is whichever container is not the results list. On the
    // redesign nothing is named, so it is found by walking out from the
    // description until an ancestor also carries the header above it.
    //
    // "Has some text above the description" is NOT enough to stop on. LinkedIn
    // wraps the description in a match-insights block first ("Your profile and
    // resume are missing some required qualifications"), which satisfies that
    // test and yields a header with no company, title, location or Apply button
    // in it. The header proper is identified by the line it always carries:
    // location · posted · applicants. Stopping at the first ancestor holding
    // that line lands on the pane column and not on the whole page.
    let pane = null;
    if (about) {
      for (let e = about.parentElement; e && e !== document.body; e = e.parentElement) {
        const t = e.innerText ?? '';
        const cut = t.indexOf('About the job');
        if (cut <= 0) continue;
        const head = t.slice(0, cut);
        if (head.split('\n').some((l) => l.includes('·') && /\bago\b|applicants?|clicked apply/i.test(l))) {
          pane = e;
          break;
        }
      }
    }
    pane = pane
      || document.querySelector('.jobs-search__job-details, .jobs-details, .job-view-layout, .scaffold-layout__detail')
      || document.body;

    let description = '';
    for (const sel of descSelectors) {
      const el = pane.querySelector(sel) ?? document.querySelector(sel);
      const t = blockText(el);
      if (t.length > description.length) description = t;
      if (description.length > 400) break;
    }
    // The block leads with its own heading, which is not part of the posting.
    description = description.replace(/^About the job\s*/i, '').trim();

    // Everything above the description is the header. The old layout had a
    // named top-card and an <h1>; the redesign has neither — the page carries
    // no <h1> at all — so the header is read as the text preceding the
    // description, line by line.
    const paneText = pane.innerText ?? '';
    const cut = paneText.indexOf('About the job');
    const headerLines = (cut > 0 ? paneText.slice(0, cut) : '')
      .split('\n').map((l) => l.trim()).filter(Boolean);
    const headerText = headerLines.join(' ').replace(/\s+/g, ' ').trim();

    // "Bengaluru, Karnataka, India · 19 hours ago · Over 100 people clicked apply"
    const factsLine = headerLines.find((l) => l.includes('·')) ?? '';
    const factParts = factsLine.split('·').map((s) => s.trim()).filter(Boolean);
    const factsTail = factParts.slice(1).join(' ');

    // Everything in the header that is furniture rather than a fact about the
    // posting. The list is long because the redesign packs the header with
    // controls and insight copy, and any one of them reads as a plausible
    // company name if it is the first line left standing.
    const isChrome = (l) =>
      l.includes('·') ||
      /^(apply|save|saved|easy apply|show match details|show more|show less|see more|learn more|follow|following|more|beta|is this information helpful|your profile and resume|responses managed off linkedin|no response insights|promoted by hirer|about the job)/i.test(l) ||
      /^(remote|hybrid|on-?site|full-time|part-time|contract|internship|temporary|entry level|internship level)$/i.test(l) ||
      /^\d[\d,]*\s+(followers?|employees?|connections?)/i.test(l);

    // The header reads company, then title, then the facts line. There is no
    // <h1> on this page at all, and the named top-card classes are gone, so
    // position within the header is what identifies them — but position AFTER
    // the furniture has been removed, never a raw line number.
    const headerFacts = headerLines.filter((l) => !isChrome(l) && l.length < 200);

    let company = text(pane.querySelector('.jobs-unified-top-card__company-name, .job-details-jobs-unified-top-card__company-name'))
      || headerFacts[0] || '';
    if (!company) {
      for (const a of pane.querySelectorAll('a[href*="/company/"]')) {
        const name = text(a);
        // "IQVIA 2,678,778 followers" is the same link with the count appended,
        // and "Show more" is a link to the company page too.
        if (name && name.length < 80 && !/followers?$/i.test(name) && !isChrome(name)) { company = name; break; }
      }
    }

    let title = text(pane.querySelector('h1, .jobs-unified-top-card__job-title, [class*="top-card"] h1'));
    if (!title) {
      const after = headerFacts.indexOf(company);
      title = (after >= 0 ? headerFacts.slice(after + 1) : headerFacts.slice(1))[0] ?? '';
    }

    const applicants =
      (factsTail.match(/(\d[\d,]*\s+applicants?|Over \d+\s+(?:applicants?|people clicked apply)|Be among the first \d+ applicants?|\d[\d,]*\s+people clicked apply)/i) || [])[1]
      || (headerText.match(/(\d[\d,]*\s+applicants?|Over \d+ applicants?|Be among the first \d+ applicants?)/i) || [])[1]
      || null;

    const postedText =
      (factsTail.match(/(just now|\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s*ago)/i) || [])[1]
      || (headerText.match(/(just now|\d+\s*(?:minute|min|hour|hr|day|week|month)s?\s*ago)/i) || [])[1]
      || '';

    // Salary can appear as a badge in the header or as an insight chip.
    const salaryText =
      (headerText.match(/([₹$€£¥]\s?[\d,][\d,.\s]*(?:k|K)?(?:\s*(?:-|–|to)\s*[₹$€£¥]?\s?[\d,][\d,.\s]*(?:k|K)?)?(?:\s*(?:\/|per\s)\s*\w+)?)/) || [])[1] || null;

    const workplaceType = (headerText.match(/\b(Remote|Hybrid|On-site|Onsite)\b/i) || [])[1] || null;
    /* LinkedIn's OWN employment type, out of the same header string. It sits
       beside the workplace type as a chip — "Hybrid · Internship" — and it is
       the only place the pane states it. Read here so a card admitted on a
       tech title that never said "intern" can be judged on LinkedIn's tag
       rather than guessed at. Recorded even when the title already says
       intern, so the two can be compared later. */
    const employmentTag = (headerText.match(/\b(Internship|Full-time|Part-time|Contract|Temporary|Volunteer)\b/i) || [])[1] || null;
    // NOT named `location`. A `const location` here is scoped to the whole
    // page.evaluate callback, which puts the page's own `location` in the
    // temporal dead zone for every line above — including the `location.href`
    // fallback that reads currentJobId when the description block is missing.
    // That fallback could therefore never run: it threw "Cannot access
    // 'location' before initialization" and lost the posting entirely.
    const locationText = factParts[0]
      || text(pane.querySelector('.jobs-unified-top-card__bullet, .job-details-jobs-unified-top-card__primary-description-container')).split('·')[0]?.trim()
      || '';

    // --- apply target ---
    // Matched on the control's OWN label, anchored at the start. A loose
    // /apply/i also matches a recruiter's "apply now" post further down the
    // pane, and following that would publish a link to somebody's feed update.
    const controls = [...pane.querySelectorAll('button, a')];
    const applyButton =
      controls.find((b) => /^(easy )?apply\b/i.test((b.innerText ?? '').trim()))
      || controls.find((b) => /^apply on/i.test(b.getAttribute('aria-label') ?? ''))
      || pane.querySelector('.jobs-apply-button');

    const applyLabel = (applyButton?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const easyApply = /easy apply/i.test(applyLabel) || !!pane.querySelector('.jobs-apply-button--top-card [class*="linkedin-bug"]');

    // For off-site applications LinkedIn sometimes exposes the destination as
    // an anchor href. When it does not, we leave this null and the report links
    // to the LinkedIn posting instead — clicking Apply there is what a person
    // would do anyway, and guessing a URL would be worse than not having one.
    let applyUrl = null;
    if (applyButton?.tagName === 'A') {
      const href = applyButton.getAttribute('href') ?? '';
      if (href && !href.startsWith('#')) {
        applyUrl = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
      }
    }

    /* The anchor above has matched nothing since LinkedIn made Apply a <button>.
       Hand the bootstrap block that mentions this posting to applyUrlFrom() in
       Node — see its comment. NO parsing here: everything inside page.evaluate
       is untestable, and the scoping this needs is the part most worth testing.
       textContent, not innerHTML, so the browser decodes the entities: a query
       string arrives as `&src=` rather than `&amp;src=`. */
    let applyBlob = null;
    if (!applyUrl && jobId) {
      const marker = `"entityUrn":"urn:li:fsd_jobPosting:${jobId}"`;
      for (const el of document.querySelectorAll('code, script[type="application/json"]')) {
        const blob = el.textContent || '';
        if (blob.includes(marker) && blob.includes('companyApplyUrl')) { applyBlob = blob; break; }
      }
      /* LAST RESORT: THERE ARE TWO SEARCH EXPERIENCES AND LINKEDIN SWITCHES
         BETWEEN THEM UNANNOUNCED. The measured one is the AI-powered
         `/jobs/search-results/` page, where the payload sits in
         `<code id="bpr-guid-…">` (Ember's batched page response). The other
         variant has never been captured, so nothing here should assume the
         element. If the marker is on the page at all, take the whole document
         and let applyUrlFrom find it — innerHTML re-encodes entities, which is
         exactly why that function decodes. */
      if (!applyBlob) {
        const whole = document.documentElement.innerHTML;
        if (whole.includes(marker) && whole.includes('companyApplyUrl')) applyBlob = whole;
      }
    }

    const detailLogo = pane.querySelector('img[src*="licdn.com"]')?.getAttribute('src') ?? '';

    return { jobId, title, company, location: locationText, workplaceType, employmentTag, applicants, postedText, salaryText, description, easyApply, applyUrl, applyBlob, applyLabel,
             logoUrl: /^https?:\/\//.test(detailLogo) ? detailLogo : '' };
  }, DESCRIPTION_SELECTORS);

  // The anchor is gone; recover the employer's URL from the bootstrap JSON the
  // page already loaded. Parsed here rather than in the page so it is testable.
  if (!detail.applyUrl && detail.applyBlob) {
    detail.applyUrl = applyUrlFrom(detail.applyBlob, detail.jobId);
  }
  delete detail.applyBlob;

  // Is the pane actually showing the card we clicked?
  const mismatch = paneMismatch(card, detail);
  if (mismatch) {
    log.warn(mismatch);
    return { jobId: null, description: '', unopenable: true };
  }

  const label = detail.jobId ?? card.jobId ?? card.key ?? 'unknown';
  if (!detail.description || detail.description.length < 60) {
    log.warn(`Description for ${label} came back very short (${detail.description?.length ?? 0} chars) — LinkedIn's markup may have shifted.`);
  }
  if (!detail.jobId && !card.jobId) {
    log.warn(`Opened "${card.title}" but LinkedIn never revealed a job id — it cannot be stored.`);
  }

  // Restore the URL context if we navigated away from the search results.
  if (!clicked && page.url() !== before) {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await pause(cfg.pacing.afterNavigation);
  }

  /* LAST, and deliberately after the employer check above: the DOM blob only
     ever holds the posting that was server-rendered on arrival, so on a clicked
     card this is the branch that actually finds anything. Placed below the
     pane/card comparison so a mismatched pane can never contribute a URL. */
  if (!detail.applyUrl && detail.jobId) {
    detail.applyUrl = await applyUrlSeen(page, detail.jobId);
  }

  // A real id from the page wins; the caller's own is the fallback so the
  // description-backfill path keeps working against the row it started from.
  return { ...detail, jobId: detail.jobId ?? card.jobId ?? null };
}
