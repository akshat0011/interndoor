/**
 * baseSalary and the PostalAddress on JobPosting markup.
 *
 * Search Console, 6 Sep 2026: 218 of 218 valid job postings were missing
 * `baseSalary`, and 208 of 218 were missing `addressRegion`, `postalCode` and
 * `streetAddress`. Those are the fields Google's job experience ranks and
 * enriches on, and the site was appearing in it twice in three months.
 *
 * BOTH ADDITIONS ARE WRITTEN AROUND ONE RISK: wrong structured data earns a
 * manual action on the WHOLE domain, not one page. So both withhold rather
 * than guess, and what is pinned here is mostly what they REFUSE.
 */
import { safeBaseSalary } from '../src/extract.js';
import { postalAddressFor } from '../src/pages.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== baseSalary IS PUBLISHED ONLY WHERE THE POSTING STATED IT ==');
{
  check('a stated hourly rate',
    safeBaseSalary({ min: 47, max: 47, currency: 'USD', period: 'hour', text: '$47/hr' }),
    { currency: 'USD', min: 47, max: 47, unitText: 'HOUR' });
  check('a stated yearly range',
    safeBaseSalary({ min: 39700, max: 52000, currency: 'USD', period: 'year', text: '$39.7K/yr' }),
    { currency: 'USD', min: 39700, max: 52000, unitText: 'YEAR' });
  check('an INR monthly stipend',
    safeBaseSalary({ min: 15000, max: 15000, currency: 'INR', period: 'month', text: '₹15,000/mo' }),
    { currency: 'INR', min: 15000, max: 15000, unitText: 'MONTH' });
  check('currency is upper-cased', safeBaseSalary({ min: 10, max: 10, currency: 'usd', period: 'hour', text: 'x' })?.currency, 'USD');
}

console.log('\n== SALARY_TEXT IS THE EVIDENCE, AND IT IS REQUIRED ==');
{
  /* Same rule groundEnrichment applies to every other field: what the posting
     did not state is not ours to publish. `stipendStatus` is the standing
     example of a field too invented to render. */
  check('no salary_text is refused', safeBaseSalary({ min: 47, max: 47, currency: 'USD', period: 'hour', text: '' }), null);
  check('whitespace is not evidence', safeBaseSalary({ min: 47, max: 47, currency: 'USD', period: 'hour', text: '   ' }), null);
  check('missing salary_text is refused', safeBaseSalary({ min: 47, max: 47, currency: 'USD', period: 'hour' }), null);
}

console.log('\n== THE MAGNITUDE MUST FIT THE PERIOD — THE PERIOD IS OFTEN WRONG ==');
{
  /* MEASURED, NOT HYPOTHETICAL. Both of these are live rows: Intel carries
     76,398-95,702 tagged `hour` with a salary_text of "₹0", and Charles Schwab
     carries 30.5 tagged `year` from LinkedIn's own "$30.50/yr" mislabel of an
     hourly rate. Without the bound the site publishes "$95,702 per hour" and
     "$30.50 per year" as facts about named employers. */
  check('Intel: 95,702 per HOUR is refused',
    safeBaseSalary({ min: 76398, max: 95702, currency: 'USD', period: 'hour', text: '₹0' }), null);
  check('Schwab: $30.50 per YEAR is refused',
    safeBaseSalary({ min: 30.5, max: 30.5, currency: 'USD', period: 'year', text: '$30.50/yr' }), null);
  check('a plausible hourly rate survives',
    !!safeBaseSalary({ min: 45, max: 45, currency: 'USD', period: 'hour', text: '$45/hr' }), true);
  check('a plausible yearly figure survives',
    !!safeBaseSalary({ min: 45000, max: 45000, currency: 'USD', period: 'year', text: '$45K' }), true);
}

console.log('\n== EVERY OTHER SHAPE OF DIRT IN THE STIPEND COLUMNS ==');
{
  check('zero pay', safeBaseSalary({ min: 0, max: 0, currency: 'USD', period: 'hour', text: '$0' }), null);
  check('negative', safeBaseSalary({ min: -5, max: 10, currency: 'USD', period: 'hour', text: 'x' }), null);
  check('max below min', safeBaseSalary({ min: 50, max: 10, currency: 'USD', period: 'hour', text: 'x' }), null);
  /* 452 live rows carry a range with NO period. Hourly or yearly changes the
     meaning by four orders of magnitude, so it cannot be guessed. */
  check('no period', safeBaseSalary({ min: 18.5, max: 41.5, currency: 'USD', period: null, text: '$18.5-41.5' }), null);
  check('an unknown period', safeBaseSalary({ min: 100, max: 100, currency: 'USD', period: 'total', text: 'x' }), null);
  check('no currency', safeBaseSalary({ min: 401000, max: 401000, currency: '', period: 'year', text: '401000' }), null);
  check('a non-ISO currency', safeBaseSalary({ min: 10, max: 10, currency: 'US', period: 'hour', text: 'x' }), null);
  check('non-numeric', safeBaseSalary({ min: 'lots', max: 'more', currency: 'USD', period: 'hour', text: 'x' }), null);
  check('null', safeBaseSalary(null), null);
  check('undefined', safeBaseSalary(undefined), null);
  check('empty object', safeBaseSalary({}), null);
}

console.log('\n== THE ADDRESS SPLIT ==');
{
  /* addressLocality was being given the WHOLE string, so a row stored as
     "Bengaluru, Karnataka, India" published all three as the locality. */
  check('three parts give a locality and a region',
    postalAddressFor('Bengaluru, Karnataka, India', 'IN'), { locality: 'Bengaluru', region: 'Karnataka' });
  check('and outside India too',
    postalAddressFor('San Mateo, California, United States', 'US'), { locality: 'San Mateo', region: 'California' });
  check('a US city and state code',
    postalAddressFor('San Diego, CA', 'US'), { locality: 'San Diego', region: 'CA' });
}

console.log('\n== A TWO-LETTER TAIL IS NOT AUTOMATICALLY A STATE ==');
{
  /* 20 live rows read "Auckland, NZ", which looks exactly like "San Jose, CA".
     A wrong addressRegion is worse than an absent one. */
  check('NZ is a country, not a region', postalAddressFor('Auckland, NZ', 'NZ'), { locality: 'Auckland', region: null });
  check('and is still refused on a row miscoded US', postalAddressFor('Auckland, NZ', 'US'), { locality: 'Auckland', region: null });
  check('Canadian provinces are refused too', postalAddressFor('Toronto, ON', 'CA'), { locality: 'Toronto', region: null });
  check('a spelled-out country is not a region', postalAddressFor('London, United Kingdom', 'GB'), { locality: 'London', region: null });
  check('lower case is not a state code', postalAddressFor('San Diego, ca', 'US'), { locality: 'San Diego', region: null });
  check('a non-state two-letter code', postalAddressFor('Somewhere, ZZ', 'US'), { locality: 'Somewhere', region: null });
}

console.log('\n== THE SIX CODES regions.js EXCLUDES MUST STILL WORK HERE ==');
{
  /* regions.js omits `in de or ia me hi` because they collide with India,
     Germany and ordinary words when INFERRING a region from free text —
     "In-Office" once matched `in`. Here the country is already resolved, so
     nothing is inferred and reusing that list would silently drop the region
     from every posting in six states. */
  for (const [loc, want] of [['Portland, OR', 'OR'], ['Indianapolis, IN', 'IN'], ['Dover, DE', 'DE'],
    ['Des Moines, IA', 'IA'], ['Auburn, ME', 'ME'], ['Honolulu, HI', 'HI']]) {
    check(`${loc}`, postalAddressFor(loc, 'US')?.region, want);
  }
}

console.log('\n== WITHHOLDING, NOT GUESSING ==');
{
  check('an unstructured area keeps the locality alone',
    postalAddressFor('Greater Seattle Area', 'US'), { locality: 'Greater Seattle Area', region: null });
  check('empty', postalAddressFor('', 'US'), null);
  check('null', postalAddressFor(null, 'US'), null);
  check('commas only', postalAddressFor(',,,', 'US'), null);
  // Never invented: we have no street or postcode and must not make them up.
  const a = postalAddressFor('San Diego, CA', 'US');
  check('no streetAddress is invented', 'streetAddress' in (a ?? {}), false);
  check('no postalCode is invented', 'postalCode' in (a ?? {}), false);
}

console.log('\n== THE MARKUP ACTUALLY CARRIES THEM ==');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/pages.js', import.meta.url), 'utf8');
  check('baseSalary is emitted', /ld\.baseSalary = \{/.test(src), true);
  check('only when the projection carries pay', /if \(job\.pay\) \{/.test(src), true);
  check('as a MonetaryAmount', /'@type': 'MonetaryAmount'/.test(src), true);
  check('addressRegion is emitted', /addressRegion: addr\.region/.test(src), true);
  /* WITHHELD, not null: an explicit `addressRegion: null` is a claim about the
     field rather than an absence of one. */
  check('and withheld rather than nulled', /\.\.\.\(addr\?\.region \? \{ addressRegion/.test(src), true);
  check('addressLocality is no longer the whole string', /addressLocality: job\.location,/.test(src), false);
  /* directApply must stay false — the most direct route to a manual action. */
  check('directApply is still false', /directApply: false/.test(src), true);

  const pub = readFileSync(new URL('../src/publish.js', import.meta.url), 'utf8');
  check('publish gates pay through safeBaseSalary', /safeBaseSalary\(\{/.test(pub), true);
  /* Absent rather than null on the ~73% that fail the gate: jobs.json is read
     by eight consumers and served to every visitor. */
  check('and omits the key entirely when null', /\.\.\.\(pay \? \{ pay \} : \{\}\)/.test(pub), true);
}

console.log('\n== THE BOARD TITLE LEADS WITH THE CATEGORY, NOT THE BRAND ==');
{
  const { readFileSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { writePages } = await import('../src/pages.js');
  const { regionOf } = await import('../src/regions.js');

  const dir = '/tmp/interndoor-head-test';
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/index.html`, readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8'));

  const job = (id) => ({
    id: String(id), title: 'Software Engineer Intern', company: 'Acme', isTech: true,
    bullets: ['a', 'b'], employmentType: 'intern', location: 'San Diego, CA',
    postedAt: Date.parse('2026-09-01'), firstSeenAt: Date.parse('2026-09-01'), skills: [],
  });
  writePages([job(1), job(2), job(3)], dir, [], { region: regionOf('US') });

  /* STRIP COMMENTS FIRST. index.html carries a <title> inside an HTML comment,
     and §11 records a naive regex matching 78 characters of prose off exactly
     that. This assertion read the comment before the strip was added. */
  const raw = readFileSync(`${dir}/us/index.html`, 'utf8');
  const html = raw.replace(/<!--[\s\S]*?-->/g, '');
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim() ?? '';
  const desc = /<meta name="description" content="([\s\S]*?)"/.exec(html)?.[1]?.trim() ?? '';

  check('the category leads', title.startsWith('Engineering Internships in the US'), true);
  check('and the brand trails', title.endsWith('— InternDoor'), true);
  /* buildTitle drops from the END so the searched part survives; the board
     titles were the one place that rule was inverted. */
  check('the brand no longer leads', title.startsWith('InternDoor'), false);
  check('under the 60-char clamp', title.length <= 60, true);

  /* §11: counts must not appear in a <title> — a live count rewrote 150 hub
     titles on almost every publish. */
  check('no count in the title', /\d/.test(title), false);
  /* ...but freshness belongs in the description, where a rewrite is free, and
     index.html already rewrites on every publish because of <!--LISTINGS-->. */
  check('the count IS in the description', desc.startsWith('3 engineering internships'), true);
  check('and the description fits a snippet', desc.length <= 160, true);

  // A board with no live rows must not say "0 engineering internships".
  writePages([], dir, [], { region: regionOf('US') });
  const empty = readFileSync(`${dir}/us/index.html`, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const emptyDesc = /<meta name="description" content="([\s\S]*?)"/.exec(empty)?.[1] ?? '';
  check('an empty board falls back to prose', emptyDesc.startsWith('Engineering internships'), true);
  check('and never says zero', /^0 /.test(emptyDesc), false);

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
