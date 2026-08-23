import { employmentType, schemaEmploymentType, INTERN, FULL_TIME } from '../src/employment.js';
import { loadConfig, matchTitle } from '../src/config.js';

const cfg = loadConfig();
const isIntern = (t) => matchTitle(t, cfg.titleTerms);
const kind = (t) => employmentType(t, isIntern);

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

console.log('\n== internships, unchanged ==');
check('intern', kind('Software Engineer Intern'), INTERN);
check('internship', kind('2027 US Summer Internship - Early Interest'), INTERN);
check('co-op', kind('Information Technology (IT) Co-op'), INTERN);
check('trainee', kind('Graduate Engineering Trainee'), INTERN);
check('apprentice', kind('Apprentice, Quality Assurance Engineer'), INTERN);
check('summer analyst', kind('2027 Summer Analyst, Technology'), INTERN);

console.log('\n== US campus hiring, which the intern filter refused ==');
// Every one of these is verbatim from a real board on 23 Aug.
check('early career', kind('2026 Early Career Software Engineer'), FULL_TIME);
check('early career, mid-title', kind('Mission Engineer, Air Dominance & Strike, Early Career'), FULL_TIME);
check('new grad', kind('Software Engineer, New Grad'), FULL_TIME);
check('new grad with year', kind('Associate Product Manager, New Grad (2027 Start)'), FULL_TIME);
check('campus', kind('Campus AI Research Engineer – Deep Learning (Full-Time)'), FULL_TIME);
check('graduate role', kind('Graduate Quantitative Trader'), FULL_TIME);
check('university graduate', kind('University Graduate, Software Engineering'), FULL_TIME);

console.log('\n== intern wins when a title says both ==');
// An internship that mentions a graduate scheme is still an internship, and
// employmentType is a field Google reads — getting it backwards is a real error.
check('both words', kind('Summer 2027 Intern - New Grad Program'), INTERN);
check('trainee beats graduate', kind('Graduate Engineer Trainee'), INTERN);

console.log('\n== senior roles ABOUT students are not roles FOR students ==');
check('campus recruiter', kind('Campus Recruiter, Technology'), null);
check('university recruiter', kind('Senior University Recruiter'), null);
check('student program manager', kind('Senior Student Program Manager'), null);
check('early careers lead', kind('Head of Early Careers'), null);
check('grad programme director', kind('Director, Graduate Programme'), null);
check('talent acquisition', kind('Talent Acquisition Partner, Campus'), null);

console.log('\n== neither ==');
check('ordinary senior role', kind('Staff Software Engineer'), null);
check('ordinary role', kind('Backend Engineer'), null);
check('empty', kind(''), null);
check('null', kind(null), null);
// "graduate" on its own is not enough — it appears in requirements-style titles.
check('bare graduate is not a match', kind('Engineer (graduate degree preferred)'), null);

console.log('\n== schema.org mapping ==');
// Google reads employmentType. INTERN and FULL_TIME are not interchangeable.
check('intern maps', schemaEmploymentType(INTERN), 'INTERN');
check('full time maps', schemaEmploymentType(FULL_TIME), 'FULL_TIME');
check('unknown defaults to intern', schemaEmploymentType(null), 'INTERN');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
