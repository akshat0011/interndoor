import { composeWhatsApp, findTarget, MAX_MESSAGE, readPending, writePending, pendingKey, MAX_PENDING, awaitComposer, COMPOSER_MS, COMPOSER_POLL_MS } from '../src/whatsapp.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The two Store methods this uses, and nothing else. */
const fakeStore = (seed = {}) => ({
  data: { ...seed },
  getSetting(k) { return this.data[k]; },
  setSetting(k, v) { this.data[k] = v; },
});
import { composeJob, jobParts } from '../src/telegram.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const IN = regionOf('IN');
const job = (extra = {}) => ({
  id: '4458863278', company: 'Joveo', title: 'Software Engineer Intern',
  location: 'Bengaluru, Karnataka, India', workplaceType: 'Hybrid',
  applicants: '20 applicants', postedAt: Date.now() - 4 * 3600_000,
  applyUrl: 'https://www.linkedin.com/jobs/view/4458863278', ...extra,
});

console.log('\n== the two channels say the same thing ==');
{
  const p = jobParts(job(), IN);
  const w = composeWhatsApp(job(), IN);
  const t = composeJob(job(), IN);
  ok('both name the employer', w.includes(p.company) && t.includes(p.company));
  ok('both carry the job page', w.includes(p.page) && t.includes(p.page));
  for (const f of p.facts) ok(`whatsapp carries: ${f.slice(0, 22)}`, w.includes(f));
}

console.log('\n== but they are rendered for their own client ==');
{
  const w = composeWhatsApp(job(), IN);
  ok('no HTML anywhere', !/<b>|<a |&amp;|&lt;/.test(w));
  ok('bold is asterisks', w.includes('*Joveo*'));
  /* WhatsApp builds its preview card from the FIRST url. Leading with the
     employer's apply link would render LinkedIn's card on every post and throw
     away the per-posting OG image the site generates. */
  const first = w.match(/https?:\/\/\S+/)[0];
  ok('our job page is the first link', first.startsWith('https://interndoor.com/jobs/'));
  ok('the employer link still appears', w.includes('https://www.linkedin.com/jobs/view/4458863278'));
}

console.log('\n== a link is never cut in half ==');
{
  /* Real titles run to 172 characters — one employer names fifteen cities in
     one. Trimming has to drop whole FACTS, because slicing the string would
     cut a URL and WhatsApp renders the fragment as dead plain text. */
  /* THE TITLE CANNOT DO IT — jobParts already clamps it to 110 characters, so
     a fixture built on a long title never reaches the cap and the assertion
     passes while testing nothing. A mutation run is what said so. degreeText
     is passed through unclamped, so that is what overflows it. */
  const overflowing = job({
    degreeText: Array.from({ length: 120 }, (_, i) => `Qualification${i}`).join(' / '),
  });
  const untrimmed = [jobParts(overflowing, IN).facts.join('\n')].join('').length;
  ok('the fixture really is over the cap', untrimmed > MAX_MESSAGE);
  const huge = composeWhatsApp(overflowing, IN);
  ok('within the cap', huge.length <= MAX_MESSAGE);
  for (const url of huge.match(/https?:\/\/\S+/g) ?? []) {
    ok(`intact url: ${url.slice(8, 30)}`, /^https:\/\/(interndoor\.com|www\.linkedin\.com)\//.test(url));
  }
}

console.log('\n== the same link is never printed twice ==');
{
  /* With no employer URL, `apply` falls back to the job page. Printing it
     again under "Apply" reads as a mistake. */
  const w = composeWhatsApp(job({ applyUrl: '', url: '' }), IN);
  const page = jobParts(job({ applyUrl: '', url: '' }), IN).page;
  check('job page appears once', (w.match(new RegExp(page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1);
  ok('and no empty Apply line', !w.includes('👉 Apply:'));
}

console.log('\n== a zero applicant count is the strongest line, not "only 0" ==');
{
  const w = composeWhatsApp(job({ applicants: '0 applicants' }), IN);
  ok('says be the first', w.includes('No applicants yet'));
  ok('never says only 0', !/only 0/i.test(w));
}

console.log('\n== findTarget names WHICH stage failed ==');
/* It failed once on 2 Sep 2026 with `nothing called "Interndoor" in the
   channels list or the chats` — one sentence reachable from four different
   causes, because the channels branch fell through silently on all of them.
   The message named both surfaces while only one had been tried, and the one
   it blamed (the chat list) can never hold a channel anyway. */

/** Minimal Playwright-shaped page. `stub` decides what each locator finds. */
function fakePage(stub = {}) {
  const calls = [];
  const loc = (key) => {
    const spec = stub[key] ?? {};
    const self = {
      first: () => self,
      or: () => self,
      count: async () => (spec.present ? 1 : 0),
      click: async () => {
        calls.push(`click:${key}`);
        if (spec.clickThrows) throw new Error(spec.clickThrows);
      },
      waitFor: async () => {
        if (!spec.present) throw new Error(`Timeout waiting for ${key}`);
      },
      getAttribute: async () => spec.aria ?? '',
      getByTitle: () => loc(`${key}>title`),
    };
    return self;
  };
  return {
    _calls: calls,
    getByRole: (role, opts) => loc(`role:${String(opts?.name)}`),
    getByTitle: () => loc('title'),
    locator: (sel) => loc(`sel:${sel}`),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {}, type: async () => {} },
  };
}

// The composer is what proves which conversation is open.
const COMPOSER = 'sel:footer div[contenteditable="true"]';

{
  // Everything present and the composer names it — the happy path.
  const page = fakePage({
    'role:/^channels$/i': { present: true },
    title: { present: true },
    [COMPOSER]: { present: true, aria: 'Type a message to Interndoor' },
  });
  const r = await findTarget(page, 'Interndoor');
  check('finds the channel', [r.ok, r.how], [true, 'channel "Interndoor"']);
  check('and never touches the chat search', page._calls.some((c) => c.includes('chats')), false);
}
{
  /* THE ACTUAL 2 SEP FAILURE: the nav had not hydrated, so the Channels button
     read as absent and the code fell into a chat search that cannot hold a
     channel. The error must now say the nav was the problem. */
  const page = fakePage({ 'role:/^chats$/i': { present: true } });
  const r = await findTarget(page, 'Interndoor');
  check('reports the missing nav', /Channels button never appeared/.test(r.error), true);
  check('and says the chat list was tried too', /no chat called "Interndoor"/.test(r.error), true);
  check('rather than one sentence blaming both', r.error.includes(';'), true);
}
{
  // The nav is there, the row never paints.
  const page = fakePage({
    'role:/^channels$/i': { present: true },
    'role:/^chats$/i': { present: true },
  });
  const r = await findTarget(page, 'Interndoor');
  check('a missing row is distinguishable from a missing nav',
    [/no channel called "Interndoor" appeared/.test(r.error),
     /Channels button never appeared/.test(r.error)], [true, false]);
}
{
  // The channel opens but the composer names something else — the dangerous one.
  const page = fakePage({
    'role:/^channels$/i': { present: true },
    'role:/^chats$/i': { present: true },
    title: { present: true },
    [COMPOSER]: { present: true, aria: 'Type a message to Family' },
  });
  const r = await findTarget(page, 'Interndoor');
  /* NOT ok, and nothing is typed. The composer is the only element that both
     proves which conversation is open AND is the one the text goes into, so
     there is no gap between what was verified and what is used. */
  check('a composer naming another conversation does not post', r.ok, false);
  check('and says so', /the channel opened but the message box says "Type a message to Family"/.test(r.error), true);

  /* HONEST LIMIT: composerNames uses `includes`, so a composer reading
     "Type a message to Interndoor feedback" would pass this check. The guard
     that actually excludes it is the ROW title, matched as an anchored
     /^Interndoor$/i — the exact reason the project notes give for matching whole
     names. The composer is the second of two layers, not the only one. */
  const near = fakePage({
    'role:/^channels$/i': { present: true },
    'role:/^chats$/i': { present: true },
    title: { present: true },
    [COMPOSER]: { present: true, aria: 'Type a message to Interndoor feedback' },
  });
  check('a near-miss name passes the composer layer, so the row regex is the real guard',
    (await findTarget(near, 'Interndoor')).ok, true);
}
{
  const page = fakePage({
    'role:/^channels$/i': { present: true, clickThrows: 'detached' },
    'role:/^chats$/i': { present: true },
  });
  const r = await findTarget(page, 'Interndoor');
  check('a throw inside the channels branch is reported, not swallowed',
    /the channels list failed \(detached\)/.test(r.error), true);
  check('and the chat fallback still runs', /no chat called/.test(r.error), true);
}
{
  const r = await findTarget(fakePage(), '');
  check('an unconfigured target is refused outright', r.error, 'no target name configured');
}

console.log('\n== the waits are measured, not guessed ==');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/whatsapp.js', import.meta.url), 'utf8');
  /* Measured 2 Sep 2026 over three cold opens: session ready at 10.3/11.7/12.4s,
     the Channels button ~50ms after that, and the channel row 203/433/399ms
     after the click. So hydration is the slow part and the row is fast — the
     opposite of what the fixed 2500ms sleep assumed. */
  check('the nav is WAITED for, not sampled once',
    /channelsBtn\.waitFor\(\{ state: 'visible', timeout: CHANNELS_NAV_MS \}\)/.test(src), true);
  check('the row is waited for too', /row\.waitFor\(\{ state: 'visible', timeout: CHANNEL_ROW_MS \}\)/.test(src), true);
  check('the nav budget covers a loaded machine', /CHANNELS_NAV_MS = 20_000/.test(src), true);
  /* RAISED 8s -> 20s ON 5 Sep 2026. The 433ms measurement above was taken on a
     warm app; this send runs at the END of a scan, when the machine is loaded,
     and 4 of 11 recent failures were "no channel called Interndoor appeared
     within 8s". A generous wait costs nothing when the row is already there —
     it resolves the moment it appears — while a tight one loses the whole
     run's listings. Matched to the nav budget, which was already 20s for the
     same reason. */
  check('and the row budget survives a loaded machine', /CHANNEL_ROW_MS = 20_000/.test(src), true);
  check('the row is not given LESS than the nav it follows',
    /CHANNELS_NAV_MS = 20_000/.test(src) && /CHANNEL_ROW_MS = 20_000/.test(src), true);
}

console.log('\n== the backlog, so a failed send is not a lost listing ==');
/* 11 of 28 recent attempts failed — a locked profile, a channel row that never
   rendered, a composer that never appeared — and every one of them dropped that
   run's India listings for ever, because this function is handed one scan's new
   rows and nothing else. Telegram was given a retry after losing 100 listings
   in three days; this is the same fix one layer up. */
const st = fakeStore();
check('an empty backlog reads as empty', readPending(st, 'IN'), []);
writePending(st, 'IN', ['a', 'b', 'c']);
check('what is written comes back in order', readPending(st, 'IN'), ['a', 'b', 'c']);
check('and it is stored per region', Object.keys(st.data), [pendingKey('IN')]);
check('regions do not share a queue', readPending(st, 'US'), []);
check('duplicates collapse', (writePending(st, 'IN', ['a', 'a', 'b']), readPending(st, 'IN')), ['a', 'b']);
check('ids are strings, whatever went in',
  (writePending(st, 'IN', [1, 2]), readPending(st, 'IN')), ['1', '2']);
/* Bounded, or a channel that has been broken for a week tries to post a week's
   backlog the moment it recovers. */
writePending(st, 'IN', Array.from({ length: MAX_PENDING + 25 }, (_, i) => `j${i}`));
check(`the queue is capped at ${MAX_PENDING}`, readPending(st, 'IN').length, MAX_PENDING);
check('and it keeps the OLDEST, which are the ones at risk', readPending(st, 'IN')[0], 'j0');

console.log('\n== and none of it may throw into a scan ==');
/* A backlog that cannot be read or saved must never fail a run that has already
   collected and published — the same rule the whole WhatsApp path follows. */
check('a store that throws reads as empty',
  readPending({ getSetting() { throw new Error('locked'); } }, 'IN'), []);
check('a store that throws on write is survived',
  (() => { try { writePending({ setSetting() { throw new Error('locked'); } }, 'IN', ['a']); return 'ok'; } catch { return 'threw'; } })(), 'ok');
check('no store at all is fine', [readPending(null, 'IN'), (writePending(null, 'IN', ['a']), 'ok')], [[], 'ok']);
check('corrupt JSON reads as empty', readPending(fakeStore({ [pendingKey('IN')]: '{not json' }), 'IN'), []);

console.log('\n== the queue is actually consulted, and drains on a quiet run ==');
const wa = readFileSync(join(ROOT, 'src', 'whatsapp.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the backlog is read before this run\'s rows', /readPending\(store, code\)/.test(wa), true);
check('and what did not send is written back', /writePending\(store, code,/.test(wa), true);
check('saved in finally, so an early return still saves', /finally \{[\s\S]*writePending/.test(wa), true);
/* THE PAIRING THAT MATTERS: only a send PROVEN to have left the box may keep a
   listing off the queue. Counting an attempt would silently drop it again. */
check('only a proven send clears an id', /if \(r\.sent\) \{ sent \+= 1; posted\.add\(id\);/.test(wa), true);
const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('and it is called even when the run found nothing',
  /if \(!DRY_RUN\) await postNewJobsWhatsApp\(whatsappLive, cfg, \{ store \}\);/.test(idx), true);
check('no longer gated on live.length', /if \(live\.length\) await postNewJobsWhatsApp/.test(idx), false);

console.log('\n== the composer is WAITED for, not slept at ==');
/* THE LAST FIXED SLEEP IN findTarget, AND THE ONE STILL LOSING RUNS. The nav
   and the row were both converted from "sleep then sample once" to a real
   wait; the composer kept waitForTimeout(2500) followed by ONE composerNames
   read. Measured over every WhatsApp attempt in the log: 6 of 11 failures were
   "no composer on this screen" — that single sample landing before the pane had
   rendered — and ZERO failures were in the send. */
const composerPage = () => ({ waits: 0, async waitForTimeout() { this.waits += 1; } });

let calls = 0;
const readyOnThird = async () => (++calls >= 3 ? { ok: true } : { ok: false, error: 'no composer on this screen' });
const p1 = composerPage();
check('it keeps looking until the composer arrives',
  await awaitComposer(p1, 'Interndoor', { check: readyOnThird }), { ok: true });
check('and it slept between the reads', p1.waits, 2);

/* A warm app answers on the FIRST read — this is faster than the 2.5s sleep it
   replaces, not just more tolerant. */
const p2 = composerPage();
check('a ready composer costs no wait at all',
  [await awaitComposer(p2, 'Interndoor', { check: async () => ({ ok: true }) }), p2.waits],
  [{ ok: true }, 0]);

/* Two ways to be not-ready, and only one is "the element is missing": the
   composer can be present while still carrying the PREVIOUS conversation's
   aria-label. A plain visibility wait returns happily on that and then fails
   the name check, which is why both conditions are re-read. */
let names = 0;
const wrongThenRight = async () => (++names >= 2
  ? { ok: true }
  : { ok: false, error: 'the message box says "Vishal\'s Community" — not "Interndoor"' });
check('a stale conversation name is waited out too',
  await awaitComposer(composerPage(), 'Interndoor', { check: wrongThenRight }), { ok: true });

console.log('\n== and it gives up saying WHICH condition never came true ==');
/* findTarget records every stage precisely so a failure can be fixed
   afterwards; a generic "timed out" here would throw that away. */
let clock = 0;
const tick = () => { clock += 400; return clock; };
const never = async () => ({ ok: false, error: 'no composer on this screen' });
const out = await awaitComposer(composerPage(), 'Interndoor', { check: never, timeoutMs: 1000, now: tick });
check('it reports the last real failure, not a generic timeout',
  out.ok === false && out.error.startsWith('no composer on this screen'), true);
check('and says how long it waited', /waited 1s/.test(out.error), true);

/* THE DEADLINE IS TESTED AFTER THE READ, NOT BEFORE IT. Checked first, a
   budget of zero would sleep the whole budget and never take the reading the
   budget was for — the same shape as the sleep this replaces. */
let zeroCalls = 0;
await awaitComposer(composerPage(), 'Interndoor',
  { check: async () => { zeroCalls += 1; return { ok: false, error: 'x' }; }, timeoutMs: 0, now: () => 0 });
check('even a zero budget takes one reading', zeroCalls, 1);

console.log('\n== the fixed sleep is gone from findTarget ==');
const wsrc = readFileSync(join(ROOT, 'src', 'whatsapp.js'), 'utf8');
const wcode = wsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('no 2500ms sleep survives', /waitForTimeout\(2500\)/.test(wcode), false);
check('the channel branch awaits the composer', /const v = await awaitComposer\(page, wanted\)/.test(wcode), true);
check('all three stages now have a real budget',
  [/CHANNELS_NAV_MS = 20_000/, /CHANNEL_ROW_MS = 20_000/, /COMPOSER_MS = 20_000/].every((re) => re.test(wcode)), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
