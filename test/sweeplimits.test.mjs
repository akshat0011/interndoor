/**
 * Per-search sweep limits — and the guarantee that INDIA IS UNAFFECTED.
 *
 * Asked for on 2 Sep 2026, in these words: "no optimization to india scrapes at
 * all, india scrapes are the utmost priority they must run for all the pages
 * until no next page is found and they must open all the interesting job cards
 * every 30 mins". So the India half of this file is not a nicety — it is the
 * constraint the US half is allowed to exist under, and every assertion here
 * that names India is pinning a promise rather than an implementation detail.
 */
import { pageCapFor, openCapFor, staleCutoffFor, pageIsAllOlderThan, sweepBaselineFor } from '../src/sweeplimits.js';
import { parseRelativeTime } from '../src/extract.js';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const cfg = loadConfig();
const india = cfg.declaredSearches.find((s) => s.region === 'IN');
const us = cfg.declaredSearches.find((s) => s.region === 'US');

console.log('\n== INDIA IS UNLIMITED, AND THAT IS THE POINT ==');
{
  check('India is declared', !!india, true);
  /* Read off the CONFIG, not off a fixture. A fixture would go on passing after
     someone added maxPages to the India entry, which is the exact regression
     this file exists to prevent. */
  check('no page cap of its own', india.maxPages, undefined);
  check('no per-employer open cap', india.maxOpensPerCompany, undefined);
  check('no all-old page stop', india.stopAfterPageOlderThanHours, undefined);
  check('no interval, so it runs on every 30-minute tick', india.intervalMinutes, undefined);

  // …and the resolvers agree, so nothing bounds it in code either.
  check('it walks to the global safety cap, not a smaller one',
    pageCapFor(india, cfg.limits.maxPagesPerSearch), cfg.limits.maxPagesPerSearch);
  check('it opens every card its gates approve', openCapFor(india), 0);
  check('and no page age can stop it early', staleCutoffFor(india), null);
}

console.log('\n== the US carries all three, at the asked-for values ==');
{
  check('US is declared', !!us, true);
  check('hourly', us.intervalMinutes, 60);
  /* Raised 20 -> 40 on 9 Sep 2026. 15% of healthy 2h-window walks were filling
     the 20-page budget before exhausting the window, so anything past page 20 on
     those runs went unread. The cap is a ceiling, not a target — the median walk
     finishes in 8 pages and is untouched by this. */
  check('40 pages', us.maxPages, 40);
  /* It now EQUALS the global safety cap, so the US has no headroom beneath it.
     Pinned so that going deeper is a deliberate two-part change rather than one
     that silently does nothing. */
  check('which is also the global ceiling', cfg.limits.maxPagesPerSearch, 40);
  check('so the US effective cap is its own', pageCapFor(us, cfg.limits.maxPagesPerSearch), 40);
  check('5 openings per employer', us.maxOpensPerCompany, 5);
  check('stops on a page that is entirely 2h old', us.stopAfterPageOlderThanHours, 2);
  check('and it is running', us.enabled, true);

  /* The override still has to be observable now that the US's own cap and the
     global one are both 40. Probe with a DIFFERENT global, or this asserts
     nothing: the first version passed 40 and expected 20, and the day those two
     numbers met it failed for the right reason. */
  check('the page cap overrides the global one', pageCapFor(us, 99), 40);
  check('the open cap resolves', openCapFor(us), 5);
  const T = 1_780_000_000_000;
  check('the cutoff is two hours back', staleCutoffFor(us, T), T - 2 * 3_600_000);
}

console.log('\n== a search that sets nothing is unchanged in every respect ==');
{
  /* The limits are opt-in. Anything else would mean adding this module changed
     the behaviour of a board nobody asked to change. */
  check('falls back to the global cap', pageCapFor({}, 40), 40);
  check('unlimited opens', openCapFor({}), 0);
  check('no cutoff', staleCutoffFor({}), null);
  check('zero is not a cap, it is absence', pageCapFor({ maxPages: 0 }, 40), 40);
  check('nor is a negative one', openCapFor({ maxOpensPerCompany: -1 }), 0);
  check('nor is a string', staleCutoffFor({ stopAfterPageOlderThanHours: 'yes' }), null);
  /* An explicit 0 is the dangerous one: read as a cutoff it means "now", and
     every card on page 1 is older than now, so the walk would stop before
     opening anything. It has to mean absence. */
  check('an explicit zero is absence, not "stop on page 1"',
    staleCutoffFor({ stopAfterPageOlderThanHours: 0 }, 1_780_000_000_000), null);
  check('and a zero page cap likewise falls back', pageCapFor({ maxPages: 0 }, 40), 40);
}

console.log('\n== the all-old page test ==');
const NOW = 1_780_000_000_000;
const CUT = NOW - 2 * 3_600_000;
const card = (postedText) => ({ postedText });
const parse = (t) => parseRelativeTime(t, NOW);
{
  check('a page of 3h-old cards has caught up',
    pageIsAllOlderThan([card('3 hours ago'), card('5 hours ago'), card('1 day ago')], CUT, parse), true);
  check('ONE fresh card keeps the walk going',
    pageIsAllOlderThan([card('4 hours ago'), card('20 minutes ago'), card('6 hours ago')], CUT, parse), false);
  check('the boundary is not old enough',
    pageIsAllOlderThan([card('2 hours ago')], CUT, parse), false);
  check('but just past it is',
    pageIsAllOlderThan([card('3 hours ago')], CUT, parse), true);

  /* AN UNDATEABLE CARD COUNTS AS FRESH. parseRelativeTime returns null for text
     it does not recognise, and a truncated sweep is silent — so one unreadable
     card must never end a walk that had real postings under it. This is the
     same benefit of the doubt the covered-ground stop already gives. */
  check('an unparseable card protects the page',
    pageIsAllOlderThan([card('5 hours ago'), card('Promoted'), card('1 day ago')], CUT, parse), false);
  check('a missing posted text does too',
    pageIsAllOlderThan([card('5 hours ago'), card(undefined)], CUT, parse), false);
  check('a page of nothing but unparseable cards never stops the walk',
    pageIsAllOlderThan([card('Promoted'), card('')], CUT, parse), false);

  // An empty page is the end-of-results / markup-break case, handled elsewhere.
  check('an empty page is not "all old"', pageIsAllOlderThan([], CUT, parse), false);
  check('nor is a missing one', pageIsAllOlderThan(undefined, CUT, parse), false);
  // No cutoff means the rule is off entirely — India's state.
  check('no cutoff, no stop',
    pageIsAllOlderThan([card('9 days ago')], null, parse), false);
}

console.log('\n== the page-age diagnostic ==');
{
  /* A stop that never fires looks exactly like a rule that is switched off.
     This project has shipped that before — the apply-URL recovery ran at 0/443
     for weeks. So the rule reports what it saw on every page. */
  const { pageAgeSummary } = await import('../src/sweeplimits.js');
  const a = pageAgeSummary(
    [card('30 minutes ago'), card('3 hours ago'), card('Be an early applicant')], parse, NOW);
  check('counts the page', a.count, 3);
  check('newest in hours', Number(a.newest.toFixed(2)), 0.5);
  check('oldest in hours', Number(a.oldest.toFixed(2)), 3);
  /* THE UNDATEABLE COLUMN IS THE POINT. "Be an early applicant" is one of the
     strings scanCardsInPage finds cards BY, and it does not parse — so it counts
     as fresh, and one per page is enough to keep a walk going for ever. If this
     is never zero, the stop can never fire, and the reason is in the log rather
     than needing a live probe against the account. */
  check('and names the undateable ones', a.undateable, 1);

  const none = pageAgeSummary([card('Be an early applicant')], parse, NOW);
  check('a page with nothing dateable reports no ages', [none.newest, none.oldest], [null, null]);
  check('but still counts them', [none.count, none.undateable], [1, 1]);
  check('an empty page is safe', pageAgeSummary([], parse, NOW).count, 0);
  check('and a missing one', pageAgeSummary(undefined, parse, NOW).count, 0);
}

console.log('\n== src/index.js actually applies all three ==');
{
  /* index.js executes on import, so this reads the source. It asserts the
     WIRING only — every rule above is tested against the real functions. */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  check('imports the module',
    /import \{[^}]*pageCapFor[^}]*openCapFor[^}]*staleCutoffFor[^}]*pageIsAllOlderThan[^}]*\} from '\.\/sweeplimits\.js'/.test(src), true);
  check('the page cap bounds the walk',
    /const lastPage = firstPage \+ pageCap;/.test(src) &&
    /const pageCap = pageCapFor\(search, cfg\.limits\.maxPagesPerSearch\);/.test(src), true);
  check('the open cap is resolved per search',
    /const openCap = openCapFor\(search\);/.test(src), true);
  /* The whole gate, not just its parts. Asserting the pieces separately let
     `if (openCap)` be mutated to `if (false)` — every piece still present, the
     cap never enforced, and the test green. */
  check('and the gate actually skips the card',
    /if \(openCap\) \{[\s\S]{0,400}?opensByCompany\.get\(card\.company\)[\s\S]{0,300}?>= openCap[\s\S]{0,300}?continue;/.test(src), true);
  check('the count only advances for a card we are about to open',
    /opensByCompany\.set\(card\.company, seenForCompany \+ 1\);[\s\S]{0,80}?\}\s*\n\s*\n\s*log\.ok\(`Opening:/.test(src), true);
  check('and every page reports its ages, stop or no stop',
    /const a = pageAgeSummary\(cards, parseRelativeTime\);[\s\S]{0,300}?undateable/.test(src), true);
  check('the all-old page test ends the walk',
    /if \(pageIsAllOlderThan\(cards, staleCutoffFor\(search\), parseRelativeTime\)\)/.test(src), true);
  check('and it counts as a COMPLETED walk, so the baseline advances',
    /pageIsAllOlderThan[\s\S]{0,320}?walkComplete = true;/.test(src), true);
  /* The per-employer cap must be reported even when nothing hits it. A limit
     you only hear about when it misbehaves is one nobody notices. */
  check('the employer cap reports itself either way',
    /no employer reached \$\{openCap\} openings/.test(src), true);
}

/* ============================================================================
   WHAT A WALK MAY RECORD AS THE BASELINE — the 8 Sep 2026 US freeze.

   sweep_ok_at is a HIGH-WATER MARK OF COMPLETE COVERAGE. The bug was that
   hitting the page cap recorded nothing at all, so the baseline froze, the
   window grew every run, and neither early stop could ever fire again. The fix
   is not "record the start on a cap" — that claims pages the cap stopped us
   reading. It is: a capped walk records the start ONLY if it reached back past
   the previous baseline, so the two stretches join with no hole between them.
   ============================================================================ */
{
  const HOUR = 3_600_000;
  const S = 1_800_000_000_000;                 // this search's start
  const back = (h) => S - h * HOUR;

  // A walk that reached a real end read its whole window.
  check('a completed walk records the search start',
    sweepBaselineFor({ endedOnOwnCap: false, searchStartedAt: S, oldestSeenAt: back(3), previousBaseline: back(1) }), S);
  check('a completed walk records it even with nothing dateable',
    sweepBaselineFor({ endedOnOwnCap: false, searchStartedAt: S, oldestSeenAt: null, previousBaseline: back(1) }), S);
  check('a completed walk records it even on a never-swept region',
    sweepBaselineFor({ endedOnOwnCap: false, searchStartedAt: S, oldestSeenAt: back(3), previousBaseline: null }), S);

  /* THE STEADY STATE THIS FIX EXISTS TO PRODUCE. Hourly search, 20 pages reach
     ~3h deep, previous sweep an hour ago: the walk overlaps it by two hours, so
     coverage is contiguous and the baseline advances. */
  check('a capped walk that reached back past the last sweep records the start',
    sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: S, oldestSeenAt: back(3), previousBaseline: back(1) }), S);

  /* THE REGRESSION ITSELF. 9 Sep 2026 measured: baseline 19h stale, page 20's
     oldest card 3.0h old. The walk does NOT meet the last sweep, so there is a
     16h hole and the baseline must not move over it. This is the case the old
     code got right by accident and the naive fix would get wrong. */
  check('a capped walk that did NOT reach the last sweep records nothing',
    sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: S, oldestSeenAt: back(3), previousBaseline: back(19) }), null);

  // Exactly meeting the last sweep is contiguous — there is no gap at a point.
  check('reaching back exactly to the last sweep is contiguous',
    sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: S, oldestSeenAt: back(1), previousBaseline: back(1) }), S);
  check('one millisecond short of it is not',
    sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: S, oldestSeenAt: back(1) + 1, previousBaseline: back(1) }), null);

  /* An undateable card counts as FRESH everywhere else in this module, because
     that is the safe reading for whether to keep paging. It is the UNSAFE
     reading for how far back we got, so a capped walk with nothing dateable
     claims nothing. */
  check('a capped walk with nothing dateable records nothing',
    sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: S, oldestSeenAt: null, previousBaseline: back(1) }), null);
  /* A NEVER-SWEPT REGION, IN ALL THREE SHAPES IT CAN ARRIVE IN. `null` alone
     does not test the guard — it coerces to 0, so the contiguity comparison
     below happens to return null anyway. `undefined` is the one that bites,
     because `x > undefined` is false and the walk would sail through. */
  for (const [what, prev] of [['null', null], ['undefined', undefined], ['NaN', NaN], ['zero', 0]]) {
    check(`a capped walk on a never-swept region (${what}) records nothing`,
      sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: S, oldestSeenAt: back(3), previousBaseline: prev }), null);
  }
  // A future-dated card earns no coverage, and the success path returns the
  // search's own start, so nothing can ever be claimed past it.
  check('a future-dated card records nothing',
    sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: S, oldestSeenAt: S + HOUR, previousBaseline: back(1) }), null);

  // Junk in must not wedge a region's baseline to a nonsense value.
  check('no search start, no claim', sweepBaselineFor({ endedOnOwnCap: false, searchStartedAt: 0 }), null);
  check('called with nothing at all', sweepBaselineFor(), null);

  /* THE RUNAWAY, SIMULATED. Before the fix a capped walk recorded nothing, so
     the gap grew by the interval every run and resolveWindowHours stretched
     with it. After it, an hourly search reading 3h deep pins the gap at the
     interval forever. Asserting the SHAPE, not one number. */
  let baseline = back(1), stuck = 0;
  for (let run = 1; run <= 12; run++) {
    const start = S + run * HOUR;
    const mark = sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: start, oldestSeenAt: start - 3 * HOUR, previousBaseline: baseline });
    if (mark === null) stuck++; else baseline = mark;
  }
  check('twelve hourly capped walks never once fail to advance', stuck, 0);
  check('and the gap stays one interval, not twelve', (S + 12 * HOUR - baseline) / HOUR, 0);

  /* AND THE ESCALATION IS KEPT. If supply ever densifies until 20 pages no
     longer span the interval, the walk stops overlapping, the baseline freezes
     on purpose, and the window keeps covering the gap. */
  let dense = back(1), advanced = 0;
  for (let run = 1; run <= 6; run++) {
    const start = S + run * HOUR;
    const mark = sweepBaselineFor({ endedOnOwnCap: true, searchStartedAt: start, oldestSeenAt: start - 0.5 * HOUR, previousBaseline: dense });
    if (mark !== null) { advanced++; dense = mark; }
  }
  check('a search that stops keeping up refuses the baseline every time', advanced, 0);
}

/* THE WIRING. The function above is only worth anything if index.js actually
   uses it, and this project has shipped a guard that ran on zero of every open
   ever performed. Assert the PAIRING each time, never the presence. */
{
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  check('index.js imports it', /import \{[^}]*sweepBaselineFor[^}]*\} from '\.\/sweeplimits\.js';/.test(src), true);
  /* INDIA CANNOT REACH THIS PATH AT ALL, which is the promise the whole file
     exists to pin. It sets no maxPages, so `Number(search.maxPages) > 0` is
     false, cappedOnOwnLimit is never set, and its walk still has to end on
     LinkedIn's own Next control. Read off the live config, not a fixture. */
  check('India sets no maxPages, so it can never end on its OWN cap', Number(india.maxPages) > 0, false);
  check('and the US does', Number(us.maxPages) > 0, true);
  check('the own-cap branch marks itself',
    /Reached this search's own \$\{pageCap\}-page limit[\s\S]{0,120}?cappedOnOwnLimit = true;/.test(src), true);
  check('and the GLOBAL cap branch does NOT',
    /Hit the \$\{pageCap\}-page cap[\s\S]{0,200}?cappedOnOwnLimit = true;/.test(src), false);
  /* PIN THE COMPARISON, NOT THE ASSIGNMENT. The first version of this matched
     `if (false) oldestSeenAt = at;` perfectly happily — the mutation that
     removes tracking entirely left every word the regex was looking for in
     place. §1's regex-matches-the-thing-it-is-searching-for, again. */
  check('the oldest card is tracked off every page',
    /for \(const c of cards\) \{[\s\S]{0,200}?parseRelativeTime\(c\.postedText\)[\s\S]{0,120}?at < oldestSeenAt\)\) oldestSeenAt = at;/.test(src), true);
  /* The mutation that matters: markRegionSweep taking searchStartedAt again
     would restore the silent hole, and every other assertion here would pass. */
  check('markRegionSweep is given the computed mark, not the search start',
    /store\.markRegionSweep\(region, sweepMark\);/.test(src), true);
  check('and never the raw start',
    /store\.markRegionSweep\(region, searchStartedAt\);/.test(src), false);
  check('a capped walk is treated as an end',
    /const reachedEnd = walkComplete \|\| cappedOnOwnLimit;/.test(src), true);
  check('the sweep is still gated on the render floor',
    /reachedEnd && rendered && sweepMark/.test(src), true);
  check('falling behind warns rather than passing silently',
    /baseline unchanged, it is falling behind/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
