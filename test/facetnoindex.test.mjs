/**
 * SKILL AND LOCATION PAGES — INDEXABLE AGAIN SINCE 30 SEP 2026.
 *
 * Noindexed on 14 Sep (a template over rows the board already shows, ~1,300
 * impressions and 2 clicks over 1-10 Sep), and turned back on with the India-
 * only switch, once each page carried what the board does not (facetInsights):
 * who is hiring, the other axis, and how many state pay. Three places still
 * have to agree, now in the other direction:
 *
 *   - the page carries no noindex and names itself canonical;
 *   - the sitemap lists every facet page written, and nothing else under them;
 *   - IndexNow hears about them.
 *
 * And the two things that made re-indexing safe: one page per city (Bengaluru,
 * Bangalore, Bangalore Urban and Greater Bengaluru were four pages), and every
 * link a facet page adds resolves to a page that was written.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePages, renderFacetPage, renderFacetIndex, isIndexable, FACETS_INDEXABLE, NOINDEX_JOB_BOARDS, jobPageIndexable, facetInsights } from '../src/pages.js';
import { facetGroups } from '../src/facets.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const NOINDEX = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i;
const FACET_URL = /\/(?:skills|locations)(?:\/|$)/;
const jobs = existsSync('web/public/data/jobs.json') ? (JSON.parse(readFileSync('web/public/data/jobs.json', 'utf8')).jobs ?? []) : [];
const region = regionOf('IN');

check('the switch is on', FACETS_INDEXABLE, true);

console.log('\n== the pages are indexable ==');
const facets = facetGroups(jobs.filter(isIndexable));
/* Without facets to render every assertion below passes vacuously. */
check('India has skill and city facets to test against', [facets.skills.length >= 3, facets.cities.length >= 3], [true, true]);
{
  const skill = renderFacetPage('skill', facets.skills[0], facets.skills, { region });
  const city = renderFacetPage('city', facets.cities[0], facets.cities, { region });
  check('a skill page carries no noindex', NOINDEX.test(skill), false);
  check('a location page carries no noindex', NOINDEX.test(city), false);
  check('a skill page names itself canonical', skill.includes(`<link rel="canonical" href="https://interndoor.com/skills/${facets.skills[0].slug}">`), true);
  check('the skills index is indexable', NOINDEX.test(renderFacetIndex('skill', facets.skills, { region })), false);
  check('the locations index likewise', NOINDEX.test(renderFacetIndex('city', facets.cities, { region })), false);
}

console.log('\n== ONE page per city ==');
{
  const slugs = facets.cities.map((c) => c.slug);
  const aliases = ['bangalore', 'bangalore-urban', 'greater-bengaluru', 'gurgaon', 'greater-hyderabad', 'pune-pimpri-chinchwad', 'pune-city', 'greater-kolkata', 'greater-chennai', 'new-delhi', 'navi-mumbai'];
  check('no alias spelling gets a page of its own', slugs.filter((x) => aliases.includes(x)), []);
  check('Bengaluru has one page and it is the big one', facets.cities[0]?.slug, 'bengaluru');
}

console.log('\n== what a facet page adds, and that it is stable ==');
{
  const f = facets.skills[0];
  const ins = facetInsights('skill', f.jobs);
  check('it names who is hiring', ins.employers.length > 0, true);
  check('ordered by count, then name', ins.employers.every((e, i, a) => i === 0 || a[i - 1].n > e.n || (a[i - 1].n === e.n && a[i - 1].name.localeCompare(e.name) <= 0)), true);
  check('at most twelve of each', [ins.employers.length <= 12, ins.other.length <= 12], [true, true]);
  const a = renderFacetPage('skill', f, facets.skills, { region, otherPages: new Set(facets.cities.map((c) => c.slug)) });
  const b = renderFacetPage('skill', f, facets.skills, { region, otherPages: new Set(facets.cities.map((c) => c.slug)) });
  check('two renders are byte-identical', a === b, true);
  const none = facetInsights('skill', [{ company: 'Acme', location: 'Pune', skills: [] }]);
  check('no pay line when nothing states pay', none.payLine, '');
}

console.log('\n== rendered: in the sitemap, announced, and every link resolves ==');
const dirs = [];
if (!jobs.length) check('India has a built board to render', false, true);
else {
  const dir = mkdtempSync(join(tmpdir(), 'interndoor-facets-IN-'));
  dirs.push(dir);
  /* An EMPTY directory, so every file written is a changed file. */
  const res = writePages(jobs, dir, [], { region });
  const list = (d) => existsSync(join(dir, d)) ? readdirSync(join(dir, d)).filter((f) => f.endsWith('.html') && f !== 'index.html') : [];
  const skillFiles = list('skills');
  const cityFiles = list('locations');
  check('skill pages are written', skillFiles.length > 0, true);
  check('location pages are written', cityFiles.length > 0, true);

  const locs = [...readFileSync(join(dir, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const facetLocs = locs.filter((l) => FACET_URL.test(l)).sort();
  const want = [...skillFiles.map((f) => `/skills/${f.slice(0, -5)}`), ...cityFiles.map((f) => `/locations/${f.slice(0, -5)}`), '/skills', '/locations'].sort();
  check('the sitemap lists exactly the facet pages written', facetLocs, want);
  check('IndexNow hears about them', (res.changedUrls ?? []).some((u) => FACET_URL.test(new URL(u).pathname)), true);

  const hrefs = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
  const broken = [];
  for (const [d, files] of [['skills', skillFiles], ['locations', cityFiles]]) {
    for (const f of files) {
      const html = readFileSync(join(dir, d, f), 'utf8');
      for (const h of hrefs(html, /href="\/companies\/([^"]+)"/g)) if (!existsSync(join(dir, 'companies', `${h}.html`))) broken.push(`${d}/${f} -> /companies/${h}`);
      for (const [dd, re] of [['skills', /href="\/skills\/([^"\/]+)"/g], ['locations', /href="\/locations\/([^"\/]+)"/g]]) {
        for (const h of hrefs(html, re)) if (!existsSync(join(dir, dd, `${h}.html`))) broken.push(`${d}/${f} -> /${dd}/${h}`);
      }
    }
  }
  check('every link a facet page adds resolves', broken.slice(0, 5), []);

  const jobFiles = readdirSync(join(dir, 'jobs')).filter((f) => f.endsWith('.html'));
  let linked = 0; const deadCity = [];
  for (const f of jobFiles) {
    const html = readFileSync(join(dir, 'jobs', f), 'utf8');
    for (const h of hrefs(html, /href="\/locations\/([^"\/]+)"/g)) { linked++; if (!existsSync(join(dir, 'locations', `${h}.html`))) deadCity.push(h); }
  }
  check('job pages link their city page', linked > 0, true);
  check('and every such link resolves', [...new Set(deadCity)], []);

  const jobLocs = locs.filter((l) => l.includes('/jobs/')).length;
  /* jobPageIndexable, not isIndexable: since 7 Oct 2026 a job page also needs
     evidence it is still open (`verified`, set by publish), and this reads the
     LIVE jobs.json. Counted with the bare quality bar it compared the sitemap
     against a different rule — 932 against 1,176 the first morning. */
  const indexableJobs = jobs.filter((j) => jobPageIndexable(j, region)).length;
  check('every indexable job page is in the sitemap', jobLocs, indexableJobs);
  check('and offered to the Indexing API', (res.indexUrls ?? []).length, indexableJobs);
  check('…and the evidence rule really is in force on the live data',
    jobs.some((j) => j.verified === false) ? indexableJobs < jobs.filter(isIndexable).length : true, true);
}

console.log('\n== the per-board switch still exists, and is deliberately empty ==');
{
  /* Pinned EMPTY rather than deleted. The mechanism is sound and re-adding a
     board is one code — this is what makes putting one back a deliberate act
     that has to change a test, instead of a change nothing notices. */
  check('NOINDEX_JOB_BOARDS is empty', [...NOINDEX_JOB_BOARDS], []);
  /* With the set empty, the board switch is a no-op and the quality bar is the
     only thing deciding — so these two must now agree on every board. If a
     board is ever re-listed this diverges and the check above fails first. */
  const good = { bullets: ['one', 'two'], title: 'Software Engineer Intern', company: 'Acme' };
  const thin = { bullets: ['only one'], title: 'Software Engineer Intern', company: 'Acme' };
  for (const code of ['IN', 'US', 'GB']) {
    check(`${code}: jobPageIndexable now equals the quality bar`,
      jobPageIndexable(good, { code }), isIndexable(good));
    check(`${code}: and a thin page is still refused`, jobPageIndexable(thin, { code }), false);
  }
}
for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
