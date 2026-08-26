/**
 * Waiting for the results to actually be on screen before scanning them.
 *
 * gotoSearch used to race three waiters and take whichever fired first. Two of
 * the three are not evidence that the LIST has painted: none of the named
 * containers exists on the redesigned page, and the one /jobs/view/ link that
 * does render belongs to the DETAIL PANE, which paints before the list. Only a
 * recency marker is card text.
 *
 * So the /jobs/view/ link kept winning, and scanCardsInPage — which finds cards
 * BY that marker — read a half-painted list as zero cards. Zero cards on page 1
 * is what assertListRendered treats as a markup break, so the run aborted and
 * screenshotted a perfectly healthy page. Six runs died this way between 13 and
 * 26 Aug 2026, one of them 35 minutes after a run that read 421 cards on the
 * very same selectors.
 */
import { gotoSearch, hasRecencyMarker } from '../src/linkedin.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const cfg = { pacing: { afterNavigation: [0, 0], warmupOnFeed: [0, 0] } };

/**
 * A page whose waiters resolve on a script rather than on a real browser.
 *
 * Each of `marker` / `viewLink` / `container` is 'now', 'late' or 'never'.
 * `seen` records which waiters gotoSearch actually consulted, in order — which
 * is the whole point: a fix that merely reorders a Promise.race would still
 * consult all three, and would still take the wrong one.
 */
function stubPage(script) {
  const seen = [];
  const timeouts = {};
  const waiter = (kind, timeout) => {
    seen.push(kind);
    timeouts[kind] = timeout;
    if (script[kind] === 'now') return Promise.resolve(true);
    if (script[kind] === 'late') return new Promise((r) => setTimeout(() => r(true), 25));
    return new Promise((_, rej) => setTimeout(() => rej(new Error(`${kind} timed out`)), 60));
  };
  return {
    seen,
    timeouts,
    goto: async () => ({ status: () => script.status ?? 200 }),
    waitForSelector: (sel, opts = {}) =>
      waiter(sel.includes('jobs/view') ? 'viewLink' : 'container', opts.timeout),
    waitForFunction: (_fn, _arg, opts = {}) => waiter('marker', opts.timeout),
  };
}

console.log('\n== the marker predicate ==');
// Serialised into the page by waitForFunction, so it must reference nothing
// outside itself and must survive a body that is not there yet.
const withBody = (text, fn) => {
  globalThis.document = { body: text === null ? undefined : { innerText: text } };
  try { return fn(); } finally { delete globalThis.document; }
};
check('a relative age counts', withBody('Software Intern 2 hours ago', hasRecencyMarker), true);
check('so does "Be an early applicant"', withBody('Be an early applicant', hasRecencyMarker), true);
check('and "Actively reviewing applicants"', withBody('Actively reviewing applicants', hasRecencyMarker), true);
// The exact text the 26 Aug screenshot shows: card titles painted, metadata
// row still a skeleton placeholder. This is the state that must NOT pass.
check('a half-painted card does NOT',
  withBody('Machine Learning Intern Zenithbyte India (Remote)', hasRecencyMarker), false);
check('a missing body does not throw', withBody(null, hasRecencyMarker), false);
check('it captures nothing from module scope',
  /\b(MARK|LIST_CONTAINERS|log|cfg)\b/.test(hasRecencyMarker.toString()), false);

console.log('\n== the marker is waited for BEFORE the unreliable waiters ==');
// The regression, exactly: the detail pane's link is up, the list is not.
const racy = stubPage({ marker: 'late', viewLink: 'now', container: 'now' });
check('it proceeds', await gotoSearch(racy, 'https://x', cfg), true);
check('the marker was consulted first', racy.seen[0], 'marker');
check('and nothing else was consulted at all', racy.seen, ['marker']);
check('the first wait is the 12s marker budget', racy.timeouts.marker, 12_000);

// A healthy page: the marker is there straight away and the race never starts.
const healthy = stubPage({ marker: 'now', viewLink: 'now', container: 'now' });
check('a painted page proceeds', await gotoSearch(healthy, 'https://x', cfg), true);
check('and still consults only the marker', healthy.seen, ['marker']);

console.log('\n== the race is kept as the fallback ==');
// An empty result set, or the tail page where the only card is stamped
// "Viewed", genuinely never gets a marker. Those still have to proceed, or
// pagination would stop dead at the end of every sweep.
const tail = stubPage({ marker: 'never', viewLink: 'now', container: 'never' });
check('no marker still proceeds on the link', await gotoSearch(tail, 'https://x', cfg), true);
check('the marker was tried first, then the race', tail.seen[0], 'marker');
check('and the race did run', tail.seen.slice(1).sort(), ['container', 'marker', 'viewLink']);

const viaContainer = stubPage({ marker: 'never', viewLink: 'never', container: 'now' });
check('a real container also proceeds', await gotoSearch(viaContainer, 'https://x', cfg), true);

console.log('\n== nothing appears at all ==');
const dead = stubPage({ marker: 'never', viewLink: 'never', container: 'never' });
check('gives up rather than scanning a blank page', await gotoSearch(dead, 'https://x', cfg), false);

console.log('\n== the rate-limit path is untouched ==');
for (const status of [429, 999]) {
  const blocked = stubPage({ marker: 'now', viewLink: 'now', container: 'now', status });
  const outcome = {};
  check(`HTTP ${status} stops`, await gotoSearch(blocked, 'https://x', cfg, outcome), false);
  check(`HTTP ${status} sets outcome.blocked`, outcome.blocked, true);
  // Never walk back into a rate limit, and never spend waiters on it either.
  check(`HTTP ${status} waits for nothing`, blocked.seen, []);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
