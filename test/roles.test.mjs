import { readFileSync } from 'node:fs';
import { classifyRole, isSoftwareRole, vetoNonTech } from '../src/roles.js';

let pass = 0, fail = 0;
function check(title, expected) {
  const { verdict, matched } = classifyRole(title);
  if (verdict === expected) {
    pass++;
    console.log(`  ok    ${String(verdict).padEnd(9)} ${title}`);
  } else {
    fail++;
    console.log(`  FAIL  got ${verdict} (via "${matched}"), want ${expected}  —  ${title}`);
  }
}

console.log('\n== should be TECH ==');
for (const t of [
  'Software Engineer Intern',
  'SDE Intern',
  'Backend Developer Intern',
  'Frontend Intern',
  'Full Stack Developer Internship',
  'Android Developer Intern',
  'iOS Developer Internship',
  'Flutter Developer Intern',
  'Python Developer Intern',
  'Java Backend Intern',
  'Data Science Intern',
  'Data Analyst Intern',
  'Machine Learning Intern',
  'AI Intern',
  'ML Engineer Intern',
  'Computer Vision Intern',
  'NLP Research Intern',
  'Generative AI Intern',
  'DevOps Intern',
  'Cloud Engineer Intern',
  'Site Reliability Engineer Intern',
  'QA Intern',
  'Software Testing Intern',
  'SDET Intern',
  'Cybersecurity Intern',
  'Security Engineer Internship',
  'Embedded Software Intern',
  'Firmware Intern',
  'VLSI Design Intern',
  'Game Development Intern',
  'Blockchain Developer Intern',
  'Database Intern',
  'API Developer Intern',
  'UI/UX Design Intern',
  'Technology Analyst Intern',
  'Graduate Engineer Trainee',
  'Web Development Internship in Bangalore',
  'Business Intelligence Intern',
]) check(t, 'tech');

console.log('\n== A GENERIC POSITIVE MUST NOT CANCEL A NEGATIVE ==');
/* `engineering intern` says "this is an engineering internship" without saying
   WHICH KIND. It used to earn the strongPositive override, which exists so a
   SPECIFIC phrase can rescue a title from a generic negative word — and a
   generic phrase carries no such information. The result was that
   `mechanical`, `chemical`, `civil engineer` and the whole non-software block
   were cancelled the moment a title ended "... Engineering Intern".
   Measured over 3,955 stored titles: `engineering intern` was beating a
   negative 41 times and `engineering trainee` once; every other multi-word
   positive doing it was specific and correct. Turning them generic refuses 159
   rows and wrongly allows none — and NOT ONE of the 159 carries a software
   word in its title. */
{
  const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const refused = (t, label = null) => vetoNonTech(t, label, true, cfg) === false;
  const is = (label, actual, expected) => {
    if (actual === expected) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}\n          got ${actual}, want ${expected}`); }
  };

  // A bare engineering title is still tech — the term keeps its own polarity.
  is('a bare "Engineering Intern" is still tech', refused('Engineering Intern'), false);
  is('and so is Qualcomm\'s "Interim Engineering Intern_Systems-2027"',
    refused('Interim Engineering Intern_Systems-2027'), false);

  // It simply stops rescuing a discipline that is not software.
  for (const t of ['Mechanical Engineering Intern', 'Chemical Engineering Intern',
    'Civil Engineering Intern', 'Structural Engineering Intern',
    'Electrical Engineering Co-Op, Spring 2027', 'Manufacturing Engineering Intern',
    'Industrial Engineering Co-OP', 'Process Engineering Intern',
    'Materials Engineering Intern', 'Ground Systems Mechanical Engineering Intern - Neutron',
    'Presales & Solution Engineering Intern', 'Graduate Engineering Trainee - Sales Engineer']) {
    is(`refused — ${t}`, refused(t), true);
  }

  /* A SPECIFIC multi-word positive still outranks a negative, which is the
     whole point of the override and must not be collateral. Every one of these
     was measured beating a real negative in the store. */
  for (const [t, why] of [
    ['Market Information and Data Analytics (MIDA) - Business Analytics', 'data analytics over business analytics'],
    ['Data Science Intern (Customer Success)', 'data science over customer success'],
    ['Intern - HR Data Analyst', 'data analyst over hr'],
    ['Sales Data Analyst Intern', 'data analyst over sales'],
    ['Spring 2027 Key User - Supply Chain / Computer Science', 'computer science over supply chain'],
    ['Internship /Praktikum \u2013 Computer Vision, Machine Learning (Medical)', 'machine learning over medical'],
    ['Data Engineering Intern', 'data engineering, not the generic term'],
    ['Software Engineering Intern - Production Automation', 'production automation is not a discipline'],
  ]) is(`kept — ${why}`, refused(t), false);

  /* THESE TWO ARE THE LOAD-BEARING ONES for the positives added alongside, and
     each needs a discipline negative in the title to be reachable at all — an
     earlier version asserted on titles with no negative in them, so removing
     `software engineering` and widening GENERIC both survived mutation. */
  is('software engineering rescues a title a discipline word would refuse',
    refused('Software Engineering Intern - Mechanical Systems'), false);
  is('data engineering is SPECIFIC and keeps its override',
    refused('Data Engineering Intern, Mechanical Division'), false);

  /* THE POSITIVES ADDED ALONGSIDE. Without `software engineering` the first
     case above would have had nothing but the generic term and would have been
     refused by `ai`. These close the same gap for a discipline word appearing
     beside a real software role. */
  for (const t of ['Embedded Software Intern - Mechanical Systems',
    'Embedded Systems Intern - Mechanical Design',
    'Security Engineering Intern - Manufacturing',
    'Platform Engineering Intern (Chemical Division)']) {
    is(`kept — ${t}`, refused(t), false);
  }

  /* Three were deliberately NOT made positives — `systems engineering`,
     `controls engineering` and `automation engineering` are as often
     aerospace, mechanical or PLC work as software. Pinned so adding one is a
     deliberate act. */
  is('controls engineering does not rescue a mechanical title',
    refused('Controls Engineering Intern - Mechanical'), true);

  /* A bare `civil` was measured and refused as a term: 21 of the 22 stored
     titles containing it are civil engineering, and the 22nd is this. Pinned so
     that adding the term has to be a deliberate act that breaks a test. */
  is('a bare "civil" is NOT a negative — this Palantir role must survive',
    refused('Privacy & Civil Liberties Engineer - New Grad'), false);
  is('but bare "structural" is safe and is one',
    refused('Structural Design Intern'), true);
}

console.log('\n== PRODUCT MANAGEMENT AND PRODUCT DESIGN ARE NOT ENGINEERING ==');
/* These two used to sit in the tech list above. Listing 'product manager' as a
   POSITIVE is why Salesforce's "Summer 2026 Intern - Product Manager" reached
   the top of the India board on 1 Sep 2026. They are negatives now, in
   config.json's matching.extraNonTechTerms, so the assertion is against the
   LIVE config rather than the built-in lists.
   THE BARE WORD 'product' WAS MEASURED AND REJECTED — it costs Micron's
   "Intern - ML/AI Engineer (Product Engineering, STPG)" and eight more real
   engineering roles. Only whole phrases naming the job function are used. */
{
  const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const refused = (t, label = null) => vetoNonTech(t, label, true, cfg) === false;
  // check() above classifies the string it is given; these are booleans.
  const is = (label, actual, expected) => {
    if (actual === expected) { pass++; console.log(`  ok    ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}\n          got ${actual}, want ${expected}`); }
  };

  for (const t of ['Product Management Intern', 'Product Manager Intern',
    'Summer 2026 Intern - Product Manager', 'Associate Product Manager, New Grad',
    'Product Design Intern', 'Product Designer Intern', 'Intern-Product Analyst']) {
    is(`refused — ${t}`, refused(t), true);
  }

  // And the engineering roles that merely have "product" in the name survive,
  // because a negative only wins when no MULTI-WORD positive also matches.
  for (const t of ['Product Engineering Intern', 'Intern - Product Yield Enhancement Eng',
    'Intern \u2013 ML/AI Engineer (Product Engineering, STPG)', 'Trainee- Product Engineer',
    'Product Engineer D&A Intern', 'Software Engineering Intern - Production Automation',
    'Co-op \u2013 Software Engineering (APM) - Cambridge, MA']) {
    is(`kept — ${t}`, refused(t), false);
  }

  /* THE LABEL PASS IS ON, and these terms are deliberately NOT in
     titleOnlyNonTechTerms. Scoping them to the title was tried and reverted:
     measured over 3,955 stored rows it rescued exactly 8, across two titles —
     Sprinklr's "Design Intern" and PwC's "Connected Physical Products Intern",
     both of which SHOULD be refused on an engineering board.
     An engineering title is protected by its own title classifying tech, not by
     the scoping: vetoNonTech only consults the label when the title is
     uncertain, and "ETO Engineering Co-op" is settled by `engineering`. */
  is('an engineering title is settled before the label is ever read',
    refused('ETO Engineering Co-op', 'Product Design Engineering'), false);
  is('a design label refuses an unsettled title',
    refused('Design Intern', 'Product Design'), true);
  is('and so does a product-management label',
    refused('Intern - Product (NFA)', 'Product management'), true);
}

console.log('\n== should be NON-TECH (real titles from actual runs) ==');
for (const t of [
  'Psychosocial Support Intern',
  'Business Development Intern',
  'Talent acquisition Intern',
  'Volunteer Teacher Internship in Bhopal',
  'Video Editing/Making Internship in Bangalore',
  'Recruiter Internship in Gurgaon',
  'Social Media Marketing Internship in Lucknow',
  'School Marketing Internship in Chennai',
  'Cinematography Internship in Bangalore',
  'Field Sales Internship in Surat',
  'Content and Social Media Marketing Internship',
  'HR Intern',
  'Finance Intern',
  'Legal Intern',
  'Graphic Design Intern',
  'Customer Support Intern',
  'Digital Marketing Intern',
  'Content Writing Intern',
  'Mechanical Engineer Intern',
  'Civil Engineer Intern',
  'Counselling Psychology Intern',
  'Supply Chain Intern',
  'Data Entry Intern',
  'Business Analyst Intern',
  'Fashion Design Intern',
]) check(t, 'non-tech');

console.log('\n== negative must beat positive (trap cases) ==');
for (const t of [
  'Software Sales Intern',
  'Sales Engineer Intern',
  'Technical Recruiter Intern',
  'Marketing Technology Intern',
  'IT Sales Intern',
]) check(t, 'non-tech');

console.log('\n== specific tech phrase must survive a generic negative word ==');
// "analyst" reads commercial, but these are data roles.
for (const t of [
  'Data Analyst Intern',
  'Business Intelligence Analyst Intern',
]) check(t, 'tech');

console.log('\n== genuinely ambiguous -> uncertain, not guessed ==');
for (const t of [
  'Summer Intern',
  'Intern',
  'Internship Trainee',
  'Operations Intern',
]) check(t, 'uncertain');

console.log('\n== real titles from a live run (regression corpus) ==');
// Harvested from `show-report.js --roles` after a real scheduled run. Two of
// these were genuine misses: \bcloud\b could not match "CloudOps" (8 postings
// lost), and bare "ux" was absent while "ui/ux" was present.
for (const t of [
  'CloudOps Trainee',
  'UX Researcher Intern',
  'Trading Intern',
  'Quantitative Trading Intern',
]) check(t, 'tech');

for (const t of [
  'Global Market Analyst Intern',
  'Telecaller / Customer Acquisition Intern',
  'Client Acquisition Intern',
  'Mechanical Design Intern',
  'Content creator Intern',
  'Student Ambassador Intern',
  'Management Trainee',
  'Character Animation Intern',
  'Curation Intern',
  'Article Trainee',
  'Fashion Intern',
  'Sports Intern',
  'Field Executive Trainee-Chemical-DMD ( 82820935 )',
  'SUE Graduate Trainee Technician',
  'EIC Apprentice - Leasing Tenant Representation_Bangalore',
  "Growth & Founder's Office Intern",
  'Quick Commerce – Cataloging Intern',
]) check(t, 'non-tech');

console.log('\n== creative and lab roles a single positive token dragged in ==');
// Both of these reached the live site. "AI Film Making(Internship)" matched on
// 'ai' alone and "QA Food Testing Intern" on 'qa', so the negative list now
// carries the creative and food-lab vocabulary that outranks them.
for (const t of [
  'AI Film Making(Internship)',
  'QA Food Testing Intern',
  'Video Editor Intern',
  'Graphic Design Intern',
  'Motion Graphics Intern',
  'Copywriting Intern',
]) check(t, 'non-tech');

console.log('\n== but the genuine AI/QA roles must survive that ==');
for (const t of [
  'AI Intern',
  'AI Research Intern',
  'Machine Learning Intern',
  'Computer Vision Intern',
  'QA Automation Intern',
  'Software Testing Intern',
]) check(t, 'tech');

console.log('\n== degenerate input ==');
let d = 0;
for (const [label, v] of [['empty', ''], ['null', null], ['undefined', undefined], ['spaces', '   ']]) {
  const { verdict } = classifyRole(v);
  const ok = verdict === 'uncertain';
  if (ok) { pass++; d++; } else { fail++; console.log(`  FAIL ${label} -> ${verdict}`); }
}
console.log(`  ok    ${d}/4 degenerate inputs return uncertain without throwing`);

console.log('\n== isSoftwareRole gate ==');
const gate = [
  ['Software Engineer Intern', false, true],
  ['HR Intern', false, false],
  ['Summer Intern', false, false],
  ['Summer Intern', true, true],
];
for (const [title, includeUncertain, want] of gate) {
  const got = isSoftwareRole(title, { includeUncertain });
  if (got === want) { pass++; console.log(`  ok    ${String(got).padEnd(5)} includeUncertain=${String(includeUncertain).padEnd(5)} ${title}`); }
  else { fail++; console.log(`  FAIL  got ${got} want ${want} — ${title} (includeUncertain=${includeUncertain})`); }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
