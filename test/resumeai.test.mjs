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
  rankWithAI, tailorWithAI, MODEL, RANK_BATCH, KEY_STORE,
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
for (const [status, want] of [[400, /rejected that API key/], [403, /rejected that API key/], [429, /quota/i], [500, /trouble/i]]) {
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
