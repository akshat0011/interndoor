/**
 * The auto-sweep's circuit breaker.
 *
 * A failed reel is invisible to the daily cap — reelCountSince counts
 * rendering|scheduled|publishing|published and NOT failed — so a blocked
 * Instagram endpoint frees a cap slot, the 60-second sweep queues a
 * replacement, and that fails too. On 28-29 Aug that loop turned a cap of 20
 * into 36 failed US reels while the API answered "API access blocked". It has
 * been stopped by hand twice; reelFailuresSinceSuccess is what stops it on its
 * own.
 */
import { Store } from '../src/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'interndoor-breaker-'));
const store = new Store(join(dir, 'test.db'));
const DAY = 86_400_000;
const now = Date.now();
const since = now - DAY;

let seq = 0;
/** Write a reel_posts row directly — the helpers all go through the queue. */
function row({ region, status, started, finished = null, error = null }) {
  store.db.prepare(`
    INSERT INTO reel_posts (job_id, status, started_at, finished_at, error, region)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(`job-${++seq}`, status, started, finished, error, region);
}

const fails = (region) => store.reelFailuresSinceSuccess(region, since);

console.log('\n== a quiet region has nothing to answer for ==');
check('never posted at all', fails('US'), 0);

console.log('\n== real publish failures count ==');
// The publisher stamps finished_at whether the attempt worked or not, so a row
// that reached Instagram and was refused carries one.
row({ region: 'US', status: 'failed', started: now - 3000, finished: now - 2900, error: 'instagram rejected the request (400) API access blocked' });
check('one', fails('US'), 1);
row({ region: 'US', status: 'failed', started: now - 2000, finished: now - 1900, error: 'instagram rejected the request (400) API access blocked' });
row({ region: 'US', status: 'failed', started: now - 1000, finished: now - 900, error: 'instagram rejected the request (400) API access blocked' });
check('three — the default limit, breaker trips here', fails('US'), 3);

console.log('\n== and they are scoped to their own region ==');
// Two accounts, two apps, two separate restrictions. One board being blocked
// says nothing about the other, and pausing both would be the same mistake as
// posting one board's roles to the other's followers.
check('IN is untouched by US failures', fails('IN'), 0);

console.log('\n== A CANCELLATION IS NOT A FAILURE ==');
// Rows retired by hand — an employer dropped from the watchlist, a region
// switched off — are written as 'failed' with the reason ON PURPOSE, because
// reelKnownJobIds returns every row whatever its status and a kept row is what
// stops the sweep re-queueing that posting. They say nothing about Instagram
// and must not be able to shut a healthy account. The discriminator is
// finished_at: a row cancelled before it was ever attempted has none.
row({ region: 'IN', status: 'failed', started: now - 5000, finished: null, error: 'cancelled 31 Aug — not an engineering role' });
row({ region: 'IN', status: 'failed', started: now - 4000, finished: null, error: 'cancelled 31 Aug — not an engineering role' });
row({ region: 'IN', status: 'failed', started: now - 3000, finished: null, error: 'cancelled 31 Aug — not an engineering role' });
row({ region: 'IN', status: 'failed', started: now - 2000, finished: null, error: 'cancelled 31 Aug — not an engineering role' });
check('four cancellations do not trip anything', fails('IN'), 0);

console.log('\n== ONE SUCCESS CLEARS IT — there is nothing to reset by hand ==');
// Measured since the last successful publish rather than over a flat window,
// so proving the endpoint answers is the whole recovery procedure.
row({ region: 'US', status: 'published', started: now - 800, finished: now - 700 });
check('the slate is clean', fails('US'), 0);
row({ region: 'US', status: 'failed', started: now - 600, finished: now - 500, error: 'instagram rejected the request (400)' });
check('and it starts counting again from there', fails('US'), 1);

console.log('\n== a failure older than the window is not held against a region ==');
// Otherwise a board that failed a fortnight ago and has simply been quiet
// since would be shut for ever with no successful post available to clear it.
row({ region: 'GB', status: 'failed', started: now - 5 * DAY, finished: now - 5 * DAY, error: 'instagram rejected the request (400)' });
row({ region: 'GB', status: 'failed', started: now - 4 * DAY, finished: now - 4 * DAY, error: 'instagram rejected the request (400)' });
row({ region: 'GB', status: 'failed', started: now - 3 * DAY, finished: now - 3 * DAY, error: 'instagram rejected the request (400)' });
check('stale failures are out of scope', fails('GB'), 0);
check('but a fresh one still counts', (row({ region: 'GB', status: 'failed', started: now - 100, finished: now - 50, error: 'x' }), fails('GB')), 1);

console.log('\n== a row still in flight is not a failure ==');
// scheduled/rendering/publishing rows are the cap's business, not the
// breaker's — and a 'publishing' row may already be live on Instagram.
row({ region: 'CA', status: 'scheduled', started: now - 400 });
row({ region: 'CA', status: 'rendering', started: now - 300 });
row({ region: 'CA', status: 'publishing', started: now - 200 });
check('nothing in flight counts', fails('CA'), 0);
// Those three carry no finished_at, so the window alone would exclude them —
// which makes them a weak test of the status filter. This one is stamped, so
// only `status = 'failed'` can keep it out. A published row must not be
// counted as a failure just because it finished.
row({ region: 'CA', status: 'published', started: now - 150, finished: now - 100 });
check('and a finished SUCCESS is not a failure', fails('CA'), 0);
// That one is still weak on its own: a published row is its own MAX, so the
// since-last-success clause excludes it whatever its status. The case only
// `status = 'failed'` can catch is a finished non-failure in a region that has
// never published — MAX is then NULL, COALESCE makes it 0, and every stamped
// row is newer than 0. Constructed rather than observed: in the live table
// nothing but a failure carries finished_at without a later publish. It is
// pinned because the clause is the only thing standing between the breaker and
// counting successes as failures if that ever stops being true.
row({ region: 'AU', status: 'rendering', started: now - 300, finished: now - 200 });
check('a stamped non-failure, in a region with no publishes', fails('AU'), 0);

console.log('\n== the config carries the limit ==');
const cfg = JSON.parse(
  (await import('node:fs')).readFileSync(new URL('../config.json', import.meta.url), 'utf8'),
);
check('failureLimit is set', typeof cfg.reels.auto.failureLimit, 'number');
// Three, not one: a single failure is as likely to be a tunnel that did not
// come up as an account problem, and retrying that is correct.
check('and is above 1', cfg.reels.auto.failureLimit > 1, true);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
