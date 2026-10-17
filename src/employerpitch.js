/**
 * The numbers an employer is told (17 Oct 2026, his ask: "advertise heavily
 * the 2500 apply clicks ... make employers notice interndoor").
 *
 * WHAT IT COUNTS: presses of OUR Apply button (`count:<UTC day>:apply:<R>`,
 * written by /api/count), never applications. Every surface says "Apply
 * clicks", never "applicants" (the 9 Oct rule in CLAUDE.md).
 *
 * WHICH DAYS: the last 7 COMPLETE UTC days. Today is still filling, and a
 * figure that includes it would read low every morning.
 *
 * ROUNDED DOWN, COARSELY, ON PURPOSE: a claim to an employer must never be
 * higher than what happened, and a coarse figure ("2,500+") moves rarely, so
 * the page that carries it is not rewritten on every publish (CLAUDE.md §10,
 * "timestamps must not churn").
 */
import { keyFor, utcDay } from '../web/api/count.js';

const DAY_MS = 86_400_000;

/** The UTC days before today, newest first. */
export function lastDays(n, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => utcDay(now - (i + 1) * DAY_MS));
}

/** Down to a round step, so the figure only ever understates: 2,588 -> 2,500. */
export function floorTo(n, step) {
  const v = Math.floor(Number(n) / step) * step;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Two significant figures, rounded down: 2,588 -> "2,500+", 1,407 -> "1,400+",
 *  999 -> "990+". Never up, so the figure is never more than happened. */
export function roundedText(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1) return null;
  const step = x < 100 ? 1 : 10 ** (Math.floor(Math.log10(x)) - 1);
  const v = floorTo(x, step);
  return v ? `${v.toLocaleString('en-IN')}+` : null;
}

/**
 * Seven days of Apply clicks for a board, from the counter store. Null when
 * the store is not configured, cannot be read, or the week is too thin to
 * quote (under 100 clicks): no figure beats a feeble or a wrong one.
 */
export async function pitchNumbers({ url, token, region = 'IN', liveRoles = 0, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!url || !token) return null;
  const days = lastDays(7, now);
  let rows;
  try {
    const res = await fetchImpl(`${String(url).replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(days.map((d) => ['GET', keyFor(d, 'apply', region)])),
    });
    if (!res.ok) return null;
    rows = await res.json();
  } catch { return null; }
  if (!Array.isArray(rows) || rows.length !== days.length) return null;
  const perDay = rows.map((r) => Number(r?.result ?? 0)).map((n) => (Number.isFinite(n) && n > 0 ? n : 0));
  const week = perDay.reduce((a, b) => a + b, 0);
  if (week < 100) return null;
  const avg = week / 7;
  return {
    region,
    days,
    applyWeek: week,
    applyPerDay: Math.round(avg),
    applyWeekText: roundedText(week),
    applyPerDayText: roundedText(avg),
    liveRoles,
  };
}
