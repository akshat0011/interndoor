/**
 * NOTHING IN A SITEMAP MAY CARRY `noindex`.
 *
 * A sitemap is a request to crawl; `noindex` is an instruction not to index.
 * A URL in both is a contradiction that spends crawl budget to reach a page
 * whose markup then throws the visit away — and on a site whose crawl is the
 * binding constraint (2,214 URLs, 871 indexed, 278 "Discovered - currently not
 * indexed" on 3 Sep 2026) that budget is the scarce thing.
 *
 * WHAT THIS CAUGHT. `writeSitemap`'s hub filter asked
 * `(pastByCompany.get(company) ?? []).length >= 2` while the hub page asked
 * `hubHistory(live, past).length >= 2`, and `hubHistory` drops a past posting
 * whose title is already live and then keeps ONE PER TITLE. An employer who
 * reposted a single title counted 2 in the sitemap and rendered 1 on the page:
 * `noindex` in the markup, listed in the sitemap. Four India hubs were in that
 * state — NVIDIA, Barclays, Salesforce, Accenture in India — and the comment
 * above the filter asserted the two bars already matched.
 *
 * SO THE ASSERTION IS THE INVARIANT, NOT THE FOUR. Pinning those employers
 * would pass again the moment a different page type drifted the same way; this
 * reads every `<loc>` the render emits and opens the file behind it.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePages } from '../src/pages.js';
import { regionOf, publishedRegions } from '../src/regions.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const NOINDEX = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i;
const dirs = [];

/** Every `<loc>` in a rendered sitemap, paired with the file that serves it. */
function auditRegion(code) {
  const region = regionOf(code);
  const slug = region.slug ? `${region.slug}/` : '';
  const src = join('web', 'public', slug, 'data', 'jobs.json');
  if (!existsSync(src)) return null;                       // region not built yet
  const jobs = JSON.parse(readFileSync(src, 'utf8')).jobs ?? [];
  if (!jobs.length) return null;

  const dir = mkdtempSync(join(tmpdir(), `interndoor-sitemap-${code}-`));
  dirs.push(dir);
  writePages(jobs, dir, [], { region });

  /* `writePages` puts a non-India region under its OWN slug — US renders into
     `<dir>/us/`, not `<dir>/` — so the tree mirrors the live paths and a
     sitemap URL maps onto it by keeping the slug, not stripping it. Getting
     this backwards reported every US URL missing, which is a harness bug that
     reads exactly like the defect. */
  const xml = join(dir, region.slug, 'sitemap.xml');
  if (!existsSync(xml)) return { code, locs: 0, noindex: [], missing: ['sitemap.xml'] };

  const locs = [...readFileSync(xml, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const noindex = [], missing = [];
  for (const loc of locs) {
    const rel = loc.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    // India's board is the bare `/`; every other path is a file or a directory
    // holding index.html. Trailing slashes never reach here — vercel.json sets
    // trailingSlash:false and regionUrl trims — but `.replace` above would
    // leave one harmless anyway.
    const cands = rel === ''
      ? [join(dir, 'index.html')]
      : [join(dir, `${rel}.html`), join(dir, rel, 'index.html'), join(dir, rel)];
    const hit = cands.find((c) => existsSync(c) && statSync(c).isFile());
    if (!hit) {
      /* THE BOARD ROOT IS THE ONE EXPECTED ABSENCE, and it is a property of
         this harness, not of the site. `index.html` is ONE hand-maintained
         template that `writeHomePage` fills in place through its
         `<!--REGION:*-->` markers, so rendering into an empty scratch
         directory has nothing to fill and writes no homepage. Asserted
         against the real tree below instead, so the exemption cannot hide a
         board that genuinely stopped being written. */
      if (rel === '' || rel === region.slug) continue;
      missing.push(loc);
      continue;
    }
    if (NOINDEX.test(readFileSync(hit, 'utf8'))) noindex.push(loc);
  }
  return { code, locs: locs.length, noindex, missing };
}

const cfg = loadConfig();
const codes = publishedRegions(cfg).map((r) => r.code);
console.log(`\n== auditing sitemaps for ${codes.join(', ')} ==`);

let audited = 0;
for (const code of codes) {
  const r = auditRegion(code);
  if (!r) { console.log(`  --    ${code} not built locally, skipped`); continue; }
  audited++;
  console.log(`  (${r.code}: ${r.locs} <loc> entries)`);
  check(`${r.code}: no sitemap URL is noindex`, r.noindex, []);
  check(`${r.code}: every sitemap URL has a file behind it`, r.missing, []);
}

// A skip-everything run must not read as a pass — that is how this class hides.
console.log('\n== the audit actually ran ==');
check('at least one region was audited', audited > 0, true);

/* The one URL the scratch render cannot produce, checked where it does exist.
   Without this the exemption above would silently cover a missing board. */
console.log('\n== the board root the harness exempts is real, and indexable ==');
for (const code of codes) {
  const slug = regionOf(code).slug;
  const f = join('web', 'public', slug, 'index.html');
  const there = existsSync(f);
  check(`${code}: ${f} exists`, there, true);
  if (there) check(`${code}: board is not noindex`, NOINDEX.test(readFileSync(f, 'utf8')), false);
}

/* THE DETERMINISTIC HALF, AND THE REASON IT EXISTS.
 *
 * The audit above only bites when the day's real data happens to contain a
 * triggering employer — restoring the old raw-past-count filter passed it
 * cleanly, because today's jobs.json has no thin hub whose past rows repeat a
 * title. An assertion that depends on live data for its teeth is the fixture
 * that is four characters too short.
 *
 * So build the shape on purpose: ONE employer, NO live roles, and TWO past
 * postings carrying THE SAME TITLE. `hubHistory` keeps one per title, so the
 * page renders noindex — while `(past ?? []).length >= 2` sees two. Anything
 * that reads raw rows instead of shaped ones lists this hub. */
console.log('\n== a thin hub whose past repeats one title is noindex AND unlisted ==');
{
  const region = regionOf('IN');
  const dir = mkdtempSync(join(tmpdir(), 'interndoor-sitemap-fixture-'));
  dirs.push(dir);

  // A live employer, so the board and its facets still render something.
  const live = [{
    id: '900001', company: 'Kepler Systems', title: 'Software Engineer Intern',
    location: 'Bengaluru, Karnataka, India', postedAt: Date.now() - 3 * 86400000,
    firstSeenAt: Date.now() - 3 * 86400000, applyUrl: 'https://example.com/a',
    bullets: ['Ship a service behind a feature flag.', 'Write the tests that gate it.'],
    skills: ['python', 'sql'], summary: 'Backend work on the pricing service, with a mentor.',
  }];
  // The employer under test: reposted ONE title, nothing live.
  const posted = Date.now() - 20 * 86400000;
  const past = [
    { company: 'Vega Instruments', title: 'Graduate Engineer Trainee', roleLabel: 'Firmware',
      postedAt: posted, location: 'Pune, Maharashtra, India', skills: ['c', 'embedded'] },
    { company: 'Vega Instruments', title: 'Graduate Engineer Trainee', roleLabel: 'Firmware',
      postedAt: posted - 86400000, location: 'Pune, Maharashtra, India', skills: ['c', 'embedded'] },
    /* THE OTHER SIDE OF THE RULE, and the fixture is incomplete without it.
       Two DISTINCT past titles and nothing live is an employer whose hub has
       real history to show, so it must be indexable AND listed. Without this
       employer the suite passed a mutation that reduced the PAGE's bar to
       `live.length > 0`: the hub went out noindex while the sitemap still
       listed it — the same contradiction as the original bug, arrived at from
       the opposite direction. One thin employer can only ever catch a filter
       that is too loose. */
    { company: 'Orion Metrology', title: 'Embedded Software Intern', roleLabel: 'Embedded',
      postedAt: posted, location: 'Chennai, Tamil Nadu, India', skills: ['c', 'rtos'] },
    { company: 'Orion Metrology', title: 'Test Automation Intern', roleLabel: 'QA automation',
      postedAt: posted - 2 * 86400000, location: 'Chennai, Tamil Nadu, India', skills: ['python'] },
  ];

  writePages(live, dir, past, { region });

  const hub = join(dir, 'companies', 'vega-instruments.html');
  check('the thin hub was written', existsSync(hub), true);
  check('the thin hub is noindex', existsSync(hub) && NOINDEX.test(readFileSync(hub, 'utf8')), true);

  const xml = readFileSync(join(dir, 'sitemap.xml'), 'utf8');
  check('the thin hub is NOT in the sitemap', xml.includes('/companies/vega-instruments'), false);
  // The control: an employer with a live role must still be listed, or a rule
  // that drops every hub would pass the line above.
  check('a hub with a live role IS in the sitemap', xml.includes('/companies/kepler-systems'), true);

  // And history alone is enough: two distinct past titles, nothing live.
  const orion = join(dir, 'companies', 'orion-metrology.html');
  check('a history-only hub was written', existsSync(orion), true);
  check('a history-only hub is INDEXABLE',
    existsSync(orion) && NOINDEX.test(readFileSync(orion, 'utf8')), false);
  check('a history-only hub IS in the sitemap', xml.includes('/companies/orion-metrology'), true);
}

/* TWO SPELLINGS OF ONE EMPLOYER ARE ONE HUB.
 *
 * `companySlug` lowercases and hyphenates, so `NVIDIA` and `Nvidia` both name
 * `companies/nvidia.html`. `writePages` looped over raw company names, wrote
 * that path twice and let the second win — the surviving hub carried one
 * spelling's roles and dropped the other's. It also defeated the sitemap fix
 * above: `writeSitemap` asks `hubIndexable` per NAME, so either spelling
 * qualifying listed the URL while the file on disk could be the noindex one.
 * That was the fourth contradiction on the India board and the only one the
 * shared-predicate change did not remove.
 *
 * The fixture splits an employer across two spellings AND two case-variant
 * past rows, so a fix that merges live rows but resolves the two maps
 * independently still fails: the display name must be chosen across both. */
console.log('\n== two spellings of one employer collapse to one hub ==');
{
  const region = regionOf('IN');
  const dir = mkdtempSync(join(tmpdir(), 'interndoor-sitemap-collide-'));
  dirs.push(dir);
  const mk = (id, company, title) => ({
    id, company, title, location: 'Hyderabad, Telangana, India',
    postedAt: Date.now() - 2 * 86400000, firstSeenAt: Date.now() - 2 * 86400000,
    applyUrl: `https://example.com/${id}`, skills: ['cuda', 'c++'],
    bullets: ['Profile a kernel and cut its runtime.', 'Land the change behind a flag.'],
    summary: 'Systems work on the runtime, with a named mentor and a code review budget.',
  });
  // Majority spelling LIVE is "Zenith Silicon" (2 rows) ...
  const live = [
    mk('910001', 'Zenith Silicon', 'Compiler Intern'),
    mk('910002', 'Zenith Silicon', 'Runtime Intern'),
    mk('910003', 'ZENITH SILICON', 'Kernel Intern'),
  ];
  // ... while the PAST rows lean the other way. Resolving the maps separately
  // picks a different name on each side and re-creates the collision.
  const posted = Date.now() - 25 * 86400000;
  const past = [
    { company: 'ZENITH SILICON', title: 'Verification Intern', roleLabel: 'RTL', postedAt: posted,
      location: 'Hyderabad, Telangana, India', skills: ['verilog'] },
    { company: 'ZENITH SILICON', title: 'Physical Design Intern', roleLabel: 'PD', postedAt: posted - 1e8,
      location: 'Hyderabad, Telangana, India', skills: ['innovus'] },
    { company: 'ZENITH SILICON', title: 'DFT Intern', roleLabel: 'DFT', postedAt: posted - 2e8,
      location: 'Hyderabad, Telangana, India', skills: ['scan'] },
  ];

  writePages(live, dir, past, { region });

  const hub = join(dir, 'companies', 'zenith-silicon.html');
  check('the two spellings share one hub file', existsSync(hub), true);
  const html = existsSync(hub) ? readFileSync(hub, 'utf8') : '';
  // All three live roles must be on it — the collision dropped one spelling's.
  for (const t of ['Compiler Intern', 'Runtime Intern', 'Kernel Intern'])
    check(`the merged hub carries "${t}"`, html.includes(t), true);

  const xml = readFileSync(join(dir, 'sitemap.xml'), 'utf8');
  const listed = [...xml.matchAll(/<loc>[^<]*\/companies\/([^<]+)<\/loc>/g)].map((m) => m[1]);
  check('the employer is listed exactly once', listed.filter((h) => h === 'zenith-silicon').length, 1);
  check('no second hub under another spelling',
    listed.filter((h) => h.startsWith('zenith')).length, 1);
}

/* And the rule has exactly one home. Two copies is what drifted; if a fourth
   caller appears it must go through the same predicate. The pattern is
   deliberately broad — `>= 2` against ANY `.length` outside `hubIndexable` is
   the shape of a restatement, whether it counts `history` or the raw rows. */
console.log('\n== the hub bar is stated once ==');
const src = readFileSync(new URL('../src/pages.js', import.meta.url), 'utf8');
check('hubIndexable is defined once', (src.match(/^function hubIndexable\(/gm) ?? []).length, 1);
const body = src.slice(src.indexOf('function hubIndexable('));
const bar = /\.length > 0 \|\|[^;\n]*\.length >= 2/g;
check('the bar appears once in the whole file', (src.match(bar) ?? []).length, 1);
check('and that one occurrence is inside hubIndexable',
  (body.slice(0, body.indexOf('\n}')).match(bar) ?? []).length, 1);

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
