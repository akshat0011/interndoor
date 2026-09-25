/**
 * The role focus: only the families he chose are published, posted or scraped.
 *
 * His call, 25 Sep 2026, from a menu built off the live board. The cases below
 * are REAL titles from that board — every one of them was either filed wrong by
 * a first draft of the classifier or is the kind of posting the focus exists
 * to remove.
 */
import { readFileSync } from 'node:fs';
import { roleFamily, roleFocusVerdict, refuseBeforeOpen, VAGUE_FAMILIES } from '../src/rolefocus.js';
import { closableFrom } from '../src/publish.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const KEEP = ['swe', 'ai_ml', 'data_eng', 'backend', 'frontend', 'fullstack', 'mobile', 'devops', 'qa', 'security', 'embedded', 'hardware', 'game_graphics'];
const keeps = (title, roleLabel = null) => roleFocusVerdict({ title, roleLabel }, KEEP).keep;

console.log('\n== the live config is his choice ==');
{
  const cfg = loadConfig();
  check('exactly the 13 families he kept', [...cfg.roleFocus.keep].sort(), [...KEEP].sort());
}

console.log('\n== software stays, whatever else the title names ==');
check('Google\'s networking PhD SWE role is software, not IT', roleFamily('Software Engineer, PhD, Early Career, Networking, 2026 Start'), 'swe');
check('a COBOL/mainframe software engineer is software', roleFamily('Specialist, Software Engineer - COBOL/Mainframe (Enterprise)'), 'swe');
check('SDE I', keeps('Software Development Engineer I'), true);
check('a bare developer', keeps('Developer II - Software Engineering'), true);
check('Test Engineer is QA', roleFamily('Test Engineer'), 'qa');
check('SDET is QA, not generic software', roleFamily('Software Engineer II (Software Engineer in Test)'), 'qa');
check('AI QA is QA, not an AI-training gig', roleFamily('AI Quality Assurance Intern'), 'qa');
check('Google\'s UX engineer is front-end', roleFamily('User Experience Engineer Intern, BS/MS, Summer 2027'), 'frontend');
check('a GPU verification engineer is hardware', roleFamily('GPU Core Pipeline IP Verification Engineer'), 'hardware');
check('embedded', keeps('Embedded Software Intern'), true);
check('data', keeps('Data Engineer-Data Platforms-Azure'), true);
check('ML', keeps('Machine Learning Engineer, 2027 Graduate U.S.'), true);
check('cloud', keeps('Cloud Operations Analyst'), true);
check('security', keeps('Cybersecurity Developer'), true);

console.log('\n== what he dropped comes off ==');
check('Turing\'s coding-expert gigs', keeps('Scientific Coding Expert - Physics and Python'), false);
check('mechanical', keeps('Mechanical Engineering Intern'), false);
check('Salesforce developer', keeps('Salesforce Developer'), false);
check('UX design', keeps('UX Design Intern'), false);
check('quant research', keeps('Quantitative Researcher (2027 Graduate)'), false);
check('service desk', keeps('Service Desk Analyst'), false);
check('robotics', keeps('Intern - Mechatronics'), false);
check('aerospace systems', keeps('Systems Engineering Summer Intern- Onsite'), false);

console.log('\n== a vague title is judged on the posting\'s own label ==');
check('"Intern" that the posting says is software stays', keeps('Intern', 'Software Engineering'), true);
check('"Engineering Intern" that is mechanical goes', keeps('Engineering Intern', 'Mechanical Design'), false);
check('an IT title the posting calls front-end stays', keeps('Associate IT Engineer', 'Frontend Development'), true);
check('a vague title with no label goes', keeps('Graduate Engineer Trainee', null), false);
// A label can only ever KEEP a posting. A title that decides is not overruled.
check('a label cannot keep a title that decides', keeps('Salesforce Developer', 'Software Development'), false);
check('a label cannot remove a software title', keeps('Software Engineer Intern', 'Mechanical Design'), true);
check('the vague families are exactly the ones whose titles do not settle it',
  [...VAGUE_FAMILIES].sort(), ['core_eng', 'generic', 'it_support', 'other', 'product', 'research', 'robotics', 'systems']);

console.log('\n== before an open: refuse on the title, never guess ==');
check('a dropped family is refused before any open', refuseBeforeOpen('Mechanical Engineering Intern', KEEP), 'core_eng');
check('so is a vague NAMED dropped family — every open is a page load', refuseBeforeOpen('Systems Engineering Intern', KEEP), 'systems');
check('a kept family goes through', refuseBeforeOpen('Software Engineer Intern', KEEP), null);
check('a title naming nothing is opened and judged at publish', refuseBeforeOpen('Intern', KEEP), null);
check('...and so is an unclassifiable one', refuseBeforeOpen('Executive 2 ( 83002037 )', KEEP), null);

console.log('\n== absent config changes nothing ==');
check('no keep list keeps everything', roleFocusVerdict({ title: 'Mechanical Engineering Intern' }, undefined).keep, true);
// An EMPTY list is not "keep nothing" — that would wipe every board.
check('an empty keep list keeps everything too', roleFocusVerdict({ title: 'Mechanical Engineering Intern' }, []).keep, true);
check('and refuses nothing before an open', refuseBeforeOpen('Mechanical Engineering Intern', []), null);

console.log('\n== a removed posting\'s page becomes a stub, not a 404 ==');
{
  const cfg = { roleFocus: { keep: KEEP }, matching: { requireCompanyMatch: false } };
  const row = (id, title, extra = {}) => ({ row: { job_id: id, title, company: 'Acme', is_tech: 1, closed_at: null, role_label: null, ...extra }, matchedNow: 'Acme', region: 'US' });
  const out = closableFrom([row('1', 'Mechanical Engineering Intern'), row('2', 'Software Engineer Intern')], cfg, new Set(['US']));
  check('off-focus row is closable', out.map((r) => r.id), ['1']);
  check('without a focus it is not', closableFrom([row('1', 'Mechanical Engineering Intern')], { matching: {} }, new Set(['US'])).length, 0);
}

console.log('\n== the wiring ==');
{
  const pub = readFileSync(new URL('../src/publish.js', import.meta.url), 'utf8');
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  check('the live board filters on the focus',
    /\.filter\(\(\{ row \}\) => \{\s*const v = roleFocusVerdict\(\{ title: row\.title, roleLabel: row\.role_label \}, cfg\.roleFocus\?\.keep\);\s*if \(v\.keep\) return true;\s*droppedOffFocus\+\+;/.test(pub), true);
  check('and says how many it held back', /Held back \$\{droppedOffFocus\} posting/.test(pub), true);
  check('the scan refuses before the open, on the card\'s title',
    /const offFocus = refuseBeforeOpen\(card\.title, cfg\.roleFocus\?\.keep\);\s*if \(offFocus\) \{[\s\S]{0,200}?continue;/.test(idx), true);
  check('...before the posting is ever opened', idx.indexOf('refuseBeforeOpen(card.title') < idx.indexOf('li.openAndExtract(page, card, cfg)'), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
