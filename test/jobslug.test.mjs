/**
 * The job URL, and the silent 404 it used to produce.
 *
 * The WhatsApp channel sent links reading
 *
 *   https://interndoor.com/jobs/harman-india-intern-role
 *
 * where the last segment should be the job id. Both the link and the preview
 * card were dead — WhatsApp cannot build a card from a 404 — and nothing
 * anywhere said so: the message composed, sent and looked correct.
 *
 * Two faults, and the second is what made the first invisible. The broadcaster
 * passed STORE rows, where the column is `job_id` and `id` is undefined. And
 * `slugify` falls back to 'role' on empty input — right for a company or a
 * title, catastrophic for the id, because it turns a missing field into a URL
 * that looks plausible.
 */
import { jobSlug } from '../src/pages.js';
import { jobParts } from '../src/telegram.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
function throws(label, fn) {
  try { fn(); fail++; console.log(`  FAIL  ${label}\n          it returned instead of throwing`); }
  catch { pass++; console.log(`  ok    ${label}`); }
}

console.log('\n== the ordinary shape ==');
check('published row (id)', jobSlug({ company: 'HARMAN India', title: 'Intern', id: '4458884978' }),
  'harman-india-intern-4458884978');

console.log('\n== A STORE ROW USES job_id, AND IT MUST WORK ==');
// jobsForRun returns SELECT * FROM jobs, and that table has job_id and no id
// column at all. Reading only `job.id` is what produced the dead links.
check('store row (job_id)', jobSlug({ company: 'HARMAN India', title: 'Intern', job_id: '4458884978' }),
  'harman-india-intern-4458884978');
check('an ATS id survives too', jobSlug({ company: 'Trellix', title: 'Intern', job_id: 'ats:workday:trellix:wd1:x:JR1' }),
  'trellix-intern-ats-workday-trellix-wd1-x-jr1');

console.log('\n== A MISSING ID THROWS — it must never be guessed ==');
// Refusing is the only honest answer: a caller with no id has nothing to link
// to, and any string returned here becomes a live 404 in somebody's feed.
throws('no id at all', () => jobSlug({ company: 'HARMAN India', title: 'Intern' }));
throws('empty string id', () => jobSlug({ company: 'HARMAN India', title: 'Intern', id: '' }));
throws('null id', () => jobSlug({ company: 'HARMAN India', title: 'Intern', id: null }));
throws('whitespace id', () => jobSlug({ company: 'HARMAN India', title: 'Intern', id: '   ' }));

console.log('\n== the exact string that went out, as a regression ==');
const slug = jobSlug({ company: 'HARMAN India', title: 'Intern', job_id: '4458884978' });
check('does not end in -role', slug.endsWith('-role'), false);
check('ends in the id', slug.endsWith('-4458884978'), true);

console.log('\n== jobParts builds the page URL from either shape ==');
const store = { company: 'GE HealthCare', title: 'Research Intern - AI', job_id: '4461088583', location: 'Bengaluru, Karnataka, India' };
const pub = { company: 'GE HealthCare', title: 'Research Intern - AI', id: '4461088583', location: 'Bengaluru, Karnataka, India' };
check('from a store row', jobParts(store, regionOf('IN')).page,
  'https://interndoor.com/jobs/ge-healthcare-research-intern-ai-4461088583');
check('from a published row', jobParts(pub, regionOf('IN')).page,
  'https://interndoor.com/jobs/ge-healthcare-research-intern-ai-4461088583');
check('the two agree', jobParts(store, regionOf('IN')).page, jobParts(pub, regionOf('IN')).page);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
