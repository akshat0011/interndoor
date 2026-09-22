/**
 * THE PER-EMPLOYER ROLE GATE — `employerRoleAllowed`.
 *
 * Some real employers are on the watchlist for their engineering roles and then
 * fill the board with bench and staffing postings named after a vendor product.
 * Infosys ran 31 of the India board's 386 rows (8%) as "Quadient Inspire Scaler
 * developer", "VisionPlus Developer", "IBM Filenet", "Sitecore XP developer".
 * De-listing the employer would take their genuine SDE, data and ML postings
 * with it, so the gate is per employer.
 *
 * THE SAFETY PROPERTY IS THAT IT IS INERT EVERYWHERE ELSE, and it is asserted
 * against the LIVE config over the LIVE boards rather than a fixture — a
 * fixture would keep passing after someone added a second employer with a
 * careless term. §9's rule for veto terms, met by scoping instead of by a
 * store-wide sweep.
 */
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig, employerRoleAllowed, normaliseCompany } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

const cfg = loadConfig();

console.log('\n== an employer with no rule is untouched ==');
{
  /* The whole gate has to cost nothing for the ~1,880 employers nobody has
     written a rule for. Without this the feature is a liability. */
  check('a random employer passes anything', employerRoleAllowed('Qualcomm', 'Quadient Inspire Scaler developer', cfg), true);
  check('an empty company passes', employerRoleAllowed('', 'anything', cfg), true);
  check('a null company passes', employerRoleAllowed(null, 'anything', cfg), true);
  check('no config at all passes', employerRoleAllowed('Infosys', 'IBM Filenet', {}), true);
  check('no matching block passes', employerRoleAllowed('Infosys', 'IBM Filenet', { matching: {} }), true);
}

console.log('\n== the configured employer: mainstream roles in, vendor products out ==');
{
  const keep = ['Data engineer', 'Data Scientist/Machine Learning Consultant', 'React JS',
    'Nextjs Developer', 'java full stack', 'Python Django', 'AI ML Engineer', 'Gen Ai Engineer',
    'Microservices and Node Developer', 'Intern'];
  for (const t of keep) check(`keeps "${t}"`, employerRoleAllowed('Infosys', t, cfg), true);

  const drop = ['Quadient Inspire Scaler developer', 'VisionPlus Developer', 'IBM Filenet',
    'Open Text Developer', 'Sitecore XP developer', 'IICS Developer', 'AEM, EDS',
    'Quantexa Engineers', 'SAP Tosca Test Engineer', 'ETL/DWT Test Engineer'];
  for (const t of drop) check(`drops "${t}"`, employerRoleAllowed('Infosys', t, cfg), false);
}

console.log('\n== deny beats allow ==');
{
  /* The interesting case, and the reason `deny` exists at all: a title that
     names a mainstream stack AND a job we do not want. Without the precedence
     these two slip through on `java` and `.net`. */
  check('"java springboot production support" is refused despite java',
    employerRoleAllowed('Infosys', 'java springboot production support', cfg), false);
  check('".Net production support" is refused despite .net',
    employerRoleAllowed('Infosys', '.Net production support', cfg), false);
  check('"Python Test Engineer" is refused despite python',
    employerRoleAllowed('Infosys', 'Python Test Engineer', cfg), false);
  /* ...while the same stack without the denied words is kept, or the rule is
     just a ban on the stack. */
  check('but plain "Python Django" is kept', employerRoleAllowed('Infosys', 'Python Django', cfg), true);
}

console.log('\n== the key is the NORMALISED company name ==');
{
  /* normaliseCompany strips legal and industry words, so one entry has to reach
     every spelling of the employer rather than needing three. */
  check('Infosys normalises to a bare word', normaliseCompany('Infosys Limited'), normaliseCompany('Infosys'));
  for (const name of ['Infosys', 'Infosys Limited', 'INFOSYS', 'Infosys Technologies']) {
    check(`"${name}" is matched by the rule`, employerRoleAllowed(name, 'IBM Filenet', cfg), false);
  }
  /* THE KEY MATCHES AS A WHOLE WORD INSIDE THE COMPANY NAME, AND THAT IS
     DELIBERATE — it is what makes one entry cover "Infosys BPM" without a
     second one. Pinned in both directions rather than assumed, because it is
     the same loose containment that lets matchCompany file "Pine Rest
     Christian Mental Health Services" under Pine Labs: anything carrying
     "Infosys" as a word is governed by the Infosys rule. That is right for
     subsidiaries and would be wrong for an unrelated firm with the word in its
     name; no such firm exists in 20,000 employer names seen, and this check is
     where it would show up. */
  check('a subsidiary is covered by the one entry', employerRoleAllowed('Infosys BPM', 'IBM Filenet', cfg), false);
  check('and so is any name carrying the word', employerRoleAllowed('Infosys Rivals Inc', 'IBM Filenet', cfg), false);
  /* But a SUBSTRING is not a word: "Infosystems" is a different company and the
     boundary is what keeps it out. */
  check('a mere substring is NOT caught', employerRoleAllowed('Infosystems Global', 'IBM Filenet', cfg), true);
}

console.log('\n== a rule with only one half still behaves ==');
{
  const allowOnly = { matching: { employerRoles: { Acme: { allow: ['engineer'] } } } };
  check('allow-only keeps a match', employerRoleAllowed('Acme', 'Data Engineer', allowOnly), true);
  check('allow-only drops a non-match', employerRoleAllowed('Acme', 'Sitecore Developer', allowOnly), false);
  const denyOnly = { matching: { employerRoles: { Acme: { deny: ['support'] } } } };
  /* With no allow list the employer keeps everything deny does not catch —
     otherwise a deny-only rule would silently ban the employer outright. */
  check('deny-only keeps anything not denied', employerRoleAllowed('Acme', 'Sitecore Developer', denyOnly), true);
  check('deny-only drops what is denied', employerRoleAllowed('Acme', 'Production Support', denyOnly), false);
  const empty = { matching: { employerRoles: { Acme: {} } } };
  check('an empty rule keeps everything', employerRoleAllowed('Acme', 'anything at all', empty), true);
  /* THE _note VALUE HAS TO BE RULE-SHAPED OR THIS TESTS NOTHING. With a string
     value, treating `_note` as a company changes no outcome — `rule.deny?.some`
     on a string is undefined and it falls through to true either way, so the
     mutation that drops the guard survives. Mutation testing caught exactly
     that. Given a real rule, the guard is the only thing keeping it out. */
  const note = { matching: { employerRoles: { _note: { deny: ['whatever'] }, Acme: { allow: ['engineer'] } } } };
  check('an _note key is not treated as a company', employerRoleAllowed('_note', 'whatever', note), true);
}

console.log('\n== matching is whole-word ==');
{
  /* Without word boundaries "ai" matches "Email", "java" matches "javascript"
     in the wrong direction, and the gate starts keeping things nobody chose. */
  const r = { matching: { employerRoles: { Acme: { allow: ['ai'] } } } };
  check('"ai" does not match inside "Email"', employerRoleAllowed('Acme', 'Email Marketing', r), false);
  check('"ai" matches as its own word', employerRoleAllowed('Acme', 'AI Engineer', r), true);
}

console.log('\n== INERT FOR EVERY OTHER EMPLOYER, over the live boards ==');
{
  let checked = 0, affected = 0;
  const hits = [];
  for (const p of ['web/public/data/jobs.json', 'web/public/us/data/jobs.json', 'web/public/uk/data/jobs.json']) {
    if (!existsSync(p)) continue;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    for (const row of (Array.isArray(raw) ? raw : raw.jobs ?? [])) {
      if (/infosys/i.test(row.company ?? '')) continue;
      checked++;
      if (!employerRoleAllowed(row.company, row.title, cfg)) { affected++; if (hits.length < 5) hits.push(`${row.company} | ${row.title}`); }
    }
  }
  check('there are live rows to check against', checked > 500, true);
  check('no other employer loses a posting', affected === 0 ? [] : hits, []);
}


console.log('\n== the gate is actually WIRED IN, in all three places ==');
{
  /* A guard nothing calls is not a guard. §11 already lost a whole feature this
     way — `closable` worked perfectly and writeSite quietly stopped passing it,
     leaving every test green while the live site did nothing. Mutation testing
     found the same hole here: removing the call from publish.js left every
     assertion above passing. */
  const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const pub = strip('../src/publish.js');
  check('publish.js imports it', /import \{[^}]*employerRoleAllowed[^}]*\} from '\.\/config\.js'/.test(pub), true);
  /* PUBLISH IS THE AUTHORITY: re-running it here is what makes a config edit
     take effect over rows already stored, with no DB surgery. */
  check('publish.js filters on it', /\.filter\(\(\{ row \}\) => \{\s*if \(employerRoleAllowed\(row\.company, row\.title, cfg\)\) return true;/.test(pub), true);

  const idx = strip('../src/index.js');
  check('the scan imports it', /employerRoleAllowed/.test(idx), true);
  check('the scan refuses a card before the click', /if \(!employerRoleAllowed\(card\.company, card\.title, cfg\)\)/.test(idx), true);

  const ats = strip('../bin/poll-ats.js');
  check('the ATS poller applies it too', /if \(!employerRoleAllowed\(board\.company, j\.title, cfg\)\)/.test(ats), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
