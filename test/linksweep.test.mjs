/**
 * The closed state and the dead-link sweep: src/linksweep.js's decisions, the
 * store's closed_at column and methods, and publish honouring it — a closed
 * posting is off the board, its URL a stub, and STILL in the record.
 */
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { deadFromStatus, hostOf, checkLink, sweepApplyLinks, CONFIRM } from '../src/linksweep.js';
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
  const row = (id, extra = {}) => ({ job_id: id, company: 'S&P Global', title: 'Apprentice', is_tech: extra.isTech ?? 1, closed_at: extra.closed ?? null });
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
