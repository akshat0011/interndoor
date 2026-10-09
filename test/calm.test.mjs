/**
 * The calm redesign's data fixes (9 Oct 2026, after hiregram.ai).
 *
 * Three things made pages read as machine-made, and none of them was styling:
 *
 *  - titles typed in capitals for emphasis ("Applied Sciences INTERN"). Only
 *    ordinary job words are calmed: titles are full of acronyms nobody could
 *    list (ABAP, SDLC, ADAS, HANA, WLAN, RHEL), and a mangled acronym misnames
 *    the job where a missed calming costs nothing. Measured on the live board,
 *    a "calm any 4+ capitals" rule changed 51 titles, most of them acronyms.
 *  - a company page reading "Bengaluru · Multiple Locations · Bangalore": two
 *    spellings of one city and an ATS placeholder that names no place.
 *  - a job page repeating its own title as the line under it.
 */
import { calmTitle, publishedTitle } from '../src/titles.js';
import { renderCompanyPage, renderJobPage } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== shouted job words are calmed, acronyms are not ==');
for (const [raw, want] of [
  ['Applied Sciences INTERN', 'Applied Sciences Intern'],
  ['SOFTWARE ENGINEER L2', 'Software Engineer L2'],
  ['CYBER SECURITY ANALYST L2', 'Cyber Security Analyst L2'],
  ['JAVA BACKEND DEVOPS', 'Java Backend DevOps'],
  ['IT ERP SAP DEVSECOPS Apprentice', 'IT ERP SAP DevSecOps Apprentice'],
  ['REACT', 'React'],
]) check(`"${raw}"`, calmTitle(raw), want);
for (const raw of ['Graduate Intern ,D&T, SAP ABAP', 'AI SDLC Engineer AWS Bedrock', 'ADAS Algorithm Integration Engineer',
  'SAP Basis HANA Contractor', 'WLAN- Engineer', 'MS Engineer - RHEL-1', 'VLSI Design Trainee', 'Intern - SCADA',
  'IT - LTSSHF - 20221132', 'Software Engineering PMTS'])
  check(`"${raw}" is left alone`, calmTitle(raw), raw);
check('a title with no run of capitals comes back as it went in', calmTitle('Software Engineer II'), 'Software Engineer II');
check('an absent title stays absent', calmTitle(undefined), undefined);
check('publishedTitle calms the stored title', publishedTitle({ title: 'Data Science INTERN' }), 'Data Science Intern');
check('and the model\'s clean title', publishedTitle({ title: 'x', display_title: 'Hardware Engineering INTERN' }), 'Hardware Engineering Intern');
check('but never an owner\'s own correction', publishedTitle({ title: 'Kept SOFTWARE ENGINEER', original_title: 'old' }), 'Kept SOFTWARE ENGINEER');

console.log('\n== one name per city on a company page ==');
{
  const IN = regionOf('IN');
  const row = (id, location) => ({ id, company: 'Microsoft', title: `Role ${id}`, location, workplaceType: 'On-site',
    bullets: ['a', 'b', 'c'], postedAt: Date.UTC(2026, 9, 1), degreeText: 'Bachelor’s', keySkills: ['python', 'sql', 'java'] });
  /* The answer grid needs two cells or it is not drawn, so the rows carry a
     degree and skills; the grid's Where cell is what this is about. */
  const html = renderCompanyPage('Microsoft', [row('1', 'Bengaluru, Karnataka, India'), row('2', 'Bangalore, Karnataka, India'),
    row('3', 'Multiple Locations'), row('4', 'Hyderabad, Telangana, India')], [], '', { region: IN });
  const where = (html.match(/<dt>Where<\/dt><dd>([^<]*)/) ?? [])[1] ?? '';
  check('the Where cell was found', where.length > 0, true);
  check('Bengaluru is named once, in its own spelling', (where.match(/Bengaluru/g) ?? []).length, 1);
  check('Bangalore is folded into it', /Bangalore/.test(where), false);
  check('an ATS placeholder is not a place', /Multiple Locations/i.test(where), false);
  check('a second real city survives', /Hyderabad/.test(where), true);
  check('the sentence under the heading folds them too', /Multiple Locations|Bangalore/.test((html.match(/class="hub-answer-line">[\s\S]*?<\/p>/) ?? [''])[0]), false);
}

console.log('\n== a job page says its role line only when it adds something ==');
{
  const IN = regionOf('IN');
  const job = { id: '77', company: 'Maersk', title: 'Software Engineer', roleLabel: 'Software Engineer', location: 'Bengaluru, Karnataka, India',
    bullets: ['a', 'b', 'c'], postedAt: Date.UTC(2026, 9, 6) };
  check('a role line equal to the title is not printed', /class="jp-focus"/.test(renderJobPage(job, [], { region: IN })), false);
  check('nor when only the case differs', /class="jp-focus"/.test(renderJobPage({ ...job, roleLabel: 'software engineer' }, [], { region: IN })), false);
  check('a role line that says more is printed', /<p class="jp-focus">HR systems engineering<\/p>/.test(renderJobPage({ ...job, roleLabel: 'HR systems engineering' }, [], { region: IN })), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
