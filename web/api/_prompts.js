/* The resume AI's prompts, schemas and models. SERVER ONLY.
 *
 * The underscore keeps this file from becoming a route on Vercel, and nothing
 * under web/public imports it, so no browser ever downloads it. /api/ai is
 * the only caller: it builds every prompt here from a resume and a role, so
 * the words sent to the model are written in ONE place and a browser can
 * never choose them.
 */
import { clampJob } from '../public/resumeai.js';

/* TWO MODELS, AND THE REASON WAS THE QUOTA, NOT THE TASTE.
 *
 * On Google's free tier the daily quota is PER MODEL
 * (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), so ranking and
 * tailoring on one model fought over one bucket. On a billed key the reason is
 * cost: measured on a real key over the same 25-role shortlist,
 *
 *   gemini-2.5-flash        16-25s   ~6,600 tokens   (thinks: 2,000-6,000)
 *   gemini-flash-lite-latest  12.0s    2,607 tokens   (no thinking)
 *
 * and the lite model discriminated at least as well — it scored a SAP supply
 * chain role 0 against a software internship at 85, which is exactly the
 * separation the AI rank exists to make.
 *
 * TAILORING STAYS ON THE STRONGER MODEL. It rewrites a real person's real
 * resume, the output goes to real employers, and the invention rule is the
 * thing that matters most — that is not where to save 4,000 tokens.
 *
 * `gemini-2.5-flash-lite` is NOT a candidate: Google answers
 * "no longer available to new projects" with a 404. */
export const RANK_MODEL = 'gemini-flash-lite-latest';
export const TAILOR_MODEL = 'gemini-2.5-flash';
/** Kept for callers and tests that just want "the model this talks to". */
export const MODEL = TAILOR_MODEL;

export const RANK_SYSTEM = `You score how well a candidate's resume fits engineering internship and entry-level postings.

For each posting return:
- fit: 0-100. How likely is this candidate to be a plausible applicant the employer would shortlist? Weigh the skills they actually have, the field they are in, and the level of the role.
- why: ONE short clause, at most twelve words, naming the concrete reason. Name a real skill or a real gap, never "good match" or "not a match".

Be honest and be spread out. A resume in a different field from the posting scores under 20. A strong overlap scores over 75. Do not cluster everything in the middle, and do not be generous to be kind — a wrong high score wastes the candidate's time.
Judge only what the resume evidences. Never assume a skill that is not written down.`;

export const RANK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    scores: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          fit: { type: 'INTEGER' },
          why: { type: 'STRING' },
        },
        required: ['i', 'fit', 'why'],
      },
    },
  },
  required: ['scores'],
};

/** One compact line per role. The index is what comes back, so the model never
 *  has to echo a title and a mis-typed one cannot bind a score to the wrong
 *  posting. */
export function buildRankPrompt(resumeText, jobs) {
  const roles = jobs.map((raw, i) => {
    const j = clampJob(raw);
    const bits = [
      `[${i}] ${j.title ?? 'Untitled'} at ${j.company ?? 'Unknown'}`,
      j.location ? `in ${j.location}` : null,
      j.skills?.length ? `— skills: ${j.skills.slice(0, 12).join(', ')}` : null,
      j.summary ? `— ${j.summary.slice(0, 220)}` : null,
    ].filter(Boolean);
    return bits.join(' ');
  }).join('\n');

  return `THE CANDIDATE'S RESUME
${resumeText}

THE POSTINGS
${roles}

Score every posting above. Return one entry per posting, using the [index] shown.`;
}

export const TAILOR_SYSTEM = `You rewrite a candidate's existing resume so it targets one specific job. You are working with a real person's real resume, which they will send to real employers.

ABSOLUTE RULE — invent nothing.
- Every skill, tool, employer, job title, date, degree, metric and achievement in your output must already be present in the resume you were given.
- You may reword, reorder, re-emphasise, merge, cut, and re-title sections. You may adopt the job's vocabulary WHERE THE RESUME ALREADY SUPPORTS THE CLAIM (e.g. if the resume says "built REST APIs in Flask" and the job asks for "backend services", describing it as backend service work is fine).
- You may NOT add a technology the resume never mentions, inflate a duration, invent a number, upgrade a title, or imply seniority the resume does not show. If the job wants Kubernetes and the resume has no Kubernetes, the resume still has no Kubernetes.
- Never write placeholders like "[add metric]" or "X%". Omit rather than fabricate.

How to tailor well:
- Lead with the experience closest to this job; push less relevant material down or cut it.
- Mirror the job's terminology for things the candidate genuinely did.
- Prefer concrete outcomes already stated in the resume over vague duties.
- Keep it to one page of content unless the source clearly warrants two.
- Keep the candidate's real contact details exactly as given.
- In "gaps", be honest about what the job asks for that the resume does not evidence. That is useful information, not a failure.`;

export const TAILOR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    contact: { type: 'STRING' },
    summary: { type: 'STRING' },
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          heading: { type: 'STRING' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING' },
                org: { type: 'STRING' },
                dates: { type: 'STRING' },
                bullets: { type: 'ARRAY', items: { type: 'STRING' } },
              },
              required: ['title', 'bullets'],
            },
          },
        },
        required: ['heading', 'items'],
      },
    },
    skills: { type: 'ARRAY', items: { type: 'STRING' } },
    changeNotes: { type: 'ARRAY', items: { type: 'STRING' } },
    gaps: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['name', 'summary', 'sections', 'skills', 'changeNotes', 'gaps'],
};

export function buildTailorPrompt(resumeText, rawJob) {
  const job = clampJob(rawJob);
  const facts = [
    `Role: ${job.title ?? 'Unknown'}`,
    `Company: ${job.company ?? 'Unknown'}`,
    job.location ? `Location: ${job.location}` : null,
    job.workplaceType ? `Work mode: ${job.workplaceType}` : null,
    job.stipend ? `Stipend: ${job.stipend}` : null,
    job.duration ? `Duration: ${job.duration}` : null,
    job.skills?.length ? `Listed skills: ${job.skills.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  return `THE JOB
${facts}

What the posting says:
${job.description || job.summary || '(no description captured — tailor against the role, company and listed skills above)'}

THE CANDIDATE'S CURRENT RESUME
${resumeText}

Rewrite this resume to target the job above. Remember: reorganise and rephrase what is there. Add nothing that is not.`;
}
