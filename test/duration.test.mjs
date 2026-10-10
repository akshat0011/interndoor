/**
 * "1-2 years" is experience, never a duration — 8 Oct 2026.
 *
 * The `duration` column often holds an experience range ("1-2 years", "0 to 3
 * years"), and the board printed it under DURATION (his screenshot: Air
 * Arabia, "Software Engineer Sitecore", Duration 1-2 years, while the posting's
 * own experience field read "1–2 years"). 175 live rows that day. publish now
 * cleans `duration` with durationText for every reader of jobs.json, and the
 * board shows the experience asked under its own label.
 */
import { readFileSync } from 'node:fs';
import { durationText } from '../src/pages.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n== the rule ==');
ok('"1-2 years" is not a duration', durationText({ duration: '1-2 years' }) === '');
ok('"0 to 3 years" is not', durationText({ duration: '0 to 3 years' }) === '');
ok('"6 months" is', durationText({ duration: '6 months' }) === '6 months');
ok('"26 weeks" is', durationText({ duration: '26 weeks' }) === '26 weeks');

console.log('\n== publish cleans it for every reader of jobs.json ==');
const pub = read('src/publish.js');
ok('the live projection runs durationText', /\n    duration: durationText\(row\) \|\| null,/.test(pub));
ok('the history projection does too', /\n      duration: durationText\(row\) \|\| null,/.test(pub));
ok('no projection passes the raw column through', !/duration: row\.duration \|\| null/.test(pub));

console.log('\n== the board labels experience as experience ==');
const app = read('web/public/app.js');
const src = app.slice(app.indexOf('function expShort('), app.indexOf('\n}', app.indexOf('function expShort(')) + 2);
const expShort = new Function(`${src}; return expShort;`)();
ok('"1–2 years" -> "1–2 yrs exp"', expShort({ experience: '1–2 years' }) === '1–2 yrs exp', expShort({ experience: '1–2 years' }));
ok('a graduation year and a range -> the range', expShort({ experience: 'Graduating 2027 · 0–1 years' }) === '0–1 yrs exp', expShort({ experience: 'Graduating 2027 · 0–1 years' }));
ok('"2+ years" -> "2+ yrs exp"', expShort({ experience: '2+ years' }) === '2+ yrs exp', expShort({ experience: '2+ years' }));
ok('a graduation year alone -> nothing (it is not experience)', expShort({ experience: 'Graduating 2027' }) === '');
ok('nothing stated -> nothing', expShort({}) === '');
ok('the card shows the duration, else the labelled experience',
  /if \(job\.duration\) meta\.append\(el\('span', null, job\.duration\)\);\s*else if \(expCard\(job\)\) meta\.append\(el\('span', null, expCard\(job\)\)\);/.test(app));
const cardSrc = app.slice(app.indexOf('function expCard('), app.indexOf('\n}', app.indexOf('function expCard(')) + 2);
const expCard = new Function(`${src}\n${cardSrc}; return expCard;`)();
ok('the card reads stated years first', expCard({ experience: '1–2 years', expSays: '1–2 years' }) === '1–2 yrs exp', expCard({ experience: '1–2 years' }));
ok('…labels years in expSays as experience, never a bare range', expCard({ expSays: '0–2 years' }) === '0–2 yrs exp', expCard({ expSays: '0–2 years' }));
ok('…shows what the posting says in words', expCard({ expSays: 'Freshers welcome' }) === 'Freshers welcome');
ok('…and nothing when the posting says nothing', expCard({}) === '');
ok('a full-time pane says "Not stated in the posting" rather than nothing',
  /else if \(fullTime\) addFact\('Experience', 'Not stated in the posting', 'muted'\);/.test(app));
ok('the pane has an "Experience" fact', /if \(job\.experience\) addFact\('Experience', job\.experience\);/.test(app));
ok('…and a "Duration" fact only when one is stated', /if \(job\.duration\) addFact\('Duration', job\.duration\);/.test(app));
/* An unknown fact is withheld, never drawn as a dash (9 Oct 2026, the pane
   redesign): "—" in its own box read as a value. */
ok('no pane fact falls back to a dash', !/addFact\([^)]*'\\u2014'/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
