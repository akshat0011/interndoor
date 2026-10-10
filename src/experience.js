/**
 * How much experience a full-time role asks for — ONLY what the posting says.
 *
 * His ask, 10 Oct 2026: students want to filter the Full-time tab by the
 * experience a role needs, and most postings never state it. Measured on the
 * 1,077 live full-time roles that day: 14% stated years, 5% said freshers or
 * new grad in words, 76% said nothing at all. So the filter has an honest
 * third answer, "Not stated", and nothing here is ever guessed — a wrong
 * "0 years" sends a fresher to a role that wants two.
 *
 * Every role it is asked about reached the Full-time tab through LinkedIn's
 * Entry level filter or an entry-level title, and publish already holds back
 * any posting that states 2+ years (asksExperience). So "not stated" on this
 * board means "the employer marked it entry level and named no years".
 *
 * The evidence, strongest first; the first that answers wins:
 *   1. the grounded `experience` field (the facts reader: the model proposed a
 *      figure and the posting was found to state it);
 *   2. a statement in words: freshers welcome, no experience required, recent
 *      or new graduates, a graduation year, campus hiring; or a title that
 *      names a fresher role (Trainee, Apprentice, Graduate Trainee, Campus
 *      Hire, Fresher, New Grad).
 * Stated years outrank words: Copeland's careers boilerplate welcomes "recent
 * graduates" on a role that asks for 1–3 years.
 *
 * YEARS ARE NEVER READ OFF THE TEXT BY A REGEX ALONE. Tried and measured on
 * 10 Oct 2026: of 26 figures found that way on roles the facts reader had
 * left blank, most were wrong — decimals ("7.5 years" read as 5, "0 to 1.5
 * years" as 5) and figures that are not this role's ("over 40 years of
 * semiconductor experience", "3 years of work experience for every 1 year of
 * education"). The facts reader, where the model proposes a figure and code
 * checks the posting states it, is the only source of years.
 */
import { experienceMonths } from './pages.js';

/** 'fresher' (0 years, or freshers welcome), 'one' (1 year), 'more' (2+), or null when the posting does not say. */
const byYears = (years) => (years === 0 ? 'fresher' : years === 1 ? 'one' : 'more');

/* A "fresher" that is refused: "not for freshers", "freshers need not apply",
   "no freshers", "freshers are not eligible". Read from the words just before
   and just after the match. */
const NOT_BEFORE = /\b(?:no|not|non|except|excluding)\b[^.;:]{0,20}$/;
const NOT_AFTER = /^\s*(?:need|should|must|may|can|will)\s*not\b|^\s*(?:are|is)\s+not\b|^\s*(?:excluded|not eligible)\b/;

const FRESHER_WORD = /\bfreshers?\b/g;
const RECENT_GRADS = /\b(?:recent|fresh|new)(?:\s+college)?\s+grad(?:uate)?s?\b|\bnewly graduated\b/g;
/* "Prior full-time professional experience is not required" (General Mills).
   Only general words may stand before "experience": WorldQuant's "prior
   finance experience is not required" is about one field, not about having
   none. A figure right after it is a grade ladder (FedEx: "Associate: Prior
   experience not required Standard I: Two (2) years"), not this role. */
const NO_EXPERIENCE = /\bno\s+(?:(?:prior|previous|work|professional|full[- ]time|industry)\s+)*experience\s+(?:is\s+)?(?:required|needed|necessary)\b|\b(?:(?:prior|previous|work|professional|full[- ]time|industry)\s+)*experience\s+(?:is\s+)?not\s+(?:required|mandatory|necessary)\b/g;
const CAMPUS = /\bcampus\s+(?:hire|hiring|recruit(?:ment|ing)?|placement|drive)\b/g;
const FRESHER_TITLE = [
  [/\bfreshers?\b/i, 'Fresher role'],
  [/\bnew\s*grad/i, 'New grad role'],
  [/\bcampus\b/i, 'Campus hire'],
  [/\bgraduate\s+(?:engineer(?:ing)?\s+)?(?:trainee|apprentice)/i, 'Graduate trainee role'],
  [/\btrainee\b/i, 'Trainee role'],
  [/\bapprentice(?:ship)?\b/i, 'Apprenticeship'],
];

/** The first match of `re` in `text` that is not refused by its neighbours, or null. */
function welcomed(text, re) {
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (NOT_BEFORE.test(before) || NOT_AFTER.test(after)) continue;
    return m;
  }
  return null;
}

const GENERAL_WORD = /^(?:prior|previous|work|professional|full[- ]time|industry)$/;
/** The posting says no experience is needed at all — not in one field, and not as one rung of a grade ladder. */
function noExperienceRequired(text) {
  NO_EXPERIENCE.lastIndex = 0;
  for (const m of text.matchAll(NO_EXPERIENCE)) {
    const word = text.slice(Math.max(0, m.index - 30), m.index).match(/([a-z-]+)\W*$/)?.[1] ?? '';
    // "prior finance experience is not required": the word before belongs to a field.
    if (/^experience/.test(m[0]) && word && !GENERAL_WORD.test(word) && !/^(?:and|or|but|the|a|an|is|are|that|as|with|so)$/.test(word)) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (/^\D{0,40}\b(?:\d+|one|two|three|four|five)\s*(?:\(\d+\)\s*)?years?\b/.test(after)) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (NOT_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

/* Emerson's and Copeland's careers boilerplate — "whether you're an
   established professional looking for a career change, an undergraduate
   student exploring possibilities, or a recent graduate with an advanced
   degree" — is printed on every posting and says nothing about this one. */
const BOILERPLATE_BEFORE = /whether you|established professional|career change/;
function recentGraduatesWelcome(text) {
  RECENT_GRADS.lastIndex = 0;
  for (const m of text.matchAll(RECENT_GRADS)) {
    if (BOILERPLATE_BEFORE.test(text.slice(Math.max(0, m.index - 160), m.index))) continue;
    if (NOT_BEFORE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    return true;
  }
  return false;
}

/** A graduation year in the grounded field ("Graduating 2027", "2025/2026 graduates") recent enough to mean freshers. */
function recentGraduation(experience, now) {
  const text = String(experience ?? '').split('·').map((p) => p.trim())
    .find((p) => /\b20\d\d\b/.test(p) && !/\byears?\b/i.test(p));
  if (!text) return null;
  const thisYear = new Date(now).getUTCFullYear();
  const years = [...text.matchAll(/\b(20\d\d)\b/g)].map((m) => Number(m[1]));
  return years.some((y) => y >= thisYear - 1) ? text : null;
}

/**
 * { level, says } for one full-time role, or { level: null, says: null } when
 * the posting does not say. `says` is what the board shows as the evidence:
 * "0–1 years", "Freshers welcome", "Campus hire".
 */
export function experienceLevel(row, { now = Date.now() } = {}) {
  const stored = String(row?.experience ?? '');
  const months = experienceMonths(stored);
  if (months != null) {
    const years = stored.split('·').map((p) => p.trim()).find((p) => /\byears?\b/i.test(p));
    return { level: byYears(months / 12), says: years || stored };
  }
  const description = String(row?.description ?? '');

  const graduation = recentGraduation(stored, now);
  if (graduation) return { level: 'fresher', says: graduation };
  const text = description.toLowerCase().replace(/\s+/g, ' ');
  if (welcomed(text, FRESHER_WORD)) return { level: 'fresher', says: 'Freshers welcome' };
  if (noExperienceRequired(text)) return { level: 'fresher', says: 'No experience required' };
  if (recentGraduatesWelcome(text)) return { level: 'fresher', says: 'Recent graduates welcome' };
  if (welcomed(text, CAMPUS)) return { level: 'fresher', says: 'Campus hire' };
  const title = String(row?.title ?? '');
  for (const [re, says] of FRESHER_TITLE) if (re.test(title)) return { level: 'fresher', says };
  return { level: null, says: null };
}
