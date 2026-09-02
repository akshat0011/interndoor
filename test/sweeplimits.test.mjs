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
import { pageCapFor, openCapFor, staleCutoffFor, pageIsAllOlderThan } from '../src/sweeplimits.js';
import { parseRelativeTime } from '../src/extract.js';
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
  check('20 pages', us.maxPages, 20);
  check('5 openings per employer', us.maxOpensPerCompany, 5);
  check('stops on a page that is entirely 2h old', us.stopAfterPageOlderThanHours, 2);
  check('and it is running', us.enabled, true);

  check('the page cap overrides the global one', pageCapFor(us, 40), 20);
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

console.log('\n== src/index.js actually applies all three ==');
{
  /* index.js executes on import, so this reads the source. It asserts the
     WIRING only — every rule above is tested against the real functions. */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  check('imports the module',
    /import \{ pageCapFor, openCapFor, staleCutoffFor, pageIsAllOlderThan \}/.test(src), true);
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
  check('the all-old page test ends the walk',
    /if \(pageIsAllOlderThan\(cards, staleCutoffFor\(search\), parseRelativeTime\)\)/.test(src), true);
  check('and it counts as a COMPLETED walk, so the baseline advances',
    /pageIsAllOlderThan[\s\S]{0,320}?walkComplete = true;/.test(src), true);
  /* The per-employer cap must be reported even when nothing hits it. A limit
     you only hear about when it misbehaves is one nobody notices. */
  check('the employer cap reports itself either way',
    /no employer reached \$\{openCap\} openings/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
