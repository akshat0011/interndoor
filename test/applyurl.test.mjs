/**
 * Recovering the employer's own apply URL from LinkedIn's bootstrap JSON.
 *
 * LinkedIn made Apply a <button> that navigates in JavaScript, so the anchor
 * href `openAndExtract` used to read stopped existing: 0 of 443 rows carried an
 * off-site URL in the week this was written, against 672 of 722 postings that
 * are not Easy Apply and therefore have an employer page to point at.
 *
 * The centrepiece here is SCOPING. One bootstrap block carries several postings
 * — 3 and 5 in the two blocks measured on a real page — so reading the first
 * `companyApplyUrl` in the block is very often reading somebody else's. That
 * failure does not show up as a missing field. It shows up as a student being
 * sent to a different company's application form, under a button that says
 * "Apply on the company's site".
 */
import { applyUrlFrom } from '../src/linkedin.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

/** A posting object shaped like the real payload: urn first, applyUrl later. */
const posting = (id, url) =>
  `{"title":"Intern","entityUrn":"urn:li:fsd_jobPosting:${id}","listedAt":1787924741000,`
  + `"$type":"com.linkedin.voyager.dash.jobs.JobPosting"`
  + (url === null ? '' : `,"companyApplyUrl":"${url}"`)
  + `,"repostedJobId":null}`;

console.log('\n== it reads the right posting out of a shared block ==');
const two = `{"included":[${posting('111', 'https://jobs.acme.com/1')},${posting('222', 'https://careers.beta.com/2')}]}`;
check('the first posting', applyUrlFrom(two, '111'), 'https://jobs.acme.com/1');
check('the second posting', applyUrlFrom(two, '222'), 'https://careers.beta.com/2');

console.log('\n== THE failure mode: a neighbour\'s URL must never leak ==');
/* This posting has no apply URL of its own and the NEXT one does. Unscoped, a
   naive regex returns beta's URL for acme's job — a student clicking "Apply on
   the company's site" lands on the wrong company's form. */
const leaky = `{"included":[${posting('111', null)},${posting('222', 'https://careers.beta.com/2')}]}`;
check('a posting with none of its own gets null, not its neighbour\'s',
  applyUrlFrom(leaky, '111'), null);
check('…while the neighbour still resolves normally',
  applyUrlFrom(leaky, '222'), 'https://careers.beta.com/2');
/* And the reverse order, so this cannot pass by accident of position. */
const leakyBack = `{"included":[${posting('111', 'https://jobs.acme.com/1')},${posting('222', null)}]}`;
check('the LAST posting with none of its own is also null',
  applyUrlFrom(leakyBack, '222'), null);

console.log('\n== onsite applies are not employer pages ==');
/* companyApplyUrl is populated for Easy Apply too, as linkedin.com/job-apply.
   Publishing it puts "Apply on the company's site" on a link to LinkedIn —
   exactly the mislabelling applyTarget() exists to prevent. */
check('linkedin.com/job-apply is refused',
  applyUrlFrom(`[${posting('1', 'https://www.linkedin.com/job-apply/4441463619')}]`, '1'), null);
check('but a real employer URL on some other host is kept',
  applyUrlFrom(`[${posting('1', 'https://linkedin.com.acme-careers.io/apply')}]`, '1'),
  'https://linkedin.com.acme-careers.io/apply');

console.log('\n== the safety interstitial is unwrapped ==');
/* Storing the wrapper publishes a LinkedIn redirect where the employer's own
   application page belongs. */
check('/safety/go/?url= is decoded',
  applyUrlFrom(`[${posting('1', 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjobs.acme.com%2F42%3Fsrc%3Dli&trk=x')}]`, '1'),
  'https://jobs.acme.com/42?src=li');

console.log('\n== anything that is not an http URL is refused ==');
for (const [label, url] of [
  ['javascript:', 'javascript:alert(1)'],
  ['a bare path', '/jobs/view/1'],
  ['a data URI', 'data:text/html,hi'],
]) check(label, applyUrlFrom(`[${posting('1', url)}]`, '1'), null);

console.log('\n== it degrades to null rather than guessing ==');
check('no block', applyUrlFrom(null, '1'), null);
check('empty block', applyUrlFrom('', '1'), null);
check('no job id', applyUrlFrom(two, null), null);
check('a job that is not in the block', applyUrlFrom(two, '999'), null);
check('a block with no apply urls at all', applyUrlFrom(`[${posting('1', null)}]`, '1'), null);
check('not a string', applyUrlFrom({ companyApplyUrl: 'https://x.com' }, '1'), null);

console.log('\n== the id is matched exactly, not as a prefix ==');
/* "444" must not match a posting numbered 4441463619, or one job's URL is
   filed under another's id — the same substring trap that makes matchCompany
   check whole words. */
check('a shorter id does not match a longer one',
  applyUrlFrom(`[${posting('4441463619', 'https://jobs.acme.com/1')}]`, '444'), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
