/**
 * The index of past run reports.
 *
 * Every run writes reports/report-<runId>.html and the queue server has always
 * served them at /report/<runId> — but nothing LISTED them, so closing the tab
 * lost the report. There are 1,676 on disk. His question was the obvious one:
 * how do I open the American Express one again to write a post about it?
 */
import { runIdFromFile, prettyRunId, companiesIn, jobCountIn, renderReportIndex, INDEX_LIMIT } from '../src/reportindex.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== run ids ==');
check('parsed from the filename', runIdFromFile('report-2026-09-02T11-34-33.html'), '2026-09-02T11-34-33');
check('latest.html is not a run', runIdFromFile('latest.html'), null);
check('nor anything else', runIdFromFile('notes.txt'), null);

console.log('\n== A RUN ID IS ALREADY LOCAL TIME, so it is parsed by hand ==');
{
  /* `new Date('2026-09-02T11-34-33')` is not even valid, and coercing it into
     one would read it as UTC and shift every report by the offset. This repo
     has already had that bug in the tracker's follow-up dates, where it moved a
     US reader's reminder a day. */
  check('morning', prettyRunId('2026-09-02T11-34-33'), 'Wed 2 Sep, 11:34 am');
  check('afternoon', prettyRunId('2026-09-02T13-05-14'), 'Wed 2 Sep, 1:05 pm');
  check('midnight is 12 am, not 0', prettyRunId('2026-09-02T00-15-00'), 'Wed 2 Sep, 12:15 am');
  check('noon is 12 pm, not 0', prettyRunId('2026-09-02T12-00-00'), 'Wed 2 Sep, 12:00 pm');
  check('a malformed id renders as itself', prettyRunId('nonsense'), 'nonsense');
  check('and a missing one does not throw', prettyRunId(undefined), '');
}

console.log('\n== what a report contains ==');
{
  const html = `<article class="job" data-id="1" data-company="American Express" data-search="x">
    <article class="job" data-id="2" data-company="Nokia">
    <article class="job" data-id="3" data-company="American Express">`;
  check('companies, de-duplicated in order', companiesIn(html), ['American Express', 'Nokia']);
  check('one card per listing', jobCountIn(html), 3);
  check('an empty report is empty, not an error', [companiesIn(''), jobCountIn('')], [[], 0]);
  check('and a missing one likewise', [companiesIn(undefined), jobCountIn(undefined)], [[], 0]);
}

console.log('\n== the page ==');
{
  const page = renderReportIndex([
    { id: '2026-09-02T11-34-33', companies: ['American Express', 'Nokia'], jobs: 5 },
    { id: '2026-09-02T10-04-52', companies: [], jobs: 0 },
  ]);
  check('links to the served URL form, with no .html',
    page.includes('href="/report/2026-09-02T11-34-33"'), true);
  check('shows the readable time', page.includes('Wed 2 Sep, 11:34 am'), true);
  check('names the employers, which is how anyone remembers a report',
    page.includes('American Express'), true);
  /* FILTERING IS OVER THE COMPANY NAMES, lower-cased, so typing "american
     express" finds it. That is the entire question this page answers. */
  check('and they are searchable', /data-find="[^"]*american express[^"]*"/.test(page), true);
  check('a run that found nothing is still listed', page.includes('nothing new'), true);
  check('singular is not "1 listings"', renderReportIndex([{ id: '2026-09-02T11-34-33', companies: ['X'], jobs: 1 }]).includes('1 listing<'), true);
  check('an empty index says so', renderReportIndex([]).includes('No reports yet'), true);
  check('and does not throw with no argument', typeof renderReportIndex() === 'string', true);

  // Untrusted-ish: a company name is employer-supplied text on a local page.
  const nasty = renderReportIndex([{ id: '2026-09-02T11-34-33', companies: ['<script>x</script>'], jobs: 1 }]);
  check('a company name cannot inject markup', nasty.includes('<script>x</script>'), false);
  check('it is escaped instead', nasty.includes('&lt;script&gt;'), true);
}

console.log('\n== the route, and the link that makes it discoverable ==');
{
  const server = readFileSync(new URL('../bin/queue-server.js', import.meta.url), 'utf8');
  check('/reports is served', /path === '\/reports' \|\| path === '\/reports\/'/.test(server), true);
  check('newest first', /\.sort\(\)\s*\n\s*\.reverse\(\)/.test(server), true);
  check('and bounded — 1,676 files is not a page', /\.slice\(0, INDEX_LIMIT\)/.test(server), true);
  check('the cap is a real number', INDEX_LIMIT > 0 && INDEX_LIMIT <= 500, true);
  /* An unreadable file must not take the whole index down. */
  check('one bad file does not break the list', /return \{ id, companies: \[\], jobs: 0 \};/.test(server), true);

  const report = readFileSync(new URL('../src/report.js', import.meta.url), 'utf8');
  check('every report links back to the index', /href="\/reports"/.test(report), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
