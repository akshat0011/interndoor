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
  /* 8 OCT 2026: A PAGE THAT SAYS SO, NOT AN INSTANT REDIRECT. Readers from his
     LinkedIn posts landed on the employer's hub with nothing telling them the
     role had closed. The page now says it, names the role, offers the channel
     and shows what is open. */
  check('it links the company hub', html.includes('href="/us/companies/acme-corp"'), true);
  check('it does NOT redirect away', /http-equiv="refresh"/.test(html), false);
  check('it says the role has closed', /This role has closed/.test(html), true);
  check('it names the role that closed', html.includes('Expiring Intern'), true);
  check('it carries its close date', /data-closed-on="\d{4}-\d{2}-\d{2}"/.test(html), true);
  check('it offers the channel — never miss one again', /Never miss one again/.test(html), true);
  check('it shows the employer\'s other open role', /Open now at Acme Corp/.test(html) && html.includes('surviving-intern-2'), true);
  check('and the client-filled "Just landed" strip', /id="fresh"/.test(html), true);

  /* THE JOB MARKUP MUST BE GONE. The role no longer exists, so the page must
     stop describing one — that is Google's own documented remedy, and the
     manual-action risk is the reason the whole expiry exists. */
  check('NO JobPosting markup survives', /JobPosting/.test(html), false);
  check('no baseSalary either', /baseSalary/.test(html), false);

  /* NOINDEX,FOLLOW AND A SELF CANONICAL (8 Oct 2026). A page about a role that
     no longer exists must not be indexed — hundreds of them would be the thin
     profile the 7 Oct audit removed — and `follow` keeps its links counting. */
  check('it canonicalises to itself', /rel="canonical" href="https:\/\/interndoor\.com\/us\/jobs\/acme-corp-expiring-intern-1"/.test(html), true);
  check('and it is noindex,follow', /name="robots" content="noindex,follow"/.test(html), true);

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

console.log('\n== AN OLD REDIRECT STUB BECOMES THE NEW PAGE, KEEPING ITS DATE ==');
{
  reset();
  /* The ~800 stubs on disk before 8 Oct 2026 were the bare redirect. Each is
     re-rendered as the new page on the next publish, with the date it closed
     — not today's. */
  const stamp = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  mkdirSync(`${DIR}/us/jobs`, { recursive: true });
  writeFileSync(STUB, `<!doctype html><html lang="en" data-closed-on="${stamp}" data-hub="https://interndoor.com/us/companies/acme-corp"><head><meta http-equiv="refresh" content="0; url=https://interndoor.com/us/companies/acme-corp"></head><body></body></html>`);
  writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  const html = existsSync(STUB) ? readFileSync(STUB, 'utf8') : '';
  check('the old stub is now the new page', /This role has closed/.test(html) && !/http-equiv="refresh"/.test(html), true);
  check('it keeps the date it closed', html.includes(`data-closed-on="${stamp}"`), true);
  check('and says so in words', html.includes(`datetime="${stamp}"`), true);
  const before = html;
  writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  check('a second publish leaves it byte-identical', existsSync(STUB) && readFileSync(STUB, 'utf8') === before, true);
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
  /* THE LIVE ROLE IS LISTED, AND THAT IS THE POINT OF THE PAIR: the stub is out
     of the sitemap because it is a stub, not because of anything about this
     board. Between 19 and 22 Sep 2026 the US board's job pages were noindex
     (NOINDEX_JOB_BOARDS), so this check had to be inverted and the contrast
     borrowed from India; the set is empty again, so it reads the honest way
     round — same board, one listed and one not. */
  check('but the live role on the same board is', sitemap.includes('acme-corp-surviving-intern-2'), true);
  {
    const IN = regionOf('IN');
    writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: IN });
    check('and so it is on another board', readFileSync(`${DIR}/sitemap.xml`, 'utf8').includes('acme-corp-surviving-intern-2'), true);
  }
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
  check('each names its own hub', /href="\/us\/companies\/acme-corp"/.test(a), true);
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
  check('it links the employer hub', /href="\/us\/companies\/acme-corp"/.test(html), true);
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

/* ============================================================================
   THE CLOSED PAGE, DESIGN A — his pick of three mockups, 8 Oct 2026.
   A Closed pill (orange, never the green "open" one), the title in sentence
   case, a notice that counts what is open, a sidebar record counted the way
   the hub counts it, the role's own facts behind "Show details", and tiles
   with skills — on this page only, so no other page is rewritten.
   ============================================================================ */
console.log('\n== THE CLOSED PAGE, DESIGN A ==');
{
  reset();
  const RICH = [
    { ...HISTORY[0], location: 'San Diego, CA', workplaceType: 'Hybrid', employmentType: 'intern',
      experience: 'Graduating 2027', applicants: '42 applicants', postedAt: Date.parse('2026-08-01'),
      firstSeenAt: Date.parse('2026-07-20'), skills: ['python', 'sql'] },
    HISTORY[1],
  ];
  /* A third live role, so the live job page carries a tile of its own — the
     "live tiles are untouched" check below is vacuous on a page with none. */
  const third = job(3, 'Another Intern');
  writePages([job(1, 'Expiring Intern'), job(2, 'Surviving Intern'), third], DIR, RICH, { region: R });
  writePages([job(2, 'Surviving Intern'), third], DIR, RICH, { region: R });
  const html = existsSync(STUB) ? readFileSync(STUB, 'utf8') : '';
  const live = existsSync(LIVE) ? readFileSync(LIVE, 'utf8') : '';

  check('a Closed pill, never the green open one', /class="cr-closed"/.test(html) && !/jp-open is-likely/.test(html), true);
  check('it says the day it was taken down', /taken down <time datetime="\d{4}-\d{2}-\d{2}">/.test(html), true);
  check('the title is the sentence-case heading', html.includes('<h1 class="cr-h1">Expiring Intern</h1>'), true);
  check('the notice counts what is open — 2 open, 0 similar', html.includes('<b>2 roles like it are open right now</b>'), true);
  check('the facts line carries mode, kind and experience',
    ['<li>Hybrid</li>', '<li>Internship</li>', '<li>Graduating 2027</li>'].every((x) => html.includes(x)), true);

  /* THE RECORD IS THE HUB'S OWN COUNT: employerRows over live + past, deduped
     by id. Two rows (1 and 2), one of them live. */
  check('roles tracked, counted like the hub', html.includes('<dt>Roles tracked</dt><dd>3</dd>'), true);
  check('open now is the employer\'s LIVE count', html.includes('<dt>Open now</dt><dd>2</dd>'), true);
  check('tracked since the earliest first sighting', html.includes('<dt>Tracked since</dt><dd>Jul 2026</dd>'), true);
  check('where they hire', html.includes('<dt>Hires in</dt><dd>San Diego</dd>'), true);

  check('the original posting sits behind Show details', /<details class="cr-orig">/.test(html), true);
  check('…with its experience', html.includes('<dt>Experience</dt><dd>Graduating 2027</dd>'), true);
  check('…and the applicant count labelled as a snapshot', html.includes('<dt>Applicants when we listed it</dt><dd>42 applicants</dd>'), true);
  check('…and the skills it asked for', /<ul class="cr-chips"><li>Python<\/li><li>SQL<\/li><\/ul>/.test(html), true);
  check('the button says Hide once open (CSS only, no script)', /cr-show">Show details<\/span><span class="cr-hide">Hide details/.test(html), true);

  /* page.css IS VERSIONED ON THIS PAGE ONLY. The stylesheet is cached for a
     day; without the query a reader with yesterday's copy gets this layout
     unstyled. Every other page keeps the bare URL, so nothing else rewrites. */
  check('the closed page asks for page.css?v=', /href="\/page\.css\?v=\d+"/.test(html), true);
  check('a live job page keeps the bare page.css', live.includes('href="/page.css"') && !/page\.css\?v=/.test(live), true);

  check('its tiles carry skills and an arrow', /class="tile cr-tile"/.test(html) && /class="cr-go"/.test(html)
    && html.includes('<span class="cr-chips"><span>Python</span></span>'), true);
  check('the live page has tiles to compare', /class="tile"/.test(live), true);
  check('a live page\'s tiles do NOT', /cr-tile|cr-go|cr-chips/.test(live), false);
  check('the phone band leads to alerts on a board with no channel', /class="cr-band" href="\/us\/alerts"/.test(html), true);
  check('no style attribute (the CSP refuses them)', / style="/.test(html), false);
}
{
  /* A ROLE WE KNOW NOTHING ABOUT (title only) SHOWS NO EMPTY DETAILS BOX. */
  reset();
  writePages([job(1, 'Expiring Intern'), job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  writePages([job(2, 'Surviving Intern')], DIR, HISTORY, { region: R });
  const bare = existsSync(STUB) ? readFileSync(STUB, 'utf8') : '';
  check('a bare record renders no details box', /cr-orig/.test(bare), false);
  check('and no empty facts line', /<ul class="cr-facts">/.test(bare), false);
}
{
  const pub = readFileSync(new URL('../src/publish.js', import.meta.url), 'utf8');
  check('the history projection carries the experience line', /experience: row\.experience \|\| null,/.test(pub), true);
  const pages = readFileSync(new URL('../src/pages.js', import.meta.url), 'utf8');
  /* The chips must share the role-label line: on a line of their own they print
     an empty whitespace line into every tile on the site, and the first draft
     rewrote 2,173 files that way. */
  check('the tile chips add no line to an ordinary tile',
    /\$\{job\.roleLabel && !showCompany \? `<span class="tile-co">\$\{esc\(job\.roleLabel\)\}<\/span>` : ''\}\$\{asked\.length/.test(pages), true);
  const css = readFileSync(new URL('../web/public/page.css', import.meta.url), 'utf8');
  check('the light theme darkens the orange (measured 3.56 → 5.03)', /:root\[data-theme="light"\] \.cr-closed, :root\[data-theme="light"\] \.cr-alert b/.test(css), true);
  check('the Show/Hide swap is CSS', /\.cr-orig\[open\] \.cr-show, \.cr-orig:not\(\[open\]\) \.cr-hide \{ display: none; \}/.test(css), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
