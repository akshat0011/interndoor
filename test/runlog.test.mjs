/**
 * The readable run log (14 Oct 2026, his ask: "run logs which i can read
 * easily so i know why its stuck"): one plain file per scan in India time,
 * and the page on the queue helper that says what the scan is doing now.
 */
import { readFileSync } from 'node:fs';
import { readableLine, istTime } from '../src/logger.js';
import { renderRunLogPage, renderRunLogIndex, nowBox } from '../src/runlogpage.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

console.log('\n== a line as the run log writes it ==');
{
  const at = new Date('2026-10-14T04:03:10Z');
  check('India time, not UTC', istTime(at), '09:33:10');
  check('a wait reads WAIT', readableLine('warn', 'refused', at), '09:33:10  WAIT  refused');
  check('an error reads ERROR', readableLine('error', 'boom', at), '09:33:10  ERROR boom');
  check('debug lines are left out', readableLine('debug', 'noise', at), null);
  check('the long search link is shortened',
    readableLine('info', 'Page 3 — https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=%28a%29&start=20', at),
    '09:33:10        Page 3 — (LinkedIn search)');
  check('a short link is kept', readableLine('info', 'see https://interndoor.com/x', at), '09:33:10        see https://interndoor.com/x');
  check('a long other link keeps its host',
    readableLine('info', `go https://example.com/${'a'.repeat(90)}`, at), '09:33:10        go example.com/…');
  check('no colour codes', /\x1b/.test(readableLine('ok', 'x', at)), false);
}

console.log('\n== the "right now" box ==');
{
  const wait = ['09:33:10  WAIT  LinkedIn\'s public job search rate-limited us (HTTP 429) on "IN entry-level" page 17 — asking again at 09:35 (in 2 min, attempt 1).'];
  const box = nowBox(wait, { running: true, mtimeMs: 0, now: 0 });
  check('a wait says when the next try is, and that it is not stuck', /Next try at 09:35/.test(box) && /Not stuck/.test(box) && /class="now wait"/.test(box), true);
  check('a finished run says so', /has finished/.test(nowBox(wait, { running: false })), true);
  const quiet = nowBox(['09:00:00        Enriching 4 postings…'], { running: true, mtimeMs: 0, now: 12 * 60_000 });
  check('a long quiet spell is named in minutes', /nothing new for 12 min/.test(quiet), true);
  check('an error is called out', /class="now err"/.test(nowBox(['09:00:00  ERROR Brave died'], { running: true })), true);
}

console.log('\n== the page ==');
{
  const text = 'InternDoor scan — India full-time — run X\nStarted 14 Oct 2026, 09:00:00 India time\n\n09:00:01        ALPHA\n09:00:02  WAIT  BETA <b>\n';
  const page = renderRunLogPage(text, { name: 'X', running: true, mtimeMs: Date.now() });
  check('newest line first', page.indexOf('BETA') < page.indexOf('ALPHA'), true);
  check('it escapes what the log says', page.includes('&lt;b&gt;') && !page.includes('<b>\n'), true);
  check('a running log refreshes itself, with no script', /http-equiv="refresh"/.test(page) && !/<script/.test(page), true);
  check('a finished log does not', /http-equiv="refresh"/.test(renderRunLogPage(text, { name: 'X', running: false })), false);
  check('the index links each run', /href="\/log\/2026-10-14T03-00-00"/.test(renderRunLogIndex([{ id: '2026-10-14T03-00-00', title: 't' }])), true);
  check('an empty index says when they start', /start with the next scan/.test(renderRunLogIndex([])), true);
}

console.log('\n== the wiring ==');
{
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const qs = readFileSync(new URL('../bin/queue-server.js', import.meta.url), 'utf8');
  const lg = readFileSync(new URL('../src/logger.js', import.meta.url), 'utf8');
  check('every scan opens its run log before anything else can stop it',
    /const store = new Store\(\);\s*const what = [\s\S]{0,200}?startRunLog\(runId,/.test(idx), true);
  check('the logger writes each line to it', /if \(runLog\) \{\s*try \{\s*const r = readableLine\(level, msg\);/.test(lg), true);
  check('a wait line names the clock time of the next try',
    (idx.match(/asking again at \$\{istTime\(new Date\(Date\.now\(\) \+ waitMs\)\)\.slice\(0, 5\)\}/g) ?? []).length, 2);
  check('the helper serves /log', /path === '\/log' \|\| path === '\/log\/' \|\| path\.startsWith\('\/log\/'\)/.test(qs), true);
  check('a run id is checked before it becomes a file name', /!SAFE_ID\.test\(name\)/.test(qs), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
