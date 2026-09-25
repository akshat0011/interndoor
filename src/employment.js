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
  // A level-II-or-above title is not an early-career role, whatever phrase it
  // also carries ("BTS Associate Software Engineer II", "Engineer 2 - Nashville
  // Campus") — bar a named graduate programme. LEVEL_TITLE, below.
  if (LEVEL_TITLE.test(t) && !NEW_GRAD_PROGRAM.test(t)) return null;
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

const MANAGER_TITLE = /\bmanager\b/i;

/* A LEVEL-2-OR-ABOVE TITLE IS NOT AN ENTRY-LEVEL JOB — his call, 25 Sep 2026
   ("remove the 2/3 titles"). The entry walk was opening "Platform Engineer
   III" and "Engineer III, Artificial Intelligence" and storing "Software
   Engineer II" rows whose prose named no years. Roman II–IV anywhere, or 2–4
   straight after a role noun ("SDE-2", "Developer 3", "Engineer 2"); level I
   and "SDE-1" pass. A year is never read as a level — "2027" has no word
   boundary after its 2. Checked over every full-time title stored: 36 caught,
   every one a level-2+ or 2+-years role. */
const LEVEL_TITLE = /\b(?:ii|iii|iv)\b|\b(?:engineer|engr|developer|dev|sde|swe|analyst|programmer|scientist|specialist|consultant|executive|architect|administrator|designer|technician|level|grade)\s*[-–]?\s*[2-4]\b/i;
/* American Express hires masters graduates into "Campus Graduate Masters
   Full-Time Engineer - 2027 Software Engineer II": a named graduate programme,
   which the level would otherwise refuse. */
const NEW_GRAD_PROGRAM = /\bcampus\s+(?:graduate|undergraduate)\b|\bnew[\s-]?grad\b/i;

/* "CONSULTANT" AND "ARCHITECT" ARE EXPERIENCED GRADES, AND EVERY ONE COST AN OPEN.
   His question, 25 Sep 2026, watching the scan: "why tf are u opening
   consultant and all". Measured over the entry-level search's history: 15
   Consultant titles opened and then refused for demanding 2-8+ years, and of
   the 12 that got in, 11 were Deloitte, YASH, Accenture, Infosys, Hitachi and
   NTT consultant grades whose prose simply omitted the years. Deloitte posts
   one role per city, so one "Ping Directory - Consultant" cost three opens in
   one run. Architect: 1 refused after opening, 4 admitted, all senior. The
   exception is a named graduate programme — PwC's "Oracle Technical
   Consultant Graduate Program", AECOM's "Graduate Technology Services
   Consultant". Entry-level search only: the careers-board path already needs
   an early-career phrase to call anything full-time. */
const EXPERIENCED_GRADE = /\b(?:consultant|architect)\b/i;
const GRADUATE_WORD = /\b(?:graduate|fresher|campus|new[\s-]?grad|trainee)\b/i;

/**
 * The part of the entry-level gate a TITLE alone can answer — asked before the
 * open (so it costs the account nothing) and again inside admitEntryLevel.
 * Returns the refusal, in seen_cards' vocabulary, or null.
 *
 * A MANAGER TITLE IS NOT A FRESHER'S JOB, whatever the facet says. Amgen's
 * "Manager, Agentic AI Business Solutions" reached India's Full-time tab on
 * 25 Sep 2026 tagged Entry level, and "Assistant Manager" / "Associate Manager"
 * are three-to-six-year grades in Indian IT. SENIOR leaves `manager` out on
 * purpose, because the careers-board path meets real graduate titles like
 * "Associate Product Manager, New Grad" and American Express's "Campus Graduate
 * Masters Full-Time Manager"; this search has no early-career phrase to lean
 * on, so here the word refuses — bar the one title that is a graduate role by
 * name.
 */
export function entryLevelTitleRefusal(title) {
  const t = String(title ?? '');
  if (isSeniorTitle(t)) return 'entry-level: senior title';
  if (MANAGER_TITLE.test(t) && !/\bassociate\s+product\s+manager\b/i.test(t)) return 'entry-level: manager title';
  if (LEVEL_TITLE.test(t) && !NEW_GRAD_PROGRAM.test(t)) return 'entry-level: level II+ title';
  if (EXPERIENCED_GRADE.test(t) && !GRADUATE_WORD.test(t)) return 'entry-level: consultant or architect title';
  return null;
}

/**
 * THE GATE FOR A CARD FOUND BY THE ENTRY-LEVEL SEARCH, which has no intern
 * word to admit it on. LinkedIn's facet already said "Entry level", so the
 * question is only whether anything DISAGREES:
 *
 *   - an intern word in the title, or LinkedIn's Internship chip, makes it an
 *     internship — the entry search finding one is fine, and it is filed as one;
 *   - a senior, manager or level-II+ title is refused whatever the facet says
 *     (recruiters mark "Senior Engineer" entry-level often enough to matter;
 *     entryLevelTitleRefusal);
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
  const byTitle = entryLevelTitleRefusal(t);
  if (byTitle) return { kind: null, reason: byTitle };
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

/* ---- the words the site uses for its two kinds ---------------------------
   The board has listed early-career full-time roles under a Full-time tab since
   23 Aug 2026 and India's fresher roles since 18 Sep, and until 19 Sep every
   surface that named the offer still said "internships" alone — the board
   title, the digest chrome, the GitHub list, the channel footers. A full-time
   role filed under "internships" is a false sentence, and the fix is one
   vocabulary every surface reads rather than a phrase retyped in forty places.

   THE WORD IS "ENTRY-LEVEL", ON EVERY BOARD — his call, 19 Sep 2026
   ("InternDoor — Internships & Entry-Level Jobs"). India's readers search for
   "fresher jobs" and America's for "new grad", but one phrase that every
   reader parses beats three that each read as foreign on the other boards,
   and it is LinkedIn's own name for the facet the search runs on. A region may
   still override it (`entryWord` on its entry in src/regions.js); none does. */

/** "entry-level" — the word for the kind, unless a board overrides it. */
export function entryWord(region) {
  return region?.entryWord ?? 'entry-level';
}

/** "Entry-level" — the same word opening a sentence. */
export function entryWordCap(region) {
  const w = entryWord(region);
  return w[0].toUpperCase() + w.slice(1);
}

/** "Entry-Level" — the same word inside a Title-Cased <title>. */
export function entryWordTitle(region) {
  return entryWord(region).replace(/(^|-)([a-z])/g, (m, sep, c) => `${sep}${c.toUpperCase()}`);
}

/**
 * How many of these rows are internships and how many full-time roles. Reads
 * both the store column (`employment_type`) and the published projection
 * (`employmentType`), because callers hold either; a row that names neither is
 * an internship, which is what every row was before the split.
 */
export function splitKinds(rows = []) {
  let fullTime = 0;
  for (const r of rows) if ((r?.employment_type ?? r?.employmentType) === FULL_TIME) fullTime += 1;
  return { interns: rows.length - fullTime, fullTime };
}

/**
 * The offer with no counts: "engineering internships and entry-level jobs" —
 * `noun` is "jobs" where a search engine is the reader and "roles" in prose;
 * `singular` gives "engineering internship and entry-level job" for "every … goes
 * live" sentences. `adjective` is dropped by passing ''.
 */
export function offerPhrase(region, { noun = 'jobs', singular = false, adjective = 'engineering', joiner = 'and' } = {}) {
  const adj = adjective ? `${adjective} ` : '';
  const n = singular ? noun.replace(/s$/, '') : noun;
  return `${adj}internship${singular ? '' : 's'} ${joiner} ${entryWord(region)} ${n}`;
}

/**
 * The offer WITH counts, each kind named only when it is there: "12 engineering
 * internships and 3 entry-level jobs", "12 engineering internships", "3
 * entry-level engineering jobs". An empty set says the noun alone, never "0
 * internships".
 */
export function countedOffer(rows, region, { noun = 'jobs', adjective = 'engineering', live = false } = {}) {
  const { interns, fullTime } = splitKinds(rows);
  const adj = adjective ? `${adjective} ` : '';
  const lv = live ? 'live ' : '';
  const fmt = (n) => n.toLocaleString('en-US');
  const interns_ = `${fmt(interns)} ${lv}${adj}internship${interns === 1 ? '' : 's'}`;
  const fresh = `${fmt(fullTime)} ${lv}${entryWord(region)} ${noun.replace(/s$/, '')}${fullTime === 1 ? '' : 's'}`;
  if (!interns && !fullTime) return `${lv}${adj}internships and ${entryWord(region)} ${noun}`.replace(/^./, (c) => c.toUpperCase());
  if (!fullTime) return interns_;
  if (!interns) return `${fmt(fullTime)} ${lv}${entryWord(region)} ${adj}${noun.replace(/s$/, '')}${fullTime === 1 ? '' : 's'}`;
  return `${interns_} and ${fresh}`;
}

/**
 * "12 new engineering internships and 3 entry-level engineering roles in India" —
 * the digest's subject, from counts rather than rows so the mail chrome can say
 * it about the whole eligible set while rendering only the cards that fit.
 */
export function newCountHeadline({ interns = 0, fullTime = 0 } = {}, where, word = 'entry-level') {
  const n = interns, ft = fullTime;
  const internsText = `${n} new engineering internship${n === 1 ? '' : 's'}`;
  const fresh = `${ft} ${word} engineering role${ft === 1 ? '' : 's'}`;
  if (!ft) return `${internsText} in ${where}`;
  if (!n) return `${ft} new ${word} engineering role${ft === 1 ? '' : 's'} in ${where}`;
  return `${internsText} and ${fresh} in ${where}`;
}
