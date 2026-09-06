/**
 * An expired job page hands its URL to the employer's hub instead of 404ing.
 *
 * WHY: on 6 Sep 2026 two of the five best-performing pages in Search Console
 * were already 404 — Continental (10 clicks, 427 impressions, the single best
 * page on the site) and Barclays (5 clicks, 123). Both had simply aged out of
 * the 30-day window. 15 of the site's 118 clicks pointed at nothing.
 *
 * The expiry itself is correct and must stay: serving a JobPosting past its
 * `validThrough` is the most direct route to a manual action across the whole
 * domain (§10). What changed is only what the URL does afterwards.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { writePages, CLOSED_ROLE_DAYS } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const DIR = '/tmp/interndoor-closedrole-test';
const R = regionOf('US');
const STUB = `${DIR}/us/jobs/acme-corp-expiring-intern-1.html`;
const LIVE = `${DIR}/us/jobs/acme-corp-surviving-intern-2.html`;

const job = (id, title) => ({
  id: String(id), title, company: 'Acme Corp', isTech: true, bullets: ['a', 'b'],
  employmentType: 'intern', location: 'San Diego, CA',
  postedAt: Date.parse('2026-08-01'), firstSeenAt: Date.parse('2026-08-01'), skills: ['python'],
});
const HISTORY = [
  { company: 'Acme Corp', id: '1', title: 'Expiring Intern', roleLabel: 'x', postedAt: 0, skills: [] },
  { company: 'Acme Corp', id: '2', title: 'Surviving Intern', roleLabel: 'x', postedAt: 0, skills: [] },
];

function reset() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/index.html`, readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8'));
}

console.log('\n== AN EXPIRED PAGE BECOMES A POINTER TO THE HUB, NOT A 404 ==');
{
  reset();
  writePages([job(1, 'Expiring Intern'), job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  check('both pages exist first', existsSync(STUB) && existsSync(LIVE), true);

  const r = writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  check('the expired URL still resolves', existsSync(STUB), true);
  /* NOT counted as removed and NOT announced as deleted: the URL answers 200,
     it has only stopped being a JobPosting. */
  check('and is not counted as removed', r.removed, 0);
  check('nor announced as a deletion', r.removedUrls.length, 0);
  /* Same treatment as a dedupe stub — anything owed on it in the indexing
     queue has to be forgotten, because the queue takes JobPosting pages only. */
  check('it is reported for the indexing queue', r.redirectUrls.some((u) => u.endsWith('/jobs/acme-corp-expiring-intern-1')), true);

  const html = readFileSync(STUB, 'utf8');
  check('it points at the company hub', html.includes('/us/companies/acme-corp'), true);
  check('with a zero-second refresh', /http-equiv="refresh" content="0;/.test(html), true);

  /* THE JOB MARKUP MUST BE GONE. The role no longer exists, so the page must
     stop describing one — that is Google's own documented remedy, and the
     manual-action risk is the reason the whole expiry exists. */
  check('NO JobPosting markup survives', /JobPosting/.test(html), false);
  check('no baseSalary either', /baseSalary/.test(html), false);

  /* NO rel=canonical, and this is the difference from renderJobRedirect. A
     reposted role IS the same posting, so pointing its canonical at the winner
     is honest. A closed role and a company hub are DIFFERENT content. */
  check('NO canonical is claimed', /rel="canonical"/.test(html), false);
  /* noindex would stop Google following the hint at all, which defeats it. */
  check('and it is not noindexed', /noindex/.test(html), false);

  check('the surviving page is untouched', /JobPosting/.test(readFileSync(LIVE, 'utf8')), true);
}

console.log('\n== IT SURVIVES THE NEXT PUBLISH, AND DOES NOT CHURN ==');
{
  /* THE STUB BRANCH IN THE SWEEP IS THE ONLY THING KEEPING THIS FILE. A stub
     is never in `wanted` — it is not a live posting — so without that branch
     recognising it, the next publish deletes the previous publish's output.
     Mutating it away is what this pins. */
  const before = readFileSync(STUB, 'utf8');
  writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  check('still there after a second publish', existsSync(STUB), true);
  /* §10: two publishes of the same input must be byte-identical. Rewriting the
     stamp every run would rewrite every closed page 48 times a day. */
  check('byte-identical — no churn', readFileSync(STUB, 'utf8') === before, true);
}

console.log('\n== IT IS BOUNDED, OR IT IS A DOORWAY FARM ==');
{
  /* 7-24 postings expire a day. Unbounded that is thousands of near-identical
     pages in a PUBLIC repo, and §11 refuses thin facet pages for exactly that
     reason. */
  check('the window is 90 days', CLOSED_ROLE_DAYS, 90);

  const stub = readFileSync(STUB, 'utf8');
  writeFileSync(STUB, stub.replace(/data-closed-on="[^"]+"/, 'data-closed-on="2026-05-01"'));
  const r = writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  check('an aged stub IS deleted', existsSync(STUB), false);
  check('and counted as removed', r.removed, 1);
  /* Only NOW is it a deletion, because only now does the URL stop resolving. */
  check('and announced as a deletion', r.removedUrls.some((u) => u.endsWith('/jobs/acme-corp-expiring-intern-1')), true);
}

console.log('\n== NO HUB MEANS THE OLD BEHAVIOUR, NOT A BROKEN POINTER ==');
{
  /* A stub aiming at a hub that is not written would be a redirect to a 404,
     which is worse than the 404 it replaced. */
  writeFileSync(`${DIR}/us/jobs/ghost-employer-some-role-999.html`, '<html>an old job page</html>');
  const r = writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  check('an unknown slug is deleted outright', existsSync(`${DIR}/us/jobs/ghost-employer-some-role-999.html`), false);
  check('and counted as removed', r.removed, 1);
}

console.log('\n== A STUB IS NOT A LISTING ==');
{
  reset();
  writePages([job(1, 'Expiring Intern'), job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  const r = writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });

  /* A sitemap may never list a page carrying no content of its own, and §11's
     standing rule is that it may never list anything Google is told not to
     index. The stub is not in `jobs`, so neither the sitemap nor indexUrls nor
     the crawlable homepage block can reach it — asserted rather than assumed. */
  const sitemap = readFileSync(`${DIR}/us/sitemap.xml`, 'utf8');
  check('the sitemap does not list it', sitemap.includes('acme-corp-expiring-intern-1'), false);
  check('but does list the live role', sitemap.includes('acme-corp-surviving-intern-2'), true);
  check('the indexing queue is not offered it', r.indexUrls.some((u) => u.includes('expiring')), false);
  const home = readFileSync(`${DIR}/us/index.html`, 'utf8');
  check('the crawlable block does not link it', home.includes('acme-corp-expiring-intern-1'), false);

  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
