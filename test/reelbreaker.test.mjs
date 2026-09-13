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
import { Store, isNetworkFailure, NETWORK_FAILURE_WINDOW_MS } from '../src/store.js';
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

console.log('\n== A FAILURE THAT NEVER REACHED INSTAGRAM ==');
// Found 13 Sep 2026: a dropped wifi tripped the breaker exactly as a revoked
// app would, and — because a tripped breaker queues nothing, so no success can
// arrive — held US shut for its full 24-hour window. Every failed row in the
// table was surveyed: 13 network failures, all in bursts of three, so it had
// happened FIVE times. The strings below are VERBATIM from reel_posts.
{
  const dnsToday = 'ig_publish exited 1:   File "/Users/akshatsaroha/.local/share/uv/python/cpython-3.13.15-macos-aarch64-none/lib/python3.13/urllib/request.py", line 1321, in do_open     raise URLError(err) urllib.error.URLError: <urlopen error [Errno 8] nodename nor servname provided, or not known>';
  /* A different Python on 7 Sep. Matching the path instead of the errno text
     would catch one outage and miss the other. */
  const dns7Sep = 'ig_publish exited 1:   File "/opt/homebrew/Cellar/python@3.12/3.12.13_4/Frameworks/Python.framework/Versions/3.12/lib/python3.12/urllib/request.py", line 1347, in do_open     raise URLError(err) urllib.error.URLError: <urlopen error [Errno 8] nodename nor servname provided, or not known>';
  const tunnel = 'ig_publish exited 1: tunnel attempt 3/4 did not come up, retrying in 15s could not open a public tunnel after several attempts   fix: check your network, or host the file on R2/S3 instead';
  /* INSTAGRAM ANSWERED both of these — and the second even shows our tunnel
     serving the video with a 200 first. Misfiling either as network is the
     direction that loses an account. */
  const blocked = 'API access blocked.';
  const igError = 'ig_publish exited 1: 127.0.0.1 - - [04/Sep/2026 03:50:51] "GET /4462811461.mp4 HTTP/1.1" 200 - instagram error detail: Something went wrong. Please retry creating a new container later. {"ok": false, "error": "instagram could not process the video (status ERROR)"}';
  const pathMoved = 'ig_publish exited 2: error: Project directory `/Users/akshatsaroha/Desktop/projects/storygasted` does not exist';

  check('DNS failure, today (uv 3.13)', isNetworkFailure(dnsToday), true);
  check('DNS failure, 7 Sep (Homebrew 3.12)', isNetworkFailure(dns7Sep), true);
  check('the tunnel that serves the video would not open', isNetworkFailure(tunnel), true);
  check('the same DNS failure as Linux words it', isNetworkFailure('getaddrinfo: Name or service not known'), true);
  check('and as glibc words it', isNetworkFailure('Temporary failure in name resolution'), true);
  check('network unreachable', isNetworkFailure('[Errno 51] Network is unreachable'), true);

  check('API access blocked is INSTAGRAM, not network', isNetworkFailure(blocked), false);
  check('Instagram replying "status ERROR" is INSTAGRAM', isNetworkFailure(igError), false);
  check('a local config fault is not network', isNetworkFailure(pathMoved), false);
  /* Deliberately absent: a read timeout after connecting can be Instagram
     throttling us, which is exactly the case the breaker must still catch. */
  check('a bare timeout is NOT treated as network', isNetworkFailure('The read operation timed out'), false);
  check('null is not network', isNetworkFailure(null), false);
  check('undefined is not network', isNetworkFailure(undefined), false);

  const MIN = 60_000;
  const at = (region, ago, error) =>
    row({ region, status: 'failed', started: now - ago - 1000, finished: now - ago, error });
  const failsAt = (region) => store.reelFailuresSinceSuccess(region, now - DAY, { now });

  console.log('\n   -- a network failure still trips the breaker while it is recent --');
  // THE HALF THAT PREVENTS A RENDER STORM. Every refill is rendered before its
  // publish fails; uncounted, a three-hour outage renders a reel a minute.
  at('NZ', 3 * MIN, dnsToday); at('NZ', 2 * MIN, dnsToday); at('NZ', 1 * MIN, dnsToday);
  check('three in three minutes trips it', failsAt('NZ'), 3);

  console.log('\n   -- and ages out after the short window, instead of a day --');
  at('SG', 45 * MIN, dnsToday); at('SG', 44 * MIN, dnsToday); at('SG', 43 * MIN, dnsToday);
  check('three DNS failures 43-45 minutes ago no longer count', failsAt('SG'), 0);

  console.log('\n   -- AN INSTAGRAM REFUSAL KEEPS ITS FULL 24 HOURS --');
  // The guarantee that makes this change safe. Same ages as the SG rows above,
  // the only difference is who refused.
  at('JP', 45 * MIN, blocked); at('JP', 44 * MIN, blocked); at('JP', 43 * MIN, blocked);
  check('three API blocks 43-45 minutes ago still trip it', failsAt('JP'), 3);
  at('KR', 20 * 60 * MIN, igError); at('KR', 19 * 60 * MIN, igError); at('KR', 18 * 60 * MIN, igError);
  check('three Instagram errors 18-20 HOURS ago still trip it', failsAt('KR'), 3);

  console.log('\n   -- mixed: only the stale network ones drop --');
  at('DE', 50 * MIN, dnsToday); at('DE', 49 * MIN, tunnel);
  at('DE', 48 * MIN, blocked); at('DE', 47 * MIN, igError);
  check('two stale network + two Instagram = 2', failsAt('DE'), 2);

  console.log('\n   -- the edge of the window --');
  at('FR', NETWORK_FAILURE_WINDOW_MS, dnsToday);
  check('exactly on the edge still counts', failsAt('FR'), 1);
  at('IT', NETWORK_FAILURE_WINDOW_MS + 1, dnsToday);
  check('one millisecond past it does not', failsAt('IT'), 0);
  check('the window is thirty minutes', NETWORK_FAILURE_WINDOW_MS, 30 * MIN);

  console.log('\n   -- 13 SEP, REPLAYED --');
  // The three US rows, 07:52-07:54 IST, against the moment the breaker tripped
  // and the moment the network had been back for a while.
  const t0752 = Date.UTC(2026, 8, 13, 2, 22), t0753 = t0752 + MIN, t0754 = t0752 + 2 * MIN;
  for (const t of [t0752, t0753, t0754]) {
    store.db.prepare(`INSERT INTO reel_posts (job_id, status, started_at, finished_at, error, region)
      VALUES (?, 'failed', ?, ?, ?, 'MX')`).run(`job-${++seq}`, t - 1000, t, dnsToday);
  }
  const replay = (hh, mm) => {
    const when = Date.UTC(2026, 8, 13, hh - 5, mm - 30);
    return store.reelFailuresSinceSuccess('MX', when - DAY, { now: when });
  };
  check('07:55 IST — tripped, and rightly: the network is down', replay(7, 55), 3);
  check('08:55 IST — reopened, an hour after the network came back', replay(8, 55), 0);
  check('under the old rule it would still be shut the next morning', (() => {
    const when = Date.UTC(2026, 8, 13, 8 - 5, 55 - 30);
    return store.db.prepare(`SELECT COUNT(*) n FROM reel_posts WHERE region='MX' AND status='failed' AND finished_at >= ?`).get(when - DAY).n;
  })(), 3);
}

console.log('\n== the sweep passes its clock through ==');
{
  const qs = (await import('node:fs')).readFileSync(new URL('../bin/queue-server.js', import.meta.url), 'utf8');
  /* Without `now` the short window is measured from a different clock than the
     sweep's own, and a replay test passes while production drifts. */
  check('reelFailuresSinceSuccess is called with { now }',
    /reelFailuresSinceSuccess\(region, now - 86_400_000, \{ now \}\)/.test(qs), true);
  /* The warning must stop promising a success will clear it. */
  check('the warning no longer claims a success clears it',
    /it clears itself on the next success/.test(qs), false);
}

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
