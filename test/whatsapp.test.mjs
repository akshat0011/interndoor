import { composeWhatsApp, findTarget, MAX_MESSAGE } from '../src/whatsapp.js';
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
     /^Interndoor$/i — the exact reason CLAUDE.md gives for matching whole
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
  check('and the row budget is well past the measured 433ms', /CHANNEL_ROW_MS = 8_000/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
