/**
 * The Instagram caption for a job reel.
 *
 * Built from stored facts with NO model, the same call the Sunday roundup
 * makes. That is not only a speed decision: it removes the grounding problem
 * outright. A model asked to write about a posting will name a stipend the
 * posting never stated, and an invented figure sends a student to an
 * application they are not eligible for.
 */
import { reelCaption, hashtags, applicantCount, cityOf, CAPTION_MAX } from '../src/reelcaption.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

// THE PUBLISHED SHAPE, field for field. The first version of this fixture used
// `stipendText` and `mode`, which are not what jobs.json carries — so it passed
// while the real caption silently dropped both, and printed a raw `duration`
// the job page refuses to print. A fixture that invents field names tests
// nothing.
const job = {
  id: '123', company: 'Philips', title: 'Intern - Embedded System',
  location: 'Pune Division, Maharashtra, India', workplaceType: 'On-site',
  stipend: '₹20,000/month', duration: '6 months', applicants: '13 applicants',
  keySkills: ['C++', 'Embedded Linux', 'RTOS'],
};

console.log('\n== the applicants column is TEXT ==');
// Documented trap: it holds "47 people clicked apply", "0 applicants" and
// "Over 100 applicants", and CAST('Over 100...' AS INTEGER) is 0. Parse before
// comparing or you get a confident wrong answer.
check('a plain count', applicantCount('7 applicants'), 7);
check('the clicked-apply phrasing', applicantCount('47 people clicked apply'), 47);
check('zero is zero, not missing', applicantCount('0 applicants'), 0);
check('"over 100" is MORE than 100', applicantCount('Over 100 applicants'), 101);
check('missing is null, not zero', applicantCount(null), null);
check('empty is null, not zero', applicantCount(''), null);

console.log('\n== the caption states only what the row holds ==');
const c = reelCaption(job, { url: 'https://interndoor.com/jobs/x' });
check('it names the employer', c.includes('Philips'), true);
check('it names the role', c.includes('Intern - Embedded System'), true);
check('it names the city', c.includes('Pune Division'), true);
check('it carries the stipend the row has', c.includes('₹20,000'), true);
check('and the workplace mode', c.includes('On-site'), true);
check('and a real duration', c.includes('6 months'), true);
check('and the link', c.includes('https://interndoor.com/jobs/x'), true);

// A blank stipend is LEFT OUT, never written as "unpaid" or "not disclosed" —
// the posting did not say, and guessing either way is a claim about somebody's
// employer. Only 39 of 384 India rows carry one, so this is the common case.
const bare = reelCaption({ company: 'Acme', title: 'Software Intern', location: 'Bengaluru, India' });
check('no stipend means no stipend line', /stipend|unpaid|not disclosed|₹/i.test(bare), false);
check('no applicant data means no urgency line', /applicant/i.test(bare), false);
check('but the employer and role survive', bare.includes('Acme') && bare.includes('Software Intern'), true);

console.log('\n== dirty columns are filtered, not printed ==');
// The bug that shipped on the first real reel. `duration` holds EXPERIENCE
// requirements that landed in the duration slot, and `stipend` holds "₹0" and
// the stray "2,026" from a copyright line. pages.js already refuses to print
// these, and the caption imports those same functions rather than repeating
// the rules — its whole claim is that it cannot say what the job page will not.
const dirty = reelCaption({
  company: 'Infineon Technologies', title: 'Young Graduate Trainee',
  location: 'Bengaluru East, Karnataka, India', workplaceType: 'On-site',
  stipend: '₹0', duration: '0 to 1 years', applicants: '47 people clicked apply',
});
check('an experience range is not a duration', dirty.includes('0 to 1 years'), false);
check('₹0 is not a stipend', dirty.includes('₹0'), false);
check('but the real facts survive', dirty.includes('Bengaluru East') && dirty.includes('On-site'), true);
// Each dirty value tested against the field it actually lands in. The first
// version passed the same string as BOTH duration and stipend, which conflated
// two filters and reported a failure against the wrong one.
for (const bad of ['0-11 months', '0 to 3 years', '0 to 1 years']) {
  const d = reelCaption({ company: 'X', title: 'Intern', location: 'Pune, India', duration: bad });
  check(`duration "${bad}" never reaches the caption`, d.includes(bad), false);
}
// The stray year from a copyright line, which lands in the STIPEND slot.
for (const bad of ['2,026', '2026', '0']) {
  const d = reelCaption({ company: 'X', title: 'Intern', location: 'Pune, India', stipend: bad });
  check(`stipend "${bad}" never reaches the caption`, d.includes(`💰 ${bad}`), false);
}
// A real stipend still does.
check('a real stipend survives',
  reelCaption({ company: 'X', title: 'Intern', location: 'Pune, India', stipend: '₹25,000/month' })
    .includes('₹25,000/month'), true);

console.log('\n== the applicant line is stated AS OF LISTING ==');
// `applicants` is frozen at scrape time. Anything that reads as current will be
// wrong within the hour, which is the exact bug `posted_text` caused on the
// live board.
check('it says when the number was true', c.includes('when this was listed'), true);
check('it never claims to be live', /right now|currently|so far today/i.test(c), false);
const zero = reelCaption({ ...job, applicants: '0 applicants' });
check('zero applicants is worth saying', zero.includes('No applicants yet'), true);

console.log('\n== hashtags ==');
const tags = hashtags(job);
check('the employer is first', tags[0], 'philips');
check('they are slugified', tags.every((t) => /^[a-z0-9]+$/.test(t)), true);
check('no duplicates', tags.length, new Set(tags).size);
check('capped', hashtags(job, { max: 5 }).length, 5);
// "C++" slugifies to "c" — two characters or fewer is not a tag worth having.
check('a degenerate tag is dropped', tags.includes('c'), false);
check('a real skill survives', tags.includes('embeddedlinux'), true);

console.log('\n== the city, not the state or the country ==');
check('comma-separated', cityOf('Bengaluru, Karnataka, India'), 'Bengaluru');
check('semicolon-separated', cityOf('London; Amsterdam'), 'London');
check('a bare city', cityOf('Chicago'), 'Chicago');
check('nothing is not a crash', cityOf(null), '');

console.log('\n== length ==');
// Instagram's cap is 2200. A 172-character title is real and on the board.
const huge = reelCaption({
  company: 'National Technology Centre for Ports, Waterways and Coasts (NTCPWC)',
  title: 'x'.repeat(400), location: 'Chennai, Tamil Nadu, India',
  keySkills: Array.from({ length: 40 }, (_, i) => `skill${i}`),
});
check('it stays under the cap', huge.length <= CAPTION_MAX, true);
check('and does not end mid-word', /\S$/.test(huge) && !huge.endsWith('…'), true);

console.log('\n== the link falls back to the board ==');
// A row outside a published region, or one classed non-tech, has no job page
// written for it. An "apply here" that 404s is worse than a generic link.
const noPage = reelCaption(job);
check('no url given means the board', noPage.includes('interndoor.com'), true);
check('and never a broken job path', /\/jobs\/undefined|\/jobs\/null/.test(noPage), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
