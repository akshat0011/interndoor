/**
 * Which boards may be posted to LinkedIn.
 *
 * He posts from his own personal account, which is Indian, and there is no US
 * LinkedIn account. So a US weekly roundup, a US post draft and a US "Add to
 * post queue" button were all producing copy nobody could publish — work done
 * every week for a destination that does not exist.
 *
 * ONE PLACE, read by four surfaces: the report's buttons, the queue endpoint,
 * the combined post and the weekly roundup. Four independent checks is how one
 * of them silently keeps queueing US rows after the others stop.
 *
 * DELIBERATELY SEPARATE FROM REELS. Instagram has a live US account
 * (@interndoorusa) posting US roles, so this must not be reused to gate them —
 * that is `reels.auto.regions`, and it says something different.
 *
 * Absent means India only rather than everything: the failure this exists to
 * stop is work being done for a channel that is not there, so the safe default
 * is the account we know exists.
 */
export function postRegions(cfg = {}) {
  const list = cfg.postQueue?.regions;
  return Array.isArray(list) && list.length ? list.map(String) : ['IN'];
}

/** May this region's listings be drafted for LinkedIn at all? */
export function postableRegion(cfg, region) {
  return postRegions(cfg).includes(String(region ?? 'IN'));
}

/**
 * Keep only the rows that may be posted.
 *
 * A row with no region is kept: everything predating regions is Indian, and
 * dropping it would silently empty the queue for older postings.
 */
export function postableJobs(cfg, jobs = []) {
  const allowed = new Set(postRegions(cfg));
  return jobs.filter((j) => allowed.has(String(j?.region ?? j?.__reportRegion ?? 'IN')));
}
