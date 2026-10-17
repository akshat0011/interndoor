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
  shortlist, clampJob, rankDigest, failureFor,
  hayOf, mentions, splitSkillEntry, reconcileTailored, roleKeywords, keywordMatch, keptIn, addHeadline, roleHeadline, tidyContact, supportsSkill, withoutTerm, headingCase,
  rankWithAI, tailorWithAI, RANK_BATCH,
  AI_ENDPOINT, FREE_PER_DAY, DEVICE_STORE, DEVICE_SHAPE, ALLOWANCE_STORE, OLD_KEY_STORE,
  deviceId, allowanceLeft, rememberAllowance, forgetOldKey, istDay, AI_OWNER_STORE, isAIOwner, respell, STANDARD_NAMES,
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

console.log('\n== the browser half names no provider ==');
/* His call, 11 Oct 2026: to a reader this is InternDoor's AI. Every file a
   browser downloads is readable in View Source, so the model names, the
   prompts and the provider's host live on the server (web/api/_prompts.js). */
{
  const served = {
    'resumeai.js': readFileSync(new URL('../web/public/resumeai.js', import.meta.url), 'utf8'),
    'app.js': readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8'),
  };
  for (const [name, src] of Object.entries(served)) {
    check(`${name} never says gemini`, /gemini/i.test(src), false);
    check(`${name} never names the provider's host`, /generativelanguage|googleapis\.com\/v1/i.test(src), false);
    // An import, not a mention: resumeai.js's header names the file in prose.
    check(`${name} never imports the server's prompts`, /from\s+['"][^'"]*_prompts/.test(src), false);
  }
  check('resumeai.js carries no prompt text', /You (score|rewrite) /.test(served['resumeai.js']), false);
  const html = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const dialog = html.slice(html.indexOf('id="tailor"'), html.indexOf('<div class="snack" id="toast"'));
  check('the dialog never names a provider', /google|gemini/i.test(dialog), false);
}

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
check('the server’s count is remembered for today, as AI reads', allowanceLeft(Date.now(), 'rank'), 3);
check('and leaves the tailor count alone', allowanceLeft(Date.now(), 'tailor'), null);
check('a reader sends no owner pass', 'x-ai-owner' in sentTo.init.headers, false);

console.log('\n== THE OWNER PASS ==');
{
  globalThis.localStorage = fakeStorage();
  const PASS = 'a'.repeat(64);
  localStorage.setItem(AI_OWNER_STORE, PASS);
  check('a stored pass makes this browser the owner', isAIOwner(), true);
  globalThis.fetch = answer({ scores: [] }, { extra: { owner: true } });
  await rankWithAI({ resumeText: 'x'.repeat(400), jobs: [{ id: 'j1', title: 'SDE Intern' }], region: 'IN' });
  check('and it is sent as x-ai-owner', answer.seen.init.headers['x-ai-owner'], PASS);
  check('in a header, never the body', JSON.parse(answer.seen.init.body).owner === undefined && !answer.seen.init.body.includes(PASS), true);
  rememberAllowance(0);
  check('the owner is never shown as out of uses', allowanceLeft(), null);
  localStorage.setItem(AI_OWNER_STORE, 'not-a-pass');
  check('a malformed pass is ignored', isAIOwner(), false);
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  check('blocked storage is a reader, not a throw', isAIOwner(), false);
  globalThis.localStorage = fakeStorage();
}

// The answer's shape is the 11 Oct 2026 contract: the original parsed, and the rewrite.
const TINY = { name: 'A', sections: [{ heading: 'Projects', items: [{ id: 'i1', title: 'P', bullets: [{ id: 'i1.b1', text: 'Built it' }] }] }], skills: [] };
globalThis.fetch = answer({ original: TINY, tailored: { ...TINY, sections: [{ heading: 'Projects', items: [{ from: 'i1', title: 'P', bullets: [{ text: 'Built it well', from: ['i1.b1'] }] }] }] } }, { remaining: 2 });
await tailorWithAI({ resumeText: 'x'.repeat(400), job: { title: 'T', description: 'about the role' } });
sentBody = JSON.parse(answer.seen.init.body);
check('a tailor is a tailor', sentBody.task, 'tailor');
check('and carries the role’s description', sentBody.job.description, 'about the role');
check('a tailor’s count is kept as tailors', allowanceLeft(), 2);
check('and is not written as AI reads', allowanceLeft(Date.now(), 'rank'), null);

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
check('a number over the limit is held to it', allowanceLeft(T), FREE_PER_DAY.tailor);
rememberAllowance(99, T, 'rank');
check('and AI reads to theirs', allowanceLeft(T, 'rank'), FREE_PER_DAY.rank);
localStorage.setItem(ALLOWANCE_STORE, JSON.stringify({ day: istDay(T), left: 4 }));
check('an old five-a-day count reads as unknown, not as four tailors', allowanceLeft(T), null);
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
  check('and the spent allowance is remembered, for AI reads', allowanceLeft(Date.now(), 'rank'), 0);
  check('which leaves the tailors alone', allowanceLeft(), null);

  for (const [status, want] of [[429, /2 free resume tailors/], [504, /too long/], [500, /not available/], [502, /not available/]]) {
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
  check('a spent AI read says AI reads', /free AI reads/.test(failureFor(429, 'rank')), true);
}

console.log('\n== skills are read one by one, never as whole lines ==');
/* THE BUG HE REPORTED: the model returned "Programming: Python, JavaScript,
   C++" as ONE skill, the old check called "programming:" invented, and the
   reader's whole skills section was stripped. */
check('a grouped line splits into its group', splitSkillEntry('Programming: Python, JavaScript, C++'), { group: 'Programming', items: ['Python', 'JavaScript', 'C++'] });
check('a bracket keeps its commas', splitSkillEntry('AWS (EC2, S3), Docker').items, ['AWS (EC2, S3)', 'Docker']);
check('a plain skill is one skill', splitSkillEntry('Python'), { group: '', items: ['Python'] });
check('semicolons and bullets split too', splitSkillEntry('Git; Linux • Vercel').items, ['Git', 'Linux', 'Vercel']);
check('an empty entry is empty', splitSkillEntry('  ').items, []);

console.log('\n== whole-word matching that survives punctuation ==');
const H = (t) => hayOf(t);
check('a hyphenated skill matches itself', mentions(H('Built a recommender in scikit-learn.'), 'scikit-learn'), true);
check('a skill at the end of a sentence still counts', mentions(H('I mostly write Python.'), 'Python'), true);
check('the dot inside a name is kept', mentions(H('APIs in Node.js and Express'), 'Node.js'), true);
check('one LLM is the same skill as LLMs', mentions(H('Fine-tuned an LLM'), 'LLMs'), true);
check('and the other way round', mentions(H('Worked with LLMs'), 'LLM'), true);
check('"go" is not inside "algorithms"', mentions(H('algorithms and data'), 'Go'), false);
check('an alias still counts', mentions(H('Skills: JS, K8s'), 'Kubernetes'), true);

console.log('\n== NOTHING THE READER WROTE IS EVER REMOVED ==');
const RESUME_TEXT = `Riya Mehta
riya@example.com
Summary
Builds full-stack apps.
Projects
StudyPortal | 2026
- Built a study portal for 300+ students with React and PostgreSQL.
- Added an AI tutor grounded on the syllabus.
JobBoard | 2026
- Wrote a Playwright scraper into SQLite.
Experience
Android ROM Developer, XDA | 2023 - 2025
- Maintained ROM builds for three devices.
Skills
Programming: Python, JavaScript, C++
Tools: Git, Docker`;
const ORIGINAL = {
  name: 'Riya Mehta', contact: 'riya@example.com', summary: 'Builds full-stack apps.',
  sections: [
    { heading: 'Projects', items: [
      { id: 'i1', title: 'StudyPortal', dates: '2026', bullets: [
        { id: 'i1.b1', text: 'Built a study portal for 300+ students with React and PostgreSQL.' },
        { id: 'i1.b2', text: 'Added an AI tutor grounded on the syllabus.' }] },
      { id: 'i2', title: 'JobBoard', dates: '2026', bullets: [{ id: 'i2.b1', text: 'Wrote a Playwright scraper into SQLite.' }] }] },
    { heading: 'Experience', items: [
      { id: 'i3', title: 'Android ROM Developer', org: 'XDA', dates: '2023 - 2025', bullets: [{ id: 'i3.b1', text: 'Maintained ROM builds for three devices.' }] }] },
  ],
  skills: [{ group: 'Programming', items: ['Python', 'JavaScript', 'C++'] }, { group: 'Tools', items: ['Git', 'Docker'] }],
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const fullTailored = () => ({
  name: 'Riya Mehta', contact: 'riya@example.com', summary: 'Full-stack developer who ships LLM tools.',
  sections: [
    { heading: 'Projects', items: [
      { from: 'i2', title: 'JobBoard', dates: '2026', bullets: [{ text: 'Built a Playwright scraper feeding SQLite.', from: ['i2.b1'] }] },
      { from: 'i1', title: 'StudyPortal', dates: '2026', bullets: [
        { text: 'Grounded an AI tutor on the syllabus.', from: ['i1.b2'] },
        { text: 'Built a React and PostgreSQL study portal for 300+ students.', from: ['i1.b1'] }] }] },
    { heading: 'Experience', items: [
      { from: 'i3', title: 'Android ROM Developer', org: 'XDA', dates: '2023 - 2025', bullets: [{ text: 'Maintained ROM builds for three devices.', from: ['i3.b1'] }] }] },
  ],
  skills: [{ group: 'Programming', items: ['Python', 'JavaScript', 'C++'] }, { group: 'Tools', items: ['Git', 'Docker'] }],
});
const allBullets = (R) => R.sections.flatMap((s) => s.items.flatMap((i) => i.bullets.map((b) => b.text)));
const allSkills = (R) => R.skills.flatMap((g) => g.items.map((x) => x.text));
/** Every original bullet is in the tailored resume, verbatim or as the bullet
 *  that names it as its source; every original skill is in its skills. */
function keepsEverything(t) {
  const tSkills = hayOf(allSkills(t.tailored).join(' , '));
  const lost = [];
  for (const g of ORIGINAL.skills) for (const s of g.items) if (!mentions(tSkills, s)) lost.push(s);
  for (const sec of ORIGINAL.sections) {
    for (const it of sec.items) {
      const home = t.tailored.sections.flatMap((x) => x.items).find((x) => x.title === it.title);
      if (!home) { lost.push(it.title); continue; }
      for (const b of it.bullets) {
        if (!home.bullets.some((x) => x.text === b.text || (x.from ?? []).includes(b.id))) lost.push(b.text);
      }
    }
  }
  return lost;
}

{
  const t = reconcileTailored({ original: clone(ORIGINAL), tailored: fullTailored() }, RESUME_TEXT);
  check('a complete rewrite needs nothing put back', t.restored, 0);
  check('and keeps everything', keepsEverything(t), []);
  check('and adds nothing', t.added, []);
  check('the summary is the rewrite', t.tailored.summary, 'Full-stack developer who ships LLM tools.');
}
{
  const T = fullTailored();
  T.sections[0].items[1].bullets.splice(0, 1);          // drop a bullet
  T.sections.splice(1, 1);                               // drop the whole Experience section
  T.skills = [{ group: 'Programming', items: ['Python'] }]; // drop four skills and a whole group
  const t = reconcileTailored({ original: clone(ORIGINAL), tailored: T }, RESUME_TEXT);
  check('a dropped bullet, section and skills all come back', keepsEverything(t), []);
  check('and the count says how many', t.restored, 6);
  check('a dropped section comes back under its own heading', t.tailored.sections.map((s) => s.heading), ['Projects', 'Experience']);
  check('dropped skills go back in their own group', t.tailored.skills.map((g) => [g.group, g.items.map((x) => x.text)]),
    [['Programming', ['Python', 'JavaScript', 'C++']], ['Tools', ['Git', 'Docker']]]);
  check('nothing put back is called an addition', t.added, []);
}
{
  // The exact shape that used to wipe a skills section.
  const T = fullTailored();
  T.skills = ['Programming: Python, JavaScript, C++', 'Tools: Git, Docker, Containerization'];
  const t = reconcileTailored({ original: clone(ORIGINAL), tailored: T, added: [{ text: 'Containerization', why: 'The role asks for it.' }] }, RESUME_TEXT);
  check('a whole skills line is read as its skills', allSkills(t.tailored), ['Python', 'JavaScript', 'C++', 'Git', 'Docker', 'Containerization']);
  check('only the new one is an addition', t.added.map((a) => [a.kind, a.text, a.why]), [['skill', 'Containerization', 'The role asks for it.']]);
  check('and it is marked in the resume', t.tailored.skills[1].items.find((x) => x.text === 'Containerization').added, true);
}
{
  // An addition the resume does not support is not written in (15 Oct 2026).
  const T = fullTailored();
  T.skills = ['Programming: Python, JavaScript, C++', 'Tools: Git, Docker, PyTorch'];
  const t = reconcileTailored({ original: clone(ORIGINAL), tailored: T, added: [{ text: 'PyTorch', why: 'The role asks for it.' }] }, RESUME_TEXT);
  check('a skill the resume never shows is not added', allSkills(t.tailored), ['Python', 'JavaScript', 'C++', 'Git', 'Docker']);
  check('and is not listed as an addition', t.added, []);
}
{
  const T = fullTailored();
  T.sections[1].items[0].bullets.push({ text: 'Debugged kernel panics across three phones.', from: [] });
  const t = reconcileTailored({ original: clone(ORIGINAL), tailored: T }, RESUME_TEXT);
  check('a new bullet is kept and flagged', t.added.map((a) => [a.kind, a.text]), [['line', 'Debugged kernel panics across three phones.']]);
  const b = t.tailored.sections[1].items[0].bullets.at(-1);
  check('with a key the page can remove it by', [b.added, b.key], [true, t.added[0].key]);
}
{
  // The model linked JobBoard to the Android job's id (seen on a real run).
  const T = fullTailored();
  T.sections[0].items[0].from = 'i3';
  const t = reconcileTailored({ original: clone(ORIGINAL), tailored: T }, RESUME_TEXT);
  const titles = t.tailored.sections.flatMap((s) => s.items.map((i) => i.title));
  check('a wrong link never renames an item', titles.filter((x) => x === 'Android ROM Developer').length, 1);
  check('JobBoard keeps its name', titles.includes('JobBoard'), true);
  check('and nothing is lost', keepsEverything(t), []);
}
{
  // The model forgets its links: an item with no "from", a reworded bullet
  // with none. Neither may be duplicated or called new.
  const T = fullTailored();
  T.sections[0].items[0].from = '';
  T.sections[0].items[1].bullets[1].from = [];   // "Built a React and PostgreSQL study portal for 300+ students."
  const t = reconcileTailored({ original: clone(ORIGINAL), tailored: T }, RESUME_TEXT);
  const titles = t.tailored.sections.flatMap((s) => s.items.map((i) => i.title));
  check('an unlinked item is matched by its title, not duplicated', titles.filter((x) => x === 'JobBoard').length, 1);
  check('an unlinked rewording is matched by its words, not duplicated', allBullets(t.tailored).filter((b) => /study portal/.test(b)).length, 1);
  check('and neither is called an addition', t.added, []);
}
{
  // Employers, titles and dates are facts: the original's always win.
  const T = fullTailored();
  Object.assign(T.sections[1].items[0], { org: 'Google', dates: '2019 - 2025' });
  T.contact = 'someone-else@example.com';
  const t = reconcileTailored({ original: clone(ORIGINAL), tailored: T }, RESUME_TEXT);
  check('an organisation cannot be changed', t.tailored.sections[1].items[0].org, 'XDA');
  check('nor dates', t.tailored.sections[1].items[0].dates, '2023 - 2025');
  check('nor the contact line', t.contact, 'riya@example.com');
}
{
  // The model sometimes puts the summary and the skills in sections.
  const O = clone(ORIGINAL);
  O.summary = '';
  O.skills = [];
  O.sections.unshift({ heading: 'Summary', items: [{ id: 's1', title: 'Builds full-stack apps.', bullets: [] }] });
  O.sections.push({ heading: 'Skills', items: [{ id: 'k1', title: 'Programming: Python, JavaScript, C++', bullets: [] }, { id: 'k2', title: 'Tools', bullets: [{ id: 'k2.b1', text: 'Git, Docker' }] }] });
  const T = fullTailored();
  T.summary = '';
  T.sections.unshift({ heading: 'Summary', items: [{ title: 'Role', bullets: [{ text: 'Full-stack developer who ships LLM tools.', from: [] }] }] });
  const t = reconcileTailored({ original: O, tailored: T }, RESUME_TEXT);
  check('a Summary section becomes the summary', t.tailored.summary, 'Full-stack developer who ships LLM tools.');
  check('so it is never printed twice', t.tailored.sections.some((s) => /summary/i.test(s.heading)), false);
  check('a Skills section becomes skills', t.original.skills.map((g) => [g.group, g.items.map((x) => x.text)]),
    [['Programming', ['Python', 'JavaScript', 'C++']], ['Tools', ['Git', 'Docker']]]);
  check('and is not restored as a job', t.tailored.sections.some((s) => /skill/i.test(s.heading)), false);
  check('everything is still kept', keepsEverything(t), []);
}
{
  const t = reconcileTailored({ original: {}, tailored: fullTailored() }, RESUME_TEXT);
  check('a parse that read nothing says so', t.coverage < 0.5, true);
  const ok = reconcileTailored({ original: clone(ORIGINAL), tailored: fullTailored() }, RESUME_TEXT);
  check('a full parse reads nearly everything', ok.coverage > 0.85, true);
}
{
  /* The property, over many random deletions: whatever the model leaves out,
     nothing of the reader's is missing afterwards. A tiny seeded generator, so
     a failure is reproducible. */
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let worst = [];
  for (let n = 0; n < 300; n++) {
    const T = fullTailored();
    for (const sec of T.sections) {
      sec.items = sec.items.filter(() => rnd() > 0.25);
      for (const it of sec.items) it.bullets = it.bullets.filter(() => rnd() > 0.3);
    }
    T.sections = T.sections.filter(() => rnd() > 0.15);
    for (const g of T.skills) g.items = g.items.filter(() => rnd() > 0.35);
    if (rnd() > 0.7) T.skills = [];
    const lost = keepsEverything(reconcileTailored({ original: clone(ORIGINAL), tailored: T }, RESUME_TEXT));
    if (lost.length) { worst = lost; break; }
  }
  check('300 random drops: nothing of the reader\'s is ever missing', worst, []);
}

console.log('\n== the role\'s keywords ==');
{
  const job = { title: 'LLM Research Intern', keySkills: ['python', 'pytorch', 'llms'], skills: ['python', 'deep learning', 'llm'] };
  // Each long phrase is refused by exactly one rule: four words but short, and
  // three words but over 28 characters.
  const kw = roleKeywords(job, ['LLM Research Intern', 'Real World Data Evaluation', 'Entertainment Domain Adaptation', 'fine-tuning', 'PyTorch']);
  check('the posting\'s key skills come first, each once', kw, ['python', 'pytorch', 'llms', 'deep learning', 'fine-tuning']);
  check('the title is not a keyword', kw.includes('LLM Research Intern'), false);
  // "fine-tuned" is not the keyword "fine-tuning", and an ATS would not count it either.
  check('a near miss is a miss', keywordMatch(['fine-tuning'], 'fine-tuned an LLM').hit, []);
  const m = keywordMatch(kw, 'Python and PyTorch; fine-tuning small LLMs.');
  check('the match counts what the text says', [m.hit, m.miss], [['python', 'pytorch', 'llms', 'fine-tuning'], ['deep learning']]);
}

console.log('\n== the tailor hears the whole role ==');
{
  const j = clampJob({ title: 'T', bullets: Array(15).fill('d'.repeat(400)), keySkills: Array(30).fill('k'), experience: '0-1 years', degreeLevel: 'PG' });
  check('duties are sent, bounded', [j.bullets.length, j.bullets[0].length], [10, 300]);
  check('key skills too', j.keySkills.length, 20);
  check('and who it is for', [j.experience, j.degreeLevel], ['0-1 years', 'PG']);
}
{
  const raw = { original: clone(ORIGINAL), tailored: (() => { const T = fullTailored(); T.skills = [{ group: 'Programming', items: ['Python'] }]; return T; })() };
  globalThis.fetch = answer(raw);
  const t = await tailorWithAI({ resumeText: RESUME_TEXT, job: { title: 'Backend Developer Intern' } });
  check('the real call sets the role as the headline', [t.tailored.headline, t.added[0]?.key], ['Backend Developer', 'headline']);
  check('tailorWithAI returns the reconciled resume', keepsEverything(t), []);
  globalThis.fetch = answer({ original: {}, tailored: {} });
  await returns('an empty answer is an error, not a blank resume',
    () => tailorWithAI({ resumeText: RESUME_TEXT, job: { title: 'X' } }).then(() => 'resolved'),
    'THREW: The AI returned an empty resume. Please try again.');
  globalThis.fetch = realFetch;
}

console.log('\n== prompt bounds ==');
const huge = { title: 'T'.repeat(900), company: 'C', description: 'd'.repeat(50_000), skills: Array(200).fill('s') };
check('title is clamped', clampJob(huge).title.length, 200);
check('description is clamped', clampJob(huge).description.length, 12_000);
check('skills are clamped', clampJob(huge).skills.length, 40);
check('a blank field becomes null, not ""', clampJob({ title: 'x', company: '   ' }).company, null);
check('a missing job does not throw', clampJob(undefined).title, null);
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
  check('spent means the server said zero', /const spent = allowanceLeft\(Date\.now\(\), 'tailor'\) === 0;/.test(prim), true);
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
  check('a spent allowance greys the rank button', /allowanceLeft\(Date\.now\(\), 'rank'\) === 0 && btn\) \{\s*btn\.disabled = true;/.test(rank), true);
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
  // His call, 11 Oct 2026: one small line, not privacy text everywhere. The
  // board's footer line went with it.
  check('the privacy line is said once on the whole page', (html.match(/store your resume/g) || []).length, 1);
  check('and it is on the resume screen, where the resume is handed over', section('step-upload', 'step-review').includes('store your resume'), true);
  check('and the old footer line is gone', /processed in memory/.test(html), false);
  check('and the old long-form privacy copy is gone', /never reach|straight to|goes through InternDoor/.test(modal), false);
  const sum = app.slice(app.indexOf('function syncReview('), app.indexOf('function setResumeText('));
  check('the review fills the allowance line', /\$\('ai-left'\)[\s\S]{0,120}allowanceText\(allowanceLeft\(Date\.now\(\), 'tailor'\)\)/.test(sum), true);

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

console.log('\n== the card, the pane and the result (11 Oct 2026) ==');
{
  const app = readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/public/styles.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../web/public/page.js', import.meta.url), 'utf8');
  const fn = (name) => { const a = app.indexOf(`function ${name}(`); return a < 0 ? '' : app.slice(a, app.indexOf('\n}\n', a) + 2); };

  // Most readers press Apply from the card and never open the role.
  const card = fn('jobCard');
  check('the card offers the tailor', /el\('button', 'tl-b'\)[\s\S]{0,400}openTailor\(job\)/.test(card), true);
  check('and the button is really on the card', /foot\.append\(tl\);/.test(card), true);
  check('and stops the card opening under it', /tl\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); openTailor\(job\); \}\)/.test(card), true);
  const chip = fn('paintTrackControl');
  check('the card has no Track button any more', /el\('button'/.test(chip), false);
  check('only a status chip for a tracked role', /el\('a', 'trk-b is-set'/.test(chip), true);
  const auto = fn('autoTrack');
  check('Apply tracks a role on its own', /T\.track\(trackable\(job\), 'applied'\)/.test(auto), true);
  check('but never moves a tracked role back to Applied', /if \(!T \|\| T\.has\(job\.id\)\) return;/.test(auto), true);
  check('so does a job page\'s Apply', /closest\('a\.btn-apply'\)[\s\S]{0,80}!T\.has\(job\.id\)\) T\.track\(job, 'applied'\)/.test(page), true);

  const pane = fn('renderDetail');
  for (const h of ['Job description', 'Key responsibilities', 'Requirements']) {
    check(`the pane has "${h}"`, pane.includes(`'${h}'`), true);
  }
  check('the pane can be shared', /shareRole\(job, pageHref\)/.test(pane), true);
  check('its actions are pinned to the foot', /const cta = el\('div', 'p-cta'\)[\s\S]*d\.append\(cta\)/.test(pane), true);
  check('the tailor there is a secondary button, not a banner', /const tailorBtn = el\('button', 'alt(?: p-tailor)?'\)/.test(pane), true);
  check('the pinned bar sticks to the bottom', /\.p-cta \{[^}]*position: sticky; bottom: 0/.test(css), true);
  check('on a phone the overlay scrolls, not the pane', /\.pane \{[^}]*overflow: visible[^}]*\}/.test(css), true);

  const modal = html.slice(html.indexOf('id="tailor"'), html.indexOf('<div class="snack" id="toast"'));
  for (const id of ['view-tailored', 'view-original', 'edit-resume', 'copy-text', 'download-pdf', 'resume-original', 'rs-score', 'rs-added', 'rs-gaps', 'rs-changes']) {
    check(`the result has #${id}`, modal.includes(`id="${id}"`), true);
  }
  const result = modal.slice(modal.indexOf('id="step-result"'), modal.indexOf('id="step-error"'));
  check('Download PDF is the result screen\'s one primary', /class="go" id="download-pdf"/.test(result) && (result.match(/class="go"/g) || []).length === 1, true);
  check('Start over is a quiet text button', /class="bare rs-over" id="start-over"/.test(modal), true);
  check('the summary folds away', (modal.match(/<details class="rs-sec"/g) || []).length, 3);
  check('the old removed-skills box is gone', /removed-note|Some skills were removed/.test(modal + app), false);

  check('editing makes the tailored sheet editable', /sheet\.contentEditable = on \? 'true' : 'false'/.test(fn('setEditing')), true);
  check('a paste arrives as plain text', /getData\('text\/plain'\)/.test(app), true);
  check('the score is counted from the sheet as edited', /keywordMatch\(t\.kw, sheetText\(\$\('resume-preview'\)\)\)/.test(fn('renderScore')), true);
  check('an addition can be removed', /removeAdded\(a\.key\)/.test(fn('renderAdded')), true);
  check('the original is never editable', /\$\('edit-resume'\)\.disabled = orig;/.test(fn('showVersion')), true);

  const print = css.slice(css.indexOf('@media print'));
  check('print leaves out the bar and the side panel', /\.rs-bar, \.rs-side/.test(print), true);
  check('an addition carries no highlight in the sheet (his call, 15 Oct 2026)', /\.r-add\s*\{/.test(css), false);
  check('the close button is big enough to hit', /\.modal\.tw #tailor-close \{ width: 40px; height: 40px;/.test(css), true);
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

console.log('\n== A RESPELLED SKILL IS KEPT; A DIFFERENT TOOL IS NOT ==');
{
  const h = hayOf('JavaScript, Node.js, Express.js, RESTful APIs, HTML, CSS, Docker, Flask, GitHub, WebSockets');
  for (const s of ['JS', 'Node', 'Node/Express', 'HTML/CSS', 'REST', 'websockets', 'Express']) check(`"${s}" is kept as its standard spelling`, keptIn(h, s), true);
  check('a qualifier the reader wrote must survive ("Docker (basic)")', keptIn(h, 'Docker (basic)'), false);
  check('FastAPI is not kept by Flask', keptIn(h, 'FastAPI'), false);
  check('Git is not kept by GitHub', keptIn(h, 'Git'), false);
  check('a part that is missing means the whole is missing', keptIn(h, 'Node/Django'), false);

  // The model respells the reader's skills; nothing comes back as a duplicate.
  const data = {
    original: { name: 'K', sections: [], skills: [{ group: 'Languages', items: ['JS', 'Python'] }, { group: 'Web', items: ['Node/Express', 'REST'] }, { group: 'Tools', items: ['Docker (basic)', 'FastAPI'] }] },
    tailored: { name: 'K', sections: [], skills: [{ group: 'Skills', items: ['JavaScript', 'Python', 'Node.js', 'Express.js', 'RESTful APIs', 'Docker', 'Flask'] }] },
    added: [],
  };
  const t = reconcileTailored(data, 'K\nLanguages: JS, Python\nWeb: Node/Express, REST\nTools: Docker (basic), FastAPI');
  check('respelled skills are not put back twice', t.tailored.skills.map((g) => g.group), ['Skills', 'Tools']);
  check('but a dropped qualifier and a different tool are', t.tailored.skills[1].items.map((x) => x.text), ['Docker (basic)', 'FastAPI']);
}

{
  // Seen on a real answer, 11 Oct 2026: an empty "Skills" section whose one
  // item is the word "Skills". That is the heading, not a skill.
  const data = {
    original: { name: 'K', sections: [], skills: [{ group: 'Languages', items: ['Python'] }] },
    tailored: { name: 'K', sections: [{ heading: 'Skills', items: [{ title: 'Skills', bullets: [] }] }, { heading: 'Technical Skills', items: [{ title: 'Technical Skills', bullets: [] }, { title: 'Kotlin', bullets: [] }] }], skills: [{ group: 'Languages', items: ['Python'] }] },
    added: [],
  };
  const t = reconcileTailored(data, 'K\nLanguages: Python\nBuilt an Android app in Kotlin.');
  const all = t.tailored.skills.flatMap((g) => g.items.map((x) => x.text));
  check('the word "Skills" under a Skills heading is not a skill', all.includes('Skills') || all.includes('Technical Skills'), false);
  check('a real skill filed the same way still is', all.includes('Kotlin'), true);
}

console.log('\n== THE PLACE OR LINK BESIDE AN ENTRY IS A FACT ==');
{
  const data = {
    original: { name: 'K', sections: [{ heading: 'Experience', items: [{ id: 'i1', title: 'Web Intern', org: 'Brightleaf', dates: '2024', where: 'Pune, India', bullets: [{ id: 'i1.b1', text: 'Fixed bugs reported by QA.' }] }] }], skills: [] },
    tailored: { name: 'K', sections: [{ heading: 'Experience', items: [{ from: 'i1', title: 'Web Intern', org: 'Brightleaf', dates: '2024', where: 'Remote', bullets: [{ text: 'Fixed bugs reported by the QA team.', from: ['i1.b1'] }] }] }], skills: [] },
    added: [],
  };
  const t = reconcileTailored(data, 'K\nWeb Intern Brightleaf 2024 Pune, India\nFixed bugs reported by QA.');
  check('the original place wins over the rewrite', t.tailored.sections[0].items[0].where, 'Pune, India');
  const lost = reconcileTailored({ ...data, tailored: { ...data.tailored, sections: [] } }, 'K');
  check('and comes back with an item that was put back', lost.tailored.sections[0].items[0].where, 'Pune, India');
}

console.log('\n== THE HEADLINE IS THE ROLE, NOT THE POSTING\'S TITLE (15 Oct 2026) ==');
{
  const t = { tailored: { name: 'K' }, added: [{ key: 'a1', kind: 'skill', text: 'MERN Stack' }] };
  addHeadline(t, { title: '  Software Engineering Intern  ' });
  check('his example: Software Engineering Intern is a Software Engineer', t.tailored.headline, 'Software Engineer');
  check('listed first among the additions, removable like any', t.added.map((a) => [a.key, a.kind]), [['headline', 'headline'], ['a1', 'skill']]);
  addHeadline(t, { title: 'Software Engineering Intern' });
  check('listed once however often it is set', t.added.filter((a) => a.key === 'headline').length, 1);
  const none = { tailored: { name: 'K' }, added: [] };
  addHeadline(none, { title: '' });
  check('no title, no headline', [none.tailored.headline, none.added.length], [undefined, 0]);
  const bare = { tailored: { name: 'K' }, added: [] };
  addHeadline(bare, { title: 'Summer Internship 2026' });
  check('a title naming no role, no headline', [bare.tailored.headline, bare.added.length], [undefined, 0]);
  check('the original never gets one', 'headline' in (reconcileTailored({ original: { name: 'K', sections: [], skills: [] }, tailored: { name: 'K', sections: [], skills: [] } }, 'K').original), false);
  const s = { tailored: { name: 'K', summary: 'Application Engineering Intern with experience building backend services.' }, added: [] };
  addHeadline(s, { title: 'Application Engineering Intern' });
  check('a summary that opens with the posting\'s title names the role instead', s.tailored.summary, 'Application Engineer with experience building backend services.');
  const same = { tailored: { name: 'K', summary: 'Data Engineer who built pipelines.' }, added: [] };
  addHeadline(same, { title: 'Data Engineer' });
  check('a title that is already the role leaves the summary alone', same.tailored.summary, 'Data Engineer who built pipelines.');

  const roles = [
    // his examples
    ['Software Engineering Intern', 'Software Engineer'],
    ['Application Engineering Intern', 'Application Engineer'],
    ['SDE-1', 'Software Development Engineer'],
    // short forms spelled out, the person and not the discipline
    ['SDE Intern', 'Software Development Engineer'],
    ['SDET Intern', 'Software Development Engineer in Test'],
    ['SRE Intern', 'Site Reliability Engineer'],
    ['Software Dev Engineer I', 'Software Development Engineer'],
    ['Data Science Intern', 'Data Scientist'],
    ['Data Analytics Intern', 'Data Analyst'],
    ['Product Management Intern', 'Product Manager'],
    ['UI/UX Design Intern', 'UI/UX Designer'],
    ['VLSI Design Intern', 'VLSI Design Engineer'],
    ['QA Testing Intern', 'QA Tester'],
    ['Software Engineering & Development Intern', 'Software Engineer'],
    ['Research and Development Intern', 'R&D Engineer'],
    // a field with no person in it takes the trade's
    ['Full Stack Intern', 'Full Stack Developer'],
    ['Spring Boot Intern', 'Spring Boot Developer'],
    ['AI/ML Intern', 'AI/ML Engineer'],
    ['Software Intern', 'Software Engineer'],
    // the programme, year, level, code and team go
    ['Graduate Engineer Trainee (GET)', 'Graduate Engineer'],
    ['Trainee Software Engineer', 'Software Engineer'],
    ['Summer 2027 Intern – Software Engineering', 'Software Engineer'],
    ['Intern (Software Engineering)', 'Software Engineer'],
    ['Intern - Product Management', 'Product Manager'],
    ['Applied Scientist I, Ads Trust Science', 'Applied Scientist'],
    ['Software Development Engineer I, L4', 'Software Development Engineer'],
    ['Software Engineer B7', 'Software Engineer'],
    ['C++ Developer IRC281591', 'C++ Developer'],
    ['AWS Data Engineer Returnship', 'AWS Data Engineer'],
    ['Systems Engineer Specialist', 'Systems Engineer'],
    ['Software Engineer, Associate', 'Software Engineer'],
    ['New Grad Software Engineer', 'Software Engineer'],
    ['Campus Graduate Masters Summer Internship - Data Engineer', 'Data Engineer'],
    ['Spring 2027 Software Engineer Co-op', 'Software Engineer'],
    ['software engineering intern', 'Software Engineer'],
    // the poster's own role words stay
    ['Associate Software Engineer', 'Associate Software Engineer'],
    ['Member of Technical Staff Intern', 'Member of Technical Staff'],
    ['Java Spring Boot Developer Intern', 'Java Spring Boot Developer'],
    ['Programmer Analyst Trainee', 'Programmer Analyst'],
    // no role named, or only a bare word: no headline
    ['Summer Internship 2026', ''],
    ['Technology Intern', ''],
    ['Engineering Intern', ''],
    ['Developer Intern', ''],
  ];
  for (const [title, want] of roles) check(`role of "${title}"`, roleHeadline(title), want);
}

console.log('\n== SKILLS KEEP THE READER\'S OWN GROUPS; ADDITIONS MUST BE SUPPORTED (15 Oct 2026) ==');
{
  // The reader's model on a fictional resume: it merged the reader's four
  // groups into two of its own, left MySQL stranded, and added four skills the
  // resume never shows.
  const O = { name: 'R', sections: [], skills: [
    { group: 'Languages', items: ['Java', 'Python', 'JavaScript', 'SQL'] },
    { group: 'Frameworks', items: ['React', 'Node.js', 'Express.js', 'Spring Boot'] },
    { group: 'Databases', items: ['MySQL', 'MongoDB'] },
    { group: 'Tools', items: ['Git', 'Docker', 'Postman'] },
  ] };
  const T = { name: 'R', sections: [], skills: [
    { group: 'Technical Skills', items: ['Node.js', 'MongoDB', 'PostgreSQL', 'AWS', 'JavaScript', 'TypeScript', 'Redis', 'Kafka'] },
    { group: 'Additional Skills', items: ['Java', 'Python', 'SQL', 'React', 'Express.js', 'Spring Boot', 'Git', 'Docker', 'Postman'] },
  ] };
  const text = 'R Languages: Java, Python, JavaScript, SQL Frameworks: React, Node.js, Express.js, Spring Boot Databases: MySQL, MongoDB Tools: Git, Docker, Postman Cut load time by adding Redis caching.';
  const t = reconcileTailored({ original: O, tailored: T }, text);
  check('the lead group, then the reader\'s own groups in their own order', t.tailored.skills.map((g) => [g.group, g.items.map((x) => x.text)]), [
    ['Technical Skills', ['Node.js', 'MongoDB', 'JavaScript', 'Redis']],
    ['Languages', ['Java', 'Python', 'SQL']],
    ['Frameworks', ['React', 'Express.js', 'Spring Boot']],
    ['Databases', ['MySQL']],
    ['Tools', ['Git', 'Docker', 'Postman']],
  ]);
  check('Redis is in the resume\'s own words, so it leads and is no addition; Kafka, AWS, TypeScript and PostgreSQL are not written in', t.added, []);
  const E = { name: 'S', sections: [], skills: [{ group: 'Programming', items: ['C', 'Embedded C', 'Python'] }, { group: 'Hardware', items: ['STM32', 'ESP32'] }] };
  const fake = reconcileTailored({ original: E, tailored: { name: 'S', sections: [], skills: [
    { group: 'Engineering', items: ['SolidWorks', 'Ansys', 'CAD'] }, { group: 'Technical', items: ['C', 'Embedded C', 'Python', 'STM32', 'ESP32'] }] } },
    'S Programming: C, Embedded C, Python Hardware: STM32, ESP32 Wrote STM32 firmware.');
  check('a lead group of skills the resume never shows is gone, and the reader\'s groups stand', fake.tailored.skills.map((g) => g.group), ['Programming', 'Hardware']);
  check('the umbrella name a resume does support stays', supportsSkill(hayOf('Built with MongoDB, Express, React and Node. Deployed with GitHub Actions.'), 'MERN Stack')
    && supportsSkill(hayOf('Deployed with GitHub Actions.'), 'CI/CD'), true);
  check('and one it does not, does not', supportsSkill(hayOf('Built with React and Node.'), 'MERN Stack') || supportsSkill(hayOf('React'), 'Kafka'), false);
  const same = reconcileTailored({ original: O, tailored: { name: 'R', sections: [], skills: [{ group: 'Languages', items: ['JavaScript', 'Java'] }] } }, text);
  check('with no lead group, the reader\'s groups take the model\'s order', same.tailored.skills[0].items.map((x) => x.text), ['JavaScript', 'Java', 'Python', 'SQL']);
}

console.log('\n== THE SUMMARY LOSES A CLAIM, NOT A SENTENCE (15 Oct 2026) ==');
{
  check('a list loses the term and reads', withoutTerm('Application Engineer with experience in Node.js, MongoDB, and AWS.', 'AWS'), 'Application Engineer with experience in Node.js and MongoDB.');
  check('from the front of a list', withoutTerm('Skilled in AWS, Node.js and MongoDB.', 'AWS'), 'Skilled in Node.js and MongoDB.');
  check('from a pair', withoutTerm('Uses Kafka and Redis daily.', 'Kafka'), 'Uses Redis daily.');
  check('a sentence that would not read is dropped', withoutTerm('Skilled in C#.', 'C#'), '');
  const job = { title: 'Backend Intern', keySkills: ['Node.js', 'AWS', 'Kafka'] };
  const t = reconcileTailored({ original: { name: 'K', summary: 'Builds apps.', sections: [], skills: [] }, tailored: { name: 'K', sections: [], skills: [],
    summary: 'Graduate Engineer. Backend Developer with experience in Node.js, MongoDB, and AWS. Built Kafka pipelines. Cut load time by 35%.' } },
    'K Built apps with Node.js and MongoDB. Cut load time by 35%.', { job });
  check('the role stays, the claim goes, a fragment goes', t.tailored.summary, 'Backend Developer with experience in Node.js and MongoDB. Cut load time by 35%.');
}

console.log('\n== HEADINGS IN CAPITALS ARE SET IN TITLE CASE (15 Oct 2026) ==');
{
  check('capitals become title case', ['EDUCATION', 'WORK EXPERIENCE', 'ACHIEVEMENTS AND AWARDS', 'IT SKILLS', 'CO-CURRICULAR'].map(headingCase),
    ['Education', 'Work Experience', 'Achievements and Awards', 'IT Skills', 'Co-Curricular']);
  check('a heading the reader wrote in mixed case is left alone', headingCase('Projects & Open Source'), 'Projects & Open Source');
  const t = reconcileTailored({ original: { name: 'K', sections: [{ heading: 'EDUCATION', items: [{ title: 'B.Tech' }] }], skills: [] },
    tailored: { name: 'K', sections: [{ heading: 'EDUCATION', items: [{ title: 'B.Tech' }] }], skills: [] } }, 'K EDUCATION B.Tech');
  check('in the rewrite only; the original keeps the reader\'s capitals', [t.tailored.sections[0].heading, t.original.sections[0].heading], ['Education', 'EDUCATION']);
}

console.log('\n== THE CONTACT LINE GETS ITS SEPARATORS BACK (15 Oct 2026) ==');
{
  // A real tailor's line: the separator between the email and LinkedIn was
  // lost in the PDF's text layer.
  check('a lost separator between two addresses comes back',
    tidyContact('Delhi, India • +91 98107 80422 • riya@example.com linkedin.com/in/riya • github.com/riya'),
    'Delhi, India • +91 98107 80422 • riya@example.com • linkedin.com/in/riya • github.com/riya');
  check('a line with none at all gets them, the place and the phone kept whole',
    tidyContact('Pune, India +91 98107 80422 riya@example.com https://riya.dev'),
    'Pune, India • +91 98107 80422 • riya@example.com • https://riya.dev');
  check('the reader\'s own separator is kept', tidyContact('riya@example.com | linkedin.com/in/riya | +1 (555) 123-4567'),
    'riya@example.com | linkedin.com/in/riya | +1 (555) 123-4567');
  check('and a middle dot too', tidyContact('Pune · riya@example.com riya.dev'), 'Pune · riya@example.com · riya.dev');
  check('a label stays with what it labels', tidyContact('Email: riya@example.com Phone: +91-9810780422 Bengaluru'),
    'Email: riya@example.com • Phone: +91-9810780422 • Bengaluru');
  check('commas between addresses become separators', tidyContact('riya@example.com, linkedin.com/in/riya, github.com/riya'),
    'riya@example.com • linkedin.com/in/riya • github.com/riya');
  check('a PIN code is not a phone number', tidyContact('Pune, Maharashtra 411001 • riya@example.com'), 'Pune, Maharashtra 411001 • riya@example.com');
  check('a plain place is left alone', tidyContact('Pune, India'), 'Pune, India');
  check('nothing in, nothing out', tidyContact(''), '');
  const t = reconcileTailored({ original: { name: 'K', contact: 'k@example.com linkedin.com/in/k', sections: [], skills: [] },
    tailored: { name: 'K', contact: 'k@example.com linkedin.com/in/k', sections: [], skills: [] } }, 'K k@example.com linkedin.com/in/k');
  check('both resumes carry the tidied line', [t.original.contact, t.tailored.contact], ['k@example.com • linkedin.com/in/k', 'k@example.com • linkedin.com/in/k']);
}

console.log('\n== A SKILLS TABLE\'S LEFT COLUMN IS NOT A SKILL (15 Oct 2026) ==');
{
  // A real tailor printed "Languages, Core CS, Backend, Tools" as a skills line
  // under groups with those very names.
  const skills = [
    { group: '', items: ['Languages', 'Core CS', 'Backend', 'Tools'] },
    { group: 'Languages', items: ['Java', 'Python'] },
    { group: 'Core CS', items: ['OOP', 'DBMS'] },
    { group: 'Backend', items: ['Express.js'] },
    { group: 'Tools', items: ['Git', 'Docker'] },
  ];
  const t = reconcileTailored({ original: { name: 'K', sections: [], skills }, tailored: { name: 'K', sections: [], skills } },
    'K Languages Core CS Backend Tools Java Python OOP DBMS Express.js Git Docker');
  check('the line of group names is gone from both', [t.original.skills.map((g) => g.group), t.tailored.skills.map((g) => g.group)],
    [['Languages', 'Core CS', 'Backend', 'Tools'], ['Languages', 'Core CS', 'Backend', 'Tools']]);
  check('and every real skill stays', t.tailored.skills.flatMap((g) => g.items.map((x) => x.text)), ['Java', 'Python', 'OOP', 'DBMS', 'Express.js', 'Git', 'Docker']);
  const one = reconcileTailored({ original: { name: 'K', sections: [], skills: [{ group: '', items: ['Backend', 'Go'] }, { group: 'Backend', items: ['Express.js'] }] },
    tailored: { name: 'K', sections: [], skills: [{ group: '', items: ['Backend', 'Go'] }, { group: 'Backend', items: ['Express.js'] }] } }, 'K Backend Go Express.js');
  check('one word that happens to be a group\'s name is a skill, and stays', one.tailored.skills[0].items.map((x) => x.text), ['Backend', 'Go']);
}

console.log('\n== A REWRITE MAY NOT CLAIM WHAT THE RESUME NEVER SAYS (12 Oct 2026) ==');
{
  // Flash-Lite's own output on a fictional resume, cut down: it turned real
  // bullets into code reviews and Agile, and said "Skilled in C#".
  const RES = 'Meera Krishnan. Built a Flask REST API backed by PostgreSQL for 40 warehouse staff. '
    + 'Wrote unit tests with pytest and set up a GitHub Actions pipeline. Fixed bugs reported by the QA team. '
    + 'Skills: Python, SQL, Flask, Git.';
  const JOB = { title: 'Software Development Apprentice', skills: ['C#', 'Agile', 'Code Reviews', 'SQL', 'Cloud Technologies'] };
  const original = {
    name: 'Meera Krishnan', summary: '',
    sections: [{ heading: 'Experience', items: [{ id: 'i1', title: 'Software Development Intern', org: 'Kavya Logistics', bullets: [
      { id: 'i1.b1', text: 'Built a Flask REST API backed by PostgreSQL for 40 warehouse staff' },
      { id: 'i1.b2', text: 'Wrote unit tests with pytest and set up a GitHub Actions pipeline' },
      { id: 'i1.b3', text: 'Fixed bugs reported by the QA team' },
    ] }] }],
    skills: [{ group: 'Skills', items: ['Python', 'SQL', 'Flask', 'Git'] }],
  };
  const tailored = {
    name: 'Meera Krishnan',
    summary: 'Developer with a Flask REST API in production. Skilled in C# and Agile team practices. Comfortable with SQL.',
    sections: [{ heading: 'Experience', items: [{ from: 'i1', title: 'Software Development Intern', bullets: [
      { from: ['i1.b1'], text: 'Built a Flask REST API on SQL (PostgreSQL) for 40 warehouse staff' },
      { from: ['i1.b2'], text: 'Performed code reviews and wrote unit tests with pytest' },
      { from: ['i1.b3'], text: 'Fixed bugs reported by the QA team while collaborating with an Agile team' },
      { from: [], text: 'Built internal tools in C#' },
    ] }] }],
    skills: [{ group: 'Skills', items: ['C#', 'Python', 'SQL', 'Flask', 'Git'] }],
  };
  const t = reconcileTailored({ original, tailored }, RES, { job: JOB });
  const lines = t.tailored.sections[0].items[0].bullets.map((b) => b.text);
  check('a rewrite naming a skill the resume has is kept', lines[0], 'Built a Flask REST API on SQL (PostgreSQL) for 40 warehouse staff');
  check('an invented duty goes back to the reader\'s words', lines[1], 'Wrote unit tests with pytest and set up a GitHub Actions pipeline');
  check('so does a line that adds a practice they never named', lines[2], 'Fixed bugs reported by the QA team');
  check('a line the model ADDS is left, because it is listed as an addition', lines[3], 'Built internal tools in C#');
  check('and it is listed', t.added.some((a) => a.kind === 'line' && a.text === 'Built internal tools in C#'), true);
  check('a summary sentence with an unsupported claim is dropped, the rest kept', t.tailored.summary, 'Developer with a Flask REST API in production. Comfortable with SQL.');
  check('it counts what it put back', t.grounded, 3);
  check('an added skill the resume never shows is not written in (15 Oct 2026)', t.tailored.skills.some((g) => g.items.some((x) => x.text === 'C#')), false);

  const allBad = reconcileTailored({ original: { ...original, summary: 'Backend developer.' }, tailored: { ...tailored, summary: 'Skilled in C#. Agile expert.' } }, RES + ' Backend developer.', { job: JOB });
  check('a summary that is all claims falls back to the reader\'s own', allBad.tailored.summary, 'Backend developer.');
  const noJob = reconcileTailored({ original, tailored }, RES);
  check('with no role there is nothing to ground against', [noJob.grounded, noJob.tailored.sections[0].items[0].bullets[1].text], [0, 'Performed code reviews and wrote unit tests with pytest']);

  // And the path a reader actually takes passes the role in.
  globalThis.localStorage = fakeStorage();
  globalThis.fetch = answer({ original, tailored }, { remaining: 4 });
  const live = await tailorWithAI({ resumeText: RES, job: JOB });
  check('tailorWithAI grounds against the role', live.tailored.sections[0].items[0].bullets[1].text, 'Wrote unit tests with pytest and set up a GitHub Actions pipeline');
}

console.log('\n== TOOL NAMES KEEP THEIR CAPITALS ==');
{
  // Flash-Lite's own lines on a fictional resume, 12 Oct 2026.
  check('kafka and python', respell('Built a kafka consumer in python', STANDARD_NAMES), 'Built a Kafka consumer in Python');
  check('the longer name wins', respell('Contributed to react native code', STANDARD_NAMES), 'Contributed to React Native code');
  check('names with dots and symbols', respell('Wrote node.js services in c# on .net with ci/cd', STANDARD_NAMES), 'Wrote Node.js services in C# on .NET with CI/CD');
  check('a resume skill the list lacks', respell('Ran testcontainers suites', ['Testcontainers']), 'Ran Testcontainers suites');
  check('English words that are also tools are left', respell('Handled the rest of the release, ready to go', STANDARD_NAMES), 'Handled the rest of the release, ready to go');
  check('a name inside a longer word is left', respell('Reported on digital reactors', STANDARD_NAMES), 'Reported on digital reactors');
  check('casing already present is never changed', respell('Used PYTHON and Python', STANDARD_NAMES), 'Used PYTHON and Python');
  const original = { name: 'K', sections: [{ heading: 'Experience', items: [{ id: 'i1', title: 'Intern', bullets: [
    { id: 'i1.b1', text: 'wrote python scripts' }, { id: 'i1.b2', text: 'Built a Spring service' }] }] }],
    skills: [{ group: 'Skills', items: ['Python', 'Spring Boot'] }] };
  const tailored = { name: 'K', summary: 'Engineer using python and spring boot.', sections: [{ heading: 'Experience', items: [{ from: 'i1', title: 'Intern', bullets: [
    { from: ['i1.b1'], text: 'wrote python scripts' }, { from: ['i1.b2'], text: 'Built a spring boot service in python' }] }] }],
    skills: [{ group: 'Skills', items: ['Python', 'Spring Boot'] }] };
  const t = reconcileTailored({ original, tailored }, 'K. wrote python scripts. Built a Spring service. Python, Spring Boot.');
  const b = t.tailored.sections[0].items[0].bullets.map((x) => x.text);
  check('a rewritten line gets its capitals back', b[1], 'Built a Spring Boot service in Python');
  check('the reader\'s own unchanged line is left as they wrote it', b[0], 'wrote python scripts');
  check('so does the summary', t.tailored.summary, 'Engineer using Python and Spring Boot.');
  // Live answer, 12 Oct 2026: the model's keyword "Data Systems" turned up as
  // "a REST API for Data Systems". A topic phrase is not a tool name.
  const topic = reconcileTailored({ original, tailored: { ...tailored, summary: 'Built a REST API for data systems with postgresql.' }, keywords: ['Data Systems', 'Unit Testing', 'PostgreSQL'] },
    'K. wrote python scripts. Built a Spring service. Python, Spring Boot.');
  check('a keyword that is a topic is not capitalised; a tool still is', topic.tailored.summary, 'Built a REST API for data systems with PostgreSQL.');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
