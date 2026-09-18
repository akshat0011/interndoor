import { employmentType, schemaEmploymentType, isInternshipTag, fullTimeWording, INTERN, FULL_TIME } from '../src/employment.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

console.log('\n== LinkedIn\'s own employment chip ==');
/* The deciding vote for a card whose TITLE never says "intern". Joveo
   advertises "Back End Developer" and "Software Engineer" and LinkedIn tags
   both Internship; both were refused on the title while a student browsing the
   same search saw them. */
check('the tag that admits a card', isInternshipTag('Internship'), true);
check('case and padding ignored', isInternshipTag('  internship '), true);
check('the short form too', isInternshipTag('Intern'), true);
/* EXACT MATCH, NOT A SUBSTRING — these are the ones that must never admit. */
check('full-time does not', isInternshipTag('Full-time'), false);
check('part-time does not', isInternshipTag('Part-time'), false);
check('contract does not', isInternshipTag('Contract'), false);
check('a title-shaped string does not', isInternshipTag('Software Engineer Intern'), false);
check('nothing does not', [isInternshipTag(null), isInternshipTag(undefined), isInternshipTag('')], [false, false, false]);

console.log('\n== and the pane is what decides, one click after the title gate ==');
/* Source assertions: src/index.js runs a scan on import and cannot be called.
   Both halves are pinned — that a tech title lacking an intern word is OPENED
   rather than refused, and that the pane's tag then refuses it. Comments are
   stripped first, or a regex matches the prose describing the rule. */
const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('a non-intern title is no longer an unconditional skip',
  /if \(!titleSaysIntern\) \{/.test(idx), true);
check('only a TECH title earns the extra open',
  /nearVerdict\.verdict !== 'tech'/.test(idx), true);
check('and the pane tag is what admits it',
  /mustConfirmInternFromPane && !isInternshipTag\(detail\.employmentTag\)/.test(idx), true);
/* The chip has to actually be read, or the check above always refuses. */
const li = readFileSync(join(ROOT, 'src', 'linkedin.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('linkedin.js parses the chip', /const employmentTag = \(headerText\.match/.test(li), true);
check('and returns it', /workplaceType, employmentTag,/.test(li), true);

console.log('\n== a full-time role is not written up as an internship ==');
{
  /* 132 of 176 stored full-time summaries opened "This internship involves" (15 Sep 2026). */
  check('the stored opening is corrected', fullTimeWording('This internship involves trading systems.'), 'This role involves trading systems.');
  check('the person too', fullTimeWording('The intern will work with Python.'), 'The new hire will work with Python.');
  check('and the article with the noun', fullTimeWording('An internship for an intern.'), 'A role for a new hire.');
  check('plurals', fullTimeWording('Interns join other internships.'), 'New hires join other roles.');
  check('whole words only — internal, internet, international survive',
    fullTimeWording('internal tools on the internet for international teams'), 'internal tools on the internet for international teams');
  check('empty stays empty', [fullTimeWording(null), fullTimeWording('')], [null, '']);

  const pub = readFileSync(join(ROOT, 'src', 'publish.js'), 'utf8');
  check('publish corrects a full-time summary, and only a full-time one',
    /summary: \(row\.employment_type === FULL_TIME \? fullTimeWording\(row\.summary\) : row\.summary\) \|\| null,/.test(pub), true);
  check('past roles carry their employment type to the hub', /employmentType: row\.employment_type \|\| 'intern',/.test(pub.slice(pub.indexOf('const history = tracked'))), true);
  const ol = readFileSync(join(ROOT, 'src', 'ollama.js'), 'utf8');
  check('the enricher is told which kind it is writing about', /`Employment: \$\{/.test(ol), true);
  const st = readFileSync(join(ROOT, 'src', 'store.js'), 'utf8');
  check('and the rows it enriches carry the field', /salary_text AS stipend, employment_type/.test(st), true);
}

console.log('\n== India writes its fresher roles differently, and every one is a full-time role ==');
{
  /* Measured 18 Sep 2026 over 42,128 live board titles: 0 reclassified, 45
     newly full-time, India 10 — Amazon SDE-1, Signzy SDE-1, Icertis and
     Celonis Associate Software Engineer, ZoomInfo and Handshake Software
     Engineer I, Hevo SDE I, Graviton "(2027 Graduate)" ×2. India had 0. */
  check('fresher', kind('Software Engineer - Fresher'), 'fulltime');
  check('freshers hiring drive', kind('Freshers Hiring Drive - Backend'), 'fulltime');
  check('associate software engineer', kind('Associate Software Engineer, Development'), 'fulltime');
  check('associate engineer', kind('Associate Engineer'), 'fulltime');
  check('junior developer', kind('Junior Developer'), 'fulltime');
  check('SDE-1', kind('SDE-1, Expansions Tech and Product'), 'fulltime');
  check('SDE 1 with a space', kind('SDE 1 Fullstack Engineer'), 'fulltime');
  check('SDE I', kind('SDE I'), 'fulltime');
  check('Software Engineer I', kind('Software Engineer I - Salesforce'), 'fulltime');
  check('Software Engineer 1', kind('Software Engineer 1'), 'fulltime');
  check('a graduating batch year', kind('Software Engineer - 2026 Batch'), 'fulltime');
  check('"batch of" form', kind('Batch of 2025 - Software Engineers'), 'fulltime');
  check('"(2027 Graduate)" — the Graviton shape', kind('Software Engineer (2027 Graduate)'), 'fulltime');
  check('an experience range starting at zero', kind('Java Developer (0-2 years)'), 'fulltime');
  check('…with an en dash and "yrs"', kind('Backend Engineer (0–1 yrs)'), 'fulltime');

  /* The lines that must NOT move — the difference between a fresher tab and a
     tab of roles a student cannot get. */
  check('Software Engineer II is not level 1', kind('Software Engineer II'), null);
  check('Software Engineer III is not level 1', kind('Software Engineer III'), null);
  check('SDE II is not SDE I', kind('SDE II'), null);
  check('"Engineer in Test" is not "Engineer I"', kind('Software Engineer in Test'), null);
  check('a bare Software Engineer says nothing about experience', kind('Software Engineer'), null);
  check('a range starting at 1 is not a fresher role', kind('Backend Engineer (1-3 years)'), null);
  check('…even a short one: 1-2 years is not zero', kind('Backend Engineer (1-2 years)'), null);
  check('a wide 0-5 band is not the fresher line either', kind('Engineer (0-5 years)'), null);
  check('"Engineer 10" is not "Engineer 1"', kind('Engineer 10'), null);
  check('senior still wins over any fresher phrase', kind('Senior Associate Software Engineer'), null);
  check('a year alone is not a batch', kind('Software Engineer 2026'), null);
  check('intern still wins outright: Graduate Engineer Trainee is an internship', kind('Graduate Engineer Trainee'), 'intern');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
