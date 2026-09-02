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
