/**
 * The link preview — the only thing a reader sees before deciding to click.
 *
 * 41 of the last 24 hours' referred visitors came from Facebook and 66 from
 * LinkedIn, and NEITHER is a channel this pipeline posts to: every one of those
 * arrived because a person shared a link. What that link renders as is
 * therefore not decoration, it is the whole funnel.
 *
 * `og:image` ALONE makes a scraper fetch the image before it can know its size,
 * and Facebook and LinkedIn both fall back to a small card — or to a bare link
 * — on the first share of a URL while that fetch is in flight. The boards have
 * declared width and height since they were written; the ~4,000 generated pages
 * had not, which is every page a reader actually shares out of a Google result.
 *
 * THE NUMBERS HERE ARE PINNED AGAINST THE RENDERERS, not repeated from memory.
 * A card resized without `OG_W`/`OG_H` changing would otherwise ship a lie to
 * every scraper and fail nothing.
 */
import { readFileSync } from 'node:fs';
import { renderContactPage, renderAlertsPage, renderJobPage, SITE } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const IN = regionOf('IN');
const src = readFileSync(new URL('../src/pages.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../web/api/og.js', import.meta.url), 'utf8');
const card = readFileSync(new URL('../src/ogcard.js', import.meta.url), 'utf8');
const board = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');

const declared = {
  w: Number(src.match(/const OG_W = (\d+);/)?.[1]),
  h: Number(src.match(/const OG_H = (\d+);/)?.[1]),
};

console.log('\n== THE DECLARED SIZE IS THE SIZE THAT IS DRAWN ==');
{
  check('the constants are readable', [declared.w, declared.h], [1200, 630]);
  /* The two renderers, each read from its own source. If either viewport
     changes, this fails rather than the site quietly advertising the old
     dimensions to every scraper. */
  const apiSize = api.match(/\{ width: (\d+), height: (\d+), fonts \}/);
  check('web/api/og.js draws exactly that',
    [Number(apiSize?.[1]), Number(apiSize?.[2])], [declared.w, declared.h]);
  const cardSize = card.match(/viewport: \{ width: (\d+), height: (\d+) \}/);
  check('src/ogcard.js draws exactly that',
    [Number(cardSize?.[1]), Number(cardSize?.[2])], [declared.w, declared.h]);
  /* And the board template, which carries its own hand-written copy. */
  ok('the board template agrees on width',
    board.includes(`<meta property="og:image:width" content="${declared.w}">`));
  ok('the board template agrees on height',
    board.includes(`<meta property="og:image:height" content="${declared.h}">`));
}

console.log('\n== EVERY GENERATED PAGE DECLARES IT ==');
{
  const pages = {
    '/contact': renderContactPage({ region: IN }),
    '/alerts': renderAlertsPage([], { region: IN }),
  };
  for (const [name, html] of Object.entries(pages)) {
    ok(`${name} declares width`, html.includes(`<meta property="og:image:width" content="${declared.w}">`));
    ok(`${name} declares height`, html.includes(`<meta property="og:image:height" content="${declared.h}">`));
    ok(`${name} declares secure_url`, /og:image:secure_url" content="https:\/\//.test(html));
    /* Exactly one card per page. A second og:image lets a scraper pick, and
       the one it picks is not always the one meant. */
    check(`${name} offers exactly one image`, (html.match(/property="og:image"/g) ?? []).length, 1);
  }
}

console.log('\n== THE TYPE IS DERIVED, NOT ASSUMED ==');
{
  /* A job page's card comes out of /api/og as PNG; every other page uses
     og.jpg. Telling a scraper image/jpeg about a PNG may cost the card. */
  const contact = renderContactPage({ region: IN });
  ok('a default card is declared image/jpeg',
    contact.includes('<meta property="og:image:type" content="image/jpeg">'));

  const job = {
    id: '999', title: 'Backend Intern', company: 'Acme', location: 'Bengaluru, Karnataka, India',
    url: 'https://example.com/j/999', applyUrl: 'https://example.com/apply/999',
    postedAt: Date.now(), firstSeenAt: Date.now(), summary: 'A role.', bullets: [], skills: [],
  };
  const jobHtml = renderJobPage(job, [], { region: IN });
  ok('a job page points at /api/og', /og:image" content="[^"]*\/api\/og\?/.test(jobHtml));
  ok('and is declared image/png',
    jobHtml.includes('<meta property="og:image:type" content="image/png">'));
  ok('with the same declared size',
    jobHtml.includes(`<meta property="og:image:height" content="${declared.h}">`));
}

console.log('\n== THE CARD URL IS ABSOLUTE AND https ==');
{
  /* A scraper is not on this origin, so a root-relative image is no image. */
  const contact = renderContactPage({ region: IN });
  const img = contact.match(/property="og:image" content="([^"]*)"/)?.[1];
  ok('og:image is absolute https', img?.startsWith('https://'));
  ok('and on this site', img?.startsWith(SITE));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
