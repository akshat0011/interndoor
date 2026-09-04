/**
 * THE REPOSTED-ROLE STUB: its script, its CSP hash, and what it does.
 *
 * When an employer relists a role, the loser's slug keeps serving a stub with
 * `rel=canonical` + `meta refresh` to the winner. Two things were wrong with
 * that, both visible on a link posted to LinkedIn:
 *
 *   1. A meta refresh navigates to EXACTLY the url it names, so `?utm_source=…`
 *      was dropped. Every click on a shared link landed unattributed, which
 *      quietly breaks the one measurement §12 says should settle whether
 *      posting links is worth it.
 *   2. The browser paints the body before the refresh fires, so the reader sees
 *      "This role moved" flash past.
 *
 * One inline script fixes both: it runs during head parsing, before the body
 * paints, and carries the query string across. It reads the canonical rather
 * than being handed the target, so it is BYTE-IDENTICAL on every stub and one
 * CSP hash covers all of them — which is the only reason adding an inline
 * script here is affordable at all (§11: a hash must be regenerated
 * byte-exactly on every edit and its failure mode is silence).
 *
 * THE HASH IS CHECKED AGAINST THE REAL web/vercel.json, and the script is
 * EXECUTED rather than grepped — the existing CSP sweep in pages.test.mjs only
 * sees stubs that are already published, so it could not have caught a mismatch
 * until after a deploy had already been refused.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writePages } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const region = regionOf('IN');
const jobs = JSON.parse(readFileSync(new URL('../web/public/data/jobs.json', import.meta.url), 'utf8')).jobs ?? [];

/* The target must be a slug writePages itself produced, or the guard in
   writePages skips the redirect and this file would assert against nothing. */
const probe = mkdtempSync(join(tmpdir(), 'stub-probe-'));
writePages(jobs, probe, [], { region });
const targets = readdirSync(join(probe, 'jobs')).slice(0, 2).map((f) => f.replace(/\.html$/, ''));
rmSync(probe, { recursive: true, force: true });

const dir = mkdtempSync(join(tmpdir(), 'stub-'));
writePages(jobs, dir, [], {
  region,
  redirects: targets.map((t, i) => ({ slug: `old-slug-${i}`, target: t })),
});
const stubs = targets.map((_, i) => readFileSync(join(dir, 'jobs', `old-slug-${i}.html`), 'utf8'));

console.log('\n== the stub still works without JavaScript ==');
check('two stubs rendered', stubs.length, 2);
check('carries rel=canonical', stubs.every((h) => /<link rel="canonical" href="https:\/\/[^"]+">/.test(h)), true);
check('carries the meta refresh fallback', stubs.every((h) => /http-equiv="refresh"/.test(h)), true);
check('carries a visible link out', stubs.every((h) => /Continue to the current listing/.test(h)), true);
/* §10: a noindex here would suppress the consolidation the stub exists to cause. */
check('is NOT noindex', stubs.some((h) => /noindex/.test(h)), false);

console.log('\n== one script, byte-identical across stubs, so one hash serves all ==');
const bodies = stubs.map((h) => [...h.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]));
check('exactly one inline script per stub', bodies.map((b) => b.length), [1, 1]);
check('identical on both stubs', bodies[0][0] === bodies[1][0], true);
const body = bodies[0][0];
check('does not interpolate the target', /interndoor\.com|old-slug/.test(body), false);

console.log('\n== the CSP in web/vercel.json allows it ==');
const vercel = readFileSync(new URL('../web/vercel.json', import.meta.url), 'utf8');
const hash = `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
check('hash is listed in vercel.json', vercel.includes(hash), true);
const csp = JSON.parse(vercel).headers.flatMap((h) => h.headers)
  .find((k) => /Content-Security-Policy/i.test(k.key))?.value ?? '';
const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) ?? '';
check('and specifically in script-src', scriptSrc.includes(hash), true);
check('script-src still has no unsafe-inline', /unsafe-inline/.test(scriptSrc), false);

console.log('\n== and it actually carries the query string across ==');
/* EXECUTED, not grepped. A regex saying "location.search appears" passes for a
   script that mentions it and drops it, which is the bug being fixed. */
function run(canonicalHref, search) {
  const calls = [];
  const document = {
    querySelector: (sel) => (sel === 'link[rel=canonical]' && canonicalHref
      ? { href: canonicalHref } : null),
  };
  const location = { search, replace: (u) => calls.push(u) };
  new Function('document', 'location', body)(document, location);
  return calls;
}
const WINNER = 'https://interndoor.com/jobs/nvidia-phd-intern-ats-workday-jr2024423';
check('utm parameters survive',
  run(WINNER, '?utm_source=linkedin&utm_medium=social&utm_content=nvidia'),
  [`${WINNER}?utm_source=linkedin&utm_medium=social&utm_content=nvidia`]);
check('a bare click still lands on the winner', run(WINNER, ''), [WINNER]);
/* If the canonical is ever dropped the script must do nothing and leave the
   meta refresh to handle it, rather than throwing and leaving the reader on a
   page that says "this role moved" and never moves. */
check('no canonical -> no navigation, no throw', run(null, '?utm_source=x'), []);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
