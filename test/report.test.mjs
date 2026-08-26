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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
