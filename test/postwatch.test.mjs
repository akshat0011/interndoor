/**
 * The jobs he posts to LinkedIn are re-checked every few hours for a week, and
 * closed the moment either source says they are gone (src/postwatch.js); he
 * can also close one by hand from the owner bar. 8 Oct 2026 — readers from
 * his posts were pressing Apply on roles that had closed (Salesforce
 * "Software Engineering AMTS": LinkedIn posting 404 a day after it went up).
 *
 * Also: postdocs are dropped (a PhD role, not a student or fresher one).
 */
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { readWatch, watchJob, nextDue, postWatchTick, WATCH_EVERY_MS, WATCH_DAYS, PAUSE_MS, KEY } from '../src/postwatch.js';
import { isPostdoc } from '../src/pages.js';
import { entryLevelTitleRefusal } from '../src/employment.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const H = 3_600_000, D = 86_400_000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function fresh() {
  const store = new Store(':memory:');
  const put = (id, apply) => store.db.prepare(`INSERT INTO jobs (job_id, title, company, first_seen_at, last_seen_at, first_run_id, is_tech, apply_url)
    VALUES (?, 'Software Engineering AMTS', 'Salesforce', ?, ?, 'r', 1, ?)`).run(id, T0, T0, apply);
  put('4477143329', 'https://www.salesforce.com/company/careers/jobs/JR307116/software-engineering-amts/');
  put('4470000001', 'https://www.linkedin.com/jobs/view/4470000001/');
  put('ats:greenhouse:acme:9', 'https://boards.greenhouse.io/acme/jobs/9');
  return store;
}
const row = (s, id) => s.db.prepare('SELECT closed_at, closed_reason, link_ok_at, link_checked_at FROM jobs WHERE job_id = ?').get(id);
const noSleep = async () => {};

console.log('\n== the watch list ==');
{
  const s = fresh();
  watchJob(s, '4477143329', T0);
  watchJob(s, '4477143329', T0 + 5 * H);   // a re-queue does not restart its week
  ok('a queued job is watched from when it was first added', readWatch(s).jobs['4477143329'].added === T0);
  ok('it is due at once', nextDue(readWatch(s), T0) === '4477143329');
  const w = readWatch(s); w.jobs['4477143329'].checked = T0;
  ok('not due again inside three hours', nextDue(w, T0 + WATCH_EVERY_MS - 1) === null);
  ok('due again after three hours', nextDue(w, T0 + WATCH_EVERY_MS) === '4477143329');
  ok('a week later it is dropped', nextDue(w, T0 + WATCH_DAYS * D + 1) === null && !w.jobs['4477143329']);
  s.setSetting(KEY, 'not json');
  ok('a corrupt setting reads as an empty watch, never a throw', Object.keys(readWatch(s).jobs).length === 0);
}

console.log('\n== LinkedIn says it has gone: closed ==');
{
  const s = fresh(); watchJob(s, '4477143329', T0);
  const calls = [];
  const r = await postWatchTick(s, { now: T0, sleep: noSleep,
    checkLi: async (id) => { calls.push(id); return { verdict: 'gone', note: 'HTTP 404' }; },
    checkEmp: async () => ({ dead: false, note: 'HTTP 200' }) });
  ok('closed', r.closed && r.state === 'closed', JSON.stringify(r));
  ok('a 404 is asked twice before it closes anything', calls.length === 2);
  ok('the row is closed, with the reason', row(s, '4477143329').closed_at === T0 && /LinkedIn: HTTP 404/.test(row(s, '4477143329').closed_reason) && /posted-job watch/.test(row(s, '4477143329').closed_reason));
  ok('and it leaves the watch', !readWatch(s).jobs['4477143329']);
}
{
  const s = fresh(); watchJob(s, '4477143329', T0);
  const r = await postWatchTick(s, { now: T0, sleep: noSleep,
    checkLi: async () => ({ verdict: 'closed', note: 'no longer accepting applications' }),
    checkEmp: async () => { throw new Error('the employer link need not be asked'); } });
  ok('"No longer accepting applications" closes it on one read', r.closed && /no longer accepting/.test(row(s, '4477143329').closed_reason));
}
{
  const s = fresh(); watchJob(s, '4477143329', T0);
  let n = 0;
  const r = await postWatchTick(s, { now: T0, sleep: noSleep,
    checkLi: async () => (n++ === 0 ? { verdict: 'gone', note: 'HTTP 404' } : { verdict: 'open', note: 'accepting applications' }),
    checkEmp: async () => ({ dead: false, note: 'HTTP 200' }) });
  ok('a 404 the second look contradicts closes NOTHING', !r.closed && row(s, '4477143329').closed_at == null);
}

console.log('\n== the employer link says it has gone: closed ==');
{
  const s = fresh(); watchJob(s, '4477143329', T0);
  const r = await postWatchTick(s, { now: T0, sleep: noSleep,
    checkLi: async () => ({ verdict: 'open', note: 'accepting applications' }),
    checkEmp: async () => ({ dead: true, note: 'HTTP 410' }) });
  ok('a dead application link closes it even while LinkedIn says open', r.closed && /apply link dead: HTTP 410/.test(row(s, '4477143329').closed_reason));
}
{
  const s = fresh(); watchJob(s, 'ats:greenhouse:acme:9', T0);
  let li = 0;
  await postWatchTick(s, { now: T0, sleep: noSleep, checkLi: async () => { li++; return { verdict: 'open' }; }, checkEmp: async () => ({ dead: false, note: 'HTTP 200' }) });
  ok('a careers-board row is never looked up on LinkedIn', li === 0);
  ok('…its live link is a positive check', row(s, 'ats:greenhouse:acme:9').link_ok_at === T0);
}
{
  const s = fresh(); watchJob(s, '4470000001', T0);
  let emp = 0;
  await postWatchTick(s, { now: T0, sleep: noSleep, checkLi: async () => ({ verdict: 'open', note: 'accepting' }), checkEmp: async () => { emp++; return { dead: true }; } });
  ok('a LinkedIn-apply row has no employer link to check', emp === 0);
  ok('…and LinkedIn saying open is a positive check', row(s, '4470000001').link_ok_at === T0 && row(s, '4470000001').closed_at == null);
}

console.log('\n== unknowns close nothing, and a 429 pauses the whole watch ==');
{
  const s = fresh(); watchJob(s, '4477143329', T0);
  const r = await postWatchTick(s, { now: T0, sleep: noSleep, checkLi: async () => ({ verdict: 'unknown', note: 'HTTP 500' }), checkEmp: async () => ({ dead: false, note: 'HTTP 403 — not gone' }) });
  ok('a 500 and a 403 close nothing', !r.closed && row(s, '4477143329').closed_at == null);
  ok('…and are not a positive check either', row(s, '4477143329').link_ok_at == null && row(s, '4477143329').link_checked_at === T0);
  ok('…but the check is recorded, so it waits three hours', readWatch(s).jobs['4477143329'].checked === T0);
}
{
  const s = fresh(); watchJob(s, '4477143329', T0);
  const r = await postWatchTick(s, { now: T0, sleep: noSleep, checkLi: async () => ({ verdict: 'blocked', note: 'HTTP 429' }), checkEmp: async () => ({ dead: true }) });
  ok('a 429 is reported as blocked', r.state === 'blocked');
  ok('…nothing is closed', row(s, '4477143329').closed_at == null);
  ok('…and the watch pauses for 30 minutes', readWatch(s).pausedUntil === T0 + PAUSE_MS);
  const later = await postWatchTick(s, { now: T0 + PAUSE_MS - 1, sleep: noSleep, checkLi: async () => { throw new Error('asked while paused'); } });
  ok('…during which nothing is asked', later.state === 'paused');
}
{
  const s = fresh(); watchJob(s, '4477143329', T0);
  s.markClosed('4477143329', 'by hand', T0);
  const r = await postWatchTick(s, { now: T0, sleep: noSleep, checkLi: async () => { throw new Error('asked about a closed row'); } });
  ok('a job closed some other way simply leaves the watch', r.state === 'dropped' && !readWatch(s).jobs['4477143329']);
}

console.log('\n== wired into the queue server ==');
{
  const qs = read('bin/queue-server.js');
  ok('a job queued from the report is watched', /else \{ store\.queueAdd\(id\); watchJob\(store, id\); \}/.test(qs));
  ok('a job queued from the owner bar is watched', /store\.queueAdd\(row\.job_id\);\s*watchJob\(store, row\.job_id\);/.test(qs));
  ok('jobs already queued are watched at start-up', /for \(const \{ job_id: id \} of store\.db\.prepare\('SELECT job_id FROM post_queue'\)\.all\(\)\) watchJob\(store, id\);/.test(qs));
  ok('the minute tick runs one check', /setInterval\(\(\) => \{\s*watchTick\(\)\.catch/.test(qs));
  ok('a close is published straight away', /if \(r\.closed\) \{[\s\S]{0,200}schedulePublish\(\);/.test(qs));
  ok('ticks never overlap', /if \(watching\) return;/.test(qs));
}

console.log('\n== the owner bar can close and reopen ==');
{
  const qs = read('bin/queue-server.js');
  ok('POST /api/owner/close marks it closed', /path === '\/api\/owner\/close'[\s\S]{0,200}store\.markClosed\(row\.job_id, `closed by hand on/.test(qs));
  ok('…and publishes', /path === '\/api\/owner\/close'[\s\S]{0,500}schedulePublish\(\);/.test(qs));
  ok('POST /api/owner/reopen undoes it', /path === '\/api\/owner\/reopen'[\s\S]{0,200}store\.reopenJob\(row\.job_id\)/.test(qs));
  ok('the bar is told the state', /closed: row\.closed_at != null,/.test(qs));
  ok('a closed page still finds its posting (Reopen must be pressable)', /closed_at IS NOT NULL AND closed_at > \?/.test(qs));
  const ow = read('web/public/owner.js');
  ok('owner.js has a Close job button', /button\(bar, 'Close job'/.test(ow) && /\/api\/owner\/close/.test(ow));
  ok('…which asks first', /window\.confirm\('Mark "/.test(ow));
  ok('…and a Reopen button on a closed posting', /if \(view\.closed\) \{\s*button\(bar, 'Reopen'/.test(ow) && /\/api\/owner\/reopen/.test(ow));
}

console.log('\n== postdocs are dropped ==');
for (const t of ['Post Doctoral Fellow Materials', 'Post Doc Researcher', 'Postdoctoral Associate', 'Post-Doc Scientist', 'Postdoc - AI']) {
  ok(`"${t}" is a postdoc`, isPostdoc({ title: t }));
  ok(`…and refused before the open`, entryLevelTitleRefusal(t) === 'entry-level: postdoc title');
}
ok('"Postal Doctor Assistant" is not', !isPostdoc({ title: 'Postal Doctor Assistant' }));
ok('"Software Engineer" is not', !isPostdoc({ title: 'Software Engineer' }) && entryLevelTitleRefusal('Software Engineer') === null);
{
  const pub = read('src/publish.js');
  ok('publish holds a postdoc back', /\.filter\(\(\{ row \}\) => \{\s*if \(!isPostdoc\(row\)\) return true;/.test(pub));
  ok('…before dedupe', pub.indexOf('isPostdoc(row)') < pub.indexOf('dedupePostings(jobs, supersededPairs)'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
