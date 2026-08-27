/**
 * Which reel format a posting can carry.
 *
 * FORMAT A — "company is hiring". Opens on the logo, because identity is the
 * fastest thing a scroller recognises. Any posting can be one.
 *
 * FORMAT D — "hidden opportunity". Opens on the applicant count and WITHHOLDS
 * the employer until the second scene, because the reveal is the format. A
 * reel that shows the logo first has nothing left to reveal, so Format D
 * forces the hook-first scene order even when a logo exists.
 *
 * WHY THE FRESHNESS GATE IS THE WHOLE CORRECTNESS OF THIS FORMAT
 * --------------------------------------------------------------
 * `applicants` is frozen at scrape time. It is what LinkedIn showed when the
 * scraper opened the posting, and NOTHING REFRESHES IT: only about 4% of
 * LinkedIn rows are ever re-seen a day later, because the search is
 * time-windowed and a card falls out of it in roughly ninety minutes. So
 * `lastSeenAt` sits within minutes of `firstSeenAt` on nearly every row.
 *
 * Measured on the live India board while this was written: of 58 postings
 * holding a count under ten, the oldest was read **432 hours — eighteen days —
 * ago**, and only 8 had been read inside a day. Making "nobody has applied!"
 * out of an eighteen-day-old reading is not a rounding error, it is a false
 * claim about a posting that has almost certainly filled its queue since.
 * That is the same failure `posted_text` caused on the live board: a number
 * that reads as current when it is not.
 *
 * Two rules follow, and they solve different halves:
 *
 * 1. **The gate.** A posting only qualifies while the count is fresh. A stale
 *    scarcity claim is not worth making even with a qualifier attached,
 *    because the entire point of the format is "act now" and a three-week-old
 *    posting does not support that sentence.
 * 2. **The tense.** Even inside the window the number can move, so the words
 *    say what was OBSERVED and never what is. src/reelscript.js and
 *    src/reelcaption.js both carry "when we found it" for this reason. The
 *    urgency is carried by the size of the number on screen and by the age
 *    stamp beside it, never by a tense that rots.
 */
import { applicantCount } from './reelcaption.js';

/** The formats a job row can be rendered as. */
export const FORMATS = ['A', 'D'];

export const FORMAT_D = {
  /**
   * The most applicants that is still "no queue".
   *
   * Ten, not zero. Zero alone is 21 rows a month on the India board and the
   * literal hook his brief asked for; 1-9 adds 37 more and is the same story
   * to a student deciding whether to bother. Above ten it stops being a
   * hidden opportunity and becomes an ordinary listing.
   */
  maxApplicants: 9,
  /** How old the READING may be. See the note above — this is not cosmetic. */
  maxCountAgeHours: 24,
};

/** Config overrides live under `reels.formatD`. */
export function formatDConfig(cfg = {}) {
  return { ...FORMAT_D, ...(cfg.reels?.formatD ?? {}) };
}

/**
 * How long ago we last read this posting, in hours.
 *
 * `lastSeenAt` is when the row was last looked at, and `saveJob`'s update path
 * refreshes `applicants` alongside it — so this is the age of the COUNT, not
 * the age of the posting. A row carrying neither timestamp cannot be dated and
 * is treated as infinitely old rather than as fresh.
 */
export function countAgeHours(job, now = Date.now()) {
  const seen = Number(job?.lastSeenAt ?? job?.firstSeenAt ?? 0);
  if (!seen) return Infinity;
  return (now - seen) / 3_600_000;
}

/**
 * Why this posting cannot be a Format D reel, or null if it can.
 *
 * Returns a SENTENCE rather than a boolean because the CLI has to explain
 * itself: "no India job qualifies" sends you looking for a bug, where "the
 * freshest zero-applicant row was read 12 hours ago" tells you the pool is
 * simply cold and will refill on the next scan.
 */
export function formatDRefusal(job, cfg = {}, now = Date.now()) {
  const c = formatDConfig(cfg);
  const raw = job?.applicants;
  const n = applicantCount(raw);

  /* Half the India board carries no count at all — 92 of 275 when this was
     written. Format D is a claim ABOUT the count, so a missing one is not a
     small gap to paper over, it is the absence of the whole subject. */
  if (n === null) return 'the posting carries no applicant count';

  /* "Over 100 applicants" parses to 101 here, and would CAST to 0 in SQL.
     That trap has already produced one confident wrong answer in this
     project; it must never reach a hook reading "nobody has applied". */
  if (n > c.maxApplicants) return `${n} applicants — not a short queue`;

  const age = countAgeHours(job, now);
  if (age > c.maxCountAgeHours) {
    const said = age === Infinity ? 'never dated' : `read ${Math.round(age)}h ago`;
    return `the count is stale (${said}, limit ${c.maxCountAgeHours}h)`;
  }
  return null;
}

export function qualifiesD(job, cfg = {}, now = Date.now()) {
  return formatDRefusal(job, cfg, now) === null;
}

/**
 * The format to render a posting as.
 *
 * `want` is 'auto' (default), or a letter to force. Forcing D on a posting
 * that does not qualify is refused rather than rendered, because every way of
 * rendering it anyway states something untrue: a missing count has no number
 * to show, and a stale one is the false claim this module exists to prevent.
 */
export function formatFor(job, { want = 'auto' } = {}, cfg = {}, now = Date.now()) {
  const w = String(want || 'auto').toUpperCase();
  if (w === 'A') return 'A';
  if (w === 'D') {
    const why = formatDRefusal(job, cfg, now);
    if (why) throw new Error(`this posting cannot be a Format D reel: ${why}`);
    return 'D';
  }
  if (w !== 'AUTO') throw new Error(`unknown format ${want} — expected ${FORMATS.join(', ')} or auto`);
  return qualifiesD(job, cfg, now) ? 'D' : 'A';
}

/**
 * Every posting that could be a Format D reel, best first.
 *
 * Ordered by the count ascending then by how recently it was read, so a zero
 * beats a nine and a fresh zero beats a day-old one — which is both the
 * strongest hook and the truest claim, and those happily agree here.
 *
 * DE-DUPLICATED ON `roleFingerprint`, the same key the board collapses cities
 * on. One role advertised in several cities is several rows with one
 * description: STEMpedia holds four zero-applicant copies of a single opening
 * on the live board right now, and rendering four identical reels off them
 * would be the multi-city repetition the feed already learned to collapse.
 * A row with no fingerprint stands alone under its own id rather than being
 * merged on a guess — the same fallback publish.js uses.
 */
export function formatDCandidates(jobs, cfg = {}, now = Date.now()) {
  const ok = (jobs ?? []).filter((j) => qualifiesD(j, cfg, now));
  ok.sort((a, b) =>
    (applicantCount(a.applicants) - applicantCount(b.applicants))
    || (countAgeHours(a, now) - countAgeHours(b, now)));

  const seen = new Set();
  const out = [];
  for (const j of ok) {
    const key = j.roleFingerprint || `id:${j.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}
