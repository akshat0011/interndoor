/**
 * Which LinkedIn job search are we on, and did it move?
 *
 * LinkedIn is retiring classic job search (banner observed 2 Sep 2026) and
 * moves accounts between the two layouts unannounced. `src/linkedin.js` is
 * built to survive that — cards are found by recency TEXT, the description
 * block has a candidate list covering both, Next falls back to a button label.
 * What was missing is knowing which one we are on, so a flip that quietly
 * degrades extraction cannot masquerade as a quiet week.
 */
import {
  classifyVariant, variantSummary, variantChanged, noteVariant, probeVariant, VARIANT_KEY, TELLS,
} from '../src/searchvariant.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

/* Taken from the live page on 2 Sep 2026: the address bar read
   linkedin.com/jobs/search/?currentJobId=4462112862&f_TPR=r39600&geoId=103644278
   with a real pagination bar, /jobs/view/ anchors, AND the retirement banner
   offering AI search. */
const CLASSIC = {
  path: '/jobs/search/',
  aboutIds: 0, emberPayloads: 8,
  jobViewLinks: 9, dataJobIds: 25, listContainers: 1, paginationBar: 1,
  description: '#job-details',
  retirementNotice: true, aiSearchOffered: true,
};
/* The redesign, as described by the August work: no container classes, cards
   are nested divs, the description block is named after the posting. */
const AI = {
  path: '/jobs/search-results/',
  aboutIds: 1, emberPayloads: 3,
  jobViewLinks: 1, dataJobIds: 0, listContainers: 0, paginationBar: 0,
  description: '[id^="JobDetails_AboutTheJob_"]',
  retirementNotice: false, aiSearchOffered: true,
};

console.log('\n== THE CLASSIC PAGE ADVERTISES THE AI ONE, AND MUST NOT BE MISREAD AS IT ==');
{
  /* This is the whole reason the classifier is structural. The retirement
     banner and a "Try AI job search" button put that phrase on the page several
     times over — so counting mentions of AI search reports "ai" for a page that
     is emphatically classic. The earlier note that the 28 Aug capture showed
     "60 AI-search markers" is very probably exactly this mistake. */
  check('a classic page offering AI search is still classic', classifyVariant(CLASSIC), 'classic');
  check('and it does say so', [CLASSIC.retirementNotice, CLASSIC.aiSearchOffered], [true, true]);
  // The text tells are recorded for the log and must never decide.
  const noText = { ...CLASSIC, retirementNotice: false, aiSearchOffered: false };
  check('stripping the text tells changes nothing', classifyVariant(noText), 'classic');
  const allText = { ...AI, retirementNotice: true, aiSearchOffered: true };
  check('nor does adding them to an AI page', classifyVariant(allText), 'ai');
}

console.log('\n== EMBER IS NOT A TELL, AND THIS IS THE LIVE PAGE THAT PROVED IT ==');
{
  /* Captured 2 Sep 2026 at 12:08 IST, verbatim from the first run that carried
     the probe. It classified "ai" on `ember 8` alone while every other signal
     said classic — including the decisive one, that the CLASSIC description
     selector is the one that answered, which can only happen when the
     redesign's JobDetails_AboutTheJob_ block is absent.

     code[id^="bpr-guid-"] is Ember's batched page response, and Ember is
     LinkedIn's framework for BOTH surfaces. Adding it back breaks this. */
  check('the real live page is classic', classifyVariant(CLASSIC), 'classic');
  check('even carrying 8 Ember payloads', CLASSIC.emberPayloads, 8);
  check('because the classic description selector answered', CLASSIC.description, '#job-details');
  check('and the redesign block was absent', CLASSIC.aboutIds, 0);
  /* Ember alone must decide nothing, in either direction. */
  check('Ember alone is not enough to call it AI',
    classifyVariant({ path: '/jobs/search/', emberPayloads: 40 }), 'unknown');
  check('and its absence does not make a redesign page classic',
    classifyVariant({ path: '/jobs/search/', aboutIds: 1, emberPayloads: 0 }), 'ai');
}

console.log('\n== structural tells decide, and an AI tell is decisive ==');
{
  check('the redesign', classifyVariant(AI), 'ai');
  check('its URL alone is enough', classifyVariant({ path: '/jobs/search-results/' }), 'ai');
  check('so is a JobDetails_AboutTheJob_ id', classifyVariant({ path: '/x', aboutIds: 1 }), 'ai');
  check('an Ember payload is NOT a tell', classifyVariant({ path: '/x', emberPayloads: 2 }), 'unknown');
  /* An AI tell outranks the classic ones because a /jobs/view/ anchor can be
     rendered by the detail pane on either surface, while nothing classic emits
     an AboutTheJob id. */
  check('an AI tell beats classic tells on the same page',
    classifyVariant({ path: '/jobs/search/', aboutIds: 1, jobViewLinks: 20, paginationBar: 1 }), 'ai');
  check('TELLS records ember as diagnostic, not as evidence',
    [TELLS.ai.includes('emberPayloads'), TELLS.diagnostic.includes('emberPayloads')], [false, true]);
  check('a pagination bar alone reads classic',
    classifyVariant({ path: '/jobs/search/', paginationBar: 1 }), 'classic');
  check('jobs/view anchors alone read classic',
    classifyVariant({ path: '/jobs/search/', jobViewLinks: 20 }), 'classic');
}

console.log('\n== a page that did not render is UNKNOWN, never a guess ==');
{
  /* A failed render has none of the tells. Calling that "the other variant"
     would report a flip on every slow page load. */
  check('nothing rendered', classifyVariant({ path: '/jobs/search/' }), 'unknown');
  check('no fingerprint at all', classifyVariant(null), 'unknown');
  check('a non-object', classifyVariant('classic'), 'unknown');
  check('an empty object', classifyVariant({}), 'unknown');
}

console.log('\n== a change is a CHANGE OF CLASSIFICATION, not of counts ==');
{
  /* Counts move on every page — 23 cards then 24, a pagination bar that renders
     on page 1 and not on the last. Diffing fingerprints would alert every run,
     and an alert that fires every run is one nobody reads. */
  check('classic -> ai is a flip', variantChanged('classic', 'ai'), true);
  check('ai -> classic is a flip too', variantChanged('ai', 'classic'), true);
  check('same classification is not', variantChanged('classic', 'classic'), false);
  check('a first sighting is not a flip', variantChanged(null, 'ai'), false);
  check('and a failed render is never a flip', variantChanged('classic', 'unknown'), false);
}

console.log('\n== noteVariant records and reports ==');
function store(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getSetting: (k) => (m.has(k) ? m.get(k) : null), setSetting: (k, v) => m.set(k, String(v)), _m: m };
}
{
  const s = store();
  const first = noteVariant(s, 'IN', CLASSIC);
  check('first sighting is recorded, not alerted', [first.variant, first.changed], ['classic', false]);
  check('and stored', s.getSetting(VARIANT_KEY('IN')), 'classic');

  check('a second identical run is quiet', noteVariant(s, 'IN', CLASSIC).changed, false);

  const flip = noteVariant(s, 'IN', AI);
  check('the flip is reported once', [flip.previous, flip.variant, flip.changed], ['classic', 'ai', true]);
  check('and the baseline moves', s.getSetting(VARIANT_KEY('IN')), 'ai');
  check('so it cannot fire twice for the same move', noteVariant(s, 'IN', AI).changed, false);
}
{
  /* UNKNOWN IS NEVER STORED. One failed render would otherwise overwrite a good
     baseline, and the next healthy run would report a flip back — two false
     alerts out of one bad page load. */
  const s = store({ [VARIANT_KEY('IN')]: 'classic' });
  const bad = noteVariant(s, 'IN', {});
  check('a failed render is not a flip', bad.changed, false);
  check('and does not overwrite the baseline', s.getSetting(VARIANT_KEY('IN')), 'classic');
  check('so the next healthy run is still quiet', noteVariant(s, 'IN', CLASSIC).changed, false);
}
{
  // Regions are keyed apart, so two boards on different surfaces cannot flap.
  const s = store();
  noteVariant(s, 'IN', CLASSIC);
  check('US has its own baseline', noteVariant(s, 'US', AI).changed, false);
  check('and India keeps its own', s.getSetting(VARIANT_KEY('IN')), 'classic');
  check('separately from the US one', s.getSetting(VARIANT_KEY('US')), 'ai');
}
{
  // A diagnostic must never be able to end a sweep.
  const broken = { getSetting() { throw new Error('db gone'); }, setSetting() { throw new Error('db gone'); } };
  check('a broken store is survivable', noteVariant(broken, 'IN', CLASSIC).changed, false);
}

console.log('\n== the summary line names what was found ==');
{
  const line = variantSummary(CLASSIC);
  check('leads with the verdict', line.startsWith('classic — '), true);
  check('names the description selector that answered', line.includes('desc #job-details'), true);
  check('and flags the retirement notice', line.includes('retirement notice'), true);
  check('the AI line names its own selector',
    variantSummary(AI).includes('desc [id^="JobDetails_AboutTheJob_"]'), true);
  check('an empty fingerprint still renders', variantSummary({}).startsWith('unknown — '), true);
}

console.log('\n== the probe is self-contained, because it is serialised into the page ==');
{
  /* Playwright stringifies it, so it may close over nothing — the same
     constraint scanCardsInPage and hasRecencyMarker are under. */
  /* Proved by RUNNING it the way readVariant does — rebuilt from its own source
     in a bare scope, with no module bindings reachable. A regex over the source
     cannot show this: `toString()` includes comments, so the first version of
     this assertion matched the word TELLS inside one and reported a captured
     identifier that does not exist. */
  const rebuilt = new Function(`return (${probeVariant.toString()})`)();

  const fakeDom = (selCounts, text, path) => {
    globalThis.document = {
      querySelectorAll: (sel) => ({ length: selCounts[sel] ?? 0 }),
      body: { innerText: text },
    };
    globalThis.location = { pathname: path };
  };
  fakeDom({
    '[id^="JobDetails_AboutTheJob_"]': 0,
    'code[id^="bpr-guid-"]': 8,
    'a[href*="/jobs/view/"]': 9,
    '[data-job-id], [data-occludable-job-id]': 25,
    '.jobs-search-results-list, .scaffold-layout__list, .jobs-search__results-list': 1,
    '.artdeco-pagination, .jobs-search-pagination': 1,
  }, "We're gradually retiring classic job search starting in September. Try AI job search", '/jobs/search/');

  const fp = rebuilt();
  check('it runs with no module scope at all', typeof fp, 'object');
  check('and counts the real classic page correctly',
    [fp.jobViewLinks, fp.paginationBar, fp.aboutIds, fp.emberPayloads], [9, 1, 0, 8]);
  check('reads the path', fp.path, '/jobs/search/');
  check('spots the retirement banner', fp.retirementNotice, true);
  check('and the AI offer', fp.aiSearchOffered, true);
  /* Which is exactly the page that must NOT classify as AI. */
  check('yet the live classic page still classifies classic', classifyVariant(fp), 'classic');
  /* The description selector is filled in by the CALLER, so DESCRIPTION_SELECTORS
     stays the one place that order is written down. */
  check('the probe leaves description to the caller', fp.description, null);

  // A page whose selectors throw must not take the probe down with it.
  globalThis.document = { querySelectorAll: () => { throw new Error('detached'); }, body: null };
  const safe = rebuilt();
  check('a hostile document degrades to zeroes', [safe.aboutIds, safe.jobViewLinks], [0, 0]);
  check('and classifies unknown rather than guessing', classifyVariant(safe), 'unknown');
  delete globalThis.document; delete globalThis.location;
}

console.log('\n== src/index.js runs it once per search and pushes on a flip ==');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const lk = readFileSync(new URL('../src/linkedin.js', import.meta.url), 'utf8');
  check('linkedin.js exposes the reader', /export async function readVariant\(page\)/.test(lk), true);
  check('which fills description from DESCRIPTION_SELECTORS',
    /selectors: DESCRIPTION_SELECTORS/.test(lk), true);
  /* SLICED to readVariant's own body. Two earlier versions of this were
     vacuous: a bare /\.catch\(\(\) => null\)/ matched other functions in the
     file, and anchoring it with a lazy [\s\S]*? still ran past the end of this
     function to the next one's catch. A diagnostic that can throw would end a
     sweep, so this has to be tested for real. */
  const body = lk.slice(lk.indexOf('export async function readVariant')).split('\nexport ')[0];
  check('readVariant is actually present', body.length > 100, true);
  check('and never throws', /\.catch\(\(\) => null\);/.test(body), true);
  check('the description resolve is guarded too', /try \{ return !!document\.querySelector\(sel\); \} catch/.test(body), true);

  check('imported', /import \{ noteVariant, variantSummary \} from '\.\/searchvariant\.js'/.test(src), true);
  /* ONCE PER SEARCH, on its first page — not once per page. */
  check('probed on the first page only',
    /if \(pageIndex === firstPage\) \{[\s\S]{0,200}?await li\.readVariant\(page\)/.test(src), true);
  check('and reported every run, not only on a change',
    /log\.info\(`Search surface: \$\{variantSummary/.test(src), true);
  check('a flip warns and is collected',
    /if \(seen\.changed\) \{[\s\S]{0,400}?variantFlips\.push/.test(src), true);
  check('and pushes to the phone at priority 4, below an expired session',
    /variantFlips\.length[\s\S]{0,600}?pushToPhone\([\s\S]{0,300}?priority: 4/.test(src), true);

  /* THE EVIDENCE IS KEPT. This is the only run that will ever see the moment of
     the change, and the move has been one-way before, so the alternative is
     writing the new selectors blind. HTML for the selectors, PNG for a human. */
  const flip = src.slice(src.indexOf('if (seen.changed) {'));
  check('the changed page is saved as HTML', /page\.content\(\)/.test(flip.slice(0, 1400)), true);
  check('and as a screenshot', /page\.screenshot\(\{ path:/.test(flip.slice(0, 1400)), true);
  check('into the state directory, not the public repo',
    /PATHS\.screenshots/.test(flip.slice(0, 1400)), true);
  /* Losing the evidence must not cost the sweep that found it. */
  check('and a failure there is caught',
    /catch \(err\) \{[\s\S]{0,140}?Could not save the changed page/.test(flip.slice(0, 1600)), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
