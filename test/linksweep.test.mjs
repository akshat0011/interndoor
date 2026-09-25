/**
 * The closed state and the dead-link sweep: src/linksweep.js's decisions, the
 * store's closed_at column and methods, and publish honouring it — a closed
 * posting is off the board, its URL a stub, and STILL in the record.
 */
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { deadFromStatus, hostOf, checkLink, sweepApplyLinks, CONFIRM, redirectedAway, postingToken, HOST_CLOSE_CAP } from '../src/linksweep.js';
import { closableFrom } from '../src/publish.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n== only a hard 404/410 is dead ==');
{
  ok('404 and 410 are dead', deadFromStatus(404) && deadFromStatus(410));
  ok('200 is not', !deadFromStatus(200));
  ok('403 (WAF/bot block) is NOT dead', !deadFromStatus(403));
  ok('5xx (transient) is not dead', !deadFromStatus(500) && !deadFromStatus(503));
  ok('301/302 is not (a redirect is followed)', !deadFromStatus(301) && !deadFromStatus(302));
  ok('null is not', !deadFromStatus(null));
  ok('host is parsed, junk is empty', hostOf('https://careers.acme.com/x') === 'careers.acme.com' && hostOf('not a url') === '');
}

/* A fake network keyed by URL → an array of statuses, one per call, or a
   thrown error name. Records every request. */
function fakeNet(map) {
  const calls = [];
  const idx = new Map();
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const seq = map[String(url)];
    const i = idx.get(url) ?? 0; idx.set(url, i + 1);
    const step = Array.isArray(seq) ? seq[Math.min(i, seq.length - 1)] : seq;
    if (typeof step === 'string') { const e = new Error(step); e.name = step; throw e; }
    return { status: step, ok: step >= 200 && step < 300 };
  };
  return { calls, fetchImpl };
}

console.log('\n== checkLink never throws, and only 404/410 is dead ==');
{
  const net = fakeNet({ 'https://a/1': 404, 'https://a/2': 403, 'https://a/3': 200, 'https://a/4': 'TimeoutError' });
  ok('404 → dead', (await checkLink('https://a/1', { fetchImpl: net.fetchImpl })).dead === true);
  ok('403 → not dead, and the note says why', (await checkLink('https://a/2', { fetchImpl: net.fetchImpl })).dead === false);
  ok('200 → not dead', (await checkLink('https://a/3', { fetchImpl: net.fetchImpl })).dead === false);
  const t = await checkLink('https://a/4', { fetchImpl: net.fetchImpl });
  ok('a thrown network error is unknown, never dead', t.dead === false && /unreachable/.test(t.note));
  ok('no url → not dead, no request', (await checkLink('', { fetchImpl: net.fetchImpl })).status === null);
}

console.log('\n== the sweep confirms before closing, and paces per host ==');
{
  const rows = [
    { job_id: 'dead', company: 'Acme', title: 'R', apply_url: 'https://acme.com/dead' },
    { job_id: 'flap', company: 'Beta', title: 'R', apply_url: 'https://beta.com/flap' },
    { job_id: 'block', company: 'Gamma', title: 'R', apply_url: 'https://gamma.com/block' },
    { job_id: 'live', company: 'Delta', title: 'R', apply_url: 'https://delta.com/ok' },
  ];
  const net = fakeNet({
    'https://acme.com/dead': [404, 404],   // dead, confirmed twice → closes
    'https://beta.com/flap': [404, 200],    // a CDN 404 then 200 → spared
    'https://gamma.com/block': [403, 403],  // WAF → never dead
    'https://delta.com/ok': 200,            // alive on the first look
  });
  const closed = [];
  let slept = 0;
  const r = await sweepApplyLinks(rows, {
    check: (u) => checkLink(u, { fetchImpl: net.fetchImpl }),
    onClose: (row, note) => closed.push([row.job_id, note]),
    sleep: async () => { slept += 1; },
    hostGapMs: 1, confirmGapMs: 1,
  });
  ok('only the confirmed-dead one closes', r.closed === 1 && closed.length === 1 && closed[0][0] === 'dead');
  ok('a 404-then-200 flap is spared', !closed.some(([id]) => id === 'flap') && r.alive >= 1);
  ok('a 403 is spared and counted unverified', !closed.some(([id]) => id === 'block') && r.unknown >= 1);
  ok('the dead link was checked twice, the live one once', net.calls.filter((u) => /dead/.test(u)).length === 2 && net.calls.filter((u) => /ok$/.test(u)).length === 1);
  ok('a not-dead result (403) breaks after one check, never re-polled', net.calls.filter((u) => /block/.test(u)).length === 1);
  ok('checked counts every row once', r.checked === 4);
  ok('perRun caps the batch', (await sweepApplyLinks(rows, { check: async () => ({ dead: false, note: 'HTTP 200' }), perRun: 2 })).checked === 2);
}

console.log('\n== the store: closed is orthogonal to is_tech ==');
{
  const s = new Store(':memory:');
  const cols = s.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  ok('closed_at and closed_reason exist', cols.includes('closed_at') && cols.includes('closed_reason'));
  const put = (id, extra = {}) => s.db.prepare(
    'INSERT INTO jobs (job_id, title, company, is_tech, suppressed_reason, first_seen_at, last_seen_at, apply_url) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, 'Apprentice', 'S&P Global', extra.isTech ?? 1, extra.suppressed ?? null, extra.seen ?? 1000, 1000, extra.apply ?? `https://careers.spglobal.com/jobs/${id}`);
  put('live'); put('linkedin', { apply: 'https://www.linkedin.com/jobs/view/1/' }); put('pulled', { isTech: 0, suppressed: 'not software' }); put('humansup', { suppressed: 'apply page 404s' });
  ok('the sweep checks only live employer links', s.applyLinksToCheck(0).map((r) => r.job_id).sort().join() === 'live');
  ok('closing a live tech row is 1, and idempotent', s.markClosed('live', '404') === 1 && s.markClosed('live', '404') === 0);
  ok('is_tech is UNTOUCHED by closing', s.db.prepare("SELECT is_tech FROM jobs WHERE job_id='live'").get().is_tech === 1);
  ok('a closed row is no longer checked', !s.applyLinksToCheck(0).some((r) => r.job_id === 'live'));
  ok('a human-suppressed row cannot be closed (stronger already)', s.markClosed('humansup', '404') === 0);
  ok('reopen clears it', s.reopenJob('live') === 1 && s.reopenJob('live') === 0 && s.applyLinksToCheck(0).some((r) => r.job_id === 'live'));
}

console.log('\n== publish honours it: off the board, stubbed, still in the record ==');
{
  const cfg = loadConfig();
  const wanted = new Set(['IN']);
  // A software title: this block is about the CLOSED state, and a bare
  // "Apprentice" is now outside the role focus (test/rolefocus.test.mjs), which
  // would make every row closable for a reason this test is not about.
  const row = (id, extra = {}) => ({ job_id: id, company: 'S&P Global', title: 'Software Engineering Apprentice', is_tech: extra.isTech ?? 1, closed_at: extra.closed ?? null });
  const tracked = [
    { row: row('live'), matchedNow: 'S&P Global', region: 'IN' },
    { row: row('closed', { closed: 123 }), matchedNow: 'S&P Global', region: 'IN' },
    { row: row('nontech', { isTech: 0 }), matchedNow: 'S&P Global', region: 'IN' },
  ];
  const closable = closableFrom(tracked, cfg, wanted).map((c) => c.id).sort();
  ok('a closed tech row is closable (its URL becomes a stub)', closable.includes('closed'));
  ok('the non-tech row still is too', closable.includes('nontech'));
  ok('the live row is NOT closable', !closable.includes('live'));
  /* The live filter and the history filter are read out of publish's own
     source, so the two rules cannot silently drift: closed drops from live,
     stays in the record. */
  const src = read('src/publish.js');
  ok('publish drops a closed row from the board', /if \(row\.closed_at == null\) return true;\s*droppedClosed\+\+;/.test(src));
  ok('and the record keeps is_tech=1 rows (closing does not touch is_tech)', /const history = tracked\s*\n\s*\.filter\(\(\{ row[^)]*\}\) => row\.is_tech === 1/.test(src));
  ok('closableFrom keys on is_tech!==1 OR closed_at', /row\.is_tech !== 1 \|\| row\.closed_at != null/.test(src));
  ok('the closed count is logged', /Held back \$\{droppedClosed\} closed posting/.test(src));
}

console.log('\n== wired in ==');
{
  const run = read('bin/run.sh');
  ok('bin/run.sh sweeps once a day, output discarded', /bin\/link-sweep\.js" --daily >> "\$LOG" 2>&1 \|\| true/.test(run));
  const pkg = JSON.parse(read('package.json'));
  ok('npm run link-sweep exists', /bin\/link-sweep\.js/.test(pkg.scripts['link-sweep'] || ''));
  const runner = read('bin/link-sweep.js');
  ok('--daily is gated by a per-day marker', /linkSweepAt/.test(runner) && /Date\.now\(\) - Number\(store\.getSetting\(KEY\)/.test(runner));
  ok('it never publishes (the next scan does)', !/publish\(/.test(runner) && !/publish-now/.test(runner));
  ok('--dry-run writes nothing', /DRY_RUN[\s\S]*would close[\s\S]*markClosed/.test(runner));
  const rm = read('bin/remove-company.js');
  ok('--closed exists as a hand path and does not touch is_tech', /if \(JOB_ID && CLOSED\)/.test(rm) && /SET closed_at = \?, closed_reason = \?/.test(rm) && /is_tech = 1 AND suppressed_reason IS NULL AND closed_at IS NULL/.test(rm));
}

console.log('\n== the ROTATION: least recently checked first, or the cap covers nothing ==');
{
  const s = new Store(':memory:');
  const cols = s.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  ok('link_checked_at exists', cols.includes('link_checked_at'));
  const put = (id, seen, checkedAt) => s.db.prepare(
    'INSERT INTO jobs (job_id, title, company, is_tech, first_seen_at, last_seen_at, apply_url, link_checked_at) VALUES (?,?,?,1,?,?,?,?)',
  ).run(id, 'R', 'Acme', seen, seen, `https://acme.com/${id}`, checkedAt);
  /* 'newest-never' is the NEWEST row and has never been checked; 'oldest-done'
     is the OLDEST and was checked a moment ago. Ordered by age — the bug — the
     newest row comes first and the stale one is never reached. */
  /* Inserted OLDEST FIRST on purpose: rowid order then disagrees with the
     first_seen_at tie-break, so dropping that tie-break is observable. With
     them inserted newest-first, SQLite returns rowid order and the mutation
     that deletes the tie-break passes. */
  put('older-never', 2000, null);
  put('newest-never', 9000, null);
  put('done-long-ago', 8000, 1000);
  put('done-recently', 7000, 5000);
  const order = s.applyLinksToCheck(0).map((r) => r.job_id);
  ok('never-checked rows come FIRST, then the least recently checked',
    order.join() === 'newest-never,older-never,done-long-ago,done-recently', order.join());
  /* THE REGRESSION ITSELF: with only one slot, the sweep must spend it on a row
     it has never looked at — not re-read the newest row again. */
  ok('a one-row budget goes to an unchecked row, not the newest',
    s.applyLinksToCheck(0, { limit: 1 })[0].job_id === 'newest-never');
  s.markLinkChecked(['newest-never', 'older-never'], 6000);
  ok('markLinkChecked stamps them, and they fall to the back',
    s.applyLinksToCheck(0).map((r) => r.job_id).join() === 'done-long-ago,done-recently,newest-never,older-never');
  ok('marking an unknown id changes nothing', s.markLinkChecked(['nope']) === 0 && s.markLinkChecked([]) === 0);

  const src = read('src/store.js');
  ok('the query orders by checked-time, never by age alone',
    /ORDER BY link_checked_at IS NOT NULL, link_checked_at ASC/.test(src));
}

console.log('\n== every row checked is stamped, not only the ones that close ==');
{
  const rows = [
    { job_id: 'dead', company: 'A', title: 'R', apply_url: 'https://a.com/dead' },
    { job_id: 'live', company: 'B', title: 'R', apply_url: 'https://b.com/ok' },
    { job_id: 'block', company: 'C', title: 'R', apply_url: 'https://c.com/waf' },
  ];
  const net = fakeNet({ 'https://a.com/dead': [404, 404], 'https://b.com/ok': 200, 'https://c.com/waf': 403 });
  const stamped = [];
  const r = await sweepApplyLinks(rows, {
    check: (u) => checkLink(u, { fetchImpl: net.fetchImpl }),
    onChecked: (row) => stamped.push(row.job_id),
    sleep: async () => {}, hostGapMs: 1, confirmGapMs: 1,
  });
  ok('onChecked fires for the alive and bot-blocked rows too, not just the closed one',
    stamped.sort().join() === 'block,dead,live', stamped.join());
  ok('once per row, never once per request', stamped.length === r.checked);
  const runner = read('bin/link-sweep.js');
  ok('the runner stamps every checked row', /onChecked:[\s\S]{0,80}store\.markLinkChecked/.test(runner));
  ok('…and a dry run stamps nothing', /onChecked: DRY_RUN \? undefined/.test(runner));
}

console.log('\n== a redirect that lands on a listing page is a dead link, whatever the status ==');
{
  /* The two real shapes that a status check calls alive: Greenhouse's closed
     job (CloudSEK, 18 Sep 2026) and Microsoft's retired careers host. */
  const GH = 'https://job-boards.greenhouse.io/cloudsek/jobs/6200261004';
  ok('Greenhouse closed: 302 → /<board>?error=true is dead', redirectedAway(GH, 'https://job-boards.greenhouse.io/cloudsek?error=true'));
  ok('Microsoft retired host → careers home with the id dropped is dead',
    redirectedAway('https://jobs.careers.microsoft.com/global/en/job/1970393557000861', 'https://apply.careers.microsoft.com/careers'));
  ok('a host move that KEEPS the id is not dead',
    !redirectedAway('https://jobs.careers.microsoft.com/global/en/job/1970393557000861', 'https://apply.careers.microsoft.com/careers/job/1970393557000861'));
  ok('a login bounce carrying the id in its query is not dead',
    !redirectedAway('https://acme.wd1.myworkdayjobs.com/en-US/Acme/job/Austin/SWE-Intern_JR12345', 'https://acme.wd1.myworkdayjobs.com/login?redirect=%2Fjob%2FAustin%2FSWE-Intern_JR12345'));
  ok('a same-depth slug page without the id is not dead (not shallower)',
    !redirectedAway('https://acme.com/jobs/12345', 'https://acme.com/jobs/software-engineer-intern'));
  ok('no redirect at all is not dead', !redirectedAway(GH, GH) && !redirectedAway(GH, '') && !redirectedAway('', GH));
  ok('postingToken prefers the segment with the id, wherever it sits',
    postingToken(GH) === '6200261004' && postingToken('https://acme.com/jobs/12345/apply') === '12345'
    && postingToken('https://acme.com/careers/apply/') === 'apply' && postingToken('junk') === '');
  /* The id is not always LAST: an /apply sub-page bouncing back to its job
     page keeps the id and drops a segment — alive. Taking the last segment as
     the token would call that dead. */
  ok('an /apply sub-page bouncing to its job page (id kept, shallower) is not dead',
    !redirectedAway('https://acme.com/jobs/12345/apply', 'https://acme.com/jobs/12345'));
  /* THE FALSE CLOSE THE FIRST RUN MADE: a tracker link landing on the same
     posting under a DIFFERENT id, one segment shallower. A landing page that
     carries an id of its own is a job page, not a listing. Real Festo shape. */
  ok('a tracker link landing on a job page under another id is NOT dead (Festo)',
    !redirectedAway('https://festo-se-co-kg.contactrh.com/jobs/12312/44445381/en_GB',
      'https://jobs.festo.com/job/Islandia-AI-Adoption-and-Digital-Mindset-Intern-FL-11749/1419984433/?utm_campaign=x'));
  ok('a listing page with a tracking number in its QUERY is still a listing — the path decides',
    redirectedAway('https://job-boards.greenhouse.io/cloudsek/jobs/6200261004', 'https://job-boards.greenhouse.io/cloudsek?error=true&t=1726650000'));
  ok('…while the real listing bounces still close: Synopsys home, Anduril open-roles',
    redirectedAway('https://careers.synopsys.com/job/-/-/44408/100721402256', 'https://careers.synopsys.com/')
    && redirectedAway('https://boards.greenhouse.io/andurilindustries/jobs/5236579007?gh_jid=5236579007', 'https://www.anduril.com/open-roles'));
  /* NOT PINNED, BY CONSTRUCTION: checkLink also requires res.redirected. Without
     an HTTP redirect the fetch API's res.url equals the requested URL, so the
     guard can only differ on a response fetch cannot produce; a fixture that
     says redirected:false with a different url would be pinning a fiction. */

  /* checkLink reads the redirect off the response, so a fake fetch that says
     "redirected, final url is the board home" must come back dead. */
  const redirecting = async () => ({ status: 200, ok: true, redirected: true, url: 'https://job-boards.greenhouse.io/cloudsek?error=true' });
  const r = await checkLink(GH, { fetchImpl: redirecting });
  ok('checkLink calls it dead with a note that says where it went', r.dead === true && /redirected away to job-boards\.greenhouse\.io\/cloudsek\?error=true/.test(r.note), r.note);
  const moved = async () => ({ status: 200, ok: true, redirected: true, url: 'https://apply.careers.microsoft.com/careers/job/1970393557000861' });
  ok('…and NOT dead for a host move that keeps the id', (await checkLink('https://jobs.careers.microsoft.com/global/en/job/1970393557000861', { fetchImpl: moved })).dead === false);
  const plain = async () => ({ status: 200, ok: true, redirected: false, url: GH });
  ok('a plain 200 is still alive', (await checkLink(GH, { fetchImpl: plain })).dead === false);

  /* And through the sweep: confirmed twice like a 404, then closed. */
  let calls = 0;
  const closed = [];
  const res = await sweepApplyLinks([{ job_id: 'gh', company: 'CloudSEK', title: 'SDE Intern - Frontend', apply_url: GH }], {
    check: async (u) => { calls += 1; return checkLink(u, { fetchImpl: redirecting }); },
    onClose: (row, note) => closed.push(note), sleep: async () => {}, confirmGapMs: 1, hostGapMs: 1,
  });
  ok('the sweep closes it, after a second look', res.closed === 1 && calls === CONFIRM && /redirected away/.test(closed[0]));
}

console.log('\n== a whole host dying at once is held for a human, not closed ==');
{
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ job_id: `a${i}`, company: 'Acme', title: 'R', apply_url: `https://acme.com/jobs/${1000 + i}` });
  rows.push({ job_id: 'b1', company: 'Beta', title: 'R', apply_url: 'https://beta.com/jobs/77' });
  const warns = [];
  const closed = [];
  const res = await sweepApplyLinks(rows, {
    check: async () => ({ status: 404, dead: true, note: 'HTTP 404' }),
    onClose: (row) => closed.push(row.job_id), sleep: async () => {}, confirmGapMs: 1, hostGapMs: 1,
    hostCloseCap: 3, log: { warn: (m) => warns.push(m), info: () => {} },
  });
  ok('only the cap closes on the dying host', closed.filter((id) => id.startsWith('a')).length === 3);
  ok('the rest are HELD and counted', res.held === 17 && res.closed === 4);
  ok('another host is unaffected by the first one\'s cap', closed.includes('b1'));
  ok('one warning, naming the host', warns.length === 1 && /acme\.com/.test(warns[0]) && /restructure/.test(warns[0]), warns.join(' | '));
  ok('the default cap is a real number the daily run uses', Number.isInteger(HOST_CLOSE_CAP) && HOST_CLOSE_CAP >= 5);
  const runner = read('bin/link-sweep.js');
  ok('the runner reports held rows', /held \(per-host cap\)/.test(runner));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
