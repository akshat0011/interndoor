/**
 * A finished script must end even when something it used is still open
 * (src/forceexit.js). On 16 Oct 2026 the scan finished, a dead network had
 * left a WhatsApp launch half open, and the process never exited: bin/loop.sh
 * waited on it and no scan ran until it was killed by hand.
 *
 * The behaviour is tested on real child processes, because the whole question
 * is whether a process ENDS. Each child has a hard timeout so a broken helper
 * fails this file instead of hanging the suite.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EXIT_GRACE_MS } from '../src/forceexit.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

const HELPER = new URL('../src/forceexit.js', import.meta.url).href;

/** Run a small ES module in a child node and report how it ended. */
function child(body) {
  const code = `import { forceExitSoon } from ${JSON.stringify(HELPER)};\n${body}`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 });
  return { status: r.status, signal: r.signal, ms: Date.now() - t0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

console.log('\n== a process held open by a stray handle is ended ==');
{
  const r = child(`setInterval(() => {}, 1000); process.exitCode = 75; forceExitSoon({ graceMs: 300 });`);
  check('it ends, with the exit code it had set (75 must reach bin/loop.sh)', r.status, 75);
  check('after the grace, not at the 10s safety timeout', r.ms < 5000, true);
  check('and says why on stderr', /Still running \d+s after finishing/.test(r.err), true);
  check('naming the code it exits with', /exiting with code 75/.test(r.err), true);
}
{
  const r = child(`setInterval(() => {}, 1000); forceExitSoon({ graceMs: 300 });`);
  check('no code set means 0', r.status, 0);
}
{
  const r = child(`setInterval(() => {}, 1000); process.exitCode = 1; forceExitSoon({ graceMs: 300, say: (m) => process.stdout.write('SAID ' + m) });`);
  check('a failed run still exits 1', r.status, 1);
  check('through the caller\'s own logger when one is given', r.out.startsWith('SAID Still running'), true);
}

console.log('\n== a clean process is not held back by it ==');
{
  const r = child(`process.exitCode = 0; forceExitSoon({ graceMs: 20000 });`);
  check('it exits at once: the timer is unref\'d', [r.status, r.ms < 5000], [0, true]);
  check('and says nothing', r.err.includes('Still running'), false);
}
check('the grace is long enough for work still finishing and short against a 30-minute tick',
  EXIT_GRACE_MS >= 10_000 && EXIT_GRACE_MS <= 120_000, true);

console.log('\n== every step bin/run.sh runs ends ==');
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').trim();
  const lastStatement = (s) => strip(s).split('\n').filter((l) => l.trim()).pop().trim();
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  const scan = strip(read('src/index.js'));
  check('the scan imports the helper', /^import \{ forceExitSoon \} from '\.\/forceexit\.js';$/m.test(scan), true);
  check('and arms it once main() has settled, success or failure, logging through the run log',
    /main\(\)\.catch\(\(err\) => \{[\s\S]*?\}\)\.finally\(\(\) => forceExitSoon\(\{ say: \(msg\) => log\.warn\(msg\) \}\)\);$/.test(scan), true);

  /* A step not in EXEMPT must arm the helper as its last statement, or end
     with its own process.exit. EXEMPT names the ones that need neither. */
  const EXEMPT = {
    'bin/queue-server.js': 'a long-running server, started in the background',
    'bin/recovery-slot.js': 'reads the store and prints one line; nothing to leave open',
    'bin/gh-readme.js': 'ends through done(), which calls process.exit',
  };
  const sh = read('bin/run.sh');
  const steps = [...new Set([...sh.matchAll(/"\$HERE\/((?:bin|src)\/[\w-]+\.js)"/g)].map((m) => m[1]))];
  check('run.sh was read: it names the scan and the ATS poll', steps.includes('src/index.js') && steps.includes('bin/poll-ats.js'), true);
  check('it runs more than a handful of steps (the loop below is not empty)', steps.length >= 10, true);
  for (const step of steps) {
    if (EXEMPT[step]) continue;
    const src = read(step);
    const last = lastStatement(src);
    const arms = /^forceExitSoon\(\);$/.test(last) || /\.finally\(\(\) => forceExitSoon\(/.test(last);
    const exits = /^process\.exit\(\d*\);$/.test(last);
    check(`${step} ends (helper or its own exit)`, arms || exits, true);
    if (arms && step !== 'src/index.js') {
      check(`${step} imports the helper`, /^import \{ forceExitSoon \} from '\.\.\/src\/forceexit\.js';$/m.test(strip(src)), true);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
