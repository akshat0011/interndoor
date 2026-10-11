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

export const TAILOR_SYSTEM = `You tailor a candidate's resume to one job so that it scores as high as possible in an applicant tracking system (ATS) and reads well to a recruiter. It is a real person's resume, which they will send to a real employer.

Return two resumes.

1. "original": the resume EXACTLY as given, parsed into the structure. Copy every line word for word. Do not fix, shorten, merge, reorder or drop anything. Give every item an id ("i1", "i2", ...) and every bullet an id ("i1.b1", "i1.b2", ...). Put every skill the resume lists into "skills", as individual skills, one per entry, in the groups the resume uses (for example group "Programming", items ["Python", "C++"]). Skills go in "skills", never in a section. The summary or objective goes in "summary", never in a section.

2. "tailored": the resume rewritten for this job.

NEVER REMOVE ANYTHING. Every item, bullet, skill, tool, project, job, school and claim in the original must still be in the tailored resume. You may:
- reorder sections, items, bullets and skills so what matters most for this job comes first;
- reword bullets in the job's own vocabulary, starting with a strong verb, keeping every number exactly as written;
- rewrite the summary for this role, naming the role and its key skills;
- regroup skills, with the ones this job asks for first.
Each tailored item gives the id of the original item it came from in "from". Each tailored bullet lists, in "from", the ids of the original bullets it came from.

YOU MAY ADD, and must list every addition in "added" with a short reason:
- skills and keywords this job asks for that fit what the candidate has actually done (someone who ran local language models can list "LLM inference");
- at most three new bullets that connect the candidate's real work to this job, with "from": [].
Never invent an employer, job title, project, school, date, degree, certification, award or number. Keep the name and contact details exactly as written.

FOR THE ATS:
- Use the job's exact words (its key skills, tools and duties) wherever the candidate's work supports them, in the summary, the bullets and the skills.
- Use standard section headings: Summary, Experience, Projects, Education, Skills, Certifications. Keep the candidate's own heading where it is already standard.
- Plain text only: no tables, columns, icons, emoji or first person.

In "keywords", list the 10 to 15 terms an ATS would scan this job for, each one to three words (skills, tools, methods), not the job title.
In "gaps", name what the job asks for that the resume still does not show, as short phrases.
In "changes", list what you changed, as short sentences.`;

const BULLET = {
  type: 'OBJECT',
  properties: {
    id: { type: 'STRING' },
    text: { type: 'STRING' },
    from: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['text'],
};

const RESUME = {
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
                id: { type: 'STRING' },
                from: { type: 'STRING' },
                title: { type: 'STRING' },
                org: { type: 'STRING' },
                dates: { type: 'STRING' },
                bullets: { type: 'ARRAY', items: BULLET },
              },
              required: ['title', 'bullets'],
            },
          },
        },
        required: ['heading', 'items'],
      },
    },
    skills: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          group: { type: 'STRING' },
          items: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['items'],
      },
    },
  },
  required: ['name', 'sections', 'skills'],
};

/* The original comes first on purpose: the model parses the resume and gives
   it ids before it writes the version that has to refer to them. */
export const TAILOR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    original: RESUME,
    tailored: RESUME,
    added: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { text: { type: 'STRING' }, why: { type: 'STRING' } },
        required: ['text'],
      },
    },
    keywords: { type: 'ARRAY', items: { type: 'STRING' } },
    changes: { type: 'ARRAY', items: { type: 'STRING' } },
    gaps: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['original', 'tailored', 'added', 'keywords', 'changes', 'gaps'],
  propertyOrdering: ['original', 'tailored', 'added', 'keywords', 'changes', 'gaps'],
};

export function buildTailorPrompt(resumeText, rawJob) {
  const job = clampJob(rawJob);
  const facts = [
    `Role: ${job.title ?? 'Unknown'}`,
    `Company: ${job.company ?? 'Unknown'}`,
    job.roleLabel ? `Kind of work: ${job.roleLabel}` : null,
    job.location ? `Location: ${job.location}` : null,
    job.workplaceType ? `Work mode: ${job.workplaceType}` : null,
    job.duration ? `Duration: ${job.duration}` : null,
    job.degreeLevel || job.degreeText ? `Open to: ${[job.degreeLevel, job.degreeText].filter(Boolean).join(', ')}` : null,
    job.experience ? `Experience asked: ${job.experience}` : null,
    job.keySkills?.length ? `Key skills: ${job.keySkills.join(', ')}` : null,
    job.skills?.length ? `Listed skills: ${job.skills.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  const duties = job.bullets?.length ? `\nWhat the work is:\n${job.bullets.map((b) => `- ${b}`).join('\n')}\n` : '';
  const about = job.description || job.summary || '';

  return `THE JOB
${facts}
${duties}${about ? `\nAbout the role:\n${about}\n` : ''}
THE CANDIDATE'S RESUME
${resumeText}

Parse the resume into "original" exactly as it is, then write "tailored" for this job. Keep everything; add only what you list in "added".`;
}
