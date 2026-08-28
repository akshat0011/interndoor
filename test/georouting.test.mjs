/**
 * Sending a reader to their own board — and not breaking indexing doing it.
 *
 * Two mechanisms, and they do different jobs. hreflang is what decides which
 * page GOOGLE shows an American searching "<company> internships"; the edge
 * redirect only catches someone who typed the apex. The redirect is the one
 * that can do damage, because Googlebot crawls from US IPs: redirect it and
 * the India board — the primary asset — may never be indexed at all.
 */
import { readFileSync } from 'node:fs';
import { renderCompanyPage, renderJobPage } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const IN = regionOf('IN'), US = regionOf('US');
const job = { id: '1', company: 'Amazon', title: 'SDE Intern', location: 'Seattle, WA',
  url: 'https://linkedin.com/jobs/view/1', postedAt: Date.now(), firstSeenAt: Date.now(), isTech: true };

console.log('\n== a hub HAS a regional equivalent; a vacancy does not ==');
const multi = renderCompanyPage('Amazon', [job], [], '', { region: IN, alsoIn: [US] });
ok('a multi-region hub points at its twin', multi.includes('hreflang="en-US" href="https://interndoor.com/us/companies/amazon"'));
ok('…and back at itself', multi.includes('hreflang="en-IN" href="https://interndoor.com/companies/amazon"'));
ok('…with an x-default', multi.includes('hreflang="x-default"'));

/* eBay has two India postings and none in the US, so /us/companies/ebay does
   not exist. Advertising it would point Google at a 404 and, being
   non-reciprocal, be ignored anyway. No amount of markup creates supply. */
const solo = renderCompanyPage('eBay', [job], [], '', { region: IN, alsoIn: [] });
check('a hub with no twin advertises nothing', (solo.match(/hreflang=/g) || []).length, 0);

/* THIS MUST NOT CHANGE. A vacancy in Seattle is not a regional variant of a
   different vacancy in Bengaluru, and saying so tells Google two unrelated
   URLs are the same page. */
const jp = renderJobPage(job, [], { region: IN });
check('a job page still emits NO hreflang', (jp.match(/hreflang=/g) || []).length, 0);

console.log('\n== every page tells the script which board it is ==');
ok('the region meta is in head()', multi.includes('<meta name="interndoor-region" content="IN">'));
ok('…on job pages too', jp.includes('<meta name="interndoor-region" content="IN">'));

console.log('\n== the edge redirect cannot hurt indexing ==');
const vercel = JSON.parse(readFileSync('web/vercel.json', 'utf8'));
const geo = vercel.redirects.filter((r) => (r.has ?? []).some((h) => h.key === 'x-vercel-ip-country'));
ok('there are geo redirects', geo.length >= 2);

/* A 308 on the apex would hand the India board's ranking to /us permanently.
   This is a nudge, not a move. */
ok('every geo redirect is TEMPORARY', geo.every((r) => r.permanent === false));

/* The apex only. A deep link into any region must never be bounced — an
   American opening an India job page asked for that page. */
check('they apply to the apex alone', [...new Set(geo.map((r) => r.source))], ['/']);

/* THE LOAD-BEARING ONE. Googlebot crawls from US IPs; redirecting it means the
   India homepage may never be indexed. */
for (const r of geo) {
  const uaRule = (r.missing ?? []).find((m) => m.key === 'user-agent');
  ok(`${r.destination} exempts crawlers`, !!uaRule);
  for (const bot of ['googlebot', 'bingbot', 'crawler', 'spider']) {
    ok(`  …including ${bot}`, new RegExp(uaRule.value).test(`Mozilla/5.0 (compatible; ${bot}/2.1)`));
  }
  ok(`${r.destination} respects a chosen board`, (r.missing ?? []).some((m) => m.type === 'cookie' && m.key === 'board'));
}

/* A real browser must still be nudged, or the exemption is too broad. */
const ua = geo[0].missing.find((m) => m.key === 'user-agent').value;
ok('an ordinary browser is NOT exempt',
  !new RegExp(ua).test('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36'));

console.log('\n== the legacy /in redirects are untouched ==');
ok('/in still folds into the root', vercel.redirects.some((r) => r.source === '/in' && r.destination === '/' && r.permanent === true));

console.log('\n== the scripts set the cookie the redirect reads ==');
for (const f of ['web/public/app.js', 'web/public/page.js']) {
  ok(`${f} sets board=`, readFileSync(f, 'utf8').includes("'board=' + __board"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
