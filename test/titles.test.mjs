/**
 * Clean titles and the Misc move (src/titles.js), on the real cases measured
 * against the local model on 30 Sep 2026.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { jobParts, composeJob } from '../src/telegram.js';
import { readdirSync } from 'node:fs';
import { groundTitle, shelfMove, publishedTitle, titleTargets, saveTitleReading, MISC_DISCIPLINES, DISCIPLINES, TITLE_SCHEMA, TITLE_MAX } from '../src/titles.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== a clean title uses only the original\'s words ==');
check('the Accenture strategy analyst',
  groundTitle('Enterprise AI Strategy Analyst', 'I&P GN - SC&E – Analyst - Enterprise AI Value Strategy-EVS', 'Accenture in India'),
  'Enterprise AI Strategy Analyst');
check('a contract tail dropped', groundTitle('AI ML Trainee', 'AI ML Trainee | 6-Month Fixed-Term Contract | 2026 Graduates'), 'AI ML Trainee');
check('a location dropped', groundTitle('Tester Intern', 'Tester Intern (Mumbai based only)'), 'Tester Intern');
// The inventions the model really produced — each refused, so the original stays.
check('"Custom Software Engineer" is not "Agentic AI Engineer"', groundTitle('Agentic AI Engineer', 'Custom Software Engineer'), null);
check('"Campus Summer Intern" is not "Data Science Intern"', groundTitle('Data Science Intern', 'Campus Summer Intern'), null);
check('"Software Developer" is not "Full Stack Developer"', groundTitle('Full Stack Developer', 'Software Developer'), null);
check('"Tech Specialist, DevOps" is not "DevOps Engineer"', groundTitle('DevOps Engineer', 'Tech Specialist, DevOps - R01571826'), null);

console.log('\n== what the check allows ==');
check('a dotted word\'s part: React.js -> React', groundTitle('React Developer', 'React.js Developer'), 'React Developer');
check('a close stem: Engineering -> Engineer', groundTitle('Site Reliability Engineer', 'Site Reliability Engineering Specialist'), 'Site Reliability Engineer');
check('a joining word', groundTitle('Data Processing with Python', 'Python - Data Processing'), 'Data Processing with Python');
check('a stem is not any prefix: "Eng" is too short to count', groundTitle('Eng Intern', 'Engineering Intern'), null);
check('a stem may add at most four letters: "Develop" is not "Developmental"', groundTitle('Develop Intern', 'Developmental Biology Intern'), null);
check('the original spelling comes back: Macos -> MacOS, Powerbi -> PowerBI',
  [groundTitle('Windows Macos Support Engineer', 'Support Engineer- Windows, MacOS & Ubuntu/Linux'), groundTitle('Powerbi developer', 'PowerBI developer - PowerBI, DAX, SQL')],
  ['Windows MacOS Support Engineer', 'PowerBI developer']);

console.log('\n== what the check refuses ==');
check('an internship that stops saying so', groundTitle('Full Stack Developer', 'Full Stack Developer - Intern'), null);
check('a role that stops saying what it is', groundTitle('Application', 'Application Engineering Services - Support'), null);
// Real India titles, 30 Sep: a grade of two or higher must survive.
check('a level 2 kept by digit', groundTitle('Software Development Associate', 'Software Engineering & Development, Associate 2'), null);
check('a level 2 kept by L-code', groundTitle('Software Engineering Associate', 'Engineering-L2-Hyderabad-Associate-Software Engineering'), null);
check('a roman II kept', groundTitle('Platform Engineer', 'Platform Engineer II'), null);
check('the level may stay', groundTitle('Software Development Associate 2', 'Software Engineering & Development, Associate 2'), 'Software Development Associate 2');
check('level 1 may go', groundTitle('API Engineer', 'API Engineer 1 - Credit (L08)'), 'API Engineer');
check('the level is a word of its own, not the end of another number', groundTitle('Associate Team 42', 'Associate 2 - Team 42'), null);
check('a year is not a level', groundTitle('Software Engineer Intern', 'Software Engineer Intern 2027'), 'Software Engineer Intern');
check('the company name alone', groundTitle('Accenture', 'Accenture Analyst', 'Accenture'), null);
check('too short', groundTitle('AI', 'AI Analyst'), null);
check(`longer than ${TITLE_MAX}`, groundTitle('Intermediate Software Engineer Full Stack C# Dotnet MVC Angular Azure', 'Intermediate Software Engineer- Full Stack-C#, Dotnet, MVC, Angular, Azure DevOps'), null);
check('empty or missing', [groundTitle('', 'Java Developer'), groundTitle(null, 'Java Developer')], [null, null]);

console.log('\n== Software moves to Misc on TWO signals, and only Software moves ==');
check('Accenture strategy analyst moves', shelfMove('software', 'consulting_strategy', 'I&P GN - SC&E – Analyst - Enterprise AI Value Strategy-EVS'), 'misc');
check('an OS support engineer moves', shelfMove('software', 'it_support_helpdesk', 'Support Engineer- Windows, MacOS & Ubuntu/Linux'), 'misc');
check('an MBA intern moves', shelfMove('software', 'business_sales_marketing_ops', 'MBA Campus Summer Intern'), 'misc');
// The model alone was wrong on these two; the title rule keeps them.
check('WebSphere middleware stays (a software word in the title)', shelfMove('software', 'core_engineering', 'IBM WebSphere Liberty Middleware Engineer'), null);
check('a bare "Intern" stays (the title names no discipline)', shelfMove('software', 'business_sales_marketing_ops', 'Intern'), null);
check('an ETL developer stays whatever the model says', shelfMove('software', 'consulting_strategy', 'Specialist, ETL Developer - Master Data Management Ecosystem'), null);
// Both kinds of word in the title: the software word wins, so a developer who
// writes Salesforce or SAP code stays on Software even when read as ERP work.
check('a Salesforce DEVELOPER stays', shelfMove('software', 'erp_crm_functional', 'Salesforce Developer'), null);
check('a Salesforce administrator moves', shelfMove('software', 'erp_crm_functional', 'Salesforce Administrator'), 'misc');
// Both measured on the India board, 30 Sep: the model read a GCP reliability
// role as helpdesk and a data-analytics analyst as business.
check('a Google Cloud infrastructure support engineer stays', shelfMove('software', 'it_support_helpdesk', 'Google Cloud Infrastructure Support Engineer'), null);
check('a business analyst in data analytics stays', shelfMove('software', 'business_sales_marketing_ops', 'Business Analyst-Data Analytics'), null);
check('a cloud FinOps strategy analyst still moves', shelfMove('software', 'consulting_strategy', 'S&CGN - Tech Strategy & Advisory - Cloud Finops - Analyst'), 'misc');
// And two the full India read would have moved wrongly, 30 Sep.
check('a DevSecOps apprentice stays, SAP or not', shelfMove('software', 'erp_crm_functional', 'Apprentice - IT ERP, SAP AI & DEVSECOPS'), null);
check('an integration-platform administrator stays', shelfMove('software', 'it_support_helpdesk', 'Integration Technology Administrator'), null);
// Real India titles the first word list let stay on Software, 30 Sep.
check('an IT administrator moves', shelfMove('software', 'it_support_helpdesk', 'ADMINISTRATOR L2'), 'misc');
check('a managed-services engineer moves', shelfMove('software', 'it_support_helpdesk', 'Cross Technology Managed Services Engineer (L1)'), 'misc');
check('an onboarding specialist moves', shelfMove('software', 'it_support_helpdesk', 'Technical Onboarding Specialist'), 'misc');
check('a demand-forecasting analyst moves', shelfMove('software', 'business_sales_marketing_ops', 'Analyst – Demand Forecasting'), 'misc');
check('a claims analyst moves', shelfMove('software', 'business_sales_marketing_ops', 'Claims Analytics Specialist'), 'misc');
check('an ecommerce intern moves', shelfMove('software', 'business_sales_marketing_ops', 'Intern - Ecommerce'), 'misc');
check('an Oracle EPM associate moves', shelfMove('software', 'erp_crm_functional', 'EPM - ARCS - Associate'), 'misc');
check('a database administrator stays', shelfMove('software', 'it_support_helpdesk', 'Database Administrator'), null);
check('a software discipline never moves', shelfMove('software', 'data_science_analytics', 'Data Analyst - Business Operations'), null);
check('hardware is never moved', shelfMove('hardware', 'business_sales_marketing_ops', 'Sales Engineer - VLSI'), null);
check('misc is never promoted', shelfMove('misc', 'software_development', 'Business Analyst'), null);
check('an unread posting never moves', shelfMove('software', null, 'Business Strategy Analyst'), null);
check('every Misc discipline is on the model\'s list', [...MISC_DISCIPLINES].every((d) => DISCIPLINES.includes(d)), true);
check('the schema offers exactly that list', TITLE_SCHEMA.properties.discipline.enum, DISCIPLINES);

console.log('\n== the published title: an owner edit, then the clean title, then the original ==');
check('the clean title', publishedTitle({ title: 'S&C GN - AI Analyst', display_title: 'AI Analyst' }), 'AI Analyst');
check('no clean title keeps the original', publishedTitle({ title: 'Java Developer', display_title: null }), 'Java Developer');
check('an owner edit wins', publishedTitle({ title: 'Edited Title', original_title: 'Old', display_title: 'Model Title' }), 'Edited Title');

console.log('\n== the store: what is read, and that a reading is recorded ==');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE jobs (job_id TEXT PRIMARY KEY, company TEXT, title TEXT, role_label TEXT, description TEXT, region TEXT,
    is_tech INTEGER, closed_at INTEGER, suppressed_reason TEXT, first_seen_at INTEGER,
    display_title TEXT, discipline TEXT, title_checked_at INTEGER)`);
  const put = db.prepare('INSERT INTO jobs (job_id, company, title, region, is_tech, closed_at, suppressed_reason, first_seen_at, title_checked_at) VALUES (?,?,?,?,?,?,?,?,?)');
  put.run('new', 'A', 'T1', 'IN', 1, null, null, 300, null);
  put.run('old', 'A', 'T2', 'IN', 1, null, null, 100, null);
  put.run('read', 'A', 'T3', 'IN', 1, null, null, 400, 5);
  put.run('nontech', 'A', 'T4', 'IN', 0, null, null, 500, null);
  put.run('closed', 'A', 'T5', 'IN', 1, 9, null, 500, null);
  put.run('pulled', 'A', 'T6', 'IN', 1, null, 'why', 500, null);
  put.run('us', 'A', 'T7', 'US', 1, null, null, 600, null);
  check('only unread live engineering rows on the asked boards, newest first',
    titleTargets(db, ['IN']).map((r) => r.job_id), ['new', 'old']);
  check('no boards asked, nothing read', titleTargets(db, []), []);
  check('the limit holds', titleTargets(db, ['IN', 'US'], 1).map((r) => r.job_id), ['us']);
  saveTitleReading(db, 'new', { displayTitle: 'Clean', discipline: 'software_development' }, 42);
  check('a reading is saved', db.prepare("SELECT display_title, discipline, title_checked_at FROM jobs WHERE job_id='new'").get(),
    { display_title: 'Clean', discipline: 'software_development', title_checked_at: 42 });
  saveTitleReading(db, 'old', {}, 43);
  check('a refused title still marks the row read', db.prepare("SELECT display_title, title_checked_at FROM jobs WHERE job_id='old'").get(),
    { display_title: null, title_checked_at: 43 });
  check('and a read row is not read again', titleTargets(db, ['IN']).map((r) => r.job_id), []);
}

console.log('\n== wired where it counts ==');
{
  const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pub = strip('../src/publish.js');
  check('the projection publishes the clean title', (pub.match(/title: publishedTitle\(row\),/g) ?? []).length, 2);
  check('and carries the original as slugTitle whenever they differ',
    (pub.match(/\.\.\.\(publishedTitle\(row\) !== row\.title \? \{ slugTitle: row\.title \} : \{\}\)/g) ?? []).length, 2);
  check('a Misc move happens only behind titles.moveToMisc',
    /cfg\.titles\?\.moveToMisc \? shelfMove\(rc\.category, row\.discipline, row\.title, \{[\s\S]{0,400}?\}\) : null/.test(pub), true);
  const idx = strip('../src/index.js');
  const at = (s) => idx.indexOf(s);
  check('each scan reads titles after enrichment and before the publish',
    at('await enrichNewJobs(store, cfg);') > 0
      && at('await cleanNewTitles(store, cfg);') > at('await enrichNewJobs(store, cfg);')
      && at('await publish(store, cfg') > at('await cleanNewTitles(store, cfg);'), true);
  check('the server slug builds from slugTitle', /slugify\(job\.slugTitle \?\? job\.title\)/.test(strip('../src/pages.js')), true);
}

console.log('\n== every link built from a published row keeps the ORIGINAL title in its URL ==');
{
  // WhatsApp and Telegram compose from jobs.json, where `title` is the clean
  // title since 30 Sep; the page lives at the original slug (slugTitle). Built
  // from `title` alone, every cleaned listing posted a link to a 404.
  const row = { id: '4472154980', company: 'Volody', title: 'Tester Intern', slugTitle: 'Tester Intern (Mumbai based only)', location: 'Mumbai' };
  const want = '/jobs/volody-tester-intern-mumbai-based-only-4472154980';
  check('the WhatsApp / Telegram parts link the page that exists', jobParts(row).page.endsWith(want), true);
  check('the Telegram caption links it too', composeJob(row).includes(want), true);
  check('and a row with no clean title is unchanged', jobParts({ id: '1', company: 'A', title: 'Java Intern' }).page.endsWith('/jobs/a-java-intern-1'), true);
  // Every jobSlug built from named fields must pass slugTitle, bar the two
  // files that are handed STORE rows (whose title is still the original).
  const STORE_ROWS = new Set(['postgen.js', 'weekly.js']);
  const offenders = [];
  for (const dir of ['../src/', '../bin/']) {
    for (const f of readdirSync(new URL(dir, import.meta.url))) {
      if (!f.endsWith('.js') || STORE_ROWS.has(f)) continue;
      const src = readFileSync(new URL(dir + f, import.meta.url), 'utf8');
      for (const m of src.matchAll(/jobSlug\(\{[^}]*\}\)/g)) if (/\btitle:/.test(m[0]) && !/slugTitle/.test(m[0])) offenders.push(`${f}: ${m[0]}`);
    }
  }
  check('no jobSlug({ title: … }) call drops slugTitle', offenders, []);
  // Links already posted from the clean title cannot be edited, so publish
  // writes a redirect stub at every live clean-title slug.
  const pubSrc = readFileSync(new URL('../src/publish.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  check('publish redirects every clean-title slug to the real page',
    /for \(const job of publicJobs\) \{\s*if \(!job\.slugTitle\) continue;[\s\S]{0,200}slug = jobSlug\(\{ \.\.\.job, slugTitle: undefined \}\); target = jobSlug\(job\);[\s\S]{0,200}redirectsByRegion\.get\(job\.region\)\.push\(\{ slug, target \}\)/.test(pubSrc), true);
}

console.log('\n== 8 Oct 2026: an open title moves only when discipline AND label both say misc ==');
check('eClerx "Analyst" — business discipline, insights label', shelfMove('software', 'business_sales_marketing_ops', 'Analyst', { open: true, labelMisc: true }), 'misc');
check('Otis "Apprentice" — core discipline, mechanic label', shelfMove('software', 'core_engineering', 'Apprentice', { open: true, labelMisc: true }), 'misc');
check('an open title with a misc discipline but no misc label STAYS', shelfMove('software', 'business_sales_marketing_ops', 'Intern', { open: true, labelMisc: false }), null);
check('a misc label but a software discipline STAYS', shelfMove('software', 'software_development', 'Intern', { open: true, labelMisc: true }), null);
check('a NAMED title is not moved by the label rule', shelfMove('software', 'business_sales_marketing_ops', 'Platform Engineer', { open: false, labelMisc: true }), null);
check('a software word in the title still wins', shelfMove('software', 'business_sales_marketing_ops', 'Developer Intern', { open: true, labelMisc: true }), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
