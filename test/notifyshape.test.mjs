/**
 * `notify(title, message, opts)` — and the third argument is an OBJECT.
 *
 * THIS IS A SILENT-FAILURE CLASS, NOT A STYLE RULE. `bin/queue-server.js`
 * published every reel with `notify(title, job.title, res.url)`, and
 * destructuring a STRING for `{ sound = 'Ping', subtitle = '' }` yields the
 * defaults for both — so the permalink the call was written to carry was
 * dropped from every notification for as long as the feature has existed. No
 * throw, no log, no test. The same mistake with `{ sound }` costs an alert its
 * sound; with a number or an array it costs the same silence.
 *
 * So this walks every notify() call site in the repo and checks the shape of
 * the arguments, which is the only way a wrong one is ever going to be caught:
 * the function cannot tell a string it was handed by mistake from an options
 * object it was handed on purpose, because JavaScript will destructure either.
 *
 * It also pins the one thing the reel publisher must do on the way out — alert
 * on FAILURE, not only on success. Reels publish unattended eight times a day,
 * so silence is what a broken token looks like.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);

/* fileURLToPath, not `.pathname`: this project lives under "Application
   Support" and the raw pathname keeps the %20. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const files = [];
for (const dir of ['src', 'bin']) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name.endsWith('.js')) files.push(`${dir}/${name}`);
  }
}

/** The argument list of a call, split on TOP-LEVEL commas. */
function argsOf(src, openParen) {
  let depth = 0, start = openParen + 1, out = [], quote = null;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (quote) { if (c === quote && prev !== '\\') quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) { depth++; continue; }
    if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) { out.push(src.slice(start, i).trim()); return out; }
      continue;
    }
    if (c === ',' && depth === 1) { out.push(src.slice(start, i).trim()); start = i + 1; }
  }
  return null; // unbalanced — the caller reports it
}

console.log('\n== EVERY notify() CALL PASSES AN OBJECT, OR NOTHING, AS ITS THIRD ARGUMENT ==');
{
  const bad = [];
  let sites = 0;
  const skipped = [];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    /* THERE ARE TWO FUNCTIONS CALLED `notify` IN THIS REPO and they take
       different arguments: the desktop notifier in src/notify.js, and the
       Google Indexing API's `notify(url, type, token, opts)` in
       src/indexing.js, whose third argument is a TOKEN and is correct. This
       test found that collision on its first run. Only files that IMPORT the
       desktop one are checked; a file carrying its own is recorded and
       skipped, so the pair can never be quietly conflated. */
    if (/^\s*export\s+(async\s+)?function\s+notify\s*\(/m.test(src)
        && !/from '\.\.?\/(src\/)?notify\.js'/.test(src)) {
      if (rel !== 'src/notify.js') skipped.push(rel);
      continue;
    }
    if (!/\bnotify\b[^\n]*from '\.\.?\/(src\/)?notify\.js'/.test(src)) continue;
    /* `notify(` preceded by a non-identifier char, so `terminalNotifier(` and
       a definition line are not call sites. The declaration is skipped by the
       `function` check below. */
    for (const m of src.matchAll(/(^|[^\w.$])(notify)\s*\(/g)) {
      const at = m.index + m[0].length - 1;
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      if (/function\s*$/.test(before)) continue;      // the definition itself
      sites++;
      const args = argsOf(src, at);
      if (!args) { bad.push(`${rel}: could not parse the arguments`); continue; }
      if (args.length < 3) continue;                   // 2 args is valid
      const third = args[2];
      if (!third.startsWith('{')) {
        const line = src.slice(0, at).split('\n').length;
        bad.push(`${rel}:${line} third argument is \`${third.slice(0, 40)}\`, not an object literal`);
      }
    }
  }
  /* The count is asserted too. A regex that silently stops matching would
     otherwise turn this whole file into a test that checks nothing. */
  ok(`found call sites to check (${sites})`, sites >= 8);
  check('none passes a non-object as options', bad, []);
  /* Named, so that a file growing its own `notify` is a visible decision
     rather than a silent exemption from this check. */
  check('the only other `notify` in the repo is the Indexing API one',
    skipped, ['src/indexing.js']);
}

console.log('\n== THE REEL PUBLISHER ALERTS ON FAILURE, NOT ONLY ON SUCCESS ==');
{
  const qs = readFileSync(join(ROOT, 'bin/queue-server.js'), 'utf8');
  /* The catch block around the publish. Anchored on what it already does —
     records the failure — so this reads the right block rather than any catch. */
  const block = qs.slice(qs.indexOf('store.reelFailed(jobId, err.message);'));
  const upToReturn = block.slice(0, block.indexOf('return { error: err.message };'));
  ok('the failure path notifies', /await notify\(/.test(upToReturn));
  ok('and does it loudly — Basso, like the watcher falling over',
    /sound: 'Basso'/.test(upToReturn));
  ok('carrying the reason', /err\.message/.test(upToReturn.split('await notify(')[1] ?? ''));

  /* And the success path still carries the permalink it was written to carry. */
  ok('success passes the permalink as subtitle', /subtitle: res\.url/.test(qs));
  check('and never as a bare third argument', /notify\([^)]*,\s*res\.url\s*\)/.test(qs), false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
