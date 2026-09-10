/**
 * The learned-vocabulary guard.
 *
 * `learn()` writes to the real state file, so every case here is one that is
 * refused — those return before the first save and cannot touch the vocabulary
 * on disk. The store is asserted empty at the end to keep it that way.
 *
 * What this pins down is the 12 Aug poisoning: `intern`, `trainee`,
 * `apprentice` and `summer analyst` had all been learned as NON-tech. They are
 * the terms the search is built from, so every card LinkedIn returns contains
 * one by construction and they carry no signal at all. Because only a
 * multi-word positive outranks a negative, single-word tech signals could not
 * survive one — `Flutter Developer Intern` was refused before it was ever
 * opened. It ran for a week and was still growing when it was found.
 */
import { learn } from '../src/learned.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

// config.matching.titleMustMatch, which is what src/index.js passes in.
const BLOCKED = ['intern', 'internship', 'trainee', 'co-op', 'coop', 'summer analyst', 'apprentice'];

// Every blocked term genuinely appears here, so nothing below is refused for
// merely being absent from the posting — the blocklist is what fires.
const posting = {
  title: 'Flutter Developer Intern',
  description: 'A paid internship building Flutter apps. Trainee and apprentice '
    + 'tracks run alongside the summer analyst cohort; co-op placements welcome.',
  company: 'Example',
};

const store = { version: 1, terms: {} };
const noBuiltIns = new Map();
const why = (term, opts = {}) => learn(
  store,
  { term, isTech: false, ...posting },
  opts.builtIns ?? noBuiltIns,
  opts.blocked ?? BLOCKED,
).why;

console.log('\n== the terms the search is built from are refused ==');
for (const term of BLOCKED) {
  check(`refuses "${term}"`, why(term), 'a term the search is built from, so every posting contains it');
}

console.log('\n== the term is normalised before it is checked ==');
check('uppercase', why('INTERN'), 'a term the search is built from, so every posting contains it');
check('padded', why('  intern  '), 'a term the search is built from, so every posting contains it');
check('collapsed whitespace', why('summer   analyst'), 'a term the search is built from, so every posting contains it');

console.log('\n== the blocklist does not swallow real vocabulary ==');
// Refused for being absent from the posting, NOT by the blocklist — proves a
// term merely containing a blocked word still reaches the later checks.
check('a longer term containing one', why('research intern programme'), 'not present in the posting');
check('an unrelated term', why('kubernetes'), 'not present in the posting');

console.log('\n== the blocklist is what does the blocking ==');
// Same inputs, empty list: execution must reach a LATER check, never be
// accepted. It no longer reaches the exact built-in test, because the
// tech-word rule below is a strict generalisation of it for negatives — if the
// built-ins call "intern" tech then "intern" is a tech WORD, so a negative
// made only of it is refused a few lines earlier. What both assertions are
// really pinning is that the blocklist is not the thing that caught it.
check('empty list lets "intern" past the blocklist',
  why('intern', { blocked: [], builtIns: new Map([['intern', true]]) }),
  'a negative built only from words the built-in vocabulary calls tech');
check('omitted list defaults to empty',
  learn(store, { term: 'intern', isTech: false, ...posting }, new Map([['intern', true]])).why,
  'a negative built only from words the built-in vocabulary calls tech');

// The exact built-in test is still reachable, and this is the case that proves
// it: the tech-word rule is deliberately asymmetric, so a POSITIVE colliding
// with a built-in negative falls all the way through to it.
check('a positive still meets the exact built-in test',
  learn(store, { term: 'flutter', isTech: true, ...posting },
    new Map([['flutter', false]]), []).why,
  'contradicts the built-in vocabulary');

console.log('\n== a term with no role signal is refused ==');
// "summer internship" is a season plus a term the search is built from. It was
// learned as NON-TECH and vetoed Barclays' Technology Developer, Cyber and
// Security, and Data and Analytics summer internships.
const NOSIGNAL = 'only seasons, cohorts and terms the search is built from';
check('summer internship', why('summer internship'), NOSIGNAL);
check('college intern', why('college intern'), NOSIGNAL);
check('graduate apprentice trainee', why('graduate apprentice trainee'), NOSIGNAL);
check('a positive is refused too', learn(store,
  { term: 'summer internship', isTech: true, ...posting }, noBuiltIns, BLOCKED).why, NOSIGNAL);
// A season bolted onto a REAL term keeps its signal and must survive.
check('summer analyst intern keeps nothing', why('summer analyst'), 'a term the search is built from, so every posting contains it');
check('a domain word survives the strip', why('summer tax intern'), 'not present in the posting');

console.log('\n== a negative made only of tech words is refused ==');
// Gemini named "development" off Hilton's hotel real-estate internship, and
// "Android app development" was refused from then on.
const ALLTECH = 'a negative built only from words the built-in vocabulary calls tech';
const tech = new Map([['software development', true], ['test engineering', true], ['data analyst', true]]);
check('development', why('development', { builtIns: tech }), ALLTECH);
check('test', why('test', { builtIns: tech }), ALLTECH);
check('engineering test', why('engineering test', { builtIns: tech }), ALLTECH);
// A bare year is filler, asserted from both sides.
//
// NOT PINNED, DELIBERATELY: the character class wordsOf splits on. Widening or
// narrowing it (`[^a-z0-9+#.&]+` -> `[^a-z]+`) changes nothing any test can
// see, because every set the guards compare against — techWords, blockedWords —
// is built by wordsOf too, so both sides of every comparison move together. It
// is kept rich so `c++`, `.net` and `r&d` survive as single tokens. Recorded
// rather than papered over with a contrived fixture; section 1's
// indistinguishable-by-construction case, same as the weak-code hoist.
check('a year is stripped', why('2027 test', { builtIns: tech }), ALLTECH);
check('a year alone has no signal', why('2027 internship'), NOSIGNAL);
// A domain qualifier is exactly what must keep a negative alive: these are the
// mechanical/civil refusals section 9 exists to protect.
check('civil engineering survives', why('civil engineering intern', { builtIns: tech }), 'not present in the posting');
check('geotechnical survives', why('geotechnical engineering', { builtIns: tech }), 'not present in the posting');
// Asymmetric on purpose: a POSITIVE agreeing with the built-ins is harmless.
// Read through a LATER refusal rather than an acceptance: an accepted term is
// SAVED, and save() writes the real vocabulary file in the state directory.
// Asserting 'added' here overwrote a 1,507-term vocabulary with one test entry
// on 10 Sep 2026. Every case in this file must be one that returns before the
// first save; "not present in the posting" is the marker that execution got
// past the tech-word rule without being caught by it.
check('a positive built of tech words is not caught', learn(store,
  { term: 'software development', isTech: true, ...posting }, tech, BLOCKED).why,
  'not present in the posting');

console.log('\n== nothing was written ==');
check('the vocabulary is untouched', Object.keys(store.terms), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
