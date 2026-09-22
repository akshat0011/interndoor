/**
 * SKILL AND LOCATION PAGES ARE WRITTEN BUT KEPT OUT OF THE INDEX — 14 SEP 2026.
 *
 * His decision after Google stopped ranking the site on 11 Sep: a /skills/ or
 * /locations/ page is a template over rows the board already shows, the purest
 * scaled-content page here, and it drew ~1,300 impressions and 2 clicks over
 * 1-10 Sep. Three places have to agree, and each one alone is a half-fix:
 *
 *   - the page's own `noindex`, or Google keeps it;
 *   - the sitemap, which may never list a noindex URL;
 *   - IndexNow's changed-URL list, or Bing is asked to fetch what it must ignore.
 *
 * AND WHAT MUST NOT MOVE: the pages still exist (job pages and hubs link to
 * them), and every indexable job page — US included, which he chose to keep —
 * is still in its sitemap.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePages, renderFacetPage, renderFacetIndex, isIndexable, FACETS_INDEXABLE, NOINDEX_JOB_BOARDS, jobPageIndexable } from '../src/pages.js';
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
const liveJobs = (slug) => {
  const f = join('web', 'public', ...(slug ? [slug] : []), 'data', 'jobs.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).jobs ?? []) : [];
};

check('the switch is off', FACETS_INDEXABLE, false);

console.log('\n== the pages say noindex ==');
{
  const region = regionOf('US');
  const facets = facetGroups(liveJobs('us').filter(isIndexable));
  /* Without facets to render every assertion below passes vacuously. */
  check('the US board has skill and city facets to test against', [facets.skills.length >= 3, facets.cities.length >= 3], [true, true]);
  const skill = renderFacetPage('skill', facets.skills[0], facets.skills, { region });
  const city = renderFacetPage('city', facets.cities[0], facets.cities, { region });
  check('a skill page is noindex', NOINDEX.test(skill), true);
  check('a location page is noindex', NOINDEX.test(city), true);
  check('and still follow — the links on it count', /content=["']noindex,follow["']/.test(skill), true);
  check('the skills index is noindex even with plenty of skills', NOINDEX.test(renderFacetIndex('skill', facets.skills, { region })), true);
  check('the locations index likewise', NOINDEX.test(renderFacetIndex('city', facets.cities, { region })), true);
}

console.log('\n== written, but not in a sitemap and not announced ==');
const dirs = [];
for (const [code, slug] of [['IN', ''], ['US', 'us']]) {
  const jobs = liveJobs(slug);
  if (!jobs.length) { check(`${code} has a built board to render`, false, true); continue; }
  const region = regionOf(code);
  const dir = mkdtempSync(join(tmpdir(), `interndoor-facets-${code}-`));
  dirs.push(dir);
  /* An EMPTY directory, so every file written is a changed file and would be in
     changedUrls if it were tracked. */
  const res = writePages(jobs, dir, [], { region });
  const root = join(dir, ...(slug ? [slug] : []));

  const skillFiles = existsSync(join(root, 'skills')) ? readdirSync(join(root, 'skills')).filter((f) => f !== 'index.html') : [];
  check(`${code}: skill pages are still written`, skillFiles.length > 0, true);
  check(`${code}: and the skills index`, existsSync(join(root, 'skills', 'index.html')), true);

  const locs = [...readFileSync(join(root, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check(`${code}: no skill or location URL in the sitemap`, locs.filter((l) => FACET_URL.test(new URL(l).pathname)), []);
  check(`${code}: none announced to IndexNow`, (res.changedUrls ?? []).filter((u) => FACET_URL.test(new URL(u).pathname)), []);
  /* NO BOARD'S JOB PAGES ARE noindex any more. The US board was, from 19 Sep
     2026 until the reversal on 22 Sep; NOINDEX_JOB_BOARDS is now empty, so
     every board is asserted the SAME way and there is no per-board branch left
     to rot. The facets keep their three-way treatment — that is what this file
     is really about, and it is unchanged. */
  const jobLocs = locs.filter((l) => new URL(l).pathname.includes('/jobs/')).length;
  check(`${code}: IndexNow hears about its job pages`, (res.changedUrls ?? []).some((u) => new URL(u).pathname.includes('/jobs/')), true);
  check(`${code}: and about its hubs`, (res.changedUrls ?? []).some((u) => new URL(u).pathname.includes('/companies/')), true);
  check(`${code}: every indexable job page is in the sitemap`, jobLocs, jobs.filter(isIndexable).length);
  check(`${code}: and offered to the Indexing API`, (res.indexUrls ?? []).length, jobs.filter(isIndexable).length);
  check(`${code}: no job page is noindex`, (() => {
    const f = readdirSync(join(root, 'jobs')).find((x) => x.endsWith('.html'));
    return f ? /<meta name="robots" content="noindex/.test(readFileSync(join(root, 'jobs', f), 'utf8')) : null;
  })(), false);
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
