import { elideMiddle, distinguishingTail, renderJobPage } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

const dec = (s) => String(s).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const TITLE_MAX = 60;

console.log('\n== elideMiddle keeps BOTH ends ==');
{
  const long = 'Booz Allen Hamilton University, 2027 Summer Games - Cyber Security Intern';
  const out = elideMiddle(long);
  ok('within the budget', out.length <= TITLE_MAX);
  ok('keeps the employer at the front', out.startsWith('Booz Allen Hamilton'));
  ok('keeps the distinguishing tail', out.endsWith('Cyber Security Intern'));
  check('a title already short enough is untouched',
    elideMiddle('Acme Software Intern'), 'Acme Software Intern');
}

console.log('\n== distinguishingTail aims at what actually differs ==');
{
  /* THE SHARED PART IS AT THE END, which is the case elideMiddle cannot
     handle: it keeps the last words, and here the last words are identical.
     An earlier version of this test used titles ending "(Undergraduate)" after
     a dash — elideMiddle separated those on its own, so the assertion passed
     with the rivals ignored entirely and proved nothing. A mutation run is
     what exposed it. */
  const a = 'Globex Advanced Systems Graduate Programme Cybersecurity Analyst Summer Placement 2027';
  const b = 'Globex Advanced Systems Graduate Programme Data Science Analyst Summer Placement 2027';
  check('elideMiddle alone CANNOT separate these', elideMiddle(a) === elideMiddle(b), true);
  const ta = distinguishingTail(a, [b]);
  const tb = distinguishingTail(b, [a]);
  ok('a is within budget', ta.length <= TITLE_MAX);
  ok('a keeps the part that differs', /Cybersecurity/.test(ta));
  ok('b keeps the part that differs', /Data Science/.test(tb));
  check('and they are not the same string', ta === tb, false);

  const abb = 'AbbVie 2027 Business Technology Solutions Intern - Cybersecurity (Undergraduate)';

  check('a rival identical to the subject is ignored',
    distinguishingTail(abb, [abb]), elideMiddle(abb));
  check('no rivals at all falls back to the generic form',
    distinguishingTail(abb, []), elideMiddle(abb));
}

console.log('\n== through the real renderer ==');
{
  const region = regionOf('IN');
  const job = (id, title) => ({
    id, company: 'Longnamed Systems Corporation',
    title, location: 'Bengaluru, Karnataka, India',
    url: 'https://example.com/j/' + id, applyUrl: 'https://example.com/apply/' + id,
    bullets: ['Build things', 'Ship things', 'Measure things'],
    summary: 'A role at an employer.', skills: ['python'],
    postedAt: Date.UTC(2026, 7, 20), firstSeenAt: Date.UTC(2026, 7, 20),
  });
  /* Identical for the first 60 characters, so every one of them clamps to the
     same string. This is the shape that put 103 pages on 46 titles. */
  const rows = [
    job('1', 'University Programme 2027 Summer Games - Cyber Security Intern'),
    job('2', 'University Programme 2027 Summer Games - Data Scientist Intern'),
    job('3', 'University Programme 2027 Summer Games - Software Developer Intern'),
  ];
  const titleOf = (j) => dec((renderJobPage(j, rows, { region, foreign: [], validDays: 30 })
    .match(/<title>([^<]*)<\/title>/) || [])[1]);
  const titles = rows.map(titleOf);
  check('three roles that clamp alike get three distinct titles',
    new Set(titles).size, 3);
  ok('none exceeds the budget', titles.every((t) => t.length <= TITLE_MAX));
  ok('each still names the employer', titles.every((t) => t.startsWith('Longnamed')));

  /* ONE role, several cities — the opposite collision, and the branch the
     `twin` ordering exists for. Here the city is the only discriminator. */
  const cityRows = ['Bengaluru, Karnataka, India', 'Hyderabad, Telangana, India', 'Pune, Maharashtra, India']
    .map((loc, i) => ({ ...job(`c${i}`, 'Interim Engineering Intern Systems 2027'), location: loc }));
  const cityTitles = cityRows.map((j) => dec((renderJobPage(j, cityRows, { region, foreign: [], validDays: 30 })
    .match(/<title>([^<]*)<\/title>/) || [])[1]));
  check('one role in three cities gets three distinct titles',
    new Set(cityTitles).size, 3);
  ok('and each names its city', cityTitles.every((t) => /Bengaluru|Hyderabad|Pune/.test(t)));

  /* THE CHURN GUARD. A posting with no rival must render exactly as it did
     before any of this existed — rewriting the <title> of a page Google has
     already settled on is churn for nothing. */
  const alone = job('9', 'Software Engineering Intern');
  const solo = dec((renderJobPage(alone, [alone], { region, foreign: [], validDays: 30 })
    .match(/<title>([^<]*)<\/title>/) || [])[1]);
  check('a posting with no rival keeps the plain title',
    solo, 'Longnamed Systems Corporation Software Engineering Intern');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
