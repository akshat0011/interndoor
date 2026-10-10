/**
 * Clean job titles, and the roles that belong on Misc.
 *
 * His ask, 30 Sep 2026: "a lot of job titles are very long and carry useless
 * info, use on device ai to find a suitable job title for every job" and "move
 * to misc any niche or non software roles that are still in the software
 * category". Accenture's "I&P GN - SC&E – Analyst - Enterprise AI Value
 * Strategy-EVS" is a strategy consultant's role, and it sat on the Software
 * shelf under a title no student could read.
 *
 * ONE LOCAL MODEL CALL PER POSTING (qwen3:8b, temperature 0; ~1.5 s measured)
 * returns a shorter title and the role's DISCIPLINE from a fixed list. Code,
 * not the model, decides what is published:
 *
 *  - THE TITLE IS GROUNDED (groundTitle). It may only drop, reorder and recase
 *    words of the original title. Measured on 60 live titles: the model turned
 *    "Custom Software Engineer" into "Agentic AI Engineer" and "Campus Summer
 *    Intern" into "Data Science Intern" — both refused here, and the original
 *    title stays. The published title is display only: the page's URL keeps
 *    being built from the original (`slugTitle`), so no link moves.
 *  - A ROLE LEAVES SOFTWARE FOR MISC ON TWO SIGNALS, never one (shelfMove): the
 *    model's discipline is not software, AND the title itself names a
 *    non-software discipline. The model alone moved an "IBM WebSphere
 *    Middleware Engineer" and a bare "Intern" to Misc; the title rule refuses
 *    both, and keeps his standing rule that a title naming no discipline is
 *    software. It can only ever move Software to Misc — never promote.
 */

export const DISCIPLINES = [
  'software_development', 'data_engineering', 'data_science_analytics', 'machine_learning_ai',
  'devops_cloud_sre', 'qa_testing', 'security', 'hardware_embedded',
  'it_support_helpdesk', 'erp_crm_functional', 'consulting_strategy', 'project_program_management',
  'business_sales_marketing_ops', 'life_sciences', 'core_engineering', 'design', 'unclear',
];

/** Disciplines that are not the Software shelf's work. */
export const MISC_DISCIPLINES = new Set([
  'it_support_helpdesk', 'erp_crm_functional', 'consulting_strategy', 'project_program_management',
  'business_sales_marketing_ops', 'life_sciences', 'core_engineering', 'design',
]);

/**
 * The plainest standard names for a job. The model may put one of these on a
 * posting whose own title does not say plainly what the job is ("PKI Engineer
 * - C# Expert" is a Security Engineer); anything else it publishes must be the
 * posting's own words. groundTitle holds it to exactly this list.
 */
export const STANDARD_NAMES = [
  'Software Engineer', 'Software Developer', 'Security Engineer', 'Data Engineer', 'Data Analyst',
  'Data Scientist', 'Machine Learning Engineer', 'AI Engineer', 'Cloud Engineer', 'DevOps Engineer',
  'QA Engineer', 'Test Engineer', 'Network Engineer', 'Embedded Engineer', 'Firmware Engineer',
  'Hardware Engineer', 'Design Engineer', 'Verification Engineer', 'Research Scientist',
  'Full Stack Developer', 'Backend Developer', 'Frontend Developer',
];

export const TITLE_SYSTEM = `You name jobs for a student job board. Reply with JSON only.

"title": the name of the job a student would search for, and its level. Nothing else. 1 to 4 words (5 for an internship or a returnship).
Keep: the job's name (Software Engineer, Applied Scientist, Data Analyst, Programmer, Java Developer); its level ONLY when the title states it as I, II, III, IV, 1-4, L1-L4 or SDE-1 to SDE-4, written as the title writes it; its kind (Intern, Internship, Trainee, Apprentice, Graduate, Co-op, Returnship).
NEVER add a level, grade or number the title does not have, and drop any other grade number ("Data Engineer 11" -> "Data Engineer").
Remove: team, product, department, business-unit and programme names (Ads Trust Science, Enterprise, Global Technology, S&C Global Network, Payments Platform, Career Accelerator Program), requisition and job codes, locations, work modes, contract terms, dates, years, seasons, the company's name, and specialist jargon a student would not recognise (PKI, ABAP, EVS, HCM). A word like Enterprise, Corporate, Global or Technology Services in front of a job names the department, not the job: remove it even when the rest of the title is plain.
A technology stays only when it IS the job and a student would know it: Java Developer, React Developer, Android Developer, Python Developer.
When the title already says plainly what the job is, keep its own words and only remove the rest: "Cybersecurity Product Engineer" stays as it is, "Data Engineer" stays "Data Engineer". Only when the title does not say plainly what the job is, or names it with jargon, name it with the plainest standard name for the work in the description: ${STANDARD_NAMES.join(', ')}. Two roles that differ only in the language or tool they use get the same name.
Examples:
"Applied Scientist I, Ads Trust Science" -> "Applied Scientist I"
"Enterprise App Programmer" -> "App Programmer"
"PKI Engineer - C# Expert" (builds certificate and encryption systems) -> "Security Engineer"
"PKI Engineer - Java /Cloud Expert" (the same work in Java) -> "Security Engineer"
"Returnship - Data Integration" -> "Data Integration Returnship"
"Career Accelerator Program - Digital IC Design Engineer" -> "Digital IC Design Engineer"
"I&P GN - SC&E – Analyst - Enterprise AI Value Strategy-EVS" -> "Strategy Analyst"
"Software Engineer II - Backend (Payments Platform)" -> "Backend Software Engineer II"
"2027 Summer Internship - Software Engineering - Bengaluru" -> "Software Engineering Intern"
"Data Engineer 11" -> "Data Engineer"
"Java Developer" -> "Java Developer"
"Cybersecurity Engineer" -> "Cybersecurity Engineer"`;

/**
 * The discipline is a call of its own, on the small model, with the words it
 * was audited on (30 Sep and 8 Oct 2026): sharing one prompt with the title
 * rules made the larger model ignore half of them (10 Oct 2026), and the
 * shelves must not move because the titles changed.
 */
export const DISCIPLINE_SYSTEM = `You name each role's discipline for a student job board. Reply with JSON only.

"discipline": what the person will actually do, judged from the title AND the description:
software_development (building applications, web, mobile, backend, frontend, full-stack, APIs),
data_engineering (pipelines, ETL, data platforms), data_science_analytics (data science, data analysis, BI that writes SQL or code),
machine_learning_ai (ML, AI, GenAI engineering), devops_cloud_sre, qa_testing (manual or automated testing), security (cybersecurity engineering),
hardware_embedded (chips, VLSI, electronics, embedded, firmware),
it_support_helpdesk (desktop, server or application support, helpdesk), erp_crm_functional (SAP, Salesforce, ServiceNow, Oracle functional or configuration roles),
consulting_strategy (consulting, strategy, advisory, value or transformation analysts), project_program_management (scrum master, project or program coordination),
business_sales_marketing_ops (business, sales, marketing, finance, HR, operations), life_sciences (biology, bioinformatics, pharma, clinical),
core_engineering (mechanical, civil, electrical, chemical, manufacturing, process), design (UX, UI, graphic),
unclear (the title and description do not say).`;

export const TITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
};

export const DISCIPLINE_SCHEMA = {
  type: 'object',
  properties: { discipline: { type: 'string', enum: DISCIPLINES } },
  required: ['discipline'],
};

/** What the model is shown for one posting. */
export function titleUserPrompt(job) {
  const description = String(job.description ?? '').slice(0, 1500);
  return [`Company: ${job.company ?? ''}`, `Title: ${job.title ?? ''}`, `Role summary: ${job.role_label ?? job.roleLabel ?? ''}`, '', 'Description:', description].join('\n');
}

const WORD = /[A-Za-z0-9][A-Za-z0-9+#.]*/g;
const words = (s) => String(s ?? '').match(WORD) ?? [];
const norm = (w) => w.toLowerCase().replace(/\.+$/, '');

/** The original title's words, lower-cased, mapped to how the title spells them. "React.js" also gives "react" and "js". */
function vocabulary(raw) {
  const v = new Map();
  for (const w of words(raw)) {
    const spelled = w.replace(/\.+$/, '');
    const n = norm(w);
    if (!v.has(n)) v.set(n, spelled);
    for (const part of spelled.split('.').filter(Boolean)) if (!v.has(part.toLowerCase())) v.set(part.toLowerCase(), part);
  }
  return v;
}

/** Joining words the model may use though the title does not ("Data Processing with Python"). */
const CONNECTORS = new Set(['and', 'of', 'for', 'in', 'the', 'a', 'to', 'with', 'on']);
const INTERN_WORD = /\b(intern|internship|trainee|apprentice|apprenticeship|co-?op)\b/i;
/** A returnship is for people back from a career break, so it must say so (Cognizant, 10 Oct 2026). */
const RETURN_WORD = /\breturn(?:ship|er)s?\b/i;
const ROLE_WORD = /\b(engineer|engineering|developer|development|analyst|analytics|scientist|intern|internship|trainee|specialist|consultant|architect|designer|programmer|tester|administrator|associate|manager|lead|apprentice|researcher|sde|sdet|technician|executive|officer)\b/i;
export const TITLE_MAX = 60;
/**
 * A level the title states: roman I-IV as a word of its own, L1-L4, or 1-4
 * straight after a role noun ("Associate 2", "SDE-1"). The clean title keeps
 * it, level 1 included (his ask, 10 Oct 2026: Amazon's "Applied Scientist I"
 * is "Applied Scientist I", not "Applied Scientist"). A roman numeral must
 * stand alone: the "I" of "I&P GN" is a unit code, not a level. A year is not
 * a level, and nor is an internal grade like Cummins' "Data Engineer 11".
 */
const LEVEL_ROMAN = /(?:^|[\s,(\-–_/])(I|II|III|IV)(?=$|[\s,)\-–_/])/;
const LEVEL_OTHER = /\b(L[1-4])\b|\b(?:engineer|engr|developer|scientist|associate|analyst|sde|programmer|executive|specialist|consultant)[\s-]*([1-4])\b/i;
function keepsLevel(clean, raw) {
  const s = String(raw ?? '');
  const r = s.match(LEVEL_ROMAN);
  const o = s.match(LEVEL_OTHER);
  const token = r && (!o || r.index <= o.index) ? r[1] : (o?.[1] ?? o?.[2]);
  if (!token) return true;
  return new RegExp(`(^|[^A-Za-z0-9])${token}(?=$|[^A-Za-z0-9])`, /^[IV]+$/.test(token) ? '' : 'i').test(clean);
}
/** An internal grade the title carried and the clean title must drop: "Data Engineer 11". */
const BIG_GRADE = /\b(?:engineer|engr|developer|scientist|analyst|associate|programmer|specialist)\s+(?:[5-9]|\d{2,})\b/i;

/** The words a standard name may add, and the kind and level words it may carry beside one. */
const STANDARD_WORDS = new Set(STANDARD_NAMES.flatMap((n) => n.toLowerCase().split(' ')).concat('engineering'));
const NAME_SET = new Set(STANDARD_NAMES.map((n) => n.toLowerCase()).concat('software engineering'));
const KIND_OR_LEVEL = /\b(?:intern|internship|trainee|apprentice|apprenticeship|graduate|co-?op|junior|associate|I|II|III|IV|L[1-4]|[1-4])\b/gi;
const coreName = (s) => String(s).replace(KIND_OR_LEVEL, ' ').replace(/[-\s]+/g, ' ').trim().toLowerCase();
/** The posting's own title already names a standard job, so it must not be renamed to another. */
const namesStandardJob = (raw) => {
  const flat = ` ${String(raw ?? '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ')} `;
  return [...NAME_SET].some((n) => flat.includes(` ${n} `));
};

/**
 * The model's title, if it is safe to publish, else null.
 *
 * Every word must be a word of the original title (or of one of its dotted
 * parts), a close stem of one (Engineer <- Engineering, Intern <- Internship),
 * or a joining word — OR the title is renamed to a standard job name
 * (STANDARD_NAMES), which is allowed only where the original names no standard
 * job itself, or, for a title naming no role at all ("Java Fullstack"), as the
 * original's own words plus Developer or Engineer. An original that names an
 * internship must still name one, one that names a role must still name one,
 * and a stated level must survive. Each word keeps the original title's own
 * spelling, so the model cannot publish "Powerbi" or "Macos".
 */
export function groundTitle(clean, raw, company = '') {
  const c = String(clean ?? '').replace(/\s+/g, ' ').replace(/^[\s\-–—|,:]+|[\s\-–—|,:]+$/g, '').trim();
  if (c.length < 3 || c.length > TITLE_MAX) return null;
  const count = words(c).length;
  if (count > 5) return null;
  if (count < 2 && words(raw).length > 1) return null;
  const vocab = vocabulary(raw);
  const respell = [];
  const added = [];
  for (const w of words(c)) {
    const n = norm(w);
    if (vocab.has(n)) { respell.push([w, vocab.get(n)]); continue; }
    if (CONNECTORS.has(n)) continue;
    const stem = n.length >= 4 && [...vocab.keys()].some((r) => r.startsWith(n) && r.length - n.length <= 4);
    if (stem) continue;
    if (STANDARD_WORDS.has(n)) { added.push(n); continue; }
    return null;
  }
  if (added.length) {
    const standard = NAME_SET.has(coreName(c)) && !namesStandardJob(raw);
    const roleAdded = !ROLE_WORD.test(String(raw)) && added.every((n) => n === 'developer' || n === 'engineer');
    if (!standard && !roleAdded) return null;
  }
  if (INTERN_WORD.test(String(raw)) && !INTERN_WORD.test(c)) return null;
  if (RETURN_WORD.test(String(raw)) && !RETURN_WORD.test(c)) return null;
  if (ROLE_WORD.test(String(raw)) && !ROLE_WORD.test(c)) return null;
  if (!keepsLevel(c, raw)) return null;
  if (BIG_GRADE.test(c)) return null;
  if (company && c.toLowerCase() === String(company).trim().toLowerCase()) return null;
  let title = c;
  for (const [w, spelled] of respell) {
    if (spelled && spelled !== w && spelled.toLowerCase() === w.toLowerCase()) {
      const esc = w.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');
      title = title.replace(new RegExp(`(^|[^A-Za-z0-9])${esc}(?=$|[^A-Za-z0-9])`), `$1${spelled}`);
    }
  }
  return title;
}

/** A word in the title that says the work IS software, whatever the model thinks. */
// "data analyst" and "data analytics" stay, by his rule ("keep data analyst");
// cloud platform work is DevOps, which is Software — a UPS "Google Cloud
// Infrastructure Support Engineer" runs GCP reliability, not a helpdesk.
const SOFTWARE_WORD = /\b(developer|development|software|sde|sdet|programmer|full[\s-]?stack|back[\s-]?end|front[\s-]?end|etl|data engineer|data analy(?:st|sts|tics)|data scien(?:ce|tist)|devops|devsecops|integration|sre|site reliability|machine learning|ml|ai engineer|cloud engineer|cloud infrastructure|automation|java|python|react|node|\.net|golang|middleware|microservices?|api|database|sql)\b/i;
/** A word in the title that names a non-software discipline — the second signal. */
const MISC_TITLE_WORD = /\b(strategy|strategic|advisory|consult(?:ing|ant)?|support|helpdesk|help desk|service desk|desktop|mba|business|sales|marketing|finance|financial|accounting|hr|human resources|operations|bioinformatics|biology|biotech|clinical|pharma|genomics|chemistry|chemical|mechanical|civil|electrical|manufacturing|scrum|sap|salesforce|servicenow|erp|crm|epm|functional|administrator|managed services|onboarding|forecasting|claims|e-?commerce|ux|ui|graphic|recruit(?:er|ing|ment)?)\b/i;

/**
 * 'misc' when a Software-shelf role should move to Misc, else null.
 * Two independent signals, and only ever Software -> Misc.
 */
export function shelfMove(category, discipline, rawTitle, { open = false, labelMisc = false } = {}) {
  if (category !== 'software') return null;
  if (!MISC_DISCIPLINES.has(discipline)) return null;
  if (SOFTWARE_WORD.test(String(rawTitle ?? ''))) return null;
  if (MISC_TITLE_WORD.test(String(rawTitle ?? ''))) return 'misc';
  /* A title that NAMES NO DISCIPLINE ("Analyst", "Intern", "Apprentice",
     "Contractor") stays Software by his standing rule — unless the model's
     discipline AND its role label both name misc work (8 Oct 2026 audit:
     eClerx's "Analyst" labelled "Customer Insights Analyst", Otis's
     "Apprentice" labelled "Elevator Mechanic Apprentice", Veradigm's
     "Contractor" labelled "Customer Support"). Still two signals: the
     discipline alone moved a bare "Intern" once, and his Deutsche Bank and
     Wells Fargo examples carry labels ("Engineering Support", "Policy Review")
     that name no misc family, so they stay. */
  if (open && labelMisc) return 'misc';
  return null;
}

/**
 * The title to publish: an owner's hand edit wins (owner.js sets
 * `original_title`), then the grounded clean title, then the original.
 */
export function publishedTitle(row) {
  if (row?.original_title) return row.title;
  return calmTitle(row?.display_title || row?.title);
}

/* A word an employer typed in capitals for emphasis is shown in title case
   (9 Oct 2026, the calm redesign): "Applied Sciences INTERN" reads as
   shouting, and a board of them reads as machine-made. ONLY ordinary job
   words are calmed. Titles are full of acronyms nobody could list (ABAP,
   SDLC, ADAS, HANA, WLAN, RHEL), so a capitalised word this list does not
   know keeps its capitals: a missed calming costs nothing, a mangled acronym
   misnames the job. The slug is built from the original title, so no URL
   moves. Measured on the live board: 51 titles changed under a "calm any
   4+ capitals" rule, most of them acronyms; this list is the fix. */
const SHOUTED = new Set(('INTERN INTERNS INTERNSHIP INTERNSHIPS ENGINEER ENGINEERS ENGINEERING SOFTWARE DEVELOPER '
  + 'DEVELOPERS DEVELOPMENT ANALYST ANALYSTS ADMINISTRATOR SPECIALIST TEST TESTING QUALITY ASSURANCE DATA SCIENCE '
  + 'SCIENCES SCIENTIST CYBER SECURITY SYSTEMS SYSTEM EXECUTIVE JAVA REACT BACKEND FRONTEND ELECTRICAL MECHANICAL '
  + 'DISTINGUISHED TRAINEE TRAINEES GRADUATE ASSOCIATE SENIOR JUNIOR CONSULTANT MANAGER LEAD PRINCIPAL DESIGN '
  + 'HARDWARE SILICON APPLIED PROGRAM PROGRAMME RESEARCH CLOUD NETWORK NETWORKING SUPPORT OPERATIONS PRODUCT '
  + 'PYTHON FULL STACK MOBILE APPLICATION APPLICATIONS SUMMER WINTER FRESHER FRESHERS ENTRY LEVEL AUTOMATION '
  + 'EMBEDDED FIRMWARE VERIFICATION VALIDATION TECHNOLOGY TECHNICAL DIGITAL MACHINE LEARNING INFRASTRUCTURE '
  + 'PLATFORM SERVICES SOLUTIONS ARCHITECT MAINTENANCE PRODUCTION PROCESS PROJECT INDIA BANGALORE BENGALURU '
  + 'HYDERABAD PUNE CHENNAI MUMBAI DELHI NOIDA GURUGRAM GURGAON REMOTE HYBRID ONSITE').split(' '));
const RECASE = { DEVOPS: 'DevOps', DEVSECOPS: 'DevSecOps', MLOPS: 'MLOps', NOSQL: 'NoSQL', GENAI: 'GenAI', IOS: 'iOS', JAVASCRIPT: 'JavaScript' };
export function calmTitle(title) {
  const t = String(title ?? '');
  if (!/[A-Z]{4,}/.test(t)) return title;
  return t.replace(/\b[A-Z]{4,}\b/g, (w) => {
    if (Object.hasOwn(RECASE, w)) return RECASE[w];
    return SHOUTED.has(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w;
  });
}


/* ------------------------------------------------------------------ store */

/** Live engineering rows on published boards whose title has not been read yet, newest first. */
export function titleTargets(db, regions, limit = 40) {
  const codes = (regions ?? []).map((c) => String(c));
  if (!codes.length) return [];
  const marks = codes.map(() => '?').join(',');
  return db.prepare(`SELECT job_id, company, title, role_label, description, region FROM jobs
    WHERE is_tech = 1 AND title_checked_at IS NULL AND closed_at IS NULL AND suppressed_reason IS NULL
      AND region IN (${marks})
    ORDER BY first_seen_at DESC LIMIT ?`).all(...codes, limit);
}

/** Record one reading. `displayTitle` null means the original title stays. */
export function saveTitleReading(db, jobId, { displayTitle = null, discipline = null } = {}, now = Date.now()) {
  db.prepare('UPDATE jobs SET display_title = ?, discipline = ?, title_checked_at = ? WHERE job_id = ?')
    .run(displayTitle, discipline, now, String(jobId));
}
