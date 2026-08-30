import { weeklyRoundup, byCompany, weekKey, roundupDue, weekRoles } from '../src/weekly.js';
import { plainText, MAX_POST_CHARS } from '../src/postgen.js';

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

const CFG = {
  regions: { publish: ['IN', 'US'] },
  notifications: { telegram: { chatId: '@interndoor', channels: { IN: '@interndoor' } } },
  postQueue: { utm: { enabled: true }, weekly: { region: 'IN', weekday: 0, hour: 10 } },
};

let n = 0;
const row = (over = {}) => ({
  job_id: String(++n), title: 'Software Engineering Intern', company: 'Acme',
  location: 'Bengaluru, Karnataka, India', is_tech: 1, employment_type: 'intern',
  first_seen_at: Date.now() - 3600_000, posted_at: Date.now() - 3600_000,
  skills: [], ...over,
});

/** Just enough of a Store for the roundup: it only ever calls recentJobs. */
const fakeStore = (rows) => ({ recentJobs: () => rows });

console.log('\n== which rows count as this week ==');
const mixed = [
  row(), row({ company: 'Beta' }),
  row({ is_tech: 0, company: 'NotTech' }),
  row({ employment_type: 'fulltime', company: 'FullTime' }),
  row({ location: 'Austin, TX', company: 'UsCo' }),
  row({ location: 'Warsaw, Poland', company: 'PlCo' }),
];
const kept = weekRoles(fakeStore(mixed), { region: 'IN', sinceMs: 0 });
const names = kept.map((r) => r.company);
ok('engineering internships in the region are kept', names.includes('Acme') && names.includes('Beta'));
ok('non-engineering is dropped', !names.includes('NotTech'));
ok('full-time is dropped', !names.includes('FullTime'));
ok('another region is dropped', !names.includes('UsCo') && !names.includes('PlCo'));

console.log('\n== grouped by employer, the biggest hirers first ==');
const groups = byCompany([
  row({ company: 'One' }),
  row({ company: 'Three' }), row({ company: 'Three' }), row({ company: 'Three' }),
  row({ company: 'Two' }), row({ company: 'Two' }),
]);
ok('grouped', groups.length === 3);
ok('most roles first', groups.map((g) => g.company).join() === 'Three,Two,One');

console.log('\n== the city line ==');
// Both seen in a real run: LinkedIn writes the same city in two cases, and the
// country reaches the city slot on some postings.
const dupCase = weeklyRoundup(fakeStore([
  row({ company: 'Tower', location: 'Gurgaon, Haryana, India' }),
  row({ company: 'Tower', location: 'gurgaon, Haryana, India' }),
]), CFG);
ok('the same city in two cases is one city', /Tower — Gurgaon$/m.test(plainText(dupCase.post)));

const country = weeklyRoundup(fakeStore([
  row({ company: 'Msft', location: 'Bengaluru, Karnataka, India' }),
  row({ company: 'Msft', location: 'India' }),
]), CFG);
ok('the country is not listed as a city', /Msft — Bengaluru$/m.test(plainText(country.post)));

const many = weeklyRoundup(fakeStore(
  ['Bengaluru', 'Pune', 'Chennai', 'Noida'].map((c) => row({ company: 'Wide', location: `${c}, India` })),
), CFG);
ok('four cities collapse to a count', /Wide — 4 cities/.test(plainText(many.post)));

console.log('\n== the post ==');
/* THE FORMAT CHANGED ON 30 AUG and these assertions changed with it. It used to
   name every employer of the week and carry ONE link, to the board, with apply
   links pushed into follow-up comments nobody opens. It is now a SHORTLIST: a
   few roles with their own apply links, and a count pointing at the board.

   The old assertions pinned the old product decision — "exactly one link",
   "leads with the employer count", the comment link-dump. They were not wrong;
   the decision moved. What is kept is the invariant underneath, which has not:
   the post fits, and what did not fit is said out loud. */
const real = weeklyRoundup(fakeStore(
  Array.from({ length: 120 }, (_, i) => row({ company: `Company ${i}`, title: `Intern ${i}` })),
), CFG);
const flat = plainText(real.post);
ok('under the LinkedIn limit', real.post.length <= MAX_POST_CHARS, `${real.post.length}`);
// The ROLE count leads, not the employer count: it is the bigger number and the
// first line is the only one LinkedIn shows before "see more".
ok('leads with the role count', flat.startsWith('🗓️ 120 engineering internships'));
// A roundup that silently drops ninety roles reads as though the week were a
// tenth as good — the count that did not fit has to be in the post itself.
ok('says how many did not fit', /…and \d+ more roles from \d+ more companies on the board/.test(flat));
ok('the numbers add up', real.stats.companiesListed + real.stats.companiesDropped === real.stats.companies);
ok('and so do the roles', real.stats.rolesFeatured + real.stats.rolesRemaining === real.stats.roles);

/* EVERY FEATURED ROLE CARRIES ITS OWN APPLY LINK — the whole point of the
   change. Six of them plus the board link. */
const urls = real.post.match(/https?:\/\/\S+/g) || [];
ok('every featured role has an apply link',
  urls.filter((u) => u.startsWith('https://interndoor.com/jobs/')).length === real.stats.rolesFeatured,
  urls.join(' '));
ok('plus the board link', real.post.includes('https://interndoor.com/?utm_'));
ok('utm names the weekly campaign', real.post.includes('utm_campaign=weekly'));
ok('the featured links are tagged as such', real.post.includes('utm_content=featured'));
ok('the channel is named but not linked', flat.includes('@interndoor') && !real.post.includes('t.me'));
// An apply URL sliced in half is a dead link nobody can repair, and the post is
// capped as a last resort. Every link that appears has to be a whole one.
ok('no link is cut in half', urls.every((u) => /^https:\/\/interndoor\.com\/(jobs\/)?\S*utm_content=(featured|roundup)$/.test(u)));

console.log('\n== a long title does not become a paragraph ==');
/* One real posting names fifteen cities in its title and runs 172 characters,
   which turns a three-line block into a wall. */
const longT = weeklyRoundup(fakeStore([row({ company: 'Wide', title: 'AI And Robotics Trainer Internship in Jhajjar, Ambala, Faridabad, Palwal, Nuh, Bhiwani, Kurukshetra, Sonipat, Jind, Fatehabad, Sirsa, Gurgaon, Hisar' })]), CFG);
const titleLine = plainText(longT.post).split('\n').find((l) => l.includes('AI And Robotics'));
ok('the title is trimmed', titleLine.trim().length <= 80, `${titleLine.trim().length}`);
/* The real invariant is not "does not end in a letter" — it ends in Faridabad —
   but that no WORD was cut through: what survives is a prefix of the original
   and the original carries on with a space. */
const LONG = 'AI And Robotics Trainer Internship in Jhajjar, Ambala, Faridabad, Palwal, Nuh, Bhiwani, Kurukshetra, Sonipat, Jind, Fatehabad, Sirsa, Gurgaon, Hisar';
const shownTitle = titleLine.trim().replace(/…$/, '').trim();
/* clampWords also drops the trailing comma, so "ends on a space" is too strict.
   The invariant that matters is that no WORD was cut through: what survives is
   a prefix, and the original does not continue with a letter or digit. */
ok('and no word is cut through',
  LONG.startsWith(shownTitle)
  && !/[A-Za-z0-9]/.test(LONG[shownTitle.length] ?? ' '),
  shownTitle);

console.log('\n== only roles the board actually publishes ==');
/* THE BUG THIS PINS. The store holds far more than publish does — an employer
   since dropped from the watchlist, the losing half of a cross-collector
   duplicate, anything past the retention window. The first render of this
   format featured STEMpedia at number one, two days after it was removed from
   the watchlist as spam, and every such link is a 404 sent to every reader.
   Same failure that put 40% of a week's Telegram links on dead pages. */
const mixedRows = [row({ company: 'Live', job_id: 'L1' }), row({ company: 'Dropped', job_id: 'D1' })];
const filtered = weeklyRoundup(fakeStore(mixedRows), CFG, { publishedIds: new Set(['L1']) });
ok('an unpublished role is excluded', filtered.stats.roles === 1);
ok('and is not linked to', !filtered.post.includes('Dropped'));
// No set passed means no filtering, so a missing jobs.json cannot empty the week.
ok('no filter means no filtering', weeklyRoundup(fakeStore(mixedRows), CFG).stats.roles === 2);

console.log('\n== the comments ==');
ok('the first comment carries the board and the channel',
  real.comments[0].includes('interndoor.com') && real.comments[0].includes('t.me/interndoor'));
// The link-dump comments are gone with the format: the body carries the links
// that matter and the board carries the rest.
ok('there is exactly one comment', real.comments.length === 1, `${real.comments.length}`);

console.log('\n== an empty week ==');
const empty = weeklyRoundup(fakeStore([]), CFG);
ok('does not claim companies it does not have', empty.stats.companies === 0 && empty.stats.roles === 0);

console.log('\n== when it runs ==');
// 2026-08-24 is a Monday; 2026-08-23 a Sunday.
const sunday = (h) => new Date(`2026-08-23T${String(h).padStart(2, '0')}:00:00+05:30`).getTime();
const monday = (h) => new Date(`2026-08-24T${String(h).padStart(2, '0')}:00:00+05:30`).getTime();

ok('not on a Monday', roundupDue(CFG, null, monday(11)) === false);
ok('not before the hour', roundupDue(CFG, null, sunday(9)) === false);
ok('yes on Sunday at the hour', roundupDue(CFG, null, sunday(10)) === true);
// "On or after", not "at" — this Mac is asleep for large parts of the day and a
// job that fired only at 10:00 exactly would simply be missed.
ok('and still yes later that day', roundupDue(CFG, null, sunday(22)) === true);
ok('but only once a week', roundupDue(CFG, weekKey(sunday(10)), sunday(22)) === false);
ok('a different week is due again', roundupDue(CFG, '2026-W01', sunday(10)) === true);
ok('disabled means never', roundupDue({ ...CFG, postQueue: { weekly: { enabled: false } } }, null, sunday(10)) === false);

console.log('\n== week keys ==');
ok('ISO week of a known Sunday', weekKey(sunday(10)) === '2026-W34', weekKey(sunday(10)));
ok('the Monday after starts a new week', weekKey(monday(10)) === '2026-W35', weekKey(monday(10)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
