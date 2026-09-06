#!/usr/bin/env node
/**
 * Open one region's scraper Brave profile by hand.
 *
 * There is one LinkedIn account per region, each in its own Brave profile
 * (see profileFor() in src/paths.js), and the directories are long enough that
 * pasting them is where a typo turns into "why is this profile empty". This
 * resolves the path through the same function the scraper uses, so the window
 * you get is unambiguously the one a scan will use.
 *
 * IT REFUSES WHILE A SCAN IS RUNNING, and that is the whole reason it exists
 * rather than a note in the README. A Chromium profile is an exclusive lock, so
 * the launch would fail — but the worse case is the one that succeeds: a manual
 * click can swap the detail pane out from under an open in flight and file
 * another employer's posting against the id the scraper just read (§7). The
 * failure is silent and lands in the database.
 *
 *   npm run profile                  # India
 *   npm run profile -- --region=US   # the US account
 */
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { PATHS, profileFor } from '../src/paths.js';
import { BRAVE_PATH } from '../src/browser.js';
import { log } from '../src/logger.js';

const regionArg = process.argv.slice(2)
  .map((a) => /^--region=(.+)$/.exec(a)?.[1])
  .find(Boolean);
const REGION = String(regionArg ?? PATHS.defaultProfileRegion).trim().toUpperCase();

if (!/^[A-Z]{2}$/.test(REGION)) {
  log.error(`"${REGION}" is not an ISO region code. Try \`npm run profile -- --region=US\`.`);
  process.exit(1);
}

/**
 * Is a scan running? The same matcher §4 prescribes — anchored, so it cannot
 * match its own shell wrapper and report a scan that is really this check.
 */
function scanInFlight() {
  try {
    const ps = execFileSync('/bin/ps', ['-eo', 'args'], { encoding: 'utf8', maxBuffer: 32 << 20 });
    return ps.split('\n').some((l) => /^\S*node.*src\/index\.js/.test(l));
  } catch {
    // Cannot tell, so assume the worst: a false "busy" costs a retry, a false
    // "free" costs a corrupted row.
    return true;
  }
}

const profileDir = profileFor(REGION);

if (!existsSync(BRAVE_PATH)) {
  log.error(`Brave is not at ${BRAVE_PATH}.`);
  process.exit(1);
}

if (!existsSync(profileDir)) {
  log.error(`No ${REGION} profile yet at ${profileDir}.`);
  log.info(`Sign in first: \`npm run login -- --region=${REGION}\``);
  process.exit(1);
}

if (scanInFlight()) {
  log.error('A scan is running — not opening the profile.');
  log.info('It holds this profile, and a manual click can swap the pane out from');
  log.info('under an open in flight and store the wrong employer. Wait for it to exit.');
  process.exit(1);
}

log.ok(`Opening the ${REGION} profile.`);
log.info(profileDir);
log.warn('The next scheduled run will close this window when it claims the profile.');

/* Detached, so closing this terminal does not take the browser with it. The
   scheduler's releaseProfileLock will end it when a run starts, which is
   correct — that is the lock working, not a crash. */
const child = spawn(BRAVE_PATH, [`--user-data-dir=${profileDir}`], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
