/**
 * The daily digest, as HTML.
 *
 * This is the ONE email this site sends, it goes out unattended every morning
 * with `digest.mode: "send"`, and nobody reads it before the subscribers do.
 * So the things pinned here are the ones that would reach a real inbox broken:
 *
 *   1. GMAIL CLIPS OVER ~102KB, replacing the tail with "[Message clipped]".
 *      A busy day is 25 eligible roles; unbudgeted that renders 130KB and the
 *      last third of the digest, the board button and the unsubscribe link all
 *      end up behind a click.
 *   2. NO SVG. Gmail, Outlook and Yahoo all refuse it, and the site's masthead
 *      radar is inline SVG — so the mail carries a PNG, which has to exist and
 *      has to be in the published allowlist.
 *   3. THE COLOURS ARE COPIED FROM styles.css BY HAND, because email needs
 *      literal values inline. Copied constants drift; these are read back out
 *      of the stylesheet here, which is the only thing making that safe.
 *   4. THE COUNTS MUST ADD UP. Two separate caps can trim the card list, and a
 *      digest that says "and 6 more" when it means 256 is lying to the reader.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderDigestEmail } from '../src/digestmail.js';
import { publishedPaths } from '../src/publish.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IN = regionOf('IN');
const cfg = { utm: {} };

/** A role with everything filled in — the biggest card the renderer can make. */
const rich = (i = 1) => ({
  job_id: `900${i}`, id: `900${i}`,
  company: 'Acme Systems', title: `Backend Engineering Intern ${i}`,
  location: 'Bengaluru, Karnataka, India', workplace_type: 'Hybrid',
  stipend: '₹50,000', stipend_period: 'month', duration: '6 months',
  keySkills: ['python', 'sql', 'docker', 'kubernetes'],
  bullets: ['Build and ship data pipelines end to end', 'Work with the platform team on latency'],
  url: 'https://example.com/j', applyUrl: 'https://example.com/apply',
  postedAt: Date.now(), first_seen_at: Date.now(),
});
const render = (rows, opts = {}) =>
  renderDigestEmail(rows, cfg, { region: IN, code: 'IN', now: Date.UTC(2026, 8, 12), ...opts });

console.log('\n== IT FITS IN GMAIL, WHATEVER THE DAY BRINGS ==');
{
  /* 25 is MAX_ROLES in src/digest.js — the most the composer can ever hand
     over. Cards are ~4.8KB, so unbudgeted this is ~130KB. */
  const many = Array.from({ length: 25 }, (_, i) => rich(i));
  const html = render(many, { total: 275 });
  const bytes = Buffer.byteLength(html, 'utf8');
  ok(`a full digest is under 102KB (${bytes} bytes)`, bytes < 102_400);
  /* And meaningfully under, not scraping it: the headers and the plain-text
     alternative Buttondown generates are also in the message and invisible
     here. */
  ok('with real headroom for the headers Buttondown adds', bytes < 96_000);

  /* The budget must TRIM, not merely happen to fit — otherwise this passes
     against a renderer with no budget at all on a day of small cards. */
  const cards = (html.match(/See the role/g) ?? []).length;
  ok(`it dropped cards to get there (${cards} of 25 shown)`, cards < 25);
  ok('but kept a useful number of them', cards >= 10);

  /* A single enormous posting still goes out. An empty digest is not a digest. */
  const one = render([rich(1)], { total: 1 });
  check('one role always renders one card', (one.match(/See the role/g) ?? []).length, 1);
}

console.log('\n== THE COUNTS ADD UP, WHICHEVER CAP BIT ==');
{
  for (const [given, total] of [[25, 275], [25, 25], [6, 6], [1, 1]]) {
    const html = render(Array.from({ length: given }, (_, i) => rich(i)), { total });
    const cards = (html.match(/See the role/g) ?? []).length;
    const more = Number(html.match(/and (\d+) more on the board/)?.[1] ?? 0);
    check(`${given} given of ${total}: cards + more = total`, cards + more, total);
    /* The headline states the true total, never how many fitted. */
    ok(`${given} of ${total}: the headline says ${total}`,
      new RegExp(`${total} new engineering`).test(html));
  }
  /* No dangling "and 0 more". */
  const exact = render([rich(1), rich(2)], { total: 2 });
  check('nothing left over says nothing', /more on the board/.test(exact), false);
}

console.log('\n== NOTHING IN IT IS EMAIL-FATAL ==');
{
  const html = render([rich(1), rich(2)], { total: 2 });
  /* Gmail, Outlook and Yahoo all refuse SVG. The site's masthead radar is
     inline SVG, so this is the exact mistake a copy from pages.js makes. */
  check('no <svg>', /<svg/i.test(html), false);
  check('no .svg reference', /\.svg/i.test(html), false);
  /* Word does not know either, so a layout built on them collapses in Outlook. */
  check('no flexbox', /display:\s*flex/i.test(html), false);
  check('no grid', /display:\s*grid/i.test(html), false);
  /* Everything the layout needs is inline; the <style> block is progressive. */
  ok('exactly one <style> block', (html.match(/<style/g) ?? []).length === 1);
  check('no external stylesheet', /<link[^>]+stylesheet/i.test(html), false);
  check('no script', /<script/i.test(html), false);

  /* Every layout table must be invisible to a screen reader and unstyled by
     the client's own defaults. */
  const tables = html.match(/<table[^>]*>/g) ?? [];
  ok(`there are layout tables (${tables.length})`, tables.length > 5);
  check('every one is role=presentation',
    tables.filter((t) => !/role="presentation"/.test(t)), []);
  check('every one zeroes cellpadding, cellspacing and border',
    tables.filter((t) => !/cellpadding="0"/.test(t) || !/cellspacing="0"/.test(t) || !/border="0"/.test(t)), []);
}

console.log('\n== THE COLOURS ARE THE SITE\'S, READ BACK OUT OF THE STYLESHEET ==');
{
  /* src/digestmail.js copies these by hand because email needs them inline and
     a stylesheet cannot be read at send time. That copy is what drifts. */
  const css = readFileSync(`${ROOT}web/public/styles.css`, 'utf8');
  const tokenOf = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]?.toLowerCase();
  const mail = readFileSync(`${ROOT}src/digestmail.js`, 'utf8');
  const constOf = (key) => mail.match(new RegExp(`\\b${key}:\\s*'(#[0-9a-fA-F]{3,8})'`))?.[1]?.toLowerCase();

  for (const [key, token] of [['bg', 'bg'], ['card', 'card'], ['rule', 'rule'],
    ['ink', 'ink'], ['ink2', 'ink-2'], ['ink3', 'ink-3'], ['live', 'live']]) {
    const want = tokenOf(token);
    const got = constOf(key);
    /* BOTH SIDES ARE ASSERTED PRESENT FIRST. The first version of this had an
       over-escaped regex, so both readers returned undefined and the equality
       passed on two nothings — while the "was found" line beside it failed and
       gave it away. Comparing two lookups is only a test when both lookups
       are known to have found something. */
    ok(`--${token} was found in styles.css`, !!want);
    ok(`C.${key} was found in digestmail.js`, !!got);
    check(`C.${key} matches --${token}`, got, want);
  }
}

console.log('\n== THE MASTHEAD MARK EXISTS AND WILL BE PUSHED ==');
{
  const png = `${ROOT}web/public/email/radar.png`;
  ok('the radar PNG is on disk', existsSync(png));
  /* A file under web/public is NOT published unless it is named: India's board
     is at the ROOT and is enumerated file by file. Missing here, the image is
     written once and pushed never — a broken mark at the top of every digest,
     with nothing on the site looking wrong. */
  ok('web/public/email is in the published allowlist',
    publishedPaths().includes('web/public/email'));
  const html = render([rich(1)], { total: 1 });
  ok('the mail points at it absolutely',
    html.includes('src="https://interndoor.com/email/radar.png"'));
  /* Decorative: the wordmark beside it is live text and says the name already,
     so a screen reader must not read it twice. */
  ok('and it is marked decorative', /radar\.png"[^>]*alt=""/.test(html));
  ok('the wordmark is live text, not baked into an image', html.includes('INTERN<span'));
}

console.log('\n== UNTRUSTED TEXT IS ESCAPED, AND LINKS ARE OURS ==');
{
  const nasty = {
    ...rich(1),
    company: 'Ev"il & <script>alert(1)</script>',
    title: "Bobby </td></table><b>tables</b> & 'co'",
    location: '<img src=x onerror=alert(1)>',
    bullets: ['<b>bold</b> claim'],
    keySkills: ['<i>x</i>'],
  };
  const html = render([nasty], { total: 1 });
  check('no injected script tag', /<script>alert/.test(html), false);
  check('no injected img', /<img src=x/.test(html), false);
  check('no injected bold', /<b>bold<\/b>/.test(html), false);
  check('the table cannot be closed early', /<\/td><\/table><b>/.test(html), false);
  ok('the company name still reads', html.includes('Ev&quot;il &amp; '));

  /* Every href in the mail is ours, absolute and https — a relative URL is no
     URL at all in an email client, and an employer's apply URL must never be
     UTM-tagged (some ATS routers read the query string). */
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  ok(`there are links (${hrefs.length})`, hrefs.length > 2);
  check('none is relative or javascript:',
    hrefs.filter((h) => !h.startsWith('https://') && h !== '{{ unsubscribe_url }}'), []);
  check('every site link is on interndoor.com',
    hrefs.filter((h) => h.startsWith('https://') && !h.startsWith('https://interndoor.com')), []);
  ok('the unsubscribe placeholder is there', hrefs.includes('{{ unsubscribe_url }}'));
  /* utm_medium=email, not the social default — a digest click filed under
     social traffic is a measurement this site cannot get back. */
  ok('links are tagged as email', html.includes('utm_medium=email'));
  check('and never as social', /utm_medium=social/.test(html), false);
}

console.log('\n== THE INBOX PREVIEW LINE ==');
{
  const html = render([rich(1)], { total: 4 });
  /* Without one, the client invents a preview from the first text in the body
     — which here is the date in the masthead. */
  ok('a preheader is present', html.includes('4 new engineering internships in India, newest first.'));
  ok('it is hidden three ways, because no one way works everywhere',
    /display:none;[^"]*max-height:0;[^"]*opacity:0/.test(html));
  ok('and padded so the client cannot pull the masthead into it',
    html.includes('&#847;&zwnj;&nbsp;'));
}

console.log('\n== A THIN ROW STILL RENDERS ==');
{
  /* Most India rows have no stipend, no duration and no skills — a card that
     needs them renders an empty box on the commonest posting there is. */
  const thin = { job_id: '1', id: '1', company: 'Solo', title: 'Intern', postedAt: Date.now() };
  const html = render([thin], { total: 1 });
  ok('the role is there', html.includes('Intern'));
  ok('the company is there', html.includes('Solo'));
  ok('initials stand in for a missing logo', html.includes('>S</td>'));
  check('and no empty facts separator is left behind', / · <\/td>/.test(html), false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
