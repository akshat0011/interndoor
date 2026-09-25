/**
 * The scan view: the public-search walk drawn in the scraper's own window, and
 * saved per run, so it can be watched and checked card by card.
 *
 * Asked for on 25 Sep 2026: "I want to see the jobs being scraped and the card
 * pages being searched like we used to before ... don't hide anything from me."
 * What is pinned:
 *   - every card is shown, refused ones included, with what actually happened
 *     to it — read back from the store, never re-decided by the view;
 *   - nothing in it is a link: it is the scraper's own browser, and a click
 *     there mid-scan can file the wrong employer's posting (CLAUDE.md §7);
 *   - card text is escaped — it is a stranger's job title;
 *   - a view that fails never costs the walk.
 */
import { readFileSync } from 'node:fs';
import { outcomeFor, renderScanSection, renderScanDocument, showScanView } from '../src/scanview.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const RUN = '2026-09-25T09-00-00';

console.log('\n== what became of a card, in the order that decides it ==');
check('before the gates: pending', outcomeFor({ pending: true }).kind, 'pending');
check('a card this walk already read', outcomeFor({ repeat: true, firstRunId: RUN, runId: RUN }).kind, 'skip');
// Saved this run beats everything after it: the row exists AND its run is ours.
check('saved this run', outcomeFor({ firstRunId: RUN, runId: RUN, skipReason: 'x' }).kind, 'saved');
check('refused on its own text, with the gate\'s own words',
  outcomeFor({ skipReason: 'company not on watchlist', runId: RUN }), { kind: 'skip', text: 'company not on watchlist' });
check('opened, then refused — said as such',
  outcomeFor({ opened: true, skipReason: 'entry-level: asks 3+ years', runId: RUN }),
  { kind: 'refused', text: 'opened, then refused: entry-level: asks 3+ years' });
check('already on the board from an earlier run', outcomeFor({ firstRunId: 'older-run', runId: RUN }).kind, 'held');
check('opened and nothing recorded is a problem, not a quiet skip', outcomeFor({ opened: true, runId: RUN }).kind, 'refused');
check('never reached is said out loud', outcomeFor({ runId: RUN }).kind, 'unchecked');

console.log('\n== every card, escaped, and nothing clickable ==');
{
  const cards = [
    { jobId: '4470111950', title: '<script>alert(1)</script> Intern', company: 'Acme & Co.', location: 'Delhi, India', postedText: '1 hour ago', logoUrl: 'https://media.licdn.com/x.png' },
    { jobId: '4470132098', title: 'Software Engineer Intern', company: '', location: 'Bengaluru', postedText: '', logoUrl: 'javascript:alert(1)' },
  ];
  const outcomes = [outcomeFor({ skipReason: 'company not on watchlist' }), outcomeFor({ firstRunId: RUN, runId: RUN })];
  const url = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=intern&start=10';
  const html = renderScanSection({ region: 'IN', label: 'intern', pageNo: 2, url, windowHours: 2, cards, outcomes, done: true, totals: { cards: 20, opened: 3, saved: 1 } });
  check('both cards are on it', (html.match(/<tr>/g) || []).length, 2);
  check('the refused card says why', html.includes('company not on watchlist'), true);
  check('the saved card says so', html.includes('SAVED this run'), true);
  check('a title is escaped, never run', html.includes('<script>'), false);
  check('the escaped title is still shown', html.includes('&lt;script&gt;alert(1)&lt;/script&gt; Intern'), true);
  check('no links at all', /<a\b|href=/i.test(html), false);
  check('the exact request is shown as text', html.includes(url.replace(/&/g, '&amp;')), true);
  check('the job id is shown to copy', html.includes('4470132098'), true);
  check('a non-https logo is not loaded', html.includes('javascript:alert'), false);
  check('a card with no company says so', html.includes('no company on the card'), true);
  check('the page tally', html.includes('this page: 1 skip, 1 saved'), true);
  check('the run tally', html.includes('20 cards read · 3 opened · 1 saved'), true);
  const live = renderScanDocument('t', [html], { live: true });
  const saved = renderScanDocument('t', [html]);
  check('the live window warns against clicking in it', /Do not click or type in it/.test(live), true);
  check('the saved copy does not', /Do not click/.test(saved), false);
}

console.log('\n== the view never costs the walk ==');
{
  const calls = [];
  const page = { url: () => 'https://www.linkedin.com/jobs/view/1/', goto: async (u) => calls.push(`goto ${u}`), setContent: async () => calls.push('set') };
  check('drawn', await showScanView(page, '<p>x</p>'), true);
  // Not drawn inside a LinkedIn page, and no LinkedIn request made to draw it.
  check('onto a blank page first', calls, ['goto about:blank', 'set']);
  const broken = { url: () => 'about:blank', goto: async () => {}, setContent: async () => { throw new Error('page closed'); } };
  check('a failure is false, never a throw', await showScanView(broken, 'x'), false);
}

console.log('\n== the outcomes are the store\'s, not the view\'s ==');
{
  const s = new Store(':memory:');
  s.noteSkippedCard('card:acme|intern|delhi', 'company not on watchlist', 'Acme', 'Intern');
  s.db.prepare(`INSERT INTO jobs (job_id, title, company, first_seen_at, last_seen_at, first_run_id) VALUES ('77', 't', 'c', 1, 1, ?)`).run(RUN);
  check('a refusal made in this page', s.cardOutcome('card:acme|intern|delhi', null, 0).skipReason, 'company not on watchlist');
  // An old record must not pass for this walk's decision.
  check('a refusal older than the page is not this page\'s', s.cardOutcome('card:acme|intern|delhi', null, Date.now() + 60_000).skipReason, null);
  check('the run that stored a job', s.cardOutcome('card:x', '77', 0).firstRunId, RUN);
  check('nothing known is nothing', s.cardOutcome('card:nope', '99', 0), { skipReason: null, firstRunId: null });
}

console.log('\n== the wiring ==');
{
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const qs = readFileSync(new URL('../bin/queue-server.js', import.meta.url), 'utf8');
  check('on only for the public search, and only when config asks',
    /const showScan = viaGuest && cfg\.scanView === true;/.test(src), true);
  // With the view on, the window is opened at the walk's start so there is
  // something to watch; off, it stays lazy.
  check('the window opens at the walk\'s start when watching',
    /if \(viaGuest && !showScan\) \{[\s\S]{0,300}?\} else if \(!\(await sessionReady\(\)\)\) \{/.test(src), true);
  check('the page is drawn before its cards are judged',
    /await drawPage\(false\);[\s\S]{0,400}?for \(const card of cards\)/.test(src), true);
  check('and again, with outcomes, when it is done',
    /log\.info\(`Page \$\{pageIndex \+ 1\} done[^\n]*\n\s*await drawPage\(true\);/.test(src), true);
  check('outcomes are read back from the store',
    /store\.cardOutcome\(c\.identity, c\.jobId, pageStartedAt\)/.test(src), true);
  check('an open is remembered, so "opened, then refused" can be told apart',
    /log\.ok\(`Opening:[\s\S]{0,300}?openedThisWalk\.add\(card\.key\);/.test(src), true);
  check('every finished page is saved for the run',
    /await writeFile\(scanLogFile, doc, 'utf8'\);/.test(src) && /'latest\.html'/.test(src), true);
  check('served at /scan/<run> and /scan/latest',
    /path\.startsWith\('\/scan\/'\)[\s\S]{0,300}?join\(PATHS\.reports, 'scans', `\$\{id\}\.html`\)/.test(qs), true);
  check('behind the same id guard as the reports', /const id = decodeURIComponent\(path\.slice\('\/scan\/'\.length\)\) \|\| 'latest';\s*if \(!SAFE_ID\.test\(id\)\)/.test(qs), true);
  check('live config: watching is on', loadConfig().scanView, true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
