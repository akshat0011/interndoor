/**
 * The resume AI, browser half (web/public/resumeai.js).
 *
 * THE THINGS THAT MUST NOT BREAK, in order:
 *
 *   1. The resume goes to OUR endpoint and nowhere else, carrying the browser's
 *      id and no key at all. Since 11 Oct 2026 the site's own key lives only on
 *      the server (/api/ai, pinned by test/ai.test.mjs). The call is made with a
 *      stubbed fetch and the recorded request is inspected — a source grep
 *      cannot tell you where a value ends up.
 *
 *   2. An AI score never attaches to the wrong posting. The model answers with
 *      indices; a fabricated or out-of-range index must be DROPPED, not
 *      clamped, because showing somebody a 95% fit against a role that is not
 *      the one they are reading is worse than showing them nothing.
 *
 * `resumeai.js` is shared with the server, so nothing in it touches the DOM or
 * localStorage at import time — every access is inside a function, inside a
 * try — and it imports cleanly into Node.
 */
import { readFileSync } from 'node:fs';
import {
  resumeNames, spellingsOf, normSkill, SKILL_ALIASES,
  shortlist, clampJob, rankDigest, buildRankPrompt, findInventedSkills, failureFor,
  rankWithAI, tailorWithAI, MODEL, RANK_MODEL, TAILOR_MODEL, RANK_BATCH,
  AI_ENDPOINT, FREE_PER_DAY, DEVICE_STORE, DEVICE_SHAPE, ALLOWANCE_STORE, OLD_KEY_STORE,
  deviceId, allowanceLeft, rememberAllowance, forgetOldKey, istDay,
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

/* A localStorage for Node, so the device id and the remembered allowance can
   be tested as they run in a browser. Set and cleared per section. */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}
const realFetch = globalThis.fetch;
/** Our endpoint's answer: { result, remaining } on success. */
const answer = (result, { status = 200, remaining = 3, extra = {} } = {}) => async (url, init) => {
  answer.seen = { url: String(url), init };
  return { ok: status >= 200 && status < 300, status, json: async () => ({ result, remaining, ...extra }) };
};

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

console.log('\n== the two models, and why they are two ==');
check('ranking and tailoring use different models', RANK_MODEL !== TAILOR_MODEL, true);
check('ranking uses the cheap fast one', RANK_MODEL, 'gemini-flash-lite-latest');
check('tailoring keeps the stronger one', TAILOR_MODEL, 'gemini-2.5-flash');
check('MODEL still names the tailor model', MODEL, TAILOR_MODEL);

console.log('\n== WHERE THE RESUME GOES ==');
globalThis.localStorage = fakeStorage();
globalThis.fetch = answer({ scores: [{ i: 0, fit: 80, why: 'python and sql overlap' }] });
await rankWithAI({ resumeText: 'x'.repeat(400), jobs: [{ id: 'j1', title: 'SDE Intern', description: 'd'.repeat(9000) }], region: 'IN' });
let sentTo = answer.seen;
let sentBody = JSON.parse(sentTo.init.body);
check('to our own endpoint', sentTo.url, '/api/ai');
check('which is same-origin, so connect-src self covers it', AI_ENDPOINT.startsWith('/') && !AI_ENDPOINT.startsWith('//'), true);
check('by POST', sentTo.init.method, 'POST');
check('as a rank', sentBody.task, 'rank');
check('with the resume', sentBody.resume.length, 400);
check('with this browser’s id', sentBody.device, deviceId());
check('with the board', sentBody.region, 'IN');
check('and no key of any kind', 'key' in sentBody || JSON.stringify(sentTo.init.headers).toLowerCase().includes('goog'), false);
check('a rank sends no description — the prompt never reads one', 'description' in sentBody.jobs[0], false);
check('and the role it is about', sentBody.jobs[0].title, 'SDE Intern');
check('the server’s count is remembered for today', allowanceLeft(), 3);

globalThis.fetch = answer({ name: 'A', summary: 's', sections: [], skills: [], changeNotes: [], gaps: [] }, { remaining: 2 });
await tailorWithAI({ resumeText: 'x'.repeat(400), job: { title: 'T', description: 'about the role' } });
sentBody = JSON.parse(answer.seen.init.body);
check('a tailor is a tailor', sentBody.task, 'tailor');
check('and carries the role’s description', sentBody.job.description, 'about the role');
check('the new count replaces the old one', allowanceLeft(), 2);

console.log('\n== the browser id ==');
globalThis.localStorage = fakeStorage();
const id1 = deviceId();
check('it has the shape the server accepts', DEVICE_SHAPE.test(id1), true);
check('it is kept', localStorage.getItem(DEVICE_STORE), id1);
check('and the same one comes back', deviceId(), id1);
localStorage.setItem(DEVICE_STORE, 'not an id!');
check('a damaged one is replaced', DEVICE_SHAPE.test(deviceId()) && deviceId() !== 'not an id!', true);
globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
const idA = deviceId();
check('with storage blocked there is still an id', DEVICE_SHAPE.test(idA), true);
check('and it holds for the page', deviceId(), idA);
check('a blocked store remembers no allowance', allowanceLeft(), null);
check('and says so rather than throwing', rememberAllowance(3), false);

console.log('\n== the remembered allowance ==');
globalThis.localStorage = fakeStorage();
const T = Date.UTC(2026, 9, 11, 10, 0);
check('nothing remembered is unknown, not zero', allowanceLeft(T), null);
rememberAllowance(0, T);
check('zero is remembered as zero', allowanceLeft(T), 0);
check('yesterday’s zero says nothing about today', allowanceLeft(T + 86_400_000), null);
rememberAllowance(99, T);
check('a number over the limit is held to it', allowanceLeft(T), FREE_PER_DAY);
check('a nonsense number is refused', rememberAllowance('lots', T), false);
localStorage.setItem(ALLOWANCE_STORE, '{not json');
check('a damaged record reads as unknown', allowanceLeft(T), null);
check('the day is India’s', [istDay(Date.UTC(2026, 9, 11, 18, 29)), istDay(Date.UTC(2026, 9, 11, 18, 30))], ['2026-10-11', '2026-10-12']);

console.log('\n== the old key is cleared ==');
globalThis.localStorage = fakeStorage();
localStorage.setItem(OLD_KEY_STORE, 'AQ.someones-own-key');
check('forgetOldKey removes the stored Google key', forgetOldKey() && localStorage.getItem(OLD_KEY_STORE), null);

console.log('\n== a score may never attach to the wrong posting ==');
globalThis.localStorage = fakeStorage();
const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const reply = (scores) => { globalThis.fetch = answer({ scores }); };

reply([{ i: 0, fit: 90, why: 'ok' }, { i: 2, fit: 10, why: 'no' }]);
let out = await rankWithAI({ resumeText: 'x'.repeat(400), jobs: three });
check('scores bind by index', [...out.entries()].map(([k, v]) => [k, v.fit]), [['a', 90], ['c', 10]]);

reply([{ i: 99, fit: 90, why: 'ok' }]);
out = await rankWithAI({ resumeText: 'x'.repeat(400), jobs: three });
check('an out-of-range index is dropped, not clamped', out.size, 0);

reply([{ i: -1, fit: 50, why: 'x' }]);
out = await rankWithAI({ resumeText: 'x'.repeat(400), jobs: three });
check('a negative index is dropped', out.size, 0);

// A job the board handed us with no id resolves fine but cannot be keyed, so
// its score has nowhere safe to go.
reply([{ i: 0, fit: 77, why: 'x' }, { i: 1, fit: 88, why: 'y' }]);
out = await rankWithAI({ resumeText: 'x'.repeat(400), jobs: [{ title: 'no id' }, { id: 'ok' }] });
check('a job with no id is dropped', [...out.keys()], ['ok']);

reply([{ i: 0, fit: 150, why: 'x' }, { i: 1, fit: -5, why: 'y' }, { i: 2, fit: 'abc', why: 'z' }]);
out = await rankWithAI({ resumeText: 'x'.repeat(400), jobs: three });
check('an impossible score is dropped', out.size, 0);

reply([{ i: 0, fit: 55, why: 'w'.repeat(400) }]);
out = await rankWithAI({ resumeText: 'x'.repeat(400), jobs: three });
check('the reason is bounded', out.get('a').why.length, 120);

reply([]);
out = await rankWithAI({ resumeText: 'x'.repeat(400), jobs: three });
check('no scores is an empty map, not a throw', out.size, 0);
{
  let called = 0;
  globalThis.fetch = async () => { called += 1; return { ok: true, status: 200, json: async () => ({ result: {} }) }; };
  await returns('an empty shortlist makes no request at all',
    async () => (await rankWithAI({ resumeText: 'x', jobs: [] })).size, 0);
  check('not one', called, 0);
}

console.log('\n== failures say something a student can act on ==');
{
  globalThis.localStorage = fakeStorage();
  const said = 'You have used today’s 5 free AI uses. They come back at midnight.';
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ code: 'limit', error: said, remaining: 0 }) });
  let caught = null;
  try { await rankWithAI({ resumeText: 'x'.repeat(400), jobs: three }); } catch (err) { caught = err; }
  check('the server’s own words are shown', caught?.message, said);
  check('with its code', caught?.code, 'limit');
  check('and the spent allowance is remembered', allowanceLeft(), 0);

  for (const [status, want] of [[429, /free AI uses/], [504, /too long/], [500, /not available/], [502, /not available/]]) {
    globalThis.fetch = async () => ({ ok: false, status, json: async () => { throw new Error('not json'); } });
    let msg = '';
    try { await tailorWithAI({ resumeText: 'x'.repeat(400), job: { title: 'X' } }); } catch (err) { msg = err.message; }
    check(`an HTTP ${status} with no words of its own still explains itself`, want.test(msg), true);
  }
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  let msg = '';
  try { await tailorWithAI({ resumeText: 'x'.repeat(400), job: { title: 'X' } }); } catch (err) { msg = err.message; }
  check('no network says so', /Could not reach InternDoor/.test(msg), true);
  // A 200 that carries no result is a failure, not an empty success.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ remaining: 4 }) });
  msg = '';
  try { await tailorWithAI({ resumeText: 'x'.repeat(400), job: { title: 'X' } }); } catch (err) { msg = err.message; }
  // Readable words, not a TypeError from reading .skills off nothing.
  check('a 200 with no result is not a success', /not available/.test(msg), true);
  check('failureFor never returns empty', failureFor(418).length > 0, true);
}

console.log('\n== the fabrication guard, carried over from the server ==');
const resume = `Akshat Saroha — akshat@example.com — Bengaluru
B.Tech Computer Science, graduating 2027.
Built a REST API in Flask backed by PostgreSQL, deployed with Docker.
Skills: Python, Flask, SQL, Git, Docker, Node.js`;
check('keeps what is really there', findInventedSkills(resume, ['Python', 'Docker']), []);
check('catches an invented skill', findInventedSkills(resume, ['Kubernetes']), ['Kubernetes']);
check('empty list', findInventedSkills(resume, []), []);
check('undefined list', findInventedSkills(resume, undefined), []);

globalThis.fetch = answer({
  name: 'A', summary: 's', sections: [], skills: ['Python', 'Kubernetes'], changeNotes: [], gaps: [],
});
const tailored = await tailorWithAI({ resumeText: resume, job: { title: 'X' } });
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
const digest = rankDigest(huge);
check('a rank digest carries no description', 'description' in digest, false);
check('and at most twelve skills', digest.skills.length, 12);
check('and a short summary only', rankDigest({ summary: 's'.repeat(5000) }).summary.length, 220);

console.log('\n== the shortlist is sized for the wait, not for coverage ==');
// 25 roles measured 16-25s against ~34s for 40, for the same single request.
check('RANK_BATCH is 25', RANK_BATCH, 25);


globalThis.fetch = realFetch;
delete globalThis.localStorage;

console.log('\n== one question per screen: the resume, then tailor ==');
/* The key screen that stood between them (23 Sep) went on 11 Oct 2026, when
   the site's own key and a free daily allowance replaced the reader's. These
   pin the order, the gate and the allowance; the look was checked in a browser. */
{
  const app = readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/public/styles.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const modal = html.slice(html.indexOf('id="tailor"'), html.indexOf('<div class="snack" id="toast"'));
  check('found the tailor modal', modal.length > 1000, true);
  const at = (id) => modal.indexOf(`id="${id}"`);
  const section = (id, next) => modal.slice(at(id), at(next));

  check('the two asking screens exist', at('step-upload') > 0 && at('step-review') > 0, true);
  check('in order: resume, review', at('step-upload') < at('step-review'), true);
  check('there is no key screen any more', at('step-key'), -1);
  check('and no key field anywhere in the dialog', /id="ai-key"|type="password"/.test(modal), false);
  check('the review starts hidden', /id="step-review"[^>]*\bhidden\b/.test(modal), true);
  check('the actions live in one footer after every screen', at('tw-foot') > at('step-error'), true);
  for (const id of ['resume-next', 'do-tailor']) {
    check(`${id} is in the footer`, at(id) > at('tw-foot'), true);
  }
  check('the key button is gone from the footer', at('key-next'), -1);
  // The markup and the script must change together, and app.js has a day of
  // stale-while-revalidate. The version on the tag is what keeps them paired.
  check('app.js is versioned with the markup that needs it', /src="\/app\.js\?v=\d+"/.test(html), true);
  // The same day of caching applies to the module app.js imports: an unversioned
  // specifier lets a new app.js link against yesterday's resumeai.js.
  check('app.js imports a versioned resumeai.js', /from '\.\/resumeai\.js\?v=\d+';/.test(app), true);
  check('and never the bare one', /from '\.\/resumeai\.js';/.test(app), false);

  const prim = app.slice(app.indexOf('function syncPrimary('), app.indexOf('function syncSteps('));
  check('one function owns every primary button', prim.length > 200, true);
  check('Continue needs a resume', /next\.disabled = !haveResume;/.test(prim), true);
  check('Tailor needs a resume and a free use left', /go\.disabled = !haveResume \|\| spent;/.test(prim), true);
  check('spent means the server said zero', /const spent = allowanceLeft\(\) === 0;/.test(prim), true);
  check('and says why when it cannot', /'Back tomorrow'/.test(prim), true);
  check('ranking by skills is never gated', /tailorMode === 'tailor' \? 'Continue' : 'Rank the board'/.test(prim), true);
  check('the progress bar follows the gate', /\bsyncSteps\(\);/.test(prim), true);
  for (const id of ['do-tailor', 'resume-next']) {
    const strays = (app.match(new RegExp(`\\$\\('${id}'\\)\\.disabled\\s*=`, 'g')) || []).length;
    check(`no stray enable/disable of ${id}`, strays, 0);
  }

  const wire = app.slice(app.indexOf('function wireTailor('), app.indexOf("$('download-pdf')"));
  check('Continue goes straight to the review', /if \(tailorMode !== 'tailor'\) \{ runTailor\(\); return; \}\s*goTo\('review'\);/.test(wire), true);
  check('the old stored key is cleared at boot', /forgetOldKey\(\);/.test(wire), true);
  check('nothing in app.js handles a key any more', /hasKey|getKey|setKey|looksLikeKey|ai-key|key-next/.test(app), false);

  const run = app.slice(app.indexOf('async function runTailor('), app.indexOf('async function startAiRank('));
  check('a tailor names its board for the counter', /tailorWithAI\(\{ resumeText, job: activeJob, region: REGION \}\)/.test(run), true);
  check('and re-checks the gate afterwards', /finally \{[\s\S]{0,120}syncPrimary\(\);/.test(run), true);
  const rank = app.slice(app.indexOf('async function startAiRank('), app.indexOf('function syncPrimary('));
  check('an AI rank names its board', /rankWithAI\(\{ resumeText, jobs: picked, signal: ctl\.signal, region: REGION \}\)/.test(rank), true);
  check('a spent allowance greys the rank button', /allowanceLeft\(\) === 0 && btn\) \{\s*btn\.disabled = true;/.test(rank), true);
  const bar = app.slice(app.indexOf("const go = el('button', 'rank-ai'") - 200, app.indexOf("go.addEventListener('click', startAiRank)"));
  check('the rank bar does not offer what will be refused', /go\.disabled = spent;/.test(bar), true);

  const steps = app.slice(app.indexOf('function syncSteps('), app.indexOf('function renderTailored('));
  check('two parts in the progress bar', (modal.match(/class="wstep" data-wiz="(upload|review)"/g) || []).length, 2);
  check('and no key part', /data-wiz="key"/.test(modal), false);
  check('the bar hides where there is one screen', /bar\.hidden = !tailoring/.test(steps), true);
  check('the current part is announced', /setAttribute\('aria-current', 'step'\)/.test(steps), true);

  const show = app.slice(app.indexOf('function showStep('), app.indexOf('function goTo('));
  check('the screen change honours reduced motion', /prefers-reduced-motion: reduce/.test(show), true);

  // A <div> in a <dl> may hold only <dt> and <dd> (§15), so Change sits in the dd.
  const review = section('step-review', 'step-working');
  const changes = (review.match(/data-go=/g) || []).length;
  const inDd = (review.match(/<dd>(?:(?!<\/dd>)[\s\S])*?data-go=/g) || []).length;
  check('the review offers Change on the resume', changes, 1);
  check('and it sits inside a <dd>', inDd, changes);
  check('the review says what this costs', /id="ai-left"/.test(review), true);
  check('the privacy position is stated once in the dialog', (modal.match(/does not store it/g) || []).length, 1);
  check('and does not claim the resume never leaves the device', /never reach|straight to Google/.test(modal), false);
  const sum = app.slice(app.indexOf('function syncReview('), app.indexOf('function setResumeText('));
  check('the review fills the allowance line', /\$\('ai-left'\)[\s\S]{0,120}allowanceText\(allowanceLeft\(\)\)/.test(sum), true);

  check('a disabled primary looks unpressable', /\.go\[disabled\]/.test(css), true);
  const dis = css.slice(css.indexOf('.go[disabled]'), css.indexOf('}', css.indexOf('.go[disabled]')));
  check('and does not dim text with opacity', /opacity:\s*0?\.[0-9]/.test(dis), false);
  check('the fine print has its rule', /\.tw-fine \{/.test(css), true);
  check('the key screen’s rules are gone', /\.tw-how|\.tw-input|\.keyset|\.keyfine/.test(css), false);
  const print = css.slice(css.indexOf('@media print'));
  check('print hides the wizard chrome', /\.wiz, \.tw-foot/.test(print), true);
  // .modal.tw outranks print's .modal rule, so the resume would print as a
  // fixed card unless print says it too.
  check('print releases the pinned dialog', /\.modal\.tw[^{]*\{[^}]*position: static/.test(print), true);
}

console.log('\n== the wiring that is only visible in production ==');
/* No local server sends the CSP header. The browser now calls only its own
   origin, so Google's host has no business in connect-src: a leftover allowance
   is a door nothing uses. */
const vercel = JSON.parse(readFileSync(new URL('../web/vercel.json', import.meta.url), 'utf8'));
const csp = vercel.headers.flatMap((h) => h.headers).find((h) => /Content-Security-Policy/i.test(h.key)).value;
const connect = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src'));
check('connect-src no longer allows the Gemini host', connect.includes('generativelanguage.googleapis.com'), false);
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
check('and no longer tells anyone to add a key', /your own|key/i.test(sent.body.error), false);
check('and does not mention a site API key', /GEMINI|site.s API key/i.test(sent.body.error), false);
tailorHandler({ method: 'GET', headers: {} }, stubRes);
check('GET is still 405', sent.code, 405);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
