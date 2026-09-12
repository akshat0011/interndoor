/**
 * /contact — one page, one address, three boards.
 *
 * The page itself is nearly all prose, so what is worth pinning is not its
 * copy but the four ways this particular design dies quietly:
 *
 *   1. IT IS WRITTEN ONCE, AT THE ROOT. Every other page here is written per
 *      region; this one is not, and a US or UK render that starts writing its
 *      own copy gives the site three near-identical indexable URLs on a domain
 *      whose measured problem is crawl scarcity.
 *   2. THE FOOTER LINK MUST NOT BE REGIONALISED. foot() links /contact
 *      root-relative from ~4,000 pages across all three trees. Wrap it in
 *      regionHref — or add it to REGION_LINKS — and every US and UK page links
 *      to a 404, which no sitemap report would ever flag.
 *   3. IT MUST BE IN publishedPaths(). A generated page missing from that list
 *      is written every run and pushed never. Five pages have been lost this
 *      way; §5 of CLAUDE.md counts them.
 *   4. THE ADDRESS IS THE POINT. A contact page that has lost its email, or
 *      grown a second spelling of it, is worse than no contact page.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderContactPage, writePages, CONTACT_EMAIL } from '../src/pages.js';
import { publishedPaths } from '../src/publish.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const IN = regionOf('IN');
const US = regionOf('US');
const html = renderContactPage({ region: IN });

console.log('\n== THE ADDRESS ==');
{
  check('the constant is the mailbox that exists', CONTACT_EMAIL, 'akshat@interndoor.com');
  /* Visible text AND a real mailto. Either one alone is a half-finished
     contact page: text with no link is a copy-paste chore, and a link whose
     label is "email us" hides the address from anybody reading the page in a
     search result or with a screen reader. */
  ok('the address is visible in the body', html.includes(`<span class="chan-n">${CONTACT_EMAIL}</span>`));
  ok('it is a real mailto', html.includes(`href="mailto:${CONTACT_EMAIL}?subject=`));
  ok('and in the meta description, which is what a searcher sees',
    new RegExp(`name="description" content="[^"]*${CONTACT_EMAIL}`).test(html));

  /* ONE SPELLING. A second address anywhere on this page is a mailbox nobody
     reads — the whole reason CONTACT_EMAIL is a constant. */
  const found = [...new Set(html.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [])]
    .filter((a) => !a.endsWith('@college.edu')); // the signup form's placeholder
  check('exactly one address on the page', found, [CONTACT_EMAIL]);
}

console.log('\n== ONE PAGE, WRITTEN ONCE, AT THE ROOT ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'interndoor-contact-'));
  try {
    writePages([], dir, [], { region: IN });
    ok('the root render writes contact.html', existsSync(join(dir, 'contact.html')));

    writePages([], dir, [], { region: US });
    /* THE ASSERTION THAT MATTERS. US must not write its own copy — three
       identical indexable pages is the duplicate every other page here goes
       out of its way to avoid, and it would cost crawls the US board does not
       have to spare. */
    check('the US render writes none of its own', existsSync(join(dir, 'us', 'contact.html')), false);

    ok('it is in the published allowlist',
      publishedPaths().includes('web/public/contact.html'));

    /* The root sitemap lists it; a region sitemap must not, because that tree
       does not contain the URL. */
    const rootMap = readFileSync(join(dir, 'sitemap.xml'), 'utf8');
    const usMap = readFileSync(join(dir, 'us', 'sitemap.xml'), 'utf8');
    ok('the root sitemap lists /contact', rootMap.includes('<loc>https://interndoor.com/contact</loc>'));
    check('the US sitemap does not', /contact/.test(usMap), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('\n== THE FOOTER LINK REACHES IT FROM EVERY BOARD ==');
{
  const src = readFileSync(new URL('../src/pages.js', import.meta.url), 'utf8');
  /* Root-relative, and never through regionHref. Both spellings below would
     render /us/contact, which is not written. */
  ok('foot() links it root-relative', src.includes('<a href="/contact">Contact</a>'));
  check('never through regionHref', /regionHref\('\/contact'/.test(src), false);
  check('and never added to REGION_LINKS', /REGION_LINKS = \[[^\]]*'\/contact'/.test(src), false);

  /* A rendered page from EACH tree, because the bug this guards against only
     shows up outside the root. */
  const dir = mkdtempSync(join(tmpdir(), 'interndoor-contactlink-'));
  try {
    for (const region of [IN, US]) {
      writePages([], dir, [], { region });
      const root = join(dir, ...(region.slug ? [region.slug] : []));
      const alerts = readFileSync(join(root, 'alerts.html'), 'utf8');
      ok(`${region.code}'s /alerts footer links /contact`,
        alerts.includes('<a href="/contact">Contact</a>'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }

  /* The two hand-written pages carry their own copy of the same row, so they
     drift silently. So does the board, whose footer is hand-authored. */
  for (const rel of ['careers/index.html', 'careers/software-engineering-intern.html']) {
    const s = readFileSync(new URL(`../web/public/${rel}`, import.meta.url), 'utf8');
    ok(`${rel} carries the link too`, s.includes('<a href="/contact">Contact</a>'));
  }
  const board = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  ok('the board footer carries it', board.includes('href="/contact"'));

  /* AND IT SURVIVES localiseLinks, which is the half of this that a source
     grep cannot see. index.html is ONE template for all three boards and
     every href in REGION_LINKS is rewritten under the region's prefix as it is
     copied. /contact must come out the other side unprefixed — so this renders
     the US board from the real template and reads the link back. */
  const dir2 = mkdtempSync(join(tmpdir(), 'interndoor-contactboard-'));
  try {
    writeFileSync(join(dir2, 'index.html'), board);
    writePages([], dir2, [], { region: US });
    const usBoard = readFileSync(join(dir2, 'us', 'index.html'), 'utf8');
    ok('the US board still links /contact', usBoard.includes('href="/contact"'));
    /* href-scoped on purpose. A bare substring test failed here on the
       explanatory comment beside the link, which names the wrong URL in order
       to warn about it — the assertion is about what the page LINKS to. */
    check('and never links /us/contact', /href="\/us\/contact"/.test(usBoard), false);
    // The control: a REGION_LINKS entry in the same footer IS rewritten, so a
    // pass above cannot be localiseLinks quietly doing nothing.
    ok('while /companies in the same file IS localised', usBoard.includes('href="/us/companies"'));
  } finally { rmSync(dir2, { recursive: true, force: true }); }
}

console.log('\n== IT SURVIVES PRODUCTION ==');
{
  /* The CSP ships `script-src 'self'` plus a hash allowlist and no
     'unsafe-inline', so an inline script whose sha256 is absent is silently
     blocked in production and works perfectly on every local server. This is
     the trap /careers already fell into. */
  const csp = JSON.parse(readFileSync(new URL('../web/vercel.json', import.meta.url), 'utf8'))
    .headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  const blocked = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    // ld+json is data, not code — CSP script-src does not apply to it.
    if (/application\/ld\+json/.test(m[1])) continue;
    const h = `sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}`;
    if (!csp.includes(h)) blocked.push(m[2].slice(0, 40));
  }
  check('no inline script the CSP would block', blocked, []);
  check('no inline style either', /<style|\sstyle="/.test(html), false);

  check('indexable — this is a page we WANT found', /noindex/.test(html), false);
  ok('canonical is the root URL', html.includes('<link rel="canonical" href="https://interndoor.com/contact">'));

  /* alternatePath: null. There is no /us/contact, so an hreflang pointing at
     one is a 404 advertised to Google as this page in another language —
     exactly the bug that once shipped "https://interndoor.comnull" on every
     job page. */
  check('no hreflang alternates', /rel="alternate" hreflang/.test(html), false);

  /* …but the switcher still renders when alternates are passed, which is the
     only way back to their own board for a reader who arrived from one. */
  /* The three regions config.json actually publishes, spelled out rather than
     read from config: publishedRegions() with no config defaults to ['IN']
     alone, and a switcher with one option is furniture that regionSwitch
     correctly declines to render. What is being pinned here is the production
     path, where writePages passes all three. */
  const withAlts = renderContactPage({ region: IN, alternates: ['IN', 'US', 'GB'].map(regionOf) });
  ok('the region switcher renders when alternates are passed',
    withAlts.includes('id="region-switch"'));
  check('and still no hreflang', /rel="alternate" hreflang/.test(withAlts), false);
}

console.log('\n== THE MARKUP SAYS WHO WE ARE ==');
{
  const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  ok('there is a JSON-LD block', !!block);
  const ld = JSON.parse(block);
  check('it is an Organization', ld['@type'], 'Organization');
  check('carrying the address', ld.email, CONTACT_EMAIL);
  /* No phone and no postal address, deliberately: there is neither, and
     inventing one is the same class of error as an invented stipend. */
  check('and inventing no phone', ld.telephone, undefined);
  check('nor an office', ld.address, undefined);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
