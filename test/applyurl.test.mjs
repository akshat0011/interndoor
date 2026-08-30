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
import { applyUrlFrom, applyUrlFromResponse } from '../src/linkedin.js';

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

console.log('\n== recovered from the graphql response, not the DOM ==');
/* WHY THIS PATH EXISTS, found 30 Aug. applyUrlFrom reads the DOM, and the DOM
   only carries this data for the posting LinkedIn server-rendered on arrival.
   openAndExtract does not navigate — it CLICKS a card in a page that is already
   loaded — and the SPA answers over graphql and renders from the response
   WITHOUT writing it into a <code> block. So for every card except whichever
   happened to be showing on load, the value was never in the document.

   That is why the recovery measured 8 of 8 when it was built and returned
   nothing in production: it was verified by NAVIGATING to postings, and the
   scan CLICKS. 34 consecutive runs at `apply links 0/N`, 0 of 563 rows. */
const GQL = 'https://www.linkedin.com/voyager/api/graphql?variables=(cardSectionTypes:List(TOP_CARD,HOW_YOU_FIT_CARD),jobPostingUrn:urn%3Ali%3Afsd_jobPosting%3A4459729777)&queryId=voyagerJobs';
const eyBody = `{"data":{"jobs":[${posting('4459729777', 'https://careers.ey.com/ey/job/Gurugram-Trainee/1431704333/')}]}}`;

check('it recovers the employer URL the pane already fetched',
  applyUrlFromResponse(GQL, eyBody),
  { jobId: '4459729777', url: 'https://careers.ey.com/ey/job/Gurugram-Trainee/1431704333/' });

/* The url is percent-encoded in the request. Decoding is what lets the id be
   read out of it at all; without it nothing is ever attributed. */
check('the encoded urn in the request url is decoded',
  applyUrlFromResponse(GQL, eyBody).jobId, '4459729777');

console.log('\n== ATTRIBUTION: a payload about several postings is refused ==');
/* THE FAILURE THIS PREVENTS is the same one the scoping above exists for, and
   it is worse here because a response body is not a page: the 1.7MB search
   payload carries every posting on the page. Naming two ids means we cannot
   know which one the body is answering for, so it is refused rather than
   guessed — a wrong answer sends a student to another employer's form. */
/* REAL-LENGTH IDS, and that is not cosmetic. The attribution regex requires
   six or more digits, so the three-digit ids used elsewhere in this file match
   NOTHING and every assertion here would pass vacuously — caught by mutation
   testing, which is the only reason it is written this way. */
const A = '4459729777', B = '4460556461';
const twoReal = `{"included":[${posting(A, 'https://jobs.acme.com/1')},${posting(B, 'https://careers.beta.com/2')}]}`;
const twoIds = `https://www.linkedin.com/voyager/api/graphql?variables=(a:urn%3Ali%3Afsd_jobPosting%3A${A},b:urn%3Ali%3Afsd_jobPosting%3A${B})`;
check('two postings named in the request url', applyUrlFromResponse(twoIds, twoReal), null);
// …and it WOULD have found one if the guard were not there, or the above is vacuous.
check('control: the same body resolves when only one id is named',
  applyUrlFromResponse(`https://www.linkedin.com/voyager/api/graphql?variables=(jobPostingUrn:urn%3Ali%3Afsd_jobPosting%3A${A})`, twoReal),
  { jobId: A, url: 'https://jobs.acme.com/1' });
check('no posting named at all',
  applyUrlFromResponse('https://www.linkedin.com/voyager/api/graphql?q=all', eyBody), null);

/* Naming ONE id is not enough on its own — the body is still scoped by
   applyUrlFrom to that posting's own entityUrn. Here the request is about 111
   and the body only holds 222's URL, so nothing may be returned. */
const oneIdA = `https://www.linkedin.com/voyager/api/graphql?variables=(jobPostingUrn:urn%3Ali%3Afsd_jobPosting%3A${A})`;
check('the body is still scoped to the id the request names',
  applyUrlFromResponse(oneIdA, `[${posting(B, 'https://careers.beta.com/2')}]`), null);

console.log('\n== it inherits every rule applyUrlFrom already enforces ==');
/* LinkedIn's own onsite form is populated in companyApplyUrl for postings that
   are not flagged Easy Apply — measured live, most of the India board — and
   publishing it would put "Apply on the company's site" on a LinkedIn link. */
check('linkedin onsite apply is refused',
  applyUrlFromResponse(GQL, `[${posting('4459729777', 'https://www.linkedin.com/job-apply/4459729777')}]`), null);
check('the safety interstitial is unwrapped',
  applyUrlFromResponse(GQL,
    `[${posting('4459729777', 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjobs.acme.com%2F9')}]`).url,
  'https://jobs.acme.com/9');

console.log('\n== it never throws on the shapes a listener really sees ==');
/* This runs inside a response handler on every voyager call. A throw there is
   an unhandled rejection in the middle of a scan. */
check('a body with no apply url', applyUrlFromResponse(GQL, '{"data":{}}'), null);
check('an empty body', applyUrlFromResponse(GQL, ''), null);
check('a non-string body', applyUrlFromResponse(GQL, null), null);
check('a non-string url', applyUrlFromResponse(null, eyBody), null);
check('an undecodable url is still tried raw',
  applyUrlFromResponse('https://x/%E0%A4%A?fsd_jobPosting:4459729777', eyBody).jobId, '4459729777');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
