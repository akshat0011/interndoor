/**
 * WhatsApp's Brave launch — clearSessionHistory and launchWithRetry.
 *
 * `browserType.launchPersistentContext: Timeout 180000ms exceeded` failed a
 * WhatsApp send about once a day. Two causes, both measured 13 Sep 2026:
 *   1. `Default/Sessions` had grown to 20 MB and Brave replays it on every
 *      start — 26-27 s idle on a copy of the profile, 0.67 s without it.
 *   2. A timed-out launch leaves its Brave holding the profile, so the NEXT run
 *      fails as well ("Failed to create a ProcessSingleton", 7 and 8 Sep).
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearSessionHistory, launchWithRetry, LAUNCH_TIMEOUT_MS, findTargetPatiently, TARGET_RETRY_MS } from '../src/whatsapp.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== THE SESSION HISTORY GOES, THE LOGIN STAYS ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'wa-profile-'));
  const def = join(dir, 'Default');
  const make = (rel, body = 'x') => { mkdirSync(join(def, rel, '..'), { recursive: true }); writeFileSync(join(def, rel), body); };
  make('Sessions/Tabs_13433787344814750');
  make('Sessions/Session_13433787344149372');
  make('Current Session'); make('Last Tabs');
  // Where WhatsApp Web keeps the linked-device login.
  make('IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/000003.log');
  make('Local Storage/leveldb/000003.log');
  make('Preferences', '{"session":{"restore_on_startup":5}}');

  clearSessionHistory(dir);
  check('Sessions is gone', existsSync(join(def, 'Sessions')), false);
  check('and the older session file names with it', [existsSync(join(def, 'Current Session')), existsSync(join(def, 'Last Tabs'))], [false, false]);
  check('IndexedDB is untouched — that is the WhatsApp login',
    existsSync(join(def, 'IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/000003.log')), true);
  check('Local Storage is untouched', existsSync(join(def, 'Local Storage/leveldb/000003.log')), true);
  check('Preferences is untouched', readFileSync(join(def, 'Preferences'), 'utf8'), '{"session":{"restore_on_startup":5}}');
  let threw = false;
  try { clearSessionHistory(join(dir, 'never-created')); } catch { threw = true; }
  check('a profile with no history yet does not throw', threw, false);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n== A LAUNCH THAT HANGS IS RETRIED, AND ITS BRAVE IS CLEARED ==');
{
  const quiet = { pause: async () => {} };
  const script = (outcomes) => {
    const log = [];
    let n = 0;
    const launch = async () => {
      const o = outcomes[n++];
      log.push(`launch${n}`);
      if (o instanceof Error) throw o;
      return o;
    };
    const release = () => log.push('release');
    return { launch, release, log };
  };
  const timeout = new Error('browserType.launchPersistentContext: Timeout 60000ms exceeded.\nCall log: …');

  const ok = script(['ctx']);
  check('a healthy launch returns its context', await launchWithRetry(ok.launch, { ...quiet, release: ok.release }), 'ctx');
  /* A leftover from the PREVIOUS run's timeout is the common case, so the
     profile is cleared before the first attempt, not only after a failure. */
  check('and the profile is released before the first attempt', ok.log, ['release', 'launch1']);

  // Caught, not awaited bare: a retry that never happens THROWS, and an uncaught
  // throw here would abort the file and stop the npm test chain (§1).
  const settle = (p) => p.then((v) => v, (e) => `threw: ${e.message.split(' — ')[0]}`);
  const second = script([timeout, 'ctx2']);
  check('one timeout, then a launch, succeeds', await settle(launchWithRetry(second.launch, { ...quiet, release: second.release })), 'ctx2');
  check('with the profile released between the two', second.log, ['release', 'launch1', 'release', 'launch2']);

  const dead = script([timeout, timeout, timeout]);
  let msg = null;
  try { await launchWithRetry(dead.launch, { ...quiet, release: dead.release }); } catch (e) { msg = e.message; }
  check('three hangs give up with the first line of the reason', msg, 'Brave would not launch after 3 attempts — browserType.launchPersistentContext: Timeout 60000ms exceeded.');
  /* Playwright leaves a timed-out Brave running; without the last release the
     NEXT run inherits a held profile and fails for this run's reason. */
  check('and the last hung Brave is cleared too, for the next run',
    dead.log, ['release', 'launch1', 'release', 'launch2', 'release', 'launch3', 'release']);

  const pauses = [];
  const slow = script([timeout, timeout, 'ctx']);
  await settle(launchWithRetry(slow.launch, { release: slow.release, pause: async (ms) => { pauses.push(ms); } }));
  check('it waits a little longer before each retry', pauses, [3000, 6000]);
}

console.log('\n== A CHANNEL LIST STILL SYNCING GETS A SECOND LOOK ==');
{
  const finder = (results) => { let n = 0; const calls = []; return { calls, find: async (_p, name) => { calls.push(name); return results[n++]; } }; };
  const pauses = [];
  const pause = async (ms) => { pauses.push(ms); };

  const found = finder([{ ok: true, how: 'channel "Interndoor"' }]);
  check('found at once: one look, no wait', [await findTargetPatiently({}, 'Interndoor', { find: found.find, pause }), found.calls.length, pauses.length],
    [{ ok: true, how: 'channel "Interndoor"' }, 1, 0]);

  const late = finder([{ ok: false, error: 'no channel called "Interndoor" appeared within 20s' }, { ok: true, how: 'channel "Interndoor"' }]);
  check('missing, then there after the pause: found', (await findTargetPatiently({}, 'Interndoor', { find: late.find, pause })).ok, true);
  check('after waiting the retry pause once', pauses, [TARGET_RETRY_MS]);
  check('and the retry pause is 15 s', TARGET_RETRY_MS, 15_000);

  const gone = finder([{ ok: false, error: 'no channel' }, { ok: false, error: 'no channel' }]);
  const r = await findTargetPatiently({}, 'Interndoor', { find: gone.find, pause: async () => {} });
  check('genuinely gone still fails, and says it looked twice', [r.ok, r.error, gone.calls.length], [false, 'no channel (also on a second look)', 2]);

  const src = readFileSync(new URL('../src/whatsapp.js', import.meta.url), 'utf8');
  check('the send path uses the patient lookup', /const target = await findTargetPatiently\(page, conf\.target\);/.test(src), true);
}

console.log('\n== WIRED INTO openWhatsApp ==');
{
  const src = readFileSync(new URL('../src/whatsapp.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function openWhatsApp'), src.indexOf('const page = ctx.pages()[0]'));
  check('the session history is cleared before the launch',
    body.indexOf('clearSessionHistory(PATHS.whatsappProfile)') > 0
      && body.indexOf('clearSessionHistory(PATHS.whatsappProfile)') < body.indexOf('launchWithRetry('), true);
  check('the launch goes through the retry', /const ctx = await launchWithRetry\(\(\) => chromium\.launchPersistentContext\(PATHS\.whatsappProfile/.test(body), true);
  check('with a bounded per-attempt timeout, not Playwright\'s 180 s', /timeout: LAUNCH_TIMEOUT_MS/.test(body) && LAUNCH_TIMEOUT_MS === 60_000, true);
  check('releasing the WhatsApp profile, never a scraper one', /release: \(\) => releaseProfileLock\(PATHS\.whatsappProfile\)/.test(body), true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
