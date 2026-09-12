/**
 * Replacing an Instagram token in .env, and refusing the wrong one.
 *
 * THIS IS A RECURRING CHORE, NOT A ONE-OFF. An Instagram Login token lasts 60
 * days and nothing warns you (§13), and it can be killed outright long before
 * that: linking a Facebook Page to @interndoorusa on 12 Sep 2026 invalidated
 * @interndoorin's token within the hour, and an invalidated token cannot be
 * refreshed — only replaced. `bin/ig-token.js` is that replacement, and the
 * part of it worth pinning is the file surgery: the network guards are real
 * requests and prove themselves against the live API every run.
 *
 * The mistake being guarded is not "the write fails" — it is "the write
 * succeeds and the wrong credential is live", which looks like nothing at all
 * until a slot fires and a reel goes to the wrong account or nowhere.
 */
import { setEnvVar, credEnvNames, accountFor } from '../src/reelaccounts.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const ok = (label, cond) => check(label, !!cond, true);
function throws(label, fn, match) {
  try { fn(); check(label, 'no throw', `throws ${match}`); }
  catch (err) { check(label, err.message.includes(match) ? `throws ${match}` : err.message, `throws ${match}`); }
}

console.log('\n== THE VARIABLE IS REPLACED AND NOTHING ELSE MOVES ==');
{
  const env = [
    '# Secrets. GEMINI_API_KEY lives here so it reaches launchd-spawned runs.',
    'GEMINI_API_KEY=abc123',
    '',
    'IG_USER_ID_IN=17841438764422631',
    'IG_ACCESS_TOKEN_IN=OLD_DEAD_TOKEN',
    'IG_USER_ID_US=17841438720125143',
    'IG_ACCESS_TOKEN_US=STILL_GOOD',
    '',
  ].join('\n');

  const out = setEnvVar(env, 'IG_ACCESS_TOKEN_IN', 'NEW_TOKEN');
  ok('the new value is in', out.includes('IG_ACCESS_TOKEN_IN=NEW_TOKEN'));
  check('the old value is gone', out.includes('OLD_DEAD_TOKEN'), false);
  /* THE ONE THAT MATTERS: the sibling region is not disturbed. Its variable
     name is a prefix-sibling, which is exactly the shape a sloppy replace
     mangles. */
  ok('the other region is untouched', out.includes('IG_ACCESS_TOKEN_US=STILL_GOOD'));
  ok('and its user id', out.includes('IG_USER_ID_US=17841438720125143'));
  ok('comments survive', out.includes('# Secrets. GEMINI_API_KEY lives here'));
  ok('unrelated keys survive', out.includes('GEMINI_API_KEY=abc123'));
  check('the file is the same length in lines', out.split('\n').length, env.split('\n').length);
  /* IG_USER_ID_IN must NOT be caught by a rewrite of IG_ACCESS_TOKEN_IN, and
     the reverse: replacing the user id must not touch the token. */
  const out2 = setEnvVar(env, 'IG_USER_ID_IN', '999');
  ok('replacing the id leaves the token', out2.includes('IG_ACCESS_TOKEN_IN=OLD_DEAD_TOKEN'));
  ok('and sets the id', out2.includes('IG_USER_ID_IN=999'));

  /* A NAME THAT IS A SUBSTRING OF ANOTHER NAME. Everything above passes even
     with an unanchored regex — no name in it is contained in another — so a
     mutation dropping the ^ and $ survived the whole block. This is the case
     that needs them: without `^`, `TOKEN=` matches INSIDE
     `IG_ACCESS_TOKEN=` and rewrites the wrong credential. */
  const collide = 'TOKEN=short\nIG_ACCESS_TOKEN=long\n';
  const fixed = setEnvVar(collide, 'TOKEN', 'NEW');
  check('only the standalone name is replaced', fixed, 'TOKEN=NEW\nIG_ACCESS_TOKEN=long\n');
  const other = setEnvVar(collide, 'IG_ACCESS_TOKEN', 'NEW');
  check('and from the other direction', other, 'TOKEN=short\nIG_ACCESS_TOKEN=NEW\n');
}

console.log('\n== A VARIABLE THAT IS NOT THERE IS APPENDED ==');
{
  check('appended to a file ending in a newline',
    setEnvVar('A=1\n', 'IG_ACCESS_TOKEN_GB', 'x'), 'A=1\nIG_ACCESS_TOKEN_GB=x\n');
  /* A file with no trailing newline would otherwise weld the new assignment
     onto the end of the last one. */
  check('a missing trailing newline is added first',
    setEnvVar('A=1', 'IG_ACCESS_TOKEN_GB', 'x'), 'A=1\nIG_ACCESS_TOKEN_GB=x\n');
  check('an empty file gets just the line',
    setEnvVar('', 'IG_ACCESS_TOKEN_GB', 'x'), 'IG_ACCESS_TOKEN_GB=x\n');
}

console.log('\n== WHAT IT REFUSES ==');
{
  /* `set -a; . .env` takes the LAST assignment and a reader that stops at the
     first takes the first, so a duplicate is a file where two tools disagree
     about which credential is live. Picking one silently is the failure. */
  throws('a duplicate assignment', () =>
    setEnvVar('T=a\nT=b\n', 'T', 'c'), 'assigned 2 times');
  /* A newline in the value splits it into an assignment plus a stray line,
     and the stray line can itself parse as a variable. */
  throws('a newline in the value', () =>
    setEnvVar('T=a\n', 'T', 'x\nEVIL=1'), 'contains a newline');
  throws('a carriage return too', () =>
    setEnvVar('T=a\n', 'T', 'x\rEVIL=1'), 'contains a newline');
  throws('a lowercase name', () => setEnvVar('', 'ig_token', 'x'), 'bad env var name');
  throws('a name with a dash', () => setEnvVar('', 'IG-TOKEN', 'x'), 'bad env var name');
}

console.log('\n== IT TARGETS THE VARIABLES THE PUBLISHER ACTUALLY READS ==');
{
  /* The tool derives its target from the same functions the reel publisher
     uses, so the two cannot drift into writing and reading different names. */
  check('IN', credEnvNames('IN').token, 'IG_ACCESS_TOKEN_IN');
  check('US', credEnvNames('US').token, 'IG_ACCESS_TOKEN_US');
  const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  check('IN posts as', accountFor('IN', cfg), 'interndoorin');
  check('US posts as', accountFor('US', cfg), 'interndoorusa');
  /* A region with no account configured is a REFUSAL, not a fallback — the
     tool must not be able to store a credential for a board that has none. */
  check('an unconfigured region has no account', accountFor('GB', cfg), null);

  const raw = readFileSync(new URL('../bin/ig-token.js', import.meta.url), 'utf8');
  /* COMMENTS STRIPPED FIRST. Two assertions here used to match this file's own
     doc comment — the mutation that deleted the publish check survived because
     the paragraph explaining the publish check was still there. Same family as
     the <title> regex that read a title out of an HTML comment (§1). */
  const tool = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('comments really were stripped', !tool.includes('THREE CHECKS BEFORE ANYTHING'));

  ok('the tool refuses an unconfigured region', /names no reels account/.test(tool));
  ok('it checks the username against config', /me\.username !== expected/.test(tool));
  ok('it CALLS the publishing-limit endpoint',
    /await graph\(`\/\$\{me\.id\}\/content_publishing_limit`\)/.test(tool));

  /* The token must never reach argv, shell history or a transcript. Asserting
     the absence of the string `--token` was too narrow: `arg('token')` reads
     the same flag and does not contain it. Assert what the token IS assigned
     from instead. */
  ok('the token comes only from the prompt',
    /const token = await askSecret\(/.test(tool));
  check('never from an argument', /\barg\(\s*['"]token['"]\s*\)/.test(tool), false);
  ok('and the prompt suppresses echo', /askSecret/.test(tool) && /\\x1b\[2K/.test(raw));
  check('and it is never printed back', /console\.log\([^)]*\btoken\b/.test(tool), false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
