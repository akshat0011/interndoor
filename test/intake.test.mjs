import {
  readIntakeHistory, appendIntakeRun, intakeWindow, intakeYield, intakeCollapsed, noteIntake,
  INTAKE_HISTORY_KEY, INTAKE_ALERT_KEY, INTAKE_ALERT_GAP_MS, WINDOW_RUNS, MIN_CARDS, MIN_YIELD, KEEP_RUNS,
} from '../src/intake.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

/** The two Store methods this uses, and nothing else. */
const fakeStore = (seed = {}) => ({
  data: { ...seed },
  getSetting(k) { return this.data[k]; },
  setSetting(k, v) { this.data[k] = v; },
});

/** A full window totalling `cards`/`newJobs`, spread over WINDOW_RUNS runs. */
const windowOf = (cards, newJobs, runs = WINDOW_RUNS) => ({ runs, cards, newJobs });

console.log('\n== the rolling history ==');
const st = fakeStore();
check('an empty history reads as empty', readIntakeHistory(st), []);
appendIntakeRun(st, { cards: 300, newJobs: 4 });
appendIntakeRun(st, { cards: 350, newJobs: 6 });
check('runs accumulate newest last', readIntakeHistory(st), [{ c: 300, n: 4 }, { c: 350, n: 6 }]);
check('it is stored under one key', Object.keys(st.data), [INTAKE_HISTORY_KEY]);
for (let i = 0; i < KEEP_RUNS + 5; i++) appendIntakeRun(st, { cards: 100 + i, newJobs: i });
check(`the history is capped at ${KEEP_RUNS}`, readIntakeHistory(st).length, KEEP_RUNS);
check('and it keeps the NEWEST, which is what the window reads',
  readIntakeHistory(st).at(-1), { c: 100 + KEEP_RUNS + 4, n: KEEP_RUNS + 4 });

console.log('\n== and none of it may throw into a scan ==');
check('corrupt JSON reads as empty', readIntakeHistory(fakeStore({ [INTAKE_HISTORY_KEY]: '{not json' })), []);
check('a non-array reads as empty', readIntakeHistory(fakeStore({ [INTAKE_HISTORY_KEY]: '{"a":1}' })), []);
check('junk entries are dropped', readIntakeHistory(fakeStore({ [INTAKE_HISTORY_KEY]: '[{"c":1,"n":2},null,{"c":"x"}]' })), [{ c: 1, n: 2 }]);
check('a store that throws reads as empty', readIntakeHistory({ getSetting() { throw new Error('locked'); } }), []);
check('a store that throws on write is survived',
  (() => { try { appendIntakeRun({ getSetting() { return null; }, setSetting() { throw new Error('locked'); } }, { cards: 1, newJobs: 1 }); return 'ok'; } catch { return 'threw'; } })(), 'ok');
check('no store at all is fine', [readIntakeHistory(null), appendIntakeRun(null, { cards: 5, newJobs: 1 })], [[], [{ c: 5, n: 1 }]]);

console.log('\n== the window sums the most recent runs only ==');
const hist = [{ c: 999, n: 99 }, ...Array.from({ length: WINDOW_RUNS }, () => ({ c: 100, n: 2 }))];
check('older runs are excluded', intakeWindow(hist), { runs: WINDOW_RUNS, cards: 100 * WINDOW_RUNS, newJobs: 2 * WINDOW_RUNS });
check('yield is new jobs per 100 cards', intakeYield({ cards: 2000, newJobs: 5 }), 0.25);
check('no cards yields null, never a divide by zero', intakeYield({ cards: 0, newJobs: 0 }), null);

console.log('\n== THE MEASURED 4 SEP OUTAGE MUST FIRE ==');
/* Real six-run windows off the runs table, IST. The parse bug ran 06:13-18:24
   and every one of these sat inside it. Cards were NOT low — 4 Sep read the
   most cards of any daytime block that week — which is the whole shape of the
   failure: the collector working harder than usual and keeping nothing. */
check('17:15 — 1995 cards, 1 new (0.05)', intakeCollapsed(windowOf(1995, 1)), true);
check('09:15 — 3205 cards, 5 new (0.16)', intakeCollapsed(windowOf(3205, 5)), true);
check('11:44 — 1738 cards, 4 new (0.23)', intakeCollapsed(windowOf(1738, 4)), true);

console.log('\n== AND THE MEASURED HEALTHY WINDOWS MUST NOT ==');
/* The lowest-yield healthy windows at >= MIN_CARDS across 11 days and 273
   windows. 0.495 is the floor, so MIN_YIELD 0.30 keeps 1.65x of headroom. */
check('31 Aug — 1616 cards, 8 new (0.50), the healthy floor', intakeCollapsed(windowOf(1616, 8)), false);
check('5 Sep — 3007 cards, 16 new (0.53)', intakeCollapsed(windowOf(3007, 16)), false);
check('2 Sep — 2294 cards, 13 new (0.57)', intakeCollapsed(windowOf(2294, 13)), false);

console.log('\n== A DROUGHT IS NOT AN OUTAGE, AND THIS IS THE CHECK THAT EARNS MIN_CARDS ==');
/* Six consecutive healthy windows on the morning of 30 Aug scored EXACTLY 0.0
   yield. §16 is right that on a weekend morning the expected intake is zero, so
   a yield-only rule would have fired on all six and been ignored within a week.
   What separates them is card volume: these carried 308-462, the outage carried
   1,672-3,205. */
check('30 Aug — 334 cards, 0 new: zero yield and NOT an outage', intakeCollapsed(windowOf(334, 0)), false);
check('30 Aug — 462 cards, 0 new', intakeCollapsed(windowOf(462, 0)), false);
check('but the same zero yield WITH a busy collector is', intakeCollapsed(windowOf(2000, 0)), true);
check('exactly at the card floor it is judged', intakeCollapsed(windowOf(MIN_CARDS, 0)), true);
check('one card under it is not', intakeCollapsed(windowOf(MIN_CARDS - 1, 0)), false);

console.log('\n== a partial window is never judged ==');
/* A fresh database, or the runs right after the history was cleared, would
   otherwise read one quiet run as a twelve-hour outage. */
check('fewer runs than the window', intakeCollapsed({ runs: WINDOW_RUNS - 1, cards: 5000, newJobs: 0 }), false);
check('a full window is', intakeCollapsed({ runs: WINDOW_RUNS, cards: 5000, newJobs: 0 }), true);

console.log('\n== noteIntake records only `ok` runs ==');
/* Same rule the sweep baselines follow (§4): a `partial` run is a degraded
   session that collected almost nothing, and letting it into the history would
   fire this for a reason it was not built to report. */
const okStore = fakeStore();
await noteIntake(okStore, { cards: 300, newJobs: 4, status: 'ok', send: async () => true });
check('an ok run is recorded', readIntakeHistory(okStore).length, 1);
for (const status of ['partial', 'aborted', 'error', 'interrupted']) {
  await noteIntake(okStore, { cards: 300, newJobs: 4, status, send: async () => true });
}
check('and nothing else is', readIntakeHistory(okStore).length, 1);

console.log('\n== it pushes once, not once per run ==');
const busted = fakeStore();
let pushes = 0;
const send = async () => { pushes += 1; return true; };
const feed = async (now) => noteIntake(busted, { cards: 2000, newJobs: 0, status: 'ok', now, send });
for (let i = 0; i < WINDOW_RUNS; i++) await feed(1_000_000);
check('the first full collapsed window pushes', pushes, 1);
await feed(1_000_000 + 60_000);
check('a run a minute later does not', pushes, 1);
await feed(1_000_000 + INTAKE_ALERT_GAP_MS + 1);
check('one past the gap does', pushes, 2);
check('the timestamp is remembered', typeof busted.data[INTAKE_ALERT_KEY], 'string');
/* A push that throws must not take down a scan that already published. */
const rude = fakeStore();
for (let i = 0; i < WINDOW_RUNS - 1; i++) await noteIntake(rude, { cards: 2000, newJobs: 0, status: 'ok', send: async () => true });
const survived = await noteIntake(rude, { cards: 2000, newJobs: 0, status: 'ok', send: async () => { throw new Error('ntfy down'); } })
  .then((r) => r.collapsed && r.alerted === false).catch(() => 'threw');
check('a failing push is survived and reported as un-alerted', survived, true);

console.log('\n== and the scan actually calls it ==');
const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('noteIntake is called', /await noteIntake\(store, \{/.test(idx), true);
/* THE PAIRING: the real counters, not zeroes or a placeholder. Passing the
   wrong two numbers would leave every check above green and the tripwire dead. */
check('with the run\'s own cards and new-job counts',
  /noteIntake\(store, \{ cards: counters\.cardsSeen, newJobs: counters\.newJobs, status \}\)/.test(idx), true);
check('after finishRun, so it sees the filed status',
  idx.indexOf('noteIntake(store') > idx.indexOf('store.finishRun(runId'), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
