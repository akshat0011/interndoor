/**
 * Which published listings are good enough for the WhatsApp channel.
 *
 * His ask, 8 Oct 2026: "make sure no trash or niche or non software role job
 * reaches the whatsapp channel, the quality must remain high". The site keeps
 * every role it already shows; this only decides what is ANNOUNCED. So the
 * gate can afford to be strict: a good role it refuses is still on the board,
 * while a bad one it lets through is pushed to every follower's phone.
 *
 * It reads the published projection (what the message is composed from):
 * `title` is the title the message shows, `slugTitle` the employer's original
 * where the two differ, `roleLabel` the model's reading of the posting and
 * `category` the shelf. Misc never reaches here — `announceable` runs first.
 *
 * Every word below was measured on the live India board (946 software and
 * hardware roles, 8 Oct 2026) and each refusal read by hand before it stayed.
 */

const norm = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ');

/* WHAT A SOFTWARE ROLE IS CALLED. Bare "engineer" is not on it: "Discipline
   Engineer", "Application Engineer" (semiconductor field work) and
   "Associate Project Engineer" all say engineer and none says software.
   "data X engineer" admits Data Ingestion / Migration / Quality engineers. */
export const SOFTWARE_ROLE = /\b(?:software|sw|sde|swe|sysdev|developers?|programmers?|programming|coders?|firmware|full[\s-]?stack|front[\s-]?end|back[\s-]?end|web|android|ios|mobile|flutter|react(?:\.?js)?|angular|node(?:\.?js)?|java|javascript|typescript|python|golang|rust|kotlin|php|dot ?net|microservices|spring boot|mean stack|mern stack|devops|devsecops|sre|site reliab\w*|cloud|platform engineer(?:ing)?|infrastructure|kubernetes|kafka|spark|databricks|snowflake|etl|sql|aws|azure|gcp|data(?: \w+)? eng(?:ineers?|ineering|g|r)|data scien(?:ce|tists?)|data analy(?:st|sts|sis|tics)|machine learning|ml|ai|aiml|genai|gen ai|generative ai|llm|nlp|deep learning|computer vision|agentic|applied scientist|qa|qe|quality assurance|quality automation|sdet|testers?|test|testing|(?:cyber ?)?security|infosec|appsec|identity|iam|vapt|soar|kernel|linux|compiler|technology|tech|(?:application|app|software|web) development|development engineer)\b|c\+\+|c#|\.net/;

/* THE TITLE MUST NAME A JOB. "Azure Data Bricks", "Playwright automation",
   "Data Science", "MEAN stack" are services-firm skill strings, and a message
   reading "Zensar — REACT" tells a follower nothing. */
export const ROLE_NOUN = /\b(?:engineers?|engr|developers?|dev|programmers?|interns?|internship|trainees?|apprentices?|apprenticeship|analysts?|scientists?|testers?|sde|swe|sysdev|sdet|sre|qa|specialists?|associates?|graduates?|freshers?|co-?op|researchers?|designers?|technologists?|coders?|pmts|smts|mts|member of technical staff)\b/;

/* NOT FOR THIS CHANNEL, whatever else the title says: support and admin work,
   business-side analysts, presales, teaching and content, contract and
   returner roles, oilfield work (SLB's "Drilling Data Analyst" got past
   "data analyst"), grades no fresher holds (abbreviations included — "Princ
   Engr", "Dist Engr", "Assoc Mgr", "Senio Gen AI"), PhD-only roles, and
   hardware. Checked on BOTH titles: cleaning a title can drop the grade. */
export const NOT_FOR_CHANNEL = /\b(?:support|help ?desk|service desk|administrators?|admin|dba|governance|compliance|compl|audit|auditor|financial analysts?|finance (?:analyst|operations|executive)|accounting|accountant|spend|procurement|revenue|sales|presales|pre-sales|solutions engineer|marketing|business (?:research )?analysts?|business operations|customer (?:engineer|success|support|service)|technicians?|label(?:l)?ing|annotation|annotators?|coordinator|coordination|managed services?|teaching|teacher|instructor|trainer|tutor|faculty|content|creators?|copywrit\w*|video editing|actuar\w*|cat modell?er|catastrophe|drilling|oilfield|reservoir|petroleum|geolog\w*|geophysic\w*|subsurface|wellsite|contractor|returnship|principal|princ|distinguished|dist|senio(?:r)?|sr|snr|lead|manager|mgr|archt|architect|head|director|advisor|expert|intermediate|phd|postdoc\w*|soc|asic|fpga|rtl|vlsi|pcb|verilog|systemverilog|uvm|dft|hardware|electronics|electrical|mechanical|silicon)\b/;

/* ONE VENDOR'S PRODUCT, configured or supported: a real job, but a niche one,
   and not what a student following a software channel is looking for.
   Checked on the label too — "Applications Developer Intermediate" at UPS is
   Workday configuration, and only the label says so. */
export const NICHE_PRODUCT = /\b(?:sap|abap|salesforce|servicenow|workday|pega|appian|guidewire|kofax|tungsten|t24|temenos|earnix|sitecore|sailpoint|planisware|apigee|mainframe|cobol|as ?400|siebel|peoplesoft|oracle (?:ebs|fusion|apps)|dynamics 365|d365|power ?apps|power platform|amazon connect|open ?text|murex|calypso|finacle|flexcube|clinical|rave|medidata|ibm ace|websphere|adobe analytics|power ?bi|tableau|qlik\w*|edi|plm|teamcenter|windchill)\b/;

/* WHAT THE LABEL ALONE MAY REFUSE. A label is the model's words, so this list
   is narrower than the title's: only work that is plainly not engineering.
   "training" is NOT on it — "Predictive Model Training" is machine learning. */
export const LABEL_NOT_FOR_CHANNEL = /\b(?:support|help ?desk|administration|administrators?|admin|governance|compliance|label(?:l)?ing|annotation|coordination|coordinator|project execution|risk management|defect analysis|financial|accounting|sales|marketing|teaching|tutoring|content)\b/;

/* A hardware-shelf role whose title names no software may still be firmware —
   but only the label's own word "software" or "firmware" can say so. */
const HARDWARE_LABEL_OK = /\b(?:software|firmware)\b/;

/* LEVEL 2 AND UP. Wipro's "DEVELOPER L2" asks 1-3 years in every posting read;
   "Protocol Test Engineer L2 L3" is network layers, hence the lookahead, and
   Amazon's "Engineer I, L4" is its entry grade, hence the role noun first. */
const LEVEL = /\b(?:developer|engineer|analyst|administrator|tester)\s+l[2-4]\b(?![\s/]*l\d)|\b(?:engr|engineer|eng|developer|dev|qa|analyst|associate|sde|swe|programmer)\s*[-–]?\s*(?:[2-4]|ii|iii|iv)\b/;

/**
 * Why a listing stays off the channel, or null when it may go.
 * The reason is a short phrase for the run log, never shown to a reader.
 */
export function channelRefusal(job) {
  const raw = String(job?.title ?? '');
  const shown = norm(raw);
  const titles = `${shown} | ${norm(job?.slugTitle)}`;
  const label = norm(job?.roleLabel);

  /* What the message SHOWS: "Z2_Java Developer", "Java Fullstack IRC300668",
     a Japanese title on the India board. Read off the shown title only — a
     requisition code the cleaner already removed costs nothing. */
  if (raw.includes('_')) return 'messy title';
  if (/\d{5,}/.test(shown)) return 'requisition code in title';
  if (/[^\x00-\u024f\u2010-\u203a]/.test(raw)) return 'title not in english';

  const years = [...titles.matchAll(/(\d+)\s*(?:\+|-|–|to)?\s*(\d+)?\s*\+?\s*(?:yrs?|years?)\b/g)]
    .flatMap((m) => [m[1], m[2]]).filter(Boolean).map(Number);
  if (years.length && Math.max(...years) >= 4) return 'experience in title';
  if (LEVEL.test(titles)) return 'level 2+';

  const bad = titles.match(NOT_FOR_CHANNEL);
  if (bad) return `title: ${bad[0]}`;
  const niche = titles.match(NICHE_PRODUCT) ?? label.match(NICHE_PRODUCT);
  if (niche) return `niche: ${niche[0]}`;
  const off = label.match(LABEL_NOT_FOR_CHANNEL);
  if (off) return `label: ${off[0]}`;

  /* A title that names no discipline ("Intern", "Winter Internship") is how
     Microsoft, Sprinklr, IQVIA and iRage title real software internships, so
     the label may vouch for it — except on the hardware shelf, where it takes
     the word software or firmware. */
  if (!SOFTWARE_ROLE.test(titles)
      && !(job?.category === 'hardware' ? HARDWARE_LABEL_OK : SOFTWARE_ROLE).test(label)) {
    return 'names no software role';
  }
  if (!ROLE_NOUN.test(shown)) return 'no role in title';
  return null;
}
