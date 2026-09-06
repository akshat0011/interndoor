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
  check('the form script is external, not inline', /<script defer src="\/careers\/apply\.js">/.test(job), true);

  /* THE DUMMY AND THE noindex ARE ONE DECISION, AND THIS IS THE PAIRING.
     The form currently sends nothing and navigates to the homepage. A
     JobPosting page Google has INDEXED whose apply flow goes nowhere is the
     shape §10 says earns a manual action across the whole domain — and this
     domain still carries a previous owner's history. So while the form is a
     dummy the page must be noindex, and whoever restores the POST has to
     remove the meta in the same change. Undoing one alone is the failure. */
  const isDummy = !/fetch\(/.test(applyJs);
  const isNoindex = /<meta name="robots" content="noindex">/.test(job);
  check('the form is currently a dummy', isDummy, true);
  check('a dummy form REQUIRES the page to be noindex', !isDummy || isNoindex, true);
  check('a live form REQUIRES the page to be indexable', isDummy || !isNoindex, true);
  check('the dummy goes to the homepage', /window\.location\.href = '\/'/.test(applyJs), true);

  /* Personal data must never reach a URL. A GET form would put the name, the
     address and the CV link straight into the query string. */
  check('nothing builds a query string', /URLSearchParams|encodeURIComponent|\?.*=.*\+/.test(applyJs), false);
  check('the form is not a GET form', /<form[^>]*method="get"/i.test(job), false);
  check('the no-JS fallback still posts to our own endpoint',
    /method="post" action="\/api\/apply"/.test(job), true);
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
  /* Both, because the copy says part time and LinkedIn's title-description
     alignment rule wants the page and the post to agree. */
  const empType = [].concat(ld.employmentType);
  check('employmentType names INTERN', empType.includes('INTERN'), true);
  check('and PART_TIME, matching the copy', empType.includes('PART_TIME'), true);
  check('the page states the job type', /<span class="pill">Part time<\/span>/.test(job), true);
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
  check('and the role links back to the hub', job.includes('href="/careers"'), true);

  /* vercel.json sets `trailingSlash: false`, so /careers/ 308-redirects to
     /careers. Every link carrying the slash is a needless redirect, and the
     hub's canonical carrying it pointed at a URL that redirects AWAY from the
     page declaring it — the self-contradiction §11 already names. Measured
     live: /careers/ -> 308 -> /careers. */
  for (const [label, f] of [['the role page', job], ['the hub', hub]]) {
    check(`no trailing-slash careers link on ${label}`, /careers\/"/.test(f), false);
  }
  check('the hub canonical has no trailing slash',
    /rel="canonical" href="https:\/\/interndoor\.com\/careers"/.test(hub), true);

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

console.log('\n== THE ENDPOINT, ACTUALLY RUN ==');
{
  /* Every other check in this file reads the SOURCE, and a source grep has
     already been wrong once here — it read the word "application" inside an
     honest log line as a leak. So this section imports the handler and calls
     it. web/api/apply.js reads APPLY_FORWARD_URL once at module load, which is
     why each case re-imports under a fresh query string. */
  const MOD = new URL('../web/api/apply.js', import.meta.url).href;
  const NOT_LIVE = 'Applications are not switched on yet — please check back shortly.';
  const GOOD = { name: 'A Student', email: 'a@example.com', resume: 'https://example.com/cv.pdf' };
  let n = 0;

  async function call(forward, upstream, body, method = 'POST') {
    process.env.APPLY_FORWARD_URL = forward ?? '';
    const mod = await import(`${MOD}?case=${++n}`);
    const sent = [], errs = [];
    const realFetch = globalThis.fetch, realErr = console.error;
    globalThis.fetch = async (url, init) => {
      sent.push({ url, body: init?.body });
      if (upstream instanceof Error) throw upstream;
      return { ok: upstream >= 200 && upstream < 300, status: upstream };
    };
    console.error = (...a) => errs.push(a.join(' '));
    const res = {
      code: 0, payload: null,
      status(c) { this.code = c; return this },
      json(o) { this.payload = o; return this },
      setHeader() {}, end() { return this },
    };
    try { await mod.default({ method, body }, res); }
    finally { globalThis.fetch = realFetch; console.error = realErr; }
    return { code: res.code, payload: res.payload, sent, errs: errs.join(' ') };
  }

  let r = await call('', null, GOOD);
  check('unset: 503', r.code, 503);
  check('unset: says it is not switched on', r.payload.error, NOT_LIVE);
  check('unset: nothing left the building', r.sent.length, 0);

  /* interndoor.com answers 405 — measured against the live site, because
     Vercel refuses POST to a static file. This is the placeholder case. */
  r = await call('https://interndoor.com', 405, GOOD);
  check('405 target: 503, not 502', r.code, 503);
  check('405 target: the SAME message as unset', r.payload.error, NOT_LIVE);
  check('405 target: never invites a retry', /try again/i.test(JSON.stringify(r.payload)), false);
  check('405 target: the log names the fault', /does not accept applications/.test(r.errs), true);
  check('405 target: the webhook URL is NOT logged', /interndoor\.com/.test(r.errs), false);

  for (const st of [404, 410, 501]) {
    r = await call('https://x.example/f', st, GOOD);
    check(`${st} target is the same situation`, [r.code, r.payload.error], [503, NOT_LIVE]);
  }

  /* A transient failure is a different thing and must still say so. */
  r = await call('https://x.example/f', 500, GOOD);
  check('500 target: 502', r.code, 502);
  check('500 target: DOES invite a retry', /try again/i.test(r.payload.error), true);
  r = await call('https://x.example/f', new Error('socket hang up'), GOOD);
  check('a thrown fetch: 502', r.code, 502);
  check('and the applicant sees no stack', /socket hang up/.test(JSON.stringify(r.payload)), false);

  r = await call('https://x.example/f', 200, GOOD);
  check('a working target: 200', r.code, 200);
  const fwd = JSON.parse(r.sent[0].body);
  check('the role travels with it', fwd.role, 'Software Engineering Intern');
  check('and so does the CV link', fwd.resume, GOOD.resume);

  for (const [label, patch] of [['no name', { name: '' }], ['bad email', { email: 'nope' }],
    ['a javascript: CV', { resume: 'javascript:alert(1)' }],
    /* The one this file's own first draft let through: clean() turned the
       newline into a space, so the newline check could never fire. */
    ['a header injection', { email: 'a@b.com\nBcc: x@y.com' }],
    ['a space in the address', { email: 'a@b.com x@y.com' }],
    ['two @ signs', { email: 'a@b@c.com' }],
    ['a domain with no dot', { email: 'a@localhost' }]]) {
    const bad = await call('https://x.example/f', 200, { ...GOOD, ...patch });
    check(`${label}: 400`, bad.code, 400);
    check(`${label}: nothing was forwarded`, bad.sent.length, 0);
  }

  /* Borrowed from the signup endpoint, so it lowercases like that one does. */
  r = await call('https://x.example/f', 200, { ...GOOD, email: 'A.Student@Example.COM' });
  check('the address is lowercased, and only that', JSON.parse(r.sent[0].body).email, 'a.student@example.com');

  r = await call('https://x.example/f', 200, GOOD, 'GET');
  check('GET: 405', r.code, 405);
  delete process.env.APPLY_FORWARD_URL;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
