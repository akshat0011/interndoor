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

/* The owner's pass (web/api/ai.js, isOwnerCall): written by owner.js in his
   paired browser only, sent as x-ai-owner, and it means no daily limit. */
export const AI_OWNER_STORE = 'interndoor-ai-owner';
const OWNER_SHAPE = /^[0-9a-f]{64}$/;

function ownerPass() {
  try {
    const v = localStorage.getItem(AI_OWNER_STORE);
    return v && OWNER_SHAPE.test(v) ? v : null;
  } catch { return null; }
}

export function isAIOwner() { return ownerPass() !== null; }

export function allowanceLeft(now = Date.now()) {
  if (isAIOwner()) return null;   // no count to show: the owner has no limit
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
  'express.js': ['express', 'expressjs'],
  websockets: ['websocket', 'web sockets', 'web socket'],
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
const MAX_DUTIES = 10;
const MAX_DUTY = 300;

/** Trim every field to a size a real posting could have. The job comes off the
 *  board, but the request comes from a browser, and the server clamps again
 *  because it pays for every token.
 *
 *  The duties, the key skills, who it is open to and the experience asked are
 *  here since 11 Oct 2026: before that the tailor saw a title, one summary
 *  paragraph and the skill tags, and could not match the role's own words. */
export function clampJob(job) {
  const text = (v, max = MAX_FIELD) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const list = (v, n, max = MAX_FIELD) => (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .slice(0, n)
    .map((x) => x.trim().slice(0, max));
  return {
    title: text(job?.title),
    company: text(job?.company),
    location: text(job?.location),
    workplaceType: text(job?.workplaceType),
    stipend: text(job?.stipend),
    duration: text(job?.duration),
    skills: list(job?.skills, MAX_SKILLS),
    keySkills: list(job?.keySkills, 20),
    bullets: list(job?.bullets, MAX_DUTIES, MAX_DUTY),
    roleLabel: text(job?.roleLabel),
    degreeLevel: text(job?.degreeLevel),
    degreeText: text(job?.degreeText),
    experience: text(job?.experience) ?? text(job?.expSays),
    description: text(job?.description, MAX_DESC),
    summary: text(job?.summary, MAX_DESC),
  };
}

/* ---------------- keeping every line ----------------
 *
 * HIS RULE, 11 Oct 2026: the tailor must NEVER remove a skill or a claim the
 * reader wrote. It may reorder, reword and add, and every addition is shown.
 *
 * The model is asked for two resumes: `original`, the input parsed as it
 * stands, every item and bullet given an id, and `tailored`, whose items and
 * bullets name the originals they came from. Nothing here trusts the model to
 * have kept everything. reconcileTailored() checks it, and anything of the
 * reader's that the rewrite dropped is put back. That is a guarantee made in
 * code, not a promise made in a prompt.
 *
 * WHAT USED TO GO WRONG, and why skills are split before they are compared:
 * the model returned skills as whole resume lines — "Programming: Python,
 * JavaScript, C++" — and the old check called "programming:" an invented skill
 * (the colon matched nothing) and stripped the line. A reader's entire skills
 * section disappeared that way.
 */

/** A haystack for whole-word matching: normalised, padded, with a full stop at
 *  the end of a word dropped ("Python." still names Python) and the dot inside
 *  a name kept (Node.js, .NET). Hyphens become spaces on both sides, so
 *  "scikit-learn" in a skill list finds "scikit-learn" in a resume. */
export function hayOf(text) {
  return ` ${normSkill(text).replace(/\.(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

const keyOf = (s) => hayOf(s).trim();
/** One skill under two spellings is one skill: "LLM" and "LLMs" included. */
const stemOf = (k) => (k.length > 3 && k.endsWith('s') ? k.slice(0, -1) : k);

/** Does this text name the skill, under any spelling, singular or plural? */
export function mentions(hay, skill) {
  const k = keyOf(skill);
  if (!hay || !k) return false;
  for (const s of new Set([k, ...spellingsOf(k)])) {
    if (hay.includes(` ${s} `)) return true;
    if (s.length > 3 && s.endsWith('s') && hay.includes(` ${s.slice(0, -1)} `)) return true;
    if (hay.includes(` ${s}s `)) return true;
  }
  return false;
}

/* A spelling the reader used, standing for the canonical name the rewrite may
   use instead ("JS" for JavaScript, "Node" for Node.js). Only true spellings:
   an alias that is a DIFFERENT tool (FastAPI listed beside Flask, GitHub beside
   Git, Keras beside TensorFlow) never counts as the reader's skill being kept,
   or a rewrite could drop it and nothing would put it back. */
const NOT_A_SPELLING = new Set([
  'fastapi', 'keras', 'opencv', 'scrum', 'ubuntu', 'unix', 'simulink', 'git', 'github', 'gitlab',
  'asp.net', 'system verilog', 'systemverilog', 'containerisation', 'containerization', 'spring',
]);
const CANONICAL_OF = new Map();
for (const [canon, alts] of Object.entries(SKILL_ALIASES)) {
  for (const alt of alts) if (!NOT_A_SPELLING.has(normSkill(alt))) CANONICAL_OF.set(normSkill(alt), canon);
}

/**
 * Is the reader's skill still in the rewrite, under its own name, a spelling of
 * it, or (for a combined entry like "Node/Express" or "HTML/CSS") with every
 * part present? Used only to decide whether a skill must be PUT BACK, so it
 * errs towards "not kept": a qualifier the reader wrote ("Docker (basic)") is
 * part of the skill's words and has to survive with it.
 */
export function keptIn(hay, skill) {
  if (mentions(hay, skill)) return true;
  const canon = CANONICAL_OF.get(keyOf(skill));
  if (canon && mentions(hay, canon)) return true;
  const parts = String(skill).split(/\s*[/&+]\s*|\s+and\s+/i).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 && parts.every((x) => x.length > 1) && parts.every((x) => keptIn(hay, x));
}

/** Split on commas, semicolons and bullets, but never inside brackets, so
 *  "AWS (EC2, S3)" stays one skill. */
function splitList(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text)) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;|•·]/.test(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim().replace(/\.$/, '').trim()).filter(Boolean);
}

/** "Programming: Python, Go" -> { group: 'Programming', items: [Python, Go] }. */
export function splitSkillEntry(entry) {
  const s = String(entry ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { group: '', items: [] };
  const m = s.match(/^([^:,()]{1,40}):\s*(.+)$/);
  return m ? { group: m[1].trim(), items: splitList(m[2]) } : { group: '', items: splitList(s) };
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const strList = (v, n, max = 300) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);
const sameKey = (a, b) => keyOf(a) === keyOf(b);

/** Words worth comparing, for telling a reworded bullet from a new one. */
function wordsOf(text) {
  return new Set(normSkill(text).split(/\s+/).filter((w) => w.length > 2));
}
function overlap(a, b) {
  const A = wordsOf(a);
  const B = wordsOf(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}

/** Titles that read the same, or share most of their words. */
function sameTitle(o, t) {
  return Boolean(o.title || t.title) && (sameKey(o.title, t.title) || overlap(o.title, t.title) >= 0.6);
}
/** The same item, found without a link: the title AND no organisation that
 *  says otherwise. An explicit link needs only the title, because the
 *  organisation is then put back from the original whatever the rewrite said. */
function sameItem(o, t) {
  const orgOk = !o.org || !t.org || sameKey(o.org, t.org) || overlap(o.org, t.org) >= 0.6;
  return sameTitle(o, t) && orgOk;
}

/** Shape whatever came back into one resume structure. Nothing here invents.
 *
 *  The model is told to put skills in `skills` and the summary in `summary`,
 *  and does not always: it has returned a "Skills" section with one item per
 *  line and a "Summary" section beside a written summary. Both are folded
 *  into their own fields here, or the summary prints twice and a skills line
 *  is treated as a job. */
function normResume(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const all = (Array.isArray(r.sections) ? r.sections : []).map((sec) => ({
    heading: str(sec?.heading, 80),
    items: (Array.isArray(sec?.items) ? sec.items : []).map((it) => ({
      id: str(it?.id, 40),
      from: str(it?.from, 40),
      title: str(it?.title, 200),
      org: str(it?.org, 200),
      dates: str(it?.dates, 80),
      where: str(it?.where, 160),
      bullets: (Array.isArray(it?.bullets) ? it.bullets : []).map((b) => (typeof b === 'string'
        ? { id: '', text: str(b, 1200), from: [] }
        : {
          id: str(b?.id, 40),
          text: str(b?.text, 1200),
          from: (Array.isArray(b?.from) ? b.from : []).map((x) => str(x, 40)).filter(Boolean),
        })).filter((b) => b.text),
    })).filter((it) => it.title || it.org || it.bullets.length),
  })).filter((sec) => sec.items.length);

  const groups = [];
  const add = (group, items) => {
    if (!items.length) return;
    const home = groups.find((g) => g.group.toLowerCase() === group.toLowerCase());
    if (home) home.items.push(...items);
    else groups.push({ group, items: [...items] });
  };
  for (const g of Array.isArray(r.skills) ? r.skills : []) {
    if (typeof g === 'string') {
      const sp = splitSkillEntry(g);
      add(sp.group, sp.items);
      continue;
    }
    const items = [];
    let group = str(g?.group, 60);
    for (const e of Array.isArray(g?.items) ? g.items : []) {
      const sp = splitSkillEntry(e);
      if (!group && sp.group) group = sp.group;
      items.push(...sp.items);
    }
    add(group, items);
  }

  let summary = str(r.summary, 2000);
  const sections = [];
  for (const sec of all) {
    if (SUMMARY_HEAD.test(sec.heading)) {
      if (!summary) {
        summary = sec.items.map((it) => (it.bullets.length
          ? it.bullets.map((b) => b.text).join(' ')
          : [it.title, it.org].filter(Boolean).join(' '))).join(' ').slice(0, 2000);
      }
      continue;
    }
    if (SKILLS_HEAD.test(sec.heading)) {
      for (const it of sec.items) {
        // A model can file an empty "Skills" section whose one item is the
        // word "Skills": that is the heading again, not a skill.
        if (!it.bullets.length && !it.org && (sameKey(it.title, sec.heading) || BARE_SKILLS_HEAD.test(it.title))) continue;
        const head = splitSkillEntry(it.title);
        const titleIsList = Boolean(head.group) || head.items.length > 1;
        let group = head.group || (titleIsList || !it.bullets.length ? '' : it.title);
        const items = titleIsList || !it.bullets.length ? [...head.items] : [];
        for (const b of it.bullets) {
          const sp = splitSkillEntry(b.text);
          if (!group && sp.group) group = sp.group;
          items.push(...sp.items);
        }
        add(group, items);
      }
      continue;
    }
    sections.push(sec);
  }

  // A skill listed twice in one resume is one skill.
  for (const g of groups) {
    const seen = new Set();
    g.items = g.items.filter((x) => {
      const k = stemOf(keyOf(x));
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  return {
    name: str(r.name, 120),
    contact: str(r.contact, 400),
    summary,
    sections,
    skills: groups.filter((g) => g.items.length),
  };
}

const SUMMARY_HEAD = /^(professional |career )?(summary|profile|objective|about( me)?)$/i;
const SKILLS_HEAD = /\bskills?\b|technolog|tech stack|competenc/i;
const BARE_SKILLS_HEAD = /^\s*(technical |key |core |soft |other |additional )?skills?\s*$/i;

/** The resume as plain text, in reading order. Used for the keyword count and
 *  for checking how much of the input the parse actually read. */
export function resumePlainText(R) {
  const out = [R?.name, R?.contact, R?.summary];
  for (const sec of R?.sections ?? []) {
    out.push(sec.heading);
    for (const it of sec.items ?? []) {
      out.push([it.title, it.org, it.dates, it.where].filter(Boolean).join(' '));
      for (const b of it.bullets ?? []) out.push(typeof b === 'string' ? b : b.text);
    }
  }
  for (const g of R?.skills ?? []) {
    out.push([g.group, ...g.items.map((x) => (typeof x === 'string' ? x : x.text))].filter(Boolean).join(', '));
  }
  return out.filter(Boolean).join('\n');
}

/**
 * The model's answer, made safe to show. Returns both resumes in one shape:
 *   original  the input as parsed, nothing changed
 *   tailored  the rewrite, with every original item, bullet and skill present;
 *             each bullet and skill carries `added: true` when it is new
 * plus the list of additions (each with a `key` the page uses to remove it),
 * how many dropped things were put back, and how much of the input the parse
 * covered (a low number means the parse itself may have missed lines).
 */
export function reconcileTailored(data, resumeText, { job = null } = {}) {
  const d = data && typeof data === 'object' ? data : {};
  const O = normResume(d.original);
  const T = normResume(d.tailored);
  const hay = hayOf(resumeText);
  let restored = 0;

  // Every original item and bullet gets an id we can rely on.
  const oItem = new Map();
  const oBullet = new Map();
  const ownerOf = new Map();
  let n = 0;
  for (const sec of O.sections) {
    for (const it of sec.items) {
      n += 1;
      if (!it.id || oItem.has(it.id)) it.id = `i${n}`;
      oItem.set(it.id, { item: it, heading: sec.heading });
      it.bullets.forEach((b, k) => {
        if (!b.id || oBullet.has(b.id)) b.id = `${it.id}.b${k + 1}`;
        oBullet.set(b.id, b);
        ownerOf.set(b.id, it.id);
      });
    }
  }

  // Link each tailored item and bullet to what it came from. When the model
  // gave no usable id, the closest unclaimed original stands in for it, so a
  // reworded line is never mistaken for a new one and then duplicated.
  const usedItems = new Set();
  const usedBullets = new Set();
  for (const sec of T.sections) {
    for (const it of sec.items) {
      /* A link is trusted only when the titles agree. Titles are facts that
         never change, so a link to an item with a different title is the
         model pointing at the wrong one — and trusting it would overwrite this
         item's title with another's (a project came back named after a job). */
      const linked = oItem.get(it.from)?.item;
      let src = linked && !usedItems.has(it.from) && sameTitle(linked, it) ? it.from : '';
      if (!src) {
        for (const [id, { item }] of oItem) {
          if (usedItems.has(id)) continue;
          if (sameItem(item, it)) { src = id; break; }
        }
      }
      it.from = src;
      it.added = !src;
      if (src) {
        usedItems.add(src);
        const o = oItem.get(src).item;
        // An employer, a title and the dates are facts, not wording.
        it.title = o.title || it.title;
        it.org = o.org;
        it.dates = o.dates;
        it.where = o.where;
      }
      for (const b of it.bullets) {
        let from = b.from.filter((id) => oBullet.has(id));
        if (!from.length) {
          let best = '';
          let score = 0.5;
          for (const [id, ob] of oBullet) {
            if (usedBullets.has(id)) continue;
            const s = overlap(ob.text, b.text);
            if (s >= score) { best = id; score = s; }
          }
          if (best) from = [best];
        }
        b.from = from;
        for (const id of from) usedBullets.add(id);
        b.added = from.length === 0;
      }
    }
  }

  /* A REWRITE MAY NOT CLAIM WHAT THE RESUME NEVER SAYS (12 Oct 2026). The
     model is asked to use the posting's words only for what the reader really
     has, and the cheaper model does not hold to it: measured on a fictional
     resume it turned "Wrote unit tests with pytest" into "Performed code
     reviews and wrote unit tests", and its summary said "Skilled in C#" for a
     resume with no C#. So code decides: a rewritten line naming any of the
     role's keywords that appears nowhere in the resume goes back to the
     reader's own words, and so does a summary sentence. A line the model ADDS
     is left alone, because it is listed and highlighted as an addition with a
     Remove button; a rewritten one is not, and would pass as the reader's. */
  const terms = job ? roleKeywords(job, d.keywords) : [];
  const claims = (text) => terms.some((kw) => mentions(hayOf(text), kw) && !mentions(hay, kw));
  let grounded = 0;
  for (const sec of T.sections) {
    for (const it of sec.items) {
      for (const b of it.bullets) {
        if (b.added || !claims(b.text)) continue;
        b.text = b.from.map((id) => oBullet.get(id)?.text ?? '').filter(Boolean).join(' ');
        grounded += 1;
      }
    }
  }
  if (T.summary && claims(T.summary)) {
    const kept = T.summary.split(/(?<=[.!?])\s+/).filter((x) => !claims(x)).join(' ').trim();
    T.summary = kept;   // empty falls back to the reader's own below (T.summary || O.summary)
    grounded += 1;
  }

  // Capitals back on tool names in what the model wrote; the reader's own
  // lines (unchanged or put back above) are left exactly as they wrote them.
  /* Only names shaped like a tool's: a symbol or digit (Node.js, C#, EC2), a
     capital after the first letter (PostgreSQL, AWS), or, from the reader's
     own skills, one word (Testcontainers). A Title-Cased phrase the model
     lists as a keyword ("Data Systems", "Unit Testing") is a topic, and
     respelling it put "a REST API for Data Systems" in a live answer. */
  const toolShaped = (n, oneWordOk) => /[^A-Za-z\s]/.test(n) || /^.+[A-Z]/.test(n.replace(/\s+[A-Z]/g, ' x'))
    || (oneWordOk && !/\s/.test(n.trim()));
  const names = [
    ...STANDARD_NAMES,
    ...O.skills.flatMap((g) => g.items).filter((n) => toolShaped(String(n), true)),
    ...(Array.isArray(d.keywords) ? d.keywords : []).filter((n) => toolShaped(String(n), false)),
  ];
  for (const sec of T.sections) {
    for (const it of sec.items) {
      for (const b of it.bullets) {
        const own = b.from.map((id) => oBullet.get(id)?.text ?? '').join(' ');
        if (b.text !== own) b.text = respell(b.text, names);
      }
    }
  }
  if (T.summary && T.summary !== O.summary) T.summary = respell(T.summary, names);

  // Anything of the reader's that the rewrite dropped goes back in.
  for (const [id, { item, heading }] of oItem) {
    if (usedItems.has(id)) continue;
    let sec = T.sections.find((x) => sameKey(x.heading, heading));
    if (!sec) { sec = { heading, items: [] }; T.sections.push(sec); }
    sec.items.push({
      id: '', from: id, added: false, title: item.title, org: item.org, dates: item.dates, where: item.where,
      bullets: item.bullets.map((b) => ({ id: '', text: b.text, from: [b.id], added: false })),
    });
    usedItems.add(id);
    for (const b of item.bullets) usedBullets.add(b.id);
    restored += 1;
  }
  for (const [id, ob] of oBullet) {
    if (usedBullets.has(id)) continue;
    const home = T.sections.flatMap((x) => x.items).find((it) => it.from === ownerOf.get(id));
    home.bullets.push({ id: '', text: ob.text, from: [id], added: false });
    usedBullets.add(id);
    restored += 1;
  }

  // Skills: every original one stays, in its own group where that survives.
  const tHay = () => hayOf(T.skills.flatMap((g) => g.items).join(' , '));
  for (const g of O.skills) {
    for (const s of g.items) {
      if (keptIn(tHay(), s)) continue;
      // Back under its own heading: a reader's "Tools" group comes back as
      // "Tools", not folded into whatever group the rewrite kept first.
      let home = T.skills.find((x) => x.group.toLowerCase() === g.group.toLowerCase())
        || (g.group ? null : T.skills[0]);
      if (!home) { home = { group: g.group, items: [] }; T.skills.push(home); }
      home.items.push(s);
      restored += 1;
    }
  }
  const oSkills = hayOf(O.skills.flatMap((g) => g.items).join(' , '));
  const skillOut = (R, isTailored) => R.skills.map((g) => ({
    group: g.group,
    items: g.items.map((text) => ({
      text,
      added: isTailored && !mentions(oSkills, text) && !mentions(hay, text),
    })),
  }));

  // What was added, with the model's reason where it gave one.
  const reasons = Array.isArray(d.added) ? d.added : [];
  const whyFor = (text) => {
    const k = keyOf(text);
    const hit = reasons.find((a) => {
      const ak = keyOf(a?.text ?? '');
      return ak && (ak.includes(k) || k.includes(ak));
    });
    return hit ? str(hit.why, 200) : '';
  };
  const tailored = {
    ...T,
    name: O.name || T.name,
    contact: O.contact || T.contact,
    summary: T.summary || O.summary,
    skills: skillOut(T, true),
  };
  const added = [];
  let k = 0;
  for (const sec of tailored.sections) {
    for (const it of sec.items) {
      for (const b of it.bullets) {
        if (!b.added) continue;
        b.key = `a${++k}`;
        added.push({ key: b.key, kind: 'line', text: b.text, why: whyFor(b.text) });
      }
    }
  }
  for (const g of tailored.skills) {
    for (const s of g.items) {
      if (!s.added) continue;
      s.key = `a${++k}`;
      added.push({ key: s.key, kind: 'skill', text: s.text, why: whyFor(s.text) });
    }
  }

  const original = {
    ...O,
    sections: O.sections.map((sec) => ({
      heading: sec.heading,
      items: sec.items.map((it) => ({ ...it, bullets: it.bullets.map((b) => ({ text: b.text, added: false })) })),
    })),
    skills: skillOut(O, false),
  };

  // How much of the input the parse read. Words of four letters or more, so
  // "and" and "the" cannot carry a bad parse over the line.
  const big = (t) => new Set(normSkill(t).split(/\s+/).filter((w) => /^[a-z]/.test(w) && w.length > 3));
  const src = big(resumeText);
  const read = big(resumePlainText(O));
  let covered = 0;
  for (const w of src) if (read.has(w)) covered += 1;

  return {
    name: tailored.name,
    contact: tailored.contact,
    original,
    tailored,
    added,
    restored,
    grounded,
    coverage: src.size ? covered / src.size : 1,
    changes: strList(d.changes, 12),
    gaps: strList(d.gaps, 10),
    keywords: strList(d.keywords, 20, 60),
  };
}

/* ---------------- tool names keep their capitals ----------------
 * Flash-Lite writes "kafka consumer in python" and "react native code" even
 * where the resume and the prompt both capitalise them (measured 12 Oct 2026).
 * A recruiter reads that as careless, so code puts the capitals back. Only a
 * WHOLLY LOWER-CASE match of a known name is touched, so the reader's own
 * casing and a sentence-initial word are never changed. Names that are also
 * ordinary English words are never respelled: "the rest of", "to go". */
export const STANDARD_NAMES = [
  'Python', 'Java', 'JavaScript', 'TypeScript', 'Kotlin', 'Golang', 'C++', 'C#', '.NET', 'SQL', 'NoSQL', 'GraphQL',
  'HTML', 'CSS', 'Tailwind CSS', 'React', 'React Native', 'Next.js', 'Node.js', 'Express.js', 'Vue.js', 'Angular',
  'Django', 'Flask', 'FastAPI', 'Spring Boot', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'Kafka',
  'Airflow', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'Linux', 'Git', 'GitHub', 'GitHub Actions', 'GitLab',
  'AWS', 'GCP', 'Azure', 'Firebase', 'Pandas', 'NumPy', 'TensorFlow', 'PyTorch', 'Scikit-learn', 'Hadoop',
  'Snowflake', 'Tableau', 'Power BI', 'Grafana', 'Prometheus', 'Selenium', 'Postman', 'Figma', 'Jira', 'REST API',
  'RESTful APIs', 'CI/CD', 'LLM', 'LLMs', 'NLP', 'OOP', 'DSA', 'DBMS',
];
const NOT_A_NAME = new Set(['go', 'rest', 'express', 'spring', 'swift', 'rust', 'shell', 'excel', 'access', 'word', 'dart', 'ruby', 'spark', 'chef', 'puppet', 'ant', 'hive', 'pig', 'c', 'r']);
const RESPELL_EDGE = 'A-Za-z0-9#+';

/** Put the standard capitals back on known names written in lower case. */
export function respell(text, names) {
  let out = String(text ?? '');
  const list = [...new Set(names.map((n) => String(n ?? '').trim()).filter((n) => n.length > 1 && /[A-Z]/.test(n) && !NOT_A_NAME.has(n.toLowerCase())))]
    .sort((a, b) => b.length - a.length);
  for (const name of list) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![${RESPELL_EDGE}.])${esc}(?![${RESPELL_EDGE}])`, 'gi');
    out = out.replace(re, (m) => (m === m.toLowerCase() && m !== name ? name : m));
  }
  return out;
}

/* ---------------- the role's keywords ---------------- */

/**
 * The words an applicant tracking system would scan this role for: the
 * posting's key skills first, then its skill tags, then the model's reading of
 * the role. One skill under two spellings is listed once.
 */
export function roleKeywords(job, extra = [], max = 16) {
  const out = [];
  const seen = new Set();
  /* The model's own terms are a supplement, and kept short: a phrase like
     "Entertainment Domain Adaptation" is not something an ATS matches word for
     word, and counting it only pads the score. The role's title is not a
     keyword either. */
  const title = keyOf(job?.title ?? '');
  const theirs = (extra ?? []).filter((x) => {
    const t = String(x ?? '').trim();
    return t && t.length <= 28 && t.split(/\s+/).length <= 3 && keyOf(t) !== title;
  }).slice(0, 6);
  for (const raw of [...(job?.keySkills ?? []), ...(job?.skills ?? []), ...theirs]) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const k = stemOf(keyOf(t));
    if (!t || t.length > 40 || !k || seen.has(k)) continue;
    if (spellingsOf(k).some((s) => seen.has(stemOf(s)))) continue;
    seen.add(k);
    for (const s of spellingsOf(k)) seen.add(stemOf(s));
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Which of the role's keywords this text contains. */
export function keywordMatch(keywords, text) {
  const hay = hayOf(text);
  const hit = [];
  const miss = [];
  for (const kw of keywords ?? []) (mentions(hay, kw) ? hit : miss).push(kw);
  return { hit, miss };
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
    const pass = ownerPass();
    res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: pass ? { 'content-type': 'application/json', 'x-ai-owner': pass } : { 'content-type': 'application/json' },
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

/** Rewrite one resume against one job. Nothing of the reader's is ever
 *  removed: reconcileTailored puts back anything the rewrite dropped, and
 *  marks everything it added. */
/**
 * The posting's exact title as the resume's headline, the first thing a
 * recruiter's search matches (a senior recruiter, 11 Oct 2026: "If I search
 * 'Senior Project Manager' and your resume says 'Project Coordinator', you
 * won't show up"). Set here, from the role, never by the model, so it is the
 * title word for word. It is an addition like any other: listed, highlighted,
 * and one click removes it.
 */
export function addHeadline(t, job) {
  const title = str(job?.title, 120);
  if (!t?.tailored || !title) return t;
  t.tailored.headline = title;
  t.added = [{
    key: 'headline', kind: 'headline', text: title,
    why: "The posting's exact title. Recruiters search by title first.",
  }, ...(t.added ?? []).filter((a) => a.key !== 'headline')];
  return t;
}

export async function tailorWithAI({ resumeText, job, signal, region }) {
  const resume = String(resumeText).slice(0, MAX_RESUME_CHARS);
  const data = await callAI('tailor', { resume, job: clampJob(job) }, { signal, region });
  const t = addHeadline(reconcileTailored(data, resume, { job: clampJob(job) }), job);
  if (!t.tailored.sections.length && !t.tailored.skills.length) {
    throw new Error('The AI returned an empty resume. Please try again.');
  }
  return t;
}
