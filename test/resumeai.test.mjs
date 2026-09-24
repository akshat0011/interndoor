/**
 * Bring-your-own-key resume AI.
 *
 * THE TWO THINGS THAT MUST NOT BREAK, in order:
 *
 *   1. The key goes to Google and NOWHERE ELSE, in a HEADER and never a URL. A
 *      key in a query string lands in browser history, in referrers and in
 *      every proxy log on the way. The call is therefore made with a stubbed
 *      fetch and the recorded request is inspected — a source grep cannot tell
 *      you where a value ends up, which is the lesson /api/apply and
 *      /api/feedback both learned the expensive way.
 *
 *   2. An AI score never attaches to the wrong posting. The model answers with
 *      indices; a fabricated or out-of-range index must be DROPPED, not
 *      clamped, because showing somebody a 95% fit against a role that is not
 *      the one they are reading is worse than showing them nothing.
 *
 * `resumeai.js` is browser code, but nothing in it touches the DOM at import
 * time — every localStorage access is inside a function, inside a try — so it
 * imports cleanly into Node and the pure half is tested directly rather than
 * by reading its source.
 */
import { readFileSync } from 'node:fs';
import {
  resumeNames, spellingsOf, normSkill, SKILL_ALIASES,
  shortlist, clampJob, buildRankPrompt, findInventedSkills,
  looksLikeKey, endpointFor, explainFailure,
  rankWithAI, tailorWithAI, MODEL, RANK_MODEL, TAILOR_MODEL, RANK_BATCH, KEY_STORE,
} from '../web/public/resumeai.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
/** Turn an unexpected throw into one failed check rather than an aborted file —
 *  a file that dies takes every assertion after it with it, and `npm test`
 *  stops at that link of the && chain. */
async function returns(label, fn, expected) {
  let actual;
  try { actual = await fn(); } catch (err) { actual = `THREW: ${err.message}`; }
  check(label, actual, expected);
}

const hay = (t) => ` ${normSkill(t)} `;

console.log('\n== skill spellings: the fix for the silent ranking failure ==');
// MEASURED 23 Sep 2026 over the live boards: a resume written in abbreviations
// drew a fit line on 145 of 399 India roles and 790 of 3,884 US roles before
// this, against 211 and 1,677 after. A resume that spells the same skills out
// was UNCHANGED (247 -> 247, 2,183 -> 2,187), which is what makes this a
// widening rather than a change of answer.
const abbrev = hay('Skills: JS, TS, React, Node, Mongo, Postgres, AWS, K8s, ML, NLP, DSA, OOP, CPP');
check('js matches JavaScript', resumeNames(abbrev, 'JavaScript'), true);
check('k8s matches Kubernetes', resumeNames(abbrev, 'Kubernetes'), true);
check('ml matches machine learning', resumeNames(abbrev, 'Machine Learning'), true);
check('postgres matches PostgreSQL', resumeNames(abbrev, 'PostgreSQL'), true);
check('cpp matches C++', resumeNames(abbrev, 'C++'), true);
check('aws matches Amazon Web Services', resumeNames(abbrev, 'Amazon Web Services'), true);

const spelled = hay('Skills: JavaScript, Kubernetes, machine learning, PostgreSQL');
check('the canonical spelling still matches', resumeNames(spelled, 'JavaScript'), true);
check('and so does its alias target', resumeNames(spelled, 'Kubernetes'), true);

// A widening that admits the wrong skill is worse than no widening.
check('java is NOT javascript', resumeNames(hay('Skills: Java, Spring'), 'JavaScript'), false);
check('a resume naming nothing matches nothing', resumeNames(hay('English literature, editing'), 'Python'), false);
check('an empty haystack never matches', resumeNames('', 'Python'), false);

// Whole-word, not substring — the property the space padding exists for.
check('"go" does not match "algorithms"', resumeNames(hay('algorithms and data'), 'Golang'), false);
check('"r" does not match "for"', resumeNames(hay('worked for a startup'), 'r'), false);
check('"ai" does not match "email"', resumeNames(hay('email marketing'), 'Artificial Intelligence'), false);

console.log('\n== the alias table itself ==');
check('canonical spelling comes first', spellingsOf('JavaScript')[0], 'javascript');
check('unknown skills have exactly one spelling', spellingsOf('COBOL'), ['cobol']);
check('blank skill yields nothing', spellingsOf(''), []);
// Every alias must normalise to something, or it can never be found.
const deadAliases = Object.entries(SKILL_ALIASES)
  .flatMap(([k, v]) => [k, ...v]).filter((s) => !normSkill(s));
check('no alias normalises to empty', deadAliases, []);
// An alias that IS another canonical skill would make two different skills
// interchangeable — react/react native is exactly the pair to keep apart.
const canon = new Set(Object.keys(SKILL_ALIASES).map(normSkill));
const collisions = Object.entries(SKILL_ALIASES)
  .flatMap(([k, v]) => v.map(normSkill).filter((a) => canon.has(a) && normSkill(k) !== a));
check('no alias is itself another canonical skill', collisions, []);

console.log('\n== shortlist: the US board cannot all go to a model ==');
const jobs = Array.from({ length: 200 }, (_, i) => ({ id: `j${i}`, title: `Role ${i}` }));
const byIndex = (j) => 100 - Number(j.id.slice(1));
check('takes only the batch size', shortlist(jobs, byIndex, RANK_BATCH).length, RANK_BATCH);
check('best first', shortlist(jobs, byIndex, 3).map((j) => j.id), ['j0', 'j1', 'j2']);
// A tie must not shuffle: with every local score equal the board order stands,
// which is what a resume from outside engineering produces.
check('ties keep board order', shortlist(jobs, () => 0, 3).map((j) => j.id), ['j0', 'j1', 'j2']);
check('unscorable roles sort last', shortlist(
  [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  (j) => (j.id === 'b' ? null : 50), 3).map((j) => j.id), ['a', 'c', 'b']);
check('a short board is not padded', shortlist([{ id: 'x' }], () => 1, 40).length, 1);
check('an empty board is empty', shortlist([], () => 1, 40), []);

console.log('\n== the endpoint ==');
check('model is in the path', endpointFor(MODEL).includes(MODEL), true);
check('host is Google and nothing else',
  new URL(endpointFor(MODEL)).origin, 'https://generativelanguage.googleapis.com');
check('no query string at all', new URL(endpointFor(MODEL)).search, '');
// The guard is only worth having if it fires. A lookalike host must be refused
// on the ORIGIN, not on a string prefix — the shape §12 fixed in utmUrl.
await returns('a lookalike host is refused',
  () => endpointFor(MODEL, 'https://generativelanguage.googleapis.com.evil.example/v1beta/models'),
  'THREW: refusing to call an unexpected host');
await returns('an unrelated host is refused',
  () => endpointFor(MODEL, 'https://evil.example/v1beta/models'),
  'THREW: refusing to call an unexpected host');

console.log('\n== the two models, and why they are two ==');
/* Google's free tier is 20 calls A DAY and the quota is PER MODEL
   (GenerateRequestsPerDayPerProjectPerModel-FreeTier), so sharing one model
   between ranking and tailoring makes them fight over one bucket. */
check('ranking and tailoring use different models', RANK_MODEL !== TAILOR_MODEL, true);
check('ranking uses the cheap fast one', RANK_MODEL, 'gemini-flash-lite-latest');
check('tailoring keeps the stronger one', TAILOR_MODEL, 'gemini-2.5-flash');
{
  const keep = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{
      text: '{"scores":[],"name":"A","summary":"s","sections":[],"skills":[],"changeNotes":[],"gaps":[]}' }] } }] }) };
  };
  await rankWithAI({ key: 'AIza' + 'z'.repeat(35), resumeText: 'x'.repeat(400), jobs: [{ id: 'a' }] });
  check('the rank call really goes to the rank model', seenUrls[0].includes(RANK_MODEL), true);
  await tailorWithAI({ key: 'AIza' + 'z'.repeat(35), resumeText: 'x'.repeat(400), job: { title: 'T' } });
  check('the tailor call really goes to the tailor model', seenUrls[1].includes(TAILOR_MODEL), true);
  globalThis.fetch = keep;
}

console.log('\n== key shape ==');
check('a classic AIza key passes', looksLikeKey('AIza' + 'b'.repeat(35)), true);
/* GOOGLE HAS TWO KEY FORMATS. AI Studio now issues keys beginning `AQ.`, and
   the first version of this check only knew `AIza` — so it refused the real key
   of the person it was built for. Every fixture here was an AIza string, which
   is exactly why nothing caught it until a real key was tried. */
check('a newer AQ. key passes', looksLikeKey('AQ.Ab8RN6' + 'c'.repeat(40)), true);
check('an AQ. key with dots and dashes passes', looksLikeKey('AQ.Ab8RN6-x_y.' + 'd'.repeat(30)), true);
check('a stub AQ. is refused', looksLikeKey('AQ.short'), false);
check('an email is refused', looksLikeKey('someone@example.com'), false);
check('a truncated paste is refused', looksLikeKey('AIzaSy'), false);
check('empty is refused', looksLikeKey(''), false);
check('undefined is refused', looksLikeKey(undefined), false);
check('whitespace is tolerated', looksLikeKey('  AIza' + 'c'.repeat(35) + '  '), true);

console.log('\n== WHERE THE KEY GOES ==');
const realFetch = globalThis.fetch;
let seen = null;
const KEY = 'AIza' + 'z'.repeat(35);
globalThis.fetch = async (url, init) => {
  seen = { url: String(url), init };
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ scores: [{ i: 0, fit: 80, why: 'python and sql overlap' }] }) }] } }] }),
  };
};

await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: [{ id: 'j1', title: 'SDE Intern' }] });
check('called Google', new URL(seen.url).origin, 'https://generativelanguage.googleapis.com');
check('the key is NOT in the url', seen.url.includes(KEY), false);
check('the key is in the header', seen.init.headers['x-goog-api-key'], KEY);
check('the key is not in the body', String(seen.init.body).includes(KEY), false);

console.log('\n== a score may never attach to the wrong posting ==');
const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const reply = (scores) => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ scores }) }] } }] }),
  });
};

reply([{ i: 0, fit: 90, why: 'ok' }, { i: 2, fit: 10, why: 'no' }]);
let out = await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: three });
check('scores bind by index', [...out.entries()].map(([k, v]) => [k, v.fit]), [['a', 90], ['c', 10]]);

reply([{ i: 99, fit: 90, why: 'ok' }]);
out = await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: three });
check('an out-of-range index is dropped, not clamped', out.size, 0);

reply([{ i: -1, fit: 50, why: 'x' }]);
out = await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: three });
check('a negative index is dropped', out.size, 0);

// A job the board handed us with no id resolves fine but cannot be keyed, so
// its score has nowhere safe to go. Found by mutation: jobs[99] is undefined
// and caught by the !job half, so nothing here reached the id half at all.
reply([{ i: 0, fit: 77, why: 'x' }, { i: 1, fit: 88, why: 'y' }]);
out = await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: [{ title: 'no id' }, { id: 'ok' }] });
check('a job with no id is dropped', [...out.keys()], ['ok']);

reply([{ i: 0, fit: 150, why: 'x' }, { i: 1, fit: -5, why: 'y' }, { i: 2, fit: 'abc', why: 'z' }]);
out = await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: three });
check('an impossible score is dropped', out.size, 0);

reply([{ i: 0, fit: 55, why: 'w'.repeat(400) }]);
out = await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: three });
check('the reason is bounded', out.get('a').why.length, 120);

reply([]);
out = await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: three });
check('no scores is an empty map, not a throw', out.size, 0);
await returns('an empty shortlist makes no request at all',
  async () => (await rankWithAI({ key: KEY, resumeText: 'x', jobs: [] })).size, 0);

console.log('\n== failures say something a student can act on ==');
for (const [status, want] of [[400, /rejected that API key/], [403, /rejected that API key/], [429, /20 AI requests a day/], [500, /trouble/i]]) {
  globalThis.fetch = async () => ({ ok: false, status, json: async () => ({}) });
  let msg = '';
  try { await rankWithAI({ key: KEY, resumeText: 'x'.repeat(400), jobs: three }); }
  catch (err) { msg = err.message; }
  check(`HTTP ${status} explains itself`, want.test(msg), true);
  check(`HTTP ${status} never quotes the key`, msg.includes(KEY), false);
}
check('explainFailure never returns empty', explainFailure(418).length > 0, true);

console.log('\n== the fabrication guard, carried over from the server ==');
const resume = `Akshat Saroha — akshat@example.com — Bengaluru
B.Tech Computer Science, graduating 2027.
Built a REST API in Flask backed by PostgreSQL, deployed with Docker.
Skills: Python, Flask, SQL, Git, Docker, Node.js`;
check('keeps what is really there', findInventedSkills(resume, ['Python', 'Docker']), []);
check('catches an invented skill', findInventedSkills(resume, ['Kubernetes']), ['Kubernetes']);
check('empty list', findInventedSkills(resume, []), []);
check('undefined list', findInventedSkills(resume, undefined), []);

globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    name: 'A', summary: 's', sections: [], skills: ['Python', 'Kubernetes'], changeNotes: [], gaps: [],
  }) }] } }] }),
});
const tailored = await tailorWithAI({ key: KEY, resumeText: resume, job: { title: 'X' } });
check('an invented skill is stripped from the output', tailored.skills, ['Python']);
check('and the student is told which', tailored.removedSkills, ['Kubernetes']);
globalThis.fetch = realFetch;

console.log('\n== prompt bounds ==');
const huge = { title: 'T'.repeat(900), company: 'C', description: 'd'.repeat(50_000), skills: Array(200).fill('s') };
check('title is clamped', clampJob(huge).title.length, 200);
check('description is clamped', clampJob(huge).description.length, 12_000);
check('skills are clamped', clampJob(huge).skills.length, 40);
check('a blank field becomes null, not ""', clampJob({ title: 'x', company: '   ' }).company, null);
check('a missing job does not throw', clampJob(undefined).title, null);
const prompt = buildRankPrompt('RESUME', [{ title: 'A', company: 'X' }, { title: 'B', company: 'Y' }]);
check('every role is indexed', /\[0\][\s\S]*\[1\]/.test(prompt), true);
check('the resume is in the prompt', prompt.includes('RESUME'), true);

console.log('\n== a transient 5xx is retried; a 4xx never is ==');
{
  const keep = globalThis.fetch;
  const okBody = { candidates: [{ content: { parts: [{ text: '{"scores":[{"i":0,"fit":70,"why":"x"}]}' }] } }] };
  const jobs = [{ id: 'a' }];

  // Google 503'd on four of seven consecutive calls while this was measured.
  let calls = 0; const attempts = [];
  globalThis.fetch = async () => {
    calls += 1;
    return calls < 3
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => okBody };
  };
  let out = await rankWithAI({ key: 'AIza' + 'z'.repeat(35), resumeText: 'x'.repeat(400), jobs,
    onAttempt: (n) => attempts.push(n) });
  check('a 503 is retried until it succeeds', out.get('a')?.fit, 70);
  check('and it took three attempts', calls, 3);
  check('the caller is told about each retry', attempts, [2, 3]);

  // Retrying a bad key or a spent quota buys nothing and costs the reader time.
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 400, json: async () => ({}) }; };
  let msg = '';
  try { await rankWithAI({ key: 'AIza' + 'z'.repeat(35), resumeText: 'x'.repeat(400), jobs }); }
  catch (e) { msg = e.message; }
  check('a 400 is NOT retried', calls, 1);
  check('and still explains itself', /rejected that API key/.test(msg), true);

  calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 429, json: async () => ({}) }; };
  try { await rankWithAI({ key: 'AIza' + 'z'.repeat(35), resumeText: 'x'.repeat(400), jobs }); } catch { /* expected */ }
  check('a 429 is NOT retried', calls, 1);

  // A 5xx that never clears must give up rather than loop.
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 500, json: async () => ({}) }; };
  try { await rankWithAI({ key: 'AIza' + 'z'.repeat(35), resumeText: 'x'.repeat(400), jobs }); } catch { /* expected */ }
  check('retries are bounded', calls, 3);

  globalThis.fetch = keep;
}

console.log('\n== the shortlist is sized for the wait, not for coverage ==');
// 25 roles measured 16-25s against ~34s for 40, for the same single request.
check('RANK_BATCH is 25', RANK_BATCH, 25);

console.log('\n== the output budget must survive the model thinking ==');
/* Measured against a real key on a real 40-role shortlist: 4,000 tokens went
   entirely on reasoning (3,839) and returned 146 tokens of truncated JSON —
   MAX_TOKENS, zero usable scores. Pin the budget so it cannot drift back. */
{
  let sawBudget = null;
  const keep = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sawBudget = JSON.parse(init.body).generationConfig.maxOutputTokens;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"scores":[]}' }] } }] }) };
  };
  await rankWithAI({ key: 'AIza' + 'z'.repeat(35), resumeText: 'x'.repeat(400), jobs: [{ id: 'a' }] });
  check('the rank budget leaves room for thinking', sawBudget >= 8000, true);
  globalThis.fetch = keep;
}

console.log('\n== BYOK has to be visible BEFORE the button is pressed ==');
/* Reported live: the key panel was a collapsed grey <details> beside a bright,
   enabled "Tailor it". The only way to discover that tailoring needs a key was
   to press it and be shown an error screen — which reads as a broken site.
   The gate now lives in ONE function that knows about the key; it used to be
   set from three places and none of them did. */
{
  const app = readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
  check('one function owns the primary button', /function syncPrimary\(/.test(app), true);
  const fn = app.slice(app.indexOf('function syncPrimary('), app.indexOf('function syncKeyUi('));
  check('it refuses to enable tailoring without a key', /needsKey/.test(fn) && /btn\.disabled/.test(fn), true);
  check('and says so on the button itself', /Add your key below to tailor/.test(fn), true);
  check('ranking is never gated on a key', /!activeJob[\s\S]*Rank the board/.test(fn), true);
  check('and marked as blocking', /is-required/.test(fn), true);
  // The three old scattered assignments must be gone, or one of them re-enables
  // the button behind syncPrimary's back.
  const strays = (app.match(/\$\('do-tailor'\)\.disabled\s*=/g) || []).length;
  check('no stray enable/disable of the primary button', strays, 0);

  const css = readFileSync(new URL('../web/public/styles.css', import.meta.url), 'utf8');
  check('the blocking state is visually distinct', /\.keybox\.is-required/.test(css), true);
  check('a disabled primary looks unpressable', /\.go\[disabled\]/.test(css), true);
  // §15: never dim text with opacity.
  const dis = css.slice(css.indexOf('.go[disabled]'), css.indexOf('}', css.indexOf('.go[disabled]')));
  check('and does not dim text with opacity', /opacity:\s*0?\.[0-9]/.test(dis), false);
  check('the why-line shows only when blocked', /\.keybox\.is-required \.keyneed\s*\{\s*display:\s*block/.test(css), true);

  /* The panel was a <details>, and the fix for it sitting collapsed was to open
     it from script — which the next redesign dropped, leaving it shut. It is a
     plain block now: nothing to open, so nothing to forget to open. */
  const html = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const modal = html.slice(html.indexOf('id="tailor"'), html.indexOf('id="step-working"'));
  check('found the tailor modal', modal.length > 500, true);
  check('the key panel is never a collapsible <details>', /<details[^>]*keybox/.test(modal), false);
  check('the key panel is in the upload step', /id="keybox"/.test(modal), true);
  // The form collapses once a key is saved. Forget living inside it would leave
  // a saved key that nothing on screen can remove.
  const formStart = modal.indexOf('id="key-form"');
  const formEnd = modal.indexOf('class="keyfine"', formStart);
  check('the key form and the privacy line are both there', formStart > 0 && formEnd > formStart, true);
  check('Forget sits outside the form that collapses', modal.slice(formStart, formEnd).includes('id="forget-key"'), false);
  check('and is still in the panel', modal.includes('id="forget-key"'), true);
  const ui = app.slice(app.indexOf('function syncKeyUi('), app.indexOf('function renderTailored('));
  check('the form collapses only on a saved key', /form\.hidden = have\b/.test(ui), true);
  // Stated once, where the key is decided — it used to be said three times over
  // and read as a policy rather than a tool.
  check('the privacy promise is stated once in the dialog', (modal.match(/never reach/g) || []).length, 1);

  // Resume, key, act. Rank mode has no key step.
  check('three steps in the markup', (modal.match(/class="wstep" data-wiz="[123]"/g) || []).length, 3);
  // Sliced to syncPrimary ALONE: syncSteps is declared right after it, and its
  // own declaration contains "syncSteps()" — a wider slice passes with the call gone.
  const prim = app.slice(app.indexOf('function syncPrimary('), app.indexOf('function syncSteps('));
  check('the steps follow the gate', /\bsyncSteps\(\);/.test(prim), true);
  const steps = app.slice(app.indexOf('function syncSteps('), app.indexOf('function syncKeyUi('));
  check('rank mode hides the key step', /two\.hidden = !tailoring/.test(steps), true);
  check('and numbers its last step 2, not 3', /tailoring \? '3' : '2'/.test(steps), true);
  check('the current step is announced', /setAttribute\('aria-current', 'step'\)/.test(steps), true);
}

console.log('\n== the wiring that is only visible in production ==');
/* No local server sends the CSP header, so a browser call to Google is refused
   ONLY on the live site and nothing in any preview looks wrong. Pin the host in
   connect-src against the real vercel.json. */
const vercel = JSON.parse(readFileSync(new URL('../web/vercel.json', import.meta.url), 'utf8'));
const csp = vercel.headers.flatMap((h) => h.headers).find((h) => /Content-Security-Policy/i.test(h.key)).value;
const connect = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src'));
check('connect-src allows the Gemini host', connect.includes('https://generativelanguage.googleapis.com'), true);
check('and still allows our own origin', connect.includes("'self'"), true);
// script-src is untouched: this adds no inline script and needs no new hash.
check('no unsafe-inline crept into script-src', /script-src[^;]*unsafe-inline/.test(csp), false);

/* resumeai.js is hand-committed like app.js — it must NOT be in the publish
   allowlist, or the scheduler would push half-finished edits every 30 minutes. */
const { publishedPaths } = await import('../src/publish.js');
const published = publishedPaths({ regions: { publish: ['IN', 'US', 'GB'] } }).map(String);
check('resumeai.js is not auto-published', published.some((p) => p.includes('resumeai.js')), false);

/* The retired endpoint must answer honestly rather than 404, because a cached
   app.js keeps POSTing to it for up to a day after the deploy. */
const { default: tailorHandler } = await import('../web/api/tailor.js');
let sent = null;
const stubRes = { status(c) { this._c = c; return this; }, json(b) { sent = { code: this._c, body: b }; return this; }, setHeader() {}, end() { sent = { code: this._c, body: null }; return this; } };
tailorHandler({ method: 'POST', headers: {} }, stubRes);
check('/api/tailor answers 410', sent.code, 410);
check('and names the fix', /reload/i.test(sent.body.error), true);
check('and does not mention a site API key', /GEMINI|site.s API key/i.test(sent.body.error), false);
tailorHandler({ method: 'GET', headers: {} }, stubRes);
check('GET is still 405', sent.code, 405);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
