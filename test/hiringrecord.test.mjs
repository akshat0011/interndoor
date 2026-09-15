/**
 * The company hub's hiring record, and the double count it exposed — 14 SEP 2026.
 *
 * Step 2 of the response to the 11 Sep search drop: a hub has to carry facts a
 * copy of a listing cannot. Building it showed the hub's existing "tracked N"
 * was wrong — publish's history INCLUDES the live rows, so every open role was
 * counted twice (Siemens India: "17" against 16 rows, one open).
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { employerRows, hiringRecord, renderCompanyPage, writePages, companySlug, RECORD_MIN_POSTINGS, statedPayRange, PAY_SPREAD_MIN, stipendText } from '../src/pages.js';
import { regionOf } from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const IN = regionOf('IN');
const US = regionOf('US');
const at = (iso) => Date.parse(iso);
// Inline emphasis goes without a gap ("<b>₹15,000</b>." reads "₹15,000."); every other tag is a break.
const text = (html) => html.replace(/<\/?b>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const row = (id, postedIso, over = {}) => ({ id, company: 'Acme', title: `Role ${id}`, postedAt: at(postedIso), firstSeenAt: at(postedIso), ...over });
const RECORD = { since: at('2026-07-26T10:00:00Z'), until: at('2026-09-14T10:00:00Z'), within: 40, of: 100 };

console.log('\n== each posting counted once ==');
{
  const live = { id: '7', company: 'Acme', title: 'Live role', bullets: ['a', 'b'], keySkills: ['python'] };
  const pastCopy = { id: '7', company: 'Acme', title: 'Live role' };
  const rows = employerRows([live], [pastCopy, { id: '8', company: 'Acme', title: 'Old' }]);
  check('the live row and its history copy are one posting', rows.length, 2);
  check('and the live copy is the one kept', rows[0].bullets, ['a', 'b']);
  check('ids are compared as strings', employerRows([{ id: 9 }], [{ id: '9' }]).length, 1);
  check('a row with no id is never dropped', employerRows([{ title: 'x' }], [{ title: 'x' }]).length, 2);

  /* The hub's own lede, end to end: 3 past + 1 of them live must say 3. */
  const jobs = [{ id: '1', company: 'Acme', title: 'A', bullets: ['x', 'y'], postedAt: at('2026-09-01T00:00:00Z') }];
  const past = [
    { id: '1', company: 'Acme', title: 'A', postedAt: at('2026-09-01T00:00:00Z') },
    { id: '2', company: 'Acme', title: 'B', postedAt: at('2026-08-01T00:00:00Z') },
    { id: '3', company: 'Acme', title: 'C', postedAt: at('2026-08-02T00:00:00Z') },
  ];
  const html = renderCompanyPage('Acme', jobs, past, '', { region: IN });
  check('the hub says it tracked 3, not 4', (html.match(/tracked <b>(\d+) engineering internships/) ?? [])[1], '3');
}

console.log('\n== when it appears ==');
{
  const four = [row('1', '2026-08-03T06:00:00Z'), row('2', '2026-08-20T06:00:00Z'), row('3', '2026-09-02T06:00:00Z'), row('4', '2026-09-10T06:00:00Z')];
  check('the bar is four postings', RECORD_MIN_POSTINGS, 4);
  check('four postings on the India board: shown', hiringRecord('Acme', four, IN, RECORD).includes('hiring record'), true);
  check('three: not shown', hiringRecord('Acme', four.slice(0, 3), IN, RECORD), '');
  check('the US board: shown', hiringRecord('Acme', four, US, RECORD).includes('hiring record'), true);
  check('the UK board: shown', hiringRecord('Acme', four, regionOf('GB'), RECORD).includes('hiring record'), true);
  check('the UK says pay, and "in the UK"',
    /None of the 4 Acme internships we have tracked stated pay\. /.test(text(hiringRecord('Acme', four, regionOf('GB'), { ...RECORD, within: 3, of: 26 })) + ' ')
    && /10 most active employers of engineering interns we track in the UK, out of 26/.test(text(hiringRecord('Acme', four, regionOf('GB'), { ...RECORD, within: 3, of: 26 }))), true);
  check('the heading takes no possessive — "L3Harris Technologies’s" read badly',
    /<h2>L3Harris Technologies hiring record<\/h2>/.test(hiringRecord('L3Harris Technologies', four, US, RECORD)), true);
  check('no board-wide record passed: not shown', hiringRecord('Acme', four, IN, null), '');
}

console.log('\n== the months ==');
{
  const rows = [row('1', '2026-07-28T06:00:00Z'), row('2', '2026-07-29T06:00:00Z'),
    row('3', '2026-09-02T06:00:00Z'), row('4', '2026-09-03T06:00:00Z'),
    // Posted in June, handed over later by a careers board: before we watched.
    row('5', '2026-06-10T06:00:00Z', { firstSeenAt: at('2026-09-13T06:00:00Z') })];
  const out = text(hiringRecord('Acme', rows, IN, RECORD));
  check('a quiet month is shown as a zero, not skipped', /Aug 2026 0\b/.test(out), true);
  check('July counts its two', /Jul 2026 2\b/.test(out), true);
  check('nothing before the board began watching', /Jun 2026/.test(out), false);
  /* Jump Trading UK: 16 postings over months summing to 6. The rest must be said. */
  check('but a posting from before is still accounted for', /1 more was posted before we began tracking in India in Jul 2026\./.test(out), true);
  check('and the months plus that line add up to the total',
    [...out.matchAll(/(?:Jul|Aug|Sept?) 2026(?: so far)? (\d+)/g)].reduce((a, m) => a + Number(m[1]), 0) + 1, rows.length);
  check('no such line when nothing predates the board',
    /posted before we began tracking/.test(text(hiringRecord('Acme', rows.slice(0, 4), IN, RECORD))), false);
  check('the newest month is marked as still running', /Sept? 2026 so far 2\b/.test(out), true);
  check('and it is the only one marked', (out.match(/so far/g) ?? []).length, 1);

  /* 20:00 UTC on 31 Jul is 01:30 on 1 Aug in India — the month a reader there names. */
  const edge = [row('1', '2026-07-31T20:00:00Z'), row('2', '2026-08-05T06:00:00Z'), row('3', '2026-08-06T06:00:00Z'), row('4', '2026-09-01T06:00:00Z')];
  check('months are the board\'s own time zone', /Aug 2026 3\b/.test(text(hiringRecord('Acme', edge, IN, RECORD))), true);

  const late = [row('1', '2026-08-10T06:00:00Z'), row('2', '2026-08-11T06:00:00Z'), row('3', '2026-09-01T06:00:00Z'), row('4', '2026-09-02T06:00:00Z')];
  check('an employer first seen in August starts at August', /from Aug 2026/.test(text(hiringRecord('Acme', late, IN, RECORD))), true);
  check('and draws no empty July before it', /Jul 2026/.test(text(hiringRecord('Acme', late, IN, RECORD))), false);
}

console.log('\n== pay ==');
{
  const base = [row('1', '2026-08-03T06:00:00Z'), row('2', '2026-08-04T06:00:00Z'), row('3', '2026-09-02T06:00:00Z'), row('4', '2026-09-03T06:00:00Z')];
  check('none stated says so, with the count',
    /None of the 4 Acme internships we have tracked stated a stipend\./.test(text(hiringRecord('Acme', base, IN, RECORD))), true);
  const some = base.map((r, i) => (i < 2 ? { ...r, stipend: i ? '₹20,000 / month' : '₹10,000 / month' } : r));
  const s = text(hiringRecord('Acme', some, IN, RECORD));
  check('some stated: how many of how many', /2 of the 4 Acme internships/.test(s), true);
  check('and the range across them', /from ₹10,000 to ₹20,000/.test(s), true);
  const all = base.map((r) => ({ ...r, stipend: '₹15,000 / month' }));
  check('all stated, one figure, with its period', /All 4 Acme internships we have tracked stated a stipend, of ₹15,000 a month\./.test(text(hiringRecord('Acme', all, IN, RECORD))), true);

  /* The US board, measured 14 Sep 2026: 1,072 hourly figures, 336 yearly, 758
     with no period at all. A range may only be drawn across one currency and one
     period, or it sets an hourly rate against a salary. */
  const us = (stipends) => base.map((r, i) => (stipends[i] ? { ...r, stipend: stipends[i] } : r));
  check('the US says pay, not stipend',
    /None of the 4 Acme internships we have tracked stated pay\./.test(text(hiringRecord('Acme', base, US, RECORD))), true);
  const hourly = text(hiringRecord('Acme', us(['$25 / hour', '$30 / hour']), US, RECORD));
  check('an hourly range reads per hour', /2 of the 4 Acme internships we have tracked stated pay, from \$25 to \$30 an hour\./.test(hourly), true);
  check('hourly figures under 1,000 are not thrown away', statedPayRange(us(['$25 / hour']))?.lo, '$25');
  check('hourly beside yearly: counted, no range', text(hiringRecord('Acme', us(['$25 / hour', '$80,000 / year']), US, RECORD)).includes('stated pay.'), true);
  check('a figure with no period: counted, no range', statedPayRange(us(['$25 / hour', '$60'])), null);
  /* The UK board's live "£31 / hour" read as no pay at all until 14 Sep 2026:
     stipendText's gate knew ₹ and $ only, and "hour" is not one of its words. */
  check('a pound figure per hour is stated pay', stipendText({ stipend: '£31 / hour' }), '£31 / hour');
  check('and a euro one per hour — a month figure would pass on "/ month" alone', stipendText({ stipend: '€20 / hour' }), '€20 / hour');
  check('a pound zero is still no pay', stipendText({ stipend: '£0 / hour' }), '');
  check('a bare number is still not pay', stipendText({ stipend: '4,01,000' }), '');
  check('two currencies: no range',statedPayRange(us(['$2,000 / month', '€2,000 / month'])), null);
  check('Indian grouping on a dollar figure still reads as the number it is', statedPayRange(us(['$94,000 – $1,25,000 / year']))?.hi, '$125,000');

  check('five postings with pay is where the middle half starts', PAY_SPREAD_MIN, 5);
  const many = [1, 2, 3, 4, 5, 6].map((i) => row(String(i), `2026-08-0${i}T06:00:00Z`, { stipend: i === 1 ? '$16,600 / year' : i === 6 ? '$175,000 / year' : `$${60 + i},000 / year` }));
  const m = text(hiringRecord('Acme', many, US, RECORD));
  check('with five or more, one outlier does not set either end', /middle half of those figures runs from \$62,000 to \$65,000 a year\./.test(m), true);
  check('and the extremes are not quoted', /16,600|175,000/.test(m), false);
  const flat = [1, 2, 3, 4, 5].map((i) => row(String(i), `2026-08-0${i}T06:00:00Z`, { stipend: '$40 / hour' }));
  check('a middle half that is one figure says so plainly',
    /All 5 Acme internships we have tracked stated pay; at least half of those figures are \$40 an hour\./.test(text(hiringRecord('Acme', flat, US, RECORD))), true);
  check('exactly five is already the middle half',/middle half/.test(text(hiringRecord('Acme', many.slice(0, 5), US, RECORD))), true);
  check('with four, the ends are the range', /from \$62,000 to \$65,000 a year/.test(text(hiringRecord('Acme', many.slice(1, 5), US, RECORD))), true);
}

console.log('\n== where they sit ==');
{
  const four = [row('1', '2026-08-03T06:00:00Z'), row('2', '2026-08-04T06:00:00Z'), row('3', '2026-09-02T06:00:00Z'), row('4', '2026-09-03T06:00:00Z')];
  const say = (within, of) => text(hiringRecord('Acme', four, IN, { ...RECORD, within, of }));
  check('ten or fewer at this count or above: top ten', /one of the 10 most active employers of engineering interns we track in India, out of 230/.test(say(10, 230)), true);
  check('eleven: not top ten', /10 most active/.test(say(11, 230)), false);
  check('but inside the busiest quarter', /busiest quarter of the 230 employers/.test(say(11, 230)), true);
  check('the quarter is floored — 58 of 230 is outside it', /busiest quarter|most active/.test(say(58, 230)), false);
  check('57 of 230 is inside', /busiest quarter/.test(say(57, 230)), true);
}

console.log('\n== wired into the board render ==');
{
  const jobs = existsSync('web/public/data/jobs.json') ? (JSON.parse(readFileSync('web/public/data/jobs.json', 'utf8')).jobs ?? []) : [];
  const byCo = new Map();
  for (const j of jobs) byCo.set(j.company, (byCo.get(j.company) ?? 0) + 1);
  const big = [...byCo.entries()].filter(([, n]) => n >= RECORD_MIN_POSTINGS).map(([c]) => c);
  check('the India board has an employer with enough live postings to test', big.length > 0, true);
  if (big.length) {
    const dir = mkdtempSync(join(tmpdir(), 'interndoor-record-'));
    writePages(jobs, dir, [], { region: IN });
    const hub = readFileSync(join(dir, 'companies', `${companySlug(big[0])}.html`), 'utf8');
    check('its hub carries the record', hub.includes('hiring record'), true);
    const of = (text(hub).match(/out of (\d+)|busiest quarter of the (\d+)/) ?? []);
    const hubs = new Set(jobs.map((j) => j.company)).size;
    if (of[0]) check('the board size it quotes is the number of employers on the board', Number(of[1] ?? of[2]), hubs);
    /* The busiest employer on the board is top ten unless more than ten tie with it. */
    const counts = [...byCo.values()];
    const max = Math.max(...counts);
    const busiest = [...byCo.entries()].find(([, n]) => n === max)[0];
    if (counts.filter((n) => n === max).length <= 10) {
      const top = readFileSync(join(dir, 'companies', `${companySlug(busiest)}.html`), 'utf8');
      check('the busiest employer on the board is called one of the 10 most active', /10 most active/.test(top), true);
    }
    const again = mkdtempSync(join(tmpdir(), 'interndoor-record-'));
    writePages(jobs, again, [], { region: IN });
    check('two renders are byte-identical', readFileSync(join(again, 'companies', `${companySlug(big[0])}.html`), 'utf8') === hub, true);
    rmSync(dir, { recursive: true, force: true });
    rmSync(again, { recursive: true, force: true });
  }
}

console.log('\n== full-time graduate roles are never counted as internships ==');
{
  /* Jump Trading UK, 15 Sep 2026: "tracked 16 engineering internships", six of
     them "Campus … (Full-Time)", which the board files under its Full-time tab. */
  const GB = regionOf('GB');
  const intern = (id, d, over = {}) => row(id, d, { company: 'Jump Trading', bullets: ['x', 'y'], employmentType: 'intern', ...over });
  const ft = (id, d, over = {}) => row(id, d, { company: 'Jump Trading', title: `Campus Role ${id} (Full-Time)`, bullets: ['x', 'y'], employmentType: 'fulltime', ...over });
  const past = [intern('1', '2026-08-03T06:00:00Z'), intern('2', '2026-08-04T06:00:00Z'), intern('3', '2026-08-05T06:00:00Z'),
    intern('4', '2026-09-02T06:00:00Z'), ft('5', '2026-08-23T06:00:00Z'), ft('6', '2026-08-24T06:00:00Z')];

  const rec = text(hiringRecord('Jump Trading', past.filter((j) => j.employmentType === 'intern'), GB, RECORD, { fullTime: 2 }));
  check('the record names the full-time roles it left out', /Jump Trading also posted 2 full-time graduate roles in this time\. They are not internships/.test(rec), true);
  check('and says nothing of them when there are none', /full-time/.test(text(hiringRecord('Jump Trading', past.slice(0, 4), GB, RECORD))), false);

  const live = [intern('4', '2026-09-02T06:00:00Z'), ft('7', '2026-09-03T06:00:00Z')];
  const hub = renderCompanyPage('Jump Trading', live, past, '', { region: GB, record: RECORD });
  const t = text(hub);
  check('the lede counts internships as internships and names the rest',
    /tracked 4 engineering internships and 3 full-time graduate roles at Jump Trading/.test(t), true);
  check('the record inside the hub is internships only, with the full-time line',
    /Aug 2026 3 Sept? 2026 so far 1 None of the 4 Jump Trading internships/.test(t) && /also posted 3 full-time graduate roles/.test(t), true);
  check('the answer line splits a mixed live set',
    /One engineering internship is open, plus one full-time graduate role/.test(t), true);
  check('the pill does not call the full-time role an internship', /2 roles open now/.test(t), true);
  check('the meta description splits them too',
    /content="1 live Jump Trading internship and 1 full-time graduate role in the UK/.test(hub), true);
  check('the full-time card is labelled', /Full-time graduate role/.test(hub.slice(hub.indexOf('id="open"'))), true);

  const onlyFt = text(renderCompanyPage('Jump Trading', [ft('7', '2026-09-03T06:00:00Z')], past, '', { region: GB, record: RECORD }));
  check('an employer with only full-time roles open is not "hiring interns"', /is hiring graduates in the UK right now, but not interns/.test(onlyFt), true);
  check('and never says it is', /is hiring interns/.test(onlyFt), false);

  /* The board-wide standing counts internships too, or a graduate-heavy
     employer outranks one that actually takes interns. */
  const src = readFileSync(new URL('../src/pages.js', import.meta.url), 'utf8');
  check('the standing counts internships only',
    /employerRows\(byCompany\.get\(c\), pastByCompany\.get\(c\)\)\.filter\(\(j\) => !isFullTimeRole\(j\)\)\.length/.test(src), true);

  const JP = await import('../src/pages.js');
  const page = JP.renderJobPage({ id: 'ats:greenhouse:jump:1', company: 'Jump Trading', title: 'Campus Quantitative Trader (Full-Time)', employmentType: 'fulltime', bullets: ['x', 'y'], postedAt: at('2026-09-01T00:00:00Z'), url: 'https://example.com/j' }, [], { region: GB });
  check('a full-time job page\'s advice speaks of early-career roles', /Early-career roles in the UK often collect/.test(page), true);
  const ipage = JP.renderJobPage({ id: 'ats:greenhouse:jump:2', company: 'Jump Trading', title: 'Quant Intern', employmentType: 'intern', bullets: ['x', 'y'], postedAt: at('2026-09-01T00:00:00Z'), url: 'https://example.com/j' }, [], { region: GB });
  check('an internship\'s still speaks of internships', /Internships in the UK often collect/.test(ipage), true);
}

console.log('\n== the history projection carries what the record needs ==');
{
  /* §10's rule: anything the hub must know has to be on publish's projection,
     or it reads undefined and the record silently loses its start month. */
  const src = readFileSync(new URL('../src/publish.js', import.meta.url), 'utf8');
  check('publish projects firstSeenAt onto past roles', /firstSeenAt: row\.first_seen_at \|\| null,/.test(src), true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
