/**
 * InternDoor's own opening at /careers/.
 *
 * HAND-WRITTEN, NOT GENERATED, which is the whole reason this file exists.
 * Every other page on this site comes out of writePages and is covered by the
 * rules that function already enforces; these two are static, so nothing checks
 * them unless something here does.
 *
 * The three ways a static page in this repo dies quietly:
 *   1. It is not in publishedPaths(), so it is written once and pushed never.
 *   2. It carries an inline script or style, which the production CSP blocks
 *      and every local preview allows.
 *   3. The removal sweep deletes it, because writePages removes anything in
 *      the job, company or facet directories it did not just write.
 */
import { readFileSync, existsSync } from 'node:fs';
import { publishedPaths } from '../src/publish.js';
import { createHash } from 'node:crypto';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const JOB = new URL('../web/public/careers/software-engineering-intern.html', import.meta.url);
const HUB = new URL('../web/public/careers/index.html', import.meta.url);
const job = readFileSync(JOB, 'utf8');
const hub = readFileSync(HUB, 'utf8');

console.log('\n== THE PAGES EXIST AND WILL ACTUALLY BE PUSHED ==');
{
  check('the job page is on disk', existsSync(JOB), true);
  check('the hub is on disk', existsSync(HUB), true);
  /* §5's most repeated mistake: a file missing from the allowlist is written
     every run and pushed never, which looks exactly like a page that renders
     wrong. Four pages have already been lost this way. */
  check('careers is in the published allowlist', publishedPaths().includes('web/public/careers'), true);
}

console.log('\n== THE PRODUCTION CSP WOULD NOT BLOCK IT ==');
{
  const csp = (() => {
    const v = JSON.parse(readFileSync(new URL('../web/vercel.json', import.meta.url), 'utf8'));
    for (const blk of v.headers ?? []) {
      for (const h of blk.headers ?? []) if (/Content-Security/i.test(h.key)) return h.value;
    }
    return '';
  })();

  /* No local server sends the CSP header, so a violation is invisible in every
     preview — it has shipped twice. Every inline script on the page must hash
     to something already allowed. */
  const inline = [...job.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check('exactly one inline script', inline.length, 1);
  const digest = `sha256-${createHash('sha256').update(inline[0]).digest('base64')}`;
  check('and its hash is already in the CSP', csp.includes(digest), true);

  check('no inline <style> block', /<style[\s>]/.test(job), false);
  // §5's own test refuses these in generated output; the same rule applies here.
  check('no style= attributes', /\sstyle="/.test(job), false);
  check('no inline style on the hub', /<style[\s>]|\sstyle="/.test(hub), false);

  /* form-action 'self' and connect-src 'self' mean the form and its fetch can
     only reach our own origin. A third-party target is refused by the browser
     with nothing visibly wrong. */
  check('the CSP really is form-action self', /form-action 'self'/.test(csp), true);
  check('the form posts same-origin', /action="\/api\/apply"/.test(job), true);
  const applyJs = readFileSync(new URL('../web/public/careers/apply.js', import.meta.url), 'utf8');
  check('and the fetch is same-origin too', /fetch\('\/api\/apply'/.test(applyJs), true);
  check('the form script is external, not inline', /<script defer src="\/careers\/apply\.js">/.test(job), true);
}

console.log('\n== THE JOBPOSTING MARKUP IS COMPLETE AND HONEST ==');
{
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(job)[1]);
  check('it is a JobPosting', ld['@type'], 'JobPosting');
  // Google's required set for a job posting.
  for (const k of ['title', 'description', 'datePosted', 'hiringOrganization']) {
    check(`required: ${k}`, !!ld[k], true);
  }
  /* A REMOTE ROLE NEEDS BOTH. jobLocation is required unless the role is
     remote, and TELECOMMUTE without applicantLocationRequirements reads as
     incomplete — Google cannot tell who may apply. Six pages were flagged for
     exactly this. */
  check('remote is declared', ld.jobLocationType, 'TELECOMMUTE');
  check('with who may apply', ld.applicantLocationRequirements?.name, 'India');
  check('employmentType is INTERN', ld.employmentType, 'INTERN');
  check('validThrough is set', !!ld.validThrough, true);

  /* directApply FALSE while the endpoint has nowhere to send. It means the
     application can be COMPLETED on this page, and §11 calls claiming it
     falsely the most direct route to a manual action across the whole domain.
     It becomes true when APPLY_FORWARD_URL is set, not before. */
  check('directApply is false', ld.directApply, false);

  /* THE UNPAID FACT IS IN THE MARKUP, not only in the visible copy. baseSalary
     is deliberately absent rather than 0: this site's standing rule is that a
     stipend it cannot state is withheld, and the description says the thing
     outright instead. */
  check('no baseSalary is claimed', 'baseSalary' in ld, false);
  check('the description says it is unpaid', /unpaid/i.test(ld.description), true);
  check('and so does the visible page', /unpaid/i.test(job), true);
  check('the pills say it too', /<span class="pill">Unpaid<\/span>/.test(job), true);
}

console.log('\n== IT IS ON THE HUB AND NOWHERE ELSE ==');
{
  check('the hub links the role', hub.includes('/careers/software-engineering-intern'), true);
  check('and the role links back to the hub', job.includes('href="/careers/"'), true);

  /* HIS ASK: on the hub and its own page, not on the board. These are static
     files outside the generated tree, so nothing can add them — asserted
     anyway, because "it cannot happen" is how the four lost pages happened. */
  for (const [label, f] of [['the India board', '../web/public/index.html'],
    ['the US board', '../web/public/us/index.html'],
    ['the India sitemap', '../web/public/sitemap.xml'],
    ['the feed', '../web/public/feed.xml']]) {
    const u = new URL(f, import.meta.url);
    if (!existsSync(u)) { console.log(`  --    skipped: ${label} not built`); continue; }
    check(`not on ${label}`, readFileSync(u, 'utf8').includes('careers/software-engineering-intern'), false);
  }
}

console.log('\n== THE ENDPOINT NEVER FAKES SUCCESS ==');
{
  const api = readFileSync(new URL('../web/api/apply.js', import.meta.url), 'utf8');
  /* The rule web/api/subscribe.js states: "a signup that silently fails is
     worse than no signup box, because the reader believes they are on the
     list." An application form is worse again — a CV and a covering note is
     real effort, spent on the belief a human will read it. */
  check('it refuses when there is nowhere to send', /if \(!FORWARD\) \{/.test(api), true);
  check('with a 503, not a 200', /503/.test(api), true);
  check('and says so out loud in the log', /APPLY_FORWARD_URL is not set/.test(api), true);
  /* NOTHING PERSONAL IS EVER LOGGED. Vercel keeps function logs, so a
     console line naming the applicant is storage — the exact thing this
     endpoint refuses to do. Reading the raw call text is not the check: the
     honest refusal message contains the WORD "application" and a substring
     search calls that a leak. Strip the string CONTENT and look only at the
     code that survives — literal prose is inert, an interpolated value is not. */
  const leaks = [];
  for (const m of api.matchAll(/console\.\w+\(([\s\S]*?)\);/g)) {
    const code = m[1]
      .replace(/'[^']*'/g, "''")                 // single-quoted prose: inert
      .replace(/"[^"]*"/g, '""')
      .replace(/`(?:[^`$]|\$(?!\{))*`/g, '``')     // template with no interpolation
      .replace(/`[\s\S]*?`/g, (t) =>              // keep only the ${...} parts
        [...t.matchAll(/\$\{([^}]*)\}/g)].map((i) => i[1]).join(' '));
    if (/\b(application|body|req)\b/.test(code)) leaks.push(m[1].trim());
  }
  check('no applicant value reaches a log line', leaks, []);
  check('a javascript: CV link is refused', /protocol === 'https:' \|\| u\.protocol === 'http:'/.test(api), true);
  check('POST only', /Use POST\./.test(api), true);

  /* Vercel routes web/api/*.js by filename; the local preview has a hand-kept
     map, and a function missing from it 404s locally and works in production. */
  const serve = readFileSync(new URL('../web/serve.js', import.meta.url), 'utf8');
  check('the dev server knows the route', /'\/api\/apply': '\.\/api\/apply\.js'/.test(serve), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
