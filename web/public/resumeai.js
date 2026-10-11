/* InternDoor — the resume AI, browser half.
 *
 * The skill vocabulary and the shortlist the free local ranker uses, the
 * browser id and the remembered daily allowance, and the one call to
 * /api/ai. The prompts, the schemas and the model live on the server
 * (web/api/_prompts.js) and never reach a browser: the endpoint builds every
 * prompt itself from a resume and a role, so nobody can borrow it as a
 * general-purpose model, and the site's own page source names no provider.
 *
 * Until 11 Oct 2026 the AI ran in the browser on a key each reader had to
 * create for themselves (23 Sep, "bring your own key"). That stopped nearly
 * every student, so the site pays now: FREE_PER_DAY uses a day per browser,
 * counted by /api/ai, with a per-network and a whole-site cap behind it. The
 * resume passes through our function for that one request and is never
 * stored or logged.
 *
 * NOTHING AT MODULE SCOPE MAY TOUCH THE DOM OR localStorage — the server and
 * the tests import this file in Node. Every browser access is inside a
 * function, inside a try.
 */


/** Same origin, so connect-src 'self' covers it and no third party sees the call. */
export const AI_ENDPOINT = '/api/ai';

/* THE FREE ALLOWANCE. One pool for both features: an AI rank and a tailored
   resume each use one. The server enforces it; the browser only remembers the
   last number the server told it, to say it on screen and grey a button. At
   the prices read on 11 Oct 2026 a tailor costs about a rupee and an AI rank a
   fraction of one, so five a day per browser is affordable and still worth
   inviting a friend for when credits arrive. */
export const FREE_PER_DAY = 5;

/* Below this a resume is not a resume, and the server refuses it — the same
   line app.js draws before it will let anyone continue. */
export const MIN_RESUME_CHARS = 200;
export const MAX_RESUME_CHARS = 18_000;
/* MEASURED against a real key on the live board: 25 roles takes 16-25s and 40
   takes ~34s, for the same one request. The reader is staring at a button the
   whole time, and the roles past the top 25 are ones the local skill pass has
   already ranked below the ones being re-read — so the extra 9-18 seconds buys
   the least valuable part of the list. */
export const RANK_BATCH = 25;

/* ---------------- the day, the browser, the allowance ---------------- */

/** The allowance resets at midnight in India, where the board is — not at UTC
 *  midnight, which is 05:30 there. Shared with the server so both count the
 *  same day. */
export function istDay(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

/* A random id for this browser, so the server can count its free uses. It is
   not a person: it names nothing, the server only ever sees it hashed with the
   day, and clearing site data makes a new one. The server's per-network and
   whole-site caps are what bound a reader who does that on purpose. */
export const DEVICE_STORE = 'interndoor-ai-device';
export const DEVICE_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;
let memoryDevice = null;

function freshId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  } catch { /* fall through */ }
  let s = '';
  while (s.length < 32) s += Math.random().toString(36).slice(2);
  return s.slice(0, 32);
}

export function deviceId() {
  try {
    const kept = localStorage.getItem(DEVICE_STORE);
    if (kept && DEVICE_SHAPE.test(kept)) return kept;
    const id = freshId();
    localStorage.setItem(DEVICE_STORE, id);
    return id;
  } catch {
    /* A private window or blocked site data throws on the accessor itself.
       One id for as long as the page is open is still a working answer. */
    memoryDevice ??= freshId();
    return memoryDevice;
  }
}

/* What the server last said was left, for today only. A number from yesterday
   says nothing about today, so it is read as unknown rather than as a limit. */
export const ALLOWANCE_STORE = 'interndoor-ai-left';

export function allowanceLeft(now = Date.now()) {
  try {
    const kept = JSON.parse(localStorage.getItem(ALLOWANCE_STORE) || 'null');
    if (!kept || kept.day !== istDay(now)) return null;
    const left = Number(kept.left);
    return Number.isInteger(left) && left >= 0 && left <= FREE_PER_DAY ? left : null;
  } catch { return null; }
}

export function rememberAllowance(left, now = Date.now()) {
  const n = Number(left);
  if (!Number.isInteger(n) || n < 0) return false;
  try {
    localStorage.setItem(ALLOWANCE_STORE, JSON.stringify({ day: istDay(now), left: Math.min(n, FREE_PER_DAY) }));
    return true;
  } catch { return false; }
}

/* The 23 Sep build kept the reader's own API key here. Nothing reads it any
   more, and a credential nothing uses should not sit in a browser. */
export const OLD_KEY_STORE = 'interndoor-ai-key';
export function forgetOldKey() {
  try { localStorage.removeItem(OLD_KEY_STORE); return true; } catch { return false; }
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
 * lot would be slow, would spend the site's key on roles nobody will read, and
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

/* ---------------- bounding a role ---------------- */

const MAX_FIELD = 200;
const MAX_DESC = 12_000;
const MAX_SKILLS = 40;

/** Trim every field to a size a real posting could have. The job comes off the
 *  board, but the request comes from a browser, and the server clamps again
 *  because it pays for every token. */
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

/** What a rank needs of a role and nothing more. clampJob alone would let 25
 *  full descriptions through, which is 300 KB the prompt never reads. */
export function rankDigest(job) {
  const j = clampJob(job);
  return {
    title: j.title,
    company: j.company,
    location: j.location,
    skills: j.skills.slice(0, 12),
    summary: j.summary ? j.summary.slice(0, 220) : null,
  };
}

/** When the answer carries no words of its own — a platform timeout or a
 *  gateway page rather than our endpoint — say something a student can act on. */
export function failureFor(status) {
  if (status === 429) return `You have used today's ${FREE_PER_DAY} free AI uses. They come back at midnight. Ranking by skills still works.`;
  if (status === 504) return 'That took too long. Please try again.';
  return 'The AI is not available right now. Please try again in a moment. Ranking by skills still works.';
}

/* Posts to our own endpoint and nowhere else. The server answers
   { result, remaining } or { error, code, remaining? }; its error text is
   written for a reader and is shown as it comes. */
async function callAI(task, fields, { signal, region } = {}) {
  let res;
  try {
    res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ task, device: deviceId(), region, ...fields }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Could not reach InternDoor. Check your connection and try again.');
  }

  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (Number.isInteger(body?.remaining)) rememberAllowance(body.remaining);

  if (!res.ok || !body || typeof body.result !== 'object' || body.result === null) {
    const err = new Error(typeof body?.error === 'string' && body.error ? body.error : failureFor(res.status));
    err.code = typeof body?.code === 'string' ? body.code : null;
    throw err;
  }
  return body.result;
}

/**
 * Re-score a shortlist. Returns a Map from the job's own id to {fit, why}, so a
 * caller can merge without depending on array order surviving the round trip.
 * A score outside 0-100, or an index naming no role, is DROPPED rather than
 * clamped — a fabricated index is the one way a score could attach to the wrong
 * posting, and showing the wrong role a high fit is worse than showing none.
 */
export async function rankWithAI({ resumeText, jobs, signal, region }) {
  if (!jobs.length) return new Map();
  const data = await callAI('rank', {
    resume: String(resumeText).slice(0, MAX_RESUME_CHARS),
    jobs: jobs.map(rankDigest),
  }, { signal, region });

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
export async function tailorWithAI({ resumeText, job, signal, region }) {
  const resume = String(resumeText).slice(0, MAX_RESUME_CHARS);
  const tailored = await callAI('tailor', { resume, job: clampJob(job) }, { signal, region });

  const invented = findInventedSkills(resume, tailored.skills);
  if (invented.length) {
    // Strip rather than fail — the rest of the rewrite is still useful, and the
    // student is told exactly what came out and why.
    tailored.skills = (tailored.skills ?? []).filter((s) => !invented.includes(s));
    tailored.removedSkills = invented;
  }
  return tailored;
}
