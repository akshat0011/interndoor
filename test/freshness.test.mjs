/**
 * FRESHNESS IS DERIVED IN THE BROWSER, NEVER BAKED INTO THE FILE.
 *
 * `is-hot` (under a day) and `is-fresh` (under three) are functions of the
 * clock, so a page that carries them in its markup is rewritten the moment its
 * posting crosses a threshold — for a colour. `agePill` says so in its own
 * comment ("the freshness class is applied by script") and `dressAges` in
 * page.js does apply it, stripping both classes off every `[data-ago]` element
 * and re-adding the right one on load. The server was baking them in as well,
 * so the class was overwritten on every load and its only effect was churn:
 * measured on the 4 Sep 2026 00:42 publish, 14 tile-wrapper flips, 14
 * `tile-age is-hot` flips and 14 `is-fresh` flips in a single run, each one a
 * diff in a public repo and an IndexNow submission.
 *
 * THE `.tile` WRAPPER IS THE PART THAT NEEDED NEW CODE. It is an `<a>`, not the
 * element holding `data-ago`, so `dressAges` never touched it; page.js now
 * toggles it from the timestamp of the `[data-ago]` inside. Removing the server
 * class without that would have dropped the coloured edge site-wide.
 *
 * The assertion is the invariant, not the three call sites: render a board and
 * open every tag that carries `data-ago`.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePages } from '../src/pages.js';
import { regionOf, publishedRegions } from '../src/regions.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const CLOCK = /is-hot|is-fresh/;
const htmlUnder = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? htmlUnder(join(d, e.name)) : (e.name.endsWith('.html') ? [join(d, e.name)] : []));

const dirs = [];
function auditRegion(code) {
  const region = regionOf(code);
  const src = join('web', 'public', region.slug, 'data', 'jobs.json');
  if (!existsSync(src)) return null;
  const jobs = JSON.parse(readFileSync(src, 'utf8')).jobs ?? [];
  if (!jobs.length) return null;
  const dir = mkdtempSync(join(tmpdir(), `interndoor-fresh-${code}-`));
  dirs.push(dir);
  writePages(jobs, dir, [], { region });

  let ago = 0, tiles = 0, hubPills = 0;
  const baked = [];
  for (const f of htmlUnder(dir)) {
    const h = readFileSync(f, 'utf8');
    // Any tag carrying data-ago — the pill, the tile's age span, anything later.
    for (const m of h.matchAll(/<[a-z]+[^>]*\sdata-ago=[^>]*>/gi)) {
      ago++;
      if (CLOCK.test(m[0])) baked.push(`${f.slice(dir.length)} ${m[0].slice(0, 80)}`);
    }
    // The wrapper, which carries no data-ago of its own.
    for (const m of h.matchAll(/<a class="tile[^"]*"/g)) {
      tiles++;
      if (CLOCK.test(m[0])) baked.push(`${f.slice(dir.length)} ${m[0]}`);
    }
    hubPills += (h.match(/class="pill is-fresh hub-live"/g) ?? []).length;
  }
  return { code, ago, tiles, hubPills, baked };
}

const codes = publishedRegions(loadConfig()).map((r) => r.code);
console.log(`\n== no clock-derived class is baked into the markup (${codes.join(', ')}) ==`);
let audited = 0, sawAgo = 0, sawTiles = 0, sawHubPills = 0;
for (const code of codes) {
  const r = auditRegion(code);
  if (!r) { console.log(`  --    ${code} not built locally, skipped`); continue; }
  audited++; sawAgo += r.ago; sawTiles += r.tiles; sawHubPills += r.hubPills;
  console.log(`  (${r.code}: ${r.ago} [data-ago] tags, ${r.tiles} .tile wrappers)`);
  check(`${r.code}: nothing baked`, r.baked.slice(0, 4), []);
}

/* A render that produced no tags would pass the line above without testing
   anything — the fixture-too-short failure this repo keeps finding. */
console.log('\n== the audit had something to look at ==');
check('at least one region audited', audited > 0, true);
check('[data-ago] tags were found', sawAgo > 100, true);
check('.tile wrappers were found', sawTiles > 100, true);

/* THE CONTROL. `is-fresh` also marks a hub that has live roles right now —
   `class="pill is-fresh hub-live"`. That one is state, not clock: it carries no
   data-ago and changes only when the employer's open count crosses zero. A rule
   that banned the string outright would delete it, so it is pinned as MUST
   SURVIVE. */
console.log('\n== the hub "open now" pill is state, not clock, and survives ==');
check('hub live pills still rendered', sawHubPills > 0, true);

/* The other half of the contract. Removing the server class is only safe while
   page.js still derives it; this is a tripwire on that file, not a proof of its
   behaviour — the behaviour was verified in a browser against a local render
   (50 tiles, 0 mismatches on both the age spans and the wrapper). */
console.log('\n== page.js still owns the derivation ==');
const pj = readFileSync(new URL('../web/public/page.js', import.meta.url), 'utf8');
check('reads the timestamp', /dataset\.ago|data-ago/.test(pj), true);
check('strips both classes first', /classList\.remove\(\s*['"]is-hot['"]\s*,\s*['"]is-fresh['"]/.test(pj), true);
check('computes both thresholds', /is-hot.*is-fresh/s.test(pj), true);
/* ASSERT THE PAIRING, NOT THE LOOKUP. The first version of this line only
   checked that `closest('.tile')` appeared, and a mutation that kept the lookup
   and threw the result away — the exact shape that loses the coloured edge on
   every tile on the site — passed it cleanly. Bounded window rather than a lazy
   `[\s\S]*?`, which §16 records running past the thing it was anchored to. */
check('drives the .tile wrapper too',
  /closest\(\s*['"]\.tile['"]\s*\)[\s\S]{0,240}classList\.(?:toggle|add)\(\s*['"]is-hot['"]/.test(pj), true);

/* And the server side must not quietly grow a fourth emitter. */
console.log('\n== pages.js emits no clock-derived class ==');
const src = readFileSync(new URL('../src/pages.js', import.meta.url), 'utf8');
/* COMMENTS MUST COME OUT FIRST, and the naive version of this got it wrong:
   filtering lines that START with a comment marker leaves every continuation
   line of a block comment behind, so the four mentions in the comments above
   `agePill` and `tile` counted as emitters and the check failed at 5. Strip the
   blocks themselves. This is the same class as the regex that matched the word
   it was searching for inside a comment (§16). */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const emitters = [...code.matchAll(/is-hot|is-fresh/g)].length;
check('only the hub state pill mentions one', emitters, 1);
check('and it is the hub-live pill', /hub-live/.test(code), true);

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
