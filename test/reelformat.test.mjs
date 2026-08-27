/**
 * Format D — "hidden opportunity".
 *
 * The thing under test is mostly a REFUSAL. `applicants` is frozen at scrape
 * time and nothing refreshes it, so the difference between a true scarcity
 * claim and a false one is entirely how recently the row was read — and on the
 * live board the oldest zero-applicant row had been sitting unread for
 * eighteen days. Most of what follows checks that such a row is turned away.
 */
import {
  formatFor, qualifiesD, formatDRefusal, formatDCandidates, countAgeHours, FORMAT_D,
} from '../src/reelformat.js';
import { reelScript, scriptText } from '../src/reelscript.js';
import { reelCaption } from '../src/reelcaption.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const NOW = 1_800_000_000_000;
const hoursAgo = (h) => NOW - h * 3_600_000;

/* THE PUBLISHED SHAPE, field for field — the same discipline the caption test
   learned the hard way. A fixture that invents field names passes while the
   real thing silently drops every one of them. */
const base = {
  id: '4457276169', company: 'Birlasoft', title: 'Data Engineer Intern',
  location: 'Noida, Uttar Pradesh, India', workplaceType: 'On-site',
  stipend: '', duration: '6 months', applicants: '0 applicants',
  keySkills: ['python', 'sql'], roleFingerprint: 'fp-a',
  postedAt: hoursAgo(3), firstSeenAt: hoursAgo(2), lastSeenAt: hoursAgo(2),
};
const job = (over = {}) => ({ ...base, ...over });

console.log('\n== a fresh empty queue qualifies ==');
check('zero applicants, read two hours ago', qualifiesD(job(), {}, NOW), true);
check('and it has no complaint to make', formatDRefusal(job(), {}, NOW), null);
check('under ten also qualifies', qualifiesD(job({ applicants: '4 applicants' }), {}, NOW), true);
check('the clicked-apply phrasing too',
  qualifiesD(job({ applicants: '7 people clicked apply' }), {}, NOW), true);

console.log('\n== a stale reading is refused, and this is the whole point ==');
// Measured on the live board while this was written: of 58 rows holding a
// count under ten, the oldest had been read 432 hours — eighteen days — ago,
// and only 8 inside a day. "Nobody has applied!" about an eighteen-day-old
// reading is a false claim, not a rounding error.
const stale = job({ lastSeenAt: hoursAgo(432), firstSeenAt: hoursAgo(432) });
check('eighteen days old does not qualify', qualifiesD(stale, {}, NOW), false);
check('and it says why', /stale/.test(formatDRefusal(stale, {}, NOW)), true);
check('the age is quoted so the pool reads as cold, not broken',
  /432h/.test(formatDRefusal(stale, {}, NOW)), true);
check('one hour past the limit is still past it',
  qualifiesD(job({ lastSeenAt: hoursAgo(FORMAT_D.maxCountAgeHours + 1) }), {}, NOW), false);
check('exactly at the limit is inside it',
  qualifiesD(job({ lastSeenAt: hoursAgo(FORMAT_D.maxCountAgeHours) }), {}, NOW), true);

console.log('\n== an undateable row is old, never fresh ==');
// A row carrying no timestamp cannot be shown to be fresh, and the safe
// default for a claim about scarcity is to refuse it.
check('no timestamps at all', countAgeHours({}, NOW), Infinity);
check('and so it does not qualify',
  qualifiesD(job({ lastSeenAt: null, firstSeenAt: null }), {}, NOW), false);
check('firstSeenAt stands in for a missing lastSeenAt',
  qualifiesD(job({ lastSeenAt: null }), {}, NOW), true);

console.log('\n== the applicants column is TEXT, and this is where it bites ==');
// CAST('Over 100 applicants' AS INTEGER) is 0. A reel hook reading "0
// applicants" off that row is the worst single output this module could have.
check('"Over 100" is never a short queue',
  qualifiesD(job({ applicants: 'Over 100 applicants' }), {}, NOW), false);
check('and it is refused as crowded, not as missing',
  /not a short queue/.test(formatDRefusal(job({ applicants: 'Over 100 applicants' }), {}, NOW)), true);
check('a missing count is refused as missing',
  formatDRefusal(job({ applicants: '' }), {}, NOW), 'the posting carries no applicant count');
check('ten is one too many', qualifiesD(job({ applicants: '10 applicants' }), {}, NOW), false);
check('nine is not', qualifiesD(job({ applicants: '9 applicants' }), {}, NOW), true);

console.log('\n== choosing a format ==');
check('auto takes D when the row qualifies', formatFor(job(), { want: 'auto' }, {}, NOW), 'D');
check('auto falls back to A when it does not', formatFor(stale, { want: 'auto' }, {}, NOW), 'A');
check('A can always be forced', formatFor(stale, { want: 'A' }, {}, NOW), 'A');
check('lower case is accepted', formatFor(job(), { want: 'd' }, {}, NOW), 'D');
// A SILENT DOWNGRADE IS THE WORST OUTCOME: the run looks like it did what was
// asked and the reel is a different one.
let threw = null;
try { formatFor(stale, { want: 'D' }, {}, NOW); } catch (e) { threw = e.message; }
check('forcing D on a stale row throws rather than downgrading', /cannot be a Format D/.test(threw ?? ''), true);
check('and the reason travels with it', /stale/.test(threw ?? ''), true);

console.log('\n== config overrides the window ==');
const wide = { reels: { formatD: { maxCountAgeHours: 500 } } };
check('a wider window admits the stale row', qualifiesD(stale, wide, NOW), true);
check('and the default is untouched', qualifiesD(stale, {}, NOW), false);

console.log('\n== candidates: best first, and one per role ==');
// STEMpedia holds FOUR zero-applicant copies of one opening on the live board,
// one per city. Rendering four identical reels off them is exactly the
// multi-city repetition the feed already learned to collapse.
const pool = [
  job({ id: '1', applicants: '4 applicants', roleFingerprint: 'fp-x' }),
  job({ id: '2', applicants: '0 applicants', roleFingerprint: 'fp-y', lastSeenAt: hoursAgo(9) }),
  job({ id: '3', applicants: '0 applicants', roleFingerprint: 'fp-y', lastSeenAt: hoursAgo(2) }),
  job({ id: '4', applicants: '0 applicants', roleFingerprint: 'fp-z', lastSeenAt: hoursAgo(1) }),
  job({ id: '5', applicants: 'Over 100 applicants', roleFingerprint: 'fp-w' }),
  job({ id: '6', applicants: '0 applicants', roleFingerprint: 'fp-v', lastSeenAt: hoursAgo(999) }),
];
const cands = formatDCandidates(pool, {}, NOW);
check('the crowded and the stale are gone', cands.map((j) => j.id), ['4', '3', '1']);
check('a zero beats a four', cands[0].applicants, '0 applicants');
check('and the fresher of two zeroes wins its slot', cands[0].id, '4');
check('one row per roleFingerprint', cands.filter((j) => j.roleFingerprint === 'fp-y').length, 1);
// A row with no fingerprint stands alone under its own id rather than being
// merged on a guess — the same fallback publish.js uses.
const noFp = formatDCandidates([
  job({ id: 'a', roleFingerprint: null }), job({ id: 'b', roleFingerprint: null }),
], {}, NOW);
check('two unfingerprinted rows are two candidates', noFp.length, 2);

console.log('\n== the script withholds the employer until the reveal ==');
const dScript = reelScript({
  format: 'D', company: 'Birlasoft', title: 'Data Engineer Intern',
  city: 'Noida', applicantsCount: 0, zeroApplicants: true,
});
check('the hook is the count, not the company', /^Zero applicants/.test(dScript[0]), true);
check('and the company is not in it', /Birlasoft/.test(dScript[0]), false);
check('the second beat reveals it', /it's at Birlasoft in Noida/.test(dScript[1]), true);
check('the role follows', /and the role is Data Engineer/.test(dScript[2]), true);
check('and the CTA closes', /InternDoor/.test(dScript[dScript.length - 1]), true);

console.log('\n== the tense can never rot ==');
// `applicants` is frozen at scrape time. "Nobody has applied" is a claim about
// NOW that we are not in a position to make — the same failure posted_text
// caused on the live board, where a day-old posting read "4 minutes ago".
const dText = scriptText({
  format: 'D', company: 'Birlasoft', title: 'Data Engineer Intern',
  city: 'Noida', applicantsCount: 0, zeroApplicants: true,
});
check('it dates the reading', dText.includes('when we listed it'), true);
check('and never claims the present', /\b(right now|currently|so far)\b/i.test(dText), false);
check('one applicant is singular', scriptText({
  format: 'D', company: 'Acme', title: 'Intern', city: 'Pune', applicantsCount: 1,
}).includes('Only one applicant when'), true);
check('four are plural', scriptText({
  format: 'D', company: 'Acme', title: 'Intern', city: 'Pune', applicantsCount: 4,
}).includes('Only four applicants when'), true);

console.log('\n== the stipend stays out of the D voiceover ==');
// Format A leads on money because that is the strongest fact it has. Here the
// short queue is, and a second headline number splits the one thing the reel
// says. The pill in the role scene still carries it, so nothing is hidden.
const paid = scriptText({
  format: 'D', company: 'Acme', title: 'Backend Intern', city: 'Pune',
  applicantsCount: 0, zeroApplicants: true,
  stipendText: '₹20,000', stipendAmount: 20000, stipendPeriod: 'month',
});
check('no amount in the D script', /twenty thousand|20,000/.test(paid), false);
check('the queue is still the hook', /^Zero applicants/.test(paid), true);
// ...and Format A is untouched by all of this.
const aPaid = scriptText({
  company: 'Acme', title: 'Backend Intern', city: 'Pune',
  stipendText: '₹20,000', stipendAmount: 20000, stipendPeriod: 'month',
});
check('Format A still leads on the money', /twenty thousand rupees a month/.test(aPaid), true);
check('and still names the employer first', /^Acme is paying/.test(aPaid), true);

console.log('\n== the caption leads on the empty queue, and says it once ==');
const dCap = reelCaption(job(), { url: 'https://interndoor.com/jobs/x', format: 'D' });
const firstLine = dCap.split('\n')[0];
check('the scarcity opens it', /No applicants yet/.test(firstLine), true);
check('the employer comes second', dCap.indexOf('Birlasoft') > dCap.indexOf('No applicants'), true);
// It used to sit at the bottom. Leading with it AND keeping it there reads as
// a template that lost track of itself.
check('and it is not repeated', dCap.split('No applicants yet').length - 1, 1);
check('the link survives', dCap.includes('https://interndoor.com/jobs/x'), true);
check('Format A keeps the old order',
  /^Birlasoft is hiring/.test(reelCaption(job(), { format: 'A' })), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
