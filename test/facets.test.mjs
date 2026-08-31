/**
 * Skill and location facet pages.
 *
 * The queries people type are "python internships" and "internships in
 * bangalore". The board held the data for both and had a page for neither,
 * because skill chips pointed at the board's ?q= filter and a query string is
 * not a URL Google indexes.
 *
 * The two things that can go wrong here are thin pages and duplicate pages, and
 * both are about the input rather than the markup: a facet with three roles is
 * doorway-page content, and LinkedIn's location field will happily give you
 * "Bengaluru" and "Bengaluru East" as two different cities for one place.
 */
import { canonicalCity, facetSlug, facetGroups } from '../src/facets.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n          got:  ${a}\n          want: ${e}`); }
}

console.log('\n== ONE CITY, ONE PAGE ==');
// Every one of these is a real stored location. Without folding them, one place
// gets several pages and each is thinner than the whole would have been.
check('administrative suffix', canonicalCity('Pune Division'), 'Pune');
check('metropolitan region', canonicalCity('Mumbai Metropolitan Region'), 'Mumbai');
check('trailing direction', canonicalCity('Bengaluru East'), 'Bengaluru');
check('several cities in one string', canonicalCity('London; Amsterdam'), 'London');
check('an internal site code', canonicalCity('London - UK2'), 'London');
check('an office suffix', canonicalCity('Milton Keynes Office'), 'Milton Keynes');
check('the ordinary case', canonicalCity('Bengaluru, Karnataka, India'), 'Bengaluru');

console.log('\n== A LEADING DIRECTION IS PART OF THE NAME ==');
// Only TRAILING noise is stripped. These are real cities and must survive.
check('North Chicago', canonicalCity('North Chicago, IL'), 'North Chicago');
check('West Lafayette', canonicalCity('West Lafayette, IN'), 'West Lafayette');
check('South San Francisco', canonicalCity('South San Francisco, CA'), 'South San Francisco');

console.log('\n== A COUNTRY IS NOT A CITY ==');
// LinkedIn puts these in the location slot, and "United States" was a top-10
// "city" on the US board before this.
for (const s of ['India', 'United States', 'United Kingdom', 'Remote', 'In-Office', '2 Locations', ''])
  check(`refuses ${JSON.stringify(s)}`, canonicalCity(s), '');

console.log('\n== THE THRESHOLD IS THE DESIGN ==');
const job = (id, skills, location) => ({ id: String(id), company: `Co${id}`, skills, location, postedAt: 1000 + Number(id) });
const many = Array.from({ length: 9 }, (_, i) => job(i, ['python'], 'Bengaluru, India'));
const few = [job(90, ['rust'], 'Kochi, India'), job(91, ['rust'], 'Kochi, India')];
{
  const g = facetGroups([...many, ...few], { minRoles: 8 });
  check('a facet above the bar gets a page', g.skills.map((f) => f.slug), ['python']);
  check('one below it does not', g.skills.some((f) => f.slug === 'rust'), false);
  check('cities obey the same bar', g.cities.map((f) => f.slug), ['bengaluru']);
}

console.log('\n== a skill named twice on one posting counts ONCE ==');
// The enricher emits "Python" and "python" on the same row; without dedupe a
// single posting could carry a facet over the threshold on its own.
{
  const dupes = Array.from({ length: 4 }, (_, i) => job(i, ['Python', 'python', 'PYTHON'], 'Pune, India'));
  const g = facetGroups(dupes, { minRoles: 4 });
  check('four postings, not twelve', g.skills.find((f) => f.slug === 'python')?.jobs.length, 4);
}

console.log('\n== the fold happens BEFORE the threshold ==');
// Bengaluru 5 + Bengaluru East 4 is one city of 9, not two below the bar.
{
  const split = [
    ...Array.from({ length: 5 }, (_, i) => job(i, ['x'], 'Bengaluru, Karnataka, India')),
    ...Array.from({ length: 4 }, (_, i) => job(50 + i, ['x'], 'Bengaluru East, Karnataka, India')),
  ];
  const g = facetGroups(split, { minRoles: 8 });
  check('one page of nine, not two of five and four', g.cities.map((f) => [f.slug, f.jobs.length]), [['bengaluru', 9]]);
}

console.log('\n== slugs are URL-safe and keep meaning ==');
check('c++', facetSlug('C++'), 'c-plus-plus');
check('c#', facetSlug('C#'), 'c-sharp');
check('node.js', facetSlug('Node.js'), 'node-js');
check('spaces', facetSlug('Machine Learning'), 'machine-learning');
check('c++ and c# do not collide', facetSlug('C++') === facetSlug('C#'), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
