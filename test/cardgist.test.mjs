/**
 * The blurb under a card that has no bullets.
 *
 * When enrichment yields no bullets the card falls back to the posting's own
 * opening text, on the reasoning that the original blurb beats an empty card.
 * That is true when the blurb is about the JOB and false when it is not.
 *
 * Measured on the live India board: six cards showed one, and three of them
 * said nothing at all — a bare "About the job", the posting's own header
 * repeated back, and a company values statement. The other three carried the
 * most useful line on their card, so dropping the blurb whenever bullets are
 * missing would have cost real information. This refuses the useless SHAPES.
 *
 * Both halves are pinned here: the three that must go, and the three that must
 * stay. A rule that only asserts the removals will pass when it over-tightens
 * and strips every blurb on the board.
 *
 * The fixtures are the real strings, taken from the live rows.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

/* Lifted out of the shipped app.js rather than restated, so a change there
   fails this file instead of drifting past it. */
const src = readFileSync(join(ROOT, 'web/public/app.js'), 'utf8');
const start = src.indexOf('const GIST_INVISIBLE');
const end = src.indexOf('\n}', src.indexOf('function gistText(job) {'));
ok('gistText was found in app.js', start > 0 && end > start);
const gistText = new Function(`${src.slice(start, end + 2)}; return gistText;`)();

console.log('\n== a blurb that says nothing is dropped ==');
ok('a bare section label',
  gistText({ summary: 'About the job', company: 'Tonbo Imaging', title: 'Intern – Digitisation & Automation' }) === '');
ok('the posting header repeated back',
  gistText({ summary: 'Qualcomm India Private Limited Interns Group, Interns Group > Interim Engineering Intern - HW Qualcomm is a company of inventors that unlocked 5G', company: 'Qualcomm', title: 'Interim Engineering Intern_Systems- 2026' }) === '');
ok('a company values statement',
  gistText({ summary: 'At Jacobs we value people. Having the right balance of belonging, career and lifestyle enables us to consistently deliver', company: 'Jacobs', title: 'Apprentice Engineer - Piping' }) === '');
ok('and an empty or missing summary',
  gistText({ summary: '', company: 'A', title: 'B' }) === '' && gistText({ company: 'A', title: 'B' }) === '');

console.log('\n== a blurb that carries the role is kept ==');
/* THIS HALF IS THE POINT. Valeo's line is the only thing on that card saying
   what the role is — it has no skills chips and a generic title. */
const valeo = gistText({ summary: 'Replacement intern position for AI4EE BE / BTech / MTech in AI/Data Science', company: 'Valeo', title: 'R&D Trainee/Apprentice/VIE' });
ok('the Valeo line survives', valeo.startsWith('Replacement intern position'), JSON.stringify(valeo));
const quest = gistText({ summary: 'This internship involves supporting engineering teams with problem-solving and innovation. It suits students', company: 'Quest Global', title: 'InternEngineering Support' });
ok('the Quest Global line survives', quest.startsWith('This internship involves'), JSON.stringify(quest));

console.log('\n== invisible junk is stripped, not counted ==');
/* Wipro's summary carries U+034F between every word. Stripped BEFORE the
   length test, or the junk would help it earn a place it has not earned. */
const wipro = gistText({ summary: 'Job Description ͏ ͏ ͏ ͏ Intern in AI/ML expertise.', company: 'Wipro', title: 'TRAINEE L1' });
ok('the joiners are gone', !/͏/.test(wipro), JSON.stringify(wipro));
ok('and the words survive', /Intern in AI\/ML expertise/.test(wipro), JSON.stringify(wipro));
ok('a summary that is ONLY junk is dropped',
  gistText({ summary: '͏ ​ ​ ͏ ﻿', company: 'X', title: 'Y' }) === '');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
