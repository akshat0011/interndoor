/* The resume AI's prompts, schemas and models. SERVER ONLY.
 *
 * The underscore keeps this file from becoming a route on Vercel, and nothing
 * under web/public imports it, so no browser ever downloads it. /api/ai is
 * the only caller: it builds every prompt here from a resume and a role, so
 * the words sent to the model are written in ONE place and a browser can
 * never choose them.
 */
import { clampJob, roleHeadline } from '../public/resumeai.js';

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
/* PINNED, 11 Oct 2026 (billing on). "gemini-flash-lite-latest" had moved, with
 * no notice, to gemini-3.5-flash-lite: $0.30/$2.50 per million tokens, six
 * times the output price of the model it used to mean. gemini-3.1-flash-lite
 * is $0.25/$1.50 and ranked the same 25 roles within 9 points of it on
 * average, same order at both ends. Never point a billed call at a -latest
 * alias: its price can change under you.
 *
 * The tailor stays on 2.5 Flash with its thinking capped at TAILOR_THINKING.
 * Measured on the same request: unlimited thinking spent 2,400-6,300 tokens
 * on it ($0.015-0.025 a tailor, 24-42 s); 1,024 spent ~800 ($0.012, 20 s) with
 * the same output; NO thinking broke the structure (the summary filed as a
 * section, every skill in one group). 3.1 Flash-Lite costs half again but kept
 * first person and filler; 3.8 Flash took 62-174 s. */
/* MOVED TO 3.1 FLASH-LITE, 12 Oct 2026, his call ("at least 200 tailors a
 * day with 2k budget"). Measured on fictional resumes against the S&P Global
 * apprentice and Rippling backend postings: one page 2,018 tokens in / 2,349
 * out, ~38p; two pages 2,433 / 4,649, ~73p; 6-13 s. 2.5 Flash on the one-page
 * resume: 2,018 / 2,567 + 833 thinking, ~87p, 16 s. 2.5 Flash-Lite would be
 * cheaper still and answers 404 to new projects. Flash-Lite INVENTS DUTIES
 * ("Performed code reviews", "Skilled in C#" for a resume with neither), which
 * reconcileTailored's grounding step undoes in code. No thinking: it does none
 * by default, and the structure held without it. */
export const RANK_MODEL = 'gemini-3.1-flash-lite';
export const TAILOR_MODEL = 'gemini-3.1-flash-lite';
export const TAILOR_THINKING = null;   // null sends no thinkingConfig
/* THE OWNER'S TAILOR KEEPS THE BEST WRITER (his call, 12 Oct 2026: "the best
 * model 2.5 flash or whatever for the owner i.e me"). Same fictional two-page
 * resume: 2.5 Flash wrote "Built a Kafka consumer in Python", Flash-Lite
 * "Built a kafka consumer in python"; 145p and 27 s against 64p and 9 s. */
export const OWNER_TAILOR_MODEL = 'gemini-2.5-flash';
export const OWNER_TAILOR_THINKING = 1024;

/* WHAT A MILLION TOKENS COSTS, in US cents, Google's paid-tier price sheet read
 * 12 Oct 2026 (ai.google.dev/gemini-api/docs/pricing). Thinking tokens bill as
 * output. Used to charge each call what it really cost (web/api/ai.js). A
 * model missing here is charged its reservation and nothing is refunded. */
export const PRICE_CENTS_PER_M = {
  'gemini-3.1-flash-lite': { in: 25, out: 150 },
  'gemini-2.5-flash': { in: 30, out: 250 },
};
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

/* THE TAILOR'S BRIEF, REWRITTEN 11 OCT 2026 from a senior recruiter's account
 * of how an ATS is used: it is a search engine. The recruiter types the job
 * title and a few skills and sees only resumes containing those exact strings,
 * so what gets a candidate shortlisted is (1) the exact title, (2) the job's
 * keywords where the recruiter looks first (summary, skills, then bullets) and
 * (3) the posting's exact wording. Measured on a real posting with the old
 * brief, the model padded the summary with "aspiring" and "proven track
 * record", copied skills in lower case from the posting, kept "my college",
 * and turned "fixed bugs reported by QA" into "participating in code reviews"
 * (an invented duty, then an invented skill). Each of those has a rule below. */
export const TAILOR_SYSTEM = `You tailor a candidate's resume to one job. It is a real person's resume, which they will send to a real employer.

HOW AN ATS IS USED, which is what you are writing for. An applicant tracking system is a search engine for recruiters. The recruiter types the role and a few skills ("Software Engineer" + "Node.js" + "MongoDB") and sees only the resumes that contain those exact words. It does not understand concepts and it does not grade style: it matches strings. So the resume must contain the posting's exact words for everything the candidate genuinely has, where a recruiter looks first: the summary, the skills, then the bullets.

Return two resumes.

1. "original": the resume EXACTLY as given, parsed into the structure. Copy every line word for word. Do not fix, shorten, merge, reorder or drop anything. Give every item an id ("i1", "i2", ...) and every bullet an id ("i1.b1", "i1.b2", ...). An item's "title" is its main line (a job title, project name, degree or school), "org" is the line that goes with it (the employer, the school, or a project's tech stack or one-line description), "dates" its dates, and "where" a location or a link printed beside it. Put every skill the resume lists into "skills", as individual skills, one per entry, in the groups the resume uses (for example group "Programming", items ["Python", "C++"]). Skills go in "skills", never in a section. The summary or objective goes in "summary", never in a section.

2. "tailored": the resume rewritten for this job.

NEVER REMOVE ANYTHING. Every item, bullet, skill, tool, project, job, school and claim in the original must still be in the tailored resume. Each tailored item gives the id of the original item it came from in "from". Each tailored bullet lists, in "from", the ids of the original bullets it came from.

THE SUMMARY. Two or three sentences, at most 55 words, that a recruiter takes in at a glance:
- the role, word for word as THE JOB's "Role" line gives it: the job title without intern, trainee, season, year or level words (the page prints that role as a headline above the summary; do not write a headline yourself). Never call the candidate an intern or a trainee. If there is no "Role" line, name no title;
- three or four of the job's key skills that the resume shows the candidate has actually used, spelled as the posting spells them;
- the strongest concrete result in the resume, with its number exactly as written.
No words about character (passionate, hardworking, motivated, aspiring, eager, dynamic, results-driven, team player, proven track record), no first person, no "looking to grow".

THE SKILLS, the recruiter's first stop.
- The first group holds the job's skills that the candidate has, in the posting's words, most important first.
- One skill per entry and hard skills only (languages, frameworks, tools, platforms, methods), 15 to 30 in all. Split combined entries: "HTML/CSS" becomes "HTML" and "CSS", "Node/Express" becomes "Node.js" and "Express.js".
- Write every skill in its standard spelling and capitalization ("Node.js", "MongoDB", "CI/CD", "JavaScript"), even where the posting writes it in lower case.
- Keep any qualifier the candidate wrote beside a skill: "Docker (basic)" stays "Docker (basic)", never just "Docker".
- Soft skills the candidate listed stay, in a last group of their own.

EXACT WORDING. Where the resume says the same thing as the posting in other words ("REST" and "RESTful APIs", "JS" and "JavaScript", "websockets" and "WebSockets", "data visualization" and "data storytelling"), use the posting's words in the summary, the bullets and the skills. Only where it is genuinely the same thing.

THE BULLETS.
- Start with a strong past-tense verb, then what was built or done, with which tool, and the result.
- Work the job's keywords in where the work supports them, naturally: at most two in one bullet, never a list of keywords.
- Keep every number exactly as written. Never add a number.
- Rewording changes the words, never the facts: do not add scope, places, users, tools or details the line does not state.
- Keep the size of every claim. "Helped the backend team with APIs" may become "Contributed RESTful API endpoints alongside the backend team", never "Built the backend" or "Led". Never add a duty the resume does not state (code reviews, mentoring, leading, owning, working with senior engineers or product teams).
- Never shrink a claim either. Where the resume already says Built, Made, Wrote, Designed, Created, Cut or Reduced, keep that verb or one as strong: "Made a Next.js dashboard" never becomes "Contributed to a dashboard".
- Write every tool, language and framework with its standard capitals (Python, Spring Boot, Kafka, React Native, PostgreSQL), never in lower case, even where the posting does.
- One or two lines each. No first person (I, my, me, we, our).
- Within each section, the items and bullets that matter most for this job come first.

HEADINGS. Use headings an ATS recognises: Summary, Experience, Projects, Education, Skills, Certifications, Achievements. Keep the candidate's own heading where it is already clear ("Achievements & Activities" stays). Rename only a heading an ATS would not map ("Things I Built" becomes "Projects", "Open Source" becomes "Open Source Experience"), and never to one that misdescribes what is under it.

DATES, NAMES, CONTACT. Copy every date, employer, school, title, location, link, name and contact detail exactly as written.

YOU MAY ADD, and must list every addition in "added" with a short reason:
- skills the posting asks for that the resume clearly shows the candidate has used, under another name or as part of what they built (MongoDB, Express, React and Node.js together are the "MERN stack"; a GitHub Actions pipeline that runs tests is "CI/CD");
- at most two new bullets that state, in the job's words, something the resume already shows, with "from": [].
Never add a skill or a claim the resume does not support. Never invent an employer, job title, project, school, date, degree, certification, award or number.

In "keywords", list the 10 to 15 terms a recruiter would search this job for, each one to three words (skills, tools, methods), in standard capitalization, not the job title.
In "gaps", name what the job asks for that the resume does not show and nothing honest can add, as short phrases the candidate can act on.
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
                where: { type: 'STRING' },
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
    `Exact job title: ${job.title ?? 'Unknown'}`,
    roleHeadline(job.title) ? `Role: ${roleHeadline(job.title)}` : null,
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

Parse the resume into "original" exactly as it is, then write "tailored" for this job: the role and the job's key skills in the summary, the job's skills first in the skills, the job's words in the bullets. Keep everything; add only what you list in "added".`;
}
