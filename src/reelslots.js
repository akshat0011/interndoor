/**
 * When the next reel should go out.
 *
 * Three good jobs found in one sitting should become three posts, not one
 * burst. Not because Instagram punishes bursts — it does not, and at zero
 * followers there is no follower feed for them to compete in — but because
 * three reels dropped into one slot is **one measurement, not three**, and
 * measurement is the whole point of the bandit this feeds later.
 *
 * Two rules, in order:
 *
 * 1. **Space them.** A reel goes out at least `spacingMinutes` after the last
 *    one, counted from whichever is later: the last publish, or the last slot
 *    already handed out. Counting only from the last PUBLISH would hand three
 *    presses in one minute the same slot.
 * 2. **Keep them inside the window.** The audience is Indian students; the
 *    board's own intake data puts weekday attention in the 16:00-20:00 IST
 *    block, against 08:00-12:00 carrying almost nothing. A reel scheduled for
 *    03:00 is a wasted reel however well spaced.
 *
 * The FIRST reel of a sitting is not delayed. He pressed the button because he
 * wants it out; making him wait four hours for the first one would mean the
 * button no longer does what it says.
 */

/** Defaults. Overridden by `reels` in config.json. */
export const SLOTS = {
  spacingMinutes: 180,
  /** Inclusive start, exclusive end, in the region's local hours. */
  windowStartHour: 10,
  windowEndHour: 22,
  timeZone: 'Asia/Kolkata',
};

/** The local hour in a zone, without pulling in a date library. */
export function hourIn(ms, timeZone) {
  const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone })
    .format(new Date(ms));
  return Number(h);
}

/**
 * Move a time forward into the next open window, if it is outside one.
 *
 * Walks in hour steps rather than doing calendar arithmetic: the step is at
 * most 24 iterations, and it is correct across a DST change in any zone
 * without knowing anything about DST. India has none, but this is the sort of
 * assumption that quietly stops being true when a region is added.
 */
export function intoWindow(ms, cfg = {}) {
  const c = { ...SLOTS, ...cfg };
  if (c.windowStartHour === c.windowEndHour) return ms;      // a 24h window
  const HOUR = 3_600_000;
  let t = ms;
  for (let i = 0; i < 48; i++) {
    const h = hourIn(t, c.timeZone);
    const open = c.windowStartHour < c.windowEndHour
      ? h >= c.windowStartHour && h < c.windowEndHour
      : h >= c.windowStartHour || h < c.windowEndHour;      // a window over midnight
    if (open) return t;
    // Advance one UTC hour boundary at a time. That is deliberately NOT the
    // local hour: IST is UTC+05:30, so a slot pushed out of the window lands
    // at 10:30 rather than 10:00. It costs nothing — the point is to stop the
    // slot inheriting whatever minute the button happened to be pressed at
    // hours earlier — and stepping on UTC keeps this free of local-calendar
    // arithmetic, which is what makes it correct across a DST change in a zone
    // that has one.
    t = Math.floor(t / HOUR) * HOUR + HOUR;
  }
  return ms;
}

/**
 * The slot for a reel queued now.
 *
 * @param {object}   opts
 * @param {number}   opts.now
 * @param {number?}  opts.lastPublishedAt  when a reel last actually went out
 * @param {number[]} opts.pendingSlots     slots already handed out and not yet used
 * @returns {number|null} the time to publish at, or null for "now"
 */
export function nextSlot({ now, lastPublishedAt = null, pendingSlots = [] }, cfg = {}) {
  const c = { ...SLOTS, ...cfg };
  const gap = c.spacingMinutes * 60_000;

  // Whichever is later. A slot already promised to a queued reel counts even
  // though nothing has been published yet — otherwise three presses inside a
  // minute all measure from the same last publish and collide.
  const anchor = Math.max(lastPublishedAt ?? 0, ...pendingSlots.filter(Boolean), 0);

  // Nothing recent and nothing queued: go now. The button did what it said.
  if (!anchor) return null;

  const earliest = anchor + gap;
  if (earliest <= now && !pendingSlots.length) return null;

  return intoWindow(Math.max(earliest, now), c);
}

/** "6:30 pm", for the button. */
export function slotLabel(ms, cfg = {}) {
  const c = { ...SLOTS, ...cfg };
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: c.timeZone,
  }).format(new Date(ms));
}
