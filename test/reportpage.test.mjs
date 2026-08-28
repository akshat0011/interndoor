/**
 * /report — the board's own statistics.
 *
 * This is the only page on the site that does not expire, which makes it the
 * only one that can accumulate links over years, which makes it the one most
 * likely to be quoted by somebody who will not check. Everything pinned here is
 * about it staying quotable:
 *
 *  - it must never name where listings come from (a deliberate decision from
 *    10 Aug, reversed nowhere else on the site),
 *  - it must never restate the `stipendStatus` claim that named employers do
 *    not pay their interns,
 *  - and it has to actually ship, which on this repo means being in the
 *    PUBLISHED allowlist rather than merely being written.
 */
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReportPage, REPORT_MIN_FACTS, writePages } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const IN = regionOf('IN');
const ALL = ['IN', 'US', 'GB'].map(regionOf);
const ASOF = Date.UTC(2026, 7, 28, 6, 0);

const fact = (i) => ({
  id: `f${i}`, value: 10 + i, of: 400, sample: 400,
  headline: `Only ${10 + i} of 400 engineering internships did the thing`,
  detail: 'the other 390 did not',
});
const facts = (n) => Array.from({ length: n }, (_, i) => fact(i));

const page = renderReportPage(facts(8), { region: IN, alternates: ALL, asOf: ASOF, days: 30 });

console.log('\n== it is a real, indexable, citable page ==');
ok('canonical is /report', page.includes('<link rel="canonical" href="https://interndoor.com/report">'));
ok('it is indexable above the bar', !page.includes('noindex'));
ok('it stamps the date it was measured', page.includes('28 August 2026'));
ok('…and says the numbers move', /regenerated daily|Updated daily/i.test(page));
// jsonLd() minifies, so match without assuming whitespace.
ok('it carries Article structured data', /"@type"\s*:\s*"Article"/.test(page));
ok('…dated, so a citation can be checked', page.includes('"datePublished"'));
ok('every region has an equivalent, so hreflang is emitted',
  page.includes('hreflang="en-US"') && page.includes('hreflang="en-GB"'));

console.log('\n== a thin region is written but NOT indexed ==');
/* The page is still written because foot() links it from ~950 generated pages
   and a link that 404s is worse than a page that says little. The bar decides
   indexing, not existence — the same call company hubs already make. */
const thin = renderReportPage(facts(REPORT_MIN_FACTS - 1), { region: regionOf('GB'), asOf: ASOF });
ok('below the bar it is noindex', thin.includes('noindex'));
ok('…but still a whole page', thin.includes('How this was measured'));
ok('at the bar it is indexable',
  !renderReportPage(facts(REPORT_MIN_FACTS), { region: IN, asOf: ASOF }).includes('noindex'));

console.log('\n== the methodology does not say where listings come from ==');
/* Reversed nowhere else on the site since 10 Aug: the README note, the
   homepage, the generated footers and the hub lede were all changed at once,
   and a methodology section is exactly where it would creep back in. */
for (const word of ['LinkedIn', 'Greenhouse', 'Lever', 'Ashby', 'Workday', 'SmartRecruiters', 'scrape', 'scraped', 'scraping']) {
  ok(`never says "${word}"`, !new RegExp(word, 'i').test(page));
}

console.log('\n== it never repeats the stipendStatus claim ==');
ok('the word "unpaid" never appears as OUR claim about an employer',
  !/\bare unpaid\b|\bexplicitly unpaid\b|employers? (?:do|does) not pay/i.test(page));
ok('and it says outright that silence is not unpaid',
  page.includes('does not mean unpaid'));

console.log('\n== the class collision that would have gone unnoticed ==');
/* page.css already uses `.stat` for the company hub at-a-glance tile, and
   `.stat span` would have rendered these figures as a 9.5px uppercase label.
   Same class as the `.gist` bug. */
ok('it uses rp-stat, not the taken .stat', page.includes('class="rp-stat"'));
ok('no bare class="stat"', !/class="stat"/.test(page));
const css = readFileSync('web/public/page.css', 'utf8');
ok('page.css defines the rp- classes it renders', css.includes('.rp-stat-h') && css.includes('.rp-stat-n'));

console.log('\n== it actually ships ==');
/* A generated page missing from the allowlist is written every run and pushed
   never, which is indistinguishable from a page that renders wrong. India has
   to be named; every other region is covered by regionPaths() by directory. */
const pub = readFileSync('src/publish.js', 'utf8');
ok("web/public/report.html is in the PUBLISHED allowlist", pub.includes("'web/public/report.html'"));

console.log('\n== writePages writes it, and the sitemap agrees ==');
const dir = mkdtempSync(join(tmpdir(), 'interndoor-report-'));
writePages([], dir, [], { region: IN, stats: { facts: facts(8), asOf: ASOF, days: 30 } });
ok('report.html is written', existsSync(join(dir, 'report.html')));
const sm = readFileSync(join(dir, 'sitemap.xml'), 'utf8');
ok('an indexable report is in the sitemap', sm.includes('https://interndoor.com/report<'));

const dir2 = mkdtempSync(join(tmpdir(), 'interndoor-report-thin-'));
writePages([], dir2, [], { region: IN, stats: { facts: facts(1), asOf: ASOF, days: 30 } });
ok('a thin report is still written, so the footer link resolves', existsSync(join(dir2, 'report.html')));
ok('…but is kept OUT of the sitemap, not advertised as noindex',
  !readFileSync(join(dir2, 'sitemap.xml'), 'utf8').includes('https://interndoor.com/report<'));

console.log('\n== every generated page can reach it ==');
ok('foot() links it', readFileSync('src/pages.js', 'utf8').includes(">The numbers</a>"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
