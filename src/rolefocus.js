/**
 * THE ROLE FOCUS — which kinds of role the site carries at all.
 *
 * His call, 25 Sep 2026: "our main focus is on software based roles, ml, ai,
 * qa, devops etc … not these niche roles, they are just polluting the
 * website". He picked the categories to keep from a menu built off the live
 * board (config `roleFocus.keep`); everything else comes off the website, and
 * so out of every channel, digest and reel (they only carry what is
 * published), and is refused BEFORE it is opened, so it costs the LinkedIn
 * account nothing.
 *
 * This sits ON TOP OF the engineering classifier (is_tech in roles.js), not
 * instead of it: that decides "is this engineering", this decides "is it an
 * engineering role this site is FOR". It is deliberately coarse — broad
 * families, read off the title first.
 *
 * TWO READINGS, AND THE ORDER MATTERS:
 *  - the TITLE decides when it names a discipline. "Mechanical Engineering
 *    Intern" and "Salesforce Developer" are what they say.
 *  - a VAGUE title — "Engineering Intern", "Systems Engineer", "Research
 *    Engineer", a consultant title, or one naming nothing — can be RESCUED by
 *    the posting's own role label (roles written by the enricher after reading
 *    the description: "Software Development", "Data Analysis"). A label can
 *    only ever keep a posting, never remove one.
 *
 * Before an open there is no label yet, and every open is a page load on the
 * LinkedIn account, so the scan refuses any title naming a family outside the
 * focus; only a title naming no discipline at all is opened (refuseBeforeOpen).
 *
 * Pure: no config, store or I/O here. The families are matched first to last,
 * so a specific family must sit above a general one ("Software Engineer in
 * Test" is QA before it is software; "Robotics Software Intern" is software
 * before it is robotics).
 */

export const ROLE_FAMILIES = [
  ['ai_training', 'AI training-data gigs', /coding expert|scientific coding|ai trainer|ai quality analyst|annotat|data label|\brater\b|ai tutor|writing expert|prompt engineer/],
  ['qa', 'QA / testing / SDET', /\bqa\b|quality assurance|\bsdet\b|engineer in test|software test|test automation|automation test|testing|software quality|\btester\b|test engineer|\btest\b|systest|quality automation/],
  ['security', 'Cybersecurity', /cyber|security|infosec|penetration|appsec|threat|vulnerab|identity & access|\biam\b|soc analyst/],
  ['devops', 'DevOps / cloud / SRE', /devops|dev ops|\bsre\b|site reliability|\bcloud\b|platform engineer|infrastructure|kubernetes|\bk8s\b|terraform|release engineer|build engineer/],
  ['ai_ml', 'AI / ML / data science', /machine learning|deep learning|\bml\b|\bai\b|artificial intelligence|gen ?ai|generative|\bllm|\bnlp\b|computer vision|perception|data scien|applied scien|mlops|reinforcement|agentic/],
  // A title that SAYS software engineer/developer is software, whatever else it
  // names — Google's "Software Engineer, PhD … Networking" and Nationwide's
  // "Software Engineer - COBOL/Mainframe" were filed as IT and platform roles.
  ['swe', 'Software engineering', /software (engineer|developer|development|engineering)|\bsde\b|\bswe\b/],
  ['it_support', 'IT support / networking', /application support|production support|it support|help ?desk|service desk|technical support|desktop support|\bdesktop\b|network|system administrator|sysadmin|data cent(er|re)|information technology|\bit (intern|analyst|engineer|operations|trainee)|it operations/],
  ['data_eng', 'Data engineering / analytics', /data engineer|data platform|\betl\b|big data|analytics engineer|\bbi\b|business intelligence|data analy|analytics|power bi|tableau|databricks|snowflake|data warehouse|visuali[sz]ation|dashboard|\bdata\b/],
  ['fullstack', 'Full-stack', /full ?-?stack|\bmern\b|mean stack/],
  ['frontend', 'Frontend / web', /ux engineer|user experience engineer|front ?-?end|\breact\b|angular|\bvue\b|web develop|ui developer|javascript|typescript/],
  ['mobile', 'Mobile', /android|\bios\b|mobile|flutter|react native|\bswift\b|kotlin/],
  ['backend', 'Backend', /back ?-?end|\bjava\b|golang|\bnode\b|django|spring boot|\.net\b|\bc#|\bapi\b|microservice|python developer/],
  ['embedded', 'Embedded / firmware', /embedded|firmware|\brtos\b|autosar|\bbsp\b|device driver|microcontroller/],
  ['enterprise', 'SAP / Salesforce / ServiceNow', /\bsap\b|salesforce|servicenow|oracle|workday|dynamics 365|\bcrm\b|\berp\b|guidewire|\bpega\b|appian|mulesoft|sitecore|\baem\b|power platform|cobol|mainframe/],
  ['game_graphics', 'Games / graphics / 3D', /\bgame|graphics|\bunity\b|unreal|\bvr\b|\bar\/vr|\b3d\b|rendering|animation|level design/],
  ['swe', 'Software engineering', /software|\bsde\b|\bswe\b|developer|programmer|programming|coding|compiler|computer science|applications? engineer|applications? development|\bdevt\b/],
  ['hardware', 'Hardware / VLSI / RF', /\basic\b|vlsi|\brtl\b|fpga|silicon|design verification|digital verification|physical design|analog|mixed.signal|hardware|semiconductor|circuit|\bpcb\b|\bdft\b|\bic\b|\bchip|\brf\b|antenna|dram|photolitho|\byield\b|characteri[sz]ation|process integration|wafer|validation|\bsoc\b|\bverification\b|\bgpu\b|baseband|\bdsp\b|signal processing|modem/],
  ['robotics', 'Robotics / controls', /robot|autonom|mechatronic|\bslam\b|controls engineer|control systems|\bcontrols\b/],
  ['ux', 'UX / product design', /\bux\b|user experience|ui\/ux|interaction design|product design/],
  ['research', 'Research / quant / PhD', /research|\bquant|scientist|\bphd\b|ph\.d|r&d/],
  ['product', 'Product / consulting', /product manager|program manager|product management|project manager|solution|consultant|consulting|business analyst|technical account|pre-?sales|sales engineer|implementation|project controls/],
  ['systems', 'Systems engineering', /systems? engineer|systems engineering|systems integration/],
  ['core_eng', 'Core engineering (mech / elec / civil / mfg)', /mechanical|electrical|electronic|civil|structural|manufactur|process|chemical|aerospace|industrial|power|energy|nuclear|reliability|maintenance|\bfield\b|service engineer|production|supply chain|quality|hydraulic|building|hvac|thermal|material|\bgis\b|environmental|water|transport|construction|plant|mining|metallurg|biomedical|medical|\bgas\b|packaging|\bcad\b|design engineer|equipment|optical|photonic|avionic|propulsion|flight/],
];

export const ROLE_LABELS = Object.fromEntries([
  ...ROLE_FAMILIES.map(([key, label]) => [key, label]),
  ['generic', 'Generic engineering intern (no discipline named)'],
  ['other', 'Unclassified'],
]);

/** Families whose title does not settle it: the posting's own label may rescue it. */
export const VAGUE_FAMILIES = new Set(['research', 'product', 'systems', 'core_eng', 'it_support', 'robotics', 'generic', 'other']);

const GENERIC = /engineer|intern|co-?op|trainee|apprentice|graduate|technolog|technical|associate|analyst/;

/** The family a piece of text names, or 'generic' / 'other'. */
export function roleFamily(text) {
  const t = String(text ?? '').toLowerCase();
  for (const [key, , rx] of ROLE_FAMILIES) if (rx.test(t)) return key;
  return GENERIC.test(t) ? 'generic' : 'other';
}

/**
 * Is this posting inside the focus?  `keep` is the list of family keys to keep;
 * an absent or empty list keeps everything (a config without `roleFocus` —
 * every test fixture — behaves exactly as before).
 *
 * Returns { keep, family, from } — `from` says which reading decided: 'title',
 * or 'label' when a vague title was rescued by the posting's role label.
 */
export function roleFocusVerdict({ title, roleLabel } = {}, keep) {
  const family = roleFamily(title);
  if (!Array.isArray(keep) || !keep.length) return { keep: true, family, from: 'off' };
  if (keep.includes(family)) return { keep: true, family, from: 'title' };
  if (VAGUE_FAMILIES.has(family) && roleLabel) {
    const byLabel = roleFamily(roleLabel);
    if (keep.includes(byLabel)) return { keep: true, family: byLabel, from: 'label' };
  }
  return { keep: false, family, from: 'title' };
}

/**
 * Before an open there is only the title, and every open is a page load on the
 * LinkedIn account — the budget he is most careful of. So a title naming ANY
 * family outside the focus is refused here, the vague named ones (research,
 * systems, consulting, core engineering) included; only a title naming no
 * discipline at all ("Intern", "Engineering Co-op") is opened and judged at
 * publish on its label. The label rescue still applies at publish to careers-
 * board rows, which cost the account nothing. Returns the family refused, or
 * null to carry on.
 */
export function refuseBeforeOpen(title, keep) {
  if (!Array.isArray(keep) || !keep.length) return null;
  const family = roleFamily(title);
  if (keep.includes(family) || family === 'generic' || family === 'other') return null;
  return family;
}
