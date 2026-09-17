#!/usr/bin/env node
/**
 * Close postings whose apply link has gone dead.
 *
 *   node bin/link-sweep.js --daily     what bin/run.sh calls, at most once a day
 *   node bin/link-sweep.js             check now (still at most PER_RUN links)
 *   node bin/link-sweep.js --dry-run   report what would close, change nothing
 *
 * Reads the live, published-region tech postings with an EMPLOYER apply link
 * (never LinkedIn — src/store.js applyLinksToCheck), checks each, and on a
 * confirmed 404/410 marks it closed: off the board, its URL a closed-role stub
 * to the employer's hub, still counted in the hub's record (src/publish.js).
 *
 * It does NOT publish. The next scheduled scan's publish (≤30 min) carries the
 * closes to the site — the whole point being to cut the "still says N open"
 * lag from days to under an hour, and a publish here would race the scan.
 * See src/linksweep.js for what is and is not treated as dead.
 */
import { Store } from '../src/store.js';
import { log } from '../src/logger.js';
import { sweepApplyLinks, PER_RUN } from '../src/linksweep.js';

const has = (f) => process.argv.includes(f);
const DRY_RUN = has('--dry-run');
const DAILY = has('--daily');
const WINDOW_DAYS = 30;
const DAY_MS = 24 * 3_600_000;
const KEY = 'linkSweepAt';

const store = new Store();

if (DAILY && Date.now() - Number(store.getSetting(KEY) ?? 0) < DAY_MS) {
  store.close();
  process.exit(0);
}

const rows = store.applyLinksToCheck(Date.now() - WINDOW_DAYS * DAY_MS, { limit: PER_RUN });
if (!rows.length) {
  if (!DRY_RUN && DAILY) store.setSetting(KEY, String(Date.now()));
  store.close();
  process.exit(0);
}

const result = await sweepApplyLinks(rows, {
  log,
  /* Stamped whatever the verdict, so the next run moves on to the rows this
     one did not reach. Skipped on a dry run, which writes nothing. */
  onChecked: DRY_RUN ? undefined : (row) => store.markLinkChecked([row.job_id]),
  onClose: DRY_RUN
    ? (row, note) => log.info(`[dry-run] would close ${row.company} — "${row.title}" (${note}).`)
    : (row, note) => store.markClosed(row.job_id, `apply link dead: ${note} (${new Date().toISOString().slice(0, 10)})`),
});

log.ok(`Link sweep: checked ${result.checked} of ${rows.length} (least recently checked first), ${result.alive} alive, ${result.unknown} unverified, `
  + `${result.closed} closed${DRY_RUN ? ' (dry run — nothing written)' : ' — the next publish stubs them'}.`);

if (!DRY_RUN && DAILY) store.setSetting(KEY, String(Date.now()));
store.close();
