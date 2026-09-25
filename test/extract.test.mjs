import { extractStipend, formatStipend, extractDuration, extractSkills, extractWorkplaceType, parseRelativeTime, jobIdFromUrl, normaliseDegree,
  statedDeadlines, groundDeadline, groundExperienceYears, groundGraduation, couldStateFacts } from '../src/extract.js';
import { normaliseCompany, matchCompany, matchTitle, resolveWindowHours } from '../src/config.js';
import { offlineSummary } from '../src/summarize.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
function money(label, text, min, max, currency, period) {
  const s = extractStipend(text);
  const got = s && { min: s.min, max: s.max, currency: s.currency, period: s.period };
  check(label, got, min === null ? null : { min, max, currency, period });
}

console.log('\n== stipend ==');
money('INR range/month', 'Stipend: ₹25,000 - ₹40,000 per month', 25000, 40000, 'INR', 'month');
money('INR single', 'The stipend is ₹30,000/month for the duration.', 30000, 30000, 'INR', 'month');
money('USD hourly', 'Compensation: $25 - $45 per hour', 25, 45, 'USD', 'hour');
money('k notation', 'Stipend: 50k per month', 50000, 50000, null, 'month');
money('LPA', 'CTC 12 LPA on conversion', 1200000, 1200000, 'INR', 'year');
money('lakh per annum', 'Salary: 6.5 lakh per annum', 650000, 650000, 'INR', 'year');
money('Rs. with period', 'Stipend Rs. 15,000 monthly', 15000, 15000, 'INR', 'month');
money('INR code', 'Stipend: INR 40000 per month', 40000, 40000, 'INR', 'month');
money('no money at all', 'We are looking for 3 interns with 2 years experience.', null);
money('team-size trap', 'Join a team of 500 engineers across 12 offices.', null);
money('rounds trap', 'Salary discussed after 2 rounds of interviews.', null);
money('duration-not-money', 'Requirements: 3 - 6 months availability required.', null);
check('formatted range', formatStipend(extractStipend('Stipend: ₹25,000 - ₹40,000 per month')), '₹25,000 – ₹40,000 / month');
check('formatted null row', formatStipend({ min: null, max: null, currency: null, period: null }), null);
check('formatted undefined', formatStipend(null), null);
// The abbreviation full-stop in "Rs." used to split the line and lose the figure.
money('Rs. mid-sentence', 'The selected intern receives Rs. 20,000 per month. Apply soon.', 20000, 20000, 'INR', 'month');

console.log('\n== company money is not the candidate\'s money ==');
// A live bug: "received more than $410 million in funding" was published as a
// $410,000,000 intern stipend on the public site.
money('funding round', 'To date, Eightfold AI has received more than $410 million in funding and a valuation of over $2B from leading investors', null);
money('annual revenue', 'The company crossed $50 million in annual revenue last year.', null);
money('series round', 'We raised $120 million in our Series C round.', null);
money('assets under mgmt', 'The fund manages Rs 12,000 crore in assets under management.', null);
money('transaction volume', 'Our platform processed Rs 5,00,00,000 in transactions last month.', null);
money('market cap', 'A market cap of $2 billion.', null);
// A currency symbol with neither a compensation word nor a period is not pay.
money('bare figure, no period', 'The office is a $30 million campus.', null);
// ...but a period alone is enough, even without the word "stipend".
money('period without keyword', 'The selected intern receives Rs 20,000 per month.', 20000, 20000, 'INR', 'month');

console.log('\n== an unstated period is not "total" ==');
// THE WORD "stipend" WAS A PERIOD PATTERN MEANING `total`. Smowcode's
// "Internship stipend - \u20b915,000." is a monthly figure and the site rendered
// "\u20b915,000 / total" on the card, the job page and the sidebar. Every one of
// these lines states an amount and NO period, so the only honest answer is a
// null period, which formatStipend renders as the bare amount.
money('bare "stipend -" line', 'Internship stipend - \u20b915,000.', 15000, 15000, 'INR', null);
money('bare "Stipend:" line', 'Stipend: \u20b910,000', 10000, 10000, 'INR', null);
money('bare "Stipend -" with Rs.', 'Stipend - Rs. 25,000', 25000, 25000, 'INR', null);
check('renders with no period suffix', formatStipend(extractStipend('Internship stipend - \u20b915,000.')), '\u20b915,000');
// A period stated ANYWHERE on the line still wins — these are what the
// mis-firing rule was hiding behind, and they must be untouched.
money('stipend + monthly', 'Internship stipend - \u20b915,000 per month.', 15000, 15000, 'INR', 'month');
money('stipend + weekly', 'Weekly stipend of $750 for the summer.', 750, 750, 'USD', 'week');
// `total` and `lump sum` are claims the employer actually makes. Principal
// Financial Group's live posting says exactly this and must keep its period.
money('real lump sum', 'You will receive a lump sum stipend of $4,000 to support incidental expenses.', 4000, 4000, 'USD', 'total');
money('word "total"', 'Total stipend for the internship: \u20b950,000', 50000, 50000, 'INR', 'total');

console.log('\n== a period stated one line away from the figure ==');
/* 1,313 live US rows carried a figure and no period, so none could become
   baseSalary and Google warned `Missing field "baseSalary"` on every US page it
   checked. The postings DO state it — ATS descriptions break the line between
   the two. Measured over all 6,799 stored descriptions: 204 rows gain a period
   (192 of them US), 0 change, 0 lose. */
money('the period is on the next line',
  'Salary ranges for U.S locations (USD):$26.50-$45.25\n\nThe Internship Program offers an hourly rate of pay.',
  26.5, 45.25, 'USD', 'hour');
money('a label above the figure',
  'SF Bay Area Hourly Rate\n$54—$60 USD',
  54, 60, 'USD', 'hour');
/* Akuna's real line. "annualized" was in no pattern at all, so a stated annual
   salary read as periodless even sitting beside the figure. A figure ALONE on
   its own line is still nothing — the line needs a pay word or a period for the
   figure to be a candidate in the first place, and that gate is unchanged. */
money('annualized counts',
  'In accordance with the Equal Pay Act, the minimum annualized base salary starts at $145,000.',
  145000, 145000, 'USD', 'year');

/* THE TRAPS THE FIRST DRAFT FELL INTO, both found by re-deriving over the real
   corpus and READING the results rather than trusting the count. */
// `p.m.` in PERIOD_PATTERNS matched SIX THIRTY PM and called a stipend monthly.
money('a clock time is not a period',
  'Stipend: \u20b910,000 (Fixed)\nTimings: 9:30 AM to 6:30 PM Monday to Friday\nDuration: 6 months',
  10000, 10000, 'INR', null);
// A one-off equipment budget became $500/day off a stray "day" nearby.
money('a one-off budget stays periodless',
  'Everyone receives a $500 home office stipend to set up your workspace.\nWe meet every day.',
  500, 500, 'USD', null);
// The magnitude has to fit: this is the Intel 76,398-per-hour row from a new
// direction, and the display string would ship before safeBaseSalary saw it.
money('a period the magnitude contradicts is refused',
  'Salary range (USD): $48,100 - $86,950\nThe program offers an hourly rate of pay.',
  48100, 86950, 'USD', null);
// `total` is a claim about the WHOLE payment. "total compensation" in the next
// paragraph is not that claim; the same-line rule still reads a real one.
money('total is never inferred from a neighbouring line',
  'Compensation: $4,000\nSee the total compensation page for details.',
  4000, 4000, 'USD', null);
// Closest wins, or a benefits paragraph outranks the rate beside the figure.
/* CLOSEST WINS, and this case is built so first-in-the-list CANNOT pass it:
   `hour` is the first nearby pattern, so an order-driven search picks it, then
   the magnitude bound rejects $60,000 an hour and the row loses its period
   entirely. Only distance gives the right answer. */
money('the closest period wins, not the first in the list',
  'Base salary: $60,000\nThat is the annual salary here. Contractors are paid an hourly rate instead.',
  60000, 60000, 'USD', 'year');

/* WEEK, FROM ONE EMPLOYER'S TWO REAL SHAPES. Formlabs writes the working week
   a line above the figure in every posting, and quotes either a weekly or a
   BI-weekly range. Reading "40 hours per week" as pay, or bi-weekly as weekly,
   doubles what we claim the employer pays. Fifteen live rows were affected. */
money('a real weekly range is read',
  'you will always be paid based on the assumed 40 hours per week as a full-time intern.\nThe weekly pay range for this role is:\n$1,575—$1,950 USD',
  1575, 1950, 'USD', 'week');
money('bi-weekly is refused, not halved or doubled',
  'you will always be paid based on the assumed 40 hours per week as a full-time intern.\nThe bi-weekly pay range for this role is:\n$1,350—$1,550 USD',
  1350, 1550, 'USD', null);
money('working hours alone are never a pay period',
  'Compensation\nInterns work 40 hours per week.\nThe range for this role is:\n$1,200—$1,400 USD',
  1200, 1400, 'USD', null);
/* A referral bounty is not the candidate's pay: Voleon's "$7,500 if your
   referred candidate is hired" was stored as a stipend before this. */
/* VOLEON'S REAL LINE, not a paraphrase. The first version of this case was
   invented, produced no figure with OR without the rule, and passed for the
   wrong reason — the mutation that deleted the rule survived it. §1's
   assertion-that-tests-nothing, caught by mutation testing. */
money('a referral bounty is not pay',
  'If you have a great candidate in mind for this role and would like to have the potential to earn $7,500 if your referred candidate is successfully hired and employed by The Voleon Group, please use this form https://voleon.com/referrals/ to submit your referral.',
  null);

console.log('\n== duration ==');
check('6 months', extractDuration('This is a 6 months internship'), '6 months');
check('range', extractDuration('Duration: 3-6 months'), '3-6 months');
check('summer', extractDuration('Summer 2026 internship program'), 'Summer 2026');
check('none', extractDuration('Great opportunity to learn.'), null);
check('label stripped', extractDuration('Duration: 3 Months'), '3 months');
check('label + range', extractDuration('Duration: 5 - 6 months'), '5-6 months');
check('singular', extractDuration('a 1 month engagement'), '1 month');

console.log('\n== skills ==');
check('typical', extractSkills('Requirements: Python, React, AWS, and knowledge of Docker. C++ a plus. Experience with PyTorch.'),
  ['python', 'c++', 'react', 'aws', 'docker', 'pytorch']);
check('cicd', extractSkills('You will work on CI/CD pipelines using Node.js and .NET'), ['node.js', '.net', 'ci/cd']);
check('golang', extractSkills('We use Golang and Kubernetes'), ['golang', 'kubernetes']);
check('no false go', extractSkills('Ready to go? R&D team is hiring.'), []);
check('spring boot dedupe', extractSkills('Built with Spring Boot'), ['spring boot']);

console.log('\n== workplace ==');
check('hybrid', extractWorkplaceType('Bengaluru, India (Hybrid)'), 'Hybrid');
check('remote', extractWorkplaceType('Remote - India'), 'Remote');
check('onsite', extractWorkplaceType('On-site in Mumbai'), 'On-site');
check('none', extractWorkplaceType('Bengaluru, Karnataka'), null);

console.log('\n== relative time ==');
const now = Date.parse('2026-07-25T12:00:00Z');
check('2 hours', parseRelativeTime('2 hours ago', now), now - 7200000);
check('45 min', parseRelativeTime('45 minutes ago', now), now - 2700000);
check('just now', parseRelativeTime('Just now', now), now);
check('3 days', parseRelativeTime('3 days ago', now), now - 259200000);
check('reposted', parseRelativeTime('Reposted 5 hours ago', now), now - 18000000);
check('1 week', parseRelativeTime('1 week ago', now), now - 604800000);
check('unparseable', parseRelativeTime('Posted recently', now), null);
check('null', parseRelativeTime(null, now), null);

console.log('\n== job id from url ==');
check('view url', jobIdFromUrl('https://www.linkedin.com/jobs/view/software-engineer-intern-at-stripe-4123456789'), '4123456789');
check('currentJobId', jobIdFromUrl('https://www.linkedin.com/jobs/search/?currentJobId=4123456789&keywords=intern'), '4123456789');
check('plain id', jobIdFromUrl('4123456789'), '4123456789');
check('no id', jobIdFromUrl('https://www.linkedin.com/feed/'), null);

console.log('\n== company matching ==');
const watchlist = [
  { display: 'Google', term: normaliseCompany('Google') },
  { display: 'Google', term: normaliseCompany('YouTube') },
  { display: 'Razorpay', term: normaliseCompany('Razorpay') },
  { display: 'Stripe', term: normaliseCompany('Stripe') },
  { display: 'Microsoft', term: normaliseCompany('Microsoft') },
];
check('exact', matchCompany('Google', watchlist), 'Google');
check('legal suffix', matchCompany('Razorpay Software Private Limited', watchlist), 'Razorpay');
check('alias maps to parent', matchCompany('YouTube', watchlist), 'Google');
check('india suffix', matchCompany('Google India Pvt Ltd', watchlist), 'Google');
check('stripe payments', matchCompany('Stripe Payments India', watchlist), 'Stripe');
check('no match', matchCompany('Some Random Startup', watchlist), null);
check('empty', matchCompany('', watchlist), null);
check('null', matchCompany(null, watchlist), null);
check('normalise pvt', normaliseCompany('Razorpay Software Pvt. Ltd.'), 'razorpay');
check('normalise tech', normaliseCompany('Zomato Technologies India'), 'zomato');

console.log('\n== title matching ==');
const terms = ['intern', 'internship', 'trainee', 'co-op', 'summer analyst'];
check('intern', matchTitle('Software Engineer Intern', terms), true);
check('interns plural', matchTitle('Backend Interns Wanted', terms), true);
check('internship', matchTitle('Summer Internship - Backend', terms), true);
check('trainee', matchTitle('Graduate Trainee Engineer', terms), true);
check('two words', matchTitle('Summer Analyst Program', terms), true);
check('full time rejected', matchTitle('Senior Software Engineer', terms), false);
check('International NOT intern', matchTitle('International Sales Manager', terms), false);
check('Internal NOT intern', matchTitle('Internal Audit Manager', terms), false);
check('disabled passes all', matchTitle('Senior Software Engineer', []), true);

console.log('\n== adaptive lookback window ==');
{
  const f = { adaptiveWindow: true, minWindowHours: 3, maxWindowHours: 36, postedWithinHours: 30 };
  const now = Date.parse('2026-07-26T12:00:00Z');
  const ago = (h) => now - h * 3600000;
  check('hourly run floors at min', resolveWindowHours(ago(1), f, now), 3);
  check('half-hour gap floors too', resolveWindowHours(ago(0.5), f, now), 3);
  check('2h gap -> 4h', resolveWindowHours(ago(2), f, now), 4);
  check('9h overnight -> 11h', resolveWindowHours(ago(9), f, now), 11);
  check('60h gap caps at max', resolveWindowHours(ago(60), f, now), 36);
  check('no previous run -> max', resolveWindowHours(null, f, now), 36);
  // A future timestamp (clock skew, restored backup) must never yield a
  // negative or tiny window that would silently drop everything.
  check('future timestamp -> max', resolveWindowHours(now + 9e6, f, now), 36);
  check('adaptive off uses fixed', resolveWindowHours(ago(1), { ...f, adaptiveWindow: false }, now), 30);
  check('adaptive off, no fixed set', resolveWindowHours(ago(1), { adaptiveWindow: false }, now), 24);
}

console.log('\n== offline summary ==');
const desc = `About us
We are a fast growing company.
Google is an equal opportunity employer and considers all applicants without regard to race.
Responsibilities: You will build and ship backend services that power our payments platform at scale.
Requirements: Currently pursuing a B.Tech degree, graduating in 2027, with strong knowledge of data structures and algorithms.
Stipend: ₹80,000 per month for a 6 month internship based in Bengaluru.
Follow us on Twitter for updates.
Apply by 15 August 2026.`;
const summary = offlineSummary(desc);
console.log(`  ${summary}`);
check('drops EEO boilerplate', /equal opportunity/.test(summary), false);
check('drops "we are a fast growing"', /fast growing/.test(summary), false);
check('keeps stipend', /80,000/.test(summary), true);
check('keeps deadline', /15 August/.test(summary), true);
check('keeps requirements', /B\.Tech/.test(summary), true);
check('empty description', offlineSummary(''), null);
check('null description', offlineSummary(null), null);

console.log('\nnormaliseDegree');
// The card shows the qualification, never the field of study.
check('strips the field', normaliseDegree('B.Tech Computer Science'), 'B.Tech');
check('keeps both alternatives', normaliseDegree('B.E/B.Tech CS or IT'), 'B.E/B.Tech');
check('source order, not list order', normaliseDegree('B.Tech/M.Tech in CSE'), 'B.Tech/M.Tech');
check('generic level when nothing specific', normaliseDegree("bachelor's degree in Computer Science"), "Bachelor's");
check('both levels survive', normaliseDegree('Bachelors/Masters in CS'), "Bachelor's/Master's");
check('a PhD is not a masters', normaliseDegree("Bachelor's/Master's/PhD in CS"), "Bachelor's/Master's");
check('specific beats generic at the same level', normaliseDegree("B.Tech or any bachelor's degree"), 'B.Tech');
check('different level is new information', normaliseDegree("B.Tech or Master's"), "B.Tech/Master's");
check('professional qualifications', normaliseDegree('CA / Semi-qualified CA'), 'CA');
check('management degrees', normaliseDegree('MBA from a recognized institution'), 'MBA');
check('diploma', normaliseDegree('Diploma in Mechanical Engineering'), 'Diploma');
// A status is not a qualification; degreeLevel already carries it.
check('status is not a degree', normaliseDegree('recent graduates and freshers'), '');
check('empty input', normaliseDegree(''), '');
check('null input', normaliseDegree(null), '');
// Regression: an uppercase-only match, or "be" and "me" in ordinary prose read as
// degrees. A Stripe posting saying "will be used in production" became a B.E.
check('the word "be" is not a B.E', normaliseDegree('code that will be used in production'), '');
check('the word "me" is not an M.E', normaliseDegree('send it to me when you can'), '');
check('the word "ca" is not a CA', normaliseDegree('you can apply any time'), '');

console.log('\n== "Spring" is a SEASON on a job board, not a framework ==');
/* `spring` was the THIRD-LARGEST skill on the US board — 512 stored postings —
   and 503 of those taggings were wrong. Measured against every stored
   description: only 9 carried any framework evidence at all, while 354 used the
   word purely as a season and the rest were things like ExxonMobil's
   headquarters in Spring, Texas and General Mills' "spring plan".
   `groundEnrichment` cannot catch this, because the word IS in the posting. */
const noSpring = (t) => !extractSkills(t).includes('spring');
check('a season is not a skill', extractSkills('Data Science Intern, Spring 2027. Requires python and sql.'), ['python', 'sql']);
check('nor is a term', noSpring('Internship, Test Engineer (Winter/Spring 2027). Uses python.'), true);
check('nor a graduation date', noSpring('For students graduating in the spring of 2026. Python required.'), true);
check('nor a place', noSpring('Our headquarters in Spring, Texas. Python required.'), true);
check('nor a business plan', noSpring('Owns the spring plan and peak support. Excel required.'), true);
/* The framework still extracts, under its real names, and the three spellings
   collapse to ONE chip rather than showing a reader three technologies. */
check('Spring Boot survives', extractSkills('Build APIs with Java and Spring Boot.'), ['java', 'spring boot']);
check('SpringBoot collapses into it', extractSkills('Stack: Java, SpringBoot.'), ['java', 'spring boot']);
check('Spring Framework collapses too', extractSkills('Built on the Spring Framework with Java.'), ['java', 'spring boot']);
check('and the bare word is not in the vocabulary at all',
  extractSkills('We use Spring for our services.').includes('spring'), false);

console.log('\n== hardware and EDA, because the watchlist is full of them ==');
/* The vocabulary was 69 web/data/cloud terms and nothing else, so a Marvell
   "Design Verification Intern" extracted as [python, java, c++] and a "Physical
   Design Engineer Intern" as [python]. Those roles were being filed onto
   /skills/python — 782 roles, a head term this site cannot rank for — instead
   of the niches that actually convert. */
check('a real RTL requirement line',
  extractSkills('Experience with RTL (SystemVerilog/Verilog/VHDL) and UVM.'),
  ['verilog', 'systemverilog', 'vhdl', 'uvm', 'rtl']);
check('back-end silicon flow',
  extractSkills('Physical design, place and route, signal integrity and DFT for our ASIC.'),
  ['asic', 'dft', 'physical design', 'place and route', 'signal integrity']);
/* Compared as a SET — the return order follows vocabulary order and is not
   part of the contract, so asserting it would pin the list's layout instead of
   its behaviour. */
check('embedded and lab tools',
  extractSkills('Firmware on an RTOS, I2C and SPI buses, boards drawn in Altium, bench work in LabVIEW.').sort(),
  ['altium', 'i2c', 'labview', 'rtos', 'spi']);
check('EDA scripting counts', extractSkills('Tcl and Perl scripting for the CAD flow.'), ['tcl', 'perl']);

console.log('\n== and four candidates were REFUSED on the evidence ==');
/* Each was counted against the store and its context read. Pinned so that
   adding one later has to break a test that says why it was rejected. */
check('"eda" is Exploratory Data Analysis here, 61 hits, every sample',
  extractSkills('Conduct Exploratory Data Analysis (EDA) using Python.'), ['python']);
check('"soc" also means a military Security Operations Center',
  extractSkills('Support a Military SOC environment.'), []);
check('"assembly" is physical on this board — weldment and device assembly',
  extractSkills('Produce manufacturing, weldment and assembly drawings.'), []);
check('"semiconductor" is an industry, not a skill',
  extractSkills('We are a semiconductor company.'), []);

console.log('\n== the 14-skill cap must drop the GENERIC term, not the specialist one ==');
/* `found` is a Set, so it keeps vocabulary order and slice(0,14) drops whatever
   is listed LAST. Measured: 34 stored postings match more than 14 terms, and
   with the hardware block placed after the generic tail, four of them lost the
   term that made them distinguishable — IBM's "Hardware Developer Intern" kept
   python and java and lost `signal integrity, tcl, perl`. */
/* THE FIXTURE IS THE REAL POSTING, not a synthetic pile of languages. IBM's
   "Hardware Developer Intern 2027 - Tucson, AZ" is the row that regressed: it
   matches more than 14 terms, and with the hardware block below the generic
   tail it kept python and java and lost signal integrity, tcl and perl. A made
   up fixture listing fourteen languages fails whatever the ordering, so it
   would have pinned nothing. */
const ibm = extractSkills([
  'Skills: Python, Java, C++, C#. Linux and Git.',
  'Agile team. Reporting in Excel, dashboards in Tableau and Power BI.',
  'Figma for specs. System design and OOP fundamentals.',
  'RTL design in Verilog and VHDL, UVM verification, FPGA and ASIC bring-up,',
  'physical design and signal integrity. Tcl and Perl scripting.',
].join(' '));
check('the cap still holds', ibm.length, 14);
check('the specialist terms survive it',
  ['verilog', 'vhdl', 'uvm', 'rtl', 'fpga', 'asic', 'physical design', 'signal integrity']
    .every((s) => ibm.includes(s)), true);
check('and the generic tail is what was dropped',
  ['agile', 'figma', 'tableau', 'power bi', 'system design', 'oop'].every((s) => !ibm.includes(s)), true);

console.log('\n== an application deadline is kept only when the posting states that date ==');
/* Every shape below is a real live posting (24 Sep 2026). The model proposes a
   deadline; statedDeadlines is the set it must come from. */
check('Wells Fargo: "Posting End Date: 11 Sep 2026"', statedDeadlines('Posting End Date: 11 Sep 2026 Job posting may come down early', 'IN'), ['2026-09-11']);
check('BCG: a time and a weekday between the cue and the date',
  statedDeadlines('Applications are due at 11:59PM ET on Thursday, October 1, 2026. The application includes', 'US'), ['2026-10-01']);
check('URBN: "p.m." and "Oct." do not end the sentence',
  statedDeadlines('Applications will close at 5:00 p.m. EST on Oct. 30, 2026. Role Responsibilities', 'US'), ['2026-10-30']);
check('Barclays: "closing date for applications is 25 September 2026"',
  statedDeadlines('The closing date for applications is 25 September 2026. Please note', 'GB'), ['2026-09-25']);
check('Entrust: an ordinal day', statedDeadlines('Application deadline: Oct 31st, 2026 You will: Collaborate', 'CA'), ['2026-10-31']);
check('Xcel: a two-digit year, read month-first in the US', statedDeadlines('Deadline to Apply: 10/16/26 EEO is the Law', 'US'), ['2026-10-16']);
check('ConocoPhillips states two, and both are candidates',
  statedDeadlines('requisition closing date of October 31, 2026. Apply By: Oct 30, 2026 Sponsorship', 'US'), ['2026-10-31', '2026-10-30']);
/* The refusals. Each would put a wrong "Apply by" on a live page. */
check('Vertex: no year written, so none stated', statedDeadlines('The application deadline for this co-op is November 15th. Please note', 'US'), []);
check('Nutanix: "40 days from the date of posting" is not a date', statedDeadlines('Our application deadline is 40 days from the date of posting.', 'US'), []);
check('Principal: the posting date in the NEXT sentence is not the deadline',
  statedDeadlines('beyond the applicable deadline. Original Posting Date 9/23/2026 Most Recently Posted', 'US'), []);
check('a start date after "rolling." is not the deadline', statedDeadlines('Application deadline: rolling. Starts June 1, 2027', 'US'), []);
check('GE Vernova: "open until at least" is a floor, not a deadline',
  statedDeadlines('This role is expected to be open until at least September 30, 2026. Additional Information', 'US'), []);
check('a posting date with no cue is nothing', statedDeadlines('Date Posted: 2026-09-14 Country: United States', 'US'), []);
check('11/2/2026 is 2 Nov in the US', statedDeadlines('Anticipated Posting End: 11/2/2026 The Opportunity', 'US'), ['2026-11-02']);
check('and 11 Feb in India', statedDeadlines('Last date to apply: 11/2/2026', 'IN'), ['2026-02-11']);
check('and nothing where the convention is unknown', statedDeadlines('Anticipated Posting End: 11/2/2026 The Opportunity', 'CA'), []);
check('an unambiguous numeric date needs no convention', statedDeadlines('Posting End: 10/30/2026 The Opportunity', 'CA'), ['2026-10-30']);
check('an impossible date is not a date', statedDeadlines('Deadline: February 30, 2027', 'US'), []);
check('the model\'s date is kept when stated', groundDeadline('2026-10-30', 'Apply By: Oct 30, 2026', 'US'), '2026-10-30');
check('a date the posting never wrote is dropped', groundDeadline('2026-10-29', 'Apply By: Oct 30, 2026', 'US'), '');
check('a month-day swap is dropped', groundDeadline('2026-02-11', 'Posting End: 11/2/2026', 'US'), '');
check('so is anything that is not an ISO day', groundDeadline('Oct 30, 2026', 'Apply By: Oct 30, 2026', 'US'), '');
check('and an empty answer stays empty', groundDeadline('', 'Apply By: Oct 30, 2026', 'US'), '');

console.log('\n== years of experience: the employer\'s figure, beside the word "experience" ==');
check('a range is re-read from the posting', groundExperienceYears('1-3 years', 'With at least 1 to 3 years of hands-on experience in Java'), '1–3 years');
check('"Minimum 2 Year(s) Of Experience" is 2+', groundExperienceYears('2 years', 'Minimum 2 Year(s) Of Experience Is Required'), '2+ years');
check('an HTML-escaped plus is a plus', groundExperienceYears('1 year', '1&#43; years of experience developing commercial'), '1+ years');
check('a single year is singular', groundExperienceYears('1 year', '1 year of experience with one or more of the following'), '1 year');
check('"2 years" is not inside "0-2 years"', groundExperienceYears('2 years', '0-2 years of work experience in testing'), '');
check('a figure with no "experience" near it is not one', groundExperienceYears('3 years', 'We are a team with 3 years in the market. Must know Java.'), '');
check('the company\'s history is not a requirement', groundExperienceYears('30+ years', 'Cyncly brings over 30 years of experience to deliver'), '');
check('nor is schooling', groundExperienceYears('15 years', 'Minimum 2 Year(s) Of Experience Is Required. Educational Qualification : 15 years full time education'), '');
check('a figure the posting does not state is dropped', groundExperienceYears('0-1 years', '1-3 years of experience in IT'), '');
check('a bare range is in years, by definition of the field', groundExperienceYears('0–2', '0-2 years of work experience in testing'), '0–2 years');
check('but a bare number the posting never gives in years is nothing', groundExperienceYears('0', 'Freshers welcome, 0 experience needed'), '');
check('a word is not a figure', groundExperienceYears('Freshers', 'Freshers are welcome to apply. 0 experience needed'), '');

console.log('\n== a graduation window: the year the graduation word governs, and its qualifiers ==');
const RAMP = 'or a related technical field, graduating December 2027 or later Experience with Kotlin';
check('Ramp', groundGraduation('Graduating Dec 2027 or later', RAMP), 'Graduating Dec 2027 or later');
check('Amazon writes "or earlier"; "or later" is dropped',
  groundGraduation('Graduating May 2027 or later', 'with a final graduation date of May 2027 or earlier - Coursework'), '');
check('a range', groundGraduation('Graduating Fall 2027-Spring 2029', 'Must graduate between Fall 2027 and Spring 2029 Currently pursuing'), 'Graduating Fall 2027–Spring 2029');
check('NatWest: the graduation word AFTER the years', groundGraduation('2025 or 2026 graduates', 'You’ll also need: 2025 or 2026 BE, B.Tech, or M.Tech graduates with academic, internship'), '2025 or 2026 graduates');
check('and a year cut from that list is refused', groundGraduation('2026 graduates', 'You’ll also need: 2025 or 2026 BE, B.Tech, or M.Tech graduates with academic, internship'), '');
check('Lennox: pass-outs', groundGraduation('2025 or 2026 graduates', 'B.Sc. / BCA (2025 or 2026 pass-outs) No prior experience required'), '2025 or 2026 graduates');
const GOOGLE = 'anticipated graduation date in 2028 and full-time availability for a 10- to 12-week internship starting in the summer of 2027 (May/June onwards)';
check('Google: the internship\'s year is not the graduating one', groundGraduation('Graduating 2027', GOOGLE), '');
check('the graduating one is', groundGraduation('Graduating 2028', GOOGLE), 'Graduating 2028');
const SUMMER = 'Summer 2027 internship for students graduating in 2028. Python required.';
check('the same trap the other way round', groundGraduation('Graduating 2027', SUMMER), '');
check('and its real year still passes', groundGraduation('Graduating 2028', SUMMER), 'Graduating 2028');
check('and with no season to give it away', groundGraduation('Graduating 2027', 'The 2027 internship is for students graduating in 2028.'), '');
check('Flow Traders: "Class of 2028, preferred" is not a requirement', groundGraduation('Class of 2028', 'Economics or related Class of 2028, preferred Demonstrable interest'), '');
check('Lam: a "Preferred Qualifications" heading after it is not a preference',
  groundGraduation('Graduating 2027', 'minimum 65% aggregate Graduating in 2027 without any backlogs Preferred Qualifications'), 'Graduating 2027');
check('Barclays: "degree achieved before June 2027" is a graduation window',
  groundGraduation('Graduating before June 2027', 'you’ll be motivated with a strong degree or expected degree achieved before June 2027. You’ll also bring'), 'Graduating before Jun 2027');
check('Capital One: "degree will be obtained by August 2029 or earlier"',
  groundGraduation('Graduating by Aug 2029 or earlier', 'with an expectation that the required degree will be obtained by August 2029 or earlier: A PhD in a quantitative field'), 'Graduating by Aug 2029 or earlier');
check('a bare year is not a phrase', groundGraduation('2027', 'Graduating in 2027 without any backlogs'), '');
/* COMPLETENESS: a phrase that leaves out what the posting attaches to the
   year is a different requirement, not a shorter one. */
check('a range cut to its start is refused', groundGraduation('Graduating 2027', 'Must graduate between Fall 2027 and Spring 2029 Currently pursuing'), '');
check('so is a dropped "or later"', groundGraduation('Graduating May 2027', 'with a graduation date of May 2027 or later. Would consider'), '');
const MICRON = 'Must be continuing academic studies through at least Fall 2027 and not graduate before Fall 2027. Coursework';
check('Micron: dropping the "not" inverts it', groundGraduation('Graduating before Fall 2027', MICRON), '');
/* A PREFERENCE IS NOT A REQUIREMENT. */
const WF = (heading) => `Required Qualifications: 6+ months of work experience ${heading}: Currently pursuing a bachelor's degree in Computer Science, or related STEM field with an expected graduation: December 2027 - June 2028 Foundational knowledge`;
check('Wells Fargo: a window under "Desired Qualifications" is refused', groundGraduation('Graduating Dec 2027 - June 2028', WF('Desired Qualifications')), '');
check('the same window under "Basic Qualifications" is kept, months read one way',
  groundGraduation('Graduating Dec 2027 - June 2028', WF('Basic Qualifications')), 'Graduating Dec 2027–Jun 2028');
check('NetApp: "is preferred" after the figure', groundExperienceYears('1-2 years', 'for Bachelor’s degree holders, 1–2 years of relevant experience is preferred. This is'), '');
check('Accenture: "Minimum … Is Required" outranks the heading before it',
  groundExperienceYears('2 years', 'Must have skills : Java Good to have skills : NA Minimum 2 Year(s) Of Experience Is Required'), '2+ years');
check('Pitney Bowes: the next heading is not a preference',
  groundExperienceYears('0-2 years', 'Bachelor’s degree in IT or equivalent 0–2 years of experience (freshers with relevant certifications can be considered) Preferred Certifications (Not Mandatory)'), '0–2 years');
check('a figure under "Preferred Qualifications" is refused',
  groundExperienceYears('1+ years', 'Basic Qualifications: Python. Preferred Qualifications: 1+ years of experience with Go'), '');
check('and keeping it passes', groundGraduation('Not graduating before Fall 2027', MICRON), 'Not graduating before Fall 2027');
check('Micron: the next sentence\'s "Prior" does not qualify the year',
  groundGraduation('Graduating after Dec 2027', 'Minimum Qualifications Currently pursuing an M.S. in Chemistry, with a graduation date after December 31, 2027. Prior academic experience in wet processing'), 'Graduating after Dec 2027');
check('"must not graduate" reads as "Not graduating"', groundGraduation('Must not graduate before Fall 2027', MICRON), 'Not graduating before Fall 2027');
check('"Graduation after" reads as "Graduating after"',
  groundGraduation('Graduation after Sep 2027', 'exceptional undergraduate candidates may be considered. Graduation date after September 2027. Academic'), 'Graduating after Sep 2027');
check('a year the posting never gives is dropped', groundGraduation('Graduating 2029', RAMP), '');
check('so is a month and a qualifier it never gives', groundGraduation('Graduating May 2027 or later', 'Graduating in 2027 without any backlogs'), '');
check('a year governed by the word after it, past another before it',
  groundGraduation('2027 graduates', 'Class of 2028 students may apply; 2027 graduates are also welcome'), '2027 graduates');
check('but not when the two years are one list', groundGraduation('2027 graduates', 'Open to the Class of 2028 or 2027 graduates with Python'), '');

console.log('\n== groundFacts: what reaches the store ==');
{
  const { groundFacts } = await import('../src/ollama.js');
  const POSTING = 'Must graduate between Fall 2027 and Spring 2029. 0-1 years of relevant experience. Deadline to Apply: 10/16/26.';
  const model = { deadline: '2026-10-16', graduation: 'Graduating Fall 2027–Spring 2029', experienceYears: '0-1 years' };
  const kept = groundFacts(model, POSTING, 'US');
  check('a stated deadline is kept', kept.deadline, '2026-10-16');
  check('both kinds of experience, graduation first', kept.experience, 'Graduating Fall 2027–Spring 2029 · 0–1 years');
  check('nothing stated was dropped', kept.dropped, []);
  const invented = groundFacts({ deadline: '2026-11-30', graduation: 'Graduating 2027', experienceYears: '2 years' }, POSTING, 'US');
  check('an invented deadline is dropped', invented.deadline, '');
  check('and invented experience', invented.experience, '');
  check('and each is reported', invented.dropped, ['deadline', 'graduation', 'experienceYears']);
  check('10/06/26 needs the region to be read at all', groundFacts(model, 'Deadline to Apply: 10/06/26.', null).deadline, '');
  check('an empty reply is nothing, not a crash', groundFacts(null, POSTING, 'US'), { deadline: '', experience: '', dropped: [] });
}

console.log('\n== couldStateFacts is a superset of all three guards ==');
/* The backfill skips the model when this is false, so a posting any guard
   would accept must never read false here. */
for (const [label, text, region] of [
  ['a stated deadline', 'Deadline to Apply: 10/16/26', 'US'],
  ['a years figure', 'Minimum 2 Year(s) Of Experience Is Required', 'IN'],
  ['an escaped plus', '1&#43; years of experience', 'US'],
  ['a graduation year', 'graduating December 2027 or later', 'US'],
  ['pass-outs', '(2025 or 2026 pass-outs)', 'IN'],
]) check(`says yes to ${label}`, couldStateFacts(text, region), true);
check('and no to a posting that states neither', couldStateFacts('Build APIs in Go. Summer 2027 internship in Austin.', 'US'), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
