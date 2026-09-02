/**
 * Which boards may be posted to LinkedIn.
 *
 * He posts from his own personal account, which is Indian, and there is no US
 * LinkedIn account — so a US weekly roundup, a US post draft and a US "Add to
 * post queue" button were all producing copy nobody could publish. One
 * Microsoft draft was sitting in the queue when this shipped.
 */
import { postRegions, postableRegion, postableJobs } from '../src/postregions.js';
import { buildReport } from '../src/report.js';
import { loadConfig } from '../src/config.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const cfg = loadConfig();

console.log('\n== the live config posts to India only ==');
{
  /* Read off config.json, not a fixture — a fixture would go on passing after
     someone put US back, which is the regression this file exists to prevent. */
  check('postQueue.regions', postRegions(cfg), ['IN']);
  check('India is postable', postableRegion(cfg, 'IN'), true);
  check('the US is NOT', postableRegion(cfg, 'US'), false);
  check('nor the UK', postableRegion(cfg, 'GB'), false);
  check('and the weekly roundup runs for India alone', cfg.postQueue.weekly.regions, ['IN']);
}

console.log('\n== absent means India, not everything ==');
{
  /* The failure this exists to stop is work done for a channel that is not
     there, so the safe default is the account we know exists. */
  check('no config at all', postRegions({}), ['IN']);
  check('an empty list is not "all"', postRegions({ postQueue: { regions: [] } }), ['IN']);
  check('a non-list is ignored', postRegions({ postQueue: { regions: 'US' } }), ['IN']);
  check('an explicit list is honoured', postRegions({ postQueue: { regions: ['IN', 'GB'] } }), ['IN', 'GB']);
}

console.log('\n== filtering rows ==');
{
  const rows = [{ region: 'IN' }, { region: 'US' }, { __reportRegion: 'US' }, { region: 'GB' }, {}];
  /* A row with no region is KEPT: everything predating regions is Indian, and
     dropping it would silently empty the queue for older postings. */
  check('keeps India and the region-less', postableJobs(cfg, rows), [{ region: 'IN' }, {}]);
  check('an empty list is fine', postableJobs(cfg, []), []);
  check('and a missing one', postableJobs(cfg), []);
}

console.log('\n== THE REPORT HIDES THE BUTTON, BUT KEEPS THE REEL ==');
{
  /* Instagram HAS a live US account (@interndoorusa), so this must never be
     reused to gate reels — that is reels.auto.regions and it says something
     different. */
  const mk = (r) => ({ job_id: 'j' + r, company: 'X', title: 'Intern', job_url: 'https://x', __reportRegion: r, skills: [] });
  const html = buildReport({ jobs: [mk('IN'), mk('US')], run: { runId: 'r' }, stats: {}, cfg });
  check('exactly one post-queue button for two cards', (html.match(/class="qbtn"/g) || []).length, 1);
  check('and it belongs to the India card', /data-id="jIN"[^>]*aria-pressed/.test(html), true);
  check('BOTH cards keep the reel button', (html.match(/class="rbtn"/g) || []).length, 2);

  // With every board postable, both cards get one — proves the gate is the cause.
  const open = buildReport({
    jobs: [mk('IN'), mk('US')], run: { runId: 'r' }, stats: {},
    cfg: { ...cfg, postQueue: { ...cfg.postQueue, regions: ['IN', 'US'] } },
  });
  check('control: allowing US gives two buttons', (open.match(/class="qbtn"/g) || []).length, 2);
}

console.log('\n== the endpoint refuses it too ==');
{
  /* The report is cached HTML and an old tab left open still carries the old
     buttons, so hiding the button is not the whole guard. */
  const server = readFileSync(new URL('../bin/queue-server.js', import.meta.url), 'utf8');
  check('the queue endpoint checks the region',
    /if \(body\.action !== 'remove'\)[\s\S]{0,320}?postableRegion\(cfg, row\.region\)/.test(server), true);
  /* Removal must always work: a row queued before the rule changed has to be
     gettable out. */
  check('but removal is always allowed', /if \(body\.action !== 'remove'\) \{/.test(server), true);
  check('and it says why', /not posted to LinkedIn — there is no account for that board/.test(server), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
