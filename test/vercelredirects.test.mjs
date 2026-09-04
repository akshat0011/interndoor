/**
 * A REDIRECT MUST NOT POINT AT A 404.
 *
 * The previous owner's domain still 308s to this one preserving path case, and
 * this site's paths are lowercase — so every capital-C URL Google had indexed
 * landed on a 404. That is why the top organic result for the brand name was
 * still `internzo.in › Companies` in September 2026: Google could not follow it
 * to a live page, so it kept serving the stale snippet.
 *
 * The fix is a case-correcting redirect per path family. THE TRAP IS DOING IT
 * FOR ALL OF THEM: `/jobs` has no index page and 404s by design (job pages live
 * at `/jobs/<slug>`), so `/Jobs -> /jobs` would swap one 404 for another and
 * spend a redirect hop doing it. Only the deep form is mapped.
 *
 * So this asserts destinations RESOLVE, not merely that redirects exist.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
/* fileURLToPath, NOT url.pathname: this repo lives under "Application
   Support", and pathname percent-encodes the space, so every existsSync missed
   and the check reported six healthy destinations as dead 404s. */
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const vercel = JSON.parse(readFileSync(new URL('../web/vercel.json', import.meta.url), 'utf8'));
const pub = fileURLToPath(new URL('../web/public/', import.meta.url));
const redirects = vercel.redirects ?? [];

/** Does a path serve something? cleanUrls is on, so `/x` may be `x.html`. */
const resolves = (p) => {
  const rel = p.replace(/^\//, '');
  if (!rel) return existsSync(join(pub, 'index.html'));
  return [join(pub, `${rel}.html`), join(pub, rel, 'index.html'), join(pub, rel)]
    .some((c) => existsSync(c) && statSync(c).isFile());
};

console.log('\n== every static redirect destination resolves ==');
const statics = redirects.filter((r) => !/:/.test(r.destination));
check('there are static destinations to check', statics.length > 0, true);
const dead = statics.filter((r) => !resolves(r.destination)).map((r) => `${r.source} -> ${r.destination}`);
check('none point at a missing page', dead, []);

console.log('\n== the capital-path families Google still holds are mapped ==');
const bySource = new Map(redirects.map((r) => [r.source, r.destination]));
for (const [from, to] of [
  ['/Companies', '/companies'],
  ['/Companies/:path*', '/companies/:path*'],
  ['/Jobs/:path+', '/jobs/:path+'],
  ['/Skills/:path*', '/skills/:path*'],
  ['/Locations/:path*', '/locations/:path*'],
]) check(`${from} -> ${to}`, bySource.get(from), to);

/* The one that must NOT be reachable — and asserting the CONFIG SHAPE was not
   enough. `/jobs` has no index page, so nothing may send `/Jobs` there. The
   first version of this check asked `bySource.has('/Jobs')` and passed, while
   the live site answered `/Jobs -> 308 -> /jobs -> 404`: in path-to-regexp
   `:path*` matches ZERO or more segments, so `/Jobs/:path*` swallowed the bare
   form. Match every source against the path instead, the way Vercel does. */
console.log('\n== nothing routes bare /Jobs into the jobs 404 ==');
const matches = (source, path) => {
  /* Tokenise BEFORE escaping. Escaping first turns the `+` of `:path+` into a
     literal `\+`, so the one-or-more branch never fires and the matcher claims
     a deep path does not match — which the three pins below caught. */
  const param = /\/:([A-Za-z0-9_]+)([*+])?/g;
  const esc = (lit) => lit.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
  let out = '^', last = 0, m;
  while ((m = param.exec(source)) !== null) {
    out += esc(source.slice(last, m.index));
    out += m[2] === '*' ? '(?:/(.*))?' : m[2] === '+' ? '/(.+)' : '/([^/]+)';
    last = m.index + m[0].length;
  }
  return new RegExp(out + esc(source.slice(last)) + '$').test(path);
};
/* The matcher itself needs pinning, or a broken regex quietly passes it all. */
check('matcher: /Jobs/:path* DOES swallow /Jobs', matches('/Jobs/:path*', '/Jobs'), true);
check('matcher: /Jobs/:path+ does NOT', matches('/Jobs/:path+', '/Jobs'), false);
check('matcher: /Jobs/:path+ still takes a deep path', matches('/Jobs/:path+', '/Jobs/adobe-x-123'), true);

const hits = redirects.filter((r) => matches(r.source, '/Jobs'));
check('no redirect source matches bare /Jobs', hits.map((r) => r.source), []);
check('and /jobs genuinely has no index page', resolves('/jobs'), false);
/* while the deep form must still be mapped */
const deep = redirects.filter((r) => matches(r.source, '/Jobs/adobe-apprentice-tech-4457612403'));
check('the deep /Jobs form is still redirected', deep.length >= 1, true);

/* Case corrections are canonical, not temporary. */
console.log('\n== they are permanent ==');
const caseFixes = redirects.filter((r) => /^\/[A-Z]/.test(r.source));
check('every capital-path redirect is a 301', caseFixes.every((r) => r.permanent === true), true);
check('and there are several', caseFixes.length >= 5, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
