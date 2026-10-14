/**
 * "Save what was found so far and stop" — the one thing that ends a scan
 * early (his rule, 14 Oct 2026: "it should never stop a run ever unless i
 * click a save so far and stop button").
 *
 * The request is a timestamp in `settings`, written by the button in the scan
 * view (in the scan's own Brave, through an exposed function) or on
 * 127.0.0.1:4322/scan/latest (through the queue server). A scan honours a
 * request made at or after `since`: bin/run.sh exports INTERNDOOR_TICK_AT, so
 * one press stops the internship phase AND the full-time phase of the same
 * tick, and never a later tick. What was saved before the press is kept,
 * enriched and published as usual.
 */
export const STOP_KEY = 'scan_stop_at';

export function requestStop(store, at = Date.now()) {
  store.setSetting(STOP_KEY, at);
  return at;
}

export function stopRequestedSince(store, since) {
  const at = Number(store.getSetting(STOP_KEY) ?? 0);
  return at > 0 && at >= since;
}

/** When this scan's stop window began: the tick's start, else the run's. */
export function stopSince(env, runStartMs) {
  const tick = Number(env?.INTERNDOOR_TICK_AT);
  return Number.isFinite(tick) && tick > 0 && tick <= runStartMs ? tick : runStartMs;
}
