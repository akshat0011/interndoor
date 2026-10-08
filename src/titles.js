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

export const TITLE_SYSTEM = `You tidy job titles for a student job board and name each role's discipline. Reply with JSON only.

"title": the job title a student would recognise, at most 6 words, still saying what the job is.
Use ONLY words that appear in the original title. You may remove words, reorder them and fix capitalisation. Never add, translate, abbreviate or expand a word.
Remove: requisition and job codes (R01571827, JR12345, EVS), business-unit and team codes (I&P GN, SC&E, S&C Global Network), locations and city names, work modes (Remote, Hybrid, On-site), contract terms, the company's name, and dates, years and seasons.
Keep: what the job is (Software Engineer, Data Analyst, Java Developer), its level or kind (Intern, Internship, Trainee, Apprentice, Co-op, Graduate, Associate, Junior, I, II) and at most two technologies when they are the point of the role.
Word order: the discipline first and the role last, as a person would say it — "Enterprise AI Strategy Analyst", "Windows Support Engineer", "Java Developer Intern".
If the original title is already clean and short, return it unchanged.

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
  properties: { title: { type: 'string' }, discipline: { type: 'string', enum: DISCIPLINES } },
  required: ['title', 'discipline'],
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
const ROLE_WORD = /\b(engineer|engineering|developer|development|analyst|analytics|scientist|intern|internship|trainee|specialist|consultant|architect|designer|programmer|tester|administrator|associate|manager|lead|apprentice|researcher|sde|sdet|technician|executive|officer)\b/i;
export const TITLE_MAX = 60;
/**
 * A grade of two or higher: roman II-IV, L2-L4, or 2-4 straight after a role
 * noun ("Associate 2", "SDE-2"). Dropping it makes a level-2 role read as an
 * entry-level one, so the clean title must keep it. Level 1 may go.
 */
const LEVEL_UP = /\b(II|III|IV)\b|\b(L[2-4])\b|\b(?:engineer|developer|associate|analyst|sde|executive|specialist|consultant)[\s-]*([2-4])\b/i;
function keepsLevel(clean, raw) {
  const m = String(raw ?? '').match(LEVEL_UP);
  if (!m) return true;
  const token = m[1] ?? m[2] ?? m[3];
  return new RegExp(`(^|[^A-Za-z0-9])${token}(?=$|[^A-Za-z0-9])`, 'i').test(clean);
}

/**
 * The model's title, if it is safe to publish, else null.
 *
 * Every word must be a word of the original title (or of one of its dotted
 * parts), a close stem of one (Engineer <- Engineering, Intern <- Internship),
 * or a joining word. An original that names an internship must still name one,
 * and one that names a role must still name one. Each word keeps the original
 * title's own spelling, so the model cannot publish "Powerbi" or "Macos".
 */
export function groundTitle(clean, raw, company = '') {
  const c = String(clean ?? '').replace(/\s+/g, ' ').replace(/^[\s\-–—|,:]+|[\s\-–—|,:]+$/g, '').trim();
  if (c.length < 3 || c.length > TITLE_MAX) return null;
  const vocab = vocabulary(raw);
  const respell = [];
  for (const w of words(c)) {
    const n = norm(w);
    if (vocab.has(n)) { respell.push([w, vocab.get(n)]); continue; }
    if (CONNECTORS.has(n)) continue;
    const stem = n.length >= 4 && [...vocab.keys()].some((r) => r.startsWith(n) && r.length - n.length <= 4);
    if (stem) continue;
    return null;
  }
  if (INTERN_WORD.test(String(raw)) && !INTERN_WORD.test(c)) return null;
  if (ROLE_WORD.test(String(raw)) && !ROLE_WORD.test(c)) return null;
  if (!keepsLevel(c, raw)) return null;
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
  return row?.display_title || row?.title;
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
