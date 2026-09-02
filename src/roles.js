/**
 * Is this job title a software / tech role?
 *
 * A single broad `internship` search returns everything — psychosocial support,
 * field sales, cinematography, telecalling. This is the filter that decides
 * what actually reaches the site.
 *
 * Negative signals are checked BEFORE positive ones on purpose: "Software Sales
 * Intern" and "Sales Engineer Intern" both contain engineering words but are
 * not engineering jobs, and letting the positive match win would put them on a
 * software job board.
 *
 * A title that matches neither list is reported as `uncertain` rather than
 * guessed at, so the vocabulary can be tuned from real titles instead of
 * imagination — see `node bin/show-report.js --roles`.
 */

const POSITIVE = [
  // core engineering
  'software', 'developer', 'dev', 'engineer', 'engineering', 'sde', 'swe', 'sdet',
  'programmer', 'programming', 'coding', 'computer science', 'informatics',
  // web / app
  'backend', 'back end', 'back-end', 'frontend', 'front end', 'front-end',
  'fullstack', 'full stack', 'full-stack', 'web development', 'web developer', 'webdev',
  'android', 'ios', 'mobile app', 'mobile application', 'react native', 'flutter',
  'kotlin', 'swift developer',
  // languages / frameworks
  'python', 'java', 'javascript', 'typescript', 'node.js', 'nodejs', 'react',
  'angular', 'vue', '.net', 'c++', 'c#', 'golang', 'rust', 'php', 'ruby', 'scala',
  // data / ml
  'data science', 'data scientist', 'data engineer', 'data engineering',
  'data analyst', 'data analytics', 'business intelligence', 'machine learning',
  'deep learning', 'artificial intelligence', 'computer vision', 'nlp',
  'generative ai', 'genai', 'mlops', 'llm', 'ml', 'ai',
  // infra. The compound forms are listed explicitly: \bcloud\b cannot match
  // "CloudOps", which cost us eight real postings before it was noticed.
  'devops', 'cloudops', 'dataops', 'secops', 'sysops', 'platformops',
  'sre', 'site reliability', 'cloud', 'aws', 'azure', 'kubernetes',
  'docker', 'infrastructure', 'platform engineer', 'systems engineer',
  'network engineer', 'database', 'dba', 'sql', 'api', 'microservices',
  // quality
  'qa', 'quality assurance', 'test engineer', 'software testing',
  'automation testing', 'test automation',
  // security
  'cybersecurity', 'cyber security', 'information security', 'infosec',
  'security engineer', 'application security', 'penetration testing', 'soc analyst',
  // hardware-adjacent software
  'embedded', 'firmware', 'vlsi', 'rtl', 'asic', 'fpga', 'chip design',
  'physical design', 'design verification', 'silicon',
  // other technical
  'game development', 'game developer', 'unity', 'unreal', 'graphics',
  'blockchain', 'web3', 'solidity', 'smart contract',
  'technology', 'technical', 'r&d', 'research and development',
  // Broader technical vocabulary — added after a real backfill showed several
  // engineering titles falling through to "uncertain".
  'software development', 'software engineering', 'software engineer',
  'software developer', 'application developer',
  'systems software',
  /* Specific software phrases, so a real role is never left leaning on the
     GENERIC `engineering intern` alone. Each of these is unambiguous. Three
     were deliberately NOT added — `systems engineering`, `controls
     engineering` and `automation engineering` are as often aerospace,
     mechanical or PLC work as software, and a positive that guesses wrong
     cancels the whole non-software block for that title. */
  'embedded software', 'embedded systems', 'firmware engineering',
  'computer engineering',
  'software quality', 'software test', 'security engineering',
  'platform engineering', 'cloud engineering', 'test engineering',
  'solution architect', 'software architect', 'technical architect',
  'technical program manager', 'tpm', 'release engineering', 'build engineer',
  'observability', 'devsecops', 'automation engineer', 'rpa',
  'etl', 'data warehouse', 'data platform', 'big data', 'spark', 'hadoop',
  'airflow', 'snowflake', 'power bi', 'tableau', 'looker',
  'salesforce developer', 'sap abap', 'servicenow developer', 'erp', 'crm developer',
  'linux', 'unix', 'shell scripting', 'networking', 'network security',
  'penetration tester', 'red team', 'blue team', 'soc',
  'compiler', 'kernel', 'operating systems', 'distributed systems',
  'robotics', 'ros', 'autonomous', 'mechatronics software',
  'ar/vr', 'xr', 'augmented reality', 'virtual reality', 'computer graphics',
  'hardware engineer', 'hardware design', 'validation engineer', 'verification engineer',
  'electronics engineer', 'signal processing', 'wireless', 'rf design',
  'bioinformatics', 'quantum computing', 'gis developer', 'geospatial',
  'mainframe', 'cobol', 'prompt engineering', 'agentic', 'chatbot',
  'engineering intern', 'engineering trainee', 'technical intern',
  'interim engineering',
  /* Design, adjacent but usually part of a software team.
     PRODUCT MANAGEMENT USED TO BE ON THIS LINE AND IS NOW A NEGATIVE — see
     matching.extraNonTechTerms in config.json. A PM internship is not an
     engineering internship, and listing `product manager` as a POSITIVE was
     why Salesforce's "Summer 2026 Intern - Product Manager" reached the top of
     the India board.
     `apm` stays, deliberately. It is three letters that also mean Application
     Performance Monitoring, and making it a negative refused Philips'
     "Co-op - Software Engineering (APM)" — a real SWE co-op, because
     `software engineer` does not whole-word-match "Software Engineering" and
     so no strong positive rescued it. Across 3,955 stored rows that Philips
     title is the ONLY one containing APM, so the term earns nothing as a
     negative and costs a genuine role. */
  'apm',
  'ui/ux', 'ui ux', 'uiux', 'ux', 'ui', 'user experience', 'user interface',
  'ux research', 'ux designer', 'ui designer', 'interaction design',
  // Quant roles. Ambiguous on their own, but leaning positive is the safe
  // direction: the company filter runs afterwards, so a trading internship at
  // an unknown shop is still dropped while one at Optiver survives. Leaning
  // negative would silently lose the watchlist ones.
  'quantitative', 'quant', 'algorithmic trading', 'trading',
];

const NEGATIVE = [
  // Creative and lab roles that a single positive token drags in. Negatives are
  // checked first, which is what makes this work: "AI Film Making(Internship)"
  // reached the live site because 'ai' matched on its own, and "QA Food Testing
  // Intern" because 'qa' did. Both are real postings that were published.
  'film', 'filmmaking', 'film making', 'videography', 'video editing', 'video editor',
  'graphic design', 'graphic designer', 'animation', 'animator', 'motion graphics',
  'photography', 'photographer', 'illustrator', 'copywriter', 'copywriting',
  'food testing', 'food technology', 'food safety',

  // commercial
  'sales', 'business development', 'telecalling', 'telesales', 'telemarketing',
  'inside sales', 'field sales', 'pre sales', 'presales', 'lead generation',
  'business analyst', 'market research', 'growth hacking',
  // marketing & content
  'marketing', 'digital marketing', 'social media', 'seo', 'content writing',
  'content creation', 'content writer', 'copywriting', 'copywriter', 'blogging',
  'brand', 'influencer', 'public relations', 'journalism', 'editorial',
  'video editing', 'video making', 'videography', 'photography', 'cinematography',
  'graphic design', 'graphics design', 'illustration', 'motion graphics',
  // people & back office
  'human resource', 'human resources', 'recruitment', 'recruiter',
  'talent acquisition', 'people operations', 'hr',
  'finance', 'accounting', 'accounts', 'audit', 'taxation', 'bookkeeping',
  'legal', 'paralegal', 'company secretary',
  'administrative', 'office assistant', 'back office', 'data entry',
  'customer support', 'customer service', 'customer success', 'call center',
  'operations executive', 'supply chain', 'logistics', 'procurement', 'warehouse',
  'event management', 'hospitality', 'travel',
  // non-software engineering & sciences
  'civil engineer', 'mechanical engineer', 'electrical engineer',
  'chemical engineer', 'production engineer', 'industrial engineer',
  'automobile', 'hvac', 'construction', 'architecture', 'interior design',
  'clinical', 'pharmacovigilance', 'pharmacist', 'nursing', 'medical',
  'biotechnology', 'microbiology', 'chemistry lab',
  // education & social
  'teaching', 'teacher', 'tutor', 'lecturer', 'academic',
  'counselling', 'counsellor', 'counselor', 'psychosocial', 'psychology',
  'social work', 'community outreach', 'fundraising', 'csr',
  'fashion design', 'fashion', 'textile', 'culinary', 'agriculture', 'agronomy',
  // Some postings say so outright: "Intern- Content Developer (Non-technical)"
  // was being filed as tech because of the word "Developer".
  'non-technical', 'non technical', 'nontechnical', 'content developer',
  // Observed in real runs, all correctly unwanted but previously "unclear".
  'mechanical', 'chemical', 'technician', 'telecaller', 'telecalling',
  'customer acquisition', 'client acquisition', 'market analyst',
  'content creator', 'student ambassador', 'management trainee',
  'character animation', 'curation', 'cataloging', 'cataloguing',
  'article trainee', 'articleship', 'leasing', 'tenant representation',
  'founder\'s office', 'founders office', 'growth intern', 'sports',
];

/**
 * Built-in terms with their polarity, for vetting learned vocabulary. A
 * hand-written rule with tests behind it outranks a model's suggestion.
 */
export function builtInPolarity() {
  const map = new Map();
  for (const t of POSITIVE) map.set(t.toLowerCase(), true);
  for (const t of NEGATIVE) map.set(t.toLowerCase(), false);
  return map;
}

const cache = new Map();

/**
 * Whole-word matching. Plain substring tests are unsafe here: "hr" appears in
 * "Chromium", "ai" in "maintain", "dev" in "device".
 */
function hasTerm(haystack, term) {
  let re = cache.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Terms ending in a non-word character (c++, .net, r&d) cannot take a
    // trailing \b, and ones starting with one cannot take a leading \b.
    const lead = /^[a-z0-9]/i.test(term) ? '\\b' : '';
    const tail = /[a-z0-9]$/i.test(term) ? '\\b' : '';
    re = new RegExp(`${lead}${esc}${tail}`, 'i');
    cache.set(term, re);
  }
  return re.test(haystack);
}

function firstMatch(text, terms) {
  // Longest terms first, so "data analyst" is considered before "sales" style
  // single words and the more specific phrase wins.
  for (const term of terms) {
    if (hasTerm(text, term)) return term;
  }
  return null;
}

/**
 * Multi-word positives that say "this is an engineering internship" WITHOUT
 * saying which KIND of engineering.
 *
 * They still classify a title as tech on their own — what they lose is the
 * power to outrank a negative. That override exists so a SPECIFIC phrase can
 * rescue a title from a generic negative word ("Data Analyst" surviving
 * `analyst`, "Credit Risk Data Engineer" surviving `credit risk`). A generic
 * phrase carries no such information, and letting it win inverted the rule:
 * `mechanical`, `chemical`, `civil engineer` and the rest of the non-software
 * block are all negatives, and every one of them was being cancelled the moment
 * a title ended "... Engineering Intern".
 *
 * Measured over 3,955 stored titles: `engineering intern` was cancelling a
 * negative 87 times — beating `mechanical`, `chemical`, `civil engineering`,
 * `electrical engineering`, `structural engineering`, `materials engineering`,
 * `process engineering`, `industrial engineering`, `manufacturing
 * engineering`, `presales`, `social media` and `product management` — and
 * `engineering trainee` once, on "Graduate Engineering Trainee - Sales
 * Engineer". Every OTHER multi-word positive doing the same job was specific
 * and correct and keeps the override: `data analytics` over `business
 * analytics`, `data science` over `customer success` and `finance`, `data
 * analyst` over `hr` and `sales`, `computer science` over `supply chain`,
 * `machine learning` over `medical`.
 *
 * A real software title is unaffected because it carries its own specific
 * phrase. `software engineering` was added to POSITIVE above in the same
 * change to keep that true — `software engineer` does not whole-word-match
 * "Software Engineering", so a title like "Software Engineering Intern -
 * Mechanical Systems" would otherwise have had nothing but this generic term
 * and would have been refused by `mechanical`.
 */
const GENERIC_POSITIVE = new Set([
  'engineering intern', 'engineering trainee',
  /* Single words are inert for the strongPositive test above, which requires a
     space — they are here for the `<Role>, <Team>` rescue below, which asks the
     same question of a one-word match: does this term actually say the work is
     software, or only that it is a job? */
  'engineer', 'engineering', 'technical', 'technology', 'r&d',
  'intern', 'trainee', 'apprentice',
]);

const POSITIVE_SORTED = [...POSITIVE].sort((a, b) => b.length - a.length);
const NEGATIVE_SORTED = [...NEGATIVE].sort((a, b) => b.length - a.length);

/**
 * Classify a job title.
 * @returns {{verdict: 'tech'|'non-tech'|'uncertain', matched: string|null}}
 */
export function classifyRole(title, options = {}) {
  const text = String(title ?? '').trim();
  if (!text) return { verdict: 'uncertain', matched: null };

  const positive = [...(options.extraPositive ?? []), ...POSITIVE_SORTED];
  const negative = [...(options.extraNegative ?? []), ...NEGATIVE_SORTED];

  // A specific positive phrase beats a generic negative word: "Data Analyst"
  // and "Business Intelligence" should survive even though "analyst" reads as
  // commercial. Only phrases of two or more words earn this override.
  const strongPositive = positive.find((t) =>
    t.includes(' ') && !GENERIC_POSITIVE.has(t) && hasTerm(text, t));

  const neg = firstMatch(text, negative);
  if (neg && !strongPositive) {
    /* `<Role>, <Team>` — the team name must not veto the role.
     *
     * AMAZON TITLES EVERY POSTING THIS WAY, and the team is routinely HR,
     * finance or recruiting vocabulary. Measured live:
     *
     *   'SDE I Intern , Amazon University Talent Acquisition' -> non-tech
     *   'SDE I Intern'                                        -> tech via sde
     *
     * A genuine SDE internship refused because of the department that posted
     * it. `sde` is one word and only a MULTI-word positive outranks a negative,
     * so nothing could rescue it.
     *
     * The head before the first comma wins only when it names the work
     * SPECIFICALLY — a generic term does not count, which is the same rule
     * GENERIC_POSITIVE enforces above — and only when the head carries no
     * negative of its own. Both guards are load-bearing and were measured:
     * letting ANY tech head win allows 7 rows, four of them SpaceX
     * "New Graduate Engineer, Electrical/Civil" rescued by the bare word
     * `engineer`; dropping the generic check allows GlobalFoundries'
     * "Facilities Engineering Intern, Electrical Distribution Systems" via
     * `engineering intern`. With both, it is exactly one row in 3,955 — the
     * Amazon one — and it compounds with every SDE internship Amazon files.
     */
    const head = text.split(',')[0].trim();
    if (head && head.length < text.length && !firstMatch(head, negative)) {
      const specific = positive.find((t) => !GENERIC_POSITIVE.has(t) && hasTerm(head, t));
      if (specific) return { verdict: 'tech', matched: specific };
    }
    return { verdict: 'non-tech', matched: neg };
  }

  const pos = strongPositive ?? firstMatch(text, positive);
  if (pos) return { verdict: 'tech', matched: pos };

  return { verdict: 'uncertain', matched: null };
}

/** Convenience: should this title reach a software job board? */
/**
 * Terms too generic to settle the question on their own. "Graduate Engineer
 * Trainee" is automotive R&D at Valeo and software at Wipro; only the
 * description tells them apart.
 */
const GENERIC = new Set([
  'engineer', 'engineering', 'technical', 'technology', 'r&d',
  'research and development', 'engineering intern', 'engineering trainee',
  'technical intern', 'interim engineering', 'trainee', 'apprentice',
]);

/**
 * Should this title be sent to Gemini with its description?
 *
 * True when the vocabulary could not decide, or when it decided on nothing more
 * than a generic engineering word.
 */
export function needsDescription(title, options = {}) {
  const { verdict, matched } = classifyRole(title, options);
  if (verdict === 'uncertain') return true;
  if (verdict === 'tech' && matched && GENERIC.has(matched.toLowerCase())) {
    // A generic match only makes the title ambiguous if nothing SPECIFIC also
    // matched. "Software Engineering Intern (Full Stack)" came back generic
    // purely because classifyRole prefers the longest phrase, and
    // "engineering intern" is longer than "full stack" — even though the
    // specific term is right there and settles it. Left alone, that sent a
    // plainly technical title off for a description read, and once the
    // watchlist became a trust signal it dropped the role entirely.
    const specific = [...(options.extraPositive ?? []), ...POSITIVE_SORTED]
      .some((t) => !GENERIC.has(t.toLowerCase()) && hasTerm(title, t));
    return !specific;
  }
  return false;
}

export function isSoftwareRole(title, { includeUncertain = false, ...options } = {}) {
  const { verdict } = classifyRole(title, options);
  return verdict === 'tech' || (includeUncertain && verdict === 'uncertain');
}

/**
 * Let this vocabulary overrule a model verdict, in one direction only.
 *
 * If the configured terms confidently call a role non-engineering, that stands
 * whatever the model thinks. Those terms are added deliberately, in response to
 * something wrong actually reaching the site, so they are evidence rather than
 * opinion. The reverse is not true: a role the vocabulary cannot settle is
 * exactly what the model is here to decide.
 *
 * The ROLE LABEL is read as well as the title, because employers who post
 * everything under one generic title give the vocabulary nothing else to bite
 * on. American Express posts every internship as the bare word "Apprentice",
 * which is how "Credit Risk Analyst" reached an engineering-only board.
 *
 * The label is a FALLBACK, consulted only when the title settles nothing. It
 * must not outrank a confident title: labels name the business domain as often
 * as the work, and BNP Paribas' "Data Science Intern" is labelled "Financial
 * NLP modelling" — with `financial` a negative term, letting the label win
 * would drop a real data science role to catch a credit risk one.
 *
 * Lives here rather than beside either classifier because there are two of
 * them and only one was ever wired up.
 */
export function vetoNonTech(title, roleLabel, modelVerdict, cfg = {}) {
  const extraNegative = cfg.matching?.extraNonTechTerms ?? [];
  const titleOnly = cfg.matching?.titleOnlyNonTechTerms ?? [];

  const options = {
    extraPositive: cfg.matching?.extraTechTerms ?? [],
    extraNegative,
  };

  /* THE LABEL PASS IS NARROWER THAN THE TITLE PASS, and this is the whole
     point of titleOnlyNonTechTerms. A title is written by the employer; a
     roleLabel is the local model's own free-text summary of the description,
     so a term blunt enough to be safe on a title can be badly wrong on a
     label. `technical support` is the measured case: HPE files real
     engineering internships as the bare title "College Intern" — the posting
     itself demands a Computer Science degree and Python/Java/C++ — and the
     model labels the work "Technical Support" because the duties say
     troubleshoot and support. The title settles nothing, so the label decided
     and the role was dropped from an engineering-only board.

     Restricting the term to the title costs nothing on the roles it was added
     for: IBM's "Technical Support Representative Intern" says it in the TITLE
     and is still refused there, and `support representative` catches it a
     second time. Measured over 30 days, the term vetoed 10 rows — 7 IBM
     (title, correctly refused), 2 HPE (label, wrongly refused) and 1 Emerson.

     Same shape as the `risk analyst` term that was tried and removed for
     flipping Zscaler's Insider Risk Analyst. */
  const labelOptions = titleOnly.length
    ? { ...options, extraNegative: extraNegative.filter((t) => !titleOnly.includes(t)) }
    : options;

  const verdictOf = (t, o = options) => (typeof t === 'string' && t.trim()
    ? classifyRole(t, o).verdict
    : 'uncertain');

  const fromTitle = verdictOf(title);
  if (fromTitle === 'non-tech') return false;
  if (fromTitle === 'uncertain' && verdictOf(roleLabel, labelOptions) === 'non-tech') return false;

  return typeof modelVerdict === 'boolean' ? modelVerdict : null;
}
