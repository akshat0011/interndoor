import { weeklyRoundup, byCompany, applyComments, weekKey, roundupDue, weekRoles } from '../src/weekly.js';
import { plainText, MAX_POST_CHARS, MAX_COMMENT_CHARS } from '../src/postgen.js';

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
const real = weeklyRoundup(fakeStore(
  Array.from({ length: 120 }, (_, i) => row({ company: `Company ${i}`, title: `Intern ${i}` })),
), CFG);
const flat = plainText(real.post);
ok('under the LinkedIn limit', real.post.length <= MAX_POST_CHARS, `${real.post.length}`);
ok('leads with the employer count', flat.startsWith('🗓️ 120 companies'));
// A roundup that silently drops half the week reads as though the week were
// half as good — the count that did not fit has to be in the post itself.
ok('says how many did not fit', /…and \d+ more companies on the board\./.test(flat));
ok('the numbers add up', real.stats.companiesListed + real.stats.companiesDropped === real.stats.companies);

const links = (real.post.match(/https?:\/\//g) || []).length;
ok('exactly one link in the post', links === 1, `${links} links`);
ok('and it is the board', real.post.includes('https://interndoor.com/?utm_'));
ok('utm names the weekly campaign', real.post.includes('utm_campaign=weekly'));
ok('the channel is named but not linked', flat.includes('@interndoor') && !real.post.includes('t.me'));

console.log('\n== the comments ==');
ok('the first comment carries the board and the channel',
  real.comments[0].includes('interndoor.com') && real.comments[0].includes('t.me/interndoor'));
ok('every comment fits', real.comments.every((c) => c.length <= MAX_COMMENT_CHARS),
  real.comments.map((c) => c.length).join(','));
// Splitting on characters rather than on whole roles would cut a URL in half,
// and half a URL in a comment is a dead link nobody can repair. Every link that
// appears has to be a whole one.
const commentUrls = real.comments.slice(1).join('\n').match(/https:\/\/\S+/g) || [];
ok('there are apply links to check', commentUrls.length > 5);
ok('every one is intact', commentUrls.every((u) => u.startsWith('https://interndoor.com/jobs/') && u.includes('utm_campaign=weekly')));
// The post is sliced to the limit as a last resort; the reserved tail budget is
// what keeps that slice away from the one link it carries.
ok('the post\'s own link survives the cap', /https:\/\/interndoor\.com\/\?utm_source=linkedin&utm_medium=social&utm_campaign=weekly&utm_content=roundup(\s|$)/.test(real.post));
ok('comments are capped', real.comments.length <= 1 + 4);
ok('coverage is reported honestly',
  real.stats.linksCovered + real.stats.linksOmitted === real.stats.roles);

const capped = applyComments(Array.from({ length: 200 }, (_, i) => row({ company: `C${i}` })), CFG, { max: 2 });
ok('max is respected', capped.comments.length === 2);
ok('and what it dropped is reported', capped.omitted === 200 - capped.covered && capped.omitted > 0);

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
