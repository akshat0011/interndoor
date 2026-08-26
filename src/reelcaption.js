/**
 * The Instagram caption for a job reel.
 *
 * NO MODEL, deliberately — the same call the Sunday roundup makes. Every line
 * worth writing here is a stored fact: who is hiring, for what, where, what it
 * pays, how many have applied, and the link. There is nothing for a model to
 * add that would not be an invented adjective, and skipping it means a reel
 * never waits on Ollama at the moment somebody has just pressed publish.
 *
 * It also removes the whole grounding problem. `groundPost` exists because a
 * model asked to write about a posting will name a stipend the posting never
 * stated, and an invented "₹45 LPA" sends a student to an application they are
 * not eligible for. A caption assembled from the row cannot do that.
 */

const SITE = 'https://interndoor.com';

/** Instagram's own cap. Captions are truncated at a word boundary well before. */
export const CAPTION_MAX = 2200;

/**
 * Tags, most specific first.
 *
 * The company and the city are the ones that can actually surface this to
 * somebody searching; the broad ones are there because Instagram needs volume
 * to place a post at all. Capped at 12 — past that it reads as spam, and
 * Instagram has said the tail adds nothing.
 */
const BROAD = ['internship', 'internships', 'hiring', 'jobs', 'freshers',
  'engineeringjobs', 'techjobs', 'interndoor'];

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function hashtags(job, { max = 12 } = {}) {
  const out = [];
  const push = (t) => {
    const v = slug(t);
    // Two characters is not a tag, and a duplicate wastes one of the twelve.
    if (v.length > 2 && !out.includes(v)) out.push(v);
  };
  push(job.company);
  push(cityOf(job.location));
  for (const s of (job.keySkills ?? job.skills ?? []).slice(0, 3)) push(s);
  for (const t of BROAD) push(t);
  return out.slice(0, max);
}

/** The city, not the state and not the country — the same rule the cards use. */
export function cityOf(location) {
  const first = String(location ?? '').split(/[,;]/)[0].trim();
  return first;
}

/** Trim at a word boundary rather than mid-word. */
function clamp(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-–—]+$/, '');
}

/**
 * The facts line.
 *
 * Only what the row actually holds. A blank stipend is left out rather than
 * written as "unpaid" or "not disclosed" — the posting did not say, and
 * guessing either way is a claim about somebody's employer.
 */
function facts(job) {
  const out = [];
  const city = cityOf(job.location);
  if (city) out.push(`📍 ${city}`);
  if (job.mode) out.push(`💼 ${job.mode}`);
  if (job.stipendText) out.push(`💰 ${job.stipendText}`);
  if (job.duration) out.push(`⏳ ${job.duration}`);
  return out;
}

/**
 * Applicant count, stated as of NOW and never as a live number.
 *
 * `applicants` is frozen at scrape time — it is what LinkedIn showed when the
 * scraper opened the posting, and it does not age. The same rule `posted_text`
 * has: anything that reads as current when it is not will be wrong within the
 * hour, and on a board whose promise is BE EARLY that is the worst field to
 * get wrong.
 */
function urgency(job) {
  const n = applicantCount(job.applicantsText ?? job.applicants);
  if (n === null) return null;
  if (n === 0) return 'No applicants yet when this was listed.';
  if (n <= 10) return `Only ${n} applicant${n === 1 ? '' : 's'} when this was listed.`;
  return `${n} applicants when this was listed.`;
}

/**
 * The applicants column is TEXT, and comparing it as a number is a documented
 * way to get a confident wrong answer: it holds "47 people clicked apply",
 * "0 applicants" and "Over 100 applicants", and `CAST('Over 100...' AS INTEGER)`
 * is 0. Parse before comparing, and treat "over N" as more than N.
 */
export function applicantCount(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^over\s+\d+/i.test(s)) return Number(s.match(/\d+/)[0]) + 1;
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * Build the caption.
 *
 * The link is the job page when one exists — a row outside a published region,
 * or one classed non-tech, has no page written for it, so the caption points at
 * the board instead. An "apply here" that 404s is worse than a generic link.
 */
export function reelCaption(job, { url = null, max = CAPTION_MAX } = {}) {
  const company = String(job.company ?? '').trim();
  const title = String(job.title ?? '').trim();
  const link = url || SITE;

  const head = company && title ? `${company} is hiring: ${title}` : (title || company || 'New internship');
  const lines = [clamp(head, 150)];

  const f = facts(job);
  if (f.length) lines.push(f.join('  ·  '));

  const u = urgency(job);
  if (u) lines.push(u);

  // One link, and it is ours. Instagram does not make caption links clickable,
  // so this is read and typed — which is the whole reason it has to be short
  // and has to be the real domain rather than a shortener.
  lines.push(`Apply → ${link}`);
  lines.push('More engineering internships, listed within minutes → interndoor.com');

  const tags = hashtags(job).map((t) => `#${t}`).join(' ');
  const body = lines.join('\n\n');
  return clamp(`${body}\n\n${tags}`, max);
}
