/**
 * Vocabulary learned from Gemini.
 *
 * When a title is too generic to judge — "Graduate Trainee", "Apprentice",
 * "Intern" — Gemini reads the description and decides. It also names the single
 * term its decision hinged on, and that term is stored here. Next time a title
 * contains it, the offline classifier answers instantly and no API call happens.
 * So the run gets cheaper and faster the longer it operates.
 *
 * Every learned term is checked before being accepted:
 *   - it must actually appear in the title or description it came from, so the
 *     model cannot invent vocabulary out of nothing
 *   - it must not contradict a built-in term, because a hand-written rule that
 *     has tests behind it outranks a model's guess
 *   - it must be a sane length, to keep single letters and whole sentences out
 *
 * The file lives in the state directory rather than the repo: it is derived
 * data, it changes most runs, and it should never produce git noise or a push
 * conflict. `node bin/show-report.js --learned` prints it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, ensureDirs } from './paths.js';
import { log } from './logger.js';

const FILE = join(PATHS.state, 'learned-roles.json');
const MIN_LEN = 3;
const MAX_LEN = 40;

/**
 * Words that say WHEN a posting runs or WHO it is aimed at, never what the work
 * is. They are the other half of the blockedTerms rule below: `internship` is a
 * term the search is built from, and `summer` is a season, so "summer
 * internship" carries no evidence about the role at all — and it was learned as
 * NON-TECH, which vetoed Barclays' Technology Developer, Cyber and Security,
 * and Data and Analytics summer internships.
 */
const FILLER = new Set([
  'summer', 'winter', 'spring', 'fall', 'autumn',
  'program', 'programme', 'graduate', 'campus', 'student', 'new', 'grad',
  'early', 'career', 'university', 'college', 'placement', 'batch', 'hiring',
  'off', 'cycle', 'year', 'i', 'ii',
]);

/** Whole words, keeping the characters that carry meaning in a tech term. */
function wordsOf(term) {
  return term.split(/[^a-z0-9+#.&]+/).filter(Boolean);
}

export function loadLearned() {
  if (!existsSync(FILE)) return { version: 1, terms: {} };
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return parsed?.terms ? parsed : { version: 1, terms: {} };
  } catch {
    log.warn('learned-roles.json is unreadable — starting a fresh vocabulary.');
    return { version: 1, terms: {} };
  }
}

function save(store) {
  ensureDirs();
  writeFileSync(FILE, `${JSON.stringify(store, null, 1)}\n`);
}

/** Learned terms, split into the shape classifyRole expects. */
export function learnedVocabulary(store = loadLearned()) {
  const positive = [];
  const negative = [];
  for (const [term, meta] of Object.entries(store.terms)) {
    (meta.isTech ? positive : negative).push(term);
  }
  return { positive, negative };
}

/**
 * Record what Gemini taught us.
 *
 * @param {object} store          from loadLearned()
 * @param {object} lesson         { term, isTech, title, description, company }
 * @param {Set<string>} builtIns  lowercase built-in terms, with their polarity,
 *                                as "term|tech" / "term|other"
 * @returns {'added'|'reinforced'|'rejected'} and why, for logging
 */
/**
 * Why this term is unusable vocabulary, or null if it is fine.
 *
 * Exported because a PURGE of the stored vocabulary has to ask exactly the
 * question `learn` asks — a second copy of these rules in a maintenance script
 * is a copy that drifts, and the whole reason this guard exists is that a rule
 * which was nearly right ran unnoticed for days.
 */
export function unusableShape(term, isTech, builtInPolarity, blockedTerms = []) {
  const blockedWords = new Set(blockedTerms.flatMap((t) => wordsOf(String(t).toLowerCase())));
  // A bare year is noise for the same reason a season is — "2027 Analyst" and
  // "Summer 2027 Internship" say nothing the term does not already say.
  const signal = wordsOf(term)
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !FILLER.has(w) && !blockedWords.has(w));

  if (!signal.length) return 'only seasons, cohorts and terms the search is built from';

  if (!isTech) {
    const techWords = new Set();
    for (const [builtIn, builtInIsTech] of builtInPolarity) {
      if (builtInIsTech) for (const w of wordsOf(builtIn)) techWords.add(w);
    }
    if (signal.every((w) => techWords.has(w))) {
      return 'a negative built only from words the built-in vocabulary calls tech';
    }
  }

  return null;
}

export function learn(store, lesson, builtInPolarity, blockedTerms = []) {
  const term = String(lesson.term ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (term.length < MIN_LEN || term.length > MAX_LEN) return { result: 'rejected', why: 'implausible length' };
  if (!/[a-z]/.test(term)) return { result: 'rejected', why: 'no letters' };

  // A term the search is BUILT FROM says nothing about what a role is: every
  // card LinkedIn returns matches one of them by construction. The model
  // proposes them anyway, and the damage is one-sided — once "intern" was
  // stored as non-tech it fired on ~100% of titles, and because only
  // multi-word positives outrank a negative (roles.js), single-word tech
  // signals could not save them. "Flutter Developer Intern" and "DevOps Intern
  // (AWS & GitOps)" were both refused before they were ever opened; 34
  // watchlist matches went that way on 12 Aug alone, and the count had been
  // climbing for a week as more of these terms were learned.
  //
  // Sourced from config.matching.titleMustMatch by the caller so this list and
  // the query cannot drift apart.
  if (blockedTerms.includes(term)) {
    return { result: 'rejected', why: 'a term the search is built from, so every posting contains it' };
  }

  /* THE TERM MUST DESCRIBE THE WORK, and two shapes never do. Both were found
     on 10 Sep 2026 after a HARMAN Android internship was demoted by a term
     learned from a HOTEL posting, and both are generalisations of guards that
     were already here and too narrow.

     `blockedTerms` above rejects a term that EQUALS a search term. It does not
     reach "summer internship", "college intern" or "graduate apprentice
     trainee", which are the same thing with a season or a cohort bolted on. A
     term made only of those words matches almost every posting the search
     returns, so whatever polarity it carries is applied to nearly everything.

     The second is worse and only applies to a NEGATIVE. Gemini named
     "development" off Hilton's "2027 Corporate Summer Internship -
     Development" — a hotel real-estate role — and from then on "Android app
     development" and "Software development" were both refused. A negative
     whose only real words are ones the BUILT-IN vocabulary calls tech
     contradicts a hand-written rule with tests behind it just as squarely as
     an exact collision does; the check below is the word-level version of the
     `builtInPolarity.get(term)` test a few lines down.

     It is deliberately asymmetric. A POSITIVE built from tech words is
     harmless — it agrees with the built-ins — so only the negative side is
     gated, exactly like `titleOnlyNonTechTerms` in roles.js.

     What must SURVIVE is the domain qualifier: "civil engineering intern",
     "geotechnical engineering intern", "field engineer" and "energy
     engineering intern" all keep a word the built-ins do not call tech, and
     all still bite. Measured over the live vocabulary: 49 of 1,075 negatives
     rejected, and every domain negative kept. */
  const shapeProblem = unusableShape(term, lesson.isTech, builtInPolarity, blockedTerms);
  if (shapeProblem) return { result: 'rejected', why: shapeProblem };

  // The term has to come from the text it supposedly explains.
  const haystack = `${lesson.title ?? ''} ${lesson.description ?? ''}`.toLowerCase();
  if (!haystack.includes(term)) return { result: 'rejected', why: 'not present in the posting' };

  // A built-in rule with tests behind it beats a model suggestion.
  const opposite = builtInPolarity.get(term);
  if (opposite !== undefined && opposite !== lesson.isTech) {
    return { result: 'rejected', why: `contradicts the built-in vocabulary` };
  }

  const existing = store.terms[term];
  if (existing) {
    if (existing.isTech !== lesson.isTech) {
      // Gemini has changed its mind about this term. Drop it rather than
      // letting the vocabulary flip-flop between runs.
      delete store.terms[term];
      save(store);
      return { result: 'rejected', why: 'conflicts with what was learned before; removed' };
    }
    existing.n = (existing.n ?? 1) + 1;
    existing.lastSeenAt = Date.now();
    save(store);
    return { result: 'reinforced', why: `seen ${existing.n}x` };
  }

  store.terms[term] = {
    isTech: !!lesson.isTech,
    n: 1,
    learnedAt: Date.now(),
    lastSeenAt: Date.now(),
    from: `${lesson.company ?? '?'} — ${String(lesson.title ?? '').slice(0, 70)}`,
  };
  save(store);
  return { result: 'added', why: 'new term' };
}

export function learnedPath() {
  return FILE;
}
