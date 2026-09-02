/**
 * WHICH LINKEDIN JOB SEARCH ARE WE ACTUALLY LOOKING AT?
 *
 * LinkedIn runs two search experiences with different DOM — the classic list at
 * `/jobs/search/`, and the "AI-powered" one at `/jobs/search-results/` — and it
 * moves accounts between them unannounced. As of 2 Sep 2026 the classic page
 * carries a banner reading "We're gradually retiring classic job search
 * starting in September", so the move is coming and is not optional.
 *
 * `src/linkedin.js` is already written to survive it: cards are found by their
 * recency TEXT rather than by any container class, the description block has a
 * candidate list covering both layouts, and the Next control falls back to a
 * button whose label is "Next". None of that is at risk. What is missing is
 * KNOWING WHICH ONE WE ARE ON — so a flip that quietly degrades extraction
 * looks like supply drying up, which this project has already spent weeks
 * misreading once (the apply-URL recovery ran at 0/443 and nothing said so).
 *
 * THE CLASSIFIER USES STRUCTURE, NEVER THE WORD "AI".
 *
 * This is the whole reason the module exists rather than a grep. The classic
 * page advertises the AI one: the retirement banner and a "Try AI job search"
 * button put that phrase on the page several times over. Counting mentions of
 * AI search therefore reports "AI variant" on a page that is emphatically the
 * classic variant — and CLAUDE.md's note that the 28 Aug capture showed
 * "60 AI-search markers" is very probably exactly that mistake. Only elements
 * decide here.
 */

/** Structural tells, in the order they are trusted. */
export const TELLS = {
  /* The redesign names its description block after the posting it belongs to.
     Nothing on the classic page does this, and it is the id openAndExtract
     prefers because it cannot lag the render the way the URL can. */
  ai: ['aboutIds'],
  /* The classic list is anchors to /jobs/view/<id>, which is where card.jobId
     comes from before a click, plus a real pagination bar. The redesign has
     neither: its cards are nested divs and its Next control is a bare button. */
  classic: ['jobViewLinks', 'paginationBar'],
  /* RECORDED, NEVER USED TO CLASSIFY — see `emberPayloads` below. */
  diagnostic: ['emberPayloads', 'retirementNotice', 'aiSearchOffered'],
};

/**
 * Runs INSIDE the page. Self-contained — Playwright serialises it, so it may
 * close over nothing, exactly like `hasRecencyMarker` and `scanCardsInPage`.
 *
 * Returns raw counts, not a verdict. Keeping the judgement in Node means it can
 * be tested against captured shapes without a browser, and means a future
 * change to the rules re-reads history instead of needing a fresh probe.
 */
export function probeVariant() {
  const count = (sel) => {
    try { return document.querySelectorAll(sel).length; } catch { return 0; }
  };
  const body = document.body?.innerText ?? '';
  return {
    path: location.pathname,
    aboutIds: count('[id^="JobDetails_AboutTheJob_"]'),
    emberPayloads: count('code[id^="bpr-guid-"]'),
    jobViewLinks: count('a[href*="/jobs/view/"]'),
    dataJobIds: count('[data-job-id], [data-occludable-job-id]'),
    listContainers: count('.jobs-search-results-list, .scaffold-layout__list, .jobs-search__results-list'),
    paginationBar: count('.artdeco-pagination, .jobs-search-pagination'),
    // Which description selector actually answers. The whole candidate list is
    // passed in so this stays the single source of that order.
    description: null,
    /* TEXT TELLS ARE RECORDED AND DELIBERATELY NOT USED TO CLASSIFY. They say
       what LinkedIn is announcing, which is worth having in the log — the
       retirement banner is how we learned this was coming — but a classic page
       advertising the AI one would classify as AI if these counted. */
    retirementNotice: /retiring classic job search/i.test(body),
    aiSearchOffered: /try ai job search|ai-powered job search/i.test(body),
  };
}

/**
 * Classify a fingerprint. Structural evidence only.
 *
 * Order matters: an AI tell is decisive because the classic tells can appear
 * alongside it (a /jobs/view/ link can be rendered by the detail pane's own
 * markup on either surface), whereas the AI tells have no classic equivalent.
 */
export function classifyVariant(fp = {}) {
  if (!fp || typeof fp !== 'object') return 'unknown';
  if (fp.path === '/jobs/search-results/') return 'ai';
  /* `emberPayloads` IS NOT A TELL AND MUST NOT BECOME ONE. It was one for
     exactly one run, on 2 Sep 2026, and the first live fingerprint disproved it
     immediately: a page reading `path /jobs/search/ · about 0 · ember 8 ·
     jobview 9 · pager 1 · desc #job-details` classified as "ai" on the Ember
     count alone while every other signal said classic — including the decisive
     one, that the CLASSIC description selector is the one that answered.
     `code[id^="bpr-guid-"]` is Ember's batched page response, and Ember is
     LinkedIn's framework for BOTH surfaces. CLAUDE.md describes it as where the
     redesign's payload lives, which is true and is not the same as it being
     absent from the classic page. It is kept in the fingerprint because
     applyUrlFrom reads those blobs, so its count is worth logging. */
  if (Number(fp.aboutIds) > 0) return 'ai';
  if (Number(fp.jobViewLinks) > 0 || Number(fp.paginationBar) > 0) return 'classic';
  return 'unknown';
}

/**
 * One line for the run log.
 *
 * Reported on EVERY run, not only on a change. A tripwire you hear from only
 * when it trips is one nobody notices the silence of — the same argument the
 * apply-link ratio and the employer cap are both logged unconditionally under.
 */
export function variantSummary(fp = {}) {
  const bits = [
    `path ${fp.path ?? '?'}`,
    `about ${fp.aboutIds ?? 0}`,
    `ember ${fp.emberPayloads ?? 0}`,
    `jobview ${fp.jobViewLinks ?? 0}`,
    `pager ${fp.paginationBar ?? 0}`,
    `desc ${fp.description ?? 'none'}`,
  ];
  if (fp.retirementNotice) bits.push('retirement notice');
  return `${classifyVariant(fp)} — ${bits.join(' · ')}`;
}

/**
 * Has the experience actually moved?
 *
 * COMPARES THE CLASSIFICATION, NOT THE FINGERPRINT. Counts move every page —
 * 23 cards then 24, a pagination bar that renders on page 2 and not page 20 —
 * so diffing raw fingerprints would alert on every run and the alert would stop
 * being read within a day.
 */
export function variantChanged(previous, next) {
  if (!previous) return false;           // first sighting is not a change
  if (next === 'unknown') return false;  // a page that failed to render is not a flip
  return previous !== next;
}

export const VARIANT_KEY = (region) => `search_variant:${region}`;

/**
 * Record what this run saw, and say whether it is new.
 *
 * `unknown` is never STORED either. A single failed render would otherwise
 * overwrite a good baseline, and the next healthy run would then report a flip
 * back — two false alerts from one bad page load.
 */
export function noteVariant(store, region, fp) {
  const variant = classifyVariant(fp);
  let previous = null;
  try { previous = store.getSetting(VARIANT_KEY(region)) || null; } catch { return { variant, changed: false, previous: null }; }
  const changed = variantChanged(previous, variant);
  if (variant !== 'unknown' && variant !== previous) {
    try { store.setSetting(VARIANT_KEY(region), variant); } catch { /* a log line is not worth failing a run for */ }
  }
  return { variant, changed, previous };
}
