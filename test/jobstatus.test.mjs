/**
 * Job status from signals (src/jobstatus.js) and the checker that feeds it
 * (src/jobchecks.js, bin/job-check.js). Every page shape below is one met on a
 * live employer page on 11 Oct 2026 (160 measured), cut down to the part that
 * decides it.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import {
  SIGNALS, classifyPage, linkedinSignal, decideStatus, nextCheckAt, linkedinNight, phenomJob, namesJob,
  closedPhrase, visibleText, isUnsure, INTERVALS, CLOSE_AT, OCCASION_MS,
} from '../src/jobstatus.js';
import { planTick, runTick, ensureJobChecks, checksFor, kindOf } from '../src/jobchecks.js';
import { announceableIds } from '../src/rolefocus.js';
import { renderJobPage } from '../src/pages.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const H = 3_600_000, D = 24 * H;
const pad = (n) => '<p>' + 'Lorem ipsum about the company and its benefits. '.repeat(n) + '</p>';
const page = (body, extra = {}) => ({ status: 200, html: `<html><head><title>Careers</title></head><body>${body}</body></html>`, requestedUrl: 'https://careers.acme.com/job/Bengaluru-Data-Engineer/123456789/', finalUrl: 'https://careers.acme.com/job/Bengaluru-Data-Engineer/123456789/', redirected: false, title: 'Data Engineer', ...extra });
const sig = (p) => classifyPage(p).signal;

console.log('\n== a check that could not see the job never says closed ==');
{
  ok('429 is rate limited', sig({ ...page(''), status: 429 }) === 'rate_limited');
  ok('403 is blocked', sig({ ...page(''), status: 403 }) === 'blocked');
  ok('401 is blocked', sig({ ...page(''), status: 401 }) === 'blocked');
  ok('a 5xx is a server error', sig({ ...page(''), status: 503 }) === 'server_error');
  ok('no answer at all is unreachable', sig({ error: 'TimeoutError' }) === 'unreachable');
  ok('a bot-check page is blocked, not read', sig(page('<h1>Just a moment...</h1><p>Verify you are human</p>')) === 'blocked');
  ok('a redirect to a sign-in page is a login wall', sig(page('<form>Sign in</form>', { redirected: true, finalUrl: 'https://careers.acme.com/login?next=/job/123456789' })) === 'login_wall');
  ok('Okta\'s own careers site is NOT a sign-in page (grnh.se lands there)',
    sig(page(pad(20) + 'Site Reliability Engineer', { redirected: true, requestedUrl: 'https://grnh.se/abc123', finalUrl: 'https://www.okta.com/company/careers/rd/site-reliability-engineer-8243101/', title: 'Site Reliability Engineer' })) !== 'login_wall');
  for (const s of ['blocked', 'rate_limited', 'login_wall', 'unreachable', 'server_error', 'unreadable', 'page_lost_job']) ok(`${s} carries no direction`, SIGNALS[s].dir === 'none');
}

console.log('\n== what closes ==');
{
  ok('404', sig({ ...page(''), status: 404 }) === 'gone_404');
  ok('410', sig({ ...page(''), status: 410 }) === 'gone_410');
  ok('a redirect to a listing page is redirect_away',
    sig(page(pad(30), { redirected: true, requestedUrl: 'https://boards.greenhouse.io/acme/jobs/4567890', finalUrl: 'https://boards.greenhouse.io/acme?error=true' })) === 'redirect_away');
  ok('SuccessFactors "Sorry, this position has been filled." (Birlasoft, title still in the head)',
    sig(page('<div class="jobTitle"> </div><div class="job"><p><strong>Sorry, this position has been filled.</strong></p></div>' + pad(40), { title: 'Analyst-Enterprise Apps', html: `<html><head><title>Analyst-Enterprise Apps Job Details | Birlasoft</title></head><body><div class="jobTitle"> </div><div class="job"><p><strong>Sorry, this position has been filled.</strong></p></div>${pad(40)}</body></html>` })) === 'closed_text');
  ok('Global Payments "This role is no longer available"', sig(page('<h1>This role is no longer available</h1>')) === 'closed_text');
  ok('Volvo "This job posting is no longer available to apply"', sig(page('This job posting is no longer available to apply.')) === 'closed_text');
  ok('SmartRecruiters keeps the description and disables Apply: "Sorry, this job has expired"',
    sig(page(pad(30) + 'Data Engineer ' + '<button class="button is-disabled job-button" disabled>Sorry, this job has expired</button>')) === 'closed_text');
  ok('Phenom\'s retired-requisition page ("Custom Job Error") is closed text', closedPhrase('custom job error') !== null);
  ok('closed wording inside a SCRIPT is not read (message catalogues)', sig(page(pad(30) + 'Data Engineer <script>var m = "This job is no longer available";</script>')) !== 'closed_text');
  ok('…and a style block is not read either', visibleText('<style>.x{content:"position has been filled"}</style>ok') === 'ok');
}

console.log('\n== Phenom: the job data decides, never the wording ==');
{
  const live = `<script>phApp.ddo = {"jobDetail":{"status":200,"hits":1,"totalHits":1,"data":{"job":{"title":"Dotnet Developer"}}}};</script>`
    + `<ppc-content key="ebsiqc-job-expire-view-jobCompletionInfo">We're sorry… the job you are trying to apply for has been filled.</ppc-content>` + pad(40);
  ok('a live Phenom job with the hidden expired view is open', sig(page(live, { title: 'Dotnet Developer' })) === 'open_names_job');
  ok('phenomJob reads it as live', phenomJob(live) === 'live');
  const empty = `<script>phApp.ddo = {"jobDetail":{"status":404,"hits":0}};</script>` + pad(40);
  ok('a Phenom page without its job data is unreadable, not closed', sig(page(empty)) === 'unreadable');
  ok('a page that is not Phenom is not judged by this rule', phenomJob('<p>hello</p>') === null);
}

console.log('\n== what keeps it open ==');
{
  ok('a JavaScript shell (little text) only "answered" — as a 200 always counted', sig(page('<div id="root"></div>')) === 'open_page');
  ok('the title on a readable page names the job', sig(page(pad(30) + '<h1>Data Engineer</h1>')) === 'open_names_job');
  ok('the title up to its separator counts ("Software Engineer I - Backend")', namesJob('<h1>Software Engineer I</h1>', 'Software Engineer I - Backend', 'https://x.com/job'));
  ok('the posting id from the URL counts', namesJob(pad(5) + '"reqId":"123456789"', 'Something Else Entirely', 'https://careers.acme.com/job/x/123456789/'));
  ok('a readable page with no trace of the job is page_lost_job (recorded only)', sig(page(pad(30), { requestedUrl: 'https://careers.acme.com/job/x', finalUrl: 'https://careers.acme.com/job/x' })) === 'page_lost_job');
  ok('a short generic word in the title does not count as naming it', !namesJob(pad(5) + 'Intern', 'Intern', 'https://x.com/job'));
}

console.log('\n== LinkedIn\'s posting page ==');
{
  ok('still accepting → open', linkedinSignal({ verdict: 'open' }).signal === 'open_accepting');
  ok('no longer accepting → closed text', linkedinSignal({ verdict: 'closed', note: 'no longer accepting applications' }).signal === 'closed_text');
  ok('404 → gone_404', linkedinSignal({ verdict: 'gone', note: 'HTTP 404' }).signal === 'gone_404');
  ok('410 → gone_410', linkedinSignal({ verdict: 'gone', note: 'HTTP 410' }).signal === 'gone_410');
  ok('429/999 → rate limited', linkedinSignal({ verdict: 'blocked', note: 'HTTP 999' }).signal === 'rate_limited');
  ok('unreadable markup moves nothing', SIGNALS[linkedinSignal({ verdict: 'unknown', note: 'markup not read' }).signal].dir === 'none');
}

console.log('\n== deciding a status ==');
{
  const now = 100 * D;
  const c = (signal, agoMs, source = 'employer') => ({ signal, at: now - agoMs, source });
  const first = now - 10 * D;
  const st = (checks, firstSeenAt = first) => decideStatus({ checks, firstSeenAt, now });
  ok('a 410 closes on its own', st([c('gone_410', H)]).status === 'closed');
  ok('the page saying closed closes on its own, 95%', st([c('closed_text', H)]).status === 'closed' && st([c('closed_text', H)]).confidence === 0.95);
  ok('one 404 is possibly closed, 65%', st([c('gone_404', H)]).status === 'possibly_closed' && st([c('gone_404', H)]).confidence === 0.65);
  ok('two 404s seconds apart are ONE occasion — still possibly closed', st([c('gone_404', H), c('gone_404', H - 3000)]).status === 'possibly_closed');
  ok('two 404s seven hours apart close it', st([c('gone_404', 8 * H), c('gone_404', H)]).status === 'closed' && st([c('gone_404', 8 * H), c('gone_404', H)]).confidence >= CLOSE_AT);
  ok('two medium signals from different sources close it', st([c('gone_404', H, 'employer'), c('gone_404', H, 'linkedin')]).status === 'closed');
  ok('a redirect away twice, apart, closes it', st([c('redirect_away', 10 * H), c('redirect_away', H)]).status === 'closed');
  ok('an open signal after a 404 reopens it', st([c('gone_404', 8 * H), c('open_names_job', H)]).status === 'open');
  ok('a 404 after an open signal is possibly closed', st([c('open_names_job', 8 * H), c('gone_404', H)]).status === 'possibly_closed');
  ok('blocked checks move nothing', st([c('open_names_job', 8 * H), c('blocked', 2 * H), c('rate_limited', H)]).status === 'open');
  ok('page_lost_job moves nothing', st([c('page_lost_job', 9 * H), c('page_lost_job', H)]).status === 'likely_open');
  ok('first seen yesterday, nothing against it → open (listed recently)', st([], now - D).status === 'open');
  ok('first seen ten days ago, never confirmed → likely open', st([]).status === 'likely_open');
  ok('last confirmed five days ago → likely open', st([c('open_accepting', 5 * D)]).status === 'likely_open');
  ok('checks older than two weeks are not read', st([c('gone_410', 15 * D)]).status === 'likely_open');
  ok('a confirmed open state carries its signal\'s weight', st([c('open_accepting', H)]).confidence === 0.9);
  ok('the reason says how many checks agreed', /2 separate checks/.test(st([c('gone_404', 8 * H), c('gone_404', H)]).reason));
  ok('OCCASION_MS is six hours', OCCASION_MS === 6 * H);
}

console.log('\n== when to look again ==');
{
  const now = 100 * D;
  const n = (o) => nextCheckAt({ now, firstSeenAt: now - 5 * D, lastCheckAt: now, ...o });
  ok('possibly closed: six hours', n({ status: 'possibly_closed' }) === now + 6 * H);
  ok('on the channels, employer page: three hours', n({ status: 'open', hot: true }) === now + 3 * H);
  ok('on the channels, LinkedIn page: six hours', n({ status: 'open', hot: true, kind: 'linkedin' }) === now + 6 * H);
  ok('an employer page: daily', n({ status: 'open' }) === now + D);
  ok('…every two days once the job is over two weeks old', n({ status: 'open', firstSeenAt: now - 20 * D }) === now + 2 * D);
  ok('a LinkedIn page: every two days', n({ status: 'open', kind: 'linkedin' }) === now + 2 * D);
  ok('never checked: two days after it was found', nextCheckAt({ status: null, firstSeenAt: now - D, now }) === now + D);
  ok('never checked but on the channels: three hours after it was found', nextCheckAt({ status: null, hot: true, firstSeenAt: now - D, now }) === now - D + 3 * H);
  ok('closed: one look two days after closing', nextCheckAt({ status: 'closed', closedAt: now, now }) === now + 2 * D);
  ok('closed and already rechecked: never again', nextCheckAt({ status: 'closed', closedAt: now, rechecked: true, now }) === null);
  ok('three checks that could not see it double the wait', n({ status: 'open', recentSignals: ['blocked', 'blocked', 'rate_limited'] }) === now + 2 * D);
  ok('…capped at four days', n({ status: 'open', firstSeenAt: now - 20 * D, recentSignals: ['blocked', 'blocked', 'blocked'] }) === now + INTERVALS.maxBackoff);
  ok('two blocked and one open does not back off', n({ status: 'open', recentSignals: ['blocked', 'open_page', 'blocked'] }) === now + D);
  const ist = (h, m) => Date.UTC(2026, 9, 11, h, m) - 5.5 * H;
  ok('03:00 IST is LinkedIn night', linkedinNight(ist(3, 0)));
  ok('09:29 IST still is', linkedinNight(ist(9, 29)));
  ok('09:31 IST is not', !linkedinNight(ist(9, 31)));
  ok('noon IST is not', !linkedinNight(ist(12, 0)));
}

console.log('\n== planning a pass ==');
{
  const night = Date.UTC(2026, 9, 11, 21, 30);   // 03:00 IST
  const day = Date.UTC(2026, 9, 11, 6, 30);      // 12:00 IST
  const base = (id, o = {}) => ({ id, title: 't', company: 'c', applyUrl: 'https://careers.acme.com/job/' + id, firstSeenAt: night - 10 * D, nextCheckAt: night - H, ...o });
  ok('a careers-board row is never page-checked (its board is the evidence)', kindOf({ id: 'ats:greenhouse:x:1' }) === null);
  ok('an employer link is checked on the employer page', kindOf({ id: '4475208744', applyUrl: 'https://careers.swiggy.com/x' }) === 'employer');
  ok('a LinkedIn apply is checked on LinkedIn', kindOf({ id: '4475208744', applyUrl: 'https://www.linkedin.com/jobs/view/4475208744' }) === 'linkedin');
  const jobs = [base('1'), base('2', { status: 'possibly_closed' }), base('3'), base('ats:x:y:1'), base('5', { closedAt: night - D }), base('6', { nextCheckAt: night + H })];
  const p = planTick({ jobs, hot: new Set(['3']), now: night });
  ok('possibly closed first, then on the channels, then the rest', p.employer.map((j) => j.id).join() === '2,3,1');
  ok('careers-board, closed and not-yet-due rows are left out', !p.employer.some((j) => ['ats:x:y:1', '5', '6'].includes(j.id)));
  ok('a closed row owed its recheck is in', planTick({ extra: [base('7', { closedAt: night - 2 * D, recheck: true })], now: night }).employer.length === 1);
  ok('the employer budget caps the pass', planTick({ jobs: Array.from({ length: 80 }, (_, i) => base(String(i + 100))), now: night }).employer.length === 60);
  const li = Array.from({ length: 20 }, (_, i) => base(String(4400000000 + i), { applyUrl: null, nextCheckAt: night - H }));
  ok('at night LinkedIn takes up to 8', planTick({ jobs: li, now: night }).linkedin.length === 8);
  const liDay = li.map((j) => ({ ...j, nextCheckAt: day - H }));
  ok('by day routine LinkedIn checks wait for night', planTick({ jobs: liDay, now: day }).linkedin.length === 0);
  ok('…but jobs on the channels go, two at most', planTick({ jobs: liDay, hot: new Set(liDay.map((j) => j.id)), now: day }).linkedin.length === 2);
  ok('a LinkedIn pause stops every LinkedIn check', planTick({ jobs: li, now: night, linkedinPausedUntil: night + H }).linkedin.length === 0);
}

console.log('\n== a pass, end to end, on a store ==');
function fakeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE jobs (job_id TEXT PRIMARY KEY, company TEXT, title TEXT, apply_url TEXT, is_tech INTEGER DEFAULT 1,
    suppressed_reason TEXT, closed_at INTEGER, closed_reason TEXT, first_seen_at INTEGER, link_checked_at INTEGER, link_ok_at INTEGER,
    status TEXT, status_confidence REAL, status_reason TEXT, status_at INTEGER, next_check_at INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  const s = { db };
  for (const m of ['markClosed', 'reopenJob', 'markLinkChecked', 'getSetting', 'setSetting']) s[m] = Store.prototype[m].bind(s);
  return s;
}
const T0 = Date.UTC(2026, 9, 11, 21, 30);
const add = (s, id, o = {}) => s.db.prepare('INSERT INTO jobs (job_id, company, title, apply_url, first_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, 'Acme', 'Data Engineer', o.url ?? `https://careers.acme.com/job/${id}/`, T0 - 10 * D);
const job = (id, o = {}) => ({ id, company: 'Acme', title: 'Data Engineer', applyUrl: `https://careers.acme.com/job/${id}/`, firstSeenAt: T0 - 10 * D, kind: 'employer', hot: false, ...o });
const answers = (list) => { let i = 0; return async () => list[Math.min(i++, list.length - 1)]; };
const P404 = { status: 404, html: '' };
const P200 = { status: 200, html: '<div id="root"></div>' };
const PCLOSED = { status: 200, html: '<p>Sorry, this position has been filled.</p>' };
const opts = (o) => ({ sleep: async () => {}, now: () => o.at ?? T0, log: null, ...o });
const row = (s, id) => s.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(id);
{
  let s = fakeStore(); add(s, 'a');
  let r = await runTick(s, opts({ plan: { employer: [job('a')] }, mode: 'shadow', page: answers([P404, P404]) }));
  ok('shadow: a 404 twice a moment apart closes, as the old sweep did', row(s, 'a').closed_at != null && /^apply link dead: HTTP 404/.test(row(s, 'a').closed_reason));
  ok('…one check row is recorded for it', checksFor(s.db, 'a').length === 1 && checksFor(s.db, 'a')[0].signal === 'gone_404');
  ok('…its status is stored with a confidence', row(s, 'a').status === 'possibly_closed' && row(s, 'a').status_confidence === 0.65);

  s = fakeStore(); add(s, 'b');
  r = await runTick(s, opts({ plan: { employer: [job('b')] }, mode: 'shadow', page: answers([PCLOSED]) }));
  ok('shadow: closed wording does NOT close (not a rule the old sweep had)', row(s, 'b').closed_at == null);
  ok('…the new verdict is stored and counted as "would close"', row(s, 'b').status === 'closed' && r.shadowWouldClose === 1);
  ok('…and it is looked at again in six hours', row(s, 'b').next_check_at === T0 + 6 * H);

  s = fakeStore(); add(s, 'c');
  await runTick(s, opts({ plan: { employer: [job('c')] }, mode: 'shadow', page: answers([P404, P200]) }));
  ok('shadow: a 404 then a 200 stays open', row(s, 'c').closed_at == null && row(s, 'c').status === 'open');
  ok('…and the positive look stamps link_ok_at', row(s, 'c').link_ok_at === T0);

  s = fakeStore(); add(s, 'd');
  await runTick(s, opts({ plan: { employer: [job('d')] }, mode: 'on', page: answers([PCLOSED]) }));
  ok('on: the page saying filled closes it, with the status reason', row(s, 'd').closed_at != null && /^status: the page says/.test(row(s, 'd').closed_reason));
  ok('…a strong signal is not rechecked', row(s, 'd').next_check_at == null);

  s = fakeStore(); add(s, 'e');
  await runTick(s, opts({ plan: { employer: [job('e')] }, mode: 'on', page: answers([P404]) }));
  ok('on: one 404 is possibly closed, not closed', row(s, 'e').closed_at == null && row(s, 'e').status === 'possibly_closed');
  ok('…no second request in the same pass', checksFor(s.db, 'e').length === 1);
  await runTick(s, opts({ plan: { employer: [job('e')] }, mode: 'on', at: T0 + 7 * H, page: answers([P404]) }));
  ok('on: a second 404 seven hours later closes it', row(s, 'e').closed_at === T0 + 7 * H);
  ok('…closed on medium evidence, it is looked at once more in two days', row(s, 'e').next_check_at === T0 + 7 * H + 2 * D);
  await runTick(s, opts({ plan: { employer: [job('e', { recheck: true, closedAt: T0 + 7 * H })] }, mode: 'on', at: T0 + 3 * D, page: answers([P200]) }));
  ok('on: the recheck finding it open reopens it', row(s, 'e').closed_at == null && row(s, 'e').status === 'open');

  s = fakeStore(); add(s, 'f');
  s.db.prepare('UPDATE jobs SET closed_at = ?, closed_reason = ? WHERE job_id = ?').run(T0, 'status: x', 'f');
  await runTick(s, opts({ plan: { employer: [job('f', { recheck: true, closedAt: T0 })] }, mode: 'on', at: T0 + 2 * D, page: answers([P404]) }));
  ok('on: a recheck still finding it gone leaves it closed, never asked again', row(s, 'f').closed_at === T0 && row(s, 'f').next_check_at == null);

  s = fakeStore(); add(s, 'g'); add(s, 'h');
  const r2 = await runTick(s, opts({ plan: { employer: [job('g'), job('h')] }, mode: 'on', hostCloseCap: 1, page: answers([PCLOSED]) }));
  ok('the per-site daily cap holds the second close on one host', row(s, 'g').closed_at != null && row(s, 'h').closed_at == null && r2.held === 1);

  s = fakeStore(); add(s, 'i');
  s.db.prepare('UPDATE jobs SET link_ok_at = 5 WHERE job_id = ?').run('i');
  await runTick(s, opts({ plan: { employer: [job('i')] }, mode: 'on', page: answers([{ status: 403, html: '' }]) }));
  ok('a 403 changes nothing and keeps the last positive look', row(s, 'i').closed_at == null && row(s, 'i').link_ok_at === 5 && row(s, 'i').status === 'likely_open');

  s = fakeStore(); add(s, '4400000001'); add(s, '4400000002');
  const li = (id) => job(id, { kind: 'linkedin', applyUrl: null });
  const r3 = await runTick(s, opts({ plan: { linkedin: [li('4400000001'), li('4400000002')] }, mode: 'on', linkedin: answers([{ verdict: 'blocked', note: 'HTTP 429' }]) }));
  ok('a LinkedIn 429 stops the LinkedIn checks and pauses them', r3.linkedinBlocked && Number(s.getSetting('jobCheckLinkedinPausedUntil')) > T0 && checksFor(s.db, '4400000002').length === 0);

  s = fakeStore(); add(s, '4400000003');
  await runTick(s, opts({ plan: { linkedin: [li('4400000003')] }, mode: 'shadow', linkedin: answers([{ verdict: 'closed', note: 'no longer accepting applications' }]) }));
  ok('shadow: LinkedIn saying no longer accepting closes, as before', /^LinkedIn: no longer accepting/.test(row(s, '4400000003').closed_reason ?? ''));

  s = fakeStore(); add(s, 'j'); add(s, 'k');
  let t = T0;
  await runTick(s, { plan: { employer: [job('j'), job('k')] }, mode: 'on', sleep: async () => {}, now: () => (t += 3 * 60_000), page: answers([P200]), budgetMs: 4 * 60_000 });
  ok('the time budget ends the pass', checksFor(s.db, 'j').length === 1 && checksFor(s.db, 'k').length === 0);
}

console.log('\n== possibly closed on the site (only in "on" mode) ==');
{
  ok('isUnsure reads the status', isUnsure({ status: 'possibly_closed' }) && !isUnsure({ status: 'open' }) && !isUnsure({}));
  ok('the digest leaves it out', !announceableIds([{ id: 'x', category: 'software', status: 'possibly_closed' }, { id: 'y', category: 'software' }]).has('x'));
  const html = renderJobPage({ id: '4441247638', company: 'Adobe', title: 'AI Engineer Apprentice', postedAt: Date.UTC(2026, 9, 1), firstSeenAt: Date.UTC(2026, 9, 1), bullets: ['a', 'b'], status: 'possibly_closed', statusAt: Date.UTC(2026, 9, 11) });
  ok('the job page says "May have closed"', html.includes('May have closed') && html.includes('could not confirm this role is still open'));
  const plain = renderJobPage({ id: '4441247638', company: 'Adobe', title: 'AI Engineer Apprentice', postedAt: Date.UTC(2026, 9, 1), firstSeenAt: Date.UTC(2026, 9, 1), bullets: ['a', 'b'] });
  ok('…and a job without the status does not', !plain.includes('May have closed'));
  const pub = read('src/publish.js');
  ok('publish carries the status only in "on" mode', /statusOn && row\.status === 'possibly_closed'/.test(pub) && /statusOn: cfg\.jobStatus\?\.mode === 'on'/.test(pub));
  ok('…and a possibly closed job is not verified (noindex, out of the sitemap)', /verified: verifiedOpen\(j\) && !isUnsure\(j\)/.test(pub));
  const wa = read('src/whatsapp.js');
  ok('WhatsApp holds it on the queue, before the channel bar', /if \(isUnsure\(pub\)\) \{ unsure\+\+; waiting\.push\(\{ code, id \}\); return; \}\s*const why = channelRefusal\(pub\)/.test(wa));
  ok('the reels leave it out', /!channelRefusal\(j\)\s*&& !isUnsure\(j\)/.test(read('bin/queue-server.js')));
  const app = read('web/public/app.js');
  ok('the board card labels it', /job\.status === 'possibly_closed'\) meta\.append\(el\('span', 'unsure', 'May have closed'\)\)/.test(app));
  // A notice above the facts since the 11 Oct 2026 pane redesign.
  ok('the board pane says so first', /if \(job\.status === 'possibly_closed'\) \{\s*body\.append\(el\('p', 'p-warn', 'This role may have closed\./.test(app));
}

console.log('\n== wired in ==');
{
  const run = read('bin/run.sh');
  ok('bin/run.sh runs a pass after every scan', /bin\/job-check\.js" >> "\$LOG" 2>&1 \|\| true/.test(run));
  const cfg = JSON.parse(read('config.json'));
  ok('config names a mode, and it is one of the two', ['shadow', 'on'].includes(cfg.jobStatus?.mode));
  const pkg = JSON.parse(read('package.json'));
  ok('npm run job-check and job-status exist', /bin\/job-check\.js/.test(pkg.scripts['job-check'] ?? '') && /--job/.test(pkg.scripts['job-status'] ?? ''));
  const bin = read('bin/job-check.js');
  ok('the runner never publishes', !/publish\(|publish-now/.test(bin));
  ok('anything but "on" is shadow', /cfg\.jobStatus\?\.mode === 'on' \? 'on' : 'shadow'/.test(bin));
  const db = new DatabaseSync(':memory:'); ensureJobChecks(db); ensureJobChecks(db);
  ok('the checks table is created idempotently', db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'job_checks'").get().n === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
