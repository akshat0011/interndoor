/**
 * Per-search limits on how hard a sweep may work.
 *
 * EVERYTHING ON THIS SITE DEPENDS ON ONE LINKEDIN ACCOUNT, and page loads are
 * what put it at risk — the session was dropped twice in August with no 429 and
 * no challenge, which is the milder warning and the one worth heeding. These
 * three limits bound a dense region's walk.
 *
 * THEY ARE OPT-IN, AND THAT IS THE WHOLE DESIGN. A search that sets none of
 * them behaves exactly as it did before this module existed. India sets none:
 * it walks to the end of its results every 30 minutes and opens every card its
 * gates approve, because it feeds ~91% of the India board and a missed posting
 * there is the one cost not worth paying. The US sets all three, because its
 * results run ~161 cards an hour and an unbounded walk spends most of a sweep
 * re-reading ground the previous run already covered.
 *
 * Pure and dependency-free so the rules can be tested directly. `src/index.js`
 * executes on import, so anything left inline there can only ever be asserted
 * by reading the source, which pins the wording rather than the behaviour.
 */

/** How deep this search may page. Falls back to the global safety cap. */
export function pageCapFor(search = {}, globalCap = 0) {
  const own = Number(search.maxPages);
  return own > 0 ? own : globalCap;
}

/**
 * How many cards one employer may cost this search, or 0 for no limit.
 *
 * Counted on the CARD's company, before the click — the point is to avoid the
 * request, and the company is one of the few things a card states without being
 * opened.
 */
export function openCapFor(search = {}) {
  const own = Number(search.maxOpensPerCompany);
  return own > 0 ? own : 0;
}

/** The absolute age at which a full page means the walk has caught up, in ms. */
export function staleCutoffFor(search = {}, now = Date.now()) {
  const hours = Number(search.stopAfterPageOlderThanHours);
  return hours > 0 ? now - hours * 3_600_000 : null;
}

/**
 * Is every card on this page already older than the cutoff?
 *
 * Results are date-descending, so a page whose newest card predates the cutoff
 * means everything past it is older still. On an hourly sweep with a 2h cutoff
 * that is, by definition, a page the previous run already walked.
 *
 * AN UNDATEABLE CARD COUNTS AS FRESH. `parseRelativeTime` reads text like
 * "2 hours ago" and returns null for anything it does not recognise — a
 * promoted card, a layout LinkedIn changed this morning. Treating null as old
 * would let one unreadable card end a walk that had real postings under it, and
 * a truncated sweep is silent. This is the same benefit of the doubt the
 * covered-ground stop and the staleness gate both give.
 *
 * An EMPTY page is never "all old" either — there is nothing to have read, and
 * a zero-card page is already handled as a markup break or the end of results.
 */
export function pageIsAllOlderThan(cards, cutoff, parse) {
  if (!cutoff || !cards?.length) return false;
  return !cards.some((card) => {
    const at = parse(card.postedText);
    return !at || at >= cutoff;
  });
}

/**
 * What a page's card ages actually look like, for the log.
 *
 * `pageIsAllOlderThan` returning false is INDISTINGUISHABLE from the rule being
 * off, and a stop that never fires is exactly the kind of silent no-op this
 * project has shipped before (the apply-URL recovery ran at 0/443 for weeks).
 * So a search carrying the rule reports what it saw on every page, whether or
 * not it stopped.
 *
 * `undateable` is the number that matters. LinkedIn's recency marker is not
 * always a time — "Be an early applicant" is one of the strings
 * `scanCardsInPage` finds cards BY, and it does not parse. Every such card
 * counts as fresh, so one of them on a page is enough to keep a walk going.
 * If this column is never zero, the rule can never fire and the reason is here
 * rather than in a live probe.
 */
export function pageAgeSummary(cards, parse, now = Date.now()) {
  const ages = [];
  let undateable = 0;
  for (const card of cards ?? []) {
    const at = parse(card.postedText);
    if (!at) undateable++;
    else ages.push((now - at) / 3_600_000);
  }
  if (!ages.length) return { count: cards?.length ?? 0, undateable, newest: null, oldest: null };
  return {
    count: cards.length,
    undateable,
    newest: Math.min(...ages),
    oldest: Math.max(...ages),
  };
}

/**
 * What a finished walk may record as the region's new baseline.
 *
 * Returns epoch ms to store, or `null` to leave the baseline exactly where it
 * is. `sweep_ok_at` is a HIGH-WATER MARK OF COMPLETE COVERAGE — "everything
 * posted before this has been seen" — which is why `resolveWindowHours` can
 * size the next window off it. Anything recorded here has to keep that true.
 *
 * THE PAGE CAP WAS THE ONE WALK ENDING THAT RECORDED NOTHING, AND THAT IS WHAT
 * FROZE THE US BASELINE FOR 19 HOURS ON 8 SEP 2026. `src/index.js` has four
 * ways out of the page loop — no Next button, a short page with no pager, the
 * covered-ground stop and the all-cards-older stop — and all four set
 * `walkComplete`. Reaching `maxPages` set nothing, so `markRegionSweep` was
 * never called, so the window stretched on the next run, so 20 pages were even
 * less likely to reach the end. Positive feedback, and neither early stop can
 * break it: the covered-ground stop compares against a baseline that is by then
 * hours stale so every page reads as fresh, and the all-older stop needs EVERY
 * card on a page to be old while LinkedIn's `sortBy=DD` is loose enough to put
 * a 0.1h card on page 20 beside a 3.0h one.
 *
 * RECORDING THE SEARCH'S START ON A CAPPED WALK IS THE OBVIOUS WRONG FIX. It
 * claims the whole window including the pages the cap stopped us reading, and
 * puts everything past page 20 behind the next run's horizon where nothing
 * would look at it again — the precise silent hole `markRegionSweep` already
 * refuses to create when it stores the search's start rather than `Date.now()`.
 *
 * SO A CAPPED WALK HAS TO PROVE CONTIGUITY, NOT DEPTH. It saw everything from
 * the oldest card it read up to now. The previous baseline says everything
 * before then was already seen. Those two only join into "everything before now
 * has been seen" if the walk reached BACK PAST the previous baseline:
 *
 *   oldestSeenAt <= previousBaseline   ->  contiguous, record searchStartedAt
 *   oldestSeenAt >  previousBaseline   ->  a hole between them, record nothing
 *
 * In steady state that is self-sustaining and cheap: an hourly search reading
 * ~3h deep overlaps the previous walk's start by two hours every time, so the
 * baseline advances every run and the window stays at `minWindowHours`.
 *
 * THE SECOND BRANCH IS THE OLD FROZEN BEHAVIOUR, KEPT DELIBERATELY, FOR THE ONE
 * CASE THAT WARRANTS IT. If a region's supply ever densifies until 20 pages no
 * longer span the interval, the walk stops overlapping and there is a real gap.
 * Leaving the baseline put keeps the window wide and — because `isSearchDue`
 * reads the same baseline — keeps the search running every tick until it
 * catches up. That is the correct escalation; it was only ever wrong as the
 * response to a walk that WAS keeping up.
 *
 * @param {object}      o
 * @param {boolean}     o.endedOnOwnCap    stopped on the search's OWN maxPages, not the global cap
 * @param {number}      o.searchStartedAt  epoch ms this search began
 * @param {number|null} o.oldestSeenAt     epoch ms of the oldest dateable card read
 * @param {number|null} o.previousBaseline epoch ms this region was last swept to
 */
export function sweepBaselineFor({
  endedOnOwnCap = false,
  searchStartedAt = 0,
  oldestSeenAt = null,
  previousBaseline = null,
} = {}) {
  if (!Number.isFinite(searchStartedAt) || searchStartedAt <= 0) return null;

  // A walk that reached a real end read its whole window, so the window's own
  // start is the honest mark — unchanged from before this function existed.
  if (!endedOnOwnCap) return searchStartedAt;

  // A region never swept has no previous coverage to join onto, so a capped
  // walk cannot establish the high-water mark at all. Leaving it null keeps the
  // full window and no early stop, which is what a first sweep wants anyway.
  if (!Number.isFinite(previousBaseline) || previousBaseline <= 0) return null;

  // Nothing dateable on the whole walk means no claim can be made. An
  // undateable card counts as FRESH everywhere else in this module, but "fresh"
  // is the safe reading for whether to keep PAGING and the unsafe one for how
  // far back we got, so here it earns no coverage.
  if (!Number.isFinite(oldestSeenAt) || oldestSeenAt <= 0) return null;

  // Did not reach back past the last sweep: there is a hole between the two.
  if (oldestSeenAt > previousBaseline) return null;

  return searchStartedAt;
}
