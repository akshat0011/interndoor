#!/usr/bin/env node
/**
 * Publish the site now, without a scan — and never on top of one.
 *
 *   node bin/publish-now.js
 *
 * What the owner controls call after a change, so a hidden or corrected posting
 * is live in a couple of minutes rather than at the next scan.
 *
 * IT TAKES THE SCAN'S OWN RUN LOCK. publish() commits and pushes, and two pushes
 * racing is the failure the notes describe: pushWithRetry retries only network
 * errors, so a non-fast-forward throws and the site sits behind its own
 * announcements. So:
 *   - a lock held by a live scan → exit 3 and change nothing. That scan reads
 *     the store when IT publishes, so the change rides along; the caller retries
 *     in case the scan had already published.
 *   - otherwise the lock is claimed for the duration and released in `finally`,
 *     but only if it is still OURS.
 * The cost, accepted: a scheduled scan that starts inside the minute this runs
 * sees the lock and skips its slot.
 */
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { publish } from '../src/publish.js';
import { log } from '../src/logger.js';

const LOCK_KEY = 'run_started_at';
const EXIT_SCAN_IN_FLIGHT = 3;

const cfg = loadConfig();
const store = new Store();
const lockExpiryMin = (cfg.limits?.maxRuntimeMinutes ?? 90) + 8;
const heldSince = Number(store.getSetting(LOCK_KEY) ?? 0);
if (heldSince && (Date.now() - heldSince) / 60_000 < lockExpiryMin) {
  console.log('A scan is running; it will publish this change itself.');
  store.close();
  process.exit(EXIT_SCAN_IN_FLIGHT);
}

const mine = String(Date.now());
store.setSetting(LOCK_KEY, mine);
let code = 0;
try {
  const ids = await publish(store, cfg, 0);
  console.log(`Published — ${ids?.size ?? 0} postings live.`);
} catch (err) {
  log.warn(`publish-now failed: ${err.message}`);
  code = 1;
} finally {
  if (store.getSetting(LOCK_KEY) === mine) store.setSetting(LOCK_KEY, '0');
  store.close();
}
process.exit(code);
