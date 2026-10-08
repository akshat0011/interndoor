/**
 * THE ROLE CATEGORY — software, hardware or misc.
 *
 * His call, 25 Sep 2026, in two steps. First (morning): "our main focus is on
 * software based roles, ml, ai, qa, devops etc … not these niche roles, they
 * are just polluting the website" — he picked the families to keep from a menu
 * built off the live board, and everything else came off the site. Then, the
 * same afternoon, reversed into this: NOTHING is dropped and nothing stops
 * being scraped. Every engineering posting stays on the site, filed under
 * Software, Hardware or Misc on both the Internships and Full-time tabs — and
 * a Misc posting is not announced on the WhatsApp channel or made into a reel.
 * (config `roleFocus.software` / `roleFocus.hardware`; anything else is misc.)
 *
 * This sits ON TOP OF the engineering classifier (is_tech in roles.js), not
 * instead of it: that decides "is this engineering at all", this decides which
 * shelf it goes on. It is deliberately coarse — broad families, read off the
 * title first.
 *
 * TWO READINGS, AND THE ORDER MATTERS:
 *  - the TITLE decides when it names a discipline. "Mechanical Engineering
 *    Intern" and "Salesforce Developer" are what they say.
 *  - a title that names NO discipline — "Apprentice Hiring for 2026-2027",
 *    "2027 Technology Program Intern", "Interim Engineering Intern_Systems",
 *    "Systems Intern" — is SOFTWARE. His words, with those four as the
 *    examples: "will be kept in software, not misc". The posting's own role
 *    label (written by the enricher) may move it to Hardware, or to Misc when
 *    it names a core-engineering discipline ("Mechanical Design"), and nothing
 *    else: Wells Fargo's technology programme carries the labels "Policy
 *    Review" and "Technical Support", and a label that noisy must not file a
 *    bank's technology intake under Misc.
 *  - a title naming a family outside both sets but loosely (research, IT,
 *    consulting, robotics, core engineering) is Misc unless its label names a
 *    kept family — "Associate IT Engineer" whose posting is front-end work.
 *
 * Pure: no config, store or I/O here. The families are matched first to last,
 * so a specific family must sit above a general one ("Software Engineer in
 * Test" is QA before it is software; "Robotics Software Intern" is software
 * before it is robotics).
 */

export const ROLE_FAMILIES = [
  ['ai_training', 'AI training-data gigs', /coding expert|scientific coding|ai trainer|ai quality analyst|annotat|data label|\brater\b|ai tutor|writing expert|prompt engineer/],
  /* THE 8 OCT 2026 AUDIT OF EVERY SOFTWARE-SHELF ROLE (his "check every
     software role … whichever arent software, move them to misc and make sure
     new roles of that category go to misc"). Each family below names work that
     was sitting on Software, read off the live board role by role. ABOVE the
     software families, because most of these titles also carry a software
     word ("AI", "platform", "security", "data"). A title that says software
     engineer / developer, or data analyst / engineer / scientist, keeps its own
     family — his standing rules.

     Business, consulting and programme work: Accenture's "S&C Global Network -
     AI - … - Analyst" (strategy & consulting), McKinsey's "AI Solutions Analyst
     - Banking Market Intelligence", General Mills' "D&T Analyst – AI &
     Automation", Komodo's "AI Solutions Specialist - Implementations", DeHaat's
     "Program Intern", Chainalysis' "Deployment Strategist", Rockwell's and
     Arcesium's "Product Specialist", customer-insights and commercial analysts,
     developer relations, placement, trainers. */
  ['business', 'Business / consulting / programmes', /^(?!.*\b(?:software (?:engineer|developer|development)|developer(?! relation)|application development|backend|frontend|full ?stack|data analy\w*|data engineer\w*|data scien\w*)\b).*(?:s&c global network|global network|#acn|\bgn-|strategist|product specialist|customer insights|commercial analyst|business operations|business analyst|developer relation\w*|\bdevrel\b|\bdevre\b|placement|\btrainer\b|tech(?:nical)? enablement|market intelligence|\bprogrammes?\b.*\bintern|\bprograms\b|account research|solutions specialist|implementations?\b|\bd&t analyst)/],
  /* Managed-services and operations support, named by the title: NTT DATA's
     "MS Engineer L2, Linux", "MS Security Engineer", "Cross Technology Managed
     Services Middleware Engineer (L2)", Hilton's "IT Coordinator", Ericsson's
     "Alarm Monitoring Engineer", "Database Support Engineer", "Product Sppt
     Trainee". Above `security`, which "MS Security Engineer" would otherwise
     hit first. */
  ['it_support', 'IT support / networking', /^(?!.*\bsoftware (?:engineer|developer)\b).*(?:managed services|\bms (?:engineer|security engineer|technical specialist)\b|\bms engineer\b|support (?:engineer|analyst)|production support|product (?:support|sppt)|\bsppt\b|customer support|it coordinator|alarm monitoring|monitoring engineer|control[- ]m\b|application owner|\bitao\b|data capture)/],
  /* Design, civil, mechanical and plant work the core families did not name:
     Jacobs' "Apprentice Engineer - Highways" and "- Telecom" (infrastructure
     design), GE Vernova's "Turbine - System Integrator", Otis's elevator
     mechanic, NewSpace's "Intern - Structures", Oceaneering's "Integrity
     Engineer" (oil & gas), EXL's "Cat Modeler" (insurance catastrophe models),
     Cognizant's "GeoSpatial Analyst", Cyncly's "3D Design Engineer" (CAD),
     Eaton's product-data steward. */
  ['core_eng', 'Core engineering (mech / elec / civil / mfg)', /^(?!.*\b(?:software|developer|data engineer\w*|data analy\w*|data scien\w*)\b).*(?:\bhighways?\b|apprentice engineer - telecom|\bturbine\b|\belevator\b|\bmechanic\b|\bstructures\b|integrity engineer|geo ?spatial|cat model\w*|3d design|data management|product data|technical assistant|biopharma\w*|pharmaceutical)/],
  /* Visual and UI design, which the UX family's words did not reach. */
  ['ux', 'UX / product design', /^(?!.*\b(?:developer|engineer)\b).*(?:visual design|graphic design|\bui design)/],
  ['qa', 'QA / testing / SDET',/\bqa\b|quality assurance|\bsdet\b|engineer in test|software test|test automation|automation test|testing|software quality|\btester\b|test engineer|\btest\b|systest|quality automation/],
  /* SECURITY OPERATIONS IS NOT SECURITY ENGINEERING (7 Oct 2026, his call on
     MUFG's "Incident Reponse - Analyst": "not software or the ones we are
     interested in"). Incident response, SOC monitoring, threat-intel and GRC
     analysts are Misc; `security` below keeps engineers, developers,
     architects, appsec and pen testing. The analyst arm is a security-themed
     title whose role is "analyst" and that names no engineer — measured on the
     live India board: 9 roles moved, every one an analyst. */
  ['secops', 'Security operations / GRC', /\bincident\b|\bc?sirt\b|\bcirt\b|\bedr analyst|security operations|\bsiem\b|forensic|\bgrc\b|governance,? risk|^(?!.*\b(?:engineer|engineering|developer|architect)\b)(?=.*(?:cyber|security|infosec|vulnerab|threat|\bsoc\b)).*\banalyst/],
  /* FINANCE AND MARKETS WORK IS NOT SOFTWARE (8 Oct 2026, his call on
     Nomura's "Global Markets – Securitized Products - Asset Management -
     Analyst", which read as generic on "Analyst" and so as Software).
     Guarded: a title naming software, a developer or engineer, or a data
     analyst / engineer / scientist keeps its own family ("keep data analyst"). */
  ['finance', 'Finance / markets / risk', /^(?!.*\b(?:software|developer|engineer|engineering|programmer|data analy\w*|data engineer|data scien\w*)\b).*(?:global markets|securiti[sz]ed|\bsecurities\b|fixed income|equity research|investment banking|asset management|wealth management|private equity|credit risk|market risk|risk management|\btreasury\b|\btrading\b|derivatives|fund accounting|\bvaluation\b|financial analyst|finance analyst)/],
  /* MES — MANUFACTURING EXECUTION SYSTEMS — IS PLANT WORK (8 Oct 2026, his call
     on Birlasoft's "Apriso MES Machine Integrator", which named no family and
     so stayed Software). Filed with core engineering. */
  ['core_eng', 'Core engineering (mech / elec / civil / mfg)', /^(?!.*\bsoftware (?:engineer|developer)\b).*(?:\bmes\b|apriso|manufacturing execution)/],
  ['security', 'Cybersecurity', /cyber|security|infosec|penetration|appsec|threat|vulnerab|identity & access|\biam\b|soc analyst/],
  /* ABOVE devops, because "IFS Cloud Developer" (Rockwell) read as DevOps on
     the bare word "cloud" while the model rightly called it ERP. Guarded so a
     title that says software engineer/developer stays Software (his standing
     rule — SocGen's "Software Engineer - PEGA"), and so Eaton's "IT ERP, SAP AI
     & DEVSECOPS" apprenticeship, kept on Software on 30 Sep, stays there. */
  ['enterprise', 'SAP / Salesforce / ServiceNow', /^(?!.*(?:software (?:engineer|developer|development)|devsecops|\bai\b|\bml\b)).*(?:\bifs\b|\bsap\b|salesforce|servicenow|workday|dynamics 365|guidewire|\bpega\b|\binfor\b|\bmsd\b|dynamics|oracle (?:fusion|ebs|erp|hcm|scm|apps|apex|cx))/],
  /* END-USER COMPUTING IS IT SUPPORT, whatever the title calls it: Macquarie's
     "Workspace and Applications SRE" is Windows endpoint management (its own
     label), Zensar's "MDM-INTUNE" is device management. Above devops for the
     same reason as the line above. Rescuable by label like any IT title. */
  ['it_support', 'IT support / networking', /^(?!.*\bsoftware (?:engineer|developer)).*(?:\bworkspace\b|end[\s-]?user|endpoint|digital workplace|\beuc\b|intune|\bvdi\b|citrix|\bm365\b|office 365|active directory)/],
  ['devops', 'DevOps / cloud / SRE', /devops|dev ops|\bsre\b|site reliability|\bcloud\b|platform engineer|infrastructure|kubernetes|\bk8s\b|terraform|release engineer|build engineer/],
  ['ai_ml', 'AI / ML / data science', /machine learning|deep learning|\bml\b|\bai\b|artificial intelligence|gen ?ai|generative|\bllm|\bnlp\b|computer vision|perception|data scien|applied scien|mlops|reinforcement|agentic/],
  // A title that SAYS software engineer/developer is software, whatever else it
  // names — Google's "Software Engineer, PhD … Networking" and Nationwide's
  // "Software Engineer - COBOL/Mainframe" were filed as IT and platform roles.
  ['swe', 'Software engineering', /software (engineer|developer|development|engineering)|\bsde\b|\bswe\b|(?:\b|_)sw\b/],
  ['it_support', 'IT support / networking', /application support|production support|it support|help ?desk|service desk|technical support|desktop support|\bdesktop\b|network|system administrator|sysadmin|data cent(er|re)|information technology|\bit (intern|analyst|engineer|operations|trainee)|it operations/],
  /* REPORTING IS NOT SOFTWARE. Amgen's "Associate Field Reporting" builds
     Tableau dashboards for sales reps, and he asked the obvious question of it
     on the live board: "this is not tech or software is it?". So dashboards,
     BI tools and reporting sit here, ABOVE data engineering, which keeps the
     pipelines, platforms and warehouses. A bare "data analyst" stays in data
     engineering / analytics, the family he kept. */
  /* BUSINESS-SIDE ANALYTICS IS MISC TOO (26 Sep 2026, his "why did this
     business analytics intern make it"): Turtlemint's marketing analytics,
     TikTok's product strategy, Seagate's marketing analytics and Ericsson's
     people analytics all sat on Software on the word "analytics" alone. A
     title that also says data analyst / engineer / scientist keeps its data
     family — "keep data analyst", his call. */
  ['analytics', 'Reporting / BI / dashboards', /business intelligence|\bbi\b|power bi|tableau|dashboard|reporting|\bmis\b|visuali[sz]ation|^(?!.*\bdata\s+(?:analy|engineer|scien)).*\b(?:business|marketing|sales|product|customer|commercial|revenue|people|hr|financial|finance|operations)\s+analytics?\b/],
  ['data_eng', 'Data engineering / analytics', /data engineer|data platform|\betl\b|big data|analytics engineer|data analy|analytics|databricks|snowflake|data warehouse|\bdata\b/],
  ['fullstack', 'Full-stack', /full ?-?stack|\bmern\b|mean stack/],
  ['frontend', 'Frontend / web', /ux engineer|user experience engineer|front ?-?end|\breact\b|angular|\bvue\b|web develop|ui developer|javascript|typescript/],
  ['mobile', 'Mobile', /android|\bios\b|mobile|flutter|react native|\bswift\b|kotlin/],
  ['backend', 'Backend', /back ?-?end|\bjava\b|golang|\bnode\b|django|spring boot|\.net\b|\bc#|\bapi\b|microservice|python developer/],
  ['embedded', 'Embedded / firmware', /embedded|firmware|\brtos\b|autosar|\bbsp\b|device driver|microcontroller/],
  ['enterprise', 'SAP / Salesforce / ServiceNow', /\bsap\b|salesforce|servicenow|oracle|workday|dynamics 365|\bcrm\b|\berp\b|guidewire|\bpega\b|appian|mulesoft|sitecore|\baem\b|power platform|cobol|mainframe/],
  ['game_graphics', 'Games / graphics / 3D', /\bgame|graphics|\bunity\b|unreal|\bvr\b|\bar\/vr|\b3d\b|rendering|animation|level design/],
  ['swe', 'Software engineering', /software|\bsde\b|\bswe\b|developer|programmer|programming|coding|compiler|computer science|applications? engineer|applications? development|\bdevt\b/],
  ['hardware', 'Hardware / VLSI / RF', /\basic\b|vlsi|\brtl\b|fpga|silicon|design verification|digital verification|physical design|analog|mixed.signal|hardware|(?:\b|_)hw\b|electronic|semiconductor|circuit|\bpcb\b|\bdft\b|\bic\b|\bchip|\brf\b|antenna|dram|photolitho|\byield\b|characteri[sz]ation|process integration|wafer|validation|\bsoc\b|\bverification\b|\bgpu\b|baseband|\bdsp\b|signal processing|modem/],
  ['robotics', 'Robotics / controls', /robot|autonom|mechatronic|\bslam\b|controls engineer|control systems|\bcontrols\b/],
  ['ux', 'UX / product design', /\bux\b|user experience|ui\/ux|interaction design|product design/],
  ['research', 'Research / quant / PhD', /research|\bquant|scientist|\bphd\b|ph\.d|r&d/],
  ['product', 'Product / consulting', /product manager|program manager|product management|project manager|solution|consultant|consulting|business analyst|technical account|pre-?sales|sales engineer|implementation|project controls/],
  ['systems', 'Systems engineering', /systems? engineer|systems engineering|systems integration/],
  ['core_eng', 'Core engineering (mech / elec / civil / mfg)', /mechanical|electrical|civil|structural|manufactur|process|chemical|aerospace|industrial|power|energy|nuclear|reliability|maintenance|\bfield\b|service engineer|production|supply chain|quality|hydraulic|building|hvac|thermal|material|\bgis\b|environmental|water|transport|construction|plant|mining|metallurg|biomedical|medical|\bgas\b|packaging|\bcad\b|design engineer|equipment|optical|photonic|avionic|propulsion|flight/],
];

export const ROLE_LABELS = Object.fromEntries([
  ...ROLE_FAMILIES.map(([key, label]) => [key, label]),
  ['generic', 'Generic engineering role (no discipline named)'],
  ['other', 'Unclassified'],
]);

export const CATEGORIES = ['software', 'hardware', 'misc'];

/** Titles that name no discipline: Software unless the label says otherwise. */
export const OPEN_FAMILIES = new Set(['generic', 'other', 'systems']);
/** Titles that name a misc family loosely: Misc unless the label rescues them. */
export const RESCUABLE_FAMILIES = new Set(['research', 'product', 'it_support', 'robotics', 'core_eng', 'analytics']);
/* A LABEL CANNOT RESCUE ON "TESTING" OR "ANALYSIS". Those two words are in half
   the labels the enricher writes for non-software work — "Propulsion Testing",
   "Reliability Testing", "Quality Data Analysis", "Transportation Analytics" —
   and they read as QA and data engineering. Measured on the live boards before
   this was added: they were most of what a label rescued out of core
   engineering. */
/* …NOR INTO HARDWARE (8 Oct 2026): GE Vernova's "Post Doctoral Fellow
   Materials" is core engineering by its title, and its label "Materials
   Validation" read as hardware on "validation" — so it was filed Hardware and
   posted to the WhatsApp channel. A loosely named misc title is rescued only
   onto Software now. */
const NO_RESCUE_INTO = new Set(['qa', 'data_eng', 'hardware']);

const GENERIC = /engineer|intern|co-?op|trainee|apprentice|graduate|technolog|technical|associate|analyst/;

/** The family a piece of text names, or 'generic' / 'other'. */
export function roleFamily(text) {
  const t = String(text ?? '').toLowerCase();
  for (const [key, , rx] of ROLE_FAMILIES) if (rx.test(t)) return key;
  return GENERIC.test(t) ? 'generic' : 'other';
}

/**
 * Which shelf a posting goes on. `focus` is config `roleFocus`:
 * { software: [family…], hardware: [family…] }. An absent focus files
 * everything under software, so a config without it — every test fixture —
 * shows one shelf and hides nothing.
 *
 * Returns { category, family, from } — `from` says which reading decided:
 * 'title', 'label', or 'open' (a title naming no discipline, left in software).
 */
export function roleCategory({ title, roleLabel } = {}, focus) {
  const family = roleFamily(title);
  const software = focus?.software ?? [];
  const hardware = focus?.hardware ?? [];
  if (!software.length && !hardware.length) return { category: 'software', family, from: 'off' };
  const shelf = (f) => (software.includes(f) ? 'software' : hardware.includes(f) ? 'hardware' : null);

  const byTitle = shelf(family);
  if (byTitle) return { category: byTitle, family, from: 'title' };

  const byLabelFamily = roleLabel ? roleFamily(roleLabel) : null;
  if (OPEN_FAMILIES.has(family)) {
    if (byLabelFamily && hardware.includes(byLabelFamily)) return { category: 'hardware', family: byLabelFamily, from: 'label' };
    if (byLabelFamily === 'core_eng') return { category: 'misc', family: byLabelFamily, from: 'label' };
    return { category: 'software', family, from: 'open' };
  }
  if (RESCUABLE_FAMILIES.has(family) && byLabelFamily && !NO_RESCUE_INTO.has(byLabelFamily)) {
    const rescued = shelf(byLabelFamily);
    if (rescued) return { category: rescued, family: byLabelFamily, from: 'label' };
  }
  return { category: 'misc', family, from: 'title' };
}

/**
 * ONE SHELF PER ROLE. A role advertised in several cities is several rows, and
 * the enricher labels each copy on its own — Northrop's "2027 Intern Systems
 * Engineer" read "Systems Integration" in five cities and "Systems
 * Maintenance" in two — so the label rescue filed one role on two shelves and
 * the board showed it under Software AND Misc. Measured on the live US board,
 * 25 Sep 2026: 4 roles split that way.
 *
 * Rows are grouped by the key the board collapses cards on (company, title,
 * the posting's own fingerprint — app.js roleKey), and every copy gets one
 * shelf: a kept shelf beats Misc, because a label can only ever KEEP a
 * posting; between Software and Hardware the one more copies name wins, a tie
 * going to Software. Returns the rows with `category` settled; nothing else is
 * touched.
 */
export function settleShelves(jobs) {
  const keyOf = (j) => [
    String(j.company ?? '').toLowerCase().trim(),
    String(j.title ?? '').toLowerCase().trim(),
    j.roleFingerprint || `id:${j.id}`,
  ].join('|');
  const tally = new Map();
  for (const j of jobs) {
    const t = tally.get(keyOf(j)) ?? { software: 0, hardware: 0, misc: 0 };
    t[j.category] = (t[j.category] ?? 0) + 1;
    tally.set(keyOf(j), t);
  }
  const shelfOf = (t) => {
    if (!t.software && !t.hardware) return 'misc';
    return t.hardware > t.software ? 'hardware' : 'software';
  };
  return jobs.map((j) => {
    const settled = shelfOf(tally.get(keyOf(j)));
    return settled === j.category ? j : { ...j, category: settled };
  });
}

/**
 * The shelf a channel may announce. Misc stays on the site and off the
 * channels: WhatsApp, the reels, the US Telegram channel and the email digest
 * (his call, 25 Sep 2026). It IS eligible for the weekly LinkedIn roundup,
 * which reads the plain published set (publishedIdsFor) and so needs nothing
 * here.
 */
export const announceable = (category) => category !== 'misc';

/** The ids in a published jobs.json a channel may announce — for callers that start from store rows. */
export const announceableIds = (jobs) => new Set((jobs ?? []).filter((j) => announceable(j.category)).map((j) => String(j.id)));
