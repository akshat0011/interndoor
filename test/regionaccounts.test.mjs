/**
 * ONE LINKEDIN ACCOUNT PER REGION.
 *
 * LinkedIn throttles the ACCOUNT, and it says so during the interactive
 * sign-in — "your profile is requesting too much data" — a surface no log in
 * this repo has ever recorded, because it appears in `npm run login` and never
 * in a scan. Splitting India and the US onto their own accounts halves what
 * either one is judged on; a separate Brave profile per region is what makes
 * that real, because one Chromium profile is one cookie jar and two accounts in
 * it produce LinkedIn's "Choose an account" picker, which guard.js correctly
 * reads as logged out.
 *
 * The three things pinned here are the three that bite:
 *   1. the profile PREFIX trap (brave-profile vs brave-profile-US)
 *   2. India keeping the original directory, so its session is not discarded
 *   3. one signed-out account costing ONE region and not the whole run
 */
import { readFileSync } from 'node:fs';
import { PATHS, profileFor } from '../src/paths.js';
import { commandHoldsProfile, scraperProfileNames } from '../src/browser.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== INDIA KEEPS THE ORIGINAL PROFILE DIRECTORY ==');
{
  /* Renaming it would discard a working session and force a fresh sign-in on
     the busiest board, for nothing. */
  check('IN resolves to the original directory', profileFor('IN'), PATHS.profile);
  check('the default region is IN', PATHS.defaultProfileRegion, 'IN');
  check('no argument is India too', profileFor(undefined), PATHS.profile);
  check('lower case is normalised', profileFor('in'), PATHS.profile);
}

console.log('\n== EVERY OTHER REGION GETS ITS OWN ==');
{
  check('US', profileFor('US'), `${PATHS.profile}-US`);
  check('GB', profileFor('GB'), `${PATHS.profile}-GB`);
  check('lower case is normalised', profileFor('us'), `${PATHS.profile}-US`);
  check('and whitespace trimmed', profileFor('  us  '), `${PATHS.profile}-US`);
  check('two regions never share a directory', profileFor('US') === profileFor('GB'), false);
}

console.log('\n== A REGION CODE IS NEVER PASTED INTO A PATH UNCHECKED ==');
{
  /* This builds a filesystem path, so anything not ISO-shaped falls back to the
     default profile rather than becoming a directory. */
  check('traversal refused', profileFor('../../etc'), PATHS.profile);
  check('slash refused', profileFor('a/b'), PATHS.profile);
  check('too long refused', profileFor('USA'), PATHS.profile);
  check('empty refused', profileFor(''), PATHS.profile);
  check('null refused', profileFor(null), PATHS.profile);
  check('digits refused', profileFor('12'), PATHS.profile);
}

console.log('\n== THE PREFIX TRAP: brave-profile IS A PREFIX OF brave-profile-US ==');
{
  /* THE FAILURE THIS PREVENTS IS A KILLED SCRAPE. releaseProfileLock SIGTERMs
     every Brave whose command line carries the profile it was given. Matched
     with a bare `includes`, releasing India's lock also matches the US Brave's
     command line and ends a live US sweep — the same lookalike-prefix shape as
     the utmUrl bug. */
  const IN = '/state/brave-profile';
  const US = '/state/brave-profile-US';
  const line = (dir) => `1234 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser --user-data-dir=${dir} --window-size=1,2`;

  check('India matches its own', commandHoldsProfile(line(IN), IN), true);
  check('US matches its own', commandHoldsProfile(line(US), US), true);
  check('INDIA DOES NOT MATCH THE US BRAVE', commandHoldsProfile(line(US), IN), false);
  check('and the US does not match India', commandHoldsProfile(line(IN), US), false);

  /* A bare `includes` passes every check above except the third — which is
     exactly why that one is here. */
  check('a substring test would have matched it', line(US).includes(`--user-data-dir=${IN}`), true);

  check('the flag may end the line', commandHoldsProfile(`x --user-data-dir=${IN}`, IN), true);
  check('an unrelated profile does not match', commandHoldsProfile(line('/state/whatsapp-profile'), IN), false);
  check('no flag at all', commandHoldsProfile('1234 Brave Browser --foo', IN), false);
  check('empty line', commandHoldsProfile('', IN), false);
  check('undefined line', commandHoldsProfile(undefined, IN), false);
}

console.log('\n== RELEASING EVERY PROFILE MUST NOT TOUCH WHATSAPP ==');
{
  /* whatsapp-profile is a different account on a different service; releasing
     it mid-send kills a channel post. */
  const names = ['brave-profile', 'brave-profile-US', 'brave-profile-GB', 'whatsapp-profile', 'jobs.db', 'reports'];
  const got = scraperProfileNames(names, 'brave-profile');
  check('the scraper profiles', got, ['brave-profile', 'brave-profile-US', 'brave-profile-GB']);
  check('whatsapp is excluded', got.includes('whatsapp-profile'), false);
  check('unrelated entries excluded', got.includes('jobs.db'), false);
  check('empty directory is survivable', scraperProfileNames([], 'brave-profile'), []);
}

console.log('\n== browser.js LAUNCHES THE REGION IT WAS ASKED FOR ==');
{
  const src = readFileSync(new URL('../src/browser.js', import.meta.url), 'utf8');
  check('launchBrave takes a region', /export async function launchBrave\(cfg, \{ forLogin = false, region \} = \{\}\)/.test(src), true);
  check('and resolves it to a profile', /const profileDir = profileFor\(region\);/.test(src), true);
  /* The whole point: the persistent context must open THAT directory, not the
     module-level default. */
  check('the persistent context opens that profile', /launchPersistentContext\(profileDir, \{/.test(src), true);
  check('PATHS.profile is never launched directly', /launchPersistentContext\(PATHS\.profile/.test(src), false);
  /* closeBrave falls back to releasing by hand; defaulting to India there would
     leave a wedged US Brave holding its own profile. */
  check('closeBrave releases the session own profile', /releaseProfileLock\(session\.profileDir\)/.test(src), true);
  check('the session carries its profile and region', /return \{ context, page, previousApp, profileDir, region/.test(src), true);
}

console.log('\n== ONE SIGNED-OUT ACCOUNT COSTS ONE REGION, NOT THE RUN ==');
{
  /* index.js executes on import — it runs a full scrape and publish — so this
     reads the source. */
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  check('the session is opened per region', /const openRegionSession = async \(code\) => \{/.test(src), true);
  check('with that region on launchBrave', /launchBrave\(cfg, \{ region: code \}\)/.test(src), true);
  check('and no run-wide launch survives', /session = await launchBrave\(cfg\);/.test(src), false);

  check('a signed-out region is recorded', /deadRegions\.set\(region, err\.message\)/.test(src), true);
  check('and skipped rather than retried', /if \(deadRegions\.has\(region\)\) \{/.test(src), true);
  check('the run carries on', /continue;/.test(src), true);

  /* ONLY a LinkedIn refusal is survivable this way. A browser that will not
     launch is not a fact about this account, and swallowing it would report a
     tidy `ok` on a run that collected nothing. */
  check('only LOGGED_OUT is survivable', /err instanceof RunAborted && err\.state === State\.LOGGED_OUT/.test(src), true);
  check('anything else still ends the run', /\n        throw err;\n/.test(src), true);

  /* Every account down is the old whole-run outage and must still read as one,
     or the push never fires. */
  check('all regions dead still aborts', /if \(deadRegions\.size && !anyRegionWorked\) \{/.test(src), true);
  check('as a LOGGED_OUT abort', /throw new RunAborted\(State\.LOGGED_OUT,/.test(src), true);

  /* anyRegionWorked is not openRegion: a run that swept India and then found
     the US signed out has openRegion === null and must not read as an outage. */
  check('a worked-region flag exists', /let anyRegionWorked = false;/.test(src), true);
  check('set on a successful sign-in', /anyRegionWorked = true;/.test(src), true);

  /* Backfill gated on openRegion, NOT on `page`: when the last region tried was
     the signed-out one, `page` is still bound to that browser. */
  check('backfill is gated on a live session', /if \(openRegion\) \{\n      await backfillDescriptions/.test(src), true);
  check('and not on the page binding', /if \(page\) \{\n      await backfillDescriptions/.test(src), false);

  /* A region change costs a close plus a fresh launch and sign-in, so the
     rotation is grouped or India's account is opened twice in one run. */
  check('the rotation is grouped by region', /const byRegion = new Map\(\);/.test(src), true);
  check('and the loop walks the grouped order', /const ordered = \[\.\.\.byRegion\.values\(\)\]\.flat\(\);/.test(src), true);

  /* The stale-lock path does not know which region crashed. */
  check('a stale lock releases every profile', /releaseAllProfileLocks\(\);/.test(src), true);
}

console.log('\n== A REGION NEVER SIGNED IN IS LOGGED OUT, NOT A BROKEN RUN ==');
{
  /* THE REGRESSION THIS PINS COSTS EVERY BOARD. index.js survives exactly one
     thing per region — RunAborted(LOGGED_OUT) — and launchBrave threw a plain
     Error here, so the first run after a region was configured but before its
     account existed would have ended the WHOLE scan and stopped India
     collecting too: the outage this split exists to end, reintroduced from the
     other side. */
  const { existsSync, rmSync } = await import('node:fs');
  const { RunAborted, State } = await import('../src/guard.js');
  const { launchBrave } = await import('../src/browser.js');
  const { loadConfig } = await import('../src/config.js');

  const SPARE = 'ZZ';                      // a region nothing else uses
  const dir = profileFor(SPARE);
  const preexisting = existsSync(dir);     // never delete something real
  let err = null;
  try {
    await launchBrave(loadConfig(), { region: SPARE });
  } catch (e) {
    err = e;
  } finally {
    if (!preexisting) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } }
  }

  check('it throws', !!err, true);
  check('as RunAborted, not a plain Error', err?.constructor?.name, 'RunAborted');
  check('with the LOGGED_OUT state index.js survives', err?.state, State.LOGGED_OUT);
  check('so one region cannot end the run', err instanceof RunAborted && err.state === State.LOGGED_OUT, true);
  /* The message is the whole remedy — a bare "npm run login" would re-sign
     India, the account that was already working. */
  check('and it names the exact command', /npm run login -- --region=ZZ/.test(err?.message ?? ''), true);
}

console.log('\n== THE FIX NAMES THE ACCOUNT ==');
{
  /* A bare "run npm run login" on a US outage re-signs INDIA — the account that
     was already working — and signing a second account into a profile that has
     one is exactly how the "Choose an account" picker appears. */
  const login = readFileSync(new URL('../bin/login.js', import.meta.url), 'utf8');
  check('login takes --region', /--region=\(\.\+\)/.test(login), true);
  check('it defaults to India', /PATHS\.defaultProfileRegion/.test(login), true);
  check('a bad code is refused', /\[A-Z\]\{2\}\$/.test(login), true);
  check('and it launches that region', /launchBrave\(cfg, \{ forLogin: true, region: REGION \}\)/.test(login), true);

  const alert = readFileSync(new URL('../src/sessionalert.js', import.meta.url), 'utf8');
  check('the alert takes the dead regions', /regions = \[\]/.test(alert), true);
  check('and names them in the fix', /npm run login -- --region=\$\{named\[0\]\}/.test(alert), true);
  check('it no longer always claims every board', /Collection has stopped on every board\. Run/.test(alert), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
