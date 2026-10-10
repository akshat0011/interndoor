/**
 * The WhatsApp channel's bar — his ask, 8 Oct 2026: "make sure no trash or
 * niche or non software role job reaches the whatsapp channel, the quality
 * must remain high". src/channelgate.js decides; the site keeps every role.
 *
 * Every title here is a real one off the live India board, and every rule is
 * pinned BOTH ways: something it must refuse, and the nearest real role it
 * must not.
 */
import { readFileSync } from 'node:fs';
import { channelRefusal } from '../src/channelgate.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}
const sw = (title, roleLabel = '', extra = {}) => ({ title, roleLabel, category: 'software', ...extra });
const goes = (label, job) => check(`goes: ${label}`, channelRefusal(job), null);
const held = (label, job, why) => check(`held: ${label}`, channelRefusal(job)?.startsWith(why) ?? null, true);

console.log('\n== WHAT A FOLLOWER SHOULD SEE ==');
goes('a software internship', sw('Software Engineer Intern', 'Software Development'));
goes('a data engineer', sw('Data Engineer I', 'Data Engineering'));
goes('a full-stack developer', sw('Full Stack Developer', 'Full Stack Developer'));
goes('a QA automation engineer', sw('QA Automation Engineer', 'QA Automation'));
goes('a C++ developer', sw('C++ QT Developer', 'Desktop application development'));
goes('C++ alone names the job', sw('Middleware C++ Engineer', 'Middleware Development'));
goes('a data ingestion engineer', sw('Data Ingestion Engineer', 'Data Pipeline Engineer'));
goes('an SRE, typo and all', sw('Site Reliablity Engineer', 'System operations'));
goes('a security engineer', sw('Network Security Engineer', 'Network Security Engineer'));
goes('a cybersecurity engineer', sw('Cybersecurity Engineer', 'Security Product Engineer'));
goes('a data analyst (his "keep data analyst")', sw('Data Analyst I', 'Data Analyst'));
goes('Amazon SDE-1', sw('SDE-1 (FTC)', 'Software development'));
goes("Amazon's L4 is its entry grade", sw('Software Dev Engineer I, L4', 'Software Testing'));
goes('Honeywell writes Engr', sw('Software Engr I', 'Software Engineering'));
goes('a Salesforce PMTS', sw('Software Engineering PMTS', 'Observability engineering'));
goes('a stated year under four', sw('Software Engineer (1 year Exp)', 'Software Development'));
goes('a batch year is not a level', sw('Software Engineer 2027 Batch', 'Software Development'));
goes('"Credit Risk Data Engineer" has no refused word', sw('Credit Risk Data Engineer', 'Data Engineering'));
goes('"Distributed" is not "Dist"', sw('Distributed Systems Engineer', 'Backend'));
goes('"financial" in a data scientist\'s title is not a financial analyst', sw('Financial Analytics Data Scientist', 'Data Science'));
goes('"model training" is machine learning, not teaching', sw('Machine Learning Engineer', 'Predictive Model Training'));
goes('L2/L3 here are network layers', sw('Protocol Test Engineer L2 L3', 'Protocol Testing'));
goes('Cummins numbers copies of one posting', sw('Data Engineer', 'Data Engineering', { slugTitle: 'Data Engineer 7' }));
goes('a requisition code the cleaner already removed', sw('Data Engineer I', 'Data Engineering', { slugTitle: 'Data Engineer I (R-19886)' }));

console.log('\n== A TITLE THAT NAMES NO DISCIPLINE ==');
goes('Sprinklr "Intern", vouched by the label', sw('Intern', 'Software Engineering'));
goes('iRage "Winter Internship"', sw('Winter Internship', 'Software Developer'));
goes('Microsoft "Applied Sciences INTERN"', sw('Applied Sciences INTERN', 'AI Research'));
held('the label cannot vouch for non-software', sw('Engineer', 'Engineering Design'), 'names no software role');
held('nor for a project intern', sw('Discipline Engineer', 'Adas validation'), 'names no software role');

console.log('\n== THE HARDWARE SHELF ==');
goes('a firmware title', sw('Firmware Design Engineer', 'NAND Flash Design', { category: 'hardware' }));
goes('an embedded developer', sw('Embedded Developer', 'Embedded firmware development', { category: 'hardware' }));
goes('a label that says embedded SOFTWARE', sw('Validation Engineer', 'Embedded Software Engineer', { category: 'hardware' }));
held('a label that only says testing', sw('Validation Engineer', 'Controls testing', { category: 'hardware' }), 'names no software role');
goes('...which the software shelf lets the label vouch for', sw('Validation Engineer', 'Controls testing'));
held('ASIC design', sw('ASIC Design Engineer Intern', 'Asic design', { category: 'hardware' }), 'title: asic');
held('hardware QC', sw('Hardware Quality Check Intern', 'Hardware Quality Check', { category: 'hardware' }), 'title: hardware');
held('PCB design', sw('PCB Design Intern', 'PCB Design', { category: 'hardware' }), 'title: pcb');
held('silicon', sw('Silicon Engineering INTERN', 'Hardware Verification', { category: 'hardware' }), 'title: silicon');
held('a SOC either way', sw('SOC Engineer - L2', 'Information security analyst', { category: 'hardware' }), 'title: soc');

console.log('\n== NOT FOR THIS CHANNEL ==');
held('application support', sw('Application Support Engineer', 'GenAI automation'), 'title: support');
held('a database administrator', sw('Database Administrator', 'Database Administration'), 'title: administrator');
held('an admin', sw('Open Shift Admin Red Hat PaaS', 'Technical Support Engineer'), 'title: admin');
held('a DBA', sw('Postgress DBA Engineer', 'Database Administration'), 'title: dba');
held('data governance', sw('Data Governance Analyst', 'Data Governance'), 'title: governance');
held('a spend analyst', sw('Spend Analyst', 'Spend Analyst'), 'title: spend');
held('a financial analyst', sw('Financial Analyst Powerbi', 'Financial Analyst'), 'title: financial analyst');
held('revenue operations', sw('Data Analyst - Revenue Operations', 'Data analysis'), 'title: revenue');
held('a business analyst', sw('Data Analytics Business Analyst', 'Data Analytics'), 'title: business analyst');
held('a business research analyst', sw('Business Research Analyst I', 'Machine Learning Research'), 'title: business research analyst');
held('a customer engineer', sw('AI Customer Engineer', 'AI Agent Development'), 'title: customer engineer');
held('presales', sw('Solutions Engineer - West Inida', 'Cloud Security Solutions'), 'title: solutions engineer');
held('a technician', sw('Quality Assurance Technician, Amazon Pay India', 'Quality Assurance Engineer'), 'title: technician');
held('managed services', sw('Cloud Managed Services Engineer (L3)', 'Cloud Infrastructure Support'), 'title: managed services');
held('content creation', sw('AI Content Intern', 'AI tools'), 'title: content');
held('a benchmark creator', sw('AI Benchmark Creator', 'AI Benchmark Creator'), 'title: creator');
held('catastrophe modelling', sw('Cat Modeler', 'Software engineer'), 'title: cat modeler');
held('a contractor', sw('Contractor', 'Cloud operations'), 'title: contractor');
held('a returnship', sw('Returnship Opportunity - Java / Angular(Fullstack) - Developer', 'Fullstack Developer'), 'title: returnship');
held('a teacher', sw('Software Development Instructor', 'Teaching'), 'title: instructor');
held('an oilfield data analyst', sw('Drilling Data Analyst', 'Drilling Data Analyst'), 'title: drilling');
goes('...while a data analyst still goes', sw('Data Analyst', 'Data Analysis'));
goes('and "Data Mining" is not mining', sw('Data Mining Engineer', 'Data Engineering'));

console.log('\n== GRADES NO FRESHER HOLDS ==');
held('Princ Engr', sw('Princ Engr-AI Science', 'AI system design'), 'title: princ');
held('Dist Engr', sw('Dist Engr-AI Science', 'AI/ML Architect'), 'title: dist');
held('Assoc Mgr', sw('Data Protect & InfoSec Compl Assoc Mgr', 'Data Engineering'), 'title: compl');
held('Mgr', sw('Mgr, Development', 'Blockchain Development'), 'title: mgr');
held('Archt', sw('Cyber Sec Archt/Engr I', 'Cybersecurity Engineering'), 'title: archt');
held('a misspelled Senior', sw('Senio Gen AI ML Engineer', 'Software development'), 'title: senio');
held('Advisor', sw('Software Developer Advisor', 'Software Development'), 'title: advisor');
held('Expert', sw('Data Engineering Expert', 'Data Engineering'), 'title: expert');
held('Intermediate', sw('Intermediate Applications Developer', 'Applications development'), 'title: intermediate');
held('a PhD-only role', sw('Software Engineer PhD Early Career', 'Distributed systems engineering'), 'title: phd');
held('a grade only the ORIGINAL title states', sw('ADAS Algorithm Integration Engineer', 'Embedded Software Engineer', { slugTitle: 'Expert Engineer - ADAS Algorithm & Integration' }), 'title: expert');
held('Wipro L2', sw('DEVELOPER L2', 'Software Development'), 'level 2+');
held('Associate 2', sw('Software Engineering & Development, Associate 2', 'Dataflow Development'), 'level 2+');
held('QA 2', sw('Engr, Software QA 2', 'Software Testing'), 'level 2+');
held('EngII', sw('Java Spring Microservices EngII', 'Java Microservices Development'), 'level 2+');
held('ten years in the title', sw('1-10yrs Application for Cyber- Kolkata DN 57 - RDC', 'Cybersecurity strategy'), 'experience in title');
held('four years in the ORIGINAL title', sw('Java Developer', 'Software development', { slugTitle: 'Java Developer (Spring boot) 4+Yrs Indore' }), 'experience in title');

console.log('\n== ONE VENDOR\'S PRODUCT ==');
held('Kofax', sw('Kofax Developer', 'Tungsten Support'), 'niche: kofax');
held('Sitecore', sw('Software Engineer Sitecore', 'Software Development'), 'niche: sitecore');
held('Workday, said only by the label', sw('Applications Developer', 'Workday Configuration'), 'niche: workday');
held('Power BI', sw('PowerBI developer', 'Data analyst'), 'niche: powerbi');
held('clinical programming', sw('Rave Custom Function Programmer', 'Custom Function Development'), 'niche: rave');
held('SAP, said only by the label', sw('Custom Software Engineer', 'SAP S/4HANA Development'), 'niche: sap');

console.log('\n== WHAT THE LABEL ALONE MAY REFUSE ==');
held('support behind a developer title', sw('Software Development Specialist', 'Application Support'), 'label: support');
held('data labelling', sw('Digital Associate, Ring Data Engineering Services', 'Data Labeling'), 'label: labeling');
held('course content', sw('GenAI Intern', 'GenAI Content Developer'), 'label: content');
held('project execution', sw('Project Intern', 'Project Execution'), 'label: project execution');

console.log('\n== WHAT THE MESSAGE WOULD SHOW ==');
held('an underscored title', sw('Z2_Java Developer', 'Java Backend Developer'), 'messy title');
held('a requisition code', sw('Java Fullstack IRC300668', 'Java Fullstack Developer'), 'requisition code in title');
held('a code in brackets', sw('Intern (P03366)', 'Machine Learning Development'), 'requisition code in title');
held('a title not in English', sw('サイバーセキュリティエンジニア', 'Cybersecurity analyst'), 'title not in english');
held('a skill string, not a job', sw('Azure Data Bricks', 'Data Engineering'), 'no role in title');
held('a stack, not a job', sw('MEAN stack', 'Full Stack Developer'), 'no role in title');
held('a practice, not a job', sw('Data Science', 'Data Analysis'), 'no role in title');
goes('an accented name is still English', sw('Software Engineer – Backend', 'Backend'));

console.log('\n== THE WIRING ==');
{
  const wa = readFileSync(new URL('../src/whatsapp.js', import.meta.url), 'utf8');
  check('whatsapp.js imports the gate', /import \{ channelRefusal \} from '\.\/channelgate\.js';/.test(wa), true);
  check('take() asks it after the shelf and before queueing, and a held listing returns',
    /if \(!announceable\(pub\.category\)\) \{ misc\+\+; return; \}\s*const why = channelRefusal\(pub\);\s*if \(why\) \{[^}]*return; \}\s*if \(unread\.has\(id\)\) \{ waiting\.push\(\{ code, id \}\); return; \}\s*mine\.push\(\{ job: pub, code, id \}\);/.test(wa), true);
  check('one take() serves the backlog and new rows alike',
    /for \(const id of readPending\(store, code\)\) take\(/.test(wa) && /const id = String\(row\.job_id \?\? row\.id\);\s*take\(/.test(wa), true);
  check('the backlog is rewritten from what was queued, so a held id is dropped',
    /const left = mine\.filter\(\(m\) => !posted\.has\(m\.id\)\);/.test(wa), true);
  check('the run log counts what was held back', /below the channel's bar left to the site/.test(wa), true);
}

console.log('\n== THE REELS GET THE SAME BAR (10 Oct 2026) ==');
{
  const qs = readFileSync(new URL('../bin/queue-server.js', import.meta.url), 'utf8');
  check('queue-server imports the gate', /^import \{ channelRefusal \} from '\.\.\/src\/channelgate\.js';$/m.test(qs), true);
  const sweep = qs.slice(qs.indexOf('function autoSweep()'), qs.indexOf('const seenEmployers'));
  check('the sweep body was found', sweep.length > 500, true);
  check('the auto-sweep drops a listing below the bar, beside the shelf check',
    /&& announceable\(j\.category\)\s*&& !channelRefusal\(j\)\s*&& !known\.has/.test(sweep), true);
}

console.log('\n== NOTHING GOES OUT BEFORE ITS EXPERIENCE IS READ (10 Oct 2026) ==');
{
  const { DatabaseSync } = await import('node:sqlite');
  const { Store } = await import('../src/store.js');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE jobs (job_id TEXT PRIMARY KEY, description TEXT, first_seen_at INTEGER, facts_checked_at INTEGER)');
  const T = 1_800_000_000_000, long = 'x'.repeat(201);
  const ins = db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)');
  ins.run('unread', long, T, null);
  ins.run('read', long, T, T + 1);
  ins.run('thin', 'x'.repeat(200), T, null);
  ins.run('old', long, T - 1, null);
  ins.run('other', long, T, null);
  const st = { db, factsUnread: Store.prototype.factsUnread };
  check('only an unread, readable, recent posting among those asked about waits',
    [...st.factsUnread(['unread', 'read', 'thin', 'old', 'missing'], T)].sort(), ['unread']);
  check('ids are compared as strings and repeats are harmless', [...st.factsUnread(['unread', 'unread'], T)], ['unread']);
  check('a posting not asked about is not reported', st.factsUnread(['read'], T).has('other'), false);
  check('nothing asked, nothing waits', st.factsUnread([], T).size, 0);

  const wa = readFileSync(new URL('../src/whatsapp.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const { FACTS_WAIT_MS } = await import('../src/whatsapp.js');
  check('a posting waits a few hours at most', FACTS_WAIT_MS > 3_600_000 && FACTS_WAIT_MS <= 12 * 3_600_000, true);
  check('the backlog and this run are both asked, bounded by the wait',
    /for \(const code of regions\) candidates\.push\(\.\.\.readPending\(store, code\)\);/.test(wa)
      && /candidates\.push\(String\(row\.job_id \?\? row\.id\)\)/.test(wa)
      && /store\?\.factsUnread\?\.\(candidates, Date\.now\(\) - FACTS_WAIT_MS\)/.test(wa), true);
  check('what waits is put back on the queue when something was sent',
    /writePending\(store, code, \[\.\.\.left\.filter\(\(m\) => m\.code === code\)\.map\(\(m\) => m\.id\), \.\.\.waitingIn\(code\)\]\)/.test(wa), true);
  check('...and when nothing was, keeping the backlog as it was',
    /if \(!mine\.length\) \{\s*if \(waiting\.length\) for \(const code of regions\) writePending\(store, code, \[\.\.\.readPending\(store, code\), \.\.\.waitingIn\(code\)\]\);/.test(wa), true);

  const ix = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const early = ix.indexOf('await readPostingFacts(store, cfg, { budgetMinutes: cfg.enrich?.factsBeforePublishMinutes');
  const pub = ix.indexOf('await publish(store, cfg, newJobs.length)');
  check('the scan reads the facts before its publish', early > 0 && pub > 0 && early < pub, true);
  check('and again after the channels for whatever was left', ix.lastIndexOf('await readPostingFacts(store, cfg);') > pub, true);
  check('the pass takes the budget it is given',
    /async function readPostingFacts\(store, cfg, \{ budgetMinutes = [^}]+\} = \{\}\)/.test(ix)
      && /enrich: \{ \.\.\.cfg\.enrich, budgetMinutes \}/.test(ix), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
