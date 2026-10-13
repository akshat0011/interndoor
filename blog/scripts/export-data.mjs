#!/usr/bin/env node
/* Writes the figures the posts chart into blog/content/data.

     node --no-warnings blog/scripts/export-data.mjs

   Runs on this Mac only: it reads the store (jobs.db) and the main site's code.
   The blog build never does; it reads the JSON this writes, which is committed,
   so a published figure cannot change unless this is re-run and the change is
   reviewed in the diff.

   Two kinds of figure, and the files say which:
   - FROZEN: copied from a monthly snapshot (settings `insight:IN:YYYY-MM`),
     which src/insights.js compiles once and never again. These match
     interndoor.com/insights exactly.
   - DERIVED: counted here over the same month's rows, with the main site's
     own row rules (src/datapost.js dataRows). Each derived set records the
     row count it saw, and the script refuses to write if September's count
     no longer equals the frozen 425, because then the two would disagree. */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'content', 'data');

const { Store } = await import(join(APP, 'src/store.js'));
const { loadConfig, matchCompany, isBlockedCompany } = await import(join(APP, 'src/config.js'));
const { dataRows } = await import(join(APP, 'src/datapost.js'));
const { monthBounds } = await import(join(APP, 'src/insights.js'));
const { roleCategory } = await import(join(APP, 'src/rolefocus.js'));
const { durationText } = await import(join(APP, 'src/pages.js'));
const { resolveRowRegion } = await import(join(APP, 'src/regions.js'));

const cfg = loadConfig();
const store = new Store();
const ZONE = 'Asia/Kolkata';
const pct = (n, of) => Math.round((100 * n) / of);
const write = (name, obj) => writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(obj, null, 2)}\n`);

function snapshot(key) {
  const row = store.db.prepare('SELECT value FROM settings WHERE key = ?').get(`insight:IN:${key}`);
  if (!row) throw new Error(`No frozen snapshot for ${key}`);
  return JSON.parse(row.value);
}
const section = (snap, id) => snap.sections.find((s) => s.id === id);

function monthRows(key) {
  const [a, b] = monthBounds(key, ZONE);
  const data = dataRows(store, cfg, { region: 'IN', now: b, days: (b - a) / 864e5 });
  return data.history.filter((r) => r.firstSeen >= a && r.firstSeen < b);
}

const SEP = snapshot('2026-09');
const AUG = snapshot('2026-08');
const sep = monthRows('2026-09');
if (sep.length !== SEP.rows) throw new Error(`September re-derives to ${sep.length} rows, the frozen report says ${SEP.rows}. Stop and look.`);
const get = store.db.prepare('SELECT * FROM jobs WHERE job_id = ?');
const sepJobs = sep.map((r) => ({ r, j: get.get(r.id) }));

const insightsSource = { label: 'InternDoor, Engineering internships in India: September 2026', url: 'https://interndoor.com/insights/2026-09' };
const derivedSource = { label: 'InternDoor postings data, September 2026 (see How we count)', url: 'https://blog.interndoor.com/methodology' };

/* --------------------------------------------------------- September 2026 */

const byEmp = new Map();
for (const r of sep) byEmp.set(r.employer, (byEmp.get(r.employer) ?? 0) + 1);
const tail = { one: [0, 0], few: [0, 0], many: [0, 0] };
for (const v of byEmp.values()) { const k = v === 1 ? 'one' : v <= 4 ? 'few' : 'many'; tail[k][0]++; tail[k][1] += v; }

const shelf = { software: 0, hardware: 0, misc: 0 };
for (const { j } of sepJobs) shelf[roleCategory({ title: j.title, roleLabel: j.role_label }, cfg.roleFocus).category]++;

const mode = { onsite: 0, hybrid: 0, remote: 0, none: 0 };
for (const r of sep) {
  if (r.mode === 'onsite') mode.onsite++;
  else if (r.mode === 'hybrid') mode.hybrid++;
  else if (r.mode === 'remote') mode.remote++;
  else mode.none++;
}

const bars = (snap, id, { unit = 'percent' } = {}) => section(snap, id).bars.map((b) => ({
  label: b.label, value: Number(String(b.value).replace('%', '')), display: unit === 'percent' ? b.value : undefined,
}));

write('sep2026', {
  id: 'sep2026',
  note: 'Frozen figures copied from the September 2026 snapshot; derived figures counted over the same 425 rows on export.',
  rows: SEP.rows,
  employers: SEP.employers,
  source: insightsSource,
  charts: {
    employers: {
      title: 'Who posted the most',
      subtitle: `Engineering internships posted in September 2026, the ten busiest of ${SEP.employers} employers`,
      unit: 'count', label: 'Employer', valueLabel: 'Postings',
      highlight: [section(SEP, 'employers').bars[0].label],
      rows: section(SEP, 'employers').bars.map((b) => ({ label: b.label, value: Number(b.value) })),
      note: 'One role posted in several cities counts once per city, so a count of postings is not a count of different jobs.',
    },
    tail: {
      title: 'Most employers posted once or twice',
      subtitle: `The ${SEP.employers} employers, by how many internships each posted in September`,
      unit: 'count', label: 'Postings per employer', valueLabel: 'Employers',
      highlight: ['Posted exactly one'],
      rows: [
        { label: 'Posted exactly one', value: tail.one[0], display: `${tail.one[0]} employers`, note: `${tail.one[1]} postings` },
        { label: 'Posted two to four', value: tail.few[0], display: `${tail.few[0]} employers`, note: `${tail.few[1]} postings` },
        { label: 'Posted five or more', value: tail.many[0], display: `${tail.many[0]} employers`, note: `${tail.many[1]} postings` },
      ],
      source: derivedSource,
    },
    cities: {
      title: 'Where the internships were',
      subtitle: `Share of all ${SEP.rows} September postings, by city`,
      unit: 'percent', max: 100, label: 'City', valueLabel: 'Share of postings',
      highlight: ['Bengaluru'],
      rows: bars(SEP, 'cities'),
      note: 'Six cities shown. A posting naming several cities counts under the first.',
    },
    mode: {
      title: 'Remote internships were rare',
      subtitle: `How the work is done, as stated on ${SEP.rows} September postings`,
      unit: 'percent', max: 100, label: 'Work arrangement', valueLabel: 'Share of postings',
      highlight: ['Remote'],
      rows: [
        { label: 'On-site', value: pct(mode.onsite, SEP.rows), display: `${pct(mode.onsite, SEP.rows)}%`, note: `(${mode.onsite})` },
        { label: 'Hybrid', value: pct(mode.hybrid, SEP.rows), display: `${pct(mode.hybrid, SEP.rows)}%`, note: `(${mode.hybrid})` },
        { label: 'Remote', value: pct(mode.remote, SEP.rows), display: `${pct(mode.remote, SEP.rows)}%`, note: `(${mode.remote})` },
        { label: 'Did not say', value: pct(mode.none, SEP.rows), display: `${pct(mode.none, SEP.rows)}%`, note: `(${mode.none})` },
      ],
      source: derivedSource,
    },
    shelves: {
      title: 'Mostly software',
      subtitle: `The ${SEP.rows} September postings, by the kind of engineering`,
      unit: 'count', label: 'Kind of role', valueLabel: 'Postings',
      highlight: ['Software, data and AI'],
      rows: [
        { label: 'Software, data and AI', value: shelf.software, note: `(${pct(shelf.software, SEP.rows)}%)` },
        { label: 'Hardware and embedded', value: shelf.hardware, note: `(${pct(shelf.hardware, SEP.rows)}%)` },
        { label: 'Other engineering', value: shelf.misc, note: `(${pct(shelf.misc, SEP.rows)}%)` },
      ],
      note: 'Sorted by InternDoor’s own reading of each title. Other engineering covers core engineering, research, IT, design and similar roles.',
      source: derivedSource,
    },
    days: {
      title: 'Weekdays, not weekends',
      subtitle: `The ${section(SEP, 'timing').bars.reduce((s, b) => s + Number(b.value), 0)} September postings found within hours of going up, by the day they were posted`,
      unit: 'count', label: 'Day', valueLabel: 'Postings',
      highlight: [section(SEP, 'timing').bars.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a)).label],
      rows: section(SEP, 'timing').bars.map((b) => ({ label: b.label, value: Number(b.value) })),
    },
    queue: {
      title: 'How many had applied when we found it',
      subtitle: 'The 333 September postings that showed an applicant count, at first sighting',
      unit: 'percent', max: 100, label: 'Applicants', valueLabel: 'Share of postings',
      highlight: ['100 or more'],
      rows: bars(SEP, 'queue'),
    },
  },
});

/* -------------------------------------------------- what postings state */

let dur = 0;
for (const { j } of sepJobs) if (durationText({ duration: j.duration })) dur++;
const statedMode = SEP.rows - mode.none;
const namedSkills = sep.filter((r) => r.skills.length).length;
/* Hand-checked against every posting's own text on 13 Oct 2026: the frozen
   report counted 19, and one of those was a company's founding year read as a
   dollar figure. See the stipends post. */
const STIPEND_VERIFIED = 18;

write('disclosure', {
  id: 'disclosure',
  source: derivedSource,
  charts: {
    sep: {
      title: 'What September’s postings told applicants',
      subtitle: `Share of the ${SEP.rows} engineering internship postings that stated each fact`,
      unit: 'percent', max: 100, label: 'Fact', valueLabel: 'Share of postings that stated it',
      highlight: ['The stipend'],
      rows: [
        { label: 'How the work is done', value: pct(statedMode, SEP.rows), display: `${pct(statedMode, SEP.rows)}%`, note: `(${statedMode} of ${SEP.rows})` },
        { label: 'At least one skill', value: pct(namedSkills, SEP.rows), display: `${pct(namedSkills, SEP.rows)}%`, note: `(${namedSkills} of ${SEP.rows})` },
        { label: 'How long it lasts', value: pct(dur, SEP.rows), display: `${pct(dur, SEP.rows)}%`, note: `(${dur} of ${SEP.rows})` },
        { label: 'The stipend', value: pct(STIPEND_VERIFIED, SEP.rows), display: `${pct(STIPEND_VERIFIED, SEP.rows)}%`, note: `(${STIPEND_VERIFIED} of ${SEP.rows})` },
      ],
      note: 'A fact counts as stated only when the posting itself says it. Skills and work arrangement are read from the posting text, so a posting that mentions them in passing still counts.',
    },
  },
});

/* ------------------------------------------------- skills, Aug and Sep */

const aug = monthRows('2026-08');
const both = [...aug, ...sep];
const NAMES = { pcb: 'PCB', spi: 'SPI', uart: 'UART', i2c: 'I2C', '.net': '.NET', 'physical design': 'Physical design', 'signal integrity': 'Signal integrity', 'machine learning': 'Machine learning', 'data structures': 'Data structures', 'ci/cd': 'CI/CD', javascript: 'JavaScript', sql: 'SQL', aws: 'AWS', matlab: 'MATLAB', 'c++': 'C++', python: 'Python', java: 'Java', git: 'Git', agile: 'Agile', algorithms: 'Algorithms', azure: 'Azure', linux: 'Linux', verilog: 'Verilog', perl: 'Perl', react: 'React', docker: 'Docker', kubernetes: 'Kubernetes', 'power bi': 'Power BI', excel: 'Excel', c: 'C', typescript: 'TypeScript', 'node.js': 'Node.js', gcp: 'GCP', tensorflow: 'TensorFlow', pytorch: 'PyTorch', 'deep learning': 'Deep learning', nlp: 'NLP', html: 'HTML', css: 'CSS', rest: 'REST', 'rest api': 'REST APIs', 'computer vision': 'Computer vision', embedded: 'Embedded', rtos: 'RTOS', fpga: 'FPGA', systemverilog: 'SystemVerilog', tcl: 'Tcl', 'generative ai': 'Generative AI', llm: 'LLMs', llms: 'LLMs', 'data analysis': 'Data analysis', statistics: 'Statistics', spark: 'Spark', tableau: 'Tableau', figma: 'Figma', selenium: 'Selenium', 'spring boot': 'Spring Boot', angular: 'Angular', mongodb: 'MongoDB', postgresql: 'PostgreSQL', mysql: 'MySQL', 'unit testing': 'Unit testing', 'object-oriented programming': 'Object-oriented programming', oop: 'OOP', networking: 'Networking', 'system design': 'System design' };
const pretty = (s) => NAMES[s] ?? (s.charAt(0).toUpperCase() + s.slice(1));
function skillTable(rows, top) {
  const withSkills = rows.filter((r) => r.skills.length);
  const counts = new Map();
  for (const r of withSkills) for (const s of new Set(r.skills.map((x) => x.toLowerCase()))) counts.set(s, (counts.get(s) ?? 0) + 1);
  const list = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
  return { n: withSkills.length, rows: list.map(([s, v]) => ({ label: pretty(s), value: pct(v, withSkills.length), display: `${pct(v, withSkills.length)}%`, note: `(${v})` })) };
}
const shelfOf = (r) => { const j = get.get(r.id); return roleCategory({ title: j.title, roleLabel: j.role_label }, cfg.roleFocus).category; };
const soft = skillTable(both.filter((r) => shelfOf(r) === 'software'), 12);
const hard = skillTable(both.filter((r) => shelfOf(r) === 'hardware'), 10);
const all = skillTable(both, 12);
const py = both.filter((r) => r.skills.some((s) => s.toLowerCase() === 'python'));
const pySql = py.filter((r) => r.skills.some((s) => s.toLowerCase() === 'sql'));
const perPosting = both.filter((r) => r.skills.length).map((r) => new Set(r.skills.map((x) => x.toLowerCase())).size).sort((a, b) => a - b);

write('skills', {
  id: 'skills',
  rows: both.length,
  withSkills: all.n,
  pythonAlsoSql: { python: py.length, both: pySql.length },
  medianSkillsPerPosting: perPosting[perPosting.length >> 1],
  source: { label: 'InternDoor postings data, August and September 2026 (see How we count)', url: 'https://blog.interndoor.com/methodology' },
  charts: {
    software: {
      title: 'Software, data and AI internships',
      subtitle: `Share of the ${soft.n} August and September postings that named at least one skill`,
      unit: 'percent', max: 100, label: 'Skill', valueLabel: 'Share of postings naming it',
      highlight: [soft.rows[0].label], rows: soft.rows,
    },
    hardware: {
      title: 'Hardware and embedded internships',
      subtitle: `Share of the ${hard.n} August and September postings that named at least one skill`,
      unit: 'percent', max: 100, label: 'Skill', valueLabel: 'Share of postings naming it',
      highlight: [hard.rows[0].label], rows: hard.rows,
      note: `Only ${hard.n} postings, so one or two postings move a skill several points. Read the order, not the decimals.`,
    },
  },
});

/* --------------------------------------------------------- job titles */

const since = Date.UTC(2026, 6, 31, 18, 30); // 1 Aug 2026, India
const until = Date.UTC(2026, 9, 12, 18, 30); // 13 Oct 2026, India
const raw = store.db.prepare('SELECT * FROM jobs WHERE is_tech = 1 AND suppressed_reason IS NULL AND first_seen_at >= ? AND first_seen_at < ?').all(since, until);
const inRows = raw.filter((r) => resolveRowRegion(r) === 'IN' && !isBlockedCompany(r.company) && matchCompany(r.company, cfg.watchlist));
const ft = inRows.filter((r) => r.employment_type === 'fulltime');
const it = inRows.filter((r) => r.employment_type !== 'fulltime');
const has = (rx) => (r) => rx.test(r.title);
const TERMS = {
  intern: /\bintern(ship)?s?\b/i,
  trainee: /\btrainee\b/i,
  apprentice: /\bapprentice(ship)?\b/i,
  associate: /\bassociate\b/i,
  level1: /\b(engineer|developer|sde|scientist|analyst)\s*[-\u2013]?\s*(i|1)\b(?![\w.])|\bsde[- ]?(1|i)\b/i,
  graduate: /\bgraduate\b/i,
};
const counts = (rows) => Object.fromEntries(Object.entries(TERMS).map(([k, rx]) => [k, rows.filter(has(rx)).length]));
const trainees = it.filter(has(TERMS.trainee));
const ftFirst = ft.reduce((m, r) => Math.min(m, r.first_seen_at), Infinity);

write('titles', {
  id: 'titles',
  window: { from: '2026-08-01', to: '2026-10-12', fullTimeFrom: new Date(ftFirst + 5.5 * 3600000).toISOString().slice(0, 10) },
  internTab: { rows: it.length, ...counts(it), traineesStatingDuration: trainees.filter((r) => durationText({ duration: r.duration })).length },
  fullTimeTab: { rows: ft.length, ...counts(ft) },
  source: { label: 'InternDoor postings data, 1 August to 12 October 2026 (see How we count)', url: 'https://blog.interndoor.com/methodology' },
  charts: {
    intern: {
      title: 'Words in internship titles',
      subtitle: `The ${it.length} India postings InternDoor filed as internships, 1 August to 12 October 2026`,
      unit: 'count', label: 'Word in the title', valueLabel: 'Postings',
      highlight: ['Trainee', 'Apprentice'],
      rows: [
        { label: 'Intern or internship', value: counts(it).intern },
        { label: 'Trainee', value: counts(it).trainee },
        { label: 'Apprentice', value: counts(it).apprentice },
        { label: 'Graduate', value: counts(it).graduate },
      ],
      note: 'A title can carry more than one of these words, so the rows add up to more than the total.',
    },
  },
});

/* ------------------------------------- what entry-level searches return */

const REFUSED_SINCE = Date.UTC(2026, 8, 12, 18, 30); // 13 Sep 2026, India
const REFUSED_UNTIL = until;
const reason = (r) => store.db.prepare(
  `SELECT count(*) n FROM seen_cards WHERE reason = ? AND last_seen_at >= ? AND last_seen_at < ?
     AND (job_id LIKE '%, india' OR job_id LIKE '%|india')`,
).get(r, REFUSED_SINCE, REFUSED_UNTIL).n;
const senior = reason('entry-level: senior title');
const asks = reason('entry-level: asks 2+ years') + reason('entry-level: asks 3+ years') + reason('entry-level: asks 5+ years');
const level = reason('entry-level: level II+ title');
const manager = reason('entry-level: manager title');
const consultant = reason('entry-level: consultant or architect title');
const offList = store.db.prepare(
  `SELECT count(*) n, count(DISTINCT lower(company)) e FROM seen_cards WHERE reason = 'company not on watchlist'
     AND last_seen_at >= ? AND last_seen_at < ? AND (job_id LIKE '%, india' OR job_id LIKE '%|india')`,
).get(REFUSED_SINCE, REFUSED_UNTIL);
const unpaid = store.db.prepare(
  `SELECT count(*) n, count(DISTINCT lower(company)) e FROM seen_cards WHERE reason = 'company not on watchlist'
     AND last_seen_at >= ? AND last_seen_at < ? AND (job_id LIKE '%, india' OR job_id LIKE '%|india') AND lower(title) LIKE '%unpaid%'`,
).get(REFUSED_SINCE, REFUSED_UNTIL);

write('refused', {
  id: 'refused',
  window: { from: '2026-09-13', to: '2026-10-12' },
  offList: { postings: offList.n, employers: offList.e },
  unpaidInTitle: { postings: unpaid.n, employers: unpaid.e },
  source: { label: 'InternDoor collection records, 13 September to 12 October 2026 (see How we count)', url: 'https://blog.interndoor.com/methodology' },
  charts: {
    entry: {
      title: 'Filed as entry level, but not entry level',
      subtitle: 'India postings returned for entry-level searches that InternDoor turned away, 13 September to 12 October 2026, by reason',
      unit: 'count', label: 'Reason', valueLabel: 'Postings',
      highlight: ['Asked for two or more years'],
      rows: [
        { label: 'Senior, lead or principal title', value: senior },
        { label: 'Asked for two or more years', value: asks },
        { label: 'Level II or higher in the title', value: level },
        { label: 'Manager title', value: manager },
        { label: 'Consultant or architect title', value: consultant },
      ].sort((a, b) => b.value - a.value),
      note: 'Counted once per posting and city. These never reached InternDoor; the counts show what an entry-level filter lets through.',
    },
  },
});

/* ---------------------------------------------------------- the months */

const monthsOut = [SEP, AUG].map((s) => ({
  key: s.month, label: s.label, rows: String(s.rows), employers: String(s.employers),
  statedPct: `${pct(s.stated, s.rows)}%`, url: `https://interndoor.com/insights/${s.month}`,
}));
writeFileSync(join(HERE, '..', 'content', 'months.json'), `${JSON.stringify(monthsOut, null, 2)}\n`);

console.log(`September ${sep.length} rows (frozen ${SEP.rows}); employers tail ${JSON.stringify(tail)}; shelves ${JSON.stringify(shelf)}; mode ${JSON.stringify(mode)}`);
console.log(`Aug+Sep ${both.length} rows, ${all.n} with skills, Python ${py.length} (with SQL ${pySql.length}), median ${perPosting[perPosting.length >> 1]} skills`);
console.log(`Titles: intern tab ${it.length} ${JSON.stringify(counts(it))}; full-time ${ft.length} ${JSON.stringify(counts(ft))} from ${new Date(ftFirst).toISOString()}`);
console.log(`Refused: off list ${offList.n} from ${offList.e}; unpaid ${unpaid.n} from ${unpaid.e}; senior ${senior}, asks ${asks}, level ${level}, manager ${manager}, consultant ${consultant}`);
