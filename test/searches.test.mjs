/**
 * The region wiring on a LinkedIn search.
 *
 * These run against the REAL config.json on purpose. The invariants here are
 * properties of the live search list, not of a fixture: the thing worth pinning
 * is that India's entry has not quietly gained a geoId, and a fixture could not
 * tell anyone that.
 */
import { loadConfig, isSearchDue, INTERVAL_DUE_FRACTION, resolveWindowHours } from '../src/config.js';
import { resolveSearches } from '../src/searches.js';
import { buildSearchUrl } from '../src/linkedin.js';
import { regionOf, resolveRowRegion } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
function ok(label, cond) { check(label, !!cond, true); }

const cfg = loadConfig();
const searches = resolveSearches(cfg);
const byRegion = new Map(searches.map((s) => [s.region, s]));

console.log('\n== every search names a region the site knows ==');
for (const s of searches) {
  ok(`${s.region} is a real region`, !!regionOf(s.region));
}
check('no search is left without a region', searches.filter((s) => !s.region).length, 0);

console.log('\n== India collects on account geo bias, never on a geoId ==');
// CLAUDE.md is emphatic about this one. LinkedIn has always returned Indian
// results for this account with no location filter at all, and India's search
// feeds ~91% of the India board. Sending a geoId would change what the single
// most load-bearing collector returns, to fix nothing.
const india = byRegion.get('IN');
ok('India has a search', !!india);
check('India sends no geoId', india?.geoId ?? null, null);
ok('India\'s URL carries no geoId param',
  !buildSearchUrl(india, cfg.filters, { start: 0 }).includes('geoId='));

console.log('\n== a non-India region is scoped by geoId, which is load-bearing ==');
// The redirect to /jobs/search-results/ DROPS `location=` and keeps `geoId`,
// so the location string is cosmetic and the id is the only real scope.
for (const s of searches.filter((x) => x.region !== 'IN')) {
  const url = buildSearchUrl(s, cfg.filters, { start: 0 });
  ok(`${s.region} sets a geoId`, Number.isFinite(Number(s.geoId)) && Number(s.geoId) > 0);
  ok(`${s.region} matches the registry's id`, Number(s.geoId) === regionOf(s.region).geoId);
  ok(`${s.region}'s URL carries geoId`, url.includes(`geoId=${s.geoId}`));
}

console.log('\n== a region is never searched twice in one run ==');
// Two entries for one region would double that region's page loads while
// looking like ordinary config, and both would write the same sweep baseline.
check('regions are distinct', byRegion.size, searches.length);

console.log('\n== only published regions are worth spending requests on ==');
// Collecting a region we do not publish is not wrong, but a LinkedIn search is
// the expensive collector — unlike an ATS board, whose requests are already
// being made. Anything here that is not published is worth a second look.
const published = new Set((cfg.regions?.publish ?? []).map(String));
for (const s of searches) {
  ok(`${s.region} is published`, published.has(s.region));
}

console.log('\n== the request-budget dial exists and defaults to "all" ==');
check('searchesPerRun is present', typeof cfg.limits.searchesPerRun, 'number');
ok('searchesPerRun is not negative', cfg.limits.searchesPerRun >= 0);

console.log('\n== window and paging params survive per-search filters ==');
// planSweep hands each search its OWN filters object, so the window has to come
// from that object rather than from a run-wide one.
const threeHours = buildSearchUrl(india, { ...cfg.filters, postedWithinHours: 3 }, { start: 0 });
const thirtySix = buildSearchUrl(india, { ...cfg.filters, postedWithinHours: 36 }, { start: 0 });
ok('3h window becomes f_TPR=r10800', threeHours.includes('f_TPR=r10800'));
ok('36h window becomes f_TPR=r129600', thirtySix.includes('f_TPR=r129600'));
ok('two windows really differ', threeHours !== thirtySix);
ok('start= pages in 25s', buildSearchUrl(india, cfg.filters, { start: 50 }).includes('start=50'));

console.log('\n== a search may run less often than the loop ticks ==');
const NOW = 1_700_000_000_000;
const agoMin = (m) => NOW - m * 60_000;
const due = (lastSwept, interval) => isSearchDue(lastSwept, interval, NOW);

// No interval means every run, which is India's case and the default.
ok('no interval is always due', due(agoMin(1), 0));
ok('undefined interval is always due', due(agoMin(1), undefined));

// An hourly search against a 30-minute tick: skip the 30, take the 60.
ok('hourly, 30m elapsed — not due', !due(agoMin(30), 60));
ok('hourly, 60m elapsed — due', due(agoMin(60), 60));

// The reason the threshold is a fraction and not the whole interval. Ticks
// drift, so the 60-minute tick can land anywhere near 60; requiring the full
// interval would push it to the next tick and make an hourly search 90-minutely.
ok('hourly, 58m elapsed (tick landed early) — still due', due(agoMin(58), 60));
ok('hourly, 46m elapsed — due', due(agoMin(46), 60));
ok('hourly, 44m elapsed — not due', !due(agoMin(44), 60));
check('the threshold sits between one tick and two', INTERVAL_DUE_FRACTION * 60 > 30 && INTERVAL_DUE_FRACTION * 60 < 60, true);

// A region that has never been swept must start, or an interval would mean it
// never runs at all.
ok('never swept — due', due(null, 60));
ok('never swept, no interval — due', due(null, 0));

// A future timestamp must not wedge a search off forever.
ok('clock skew into the future — due', due(NOW + 60 * 60_000, 60));

console.log('\n== the live config: India every run, US hourly ==');
check('India has no interval', byRegion.get('IN')?.intervalMinutes ?? 0, 0);
check('US runs hourly', byRegion.get('US')?.intervalMinutes, 60);
ok('India is due on any tick', due(agoMin(30), byRegion.get('IN')?.intervalMinutes ?? 0));
ok('US is not due 30m after its sweep', !due(agoMin(30), byRegion.get('US')?.intervalMinutes));
ok('US is due 60m after its sweep', due(agoMin(60), byRegion.get('US')?.intervalMinutes));

console.log('\n== a dense region narrows its own lookback ==');
// The US sweep was walking its whole 3h result set to exhaustion — 21 pages,
// ~480 cards — to collect one hour of new postings, because the global window
// defaults were tuned for one India search on a 30-minute loop. Measured
// density is ~161 US cards an hour, so every extra hour of window is ~7 pages.
const winOf = (search, gapHours) => {
  const f = {
    ...cfg.filters,
    ...(search.minWindowHours != null ? { minWindowHours: search.minWindowHours } : {}),
    ...(search.windowMarginHours != null ? { windowMarginHours: search.windowMarginHours } : {}),
  };
  return resolveWindowHours(NOW_W - gapHours * 3_600_000, f, NOW_W);
};
const NOW_W = 1_700_000_000_000;
const IN_S = byRegion.get('IN'), US_S = byRegion.get('US');

check('India is unchanged at its 30-minute cadence', winOf(IN_S, 0.5), 3);
check('India after a 6h sleep still stretches', winOf(IN_S, 6), 8);
check('US at its hourly cadence takes 2h, not 3', winOf(US_S, 1.1), 2);
check('US on the dot takes 2h', winOf(US_S, 1.0), 2);
// The floor and the slack change; the adaptive rule does not.
check('US after a 6h sleep still stretches', winOf(US_S, 6), 7);
check('US is capped like everything else', winOf(US_S, 500), cfg.filters.maxWindowHours ?? 36);

// The defaults must not move — India depends on them.
check('default floor', cfg.filters.minWindowHours, 3);
check('default slack is 2h', resolveWindowHours(NOW_W - 0.5 * 3_600_000, { adaptiveWindow: true, minWindowHours: 0, maxWindowHours: 36 }, NOW_W), 3);
check('an explicit slack is honoured', resolveWindowHours(NOW_W - 0.5 * 3_600_000, { adaptiveWindow: true, minWindowHours: 0, maxWindowHours: 36, windowMarginHours: 0.75 }, NOW_W), 1);

console.log('\n== only the home region interrupts him ==');
// He applies to internships in India. Every region is still collected,
// published and posted to its own Telegram channel; what is scoped is the Mac
// banner, the phone push and auto-opening the report. One run produced 86 new
// listings of which 76 were American, so leaving this unscoped would turn an
// "apply in the first hour" alert into mostly noise.
const home = cfg.notifications.homeRegion ?? 'IN';
check('home region is India', home, 'IN');

// The filter index.js applies, on rows shaped like the store's.
const rows = [
  { company: 'Zoho', location: 'Chennai, Tamil Nadu, India', region: 'IN' },
  { company: 'Stripe', location: 'San Francisco, CA', region: 'US' },
  { company: 'P&G', location: 'Mason, OH', region: 'US' },
  { company: 'Monzo', location: 'London', region: 'GB' },
  // No location text at all — this is the one case the stored column decides.
  { company: 'Acme', location: null, region: 'IN' },
];
const mine = rows.filter((r) => resolveRowRegion(r) === home);
check('two India rows alert', mine.length, 2);
check('and they are the right two', mine.map((r) => r.company), ['Zoho', 'Acme']);
check('three rows are published but silent', rows.length - mine.length, 3);

// Re-derived from the LOCATION, never trusted from the column — same rule
// publish follows, because a row captured before a gazetteer fix carries the
// old answer. A US row mislabelled IN in the column must not alert.
check('a stale IN column on a US location does not alert',
  resolveRowRegion({ location: 'Austin, TX', region: 'IN' }), 'US');
// And the fix from earlier this session holds on this path too.
check('Reading PA does not alert as a UK role',
  resolveRowRegion({ location: 'Reading, PA', region: null }), 'US');

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
