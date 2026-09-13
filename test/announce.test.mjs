/**
 * Careers-board (ATS) postings reach Telegram and WhatsApp — src/announce.js and
 * its wiring in src/index.js.
 *
 * Before 13 Sep 2026 no ATS posting had ever been announced: the channels were
 * handed `store.jobsForRun(runId)`, and bin/poll-ats.js tags its rows
 * `ats-<day>`, never a scan's run id. The two ways a fix goes wrong are the ones
 * pinned here — a new board's whole backlog announced in one burst, and a role
 * announced a second time because its LinkedIn copy already was.
 */
import { readFileSync } from 'node:fs';
import { atsToAnnounce, ANNOUNCE_MAX_AGE_MS, TWIN_WINDOW_MS } from '../src/announce.js';
import { Store } from '../src/store.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 13, 14, 0);
const ats = (id, over = {}) => ({ job_id: `ats:workday:kaleris:${id}`, company: 'Kaleris', title: `Role ${id}`,
  posted_at: NOW - DAY, first_seen_at: NOW - 60_000, ...over });
const ids = (rows) => rows.map((r) => r.job_id);

console.log('\n== A NEW POSTING IS ANNOUNCED, A NEW BOARD\'S BACKLOG IS NOT ==');
{
  check('the rule is three days', ANNOUNCE_MAX_AGE_MS, 3 * DAY);
  check('a posting from yesterday is announced', ids(atsToAnnounce([ats(1)], [], { now: NOW })), ['ats:workday:kaleris:1']);
  check('one posted just inside three days is announced',
    ids(atsToAnnounce([ats(2, { posted_at: NOW - 3 * DAY + 1000 })], [], { now: NOW })).length, 1);
  /* 13 Sep: 52 boards seeded, 130 of 145 US rows already weeks old. */
  check('one posted a month ago, first seen today, is NOT',
    atsToAnnounce([ats(3, { posted_at: NOW - 30 * DAY })], [], { now: NOW }), []);
  check('one with no posted date is not guessed at', atsToAnnounce([ats(4, { posted_at: null })], [], { now: NOW }), []);
}

console.log('\n== A ROLE ALREADY ANNOUNCED FROM LINKEDIN IS NOT ANNOUNCED AGAIN ==');
{
  const row = ats(5, { title: 'Associate Software Engineer - Intern' });
  const scraped = (over) => [{ company: 'Kaleris', company_matched: null, title: 'Associate Software Engineer - Intern',
    first_seen_at: NOW - DAY, ...over }];
  check('a LinkedIn copy stored earlier suppresses it', atsToAnnounce([row], scraped(), { now: NOW }), []);
  check('matched regardless of case and punctuation',
    atsToAnnounce([row], scraped({ title: 'associate software engineer intern' }), { now: NOW }), []);
  check('matched on the watchlist name when LinkedIn spells the employer differently',
    atsToAnnounce([row], scraped({ company: 'Kaleris Software Pvt Ltd', company_matched: 'Kaleris' }), { now: NOW }), []);
  /* When the ATS row came FIRST, it wins the publish dedupe and the LinkedIn
     copy is never announced — so the ATS row is the only announcement. */
  check('a LinkedIn copy stored LATER does not suppress it',
    ids(atsToAnnounce([row], scraped({ first_seen_at: NOW }), { now: NOW })).length, 1);
  check('a LinkedIn copy from long before the window is a different posting',
    ids(atsToAnnounce([row], scraped({ first_seen_at: row.first_seen_at - TWIN_WINDOW_MS - 1 }), { now: NOW })).length, 1);
  check('a different title at the same employer does not suppress it',
    ids(atsToAnnounce([row], scraped({ title: 'Associate Cloud Ops Engineer - Intern' }), { now: NOW })).length, 1);
}

console.log('\n== THE STORE READS ==');
{
  const s = new Store(':memory:');
  const put = (jobId, firstSeen) => s.db.prepare(
    `INSERT INTO jobs (job_id, title, company, first_seen_at, last_seen_at, first_run_id, posted_at)
     VALUES (?, 't', 'Kaleris', ?, ?, 'r', ?)`,
  ).run(jobId, firstSeen, firstSeen, firstSeen);
  put('ats:a:1', 1000); put('ats:a:2', 2000); put('ats:a:3', 3000); put('4455', 2500);
  check('ATS rows in (from, until] — the lower bound is exclusive so no row is announced twice',
    ids(s.atsJobsFirstSeenBetween(1000, 2500)), ['ats:a:2']);
  check('the upper bound is inclusive', ids(s.atsJobsFirstSeenBetween(2500, 3000)), ['ats:a:3']);
  check('a LinkedIn row is never an ATS row', ids(s.atsJobsFirstSeenBetween(0, 9999)).includes('4455'), false);
  check('scraped titles hold LinkedIn rows only', s.scrapedTitlesSince(0).length, 1);
  s.close?.();
}

console.log('\n== WIRED INTO THE SCAN ==');
{
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  check('ATS rows are added to the scan\'s own new rows', /const toAnnounce = \[\.\.\.newJobs, \.\.\.atsNew\];/.test(idx), true);
  check('the "has a page" filter runs over that combined set',
    /const live = toAnnounce\.filter\(\(j\) => publishedIds\.has\(String\(j\.job_id\)\)\);/.test(idx), true);
  check('the channel block no longer waits for the scan itself to find something',
    /if \(!DRY_RUN && toAnnounce\.length && publishedIds\)/.test(idx), true);
  /* Moved before publish succeeded, a failed publish would skip those rows for
     good; moved without a publish check, the same. */
  check('the watermark moves only after a successful publish, and after the posts',
    /await postNewJobsWhatsApp\(whatsappLive, cfg, \{ store \}\);\n  if \(!DRY_RUN && publishedIds\) store\.setSetting\(ANNOUNCE_KEY, String\(announceUntil\)\);/.test(idx), true);
  check('the window ends where the selection was taken, not at a later clock read',
    /atsJobsFirstSeenBetween\(announceFrom, announceUntil\)/.test(idx), true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
