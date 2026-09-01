/**
 * The application tracker.
 *
 * Three separate things are pinned here, and the first is the one that would
 * hurt most quietly.
 *
 * 1. THE STORE'S SEMANTICS (web/public/track.js). It is a browser file, so it
 *    is evaluated below against a fake window and a fake localStorage rather
 *    than imported. The history-appending and the import merge are real logic
 *    and are unrecoverable if wrong: a merge that replaced instead of merging
 *    would delete applications the reader had added since their last backup,
 *    and nothing on a server has a copy.
 *
 * 2. THE STATUS LADDER PRINTED ON THE PAGE MATCHES THE STORE'S. The page
 *    renders the seven stages server-side so it explains itself before
 *    anybody has used it, and the dropdown offers them from track.js. A stage
 *    named on the page that the store does not know is a promise the dropdown
 *    cannot keep.
 *
 * 3. THE PAGE'S PUBLISHING RULES. It has to be in the PUBLISHED allowlist (a
 *    generated page missing from it is written every run and pushed never —
 *    that has happened four times now), noindex, and absent from the sitemap.
 */
import { readFileSync } from 'node:fs';
import { publishedPaths } from '../src/publish.js';
import { renderApplicationsPage, jobSlug } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ *
 * The store, evaluated against a fake browser.
 * ------------------------------------------------------------------ */

function loadStore() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const win = { addEventListener() {} };
  const src = read('../web/public/track.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'localStorage', src)(win, localStorage);
  return {
    T: win.IDTrack,
    raw: () => JSON.parse(store.get(win.IDTrack.KEY) || 'null'),
    // Plant bytes directly, bypassing importData — the only way to reach code
    // that defends against rows read() did not sanitise.
    plant: (items) => store.set(win.IDTrack.KEY, JSON.stringify({ v: 1, items })),
  };
}

const JOB = {
  id: '4458884978', company: 'HARMAN India', title: 'Software Intern',
  location: 'Bengaluru, Karnataka, India', url: 'https://x/1', applyUrl: '',
  slug: 'harman-india-software-intern-4458884978', region: 'IN', path: '',
};

console.log('\n== marking a role applied ==');
{
  const { T } = loadStore();
  check('nothing tracked to begin with', T.count(), 0);
  T.track(JOB, 'applied');
  check('one row', T.count(), 1);
  check('status is applied', T.get(JOB.id).status, 'applied');
  check('one history entry', T.get(JOB.id).history.length, 1);
}

console.log('\n== A DOUBLE CLICK MUST NOT REWRITE WHEN SOMEBODY APPLIED ==');
{
  // The card's button is one of 250 on a scrolling list. Pressing it twice on a
  // role already at Applied must be a no-op, not a second history entry and a
  // fresh date.
  const { T } = loadStore();
  T.track(JOB, 'applied');
  const first = T.get(JOB.id).at;
  T.track(JOB, 'applied');
  check('still one history entry', T.get(JOB.id).history.length, 1);
  check('the applied date did not move', T.get(JOB.id).at, first);
}

console.log('\n== a status change APPENDS, it does not overwrite ==');
{
  /* The whole value of a tracker is "I applied three weeks ago and heard
     nothing" and "the OA came two days after applying". A single current-status
     field answers neither, and the history cannot be reconstructed later. */
  const { T } = loadStore();
  T.track(JOB, 'applied');
  T.track(JOB, 'review');
  T.track(JOB, 'oa');
  const row = T.get(JOB.id);
  check('current status is the last one set', row.status, 'oa');
  check('every step is kept', row.history.map((h) => h.s), ['applied', 'review', 'oa']);
  check('the first-applied date is untouched', row.at, row.history[0].at);
}

console.log('\n== open vs closed ==');
{
  const { T } = loadStore();
  T.track(JOB, 'interview');
  T.track({ ...JOB, id: '2' }, 'rejected');
  T.track({ ...JOB, id: '3' }, 'selected');
  check('three tracked', T.count(), 3);
  // Rejected and Selected are both endings; only the interview is outstanding.
  check('one still waiting on somebody', T.openCount(), 1);
}

console.log('\n== an unknown status is KEPT, never rewritten ==');
{
  /* It can only arrive from a backup written by a newer build. Coercing it to
     Applied would overwrite something the reader recorded with something they
     did not. */
  const { T } = loadStore();
  T.track(JOB, 'applied');
  T.track(JOB, 'offer-accepted');
  check('stored verbatim', T.get(JOB.id).status, 'offer-accepted');
  check('rendered as its own label', T.statusMeta('offer-accepted').label, 'offer-accepted');
  check('and it is flagged as unknown', T.statusMeta('offer-accepted').unknown, true);
}

console.log('\n== RESTORING A BACKUP MERGES, IT NEVER REPLACES ==');
{
  /* Restoring an old backup onto a device that has tracked more roles since
     must not throw the newer ones away. That is a data loss the reader cannot
     undo and would not expect from something called "restore". */
  const { T } = loadStore();
  T.track(JOB, 'applied');
  const backup = T.exportData();

  T.track({ ...JOB, id: 'newer' }, 'applied');   // tracked after the backup
  T.track(JOB, 'interview');                      // and this one moved on

  const res = T.importData(backup);
  check('the import succeeded', res.ok, true);
  check('the role added since the backup survives', !!T.get('newer'), true);
  check('nothing was added twice', T.count(), 2);
  // The stored row is NEWER than the backup's copy, so it wins.
  check('the newer status is not rolled back', T.get(JOB.id).status, 'interview');
}

console.log('\n== a backup that IS newer does win ==');
{
  const { T } = loadStore();
  T.track(JOB, 'applied');
  const row = { ...T.get(JOB.id), status: 'selected', updated: Date.now() + 60000 };
  const res = T.importData({ v: 1, items: [row] });
  check('import reports the update', res.updated, 1);
  check('the newer copy replaced the older', T.get(JOB.id).status, 'selected');
}

console.log('\n== a file that is not ours is refused, and changes nothing ==');
{
  const { T } = loadStore();
  T.track(JOB, 'applied');
  check('rejected', T.importData({ hello: 'world' }).ok, false);
  check('wrong version rejected', T.importData({ v: 99, items: [] }).ok, false);
  check('the existing list is untouched', T.count(), 1);
}

console.log('\n== refresh() updates the POSTING, never the reader\'s own fields ==');
{
  const { T } = loadStore();
  T.track(JOB, 'interview');
  const before = T.get(JOB.id);
  T.refresh([{ ...JOB, title: 'Software Engineering Intern', applyUrl: 'https://x/apply' }]);
  const after = T.get(JOB.id);
  check('a corrected title reaches the row', after.title, 'Software Engineering Intern');
  check('a recovered apply URL reaches the row', after.applyUrl, 'https://x/apply');
  check('the status is the reader\'s, and is untouched', after.status, 'interview');
  check('so is the history', after.history.length, before.history.length);
}

console.log('\n== a tracked role that has aged off the board still renders ==');
{
  /* Job pages are deleted 30 days after the posting is first seen, and
     jobs.json only carries what is live — so an application from five weeks
     ago, the one most likely still waiting on an answer, has no live row to
     read. This is why the store keeps a snapshot rather than an id. */
  const { T } = loadStore();
  T.track(JOB, 'applied');
  T.refresh([]);                       // the board no longer carries it
  const row = T.get(JOB.id);
  check('the company survives', row.company, 'HARMAN India');
  check('the title survives', row.title, 'Software Intern');
  check('and so does the link to its page', row.slug, JOB.slug);
}

console.log('\n== notes ==');
{
  const { T } = loadStore();
  T.track(JOB, 'applied');
  T.setNote(JOB.id, 'Referred by Priya. OA covered graphs.');
  check('the note is stored verbatim', T.get(JOB.id).note, 'Referred by Priya. OA covered graphs.');
  // A note is not an event that happened to the application.
  check('it does NOT enter the status history', T.get(JOB.id).history.length, 1);
  const before = T.get(JOB.id).updated;
  /* WAIT FOR THE CLOCK. Date.now() can return the same millisecond twice, so
     without this the assertion below passes whether or not the guard exists —
     which is exactly what a mutation run showed. */
  while (Date.now() === before) { /* spin one millisecond */ }
  check('a blur with no edit is a no-op', T.setNote(JOB.id, 'Referred by Priya. OA covered graphs.'), true);
  check('and does not move `updated`', T.get(JOB.id).updated, before);
  T.setNote(JOB.id, '');
  check('it can be cleared', T.get(JOB.id).note, '');
  check('a note on an untracked role is refused', T.setNote('nope', 'x'), false);
}

console.log('\n== the follow-up date ==');
{
  const { T } = loadStore();
  T.track(JOB, 'applied');
  check('stored as the ISO string the date input produces',
    T.setReminder(JOB.id, '2026-09-05') && T.get(JOB.id).remindAt, '2026-09-05');
  check('cleared with an empty string',
    T.setReminder(JOB.id, '') && T.get(JOB.id).remindAt, '');

  // Re-picking the same date is a no-op, the same way re-blurring a note is.
  T.setReminder(JOB.id, '2026-09-05');
  const stamp = T.get(JOB.id).updated;
  while (Date.now() === stamp) { /* spin one millisecond */ }
  check('re-picking the same date is a no-op', T.setReminder(JOB.id, '2026-09-05'), true);
  check('and does not move `updated`', T.get(JOB.id).updated, stamp);

  /* REFUSED, NOT STORED. Everything downstream compares these as strings, which
     is only exact while every value really is a bare ISO date — one free-text
     value and the comparison silently stops meaning anything. */
  T.setReminder(JOB.id, '2026-09-05');
  for (const bad of ['tomorrow', '5/9/2026', '2026-9-5', '2026-09-05T00:00:00Z', '20260905']) {
    check(`"${bad}" is refused`, T.setReminder(JOB.id, bad), false);
  }
  check('and the good value survives every refusal', T.get(JOB.id).remindAt, '2026-09-05');
  check('a date on an untracked role is refused', T.setReminder('nope', '2026-09-05'), false);
}

console.log('\n== what counts as due ==');
{
  const { T } = loadStore();
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  check('today() is a bare ISO date', /^\d{4}-\d{2}-\d{2}$/.test(T.today()), true);
  check('and it is today in THIS timezone', T.today(), day(0));

  T.track({ ...JOB, id: 'over' }, 'applied');  T.setReminder('over', day(-3));
  T.track({ ...JOB, id: 'now' }, 'applied');   T.setReminder('now', day(0));
  T.track({ ...JOB, id: 'soon' }, 'applied');  T.setReminder('soon', day(4));
  T.track({ ...JOB, id: 'none' }, 'applied');
  T.track({ ...JOB, id: 'shut' }, 'rejected'); T.setReminder('shut', day(-3));

  check('overdue is due', T.isDue(T.get('over')), true);
  check('today is due', T.isDue(T.get('now')), true);
  check('a future date is not', T.isDue(T.get('soon')), false);
  check('no date is not', T.isDue(T.get('none')), false);
  /* A follow-up left on a REJECTED application is a leftover from before the
     answer arrived. Flagging it sends somebody to chase a reply they have. */
  check('a closed application is never due', T.isDue(T.get('shut')), false);
  check('the count agrees', T.dueCount(), 2);
  check('a garbage row does not throw', T.isDue(null), false);
}

console.log('\n== the timezone trap this is written around ==');
{
  /* `new Date("2026-09-05")` parses as UTC midnight, so west of Greenwich it
     renders as the 4th. Storing a date STRING and comparing lexicographically
     touches no timezone at all — and this is the check that proves it, because
     the bug is invisible when the test runs in IST. */
  const { execFileSync } = await import('node:child_process');
  const probe = `
    import { readFileSync } from 'node:fs';
    const src = readFileSync('web/public/track.js', 'utf8');
    const store = new Map();
    const ls = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)) };
    const win = { addEventListener(){} };
    new Function('window','localStorage',src)(win, ls);
    const T = win.IDTrack;
    T.track({id:'a',company:'c',title:'t'}, 'applied');
    T.setReminder('a', T.today());
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const localToday = d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
    process.stdout.write(JSON.stringify({
      today: T.today(), local: localToday, utc: d.toISOString().slice(0,10),
      dueToday: T.isDue(T.get('a')),
    }));
  `;
  for (const tz of ['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
    check(`a follow-up set for today is due in ${tz}`, out.dueToday, true);
    check(`today() is the LOCAL date in ${tz}`, out.today, out.local);
  }
  /* And prove the check above is not vacuous: at least one of these zones must
     be on a different calendar day from UTC right now, or "local" and "UTC"
     agree everywhere and the assertion is comparing a value to itself. */
  const spread = new Set();
  for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
    spread.add(out.local === out.utc);
  }
  check('the timezone probe actually spans a date boundary', spread.has(false), true);
}

console.log('\n== notes and dates survive everything that touches a row ==');
{
  const { T } = loadStore();
  T.track(JOB, 'applied');
  T.setNote(JOB.id, 'spoke to the recruiter');
  T.setReminder(JOB.id, '2026-12-01');

  T.track(JOB, 'interview');
  check('a status change keeps the note', T.get(JOB.id).note, 'spoke to the recruiter');
  check('and the follow-up date', T.get(JOB.id).remindAt, '2026-12-01');

  /* refresh() copies POSTING fields only. Neither of these is in snapshot(),
     which is the mechanism — not a list of exceptions that could go stale. */
  T.refresh([{ ...JOB, title: 'Renamed Role', note: 'CLOBBER', remindAt: '1999-01-01' }]);
  check('a board refresh cannot overwrite the note', T.get(JOB.id).note, 'spoke to the recruiter');
  check('nor the follow-up date', T.get(JOB.id).remindAt, '2026-12-01');
  check('while the title still updates', T.get(JOB.id).title, 'Renamed Role');

  const backup = T.exportData();
  check('the backup carries the note', backup.items[0].note, 'spoke to the recruiter');
  check('and the date', backup.items[0].remindAt, '2026-12-01');

  const { T: fresh } = loadStore();
  fresh.importData(backup);
  check('and a restore brings both back',
    [fresh.get(JOB.id).note, fresh.get(JOB.id).remindAt],
    ['spoke to the recruiter', '2026-12-01']);
}

console.log('\n== A BACKUP FILE IS UNTRUSTED INPUT ==');
{
  /* It is a file off the reader's own disk: corrupt, truncated, hand-edited or
     written by something else entirely. Nothing here is a script-injection risk
     (every render uses textContent) but it WAS a data-corruption one — a
     `history` arriving as a string survived, and the next status change ran
     "not-an-array".concat([...]) and permanently wrecked the row. */
  const { T } = loadStore();
  const res = T.importData({ v: 1, items: [
    { id: 'a', company: {}, title: ['x'], status: { bad: 1 },
      history: 'not-an-array', note: { o: 1 }, remindAt: {}, updated: 1 },
    { id: 'b', company: 'ok', title: 'ok', status: 'applied', updated: 2 },
    { id: '', company: 'no id' },
    'not an object',
    null,
    [],
  ] });
  check('it still imports what it can', res.ok, true);
  check('and says how much it dropped', res.skipped, 4);
  check('only the usable rows are kept', T.count(), 2);

  const a = T.get('a');
  check('status is coerced to a string', typeof a.status, 'string');
  check('history is coerced to an array', Array.isArray(a.history), true);
  check('note is coerced to a string', typeof a.note, 'string');
  check('a nonsense remindAt is dropped, not stored', a.remindAt, '');

  // The bug this exists for: a status change on the corrupted row.
  T.track({ id: 'a' }, 'oa');
  check('a later status change keeps history an array', Array.isArray(T.get('a').history), true);
  check('and appends properly', T.get('a').history[T.get('a').history.length - 1].s, 'oa');
}

console.log('\n== read() does NOT sanitise, so the writers must defend ==');
{
  /* clean() only runs on IMPORT. read() is called by every single operation, so
     sanitising there would mean re-walking every row on every get() — instead
     the writers guard themselves. This reaches that guard the only way it can
     be reached: bytes already in localStorage, from a hand-edit or a future
     bug. */
  const { T, plant } = loadStore();
  plant([{ id: 'a', company: 'C', title: 'T', status: 'applied',
           history: 'not-an-array', at: 1, updated: 1 }]);
  check('the row is readable', T.get('a').company, 'C');
  T.track({ id: 'a' }, 'oa');
  check('a status change does not string-concat onto it',
    Array.isArray(T.get('a').history), true);
  check('and records the change', T.get('a').history.map((h) => h.s), ['oa']);
}

console.log('\n== but a backup from a NEWER build still round-trips ==');
{
  /* Sanitising types must not become sanitising VALUES. An unknown status is
     the documented way a newer build's file survives an older one. */
  const { T } = loadStore();
  T.importData({ v: 1, items: [
    { id: 'z', company: 'C', title: 'T', status: 'offer-accepted', at: 9, updated: 9 },
  ] });
  check('the unknown status is kept verbatim', T.get('z').status, 'offer-accepted');
  check('and is still flagged unknown', T.statusMeta(T.get('z').status).unknown, true);
  check('a row with no history gets one built from its status',
    T.get('z').history.map((h) => h.s), ['offer-accepted']);
}

console.log('\n== a row written before notes existed ==');
{
  /* Anything already in a reader's browser from the first release has neither
     field. Nothing may throw on it, and nothing may invent a value. */
  const { T } = loadStore();
  T.track(JOB, 'applied');
  const raw = T.exportData();
  delete raw.items[0].note;
  delete raw.items[0].remindAt;
  const { T: old } = loadStore();
  old.importData(raw);
  check('it is not due', old.isDue(old.get(JOB.id)), false);
  check('the count does not throw', old.dueCount(), 0);
  check('and a note can still be added', old.setNote(JOB.id, 'hello') && old.get(JOB.id).note, 'hello');
}

console.log('\n== a write that fails is REPORTED, never swallowed ==');
{
  /* A tracker that appears to save and does not is worse than no tracker: the
     reader stops keeping their own list because they believe this one is. */
  const src = read('../web/public/track.js');
  const win = { addEventListener() {} };
  const ls = {
    getItem: () => null,
    setItem: () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'localStorage', src)(win, ls);
  check('track() reports failure', win.IDTrack.track(JOB, 'applied'), false);
  check('and says why', /no room/.test(win.IDTrack.error()), true);
}

/* ------------------------------------------------------------------ *
 * The page.
 * ------------------------------------------------------------------ */

const IN = regionOf('IN');
const html = renderApplicationsPage({ region: IN });
const { T } = loadStore();

console.log('\n== the ladder on the page is the ladder the store offers ==');
{
  // The <ol> the page ships, in order.
  const ladder = [...html.matchAll(/<li><b>([^<]+)<\/b>/g)].map((m) => m[1]);
  const stored = T.STATUSES.map((s) => s.label);
  check('every stage on the page exists in the store',
    ladder.filter((l) => !stored.includes(l)), []);
  check('every stage in the store is named on the page',
    stored.filter((s) => !ladder.includes(s)), []);
  check('all seven the brief asked for', ladder.length, 7);
}

console.log('\n== the seven statuses, by name ==');
{
  const labels = T.STATUSES.map((s) => s.label);
  for (const want of ['Applied', 'Application under review', 'Shortlisted', 'OA received',
    'Interview scheduled', 'Rejected', 'Selected']) {
    check(`"${want}" is offered`, labels.includes(want), true);
  }
}

console.log('\n== the page is noindex and ships its EMPTY state ==');
{
  /* Every row is built from localStorage, so this page is identical for every
     reader and every crawler. What it would index is a heading and no
     listings — thin content, on a domain that already carries a previous
     owner's history. */
  check('noindex', /<meta name="robots" content="noindex,follow">/.test(html), true);
  check('the empty state is in the HTML', html.includes('Nothing tracked yet'), true);
  check('and it says where the data lives', /On this device, in this browser/.test(html), true);
}

console.log('\n== no inline script — the CSP would silently block it ==');
{
  /* vercel.json ships script-src 'self' plus a hash allowlist and no
     'unsafe-inline'. An inline script whose sha256 is absent is blocked in
     production and works perfectly on every local server, which is exactly how
     the no-flash theme script shipped broken on 21 Aug. head()'s own theme
     one-liner is hashed already; this page must add none of its own. */
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)];
  check('exactly the one head() already hashes', inline.length, 1);
  check('its own script is a self src',
    html.includes('<script defer src="/applications.js"></script>'), true);
  check('and the store is loaded ahead of it',
    html.indexOf('/track.js') < html.indexOf('/applications.js'), true);
}

console.log('\n== the publishing rules ==');
{
  const allow = new Set(publishedPaths());
  /* Four generated pages have now been written every run and pushed never —
     /alerts, /report and the two facet directories. This one is worse to miss:
     it is noindex and out of the sitemap, so no Search Console report would
     ever flag the 404, and foot() links it from every one of ~950 pages. */
  check('applications.html is in the PUBLISHED allowlist',
    allow.has('web/public/applications.html'), true);
  check('the hand-maintained scripts are still NOT',
    ['web/public/track.js', 'web/public/applications.js'].filter((p) => allow.has(p)), []);
}

console.log('\n== every board links to its OWN tracker ==');
{
  /* REGION_LINKS is what localiseLinks rewrites. Without /applications in it,
     the US and UK boards would link India's page — which is the same class of
     mistake as posting one board's roles to another board's channel. */
  const src = read('../src/pages.js');
  const line = src.match(/const REGION_LINKS = \[([^\]]*)\]/)[1];
  check("/applications is localised per region", line.includes("'/applications'"), true);

  const us = renderApplicationsPage({ region: regionOf('US') });
  check('the US page canonical is /us/applications',
    /<link rel="canonical" href="https:\/\/interndoor\.com\/us\/applications">/.test(us), true);
  check('and its feed is the US board\'s',
    /data-feed="\/us\/data\/jobs\.json"/.test(us), true);
}

console.log('\n== the slug the tracker builds is the slug the page is written at ==');
{
  /* jobPageSlug now exists in FOUR copies — src/pages.js, app.js, page.js and
     applications.js. A drift links a tracked application to a 404, which on
     this page lands on the role somebody is actively chasing. */
  /* The two functions are lifted out of the real source text rather than the
     whole IIFE being run — it bails immediately without a browser, so running
     it would test nothing. Lifting by name means an edit to either function is
     what this reads. */
  const src = read('../web/public/applications.js');
  const grab = (name) => {
    const at = src.indexOf(`function ${name}(`);
    if (at === -1) throw new Error(`applications.js no longer defines ${name}()`);
    let i = src.indexOf('{', at), depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
    }
    throw new Error(`unbalanced ${name}()`);
  };
  const jobPageSlug = new Function(
    `${grab('slugPart')}\n${grab('jobPageSlug')}\nreturn jobPageSlug;`)();
  const cases = [
    { company: 'HARMAN India', title: 'Intern', id: '4458884978' },
    { company: 'Procter & Gamble', title: 'Engineering Internship, Summer 2027', id: '999' },
    { company: 'AtkinsRéalis', title: 'Intern', id: 'ats:greenhouse:x:12' },
    /* THE TRUNCATION LIMITS ARE THE PART THAT DRIFTS, and short names cannot
       exercise them — an earlier version of this test passed with the company
       limit mutated from 70 to 60 because every fixture was under both. Both of
       these are real rows: a 67-character employer, and the 172-character title
       from an employer who names fifteen cities in it. */
    {
      company: 'National Technology Centre for Ports, Waterways and Coasts (NTCPWC)',
      title: 'Intern',
      id: '4460134522',
    },
    {
      company: 'STEMpedia',
      title: 'AI And Robotics Trainer Internship in Haryana, Jhajjar, Ambala, Bhiwani, '
        + 'Palwal, Hisar, Jind, Kurukshetra, Gurgaon, Sirsa, Sonipat, Faridabad, Nuh, '
        + 'Charkhi Dadri, Fatehabad',
      id: '4459622396',
    },
  ];
  for (const c of cases) {
    check(`slug matches pages.js — ${c.company}`, jobPageSlug(c), jobSlug(c));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
