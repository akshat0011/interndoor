/**
 * Which Instagram account a region's reels go to, and which credentials open it.
 *
 * THERE IS ONE ACCOUNT PER REGION AND THEY MUST NEVER BE ABLE TO CROSS.
 * `@interndoorusa` carries US roles and `@interndoorin` carries Indian ones. A
 * reel posted to the wrong account cannot be taken back, and it is the exact
 * mistake bin/ig_publish.py's account guard already exists to stop — it was
 * written because storygasted's .env holds IG_USER_ID and IG_ACCESS_TOKEN for a
 * DIFFERENT account under the same two names, so a pipeline that merely
 * inherited the environment would post InternDoor's reels to storygasted.
 *
 * Two accounts turn that from a trap into an everyday condition: the names now
 * collide by design. So credentials are held under REGION-SUFFIXED names —
 * IG_USER_ID_US / IG_ACCESS_TOKEN_US, IG_USER_ID_IN / IG_ACCESS_TOKEN_IN — and
 * the guard still asks the live account who it is before anything is published.
 * The suffixed name is the only thing that can address a region's account; the
 * bare names are read ONLY as a fallback for a single-account setup, and never
 * when a suffixed pair exists.
 */

/** Bare names, kept so a pre-existing single-account .env still works. */
const LEGACY = { user: 'IG_USER_ID', token: 'IG_ACCESS_TOKEN' };

/** The env var names holding one region's credentials. */
export function credEnvNames(region) {
  const r = String(region || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(r)) throw new Error(`bad region for credentials: ${region}`);
  return { user: `IG_USER_ID_${r}`, token: `IG_ACCESS_TOKEN_${r}`, legacy: LEGACY };
}

/**
 * The username that MUST own the token for this region.
 *
 * Returns null when the region has no account configured, which is a REFUSAL,
 * not a fallback: posting a region's roles to another region's followers is the
 * same mistake as routing its listings to the wrong Telegram channel, and that
 * one is already decided — a region with no channel gets no post.
 */
export function accountFor(region, cfg = {}) {
  const accounts = cfg.reels?.accounts ?? {};
  return accounts[String(region || '').toUpperCase()] || null;
}

/** Regions that publish reels automatically, in config order. */
export function autoRegions(cfg = {}) {
  const wanted = cfg.reels?.auto?.regions ?? [];
  return wanted.map((r) => String(r).toUpperCase()).filter((r) => accountFor(r, cfg));
}

export function autoEnabled(cfg = {}) {
  return cfg.reels?.auto?.enabled !== false && autoRegions(cfg).length > 0;
}

/**
 * How many reels a region may publish in a rolling day.
 *
 * THIS IS NOT A STYLE PREFERENCE, IT IS THE PLATFORM'S OWN LIMIT. Instagram's
 * Content Publishing API allows 100 posts per rolling 24 hours per account —
 * measured live, not assumed. The US board's intake over the fortnight to
 * 27 Aug ran a mean of 78 tech listings a day, a MEDIAN of 105 and a peak of
 * 138, so "a reel for every new job" is not something the account is allowed to
 * do: on a normal day it would be turned away by the API, and the reels refused
 * would be an arbitrary tail rather than the worst ones.
 *
 * A cap therefore has to exist. Making it explicit means the pipeline chooses
 * WHICH roles go out — freshest first — instead of discovering the ceiling by
 * being rejected partway through the day.
 */
export function dailyCap(region, cfg = {}) {
  const auto = cfg.reels?.auto ?? {};
  const per = auto.dailyCapByRegion ?? {};
  const n = Number(per[String(region || '').toUpperCase()] ?? auto.dailyCap ?? 20);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : 0;
}

/**
 * Minutes between two automatic posts, so a day's cap spreads across the window
 * instead of arriving as a burst.
 *
 * DERIVED FROM THE CAP, not taken from `reels.spacingMinutes`. That value is 180
 * and belongs to the MANUAL queue, where a sitting is two or three reels he
 * picked by hand; at 180 minutes the 10:00-22:00 window holds four posts, so an
 * automatic run capped at 20 would spend three days delivering one day's roles
 * and never catch up. Dividing the window by the cap keeps the whole day's
 * allowance inside the day.
 */
export function autoSpacingMinutes(region, cfg = {}) {
  const explicit = Number(cfg.reels?.auto?.spacingMinutes);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const start = Number(cfg.reels?.windowStartHour ?? 10);
  const end = Number(cfg.reels?.windowEndHour ?? 22);
  const windowMinutes = (start === end ? 24 : (end - start + 24) % 24) * 60;
  const cap = dailyCap(region, cfg);
  if (!cap) return 60;
  return Math.max(5, Math.floor(windowMinutes / cap));
}

/**
 * The slot config an automatic post should be spaced and placed by.
 *
 * THE POSTING WINDOW IS IN THE REGION'S OWN TIME ZONE, and that is not a
 * detail. `reels.timeZone` is Asia/Kolkata because the manual queue was built
 * when India was the only account, and 10:00-22:00 there is 23:30-11:30 in New
 * York — so every US reel would have gone out while America was asleep, which
 * defeats the only reason the window exists. src/regions.js already carries the
 * right zone for each board (US -> America/New_York) and stamping dates in it
 * is a rule publish already follows.
 *
 * The HOURS stay shared: 10:00-22:00 is a statement about when people look at
 * their phones, and that travels. Only the zone it is measured in changes.
 */
export function autoSlotConfig(region, cfg = {}, regionTimeZone = null) {
  const reels = cfg.reels ?? {};
  return {
    ...reels,
    spacingMinutes: autoSpacingMinutes(region, cfg),
    timeZone: cfg.reels?.auto?.timeZoneByRegion?.[String(region || '').toUpperCase()]
      || regionTimeZone || reels.timeZone,
  };
}
