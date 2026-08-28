/* ============================================================
   The Google Ads tag, and the CSP it needs.

   WHY THIS FILE EXISTS. web/vercel.json ships a strict CSP and
   no local server sends that header, so a blocked tag works
   perfectly in every preview and fails only in front of real
   users — which is how the no-flash theme script shipped
   broken on 21 Aug and went unnoticed for a day.

   The host list below is MEASURED, not read off a doc: a real
   ID was set, a page was served with the production header,
   and every request the tag made was recorded. Two hosts that
   every guide files under img-src are wrong — see the comment
   in web/public/gtag.js. Both were blocking conversions
   outright before this was checked empirically.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderJobPage } from '../src/pages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

const vercel = JSON.parse(readFileSync(join(ROOT, 'web', 'vercel.json'), 'utf8'));
const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const gtagSrc = readFileSync(join(ROOT, 'web', 'public', 'gtag.js'), 'utf8');
const indexHtml = readFileSync(join(ROOT, 'web', 'public', 'index.html'), 'utf8');
const appJs = readFileSync(join(ROOT, 'web', 'public', 'app.js'), 'utf8');
const subscribeJs = readFileSync(join(ROOT, 'web', 'public', 'subscribe.js'), 'utf8');

/* 'script-src a b; img-src c' -> { 'script-src': ['a','b'], 'img-src': ['c'] } */
const directives = Object.fromEntries(csp.split(';').map((d) => {
  const [name, ...values] = d.trim().split(/\s+/);
  return [name, values];
}));

console.log('\n== the CSP allows every host the tag actually contacts ==');
/* Measured live. Each entry is (host, the directive it is fetched under). */
const REQUIRED = [
  ['https://www.googletagmanager.com', 'script-src'],
  /* NOT img-src. The conversion beacon at /pagead/viewthroughconversion is
     loaded as a SCRIPT, and with this host missing from script-src BOTH
     conversions were blocked with nothing to show for it. */
  ['https://googleads.g.doubleclick.net', 'script-src'],
  /* A DIFFERENT host from googleads.g.doubleclick.net — /ccm/s/collect. */
  ['https://ad.doubleclick.net', 'connect-src'],
  ['https://www.google.com', 'connect-src'],
  ['https://www.google.com', 'img-src'],
  /* The campaign targets India and readers are served their country TLD.
     A NEW TARGET COUNTRY NEEDS ITS OWN TLD HERE. */
  ['https://www.google.co.in', 'connect-src'],
  ['https://www.google.co.in', 'img-src'],
];
for (const [host, directive] of REQUIRED) {
  check(`${directive} allows ${host}`, (directives[directive] || []).includes(host), true);
}

console.log('\n== the strict parts of the CSP are still strict ==');
/* Widening for the tag must not have quietly opened the door generally. */
check("script-src has no 'unsafe-inline'", (directives['script-src'] || []).includes("'unsafe-inline'"), false);
check("script-src has no 'unsafe-eval'", (directives['script-src'] || []).includes("'unsafe-eval'"), false);
check('script-src has no bare wildcard', (directives['script-src'] || []).includes('*'), false);
check("default-src is still 'self'", directives['default-src'], ["'self'"]);
check("frame-ancestors is still 'none'", directives['frame-ancestors'], ["'none'"]);
check("object-src is still 'none'", directives['object-src'], ["'none'"]);
check('both original inline hashes survive', (directives['script-src'] || [])
  .filter((v) => v.startsWith("'sha256-")).length, 2);

console.log('\n== every page loads the tag ==');
/* index.html is the TEMPLATE for all three boards, so one reference covers
   India, US and UK. head() in pages.js covers every job page, company hub,
   directory and /alerts. */
check('the board template references it', indexHtml.includes('<script defer src="/gtag.js"></script>'), true);
const jobPage = renderJobPage({
  id: '1', company: 'Acme', title: 'Software Engineer Intern',
  url: 'https://www.linkedin.com/jobs/view/1',
  /* The rail button renders off applyUrl, not url — all 265 live job pages
     carry one, so a fixture without it is not representative. */
  applyUrl: 'https://www.linkedin.com/jobs/view/1',
  location: 'Bengaluru, Karnataka, India',
  postedAt: Date.UTC(2026, 6, 1), firstSeenAt: Date.UTC(2026, 6, 1), bullets: ['a', 'b'],
});
check('a rendered job page references it', jobPage.includes('<script defer src="/gtag.js"></script>'), true);

console.log('\n== it is external, because an inline script would need a hash ==');
/* test/pages.test.mjs pins a job page at exactly one inline script and checks
   its sha256 against the real vercel.json. Google's own snippet is two tags,
   one inline — it would fail that pin AND need its hash regenerated every time
   the conversion ID changed. */
check('the tag adds no inline script', [...jobPage.matchAll(/<script>/g)].length, 1);
check('gtag.js is never inlined into a page', /<script>[^<]*ADS_ID/.test(jobPage), false);

console.log('\n== it is a no-op until an ID is set ==');
/* Same shape as src/websearch.js with no GOOGLE_CSE_KEY: a missing key is a
   quiet no-op, never a half-working feature. Deliberately NOT asserting that
   ADS_ID is empty — that is the one thing that is supposed to change. */
check('everything is guarded on the ID', /\n\s*if \(ADS_ID\) \{/.test(gtagSrc), true);
check('idTrack is defined BEFORE the guard, so call sites never throw',
  gtagSrc.indexOf('window.idTrack = function idTrack() {};') < gtagSrc.indexOf('if (ADS_ID) {'), true);

console.log('\n== the apply selectors match what actually renders ==');
/* THE DRIFT THIS PINS. The apply click is tracked by ONE delegated listener in
   gtag.js rather than a call site in each of the four places an apply link is
   built. That is a single source of truth, but it couples gtag.js to class
   names owned by app.js and pages.js — and a rename there would stop apply
   tracking with no error anywhere. */
const selector = (gtagSrc.match(/closest\?\.\('([^']+)'\)/) || [])[1] || '';
check('app.js still builds a.card-go', appJs.includes("el('a', 'card-go')"), true);
check('app.js still builds a.go', appJs.includes("el('a', 'go')"), true);
check('a job page still renders a.btn-apply', /<a class="btn-apply"/.test(jobPage), true);
for (const cls of ['a.card-go', 'a.go', 'a.btn-apply']) {
  check(`the listener still matches ${cls}`, selector.includes(cls), true);
}
check('it listens in the capture phase', /addEventListener\('click',[\s\S]{0,240}\}, true\)/.test(gtagSrc), true);

console.log('\n== the subscribe conversion is wired at its one call site ==');
/* Not a click, so it cannot go through the delegated listener. */
check('subscribe.js fires it on success', subscribeJs.includes("window.idTrack?.('subscribe'"), true);
check('optional-chained, so a deferred/absent tag cannot break signup',
  subscribeJs.includes("window.idTrack?.("), true);
check('it fires AFTER the success message, not before',
  subscribeJs.indexOf('you are on the list') < subscribeJs.indexOf("window.idTrack?.('subscribe'"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
