import {
  resolveRegion, regionOf, regionBySlug, regionPath, publishedRegions,
  isPublishedRegion, collectsRegion, ALL_REGIONS, UNKNOWN,
} from '../src/regions.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n         got:  ${a}\n         want: ${e}`); }
}
const at = (label, location, expected) => check(label, resolveRegion(location), expected);

console.log('\n== an explicit country always wins ==');
at('india spelled out', 'Bengaluru, Karnataka, India', 'IN');
at('remote india', 'India (Remote)', 'IN');
at('usa spelled out', 'Remote - USA', 'US');
at('usa in a path', 'USA - Arlington, VA', 'US');
at('united kingdom', 'London,England,United Kingdom', 'GB');
at('canada', 'Montreal,Quebec,Canada', 'CA');
at('singapore', 'Fab 10N/X, Singapore', 'SG');
at('poland', 'Warsaw, Poland', 'PL');
at('australia', 'Sydney, Australia', 'AU');
at('ireland', 'Dublin', 'IE');
at('netherlands', 'Amsterdam, North Holland, Netherlands', 'NL');
at('france', 'Paris, France', 'FR');

console.log('\n== a known city, with no country named ==');
at('us city + state code', 'Chicago, IL', 'US');
at('us city alone', 'New York', 'US');
at('two us cities', 'Chicago; New York', 'US');
at('us city, spelled state', 'San Francisco, California', 'US');
at('uk city alone', 'London', 'GB');
at('canadian city alone', 'Montreal', 'CA');
at('german city alone', 'Hamburg', 'DE');
at('indian city alone', 'gurgaon', 'IN');
at('indian city, odd casing', 'Ahmedabad,Gj', 'IN');

console.log('\n== a code, only where a code actually appears ==');
// Both shapes are verbatim from live ATS payloads.
at('trailing iso code', 'London, gb', 'GB');
at('trailing iso code, lowercase country', 'Hannover, de', 'DE');
at('leading country prefix', 'PL-Warsaw-Lixa C', 'PL');
at('leading prefix, unknown city', 'DE-Berlin-Trion Building', 'DE');
at('malaysia is not a region we serve', 'Bayan Lepas, my', UNKNOWN);

console.log('\n== the CA collision — city must beat code ==');
// `CA` is Canada's ISO code AND California's postal abbreviation. Same shape,
// different continents. Resolving the code first gets one of these wrong every
// single time, which is why the city pass runs first.
at('california', 'San Jose, CA', 'US');
at('canada', 'Toronto, CA', 'CA');
at('california, spelled out', 'Palo Alto, CA', 'US');

console.log('\n== unknown means no ==');
at('empty', '', UNKNOWN);
at('null', null, UNKNOWN);
at('undefined', undefined, UNKNOWN);
at('an office, not a place', 'In-Office', UNKNOWN);
at('a placeholder', 'BLANK,BLANK,Multiple Locations', UNKNOWN);
at('a continent is not a country', 'APAC - Remote', UNKNOWN);
at('bare remote routes nowhere', 'Remote', UNKNOWN);
at('a country we do not serve', 'Hong Kong', UNKNOWN);
at('another', 'Auckland, NZ', UNKNOWN);
at('and another', 'Taguig, Philippines', UNKNOWN);

console.log('\n== ambiguous cities are deliberately absent ==');
// Cambridge, Birmingham and London, Ontario all exist on both sides of the
// Atlantic and all appear in these feeds. Declining to guess is the correct
// answer; misfiling a US role onto the India board is the failure being avoided.
at('cambridge needs its country', 'Cambridge', UNKNOWN);
at('cambridge, spelled out', 'Cambridge, United Kingdom', 'GB');
at('cambridge, the other one', 'Cambridge, MA', 'US');
at('birmingham needs its country', 'Birmingham', UNKNOWN);

console.log('\n== word boundaries ==');
// Without \b, "in" matches inside "Berlin" and every German row becomes Indian.
at('berlin is not india', 'Berlin', 'DE');
at('a word containing a code is not that code', 'Bengaluru', 'IN');
check('goal is not goa', resolveRegion('Our goal is to hire'), UNKNOWN);

console.log('\n== the empty-location fallback is how the collectors differ ==');
// The LinkedIn sweep is scoped to a region by its search, so a card with no
// location text is still known. An ATS board carries every office at once and
// knows nothing, so a blank there is genuinely unknown.
check('linkedin passes its search region', resolveRegion('', { fallback: 'IN' }), 'IN');
check('ats passes nothing', resolveRegion('', {}), UNKNOWN);
check('a real location ignores the fallback', resolveRegion('Chicago, IL', { fallback: 'IN' }), 'US');

console.log('\n== the old India gate, reproduced exactly ==');
// isIndianLocation is gone -- it had no callers left once publish and the ATS
// poller moved to regions, and a second unused export in this codebase is the
// same trap src/gemini.js already is. What it MEANT is pinned here instead:
// India, with a blank location falling back to India, which is what the
// LinkedIn collector passes. These are the exact cases the old gazetteer was
// built from, plus the ones that caused it to be written.
const isIndianLocation = (loc) => resolveRegion(loc, { fallback: 'IN' }) === 'IN';
check('bengaluru', isIndianLocation('Bengaluru, Karnataka, India'), true);
check('blank is still kept', isIndianLocation(''), true);
check('singapore still refused', isIndianLocation('MSB, Singapore'), false);
check('malaysia still refused', isIndianLocation('Bayan Lepas, my'), false);
check('hannover still refused', isIndianLocation('Hannover, de'), false);
// The Valeo posting that reached the board: LinkedIn geocoded Kanda, Fukuoka as
// "Kanda, Uttarakhand, India". The fix is still to correct the row, not the code.
check('a corrected row is refused', isIndianLocation('Kanda, Fukuoka, Japan'), false);

console.log('\n== the registry ==');
check('india is at the root', regionOf('IN').slug, '');
check('india path has no double slash', regionPath('IN'), '');
check('the us is a subpath', regionPath('US'), '/us');
check('GB is served at /uk', regionOf('GB').slug, 'uk');
check('unknown has no path', regionPath(UNKNOWN), '');
check('a bogus code has no path', regionPath('ZZ'), '');
check('lookup is case-insensitive', regionOf('in').code, 'IN');
check('root slug resolves to india', regionBySlug('').code, 'IN');
check('/uk/ resolves to GB', regionBySlug('/uk/').code, 'GB');
check('an unserved slug is null', regionBySlug('zz'), null);

// Every region needs these for the pages to render and the JSON-LD to validate.
for (const r of ALL_REGIONS) {
  const ok = !!(r.code && r.name && r.inName && r.hreflang && r.timeZone && r.currency);
  check(`${r.code} is fully described`, ok, true);
}
check('slugs are unique', new Set(ALL_REGIONS.map((r) => r.slug)).size, ALL_REGIONS.length);
check('codes are unique', new Set(ALL_REGIONS.map((r) => r.code)).size, ALL_REGIONS.length);
check('exactly one region sits at the root', ALL_REGIONS.filter((r) => r.slug === '').length, 1);

console.log('\n== publish and collect are separate decisions ==');
// Collecting a region is cheap and reversible; publishing one is a public
// commitment. Keeping them apart is what lets a board fill up quietly first.
check('default is india only', publishedRegions({}).map((r) => r.code), ['IN']);
check('empty list falls back to india', publishedRegions({ regions: { publish: [] } }).map((r) => r.code), ['IN']);
check('two regions', publishedRegions({ regions: { publish: ['IN', 'US'] } }).map((r) => r.code), ['IN', 'US']);
check('a bogus code is dropped, not thrown', publishedRegions({ regions: { publish: ['IN', 'ZZ'] } }).map((r) => r.code), ['IN']);
check('is published', isPublishedRegion({ regions: { publish: ['IN', 'US'] } }, 'US'), true);
check('is not published', isPublishedRegion({ regions: { publish: ['IN'] } }, 'US'), false);
check('unknown is never published', isPublishedRegion({ regions: { publish: ['IN'] } }, UNKNOWN), false);
check('collect defaults to everything', collectsRegion({}, 'US'), true);
check('collect covers unknown too', collectsRegion({}, UNKNOWN), true);
check('an explicit collect list', collectsRegion({ regions: { collect: ['IN'] } }, 'US'), false);
check('publishing without collecting is possible to express', collectsRegion({ regions: { collect: ['IN', 'US'] } }, 'US'), true);

console.log('\n== a shared city name loses to an explicit state code ==');
// Every one of these is a real US place whose name Britain also uses, written
// the way LinkedIn writes US locations. They ALL resolved to GB before the
// weak-city rule, because the city pass ran before the code pass — and
// "Reading, PA" turned up in the first 24 cards of the first US sweep, so this
// was a live route for US roles onto the UK board.
at('reading pennsylvania', 'Reading, PA', 'US');
at('manchester new hampshire', 'Manchester, NH', 'US');
at('bristol connecticut', 'Bristol, CT', 'US');
at('oxford mississippi', 'Oxford, MS', 'US');
at('newcastle washington', 'Newcastle, WA', 'US');
at('brighton michigan', 'Brighton, MI', 'US');
at('southampton new york', 'Southampton, NY', 'US');
at('liverpool new york', 'Liverpool, NY', 'US');
at('sheffield alabama', 'Sheffield, AL', 'US');
at('nottingham maryland', 'Nottingham, MD', 'US');
at('coventry rhode island', 'Coventry, RI', 'US');
at('london kentucky', 'London, KY', 'US');
at('cardiff california', 'Cardiff, CA', 'US');
at('leicester massachusetts', 'Leicester, MA', 'US');

console.log('\n== but a bare british city is still british ==');
// The whole reason these names stay in the gazetteer rather than being deleted
// the way cambridge and birmingham were: of 30 live GB rows only 7 name the
// country, and 13 are the bare word "London". Deleting them would send most of
// the UK board to `unknown`. Every string here is verbatim from a stored row.
at('bare london', 'London', 'GB');
at('bare bristol', 'Bristol', 'GB');
at('london spelled out', 'London,England,United Kingdom', 'GB');
at('london with a code', 'London, gb', 'GB');
at('london with the country', 'London, United Kingdom', 'GB');
at('london with a suffix', 'London - UK2', 'GB');
at('milton keynes office', 'Milton Keynes Office', 'GB');

console.log('\n== a weak city is outranked by a code, never by another city ==');
// A posting listing several offices must not change country because one of its
// cities is ambiguous. An earlier version of the rule let a later STRONG city
// match win, and these three flipped to NL and FR.
at('two offices', 'London; Amsterdam', 'GB');
at('london and paris', 'London; Paris', 'GB');
at('four offices', 'London, Paris, Hong Kong, Tokyo', 'GB');

console.log('\n== every US state name resolves, not just the first 23 ==');
// "Iowa City, IA" resolved to `unknown` purely because `iowa` was missing from
// the gazetteer while `california` and `texas` were in it. Found on the first
// US sweep; the list is now all fifty.
at('iowa city', 'Iowa City, IA', 'US');
at('delaware spelled out', 'Wilmington, Delaware', 'US');
at('maine spelled out', 'Portland, Maine', 'US');
at('iowa spelled out', 'Des Moines, Iowa', 'US');
at('washington state', 'Seattle, Washington', 'US');
at('hawaii', 'Honolulu, Hawaii', 'US');
at('new hampshire', 'Nashua, New Hampshire', 'US');

console.log('\n== the six excluded codes are still a known gap ==');
// `in`, `de`, `or`, `ia`, `me`, `hi` are deliberately absent from US codes —
// they collide with India, Germany and ordinary English words. The cost is that
// a US posting written "City, ST" in one of those six states cannot be placed
// unless its city or state is spelled out. These are STORED as unknown, never
// published, so a later gazetteer improvement picks them up with no
// re-collection. Pinned so the behaviour is deliberate rather than a surprise.
// `auburn` is NOT in the gazetteer: Auburn is a town in Maine, Alabama,
// Washington and New South Wales, so naming it would hand an Australian
// role to the US board. This is the gap staying open on purpose.
at('maine by code alone', 'Auburn, ME', UNKNOWN);
// Franklin is the same shape: Franklin, IN is a real US city and so is
// Franklin in a dozen other states, but nothing here names it yet.
at('indiana by code alone', 'Franklin, IN', UNKNOWN);
// ...and the other half of the note: naming the city IS the remedy, so a
// city that has been added now reads despite its code being excluded.
// Fort Wayne, Hillsboro, Cedar Rapids, Boise, Honolulu and Pearl City were
// 15 stored rows sitting in `unknown` for exactly this reason (27 Aug).
at('indiana by a named city', 'Fort Wayne, IN', 'US');
at('oregon by a named city', 'Hillsboro, OR', 'US');
at('iowa by a named city', 'Cedar Rapids, IA', 'US');
at('idaho, with trailing junk', 'Boise, ID - Main Site', 'US');
at('hawaii by a named city', 'Honolulu, HI', 'US');
at('hawaii, the other one', 'Pearl City, HI', 'US');
at('a metro area, not a city proper', 'Little Rock Metropolitan Area', 'US');
at('a warehouse, not a city proper', 'San Bernardino Warehouse', 'US');

console.log('\n== city still beats code, which is what the rule protects ==');
// The documented collision the ordering exists for: CA is Canada's ISO code AND
// California's postal abbreviation, so these two are the same shape and mean
// different continents. Neither toronto nor ontario is marked ambiguous.
at('toronto is canadian', 'Toronto, CA', 'CA');
at('san jose is californian', 'San Jose, CA', 'US');
at('ontario the province', 'Ontario, CA', 'CA');
// Tamil Nadu and Tennessee share TN. `chennai` is unambiguous, so it settles it
// before the code pass is ever reached.
at('chennai not tennessee', 'Chennai, TN', 'IN');

console.log('\n== Mexico is read by city and code, never by country name ==');
// MX carries NO `countries: ['mexico']`, and that is the whole design of the
// entry. Matching is \b(...)\b and the COUNTRY pass runs before the city pass,
// so a `mexico` country entry would match the second word of "New Mexico" and
// beat US outright — filing every New Mexico role in Mexico. Worse, publish
// re-derives the region of every stored row on each run, so it would have
// rewritten history too. These four are the regression that guards it.
at('new mexico is a US state', 'Albuquerque, New Mexico', 'US');
at('new mexico, bare', 'New Mexico', 'US');
at('new mexico, spelled out fully', 'Las Cruces, New Mexico, United States', 'US');
at('new mexico by code', 'Santa Fe, NM', 'US');
// And the rows that made the region worth adding — all Valeo ATS payloads.
at('bare mexican city', 'Queretaro', 'MX');
at('accented, with code', 'Santiago de Querétaro, mx', 'MX');
at('accented city alone', 'San Luis Potosí, mx', 'MX');
at('unaccented city alone', 'San Luis Potosi', 'MX');
at('the country name still reads, via its city', 'Mexico City, Mexico', 'MX');
at('a state, not a city', 'Jalisco, Mexico', 'MX');
// Collected, not published — it has no board and must not acquire one by
// accident. IN, US and GB are the published set.
check('mexico is collected', collectsRegion({ regions: { collect: 'all' } }, 'MX'), true);
check('mexico is not published',
  isPublishedRegion({ regions: { publish: ['IN', 'US', 'GB'] } }, 'MX'), false);

console.log('\n== the two rows that prompted all of this (27 Aug) ==');
// `bin/poll-ats.js` reported "2 could not be placed" for these two Valeo roles.
at('tuam, county galway', 'Tuam', 'IE');
at('a maharashtra town, no space after the comma', 'Turbhe,MH', 'IN');
at('and its neighbour', 'Mahad,MH', 'IN');
// The word-boundary check that keeps `mahad` from eating a Bengaluru suburb.
at('mahad does not match mahadevapura', 'Mahadevapura, Bengaluru', 'IN');

console.log('\n== a foreign COUNTRY NAME inside a US place name (the New Mexico trap, again) ==');
/* `holland` was in the Netherlands' `countries` list. The country pass runs
   BEFORE the city pass and has no weak-evidence step, so \bholland\b matched
   the second word of "New Holland" — a real Pennsylvania town — and nothing
   gave `pa` a chance to say otherwise. Exactly what Mexico's deliberately
   missing `countries` entry has guarded against since August. */
at('new holland is in pennsylvania', 'New Holland, PA', 'US');
at('holland michigan too', 'Holland, MI', 'US');
at('the country still reads by name', 'Netherlands', 'NL');
at('and in dutch', 'Nederland', 'NL');
at('and by its cities', 'Rotterdam', 'NL');

console.log('\n== foreign CITY names that are also US places defer to the code ==');
/* The weak-evidence mechanism GB has carried since Reading, PA resolved to
   Britain: the city is remembered but not returned until the code pass has had
   its turn, so a US state code outranks it while a bare city name does not
   change meaning. */
at('amsterdam new hampshire', 'Amsterdam, NH', 'US');
at('dublin ohio', 'Dublin, OH', 'US');
at('melbourne florida', 'Melbourne, FL', 'US');
at('bare amsterdam is dutch', 'Amsterdam', 'NL');
at('bare dublin is irish', 'Dublin', 'IE');
at('bare melbourne is australian', 'Melbourne', 'AU');
at('bare warsaw is polish', 'Warsaw', 'PL');
at('the country name always wins', 'Melbourne, Australia', 'AU');
at('as does a state code that is not ours', 'Melbourne, VIC', 'AU');

console.log('\n== KNOWN AND NOT FIXED: the six excluded US state codes ==');
/* `in de or ia me hi` are absent from the US gazetteer on purpose — they
   collide with India, Germany and ordinary words ("in" matched "In-Office").
   The cost is that a US location using one has nothing to outrank a foreign
   city or country match, so the weak step falls through to the foreign answer.
   These three are pinned AS WRONG, so the day somebody makes those codes work
   this file says so rather than passing in silence. */
at('warsaw indiana is still misfiled', 'Warsaw, IN', 'PL');
at('waterloo iowa is still misfiled', 'Waterloo, IA', 'CA');
at('dover delaware is still misfiled', 'Dover, DE', 'DE');

console.log('\n== Portugal, added 5 Sep 2026 ==');
/* Added because Cloudflare's Lisbon internship was the one row the In-Office
   fix could recover the TEXT of but not the region. Both stored Portuguese
   rows are settled without any city entry at all — one by the country name and
   one by the code — which is what kept this edit as small as it is. */
at('the country spelled out', 'Lisboa, Lisboa, Portugal', 'PT');
at('the bare country', 'Portugal', 'PT');
at('the trailing code', 'Lisbon, pt', 'PT');
at('the leading code prefix', 'PT-Lisboa-Office', 'PT');
at('the Portuguese spelling of the city', 'Lisboa', 'PT');

console.log('\n== and the three collisions it was checked against ==');
/* `porto` IS NOT AND MUST NOT BECOME A CITY HERE. It whole-word matches Porto
   Alegre and Porto Velho, which are Brazilian, and Brazil is not in this
   gazetteer — so there is no code and no country name that could outrank it,
   and marking it ambiguous would not help because only the CODE pass beats a
   weak match. Adding it files Brazilian roles in Portugal with nothing able to
   correct them. */
at('Porto Alegre is not Portuguese', 'Porto Alegre, Brazil', UNKNOWN);
at('nor is bare Porto', 'Porto', UNKNOWN);

/* `lisbon` IS NOT A CITY HERE EITHER, AND IT WAS IN THE FIRST DRAFT. Lisbon
   ME / ND / OH / IA / WI and New Lisbon WI are real US towns. The London and
   Amsterdam treatment — list it and mark it ambiguous — looks right and is not,
   because a weak match is only beaten by the CODE pass and `me` and `ia` are
   two of the six US state codes excluded above. With `lisbon` listed weak,
   "Lisbon, ME" resolved to PORTUGAL. It is left out, so a bare Lisbon is
   honestly unknown. */
at('Lisbon Maine is not Portuguese', 'Lisbon, ME', UNKNOWN);
at('Lisbon Ohio is American', 'Lisbon, OH', 'US');
at('New Lisbon Wisconsin is American', 'New Lisbon, WI', 'US');
at('a bare Lisbon declines to guess', 'Lisbon', UNKNOWN);

/* The second-word question §6 insists on for any country name. `portugal`
   appears in the Canadian "Portugal Cove-St. Philip's" — Canada is earlier in
   the list and the country pass returns the first region that matches, so the
   real rows for that place are unaffected. No US place carries the word. */
at('Portugal Cove is Canadian', "Portugal Cove-St. Philip's, NL, Canada", 'CA');

console.log('\n== adding it publishes nothing ==');
/* Collected, never published: `regions.publish` is IN/US/GB, so a PT row is
   stored and stays off every board. That is the whole reason a region can be
   added on the strength of two rows. */
check('PT is a known region', regionOf('PT')?.name, 'Portugal');
check('PT is not published', isPublishedRegion({ regions: { publish: ['IN', 'US', 'GB'] } }, 'PT'), false);
check('PT is collected under "all"', collectsRegion({ regions: { collect: 'all' } }, 'PT'), true);
check('its slug does not collide', ALL_REGIONS.filter((r) => r.slug === 'pt').length, 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
