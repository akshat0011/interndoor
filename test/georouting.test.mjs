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

console.log('\n== INDIA ONLY SINCE 30 SEP 2026: nobody is bounced, the retired boards answer 410 ==');
const vercel = JSON.parse(readFileSync('web/vercel.json', 'utf8'));
/* The geo nudge sent an American typing the apex to /us. With /us retired that
   redirect would land every one of them on a 410, so it must be gone — and
   with it the boardpick cookie it read, which nothing consults any more. */
const geo = vercel.redirects.filter((r) => JSON.stringify(r.has ?? []).includes('x-vercel-ip-country'));
check('no geo redirect remains', geo.length, 0);
check('no redirect points into a retired board', vercel.redirects.filter((r) => /^\/(us|uk|ca)(\/|$)/.test(r.destination)).map((r) => r.source), []);

/* Vercel's own matching for a `/x/:path*` source: zero or more segments, so the
   bare /us matches too (the /Jobs/:path* lesson in vercelredirects). */
const rewrites = vercel.rewrites ?? [];
const toRegex = (src) => new RegExp('^' + src.replace(/\/:path\*$/, '(?:/.*)?') + '$');
const rewritten = (path) => rewrites.find((r) => toRegex(r.source).test(path))?.destination ?? null;
for (const path of ['/us', '/us/jobs/salesforce-intern-1', '/us/companies/ibm', '/us/sitemap.xml', '/uk', '/uk/skills/python', '/ca', '/ca/jobs/x-1']) {
  check(`${path} is answered by the 410 function`, rewritten(path), '/api/gone');
}
/* And nothing India owns is caught. A rule written as /us:path* would swallow
   an India slug that merely starts with those letters. */
for (const path of ['/', '/jobs/usb-intern-1', '/companies/us-foods', '/companies/ukg', '/companies/canva', '/skills/python', '/careers', '/contact']) {
  check(`${path} is left alone`, rewritten(path), null);
}
check('/in still folds into the root', vercel.redirects.some((r) => r.source === '/in' && r.destination === '/' && r.permanent === true), true);

console.log('\n== the 410 function ==');
{
  const { default: gone } = await import('../web/api/gone.js');
  const mk = () => { const r = { h: {}, code: 0, body: '' }; r.setHeader = (k, v) => { r.h[k.toLowerCase()] = v; }; r.status = (c) => { r.code = c; return r; }; r.send = (b) => { r.body = b; return r; }; r.end = () => r; return r; };
  const res = mk(); gone({ method: 'GET' }, res);
  check('answers 410 Gone, not 404 and not a redirect', res.code, 410);
  check('tells crawlers not to index the notice', res.h['x-robots-tag'], 'noindex');
  ok('links the reader to the India board', res.body.includes('href="https://interndoor.com/"'));
  /* The production CSP blocks inline script and style (vercel.json); a notice
     that needed either would render broken only in production. */
  ok('carries no inline script or style', !/<script|<style|\sstyle=/.test(res.body));
  const head = mk(); gone({ method: 'HEAD' }, head);
  check('HEAD is 410 too, with no body', [head.code, head.body], [410, '']);
  ok('web/serve.js routes it locally', readFileSync('web/serve.js', 'utf8').includes("'/api/gone': './api/gone.js'"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
