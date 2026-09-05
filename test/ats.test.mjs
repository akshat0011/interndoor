import { stripHtml, parseAtsLink, workdayPlaces, isWorkplaceType } from '../src/ats.js';
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
check('and stays unplaced rather than guessed', nvidiaPlaces.every((r) => r === UNKNOWN), true);
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
/* The Lisbon row end to end: the office names a real city, the gazetteer cannot
   place it, and the point is that the CITY is what should survive. */
check('Lisbon does not resolve', resolveRegion('Lisbon, Portugal', {}), UNKNOWN);
check('so the slot it would replace is a workplace type', isWorkplaceType('In-Office'), true);

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
