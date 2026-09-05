/**
 * IS THE COLLECTOR READING CARDS AND LEARNING NOTHING FROM THEM?
 *
 * Every health check this project had asks whether the collector is WORKING.
 * None asked whether what it read was TRUE, and on 4 Sep 2026 that gap cost
 * twelve hours of the India board: LinkedIn re-worded the verified badge, the
 * employer's name landed in the location slot, and every verified employer's
 * card met the watchlist gate under a company name that was really its own
 * title. Runs stayed `ok`, pages returned 22 cards each, the skip breakdown
 * still said "off-watchlist", and §16's checklist passed the outage clean.
 *
 * WHAT ACTUALLY MOVED WAS THE YIELD: new jobs per 100 cards scanned.
 *
 *   1 Sep  2.92 / 2.57      3 Sep  1.48 / 1.78
 *   2 Sep  1.85 / 1.81      4 Sep  0.19 (bug) then 1.71 once fixed
 *
 * Cards scanned did not fall at all — 4 Sep's daytime block read 7,765 cards,
 * the HIGHEST of the week. That is the whole shape of this failure: a collector
 * doing more work than usual and returning nothing.
 *
 * THE OBVIOUS VERSION OF THIS TRIPWIRE DOES NOT WORK, AND IT WAS MEASURED
 * BEFORE BEING WRITTEN. Yield alone fires on ordinary droughts: six consecutive
 * healthy windows on the morning of 30 Aug scored exactly 0.0, because §16 is
 * right that on a weekend morning the expected intake is zero. A tripwire that
 * cries wolf daily is one nobody reads within a week.
 *
 * CARD VOLUME IS THE DISCRIMINATOR. A drought means FEW cards on the page —
 * those 0.0 windows carried 308-462 cards. A broken parser means MANY cards and
 * no yield: the 4 Sep windows carried 1,672-3,205. So the rule is not "yield is
 * low", it is "yield is low **while the collector is busy**", which is a state
 * that has no innocent explanation.
 *
 * Swept over 273 six-run windows across 11 days:
 *
 *   worst HEALTHY window at >= 1500 cards   0.495   (31 Aug)
 *   worst BUG window                        0.05    (4 Sep 17:15)
 *
 * `MIN_YIELD` 0.30 sits between them with 1.65x headroom under the healthy
 * floor, and fires on every 4 Sep window from 09:15 onward — about three hours
 * into a twelve-hour outage, against the zero hours it was caught in at the
 * time. **Zero false positives across those 11 days.**
 *
 * Re-measure both constants if the watchlist is widened sharply: yield is a
 * ratio against the gate, so a much larger watchlist raises the healthy floor
 * and leaves this firing later than it could.
 */

import { pushToPhone } from './notify.js';
import { log } from './logger.js';

/** Rolling per-run intake, newest last. */
export const INTAKE_HISTORY_KEY = 'intakeHistory';

/** When the last collapse alert went out, so a long outage sends one push. */
export const INTAKE_ALERT_KEY = 'intake_alert_at';

/**
 * Six runs is about three hours at a 30-minute cadence — long enough that a
 * single quiet run cannot trip it, short enough to catch an outage the same
 * morning. Both 4 Sep and the healthy sweep above were measured at this size.
 */
export const WINDOW_RUNS = 6;

/**
 * Below this the window is a drought, not a fault, and is not judged at all.
 * The healthy 0.0-yield windows carried 308-462 cards; the bug windows carried
 * 1,672-3,205. This is the line between "nothing was there" and "everything was
 * there and none of it landed".
 */
export const MIN_CARDS = 1500;

/** New jobs per 100 cards. See the sweep above for why it is 0.30. */
export const MIN_YIELD = 0.30;

/** One push per six hours, exactly as the session alert does. */
export const INTAKE_ALERT_GAP_MS = 6 * 60 * 60 * 1000;

/** How many runs to remember. Twice the window, so a stale entry cannot linger. */
export const KEEP_RUNS = WINDOW_RUNS * 2;

/**
 * ONLY `ok` RUNS ARE RECORDED, and that is the same rule the sweep baselines
 * follow (§4). A `partial` run is a degraded session that collected almost
 * nothing; letting it into the history would drag the window down and fire this
 * for a reason it was not built to report — and `aborted` runs have no cards at
 * all.
 */
export function readIntakeHistory(store) {
  try {
    const raw = store?.getSetting?.(INTAKE_HISTORY_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows)
      ? rows.filter((r) => r && Number.isFinite(r.c) && Number.isFinite(r.n))
      : [];
  } catch { return []; }
}

/** Append one run's totals and forget anything past `KEEP_RUNS`. */
export function appendIntakeRun(store, { cards, newJobs }) {
  const rows = [...readIntakeHistory(store), { c: Number(cards) || 0, n: Number(newJobs) || 0 }];
  const kept = rows.slice(-KEEP_RUNS);
  try { store?.setSetting?.(INTAKE_HISTORY_KEY, JSON.stringify(kept)); } catch { /* never fail a run for a counter */ }
  return kept;
}

/** Totals over the most recent `size` runs. */
export function intakeWindow(history, size = WINDOW_RUNS) {
  const rows = (history ?? []).slice(-size);
  return {
    runs: rows.length,
    cards: rows.reduce((t, r) => t + (Number(r.c) || 0), 0),
    newJobs: rows.reduce((t, r) => t + (Number(r.n) || 0), 0),
  };
}

/** New jobs per 100 cards, or null when there were no cards to judge. */
export function intakeYield({ cards, newJobs }) {
  return cards > 0 ? (100 * newJobs) / cards : null;
}

/**
 * Busy and returning nothing.
 *
 * Requires a FULL window as well as the card floor: a fresh database, or the
 * first runs after the history was cleared, would otherwise judge one quiet run
 * as an outage.
 */
export function intakeCollapsed(window, { minCards = MIN_CARDS, minYield = MIN_YIELD, windowRuns = WINDOW_RUNS } = {}) {
  if (!window || window.runs < windowRuns) return false;
  if (window.cards < minCards) return false;
  const rate = intakeYield(window);
  return rate !== null && rate < minYield;
}

/**
 * Record this run and say something if the collector has gone quiet while busy.
 *
 * Fails soft on every path. A tripwire that can throw is worse than no
 * tripwire: it would take down a scan that had already collected and published.
 */
export async function noteIntake(store, { cards, newJobs, status, now = Date.now(), send = pushToPhone } = {}) {
  if (status !== 'ok') return { recorded: false, collapsed: false };

  const history = appendIntakeRun(store, { cards, newJobs });
  const window = intakeWindow(history);
  const collapsed = intakeCollapsed(window);
  if (!collapsed) return { recorded: true, collapsed: false, window };

  const rate = intakeYield(window).toFixed(2);
  const line = `INTAKE HAS COLLAPSED: ${window.cards} cards read over the last ${window.runs} runs `
    + `produced ${window.newJobs} new listing(s) — ${rate} per 100, against a healthy floor of ${MIN_YIELD}. `
    + 'Cards are being READ and not KEPT, which is what a broken parser looks like and not what a drought looks like. '
    + 'Read the company column in seen_cards before the skip breakdown (§16).';
  log.warn(line);

  /* Once per six hours, like the session alert. A twelve-hour outage is one
     push, not twenty-four. */
  try {
    const last = Number(store?.getSetting?.(INTAKE_ALERT_KEY) ?? 0);
    if (last && now - last < INTAKE_ALERT_GAP_MS) return { recorded: true, collapsed: true, alerted: false, window };
    await send('InternDoor: intake has collapsed',
      `${window.cards} cards, ${window.newJobs} new. Check seen_cards company names.`,
      { tags: ['rotating_light'], priority: 4 });
    store?.setSetting?.(INTAKE_ALERT_KEY, String(now));
    return { recorded: true, collapsed: true, alerted: true, window };
  } catch {
    return { recorded: true, collapsed: true, alerted: false, window };
  }
}
