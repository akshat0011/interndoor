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
  // INDIA WRITES ITS FRESHER ROLES DIFFERENTLY, and none of the phrases above
  // appear on them (18 Sep 2026: US 151 and UK 48 full-time rows live, India
  // 0). What an Indian employer puts on the tin instead:
  'fresher', 'freshers',
  'associate software engineer', 'associate software developer', 'associate engineer', 'associate developer',
  'junior software engineer', 'junior software developer', 'junior developer', 'junior engineer', 'junior data',
  // Level-1 titles. `\bi\b` after the word cannot match "II" or "III" (no
  // boundary between the letters), and `\b1\b` cannot match "10".
  'software engineer i', 'software engineer 1', 'software developer i', 'software developer 1',
  'sde 1', 'sde i', 'sde1',
];

/**
 * Two more Indian shapes that are not phrases: a graduating BATCH YEAR
 * ("Software Engineer - 2026 Batch", "2025 passouts") and an EXPERIENCE RANGE
 * that starts at zero ("Java Developer (0-2 years)"). A range starting at 1 or
 * more is not a fresher role and does not match.
 */
const BATCH_RE = /\b(?:20[2-3]\d[-\s]*(?:batch|pass[-\s]?outs?|graduates?)|batch[-\s]*(?:of[-\s]*)?20[2-3]\d)\b/i;
const ZERO_EXP_RE = /\b0\s*(?:-|–|to)\s*[12]\s*\+?\s*(?:years?|yrs?)\b/i;

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
  if (BATCH_RE.test(t) || ZERO_EXP_RE.test(t)) return FULL_TIME;
  // A title that OPENS with "Graduate" is a graduate role — "Graduate
  // Quantitative Trader", "Graduate Software Engineer". Anchored to the start
  // deliberately: a bare `graduate` anywhere would also match
  // "Engineer (graduate degree preferred)", which is a requirement, not a role.
  return /^\s*graduate\b/i.test(t) ? FULL_TIME : null;
}

/** Seniority words that disqualify a title outright — exported for the
 *  entry-level search, which has no intern word to lean on. */
export function isSeniorTitle(title) {
  return SENIOR.test(String(title ?? ''));
}

/**
 * The minimum years of experience a posting DEMANDS, read off its prose, or
 * null when it states none. "3+ years", "2-4 years of experience", "minimum
 * of 2 years", "at least 3 yrs". A range reads as its floor. A bare "years"
 * with no number, or a number that is not about experience ("2 years of
 * runway"), is left alone — this is a refusal gate, and a wrong refusal costs a
 * student a role.
 */
export function experienceFloor(text) {
  const t = String(text ?? '');
  if (!t) return null;
  const floors = [];
  const push = (n) => { const v = Number(n); if (Number.isFinite(v) && v >= 0 && v <= 30) floors.push(v); };
  // "3+ years", "3 + yrs"
  for (const m of t.matchAll(/\b(\d{1,2})\s*\+\s*(?:years?|yrs?)\b/gi)) push(m[1]);
  // "2-4 years", "2 to 4 years", "2–4 yrs"
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*(?:years?|yrs?)\b/gi)) push(m[1]);
  // "minimum (of) 2 years", "at least 3 years", "min. 2 yrs"
  for (const m of t.matchAll(/\b(?:minimum(?:\s+of)?|min\.?|at\s+least)\s+(\d{1,2})\s*(?:years?|yrs?)\b/gi)) push(m[1]);
  // "3 years of (relevant/professional/industry/hands-on/…) experience"
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?:years?|yrs?)\s+(?:of\s+)?(?:\w+[-\s]+){0,3}?experience\b/gi)) push(m[1]);
  return floors.length ? Math.min(...floors) : null;
}

/** Below this many demanded years a role is still a fresher role. */
export const ENTRY_MAX_YEARS = 2;

/**
 * THE GATE FOR A CARD FOUND BY THE ENTRY-LEVEL SEARCH, which has no intern
 * word to admit it on. LinkedIn's facet already said "Entry level", so the
 * question is only whether anything DISAGREES:
 *
 *   - an intern word in the title, or LinkedIn's Internship chip, makes it an
 *     internship — the entry search finding one is fine, and it is filed as one;
 *   - a senior title is refused whatever the facet says (recruiters mark
 *     "Senior Engineer" entry-level often enough to matter);
 *   - LinkedIn's employment chip must say Full-time — Contract, Part-time and
 *     Temporary are not the role a fresher is looking for; a missing chip is
 *     refused for the same reason the intern path refuses it: the card got in
 *     on the promise the pane would settle it;
 *   - LinkedIn's seniority chip, when it is there, must say Entry level;
 *   - the prose must not demand ENTRY_MAX_YEARS or more.
 *
 * Returns { kind, reason }: kind 'intern' | 'fulltime' | null, reason set when
 * refused, in the vocabulary seen_cards uses.
 */
export function admitEntryLevel({ title, employmentTag, seniorityTag, description, isIntern }) {
  const t = String(title ?? '');
  if ((typeof isIntern === 'function' && isIntern(t)) || isInternshipTag(employmentTag)) return { kind: INTERN, reason: null };
  if (isSeniorTitle(t)) return { kind: null, reason: 'entry-level: senior title' };
  if (!/^full[-\s]?time$/i.test(String(employmentTag ?? '').trim())) {
    return { kind: null, reason: `entry-level: LinkedIn tags it ${employmentTag ?? 'nothing'}` };
  }
  if (seniorityTag && !/^entry[-\s]?level$/i.test(String(seniorityTag).trim())) {
    return { kind: null, reason: `entry-level: LinkedIn says ${seniorityTag}` };
  }
  const floor = experienceFloor(description);
  if (floor != null && floor >= ENTRY_MAX_YEARS) return { kind: null, reason: `entry-level: asks ${floor}+ years` };
  return { kind: FULL_TIME, reason: null };
}

/** schema.org employmentType, which Google reads. Never guess this one. */
export function schemaEmploymentType(kind) {
  return kind === FULL_TIME ? 'FULL_TIME' : 'INTERN';
}

/**
 * A full-time role's prose, with the internship words it was wrongly written in
 * replaced.
 *
 * The enricher's prompt described every posting as "this specific internship",
 * so 132 of the 176 stored full-time summaries opened "This internship involves"
 * — on a Jump Trading "Campus Quantitative Trader (Full-Time)" page, which the
 * board itself files under Full-time. The prompt is fixed for new rows; this
 * corrects the stored ones at publish, where every page reads them.
 *
 * WHOLE WORDS ONLY. "internal", "internet" and "international" are real words in
 * these descriptions, and a substring rule would print "new hireal systems".
 * The article is fixed with the noun — "an internship" is "a role", not "an role".
 */
export function fullTimeWording(text) {
  if (!text) return text;
  const cap = (orig, word) => (/^[A-Z]/.test(orig) ? word[0].toUpperCase() + word.slice(1) : word);
  return String(text)
    .replace(/\b(an?)\s+(internship|intern)\b/gi, (m, a, noun) =>
      `${a[0] === 'A' ? 'A' : 'a'} ${noun.toLowerCase() === 'internship' ? 'role' : 'new hire'}`)
    .replace(/\binternships\b/gi, (m) => cap(m, 'roles'))
    .replace(/\binternship\b/gi, (m) => cap(m, 'role'))
    .replace(/\binterns\b/gi, (m) => cap(m, 'new hires'))
    .replace(/\bintern\b/gi, (m) => cap(m, 'new hire'));
}
