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

import { stipendText, durationText, modeText } from './pages.js';

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
const BROAD = ['internship', 'internships', 'hiring', 'jobs',
  'engineeringjobs', 'techjobs', 'interndoor'];

/**
 * The terms that actually name a market, split by board.
 *
 * These were SHARED between the two accounts, and `freshers` was in the shared
 * list. "Fresher" is an almost exclusively Indian and South-Asian word for an
 * entry-level candidate and is essentially unused in American job search — so
 * every @interndoorusa reel shipped telling Instagram's recommender it was for
 * an Indian audience. Measured on that account's own insights: **90.5% India,
 * 0.9% United States**, on a reel about a US internship.
 *
 * Only market-naming terms are split. The generic half above stays shared
 * because it is genuinely generic, and duplicating it would just spend the cap.
 *
 * Region comes off the published job and defaults to IN — the board that
 * existed first, and the safer wrong answer: an Indian reel reaching Indians is
 * at worst a no-op, while the reverse is the thing being fixed here.
 *
 * These are ONE signal among several and not the dominant one. Instagram offers
 * no organic country targeting at all; for an account with no followers the
 * recommender leans on the account's own locale and on who engages first.
 */
const BY_REGION = {
  IN: ['freshers', 'offcampus', 'campushiring'],
  US: ['summerinternship', 'techinternships', 'careers', 'stemjobs'],
  GB: ['graduatejobs', 'placementyear', 'ukjobs'],
};

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function hashtags(job, { max = 12 } = {}) {
  const out = [];
  const push = (t) => {
    const v = slug(t);
    // Two characters is not a tag, and a duplicate wastes one of the twelve.
    if (v.length > 2 && !out.includes(v)) out.push(v);
  };
  push(job.company);
  /* Cut an office code off the city: Samsara files "London - UK2", which slugs
     to #londonuk2 — a tag that names nothing, helps no one find the post, and
     spends one of the twelve. cityOf itself is left alone; the full string is
     still what the card and the caption print. */
  push(cityOf(job.location).split(/\s+[-–—]\s+/)[0]);
  for (const s of (job.keySkills ?? job.skills ?? []).slice(0, 3)) push(s);
  /* Before BROAD, so the market-naming tags survive the twelve-tag cap rather
     than being crowded out by the generic ones. */
  const region = job.region ?? job.__region ?? 'IN';
  for (const t of (BY_REGION[region] ?? BY_REGION.IN)) push(t);
  for (const t of BROAD) push(t);
  return out.slice(0, max);
}

/** The city, not the state and not the country — the same rule the cards use. */
export function cityOf(location) {
  const first = String(location ?? '').split(/[,;]/)[0].trim();
  return first;
}

/** "₹0", "₹ 0", "0", "0.00" — a figure that says the pay is nothing. */
const zeroish = (v) => /^[^\d]*0+(?:[.,]0+)?\s*$/.test(String(v ?? '').trim()) && /\d/.test(String(v ?? ''));

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
 * READ THROUGH THE SITE'S OWN DISPLAY FILTERS, not off the row. `stipend` and
 * `duration` are dirty in the store: `duration` holds "0 to 1 years" and
 * "0-11 months", which are EXPERIENCE requirements that landed in the duration
 * slot, and `stipend` holds "₹0" and the stray "2,026" from a copyright line.
 * pages.js already refuses to print those, so the first published reel said
 * "⏳ 0 to 1 years" while the job page it linked to said nothing of the kind.
 *
 * Importing the same functions is the point. Re-implementing the rules here
 * would drift on the first fix to either, and this caption's whole claim is
 * that it cannot state something the job page does not.
 *
 * A blank stipend is left out rather than written as "unpaid" or "not
 * disclosed" — the posting did not say, and guessing either way is a claim
 * about somebody's employer.
 */
function facts(job) {
  const out = [];
  const city = cityOf(job.location);
  const mode = modeText(job);
  // A ZERO STIPEND IS NOT A STIPEND. `stipendText` lets "₹0" through because it
  // only asks for a currency or a period, and ₹0 has a currency — so the site
  // prints it on 37 of 274 India cards. On a job page a "₹0" pill reads as a
  // data quirk; in a caption it reads as a claim about what the employer pays,
  // next to an "Apply →" link. Left out here, and the site's own behaviour is
  // deliberately NOT changed from inside a caption module.
  const money = zeroish(stipendText(job)) ? '' : stipendText(job);
  const howLong = durationText(job);
  if (city) out.push(`📍 ${city}`);
  if (mode) out.push(`💼 ${mode}`);
  if (money) out.push(`💰 ${money}`);
  if (howLong) out.push(`⏳ ${howLong}`);
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
export function reelCaption(job, { url = null, max = CAPTION_MAX, format = 'A' } = {}) {
  const company = String(job.company ?? '').trim();
  const title = String(job.title ?? '').trim();
  const link = url || SITE;

  const head = company && title ? `${company} is hiring: ${title}` : (title || company || 'New internship');
  const u = urgency(job);

  /* FORMAT D LEADS ON THE EMPTY QUEUE, because that is what the reel above the
     caption is about and a caption that opens on a different fact reads as a
     caption for a different post. The employer still comes second, which
     mirrors the reel's own reveal.

     The wording is `urgency()` unchanged, not a second phrasing: it already
     dates the claim ("when this was listed") because `applicants` is frozen at
     scrape time, and two copies of that sentence would drift the first time
     either was fixed. It is not repeated lower down — see below. */
  const dLead = format === 'D' && u;
  const lines = dLead ? [u, clamp(head, 150)] : [clamp(head, 150)];

  const f = facts(job);
  if (f.length) lines.push(f.join('  ·  '));

  if (u && !dLead) lines.push(u);

  // One link, and it is ours. Instagram does not make caption links clickable,
  // so this is read and typed — which is the whole reason it has to be short
  // and has to be the real domain rather than a shortener.
  lines.push(`Apply → ${link}`);
  lines.push('More engineering internships, listed within minutes → interndoor.com');

  const tags = hashtags(job).map((t) => `#${t}`).join(' ');
  const body = lines.join('\n\n');
  return clamp(`${body}\n\n${tags}`, max);
}
