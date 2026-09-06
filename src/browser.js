import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PATHS, profileFor } from './paths.js';
import { RunAborted, State } from './guard.js';
import { log } from './logger.js';

export const BRAVE_PATH = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

/**
 * Playwright cannot drive your everyday Brave.
 *
 * Two independent blockers: Chromium 136+ refuses remote debugging on the
 * default user-data-dir, and a running Brave holds the profile lock so a second
 * launch just relays and exits. So the tool keeps its own profile, which you
 * sign into once via `npm run login`.
 */
function braveArgs(cfg) {
  const [w, h] = cfg.browser.windowSize;
  const [x, y] = cfg.browser.windowPosition ?? [40, 40];

  const args = [
    // Window geometry has to come through as a Chromium arg. Setting a
    // Playwright `viewport` instead decouples the CSS viewport from the real
    // window, producing an outerWidth/innerWidth mismatch no real browser has.
    `--window-size=${w},${h}`,
    `--window-position=${x},${y}`,

    // The one masking flag that matters. navigator.webdriver is true by
    // default even with a real Brave binary, a persistent profile and a headed
    // window; this clears it at the Blink level, leaving no JS artifact.
    '--disable-blink-features=AutomationControlled',

    '--no-first-run',
    '--no-default-browser-check',
    '--disable-brave-update',

    // If a previous run ended badly, Chromium offers to restore its tabs. The
    // bubble steals the viewport, and accepting it reopens a window of stale
    // job pages that the scan then treats as the current one. We always start
    // from a known URL, so there is nothing worth restoring.
    //
    // Only the bubble flag belongs here. There is NO "--restore-last-session=false":
    // that switch is read with HasSwitch(), so any value at all — including the
    // string "false" — turns restore ON. Passing it did the opposite of what it
    // looks like and cost a run.
    '--hide-crash-restore-bubble',
  ];

  // Brave's Shields extension. Not normally needed: Playwright passes
  // --disable-component-update, and Brave ships its ad-block lists as an
  // updatable component, so a fresh profile has no filter data to match on.
  if (cfg.browser.disableBraveShields) args.push('--disable-brave-extension');

  // Deliberately NOT passed: --disable-features / --enable-features. Playwright
  // already sets both with long, load-bearing lists, and a second copy of the
  // switch replaces rather than extends them. The commonly cited Brave flags
  // (--disable-brave-rewards, --disable-brave-wallet) are not real switches
  // anyway, and Rewards shows no onboarding on a fresh profile with
  // --no-first-run.
  return args;
}

/** Which app currently owns the keyboard. Needs no accessibility permission. */
function frontmostApp() {
  try {
    const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8' });
    return (info.match(/"([^"]*)"$/m) || [])[1] || null;
  } catch {
    return null;
  }
}

/**
 * Hand focus back to whoever had it. Chromium calls
 * -[NSApp activateIgnoringOtherApps:] on launch, so a headed window always
 * steals focus — even positioned off-screen. The theft is a one-time event at
 * launch, so a single `open -a` settles it; later navigation and screenshots do
 * not re-steal. Uses `open` rather than osascript because LaunchServices needs
 * no Automation permission, while Apple Events do.
 */
function restoreFocus(appName) {
  if (!appName || appName === 'Brave Browser') return;
  try {
    execFileSync('/usr/bin/open', ['-a', appName], { stdio: 'ignore' });
  } catch { /* cosmetic only */ }
}

/**
 * Free the tool's Brave profile before launching.
 *
 * Guards against a Brave from an earlier run still holding the profile's
 * singleton lock, which makes the next `launchPersistentContext` wait for a
 * profile it will never get. The visible symptom is leftover windows full of
 * about:blank tabs.
 *
 * Worth knowing what this did NOT explain: the run of
 * "launchPersistentContext: Timeout" failures in the runs table happened with no
 * orphan present — this function never once logged a kill during them. Their
 * real cause was the run lock expiring at exactly maxRuntimeMinutes while a run
 * was legitimately still going (see index.js), plus launchd firing as the
 * machine woke. Keep this as belt-and-braces, not as the explanation.
 *
 * Two rules keep this safe:
 *   1. Match on the profile path, never on the process name. Killing "Brave" by
 *      name would take the user's ordinary browser and every tab in it with it.
 *      Only a process whose command line carries `--user-data-dir=<our profile>`
 *      is ours to end.
 *   2. Terminate politely first. SIGKILL on Chromium leaves the profile marked
 *      unclean, which is what produces the "Brave didn't shut down correctly"
 *      restore-tabs bar on the next launch — another source of stray tabs.
 */
/**
 * Is this `ps` line a browser holding EXACTLY this profile directory?
 *
 * MATCH TO AN ARGUMENT BOUNDARY, NEVER WITH A BARE `includes`.
 *
 * Since regions got their own profiles the directory names are prefixes of one
 * another — `brave-profile` is a prefix of `brave-profile-US` — so a substring
 * test for India's profile also matches the US Brave's command line, and
 * releasing one region's lock would SIGKILL the other region's live scrape.
 * Chromium's argv reaches `ps` space-separated, so the flag is ours only when
 * the character after it ends the argument.
 *
 * Exported for the tests: this is a one-line predicate whose failure mode is a
 * killed scrape in another region, and a source-level assertion would keep
 * passing if the boundary check were quietly relaxed back to `includes`.
 */
export function commandHoldsProfile(line, profileDir) {
  const flag = `--user-data-dir=${profileDir}`;
  const at = String(line ?? '').indexOf(flag);
  if (at === -1) return false;
  const next = String(line)[at + flag.length];
  return next === undefined || next === ' ';
}

/**
 * Which entries of a state directory are scraper profiles?
 *
 * `whatsapp-profile` must never be among them: it is a different account on a
 * different service, and releasing it mid-send kills a channel post.
 */
export function scraperProfileNames(names, base) {
  return (names ?? []).filter((n) => n === base || n.startsWith(`${base}-`));
}

export function releaseProfileLock(profileDir = PATHS.profile) {
  const holdsProfile = (line) => commandHoldsProfile(line, profileDir);

  let ours = [];
  try {
    // -ww asks ps not to truncate. Measured on this machine it changes nothing
    // (both forms return the full ~4.4k-character Chromium command line), but
    // the default width limit is platform-dependent and `--user-data-dir` sits
    // near the end of that line, so it is cheap insurance.
    const ps = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 });
    ours = ps
      .split('\n')
      // Both conditions are required. The profile path alone also matches this
      // very process, any shell that mentions it, and a grep looking for it —
      // killing those would be worse than the problem being solved.
      .filter((line) => holdsProfile(line) && line.includes('Brave Browser'))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid && pid !== process.ppid);
  } catch {
    return; // ps unavailable — fall through and let the launch try anyway.
  }

  if (ours.length) {
    log.warn(`Found ${ours.length} leftover Brave process${ours.length === 1 ? '' : 'es'} holding the tool profile — closing ${ours.length === 1 ? 'it' : 'them'} before launching.`);
    for (const pid of ours) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    // Give Chromium a moment to release the lock and write a clean profile.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const alive = ours.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (!alive.length) break;
      try { execFileSync('/bin/sleep', ['0.25']); } catch { break; }
    }
    for (const pid of ours) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited cleanly */ }
    }
  }

  // Stale singleton links survive a hard kill and block the next launch on
  // their own, so clear them whether or not we just killed anything.
  try {
    for (const name of readdirSync(profileDir)) {
      if (name.startsWith('Singleton')) {
        rmSync(join(profileDir, name), { force: true, recursive: true });
      }
    }
  } catch { /* profile not created yet */ }
}

/**
 * Release EVERY region's scraper profile.
 *
 * For the stale-run-lock path only, where a previous run crashed and we do not
 * know which region's Brave it had open — possibly several, since a run now
 * opens one per region in turn. Discovered from the filesystem rather than
 * from config, so a profile left behind by a region that has since been turned
 * off is still cleaned up.
 *
 * `brave-profile` is matched as a NAME PREFIX, which deliberately excludes
 * `whatsapp-profile`: that is a different account on a different service and
 * killing it would break a channel post mid-send.
 */
export function releaseAllProfileLocks() {
  const dir = dirname(PATHS.profile);
  const base = basename(PATHS.profile);
  let names = [];
  try {
    names = scraperProfileNames(readdirSync(dir), base);
  } catch {
    names = [base];
  }
  for (const name of names) releaseProfileLock(join(dir, name));
}

/**
 * Launch Brave with the persistent profile for ONE region's LinkedIn account.
 *
 * Returns { context, page, profileDir, region }. Pass `{ forLogin: true }` for
 * the sign-in flow, which must not assume a session already exists, and
 * `{ region }` to pick the account — see profileFor() in src/paths.js for why
 * each region has its own directory.
 */
export async function launchBrave(cfg, { forLogin = false, region } = {}) {
  const profileDir = profileFor(region);
  if (!existsSync(BRAVE_PATH)) {
    throw new Error(`Brave is not at ${BRAVE_PATH}. Install Brave, or edit BRAVE_PATH in src/browser.js.`);
  }
  if (cfg.browser.headed === false) {
    // Headless leaks "HeadlessChrome" in the user agent and collapses the
    // screen to 800x600 — both trivially detectable.
    throw new Error('browser.headed must stay true. Headless mode is detectable and will get the account flagged.');
  }

  mkdirSync(profileDir, { recursive: true });
  const firstEver = !existsSync(join(profileDir, 'Default'));

  if (!forLogin && firstEver) {
    /* Name the region, because with one profile per region the fix is a
       DIFFERENT command per account and "run npm run login" on its own sends
       him to re-sign the region that was already working. */
    const how = profileDir === PATHS.profile
      ? '`npm run login`'
      : `\`npm run login -- --region=${String(region).toUpperCase()}\``;
    /**
     * A REGION THAT HAS NEVER BEEN SIGNED IN IS LOGGED OUT, NOT A BROKEN RUN.
     *
     * This threw a plain Error, and a plain Error is the one thing index.js
     * will not survive per region — so the first run after a new region was
     * configured, but before its account existed, would have ended the WHOLE
     * scan and stopped India collecting too. Exactly the outage this split was
     * meant to end, reintroduced from the other side.
     *
     * `RunAborted(LOGGED_OUT)` is also simply the truthful state: there is no
     * session for this account. It makes the run skip this region, say so in
     * the notes, and push a message naming the command that fixes it.
     */
    throw new RunAborted(State.LOGGED_OUT,
      `No LinkedIn session for ${region ?? PATHS.defaultProfileRegion} yet. Run ${how} once to sign in.`);
  }

  const previousApp = frontmostApp();

  // Must happen before the launch, not after: the whole point is that the
  // profile is free by the time Playwright asks for it. Scoped to THIS
  // region's profile, so it cannot end another region's browser.
  releaseProfileLock(profileDir);

  log.info(`Launching Brave (${region ?? PATHS.defaultProfileRegion} account)…`);

  /**
   * Launching is retried rather than fatal.
   *
   * A launch timeout used to end the run outright, and it was the single
   * largest source of failed runs. The causes are all transient — the machine
   * waking from sleep while launchd fires, a previous Brave that has not
   * finished releasing the profile, a moment of heavy load — and every one of
   * them is gone a few seconds later. Killing a whole 15-minute slot over that
   * is the wrong trade, especially when the retry costs seconds.
   *
   * Each attempt re-runs the profile cleanup first, because by far the most
   * likely reason the first attempt hung is something still holding the profile.
   */
  // Only these four options, plus args. Overriding locale, timezoneId or
  // userAgent can only create a mismatch between JS values, HTTP headers and
  // the real IP geolocation — on the user's own machine the natural values are
  // correct by definition.
  const attemptLaunch = () => chromium.launchPersistentContext(profileDir, {
    executablePath: BRAVE_PATH,
    headless: false,
    viewport: null,
    args: braveArgs(cfg),
    // Playwright defaults to --no-sandbox, which makes Brave show a yellow
    // "unsupported command-line flag" banner across the top of every page.
    // Keeping the normal sandbox removes the banner and matches how the browser
    // ordinarily runs.
    chromiumSandbox: true,
    // Per attempt, not for the whole launch. A healthy launch takes about two
    // seconds, so 45s is already generous; the retries below are what absorb a
    // slow machine, rather than one long hopeful wait.
    timeout: 45_000,
  });

  const LAUNCH_ATTEMPTS = 3;
  let context;
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    try {
      context = await attemptLaunch();
      if (attempt > 1) log.ok(`Brave launched on attempt ${attempt}.`);
      break;
    } catch (err) {
      const last = attempt === LAUNCH_ATTEMPTS;
      const why = err.message.split('\n')[0];
      if (last) {
        // Playwright does not kill the browser it spawned when the launch times
        // out, so giving up here would leave it holding the profile and make the
        // NEXT run fail for a reason that has nothing to do with that run. The
        // logs show exactly this: "Found 4 leftover Brave processes" on every
        // retry, each set left by the attempt before it.
        releaseProfileLock(profileDir);
        throw new Error(`Brave would not launch after ${LAUNCH_ATTEMPTS} attempts — ${why}`);
      }
      log.warn(`Brave did not launch (attempt ${attempt}/${LAUNCH_ATTEMPTS}): ${why}`);
      // Almost always something still holding the profile, so clear it again
      // before trying rather than repeating the identical attempt.
      releaseProfileLock(profileDir);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  if (cfg.browser.returnFocus !== false) restoreFocus(previousApp);

  // No fingerprint-spoofing init script here, deliberately. What keeps this
  // account safe is low volume and honest pacing, not pretending to be a
  // different browser. If LinkedIn challenges the session, the tool stops and
  // asks you — see src/guard.js.

  // Pick the real tab, not a placeholder. Brave can come up with a restored
  // session or its own new-tab page, and `pages()[0]` is then an about:blank
  // that every later health check reads as a broken or challenged page — the
  // run stops on a page that was never LinkedIn to begin with.
  const realPage = context.pages().find((p) => {
    const u = p.url();
    return u && u !== 'about:blank' && !u.startsWith('chrome://') && !u.startsWith('brave://');
  });
  const page = realPage ?? context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);

  // Close the tabs Brave opened for itself. A single sweep is not enough: the
  // restore-session tab can arrive a moment after launch, so anything that
  // shows up later gets closed too. Without this they accumulate across runs,
  // which is where the window full of about:blank tabs comes from.
  const closeStray = (p) => {
    if (p === page) return;
    p.close().catch(() => {});
  };
  for (const p of context.pages()) closeStray(p);
  context.on('page', closeStray);

  /* profileDir and region travel WITH the session. closeBrave falls back to
     releasing the lock by hand, and with one profile per region it has to
     release the right one — defaulting to India's would leave a wedged US
     Brave holding its own profile and kill the next US sweep. */
  return { context, page, previousApp, profileDir, region: region ?? PATHS.defaultProfileRegion };
}

export async function closeBrave(session) {
  if (!session) return;
  try {
    // A close that never resolves is how a Brave survives its own run and then
    // blocks the next one. Bound the wait, then fall through to the same
    // profile-lock cleanup the next launch would do — better to end it here,
    // while we still know it is ours, than to leave it for a run 15 minutes
    // from now to discover.
    await Promise.race([
      session.context.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close timed out after 20s')), 20_000)),
    ]);
    log.info('Closed Brave.');
  } catch (err) {
    log.warn(`Brave did not close cleanly (${err.message}) — releasing the profile by hand.`);
    releaseProfileLock(session.profileDir);
  }
}

/** Bring the automation window forward — used when a CAPTCHA needs a human. */
export function focusBrave() {
  try {
    execFileSync('/usr/bin/open', ['-a', 'Brave Browser'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Is there a usable LinkedIn session cookie in the profile? */
export async function hasLinkedInSession(context) {
  const cookies = await context.cookies('https://www.linkedin.com');
  const liAt = cookies.find((c) => c.name === 'li_at');
  if (!liAt) return false;
  if (liAt.expires && liAt.expires > 0 && liAt.expires * 1000 < Date.now()) return false;
  return true;
}
