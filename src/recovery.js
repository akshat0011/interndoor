/**
 * THE NIGHTLY RECOVERY SLOT (his call, 14 Oct 2026): once a night, in the hour
 * LinkedIn is least likely to rate-limit us, both India searches are read on
 * the PUBLIC search over a 24-hour window, to pick up anything the hourly
 * signed-in walks missed. No signed-in walk runs in that hour: the last one is
 * in the hour before and the next in the hour after.
 *
 * Measured before choosing the hour (public-search requests and 429 waits by
 * IST hour, 26 Sep - 14 Oct 2026): 04:00 had 1 rate-limit in 813 requests
 * (0.1%), 03:00 0.7%, midday about 3%.
 *
 * bin/run.sh asks bin/recovery-slot.js once per tick. The answer:
 *   'recover' - the slot's hour, and tonight's recovery has not run yet
 *   'hold'    - the slot's hour, recovery already ran: no LinkedIn walk at all
 *   'normal'  - any other hour
 */
export const RECOVERY_KEY = 'recovery_day';

/** The calendar day and hour of `now` in the recovery's own time zone. */
export function zonedParts(now, timeZone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

export function recoveryConfig(cfg) {
  const r = cfg?.recovery;
  if (!r || r.enabled !== true) return null;
  const hour = Number(r.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const windowHours = Number(r.windowHours) > 0 ? Number(r.windowHours) : 24;
  return { hour, windowHours, timeZone: r.timeZone || 'Asia/Kolkata' };
}

/** Which kind of tick this is. `lastDay` is the day recovery last finished. */
export function recoverySlot({ now = Date.now(), cfg, lastDay = null } = {}) {
  const r = recoveryConfig(cfg);
  if (!r) return 'normal';
  const { day, hour } = zonedParts(now, r.timeZone);
  if (hour !== r.hour) return 'normal';
  return lastDay === day ? 'hold' : 'recover';
}

/** The day to record once a recovery has run. */
export function recoveryDay(now, cfg) {
  return zonedParts(now, recoveryConfig(cfg)?.timeZone ?? 'Asia/Kolkata').day;
}
