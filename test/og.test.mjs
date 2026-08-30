/**
 * The Open Graph card generator — web/api/_card.js.
 *
 * The card is drawn ON REQUEST rather than committed, because a committed one
 * is ~46KB and will not compress further (measured at four quality levels and
 * with the film grain removed): +44MB for today's board and ~1.7GB a YEAR of
 * git history that cannot be pruned without rewriting a public repo.
 *
 * Only the PURE half is tested here. web/api/og.js imports @vercel/og, whose
 * Node build cannot be loaded outside the edge runtime, which is exactly why
 * the element tree lives in its own module — a layout that cannot be rendered
 * without deploying cannot be checked before it ships, and four bugs in the
 * HTML version of this card were found only by looking at a rendered frame.
 */
import { buildCard, roleSize, clampTitle, REGION_PREFIX } from '../web/api/_card.js';
import { regionPath, publishedRegions } from '../src/regions.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
};

console.log('\n== the region prefix agrees with the site ==');
/* THE ONE THING THAT CAN SILENTLY DRIFT. An edge function cannot import
   src/regions.js, so the slug map is a copy. If a region is ever added, or /uk
   stops being GB's slug, the generator would fetch the wrong board's jobs.json
   and quietly draw the generic card for a whole region. */
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
for (const region of publishedRegions(cfg)) {
  check(`${region.code} matches regionPath`, REGION_PREFIX[region.code], regionPath(region.code));
}
check('India is the root, not "/in"', REGION_PREFIX.IN, '');
check('GB is served at /uk', REGION_PREFIX.GB, '/uk');
// An unknown region must be absent, not empty: the handler refuses `undefined`
// and would otherwise coerce it to India's board.
check('an unknown region is absent', REGION_PREFIX.ZZ, undefined);

console.log('\n== the function is wired the same way locally and live ==');
/* A route the dev server does not know about can work live and 404 here, which
   is the trap web/serve.js exists to close — and the assets have to be shipped
   into the function bundle or it renders nothing but the fallback. */
const serve = readFileSync(join(ROOT, 'web', 'serve.js'), 'utf8');
check('serve.js answers /api/og', serve.includes("'/api/og': './api/og.js'"), true);

const vercel = JSON.parse(readFileSync(join(ROOT, 'web', 'vercel.json'), 'utf8'));
check('the fonts and the rasteriser are bundled with it',
  vercel.functions?.['api/og.js']?.includeFiles, 'api/assets/**');
for (const f of ['archivo-900.ttf', 'jetbrains-700.ttf', 'resvg.wasm']) {
  check(`${f} is where includeFiles looks`,
    existsSync(join(ROOT, 'web', 'api', 'assets', f)), true);
}
/* @vercel/og is NOT used and must not come back: it is built for Next.js's
   bundler and fails in both runtimes here — `?module` wasm imports the plain
   Edge bundler cannot resolve, and a "type": "module" package shipping
   require("fs") on Node. It cost one failed deploy, and a failed build freezes
   the whole site because Vercel keeps serving the previous deployment. */
const fn = readFileSync(join(ROOT, 'web', 'api', 'og.js'), 'utf8');
// The name appears in the file's own note explaining why it is not used, so
// this asserts on the IMPORT rather than the mention.
check('the handler does not import @vercel/og', /from ['"]@vercel\/og['"]/.test(fn), false);
/* Imported DYNAMICALLY and inside the guarded path: a static import that fails
   to resolve throws before any of our code runs, so the whole function 500s
   instead of falling back to the generic card — which is exactly what the first
   deploy did, and it was undiagnosable from outside. */
check('it renders with satori', /import\('satori'\)/.test(fn), true);
check('and rasterises with resvg-wasm', /import\('@resvg\/resvg-wasm'\)/.test(fn), true);
check('neither is imported statically',
  /^import .*(satori|resvg)/m.test(fn), false);
// A failure that cannot be seen from outside is a failure that cannot be fixed.
check('a fallback says why on a header', fn.includes("'x-og-error'"), true);
// The Node runtime, so it can be exercised locally before it ships.
check('it is not an edge function', /runtime:\s*'edge'/.test(fn), false);

console.log('\n== the role is sized from its length ==');
/* Satori cannot fit text to a box the way the HTML card did — there is no
   layout pass to read — so the size is chosen from the length. Real titles run
   from 6 characters to 172, because one employer names fifteen cities in one. */
check('a short title gets the full size', roleSize(10), 92);
check('a medium one steps down', roleSize(40) < 92, true);
check('a long one steps down again', roleSize(100) < roleSize(40), true);
check('and the longest is still legible', roleSize(400) >= 34, true);
// Monotonic: a longer title must never be drawn LARGER than a shorter one.
let prev = Infinity;
let monotonic = true;
for (let n = 1; n <= 300; n += 7) { if (roleSize(n) > prev) monotonic = false; prev = roleSize(n); }
check('size never grows with length', monotonic, true);

console.log('\n== a title is trimmed, never allowed to become the card ==');
const LONG = 'AI And Robotics Trainer Internship in Jhajjar, Ambala, Faridabad, Palwal, Nuh, Bhiwani, Kurukshetra, Sonipat, Jind, Fatehabad, Sirsa, Gurgaon, Hisar';
const cut = clampTitle(LONG);
check('it is trimmed', cut.length <= 128, true);
check('at a word boundary', LONG.startsWith(cut) && !/[A-Za-z0-9]/.test(LONG[cut.length] ?? ' '), true);
check('a short title is untouched', clampTitle('Backend Intern'), 'Backend Intern');
check('whitespace is collapsed', clampTitle('  Backend   Intern  '), 'Backend Intern');
check('missing is empty, never "undefined"', clampTitle(undefined), '');

console.log('\n== the tree satori is given ==');
/* SATORI IS FLEXBOX ONLY: any element with more than one child needs an
   explicit display:flex, and one without it throws at render time — on a live
   share, where the failure is a broken preview nobody sees until it is out. */
const tree = buildCard({ company: 'Janitri', title: 'Back End Developer - Intern',
  facts: ['20,000 / month', 'Bengaluru', 'On-site'], logo: 'https://interndoor.com/logos/j.jpg' });
const walk = (n, out = []) => {
  if (!n || typeof n !== 'object') return out;
  out.push(n);
  const kids = n.props?.children;
  for (const k of (Array.isArray(kids) ? kids : [kids])) walk(k, out);
  return out;
};
const nodes = walk(tree).filter((n) => n.type === 'div');
const multi = nodes.filter((n) => Array.isArray(n.props?.children) && n.props.children.filter(Boolean).length > 1);
check('every multi-child div declares display:flex',
  multi.every((n) => n.props.style?.display === 'flex'), true);
check('and there are some to check', multi.length >= 3, true);

const flat = JSON.stringify(tree);
check('the company is on the card', flat.includes('Janitri'), true);
check('the role is on the card', flat.includes('Back End Developer - Intern'), true);
check('the facts are on the card', flat.includes('20,000 / month') && flat.includes('Bengaluru'), true);
check('the logo is used when there is one', flat.includes('logos/j.jpg'), true);
// A posting with no logo must not render a broken image box.
check('and no img is emitted when there is none',
  JSON.stringify(buildCard({ company: 'A', title: 'B', facts: [] })).includes('logos/'), false);
// Only three chips fit across the foot; a fourth would push the URL off.
check('at most three facts are drawn',
  (JSON.stringify(buildCard({ company: 'A', title: 'B', facts: ['1', '2', '3', '4'] }))
    .match(/"1"|"2"|"3"|"4"/g) || []).length, 3);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
