/**
 * The session-expiry alert.
 *
 * On 2 Sep 2026 the LinkedIn session expired at 04:35 IST and ELEVEN
 * consecutive runs aborted with `Session expired` until 09:35 — five hours of
 * zero collection on every board — and nothing reached him. guard.js fires a
 * Mac banner and an alarm for it, and the Mac was asleep.
 *
 * Two things are pinned here and they pull against each other: the alert has to
 * ARRIVE (on the phone, breaking through silent), and it has to arrive ONCE.
 * Eleven identical pushes for one outage is how an alert stops being read.
 */
import { alertOnSessionLoss, SESSION_ALERT_KEY, SESSION_ALERT_GAP_MS } from '../src/sessionalert.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

/** A store with just the two methods the alert uses. */
function fakeStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getSetting: (k) => (map.has(k) ? map.get(k) : null),
    setSetting: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}
/** A push that records its calls and reports success. */
function fakePush(ok = true) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return ok; };
  fn.calls = calls;
  return fn;
}

const T0 = 1_780_000_000_000;

console.log('\n== an expired session pushes to the phone ==');
{
  const store = fakeStore();
  const push = fakePush();
  const r = await alertOnSessionLoss(store, {
    sessionExpired: true, push, now: () => T0,
  });
  check('it sends', r, 'sent');
  check('exactly one push', push.calls.length, 1);
  const [title, body, opts] = push.calls[0];
  check('the title names the site and the fault', title, 'InternDoor: LinkedIn session expired');
  check('the body says what to run', /npm run login/.test(body), true);
  /* PRIORITY 5 IS THE POINT. ntfy breaks a 5 through a silent phone, and this
     is the one alert that warrants it — every board has stopped collecting. */
  check('priority 5, so it breaks through a silent phone', opts.priority, 5);
  check('and it is marked as an alarm', opts.tags, ['rotating_light']);
  check('the marker is written', Number(store.getSetting(SESSION_ALERT_KEY)), T0);
}

console.log('\n== ELEVEN ABORTS MUST NOT BE ELEVEN PUSHES ==');
{
  /* The exact shape of the 2 Sep outage: a run every 30 minutes, all aborting
     on the same expired session, over five hours. */
  const store = fakeStore();
  const push = fakePush();
  let sent = 0;
  for (let i = 0; i < 11; i++) {
    const at = T0 + i * 30 * 60_000;
    const r = await alertOnSessionLoss(store, { sessionExpired: true, push, now: () => at });
    if (r === 'sent') sent++;
  }
  check('eleven aborts over five hours', sent, 1);
  check('one push, not eleven', push.calls.length, 1);
}

console.log('\n== the gap is SIX HOURS, and that is a decision ==');
{
  /* Asserted absolutely, not relative to the constant — every other test here
     uses SESSION_ALERT_GAP_MS to build its timestamps, so widening it to a week
     passed all of them. Six hours is the compromise: silent through a
     night-time outage, not silent for a whole day. Changing it should have to
     break this. */
  check('six hours', SESSION_ALERT_GAP_MS, 6 * 60 * 60 * 1000);
  check('which is more than the 30-minute tick that causes the repeats',
    SESSION_ALERT_GAP_MS > 30 * 60 * 1000, true);
  check('and less than a day, so a stuck session is chased up',
    SESSION_ALERT_GAP_MS < 24 * 60 * 60 * 1000, true);
}

console.log('\n== but a LONG outage nudges again ==');
{
  /* A single push six hours ago may have been missed. The gap is a compromise:
     silent through a night-time outage, not silent for ever. */
  const store = fakeStore();
  const push = fakePush();
  await alertOnSessionLoss(store, { sessionExpired: true, push, now: () => T0 });
  const justUnder = await alertOnSessionLoss(store, {
    sessionExpired: true, push, now: () => T0 + SESSION_ALERT_GAP_MS - 60_000,
  });
  check('still throttled just inside the window', justUnder, 'throttled');
  const justOver = await alertOnSessionLoss(store, {
    sessionExpired: true, push, now: () => T0 + SESSION_ALERT_GAP_MS + 1000,
  });
  check('and pushes again just outside it', justOver, 'sent');
  check('two pushes in total', push.calls.length, 2);
}

console.log('\n== A HEALTHY RUN RE-ARMS IT ==');
{
  /* Without this the marker would sit there and the NEXT outage — hours or days
     later — would be swallowed by a stale six-hour window. */
  const store = fakeStore();
  const push = fakePush();
  await alertOnSessionLoss(store, { sessionExpired: true, push, now: () => T0 });
  check('recovery clears the marker',
    await alertOnSessionLoss(store, { healthy: true, push, now: () => T0 + 60_000 }), 'rearmed');
  check('the marker is empty', store.getSetting(SESSION_ALERT_KEY), '');
  // A new outage one minute later must alert, not be throttled.
  check('the next outage alerts immediately',
    await alertOnSessionLoss(store, { sessionExpired: true, push, now: () => T0 + 120_000 }), 'sent');
  check('so two pushes', push.calls.length, 2);
}
{
  // A healthy run with nothing to clear must not log or write anything.
  const store = fakeStore();
  const r = await alertOnSessionLoss(store, { healthy: true, push: fakePush(), now: () => T0 });
  check('a healthy run with no outage is a no-op', r, 'skipped');
  check('and writes no marker', store._map.size, 0);
}

console.log('\n== it fires ONLY for an expired session ==');
{
  /* A rate limit and a CAPTCHA are different faults with different remedies —
     a cooldown and a human at the keyboard — and each has its own handling.
     This alert says "run npm run login", which would be wrong advice for both. */
  const store = fakeStore();
  const push = fakePush();
  check('a rate-limited abort does not push',
    await alertOnSessionLoss(store, { sessionExpired: false, push, now: () => T0 }), 'skipped');
  check('nor does a plain error', push.calls.length, 0);
}

console.log('\n== notifications.onError still switches it off ==');
{
  const store = fakeStore();
  const push = fakePush();
  check('disabled', await alertOnSessionLoss(store, {
    sessionExpired: true, enabled: false, push, now: () => T0,
  }), 'skipped');
  check('no push', push.calls.length, 0);
  check('and no marker, so enabling it later still alerts', store._map.size, 0);
}

console.log('\n== it can never break a run ==');
{
  /* The alert runs immediately after finishRun. A throw here would propagate
     out of a run that had already recorded itself correctly. */
  const exploding = {
    getSetting() { throw new Error('db is gone'); },
    setSetting() { throw new Error('db is gone'); },
  };
  check('a broken store is survivable',
    await alertOnSessionLoss(exploding, { sessionExpired: true, push: fakePush(), now: () => T0 }),
    'skipped');

  const store = fakeStore();
  const thrower = async () => { throw new Error('ntfy unreachable'); };
  check('a failing push is survivable',
    await alertOnSessionLoss(store, { sessionExpired: true, push: thrower, now: () => T0 }),
    'skipped');

  // A push that reports failure is NOT an exception — it still counts as the
  // attempt for this outage, or a dead ntfy would retry every 30 minutes.
  const store2 = fakeStore();
  const failing = fakePush(false);
  check('a push that returns false still marks the attempt',
    await alertOnSessionLoss(store2, { sessionExpired: true, push: failing, now: () => T0 }), 'sent');
  check('and is therefore throttled next tick',
    await alertOnSessionLoss(store2, { sessionExpired: true, push: failing, now: () => T0 + 60_000 }),
    'throttled');
}

console.log('\n== src/index.js actually calls it, on the right signal ==');
{
  /* The module is only useful if it is wired in. index.js executes on import,
     so this reads the source rather than importing it. */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  check('imported', /import \{ alertOnSessionLoss \} from '\.\/sessionalert\.js'/.test(src), true);
  check('called', /await alertOnSessionLoss\(store, \{/.test(src), true);
  check('healthy covers ok and partial',
    /healthy: status === 'ok' \|\| status === 'partial'/.test(src), true);
  check('and it keys on the LOGGED_OUT state',
    /sessionExpired: abortState === State\.LOGGED_OUT/.test(src), true);
  // abortState has to actually be captured, or sessionExpired is always false.
  check('the abort state is captured in the catch', /abortState = err\.state;/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
