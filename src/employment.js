/**
 * Internship, or a full-time role aimed at the same people?
 *
 * The site was internships only, because in India that is what the market
 * calls them: the LinkedIn search is built from `intern OR internship OR
 * trainee OR co-op OR apprentice` and nearly every relevant posting uses one of
 * those words.
 *
 * US campus hiring does not. A census of the ATS boards on 23 Aug found 139
 * US/UK postings that a student would obviously want and that the title filter
 * refused outright, because the industry writes them as:
 *
 *   Anduril      2026 Early Career Software Engineer      (15 of these)
 *   Databricks   Associate Product Manager, New Grad (2027 Start)
 *   Deliveroo    Software Engineer, New Grad
 *   Jump Trading Campus AI Research Engineer - Deep Learning (Full-Time)
 *   Flow Traders Graduate Quantitative Trader
 *
 * These are NOT internships — most say full-time on the tin — so filing them as
 * one would be a lie to the reader and wrong in the JobPosting markup, where
 * employmentType is a real field Google reads. They are collected and labelled,
 * and the board lets people switch between the two.
 *
 * The words are the same in every region on purpose. India produces few of
 * these because its LinkedIn search never asks for them, so region-scoping the
 * vocabulary would be configuration nobody benefits from.
 */

export const INTERN = 'intern';
export const FULL_TIME = 'fulltime';

/** Phrases that name an early-career FULL-TIME role rather than an internship. */
const EARLY_CAREER = [
  'new grad', 'new graduate', 'newgrad', 'recent graduate', 'recent grad',
  'early career', 'early careers', 'early talent',
  'campus hire', 'campus hiring', 'campus',
  'graduate program', 'graduate programme', 'graduate scheme',
  'graduate engineer', 'graduate developer', 'graduate analyst', 'graduate software',
  'university graduate', 'university hire', 'entry level', 'entry-level',
  'rotational program', 'rotational programme', 'analyst program', 'analyst programme',
];

/**
 * Seniority words that disqualify a title however early-career it reads.
 *
 * "Campus Recruiter", "Senior University Recruiter" and "Senior Student Program
 * Manager" all match an early-career phrase and are all senior full-time jobs
 * ABOUT students rather than for them. The role classifier catches most of them
 * as non-technical, but not all — Jane Street posts "Campus Recruiter,
 * Technology", and the word technology is enough to read as tech.
 */
// NOT `manager` on its own: "Associate Product Manager, New Grad" is a graduate
// role, and product management is an ordinary destination for one. The words
// here are people-leadership and recruiting, which is what actually
// disqualifies a title.
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|head\s+of|director|vp|vice\s+president|recruiter|recruiting|talent\s+acquisition)\b/i;

// A space in a phrase matches a space OR a hyphen, because the same role is
// written "new grad", "new-grad" and "newgrad" on different boards.
const phrase = (p) => new RegExp(`\\b${p.replace(/[-\s]+/g, '[-\\s]*')}\\b`, 'i');
const EARLY_RE = EARLY_CAREER.map(phrase);

/**
 * Which kind of role is this, if either?
 *
 * @param {string} title
 * @param {(t: string) => boolean} isIntern  the existing intern-title test
 * @returns {'intern'|'fulltime'|null}  null = neither, do not collect
 */
/**
 * Does LinkedIn's OWN employment-type chip say this posting is an internship?
 *
 * The chip lives only in the detail pane, beside the workplace type, and it is
 * the deciding vote for a card whose TITLE never says "intern" — Joveo
 * advertises "Back End Developer" and "Software Engineer" and tags both
 * Internship. `filters.jobTypes` is deliberately empty (§7) because FILTERING
 * the search on this tag hides real internships that recruiters mis-tag as
 * full-time; reading it AFTER a click to admit a role the title alone would
 * have refused is the opposite operation and carries none of that risk — the
 * worst case is that a mis-tagged internship stays refused, which is exactly
 * what happens today.
 *
 * Exact match, not a substring: "Full-time" must never pass because it contains
 * no intern word, and a title-shaped string must never pass either.
 */
export function isInternshipTag(tag) {
  return /^intern(ship)?$/i.test(String(tag ?? '').trim());
}

export function employmentType(title, isIntern) {
  const t = String(title ?? '');
  // Intern wins outright. "Summer 2027 Intern - New Grad Program" is an
  // internship that mentions a graduate scheme, not the other way round.
  if (isIntern(t)) return INTERN;
  if (SENIOR.test(t)) return null;
  if (EARLY_RE.some((re) => re.test(t))) return FULL_TIME;
  // A title that OPENS with "Graduate" is a graduate role — "Graduate
  // Quantitative Trader", "Graduate Software Engineer". Anchored to the start
  // deliberately: a bare `graduate` anywhere would also match
  // "Engineer (graduate degree preferred)", which is a requirement, not a role.
  return /^\s*graduate\b/i.test(t) ? FULL_TIME : null;
}

/** schema.org employmentType, which Google reads. Never guess this one. */
export function schemaEmploymentType(kind) {
  return kind === FULL_TIME ? 'FULL_TIME' : 'INTERN';
}
