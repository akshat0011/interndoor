/**
 * THE FIXES FROM THE 14 OCT 2026 SEO/GEO AUDIT.
 *
 *   1. The board's role-type tabs wait for the data INVISIBLE, not hidden, so
 *      the search box and filters below them never jump (CLS 0.228 -> 0.012
 *      on a throttled phone).
 *   2. Job pages fill their "just landed" strip from data/fresh.json, the
 *      newest roles with a tile's fields only, not the 2.6 MB board.
 *   3. Role pages show when their newest role was listed, as a <time>.
 *   4. The role pages' breadcrumb markup says "Jobs" like the visible trail;
 *      job and company pages name InternDoor as publisher; /jobs redirects to
 *      the board; HSTS covers the subdomains.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshFeed, FRESH_FEED_SIZE } from '../src/publish.js';
import { renderRolePage, renderJobPage, renderCompanyPage } from '../src/pages.js';
import { roleGroups } from '../src/rolepages.js';
import { regionOf } from '../src/regions.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const region = regionOf('IN');

/* ---------------------------------------------------------------- 1 */
console.log('\n== 1. THE TABS RESERVE THEIR ROW ==');
{
  const html = read('web/public/index.html').replace(/<!--[\s\S]*?-->/g, '');
  const tag = (html.match(/<div[^>]*id="seg-kind"[^>]*>/) ?? [''])[0];
  check('the tab row is in the template', tag !== '', true);
  check('it ships is-pending', /class="[^"]*\bis-pending\b/.test(tag), true);
  check('it does NOT ship hidden (hidden takes it out of layout)', /\shidden\b/.test(tag), false);

  const css = noComments(read('web/public/styles.css'));
  const rule = (css.match(/#seg-kind\.is-pending\s*\{([^}]*)\}/) ?? [, ''])[1];
  check('pending is visibility: hidden', /visibility:\s*hidden/.test(rule), true);
  check('pending is never display: none', /display:\s*none/.test(rule), false);

  const app = read('web/public/app.js');
  const start = app.indexOf('function renderTotal()');
  const body = noComments(app.slice(start, app.indexOf('\n}\n', start)));
  check('renderTotal is found', start > 0 && body.length > 100, true);
  check('renderTotal takes is-pending off', /seg\.classList\.remove\(\s*['"]is-pending['"]\s*\)/.test(body), true);
}

/* ---------------------------------------------------------------- 2 */
console.log('\n== 2. THE "JUST LANDED" STRIP READS fresh.json ==');
{
  let n = 0;
  const row = (o = {}) => ({ id: String(++n), company: `Co${n}`, title: 'Software Engineer', location: 'Pune, Maharashtra, India',
    isTech: true, bullets: ['One', 'Two'], summary: 'Long summary text.', applyUrl: 'https://example.com/apply', postedAt: 1_790_000_000_000 + n * 1000, ...o });
  const rows = [
    row({ postedAt: 5 }), row({ isTech: false, postedAt: 1_800_000_000_000 }), row({ bullets: ['Only one'], postedAt: 1_800_000_000_001 }),
    row({ postedAt: undefined, firstSeenAt: 1_790_000_009_000 }), row(), row(),
  ];
  const feed = freshFeed(rows);
  check('a non-engineering row is left out', feed.some((j) => j.id === '2'), false);
  check('a row with under two duties is left out', feed.some((j) => j.id === '3'), false);
  check('newest first, postedAt else firstSeenAt', feed.map((j) => j.id), ['4', '6', '5', '1']);
  check('a tile\'s fields only: no duties, summary or apply link', feed.every((j) => !('bullets' in j) && !('summary' in j) && !('applyUrl' in j)), true);
  check('it says how many duties a row has', feed.every((j) => j.bulletCount === 2), true);
  check('it keeps what a tile and a slug need', Object.keys(freshFeed([row({ slugTitle: 'Old Title', workplaceType: 'hybrid', logo: '/logos/x.png', firstSeenAt: 1 })])[0]).sort(),
    ['bulletCount', 'company', 'firstSeenAt', 'id', 'location', 'logo', 'postedAt', 'slugTitle', 'title', 'workplaceType']);
  const big = Array.from({ length: FRESH_FEED_SIZE + 10 }, () => row());
  check(`it stops at ${FRESH_FEED_SIZE}`, freshFeed(big).length, FRESH_FEED_SIZE);

  const pub = noComments(read('src/publish.js'));
  check('publish writes fresh.json beside jobs.json', /writeFileSync\(freshFileFor\(region\),[^\n]*freshFeed\(regionJobs\)/.test(pub), true);

  const pj = read('web/public/page.js');
  const prefixRe = new Function(`return ${(pj.match(/feed\.replace\((\/[^\n]*?\/),\s*''\)/) ?? [, '/$^/'])[1]}`)();
  check('the region prefix comes off fresh.json', ['/data/fresh.json', '/us/data/fresh.json'].map((f) => f.replace(prefixRe, '')), ['', '/us']);
  check('and off jobs.json, for a page still naming it', '/data/jobs.json'.replace(prefixRe, ''), '');
  const filterSrc = (pj.match(/\.filter\((\(j\) => j\.isTech !== false[^\n]*)\)\n/) ?? [, '() => false'])[1];
  const keep = new Function(`return ${filterSrc}`)();
  check('the strip keeps a fresh.json row', keep({ isTech: true, bulletCount: 2 }), true);
  check('and still reads a jobs.json row', [keep({ bullets: ['a', 'b'] }), keep({ bullets: ['a'] })], [true, false]);

  const src = read('src/pages.js');
  check('every "just landed" strip names fresh.json', (src.match(/id="fresh" hidden data-feed="\$\{regionHref\('\/data\/fresh\.json', region\)\}"/g) ?? []).length, 3);
  check('no strip names the whole board', /id="fresh"[^>]*jobs\.json/.test(src), false);
  check('the tracker still reads the whole board (it resolves any tracked role)', /id="trk-root" data-feed="\$\{esc\(regionHref\('\/data\/jobs\.json'/.test(src), true);
}

/* ---------------------------------------------------------------- 3 + 4a */
console.log('\n== 3. ROLE PAGES SAY WHEN THEY WERE UPDATED ==');
{
  let seq = 0;
  /* 20:00 UTC on 13 Sep is 01:30 on 14 Sep in India: the date must be the
     board's own day, the one dayLabel prints. A September date, not today's,
     so a clock-based date cannot pass by matching the day the suite runs. */
  const newest = Date.UTC(2026, 8, 13, 20, 0);
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `r${++seq}`, company: `Co${seq}`, title: 'Software Engineer',
    location: 'Bengaluru, Karnataka, India', employmentType: 'fulltime', category: 'software', family: 'swe',
    postedAt: Date.UTC(2026, 8, 1), firstSeenAt: i === 4 ? newest : Date.UTC(2026, 8, 2 + i), bullets: ['a', 'b'], skills: ['python'] }));
  const g = roleGroups(rows);
  const html = renderRolePage(g.roles[0], { region, roles: g.roles, combos: g.combos });
  check('a role page says when it was updated', /<p class="summary">[^<]*Updated <time /.test(html), true);
  check('dated by its newest role, in India\'s day', (html.match(/ Updated <time datetime="([^"]+)">([^<]+)<\/time>\./) ?? []).slice(1), ['2026-09-14', '14 Sept 2026']);
  check('two renders are byte-identical (no clock)', html, renderRolePage(g.roles[0], { region, roles: g.roles, combos: g.combos }));

  console.log('\n== 4a. THE BREADCRUMB MARKUP MATCHES THE TRAIL ==');
  const crumb = ldBlocks(html).find((b) => b['@type'] === 'BreadcrumbList');
  const visible = (html.match(/<nav class="crumbs"[^>]*>\s*<a [^>]*>([^<]+)<\/a>/) ?? [])[1];
  check('the visible trail starts with Jobs', visible, 'Jobs');
  check('and so does the markup', crumb?.itemListElement?.[0]?.name, 'Jobs');
}

/* ---------------------------------------------------------------- 4b */
console.log('\n== 4b. INTERNDOOR IS THE PUBLISHER ==');
{
  const job = { id: '4477', company: 'Acme Robotics', title: 'Software Engineer Intern', location: 'Pune, Maharashtra, India',
    employmentType: 'intern', postedAt: Date.UTC(2026, 9, 10), firstSeenAt: Date.UTC(2026, 9, 10), lastSeenAt: Date.UTC(2026, 9, 10),
    bullets: ['Build services', 'Write tests'], skills: ['python'], summary: 'Our own words.', isTech: true, url: 'https://example.com/job' };
  const jp = ldBlocks(renderJobPage(job, [], { region }));
  check('the posting is still the first block', jp[0]?.['@type'], 'JobPosting');
  const web = jp.find((b) => b['@type'] === 'WebPage');
  check('a job page names InternDoor as publisher', [web?.publisher?.['@id'], web?.publisher?.name], ['https://interndoor.com/#organization', 'InternDoor']);
  check('about its own URL', web?.url, 'https://interndoor.com/jobs/acme-robotics-software-engineer-intern-4477');

  const hub = ldBlocks(renderCompanyPage('Acme Robotics', [job], [], '', { region }));
  const coll = hub.find((b) => b['@type'] === 'CollectionPage');
  check('a company page names InternDoor as publisher', coll?.publisher?.['@id'], 'https://interndoor.com/#organization');
  check('and is still ABOUT the employer', coll?.about?.name, 'Acme Robotics');
}

/* ---------------------------------------------------------------- 4c + 4d */
console.log('\n== 4c/d. /jobs AND HSTS ==');
{
  const v = JSON.parse(read('web/vercel.json'));
  const jobs = v.redirects.find((r) => r.source === '/jobs');
  check('/jobs redirects to the board', [jobs?.destination, jobs?.permanent], ['/', true]);
  check('and only /jobs itself, never a job page', v.redirects.some((r) => /^\/jobs\/:/.test(r.source)), false);
  const all = v.headers.find((h) => h.source === '/(.*)')?.headers ?? [];
  const hsts = all.find((h) => h.key === 'Strict-Transport-Security')?.value ?? '';
  check('HSTS covers the subdomains', /includeSubDomains/.test(hsts), true);
  check('for two years', /max-age=63072000\b/.test(hsts), true);
  check('and does not opt into the preload list (a separate, one-way decision)', /preload/.test(hsts), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
