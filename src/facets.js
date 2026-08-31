/**
 * Skill and location facets — the pages people actually search for.
 *
 * "python internships", "internships in bangalore". The board has always held
 * the data for these and has never had a page for one: skill chips link to the
 * board's `?q=` filter, which is a query string Google will not index as a
 * separate page, so that whole surface did not exist.
 *
 * THE THRESHOLD IS THE WHOLE DESIGN. A facet page with three roles on it is
 * thin content, and forty of them on a domain with no crawl history is the
 * fastest way to look like a doorway-page farm. So a facet becomes a page only
 * once it carries `minRoles`, and everything below simply is not written — the
 * company hubs' approach of writing-but-noindexing exists because `foot()`
 * links to every hub and a link that 404s is worse; nothing links to a facet
 * that does not exist, so there is nothing to protect.
 */

/** Region names must never become "cities" — LinkedIn puts them in that slot. */
const NOT_A_CITY = new Set([
  'india', 'united states', 'united kingdom', 'usa', 'us', 'uk', 'england',
  'remote', 'in-office', 'hybrid', 'on-site', 'onsite', 'anywhere',
  'multiple locations', '2 locations', 'apac', 'emea',
]);

/**
 * Trailing words that are administrative noise rather than part of the name.
 *
 * Every one of these is from a real stored location: "Pune Division",
 * "Mumbai Metropolitan Region", "Bengaluru East", "Milton Keynes Office".
 * Only stripped from the END — "North Chicago" and "West Lafayette" are real
 * city names where the direction leads, and those must survive untouched.
 */
const TRAILING_NOISE = [
  'metropolitan region', 'urban district', 'rural district',
  'division', 'district', 'region', 'area', 'office', 'campus',
  'east', 'west', 'north', 'south', 'central',
];

/**
 * One canonical city name, or '' when the string does not name a city.
 *
 * LinkedIn's location field is free text and carries all of: several cities in
 * one string ("London; Amsterdam"), internal site codes ("London - UK2"),
 * administrative suffixes ("Pune Division"), and sometimes just a country.
 * Without this, "Bengaluru" and "Bengaluru East" become two pages for one
 * place, and "United States" becomes a city page.
 */
export function canonicalCity(location) {
  let s = String(location ?? '').trim();
  if (!s) return '';
  s = s.split(';')[0];              // "London; Amsterdam" -> the first
  s = s.split(',')[0];              // "Bengaluru, Karnataka, India" -> the city
  s = s.split(/\s+-\s+/)[0];        // "London - UK2" -> "London"
  s = s.replace(/\s+/g, ' ').trim();

  // Strip administrative noise repeatedly: "Bengaluru East Division" -> two passes.
  for (let i = 0; i < 3; i++) {
    const before = s;
    for (const w of TRAILING_NOISE) {
      const re = new RegExp(`\\s+${w}$`, 'i');
      if (re.test(s) && s.replace(re, '').trim().length >= 3) s = s.replace(re, '').trim();
    }
    if (s === before) break;
  }
  if (!s || s.length < 3) return '';
  if (NOT_A_CITY.has(s.toLowerCase())) return '';
  if (/^\d/.test(s)) return '';                       // "2 Locations"
  return s;
}

/** URL slug for a facet. Shared by the writer and every link to it. */
export function facetSlug(name) {
  return String(name ?? '').toLowerCase()
    .replace(/\+/g, '-plus').replace(/#/g, '-sharp').replace(/\./g, '-')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/**
 * Group live roles by skill and by city, keeping only facets worth a page.
 *
 * @param {object[]} jobs   published rows for ONE region
 * @param {object}   [opts]
 * @param {number}   [opts.minRoles] roles a facet needs before it gets a page
 */
export function facetGroups(jobs, { minRoles = 8 } = {}) {
  const skills = new Map();
  const cities = new Map();
  const add = (map, key, label, job) => {
    if (!map.has(key)) map.set(key, { label, jobs: [] });
    map.get(key).jobs.push(job);
  };

  for (const job of jobs) {
    /* De-duplicated per job: the enricher emits "python" and "python
       programming" on the same posting, and without this one role would count
       twice toward the same page's threshold. */
    const seen = new Set();
    for (const raw of job.skills ?? []) {
      const label = String(raw ?? '').trim();
      const slug = facetSlug(label);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      add(skills, slug, label, job);
    }
    const city = canonicalCity(job.location);
    if (city) add(cities, facetSlug(city), city, job);
  }

  const keep = (map) => [...map]
    .filter(([, v]) => v.jobs.length >= minRoles)
    .map(([slug, v]) => ({ slug, label: v.label, jobs: v.jobs }))
    .sort((a, b) => b.jobs.length - a.jobs.length || a.slug.localeCompare(b.slug));

  return { skills: keep(skills), cities: keep(cities) };
}
