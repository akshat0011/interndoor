import { dedupePostings } from '../src/publish.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const DAY = 86_400_000;
const AUG = Date.UTC(2026, 7, 20);

/** One store row, shaped the way writeJobsFile hands them over. */
const row = (job_id, company, title, location, { posted = AUG, region = 'IN' } = {}) =>
  ({ row: { job_id, company, title, location, posted_at: posted, first_seen_at: posted }, region });

const ids = (entries) => entries.map((e) => e.row.job_id).sort();

console.log('\n== a country-only location folds into the same role with a real city ==');
// Microsoft's India board writes "India, Karnataka, Bangalore" while LinkedIn
// writes plain "India" for the same vacancy. The city key was `bengaluru` for
// one and `india` for the other, so one role published as two pages — and both
// pages then shared a <title>, which is how it was found.
const msAts = row('ats:microsoft:India:197039', 'Microsoft', 'Research Sciences INTERN', 'India, Karnataka, Bangalore');
const msLi = row('4432065177', 'Microsoft', 'Research Sciences INTERN', 'India', { posted: AUG + DAY });
check('the pair collapses to one', dedupePostings([msAts, msLi]).length, 1);
// ATS wins a cross-collector tie inside SAME_POSTING_MS: it carries the
// employer's real apply URL rather than a LinkedIn redirect.
check('and the ATS row is the survivor', ids(dedupePostings([msAts, msLi])), ['ats:microsoft:India:197039']);
check('order does not decide it', ids(dedupePostings([msLi, msAts])), ['ats:microsoft:India:197039']);

// Beyond three days they are two postings, not two views of one, so the fold
// still defers to the newest — same rule the city-keyed pass uses.
const msOld = row('ats:microsoft:India:111', 'Microsoft', 'Research Sciences INTERN', 'Bengaluru', { posted: AUG - 10 * DAY });
check('a stale ATS row does not suppress a fresh relisting',
  ids(dedupePostings([msOld, msLi])), ['4432065177']);

console.log('\n== but only when the role runs in exactly one city ==');
// The case dedupeKey exists to protect. Bajaj Finserv lists "Functional
// Trainee" in eight real cities; merging a nationally-advertised row into an
// arbitrary one of them would drop a vacancy a student could have chosen.
const bajaj = ['Pune', 'Lucknow', 'Ranchi'].map((c, i) =>
  row(`b${i}`, 'Bajaj Finserv', 'Functional Trainee', `${c}, India`));
const bajajCountry = row('bNat', 'Bajaj Finserv', 'Functional Trainee', 'India');
check('several cities plus a country-only row: nothing merges',
  dedupePostings([...bajaj, bajajCountry]).length, 4);
check('the country-only row survives on its own',
  ids(dedupePostings([...bajaj, bajajCountry])).includes('bNat'), true);
check('and the eight-city case is untouched', dedupePostings(bajaj).length, 3);

console.log('\n== the fold is scoped to one region ==');
// A role advertised as plain "India" says nothing about a Chicago posting, and
// the two are on different boards. roleOf carries the region for that reason.
const inCountry = row('x1', 'Stripe', 'Software Engineer Intern', 'India', { region: 'IN' });
const usCity = row('x2', 'Stripe', 'Software Engineer Intern', 'Chicago', { region: 'US' });
check('a country-only row does not reach across boards', dedupePostings([inCountry, usCity]).length, 2);

console.log('\n== Singapore is a city, not a bare country ==');
// It is a city as much as a country, so "Singapore" IS the most specific
// location there is. Treating it as unknown would fold Jump Trading's Singapore
// internship into whichever other city happened to be the only one.
const jtSg = row('ats:greenhouse:jumptrading:8027952', 'Jump Trading', 'Campus Systems Engineer (Intern)', 'Singapore', { region: 'SG' });
const jtSg2 = row('ats:greenhouse:jumptrading:8027955', 'Jump Trading', 'Campus Python Software Engineer (Intern)', 'Singapore', { region: 'SG' });
check('two Singapore roles stay two', dedupePostings([jtSg, jtSg2]).length, 2);
const jtSgPair = row('ats:greenhouse:jumptrading:9', 'Jump Trading', 'Campus Systems Engineer (Intern)', 'Chicago', { region: 'US' });
check('Singapore is not folded into another city', dedupePostings([jtSg, jtSgPair]).length, 2);

console.log('\n== the country names it recognises ==');
for (const [label, loc] of [
  ['plain India', 'India'],
  ['United States', 'United States'],
  ['USA', 'USA'],
  ['U.S.A.', 'U.S.A.'],
  ['United Kingdom', 'United Kingdom'],
  ['UK', 'UK'],
]) {
  const bare = row('n1', 'Acme', 'Software Intern', loc, { region: 'IN' });
  const city = row('n2', 'Acme', 'Software Intern', 'Bengaluru, Karnataka, India', { region: 'IN' });
  check(`${label} folds in`, dedupePostings([city, bare]).length, 1);
}
// A real city must never be mistaken for a country.
const dublin = row('n3', 'Acme', 'Software Intern', 'Dublin', { region: 'IN' });
const bengaluru = row('n4', 'Acme', 'Software Intern', 'Bengaluru, Karnataka, India', { region: 'IN' });
check('two real cities stay two', dedupePostings([dublin, bengaluru]).length, 2);

console.log('\n== the behaviour that was already there ==');
// The 26 Aug fix: the two collectors write the same US place differently, and
// keeping the state or country in the key published every pair twice.
const abbvieAts = row('ats:smartrecruiters:abbvie:374399', 'AbbVie', '2027 Business Technology Solutions Intern', 'South San Francisco, us', { region: 'US' });
const abbvieLi = row('4448252180', 'AbbVie', '2027 Business Technology Solutions Intern', 'South San Francisco, CA', { region: 'US' });
check('an ATS + LinkedIn twin still collapses', dedupePostings([abbvieAts, abbvieLi]).length, 1);
// The India alias path: the ATS says Bangalore where LinkedIn says Bengaluru.
const groww = [
  row('ats:greenhouse:groww:1', 'Groww', 'Backend Intern', 'Bangalore'),
  row('4400000001', 'Groww', 'Backend Intern', 'Bengaluru, Karnataka, India'),
];
check('the city aliases still collapse a pair', dedupePostings(groww).length, 1);
// Two genuinely different roles at one employer must never merge.
check('different titles stay apart', dedupePostings([
  row('d1', 'Emerson', 'Graduate Engineer Trainee', 'Pune, India'),
  row('d2', 'Emerson', 'Data Engineer Trainee', 'Pune, India'),
]).length, 2);

console.log('\n== degenerate input ==');
check('an empty list is empty', dedupePostings([]).length, 0);
check('a single row survives', dedupePostings([msLi]).length, 1);
// A row with no location at all is already keyed '' by cityOf, so it takes the
// same path as a country-only one rather than a special case of its own.
const noLoc = row('e1', 'Acme', 'Software Intern', null, { region: 'IN' });
check('a null location does not throw', dedupePostings([noLoc]).length, 1);
check('and it folds into the one real city', dedupePostings([noLoc, bengaluru]).length, 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
