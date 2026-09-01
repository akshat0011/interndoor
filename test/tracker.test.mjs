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
  return { T: win.IDTrack, raw: () => JSON.parse(store.get(win.IDTrack.KEY) || 'null') };
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
