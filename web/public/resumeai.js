/* InternDoor — bring-your-own-key resume AI.
 *
 * EVERYTHING HERE RUNS IN THE READER'S BROWSER AND TALKS TO GOOGLE DIRECTLY.
 * The key and the resume never reach interndoor.com at all — there is no
 * server hop to log them, rate-limit them or get them wrong. That is the whole
 * point of the design, and it is why `connect-src` in web/vercel.json carries
 * generativelanguage.googleapis.com: without that one host the browser refuses
 * the call and nothing on the page looks broken (§5 — no local server sends the
 * CSP header, so this is only ever visible in production).
 *
 * The site used to proxy this through /api/tailor on its own Gemini key, capped
 * at 200 tailors a day for the whole site. That key is gone. A reader with no
 * key still gets the local skill ranker, which costs nothing and needs no
 * network at all.
 *
 * NOTHING IN THIS FILE MAY LOG THE KEY. Not on failure, not in a thrown
 * message, not into a URL query string — a key in a URL lands in history and in
 * every referrer on the way. It travels in the x-goog-api-key header and
 * nowhere else.
 */

export const MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** The only host this file may ever send a key to. Anchored, so a lookalike
 *  such as https://generativelanguage.googleapis.com.evil.example cannot pass
 *  a prefix test — the same shape §12 fixed in utmUrl and engage.js. */
const ALLOWED_ORIGIN = 'https://generativelanguage.googleapis.com';
export function endpointFor(model, base = API_BASE) {
  const url = new URL(`${base}/${encodeURIComponent(model)}:generateContent`);
  if (url.origin !== ALLOWED_ORIGIN) throw new Error('refusing to call an unexpected host');
  return url.toString();
}

export const KEY_STORE = 'interndoor-ai-key';
export const MAX_RESUME_CHARS = 18_000;
export const RANK_BATCH = 40;

/* ---------------- key handling ----------------
 *
 * localStorage is per-origin and per-browser: the key never leaves the reader's
 * machine and never reaches us. Every access is wrapped because a private
 * window, blocked site data or an embedded webview throws on the accessor
 * itself rather than returning empty.
 */

export function getKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}

export function setKey(key) {
  try { localStorage.setItem(KEY_STORE, String(key).trim()); return true; } catch { return false; }
}

export function forgetKey() {
  try { localStorage.removeItem(KEY_STORE); return true; } catch { return false; }
}

export function hasKey() { return getKey().length > 0; }

/**
 * Shape check only — whether the key WORKS is settled by using it, which is the
 * §13 rule (a configured id is checked by using it, never by comparing it to
 * another id). This exists to catch a pasted email address or a truncated
 * paste before spending a round trip on it.
 */
export function looksLikeKey(value) {
  const k = String(value ?? '').trim();
  return /^AIza[A-Za-z0-9_-]{30,}$/.test(k);
}

/* ---------------- skill vocabulary ----------------
 *
 * A posting says "JavaScript"; a student's resume says "JS". Both are the same
 * skill and the old matcher scored that as a miss, because it compared
 * normalised strings with a whole-word includes() and nothing else.
 *
 * MEASURED OVER THE LIVE BOARDS, 23 Sep 2026, for a resume written in
 * abbreviations — which is how most students write one:
 *
 *     roles showing a fit line      before   after
 *     India (399 roles)               145      211
 *     US    (3,884 roles)             790    1,677
 *     UK    (124 roles)                14       56
 *
 * And for a resume that spells every skill out, the count is UNCHANGED
 * (247 -> 247 India, 2,183 -> 2,187 US, 61 -> 61 UK), so this can only add
 * matches, never move an existing one. That pair of numbers is the check: a
 * widening that moved the spelled-out count would be changing answers, not
 * finding them.
 *
 * ONLY EXACT SYNONYMS GO IN HERE. "react" and "react native" are different
 * skills and are deliberately not linked; nor are "java" and "javascript".
 */
export const SKILL_ALIASES = {
  javascript: ['js', 'ecmascript'],
  typescript: ['ts'],
  'node.js': ['nodejs', 'node js', 'node'],
  'react.js': ['reactjs', 'react'],
  'next.js': ['nextjs'],
  'vue.js': ['vuejs', 'vue'],
  'machine learning': ['ml'],
  'deep learning': ['dl'],
  'natural language processing': ['nlp'],
  'computer vision': ['cv', 'opencv'],
  'artificial intelligence': ['ai'],
  kubernetes: ['k8s'],
  postgresql: ['postgres', 'psql'],
  mongodb: ['mongo'],
  'amazon web services': ['aws'],
  'google cloud platform': ['gcp', 'google cloud'],
  'microsoft azure': ['azure'],
  'continuous integration': ['ci', 'ci cd', 'cicd'],
  'rest apis': ['rest', 'restful', 'rest api'],
  'c++': ['cpp', 'c plus plus'],
  'c#': ['c sharp', 'csharp'],
  '.net': ['dotnet', 'asp.net'],
  golang: ['go'],
  'structured query language': ['sql'],
  html5: ['html'],
  css3: ['css'],
  sass: ['scss'],
  'scikit-learn': ['sklearn', 'scikit learn'],
  tensorflow: ['tf', 'keras'],
  pytorch: ['torch'],
  'version control': ['git', 'github', 'gitlab'],
  'data structures': ['dsa', 'data structures and algorithms'],
  'object oriented programming': ['oop', 'object oriented'],
  'user interface design': ['ui design', 'ui'],
  'user experience': ['ux'],
  verilog: ['system verilog', 'systemverilog'],
  matlab: ['simulink'],
  linux: ['unix', 'ubuntu'],
  docker: ['containerisation', 'containerization'],
  agile: ['scrum'],
  'spring boot': ['springboot', 'spring'],
  flask: ['fastapi'],
  'power bi': ['powerbi'],
  excel: ['microsoft excel', 'ms excel'],
};

/** The same normaliser app.js uses, so a skill and its aliases are compared on
 *  identical terms. Kept here rather than imported the other way so this module
 *  stays testable in Node with no DOM. */
export const normSkill = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();

const ALIAS_INDEX = new Map(
  Object.entries(SKILL_ALIASES).map(([k, v]) => [normSkill(k), v.map(normSkill)]),
);

/** Every spelling that counts as this skill, the canonical one first. */
export function spellingsOf(skill) {
  const k = normSkill(skill);
  if (!k) return [];
  return [k, ...(ALIAS_INDEX.get(k) ?? [])];
}

/**
 * Does a resume name this skill, under any of its spellings?
 * `hay` is the space-padded normalised resume, so a plain includes() is a
 * whole-word test — "r" must not match "for", "go" must not match "algorithm".
 */
export function resumeNames(hay, skill) {
  if (!hay) return false;
  for (const s of spellingsOf(skill)) if (hay.includes(` ${s} `)) return true;
  return false;
}

/* ---------------- shortlist ----------------
 *
 * THE US BOARD IS 3,884 ROLES AND THEY CANNOT ALL GO TO A MODEL. Sending the
 * lot would be slow, would cost the reader real money on their own key, and
 * would buy nothing: the local ranker already puts plausible roles at the top,
 * and what the model is for is fixing the ORDER among those, plus scoring the
 * ones our skill extractor could not judge at all.
 *
 * So the AI pass re-scores the best RANK_BATCH of whatever the reader is
 * currently looking at, and every other role keeps its local score and sorts
 * below. `pick` is passed in rather than imported so this stays pure.
 */
export function shortlist(jobs, localPct, n = RANK_BATCH) {
  /* The `a.i - b.i` tie-break is belt-and-braces: Array#sort is stable, so equal
     scores already keep board order and NO MUTATION CAN DISTINGUISH DROPPING IT.
     Recorded rather than papered over with a contrived fixture — the same call
     §6 makes about hoisting the weak-code pass. It is kept because the ordering
     it guarantees is load-bearing (a tie is the normal case for a resume from
     outside engineering) and stability should not be left implicit. */
  return [...jobs]
    .map((job, i) => ({ job, i, pct: localPct(job) ?? -1 }))
    .sort((a, b) => b.pct - a.pct || a.i - b.i)
    .slice(0, Math.max(0, n))
    .map((r) => r.job);
}

/* ---------------- prompts ---------------- */

const MAX_FIELD = 200;
const MAX_DESC = 12_000;
const MAX_SKILLS = 40;

/** Trim every field to a size a real posting could have. The job comes off the
 *  board rather than from a stranger now, but the cap still bounds what one
 *  rank call can cost the reader. */
export function clampJob(job) {
  const text = (v, max = MAX_FIELD) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  return {
    title: text(job?.title),
    company: text(job?.company),
    location: text(job?.location),
    workplaceType: text(job?.workplaceType),
    stipend: text(job?.stipend),
    duration: text(job?.duration),
    skills: (Array.isArray(job?.skills) ? job.skills : [])
      .filter((s) => typeof s === 'string' && s.trim())
      .slice(0, MAX_SKILLS)
      .map((s) => s.trim().slice(0, MAX_FIELD)),
    description: text(job?.description, MAX_DESC),
    summary: text(job?.summary, MAX_DESC),
  };
}

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

/* ---------------- verification ---------------- */

/**
 * The most damaging failure a tailorer can have is a skill in the output that
 * was never in the input — that hands a student a document making a claim they
 * cannot back up in an interview. A safety net under the prompt, not a
 * replacement for it.
 */
export function findInventedSkills(resumeText, skills) {
  const haystack = String(resumeText).toLowerCase().replace(/[^a-z0-9+#./ ]/g, ' ');
  return (skills ?? []).filter((skill) => {
    const s = String(skill).toLowerCase().trim();
    if (s.length < 2) return false;
    const words = s.split(/[\s/,]+/).filter((w) => w.length > 2);
    if (words.length > 1) return !words.every((w) => haystack.includes(w));
    return !haystack.includes(s);
  });
}

/* ---------------- the one network call ---------------- */

/** Turn Google's failure into something a student can act on. The key is never
 *  quoted back, on any branch. */
export function explainFailure(status) {
  if (status === 400 || status === 403) {
    return 'Google rejected that API key. Check you pasted it whole, and that the Generative Language API is enabled on its project.';
  }
  if (status === 429) {
    return 'Your own Google quota is used up for now. Free keys reset after a while; try again later.';
  }
  if (status >= 500) return 'Google’s API is having trouble. Try again shortly.';
  return `Google refused the request (HTTP ${status}).`;
}

async function callGemini({ key, system, prompt, schema, maxTokens, temperature, signal }) {
  const res = await fetch(endpointFor(MODEL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The header, never the query string — a URL is logged, a header is not.
      'x-goog-api-key': key,
    },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }),
  });

  if (!res.ok) throw new Error(explainFailure(res.status));

  const payload = await res.json();
  if (payload.promptFeedback?.blockReason) {
    throw new Error('Google’s content filter rejected this. If your resume contains anything unusual, try removing it.');
  }
  const candidate = payload.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error('That was too long to handle in one pass. Try trimming the resume to its most relevant two pages.');
  }
  const raw = (candidate?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join('').trim();
  if (!raw) throw new Error('Google returned an empty response. Please try again.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Google returned something unreadable. Please try again.');
  }
}

/**
 * Re-score a shortlist. Returns a Map from the job's own id to {fit, why}, so a
 * caller can merge without depending on array order surviving the round trip.
 * A score outside 0-100, or an index naming no role, is DROPPED rather than
 * clamped — a fabricated index is the one way a score could attach to the wrong
 * posting, and showing the wrong role a high fit is worse than showing none.
 */
export async function rankWithAI({ key, resumeText, jobs, signal }) {
  if (!jobs.length) return new Map();
  const data = await callGemini({
    key,
    system: RANK_SYSTEM,
    prompt: buildRankPrompt(String(resumeText).slice(0, MAX_RESUME_CHARS), jobs),
    schema: RANK_SCHEMA,
    maxTokens: 4_000,
    temperature: 0.2,
    signal,
  });

  const out = new Map();
  for (const row of data?.scores ?? []) {
    const job = jobs[row?.i];
    if (!job || typeof job.id === 'undefined') continue;
    const fit = Number(row?.fit);
    if (!Number.isFinite(fit) || fit < 0 || fit > 100) continue;
    out.set(job.id, { fit: Math.round(fit), why: String(row?.why ?? '').trim().slice(0, 120) });
  }
  return out;
}

/** Rewrite one resume against one job. */
export async function tailorWithAI({ key, resumeText, job, signal }) {
  const resume = String(resumeText).slice(0, MAX_RESUME_CHARS);
  const tailored = await callGemini({
    key,
    system: TAILOR_SYSTEM,
    prompt: buildTailorPrompt(resume, job),
    schema: TAILOR_SCHEMA,
    maxTokens: 4_000,
    temperature: 0.4,
    signal,
  });

  const invented = findInventedSkills(resume, tailored.skills);
  if (invented.length) {
    // Strip rather than fail — the rest of the rewrite is still useful, and the
    // student is told exactly what came out and why.
    tailored.skills = (tailored.skills ?? []).filter((s) => !invented.includes(s));
    tailored.removedSkills = invented;
  }
  return tailored;
}
