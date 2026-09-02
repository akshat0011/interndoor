import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ROOT } from './paths.js';

/** Strip the `_comment` / `_*_note` documentation keys before use. */
function stripNotes(value) {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, stripNotes(v)]),
    );
  }
  return value;
}

const DEFAULTS = {
  companies: [],
  defaultLocation: '',
  searches: [{ keywords: 'software engineer intern', location: '' }],
  filters: { postedWithinHours: 24, sortBy: 'recent', jobTypes: [] },
  matching: { requireCompanyMatch: true, titleMustMatch: [] },
  pacing: {
    betweenCards: [4000, 9000],
    betweenPages: [8000, 16000],
    betweenSearches: [20000, 40000],
    scrollStep: [500, 1400],
    afterNavigation: [3000, 6000],
    warmupOnFeed: [6000, 12000],
    longBreakEvery: 12,
    longBreak: [45000, 90000],
  },
  limits: { maxRuntimeMinutes: 90, maxPagesPerSearch: 40, maxDetailsPerRun: 100 },
  notifications: {
    onCaptcha: true, onNewJobs: true, onError: true, openReportWhenDone: true,
    telegram: { enabled: false, chatId: '' },
  },
  browser: {
    headed: true,
    windowSize: [1512, 950],
    windowPosition: [40, 40],
    returnFocus: true,
    disableBraveShields: true,
  },
  safety: { cooldownHoursAfterRateLimit: 24, pauseOnChallenge: true },
  summarizer: { mode: 'offline', model: 'claude-haiku-4-5-20251001' },
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Normalise a company name for comparison: lowercase, drop legal suffixes and
 * punctuation, collapse whitespace. "Razorpay Software Pvt. Ltd." -> "razorpay".
 */
import { regionOf } from './regions.js';

export function normaliseCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/\b(inc|llc|ltd|limited|pvt|private|plc|gmbh|corp|corporation|co|company|technologies|technology|labs|india|group|holdings|solutions|services|systems|software)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read the grouped company file and flatten it. Groups exist only so the list
 * stays navigable by hand; the tool treats it as one flat watchlist.
 */
function loadCompanyFile(fileName) {
  const path = join(ROOT, fileName);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${fileName} — ${err.message}`);
  }
  const out = [];
  for (const [group, entries] of Object.entries(raw)) {
    if (group.startsWith('_') || !Array.isArray(entries)) continue;
    out.push(...entries);
  }
  return out;
}

export function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(PATHS.config, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read config.json — ${err.message}`);
  }

  const cfg = deepMerge(DEFAULTS, stripNotes(raw));

  if (cfg.companiesFile) {
    cfg.companies = [...loadCompanyFile(cfg.companiesFile), ...(cfg.companies ?? [])];
  }

  // Flatten into normalised match terms, remembering which canonical display
  // name each alias belongs to. Duplicate terms are dropped — a company can
  // legitimately appear in two groups (Ola is both consumer and deeptech).
  cfg.watchlist = [];
  const seenTerms = new Set();
  const seenCompanies = new Set();
  for (const entry of cfg.companies) {
    const company = typeof entry === 'string' ? { name: entry } : entry;
    if (!company?.name) continue;
    seenCompanies.add(company.name.toLowerCase());
    const names = [company.name, ...(company.aliases || [])].filter(Boolean);
    for (const n of names) {
      const norm = normaliseCompany(n);
      if (norm && !seenTerms.has(norm)) {
        seenTerms.add(norm);
        cfg.watchlist.push({ display: company.name, term: norm });
      }
    }
  }
  cfg.uniqueCompanyCount = seenCompanies.size;

  // A search may be written as a bare keyword string, which picks up
  // defaultLocation — 50 entries are far more readable that way.
  //
  // `region` is what a card's location falls back to when LinkedIn renders
  // none, which it does often. A LinkedIn sweep is scoped to one region by its
  // search parameters, so a blank card is still known to be inside it — unlike
  // an ATS board, which carries every office a company has and can fall back to
  // nothing.
  //
  // `geoId` is NOT filled in from the region, deliberately. The registry knows
  // every id, and buildSearchUrl has always supported the parameter, but this
  // search has never sent one: the redirect to /jobs/search-results/ drops
  // `location=` and results come back Indian from account geo bias alone.
  // Adding an id would change what LinkedIn returns on the one collector the
  // whole board depends on, for no benefit — India is unaffected by regions,
  // and every other region is served from ATS boards, which have no search at
  // all. Set it explicitly on a search when a second LinkedIn region is added.
  /* `enabled: false` PAUSES A SEARCH WITHOUT DELETING IT.
   *
   * Deleting the entry is the obvious way to stop a region and it throws away
   * everything that made it work — the US search carries a verified `geoId`,
   * its own `intervalMinutes`, and a `minWindowHours`/`windowMarginHours` pair
   * that exist because US supply is dense enough to walk 30 pages a sweep.
   * Re-typing those from memory is how a region comes back subtly wrong.
   *
   * A disabled search is dropped here, so nothing downstream has to know: the
   * rotation, the due check and the sweep baselines all simply never see it.
   * Its `sweep_ok_at:<CODE>` baseline is left untouched, so re-enabling it
   * stretches the window over the pause exactly the way an outage does. */
  const declared = (cfg.searches ?? []).map((entry) => {
    const base = typeof entry === 'string' ? { keywords: entry } : { ...entry };
    const region = regionOf(base.region ?? cfg.defaultRegion ?? 'IN');
    return {
      ...base,
      location: base.location ?? cfg.defaultLocation ?? '',
      region: region?.code ?? 'IN',
      geoId: base.geoId ?? null,
      enabled: base.enabled !== false,
    };
  });
  /* Every search as WRITTEN, paused ones included. Exposed because a test that
     walks `cfg.searches` to check a mechanism — that a non-India region is
     scoped by geoId, say — silently stops asserting anything the moment that
     region is paused. Pausing US did exactly that: the geoId loop ran zero
     times and still reported success. Mechanism tests read this; tests about
     what is running now read `cfg.searches`. */
  cfg.declaredSearches = declared;
  cfg.pausedSearches = declared.filter((s) => !s.enabled).map((s) => s.region);
  cfg.searches = declared.filter((s) => s.enabled);

  cfg.titleTerms = (cfg.matching.titleMustMatch || []).map((t) => t.toLowerCase());

  // Module-level so matchCompany can consult it without every caller threading it
  // through — publish.js and the scrape filter both go through matchCompany, so
  // setting it once here blocks an employer on both paths.
  setCompanyBlocklist(cfg.matching.blocklist ?? []);

  validate(cfg);
  return cfg;
}

function validate(cfg) {
  const problems = [];

  if (!Array.isArray(cfg.searches) || cfg.searches.length === 0) {
    problems.push('`searches` must contain at least one { keywords, location } entry.');
  }
  if (cfg.matching.requireCompanyMatch && cfg.watchlist.length === 0) {
    problems.push('`matching.requireCompanyMatch` is true but `companies` is empty — nothing could ever match. Add companies, or set requireCompanyMatch to false.');
  }
  if (cfg.browser.headed === false) {
    problems.push('browser.headed must be true — headless browsers are trivially detectable and you could not solve a CAPTCHA in a window you cannot see.');
  }
  for (const key of ['betweenCards', 'betweenPages', 'betweenSearches', 'scrollStep', 'afterNavigation', 'longBreak', 'warmupOnFeed']) {
    const pair = cfg.pacing[key];
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] > pair[1]) {
      problems.push(`pacing.${key} must be a [min, max] pair with min <= max.`);
    }
  }
  if (cfg.pacing.betweenCards[0] < 1500) {
    problems.push('pacing.betweenCards minimum is below 1.5s — that is fast enough to look automated. Raise it.');
  }
  if (cfg.summarizer.mode === 'claude' && !process.env.ANTHROPIC_API_KEY) {
    problems.push('summarizer.mode is "claude" but ANTHROPIC_API_KEY is not set in the environment.');
  }

  if (problems.length) {
    throw new Error(`config.json problems:\n  - ${problems.join('\n  - ')}`);
  }
}

const boundaryCache = new Map();

/**
 * Whole-word containment. Plain substring matching is not safe here: "ola" is
 * inside "solar", "ibm" is inside "acibmed", "hcl" is inside "hcltech" (fine)
 * but also inside unrelated tokens. Requiring word boundaries keeps
 * "Ola Electric" matching while "Solar Industries" does not.
 */
function containsWord(haystack, needle) {
  if (!haystack || !needle || needle.length < 2) return false;
  let re = boundaryCache.get(needle);
  if (!re) {
    re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    boundaryCache.set(needle, re);
  }
  return re.test(haystack);
}

/**
 * Does this company name match the watchlist?
 *
 * Exact normalised equality first, then whole-word containment in either
 * direction, so "Stripe" hits "Stripe Payments India" and "JPMorgan Chase"
 * hits a card that just says "JPMorgan". Returns the canonical display name,
 * or null.
 */
/**
 * Employers never to publish, whatever the watchlist says.
 *
 * Set by loadConfig from matching.blocklist. This is the last word: a blocked
 * employer is dropped before any watchlist term is considered, so a bad match
 * cannot resurrect it. Matching is on the normalised name and is a containment
 * test, so one entry covers "MedTourEasy", "MedTourEasy Navi Mumbai" and
 * "MedTourEasy Pvt Ltd" without needing all three spelled out.
 */
let blocklist = [];

export function setCompanyBlocklist(names) {
  blocklist = (names ?? [])
    .map((n) => normaliseCompany(n))
    .filter(Boolean);
}

/** Is this employer on the blocklist? Exported so callers can report it. */
export function isBlockedCompany(companyName) {
  const norm = normaliseCompany(companyName);
  if (!norm) return false;
  return blocklist.some((b) => norm === b || norm.includes(b));
}

export function matchCompany(companyName, watchlist) {
  const norm = normaliseCompany(companyName);
  if (!norm) return null;

  // Before anything else. A blocked employer must not be reachable through an
  // exact hit, a fuzzy hit, or an alias.
  if (isBlockedCompany(companyName)) return null;

  for (const { display, term } of watchlist) {
    if (norm === term) return display;
  }
  for (const { display, term } of watchlist) {
    // Single-word terms under 4 characters are too collision-prone to match
    // as a substring of a longer name; they must match exactly (handled above).
    if (term.length < 4 && !term.includes(' ')) continue;
    if (containsWord(norm, term) || containsWord(term, norm)) return display;
  }
  return null;
}

/**
 * Does this job title look like an internship, per config?
 *
 * Bounded with a small suffix allowance, so "intern" matches "Intern",
 * "Interns" and "Internship" but not "International Sales Manager" — a plain
 * substring test made that mistake.
 *
 * The bound is "not a letter or digit" rather than \b, because \w counts the
 * underscore as a word character, so \b never fires between "n" and "_".
 * Qualcomm posts as "Interim Intern_OneIT" and every one of those was dropped
 * as not-an-internship — the company was on the watchlist the whole time.
 */
const titleRegexCache = new Map();

function titleRegex(term) {
  let re = titleRegexCache.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?<![a-z0-9])${esc}(?:s|es|ship|ships)?(?![a-z0-9])`, 'i');
    titleRegexCache.set(term, re);
  }
  return re;
}

export function matchTitle(title, titleTerms) {
  if (!titleTerms?.length) return true;
  const t = String(title || '');
  return titleTerms.some((term) => titleRegex(term).test(t));
}

/**
 * How many hours back a run should look.
 *
 * Derived from the gap since the last successful run rather than fixed. With
 * hourly runs a fixed 30-hour window means re-paginating a day of postings
 * every time to find the newest hour; a fixed 3-hour one loses everything
 * posted while the lid was shut. Two hours of slack keeps a posting sitting
 * right on the boundary from slipping through.
 *
 * @param {number|null} lastRunStartedAt epoch ms, or null if there is none
 * @param {object} filters config.filters
 * @param {number} now epoch ms
 */
export function resolveWindowHours(lastRunStartedAt, filters, now = Date.now()) {
  const min = filters.minWindowHours ?? 3;
  const max = filters.maxWindowHours ?? 36;
  /**
   * Slack added on top of the gap since the last sweep.
   *
   * Overridable per search because the right amount depends on how dense the
   * region is and how often it is swept, and the defaults here were tuned when
   * this was one India search on a 30-minute loop. On a dense region the slack
   * is not free: US results run about 161 cards an hour, so every extra hour of
   * window is roughly seven more pages walked against the single account.
   */
  const margin = filters.windowMarginHours ?? 2;

  if (!filters.adaptiveWindow) return filters.postedWithinHours ?? 24;
  if (!lastRunStartedAt) return max;

  const gapHours = (now - lastRunStartedAt) / 3_600_000;
  // A clock skew or a future timestamp must not produce a negative window.
  if (!Number.isFinite(gapHours) || gapHours < 0) return max;

  return Math.round(Math.min(max, Math.max(min, gapHours + margin)));
}

/**
 * How much of its interval a search must have waited before it is due again.
 *
 * A search set to run hourly cannot simply demand 60 minutes to have elapsed.
 * The loop ticks every 30 and each tick starts at a slightly different moment —
 * startup jitter, and a run that begins only once the previous one finished — so
 * at the 60-minute tick the real gap is as likely to read 58 as 61. Requiring
 * the full interval would skip that tick and wait for the next, turning an
 * hourly search into a 90-minute one, and the drift compounds from there.
 *
 * Three quarters puts the threshold squarely between one tick and two for any
 * sensible pairing, so the search runs on the tick it was meant to and never on
 * the one before.
 */
export const INTERVAL_DUE_FRACTION = 0.75;

/**
 * Is a search due to run, given when its region was last swept?
 *
 * Due when it has no interval, when the region has never been swept (there is
 * no gap to measure and skipping would mean never starting), or when enough of
 * the interval has passed.
 *
 * @param {number|null} lastSweptAt  epoch ms of that region's last completed sweep
 * @param {number} intervalMinutes   0 or absent means "every run"
 */
export function isSearchDue(lastSweptAt, intervalMinutes, now = Date.now()) {
  const interval = Number(intervalMinutes ?? 0);
  if (!Number.isFinite(interval) || interval <= 0) return true;
  if (!lastSweptAt) return true;

  const elapsedMin = (now - lastSweptAt) / 60_000;
  // A clock skew or a future timestamp must not wedge a search off forever.
  if (!Number.isFinite(elapsedMin) || elapsedMin < 0) return true;

  return elapsedMin >= interval * INTERVAL_DUE_FRACTION;
}
