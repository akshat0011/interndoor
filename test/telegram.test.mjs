/**
 * One Telegram message per role.
 *
 * IT USED TO BATCH A WHOLE RUN INTO ONE MESSAGE and these tests pinned that:
 * a header counting the batch, "+N more on the site", one link for twelve
 * roles. The batch was the wrong trade — every role got the same three lines,
 * no image and no apply link, and Telegram renders one preview per message so
 * twelve roles shared one generic picture. The assertions that survive are the
 * ones about things that did not change: escaping untrusted text, the region
 * prefix on every link, and never cutting a message through its own markup.
 */
import { composeJob, applicantCount, esc } from '../src/telegram.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

/** The SITE's shape, not a database row — that is what composeJob is handed. */
const job = (over = {}) => ({
  id: '4449259269', company: 'NoBroker.com', title: 'Engineering Intern',
  location: 'Bengaluru', workplaceType: 'On-site',
  postedAt: Date.now() - 2 * 3600_000, ...over,
});

console.log('\n== one role, one message ==');
const one = composeJob(job());
/* COMPANY FIRST, THEN THE ROLE — the opposite of the board's cards, and
   deliberately so: a board is scanned for the ROLE, a channel is a feed of
   single messages and what stops a thumb is the employer's name. It also
   matches the card directly above it, which leads with the company. */
ok('the employer is the first line', one.startsWith('🏢 <b>NoBroker.com</b>'));
ok('the role is second, and is the link', one.split('\n')[1] === '🚀 <b><a href="https://interndoor.com/jobs/nobroker-com-engineering-intern-4449259269">Engineering Intern</a></b>');
ok('place and mode on one line', one.includes('📍 Bengaluru · On-site'));
ok('and the age', /🕐 Posted 2h ago/.test(one));

console.log('\n== two links, and only two ==');
/* The title goes to the job page — the details, and the only thing that brings
   a reader onto the site. "Apply" goes straight to the employer. A third would
   only compete with those two. */
const links = one.match(/href="[^"]+"/g) || [];
ok('exactly three anchors: title, apply, board', links.length === 3, links.join(' '));
ok('apply is its own call to action', one.includes('<b>Apply now</b>'));
ok('and the board is offered last', one.includes('>More internships</a>'));

const offsite = composeJob(job({ applyUrl: 'https://careers.ey.com/ey/job/123' }));
ok('a recovered employer URL is used for apply', offsite.includes('href="https://careers.ey.com/ey/job/123"'));
const noApply = composeJob(job({ applyUrl: null, url: null }));
ok('with no apply url it falls back to the job page', (noApply.match(/interndoor\.com/g) || []).length >= 2);

console.log('\n== the applicant count is stated only while the queue is short ==');
/* Same rule as the board and the LinkedIn post: the number exists to prove the
   reader is EARLY, and on a crowded role, next to an apply link, it argues
   against clicking. */
ok('zero is the strongest line there is, and is not "Only 0"',
  composeJob(job({ applicants: '0 applicants' })).includes('No applicants yet — be the first'));
ok('a short queue is stated', composeJob(job({ applicants: '3 applicants' })).includes('Only 3 applicants so far'));
ok('singular reads correctly', composeJob(job({ applicants: '1 applicant' })).includes('Only 1 applicant so far'));
ok('a crowded queue is left out', !/applicant/i.test(composeJob(job({ applicants: '100 applicants' }))));
ok('and so is a missing one', !/applicant/i.test(composeJob(job({ applicants: null }))));
// "Over 100" is MORE than 100 and must never read as low.
ok('"over 100" is not a low count', applicantCount('Over 100 people clicked apply') === 101);
ok('a plain count', applicantCount('47 people clicked apply') === 47);
ok('no number means no claim', applicantCount('Be among the first applicants') === null);

console.log('\n== nothing is padded ==');
/* A line with no value is absent, so a sparse posting reads as short rather
   than as a column of blanks. */
const bare = composeJob(job({ workplaceType: null, location: null, stipend: null, duration: null }));
ok('no empty place line', !bare.includes('📍'));
ok('no empty money line', !bare.includes('💰'));
ok('no stray separator', !bare.includes(' · \n'));

console.log('\n== untrusted text is escaped ==');
// A real posting title with an ampersand; unescaped it makes Telegram 400 the
// message and the listing is silently dropped.
const nasty = composeJob(job({ company: 'Tom & Jerry <Labs>', title: 'Dev & Ops Intern' }));
ok('ampersands escaped', nasty.includes('Tom &amp; Jerry'));
ok('angle brackets escaped', nasty.includes('&lt;Labs&gt;'));
ok('no raw < from the data survives', !/Jerry <Labs/.test(nasty));
ok('esc is exported for the WhatsApp channel to reuse', esc('a&b') === 'a&amp;b');

console.log('\n== stays inside Telegram limits ==');
/* A photo caption is capped at 1024 characters, and one real title runs 172.
   Dropping whole fact lines is what keeps the cap away from the links: slicing
   would cut an href in half and Telegram would reject the message outright. */
/* A 700-character title produced an 1139-character caption before the title was
   clamped — over Telegram's hard limit, so the message is rejected with a 400
   and that listing is silently dropped. Dropping fact lines cannot recover a
   caption whose TITLE is the thing over budget. */
for (const reps of [6, 14, 40]) {
  const huge = composeJob(job({
    title: 'A very long internship title that goes on and on '.repeat(reps),
    location: 'Bengaluru, Karnataka, India and several other places besides',
    stipend: '₹50,000 / month', duration: '6 months', degreeText: 'B.Tech/M.Tech',
    applicants: '2 applicants',
  }));
  ok(`a ${reps}x title stays under Telegram's 1024 cap`, huge.length <= 1024, `${huge.length} chars`);
  ok(`  markup is still balanced at ${reps}x`,
    (huge.match(/<a /g) || []).length === (huge.match(/<\/a>/g) || []).length);
  ok(`  the apply link survives at ${reps}x`, huge.includes('<b>Apply now</b>'));
  ok(`  and the board link at ${reps}x`, huge.includes('>More internships</a>'));
}

// Clamped at a word boundary, not sliced through one.
const clamped = composeJob(job({ title: 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon' }));
const shown = (clamped.match(/">([^<]+)<\/a><\/b>/) || [])[1] ?? '';
ok('a long title is trimmed', shown.length <= 115, `${shown.length}`);
ok('and no word is cut through', !/\S$/.test(shown) || 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon'.startsWith(shown));

console.log('\n== every link carries its region ==');
// A US role posted with an India link is a 404 sent straight to a subscriber.
const us = composeJob(job({ company: 'Databricks', location: 'San Francisco, CA' }), regionOf('US'));
ok('job link is prefixed', us.includes('https://interndoor.com/us/jobs/'));
ok('board link is prefixed', us.includes('<a href="https://interndoor.com/us/">'));
ok('no unprefixed job link leaks in', !us.includes('interndoor.com/jobs/'));

const uk = composeJob(job(), regionOf('GB'));
ok('GB is served at /uk/, not /gb/', uk.includes('interndoor.com/uk/jobs/') && !uk.includes('/gb/'));

console.log('\n== India is unchanged, and is the default ==');
const inExplicit = composeJob(job(), regionOf('IN'));
ok('default region is India', composeJob(job()) === inExplicit);
ok('no prefix on an India link', inExplicit.includes('interndoor.com/jobs/'));
ok('no double slash from the empty slug', !inExplicit.includes('interndoor.com//'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
