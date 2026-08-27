import { reelScript } from '../src/reelscript.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
/** The role as it is actually SPOKEN — the clause the clamp governs.
 *  It is its OWN beat ("and the role is X,"), which is why this reads the beat
 *  rather than regexing the joined script: joined, the match ran on into the
 *  applicants clause and every expectation here looked wrong. */
const spoken = (title, extra = {}) => {
  const beats = reelScript({ company: 'Acme', title, city: 'Pune', applicantsCount: 5, ...extra });
  const beat = beats.find((b) => b.startsWith('and the role is '));
  return beat ? beat.slice('and the role is '.length).replace(/[.,]\s*$/, '') : null;
};
const words = (t) => (spoken(t) ?? '').split(' ').filter(Boolean).length;

console.log('\n== the 172-character title that was being read aloud ==');
/* STEMpedia files one role against fifteen cities in the TITLE. The card never
   showed this because it clamps and shrinks to fit; only the voiceover did, and
   it was reading every city out. This is the case the clamp exists for. */
const stem = 'AI And Robotics Trainer Internship in Haryana, Jhajjar, Ambala, Bhiwani, Palwal, Hisar, Jind, Kurukshetra, Gurgaon, Sirsa, Sonipat, Faridabad, Nuh, Charkhi Dadri, Fatehabad';
check('the role survives', spoken(stem), 'AI And Robotics Trainer');
check('and not one city is spoken', /jhajjar|ambala|bhiwani|sirsa|fatehabad/i.test(spoken(stem)), false);

console.log('\n== a place list needs THREE items, so a real role is never cut ==');
// The VO already said the city in the clause before, so a trailing list of
// them is pure repetition. One "in" is not a list.
// "the role is in Machine Learning" is grammatical, and the leading generic
// word is stripped as it always was. The point is only that "in" survives when
// it introduces a subject rather than a list of cities.
check('"in Machine Learning" is part of the job', spoken('Internship in Machine Learning'), 'in Machine Learning');
// roleOnly only ever trims the ENDS, so a generic word in the middle stays.
check('two cities are left alone', spoken('Data Intern in Pune, Mumbai'), 'Data Intern in Pune Mumbai');
check('three or more is a list', spoken('Data Intern in Pune, Mumbai, Delhi'), 'Data');

console.log('\n== separators ==');
check('a pipe ends the role', spoken('AI Training |Internship| Job Opportunity |2026 Graduates'), 'AI Training');
// A dash is NOT reliably a separator, so it is only cut when the title is
// still too long to say.
check('a short dashed title keeps both halves',
  spoken('Trainee Consultant - SAP Process Integration'), 'Trainee Consultant SAP Process Integration');
check('a long one is cut at the dash',
  spoken('Software Developer Trainee - Java & AI/ML | 6-Month Fixed-Term Contract | 2026 Graduates'),
  'Software Developer Trainee Java & AI ML');

console.log('\n== the clamp can never leave nothing to say ==');
/* The failure that would matter: "the role is ." A cut only happens when two
   or more words survive it, so the right-hand side is kept when the left is
   just a generic word. */
check('"Intern - Embedded System" keeps its meaning', spoken('Intern - Embedded System'), 'Embedded System');
check('a bare generic title still yields something', spoken('Software Engineer Intern'), 'Software Engineer');
check('no role clause at all rather than an empty one', spoken('Intern'), null);

console.log('\n== a parenthetical that IS the job ==');
/* speakable() deletes bracketed text, which is right for "(Remote)". But
   Honeywell files "Intern (Bachelor's)" and Yubi "Intern (Data Science)", where
   deleting it leaves the bare word "Intern" -- stripped as redundant -- and the
   reel then says no role at all. Unwrapped only when nothing but a generic word
   sits outside the brackets. */
check('the bracketed role is rescued', spoken('Intern (Data Science)'), 'Data Science');
check('and so is a qualification', spoken("Intern (Bachelor's)"), "Bachelor's");
check('an ordinary parenthetical is still dropped',
  spoken('Software Engineer Intern (Remote)'), 'Software Engineer');
check('and so is a long one', spoken('Data Scientist Intern (Summer 2027, Hybrid)'), 'Data Scientist');

console.log('\n== the hard cap ==');
check('nine words at most', words('Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu') <= 9, true);
// Trailing noise is re-trimmed after the cut, or the cap could expose a "Job".
check('the cap does not leave a trailing "Job"',
  /\b(job|role|position|opportunity)$/i.test(spoken('One Two Three Four Five Six Seven Eight Job') ?? ''), false);

console.log('\n== every published title, against the real boards ==');
const all = [];
for (const f of ['web/public/data/jobs.json', 'web/public/us/data/jobs.json']) {
  all.push(...JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).jobs);
}
// The one that would actually hurt: a title clamped away to nothing, so the
// reel says "and the role is ." out loud.
const emptied = all.filter((j) => {
  const bare = String(j.title).replace(/[^a-z]/gi, '');
  return bare.length > 12 && spoken(j.title) === null;
});
check('no substantial title is clamped to nothing', emptied.length, 0);
const longest = Math.max(...all.map((j) => words(j.title)));
check('nothing exceeds the cap on the live boards', longest <= 9, true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
