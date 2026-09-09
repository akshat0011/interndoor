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
import { createHash } from 'node:crypto';
import { writePages, writeSite, CLOSED_ROLE_DAYS } from '../src/pages.js';
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

/* ============================================================================
   THE STUB'S INLINE SCRIPT MUST BE ALLOWED BY THE PRODUCTION CSP.

   This is the assertion whose absence let a broken stub ship. Every other check
   in this file passed while the script was blocked on all 16 live stubs, because
   nothing here ever hashed it. `script-src 'self'` plus sha256 hashes and no
   'unsafe-inline' means an inline script runs only if its EXACT BYTES are in
   web/vercel.json — and NO LOCAL SERVER SENDS THE HEADER, so a violation is
   invisible in every preview (§5).

   The first version interpolated the hub URL into the script, so every stub had
   a different hash and none could ever be allowlisted. That is why the second
   check below — two DIFFERENT employers producing the SAME hash — is the one
   that matters: it pins constant bytes, which is the only property that makes a
   single allowlist entry possible at all.
   ============================================================================ */
console.log('\n== THE CLOSED STUB IS ALLOWED BY THE PRODUCTION CSP ==');
{
  const csp = readFileSync(new URL('../web/vercel.json', import.meta.url), 'utf8');
  const scriptsIn = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hash = (body) => `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;

  const stubFor = (company, id) => {
    reset();
    const j = { ...job(id, 'Expiring Intern'), company };
    writePages([j, job(2, 'Surviving Intern')], DIR, [
      { company, id: String(id), title: 'Expiring Intern', roleLabel: 'x', postedAt: 0, skills: [] },
      ...HISTORY.slice(1),
    ], { region: R });
    const path = `${DIR}/us/jobs/${company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-expiring-intern-${id}.html`;
    writePages([job(2, 'Surviving Intern')], DIR, [
      { company, id: String(id), title: 'Expiring Intern', roleLabel: 'x', postedAt: 0, skills: [] },
      ...HISTORY.slice(1),
    ], { region: R });
    return readFileSync(path, 'utf8');
  };

  const a = stubFor('Acme Corp', 1);
  const bodies = scriptsIn(a);
  check('the stub carries exactly one inline script', bodies.length, 1);
  check('and the CSP allows it', csp.includes(hash(bodies[0])), true);

  /* THE MUTATION THAT MATTERS. Put the URL back in the script body and these
     two hashes diverge, so one allowlist entry can never cover both. */
  const b = stubFor('Globex Industries', 3);
  const bodiesB = scriptsIn(b);
  check('a different employer yields a different page', a !== b, true);
  check('but the SAME script hash — the bytes do not vary', hash(bodiesB[0]), hash(bodies[0]));
  check('and that one hash is the allowlisted one', csp.includes(hash(bodiesB[0])), true);

  /* The target has to survive somewhere the script can reach without being
     interpolated into it, or the constant-bytes trick silently redirects
     nowhere. Both stubs must name their own hub. */
  check('the hub is carried in the markup for the script to read',
    /data-hub="https:\/\/interndoor\.com\/us\/companies\/acme-corp"/.test(a), true);
  check('and the meta refresh still names it too',
    /http-equiv="refresh" content="0; url=https:\/\/interndoor\.com\/us\/companies\/acme-corp"/.test(a), true);
}

/* ============================================================================
   A DEMOTED POSTING'S URL ALSO GOES TO THE HUB — via `closable`, NOT `history`.

   146 of the dead URLs Google holds belong to postings that were published,
   indexed, and later demoted to is_tech = 0 by the classifier. They must not
   enter `history`, because that is what a hub is BUILT from and it would put
   non-engineering roles on an engineering board's hubs and move the indexable
   bar. They travel in a second list used for exactly one decision: which hub a
   dead job URL points at.
   ============================================================================ */
console.log('\n== A DEMOTED POSTING HANDS ITS URL OVER TOO ==');
const DEMOTED = `${DIR}/us/jobs/acme-corp-product-manager-intern-9.html`;
const demotedRow = { company: 'Acme Corp', id: '9', title: 'Product Manager Intern', roleLabel: 'x', postedAt: 0, skills: [] };
{
  reset();
  // It is live and publishable first — that is how its page came to exist.
  writePages([job(2, 'Surviving Intern'), job(9, 'Product Manager Intern')], DIR, HISTORY, { region: R });
  check('the demoted role had a page to begin with', existsSync(DEMOTED), true);

  // Now it is is_tech = 0: gone from the live set AND from history, present in closable.
  const r = writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R, closable: [demotedRow] });
  check('its URL still resolves', existsSync(DEMOTED), true);
  /* Read defensively. When this stub is missing the mutation under test has
     already failed the line above, and a bare readFileSync would THROW — which
     stops the whole `npm test` chain rather than failing one file (§1). */
  const html = existsSync(DEMOTED) ? readFileSync(DEMOTED, 'utf8') : '';
  check('it points at the employer hub', /data-hub="https:\/\/interndoor\.com\/us\/companies\/acme-corp"/.test(html), true);
  check('it names the employer, not the slug', html.includes('Acme Corp'), true);
  check('NO JobPosting markup', /JobPosting/.test(html), false);
  check('it is not counted as removed', r.removed, 0);
  check('and is handed to the indexing queue as a redirect, not a deletion',
    r.redirectUrls.some((u) => u.endsWith('/jobs/acme-corp-product-manager-intern-9')), true);
  check('never offered to Google as an indexable job page',
    r.indexUrls.some((u) => u.includes('product-manager')), false);

  /* THE SEPARATION, AND IT IS THE WHOLE REASON closable IS NOT history. */
  const hub = readFileSync(`${DIR}/us/companies/acme-corp.html`, 'utf8');
  check('the demoted role does NOT appear on the hub', hub.includes('Product Manager Intern'), false);
  const sitemap = readFileSync(`${DIR}/us/sitemap.xml`, 'utf8');
  check('nor in the sitemap', sitemap.includes('product-manager-intern-9'), false);
}

/* WITHOUT closable IT IS A 404, WHICH IS THE MUTATION THAT MATTERS. Passing the
   row in `history` instead would also make the stub appear — and would quietly
   put it on the hub — so the check above is what tells the two apart. */
{
  reset();
  writePages([job(2, 'Surviving Intern'), job(9, 'Product Manager Intern')], DIR, HISTORY, { region: R });
  const r = writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  check('a demoted role absent from closable is deleted outright', existsSync(DEMOTED), false);
  check('and counted as removed', r.removed, 1);
  check('and announced as a deletion',
    r.removedUrls.some((u) => u.endsWith('/jobs/acme-corp-product-manager-intern-9')), true);
}

/* AN EMPLOYER WITH NO HUB GETS NO STUB, whichever list the row travels in.
   The hub is the destination; without it the stub would point at a 404. */
{
  reset();
  const ghost = { ...job(9, 'Product Manager Intern'), company: 'Ghost Employer' };
  writePages([job(2, 'Surviving Intern'), ghost], DIR, HISTORY, { region: R });
  const path = `${DIR}/us/jobs/ghost-employer-product-manager-intern-9.html`;
  check('the ghost employer had a page', existsSync(path), true);
  writePages([job(2, 'Surviving Intern')], DIR, HISTORY,
    { region: R, closable: [{ ...demotedRow, company: 'Ghost Employer' }] });
  check('no hub, so no stub — it 404s', existsSync(path), false);
}

/* ============================================================================
   AND IT HAS TO SURVIVE writeSite, WHICH IS WHAT PRODUCTION ACTUALLY CALLS.

   Every check above calls writePages directly. Dropping `closable` from
   writeSite's per-region pass-through leaves all of them green while the
   feature does nothing at all on the live site — measured by mutation, not
   assumed. This is the §1 lesson about a guard that is only safe because of its
   callers, met from the other side: the guard works, the caller stops feeding it.
   ============================================================================ */
console.log('\n== closable reaches writePages THROUGH writeSite ==');
{
  reset();
  const jobsByRegion = new Map([['US', [job(2, 'Surviving Intern'), job(9, 'Product Manager Intern')]]]);
  const historyByRegion = new Map([['US', HISTORY]]);
  writeSite(jobsByRegion, DIR, historyByRegion, [R], {});
  check('the demoted role had a page after a real writeSite', existsSync(DEMOTED), true);

  const out = writeSite(new Map([['US', [job(2, 'Surviving Intern')]]]), DIR, historyByRegion, [R],
    { closableByRegion: new Map([['US', [demotedRow]]]) });
  check('writeSite hands closable down — the URL still resolves', existsSync(DEMOTED), true);
  check('and reports it as a redirect, not a removal',
    out.redirectUrls.some((u) => u.endsWith('/jobs/acme-corp-product-manager-intern-9')), true);
  check('nothing was removed', out.removedUrls.some((u) => u.includes('product-manager')), false);
}

/* THE CALL SITE, PINNED AT SOURCE. closableFrom is a pure function with its own
   tests, and writeSite is exercised above — but neither can see publish.js
   folding the two lists together before it passes them, which would put demoted
   roles on every hub. One line, and nothing else would fail. */
{
  const src = readFileSync(new URL('../src/publish.js', import.meta.url), 'utf8');
  check('history is grouped from history alone',
    /const historyByRegion = groupBy\(history\);/.test(src), true);
  check('closable is grouped separately',
    /const closableByRegion = groupBy\(closable\);/.test(src), true);
  check('and writeSite is given both',
    /closableByRegion \}\);/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
