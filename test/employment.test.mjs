import { employmentType, isSeniorTitle, experienceFloor, admitEntryLevel, ENTRY_MAX_YEARS, schemaEmploymentType, isInternshipTag, fullTimeWording, INTERN, FULL_TIME } from '../src/employment.js';
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

console.log('\n== experienceFloor: the years a posting DEMANDS, or null ==');
{
  check('3+ years', experienceFloor('3+ years of experience in Java'), 3);
  check('a range reads as its floor', experienceFloor('2-4 years experience'), 2);
  check('minimum of', experienceFloor('Minimum of 2 years'), 2);
  check('at least', experienceFloor('at least 3 yrs'), 3);
  check('1-3 years is floor 1', experienceFloor('1-3 years of relevant experience'), 1);
  check('0-1 years is floor 0', experienceFloor('0-1 years'), 0);
  check('N years of <adjectives> experience', experienceFloor('Bachelor degree, 2 years of hands-on experience'), 2);
  check('the LOWEST demand wins when several are stated', experienceFloor('5+ years preferred; minimum 1 year required'), 1);
  check('no number, no floor', experienceFloor('Fresh graduates welcome'), null);
  check('a number about something else is not experience', experienceFloor('We have 5 years of runway and 10 offices'), null);
  check('empty is null', experienceFloor(''), null);
  check('null is null', experienceFloor(null), null);
}

console.log('\n== admitEntryLevel: the facet said entry level; does anything disagree? ==');
{
  const isIntern = (t) => /\b(intern|internship|trainee)\b/i.test(t);
  const base = { title: 'Software Engineer', employmentTag: 'Full-time', seniorityTag: 'Entry level', description: 'Join our platform team. 0-1 years.', isIntern };
  check('a clean entry-level role is full-time', admitEntryLevel(base).kind, 'fulltime');
  check('an intern word in the title makes it an internship, not a refusal', admitEntryLevel({ ...base, title: 'Software Engineer Intern' }).kind, 'intern');
  check('LinkedIn\'s Internship chip makes it an internship', admitEntryLevel({ ...base, employmentTag: 'Internship' }).kind, 'intern');
  check('a senior title is refused whatever the facet says', admitEntryLevel({ ...base, title: 'Senior Software Engineer' }), { kind: null, reason: 'entry-level: senior title' });
  check('Lead too', admitEntryLevel({ ...base, title: 'Lead Engineer' }).kind, null);
  check('a Contract chip is refused', admitEntryLevel({ ...base, employmentTag: 'Contract' }), { kind: null, reason: 'entry-level: LinkedIn tags it Contract' });
  check('a MISSING employment chip is refused — no tag settles nothing', admitEntryLevel({ ...base, employmentTag: null }).reason, 'entry-level: LinkedIn tags it nothing');
  check('a seniority chip that is not Entry level is refused', admitEntryLevel({ ...base, seniorityTag: 'Mid-Senior level' }), { kind: null, reason: 'entry-level: LinkedIn says Mid-Senior level' });
  check('Associate seniority is refused too', admitEntryLevel({ ...base, seniorityTag: 'Associate' }).kind, null);
  check('a missing seniority chip is accepted — the facet already said it', admitEntryLevel({ ...base, seniorityTag: null }).kind, 'fulltime');
  check(`prose demanding ${ENTRY_MAX_YEARS}+ years is refused`, admitEntryLevel({ ...base, description: '3+ years of Java' }), { kind: null, reason: 'entry-level: asks 3+ years' });
  check('exactly the limit is refused', admitEntryLevel({ ...base, description: `minimum ${ENTRY_MAX_YEARS} years` }).kind, null);
  check('under the limit is accepted', admitEntryLevel({ ...base, description: '1-3 years of experience' }).kind, 'fulltime');
  check('the chip is matched whole: "Full-time" not "Full-time Contract"', admitEntryLevel({ ...base, employmentTag: 'Full-time Contract' }).kind, null);
  check('isSeniorTitle is exported and agrees', [isSeniorTitle('Staff Engineer'), isSeniorTitle('Software Engineer')], [true, false]);
}

console.log('\n== the entry-level search is wired into the scan, in the right order ==');
{
  const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const li = readFileSync(join(ROOT, 'src', 'linkedin.js'), 'utf8');
  check('the switch is the search\'s employment key', /const entrySearch = search\.employment === 'fulltime';/.test(idx), true);
  // entryLevelTitleRefusal covers a senior title and, since 25 Sep, a manager one.
  check('a senior title is refused BEFORE the click, only on the entry search',
    /if \(entrySearch && !titleSaysIntern\) \{[\s\S]{0,200}?entryLevelTitleRefusal\(card\.title\)[\s\S]{0,300}?continue;/.test(idx), true);
  check('the pane gate hands admitEntryLevel the seniority chip and the prose',
    /admitEntryLevel\(\{[\s\S]{0,400}?seniorityTag: detail\.seniorityTag,[\s\S]{0,120}?description: detail\.description,/.test(idx), true);
  /* ORDER: the refusal must come before the row is saved. Index of the gate
     against index of the upsert that saves an opened card. */
  const gateAt = idx.indexOf('if (mustConfirmEntryFromPane) {');
  const saveAt = idx.indexOf('employmentType: employmentKind,');
  check('the gate precedes the save', gateAt > 0 && saveAt > gateAt, true);
  // {0,360}: the refusal is also recorded under the job id (REFUSED_AFTER_OPEN).
  check('a refused card is skipped, not saved', /if \(!verdict\.kind\) \{[\s\S]{0,360}?continue;/.test(idx.slice(gateAt, saveAt)), true);
  check('the row carries the kind the gate decided', /employmentType: employmentKind,/.test(idx), true);
  check('the kind defaults to intern for every other search', /let employmentKind = INTERN;/.test(idx), true);
  check('the baseline is read and written under the search\'s own key',
    /lastRegionSweep\(search\.sweepKey \?\? region\)/.test(idx) && /markRegionSweep\(search\.sweepKey \?\? region, sweepMark\)/.test(idx), true);
  /* The seniority chip is read as an exact dot-separated PART. A substring
     test on the header would read "Associate Software Engineer" — the title —
     as the Associate seniority and refuse every such fresher role. */
  check('the seniority regex is anchored to a whole part', /const SENIORITY = \/\^\(Internship\|Entry level\|Associate\|Mid-Senior level\|Director\|Executive\)\$\/i;/.test(li), true);
  check('…and is tested against split parts, never headerText', /parts\.find\(\(x\) => SENIORITY\.test\(x\)\)/.test(li) && !/SENIORITY\.test\(headerText\)/.test(li), true);
  check('openAndExtract returns it', /employmentTag, seniorityTag, applicants,/.test(li), true);
}

console.log('\n== the one phrase every surface uses for the two kinds ==');
{
  const { entryWord, entryWordCap, entryWordTitle, splitKinds, offerPhrase, countedOffer, newCountHeadline } = await import('../src/employment.js');
  const { regionOf } = await import('../src/regions.js');
  const IN = regionOf('IN'), US = regionOf('US'), GB = regionOf('GB');
  /* "InternDoor — Internships & Entry-Level Jobs": one wording on every
     board, his call of 19 Sep 2026. Not "fresher", not "new grad", not
     "graduate" — each reads as foreign on two of the three boards. */
  check('entry-level on India', entryWord(IN), 'entry-level');
  check('entry-level in the US', entryWord(US), 'entry-level');
  check('entry-level in the UK', entryWord(GB), 'entry-level');
  check('and with no region at all', entryWord(undefined), 'entry-level');
  check('a region may still override it', entryWord({ entryWord: 'fresher' }), 'fresher');
  check('sentence case', entryWordCap(IN), 'Entry-level');
  check('title case', entryWordTitle(IN), 'Entry-Level');

  /* Kinds are read off either shape a caller holds. */
  check('the store column', splitKinds([{ employment_type: 'fulltime' }, { employment_type: 'intern' }]), { interns: 1, fullTime: 1 });
  check('the projection', splitKinds([{ employmentType: 'fulltime' }, {}]), { interns: 1, fullTime: 1 });
  check('a row naming neither is an internship', splitKinds([{}]), { interns: 1, fullTime: 0 });

  check('the bare phrase', offerPhrase(IN), 'engineering internships and entry-level jobs');
  check('as roles', offerPhrase(US, { noun: 'roles' }), 'engineering internships and entry-level roles');
  check('singular, with or', offerPhrase(GB, { singular: true, noun: 'roles', joiner: 'or' }), 'engineering internship or entry-level role');
  check('without the adjective', offerPhrase(IN, { adjective: '' }), 'internships and entry-level jobs');

  const both = [{ employmentType: 'fulltime' }, {}, {}, { employment_type: 'fulltime' }];
  /* EACH KIND IS NAMED ONLY WHEN IT IS THERE. "2 internships and 0 entry-level
     jobs" is noise; "0 internships" is the sentence that teaches a reader the
     board is empty. */
  check('both kinds counted', countedOffer(both, IN), '2 engineering internships and 2 entry-level jobs');
  check('internships alone', countedOffer([{}], IN), '1 engineering internship');
  check('entry-level alone', countedOffer([{ employmentType: 'fulltime' }], US, { noun: 'roles' }), '1 entry-level engineering role');
  check('nothing at all is prose, never zero', countedOffer([], GB), 'Engineering internships and entry-level jobs');
  check('live, as roles', countedOffer(both, IN, { live: true, noun: 'roles' }), '2 live engineering internships and 2 live entry-level roles');
  check('thousands are grouped', countedOffer(Array.from({ length: 1234 }, () => ({})), US), '1,234 engineering internships');

  check('the digest headline, mixed', newCountHeadline({ interns: 16, fullTime: 33 }, 'India'), '16 new engineering internships and 33 entry-level engineering roles in India');
  check('the digest headline, entry-level only', newCountHeadline({ interns: 0, fullTime: 1 }, 'the US'), '1 new entry-level engineering role in the US');
  check('the digest headline, internships only', newCountHeadline({ interns: 2, fullTime: 0 }, 'the UK'), '2 new engineering internships in the UK');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
