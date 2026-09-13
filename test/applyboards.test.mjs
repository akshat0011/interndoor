/**
 * ATS boards read off apply links — src/applyboards.js.
 *
 * The one failure that matters here is seeding ANOTHER employer's board under a
 * watchlist company, because the poller would then publish that employer's
 * whole board under our company's name. Every fixture below that must be
 * refused is a real posting from the store, verbatim, filed under the watchlist
 * entry `matchCompany` loosely gave it on 13 Sep 2026.
 */
import { boardsFromApplyLinks } from '../src/applyboards.js';
import { normaliseCompany, matchCompany } from '../src/config.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

/** A watchlist built the way loadConfig builds one: display name + normalised term. */
const watchlist = [
  ['Pine Labs'], ['Mercury Technologies'], ['Titan Company'], ['Wonder Cement'],
  ['American Express'], ['NewSpace Research'], ['Otis Elevator'], ['HighLevel'],
  ['Honeywell', ['Honeywell Technologies']], ['WS Audiology', ['WSA – Wonderful Sound for All']],
].flatMap(([display, aliases = []]) =>
  [display, ...aliases].map((n) => ({ display, term: normaliseCompany(n) })));

const row = (company, apply_url, first_seen_at = 1) => ({ company, apply_url, first_seen_at });
const boardFor = (rows, company) => boardsFromApplyLinks(rows, watchlist).find((b) => b.company === company) ?? null;

console.log('\n== ANOTHER EMPLOYER\'S BOARD IS NEVER SEEDED ==');
{
  /* normaliseCompany reduces "Pine Labs" to the bare word `pine`, so every one
     of these reached the watchlist entry through a single shared word.
     ASSERTED FIRST: a refusal is only a test of the guard if the posting really
     does match the entry. Without this, a watchlist that simply failed to match
     "Wonder" would pass every refusal below on an empty candidate list. */
  for (const [posting, entry] of [['Pine Rest Christian Mental Health Services', 'Pine Labs'],
    ['Mercury Marine', 'Mercury Technologies'], ['Titan Electric Companies', 'Titan Company'],
    ['Wonder', 'Wonder Cement']]) {
    check(`precondition: matchCompany files "${posting}" under ${entry}`, matchCompany(posting, watchlist), entry);
  }
  check('Pine Rest\'s Workday is not Pine Labs\'',
    boardFor([row('Pine Rest Christian Mental Health Services',
      'https://pinerest.wd5.myworkdayjobs.com/PineRest/job/Grand-Rapids-MI/Intern')], 'Pine Labs'), null);
  check('Brunswick\'s Workday (Mercury Marine) is not Mercury Technologies\'',
    boardFor([row('Mercury Marine',
      'https://brunswick.wd1.myworkdayjobs.com/search/job/Fond-du-Lac-WI/Mercury-Marine--Software')], 'Mercury Technologies'), null);
  check('Titan Electric\'s Lever is not Titan Company\'s',
    boardFor([row('Titan Electric Companies', 'https://jobs.lever.co/titanelectric-ga/b5ba89be/apply')], 'Titan Company'), null);
  /* The board name CONTAINS the company's first word here, which is why a
     token-name check was the wrong design: it admitted this one. */
  check('US Wonder\'s Workday is not Wonder Cement\'s, though `wonder` names both',
    boardFor([row('Wonder', 'https://wonder.wd1.myworkdayjobs.com/WG/job/NY/Intern')], 'Wonder Cement'), null);
}

console.log('\n== THE COMPANY\'S OWN BOARD IS FOUND ==');
{
  /* An opaque Oracle host carries no name at all; the posting's name equalling
     the watchlist term is what vouches for it. */
  check('an exact employer name admits an opaque token',
    boardFor([row('American Express', 'https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/123')], 'American Express'),
    { company: 'American Express', provider: 'oraclecloud', token: 'egug.fa.us2.oraclecloud.com', postings: 1, lastSeen: 1 });
  check('an alias counts as exact',
    boardFor([row('Honeywell Technologies', 'https://ibqbjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/9')], 'Honeywell')?.token,
    'ibqbjb.fa.ocs.oraclecloud.com');
  /* The only path that admits this one is the exact-term check: the posting
     shares no word with "WS Audiology" at all. It is the name LinkedIn really
     shows for that employer, added as an alias for exactly that reason. */
  check('an alias with no word in common with the company is admitted by exactness alone',
    boardFor([row('WSA – Wonderful Sound for All', 'https://jobs.smartrecruiters.com/WSAudiology/74400')], 'WS Audiology')?.token,
    'WSAudiology');
  check('a longer legal name carrying every word of ours is admitted',
    boardFor([row('NewSpace Research and Technologies', 'https://newspace.keka.com/careers/jobdetails/42')], 'NewSpace Research')?.token,
    'newspace');
  check('extra words in the posting\'s name do not stop it vouching (Otis Elevator Co.)',
    boardFor([row('Otis Elevator Co.', 'https://otis.wd504.myworkdayjobs.com/REC_Ext_Gateway/job/Farmington/Intern')], 'Otis Elevator')?.token,
    'otis:wd504:REC_Ext_Gateway');
}

console.log('\n== ONE BOARD PER COMPANY, AND ONLY REAL BOARDS ==');
{
  const rows = [
    // Newest FIRST, so "the last row seen" and "the newest row" differ.
    row('HighLevel', 'https://jobs.lever.co/gohighlevel/b', 6),
    row('HighLevel', 'https://jobs.lever.co/gohighlevel/a', 5),
    row('HighLevel', 'https://job-boards.greenhouse.io/someoneelse/jobs/1', 9),
  ];
  const b = boardFor(rows, 'HighLevel');
  check('the board its postings link to most often wins', b?.token, 'gohighlevel');
  check('and counts those postings', b?.postings, 2);
  check('lastSeen is the newest of them, not of every link', b?.lastSeen, 6);
  check('one entry per company', boardsFromApplyLinks(rows, watchlist).filter((x) => x.company === 'HighLevel').length, 1);

  check('an apply link that is no ATS board yields nothing',
    boardsFromApplyLinks([row('HighLevel', 'https://www.gohighlevel.com/careers')], watchlist), []);
  check('LinkedIn\'s own apply form yields nothing',
    boardsFromApplyLinks([row('HighLevel', 'https://www.linkedin.com/job-apply/4412')], watchlist), []);
  check('an employer off the watchlist yields nothing',
    boardsFromApplyLinks([row('Acme Rockets', 'https://jobs.lever.co/acme/1')], watchlist), []);
  check('no rows, no boards', boardsFromApplyLinks([], watchlist), []);
  check('null rows do not throw', boardsFromApplyLinks(null, watchlist), []);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passing, ${fail} failing`);
process.exit(fail === 0 ? 0 : 1);
