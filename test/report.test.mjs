/**
 * The run report's inline script must actually PARSE.
 *
 * The page is assembled inside a template literal, so every backslash in the
 * script is read once by JavaScript before it is ever written to the file. A
 * `\n` in the source is consumed at build time and a REAL newline is emitted
 * into a single-quoted string in the output — a syntax error.
 *
 * The cost is not the one line. There is ONE inline script on the page, so a
 * syntax error anywhere in it kills ALL of it: the reel button, the post-queue
 * buttons, the filter chips, the Generate button. On 26 Aug exactly that
 * happened — a `\n` inside a confirm() took the queue buttons down with it, and
 * nothing about the rendered page looked wrong.
 *
 * `new Function(src)` parses without executing, which is the whole check.
 */
import { buildReport } from '../src/report.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const job = (over = {}) => ({
  job_id: '4457939009', company: 'Infineon Technologies', title: 'Young Graduate Trainee',
  location: 'Bengaluru East, Karnataka, India', summary: 'Bluetooth test frameworks.',
  skills: ['python', 'ci/cd'], job_url: 'https://www.linkedin.com/jobs/view/4457939009/',
  posted_at: Date.UTC(2026, 7, 26), first_seen_at: Date.UTC(2026, 7, 26), ...over,
});

const scriptsOf = (html) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

console.log('\n== the inline script parses ==');
const html = buildReport({ jobs: [job()], run: { cardsSeen: 10, pagesScanned: 1 } });
const scripts = scriptsOf(html);
check('there is a script', scripts.length > 0, true);
for (const [i, src] of scripts.entries()) {
  let err = null;
  try { new Function(src); } catch (e) { err = e.message; }
  check(`script ${i} parses`, err, null);
}

// A run with no new listings emits NO script at all — the block is rendered
// per job list, so there is nothing to bind and nothing to break. Asserted
// rather than looped over, because a loop across an empty array silently
// checks nothing and reads like a passing test forever.
const empty = buildReport({ jobs: [], run: { cardsSeen: 0, pagesScanned: 0 } });
check('an empty run emits no script', scriptsOf(empty).length, 0);
check('but still renders the empty state', empty.includes('No new matching internships'), true);

// A posting whose text carries the characters most likely to break the page.
// Real titles contain apostrophes and ampersands; the description is the
// employer's own text and has contained script tags before.
const nasty = buildReport({
  jobs: [job({
    company: "Dexter's Tech & Co </script>",
    title: 'Intern `backtick` ${notATemplate} "quoted" \\backslash',
    summary: "It's a test & <b>markup</b> </script><script>alert(1)</script>",
    location: "O'Fallon, MO",
  })],
  run: { cardsSeen: 1, pagesScanned: 1 },
});
for (const [i, src] of scriptsOf(nasty).entries()) {
  let err = null;
  try { new Function(src); } catch (e) { err = e.message; }
  check(`hostile-text script ${i} parses`, err, null);
}
check('a closing script tag in job text does not escape', nasty.includes('</script><script>alert(1)'), false);

console.log('\n== the buttons the script drives are all present ==');
check('the reel button', html.includes('class="rbtn"'), true);
check('the post-queue button', html.includes('class="qbtn"'), true);
// These are what the handlers bind to; a rename in one place only is a dead
// button that still looks right.
for (const hook of ['.rbtn', '.qbtn', '/api/reel', '/api/queue']) {
  check(`the script references ${hook}`, scripts.some((s) => s.includes(hook)), true);
}

console.log('\n== the confirm survives the template literal ==');
// The exact bug: it must reach the page as an ESCAPE, not as a real newline.
const script = scripts.join('\n');
check('confirm is present', script.includes('confirm('), true);
check('and carries no literal newline inside its string',
  /confirm\('[^']*\n/.test(script), false);

console.log('\n== AN EMPTY RUN IS NOT ARCHIVED ==');
{
  const { writeReport } = await import('../src/report.js');
  const { PATHS } = await import('../src/paths.js');
  const { existsSync, rmSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  /* His call, 6 Sep 2026, reversing what reportindex.js used to say. Measured
     that day: 1,240 of 1,867 archived reports — 66% — carried no listing, and
     they are what made /reports unreadable. */
  const EMPTY_ID = '9999-01-01T00-00-00';
  const FULL_ID = '9999-01-02T00-00-00';
  const emptyFile = join(PATHS.reports, `report-${EMPTY_ID}.html`);
  const fullFile = join(PATHS.reports, `report-${FULL_ID}.html`);
  rmSync(emptyFile, { force: true }); rmSync(fullFile, { force: true });

  const before = existsSync(PATHS.latestReport) ? readFileSync(PATHS.latestReport, 'utf8') : null;

  check('an empty run returns no path', writeReport('<html><p>nothing new</p></html>', EMPTY_ID), null);
  check('and writes no archive file', existsSync(emptyFile), false);
  /* latest.html IS still written, which keeps what the old behaviour was
     protecting: the most recent run can always be inspected, empty or not. */
  check('but latest.html is still updated', readFileSync(PATHS.latestReport, 'utf8').includes('nothing new'), true);

  const got = writeReport('<html><article class="job">x</article></html>', FULL_ID);
  check('a run with listings IS archived', got === fullFile, true);
  check('and the file exists', existsSync(fullFile), true);

  /* Counted from the markup when the caller does not say, so it cannot drift
     from what the page actually shows. */
  check('an explicit count of 0 also skips', writeReport('<html><article class="job">x</article></html>', EMPTY_ID, 0), null);

  rmSync(fullFile, { force: true }); rmSync(emptyFile, { force: true });
  if (before !== null) (await import('node:fs')).writeFileSync(PATHS.latestReport, before, 'utf8');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
