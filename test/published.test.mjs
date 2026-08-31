/**
 * The PUBLISHED allowlist must cover everything India's render creates.
 *
 * A generated page missing from that list is WRITTEN EVERY RUN AND PUSHED
 * NEVER, which is indistinguishable from a page that renders wrong. It has now
 * happened three times — /alerts, /report, and the /skills and /locations facet
 * pages, where 47 URLs sat in India's sitemap returning 404 while
 * /us/skills/python and /uk/skills served 200 the whole time, because every
 * non-India region is allowlisted by DIRECTORY and India is enumerated file by
 * file.
 *
 * This renders India into a scratch directory and fails if anything it creates
 * at the root is not covered.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedPaths } from '../src/publish.js';
import { writePages } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'interndoor-published-'));
const jobs = JSON.parse(readFileSync(new URL('../web/public/data/jobs.json', import.meta.url), 'utf8')).jobs ?? [];
writePages(jobs, dir, [], { region: regionOf('IN') });

/* Everything the India render puts at the root. Files the repo ships by hand —
   stylesheets, scripts, images, vercel.json — are deliberately NOT published,
   which is the whole reason India cannot be allowlisted as one directory. */
const HAND_MAINTAINED = new Set([
  'styles.css', 'app.js', 'page.css', 'page.js', 'subscribe.js', 'gtag.js',
  'vercel.json', 'og.jpg', 'favicon.ico', 'favicon.svg', 'og-card.html',
]);

const created = readdirSync(dir, { withFileTypes: true })
  .map((e) => e.name)
  .filter((n) => !n.startsWith('.') && !HAND_MAINTAINED.has(n));

const allow = new Set(publishedPaths().map((p) => p.replace(/^web\/public\//, '')));

console.log('\n== every root entry the render creates is in the allowlist ==');
console.log(`  (render produced: ${created.join(', ')})`);
const missing = created.filter((n) => !allow.has(n));
check('nothing written-but-never-pushed', missing, []);

console.log('\n== the entries that have burned us before are named ==');
// Each of these was, at some point, generated and silently never shipped.
for (const p of ['alerts.html', 'report.html', 'skills', 'locations'])
  check(`${p} is allowlisted`, allow.has(p), true);

console.log('\n== and the things that must NEVER be auto-published are not ==');
// styles.css, app.js and the rest are committed by hand on purpose — the
// scheduler shipping them would push half-finished edits every 30 minutes.
for (const p of ['styles.css', 'app.js', 'page.css', 'page.js', 'vercel.json'])
  check(`${p} is NOT allowlisted`, allow.has(p), false);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
