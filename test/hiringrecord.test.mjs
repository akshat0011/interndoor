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
import { employerRows, hiringRecord, renderCompanyPage, writePages, companySlug, RECORD_MIN_POSTINGS } from '../src/pages.js';
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
  check('the US board: not shown yet', hiringRecord('Acme', four, US, RECORD), '');
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
    /None of the 4 Acme postings we have tracked stated a stipend\./.test(text(hiringRecord('Acme', base, IN, RECORD))), true);
  const some = base.map((r, i) => (i < 2 ? { ...r, stipend: i ? '₹20,000 / month' : '₹10,000 / month' } : r));
  const s = text(hiringRecord('Acme', some, IN, RECORD));
  check('some stated: how many of how many', /2 of the 4 Acme postings/.test(s), true);
  check('and the range across them', /from ₹10,000 to ₹20,000/.test(s), true);
  const all = base.map((r) => ({ ...r, stipend: '₹15,000 / month' }));
  check('all stated, one figure', /All 4 Acme postings we have tracked stated a stipend, of ₹15,000\./.test(text(hiringRecord('Acme', all, IN, RECORD))), true);
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

console.log('\n== the history projection carries what the record needs ==');
{
  /* §10's rule: anything the hub must know has to be on publish's projection,
     or it reads undefined and the record silently loses its start month. */
  const src = readFileSync(new URL('../src/publish.js', import.meta.url), 'utf8');
  check('publish projects firstSeenAt onto past roles', /firstSeenAt: row\.first_seen_at \|\| null,/.test(src), true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
