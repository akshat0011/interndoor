// A rate limit on the signed-in walk is waited out and asked again until
// LinkedIn answers or he presses stop (his rule, 14 Oct 2026). A restricted
// account still ends the run. These run ensureHealthy against a fake page.
import { readFileSync } from 'node:fs';
import { ensureHealthy, sleepUnlessStopped, isHardLimit, RunAborted, State, RATE_LIMIT_RETRY_MS } from '../src/guard.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const cfg = { safety: {}, notifications: { onError: false } };

/** A page whose text after each goto comes from `script`. */
function fakePage(texts, startUrl = 'https://www.linkedin.com/jobs/search/?x=1') {
  const state = { url: startUrl, text: texts.shift(), gotos: [] };
  return {
    state,
    url: () => state.url,
    evaluate: async (fn) => (String(fn).includes('iframe') ? null : { text: state.text, signedIn: true }),
    goto: async (url) => { state.gotos.push(url); state.url = url; state.text = texts.length ? texts.shift() : ''; },
    screenshot: async () => {},
  };
}

async function outcome(p) {
  try { await p; return 'returned'; } catch (err) { return err; }
}

// 1. waits, asks again, returns once LinkedIn answers
{
  const page = fakePage(['Too many requests', 'Too many requests', 'Job results here']);
  const waits = []; let loads = 0;
  const r = await outcome(ensureHealthy(page, cfg, {
    context: 'search page 2',
    persist: { retryUrl: 'https://www.linkedin.com/jobs/search/?x=2', waitMs: 5, onWait: (w) => waits.push(w), onLoad: () => loads++, shouldStop: () => false },
  }));
  ok(r === 'returned', 'a rate limit that lifts lets the walk carry on');
  ok(waits.length === 2, 'one wait per refusal');
  ok(page.state.gotos.length === 2 && page.state.gotos.every((u) => u.endsWith('x=2')), 'asks again at the URL it was given, not the error page');
  ok(loads === 2, 'each retry counts as an account load');
  ok(waits[1].attempt === 2, 'attempts are numbered');
}

// 2. never gives up while LinkedIn keeps refusing (stops only on the button)
{
  const page = fakePage(Array(200).fill('Too many requests'));
  let n = 0;
  const r = await outcome(ensureHealthy(page, cfg, {
    context: 'card x',
    persist: { waitMs: 1, onWait: () => {}, shouldStop: () => ++n > 300 },
  }));
  ok(r instanceof RunAborted && r.state === State.STOPPED, 'only the stop button ends it');
  ok(page.state.gotos.length >= 100, 'kept asking again (no attempt cap)');
}

// 3. a restricted account is not waited out
{
  const page = fakePage(['Your account has been restricted']);
  let waited = false;
  const r = await outcome(ensureHealthy(page, cfg, {
    persist: { waitMs: 1, onWait: () => { waited = true; }, shouldStop: () => false },
  }));
  ok(r instanceof RunAborted && r.state === State.RATE_LIMITED, 'restriction still ends the run');
  ok(!waited && page.state.gotos.length === 0, 'restriction is not retried');
}

// 4. no persist = the old behaviour, and the evidence travels on the error
{
  const page = fakePage(['Too many requests']);
  const r = await outcome(ensureHealthy(page, cfg, {}));
  ok(r instanceof RunAborted && r.state === State.RATE_LIMITED, 'without persist a rate limit still throws');
  ok(/too many requests/.test(String(r.evidence)), 'the error carries what matched');
}

// 5. the error page URL is waited out too
{
  const page = fakePage(['', 'Job results'], 'https://www.linkedin.com/error/429');
  const r = await outcome(ensureHealthy(page, cfg, {
    persist: { retryUrl: 'https://www.linkedin.com/jobs/view/123/', waitMs: 1, shouldStop: () => false },
  }));
  ok(r === 'returned' && page.state.gotos[0] === 'https://www.linkedin.com/jobs/view/123/', '/error/429 is retried at the real URL');
}

// 6. sleepUnlessStopped / isHardLimit
{
  ok(await sleepUnlessStopped(5, () => false, 1) === false, 'sleeps out the time');
  ok(await sleepUnlessStopped(60_000, () => true) === true, 'returns at once on stop');
  ok(isHardLimit('text matched /your account (?:has been )?(?:restricted|temporarily restricted)/i'), 'restriction is a hard limit');
  ok(!isHardLimit('text matched /too many requests/i'), 'too many requests is not');
  ok(RATE_LIMIT_RETRY_MS === 120_000, 'asked again every 2 minutes, never longer');
}

// 7. index.js hands persist to every signed-in check and never ends a walk on a 429
{
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  ok(/context: `search "\$\{label\}" page \$\{pageIndex \+ 1\}`, remainingMs: clock\.remainingMs\(\), persist: ratePersist\(url\)/.test(src), 'search page check persists');
  ok(/context: `job \$\{jobId\}`, remainingMs: clock\.remainingMs\(\), persist: ratePersist\(li\.jobUrl\(jobId\)\)/.test(src), 'posting open check persists');
  ok((src.match(/context: `card \$\{card\.key\}`, remainingMs: clock\.remainingMs\(\), persist: ratePersist\(/g) ?? []).length === 2, 'both card checks persist');
  ok(/if \(!nav\.blocked && !nav\.networkError\) break;/.test(src), 'a 429 on the search page is asked again, not the end of the walk');
  ok(/sleepUnlessStopped\(RATE_LIMIT_RETRY_MS, stopNow\)/.test(src), 'that wait honours the stop button');
  ok(/err\.state === State\.STOPPED \? 'partial'/.test(src), 'a stop during a wait is a partial run, not an abort');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
