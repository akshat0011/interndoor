/**
 * The GitHub internship list.
 *
 * The repo's history is PUBLIC and the file is regenerated from a board that
 * changes all day, so the binding constraint is that unchanged data renders
 * byte-identically — otherwise this is 48 commits a day of noise, which is the
 * exact churn that put ~9,900 pointless page rewrites through this project on
 * 30 Aug.
 */
import { renderReadme } from '../src/ghreadme.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const AUG31 = Date.UTC(2026, 7, 31, 6, 0, 0);
const AUG29 = Date.UTC(2026, 7, 29, 6, 0, 0);

const paid = {
  id: '4458895309', company: 'Bugsmirror', title: 'Flutter Developer Intern',
  location: 'Indore, Madhya Pradesh, India', workplaceType: 'On-site',
  stipend: '₹8,000 / total', postedAt: AUG29,
  url: 'https://www.linkedin.com/jobs/view/4458895309/',
  // The DISPLAY list, whose first entry is the stipend on a row that states pay.
  cardFacts: ['₹8,000 / total', 'On-site'],
};
const unpaid = {
  id: '4461088583', company: 'GE HealthCare', title: 'Research Intern - AI',
  location: 'Bengaluru, Karnataka, India', workplaceType: 'On-site', postedAt: AUG31,
  applyUrl: 'https://careers.gehealthcare.com/job/x?utm_source=linkedin',
  cardFacts: ['Bengaluru', 'On-site'],
};

console.log('\n== IT MUST BE DETERMINISTIC ==');
// Nothing may derive from the clock. A README that moves on its own turns a
// public commit history into noise and makes "it changed" meaningless.
check('same input renders identically', renderReadme([paid, unpaid], 'IN') === renderReadme([paid, unpaid], 'IN'), true);
check('input order does not matter', renderReadme([paid, unpaid], 'IN') === renderReadme([unpaid, paid], 'IN'), true);

const md = renderReadme([paid, unpaid], 'IN');

console.log('\n== the job link carries the id, never the -role fallback ==');
// jobSlug throws on a missing id now, but the rendered URL is what a reader
// clicks, so it is pinned here too: this is the string that 404'd for a day.
check('job page url has the id', md.includes('/jobs/ge-healthcare-research-intern-ai-4461088583'), true);
check('no -role slug anywhere', /\/jobs\/[a-z0-9-]*-role[)?]/.test(md), false);

console.log('\n== the location is the CITY, not the stipend ==');
// cardFacts[0] is the stipend on a paying row, and using it rendered
// "₹8,000 / total · On-site" into the location column.
check('paid row shows its city', md.includes('| Indore · On-site |'), true);
check('and not its stipend', md.includes('| ₹8,000 / total · On-site |'), false);

console.log('\n== the stipend is INLINE, not a column ==');
// Only ~8% of India rows state one; a column would be a wall of em-dashes and
// this project has already learned that teaches the eye to skip the row.
check('stated pay is bolded onto the role', md.includes('— **₹8,000 / total**'), true);
check('there is no Stipend column', md.includes('| Company | Role | Location | Posted | |'), true);
check('and no em-dash filler cell', md.includes('| — |'), false);

console.log('\n== newest first ==');
check('Aug 31 row precedes Aug 29', md.indexOf('GE HealthCare') < md.indexOf('Bugsmirror'), true);

console.log('\n== only OUR links are tagged ==');
// An employer's ATS may read its own query string; tagging somebody else's URL
// is not ours to do. Same rule utmUrl enforces.
check('our job link is tagged', md.includes('4461088583?utm_source=github'), true);
check("the employer's apply link is untouched", md.includes('https://careers.gehealthcare.com/job/x?utm_source=linkedin)'), true);
check('and never carries our tag', /careers\.gehealthcare[^)]*utm_medium=readme/.test(md), false);

console.log('\n== a pipe in a name cannot break the table ==');
const piped = { ...unpaid, id: '99', company: 'A|B Corp', title: 'Intern | Data' };
const md2 = renderReadme([piped], 'IN');
check('company pipe escaped', md2.includes('A\\|B Corp'), true);
check('title pipe escaped', md2.includes('Intern \\| Data'), true);
check('row still has 5 columns', md2.split('\n').find((l) => l.includes('A\\|B'))?.split(/(?<!\\)\|/).length, 7);

console.log('\n== the pay statistic is counted, not asserted ==');
check('1 of 2 state pay', md.includes('Only 1 of these 2 postings say what they pay'), true);

console.log('\n== region ==');
check('names the region', renderReadme([unpaid], 'US').startsWith('# United States'), true);
check('US links carry the /us prefix', renderReadme([unpaid], 'US').includes('interndoor.com/us/jobs/'), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
