/**
 * The shelves: every engineering posting is filed Software, Hardware or Misc.
 *
 * His call, 25 Sep 2026 — first a removal, then, the same afternoon, this:
 * nothing dropped, nothing unscraped, Misc kept off WhatsApp and the reels.
 * The titles below are REAL, off the live boards; each was either filed wrong
 * by a draft of the classifier or is one he named himself.
 */
import { readFileSync } from 'node:fs';
import { roleFamily, roleCategory, announceable, announceableIds, settleShelves, OPEN_FAMILIES, RESCUABLE_FAMILIES } from '../src/rolefocus.js';
import { closableFrom } from '../src/publish.js';
import { loadConfig } from '../src/config.js';
import { entryLevelTitleRefusal, admitEntryLevel, employmentType } from '../src/employment.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const FOCUS = {
  software: ['swe', 'ai_ml', 'data_eng', 'backend', 'frontend', 'fullstack', 'mobile', 'devops', 'qa', 'security', 'game_graphics'],
  hardware: ['hardware', 'embedded'],
};
const shelf = (title, roleLabel = null) => roleCategory({ title, roleLabel }, FOCUS).category;

console.log('\n== the live config is his choice ==');
{
  const cfg = loadConfig();
  check('the software shelf', [...cfg.roleFocus.software].sort(), [...FOCUS.software].sort());
  check('the hardware shelf', [...cfg.roleFocus.hardware].sort(), [...FOCUS.hardware].sort());
  check('the old keep list is gone', cfg.roleFocus.keep, undefined);
}

console.log('\n== his own examples are software, not misc ==');
check('Deutsche Bank "Apprentice Hiring for 2026- 2027"', shelf('Apprentice Hiring for 2026- 2027', 'Engineering Support'), 'software');
// Its labels on the live board are "Policy Review" and "Technical Support" —
// the case that decided a label may never file an open title under Misc on its
// own say-so except for core engineering.
check('Wells Fargo "2027 Technology Program Intern" labelled Policy Review', shelf('2027 Technology Program Intern', 'Policy Review'), 'software');
check('...and labelled Technical Support', shelf('2027 Technology Program Intern', 'Technical Support'), 'software');
check('Qualcomm "Interim Engineering Intern_Systems- 2026"', shelf('Interim Engineering Intern_Systems- 2026', 'Systems Intern'), 'software');
check('"Systems Intern"', shelf('Systems Intern'), 'software');
check('a title naming nothing, with no label', shelf('Graduate Engineer Trainee'), 'software');
check('the open families are exactly these', [...OPEN_FAMILIES].sort(), ['generic', 'other', 'systems']);

console.log('\n== software ==');
check('Google\'s networking PhD SWE role is software, not IT', roleFamily('Software Engineer, PhD, Early Career, Networking, 2026 Start'), 'swe');
check('a COBOL/mainframe software engineer is software', roleFamily('Specialist, Software Engineer - COBOL/Mainframe (Enterprise)'), 'swe');
check('SDE I', shelf('Software Development Engineer I'), 'software');
check('Test Engineer is QA', roleFamily('Test Engineer'), 'qa');
check('SDET is QA, not generic software', roleFamily('Software Engineer II (Software Engineer in Test)'), 'qa');
check('AI QA is QA, not an AI-training gig', roleFamily('AI Quality Assurance Intern'), 'qa');
check('Google\'s UX engineer is front-end', roleFamily('User Experience Engineer Intern, BS/MS, Summer 2027'), 'frontend');
check('a data engineer', shelf('Data Engineer-Data Platforms-Azure'), 'software');
check('a data analyst stays with data engineering, the family he kept', shelf('Data Analyst Intern'), 'software');
check('Qualcomm\'s _SW suffix', shelf('Interim Engineering Intern_2027_SW'), 'software');
check('games are software', shelf('Gameplay Programmer Intern'), 'software');

console.log('\n== hardware ==');
check('a GPU verification engineer', roleFamily('GPU Core Pipeline IP Verification Engineer'), 'hardware');
check('embedded is hardware', shelf('Embedded Software Intern'), 'hardware');
check('Qualcomm\'s _HW suffix', shelf('Interim Engineering Intern_2027_HW'), 'hardware');
check('electronics is hardware', shelf('Electronics Engineer - Intern'), 'hardware');
check('an open title the posting calls chip work', shelf('Associate Engineer', 'Semiconductor Design'), 'hardware');

console.log('\n== misc ==');
// Amgen's Tableau dashboards for sales reps, which he asked about on the live
// board: "this is not tech or software is it?"
check('Amgen\'s "Associate Field Reporting"', shelf('Associate Field Reporting', 'Dashboard Development'), 'misc');
check('a Power BI developer is reporting', shelf('Power BI', 'Power BI Developer'), 'misc');
check('Turing\'s coding-expert gigs', shelf('Scientific Coding Expert - Physics and Python'), 'misc');
check('mechanical', shelf('Mechanical Engineering Intern'), 'misc');
check('Salesforce developer', shelf('Salesforce Developer'), 'misc');
check('UX design', shelf('UX Design Intern'), 'misc');
check('quant research', shelf('Quantitative Researcher (2027 Graduate)'), 'misc');
check('service desk', shelf('Service Desk Analyst'), 'misc');
check('mechatronics', shelf('Intern - Mechatronics'), 'misc');
check('an open title the posting calls mechanical', shelf('Engineering Intern', 'Mechanical Design'), 'misc');

console.log('\n== a label rescues a loose title, but not on "testing" or "analysis" ==');
check('an IT title the posting calls front-end', shelf('Associate IT Engineer', 'Frontend Development'), 'software');
check('a reporting title the posting calls software', shelf('Data Management & Reporting Intern', 'Software Development'), 'software');
check('"Propulsion Testing" is not QA', shelf('Intern - Propulsion (P07344)', 'Propulsion Testing'), 'misc');
check('"Quality Data Analysis" is not data engineering', shelf('Intern - Kite Development - Tech Ops (Quality)', 'Quality Data Analysis'), 'misc');
check('a label cannot move a title that names a kept family', shelf('Software Engineer Intern', 'Mechanical Design'), 'software');
check('a label cannot rescue a title that names a non-loose misc family', shelf('Salesforce Developer', 'Software Development'), 'misc');
check('the rescuable families', [...RESCUABLE_FAMILIES].sort(), ['analytics', 'core_eng', 'it_support', 'product', 'research', 'robotics']);

console.log('\n== absent config files everything under software ==');
check('no focus', roleCategory({ title: 'Mechanical Engineering Intern' }, undefined).category, 'software');
check('an empty focus', roleCategory({ title: 'Mechanical Engineering Intern' }, { software: [], hardware: [] }).category, 'software');

console.log('\n== only misc is kept off the channels ==');
check('software is announced', announceable('software'), true);
check('hardware is announced', announceable('hardware'), true);
check('misc is not', announceable('misc'), false);
// A jobs.json written before `category` existed must not go silent.
check('a row with no shelf yet is announced', announceable(undefined), true);

console.log('\n== one role, one shelf ==');
{
  // The live US board on 25 Sep: one role's city copies labelled differently.
  const copy = (id, company, title, category, fp = 'fp1') => ({ id, company, title, category, roleFingerprint: fp });
  const shelfOfId = (rows) => Object.fromEntries(settleShelves(rows).map((r) => [r.id, r.category]));
  const northrop = [1, 2, 3, 4, 5].map((i) => copy(`n${i}`, 'Northrop Grumman', '2027 Intern Systems Engineer - CA & ND', 'software'))
    .concat([6, 7].map((i) => copy(`n${i}`, 'Northrop Grumman', '2027 Intern Systems Engineer - CA & ND', 'misc')));
  check('a role split software/misc goes to software, every copy', [...new Set(Object.values(shelfOfId(northrop)))], ['software']);
  check('...even when misc has more copies — a label only ever keeps',
    Object.values(shelfOfId([copy('a', 'Capital One', 'PhD Applied Research', 'misc'), copy('b', 'Capital One', 'PhD Applied Research', 'misc'), copy('c', 'Capital One', 'PhD Applied Research', 'software')])),
    ['software', 'software', 'software']);
  check('hardware beats misc',
    Object.values(shelfOfId([copy('a', 'NVIDIA', 'PhD Research Intern, Architecture', 'misc'), copy('b', 'NVIDIA', 'PhD Research Intern, Architecture', 'hardware')])),
    ['hardware', 'hardware']);
  check('between software and hardware, more copies win',
    Object.values(shelfOfId([copy('a', 'X', 'T', 'hardware'), copy('b', 'X', 'T', 'hardware'), copy('c', 'X', 'T', 'software')])),
    ['hardware', 'hardware', 'hardware']);
  check('a tie goes to software',
    Object.values(shelfOfId([copy('a', 'X', 'T', 'hardware'), copy('b', 'X', 'T', 'software')])), ['software', 'software']);
  check('an all-misc role stays misc', Object.values(shelfOfId([copy('a', 'X', 'T', 'misc'), copy('b', 'X', 'T', 'misc')])), ['misc', 'misc']);
  // The key is the board's own roleKey: a different posting with the same
  // title is a different role and keeps its own shelf.
  check('a different posting under the same title is not merged',
    shelfOfId([copy('a', 'X', 'T', 'misc', 'fp1'), copy('b', 'X', 'T', 'software', 'fp2')]), { a: 'misc', b: 'software' });
  check('company and title are compared case-insensitively, like the board',
    Object.values(shelfOfId([copy('a', 'NVIDIA', 'Intern', 'misc'), copy('b', 'Nvidia', 'intern', 'hardware')])), ['hardware', 'hardware']);
  check('a row with no fingerprint stands alone',
    shelfOfId([copy('a', 'X', 'T', 'misc', null), copy('b', 'X', 'T', 'software', null)]), { a: 'misc', b: 'software' });
  const untouched = copy('z', 'X', 'T', 'software');
  check('a settled row is returned as it was', settleShelves([untouched])[0] === untouched, true);
}

console.log('\n== nothing is taken off the site for its discipline ==');
{
  const cfg = { roleFocus: FOCUS, matching: { requireCompanyMatch: false } };
  const row = (id, title, extra = {}) => ({ row: { job_id: id, title, company: 'Acme', is_tech: 1, closed_at: null, role_label: null, ...extra }, matchedNow: 'Acme', region: 'US' });
  const out = closableFrom([row('1', 'Mechanical Engineering Intern'), row('2', 'Software Engineer Intern')], cfg, new Set(['US']));
  check('a misc row is not turned into a closed-role stub', out.map((r) => r.id), []);
  check('a closed one still is', closableFrom([row('3', 'Mechanical Engineering Intern', { closed_at: 1 })], cfg, new Set(['US'])).map((r) => r.id), ['3']);
}

console.log('\n== a manager title is not an entry-level job ==');
check('Amgen\'s manager role', entryLevelTitleRefusal('Manager, Agentic AI Business Solutions, Neural Nexus'), 'entry-level: manager title');
check('an Indian IT "Assistant Manager"', entryLevelTitleRefusal('Assistant Manager - Data Engineering'), 'entry-level: manager title');
check('a senior title still says senior', entryLevelTitleRefusal('Senior Software Engineer'), 'entry-level: senior title');
check('an associate product manager is a graduate role', entryLevelTitleRefusal('Associate Product Manager'), null);
check('a software engineer passes', entryLevelTitleRefusal('Software Engineer'), null);
check('admitEntryLevel refuses it after the open too',
  admitEntryLevel({ title: 'Manager, Site Reliability Engineer - Data Platforms', employmentTag: 'Full-time', seniorityTag: 'Entry level', description: '' }).reason,
  'entry-level: manager title');

console.log('\n== a level-II-or-above title is not an entry-level job ==');
{
  const LVL = 'entry-level: level II+ title';
  for (const t of ['Software Engineer II', 'SDE-2', 'SDE 3', 'Developer 3', 'Developer III - Enterprise Solutions',
    'Platform Engineer III', 'Engineer III, Artificial Intelligence', 'Software Engr II', 'Engineer IV', 'OCI Core Infrastructure Engineer 2 - Nashville Campus']) {
    check(`refused: ${t}`, entryLevelTitleRefusal(t), LVL);
  }
  for (const t of ['Software Engineer I', 'SDE-1', 'SDE 1, Expansions Tech and Product', 'Software Engineer, 2027 Batch', 'Software Engineer 2027 Batch', 'Graduate Engineer - 2026', 'Graduate Engineer Trainee 2026',
    'Associate Software Engineer', 'Software Engineer I (New Grad)']) {
    check(`passes: ${t}`, entryLevelTitleRefusal(t), null);
  }
  const GRADE = 'entry-level: consultant or architect title';
  for (const t of ['Consultant - Application Monitoring Job', 'Cyber DT&P - IAM Okta- Consultant (CMF)', 'Ping Directory - Consultant',
    'Associate Consultant - SAP DMC Job', 'Solution Architect', 'Cloud Architect - AWS']) {
    check(`refused: ${t}`, entryLevelTitleRefusal(t), GRADE);
  }
  check('a consultant graduate programme passes', entryLevelTitleRefusal('ETIC, Oracle Technical Consultant Graduate Program'), null);
  check('so does a fresher consultant', entryLevelTitleRefusal('Consultant - Fresher (2026 batch)'), null);
  check('"consulting" is not a grade', entryLevelTitleRefusal('Software Engineer - Consulting Practice'), null);
  check('"architecture" is not a grade', entryLevelTitleRefusal('Software Engineer, Platform Architecture'), null);
  // A named graduate programme keeps its level: Amex hires masters grads as Engineer II.
  check('Amex "Campus Graduate Masters … Software Engineer II" is a graduate programme',
    entryLevelTitleRefusal('Campus Graduate Masters Full-Time Engineer - 2027 Software Engineer II, Enterprise Technology Services- Sunrise, FL'), null);
  check('so is a "New Grad" Engineer II', entryLevelTitleRefusal('Software Engineer II, New Grad'), null);
  check('but "Campus" alone is a place, not a programme', entryLevelTitleRefusal('Engineer 2 - Nashville Campus'), LVL);
  check('admitEntryLevel refuses it after the open too',
    admitEntryLevel({ title: 'Software Engineer II', employmentTag: 'Full-time', seniorityTag: 'Entry level', description: '' }).reason, LVL);
  // The careers-board path decides by title alone (employmentType), so the rule
  // is there too: over 57,631 stored titles it changed exactly these shapes.
  const isIntern = (x) => /\b(intern|internship|co-?op|trainee|apprentice)\b/i.test(x);
  check('careers board: "BTS Associate Software Engineer II - AI" is not early-career', employmentType('BTS Associate Software Engineer II - AI', isIntern), null);
  check('careers board: "OCI Core Infrastructure Engineer 2 - Nashville Campus" is not either', employmentType('OCI Core Infrastructure Engineer 2 - Nashville Campus', isIntern), null);
  check('careers board: a plain "Associate Software Engineer" still is', employmentType('Associate Software Engineer', isIntern), 'fulltime');
  check('careers board: Amex\'s masters programme still is',
    employmentType('Campus Graduate Masters Full-Time Engineer - 2027 Software Engineer II, Enterprise Technology Services- Sunrise, FL', isIntern), 'fulltime');
  check('careers board: an intern title with a level is still an internship', employmentType('Software Engineer Intern II', isIntern), 'intern');
  check('an intern word still wins over a level', admitEntryLevel({ title: 'Software Engineer Intern II', employmentTag: 'Full-time', isIntern: (x) => /intern/i.test(x) }).kind, 'intern');
}

console.log('\n== misc stays off Telegram and the digest, and stays in the weekly roundup ==');
{
  const ids = announceableIds([{ id: 1, category: 'software' }, { id: 2, category: 'misc' }, { id: 3, category: 'hardware' }, { id: 4 }]);
  check('the announceable ids leave misc out', [...ids], ['1', '3', '4']);
  check('an absent file announces nothing', [...announceableIds(undefined)], []);
}

console.log('\n== the wiring ==');
{
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const pub = read('src/publish.js');
  const idx = read('src/index.js');
  const wa = read('src/whatsapp.js');
  const qs = read('bin/queue-server.js');
  check('publish writes the shelf onto every row',
    /category: roleCategory\(\{ title: row\.title, roleLabel: row\.role_label \}, cfg\.roleFocus\)\.category,/.test(pub), true);
  check('publish settles one shelf per role before anything reads it',
    /const publicJobs = settleShelves\(shelved\)/.test(pub), true);
  check('publish no longer holds anything back for its discipline', /roleFocusVerdict|droppedOffFocus/.test(pub), false);
  check('the scan refuses nothing for its discipline', /refuseBeforeOpen|role not in focus/.test(idx), false);
  check('the scan refuses a manager title before the open',
    /const titleRefusal = entryLevelTitleRefusal\(card\.title\);\s*if \(titleRefusal\) \{/.test(idx), true);
  check('WhatsApp checks the shelf before it queues a listing',
    /if \(!announceable\(pub\.category\)\) \{ misc\+\+; return; \}\s*mine\.push\(/.test(wa), true);
  check('...for the backlog and for new rows alike',
    /for \(const id of readPending\(store, code\)\) take\(indexFor\(code\)\.get\(String\(id\)\), code, String\(id\)\);/.test(wa)
      && /const id = String\(row\.job_id \?\? row\.id\);\s*take\(indexFor\(code\)\.get\(id\), code, id\);/.test(wa), true);
  check('the reel sweep checks the shelf', /&& j\.isTech !== false\s*&& announceable\(j\.category\)/.test(qs), true);
  const tg = read('src/telegram.js');
  const dg = read('bin/digest.js');
  const wk = read('src/weekly.js');
  check('Telegram posts only what the shelf lets it announce',
    /const public_ = onSite\.filter\(\(j\) => announceable\(j\.category\)\);/.test(tg) && /for \(const job of public_\)/.test(tg), true);
  check('the digest composes only from announceable ids', /return announceableIds\(JSON\.parse\(readFileSync\(file, 'utf8'\)\)\.jobs\);/.test(dg), true);
  check('the weekly roundup reads the whole published set, misc included',
    /return new Set\(\(JSON\.parse\(readFileSync\(file, 'utf8'\)\)\.jobs \?\? \[\]\)\.map\(\(j\) => String\(j\.id\)\)\);/.test(wk) && !/announceable|\.category/.test(wk), true);
}

console.log('\n== the board ==');
{
  const app = readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/public/styles.css', import.meta.url), 'utf8');
  const lift = (from, until) => {
    const start = app.indexOf(from); const end = app.indexOf(until, start);
    check(`${from.trim()} was found`, start > 0 && end > start, true);
    return app.slice(start, end + until.length);
  };
  const newSinceByCat = new Function(`const kindOf = (j) => j.employmentType || 'intern'; ${lift('const catOf =', ';')} ${lift('function newSinceByCat(', '\n}')}; return newSinceByCat;`)();
  const key = (j) => j.title;
  const rows = [
    { title: 'A', firstSeenAt: 900, category: 'software' },
    { title: 'A', firstSeenAt: 950, category: 'software' },   // the same role in a second city
    { title: 'B', firstSeenAt: 900, category: 'misc' },
    { title: 'C', firstSeenAt: 900, category: 'hardware', employmentType: 'fulltime' },
    { title: 'D', firstSeenAt: 100, category: 'hardware' },
    { title: 'E', firstSeenAt: 900 },                           // written before shelves existed
  ];
  check('new roles per shelf, inside the tab, in roles', newSinceByCat(rows, 500, 'intern', key), { software: 2, hardware: 0, misc: 1 });
  check('the other tab is its own count', newSinceByCat(rows, 500, 'fulltime', key), { software: 0, hardware: 1, misc: 0 });
  check('a first visit counts nothing', newSinceByCat(rows, null, 'intern', key), { software: 0, hardware: 0, misc: 0 });
  check('the list is filtered to the shelf', /if \(kindOf\(j\) !== state\.kind\) return false;\s*if \(catOf\(j\) !== state\.cat\) return false;/.test(app), true);
  check('software is where the board opens', /cat: 'software',/.test(app), true);
  check('every data load redraws the shelves', /renderTabNews\(\);\s*renderCatSeg\(\);\s*\}/.test(app), true);
  check('switching tab falls back off an empty shelf',
    /if \(state\.cat !== 'software' && !catCounts\(kind\)\[state\.cat\]\) state\.cat = 'software';/.test(app), true);
  check('a #job- link opens on its own tab and shelf', /setKind\(kindOf\(target\)\);\s*setCat\(catOf\(target\)\);\s*selectJob\(target\.id\);/.test(app), true);
  check('the resume ranking counts only the shelf on screen', /kindOf\(job\) !== state\.kind \|\| catOf\(job\) !== state\.cat/.test(app) && /covCache\.cat === state\.cat/.test(app), true);
  check('the shelf control has its own style', /\.seg-cat \.seg-b \{/.test(css), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
