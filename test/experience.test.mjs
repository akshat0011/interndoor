/**
 * The Full-time tab's experience filter — 10 Oct 2026.
 *
 * Only what the posting says: the grounded years, or freshers / graduates /
 * campus hiring in words, or a fresher title. Most postings say nothing, and
 * "Not stated" is then the honest answer — never a guess. Every phrase below is
 * a live posting's own wording.
 */
import { readFileSync } from 'node:fs';
import { experienceLevel } from '../src/experience.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const level = (row) => experienceLevel(row, { now: Date.UTC(2026, 9, 10) });
const is = (label, row, want, says) => {
  const got = level(row);
  ok(label, got.level === want && (says === undefined || got.says === says), JSON.stringify(got));
};

console.log('\n== stated years decide first ==');
is('0–1 years is freshers', { experience: '0–1 years' }, 'fresher', '0–1 years');
is('a graduation year beside the years: the years speak', { experience: 'Graduating 2027 · 0–2 years' }, 'fresher', '0–2 years');
is('1–3 years is up to one year', { experience: '1–3 years' }, 'one', '1–3 years');
is('1+ years too', { experience: '1+ years' }, 'one');
is('2+ years is neither (publish holds it back anyway)', { experience: '2+ years' }, 'more');
is('stated years outrank careers boilerplate',
  { experience: '1–3 years', description: 'an undergraduate student exploring your first opportunity, or recent graduate with an advanced degree' }, 'one');

console.log('\n== a graduation year in the grounded field ==');
is('"Fresh graduates from 2025 or 2026 batches"', { experience: 'Fresh graduates from 2025 or 2026 batches' }, 'fresher', 'Fresh graduates from 2025 or 2026 batches');
is('"Graduating 2027" (a full-time role for 2027 graduates)', { experience: 'Graduating 2027' }, 'fresher');
is('an old graduation year says nothing about freshers', { experience: 'Graduated 2019' }, null);

console.log('\n== statements in words ==');
is('"Fresher or experience up to 2 years" (UPS)', { description: 'Tableau is desirable. Fresher or experience up to 2 years. Strong communication' }, 'fresher', 'Freshers welcome');
is('"not for freshers" is refused', { description: 'This role is not for freshers.' }, null);
is('"freshers need not apply" is refused', { description: 'Freshers need not apply.' }, null);
is('"Prior full-time professional experience is not required" (General Mills)',
  { description: 'Recent graduates are encouraged to apply. Prior full-time professional experience is not required.' }, 'fresher', 'No experience required');
is('"prior finance experience is not required" is about one field (WorldQuant)',
  { description: 'While prior finance experience is not required, a successful candidate must possess a strong background.' }, null);
is('a grade ladder is not this role (FedEx)',
  { description: 'Associate: Prior experience not required Standard I: Two (2) years Standard II: Three (3) years' }, null);
is('"a 12-month program for new college graduates" (Texas Instruments)',
  { description: 'The program is a 12-month program for new college graduates in the TMG organization.' }, 'fresher', 'Recent graduates welcome');
is('"Employee Type: New College Grad" (Applied Materials)', { description: 'Time Type: Full time Employee Type: New College Grad Travel: Yes' }, 'fresher');
is('the Emerson / Copeland boilerplate is not about this role',
  { description: 'Whether you’re an established professional looking for a career change, an undergraduate student exploring possibilities, or a recent graduate with an advanced degree, you’ll find your chance.' }, null);
is('"campus hiring" is', { description: 'This is part of our campus hiring for 2026.' }, 'fresher', 'Campus hire');
is('"green campus" is not', { description: 'Our green campus promotes physical wellbeing.' }, null);
is('"campus, branch and data center networks" is not', { description: 'switching solutions that power campus, branch, and data center networks' }, null);

console.log('\n== titles that name a fresher role ==');
is('"2027 Campus Hire_ Engineer_ HW" (Qualcomm)', { title: '2027 Campus Hire_ Engineer_ HW' }, 'fresher', 'Campus hire');
is('"Graduate Engineer Trainee"', { title: 'Graduate Engineer Trainee - R&D PTM' }, 'fresher', 'Graduate trainee role');
is('a trainee', { title: 'Software Trainee' }, 'fresher', 'Trainee role');
is('an apprentice', { title: 'Graduate Apprentice' }, 'fresher');
is('a plain Software Engineer says nothing', { title: 'Software Engineer', description: 'Build services in Java.' }, null);
is('nothing at all says nothing', {}, null);

console.log('\n== publish carries it, full-time only ==');
const pub = read('src/publish.js');
ok('the live projection adds expLevel/expSays for a full-time row only',
  /\.\.\.\(row\.employment_type === FULL_TIME \? experienceFields\(row\) : \{\}\),/.test(pub));
ok('…and adds nothing when the posting says nothing', /return level \? \{ expLevel: level, expSays: says \} : \{\};/.test(pub));

console.log('\n== the board filters on it ==');
const app = read('web/public/app.js');
const start = app.indexOf('const EXP_OPTIONS');
const src = app.slice(start, app.indexOf('\n}', app.indexOf('function expMatches(')) + 2);
const expMatches = new Function(`${src}; return expMatches;`)();
const fresher = { expLevel: 'fresher' }, one = { expLevel: 'one' }, more = { expLevel: 'more' }, none = {};
ok('Any shows everything', [fresher, one, more, none].every((j) => expMatches(j, '')));
ok('"Freshers welcome" is fresher roles only', expMatches(fresher, 'fresher') && !expMatches(one, 'fresher') && !expMatches(none, 'fresher'));
ok('"Up to 1 year" includes the fresher roles', expMatches(fresher, 'one') && expMatches(one, 'one') && !expMatches(more, 'one') && !expMatches(none, 'one'));
ok('"Not stated" is only the roles that say nothing', expMatches(none, 'none') && !expMatches(fresher, 'none') && !expMatches(more, 'none'));
ok('the filter applies on the Full-time tab only',
  /const exp = state\.kind === 'fulltime' \? \(\$\('f-exp'\)\?\.value \?\? ''\) : '';/.test(app));
ok('its control is hidden on the Internships tab', /sel\.closest\('label'\)\.hidden = state\.kind !== 'fulltime';/.test(app));
ok('it survives a reload and a shared link', /exp: 'f-exp'/.test(app));
ok('Reset clears it', /\['f-company', 'f-location', 'f-mode', 'f-exp'\]\) if \(\$\(id\)\) \$\(id\)\.value = '';/.test(app));
ok('a board without the control does not crash the URL sync', /const value = \$\(id\)\?\.value\.trim\(\);/.test(app) && /if \(!node\) continue;/.test(app));
ok('the control is made before the URL is read', app.indexOf('ensureExpFilter();') > -1
  && app.indexOf('ensureExpFilter();') < app.indexOf('readUrl();          // after populateFilters()'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
