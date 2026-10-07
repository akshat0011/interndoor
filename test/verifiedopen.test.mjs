/**
 * The 7 Oct 2026 quality pass: what may sit on the board, and what may be
 * indexed.
 *
 *  - a posting that STATES 2+ years of experience, or is not a job at all
 *    (a talent community), leaves the live set (publish);
 *  - a job page is indexable only with EVIDENCE it is still open (verifiedOpen):
 *    a careers-board row, a positive check of its application route within a
 *    week, or first seen within three days — an unknown is never "open";
 *  - postings whose Apply is LinkedIn's own are checked on LinkedIn's public
 *    posting page (sweepLinkedinPostings), timidly: the first 429 stops it;
 *  - a check stamps link_ok_at only when it came back positive.
 *
 * Every case is a real shape from the audit: EXL "4–6 years", Mu Sigma "5–7
 * years", AlphaSense "Join … Talent Community", a 404 and a "No longer
 * accepting applications" page.
 */
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asksExperience, notAJob, verifiedOpen, checkedAt, jobPageIndexable, writePages, renderJobPage,
  CHECK_MAX_AGE_MS, LISTED_FRESH_MS, DEFAULT_REGION,
} from '../src/pages.js';
import { checkPosting, sweepLinkedinPostings, linkedinPostingsToCheck, POSTING_MIN_AGE_MS } from '../src/linksweep.js';
import { parsePublicPosting } from '../src/guestsearch.js';
import { Store } from '../src/store.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const D = 86_400_000;
const NOW = Date.now();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n== a posting that states 2+ years is not entry-level ==');
ok('EXL "4–6 years"', asksExperience({ experience: '4–6 years' }));
ok('Mu Sigma "5–7 years"', asksExperience({ experience: '5–7 years' }));
ok('"2+ years"', asksExperience({ experience: '2+ years' }));
ok('a graduation year then 3 years', asksExperience({ experience: 'Graduating 2027 · 3+ years' }));
ok('"0–1 years" stays', !asksExperience({ experience: '0–1 years' }));
ok('"1–3 years" stays (the minimum is what is asked)', !asksExperience({ experience: '1–3 years' }));
ok('a graduation year alone stays', !asksExperience({ experience: 'Graduating 2027' }));
ok('nothing stated stays — an unknown is never refused', !asksExperience({ experience: null }) && !asksExperience({}));

console.log('\n== a talent community is not a job ==');
ok('AlphaSense "Join AlphaSense India Talent Community"', notAJob({ title: 'Join AlphaSense India Talent Community' }));
ok('a talent pool', notAJob({ title: 'Engineering Talent Pool 2027' }));
ok('a general application', notAJob({ title: 'General Application - Software' }));
ok('a real role is a job', !notAJob({ title: 'Software Engineer Intern' }));
ok('"Talent Acquisition Intern" is a job (not this rule\'s business)', !notAJob({ title: 'Talent Acquisition Intern' }));

console.log('\n== publish holds both back, and says so ==');
{
  const pub = read('src/publish.js');
  ok('the experience filter is in the live chain', /\.filter\(\(\{ row \}\) => \{\s*if \(!asksExperience\(row\)\) return true;/.test(pub));
  ok('the not-a-job filter is in the live chain', /\.filter\(\(\{ row \}\) => \{\s*if \(!notAJob\(row\)\) return true;/.test(pub));
  ok('both run BEFORE dedupe (so a held-back row cannot win a dedupe)',
    pub.indexOf('asksExperience(row)') < pub.indexOf('dedupePostings(jobs, supersededPairs)') && pub.indexOf('notAJob(row)') < pub.indexOf('dedupePostings(jobs, supersededPairs)'));
  ok('every published row carries `verified`', /\.map\(\(j\) => \(\{ \.\.\.j, verified: verifiedOpen\(j\) \}\)\)/.test(pub));
  ok('the projection carries the positive check', /row\.link_ok_at \? \{ checkedAt: row\.link_ok_at, checkedVia:/.test(pub));
}

console.log('\n== evidence it is still open ==');
const li = (over = {}) => ({ id: '4446731184', company: 'EXL', title: 'AI Data Engineer', firstSeenAt: NOW - 10 * D, bullets: ['a', 'b'], ...over });
ok('a careers-board row is open while it is live', verifiedOpen(li({ id: 'ats:greenhouse:x:1' }), NOW));
ok('a positive check this week', verifiedOpen(li({ checkedAt: NOW - 2 * D }), NOW));
ok('a positive check eight days ago is not evidence', !verifiedOpen(li({ checkedAt: NOW - CHECK_MAX_AGE_MS - D }), NOW));
ok('first seen two days ago is', verifiedOpen(li({ firstSeenAt: NOW - 2 * D }), NOW));
ok('first seen four days ago with no check is NOT — unknown is never open', !verifiedOpen(li({ firstSeenAt: NOW - LISTED_FRESH_MS - D }), NOW));
ok('a careers-board row ignores checkedAt (its board is the evidence)', checkedAt({ id: 'ats:x', checkedAt: NOW }, NOW) === null);
ok('no firstSeenAt and no check is not open', !verifiedOpen({ id: '1' }, NOW));

console.log('\n== indexable only with that evidence ==');
ok('verified + two bullets is indexable', jobPageIndexable(li({ verified: true })));
ok('verified:false is not', !jobPageIndexable(li({ verified: false })));
ok('the quality bar still applies', !jobPageIndexable(li({ verified: true, bullets: ['only one'] })));

console.log('\n== the page, the sitemap and the queue agree ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'verified-'));
  try {
    const base = { location: 'Bengaluru, Karnataka, India', applyUrl: 'https://careers.example.com/1', summary: 'Backend work.', skills: ['python'], postedAt: NOW - 5 * D };
    const open = { ...base, id: '1001', company: 'Kepler Systems', title: 'Software Engineer', firstSeenAt: NOW - 5 * D, bullets: ['Build it.', 'Test it.'], verified: true, checkedAt: NOW - D, checkedVia: 'link' };
    const unknown = { ...base, id: '1002', company: 'Kepler Systems', title: 'Data Engineer', firstSeenAt: NOW - 9 * D, bullets: ['Load it.', 'Watch it.'], verified: false };
    const res = writePages([open, unknown], dir, [], { region: DEFAULT_REGION });
    const sm = readFileSync(join(dir, 'sitemap.xml'), 'utf8');
    ok('the verified page is in the sitemap', sm.includes('/jobs/kepler-systems-software-engineer-1001'));
    ok('the unverified page is NOT', !sm.includes('/jobs/kepler-systems-data-engineer-1002'));
    ok('the unverified page is still written for readers', existsSync(join(dir, 'jobs', 'kepler-systems-data-engineer-1002.html')));
    const u = readFileSync(join(dir, 'jobs', 'kepler-systems-data-engineer-1002.html'), 'utf8');
    ok('…and it is noindex', /name="robots" content="noindex/.test(u));
    ok('the Indexing API is offered only the verified page',
      res.indexUrls.some((x) => x.endsWith('-1001')) && !res.indexUrls.some((x) => x.endsWith('-1002')));
    const v = readFileSync(join(dir, 'jobs', 'kepler-systems-software-engineer-1001.html'), 'utf8');
    ok('the verified page says what was checked, and when', /The application page answered when we checked it/.test(v) && /<time datetime="\d{4}-\d{2}-\d{2}">/.test(v));
    ok('the unknown page says "Likely open", never "Open now"', /Likely open/.test(u) && !/Open now/.test(u));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const viaLi = renderJobPage({ id: '2001', company: 'Acme', title: 'SWE', location: 'Pune, India', bullets: ['a', 'b'], summary: 's', firstSeenAt: NOW - 5 * D, postedAt: NOW - 5 * D, checkedAt: NOW - D, checkedVia: 'linkedin', verified: true, applyUrl: 'https://www.linkedin.com/jobs/view/2001' });
  ok('a LinkedIn-apply check says the posting was still taking applications', /still taking applications when we checked it/.test(viaLi) && /Open now/.test(viaLi));
  ok('no style attribute on either (CSP)', !/\sstyle=/.test(viaLi));
}

console.log('\n== LinkedIn\'s public posting page: the verdicts ==');
const page = (closed) => `<html><h2 class="topcard__title">SWE</h2><div class="show-more-less-html__markup">Build things.</div>${closed ? '<figure class="closed-job">No longer accepting applications</figure>' : '<a class="apply-link-offsite">Apply</a>'}</html>`;
const res = (status, body = '') => ({ status, text: async () => body, body: { cancel: async () => {} } });
const fetchOf = (r) => async () => (r instanceof Error ? Promise.reject(r) : r);
const verdict = async (r) => (await checkPosting('1', { fetchImpl: fetchOf(r), parse: parsePublicPosting })).verdict;
ok('an open posting', (await verdict(res(200, page(false)))) === 'open');
ok('"No longer accepting applications" is closed', (await verdict(res(200, page(true)))) === 'closed');
ok('a 404 is gone', (await verdict(res(404))) === 'gone');
ok('a 410 is gone', (await verdict(res(410))) === 'gone');
ok('a 429 is blocked', (await verdict(res(429))) === 'blocked');
ok('a 999 is blocked', (await verdict(res(999))) === 'blocked');
ok('a 500 is unknown, never closed', (await verdict(res(500))) === 'unknown');
ok('markup we cannot read is unknown', (await verdict(res(200, '<html>nothing</html>'))) === 'unknown');
ok('a network error is unknown', (await verdict(new Error('ECONNRESET'))) === 'unknown');
{
  let asked = '';
  await checkPosting('4446731184', { fetchImpl: async (u) => { asked = u; return res(200, page(false)); }, parse: parsePublicPosting });
  ok('it reads the PUBLIC posting page, never the account', asked === 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4446731184', asked);
}

console.log('\n== the sweep: timid, and only closes on real evidence ==');
{
  const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ job_id: id, company: 'X', title: id }));
  const answers = { a: ['open'], b: ['closed'], c: ['gone', 'gone'], d: ['gone', 'open'], e: ['unknown'] };
  const calls = {};
  const check = async (id) => { const i = (calls[id] = (calls[id] ?? -1) + 1); return { verdict: answers[id][i] ?? answers[id].at(-1), note: answers[id][i] }; };
  const closed = []; const stamped = [];
  const r = await sweepLinkedinPostings(rows, { check, sleep: async () => {}, onClose: (row) => closed.push(row.job_id), onChecked: (row, { alive }) => stamped.push(`${row.job_id}:${alive}`) });
  ok('closes the "no longer accepting" one', closed.includes('b'));
  ok('closes a 404 seen twice', closed.includes('c'));
  ok('does NOT close a 404 the second look contradicts', !closed.includes('d'));
  ok('does not close an unknown', !closed.includes('e'));
  ok('closed exactly two', closed.length === 2, closed.join());
  ok('stamps every row checked, alive only where open', stamped.join() === 'a:true,b:false,c:false,d:true,e:false', stamped.join());
  ok('counts add up', r.checked === 5 && r.open === 2 && r.closed === 2 && r.unknown === 1, JSON.stringify(r));
}
{
  const rows = ['a', 'b', 'c'].map((id) => ({ job_id: id, company: 'X', title: id }));
  const stamped = [];
  const check = async (id) => ({ verdict: id === 'b' ? 'blocked' : 'open', note: id === 'b' ? 'HTTP 429' : 'ok' });
  const r = await sweepLinkedinPostings(rows, { check, sleep: async () => {}, onChecked: (row) => stamped.push(row.job_id) });
  ok('the first 429 stops the pass', r.blocked && r.checked === 1, JSON.stringify(r));
  ok('…and nothing after it is stamped (it is retried next rotation)', stamped.join() === 'a');
}
{
  const waits = [];
  await sweepLinkedinPostings([{ job_id: 'a' }, { job_id: 'b' }], { check: async () => ({ verdict: 'open' }), sleep: async (ms) => waits.push(ms), gapMs: 6000 });
  ok('requests are spaced', waits.includes(6000));
  ok('the per-run cap holds', (await sweepLinkedinPostings(Array.from({ length: 9 }, (_, i) => ({ job_id: String(i) })), { check: async () => ({ verdict: 'open' }), sleep: async () => {}, perRun: 4 })).checked === 4);
}

console.log('\n== which rows the LinkedIn pass reads ==');
{
  const store = new Store(':memory:');
  const put = (id, o) => store.db.prepare(`INSERT INTO jobs (job_id, title, company, first_seen_at, last_seen_at, first_run_id, is_tech, suppressed_reason, closed_at, apply_url, link_checked_at)
    VALUES (?, 't', 'C', ?, ?, 'r', ?, ?, ?, ?, ?)`).run(id, o.first, o.first, o.tech ?? 1, o.supp ?? null, o.closed ?? null, o.apply ?? null, o.checked ?? null);
  put('old-li', { first: NOW - 20 * D, apply: 'https://www.linkedin.com/jobs/view/1' });
  put('older-li', { first: NOW - 25 * D, apply: null });
  put('checked-li', { first: NOW - 28 * D, apply: 'https://www.linkedin.com/jobs/view/2', checked: NOW - D });
  put('young-li', { first: NOW - POSTING_MIN_AGE_MS + D / 2, apply: 'https://www.linkedin.com/jobs/view/3' });
  put('employer', { first: NOW - 20 * D, apply: 'https://careers.example.com/9' });
  put('ats:greenhouse:x:1', { first: NOW - 20 * D, apply: 'https://www.linkedin.com/jobs/view/4' });
  put('closed-li', { first: NOW - 20 * D, apply: null, closed: NOW });
  put('suppressed-li', { first: NOW - 20 * D, apply: null, supp: 'pulled' });
  put('nontech-li', { first: NOW - 20 * D, apply: null, tech: 0 });
  put('ancient-li', { first: NOW - 40 * D, apply: null });
  const ids = linkedinPostingsToCheck(store.db, { now: NOW }).map((r) => r.job_id);
  ok('reads exactly the LinkedIn-apply live rows', ids.join() === 'older-li,old-li,checked-li', ids.join());
  ok('never-checked first, oldest first, then by last check', ids[0] === 'older-li' && ids.at(-1) === 'checked-li');

  store.db.prepare("INSERT INTO jobs (job_id, title, company, first_seen_at, last_seen_at, first_run_id, is_tech) VALUES ('s1','t','C',1,1,'r',1)").run();
  store.markLinkChecked(['s1'], 5000);
  let row = store.db.prepare("SELECT link_checked_at, link_ok_at FROM jobs WHERE job_id='s1'").get();
  ok('a check that proves nothing stamps only link_checked_at', row.link_checked_at === 5000 && row.link_ok_at == null);
  store.markLinkChecked(['s1'], 6000, { ok: true });
  row = store.db.prepare("SELECT link_checked_at, link_ok_at FROM jobs WHERE job_id='s1'").get();
  ok('a positive check stamps link_ok_at too', row.link_checked_at === 6000 && row.link_ok_at === 6000);
  store.markLinkChecked(['s1'], 7000);
  row = store.db.prepare("SELECT link_checked_at, link_ok_at FROM jobs WHERE job_id='s1'").get();
  ok('…and a later 403 does not erase it', row.link_checked_at === 7000 && row.link_ok_at === 6000);
}

console.log('\n== the runner ==');
{
  const runner = read('bin/link-sweep.js');
  ok('the employer pass stamps the verdict', /onChecked:[^\n]*store\.markLinkChecked\(\[row\.job_id\], Date\.now\(\), \{ ok: !!alive \}\)/.test(runner));
  ok('the LinkedIn pass filters to published boards BEFORE the cap',
    /linkedinPostingsToCheck\(store\.db, \{ limit: 1_000_000 \}\)\s*\.filter\([^\n]*resolveRowRegion[^\n]*\)\.slice\(0, POSTING_PER_RUN\)/.test(runner));
  ok('the employer sweep marks alive only on a 200 that was not dead',
    /onChecked\(row, \{ alive: dead === 0 && lastNote\.startsWith\('HTTP 200'\) \}\)/.test(read('src/linksweep.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
