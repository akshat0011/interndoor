/**
 * Which careers-board (ATS) postings the channels should announce.
 *
 * Telegram and WhatsApp are handed what a scan stored this run
 * (`store.jobsForRun`). bin/poll-ats.js runs before the scan as its own process
 * and tags rows `ats-<day>`, so no ATS posting was ever announced anywhere.
 * These rows are added to that set, after the same "does it have a page" filter.
 *
 * TWO RULES, BOTH MEASURED 13 SEP 2026 before writing them:
 *
 *   1. POSTED IN THE LAST THREE DAYS. A board seen for the first time hands over
 *      everything it has open, and those are not new. Every ATS row carries a
 *      posted date; on an ordinary day almost all are under three days old when
 *      first stored (US 11/11, 26/27, 32/32), while on 13 Sep, when 52 boards
 *      were seeded, 130 of 145 US rows were older. A channel is "be early"; a
 *      board's backlog in one burst is spam.
 *   2. NOT ALREADY ANNOUNCED AS ITS LINKEDIN COPY. The scan often finds a role
 *      first and the channel already carried it; the ATS twin then wins the dedupe
 *      at publish. 34 of 230 fresh ATS rows in 14 days were that shape. Matched on
 *      employer and title, which is looser than publish's key (it also compares
 *      the city): a missed announcement costs less than a duplicate one.
 */
export const ANNOUNCE_MAX_AGE_MS = 3 * 86_400_000;
export const TWIN_WINDOW_MS = 7 * 86_400_000;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (r) => `${norm(r.company_matched || r.company)}|${norm(r.title)}`;

export function atsToAnnounce(atsRows, scrapedRows, { now = Date.now(), maxAgeMs = ANNOUNCE_MAX_AGE_MS, twinWindowMs = TWIN_WINDOW_MS } = {}) {
  const scrapedAt = new Map();
  for (const r of scrapedRows ?? []) {
    const k = keyOf(r);
    if (!scrapedAt.has(k)) scrapedAt.set(k, []);
    scrapedAt.get(k).push(Number(r.first_seen_at ?? 0));
  }
  return (atsRows ?? []).filter((r) => {
    const posted = Number(r.posted_at ?? 0);
    if (!posted || now - posted > maxAgeMs) return false;
    const seen = Number(r.first_seen_at ?? 0);
    const twins = scrapedAt.get(keyOf(r)) ?? [];
    return !twins.some((t) => t < seen && seen - t <= twinWindowMs);
  });
}
