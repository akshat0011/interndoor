import { stripHtml, parseAtsLink, workdayPlaces, isWorkplaceType,
  fetchBoard, PROVIDER_NAMES, FIRST_PARTY_BOARDS, boardTokens, microsoftPlace } from '../src/ats.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRegion, UNKNOWN } from '../src/regions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}

console.log('\n== ordinary HTML ==');
check('tags removed', stripHtml('<p>Hello <strong>world</strong></p>'), 'Hello world');
check('block tags become newlines', stripHtml('<li>One</li><li>Two</li>'), 'One\nTwo');
check('br becomes a newline', stripHtml('One<br>Two'), 'One\nTwo');
check('attributes do not survive', stripHtml('<div class="x" data-y="z">Text</div>'), 'Text');
check('entities decoded', stripHtml('<p>R&amp;D at 9&nbsp;AM</p>'), 'R&D at 9 AM');
check('smart quotes', stripHtml('<p>&ldquo;early&rdquo; &rsquo;s</p>'), '"early" \'s');

console.log('\n== an entity-escaped document ==');
// Greenhouse answers with the whole document escaped — there is not one literal
// `<` in it. Stripping tags first found nothing, and the entity decode that ran
// afterwards turned the markup into visible text. Roblox's card on the US board
// read "<p><br><strong>You Will:</strong></p> There, you'll gain access to...".
const escaped = '&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;&lt;strong&gt;You Will:&lt;/strong&gt;&lt;/p&gt;Build things.&lt;/div&gt;';
check('markup does not survive as text', stripHtml(escaped), 'You Will:\nBuild things.');
check('no angle brackets left at all', /[<>]/.test(stripHtml(escaped)), false);
check('escaped br', stripHtml('One&lt;br&gt;Two'), 'One\nTwo');

console.log('\n== a document with real tags keeps escaped ones as text ==');
// A frontend posting genuinely writing about <div> elements. The escape-first
// path must not fire here: this document has real tags, so the escaped ones are
// content the reader is meant to see.
check('escaped tag inside real markup is content',
  stripHtml('<p>You will style &lt;div&gt; elements.</p>'),
  'You will style <div> elements.');
check('mixed document is not double-stripped',
  stripHtml('<ul><li>Know &lt;section&gt; and &lt;main&gt;</li></ul>'),
  'Know <section> and <main>');

console.log('\n== double-escaped ampersands ==');
// &amp; is decoded last, or "&amp;lt;" collapses to "<" in a single pass
// instead of stopping at "&lt;".
check('amp decoded after the rest', stripHtml('<p>Tom &amp;amp; Jerry</p>'), 'Tom &amp; Jerry');

console.log('\n== whitespace ==');
check('runs of spaces collapse', stripHtml('<p>a     b</p>'), 'a b');
check('three or more newlines collapse to two', stripHtml('a<br><br><br><br>b'), 'a\n\nb');
check('trimmed', stripHtml('  <p>  x  </p>  '), 'x');

console.log('\n== degenerate input ==');
check('empty', stripHtml(''), '');
check('null', stripHtml(null), 'null');
check('no markup at all', stripHtml('Just words.'), 'Just words.');

console.log('\n== Workday links, the ones that cannot be guessed ==');
// A Workday token is `tenant:wdN:site` and NO part of the site name is
// derivable from the company — "CareerDepot", "CSC_Careers", "External". If
// this parser misses the link the board is simply unreachable, which is why
// nine companies with Workday on their careers page had no board at all.
const wd = (u) => { const r = parseAtsLink(u); return r ? `${r.provider}:${r.token}` : null; };
check('plain', wd('https://homedepot.wd5.myworkdayjobs.com/CareerDepot/login'), 'workday:homedepot:wd5:CareerDepot');
check('deep job path', wd('https://nordstrom.wd501.myworkdayjobs.com/nordstrom_careers/job/Dubuque-IA/x_R-1'), 'workday:nordstrom:wd501:nordstrom_careers');
check('three-digit datacentre', wd('https://a.wd501.myworkdayjobs.com/Careers'), 'workday:a:wd501:Careers');
check('underscored site', wd('https://columbiasportswearcompany.wd5.myworkdayjobs.com/CSC_Careers'), 'workday:columbiasportswearcompany:wd5:CSC_Careers');
// Both domains are real and in use. Missing the second loses the whole tenant.
check('myworkdaysite.com', wd('https://acme.wd3.myworkdaysite.com/en-US/Careers'), 'workday:acme:wd3:Careers');
check('en-US locale skipped', wd('https://acme.wd1.myworkdayjobs.com/en-US/Global'), 'workday:acme:wd1:Global');
check('en_US locale skipped', wd('https://acme.wd1.myworkdayjobs.com/en_US/Global'), 'workday:acme:wd1:Global');
check('no locale', wd('https://travelers.wd5.myworkdayjobs.com/External'), 'workday:travelers:wd5:External');

console.log('\n== the other providers still parse ==');
check('greenhouse', wd('https://boards.greenhouse.io/cloudflare'), 'greenhouse:cloudflare');
// The embed form hides the real token in a query parameter; matching the path
// first would capture the literal word "embed" as the board name.
check('greenhouse embed', wd('https://boards.greenhouse.io/embed/job_board?for=cloudsek'), 'greenhouse:cloudsek');
check('lever', wd('https://jobs.lever.co/gopuff'), 'lever:gopuff');
check('ashby', wd('https://jobs.ashbyhq.com/drata'), 'ashby:drata');
check('smartrecruiters', wd('https://jobs.smartrecruiters.com/WesternDigital'), 'smartrecruiters:WesternDigital');
check('nothing to find', wd('https://example.com/careers'), null);
check('empty', wd(''), null);

console.log('\n== Workday names the place only on the per-job endpoint ==');
/* `locationsText` — the only location the LIST offers — is the literal string
   "2 Locations" for any posting spanning offices, so these rows resolved to
   nowhere and were stored and never published. The shapes below are the real
   payloads, probed 5 Sep 2026 against boards the poller already reads. */
const conoco = { location: 'Houston, TX',
  additionalLocations: ['Dickinson, ND', 'Loving, NM'],
  jobRequisitionLocation: { country: { descriptor: 'United States of America', alpha2Code: 'US' } } };
check('the real place comes first', workdayPlaces(conoco)[0], 'Houston, TX');
check('then the additional offices, then the country',
  workdayPlaces(conoco),
  ['Houston, TX', 'Dickinson, ND', 'Loving, NM', 'United States of America']);

/* AMBARELLA IS WHY `country` IS NOT BELT-AND-BRACES. Its office really is named
   "US Headquarters", so `location` repeats the placeholder and only the country
   places the role. Drop country and seven live rows stay invisible. */
const ambarella = { location: 'US Headquarters', additionalLocations: null,
  jobRequisitionLocation: { country: { descriptor: 'United States of America' } } };
check('a placeholder location still yields the country',
  workdayPlaces(ambarella), ['US Headquarters', 'United States of America']);
check('and the country is what actually places it',
  workdayPlaces(ambarella).map((s) => resolveRegion(s, {})).find((r) => r !== UNKNOWN), 'US');
check('the placeholder itself places nothing', resolveRegion('US Headquarters', {}), UNKNOWN);

/* FEDEX IS THE SECOND REASON. Its `location` is an internal facility code. */
const fedex = { location: 'FXE_APAC/MYS/MYKULIP/Kulip Gateway',
  additionalLocations: ['FXE_APAC/MYS/MYXKLA/Subang Hi-tech Industrial Park'],
  jobRequisitionLocation: { country: { descriptor: 'Malaysia' } } };
/* NEVER ASSUME US, AND THIS IS THE HALF THAT MATTERS. FedEx's "2 Locations" is
   Malaysia and Nvidia's is Beijing and Shanghai. The gazetteer has no entry for
   either country — measured, not assumed — so both stay `unknown` and stay
   unpublished, exactly as they were. The gain from this fix is bounded to the
   regions regions.js already knows; what must never happen is that a candidate
   nobody could place gets filed as American because most Workday rows are.
   Asserting the region equals 'MY' would pin a gazetteer this project does not
   have; asserting it is never 'US' pins the rule. */
const fedexPlaces = workdayPlaces(fedex).map((s) => resolveRegion(s, {}));
check('a Malaysian facility is never filed as US', fedexPlaces.includes('US'), false);
check('and stays unplaced rather than guessed', fedexPlaces.every((r) => r === UNKNOWN), true);

const nvidia = { location: 'China, Beijing', additionalLocations: ['China, Shanghai'],
  jobRequisitionLocation: { country: { descriptor: 'China' } } };
const nvidiaPlaces = workdayPlaces(nvidia).map((s) => resolveRegion(s, {}));
check('a Chinese posting is never filed as US', nvidiaPlaces.includes('US'), false);
/* ASSERT THE PROPERTY, NOT THE GAP. This line used to read "and stays unplaced
   rather than guessed", which was true until China was added to the gazetteer
   the same afternoon — the second assertion in this file to rot that way. A
   check that pins "we cannot place this" is a time bomb: it documents a gap and
   dies the day the gap is closed.

   What must hold for ever is that a Chinese posting never reaches a PUBLISHED
   board. That survives China being added, removed, or renamed. (Note the
   candidates do not all agree: "China, Beijing" and "China, Shanghai" resolve
   CN while a bare "China" is unknown, because `china` is deliberately not a
   country name — see §6.) */
check('and no candidate ever reaches a published board',
  nvidiaPlaces.some((r) => ['IN', 'US', 'GB'].includes(r)), false);
/* The counterpart: a country the gazetteer DOES know is placed by country alone,
   which is the Ambarella path above and the whole reason `country` is harvested. */
check('a known country still places from the country field',
  resolveRegion(workdayPlaces({ location: 'Bengaluru Office',
    jobRequisitionLocation: { country: { descriptor: 'India' } } }).at(-1), {}), 'IN');

console.log('\n== the two country fields, and why only one may be read ==');
/* WORKDAY'S TOP-LEVEL `country` IS THE CAREERS SITE'S, NOT THE ROLE'S. Copeland
   files a maintenance co-op in Ramos Arizpe, Mexico, and answers:
       location                        "Ramos Arizpe, Mexico"
       country                         "United States of America"   <- the site
       jobRequisitionLocation.country  "Mexico"                     <- the role
   Reading the top-level one puts a Mexican role on the American board. Checked
   across ten tenants: they agree everywhere but here, and here the requisition
   is right. */
const copeland = { location: 'Ramos Arizpe, Mexico', additionalLocations: null,
  country: { descriptor: 'United States of America', id: 'bc33' },
  jobRequisitionLocation: { descriptor: 'Ramos Arizpe - Motors',
    country: { descriptor: 'Mexico', alpha2Code: 'MX' } } };
check('the site country is never a candidate',
  workdayPlaces(copeland).includes('United States of America'), false);
check('the requisition country is', workdayPlaces(copeland), ['Ramos Arizpe, Mexico', 'Mexico']);
check('so a Mexican role is never filed as US',
  workdayPlaces(copeland).map((s) => resolveRegion(s, {})).includes('US'), false);
/* And it stays unplaced, which is correct — `mexico` is absent from the
   gazetteer on purpose (§6, the "New Mexico" trap) and MX is not published. */
check('and stays unplaced rather than guessed',
  workdayPlaces(copeland).every((s) => resolveRegion(s, {}) === UNKNOWN), true);
check('there is no fallback to the site country',
  workdayPlaces({ location: 'Nowhere Site', country: { descriptor: 'United States of America' } }),
  ['Nowhere Site']);

// Trane repeats `location` inside `additionalLocations`.
check('a repeated office appears once',
  workdayPlaces({ location: 'La Crosse, Wisconsin', additionalLocations: ['La Crosse, Wisconsin'] }),
  ['La Crosse, Wisconsin']);

console.log('\n== and it survives every shape the boards actually answer with ==');
check('no additionalLocations key', workdayPlaces({ location: 'Austin, TX' }), ['Austin, TX']);
check('additionalLocations not an array', workdayPlaces({ location: 'Austin, TX', additionalLocations: 'x' }), ['Austin, TX']);
check('requisition without a country', workdayPlaces({ location: 'Austin, TX', jobRequisitionLocation: {} }), ['Austin, TX']);
check('country without a descriptor', workdayPlaces({ location: 'Austin, TX', jobRequisitionLocation: { country: {} } }), ['Austin, TX']);
check('country as a bare string is ignored', workdayPlaces({ location: 'Austin, TX', jobRequisitionLocation: { country: 'USA' } }), ['Austin, TX']);
check('non-string entries dropped', workdayPlaces({ location: null, additionalLocations: [null, 7, '  ', 'Pune, India'] }), ['Pune, India']);
check('an empty posting yields nothing', workdayPlaces({}), []);
check('a missing posting yields nothing', workdayPlaces(undefined), []);

console.log('\n== a workplace type is not a place ==');
/* Greenhouse's `location.name` is free text and Cloudflare types the WAY OF
   WORKING into it: all 332 of its postings answer "In-Office" while the real
   city sits in offices[]. Where that office resolves the fallback already
   replaced the text; where it does not — Lisbon, because Portugal is absent
   from the gazetteer — the row kept "In-Office" for ever, which is what makes
   §6's "a better gazetteer picks those rows up later" worthless for it. */
check('in-office', isWorkplaceType('In-Office'), true);
check('hybrid', isWorkplaceType('Hybrid'), true);
check('on-site', isWorkplaceType('On-Site'), true);
check('spelling and spacing variants', [isWorkplaceType('onsite'), isWorkplaceType('In Office'), isWorkplaceType('on site')], [true, true, true]);
check('case and padding ignored', isWorkplaceType('  in-OFFICE  '), true);
/* REMOTE IS THE ONE THAT MUST NOT BE IN THE LIST. In-office, hybrid and on-site
   all describe how you work AT an office, so substituting that office
   clarifies. Remote describes the absence of one — swapping an address in
   there tells a student to be in Austin for a job that is not in Austin. */
check('remote is NOT a workplace type', isWorkplaceType('Remote'), false);
check('nor work from home', isWorkplaceType('Work from home'), false);
check('a real place is not one', [isWorkplaceType('Austin, TX'), isWorkplaceType('Lisbon, Portugal')], [false, false]);
check('nothing is not one', [isWorkplaceType(null), isWorkplaceType(undefined), isWorkplaceType('')], [false, false, false]);
/* The Lisbon row end to end. THIS ASSERTION USED TO READ "Lisbon does not
   resolve" AND THE SUITE CAUGHT IT the same afternoon, because Portugal was
   added to the gazetteer hours later — which is the rule working exactly as
   intended: the office text was kept, so the row was waiting to be picked up,
   and it was. Keep the rule pinned against a country the gazetteer still does
   not know, or this check quietly stops testing anything the next time one is
   added. */
check('Lisbon resolves now that Portugal is in the gazetteer',
  resolveRegion('Lisboa, Lisboa, Portugal', {}), 'PT');
/* Structurally unplaceable, not merely a country we have not got to yet — this
   is FedEx's real Workday location text, and no gazetteer will ever read it. A
   country name here would rot the moment that country is added, which is
   exactly what happened to the two lines above. */
check('a structurally unreadable place is the case the rescue is for',
  resolveRegion('FXE_APAC/MYS/MYKULIP/Kulip Gateway', {}), UNKNOWN);
check('and the slot it replaces is a workplace type', isWorkplaceType('In-Office'), true);

console.log('\n== the poller consults it ONLY when the primary said nowhere ==');
/* A SOURCE ASSERTION, because bin/poll-ats.js executes on import and cannot be
   called. Both halves are pinned: that the detail candidates are read at all,
   and that they are read behind the UNKNOWN guard. Without the second, a
   mutation that consults them unconditionally — overwriting a location the
   board had already placed correctly — passes. */
const poll = readFileSync(join(ROOT, 'bin', 'poll-ats.js'), 'utf8');
const code = poll.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/* ASSERT THE PAIRING, NOT THE MENTION. The first version of this checked only
   that `extra?.locationAlt` appeared somewhere, which the GUARD satisfies on its
   own — so a mutation that guarded correctly and then called
   `placeFrom(j, [])`, doing nothing at all, passed all 56 checks. The candidates
   have to be seen going IN to the helper. */
check('the detail candidates are consulted', /placeFrom\(j, extra\.locationAlt\)/.test(code), true);
check('behind an UNKNOWN guard', /region === UNKNOWN && extra\?\.locationAlt/.test(code), true);
check('and the region is re-gated afterwards', /region !== UNKNOWN && !collected\(region\)/.test(code), true);
// The replacement rule lives in one helper, so both callers cannot drift apart.
check('both fallbacks go through placeFrom', (code.match(/placeFrom\(/g) ?? []).length, 3);
check('the old inline loop is gone', /for \(const alt of j\.locationAlt/.test(code), false);
/* And the text rescue: a workplace-type slot keeps a real candidate even when
   nothing resolved. Both halves again — the guard AND the assignment — because
   the guard alone is satisfied by code that then does nothing. */
check('a workplace-type slot is detected', /isWorkplaceType\(job\.location\)/.test(code), true);
check('and the candidate is actually kept', /job\.location = first/.test(code), true);
check('the rescue runs only after the resolving loop',
  code.indexOf('isWorkplaceType(job.location)') > code.indexOf('if (region !== UNKNOWN) { job.location = alt; return region; }'), true);

/* ------------------------------------------------------------------------- *
 * The four providers added 7 Sep 2026 — Eightfold, Keka, Teamtailor and
 * Oracle Cloud — found by the sweep of the no-board pool in section 8.
 *
 * These call list() with a STUBBED fetch rather than grepping the source. The
 * bug worth catching here cannot be seen in a grep: Eightfold's t_create is in
 * SECONDS, and handing it to new Date() unmultiplied dates every posting to
 * 1970, at which point the staleness filter drops the whole board with no error
 * line at all. That is Microsoft's postedTs trap, one provider later.
 * ------------------------------------------------------------------------- */
console.log('\n== the new providers: link shapes ==');
check('keka is read off its host', parseAtsLink('https://gokwik.keka.com/careers/'),
  { provider: 'keka', token: 'gokwik' });
check('teamtailor is read off its host', parseAtsLink('https://payfit.teamtailor.com/jobs'),
  { provider: 'teamtailor', token: 'payfit' });
check('eightfold keeps the WHOLE host as the token',
  parseAtsLink('https://lockheedmartin.eightfold.ai/careers'),
  { provider: 'eightfold', token: 'lockheedmartin.eightfold.ai' });
check('oracle keeps the whole multi-label pod host',
  parseAtsLink('https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/x'),
  { provider: 'oraclecloud', token: 'fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com' });

/* The four patterns were APPENDED to ATS_LINK because parseAtsLink destructures
   its groups by POSITION. Inserting one anywhere but the end renumbers every
   provider after it, and the failure is silent — a Workday link starts
   resolving as Greenhouse. These pin that the old shapes did not shift. */
console.log('\n== and the old shapes did not shift ==');
check('greenhouse', parseAtsLink('https://boards.greenhouse.io/stripe'),
  { provider: 'greenhouse', token: 'stripe' });
check('greenhouse embed', parseAtsLink('https://boards.greenhouse.io/embed/job_board?for=cloudsek'),
  { provider: 'greenhouse', token: 'cloudsek' });
check('lever', parseAtsLink('https://jobs.lever.co/meesho'), { provider: 'lever', token: 'meesho' });
check('ashby', parseAtsLink('https://jobs.ashbyhq.com/openai'), { provider: 'ashby', token: 'openai' });
check('workday keeps tenant:wdN:site', parseAtsLink('https://acme.wd1.myworkdayjobs.com/en-US/External'),
  { provider: 'workday', token: 'acme:wd1:External' });
check('smartrecruiters', parseAtsLink('https://jobs.smartrecruiters.com/Freshworks'),
  { provider: 'smartrecruiters', token: 'Freshworks' });
check('a non-board URL is still nothing', parseAtsLink('https://example.com/careers'), null);

console.log('\n== which providers discovery may GUESS a token for ==');
/* Eightfold and Oracle are keyed by HOST, which no company name produces, so
   letting discovery guess at them means one wasted request per company per
   provider forever. */
check('keka is guessable', PROVIDER_NAMES.includes('keka'), true);
check('teamtailor is guessable', PROVIDER_NAMES.includes('teamtailor'), true);
check('eightfold is NOT guessable', PROVIDER_NAMES.includes('eightfold'), false);
check('oraclecloud is NOT guessable', PROVIDER_NAMES.includes('oraclecloud'), false);
check('and neither are the first-party boards', PROVIDER_NAMES.includes('amazon'), false);

console.log('\n== a vanity host can only be reached by being written down ==');
check('Netflix is seeded onto eightfold', FIRST_PARTY_BOARDS.Netflix,
  ['eightfold', 'explore.jobs.netflix.net']);
check('its token is the vanity host, not a *.eightfold.ai guess',
  parseAtsLink('https://explore.jobs.netflix.net/careers'), null);

/* One stub for every provider below. Each returns the first body whose key the
   requested URL contains, so a provider asking for an endpoint the test did not
   plan for gets null rather than another provider's payload. */
function stubFetch(routes) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const hit = Object.entries(routes).find(([frag]) => String(url).includes(frag));
    return {
      ok: !!hit, status: hit ? 200 : 404,
      headers: { get: () => null },
      async text() { return JSON.stringify(hit ? hit[1] : {}); },
    };
  };
  return () => { globalThis.fetch = realFetch; };
}

console.log('\n== Eightfold: the seconds-vs-milliseconds trap ==');
{
  const restore = stubFetch({
    '/api/apply/v2/jobs': {
      count: 1,
      positions: [{
        id: '790317917022',
        name: 'Machine Learning Intern',
        location: 'Los Gatos,California,United States of America',
        locations: ['Los Gatos,California,United States of America'],
        department: 'Engineering',
        // SECONDS. 1787097600 is 2026-08-19; as milliseconds it is 1970-01-21.
        t_create: '1787097600',
        canonicalPositionUrl: 'https://explore.jobs.netflix.net/careers/job/790317917022',
        work_location_option: 'onsite',
        job_description: '',
      }],
    },
  });
  const jobs = await fetchBoard('eightfold', 'explore.jobs.netflix.net');
  restore();
  check('one posting, deduped across the four search terms', jobs.length, 1);
  check('t_create is multiplied to milliseconds',
    new Date(jobs[0].postedAt).toISOString().slice(0, 7), '2026-08');
  check('and is NOT read as milliseconds', new Date(jobs[0].postedAt).getUTCFullYear() === 1970, false);
  check('the canonical URL is preferred over a built one', jobs[0].url,
    'https://explore.jobs.netflix.net/careers/job/790317917022');
  check('the id is carried for the detail fetch', jobs[0].externalPath, '790317917022');
  check('an empty description stays null rather than becoming ""', jobs[0].description, null);
}

console.log('\n== Keka: locations, URL, and an empty board ==');
{
  const restore = stubFetch({
    '/careers/api/jobs/default/active': [{
      id: 159768,
      title: 'Software Engineering Intern',
      description: '<p>Build things.</p>',
      excerpt: 'Build things.',
      departmentName: 'Engineering',
      jobLocations: [
        { city: 'Gurugram', state: 'HR', countryName: 'India' },
        { city: 'Bengaluru', state: 'KA', countryName: 'India' },
      ],
      publishedOn: '2026-09-04T12:04:06.933Z',
    }],
  });
  const jobs = await fetchBoard('keka', 'gokwik');
  restore();
  check('the location object becomes a readable place', jobs[0].location, 'Gurugram, HR, India');
  check('and the rest become alternates', jobs[0].locationAlt, ['Bengaluru, KA, India']);
  check('that place resolves to a region', resolveRegion(jobs[0].location, {}) !== UNKNOWN, true);
  check('the payload carries no URL so one is built', jobs[0].url,
    'https://gokwik.keka.com/careers/jobdetails/159768');
  check('HTML description is stripped', jobs[0].description, 'Build things.');
}
{
  /* bijak.keka.com really answers this: HTTP 200 with an empty array. That is a
     board with nothing open, NOT a board that failed to read, and collapsing
     the two would retire a live tenant on its quiet week. */
  const restore = stubFetch({ '/careers/api/jobs/default/active': [] });
  const jobs = await fetchBoard('keka', 'bijak');
  restore();
  check('an empty board is [] and not null', Array.isArray(jobs) && jobs.length === 0, true);
}

console.log('\n== Teamtailor: _jobposting is an OBJECT, not a JSON string ==');
{
  const restore = stubFetch({
    '.teamtailor.com/jobs.json': {
      title: 'PayFit',
      items: [{
        id: '308d03b9',
        title: 'Backend Intern',
        url: 'https://payfit.teamtailor.com/jobs/7977149-backend-intern',
        date_published: '2026-06-26T11:30:42+02:00',
        content_html: '<p>fallback</p>',
        _jobposting: {
          '@type': 'JobPosting',
          title: 'Backend Intern',
          description: '<p>Real description.</p>',
          jobLocation: [{ address: { addressLocality: 'Barcelona', addressCountry: 'ES' } }],
        },
      }],
    },
  });
  const jobs = await fetchBoard('teamtailor', 'payfit');
  restore();
  check('the embedded JobPosting supplies the place', jobs[0].location, 'Barcelona, ES');
  check('its description wins over content_html', jobs[0].description, 'Real description.');
  check('the feed URL is used as-is', jobs[0].url,
    'https://payfit.teamtailor.com/jobs/7977149-backend-intern');
  check('date_published is parsed', new Date(jobs[0].postedAt).toISOString().slice(0, 10), '2026-06-26');
}

console.log('\n== Oracle Cloud: requisitions are nested two deep ==');
{
  const restore = stubFetch({
    'recruitingCEJobRequisitions': {
      items: [{
        TotalJobsCount: 1971,
        requisitionList: [{
          Id: '344176',
          Title: 'Financial Analyst Intern',
          PrimaryLocation: 'Nashville, TN, United States',
          PostedDate: '2026-08-31',
          secondaryLocations: [{ Name: 'Austin, TX, United States' }],
        }],
      }],
    },
  });
  const jobs = await fetchBoard('oraclecloud', 'eeho.fa.us2.oraclecloud.com');
  restore();
  check('the requisition is found under items[0].requisitionList', jobs.length, 1);
  check('PrimaryLocation is the location', jobs[0].location, 'Nashville, TN, United States');
  check('secondary locations become alternates', jobs[0].locationAlt, ['Austin, TX, United States']);
  check('PostedDate is parsed', new Date(jobs[0].postedAt).toISOString().slice(0, 10), '2026-08-31');
  check('the list carries no description, so detail() must run', jobs[0].description, null);
}

/* ------------------------------------------------------------------------- *
 * ONE COMPANY, SEVERAL COUNTRY BOARDS (7 Sep 2026).
 *
 * `company_ats.company` is the PRIMARY KEY, so a company gets one row and
 * therefore one token — which is why Amazon and Microsoft were India-only for
 * as long as they existed, while amazon.jobs was carrying 49 US and 14 GB
 * internships nobody collected. The extra boards live INSIDE the token.
 * ------------------------------------------------------------------------- */
console.log('\n== boardTokens ==');
check('a list splits', boardTokens('IND,USA,GBR'), ['IND', 'USA', 'GBR']);
check('spaces around the commas survive nothing', boardTokens(' IND , USA '), ['IND', 'USA']);
check('a single value still parses to one board', boardTokens('IND'), ['IND']);
check('a name containing spaces is kept whole',
  boardTokens('India,United States,United Kingdom'), ['India', 'United States', 'United Kingdom']);
check('an empty token yields no boards at all', boardTokens(''), []);
check('null is empty', boardTokens(null), []);
check('trailing comma does not invent a board', boardTokens('IND,'), ['IND']);

/* Records every URL asked for, so the test can assert the fan-out actually
   happened rather than trusting that a loop was written correctly. */
function recordingStub(payloadFor) {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = payloadFor(String(url));
    return {
      ok: !!body, status: body ? 200 : 404,
      headers: { get: () => null },
      async text() { return JSON.stringify(body ?? {}); },
    };
  };
  return { urls, restore: () => { globalThis.fetch = realFetch; } };
}

console.log('\n== Amazon asks each country for each term ==');
{
  const { urls, restore } = recordingStub((u) => {
    const country = new URL(u).searchParams.get('country');
    return { jobs: [{ id: `${country}-1`, title: 'SDE Intern', normalized_location: 'X', job_path: '/en/jobs/1' }] };
  });
  const jobs = await fetchBoard('amazon', 'IND,USA,GBR');
  restore();
  const countries = [...new Set(urls.map((u) => new URL(u).searchParams.get('country')))];
  check('all three countries were asked', countries.sort(), ['GBR', 'IND', 'USA']);
  check('three countries x three terms', urls.length, 9);
  check('and each country contributed a distinct posting', jobs.length, 3);
}
{
  /* THE FAILURE THIS PREVENTS: a token that is not split is sent whole as the
     country. amazon.jobs answers 200 with zero jobs for an unknown country, so
     the board reads as empty rather than erroring — which is exactly how US
     stayed uncollected behind the two-letter code `US`. */
  const { urls, restore } = recordingStub(() => ({ jobs: [] }));
  await fetchBoard('amazon', 'IND,USA,GBR');
  restore();
  check('the whole token is never sent as one country',
    urls.some((u) => (new URL(u).searchParams.get('country') ?? '').includes(',')), false);
}
{
  const { urls, restore } = recordingStub(() => ({ jobs: [] }));
  await fetchBoard('amazon', 'ind');
  restore();
  check('a country is upper-cased', new URL(urls[0]).searchParams.get('country'), 'IND');
}
{
  const { urls, restore } = recordingStub(() => ({ jobs: [] }));
  await fetchBoard('amazon', '');
  restore();
  check('an empty token still asks India rather than nothing',
    new URL(urls[0]).searchParams.get('country'), 'IND');
}

console.log('\n== Microsoft asks each location for each term ==');
{
  const { urls, restore } = recordingStub((u) => {
    const loc = new URL(u).searchParams.get('location');
    return { data: { positions: [{ id: `${loc}-1`, name: 'Software Engineering Intern', locations: [loc] }] } };
  });
  const jobs = await fetchBoard('microsoft', 'India,United States,United Kingdom');
  restore();
  const locs = [...new Set(urls.map((u) => new URL(u).searchParams.get('location')))];
  check('all three locations were asked', locs.sort(), ['India', 'United Kingdom', 'United States']);
  check('three locations x three terms', urls.length, 9);
  check('a location keeps its space rather than being split on it', jobs.length, 3);
}

console.log('\n== Uber filters to the SET of wanted countries ==');
{
  const { restore } = recordingStub(() => ({ data: { results: [
    { id: 'a', title: 'Intern', location: { country: 'IND', city: 'Bengaluru', countryName: 'India' } },
    { id: 'b', title: 'Intern', location: { country: 'USA', city: 'Seattle', countryName: 'United States' } },
    { id: 'c', title: 'Intern', location: { country: 'FRA', city: 'Paris', countryName: 'France' } },
  ] } }));
  const jobs = await fetchBoard('uber', 'IND,USA');
  restore();
  /* Comparing a country to the literal string "IND,USA" matches nothing, and a
     board that matches nothing is indistinguishable from a board with nothing
     open. Both wanted countries must survive and the third must not. */
  check('both wanted countries survive', jobs.map((j) => j.id).sort(), ['a', 'b']);
  check('an unwanted country is dropped', jobs.some((j) => j.id === 'c'), false);
}

console.log('\n== the tokens actually configured ==');
check('Amazon covers the three published boards', FIRST_PARTY_BOARDS.Amazon, ['amazon', 'IND,USA,GBR']);
check('Microsoft covers the same three',
  FIRST_PARTY_BOARDS.Microsoft, ['microsoft', 'India,United States,United Kingdom']);
/* ISO-3166 ALPHA-3, and this is not pedantry: `US` and `GB` answer 200 with
   zero jobs, so a two-letter code is an empty board and never an error. */
check('no two-letter country code slipped into Amazon\'s token',
  boardTokens(FIRST_PARTY_BOARDS.Amazon[1]).every((c) => c.length === 3), true);

/* ------------------------------------------------------------------------- *
 * MICROSOFT WAS THE ONE PROVIDER WRITING ITS LOCATION COUNTRY-FIRST, and it
 * put twelve postings on the US board TWICE. `resolveRegion` reads
 * "United States, Washington, Redmond" perfectly well, which is why the old
 * comment on that line said it was fine and why it stood for so long. But
 * `dedupeKey` is company|title|cityOf(location) and cityOf takes the FIRST
 * comma segment, so the ATS row keyed on "United States" while the LinkedIn row
 * for the same posting keyed on "Redmond", and nothing collapsed them.
 * ------------------------------------------------------------------------- */
console.log('\n== Microsoft locations are reversed to city-first ==');
check('country-first becomes city-first',
  microsoftPlace('United States, Washington, Redmond'), 'Redmond, Washington, United States');
check('the India board too', microsoftPlace('India, Karnataka, Bangalore'), 'Bangalore, Karnataka, India');
check('the CITY leads, which is what cityOf reads',
  microsoftPlace('United States, Washington, Redmond').split(',')[0].trim(), 'Redmond');
/* Two segments are not a country/region/city triple, and reversing one would
   invent an order that is not there — "Cambridge, United Kingdom" is already
   city-first and flipping it puts the country in the city slot.
   THE FIXTURE MUST NOT BE A PALINDROME: the first version of this check used
   "London, London", which reverses to itself and therefore passed with the
   length guard deleted. The mutation caught it; the fixture was the bug. */
check('a two-segment value is NOT reversed',
  microsoftPlace('Cambridge, United Kingdom'), 'Cambridge, United Kingdom');
check('a repeated two-segment name is unchanged either way',
  microsoftPlace('London, London'), 'London, London');
check('a bare city is left alone', microsoftPlace('Redmond'), 'Redmond');
check('empty is null', microsoftPlace(''), null);
check('null is null', microsoftPlace(null), null);
/* The region must NOT move — that is the number §6 says is the only one that
   matters, and it was measured at 0 reclassified over all 24 stored rows. */
check('the region is unchanged by the reversal',
  resolveRegion(microsoftPlace('United States, Washington, Redmond'), {}),
  resolveRegion('United States, Washington, Redmond', {}));
check('and for India', resolveRegion(microsoftPlace('India, Karnataka, Bangalore'), {}),
  resolveRegion('India, Karnataka, Bangalore', {}));

{
  const { restore } = recordingStub(() => ({ data: { positions: [
    { id: 'm1', name: 'Software Engineer Intern', locations: ['United States, Washington, Redmond'] },
  ] } }));
  const jobs = await fetchBoard('microsoft', 'United States');
  restore();
  check('list() emits the reversed place', jobs[0].location, 'Redmond, Washington, United States');
  check("and keeps the board's own wording as an alternate",
    jobs[0].locationAlt, ['United States, Washington, Redmond']);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
