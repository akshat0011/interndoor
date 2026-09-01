/* ============================================================
   The board's payload fetch, its heading level, and the
   light-theme tokens the contrast audit failed on.

   WHY THIS FILE EXISTS. All three are things that look wrong
   when they are right, so all three invite being "fixed" back.

   THE FETCH is the important one. loadJobs used to send
   `?t=${Date.now()}` with cache: 'no-store'. That reads like
   diligence and is the single most expensive thing on the
   site: a unique URL plus no-store means no validator is ever
   sent, so the FULL file is downloaded on every load, reload
   and back-navigation. Measured in a real browser against the
   live US board:

     ?t= + no-store   205,114 B   every time
     no-cache         205,114 B   first load
                            300 B   every load after

   with a byte-identical body (1,474,942 chars) each time, so
   nothing about freshness changed - vercel.json already serves
   this file max-age=0, must-revalidate, and 'no-cache' revalidates
   on every load too. It just sends the ETag while doing it.

   THE HEADING was h3 under the page's only h1, on all 610 cards,
   which was the one navigation failure in the accessibility audit.

   THE TOKENS clear AA where they are used as text. NOTE what
   this does NOT claim: it was originally written believing it
   fixed the audit's reported contrast failures, and it does
   not. Those were measured with a hand-rolled canvas harness
   that ignored element opacity and gradient background layers,
   so it invented failures and missed the real ones. axe-core
   is the authority here - it is what Lighthouse and PSI run.
   The real failures are listed in CLAUDE.md and are a
   different set. These assertions are still worth keeping:
   the ratios they pin are genuinely correct and genuinely
   used. They are simply not the audit fix.

   THE CARD ELEMENT is a div. role="button" is not allowed on
   <article>, which axe flags as aria-allowed-role on every
   card - the whole of the "accessibility tree is not
   well-formed" finding. Verified with axe before and after:
   237 violations -> 0.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
function atLeast(label, actual, min) {
  if (actual >= min) { pass++; console.log(`  ok   ${label} (${actual.toFixed(2)} >= ${min})`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${actual.toFixed(2)}\n         want: >= ${min}`); }
}

const app = readFileSync(join(ROOT, 'web', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'web', 'public', 'styles.css'), 'utf8');

/* ---- the payload fetch ---- */
console.log('\n== the board payload is fetched CONDITIONALLY ==');
// The call itself, not the whole file: comments here quote the old form on purpose.
const fetchCall = (app.match(/const res = await fetch\([^;]*\);/) || [''])[0];
check('loadJobs issues exactly one fetch of DATA_URL',
  /fetch\(\s*DATA_URL\s*,/.test(fetchCall), true);
check('it does NOT append a cache-busting timestamp',
  /\?t=|Date\.now\(\)|Math\.random\(\)/.test(fetchCall), false);
check("it does NOT use cache: 'no-store' (that suppresses the validator)",
  /no-store/.test(fetchCall), false);
check("it uses cache: 'no-cache' — revalidate every load, but send the ETag",
  /cache:\s*'no-cache'/.test(fetchCall), true);

/* ---- the card heading ---- */
console.log('\n== the card element accepts the role it is given ==');
const jobCard = (app.match(/function jobCard\(job[\s\S]{0,1200}/) || [''])[0];
if (!/const row = el\('\w+', 'row'\)/.test(jobCard)) { console.log('  FAIL  jobCard window found no row element'); process.exit(1); }
check("the card is a div, which accepts any role",
  /const row = el\('div', 'row'\)/.test(jobCard), true);
check("and NOT an <article>, where role=button is disallowed",
  /const row = el\('article', 'row'\)/.test(jobCard), false);
check("it still carries role=button (the whole card opens the dialog)",
  /setAttribute\('role', 'button'\)/.test(jobCard), true);

console.log('\n== the card heading is sequential under the page h1 ==');
// Wide enough to clear the explanatory comment above the call. A window that
// stops short makes the NEGATIVE assertion below pass on an empty string.
const roleLine = (app.match(/function roleLine\(job\)[\s\S]{0,1400}/) || [''])[0];
if (!/el\('h[1-6]',\s*'role'/.test(roleLine)) { console.log('  FAIL  roleLine window found no role heading at all'); process.exit(1); }
check("the role line is an h2", /el\('h2',\s*'role'/.test(roleLine), true);
check("and not an h3, which skipped a level on every card",
  /el\('h3',\s*'role'/.test(roleLine), false);

/* ---- the light-theme tokens ---- */
console.log('\n== no CSS opacity on text that has to stay legible ==');
/* Both of these carried an opacity that faded .foot's own --ink-3 (a passing
   4.94 on --bg-2) below AA without changing a single colour value, which is
   exactly why it went unnoticed: the token was right and the rendered text
   was not. axe folds opacity into the foreground and is correct to.
   .dim was .75 -> 3.27; .all-roles > summary was .55 -> 2.29, on a control
   somebody is meant to click. */
const dimRule = (css.match(/\n\.dim \{[^}]*\}/) || [''])[0];
const sumRule = (css.match(/\.all-roles > summary \{[^}]*\}/) || [''])[0];
if (!dimRule || !sumRule) { console.log('  FAIL  could not find .dim / .all-roles > summary'); process.exit(1); }
check('.dim carries no opacity', /opacity/.test(dimRule), false);
check('.all-roles > summary carries no opacity', /opacity/.test(sumRule), false);

console.log('\n== the sticky rail stays solid enough to read 9.5px labels on ==');
/* The .field decorative marks are lime and sit behind the rail. At 78% they
   composited through and became the background the filter labels are read
   against (axe measured #242b09 at 1280px, 3.8:1). Raising the rail to 92%
   cleared every desktop violation. Pinned as a floor, not an exact value. */
const railPct = +((css.match(/\.rail \{[\s\S]{0,700}?background: color-mix\(in oklab, var\(--bg\) (\d+)%/) || [])[1]);
if (!railPct) { console.log('  FAIL  could not read the .rail background mix'); process.exit(1); }
atLeast('.rail --bg mix percentage', railPct, 90);

console.log('\n== light-theme tokens clear AA where they are used as text ==');
const light = (css.match(/:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/) || [''])[0];
const tok = (n) => {
  const m = light.match(new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`light theme token --${n} not found`);
  return m[1];
};
const lum = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const live = tok('live'), ink3 = tok('ink-3'), liveInk = tok('live-ink');
const bg = tok('bg'), bg2 = tok('bg-2'), card = tok('card');

// --live as TEXT. It failed 4.02 / 3.69 before, on --bg and --bg-2.
atLeast('--live on --bg',            ratio(live, bg),   4.5);
atLeast('--live on --bg-2',          ratio(live, bg2),  4.5);
atLeast('--live on --card',          ratio(live, card), 4.5);
// --live as a BACKGROUND, carrying --live-ink. This failed at 3.66.
atLeast('--live-ink on --live',      ratio(liveInk, live), 4.5);
// --ink-3 is the muted body colour and sits on the darker band. It failed at 4.32.
atLeast('--ink-3 on --bg-2',         ratio(ink3, bg2),  4.5);
atLeast('--ink-3 on --bg',           ratio(ink3, bg),   4.5);
atLeast('--ink-3 on --card',         ratio(ink3, card), 4.5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
